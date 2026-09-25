// Pagos online del lado del servidor (Edge Functions), sin red y sin Mercado
// Pago real: adaptador (estados, pedidos al proveedor, idempotencia), firma de
// los webhooks, receptor (falso, repetido, reintentos), cifrado de tokens y
// OAuth. Todo lo externo es un doble de prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapOrderStatus, mapPaymentStatus, toPesos, buildOrderRequest, buildPreferenceRequest, readOrder, readPayment,
  resourceRequest, buildCheckoutProOrderRequest, expirationDuration, isTestOrderId, SANDBOX_PAYER_EMAIL,
} from '../supabase/functions/_shared/payments/mercadopago.js';
import { verifySignature, signForTest, signatureManifest } from '../supabase/functions/_shared/payments/signature.js';
import { handleWebhook, eventKey } from '../supabase/functions/_shared/payments/webhook.js';
import { importTokenKey, sealToken, openToken } from '../supabase/functions/_shared/payments/vault.js';
import { pkcePair, authorizationUrl, tokenRequest, parseTokenResponse, randomToken, accountRequest, isTestAccount }
  from '../supabase/functions/_shared/payments/oauth.js';
import { paymentsConfig, REQUIRED_SECRETS, apiBaseFrom } from '../supabase/functions/_shared/payments/config.js';
import { freshAccessToken, refreshDue, ReconnectRequired, REFRESH_WINDOW_DAYS } from '../supabase/functions/_shared/payments/tokens.js';
import { PAYMENT_STATES } from '../js/core/payment.js';

const WEBHOOK_KEY = 'clave-de-webhook-solo-para-pruebas';
const ATTEMPT = '6f1c2d3e-4b5a-4c6d-8e7f-001122334455';
const context = (extra = {}) => ({
  attempt_id: ATTEMPT, idempotency_key: '0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3', amount: 7500, currency: 'ARS',
  status: 'pending', order: { code: 'CA-0042' }, business: { name: 'Almacén Los Pehuenes' }, ...extra,
});

// ───────────────── estados ─────────────────
test('los estados de una orden de Mercado Pago se traducen a estados neutrales de CAUCE', () => {
  const cases = [
    ['created', '', 'pending'], ['action_required', 'waiting_payment', 'pending'], ['processing', 'in_process', 'processing'],
    ['processed', 'accredited', 'approved'], ['processed', 'partially_refunded', 'partially_refunded'],
    ['refunded', 'refunded', 'refunded'], ['canceled', 'canceled', 'cancelled'], ['failed', 'rejected', 'rejected'],
    ['expired', 'expired', 'expired'], ['charged_back', '', 'refunded'],
  ];
  for (const [status, detail, expected] of cases) assert.equal(mapOrderStatus(status, detail), expected, `${status}/${detail}`);
  for (const unknown of ['', 'algo_nuevo', null, undefined, 'PROCESSEDX']) assert.equal(mapOrderStatus(unknown), null);
  assert.equal(mapOrderStatus('PROCESSED', 'accredited'), 'approved', 'sin distinguir mayúsculas');
});

test('los estados de un pago (Checkout Pro) se traducen y una disputa queda para revisar', () => {
  const cases = [['pending', 'pending'], ['in_process', 'processing'], ['authorized', 'processing'], ['approved', 'approved'],
    ['rejected', 'rejected'], ['cancelled', 'cancelled'], ['refunded', 'refunded'], ['charged_back', 'refunded']];
  for (const [status, expected] of cases) assert.equal(mapPaymentStatus(status), expected, status);
  assert.equal(mapPaymentStatus('approved', 'partially_refunded'), 'partially_refunded');
  assert.equal(mapPaymentStatus('in_mediation'), null);
  assert.equal(mapPaymentStatus('desconocido'), null);
});

test('todo estado traducido es un estado neutral de CAUCE, nunca uno del proveedor', () => {
  const produced = new Set([
    ...['created', 'action_required', 'processing', 'processed', 'refunded', 'canceled', 'failed', 'expired', 'charged_back']
      .map(status => mapOrderStatus(status)),
    ...['pending', 'in_process', 'authorized', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back']
      .map(status => mapPaymentStatus(status)),
  ]);
  for (const state of produced) assert.ok(PAYMENT_STATES.includes(state), state);
});

test('los importes se leen en pesos enteros; con centavos no coinciden con un pedido', () => {
  assert.equal(toPesos('1500.00'), 1500);
  assert.equal(toPesos('1500'), 1500);
  assert.equal(toPesos(7500), 7500);
  assert.equal(toPesos('1500.50'), null);
  assert.equal(toPesos('-5'), null);
  assert.equal(toPesos('abc'), null);
  assert.equal(toPesos(''), null);
});

// ───────────────── de CAUCE al proveedor ─────────────────
test('la orden (API de Orders) lleva la clave de idempotencia del intento y el importe del pedido', () => {
  const call = buildOrderRequest(context(), { cardToken: 'tok-de-prueba', paymentMethodId: 'master',
    paymentMethodType: 'credit_card', installments: 1, payerEmail: 'vecina@example.com' }, 'token-de-prueba');
  assert.equal(call.url, 'https://api.mercadopago.com/v1/orders');
  assert.equal(call.headers['X-Idempotency-Key'], context().idempotency_key);
  assert.equal(call.headers.Authorization, 'Bearer token-de-prueba');
  assert.equal(call.body.total_amount, '7500.00');
  assert.equal(call.body.transactions.payments[0].amount, '7500.00');
  assert.equal(call.body.external_reference, ATTEMPT);
  assert.equal(call.body.processing_mode, 'automatic');
  // El mismo intento, la misma clave: un reintento no crea otro cobro.
  const again = buildOrderRequest(context(), { cardToken: 'otro-tok', paymentMethodId: 'master',
    paymentMethodType: 'credit_card', payerEmail: 'vecina@example.com' }, 'token-de-prueba');
  assert.equal(again.headers['X-Idempotency-Key'], call.headers['X-Idempotency-Key']);
});

test('no se pide una orden sin clave, con importe inválido, con otra moneda o con el intento cerrado', () => {
  const card = { cardToken: 't', paymentMethodId: 'visa', paymentMethodType: 'credit_card', payerEmail: 'a@b.co' };
  assert.throws(() => buildOrderRequest(context({ idempotency_key: '' }), card, 'x'), /idempotencia/);
  assert.throws(() => buildOrderRequest(context({ amount: 0 }), card, 'x'), /Importe/);
  assert.throws(() => buildOrderRequest(context({ amount: 12.5 }), card, 'x'), /Importe/);
  assert.throws(() => buildOrderRequest(context({ currency: 'USD' }), card, 'x'), /Moneda/);
  assert.throws(() => buildOrderRequest(context({ status: 'approved' }), card, 'x'), /abierto/);
  assert.throws(() => buildOrderRequest(context(), { ...card, cardToken: '' }, 'x'), /tarjeta/);
  assert.throws(() => buildOrderRequest(context(), { ...card, payerEmail: 'no-es-correo' }, 'x'), /correo/);
});

test('la preferencia (Checkout Pro) vuelve a #/pago/* con la referencia del intento y avisa al webhook', () => {
  const call = buildPreferenceRequest(context(), { siteUrl: 'https://bitflowapp.github.io/cauce',
    notificationUrl: 'https://proyecto.supabase.co/functions/v1/payments-webhook' }, 'token-de-prueba');
  assert.equal(call.url, 'https://api.mercadopago.com/checkout/preferences');
  assert.equal(call.headers['X-Idempotency-Key'], context().idempotency_key);
  assert.deepEqual(call.body.items, [{ id: ATTEMPT, title: 'Pedido CA-0042 · Almacén Los Pehuenes', quantity: 1,
    currency_id: 'ARS', unit_price: 7500 }]);
  assert.equal(call.body.back_urls.success, `https://bitflowapp.github.io/cauce/index.html#/pago/exito?intento=${ATTEMPT}`);
  assert.equal(call.body.back_urls.pending, `https://bitflowapp.github.io/cauce/index.html#/pago/pendiente?intento=${ATTEMPT}`);
  assert.equal(call.body.back_urls.failure, `https://bitflowapp.github.io/cauce/index.html#/pago/error?intento=${ATTEMPT}`);
  assert.equal(call.body.external_reference, ATTEMPT);
  assert.throws(() => buildPreferenceRequest(context(), { siteUrl: 'http://sitio.example',
    notificationUrl: 'https://x.example/w' }, 't'), /https/);
  assert.throws(() => buildPreferenceRequest(context(), { siteUrl: 'https://sitio.example',
    notificationUrl: 'http://x.example/w' }, 't'), /https/);
});

// ───────────────── del proveedor a CAUCE ─────────────────
test('una orden leída del proveedor da el estado, la referencia, el importe y los movimientos', () => {
  // Forma documentada de GET /v1/orders/{id}: las devoluciones van en transactions.refunds.
  const read = readOrder({ id: 'ORD01PRUEBA', external_reference: ATTEMPT, status: 'processed', status_detail: 'accredited',
    total_amount: '7500.00', total_paid_amount: '7500.00',
    transactions: { payments: [{ id: 'PAY01PRUEBA', amount: '7500.00', paid_amount: '7500.00', status: 'processed',
      status_detail: 'accredited', payment_method: { id: 'master', type: 'credit_card' } }],
    refunds: [{ id: 'REF01', transaction_id: 'PAY01PRUEBA', amount: '500.00', status: 'processed' }] } });
  assert.deepEqual({ ...read, transactions: undefined }, { providerOrderId: 'ORD01PRUEBA', attemptReference: ATTEMPT,
    status: 'approved', statusDetail: 'accredited', paidAmount: 7500, transactions: undefined });
  assert.deepEqual(read.transactions.map(movement => [movement.kind, movement.id, movement.status, movement.amount]),
    [['payment', 'PAY01PRUEBA', 'approved', 7500], ['refund', 'REF01', 'refunded', 500]]);
  // Respuestas viejas con la devolución dentro del pago: la misma, sin repetirse.
  const nested = readOrder({ id: 'ORD01PRUEBA', external_reference: ATTEMPT, status: 'processed', total_paid_amount: '7500.00',
    transactions: { payments: [{ id: 'PAY01PRUEBA', paid_amount: '7500.00', status: 'processed',
      refunds: [{ id: 'REF01', amount: '500.00' }] }], refunds: [{ id: 'REF01', amount: '500.00' }] } });
  assert.deepEqual(nested.transactions.map(movement => movement.id), ['PAY01PRUEBA', 'REF01']);
  // Una referencia que no es un intento de CAUCE no se usa.
  assert.equal(readOrder({ id: 'X', external_reference: 'otro-sistema' }).attemptReference, null);
});

test('un pago leído del proveedor (Checkout Pro) da lo mismo', () => {
  const read = readPayment({ id: 123456, external_reference: ATTEMPT, status: 'approved', status_detail: 'accredited',
    transaction_amount: 7500, payment_type_id: 'account_money', order: { id: 987 } });
  assert.equal(read.status, 'approved');
  assert.equal(read.attemptReference, ATTEMPT);
  // La merchant order de un pago no es la orden del intento: se encuentra por la referencia.
  assert.equal(read.providerOrderId, null);
  assert.equal(read.paidAmount, 7500);
  assert.deepEqual(read.transactions[0], { kind: 'payment', id: '123456', status: 'approved', status_detail: 'accredited',
    amount: 7500, method_type: 'account_money' });
  assert.equal(resourceRequest('order', 'ORD 1/2', 't').url, 'https://api.mercadopago.com/v1/orders/ORD%201%2F2');
  assert.equal(resourceRequest('merchant_order', '1', 't'), null);
});

// ───────────────── firma ─────────────────
test('la firma válida pasa; alterada, mal formada o sin clave, no', async () => {
  const ts = '1759000000000';
  const signature = await signForTest({ dataId: 'ORD01ABC', requestId: 'req-1', ts, secret: WEBHOOK_KEY });
  assert.deepEqual(await verifySignature({ signature, requestId: 'req-1', dataId: 'ORD01ABC', secret: WEBHOOK_KEY }),
    { valid: true, reason: 'ok' });
  assert.equal((await verifySignature({ signature, requestId: 'req-2', dataId: 'ORD01ABC', secret: WEBHOOK_KEY })).reason, 'mismatch');
  assert.equal((await verifySignature({ signature, requestId: 'req-1', dataId: 'ORD01XYZ', secret: WEBHOOK_KEY })).reason, 'mismatch');
  assert.equal((await verifySignature({ signature, requestId: 'req-1', dataId: 'ORD01ABC', secret: 'otra-clave' })).reason, 'mismatch');
  assert.equal((await verifySignature({ signature: 'ts=1,v1=zz', requestId: 'r', dataId: 'x', secret: WEBHOOK_KEY })).reason, 'malformed');
  assert.equal((await verifySignature({ signature: null, requestId: 'r', dataId: 'x', secret: WEBHOOK_KEY })).reason, 'malformed');
  assert.equal((await verifySignature({ signature, requestId: 'req-1', dataId: 'ORD01ABC', secret: '' })).reason, 'not_configured');
});

test('el manifiesto sigue al proveedor: id alfanumérico en minúsculas y sin los valores que faltan', async () => {
  assert.equal(signatureManifest({ dataId: 'ORD01ABC', requestId: 'req', ts: '1' }), 'id:ord01abc;request-id:req;ts:1;');
  assert.equal(signatureManifest({ dataId: '', requestId: 'req', ts: '1' }), 'request-id:req;ts:1;');
  assert.equal(signatureManifest({ dataId: '123', requestId: '', ts: '1' }), 'id:123;ts:1;');
  // Firmado con el id en mayúsculas o minúsculas, da lo mismo.
  const signature = await signForTest({ dataId: 'ord01abc', requestId: 'r', ts: '1759000000', secret: WEBHOOK_KEY });
  assert.equal((await verifySignature({ signature, requestId: 'r', dataId: 'ORD01ABC', secret: WEBHOOK_KEY })).valid, true);
});

test('la antigüedad de la firma se controla sólo si se configura', async () => {
  const ts = '1759000000';
  const signature = await signForTest({ dataId: '1', requestId: 'r', ts, secret: WEBHOOK_KEY });
  const later = 1759000000 * 1000 + 3600 * 1000;
  assert.equal((await verifySignature({ signature, requestId: 'r', dataId: '1', secret: WEBHOOK_KEY, now: later })).valid, true);
  assert.equal((await verifySignature({ signature, requestId: 'r', dataId: '1', secret: WEBHOOK_KEY, now: later,
    toleranceSeconds: 600 })).reason, 'stale');
});

// ───────────────── receptor ─────────────────
function fakeDeps(overrides = {}) {
  const calls = { record: [], fetch: [], apply: [], mark: [] };
  const seen = new Map();
  const deps = {
    secret: WEBHOOK_KEY,
    recordEvent: async event => {
      calls.record.push(event);
      if (seen.has(event.key)) return { eventId: seen.get(event.key), duplicate: true };
      seen.set(event.key, seen.size + 1);
      return { eventId: seen.size, duplicate: false };
    },
    credentialsForSeller: async seller => (seller === '555' ? { accessToken: 'token-del-vendedor' } : null),
    fetchJson: async (url, token) => {
      calls.fetch.push({ url, token });
      return { id: 'ORD01ABC', external_reference: ATTEMPT, status: 'processed', status_detail: 'accredited',
        total_paid_amount: '7500.00', transactions: { payments: [] } };
    },
    applyUpdate: async update => { calls.apply.push(update); return { outcome: 'applied' }; },
    markEvent: async (id, outcome, detail) => { calls.mark.push({ id, outcome, detail }); },
    ...overrides,
  };
  return { deps, calls };
}
async function webhook({ dataId = 'ORD01ABC', type = 'order', requestId = 'req-1', body, signature, method = 'POST',
  url = null } = {}) {
  const ts = '1759000000000';
  const payload = body ?? { id: 'notif-1', type, action: 'order.processed', live_mode: false, user_id: 555,
    data: { id: dataId } };
  const sig = signature ?? await signForTest({ dataId, requestId, ts, secret: WEBHOOK_KEY });
  const headers = new Map([['x-signature', sig], ['x-request-id', requestId]]);
  return {
    method,
    url: url || `https://proyecto.supabase.co/functions/v1/payments-webhook?data.id=${dataId}&type=${type}`,
    headers: { get: name => headers.get(name.toLowerCase()) ?? null },
    text: async () => JSON.stringify(payload),
  };
}

test('un webhook falso se rechaza con 401 y no deja rastro', async () => {
  const { deps, calls } = fakeDeps();
  const forged = await webhook({ signature: `ts=1759000000000,v1=${'0'.repeat(64)}` });
  const result = await handleWebhook(forged, deps);
  assert.equal(result.status, 401);
  assert.equal(result.after, undefined);
  assert.deepEqual(calls.record, []);
  const unsigned = await webhook({ signature: '' });
  assert.equal((await handleWebhook(unsigned, deps)).status, 401);
  // Otra notificación con la firma de ésta tampoco pasa.
  const replay = await webhook({ dataId: 'ORD01OTRA', signature: await signForTest({ dataId: 'ORD01ABC', requestId: 'req-1',
    ts: '1759000000000', secret: WEBHOOK_KEY }) });
  assert.equal((await handleWebhook(replay, deps)).status, 401);
  assert.deepEqual(calls.record, []);
});

test('un webhook válido responde enseguida y reconcilia leyendo el recurso con la cuenta del vendedor', async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleWebhook(await webhook(), deps);
  assert.equal(result.status, 200);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.fetch.length, 0, 'todavía no leyó: primero respondió');
  assert.deepEqual(await result.after(), { outcome: 'applied' });
  assert.deepEqual(calls.fetch, [{ url: 'https://api.mercadopago.com/v1/orders/ORD01ABC', token: 'token-del-vendedor' }]);
  assert.equal(calls.apply.length, 1);
  assert.deepEqual({ ...calls.apply[0], transactions: undefined }, { provider: 'mercadopago', sellerId: '555',
    attemptReference: ATTEMPT, providerOrderId: 'ORD01ABC', status: 'approved', statusDetail: 'accredited',
    paidAmount: 7500, transactions: undefined, eventId: 1 });
});

test('el cuerpo del webhook no decide nada: el estado sale de la API del proveedor', async () => {
  const { deps, calls } = fakeDeps({
    fetchJson: async () => ({ id: 'ORD01ABC', external_reference: ATTEMPT, status: 'action_required',
      status_detail: 'waiting_payment', total_amount: '7500.00' }),
  });
  const lie = await webhook({ body: { id: 'notif-2', type: 'order', action: 'order.processed', user_id: 555,
    data: { id: 'ORD01ABC', status: 'processed', total_paid_amount: '7500.00' } } });
  const result = await handleWebhook(lie, deps);
  await result.after();
  assert.equal(calls.apply[0].status, 'pending', 'el proveedor dice que falta pagar, aunque el cuerpo diga otra cosa');
});

test('la misma notificación repetida no se procesa dos veces', async () => {
  const { deps, calls } = fakeDeps();
  const first = await handleWebhook(await webhook(), deps);
  await first.after();
  const again = await handleWebhook(await webhook(), deps);
  assert.deepEqual({ status: again.status, body: again.body }, { status: 200, body: { received: true, duplicate: true } });
  assert.equal(again.after, undefined);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.apply.length, 1);
});

test('la clave de la notificación es estable y distingue notificaciones distintas', async () => {
  const a = await eventKey({ type: 'order', notificationId: 'n-1', dataId: 'X', action: 'a', requestId: 'r1' });
  const b = await eventKey({ type: 'order', notificationId: 'n-1', dataId: 'X', action: 'a', requestId: 'r2' });
  const c = await eventKey({ type: 'order', notificationId: 'n-2', dataId: 'X', action: 'a', requestId: 'r1' });
  assert.equal(a, b, 'un reenvío de la misma notificación es la misma clave');
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('temas ajenos, vendedores sin cuenta, estados sin traducir y errores quedan anotados sin aplicar nada', async () => {
  const other = fakeDeps();
  const topic = await handleWebhook(await webhook({ type: 'merchant_order' }), other.deps);
  assert.deepEqual({ status: topic.status, body: topic.body }, { status: 200, body: { received: true, ignored: true } });
  assert.deepEqual(other.calls.record, []);

  const stranger = fakeDeps();
  const foreign = await handleWebhook(await webhook({ body: { id: 'n-9', type: 'order', user_id: 999, data: { id: 'ORD01ABC' } } }),
    stranger.deps);
  assert.deepEqual(await foreign.after(), { outcome: 'ignored' });
  assert.deepEqual(stranger.calls.mark.map(mark => mark.outcome), ['ignored']);
  assert.equal(stranger.calls.fetch.length, 0);

  const unknown = fakeDeps({ fetchJson: async () => ({ id: 'ORD01ABC', external_reference: ATTEMPT, status: 'algo_nuevo' }) });
  const odd = await handleWebhook(await webhook(), unknown.deps);
  assert.deepEqual(await odd.after(), { outcome: 'ignored' });
  assert.equal(unknown.calls.apply.length, 0);

  const broken = fakeDeps({ fetchJson: async () => { throw new Error('El proveedor respondió 500'); } });
  const failing = await handleWebhook(await webhook(), broken.deps);
  assert.equal(failing.status, 200);
  assert.deepEqual(await failing.after(), { outcome: 'failed' });
  assert.deepEqual(broken.calls.mark.map(mark => [mark.outcome, mark.detail]), [['failed', 'El proveedor respondió 500']]);
});

test('el receptor sólo acepta POST por HTTPS, con cuerpo JSON acotado y configurado', async () => {
  const { deps } = fakeDeps();
  assert.equal((await handleWebhook(await webhook({ method: 'GET' }), deps)).status, 405);
  assert.equal((await handleWebhook(await webhook({ url: 'http://proyecto.example/w?data.id=ORD01ABC&type=order' }), deps)).status, 400);
  assert.equal((await handleWebhook(await webhook(), { ...deps, secret: '' })).status, 503);
  const big = await webhook();
  big.text = async () => 'x'.repeat(70 * 1024);
  assert.equal((await handleWebhook(big, deps)).status, 413);
  const garbage = await webhook();
  garbage.text = async () => '{no es json';
  assert.equal((await handleWebhook(garbage, deps)).status, 400);
});

// ───────────────── tokens y OAuth ─────────────────
const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64');

test('los tokens se guardan cifrados: el texto cifrado no revela nada y alterado no abre', async () => {
  const key = await importTokenKey(KEY);
  const sealed = await sealToken('token-de-acceso-de-prueba', key, 1);
  assert.match(sealed, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.equal(sealed.includes('token-de-acceso'), false);
  assert.equal(await openToken(sealed, { 1: key }), 'token-de-acceso-de-prueba');
  assert.notEqual(await sealToken('token-de-acceso-de-prueba', key, 1), sealed, 'cada cifrado usa otro iv');
  const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  await assert.rejects(openToken(tampered, { 1: key }));
  const other = await importTokenKey(Buffer.from(Uint8Array.from({ length: 32 }, () => 7)).toString('base64'));
  await assert.rejects(openToken(sealed, { 1: other }));
  await assert.rejects(openToken(sealed, { 2: key }), /versión 1/);
  await assert.rejects(importTokenKey(Buffer.from('corta').toString('base64')), /32 bytes/);
});

test('OAuth con PKCE: la URL de autorización lleva el state y el desafío S256; el canje es del servidor', async () => {
  const { verifier, challenge } = await pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);
  const state = randomToken(32);
  const url = new URL(authorizationUrl({ clientId: '1234567890', redirectUri: 'https://proyecto.supabase.co/functions/v1/payments-oauth',
    state, challenge }));
  assert.equal(url.origin + url.pathname, 'https://auth.mercadopago.com/authorization');
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: '1234567890', response_type: 'code', platform_id: 'mp',
    state, redirect_uri: 'https://proyecto.supabase.co/functions/v1/payments-oauth', code_challenge: challenge,
    code_challenge_method: 'S256' });
  assert.throws(() => authorizationUrl({ clientId: '1', redirectUri: 'http://inseguro.example', state, challenge }), /https/);
  const exchange = tokenRequest({ clientId: '1', clientSecret: 's', code: 'c', redirectUri: 'https://x.example/cb', verifier });
  assert.equal(exchange.url, 'https://api.mercadopago.com/oauth/token');
  assert.equal(exchange.body.grant_type, 'authorization_code');
  assert.equal(exchange.body.code_verifier, verifier);
});

test('la respuesta del canje se valida y separa tokens (a cifrar) de metadatos (a la cuenta)', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const parsed = parseTokenResponse({ access_token: 'token-de-prueba-a', refresh_token: 'token-de-prueba-r', token_type: 'Bearer',
    expires_in: 15552000, scope: 'offline_access read write', user_id: 123456789, live_mode: false }, now);
  assert.deepEqual(parsed, { accessToken: 'token-de-prueba-a', refreshToken: 'token-de-prueba-r', sellerId: '123456789',
    scopes: ['offline_access', 'read', 'write'], liveMode: false, expiresAt: '2027-03-25T12:00:00.000Z' });
  assert.throws(() => parseTokenResponse({ access_token: 'x' }), /incompleta/);
  assert.throws(() => parseTokenResponse({ access_token: 'x', user_id: 'no-numérico' }), /incompleta/);
});

test('sin secretos las funciones no arrancan, y sólo se informan los nombres que faltan', async () => {
  const empty = paymentsConfig(() => '');
  assert.deepEqual(empty.missing(), [...REQUIRED_SECRETS]);
  const values = { MP_CLIENT_ID: '1', MP_CLIENT_SECRET: 'secreto-que-no-se-muestra', MP_WEBHOOK_SECRET: 'otro-secreto',
    PAYMENTS_TOKEN_KEYS: JSON.stringify({ 1: KEY, 2: KEY }), SUPABASE_URL: 'https://proyecto.supabase.co' };
  const config = paymentsConfig(name => values[name]);
  assert.deepEqual(config.missing(), []);
  assert.equal(config.functionsUrl, 'https://proyecto.supabase.co/functions/v1');
  const { keys, current } = await config.tokenKeys();
  assert.equal(current, 2);
  assert.deepEqual(Object.keys(keys), ['1', '2']);
  assert.equal(JSON.stringify(config.missing()).includes('secreto'), false);
});

// ───────────────── sandbox: Checkout Pro vía la API de Orders ─────────────────
test('Checkout Pro va por la API de Orders: orden online manual con el importe del intento y su clave', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const call = buildCheckoutProOrderRequest(context({ created_at: '2026-09-26T11:59:40Z', expires_at: '2026-09-26T12:29:40Z' }),
    { siteUrl: 'https://bitflowapp.github.io/cauce', payerEmail: SANDBOX_PAYER_EMAIL, now }, 'token-de-prueba');
  assert.equal(call.url, 'https://api.mercadopago.com/v1/orders');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['X-Idempotency-Key'], '0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3');
  assert.equal(call.headers.Authorization, 'Bearer token-de-prueba');
  const { body } = call;
  // Lo que exige la documentación de Checkout Pro vía Orders.
  assert.equal(body.type, 'online');
  assert.equal(body.processing_mode, 'manual');
  assert.equal(body.total_amount, '7500.00');
  assert.equal(body.external_reference, ATTEMPT);
  assert.ok(body.external_reference.length <= 64);
  assert.equal(body.expiration_time, 'PT30M');
  // Una sola línea con el total del pedido: nunca se suma desde el navegador.
  assert.deepEqual(body.items, [{ external_code: 'CA-0042', title: 'Pedido CA-0042 · Almacén Los Pehuenes', quantity: 1,
    unit_price: '7500.00' }]);
  assert.equal(body.items.reduce((sum, item) => sum + Number(item.unit_price) * item.quantity, 0), Number(body.total_amount));
  // Sin comisión de marketplace: CAUCE no cobra comisión.
  assert.equal('marketplace_fee' in body, false);
  assert.equal(body.config.online.auto_return, 'approved');
  assert.equal(body.config.online.success_url,
    `https://bitflowapp.github.io/cauce/index.html#/pago/exito?intento=${ATTEMPT}`);
  assert.match(body.config.online.pending_url, /#\/pago\/pendiente\?intento=/);
  assert.match(body.config.online.failure_url, /#\/pago\/error\?intento=/);
  // En sandbox el pagador es el de prueba que exige el proveedor (@testuser.com):
  // ningún dato de la persona ni del navegador viaja en la orden.
  assert.deepEqual(body.payer, { email: 'test@testuser.com' });
  // Sin correo válido no se inventa un pagador: el proveedor lo pide en su página.
  for (const payerEmail of ['', 'no-es-correo', undefined]) {
    assert.equal('payer' in buildCheckoutProOrderRequest(context(), { siteUrl: 'https://bitflowapp.github.io/cauce',
      payerEmail }, 't').body, false);
  }
  // El código del ítem admite hasta 30 caracteres.
  const long = buildCheckoutProOrderRequest(context({ order: { code: 'X'.repeat(40) } }),
    { siteUrl: 'https://bitflowapp.github.io/cauce' }, 't');
  assert.equal(long.body.items[0].external_code.length, 30);
});

test('el mismo intento arma siempre el mismo pedido (reintento con la misma clave)', () => {
  const attempt = context({ created_at: '2026-09-26T12:00:00Z', expires_at: '2026-09-26T12:30:00Z' });
  const options = { siteUrl: 'https://bitflowapp.github.io/cauce', payerEmail: SANDBOX_PAYER_EMAIL };
  const first = buildCheckoutProOrderRequest(attempt, { ...options, now: Date.parse('2026-09-26T12:00:02Z') }, 'a');
  // Veinte minutos después, con el token renovado: el cuerpo y la clave, idénticos.
  const retry = buildCheckoutProOrderRequest(attempt, { ...options, now: Date.parse('2026-09-26T12:20:00Z') }, 'b');
  assert.equal(JSON.stringify(retry.body), JSON.stringify(first.body));
  assert.equal(retry.headers['X-Idempotency-Key'], first.headers['X-Idempotency-Key']);
  assert.equal(first.body.expiration_time, 'PT30M');
});

test('la orden vive lo que vive el intento; un intento vencido no se manda al proveedor', () => {
  const now = Date.parse('2026-09-26T12:10:00Z');
  const createdAt = '2026-09-26T12:00:00Z';
  // La vida completa del intento, sin importar cuándo se envía.
  assert.equal(expirationDuration({ expiresAt: '2026-09-26T12:30:00Z', createdAt, now }), 'PT30M');
  assert.equal(expirationDuration({ expiresAt: '2026-09-26T12:30:00Z', createdAt, now: Date.parse('2026-09-26T12:25:00Z') }),
    'PT30M');
  // Con menos de un minuto por delante ya no se crea una orden: el intento está vencido.
  assert.throws(() => expirationDuration({ expiresAt: '2026-09-26T12:10:59Z', createdAt, now }), /venció/);
  assert.throws(() => expirationDuration({ expiresAt: '2026-09-26T12:09:00Z', createdAt, now }), /venció/);
  assert.equal(expirationDuration({ expiresAt: '2026-10-09T12:00:00Z', createdAt, now }), 'PT1440M', 'nunca más de un día');
  assert.equal(expirationDuration({ expiresAt: null, createdAt, now }), null);
  // Sin la creación: el plazo por defecto del proveedor (tampoco depende de la hora).
  assert.equal(expirationDuration({ expiresAt: '2026-09-26T12:30:00Z', createdAt: null, now }), null);
  assert.throws(() => buildCheckoutProOrderRequest(context({ status: 'approved' }),
    { siteUrl: 'https://bitflowapp.github.io/cauce' }, 't'), /abierto/);
  assert.throws(() => buildCheckoutProOrderRequest(context(), { siteUrl: 'http://sitio.example' }, 't'), /https/);
});

test('sólo una orden de prueba (ORDTST…) sirve para un piloto en sandbox', () => {
  assert.equal(isTestOrderId('ORDTST01KS5AJ6HTK2HRQ3XJ3C2JCKP9'), true);
  for (const id of ['ORD01J49MMW3SSBK5PSV3DFR32959', '', null, 'ordtst01abc', 'ORDTST', 'ORDTST01 x']) {
    assert.equal(isTestOrderId(id), false, String(id));
  }
});

test('el canje nunca pide credenciales TEST- (la API de Orders las rechaza)', () => {
  const base = { clientId: '1', clientSecret: 's', code: 'c', redirectUri: 'https://x.example/cb', verifier: 'v'.repeat(64) };
  assert.equal('test_token' in tokenRequest(base).body, false);
  assert.equal('test_token' in tokenRequest({ ...base, testToken: true }).body, false);
});

test('de prueba o real lo dice el proveedor sobre la cuenta', () => {
  const who = accountRequest('token-de-la-cuenta');
  assert.deepEqual({ url: who.url, method: who.method, auth: who.headers.Authorization },
    { url: 'https://api.mercadopago.com/users/me', method: 'GET', auth: 'Bearer token-de-la-cuenta' });
  assert.throws(() => accountRequest(''), /token/);
  assert.equal(isTestAccount({ id: 1, tags: ['normal', 'test_user'] }), true);
  assert.equal(isTestAccount({ id: 1, email: 'test_user_123@testuser.com' }), true);
  for (const real of [{ id: 1, tags: ['normal'], email: 'comercio@example.com' }, {}, null, { tags: 'test_user' },
    { email: 'alguien@testuser.com.ar' }]) {
    assert.equal(isTestAccount(real), false, JSON.stringify(real));
  }
});

test('la URL de retorno http sólo vale en el stack local', async () => {
  const { challenge } = await pkcePair();
  const state = randomToken(32);
  for (const local of ['http://kong:8000/functions/v1/payments-oauth', 'http://127.0.0.1:54321/functions/v1/payments-oauth']) {
    assert.match(authorizationUrl({ clientId: '1', redirectUri: local, state, challenge }), /^https:\/\/auth\.mercadopago\.com/);
  }
  assert.throws(() => authorizationUrl({ clientId: '1', redirectUri: 'http://proyecto.supabase.co/x', state, challenge }), /https/);
});

test('el doble del proveedor sólo puede estar en la máquina local: si no, la API real', () => {
  assert.equal(apiBaseFrom('http://127.0.0.1:9911'), 'http://127.0.0.1:9911');
  assert.equal(apiBaseFrom('http://host.docker.internal:9911/x'), 'http://host.docker.internal:9911');
  for (const value of ['', 'https://evil.example', 'http://api.mercadopago.com.evil.example', 'https://127.0.0.1:9911',
    'no-es-url']) {
    assert.equal(apiBaseFrom(value), 'https://api.mercadopago.com', value);
  }
});

// ───────────────── renovación de tokens ─────────────────
async function tokenFixture({ expiresInDays, refresh = true }) {
  const key = await importTokenKey(KEY);
  const keys = { 1: key };
  const now = Date.parse('2026-09-26T12:00:00Z');
  return {
    now, keys,
    credentials: {
      account_id: '11111111-2222-4333-8444-555555555555',
      access_token_ciphertext: await sealToken('token-guardado', key, 1),
      refresh_token_ciphertext: refresh ? await sealToken('renovacion-guardada', key, 1) : '',
      expires_at: new Date(now + expiresInDays * 24 * 3600 * 1000).toISOString(),
    },
  };
}
const providerAnswer = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('un token lejos de vencer se usa como está, sin llamar al proveedor', async () => {
  const { credentials, keys, now } = await tokenFixture({ expiresInDays: 90 });
  assert.equal(refreshDue(credentials, { now }), false);
  let called = false;
  const token = await freshAccessToken(credentials, { keys, current: 1, clientId: '1', clientSecret: 's', now,
    fetch: async () => { called = true; }, rotate: async () => {}, markReconnect: async () => {} });
  assert.equal(token, 'token-guardado');
  assert.equal(called, false);
});

test('cerca de vencer se renueva del lado del servidor y se guarda cifrado con su nuevo vencimiento', async () => {
  const { credentials, keys, now } = await tokenFixture({ expiresInDays: REFRESH_WINDOW_DAYS - 1 });
  assert.equal(refreshDue(credentials, { now }), true);
  const seen = {};
  const token = await freshAccessToken(credentials, { keys, current: 1, clientId: '1', clientSecret: 's', now,
    fetch: async (url, init) => {
      seen.body = JSON.parse(init.body);
      return { status: 200, ok: true, json: async () => ({ access_token: 'token-nuevo', refresh_token: 'renovacion-nueva',
        user_id: 123456789, expires_in: 15552000, live_mode: false }) };
    },
    rotate: async (...args) => { seen.rotate = args; },
    markReconnect: async () => { seen.reconnect = true; } });
  assert.equal(token, 'token-nuevo');
  assert.deepEqual({ grant: seen.body.grant_type, refresh: seen.body.refresh_token },
    { grant: 'refresh_token', refresh: 'renovacion-guardada' });
  const [account, access, refresh, version, expires] = seen.rotate;
  assert.equal(account, credentials.account_id);
  // A la base llega cifrado, nunca el token en claro.
  assert.equal(access.includes('token-nuevo'), false);
  assert.equal(refresh.includes('renovacion-nueva'), false);
  assert.equal(await openToken(access, keys), 'token-nuevo');
  assert.equal(await openToken(refresh, keys), 'renovacion-nueva');
  assert.equal(version, 1);
  assert.equal(expires, '2027-03-25T12:00:00.000Z');
  assert.equal(seen.reconnect, undefined);
});

test('si el proveedor rechaza la renovación, la cuenta pide reconectar', async () => {
  const { credentials, keys, now } = await tokenFixture({ expiresInDays: 2 });
  let reason = '';
  await assert.rejects(freshAccessToken(credentials, { keys, current: 1, clientId: '1', clientSecret: 's', now,
    fetch: providerAnswer(400, { error: 'invalid_grant' }), rotate: async () => assert.fail('no rota'),
    markReconnect: async text => { reason = text; } }), ReconnectRequired);
  assert.match(reason, /volver a conectar/);
});

test('si el proveedor no responde, se sigue con el token vigente; vencido, se pide reconectar', async () => {
  const soon = await tokenFixture({ expiresInDays: 3 });
  const deps = { keys: soon.keys, current: 1, clientId: '1', clientSecret: 's', now: soon.now,
    fetch: providerAnswer(503, {}), rotate: async () => assert.fail('no rota'), markReconnect: async () => assert.fail('no') };
  assert.equal(await freshAccessToken(soon.credentials, deps), 'token-guardado');
  const timeout = { ...deps, fetch: async () => { throw new Error('timeout'); } };
  assert.equal(await freshAccessToken(soon.credentials, timeout), 'token-guardado');
  const expired = await tokenFixture({ expiresInDays: -1 });
  let marked = false;
  await assert.rejects(freshAccessToken(expired.credentials, { ...deps, keys: expired.keys,
    markReconnect: async () => { marked = true; } }), ReconnectRequired);
  assert.equal(marked, true);
});

test('sin refresh_token no hay renovación: cerca de vencer, se pide reconectar', async () => {
  const { credentials, keys, now } = await tokenFixture({ expiresInDays: 1, refresh: false });
  let marked = false;
  await assert.rejects(freshAccessToken(credentials, { keys, current: 1, clientId: '1', clientSecret: 's', now,
    fetch: async () => assert.fail('no llama'), rotate: async () => {}, markReconnect: async () => { marked = true; } }),
  ReconnectRequired);
  assert.equal(marked, true);
});
