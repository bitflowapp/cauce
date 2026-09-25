// Edge Function: webhooks de Mercado Pago (Orders y pagos de Checkout Pro).
// Sin JWT (lo llama el proveedor): la autenticidad la da la firma x-signature.
// Despliegue y secretos: docs/PAGOS-ONLINE.md. Con el interruptor
// payments_online apagado o sin secretos, responde 503 y no toca nada.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handleWebhook } from '../_shared/payments/webhook.js';
import { openToken } from '../_shared/payments/vault.js';
import { paymentsConfig, json } from '../_shared/payments/config.js';

const env = name => Deno.env.get(name);

Deno.serve(async request => {
  const config = paymentsConfig(env);
  if (config.missing().length) return json(503, { error: 'not_configured' });
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } });
  const status = await db.rpc('app_status');
  if (status.error || status.data?.features?.payments_online !== true) return json(503, { error: 'payments_disabled' });
  const { keys } = await config.tokenKeys();
  const call = async (name, args) => {
    const result = await db.rpc(name, args);
    if (result.error) throw new Error(`${name}: ${result.error.code || ''}`);
    return result.data;
  };
  const result = await handleWebhook(request, {
    secret: config.webhookSecret,
    recordEvent: async ({ provider, key, type, resourceId, action, liveMode }) => {
      const data = await call('payment_record_event', { provider, event_key: key, resource_type: type,
        resource_id: resourceId, action, live_mode: liveMode });
      return { eventId: data.event_id, duplicate: data.duplicate === true };
    },
    credentialsForSeller: async sellerId => {
      const data = await call('payment_seller_credentials', { provider: 'mercadopago', seller_id: sellerId });
      return data ? { accessToken: await openToken(data.access_token_ciphertext, keys) } : null;
    },
    fetchJson: async (url, accessToken) => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
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
