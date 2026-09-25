// Doble de prueba de la API de Mercado Pago, SÓLO para el stack local.
//
// Sirve para lo que el sandbox real no deja provocar a pedido: demoras, 429,
// 500, respuestas sin checkout_url, tokens revocados, renovaciones que fallan
// y órdenes "reales" (sin el prefijo de prueba). No reemplaza la validación
// contra el sandbox de Mercado Pago: la complementa (docs/PAGOS-SANDBOX-RESULTS.md).
//
// Reproduce lo que exige la API real y la documentación:
//   · OAuth: el código es de un solo uso y vence; el canje exige client_id,
//     client_secret, redirect_uri idéntica y el code_verifier cuyo SHA-256
//     (base64url) es el code_challenge de la autorización (PKCE S256);
//   · Orders: X-Idempotency-Key obligatorio y con la misma clave, la misma
//     orden; una orden sólo la lee el vendedor dueño del token; las órdenes
//     de prueba se llaman ORDTST…;
//   · nada de tarjetas ni datos personales.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const s256 = verifier => base64url(createHash('sha256').update(verifier).digest());
const testId = prefix => `${prefix}${randomBytes(12).toString('hex').toUpperCase().slice(0, 20)}`;

/**
 * @param {{ port?: number, host?: string, clientId: string, clientSecret: string }} options
 */
export async function startFakeMercadoPago({ port = 0, host = '0.0.0.0', clientId, clientSecret }) {
  const state = {
    codes: new Map(),        // code → { seller, challenge, redirectUri, live, used, expiresAt }
    tokens: new Map(),       // access token → seller
    refresh: new Map(),      // refresh token → seller
    orders: new Map(),       // id → order
    byKey: new Map(),        // idempotency key → order id
    requests: [],            // lo que llegó (sin tokens)
    mode: { orders: [], refresh: [] },
  };
  const next = kind => state.mode[kind].shift() || 'ok';
  const issue = (seller, live = false) => {
    const access = `APP_USR-TEST-${seller}-${randomBytes(6).toString('hex')}`;
    const refresh = `TG-TEST-${seller}-${randomBytes(6).toString('hex')}`;
    state.tokens.set(access, seller);
    state.refresh.set(refresh, seller);
    return { access_token: access, token_type: 'Bearer', expires_in: 15552000, scope: 'offline_access read write',
      user_id: Number(seller), refresh_token: refresh, public_key: `APP_USR-PUBLIC-${seller}`, live_mode: live };
  };
  const readBody = request => new Promise(resolve => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { resolve(null); } });
  });
  const send = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const sellerOf = request => state.tokens.get(String(request.headers.authorization || '').replace(/^Bearer /, ''));

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake');
    const body = request.method === 'GET' ? null : await readBody(request);

    // ── controles de la prueba ──
    if (url.pathname === '/__authorize' && request.method === 'POST') {
      // La persona vendedora acepta en la página del proveedor: nace un código.
      const code = `TG-${randomBytes(8).toString('hex')}`;
      state.codes.set(code, { seller: String(body.seller), challenge: body.challenge, redirectUri: body.redirect_uri,
        live: body.live === true, used: false, expiresAt: Date.now() + 10 * 60 * 1000 });
      return send(response, 200, { code });
    }
    if (url.pathname === '/__mode' && request.method === 'POST') {
      for (const kind of ['orders', 'refresh']) if (Array.isArray(body[kind])) state.mode[kind].push(...body[kind]);
      return send(response, 200, { ok: true });
    }
    if (url.pathname.startsWith('/__order/') && request.method === 'POST') {
      const order = state.orders.get(url.pathname.slice('/__order/'.length));
      if (!order) return send(response, 404, { error: 'not_found' });
      Object.assign(order, body, { last_updated_date: new Date().toISOString() });
      return send(response, 200, order);
    }
    if (url.pathname === '/__create_order' && request.method === 'POST') {
      // Una orden del vendedor que no nació en CAUCE (otra referencia).
      const id = testId('ORDTST01');
      const order = { id, type: 'online', processing_mode: 'manual', status: body.status || 'processed',
        status_detail: 'accredited', external_reference: body.external_reference, total_amount: body.total_amount,
        total_paid_amount: body.total_amount, currency: 'ARS', user_id: String(body.seller), transactions: { payments: [] } };
      state.orders.set(id, order);
      return send(response, 200, order);
    }
    if (url.pathname === '/__state' && request.method === 'GET') {
      return send(response, 200, { orders: [...state.orders.values()], requests: state.requests,
        exchanges: state.requests.filter(item => item.kind === 'exchange').length,
        refreshes: state.requests.filter(item => item.kind === 'refresh').length });
    }

    // ── OAuth ──
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      if (body?.client_id !== clientId || body?.client_secret !== clientSecret) {
        return send(response, 401, { error: 'invalid_client' });
      }
      if (body.grant_type === 'authorization_code') {
        state.requests.push({ kind: 'exchange', test_token: body.test_token === true, has_verifier: Boolean(body.code_verifier) });
        const grant = state.codes.get(body.code);
        if (!grant || grant.used || grant.expiresAt < Date.now()) return send(response, 400, { error: 'invalid_grant' });
        grant.used = true;
        if (body.redirect_uri !== grant.redirectUri) return send(response, 400, { error: 'invalid_grant', message: 'redirect_uri' });
        if (!body.code_verifier || s256(body.code_verifier) !== grant.challenge) {
          return send(response, 400, { error: 'invalid_grant', message: 'code_verifier' });
        }
        return send(response, 200, issue(grant.seller, grant.live));
      }
      if (body.grant_type === 'refresh_token') {
        state.requests.push({ kind: 'refresh' });
        const mode = next('refresh');
        if (mode === 'down') return send(response, 503, { error: 'unavailable' });
        const seller = state.refresh.get(body.refresh_token);
        if (mode === 'reject' || !seller) return send(response, 400, { error: 'invalid_grant' });
        state.refresh.delete(body.refresh_token);
        return send(response, 200, issue(seller));
      }
      return send(response, 400, { error: 'unsupported_grant_type' });
    }

    // ── Orders ──
    if (url.pathname === '/v1/orders' && request.method === 'POST') {
      const seller = sellerOf(request);
      const key = request.headers['x-idempotency-key'];
      state.requests.push({ kind: 'order', key, seller, body });
      const mode = next('orders');
      if (mode === 'timeout') return; // nunca responde: la función corta por tiempo
      if (!seller || mode === '401') return send(response, 401, { error: 'unauthorized' });
      if (mode === '429') return send(response, 429, { error: 'too_many_requests' });
      if (mode === '500') return send(response, 500, { error: 'internal_error' });
      if (!key) return send(response, 400, { error: 'missing_idempotency_key' });
      if (state.byKey.has(key)) return send(response, 201, state.orders.get(state.byKey.get(key)));
      const id = mode === 'live' ? testId('ORD01') : testId('ORDTST01');
      const order = {
        id, type: body.type, processing_mode: body.processing_mode, status: 'created', status_detail: 'created',
        external_reference: body.external_reference, total_amount: body.total_amount, total_paid_amount: '0.00',
        currency: 'ARS', country_code: 'AR', user_id: seller, expiration_time: body.expiration_time,
        created_date: new Date().toISOString(), transactions: { payments: [] },
        ...(mode === 'no_checkout_url' ? {} : { checkout_url: `https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=${id}` }),
      };
      state.orders.set(id, order);
      state.byKey.set(key, id);
      return send(response, 201, order);
    }
    const match = /^\/v1\/orders\/([^/]+)$/.exec(url.pathname);
    if (match && request.method === 'GET') {
      const seller = sellerOf(request);
      state.requests.push({ kind: 'read', id: decodeURIComponent(match[1]), seller });
      if (!seller) return send(response, 401, { error: 'unauthorized' });
      const order = state.orders.get(decodeURIComponent(match[1]));
      // Una orden sólo la lee el vendedor que la creó.
      if (!order || order.user_id !== seller) return send(response, 404, { error: 'not_found' });
      return send(response, 200, order);
    }
    return send(response, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const { port: bound } = server.address();
  return {
    port: bound,
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
    async authorize({ seller, challenge, redirectUri, live = false }) {
      const response = await fetch(`http://127.0.0.1:${bound}/__authorize`, { method: 'POST',
        body: JSON.stringify({ seller, challenge, redirect_uri: redirectUri, live }) });
      return (await response.json()).code;
    },
    async mode(value) {
      await fetch(`http://127.0.0.1:${bound}/__mode`, { method: 'POST', body: JSON.stringify(value) });
    },
    async setOrder(id, value) {
      const response = await fetch(`http://127.0.0.1:${bound}/__order/${id}`, { method: 'POST', body: JSON.stringify(value) });
      return response.json();
    },
    async state() {
      return (await fetch(`http://127.0.0.1:${bound}/__state`)).json();
    },
  };
}

// Cliente de los controles del doble, para pruebas que corren en otro proceso.
export function fakeControl(base) {
  const post = async (path, body) => (await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) })).json();
  return {
    authorize: async ({ seller, challenge, redirectUri, live = false }) =>
      (await post('/__authorize', { seller, challenge, redirect_uri: redirectUri, live })).code,
    mode: value => post('/__mode', value),
    setOrder: (id, value) => post(`/__order/${id}`, value),
    createOrder: value => post('/__create_order', value),
    state: async () => (await fetch(`${base}/__state`)).json(),
  };
}
