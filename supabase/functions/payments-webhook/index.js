// Edge Function: webhooks de Mercado Pago (órdenes de Checkout Pro vía la API
// de Orders; también pagos del flujo clásico).
// Sin JWT (lo llama el proveedor): la autenticidad la da la firma x-signature.
// Despliegue y secretos: docs/PAGOS-ONLINE.md. Con todo apagado (sin
// interruptor ni comercio piloto) o sin secretos, responde 503 y no toca nada.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handleWebhook } from '../_shared/payments/webhook.js';
import { paymentsConfig, json } from '../_shared/payments/config.js';
import { freshAccessToken } from '../_shared/payments/tokens.js';

const env = name => Deno.env.get(name);
const PROVIDER_TIMEOUT_MS = 10000;

Deno.serve(async request => {
  const config = paymentsConfig(env);
  if (config.missing().length) return json(503, { error: 'not_configured' });
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } });
  const gate = await db.rpc('payments_accepting');
  if (gate.error || gate.data !== true) return json(503, { error: 'payments_disabled' });
  const { keys, current } = await config.tokenKeys();
  const call = async (name, args) => {
    const result = await db.rpc(name, args);
    if (result.error) throw new Error(`${name}: ${result.error.code || ''}`);
    return result.data;
  };
  const result = await handleWebhook(request, {
    secret: config.webhookSecret,
    apiBase: config.apiBase,
    recordEvent: async ({ provider, key, type, resourceId, action, liveMode }) => {
      const data = await call('payment_record_event', { provider, event_key: key, resource_type: type,
        resource_id: resourceId, action, live_mode: liveMode });
      return { eventId: data.event_id, duplicate: data.duplicate === true };
    },
    // La cuenta conectada del vendedor que avisa, con un token vigente
    // (renovado acá si vence pronto). Si hay que reconectar, la notificación
    // queda fallida y el reintento del proveedor la vuelve a procesar.
    credentialsForSeller: async sellerId => {
      const data = await call('payment_seller_credentials', { provider: 'mercadopago', seller_id: sellerId });
      if (!data) return null;
      const accessToken = await freshAccessToken(data, { clientId: config.clientId, clientSecret: config.clientSecret,
        keys, current, apiBase: config.apiBase, fetch, timeoutMs: PROVIDER_TIMEOUT_MS,
        markReconnect: reason => call('payment_account_mark', { business: data.business_id, provider: data.provider,
          status: 'reconnect_required', reason }),
        rotate: (account, access, refresh, version, expires) => call('payment_account_rotate', { account,
          access_ciphertext: access, refresh_ciphertext: refresh, new_key_version: version, new_expires_at: expires }) });
      return { accessToken };
    },
    fetchJson: async (url, accessToken) => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`El proveedor respondió ${response.status}`);
      return response.json();
    },
    applyUpdate: update => call('payment_apply_update', { provider: update.provider, seller_id: update.sellerId,
      attempt_reference: update.attemptReference, provider_order_id: update.providerOrderId, status: update.status,
      status_detail: update.statusDetail, paid_amount: update.paidAmount, transactions: update.transactions,
      event_id: update.eventId }),
    markEvent: (eventId, outcome, detail) => call('payment_mark_event', { event_id: eventId, outcome, detail }),
  });
  // Se responde enseguida; la reconciliación sigue en segundo plano.
  if (result.after) {
    const pending = result.after();
    globalThis.EdgeRuntime?.waitUntil(pending);
  }
  return json(result.status, result.body);
});
