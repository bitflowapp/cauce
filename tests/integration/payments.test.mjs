// Pagos online preparados, contra Supabase real (stack local): PostgREST, RLS
// y el rol de servicio de verdad. El interruptor está apagado, como en
// producción: se prueba que el pago online no existe para nadie, que ningún
// cliente ejecuta las funciones del servidor (webhooks, OAuth, credenciales)
// y que sólo service_role —el de las Edge Functions— las ejecuta. Un bloque
// enciende el interruptor dentro de la prueba para ver el aislamiento entre
// comercios y lo vuelve a apagar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, admin, account, guest, anonClient, makeAdmin, publishedBusiness, order, ok, closeAll, contact } from './harness.mjs';

const people = {};
let A, B;

const denied = (result, label) => {
  assert.ok(result.error, `${label}: tenía que fallar`);
  assert.ok(['42501', 'PGRST202', '401', '403'].includes(String(result.error.code || result.status)) || /permission denied/i.test(result.error.message),
    `${label}: ${result.error.code} ${result.error.message}`);
};
const setFlag = on => sql`update private.platform_features set enabled = ${on} where key = 'payments_online'`;

before(async () => {
  for (const name of ['ownerA', 'ownerB', 'admin', 'cliente']) people[name] = await account(`pagos-${name}`);
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Pagos Alfa' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Pagos Beta' });
});
after(async () => {
  await setFlag(false);
  await closeAll(Object.values(people));
});

test('producción: el interruptor está apagado y el checkout sólo ofrece efectivo', async () => {
  const status = ok(await anonClient().rpc('app_status'));
  assert.equal(status.features.payments_online, false);
  const methods = ok(await anonClient().rpc('payment_methods', { business: A.id }));
  assert.deepEqual(methods.map(method => method.id), ['cash_on_pickup', 'cash_on_delivery']);
});

test('un pedido online se rechaza aunque el cliente lo pida', async () => {
  const buyer = await guest('pagos-online');
  const attempt = await buyer.client.rpc('create_order', { business: A.id, idem: crypto.randomUUID(), fulfillment: 'pickup',
    payment_method: 'online', contact: contact(), items: [{ product_id: A.products.untracked.id, quantity: 1 }],
    expected_total: null });
  assert.equal(attempt.error?.code, '23514');
  assert.match(attempt.error.message, /Payment method not available/);
  // Y el efectivo sigue igual.
  const cash = ok(await order(buyer, A.id, [{ product_id: A.products.untracked.id, quantity: 1 }]));
  const [row] = await sql`select payment_method, payment_status from public.orders where id = ${cash}`;
  assert.deepEqual({ ...row }, { payment_method: 'cash_on_pickup', payment_status: 'pending_on_delivery' });
});

test('ningún cliente ejecuta las funciones del servidor; service_role sí', async () => {
  const visitor = anonClient();
  const calls = {
    payment_record_event: { provider: 'mercadopago', event_key: `prueba-${crypto.randomUUID()}`, resource_type: 'order',
      resource_id: 'ORD01X', action: 'order.processed', live_mode: false },
    payment_apply_update: { provider: 'mercadopago', seller_id: '1', attempt_reference: null, provider_order_id: 'ORD01X',
      status: 'approved', status_detail: '', paid_amount: 1, transactions: [], event_id: null },
    payment_account_credentials: { business: A.id, provider: 'mercadopago' },
    payment_seller_credentials: { provider: 'mercadopago', seller_id: '1' },
    payment_oauth_lookup: { state: 'x'.repeat(40) },
    payment_checkout_context: { attempt_id: crypto.randomUUID() },
  };
  for (const [name, args] of Object.entries(calls)) {
    denied(await visitor.rpc(name, args), `visita · ${name}`);
    denied(await people.cliente.client.rpc(name, args), `cliente · ${name}`);
    denied(await people.ownerA.client.rpc(name, args), `titular · ${name}`);
  }
  // El rol de servicio (Edge Functions) sí: una notificación se anota una vez.
  const key = `integracion-${crypto.randomUUID()}`;
  const first = ok(await admin.rpc('payment_record_event', { ...calls.payment_record_event, event_key: key }));
  const again = ok(await admin.rpc('payment_record_event', { ...calls.payment_record_event, event_key: key }));
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(first.event_id, again.event_id);
  // Una orden desconocida se ignora, no rompe nada.
  const unknown = ok(await admin.rpc('payment_apply_update', { ...calls.payment_apply_update, event_id: first.event_id }));
  assert.equal(unknown.outcome, 'ignored');
});

test('las tablas de pagos no se escriben desde el cliente, y las credenciales no se leen', async () => {
  denied(await people.ownerA.client.from('payment_provider_accounts').insert({ business_id: A.id, provider: 'mercadopago',
    status: 'connected' }), 'crear cuenta conectada');
  denied(await people.cliente.client.from('payment_attempts').insert({ order_id: crypto.randomUUID(), business_id: A.id,
    provider: 'mercadopago', flow: 'checkout_pro', amount_ars: 1 }), 'crear intento');
  const hidden = await people.ownerA.client.schema('private').from('payment_provider_credentials').select('*');
  assert.ok(hidden.error, 'el esquema privado no se expone');
});

test('con el interruptor encendido, el comercio B no ve ni toca la cuenta ni los pagos del comercio A', async () => {
  await setFlag(true);
  try {
    await sql`insert into public.payment_provider_accounts (business_id, provider, status, provider_user_id, connected_at)
      values (${A.id}, 'mercadopago', 'connected', '424242', now())`;
    const methods = ok(await anonClient().rpc('payment_methods', { business: A.id }));
    assert.deepEqual(methods.map(method => method.id), ['cash_on_pickup', 'cash_on_delivery', 'online']);
    const buyer = await guest('pagos-online-2');
    const id = ok(await buyer.client.rpc('create_order', { business: A.id, idem: crypto.randomUUID(), fulfillment: 'pickup',
      payment_method: 'online', contact: contact(), items: [{ product_id: A.products.untracked.id, quantity: 1 }],
      expected_total: null }));
    const started = ok(await buyer.client.rpc('start_payment', { order_id: id }));
    const again = ok(await buyer.client.rpc('start_payment', { order_id: id }));
    assert.equal(started.attempt_id, again.attempt_id, 'doble toque: el mismo intento');
    // El comercio B: nada de A. Su propio día, vacío y sin cuenta.
    assert.deepEqual(ok(await people.ownerB.client.from('payment_provider_accounts').select('*')), []);
    assert.deepEqual(ok(await people.ownerB.client.from('payment_attempts').select('*')), []);
    const own = ok(await people.ownerB.client.rpc('business_payment_overview', { business: B.id }));
    assert.deepEqual(own.accounts, []);
    assert.equal(own.today.pending, 0);
    denied(await people.ownerB.client.rpc('business_payment_overview', { business: A.id }), 'B lee el día de A');
    denied(await people.ownerB.client.rpc('disconnect_payment_account', { business: A.id, provider: 'mercadopago' }), 'B desconecta a A');
    assert.equal(ok(await people.ownerB.client.rpc('payment_status', { reference: id })), null);
    // El comercio A sí: su cuenta y su día, sin ningún secreto.
    const overview = ok(await people.ownerA.client.rpc('business_payment_overview', { business: A.id }));
    assert.equal(overview.accounts[0].status, 'connected');
    assert.equal(overview.today.pending, 1);
    // El cliente no aprueba su pago, ni por la tabla ni por el estado del pedido.
    denied(await buyer.client.from('payment_attempts').update({ status: 'approved' }).eq('id', started.attempt_id), 'aprobar el intento');
    await buyer.client.from('orders').update({ payment_status: 'approved' }).eq('id', id);
    const [row] = await sql`select payment_status from public.orders where id = ${id}`;
    assert.equal(row.payment_status, 'pending');
    // El comercio no acepta un pedido online sin el pago aprobado.
    const accept = await people.ownerA.client.rpc('transition_order', { order_id: id, expected_version: null,
      next_status: 'accepted', rider: null, reason: '' });
    assert.equal(accept.error?.code, 'U0007');
  } finally {
    await sql`delete from public.payment_provider_accounts where business_id = ${A.id}`;
    await setFlag(false);
  }
});

// ───────────────── sandbox: piloto por comercio ─────────────────
const pilot = (business, sandbox = true) => sql`insert into private.payment_pilot_businesses (business_id, sandbox, reason)
  values (${business}, ${sandbox}, 'CAUCE QA · Mercado Pago') on conflict (business_id) do nothing`;
const unpilot = business => sql`delete from private.payment_pilot_businesses where business_id = ${business}`;

test('las funciones nuevas del servidor (renovación, estado, descarte) son sólo de service_role', async () => {
  const calls = {
    payments_accepting: {},
    payment_oauth_discard: { state: 'y'.repeat(43) },
    payment_accounts_expiring: { within_days: 30 },
    payment_account_rotate: { account: crypto.randomUUID(), access_ciphertext: 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
      refresh_ciphertext: '', new_key_version: 1, new_expires_at: new Date().toISOString() },
  };
  for (const [name, args] of Object.entries(calls)) {
    denied(await anonClient().rpc(name, args), `visita · ${name}`);
    denied(await people.cliente.client.rpc(name, args), `cliente · ${name}`);
    denied(await people.ownerA.client.rpc(name, args), `titular · ${name}`);
  }
  assert.equal(ok(await admin.rpc('payments_accepting')), false, 'producción: nada encendido');
  assert.equal(ok(await admin.rpc('payment_oauth_discard', calls.payment_oauth_discard)), null);
  assert.deepEqual(ok(await admin.rpc('payment_accounts_expiring', calls.payment_accounts_expiring)), []);
});

test('un comercio piloto cobra online con el interruptor apagado; los demás y el público no ven nada', async () => {
  await pilot(A.id);
  try {
    await sql`insert into public.payment_provider_accounts (business_id, provider, status, provider_user_id, live_mode, connected_at)
      values (${A.id}, 'mercadopago', 'connected', '3131313131', false, now())`;
    await sql`insert into public.payment_provider_accounts (business_id, provider, status, provider_user_id, live_mode, connected_at)
      values (${B.id}, 'mercadopago', 'connected', '3232323232', false, now())`;
    assert.equal(ok(await anonClient().rpc('app_status')).features.payments_online, false, 'el interruptor sigue apagado');
    assert.equal(ok(await admin.rpc('payments_accepting')), true);
    const methodsA = ok(await anonClient().rpc('payment_methods', { business: A.id })).map(method => method.id);
    const methodsB = ok(await anonClient().rpc('payment_methods', { business: B.id })).map(method => method.id);
    assert.deepEqual(methodsA, ['cash_on_pickup', 'cash_on_delivery', 'online']);
    assert.deepEqual(methodsB, ['cash_on_pickup', 'cash_on_delivery'], 'B no es piloto');
    // Sólo titular o encargado/a ven que su comercio es piloto.
    const [ownRow] = ok(await people.ownerA.client.from('businesses').select('id,payments_pilot').eq('id', A.id));
    assert.equal(ownRow.payments_pilot, true);
    const [foreign] = ok(await people.ownerB.client.from('businesses').select('id,payments_pilot').eq('id', A.id));
    assert.equal(foreign.payments_pilot, null);
    const [ownB] = ok(await people.ownerB.client.from('businesses').select('id,payments_pilot').eq('id', B.id));
    assert.equal(ownB.payments_pilot, false);
    assert.ok((await anonClient().from('businesses').select('id,payments_pilot').eq('id', A.id)).error,
      'el público no puede pedir la columna del piloto');
    // Un pedido online en A: B ni lo ve ni lo toca; un webhook del vendedor de B no actualiza a A.
    const buyer = await guest('pagos-piloto');
    const id = ok(await buyer.client.rpc('create_order', { business: A.id, idem: crypto.randomUUID(), fulfillment: 'pickup',
      payment_method: 'online', contact: contact(), items: [{ product_id: A.products.untracked.id, quantity: 1 }],
      expected_total: null }));
    const started = ok(await buyer.client.rpc('start_payment', { order_id: id }));
    const intruder = ok(await admin.rpc('payment_apply_update', { provider: 'mercadopago', seller_id: '3232323232',
      attempt_reference: started.attempt_id, provider_order_id: null, status: 'approved', status_detail: '',
      paid_amount: Number(started.amount), transactions: [], event_id: null }));
    assert.equal(intruder.reason, 'seller_mismatch');
    const [row] = await sql`select payment_status from public.orders where id = ${id}`;
    assert.equal(row.payment_status, 'pending', 'el vendedor ajeno no aprueba nada');
    assert.deepEqual(ok(await people.ownerB.client.from('payment_attempts').select('id').eq('order_id', id)), []);
    denied(await people.ownerB.client.rpc('disconnect_payment_account', { business: A.id, provider: 'mercadopago' }),
      'B desconecta a A');
    denied(await anonClient().from('payment_transactions').select('*'), 'la visita lee movimientos');
    assert.ok((await buyer.client.schema('private').from('payment_provider_credentials').select('*')).error,
      'el cliente no lee credenciales');
  } finally {
    await sql`delete from public.payment_provider_accounts where business_id in (${A.id}, ${B.id})`;
    await unpilot(A.id);
  }
  assert.deepEqual(ok(await anonClient().rpc('payment_methods', { business: A.id })).map(method => method.id),
    ['cash_on_pickup', 'cash_on_delivery'], 'sin piloto, vuelve el efectivo solo');
});
