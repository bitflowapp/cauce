// Edge Functions de pagos corriendo de verdad (Deno o Supabase Edge Runtime)
// contra el stack local de Supabase y un doble del proveedor. Lo arma
// tests/edge/run-local.mjs; esta prueba sólo habla HTTP con las funciones,
// como lo harían el navegador y Mercado Pago, y mira la base.
//
// Cubre: OAuth con PKCE (state incorrecto, vencido, reutilizado, cancelado,
// cuenta real en sandbox), checkout por la API de Orders (importe del pedido,
// clave de idempotencia, doble toque, reintento tras un corte, 429, 500, sin
// checkout_url, orden real frenada), webhook (firmado, falso, sin firma,
// repetido, fuera de orden, vendedor ajeno, intento desconocido, importe
// distinto, doble pago, rechazado, pendiente), reconexión, renovación de
// tokens y efectivo como respaldo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, account, guest, makeAdmin, publishedBusiness, closeAll, anonClient, ok, contact } from '../integration/harness.mjs';
import { signForTest } from '../../supabase/functions/_shared/payments/signature.js';
import { fakeControl } from './fake-mercadopago.mjs';

const URLS = JSON.parse(process.env.EDGE_URLS || '{}');
const fake = fakeControl(process.env.EDGE_FAKE_MP || 'http://127.0.0.1:9911');
const SECRET = process.env.EDGE_WEBHOOK_SECRET || '';
const SITE = process.env.EDGE_SITE_URL || 'http://127.0.0.1:4174';
const SELLER_A = '7100000001';
const SELLER_B = '7100000002';
const people = {};
let A, B;

const tokenOf = async person => (await person.client.auth.getSession()).data.session.access_token;
const call = (fn, { method = 'POST', token = '', body, query = '', headers = {} } = {}) => fetch(`${URLS[fn]}${query}`, {
  method, redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const jsonOf = async response => ({ status: response.status, body: await response.json().catch(() => null) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeout = 15000, label = 'condición' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`No se cumplió a tiempo: ${label}`);
    await sleep(250);
  }
}

// ── OAuth ──
async function beginOAuth(owner, business) {
  const started = await jsonOf(await call('payments-oauth', { token: await tokenOf(owner), body: { business } }));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const url = new URL(started.body.authorization_url);
  return { url, state: url.searchParams.get('state'), challenge: url.searchParams.get('code_challenge'),
    redirectUri: url.searchParams.get('redirect_uri') };
}
async function returnFromProvider(query) {
  const response = await call('payments-oauth', { method: 'GET', query: `?${new URLSearchParams(query)}` });
  assert.equal(response.status, 302);
  return response.headers.get('location');
}
async function connect(owner, business, seller) {
  const flow = await beginOAuth(owner, business);
  const code = await fake.authorize({ seller, challenge: flow.challenge, redirectUri: flow.redirectUri });
  const location = await returnFromProvider({ code, state: flow.state });
  assert.equal(location, `${SITE}/index.html#panel/${business}/pagos?conexion=ok`);
  return flow;
}
const accountOf = async business => (await sql`select status, provider_user_id, live_mode, token_expires_at
  from public.payment_provider_accounts where business_id = ${business}`)[0];
const credentialsOf = async business => (await sql`select c.access_token_ciphertext as access,
  c.refresh_token_ciphertext as refresh, c.expires_at from private.payment_provider_credentials c
  join public.payment_provider_accounts a on a.id = c.account_id where a.business_id = ${business}`)[0];

// ── pedidos y pagos ──
async function onlineOrder(buyer, business, quantity = 3) {
  return ok(await buyer.client.rpc('create_order', { business, idem: randomUUID(), fulfillment: 'pickup',
    payment_method: 'online', contact: contact(), items: [{ product_id: A.products.untracked.id, quantity }],
    expected_total: null }), 'pedido online');
}
const checkout = async (buyer, orderId) => jsonOf(await call('payments-checkout', { token: await tokenOf(buyer),
  body: { order_id: orderId, flow: 'checkout_pro' } }));
const attemptsOf = async orderId => sql`select id, status, status_detail, provider_order_id, checkout_url,
  idempotency_key::text as key, amount_ars from public.payment_attempts where order_id = ${orderId} order by created_at`;
const orderOf = async orderId => (await sql`select status, payment_status, total_ars from public.orders where id = ${orderId}`)[0];
const eventsFor = async resource => sql`select outcome, detail, live_mode from private.payment_events
  where resource_id = ${resource} order by id`;

async function notify(orderId, { seller = SELLER_A, action = 'order.processed', notificationId = String(Date.now()) + Math.floor(Math.random() * 1000),
  signature, omit = false } = {}) {
  const requestId = randomUUID();
  const ts = String(Date.now());
  const body = { id: notificationId, live_mode: false, type: 'order', date_created: new Date().toISOString(),
    user_id: Number(seller), api_version: 'v1', action, application_id: '1234567890', data: { id: orderId } };
  const header = signature ?? await signForTest({ dataId: orderId, requestId, ts, secret: SECRET });
  const response = await fetch(`${URLS['payments-webhook']}?data.id=${encodeURIComponent(orderId)}&type=order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, ...(omit ? {} : { 'x-signature': header }) },
    body: JSON.stringify(body),
  });
  return { ...(await jsonOf(response)), notificationId };
}
const paid = (order, { amount, paymentId = `PAYTST01${Math.random().toString(36).slice(2, 10).toUpperCase()}` } = {}) => ({
  status: 'processed', status_detail: 'accredited', total_paid_amount: `${amount}.00`,
  transactions: { payments: [...(order.transactions?.payments || []), { id: paymentId, amount: `${amount}.00`,
    paid_amount: `${amount}.00`, status: 'processed', status_detail: 'accredited',
    payment_method: { id: 'master', type: 'credit_card' } }] },
});
const providerOrder = async id => (await fake.state()).orders.find(order => order.id === id);

before(async () => {
  for (const name of ['ownerA', 'ownerB', 'admin']) people[name] = await account(`edge-${name}`);
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'CAUCE QA Mercado Pago A' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'CAUCE QA Mercado Pago B' });
});
after(async () => {
  await sql`delete from private.payment_pilot_businesses where business_id in (${A.id}, ${B.id})`;
  await sql`delete from public.payment_provider_accounts where business_id in (${A.id}, ${B.id})`;
  await closeAll(Object.values(people));
});

test('con todo apagado (sin interruptor ni piloto) las tres funciones responden 503 y no tocan nada', async () => {
  const events = (await sql`select count(*)::int as n from private.payment_events`)[0].n;
  assert.equal((await jsonOf(await call('payments-oauth', { token: await tokenOf(people.ownerA), body: { business: A.id } }))).status, 503);
  const webhook = await notify('ORDTST01APAGADO');
  assert.deepEqual({ status: webhook.status, error: webhook.body?.error }, { status: 503, error: 'payments_disabled' });
  const buyer = await guest('edge-apagado');
  assert.equal((await checkout(buyer, randomUUID())).status, 503);
  assert.equal((await sql`select count(*)::int as n from private.payment_events`)[0].n, events);
  // Encender el piloto (como la operación): sólo estos dos comercios, en sandbox.
  await sql`insert into private.payment_pilot_businesses (business_id, sandbox, reason) values
    (${A.id}, true, 'CAUCE QA · Mercado Pago'), (${B.id}, true, 'CAUCE QA · Mercado Pago')`;
});

test('OAuth: PKCE S256, state impredecible y URL de retorno fija; el token no pasa por la URL ni se guarda en claro', async () => {
  const flow = await beginOAuth(people.ownerA, A.id);
  assert.equal(flow.url.origin + flow.url.pathname, 'https://auth.mercadopago.com/authorization');
  assert.equal(flow.url.searchParams.get('response_type'), 'code');
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(flow.challenge, /^[A-Za-z0-9_-]{43}$/, 'SHA-256 en base64url');
  assert.ok(flow.state.length >= 43, 'state de 32 bytes aleatorios');
  assert.match(flow.redirectUri, /\/functions\/v1\/payments-oauth$/);
  const other = await beginOAuth(people.ownerA, A.id);
  assert.notEqual(other.state, flow.state, 'cada intento tiene su state');
  assert.equal(other.redirectUri, flow.redirectUri, 'la URL de retorno no cambia entre intentos');
  const exchangesBefore = (await fake.state()).exchanges;
  const code = await fake.authorize({ seller: SELLER_A, challenge: flow.challenge, redirectUri: flow.redirectUri });
  const location = await returnFromProvider({ code, state: flow.state });
  assert.equal(location, `${SITE}/index.html#panel/${A.id}/pagos?conexion=ok`);
  assert.doesNotMatch(location, /APP_USR|TG-|token/i, 'ningún token en la URL final');
  const exchange = (await fake.state()).requests.filter(item => item.kind === 'exchange').at(-1);
  assert.deepEqual({ test_token: exchange.test_token, verifier: exchange.has_verifier }, { test_token: true, verifier: true });
  assert.equal((await fake.state()).exchanges, exchangesBefore + 1);
  assert.deepEqual({ ...(await accountOf(A.id)), token_expires_at: undefined },
    { status: 'connected', provider_user_id: SELLER_A, live_mode: false, token_expires_at: undefined });
  const stored = await credentialsOf(A.id);
  assert.doesNotMatch(stored.access, /APP_USR/);
  assert.doesNotMatch(stored.refresh, /TG-/);
  assert.match(stored.access, /^v1\./, 'cifrado con la versión de la clave');
});

test('OAuth: callback reutilizado, state incorrecto, vencido y cancelación del vendedor no conectan nada', async () => {
  // Reutilizado: el mismo código y state otra vez.
  const flow = await beginOAuth(people.ownerA, A.id);
  const code = await fake.authorize({ seller: SELLER_A, challenge: flow.challenge, redirectUri: flow.redirectUri });
  assert.match(await returnFromProvider({ code, state: flow.state }), /conexion=ok$/);
  const exchanges = (await fake.state()).exchanges;
  assert.match(await returnFromProvider({ code, state: flow.state }), /conexion=vencida$/);
  assert.equal((await fake.state()).exchanges, exchanges, 'no se vuelve a canjear');
  // Incorrecto.
  assert.match(await returnFromProvider({ code: 'TG-inventado', state: 'inventado'.repeat(5) }), /#panel\/\/pagos\?conexion=vencida$/);
  // Vencido.
  const late = await beginOAuth(people.ownerA, A.id);
  await sql`update private.payment_oauth_states set expires_at = now() - interval '1 minute' where state = ${late.state}`;
  const lateCode = await fake.authorize({ seller: SELLER_A, challenge: late.challenge, redirectUri: late.redirectUri });
  assert.match(await returnFromProvider({ code: lateCode, state: late.state }), /conexion=vencida$/);
  // El vendedor cancela en el proveedor: el state se quema.
  const cancel = await beginOAuth(people.ownerA, A.id);
  assert.equal(await returnFromProvider({ error: 'access_denied', state: cancel.state }),
    `${SITE}/index.html#panel/${A.id}/pagos?conexion=cancelada`);
  const afterCancel = await fake.authorize({ seller: SELLER_A, challenge: cancel.challenge, redirectUri: cancel.redirectUri });
  assert.match(await returnFromProvider({ code: afterCancel, state: cancel.state }), /conexion=vencida$/);
  assert.equal((await accountOf(A.id)).status, 'connected', 'la cuenta conectada sigue igual');
});

test('OAuth: una cuenta real en un piloto de prueba no se guarda; sólo el titular conecta', async () => {
  const flow = await beginOAuth(people.ownerB, B.id);
  const code = await fake.authorize({ seller: SELLER_B, challenge: flow.challenge, redirectUri: flow.redirectUri, live: true });
  assert.equal(await returnFromProvider({ code, state: flow.state }), `${SITE}/index.html#panel/${B.id}/pagos?conexion=error`);
  assert.notEqual((await accountOf(B.id))?.status, 'connected');
  assert.equal(await credentialsOf(B.id), undefined, 'ni credenciales');
  // Otro titular, un comprador anónimo o sin sesión: no.
  assert.equal((await jsonOf(await call('payments-oauth', { token: await tokenOf(people.ownerB), body: { business: A.id } }))).status, 403);
  const buyer = await guest('edge-oauth');
  assert.equal((await jsonOf(await call('payments-oauth', { token: await tokenOf(buyer), body: { business: A.id } }))).status, 401);
  assert.equal((await jsonOf(await call('payments-oauth', { body: { business: A.id } }))).status, 401);
  // B con una cuenta de prueba: conecta.
  await connect(people.ownerB, B.id, SELLER_B);
  assert.equal((await accountOf(B.id)).status, 'connected');
});

let paidOrder;
test('checkout: la orden del proveedor sale del pedido en la base, con la clave del intento, y se guarda', async () => {
  const buyer = await guest('edge-checkout');
  const id = await onlineOrder(buyer, A.id);
  const result = await checkout(buyer, id);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.checkout_url, /^https:\/\/www\.mercadopago\.com\.ar\/checkout\/v1\/redirect\?order_id=ORDTST01/);
  const [attempt] = await attemptsOf(id);
  const order = await orderOf(id);
  assert.equal(attempt.checkout_url, result.body.checkout_url);
  assert.match(attempt.provider_order_id, /^ORDTST01/);
  const sent = (await fake.state()).requests.filter(item => item.kind === 'order' && item.key === attempt.key);
  assert.equal(sent.length, 1);
  const { body } = sent[0];
  assert.deepEqual({ type: body.type, mode: body.processing_mode, total: body.total_amount, reference: body.external_reference },
    { type: 'online', mode: 'manual', total: `${order.total_ars}.00`, reference: attempt.id });
  assert.match(body.expiration_time, /^PT(29|30)M$/);
  assert.equal(sent[0].seller, SELLER_A, 'con el token del vendedor del comercio');
  paidOrder = { id, buyer, providerOrderId: attempt.provider_order_id, total: Number(order.total_ars) };
  // El reintento devuelve el mismo checkout sin llamar al proveedor.
  assert.equal((await checkout(buyer, id)).body.checkout_url, result.body.checkout_url);
  assert.equal((await fake.state()).requests.filter(item => item.kind === 'order' && item.key === attempt.key).length, 1);
});

test('idempotencia: doble toque concurrente y reintento después de un corte dan un solo intento y una sola orden', async () => {
  const buyer = await guest('edge-doble');
  const id = await onlineOrder(buyer, A.id);
  const [first, second] = await Promise.all([checkout(buyer, id), checkout(buyer, id)]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(first.body.checkout_url, second.body.checkout_url);
  const attempts = await attemptsOf(id);
  assert.equal(attempts.length, 1, 'un solo intento');
  const orders = (await fake.state()).orders.filter(order => order.external_reference === attempts[0].id);
  assert.equal(orders.length, 1, 'una sola orden en el proveedor');
  // Corte de red: la función no espera para siempre, no guarda nada y el reintento usa la misma clave.
  const other = await guest('edge-corte');
  const cut = await onlineOrder(other, A.id);
  await fake.mode({ orders: ['timeout'] });
  const timedOut = await checkout(other, cut);
  assert.deepEqual({ status: timedOut.status, error: timedOut.body?.error }, { status: 504, error: 'provider_timeout' });
  const [pending] = await attemptsOf(cut);
  assert.equal(pending.checkout_url, null);
  const retried = await checkout(other, cut);
  assert.equal(retried.status, 200);
  const sameKey = (await fake.state()).requests.filter(item => item.kind === 'order' && item.key === pending.key);
  assert.equal(sameKey.length, 2, 'dos pedidos al proveedor, la misma clave');
  assert.equal((await fake.state()).orders.filter(order => order.external_reference === pending.id).length, 1);
});

test('fallas del proveedor: 429, 500, sin checkout_url y una orden real se frenan sin guardar nada', async () => {
  const buyer = await guest('edge-fallas');
  const id = await onlineOrder(buyer, A.id);
  await fake.mode({ orders: ['429'] });
  const busy = await checkout(buyer, id);
  assert.deepEqual({ status: busy.status, error: busy.body?.error }, { status: 503, error: 'provider_busy' });
  await fake.mode({ orders: ['500'] });
  assert.deepEqual((await checkout(buyer, id)).body, { error: 'provider_error' });
  await fake.mode({ orders: ['no_checkout_url'] });
  assert.equal((await checkout(buyer, id)).status, 502);
  assert.equal((await attemptsOf(id))[0].checkout_url, null, 'nada guardado');
  // Una orden "real" en un piloto de prueba: nunca se redirige.
  const live = await guest('edge-real');
  const liveOrder = await onlineOrder(live, A.id);
  await fake.mode({ orders: ['live'] });
  const refused = await checkout(live, liveOrder);
  assert.deepEqual({ status: refused.status, error: refused.body?.error }, { status: 409, error: 'live_order_refused' });
  assert.equal((await attemptsOf(liveOrder))[0].checkout_url, null);
});

test('webhook firmado: se lee la orden con el token del vendedor, se aprueba y el comercio acepta el pedido', async () => {
  const before = await orderOf(paidOrder.id);
  assert.equal(before.payment_status, 'pending');
  const accept0 = await people.ownerA.client.rpc('transition_order', { order_id: paidOrder.id, expected_version: null,
    next_status: 'accepted', rider: null, reason: '' });
  assert.equal(accept0.error?.code, 'U0007', 'sin pago aprobado no se acepta');
  await fake.setOrder(paidOrder.providerOrderId, paid(await providerOrder(paidOrder.providerOrderId), { amount: paidOrder.total }));
  const delivered = await notify(paidOrder.providerOrderId);
  assert.deepEqual({ status: delivered.status, body: delivered.body }, { status: 200, body: { received: true } });
  await until(async () => (await orderOf(paidOrder.id)).payment_status === 'approved', { label: 'pedido pagado' });
  const [attempt] = await attemptsOf(paidOrder.id);
  assert.equal(attempt.status, 'approved');
  const events = await eventsFor(paidOrder.providerOrderId);
  assert.deepEqual(events.at(-1), { outcome: 'applied', detail: '', live_mode: false });
  const reads = (await fake.state()).requests.filter(item => item.kind === 'read' && item.id === paidOrder.providerOrderId);
  assert.equal(reads.at(-1).seller, SELLER_A, 'la verdad sale de la API con la cuenta del vendedor');
  const accepted = ok(await people.ownerA.client.rpc('transition_order', { order_id: paidOrder.id, expected_version: null,
    next_status: 'accepted', rider: null, reason: '' }), 'aceptar');
  assert.equal(accepted.status, 'accepted');
  paidOrder.notificationId = delivered.notificationId;
});

test('webhook falso o sin firma: 401 y cero cambios; repetido: una sola vez; fuera de orden: manda la API', async () => {
  const events = (await sql`select count(*)::int as n from private.payment_events`)[0].n;
  const forged = await notify(paidOrder.providerOrderId, { signature: `ts=${Date.now()},v1=${'0'.repeat(64)}` });
  assert.deepEqual({ status: forged.status, error: forged.body?.error }, { status: 401, error: 'invalid_signature' });
  const unsigned = await notify(paidOrder.providerOrderId, { omit: true });
  assert.equal(unsigned.status, 401);
  assert.equal((await sql`select count(*)::int as n from private.payment_events`)[0].n, events, 'nada anotado');
  // La misma notificación otra vez.
  const movements = (await sql`select count(*)::int as n from public.payment_transactions t join public.payment_attempts a
    on a.id = t.attempt_id where a.order_id = ${paidOrder.id}`)[0].n;
  const again = await notify(paidOrder.providerOrderId, { notificationId: paidOrder.notificationId });
  assert.deepEqual(again.body, { received: true, duplicate: true });
  assert.equal((await sql`select count(*)::int as n from public.payment_transactions t join public.payment_attempts a
    on a.id = t.attempt_id where a.order_id = ${paidOrder.id}`)[0].n, movements);
  // Un aviso viejo ("creada") que llega después: se lee la orden y sigue aprobada.
  const stale = await notify(paidOrder.providerOrderId, { action: 'order.created' });
  assert.equal(stale.status, 200);
  await until(async () => (await eventsFor(paidOrder.providerOrderId)).some(event => event.outcome === 'applied' && event.detail === ''),
    { label: 'aviso viejo procesado' });
  await sleep(500);
  assert.equal((await orderOf(paidOrder.id)).payment_status, 'approved');
});

test('vendedor ajeno e intento desconocido no cambian nada', async () => {
  // El vendedor de B avisa por la orden de A: con su token no la puede leer.
  const intruder = await notify(paidOrder.providerOrderId, { seller: SELLER_B });
  assert.equal(intruder.status, 200);
  await until(async () => (await eventsFor(paidOrder.providerOrderId)).at(-1).outcome === 'failed', { label: 'aviso ajeno' });
  assert.equal((await orderOf(paidOrder.id)).payment_status, 'approved');
  // Una orden del vendedor de A que no nació en CAUCE.
  const stray = await fake.createOrder({ seller: SELLER_A, external_reference: randomUUID(), total_amount: '100.00' });
  await notify(stray.id);
  await until(async () => (await eventsFor(stray.id)).at(-1)?.outcome === 'ignored', { label: 'intento desconocido' });
  assert.equal((await eventsFor(stray.id)).at(-1).detail, 'Intento de pago desconocido');
});

test('importe distinto y doble pago quedan para revisar; el pedido no avanza como pagado normal', async () => {
  const buyer = await guest('edge-importe');
  const id = await onlineOrder(buyer, A.id);
  const { providerOrderId, total } = await (async () => {
    const result = await checkout(buyer, id);
    assert.equal(result.status, 200);
    const [attempt] = await attemptsOf(id);
    return { providerOrderId: attempt.provider_order_id, total: Number(attempt.amount_ars) };
  })();
  await fake.setOrder(providerOrderId, paid(await providerOrder(providerOrderId), { amount: total - 1 }));
  await notify(providerOrderId);
  await until(async () => (await eventsFor(providerOrderId)).at(-1)?.outcome === 'flagged', { label: 'importe distinto' });
  assert.equal((await eventsFor(providerOrderId)).at(-1).detail, 'amount_mismatch');
  assert.notEqual((await orderOf(id)).payment_status, 'approved');
  const accept = await people.ownerA.client.rpc('transition_order', { order_id: id, expected_version: null,
    next_status: 'accepted', rider: null, reason: '' });
  assert.equal(accept.error?.code, 'U0007');
  // Doble pago sobre el pedido ya pagado: sigue pagado una vez y queda para revisar.
  await fake.setOrder(paidOrder.providerOrderId, paid(await providerOrder(paidOrder.providerOrderId),
    { amount: paidOrder.total, paymentId: `PAYTST01SEGUNDO${Date.now()}` }));
  await notify(paidOrder.providerOrderId);
  await until(async () => (await eventsFor(paidOrder.providerOrderId)).at(-1)?.detail === 'duplicate_payment',
    { label: 'doble pago' });
  assert.equal((await orderOf(paidOrder.id)).payment_status, 'approved');
  const overview = ok(await people.ownerA.client.rpc('business_payment_overview', { business: A.id }));
  assert.ok(overview.to_review >= 2, 'el comercio los ve para revisar');
});

test('rechazado: el pedido no se acepta, se explica y se puede volver a intentar con otro intento; pendiente: espera', async () => {
  const buyer = await guest('edge-rechazo');
  const id = await onlineOrder(buyer, A.id);
  assert.equal((await checkout(buyer, id)).status, 200);
  const [first] = await attemptsOf(id);
  await fake.setOrder(first.provider_order_id, { status: 'failed', status_detail: 'rejected_by_issuer' });
  await notify(first.provider_order_id);
  await until(async () => (await orderOf(id)).payment_status === 'rejected', { label: 'rechazado' });
  assert.equal((await orderOf(id)).status, 'submitted');
  const retry = await checkout(buyer, id);
  assert.equal(retry.status, 200);
  const attempts = await attemptsOf(id);
  assert.equal(attempts.length, 2, 'un intento nuevo');
  assert.notEqual(attempts[1].key, attempts[0].key, 'con otra clave de idempotencia');
  assert.notEqual(attempts[1].provider_order_id, attempts[0].provider_order_id);
  assert.equal((await orderOf(id)).payment_status, 'pending');
  // Pendiente (por ejemplo, un medio que se paga después).
  await fake.setOrder(attempts[1].provider_order_id, { status: 'action_required', status_detail: 'waiting_payment' });
  await notify(attempts[1].provider_order_id);
  await until(async () => (await eventsFor(attempts[1].provider_order_id)).at(-1)?.outcome === 'applied', { label: 'pendiente' });
  assert.deepEqual({ ...(await orderOf(id)), total_ars: undefined }, { status: 'submitted', payment_status: 'pending', total_ars: undefined });
  const accept = await people.ownerA.client.rpc('transition_order', { order_id: id, expected_version: null,
    next_status: 'accepted', rider: null, reason: '' });
  assert.equal(accept.error?.code, 'U0007', 'hasta que se apruebe');
});

test('reconexión: un token rechazado pide reconectar, el online desaparece y el efectivo sigue', async () => {
  const buyer = await guest('edge-reconexion');
  const id = await onlineOrder(buyer, A.id);
  await fake.mode({ orders: ['401'] });
  const refused = await checkout(buyer, id);
  assert.deepEqual({ status: refused.status, error: refused.body?.error }, { status: 409, error: 'account_reconnect_required' });
  assert.equal((await accountOf(A.id)).status, 'reconnect_required');
  const methods = ok(await anonClient().rpc('payment_methods', { business: A.id })).map(method => method.id);
  assert.deepEqual(methods, ['cash_on_pickup', 'cash_on_delivery'], 'sin online, con efectivo');
  const cash = ok(await buyer.client.rpc('create_order', { business: A.id, idem: randomUUID(), fulfillment: 'pickup',
    payment_method: 'cash_on_pickup', contact: contact(), items: [{ product_id: A.products.untracked.id, quantity: 3 }],
    expected_total: null }), 'pedido en efectivo');
  assert.equal((await orderOf(cash)).payment_status, 'pending_on_delivery');
  await connect(people.ownerA, A.id, SELLER_A);
  assert.equal((await accountOf(A.id)).status, 'connected');
});

test('renovación: cerca de vencer se renueva y rota cifrado; si el proveedor la rechaza, reconectar', async () => {
  await sql`update private.payment_provider_credentials c set expires_at = now() + interval '5 days'
    from public.payment_provider_accounts a where a.id = c.account_id and a.business_id = ${A.id}`;
  const before = await credentialsOf(A.id);
  const refreshes = (await fake.state()).refreshes;
  const buyer = await guest('edge-renueva');
  const id = await onlineOrder(buyer, A.id);
  assert.equal((await checkout(buyer, id)).status, 200);
  assert.equal((await fake.state()).refreshes, refreshes + 1);
  const rotated = await credentialsOf(A.id);
  assert.notEqual(rotated.access, before.access);
  assert.notEqual(rotated.refresh, before.refresh);
  assert.ok(new Date(rotated.expires_at) > new Date(Date.now() + 150 * 24 * 3600 * 1000), 'vencimiento nuevo');
  assert.doesNotMatch(rotated.access, /APP_USR/);
  // Rechazada: la cuenta pide reconectar.
  await sql`update private.payment_provider_credentials c set expires_at = now() + interval '2 days'
    from public.payment_provider_accounts a where a.id = c.account_id and a.business_id = ${A.id}`;
  await fake.mode({ refresh: ['reject'] });
  const other = await guest('edge-renueva-no');
  const second = await onlineOrder(other, A.id);
  const refused = await checkout(other, second);
  assert.deepEqual({ status: refused.status, error: refused.body?.error }, { status: 409, error: 'account_reconnect_required' });
  assert.equal((await accountOf(A.id)).status, 'reconnect_required');
  await connect(people.ownerA, A.id, SELLER_A);
});

test('renovación programada: sólo con la clave de servicio; renueva las cuentas que vencen pronto', async () => {
  await sql`update private.payment_provider_credentials c set expires_at = now() + interval '10 days'
    from public.payment_provider_accounts a where a.id = c.account_id and a.business_id = ${B.id}`;
  const anonKey = process.env.EDGE_ANON_KEY || '';
  const denied = await jsonOf(await call('payments-oauth', { token: anonKey, body: { action: 'refresh_due', within_days: 30 } }));
  assert.deepEqual({ status: denied.status, error: denied.body?.error }, { status: 401, error: 'service_only' });
  const done = await jsonOf(await call('payments-oauth', { token: process.env.EDGE_SERVICE_ROLE_KEY || '',
    body: { action: 'refresh_due', within_days: 30 } }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.checked >= 1 && done.body.refreshed >= 1, JSON.stringify(done.body));
  const b = await credentialsOf(B.id);
  assert.ok(new Date(b.expires_at) > new Date(Date.now() + 150 * 24 * 3600 * 1000));
});

test('aislamiento: nadie paga ni ve el pedido de otra persona; el comercio B no toca a A', async () => {
  const stranger = await guest('edge-ajeno');
  const foreign = await checkout(stranger, paidOrder.id);
  assert.equal(foreign.status, 409, 'el pedido no es suyo');
  const b = people.ownerB.client;
  assert.deepEqual(ok(await b.from('payment_attempts').select('id').eq('order_id', paidOrder.id)), []);
  const disconnect = await b.rpc('disconnect_payment_account', { business: A.id, provider: 'mercadopago' });
  assert.ok(disconnect.error);
  assert.equal((await accountOf(A.id)).status, 'connected');
});
