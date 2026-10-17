// Pagos online preparados, en PostgreSQL embebido (PGlite) con las migraciones
// reales. La base se construye como está hoy en producción, con pedidos en
// efectivo en curso y entregados, y recién ahí se aplica la migración de pagos:
// se prueba que no toca nada de lo existente y, sobre esa base, qué hace cada
// cuenta. Con el interruptor apagado no existe el pago online para nadie; con
// el interruptor encendido (sólo en esta prueba) se prueban las reglas que lo
// van a gobernar: idempotencia, webhooks repetidos o falsos, importes, aislamiento
// entre comercios y funciones que sólo ejecuta el servidor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, applyMigration, migrationFiles, versionOf } from './fixture.mjs';
import { REQUIRED_SCHEMA } from '../../js/core/contract.js';
import { PAYMENT_TRANSITIONS } from '../../js/core/payment.js';

const PAYMENTS = 20260926120000;
const db = new PGlite();
const NAMES = ['ownerA', 'managerA', 'staffA', 'ownerB', 'customer1', 'customer2', 'customer3', 'customer4', 'customer5',
  'customer6', 'customer7', 'stranger', 'admin', 'guest', 'customer8'];
const ids = Object.fromEntries(NAMES.map((name, i) => [name, `40000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const email = name => `${name.toLowerCase()}@cauce.test`;
const rows = result => result.rows;

async function as(name, sql, params = []) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${name === 'anon' ? 'anon' : name === 'service' ? 'service_role' : 'authenticated'}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [ids[name] || '']);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [ids[name]
      ? JSON.stringify({ sub: ids[name], role: 'authenticated', is_anonymous: name === 'guest' }) : '']);
    return tx.query(sql, params);
  });
}
const one = async (name, sql, params) => rows(await as(name, sql, params))[0];
const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(`${error.code} ${error.message}`));
const setFlag = on => db.query("update private.platform_features set enabled=$1 where key='payments_online'", [on]);
const connect = (shop, status = 'connected') => db.query(`insert into public.payment_provider_accounts
  (business_id, provider, status, provider_user_id, connected_at) values ($1, 'mercadopago', $2, '123456789', now())
  on conflict on constraint payment_provider_accounts_business_provider do update set status = excluded.status`,
[shop.id, status]);

const shops = {};
const legacy = {};
const contact = { name: 'Vecina de Prueba', phone: '2942401122', notes: '', address: 'Los Pehuenes 45' };
const order = async (customer, shop, { method = 'cash_on_pickup', fulfillment = 'pickup' } = {}) =>
  (await one(customer, 'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as id',
    [shop.id, crypto.randomUUID(), fulfillment, method, JSON.stringify(contact),
      JSON.stringify([{ product_id: shop.product, quantity: 2 }]), null])).id;
const version = async id => rows(await db.query('select version from public.orders where id=$1', [id]))[0].version;
const move = async (who, id, status, reason = '') =>
  one(who, 'select (public.transition_order($1,$2,$3,$4,$5)).status as status', [id, await version(id), status, null, reason]);
const orderRow = async id => rows(await db.query('select status, payment_method, payment_status, total_ars from public.orders where id=$1', [id]))[0];
const start = async (who, id) => (await one(who, 'select public.start_payment($1) as r', [id])).r;
const record = async key => (await one('service', 'select public.payment_record_event($1,$2,$3,$4,$5,$6) as r',
  ['mercadopago', key, 'order', 'ORD01TEST', 'order.processed', false])).r;
// El servidor aplica lo que leyó del proveedor: vendedor, referencia o orden, estado e importe.
const apply = async (providerOrder, status, amount, transactions = [], eventId = null,
  { seller = '123456789', reference = null } = {}) =>
  (await one('service', 'select public.payment_apply_update($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) as r',
    ['mercadopago', seller, reference, providerOrder, status, '', amount, JSON.stringify(transactions), eventId])).r;
const setCheckout = (attempt, providerOrder) => as('service', 'select public.payment_attempt_set_checkout($1,$2,$3)',
  [attempt, providerOrder, 'https://pago.example/checkout']);

async function publishedShop(owner, label) {
  const id = (await one(owner, 'select public.create_business($1,$2) as id', [`Comercio ${label}`, `comercio-${label.toLowerCase()}`])).id;
  await as(owner, `update public.businesses set address='San Martín 100', hours_label='Todos los días',
    public_phone='2942555000', delivery_enabled=true, delivery_zone='Casco urbano', delivery_fee_ars=800,
    minimum_order_ars=1000, category_id=(select id from public.business_categories where slug='gastronomia')
    where id=$1`, [id]);
  await as(owner, "insert into public.business_contacts(business_id,owner_name,phone) values ($1,'Titular','2942555001')", [id]);
  const product = (await one(owner, "insert into public.products(business_id,name,price_ars) values ($1,'Empanada',1500) returning id", [id])).id;
  await as(owner, 'select public.submit_business_for_review($1)', [id]);
  await as('admin', "select public.review_business($1,'active','Aprobado')", [id]);
  await as(owner, 'select public.set_business_presence($1,null,true)', [id]);
  return { id, product };
}

before(async () => {
  // Producción hoy: todas las migraciones anteriores a la de pagos.
  const applied = await applyMigrations(db, { until: PAYMENTS });
  assert.ok(applied.length >= 11, 'se reconstruyó el esquema de producción');
  for (const name of NAMES) {
    await db.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)',
      [ids[name], name === 'guest' ? null : email(name), name === 'guest']);
    if (name !== 'guest') await as(name, 'insert into public.profiles (user_id, display_name) values ($1, $2)', [ids[name], `Prueba ${name}`]);
  }
  await db.query('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);
  shops.A = await publishedShop('ownerA', 'A');
  shops.B = await publishedShop('ownerB', 'B');
  await as('ownerA', "select public.add_business_member($1,$2,'manager')", [shops.A.id, email('managerA')]);
  await as('ownerA', "select public.add_business_member($1,$2,'staff')", [shops.A.id, email('staffA')]);
  // Pedidos en efectivo de antes: uno en curso y uno entregado.
  legacy.open = await order('customer1', shops.A);
  legacy.done = await order('customer2', shops.A);
  for (const status of ['accepted', 'preparing', 'ready', 'delivered']) await move('ownerA', legacy.done, status);
  legacy.orders = rows(await db.query(`select id, code, status, version, payment_method, payment_status, total_ars
    from public.orders order by code`));
  legacy.events = rows(await db.query('select count(*)::int as n from public.order_events'))[0].n;
  const file = (await migrationFiles()).find(name => versionOf(name) === PAYMENTS);
  assert.ok(file, 'existe la migración de pagos');
  await applyMigration(db, file);
});
after(async () => { await db.close(); });

// ───────────────── actualización ─────────────────
test('la migración corre sobre datos de producción sin tocar pedidos ni pagos en efectivo', async () => {
  assert.equal(Number((await one('anon', 'select public.app_status() as s')).s.schema), PAYMENTS);
  assert.ok(REQUIRED_SCHEMA >= PAYMENTS, 'este frontend exige esta migración o una posterior');
  assert.deepEqual(rows(await db.query(`select id, code, status, version, payment_method, payment_status, total_ars
    from public.orders order by code`)), legacy.orders);
  assert.equal(rows(await db.query('select count(*)::int as n from public.order_events'))[0].n, legacy.events);
  assert.deepEqual((await orderRow(legacy.done)).payment_status, 'settled');
  for (const table of ['payment_provider_accounts', 'payment_attempts', 'payment_transactions']) {
    assert.equal(rows(await db.query(`select count(*)::int as n from public.${table}`))[0].n, 0, `${table} vacía`);
  }
});

test('el interruptor de pagos online existe y está apagado', async () => {
  const features = (await one('anon', 'select public.app_status() as s')).s.features;
  assert.equal(features.payments_online, false);
  assert.equal(rows(await db.query("select enabled from private.platform_features where key='payments_online'"))[0].enabled, false);
});

test('la máquina de estados de esta migración está contenida en la de la aplicación', async () => {
  // La igualdad exacta, con todas las migraciones, se prueba en payments-sandbox.
  const sql = rows(await db.query("select from_status || '>' || to_status as t from private.payment_status_transitions order by 1"))
    .map(row => row.t);
  const js = Object.entries(PAYMENT_TRANSITIONS).flatMap(([from, list]) => list.map(to => `${from}>${to}`));
  for (const transition of sql) assert.ok(js.includes(transition), transition);
});

// ───────────────── interruptor apagado ─────────────────
test('con los pagos apagados sólo se ofrece efectivo, aunque la cuenta figure conectada', async () => {
  await connect(shops.A);
  try {
    const methods = (await one('anon', 'select public.payment_methods($1) as m', [shops.A.id])).m;
    assert.deepEqual(methods.map(method => method.id), ['cash_on_pickup', 'cash_on_delivery']);
    await rejects(order('customer1', shops.A, { method: 'online' }), /23514 Payment method not available/);
    await rejects(order('guest', shops.A, { method: 'online', fulfillment: 'delivery' }), /Payment method not available/);
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id=$1", [shops.A.id]);
  }
});

test('un comercio pausado o inexistente no ofrece ninguna forma de pago', async () => {
  assert.deepEqual((await one('anon', 'select public.payment_methods($1) as m', [crypto.randomUUID()])).m, []);
});

test('con los pagos encendidos, un comercio sin Mercado Pago conectado sigue sólo con efectivo', async () => {
  await setFlag(true);
  try {
    for (const status of [null, 'not_connected', 'connecting', 'reconnect_required']) {
      if (status) await connect(shops.B, status);
      const methods = (await one('anon', 'select public.payment_methods($1) as m', [shops.B.id])).m;
      assert.deepEqual(methods.map(method => method.kind), ['cash', 'cash'], `cuenta ${status || 'inexistente'}`);
      await rejects(order('customer1', shops.B, { method: 'online' }), /Payment method not available/);
    }
  } finally {
    await setFlag(false);
    await db.query('delete from public.payment_provider_accounts where business_id=$1', [shops.B.id]);
  }
});

// ───────────────── interruptor encendido (sólo en esta prueba) ─────────────────
test('encendido y conectado: el pedido online nace esperando el pago y no se acepta hasta aprobarlo', async () => {
  await setFlag(true);
  await connect(shops.A);
  try {
    const methods = (await one('anon', 'select public.payment_methods($1) as m', [shops.A.id])).m;
    const online = methods.find(method => method.id === 'online');
    assert.deepEqual({ ...online, flows: undefined }, { id: 'online', kind: 'online', provider: 'mercadopago',
      label: 'Mercado Pago', flows: undefined });
    const id = await order('customer1', shops.A, { method: 'online' });
    assert.deepEqual(await orderRow(id), { status: 'submitted', payment_method: 'online', payment_status: 'pending', total_ars: 3000 });
    await rejects(move('ownerA', id, 'accepted'), /U0007 Payment not approved/);
    // El pago se aprueba sólo por el servidor, con lo que leyó del proveedor.
    const attempt = await start('customer1', id);
    await setCheckout(attempt.attempt_id, 'ORD-ACEPTAR-1');
    const result = await apply('ORD-ACEPTAR-1', 'approved', 3000, [{ kind: 'payment', id: 'PAY-1', status: 'approved', amount: 3000,
      method_type: 'account_money' }]);
    assert.deepEqual({ outcome: result.outcome, status: result.status }, { outcome: 'applied', status: 'approved' });
    assert.equal((await orderRow(id)).payment_status, 'approved');
    assert.equal((await move('ownerA', id, 'accepted')).status, 'accepted');
    // Entregar no pisa el pago online con "settled": el efectivo sí.
    for (const status of ['preparing', 'ready', 'delivered']) await move('ownerA', id, status);
    assert.deepEqual(await orderRow(id), { status: 'delivered', payment_method: 'online', payment_status: 'approved', total_ars: 3000 });
  } finally {
    await setFlag(false);
  }
});

test('doble toque o reintento: el mismo intento, con la misma clave de idempotencia', async () => {
  await setFlag(true);
  try {
    const id = await order('customer2', shops.A, { method: 'online', fulfillment: 'delivery' });
    const first = await start('customer2', id);
    const second = await start('customer2', id);
    assert.equal(first.attempt_id, second.attempt_id);
    const keys = rows(await db.query('select idempotency_key from public.payment_attempts where order_id=$1', [id]));
    assert.equal(keys.length, 1, 'un solo intento');
    // El importe sale del pedido: 2 × 1500 + envío 800.
    assert.equal(first.amount, 3800);
    // Un intento vivo por pedido, garantizado por la base.
    await rejects(db.query(`insert into public.payment_attempts (order_id, business_id, provider, flow, amount_ars)
      values ($1, $2, 'mercadopago', 'checkout_pro', 3800)`, [id, shops.A.id]), /23505/);
    // Rechazado: el siguiente intento es otro, con otra clave.
    await setCheckout(first.attempt_id, 'ORD-REINTENTO-1');
    await apply('ORD-REINTENTO-1', 'rejected', 3800);
    assert.equal((await orderRow(id)).payment_status, 'rejected');
    const retry = await start('customer2', id);
    assert.notEqual(retry.attempt_id, first.attempt_id);
    const both = rows(await db.query('select idempotency_key::text as k from public.payment_attempts where order_id=$1', [id]));
    assert.equal(new Set(both.map(row => row.k)).size, 2, 'claves distintas por intento');
    assert.equal((await orderRow(id)).payment_status, 'pending');
    // Otra persona no inicia el pago de un pedido ajeno.
    await rejects(start('customer1', id), /P0002/);
    // Un pedido en efectivo no tiene pago online.
    await rejects(start('customer1', legacy.open), /Payment not required/);
  } finally {
    await setFlag(false);
  }
});

test('con el interruptor apagado no se inicia ningún pago, ni siquiera de un pedido online previo', async () => {
  await setFlag(true);
  const id = await order('customer1', shops.A, { method: 'online' });
  await setFlag(false);
  await rejects(start('customer1', id), /Payment method not available/);
});

// ───────────────── webhooks ─────────────────
test('la misma notificación dos veces se anota una sola vez y no duplica movimientos', async () => {
  await setFlag(true);
  try {
    const id = await order('customer1', shops.A, { method: 'online' });
    const attempt = await start('customer1', id);
    await setCheckout(attempt.attempt_id, 'ORD-DUP-1');
    const first = await record('evento-duplicado-1');
    const again = await record('evento-duplicado-1');
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(first.event_id, again.event_id);
    const movement = [{ kind: 'payment', id: 'PAY-DUP-1', status: 'approved', amount: 3000, method_type: 'credit_card' }];
    await apply('ORD-DUP-1', 'approved', 3000, movement, first.event_id);
    const repeated = await apply('ORD-DUP-1', 'approved', 3000, movement, first.event_id);
    assert.equal(repeated.status, 'approved');
    assert.equal(rows(await db.query("select count(*)::int as n from public.payment_transactions where provider_transaction_id='PAY-DUP-1'"))[0].n, 1);
    assert.equal(rows(await db.query("select outcome from private.payment_events where id=$1", [first.event_id]))[0].outcome, 'applied');
  } finally {
    await setFlag(false);
  }
});

test('una notificación cuya reconciliación falló se vuelve a procesar cuando el proveedor reintenta', async () => {
  const first = await record('evento-reintento-1');
  assert.equal(first.duplicate, false);
  await one('service', "select public.payment_mark_event($1, 'failed', 'La API del proveedor no respondió')", [first.event_id]);
  const retried = await record('evento-reintento-1');
  assert.deepEqual({ duplicate: retried.duplicate, retry: retried.retry, id: retried.event_id },
    { duplicate: false, retry: true, id: first.event_id }, 'el reintento toma la misma notificación');
  const [row] = rows(await db.query('select outcome, retries, detail from private.payment_events where id=$1', [first.event_id]));
  assert.deepEqual({ ...row }, { outcome: 'received', retries: 1, detail: '' });
  // Mientras se procesa, otro envío del mismo aviso es duplicado.
  assert.equal((await record('evento-reintento-1')).duplicate, true);
  // Lo ignorado o marcado para revisar no se reprocesa.
  await one('service', "select public.payment_mark_event($1, 'ignored', 'Sin referencia de CAUCE')", [first.event_id]);
  assert.equal((await record('evento-reintento-1')).duplicate, true);
});

test('un segundo pago aprobado del mismo intento queda para revisar y el comercio lo ve', async () => {
  await setFlag(true);
  try {
    const id = await order('customer8', shops.A, { method: 'online' });
    const attempt = await start('customer8', id);
    await setCheckout(attempt.attempt_id, 'ORD-DOBLE-1');
    const total = rows(await db.query('select total_ars::int as t from public.orders where id=$1', [id]))[0].t;
    const pay = payId => [{ kind: 'payment', id: payId, status: 'approved', amount: total, method_type: 'credit_card' }];
    const first = await record('evento-doble-1');
    assert.equal((await apply('ORD-DOBLE-1', 'approved', total, pay('PAY-DOBLE-1'), first.event_id)).outcome, 'applied');
    const second = await record('evento-doble-2');
    const result = await apply('ORD-DOBLE-1', 'approved', total, pay('PAY-DOBLE-2'), second.event_id);
    assert.deepEqual({ outcome: result.outcome, status: result.status }, { outcome: 'flagged', status: 'approved' });
    const [event] = rows(await db.query('select outcome, detail from private.payment_events where id=$1', [second.event_id]));
    assert.deepEqual({ ...event }, { outcome: 'flagged', detail: 'duplicate_payment' });
    const overview = await one('ownerA', 'select public.business_payment_overview($1) as r', [shops.A.id]);
    assert.ok(overview.r.to_review >= 1, 'el panel lo muestra para revisar');
  } finally {
    await setFlag(false);
  }
});

test('nunca se aprueba por un importe distinto del pedido', async () => {
  await setFlag(true);
  try {
    const id = await order('customer3', shops.A, { method: 'online' });
    const attempt = await start('customer3', id);
    await setCheckout(attempt.attempt_id, 'ORD-IMPORTE-1');
    const event = await record('evento-importe-1');
    const result = await apply('ORD-IMPORTE-1', 'approved', 10, [], event.event_id);
    assert.deepEqual({ outcome: result.outcome, status: result.status }, { outcome: 'flagged', status: 'processing' });
    assert.equal((await orderRow(id)).payment_status, 'processing');
    const flagged = rows(await db.query('select outcome, detail from private.payment_events where id=$1', [event.event_id]))[0];
    assert.deepEqual(flagged, { outcome: 'flagged', detail: 'amount_mismatch' });
    await rejects(move('ownerA', id, 'accepted'), /U0007/);
  } finally {
    await setFlag(false);
  }
});

test('un salto que la máquina de estados no admite, o una orden desconocida, se ignora y queda anotado', async () => {
  await setFlag(true);
  try {
    const id = await order('customer2', shops.A, { method: 'online' });
    const attempt = await start('customer2', id);
    await setCheckout(attempt.attempt_id, 'ORD-SALTO-1');
    await apply('ORD-SALTO-1', 'approved', 3000);
    const back = await record('evento-salto-1');
    const ignored = await apply('ORD-SALTO-1', 'pending', 3000, [], back.event_id);
    assert.deepEqual({ outcome: ignored.outcome, status: ignored.status }, { outcome: 'ignored', status: 'approved' });
    assert.equal((await orderRow(id)).payment_status, 'approved');
    const unknown = await apply('ORD-QUE-NO-EXISTE', 'approved', 3000);
    assert.equal(unknown.outcome, 'ignored');
    // Un vendedor que no es la cuenta de este comercio no toca su pago.
    const foreign = await apply('ORD-SALTO-1', 'refunded', 3000, [], null, { seller: '999999' });
    assert.deepEqual({ outcome: foreign.outcome, reason: foreign.reason }, { outcome: 'ignored', reason: 'seller_mismatch' });
    assert.equal((await orderRow(id)).payment_status, 'approved');
    // Por nuestra referencia (external_reference) también se encuentra el intento.
    const byReference = await apply(null, 'refunded', 3000, [], null, { reference: attempt.attempt_id });
    assert.deepEqual({ outcome: byReference.outcome, status: byReference.status }, { outcome: 'applied', status: 'refunded' });
    await rejects(apply('ORD-SALTO-1', 'pagado', 3000), /Invalid payment status/);
  } finally {
    await setFlag(false);
  }
});

test('ningún cliente ejecuta las funciones del servidor: webhooks, OAuth ni credenciales', async () => {
  for (const who of ['anon', 'customer1', 'ownerA', 'admin']) {
    await rejects(as(who, "select public.payment_record_event('mercadopago','evento-falso-1','order','X','a',false)"), /42501|permission denied/);
    await rejects(as(who, "select public.payment_apply_update('mercadopago','1',null,'ORD-X','approved','',1,'[]'::jsonb,null)"), /42501|permission denied/);
    await rejects(as(who, 'select public.payment_account_credentials($1, $2)', [shops.A.id, 'mercadopago']), /42501|permission denied/);
    await rejects(as(who, "select public.payment_oauth_complete(repeat('s',40),'1','{}',false,null,'cifrado-cifrado-1','',1::smallint)"), /42501|permission denied/);
    await rejects(as(who, 'select public.payment_checkout_context($1)', [crypto.randomUUID()]), /42501|permission denied/);
    await rejects(as(who, "select public.payment_mark_event(1,'ignored','x')"), /42501|permission denied/);
    await rejects(as(who, "select public.payment_seller_credentials('mercadopago','1')"), /42501|permission denied/);
  }
});

test('el cliente no escribe pagos ni el estado del pago de su pedido', async () => {
  await rejects(as('customer1', `insert into public.payment_attempts (order_id, business_id, provider, flow, amount_ars)
    values ($1, $2, 'mercadopago', 'checkout_pro', 1)`, [legacy.open, shops.A.id]), /42501|permission denied/);
  await rejects(as('customer1', "update public.payment_attempts set status='approved'"), /42501|permission denied/);
  await rejects(as('ownerA', "insert into public.payment_transactions (attempt_id, business_id, provider, kind, provider_transaction_id, status, amount_ars) values ($1,$2,'mercadopago','payment','P','approved',1)",
    [crypto.randomUUID(), shops.A.id]), /42501|permission denied/);
  await rejects(as('ownerA', "insert into public.payment_provider_accounts (business_id, provider, status) values ($1,'mercadopago','connected')",
    [shops.A.id]), /42501|permission denied/);
  await rejects(as('customer1', "update public.orders set payment_status='settled' where id=$1", [legacy.open]), /42501|permission denied/);
  assert.equal((await orderRow(legacy.open)).payment_status, 'pending_on_delivery');
});

// ───────────────── aislamiento y conexión del comercio ─────────────────
test('el comercio B no ve la cuenta, los intentos ni los movimientos del comercio A', async () => {
  await connect(shops.A);
  try {
    assert.equal(rows(await as('ownerB', 'select * from public.payment_provider_accounts')).length, 0);
    assert.equal(rows(await as('ownerB', 'select * from public.payment_attempts')).length, 0);
    assert.equal(rows(await as('ownerB', 'select * from public.payment_transactions')).length, 0);
    await rejects(as('ownerB', 'select public.business_payment_overview($1)', [shops.A.id]), /42501 Not allowed/);
    await rejects(as('ownerB', 'select public.disconnect_payment_account($1,$2)', [shops.A.id, 'mercadopago']), /42501/);
    // Equipo atiende pedidos pero no ve la cuenta; titular y encargado/a, sí.
    assert.equal(rows(await as('staffA', 'select * from public.payment_provider_accounts')).length, 0);
    assert.equal(rows(await as('managerA', 'select * from public.payment_provider_accounts')).length, 1);
    await rejects(as('staffA', 'select public.business_payment_overview($1)', [shops.A.id]), /42501/);
    // Las credenciales no las lee nadie desde el cliente, tampoco el titular.
    await rejects(as('ownerA', 'select * from private.payment_provider_credentials'), /42501|permission denied/);
  } finally {
    await db.query('delete from public.payment_provider_accounts where business_id=$1', [shops.A.id]);
  }
});

test('OAuth: sólo el titular, con el interruptor encendido, y el state se usa una vez antes de vencer', async () => {
  const state = 's'.repeat(24) + crypto.randomUUID().replaceAll('-', '');
  const verifier = 'v'.repeat(50);
  await rejects(as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)',
    [shops.A.id, 'mercadopago', ids.ownerA, state, verifier]), /Payments disabled/);
  await setFlag(true);
  try {
    await rejects(as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)',
      [shops.A.id, 'mercadopago', ids.managerA, state, verifier]), /Not allowed/);
    await rejects(as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)',
      [shops.A.id, 'mercadopago', ids.ownerB, state, verifier]), /Not allowed/);
    await as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)', [shops.A.id, 'mercadopago', ids.ownerA, state, verifier]);
    assert.equal(rows(await db.query('select status from public.payment_provider_accounts where business_id=$1', [shops.A.id]))[0].status, 'connecting');
    const lookup = (await one('service', 'select public.payment_oauth_lookup($1) as l', [state])).l;
    assert.deepEqual(lookup, { business_id: shops.A.id, provider: 'mercadopago', code_verifier: verifier });
    await rejects(as('ownerA', 'select public.payment_oauth_lookup($1)', [state]), /42501|permission denied/);
    const done = (await one('service', 'select public.payment_oauth_complete($1,$2,$3,$4,$5,$6,$7,$8) as r',
      [state, '987654321', ['offline_access', 'read', 'write'], false, new Date(Date.now() + 86400000).toISOString(),
        'cifrado-de-prueba-acceso', 'cifrado-de-prueba-refresco', 1])).r;
    assert.deepEqual(done, { business_id: shops.A.id, provider: 'mercadopago' });
    await rejects(as('service', 'select public.payment_oauth_complete($1,$2,$3,$4,$5,$6,$7,$8)',
      [state, '987654321', [], false, null, 'cifrado-de-prueba-otra', '', 1]), /Invalid or expired state/);
    assert.equal((await one('service', 'select public.payment_oauth_lookup($1) as l', [state])).l, null, 'usado: no se vuelve a canjear');
    // Lo que ve el titular: estado de la conexión, sin ningún secreto.
    const overview = (await one('ownerA', 'select public.business_payment_overview($1) as o', [shops.A.id])).o;
    assert.equal(overview.enabled, true);
    assert.equal(overview.accounts[0].status, 'connected');
    assert.equal(overview.accounts[0].provider_user_id, '987654321');
    assert.equal(JSON.stringify(overview).includes('cifrado'), false, 'ningún token cifrado sale hacia el comercio');
    const today = rows(await db.query(`select
        count(*) filter (where status in ('approved','partially_refunded'))::int as approved,
        coalesce(sum(amount_ars) filter (where status in ('approved','partially_refunded')), 0)::int as approved_ars,
        count(*) filter (where status in ('pending','processing'))::int as pending,
        count(*) filter (where status = 'rejected')::int as rejected,
        count(*) filter (where status in ('refunded','partially_refunded'))::int as refunded,
        count(*) filter (where cancel_requested_at is not null and status in ('approved','partially_refunded'))::int as to_refund
      from public.payment_attempts where business_id = $1`, [shops.A.id]))[0];
    assert.deepEqual(overview.today, today, 'los números del día salen de los intentos reales');
    assert.ok(today.approved > 0 && today.rejected > 0, 'las pruebas anteriores dejaron pagos aprobados y rechazados');
    // Otro comercio sin pagos: ceros, sin valores simulados.
    const empty = (await one('ownerB', 'select public.business_payment_overview($1) as o', [shops.B.id])).o;
    assert.deepEqual(empty.today, { approved: 0, approved_ars: 0, pending: 0, rejected: 0, refunded: 0, to_refund: 0 });
    assert.deepEqual(empty.accounts, []);
    // El servidor lee las credenciales cifradas para llamar al proveedor.
    const credentials = (await one('service', 'select public.payment_account_credentials($1,$2) as c', [shops.A.id, 'mercadopago'])).c;
    assert.equal(credentials.access_token_ciphertext, 'cifrado-de-prueba-acceso');
    // El webhook trae el vendedor: sus credenciales, sólo si la cuenta está conectada.
    const seller = (await one('service', 'select public.payment_seller_credentials($1,$2) as c', ['mercadopago', '987654321'])).c;
    assert.equal(seller.business_id, shops.A.id);
    assert.equal((await one('service', 'select public.payment_seller_credentials($1,$2) as c', ['mercadopago', '111'])).c, null);
    // Encargado/a no desconecta; el titular sí, y las credenciales se borran.
    await rejects(as('managerA', 'select public.disconnect_payment_account($1,$2)', [shops.A.id, 'mercadopago']), /42501/);
    await as('ownerA', 'select public.disconnect_payment_account($1,$2)', [shops.A.id, 'mercadopago']);
    assert.equal(rows(await db.query('select count(*)::int as n from private.payment_provider_credentials'))[0].n, 0);
    assert.equal(rows(await db.query('select status from public.payment_provider_accounts where business_id=$1', [shops.A.id]))[0].status, 'not_connected');
    // Un state vencido no sirve.
    const late = 'l'.repeat(24) + crypto.randomUUID().replaceAll('-', '');
    await as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)', [shops.A.id, 'mercadopago', ids.ownerA, late, verifier]);
    await db.query("update private.payment_oauth_states set expires_at = now() - interval '1 minute' where state=$1", [late]);
    await rejects(as('service', 'select public.payment_oauth_complete($1,$2,$3,$4,$5,$6,$7,$8)',
      [late, '1', [], false, null, 'cifrado-de-prueba-tarde', '', 1]), /Invalid or expired state/);
  } finally {
    await setFlag(false);
    await db.query('delete from public.payment_provider_accounts where business_id=$1', [shops.A.id]);
  }
});

test('cancelar un pedido online pide anular el pago en el proveedor sin darlo por anulado', async () => {
  await setFlag(true);
  await connect(shops.A);
  try {
    const id = await order('customer2', shops.A, { method: 'online' });
    const attempt = await start('customer2', id);
    await move('ownerA', id, 'canceled', 'Sin stock');
    const row = rows(await db.query('select status, cancel_requested_at from public.payment_attempts where id=$1', [attempt.attempt_id]))[0];
    assert.equal(row.status, 'pending', 'el estado lo confirma el proveedor');
    assert.ok(row.cancel_requested_at, 'queda pedido anular el cobro');
    assert.equal((await orderRow(id)).payment_status, 'pending');
    await rejects(start('customer2', id), /Order canceled/);
  } finally {
    await setFlag(false);
    await db.query('delete from public.payment_provider_accounts where business_id=$1', [shops.A.id]);
  }
});

test('las páginas de retorno leen el estado real sólo del pedido propio o del comercio', async () => {
  await setFlag(true);
  await connect(shops.A);
  try {
    const id = await order('customer4', shops.A, { method: 'online' });
    const attempt = await start('customer4', id);
    const byAttempt = (await one('customer4', 'select public.payment_status($1) as s', [attempt.attempt_id])).s;
    const byOrder = (await one('customer4', 'select public.payment_status($1) as s', [id])).s;
    assert.equal(byAttempt.order_id, id);
    assert.equal(byOrder.payment_status, 'pending');
    assert.equal(byOrder.attempt.id, attempt.attempt_id);
    assert.equal((await one('ownerA', 'select public.payment_status($1) as s', [id])).s.payment_status, 'pending');
    assert.equal((await one('stranger', 'select public.payment_status($1) as s', [id])).s, null);
    assert.equal((await one('ownerB', 'select public.payment_status($1) as s', [attempt.attempt_id])).s, null);
    await rejects(as('anon', 'select public.payment_status($1)', [id]), /42501|permission denied/);
    // El seguimiento público suma el estado del pago (nada del proveedor).
    const token = rows(await db.query('select tracking_token from public.orders where id=$1', [id]))[0].tracking_token;
    const tracked = (await one('anon', 'select public.track_order($1) as t', [token])).t;
    assert.equal(tracked.payment_status, 'pending');
    assert.equal(JSON.stringify(tracked).includes('idempotency'), false);
  } finally {
    await setFlag(false);
    await db.query('delete from public.payment_provider_accounts where business_id=$1', [shops.A.id]);
  }
});

test('el efectivo sigue igual: se liquida al entregar', async () => {
  const id = await order('customer5', shops.B, { method: 'cash_on_pickup' });
  for (const status of ['accepted', 'preparing', 'ready', 'delivered']) await move('ownerB', id, status);
  assert.deepEqual(await orderRow(id), { status: 'delivered', payment_method: 'cash_on_pickup', payment_status: 'settled', total_ars: 3000 });
  // La base no deja mezclar estados de efectivo con los del pago online.
  await rejects(db.query("update public.orders set payment_status='approved' where id=$1", [id]), /orders_payment_status_matches_method/);
});

test('desde cero, todas las migraciones construyen el contrato de pagos', async () => {
  const fresh = new PGlite();
  try {
    await applyMigrations(fresh);
    const status = rows(await fresh.query('select private.app_status() as s'))[0].s;
    assert.equal(Number(status.schema), REQUIRED_SCHEMA);
    assert.equal(status.features.payments_online, false);
    const privileged = rows(await fresh.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef`));
    assert.deepEqual(privileged, [], 'ninguna función con privilegios en public');
  } finally {
    await fresh.close();
  }
});
