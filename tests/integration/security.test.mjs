// Seguridad y aislamiento multi-comercio contra Supabase real (stack local).
// Cada prueba intenta romper una regla con la identidad equivocada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  sql, account, guest, anonClient, makeAdmin, publishedBusiness, order, transition, ok, failsWith,
  invisible, closeAll, run,
} from './harness.mjs';

const people = {};
let A, B, draftC, orderOfA, orderOfB;
const anon = anonClient();

before(async () => {
  for (const name of ['ownerA', 'managerA', 'staffA', 'ownerB', 'customerA', 'customerB', 'outsider', 'admin']) {
    people[name] = await account(name);
  }
  people.guest = await guest('guest');
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Alfa' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Beta' });
  draftC = ok(await people.ownerB.client.rpc('create_business',
    { business_name: `Borrador ${run}`, business_slug: `borrador-${run}` }));
  ok(await people.ownerA.client.rpc('add_business_member',
    { business: A.id, member_email: people.managerA.email, member_role: 'manager' }), 'sumar manager');
  ok(await people.ownerA.client.rpc('add_business_member',
    { business: A.id, member_email: people.staffA.email, member_role: 'staff' }), 'sumar staff');
  orderOfA = ok(await order(people.customerA, A.id, [{ product_id: A.products.untracked.id, quantity: 2 }]), 'pedido en A');
  orderOfB = ok(await order(people.customerB, B.id, [{ product_id: B.products.untracked.id, quantity: 1 }]), 'pedido en B');
});

after(async () => { await closeAll(Object.values(people)); });

const PRIVATE_TABLES = ['orders', 'order_items', 'order_events', 'profiles', 'business_memberships',
  'business_contacts', 'business_review_events', 'business_riders', 'drivers', 'trips', 'trip_events'];

test('una visita sin sesión lee sólo lo público', async () => {
  const businesses = ok(await anon.from('businesses').select('id,name,open_now'));
  const ids = businesses.map(row => row.id);
  assert.ok(ids.includes(A.id) && ids.includes(B.id));
  assert.ok(!ids.includes(draftC), 'un borrador nunca es público');
  assert.equal(businesses.find(row => row.id === A.id).open_now, true);
  const products = ok(await anon.from('products').select('id').eq('business_id', A.id));
  assert.equal(products.length, 3);
  assert.equal(ok(await anon.from('localities').select('slug'))[0].slug, 'alumine');
  for (const table of PRIVATE_TABLES) {
    assert.ok(await invisible(anon.from(table).select('*').limit(1)), `anon no debe leer ${table}`);
  }
  // Tampoco por columna: el contacto privado no viaja embebido.
  assert.ok((await anon.from('businesses').select('id,business_contacts(phone)').eq('id', A.id)).error);
});

test('una visita sin sesión no escribe ni invoca operaciones', async () => {
  const writes = [
    anon.from('businesses').insert({ name: 'Intrusa', slug: 'intrusa', locality_id: randomUUID() }),
    anon.from('businesses').update({ name: 'Intrusa' }).eq('id', A.id).select(),
    anon.from('products').insert({ business_id: A.id, name: 'Intruso', price_ars: 1 }),
    anon.from('products').update({ price_ars: 1 }).eq('id', A.products.untracked.id).select(),
    anon.from('products').delete().eq('id', A.products.untracked.id).select(),
    anon.from('business_hours').insert({ business_id: A.id, weekday: 1, opens: '08:00', closes: '09:00' }),
    anon.from('business_contacts').insert({ business_id: A.id, phone: '1' }),
    anon.from('business_riders').insert({ business_id: A.id, name: 'Intruso' }),
    anon.from('product_variants').insert({ product_id: A.products.variants.id, business_id: A.id, name: 'Intrusa' }),
  ];
  for (const attempt of await Promise.all(writes)) {
    assert.ok(attempt.error || (Array.isArray(attempt.data) && attempt.data.length === 0),
      'anon no debe escribir');
  }
  const calls = {
    create_order: { business: A.id, idem: randomUUID(), fulfillment: 'pickup', payment_method: 'cash_on_pickup',
      contact: { name: 'X', phone: '2942000000' }, items: [] },
    create_business: { business_name: 'Intrusa', business_slug: 'intrusa' },
    transition_order: { order_id: orderOfA, next_status: 'accepted' },
    set_business_presence: { business: A.id, is_open: false },
    set_product_availability: { product: A.products.untracked.id, is_available: false },
    submit_business_for_review: { business: A.id },
    review_business: { business: A.id, decision: 'active' },
    add_business_member: { business: A.id, member_email: people.outsider.email },
    business_team: { business: A.id },
    admin_snapshot: {}, admin_set_business_status: { business: A.id, next_status: 'suspended', note: 'x' },
    admin_client_events: {}, my_access: {},
  };
  for (const [fn, args] of Object.entries(calls)) {
    const result = await anon.rpc(fn, args);
    assert.equal(result.error?.code, '42501', `anon no debe ejecutar ${fn}`);
  }
});

test('lo único que invoca una visita sin sesión es el contrato público', async () => {
  const status = ok(await anon.rpc('app_status'));
  assert.equal(status.features.taxi, false);
  assert.equal(status.features.guest_checkout, true);
  assert.equal(status.schema, 20260924120000);
  assert.equal(ok(await anon.rpc('track_order', { token: randomUUID() })), null);
  assert.equal(ok(await anon.rpc('report_client_event',
    { kind: 'frontend_error', code: 'TEST', message: 'correo qa@example.com tel 2942 123456', route: '#inicio' })), true);
  const [event] = await sql`select message from private.client_events where code = 'TEST' order by id desc limit 1`;
  assert.equal(event.message.includes('qa@example.com'), false, 'el correo se descarta');
  assert.equal(event.message.includes('2942 123456'), false, 'el teléfono se descarta');
  assert.equal(ok(await anon.rpc('report_client_event', { kind: 'otra_cosa' })), false);
});

test('una sesión anónima de compra pide y sigue su pedido, pero no administra nada', async () => {
  const { client, id } = people.guest;
  failsWith(await client.rpc('create_business', { business_name: 'Invitada', business_slug: `invitada-${run}` }), '42501');
  failsWith(await client.from('profiles').insert({ user_id: id, display_name: 'Invitada' }), '42501');
  failsWith(await client.rpc('apply_as_driver', { display_name: 'Invitada' }), '42501');
  failsWith(await client.rpc('add_business_member', { business: A.id, member_email: people.outsider.email }), '42501');
  const mine = ok(await order(people.guest, A.id, [{ product_id: A.products.untracked.id, quantity: 1 }]), 'pedido invitado');
  const visible = ok(await client.from('orders').select('id,customer_id'));
  assert.deepEqual(visible.map(row => row.id), [mine]);
  assert.ok(await invisible(client.from('orders').select('id').eq('id', orderOfA)));
  failsWith(await transition(people.guest, mine, 'accepted'), '42501');
  assert.equal(ok(await transition(people.guest, mine, 'canceled', { reason: '' })).status, 'canceled');
});

test('cliente A y cliente B no ven ni tocan lo del otro', async () => {
  const a = people.customerA.client;
  assert.deepEqual(ok(await a.from('orders').select('id')).map(row => row.id), [orderOfA]);
  assert.ok(await invisible(a.from('orders').select('id').eq('id', orderOfB)));
  assert.ok(await invisible(a.from('order_items').select('id').eq('order_id', orderOfB)));
  assert.ok(await invisible(a.from('order_events').select('id').eq('order_id', orderOfB)));
  assert.ok(await invisible(a.from('profiles').select('user_id').eq('user_id', people.customerB.id)));
  assert.equal(ok(await a.from('profiles').update({ display_name: 'Intrusa' }).eq('user_id', people.customerB.id).select()).length, 0);
  failsWith(await transition(people.customerA, orderOfB, 'canceled'), '42501');
  failsWith(await a.from('orders').update({ total_ars: 1 }).eq('id', orderOfA), '42501');
  failsWith(await a.from('orders').update({ status: 'delivered' }).eq('id', orderOfA), '42501');
  failsWith(await a.from('order_items').update({ unit_price_ars: 1 }).eq('order_id', orderOfA), '42501');
  failsWith(await a.from('orders').delete().eq('id', orderOfA), '42501');
});

test('comercio A nunca lee, edita, borra ni lista datos privados de comercio B', async () => {
  const a = people.ownerA.client;
  assert.ok(await invisible(a.from('orders').select('id').eq('business_id', B.id)));
  assert.ok(await invisible(a.from('order_items').select('id').eq('business_id', B.id)));
  assert.ok(await invisible(a.from('order_events').select('id').eq('business_id', B.id)));
  assert.ok(await invisible(a.from('business_contacts').select('*').eq('business_id', B.id)));
  assert.ok(await invisible(a.from('business_riders').select('*').eq('business_id', B.id)));
  assert.ok(await invisible(a.from('business_review_events').select('*').eq('business_id', B.id)));
  assert.ok(await invisible(a.from('business_memberships').select('*').eq('business_id', B.id)));
  assert.ok(await invisible(a.from('businesses').select('id').eq('id', draftC)));
  assert.equal(ok(await a.from('businesses').update({ name: 'Tomado' }).eq('id', B.id).select()).length, 0);
  assert.equal(ok(await a.from('products').update({ price_ars: 1 }).eq('id', B.products.untracked.id).select()).length, 0);
  assert.equal(ok(await a.from('products').delete().eq('id', B.products.untracked.id).select()).length, 0);
  assert.equal(ok(await a.from('business_hours').delete().eq('business_id', B.id).select()).length, 0);
  failsWith(await a.from('products').insert({ business_id: B.id, name: 'Infiltrado', price_ars: 100 }), '42501');
  failsWith(await a.from('product_variants').insert({ product_id: B.products.variants.id, business_id: B.id, name: 'Infiltrada' }), '42501');
  failsWith(await a.from('business_hours').insert({ business_id: B.id, weekday: 1, opens: '08:00', closes: '12:00' }), '42501');
  failsWith(await a.from('business_riders').insert({ business_id: B.id, name: 'Infiltrado' }), '42501');
  failsWith(await a.from('business_contacts').insert({ business_id: B.id, phone: '1' }), '42501');
  // Mover un producto propio a otro comercio es imposible por clave compuesta.
  failsWith(await a.from('products').update({ business_id: B.id }).eq('id', A.products.untracked.id), '42501');
  for (const [fn, args] of Object.entries({
    business_team: { business: B.id },
    add_business_member: { business: B.id, member_email: people.outsider.email },
    set_business_presence: { business: B.id, is_open: false },
    submit_business_for_review: { business: draftC },
    set_product_availability: { product: B.products.untracked.id, is_available: false },
    transition_order: { order_id: orderOfB, next_status: 'accepted' },
  })) {
    failsWith(await a.rpc(fn, args), '42501');
  }
  const stillB = ok(await people.ownerB.client.from('products').select('price_ars').eq('id', B.products.untracked.id).single());
  assert.equal(Number(stillB.price_ars), 1200, 'el catálogo de B quedó intacto');
});

test('staff opera pedidos pero no administra catálogo, datos ni equipo', async () => {
  const s = people.staffA.client;
  assert.ok(ok(await s.from('orders').select('id')).some(row => row.id === orderOfA));
  assert.ok(await invisible(s.from('orders').select('id').eq('id', orderOfB)));
  assert.equal(ok(await s.from('products').update({ price_ars: 1 }).eq('id', A.products.untracked.id).select()).length, 0);
  assert.equal(ok(await s.from('businesses').update({ name: 'Staff' }).eq('id', A.id).select()).length, 0);
  failsWith(await s.from('products').insert({ business_id: A.id, name: 'Staff', price_ars: 100 }), '42501');
  failsWith(await s.from('business_riders').insert({ business_id: A.id, name: 'Staff' }), '42501');
  failsWith(await s.rpc('set_business_presence', { business: A.id, is_open: false }), '42501');
  failsWith(await s.rpc('business_team', { business: A.id }), '42501');
  failsWith(await s.rpc('add_business_member', { business: A.id, member_email: people.outsider.email }), '42501');
  const availability = ok(await s.rpc('set_product_availability',
    { product: A.products.untracked.id, is_available: false }));
  assert.equal(availability.available, false);
  ok(await s.rpc('set_product_availability', { product: A.products.untracked.id, is_available: true }));
  const accepted = ok(await transition(people.staffA, orderOfA, 'accepted', { version: 1 }));
  assert.equal(accepted.status, 'accepted');
});

test('manager administra la operación pero no el equipo', async () => {
  const m = people.managerA.client;
  assert.equal(ok(await m.from('businesses').update({ description: 'Editado por manager' }).eq('id', A.id).select()).length, 1);
  ok(await m.from('products').insert({ business_id: A.id, name: 'Del manager', price_ars: 500 }), 'producto del manager');
  ok(await m.rpc('set_business_presence', { business: A.id, is_open: true }));
  const team = ok(await m.rpc('business_team', { business: A.id }));
  assert.deepEqual(team.map(member => member.role).sort(), ['manager', 'owner', 'staff']);
  failsWith(await m.rpc('add_business_member', { business: A.id, member_email: people.outsider.email }), '42501');
  failsWith(await m.rpc('set_business_member_role', { business: A.id, member: people.staffA.id, member_role: 'manager' }), '42501');
  failsWith(await m.rpc('remove_business_member', { business: A.id, member: people.staffA.id }), '42501');
});

test('owner gestiona el equipo con límites, y quitar a alguien corta su acceso en el acto', async () => {
  const o = people.ownerA.client;
  failsWith(await o.rpc('add_business_member', { business: A.id, member_email: `nadie-${run}@cauce.test` }), 'P0002');
  failsWith(await o.rpc('add_business_member', { business: A.id, member_email: people.guest.id }), 'P0002');
  failsWith(await o.rpc('add_business_member', { business: A.id, member_email: people.staffA.email }), '23505');
  failsWith(await o.rpc('add_business_member',
    { business: A.id, member_email: people.outsider.email, member_role: 'owner' }), '23514');
  failsWith(await o.rpc('remove_business_member', { business: A.id, member: people.ownerA.id }), '42501');
  failsWith(await o.rpc('set_business_member_role',
    { business: A.id, member: people.ownerA.id, member_role: 'staff' }), '42501');
  assert.equal(ok(await o.rpc('set_business_member_role',
    { business: A.id, member: people.staffA.id, member_role: 'manager' })), 'manager');
  assert.equal(ok(await o.rpc('set_business_member_role',
    { business: A.id, member: people.staffA.id, member_role: 'staff' })), 'staff');
  ok(await o.rpc('remove_business_member', { business: A.id, member: people.staffA.id }));
  assert.ok(await invisible(people.staffA.client.from('orders').select('id').eq('business_id', A.id)),
    'sin membresía no hay acceso, aunque el JWT siga vigente');
  ok(await o.rpc('add_business_member', { business: A.id, member_email: people.staffA.email, member_role: 'staff' }));
  // Cada persona puede irse sola; nadie más que el owner la saca.
  ok(await people.managerA.client.rpc('remove_business_member', { business: A.id, member: people.managerA.id }));
  ok(await o.rpc('add_business_member', { business: A.id, member_email: people.managerA.email, member_role: 'manager' }));
});

test('nadie se autoaprueba, se suspende a otro ni se vuelve administración', async () => {
  const b = people.ownerB.client;
  failsWith(await b.from('businesses').update({ status: 'active' }).eq('id', draftC), '42501');
  failsWith(await b.rpc('review_business', { business: draftC, decision: 'active' }), '42501');
  failsWith(await people.ownerA.client.rpc('admin_set_business_status',
    { business: B.id, next_status: 'suspended', note: 'Competencia' }), '42501');
  // user_metadata la edita la propia persona: jamás concede permisos.
  await sql`update auth.users set raw_user_meta_data = raw_user_meta_data || '{"role":"admin","roles":["admin"]}'::jsonb
    where id = ${people.outsider.id}`;
  assert.equal(ok(await people.outsider.client.rpc('my_access')), false);
  const privateTable = await people.outsider.client.schema('private').from('platform_admins').insert({ user_id: people.outsider.id });
  assert.ok(privateTable.error, 'el esquema private no está expuesto');
  failsWith(await b.from('business_memberships').insert({ business_id: A.id, user_id: people.ownerB.id, role: 'owner' }), '42501');
});

test('administración suspende y rehabilita; el comercio no levanta una suspensión', async () => {
  const adminClient = people.admin.client;
  failsWith(await adminClient.rpc('admin_set_business_status', { business: B.id, next_status: 'suspended', note: '' }), '23514');
  assert.equal(ok(await adminClient.rpc('admin_set_business_status',
    { business: B.id, next_status: 'suspended', note: 'Documentación vencida' })), 'suspended');
  assert.ok(!ok(await anon.from('businesses').select('id')).some(row => row.id === B.id), 'suspendido no es público');
  failsWith(await order(people.customerA, B.id, [{ product_id: B.products.untracked.id, quantity: 1 }]), '23514');
  failsWith(await people.ownerB.client.rpc('set_business_presence', { business: B.id, next_status: 'active' }), '23514');
  failsWith(await people.ownerB.client.rpc('set_business_presence', { business: B.id, is_open: true }), '23514');
  assert.equal(ok(await adminClient.rpc('admin_set_business_status', { business: B.id, next_status: 'active', note: 'Regularizado' })), 'active');
  ok(await people.ownerB.client.rpc('set_business_presence', { business: B.id, is_open: true }));
  // Administración supervisa agregados: no lee pedidos ni datos personales.
  assert.ok(await invisible(adminClient.from('orders').select('id')));
  assert.ok(await invisible(adminClient.from('profiles').select('user_id').eq('user_id', people.customerA.id)));
  assert.ok(Array.isArray(ok(await adminClient.rpc('admin_client_events', { max_rows: 5 }))));
  failsWith(await people.ownerA.client.rpc('admin_client_events', { max_rows: 5 }), '42501');
});

test('taxi está apagado en la base, no sólo escondido en la interfaz', async () => {
  const c = people.customerA.client;
  failsWith(await c.rpc('request_trip', { origin: 'Plaza', destination: 'Hospital',
    passenger_name: 'Vecina', passenger_phone: '2942000000' }), '42501');
  failsWith(await c.rpc('apply_as_driver', { display_name: 'Conductor' }), '42501');
  assert.deepEqual(ok(await c.rpc('driver_offers')), []);
});

test('el esquema construido no deja huecos de privilegio', async () => {
  const noRls = await sql`select n.nspname || '.' || c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`;
  assert.deepEqual([...noRls], []);
  const publicDefiner = await sql`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef`;
  assert.deepEqual([...publicDefiner], []);
  const anonExecutable = (await sql`select n.nspname || '.' || p.proname as name from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'EXECUTE')
    order by 1`).map(row => row.name);
  assert.deepEqual(anonExecutable, [
    'private.app_status', 'private.business_open_now', 'private.report_client_event', 'private.track_order',
    'public.app_status', 'public.open_now', 'public.report_client_event', 'public.track_order',
  ]);
  const anonWrites = await sql`select table_name, privilege_type from information_schema.role_table_grants
    where grantee = 'anon' and privilege_type <> 'SELECT' and table_schema in ('public', 'private')`;
  assert.deepEqual([...anonWrites], []);
});
