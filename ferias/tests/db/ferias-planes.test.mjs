// Ferias, puestos, retiro en feria, planes y suscripciones en PostgreSQL
// embebido. Un organizador sólo administra sus ferias; los límites del plan y
// el vencimiento se aplican en la base sin cortar pedidos en curso.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorld, denied, failsWith } from './world.mjs';

let w, A, E, orgA, orgB, fair;
before(async () => {
  w = await createWorld();
  A = await w.publishedBusiness('merchantA', { name: 'Raíces de Barro', plan: 'feriante' });
  E = await w.publishedBusiness('merchantB', { name: 'Luna Accesorios', plan: 'entrada' });
  orgA = await w.organizer('organizerA', 'Ferias del Parque');
  orgB = await w.organizer('organizerB', 'Paseo de la Costa');
  await w.root("insert into public.organizer_members (organizer_id, user_id, role) values ($1, $2, 'editor')",
    [orgA, w.ids.editorA]);
});
after(async () => { await w.close(); });

const audit = async action => (await w.root('select count(*)::int as n from private.audit_log where action = $1', [action])).rows[0].n;

test('sólo administración crea organizadores, y deja auditoría', async () => {
  await denied(assert, w.as('merchantA', "select public.admin_create_organizer('Truchos', 'merchanta@ferias.test')"));
  assert.ok(await audit('organizer.created') >= 2);
  const visible = (await w.as('anon', 'select name from public.organizers order by name')).rows.map(r => r.name);
  assert.deepEqual(visible, ['Ferias del Parque organizerA', 'Paseo de la Costa organizerB']);
});

test('un borrador de feria no es público; publicar exige plan de organizador', async () => {
  const starts = new Date(Date.now() + 3 * 86400000);
  const draft = (await w.one('editorA', 'select public.create_fair($1, $2::jsonb) as r', [orgA, JSON.stringify({
    name: 'Feria de Primavera', venue: 'Plaza Roca', locality: 'neuquen', starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + 6 * 3600000).toISOString() })])).r;
  assert.match(draft.slug, /^feria-de-primavera-\d{4}-\d{2}-\d{2}$/);
  assert.equal((await w.as('anon', 'select id from public.fairs where id = $1', [draft.id])).rows.length, 0);
  await failsWith(assert, w.as('editorA', "select public.set_fair_status($1, 'published', '')", [draft.id]),
    'Organizer plan required', 'U0010');
  // Otro organizador no puede tocarla, ni por RPC ni por la tabla.
  await denied(assert, w.as('organizerB', 'select public.create_fair($1, $2::jsonb)', [orgA, JSON.stringify({ name: 'X' })]));
  await denied(assert, w.as('organizerB', "select public.set_fair_status($1, 'published', '')", [draft.id]));
  assert.equal((await w.as('organizerB', "update public.fairs set name = 'Intrusa' where id = $1 returning id", [draft.id])).rows.length, 0);
  await denied(assert, w.as('editorA', "update public.fairs set status = 'published' where id = $1", [draft.id]));
});

test('feria publicada con plan; aparece en el calendario público', async () => {
  fair = await w.publishedFair('organizerA', orgA, { capacity: 2 });
  const list = (await w.one('anon', "select public.public_fairs('neuquen', null, null, null, 20) as r")).r;
  const item = list.find(f => f.id === fair.id);
  assert.ok(item);
  assert.equal(item.participants, 0);
  assert.equal(item.venue, 'Parque Central');
  assert.equal((await w.one('anon', "select public.public_fairs('zapala', null, null, null, 20) as r")).r.length, 0);
});

test('inscripción: el comercio pide, el organizador confirma con puesto; nadie más decide', async () => {
  const participation = (await w.one('merchantA', 'select public.apply_to_fair($1, $2) as id', [fair.id, A.id])).id;
  // Repetir la solicitud no duplica.
  assert.equal((await w.one('merchantA', 'select public.apply_to_fair($1, $2) as id', [fair.id, A.id])).id, participation);
  await denied(assert, w.as('merchantB', 'select public.apply_to_fair($1, $2)', [fair.id, A.id]));
  // La solicitud pendiente no es pública.
  assert.equal((await w.as('anon', 'select id from public.fair_participations where id = $1', [participation])).rows.length, 0);
  await denied(assert, w.as('merchantA', "select public.decide_participation($1, 'confirmed', 'A1', '')", [participation]));
  await denied(assert, w.as('organizerB', "select public.decide_participation($1, 'confirmed', 'A1', '')", [participation]));
  await denied(assert, w.as('organizerB', 'select public.fair_applications($1)', [fair.id]));
  const applications = (await w.one('editorA', 'select public.fair_applications($1) as r', [fair.id])).r;
  assert.equal(applications[0].business.name, 'Raíces de Barro');
  assert.equal(applications[0].status, 'requested');
  await w.as('editorA', "select public.decide_participation($1, 'confirmed', 'a12', '')", [participation]);
  const row = (await w.one('anon', 'select status, stall_code from public.fair_participations where id = $1', [participation]));
  assert.deepEqual(row, { status: 'confirmed', stall_code: 'A12' });
  assert.equal((await w.one('anon', "select public.public_fairs('neuquen', null, null, null, 20) as r")).r
    .find(f => f.id === fair.id).participants, 1);
  // Las inscripciones no se escriben por la tabla.
  await denied(assert, w.as('merchantA', "update public.fair_participations set status = 'confirmed' where id = $1", [participation]));
});

test('dos comercios no comparten puesto y la capacidad se respeta', async () => {
  const p2 = (await w.one('merchantB', 'select public.apply_to_fair($1, $2) as id', [fair.id, E.id])).id;
  await failsWith(assert, w.as('organizerA', "select public.decide_participation($1, 'confirmed', 'A12', '')", [p2]),
    'Stall already assigned', '23505');
  await w.as('organizerA', "select public.decide_participation($1, 'confirmed', 'B3', '')", [p2]);
  const third = await w.publishedBusiness('customerA', { name: 'Tercera', plan: 'feriante' });
  const p3 = (await w.one('customerA', 'select public.apply_to_fair($1, $2) as id', [fair.id, third.id])).id;
  await failsWith(assert, w.as('organizerA', "select public.decide_participation($1, 'confirmed', 'C1', '')", [p3]),
    'Fair is full');
  await w.as('organizerA', "select public.decide_participation($1, 'rejected', null, 'Cupo completo')", [p3]);
  const mine = (await w.one('customerA', 'select status, decision_note from public.fair_participations where id = $1', [p3]));
  assert.deepEqual(mine, { status: 'rejected', decision_note: 'Cupo completo' });
  await failsWith(assert, w.as('customerA', 'select public.apply_to_fair($1, $2)', [fair.id, third.id]), 'Application rejected');
  assert.ok(await audit('participation.confirmed') >= 2);
});

test('retiro en feria: sólo con plan que lo incluya y participación confirmada', async () => {
  const ok = await w.order('customerA', A.id, [{ product_id: A.madeToOrder, quantity: 1 }],
    { fulfillment: 'fair_pickup', fair: fair.id });
  const row = (await w.root('select * from public.orders where id = $1', [ok.id])).rows[0];
  assert.equal(row.pickup_stall, 'A12');
  assert.equal(row.pickup_fair_name, 'Feria del Parque Central');
  assert.equal(Number(row.delivery_fee_ars), 0);
  // Plan de entrada: participa de la feria pero no ofrece retiro en el puesto.
  await failsWith(assert, w.order('customerB', E.id, [{ product_id: E.madeToOrder, quantity: 1 }],
    { fulfillment: 'fair_pickup', fair: fair.id }), 'Fair pickup not available');
  // Sin feria o con una feria donde no participa: rechazado.
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }],
    { fulfillment: 'fair_pickup' }), 'Choose a fair');
  const other = await w.publishedFair('organizerB', orgB);
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }],
    { fulfillment: 'fair_pickup', fair: other.id }), 'Fair pickup not available');
  // El seguimiento muestra feria, puesto y coordenadas para llegar.
  const token = row.tracking_token;
  const tracked = (await w.one('anon', 'select public.track_order($1) as t', [token])).t;
  assert.equal(tracked.pickup.stall, 'A12');
  assert.equal(tracked.pickup.venue, 'Parque Central');
  assert.equal(Number(tracked.pickup.latitude), -38.9516);
});

test('no se retira de la feria con retiros pendientes; el organizador ve conteos sin importes', async () => {
  const participation = (await w.one('merchantA', 'select id from public.fair_participations where fair_id = $1 and business_id = $2', [fair.id, A.id])).id;
  await failsWith(assert, w.as('merchantA', 'select public.withdraw_participation($1)', [participation]), 'Pending fair pickups');
  const stats = (await w.one('organizerA', 'select public.fair_stats($1) as s', [fair.id])).s;
  assert.equal(stats.confirmed, 2);
  assert.equal(stats.rejected, 1);
  assert.equal(stats.pickup_orders, 1);
  assert.equal(JSON.stringify(stats).includes('total'), false);
  await denied(assert, w.as('merchantA', 'select public.fair_stats($1)', [fair.id]));
});

test('avisos de la feria: los leen organizadores y participantes confirmados, nadie más', async () => {
  await w.as('editorA', "insert into public.fair_announcements (fair_id, body) values ($1, 'Armado desde las 8:00 por calle Roca.')", [fair.id]);
  const author = (await w.root('select created_by from public.fair_announcements where fair_id = $1', [fair.id])).rows[0].created_by;
  assert.equal(author, w.ids.editorA);
  assert.equal((await w.as('merchantA', 'select body from public.fair_announcements where fair_id = $1', [fair.id])).rows.length, 1);
  assert.equal((await w.as('customerA', 'select body from public.fair_announcements where fair_id = $1', [fair.id])).rows.length, 0);
  assert.equal((await w.as('organizerB', 'select body from public.fair_announcements where fair_id = $1', [fair.id])).rows.length, 0);
  await denied(assert, w.as('merchantA', "insert into public.fair_announcements (fair_id, body) values ($1, 'Spam de prueba')", [fair.id]));
  await denied(assert, w.as('anon', 'select * from public.fair_announcements'));
});

test('cancelar una feria exige motivo y queda visible como cancelada', async () => {
  const extra = await w.publishedFair('organizerA', orgA, { days: 20 });
  await failsWith(assert, w.as('organizerA', "select public.set_fair_status($1, 'canceled', '')", [extra.id]), 'Reason required');
  await w.as('organizerA', "select public.set_fair_status($1, 'canceled', 'Alerta por viento')", [extra.id]);
  const listed = (await w.one('anon', "select public.public_fairs(null, null, null, null, 50) as r")).r.find(f => f.id === extra.id);
  assert.equal(listed.status, 'canceled');
  assert.equal(listed.cancel_reason, 'Alerta por viento');
});

test('límite de productos del plan de entrada (20), validado en la base', async () => {
  const shop = (await w.one('stranger', "select public.create_business('Muchos Productos', 'centenario', 'arte') as r")).r;
  for (let i = 0; i < 20; i += 1) {
    await w.as('stranger', 'insert into public.products (business_id, name, price_ars) values ($1, $2, 1000)', [shop.id, `Pieza ${i + 1}`]);
  }
  await failsWith(assert, w.as('stranger', "insert into public.products (business_id, name, price_ars) values ($1, 'Pieza 21', 1000)", [shop.id]),
    'Plan limit: products', 'U0010');
  // Archivar libera un lugar; desarchivar lo vuelve a pedir.
  const first = (await w.one('stranger', "select id from public.products where business_id = $1 and name = 'Pieza 1'", [shop.id])).id;
  await w.as('stranger', 'update public.products set archived = true where id = $1', [first]);
  await w.as('stranger', "insert into public.products (business_id, name, price_ars) values ($1, 'Pieza 21', 1000)", [shop.id]);
  await failsWith(assert, w.as('stranger', 'update public.products set archived = false where id = $1', [first]),
    'Plan limit: products', 'U0010');
  // Con Emprendedor Pro (100) se puede seguir cargando.
  await w.as('admin', "select public.admin_set_subscription($1, null, 'pro', 'active', current_date + 30, 10, '')", [shop.id]);
  await w.as('stranger', 'update public.products set archived = false where id = $1', [first]);
  const usage = (await w.one('stranger', 'select public.my_entitlements($1) as e', [shop.id])).e;
  assert.equal(usage.max_products, 100);
  assert.equal(usage.products_used, 21);
});

test('límite de fotos por producto según el plan', async () => {
  const product = (await w.one('merchantB', "insert into public.products (business_id, name, price_ars) values ($1, 'Collar', 5000) returning id", [E.id])).id;
  for (let i = 0; i < 3; i += 1) {
    await w.as('merchantB', 'insert into public.product_images (product_id, business_id, path, position) values ($1, $2, $3, $4)',
      [product, E.id, `businesses/${E.id}/products/${randomUUID()}.webp`, i]);
  }
  await failsWith(assert, w.as('merchantB', 'insert into public.product_images (product_id, business_id, path) values ($1, $2, $3)',
    [product, E.id, `businesses/${E.id}/products/${randomUUID()}.webp`]), 'Plan limit: images', 'U0010');
});

test('vencimiento: en gracia se sigue vendiendo; vencida no toma pedidos nuevos pero los abiertos siguen', async () => {
  const open = await w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }]);
  // Venció hace 3 días con 10 de gracia.
  await w.root("update public.subscriptions set period_end = current_date - 3 where business_id = $1", [A.id]);
  let rights = (await w.one('merchantA', 'select public.my_entitlements($1) as e', [A.id])).e;
  assert.equal(rights.state, 'grace');
  assert.equal(rights.can_sell, true);
  assert.ok((await w.order('editorA', A.id, [{ product_id: A.madeToOrder, quantity: 1 }])).id);
  // Fuera de la gracia.
  await w.root("update public.subscriptions set period_end = current_date - 30 where business_id = $1", [A.id]);
  rights = (await w.one('merchantA', 'select public.my_entitlements($1) as e', [A.id])).e;
  assert.equal(rights.state, 'expired');
  assert.equal(rights.can_sell, false);
  assert.equal(rights.max_products, 20);
  await failsWith(assert, w.order('stranger', A.id, [{ product_id: A.madeToOrder, quantity: 1 }]), 'Business not taking orders');
  // La tienda sigue visible como vitrina y el pedido abierto se puede terminar.
  assert.equal((await w.as('anon', 'select id from public.businesses where id = $1', [A.id])).rows.length, 1);
  await w.as('merchantA', "select public.transition_order($1, null, 'accepted', '')", [open.id]);
  await w.as('merchantA', "select public.transition_order($1, null, 'ready', '')", [open.id]);
  await w.as('merchantA', "select public.transition_order($1, null, 'delivered', '')", [open.id]);
  // Renovar devuelve todo en el acto.
  await w.as('admin', "select public.admin_set_subscription($1, null, 'feriante', 'active', current_date + 30, 10, 'Pagó transferencia')", [A.id]);
  assert.equal((await w.one('anon', 'select public.taking_orders(b) as t from public.businesses b where id = $1', [A.id])).t, true);
  assert.ok(await audit('subscription.set') >= 1);
});

test('un plan de organizador no se asigna a un comercio', async () => {
  await failsWith(assert, w.as('admin', "select public.admin_set_subscription($1, null, 'organizador', 'active', current_date + 30, 10, '')", [A.id]),
    'Plan does not match subject');
});

test('suspensión administrativa: oculta la tienda y exige motivo', async () => {
  await failsWith(assert, w.as('admin', "select public.admin_set_business_status($1, 'suspended', '')", [E.id]), 'Reason required');
  await w.as('admin', "select public.admin_set_business_status($1, 'suspended', 'Reclamo verificado')", [E.id]);
  assert.equal((await w.as('anon', 'select id from public.businesses where id = $1', [E.id])).rows.length, 0);
  await denied(assert, w.as('merchantB', "select public.admin_set_business_status($1, 'active', '')", [E.id]));
  await w.as('admin', "select public.admin_set_business_status($1, 'active', '')", [E.id]);
  const log = (await w.one('admin', 'select public.admin_audit_log(100) as l')).l;
  assert.ok(log.some(entry => entry.action === 'business.suspended' && entry.actor_email === 'admin@ferias.test'));
});

test('el campo público offers_fair_pickup refleja tienda y plan', async () => {
  const value = async id => (await w.one('anon', 'select public.offers_fair_pickup(b) as v from public.businesses b where id = $1', [id])).v;
  assert.equal(await value(A.id), true);
  assert.equal(await value(E.id), false);
  await w.as('merchantA', 'update public.businesses set fair_pickup_enabled = false where id = $1', [A.id]);
  assert.equal(await value(A.id), false);
  await w.as('merchantA', 'update public.businesses set fair_pickup_enabled = true where id = $1', [A.id]);
});
