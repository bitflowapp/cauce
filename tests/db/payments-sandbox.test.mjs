// Pagos online a prueba en un comercio (sandbox de Mercado Pago), en
// PostgreSQL embebido (PGlite) con las migraciones reales. La base se construye
// como está hoy en producción (pagos preparados, interruptor apagado) y recién
// ahí se aplica la migración del sandbox: se prueba que no enciende nada para
// nadie y, sobre esa base, el piloto por comercio, el freno a cuentas reales en
// un piloto de prueba, la renovación de tokens, el vencimiento de intentos y
// los aprobados que llegan tarde o repetidos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, applyMigration, migrationFiles, versionOf } from './fixture.mjs';
import { REQUIRED_SCHEMA } from '../../js/core/contract.js';
import { PAYMENT_TRANSITIONS } from '../../js/core/payment.js';

const SANDBOX = 20260927120000;
const db = new PGlite();
const NAMES = ['ownerA', 'managerA', 'staffA', 'ownerB', 'customer1', 'customer2', 'customer3', 'customer4', 'customer5',
  'customer6', 'stranger', 'admin', 'guest'];
const ids = Object.fromEntries(NAMES.map((name, i) => [name, `50000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
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
const pilot = (shop, sandbox = true) => db.query(`insert into private.payment_pilot_businesses (business_id, sandbox, reason)
  values ($1, $2, 'CAUCE QA · Mercado Pago') on conflict (business_id) do update set sandbox = excluded.sandbox`, [shop.id, sandbox]);
const unpilot = shop => db.query('delete from private.payment_pilot_businesses where business_id=$1', [shop.id]);
const connect = (shop, { live = false, seller = shop.seller, status = 'connected' } = {}) => db.query(`
  with account as (
    insert into public.payment_provider_accounts (business_id, provider, status, provider_user_id, live_mode, connected_at,
      token_expires_at)
    values ($1, 'mercadopago', $2, $3, $4, now(), now() + interval '180 days')
    on conflict on constraint payment_provider_accounts_business_provider do update set status = excluded.status,
      provider_user_id = excluded.provider_user_id, live_mode = excluded.live_mode
    returning id)
  insert into private.payment_provider_credentials (account_id, access_token_ciphertext, refresh_token_ciphertext,
    key_version, expires_at)
  select id, 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb', 'v1.cccccccccccccccc.dddddddddddddddd', 1, now() + interval '180 days'
  from account
  on conflict (account_id) do update set expires_at = excluded.expires_at`, [shop.id, status, seller, live]);
const methodsOf = async shop => (await one('anon', 'select public.payment_methods($1) as m', [shop.id])).m.map(item => item.id);

const shops = {};
const contact = { name: 'Vecina de Prueba', phone: '2942401122', notes: '', address: 'Los Pehuenes 45' };
const order = async (customer, shop, { method = 'online', fulfillment = 'pickup' } = {}) =>
  (await one(customer, 'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as id',
    [shop.id, crypto.randomUUID(), fulfillment, method, JSON.stringify(contact),
      JSON.stringify([{ product_id: shop.product, quantity: 2 }]), null])).id;
const orderRow = async id => rows(await db.query('select status, payment_method, payment_status, total_ars from public.orders where id=$1', [id]))[0];
const attemptRow = async id => rows(await db.query('select id, status, status_detail, provider_order_id from public.payment_attempts where id=$1', [id]))[0];
const start = async (who, id) => (await one(who, 'select public.start_payment($1) as r', [id])).r;
const setCheckout = (attempt, providerOrder) => as('service', 'select public.payment_attempt_set_checkout($1,$2,$3)',
  [attempt, providerOrder, `https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=${providerOrder}`]);
let eventSeq = 0;
const record = async () => (await one('service', 'select public.payment_record_event($1,$2,$3,$4,$5,$6) as r',
  ['mercadopago', `evento-${(eventSeq += 1)}`, 'order', 'ORDTST01PRUEBA', 'order.processed', false])).r.event_id;
const apply = async ({ seller, reference = null, providerOrder = null, status, amount, transactions = [], eventId = null }) =>
  (await one('service', 'select public.payment_apply_update($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) as r',
    ['mercadopago', seller, reference, providerOrder, status, '', amount, JSON.stringify(transactions), eventId])).r;
const eventRow = async id => rows(await db.query('select outcome, detail from private.payment_events where id=$1', [id]))[0];
const version = async id => rows(await db.query('select version from public.orders where id=$1', [id]))[0].version;
const move = async (who, id, status, reason = '') =>
  one(who, 'select (public.transition_order($1,$2,$3,$4,$5)).status as status', [id, await version(id), status, null, reason]);

async function publishedShop(owner, label, seller) {
  const id = (await one(owner, 'select public.create_business($1,$2) as id', [`CAUCE QA · Mercado Pago ${label}`,
    `cauce-qa-mercado-pago-${label.toLowerCase()}`])).id;
  await as(owner, `update public.businesses set address='San Martín 100', hours_label='Todos los días',
    public_phone='2942555000', delivery_enabled=true, delivery_zone='Casco urbano', delivery_fee_ars=800,
    minimum_order_ars=1000, category_id=(select id from public.business_categories where slug='gastronomia')
    where id=$1`, [id]);
  await as(owner, "insert into public.business_contacts(business_id,owner_name,phone) values ($1,'Titular QA','2942555001')", [id]);
  const product = (await one(owner, "insert into public.products(business_id,name,price_ars) values ($1,'Empanada',1500) returning id", [id])).id;
  await as(owner, 'select public.submit_business_for_review($1)', [id]);
  await as('admin', "select public.review_business($1,'active','Aprobado')", [id]);
  await as(owner, 'select public.set_business_presence($1,null,true)', [id]);
  return { id, product, seller };
}

let before_counts;
before(async () => {
  // Producción hoy: todas las migraciones anteriores a la del sandbox.
  await applyMigrations(db, { until: SANDBOX });
  for (const name of NAMES) {
    await db.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)',
      [ids[name], name === 'guest' ? null : email(name), name === 'guest']);
    if (name !== 'guest') await as(name, 'insert into public.profiles (user_id, display_name) values ($1, $2)', [ids[name], `Prueba ${name}`]);
  }
  await db.query('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);
  shops.A = await publishedShop('ownerA', 'A', '1111111111');
  shops.B = await publishedShop('ownerB', 'B', '2222222222');
  await as('ownerA', "select public.add_business_member($1,$2,'manager')", [shops.A.id, email('managerA')]);
  await as('ownerA', "select public.add_business_member($1,$2,'staff')", [shops.A.id, email('staffA')]);
  before_counts = rows(await db.query(`select (select count(*)::int from public.orders) as orders,
    (select count(*)::int from public.payment_attempts) as attempts`))[0];
  const file = (await migrationFiles()).find(name => versionOf(name) === SANDBOX);
  assert.ok(file, 'existe la migración del sandbox');
  await applyMigration(db, file);
});
after(async () => { await db.close(); });

// ───────────────── actualización ─────────────────
test('la migración no enciende nada: interruptor apagado, ningún piloto y los datos intactos', async () => {
  const status = (await one('anon', 'select public.app_status() as s')).s;
  assert.equal(Number(status.schema), SANDBOX);
  assert.equal(SANDBOX, REQUIRED_SCHEMA, 'el contrato que exige este frontend');
  assert.equal(status.features.payments_online, false);
  assert.equal(rows(await db.query('select count(*)::int as n from private.payment_pilot_businesses'))[0].n, 0);
  assert.equal((await one('service', 'select public.payments_accepting() as ok')).ok, false);
  assert.deepEqual(rows(await db.query(`select (select count(*)::int from public.orders) as orders,
    (select count(*)::int from public.payment_attempts) as attempts`))[0], before_counts);
});

test('la máquina de estados del pago es la misma en la base y en la aplicación', async () => {
  const sql = rows(await db.query("select from_status || '>' || to_status as t from private.payment_status_transitions order by 1"))
    .map(row => row.t);
  const js = Object.entries(PAYMENT_TRANSITIONS).flatMap(([from, list]) => list.map(to => `${from}>${to}`)).sort();
  assert.deepEqual(sql, js);
});

// ───────────────── piloto por comercio ─────────────────
test('un comercio piloto cobra online con el interruptor apagado; el resto sigue sólo con efectivo', async () => {
  await pilot(shops.A);
  await connect(shops.A);
  await connect(shops.B);
  try {
    assert.equal((await one('service', 'select public.payments_accepting() as ok')).ok, true);
    assert.deepEqual(await methodsOf(shops.A), ['cash_on_pickup', 'cash_on_delivery', 'online']);
    assert.deepEqual(await methodsOf(shops.B), ['cash_on_pickup', 'cash_on_delivery'], 'B no es piloto');
    // El interruptor global sigue apagado para todos.
    assert.equal((await one('anon', 'select public.app_status() as s')).s.features.payments_online, false);
    await rejects(order('customer1', shops.B), /23514 Payment method not available/);
    const id = await order('customer1', shops.A);
    assert.deepEqual(await orderRow(id), { status: 'submitted', payment_method: 'online', payment_status: 'pending',
      total_ars: 3000 });
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id = any($1)", [[shops.A.id, shops.B.id]]);
    await unpilot(shops.A);
  }
});

test('un piloto en sandbox sólo cobra con una cuenta de prueba declarada; una real ni se guarda', async () => {
  await pilot(shops.A);
  try {
    await connect(shops.A, { live: true });
    assert.deepEqual(await methodsOf(shops.A), ['cash_on_pickup', 'cash_on_delivery'], 'cuenta real: sin online');
    await db.query("update public.payment_provider_accounts set live_mode = null where business_id = $1", [shops.A.id]);
    assert.deepEqual(await methodsOf(shops.A), ['cash_on_pickup', 'cash_on_delivery'], 'sin declarar: sin online');
    await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
    // El canje de una cuenta real en un piloto de prueba se rechaza y el state no sirve más.
    const state = 's'.repeat(43);
    await as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)', [shops.A.id, 'mercadopago', ids.ownerA, state, 'v'.repeat(64)]);
    const lookup = (await one('service', 'select public.payment_oauth_lookup($1) as r', [state])).r;
    assert.deepEqual({ enabled: lookup.enabled, sandbox: lookup.sandbox }, { enabled: true, sandbox: true });
    await rejects(as('service', 'select public.payment_oauth_complete($1,$2,$3,$4,$5,$6,$7,$8)',
      [state, '1111111111', ['read'], true, null, 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb', '', 1]), /Live account not allowed in sandbox/);
    assert.equal(rows(await db.query('select count(*)::int as n from private.payment_provider_credentials c join public.payment_provider_accounts a on a.id = c.account_id where a.business_id = $1', [shops.A.id]))[0].n, 0);
    // Con una cuenta de prueba, se conecta.
    const good = 't'.repeat(43);
    await as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)', [shops.A.id, 'mercadopago', ids.ownerA, good, 'w'.repeat(64)]);
    await as('service', 'select public.payment_oauth_complete($1,$2,$3,$4,$5,$6,$7,$8)',
      [good, '1111111111', ['read', 'offline_access'], false, null, 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb', '', 1]);
    assert.deepEqual(await methodsOf(shops.A), ['cash_on_pickup', 'cash_on_delivery', 'online']);
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
    await unpilot(shops.A);
  }
});

test('ningún cliente enciende un piloto ni ejecuta las funciones nuevas del servidor', async () => {
  for (const who of ['anon', 'ownerA', 'admin', 'customer1']) {
    await rejects(as(who, "insert into private.payment_pilot_businesses (business_id, reason) values ($1, 'intento')", [shops.A.id]),
      /42501|permission denied/);
    for (const sql of ['select public.payments_accepting()', "select public.payment_oauth_discard('x')",
      'select public.payment_accounts_expiring(30)',
      "select public.payment_account_rotate(gen_random_uuid(), 'v1.a.b', '', 1::smallint, now())"]) {
      await rejects(as(who, sql), /42501|permission denied/);
    }
  }
});

test('el panel ve si su comercio es piloto; nadie más lo ve', async () => {
  await pilot(shops.A);
  try {
    const flag = async (who, shop) => (await one(who, 'select public.payments_pilot(b) as p from public.businesses b where b.id = $1',
      [shop.id])).p;
    assert.equal(await flag('ownerA', shops.A), true);
    assert.equal(await flag('managerA', shops.A), true);
    assert.equal(await flag('staffA', shops.A), null);
    assert.equal(await flag('ownerB', shops.A), null);
    assert.equal(await flag('ownerB', shops.B), false);
    await rejects(as('anon', 'select public.payments_pilot(b) from public.businesses b limit 1'), /42501|permission denied/);
    const overview = (await one('ownerA', 'select public.business_payment_overview($1) as o', [shops.A.id])).o;
    assert.deepEqual({ enabled: overview.enabled, sandbox: overview.sandbox }, { enabled: true, sandbox: true });
    const other = (await one('ownerB', 'select public.business_payment_overview($1) as o', [shops.B.id])).o;
    assert.deepEqual({ enabled: other.enabled, sandbox: other.sandbox }, { enabled: false, sandbox: false });
  } finally {
    await unpilot(shops.A);
  }
});

// ───────────────── OAuth ─────────────────
test('OAuth: piloto sí, sin piloto no; PKCE de 43 a 128; un state descartado no se canjea nunca', async () => {
  const begin = (state, verifier) => as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)',
    [shops.A.id, 'mercadopago', ids.ownerA, state, verifier]);
  await rejects(begin('a'.repeat(43), 'v'.repeat(64)), /Payments disabled/);
  await pilot(shops.A);
  try {
    await rejects(begin('b'.repeat(43), 'v'.repeat(42)), /Invalid PKCE parameters/);
    await rejects(begin('c'.repeat(43), 'v'.repeat(129)), /Invalid PKCE parameters/);
    await rejects(begin('corto', 'v'.repeat(64)), /Invalid PKCE parameters/);
    await begin('d'.repeat(43), 'v'.repeat(43));
    await begin('e'.repeat(43), 'v'.repeat(128));
    // Vendedor cancela o vuelve con error: el state se quema.
    const burned = (await one('service', 'select public.payment_oauth_discard($1) as r', ['d'.repeat(43)])).r;
    assert.equal(burned.business_id, shops.A.id);
    assert.equal((await one('service', 'select public.payment_oauth_lookup($1) as r', ['d'.repeat(43)])).r, null);
    await rejects(as('service', 'select public.payment_oauth_complete($1,$2,$3,$4,$5,$6,$7,$8)',
      ['d'.repeat(43), '1111111111', [], false, null, 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb', '', 1]), /Invalid or expired state/);
    // Un state inventado no existe.
    assert.equal((await one('service', 'select public.payment_oauth_discard($1) as r', ['inventado'])).r, null);
    // Vencido: no se encuentra ni se canjea.
    await db.query("update private.payment_oauth_states set expires_at = now() - interval '1 minute' where state = $1", ['e'.repeat(43)]);
    assert.equal((await one('service', 'select public.payment_oauth_lookup($1) as r', ['e'.repeat(43)])).r, null);
    await rejects(as('service', 'select public.payment_oauth_complete($1,$2,$3,$4,$5,$6,$7,$8)',
      ['e'.repeat(43), '1111111111', [], false, null, 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb', '', 1]), /Invalid or expired state/);
    // Sólo el titular inicia la conexión.
    await rejects(as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)',
      [shops.A.id, 'mercadopago', ids.managerA, 'f'.repeat(43), 'v'.repeat(64)]), /Not allowed for this business/);
    await rejects(as('service', 'select public.payment_oauth_begin($1,$2,$3,$4,$5)',
      [shops.A.id, 'mercadopago', ids.ownerB, 'g'.repeat(43), 'v'.repeat(64)]), /Not allowed for this business/);
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
    await unpilot(shops.A);
  }
});

// ───────────────── renovación ─────────────────
test('la renovación rota token y vencimiento juntos, sólo en cuentas conectadas, y lista las que vencen pronto', async () => {
  await pilot(shops.A);
  await connect(shops.A);
  try {
    const account = rows(await db.query("select id from public.payment_provider_accounts where business_id = $1", [shops.A.id]))[0].id;
    await db.query("update private.payment_provider_credentials set expires_at = now() + interval '5 days' where account_id = $1", [account]);
    const expiring = (await one('service', 'select public.payment_accounts_expiring(30) as r')).r;
    assert.deepEqual(expiring.map(item => item.account_id), [account]);
    assert.equal(expiring[0].sandbox, true);
    assert.equal((await one('service', 'select public.payment_accounts_expiring(1) as r')).r.length, 0);
    const until = '2027-03-25T12:00:00Z';
    await as('service', 'select public.payment_account_rotate($1,$2,$3,$4,$5)',
      [account, 'v2.nuevonuevonuevonu.cifradocifradocif', '', 2, until]);
    const stored = rows(await db.query(`select c.access_token_ciphertext as access, c.refresh_token_ciphertext as refresh,
      c.key_version, c.expires_at, a.token_expires_at from private.payment_provider_credentials c
      join public.payment_provider_accounts a on a.id = c.account_id where c.account_id = $1`, [account]))[0];
    assert.equal(stored.access, 'v2.nuevonuevonuevonu.cifradocifradocif');
    assert.equal(stored.refresh, 'v1.cccccccccccccccc.dddddddddddddddd', 'sin refresh nuevo, queda el anterior');
    assert.equal(stored.key_version, 2);
    assert.equal(new Date(stored.expires_at).toISOString(), new Date(until).toISOString());
    assert.equal(new Date(stored.token_expires_at).toISOString(), new Date(until).toISOString());
    // Desconectada por el titular: no revive con una renovación en vuelo.
    await as('ownerA', "select public.disconnect_payment_account($1,'mercadopago')", [shops.A.id]);
    await rejects(as('service', 'select public.payment_account_rotate($1,$2,$3,$4,$5)',
      [account, 'v2.otrootrootrootro.cifradocifradocif', '', 2, until]), /Account not connected/);
    // Si falla la renovación: reconectar, y el online desaparece; el efectivo sigue.
    await connect(shops.A);
    await as('service', "select public.payment_account_mark($1,'mercadopago','reconnect_required','La renovación fue rechazada')",
      [shops.A.id]);
    assert.deepEqual(await methodsOf(shops.A), ['cash_on_pickup', 'cash_on_delivery']);
    const cash = await order('customer2', shops.A, { method: 'cash_on_pickup' });
    assert.equal((await orderRow(cash)).payment_status, 'pending_on_delivery');
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
    await unpilot(shops.A);
  }
});

// ───────────────── intentos: vencimiento, aprobados tarde y repetidos ─────────────────
test('el circuito del piloto: pedido, intento, orden de prueba, aprobado leído del proveedor y el comercio lo acepta', async () => {
  await pilot(shops.A);
  await connect(shops.A);
  try {
    const id = await order('customer3', shops.A);
    const attempt = (await start('customer3', id)).attempt_id;
    assert.equal((await start('customer3', id)).attempt_id, attempt, 'doble toque: el mismo intento');
    await setCheckout(attempt, 'ORDTST01CIRCUITO');
    await rejects(move('ownerA', id, 'accepted'), /U0007 Payment not approved/);
    const event = await record();
    const result = await apply({ seller: shops.A.seller, reference: attempt, providerOrder: 'ORDTST01CIRCUITO',
      status: 'approved', amount: 3000, eventId: event,
      transactions: [{ kind: 'payment', id: 'PAYTST01', status: 'approved', status_detail: 'accredited', amount: 3000 }] });
    assert.equal(result.outcome, 'applied');
    assert.equal((await orderRow(id)).payment_status, 'approved');
    assert.equal((await move('ownerA', id, 'accepted')).status, 'accepted');
    // Otro vendedor no puede aplicar nada sobre este intento.
    const intruder = await apply({ seller: shops.B.seller, reference: attempt, status: 'refunded', amount: 3000 });
    assert.equal(intruder.reason, 'seller_mismatch');
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
    await unpilot(shops.A);
  }
});

test('un intento pendiente vencido no se reutiliza; con orden en el proveedor, después de un margen; en revisión, nunca', async () => {
  await pilot(shops.A);
  await connect(shops.A);
  try {
    // Sin orden en el proveedor: vence en el acto.
    const first = await order('customer4', shops.A);
    const a1 = (await start('customer4', first)).attempt_id;
    await db.query("update public.payment_attempts set expires_at = now() - interval '1 minute' where id = $1", [a1]);
    const a2 = (await start('customer4', first)).attempt_id;
    assert.notEqual(a2, a1);
    assert.deepEqual(await attemptRow(a1), { id: a1, status: 'expired', status_detail: 'local_expiry', provider_order_id: null });
    assert.equal((await orderRow(first)).payment_status, 'pending');
    // Con orden: 5 minutos pasado el vencimiento todavía es el mismo; 15, ya no.
    await setCheckout(a2, 'ORDTST01MARGEN');
    await db.query("update public.payment_attempts set expires_at = now() - interval '5 minutes' where id = $1", [a2]);
    assert.equal((await start('customer4', first)).attempt_id, a2);
    await db.query("update public.payment_attempts set expires_at = now() - interval '15 minutes' where id = $1", [a2]);
    const a3 = (await start('customer4', first)).attempt_id;
    assert.notEqual(a3, a2);
    // En revisión (processing) el proveedor todavía puede aprobar: nunca vence acá.
    await apply({ seller: shops.A.seller, reference: a3, status: 'processing', amount: 3000 });
    await db.query("update public.payment_attempts set expires_at = now() - interval '2 hours' where id = $1", [a3]);
    assert.equal((await start('customer4', first)).attempt_id, a3);
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
    await unpilot(shops.A);
  }
});

test('un aprobado sobre un intento cerrado se refleja y queda para revisar; un segundo intento aprobado también', async () => {
  await pilot(shops.A);
  await connect(shops.A);
  try {
    const id = await order('customer5', shops.A);
    const old = (await start('customer5', id)).attempt_id;
    await setCheckout(old, 'ORDTST01VIEJA');
    await db.query("update public.payment_attempts set expires_at = now() - interval '20 minutes' where id = $1", [old]);
    const fresh = (await start('customer5', id)).attempt_id;
    assert.equal((await attemptRow(old)).status, 'expired');
    // El proveedor aprueba la orden vieja (llegó tarde): es plata cobrada.
    const late = await record();
    const result = await apply({ seller: shops.A.seller, reference: old, providerOrder: 'ORDTST01VIEJA', status: 'approved',
      amount: 3000, eventId: late,
      transactions: [{ kind: 'payment', id: 'PAYTST-VIEJA', status: 'approved', status_detail: 'accredited', amount: 3000 }] });
    assert.deepEqual({ outcome: result.outcome, status: result.status, detail: result.detail },
      { outcome: 'flagged', status: 'approved', detail: 'approved_after_close' });
    assert.deepEqual(await eventRow(late), { outcome: 'flagged', detail: 'approved_after_close' });
    assert.equal((await orderRow(id)).payment_status, 'approved', 'el pedido figura pagado aunque haya un intento más nuevo');
    // Si también pagan el intento nuevo: el pedido sigue pagado una vez y el cobro de más queda para revisar.
    await setCheckout(fresh, 'ORDTST01NUEVA');
    const second = await record();
    const dup = await apply({ seller: shops.A.seller, reference: fresh, providerOrder: 'ORDTST01NUEVA', status: 'approved',
      amount: 3000, eventId: second,
      transactions: [{ kind: 'payment', id: 'PAYTST-NUEVA', status: 'approved', status_detail: 'accredited', amount: 3000 }] });
    assert.deepEqual({ outcome: dup.outcome, detail: dup.detail }, { outcome: 'flagged', detail: 'duplicate_payment' });
    assert.equal((await orderRow(id)).payment_status, 'approved');
    const overview = (await one('ownerA', 'select public.business_payment_overview($1) as o', [shops.A.id])).o;
    assert.ok(overview.to_review >= 2, 'el comercio ve los dos avisos para revisar');
    // Un vencimiento o rechazo posterior del intento nuevo no "desaprueba" el pedido.
    await apply({ seller: shops.A.seller, reference: fresh, status: 'refunded', amount: 3000 });
    assert.equal((await orderRow(id)).payment_status, 'approved', 'otro intento pagó el pedido');
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
    await unpilot(shops.A);
  }
});

test('importe distinto sobre un intento cerrado y otra orden para el mismo intento: nada en silencio', async () => {
  await pilot(shops.A);
  await connect(shops.A);
  try {
    const id = await order('customer6', shops.A);
    const attempt = (await start('customer6', id)).attempt_id;
    await setCheckout(attempt, 'ORDTST01UNICA');
    await apply({ seller: shops.A.seller, reference: attempt, status: 'rejected', amount: 3000 });
    const mismatch = await record();
    const result = await apply({ seller: shops.A.seller, reference: attempt, status: 'approved', amount: 2999, eventId: mismatch });
    assert.deepEqual({ outcome: result.outcome, status: result.status }, { outcome: 'flagged', status: 'rejected' });
    assert.deepEqual(await eventRow(mismatch), { outcome: 'flagged', detail: 'amount_mismatch' });
    assert.equal((await orderRow(id)).payment_status, 'rejected', 'no se aprueba por otro importe');
    // Otra orden del proveedor con nuestra referencia (falló la idempotencia): se aplica y se revisa.
    const other = await record();
    const twice = await apply({ seller: shops.A.seller, reference: attempt, providerOrder: 'ORDTST01OTRA', status: 'approved',
      amount: 3000, eventId: other });
    assert.equal(twice.outcome, 'flagged');
    assert.equal((await attemptRow(attempt)).provider_order_id, 'ORDTST01UNICA', 'la orden del intento no cambia');
    assert.equal((await orderRow(id)).payment_status, 'approved');
  } finally {
    await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
    await unpilot(shops.A);
  }
});

test('al quitar el piloto el online desaparece y el efectivo sigue; nada queda encendido', async () => {
  await pilot(shops.A);
  await connect(shops.A);
  assert.ok((await methodsOf(shops.A)).includes('online'));
  await unpilot(shops.A);
  assert.deepEqual(await methodsOf(shops.A), ['cash_on_pickup', 'cash_on_delivery']);
  assert.equal((await one('service', 'select public.payments_accepting() as ok')).ok, false);
  await rejects(order('customer1', shops.A), /Payment method not available/);
  const cash = await order('customer1', shops.A, { method: 'cash_on_pickup' });
  assert.equal((await orderRow(cash)).payment_status, 'pending_on_delivery');
  await db.query("delete from public.payment_provider_accounts where business_id = $1", [shops.A.id]);
});
