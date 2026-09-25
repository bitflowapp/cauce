// Edge Function: iniciar el pago online de un pedido.
//   POST {order_id, flow: 'checkout_pro'}                      → {checkout_url}
//   POST {order_id, flow: 'checkout_api', card_token, …}       → {status}
// Con la sesión de quien compra: el intento lo crea start_payment como esa
// persona (la base verifica que el pedido es suyo). El importe sale del
// pedido y la clave de idempotencia, del intento: un reintento o un doble
// toque devuelve el mismo checkout y nunca crea otro cobro.
//
// Checkout Pro va por la API de Orders: una orden en modo manual con la
// dirección del checkout del proveedor (`checkout_url`), adonde va quien
// compra. Si el proveedor tarda, limita (429) o falla, no se guarda nada y el
// reintento usa la misma clave: nunca una segunda orden.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { paymentsConfig, json } from '../_shared/payments/config.js';
import { freshAccessToken, ReconnectRequired } from '../_shared/payments/tokens.js';
import { buildCheckoutProOrderRequest, buildOrderRequest, readOrder, isTestOrderId, PROVIDER }
  from '../_shared/payments/mercadopago.js';

const env = name => Deno.env.get(name);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_TIMEOUT_MS = 10000;

Deno.serve(async request => {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const config = paymentsConfig(env);
  if (config.missing().length) return json(503, { error: 'not_configured' });
  const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } });
  // Interruptor global o comercio piloto: con todo apagado no se hace nada.
  const gate = await service.rpc('payments_accepting');
  if (gate.error || gate.data !== true) return json(503, { error: 'payments_disabled' });

  const body = await request.json().catch(() => ({}));
  const flow = body?.flow === 'checkout_api' ? 'checkout_api' : 'checkout_pro';
  if (!UUID.test(String(body?.order_id || ''))) return json(400, { error: 'invalid_order' });
  const buyer = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { auth: { persistSession: false },
    global: { headers: { Authorization: request.headers.get('Authorization') || '' } } });
  // La base decide: pedido de esta persona, online, comercio habilitado y con
  // cuenta conectada (de prueba si es un piloto en sandbox).
  const started = await buyer.rpc('start_payment', { order_id: body.order_id, flow });
  if (started.error) return json(409, { error: 'payment_not_available' });
  const context = (await service.rpc('payment_checkout_context', { attempt_id: started.data.attempt_id })).data;
  if (!context) return json(409, { error: 'payment_not_available' });
  // Ya creado en el proveedor: el mismo checkout, sin llamar otra vez.
  if (flow === 'checkout_pro' && context.checkout_url) return json(200, { checkout_url: context.checkout_url });

  const credentials = (await service.rpc('payment_account_credentials',
    { business: context.business.id, provider: context.provider })).data;
  if (!credentials || credentials.status !== 'connected') return json(409, { error: 'account_not_connected' });
  // Nunca una cuenta real en un piloto de prueba (la base tampoco lo permite).
  if (credentials.sandbox && credentials.live_mode !== false) return json(409, { error: 'account_not_connected' });

  const { keys, current } = await config.tokenKeys();
  const markReconnect = reason => service.rpc('payment_account_mark', { business: context.business.id,
    provider: context.provider, status: 'reconnect_required', reason });
  let accessToken;
  try {
    accessToken = await freshAccessToken(credentials, { clientId: config.clientId, clientSecret: config.clientSecret,
      keys, current, apiBase: config.apiBase, fetch, markReconnect,
      rotate: async (account, access, refresh, version, expires) => {
        const saved = await service.rpc('payment_account_rotate', { account, access_ciphertext: access,
          refresh_ciphertext: refresh, new_key_version: version, new_expires_at: expires });
        if (saved.error) throw new Error('rotate_failed');
      } });
  } catch (error) {
    if (error instanceof ReconnectRequired) return json(409, { error: 'account_reconnect_required' });
    return json(503, { error: 'provider_unavailable' });
  }

  const send = async call => {
    try {
      return await fetch(call.url, { method: call.method, headers: call.headers, body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch {
      return null;
    }
  };
  // Qué hacer con una respuesta que no es una orden: nada se guarda y el
  // reintento repite la misma clave de idempotencia.
  const failure = async response => {
    if (!response) return json(504, { error: 'provider_timeout' });
    if (response.status === 401) {
      await markReconnect('El proveedor rechazó el token de la cuenta: hay que volver a conectarla.');
      return json(409, { error: 'account_reconnect_required' });
    }
    if (response.status === 429 || response.status === 409) {
      return json(503, { error: 'provider_busy' }, { 'Retry-After': '5' });
    }
    return json(502, { error: 'provider_error' });
  };

  if (flow === 'checkout_pro') {
    let call;
    try {
      // La orden vence con el intento: un enlace viejo no se puede pagar.
      call = buildCheckoutProOrderRequest(context, { siteUrl: config.siteUrl, expiresAt: context.expires_at,
        apiBase: config.apiBase }, accessToken);
    } catch {
      return json(409, { error: 'attempt_closed' });
    }
    const response = await send(call);
    if (!response?.ok) return failure(response);
    const order = await response.json().catch(() => null);
    const checkoutUrl = typeof order?.checkout_url === 'string' ? order.checkout_url : '';
    if (!order?.id || !/^https:\/\//.test(checkoutUrl)) return json(502, { error: 'provider_error' });
    // Un piloto en sandbox sólo redirige a una orden de prueba. Si el
    // proveedor devolviera una orden real, se frena acá: nadie paga de verdad.
    if (credentials.sandbox && !isTestOrderId(order.id)) return json(409, { error: 'live_order_refused' });
    const saved = await service.rpc('payment_attempt_set_checkout', { attempt_id: context.attempt_id,
      provider_order_id: String(order.id), checkout_url: checkoutUrl });
    if (saved.error) return json(409, { error: 'attempt_closed' });
    return json(200, { checkout_url: checkoutUrl });
  }

  // Pago dentro de CAUCE: el token de la tarjeta lo generó el SDK del proveedor.
  let call;
  try {
    call = buildOrderRequest(context, { cardToken: body.card_token, paymentMethodId: body.payment_method_id,
      paymentMethodType: body.payment_method_type, installments: Number(body.installments) || 1,
      payerEmail: body.payer_email, apiBase: config.apiBase }, accessToken);
  } catch {
    return json(400, { error: 'invalid_payment_data' });
  }
  const response = await send(call);
  if (!response?.ok) return failure(response);
  const order = await response.json().catch(() => null);
  if (!order?.id) return json(502, { error: 'provider_error' });
  if (credentials.sandbox && !isTestOrderId(order.id)) return json(409, { error: 'live_order_refused' });
  await service.rpc('payment_attempt_set_checkout', { attempt_id: context.attempt_id, provider_order_id: String(order.id),
    checkout_url: null });
  // La respuesta de la API también es el proveedor: se aplica con las mismas reglas.
  const read = readOrder(order);
  if (read.status) {
    await service.rpc('payment_apply_update', { provider: PROVIDER, seller_id: credentials.provider_user_id,
      attempt_reference: context.attempt_id, provider_order_id: read.providerOrderId, status: read.status,
      status_detail: read.statusDetail, paid_amount: read.paidAmount, transactions: read.transactions, event_id: null });
  }
  return json(200, { status: read.status || 'processing' });
});
