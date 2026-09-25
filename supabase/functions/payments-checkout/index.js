// Edge Function: iniciar el pago online de un pedido.
//   POST {order_id, flow: 'checkout_pro'}                      → {checkout_url}
//   POST {order_id, flow: 'checkout_api', card_token, …}       → {status}
// Con la sesión de quien compra: el intento lo crea start_payment como esa
// persona (la base verifica que el pedido es suyo). El importe sale del
// pedido y la clave de idempotencia, del intento: un reintento o un doble
// toque devuelve el mismo checkout y nunca crea otro cobro.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { paymentsConfig, json } from '../_shared/payments/config.js';
import { openToken } from '../_shared/payments/vault.js';
import { buildPreferenceRequest, buildOrderRequest, readOrder } from '../_shared/payments/mercadopago.js';

const env = name => Deno.env.get(name);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async request => {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const config = paymentsConfig(env);
  if (config.missing().length) return json(503, { error: 'not_configured' });
  const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } });
  const status = await service.rpc('app_status');
  if (status.error || status.data?.features?.payments_online !== true) return json(503, { error: 'payments_disabled' });

  const body = await request.json().catch(() => ({}));
  const flow = body?.flow === 'checkout_api' ? 'checkout_api' : 'checkout_pro';
  if (!UUID.test(String(body?.order_id || ''))) return json(400, { error: 'invalid_order' });
  const buyer = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { auth: { persistSession: false },
    global: { headers: { Authorization: request.headers.get('Authorization') || '' } } });
  const started = await buyer.rpc('start_payment', { order_id: body.order_id, flow });
  if (started.error) return json(409, { error: 'payment_not_available' });
  const context = (await service.rpc('payment_checkout_context', { attempt_id: started.data.attempt_id })).data;
  if (!context) return json(409, { error: 'payment_not_available' });
  // Ya creado en el proveedor: el mismo checkout, sin llamar otra vez.
  if (flow === 'checkout_pro' && context.checkout_url) return json(200, { checkout_url: context.checkout_url });

  const credentials = (await service.rpc('payment_account_credentials',
    { business: context.business.id, provider: context.provider })).data;
  if (!credentials || credentials.status !== 'connected') return json(409, { error: 'account_not_connected' });
  const { keys } = await config.tokenKeys();
  const accessToken = await openToken(credentials.access_token_ciphertext, keys);

  if (flow === 'checkout_pro') {
    // La preferencia vence con el intento: un enlace viejo no se puede pagar.
    const call = buildPreferenceRequest(context, { siteUrl: config.siteUrl,
      notificationUrl: `${config.functionsUrl}/payments-webhook`,
      expiresAt: context.expires_at ? new Date(context.expires_at).toISOString() : null }, accessToken);
    const response = await fetch(call.url, { method: call.method, headers: call.headers, body: JSON.stringify(call.body) });
    if (!response.ok) return json(502, { error: 'provider_error' });
    const preference = await response.json();
    const saved = await service.rpc('payment_attempt_set_checkout', { attempt_id: context.attempt_id,
      provider_order_id: String(preference.id || ''), checkout_url: String(preference.init_point || '') });
    if (saved.error) return json(409, { error: 'attempt_closed' });
    return json(200, { checkout_url: preference.init_point });
  }

  // Pago dentro de CAUCE: el token de la tarjeta lo generó el SDK del proveedor.
  const call = buildOrderRequest(context, { cardToken: body.card_token, paymentMethodId: body.payment_method_id,
    paymentMethodType: body.payment_method_type, installments: Number(body.installments) || 1,
    payerEmail: body.payer_email }, accessToken);
  const response = await fetch(call.url, { method: call.method, headers: call.headers, body: JSON.stringify(call.body) });
  const order = await response.json().catch(() => null);
  if (!order?.id) return json(502, { error: 'provider_error' });
  await service.rpc('payment_attempt_set_checkout', { attempt_id: context.attempt_id, provider_order_id: String(order.id),
    checkout_url: null });
  // La respuesta de la API también es el proveedor: se aplica con las mismas reglas.
  const read = readOrder(order);
  if (read.status) {
    await service.rpc('payment_apply_update', { provider: context.provider, seller_id: credentials.provider_user_id,
      attempt_reference: context.attempt_id, provider_order_id: read.providerOrderId, status: read.status,
      status_detail: read.statusDetail, paid_amount: read.paidAmount, transactions: read.transactions, event_id: null });
  }
  return json(200, { status: read.status || 'processing' });
});
