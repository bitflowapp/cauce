// Edge Function: conexión de la cuenta de Mercado Pago de un comercio (OAuth).
//   POST (con la sesión del titular) {business, provider}  → {authorization_url}
//   GET  ?code&state (vuelta del proveedor)      → redirige a #panel/<id>/pagos
//   POST (con la clave de servicio) {action: 'refresh_due', within_days}
//        → renueva los tokens que vencen pronto (renovación programada)
// Sin JWT obligatorio en la plataforma porque la vuelta del proveedor no lo
// trae; el POST verifica la sesión de la persona y la base, que es titular.
//
// La URL de retorno es fija: <proyecto>/functions/v1/payments-oauth. Es la
// que se carga en la aplicación del proveedor y nunca cambia entre intentos.
// El `state` es impredecible, de un solo uso y vence en 10 minutos; cualquier
// vuelta con un `state` que no sirve (vencido, usado, cancelado o con error)
// lo quema y no canjea nada. Ningún token pasa por el navegador, por la URL
// final ni por un registro.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { paymentsConfig, json } from '../_shared/payments/config.js';
import { randomToken, pkcePair, authorizationUrl, tokenRequest, parseTokenResponse } from '../_shared/payments/oauth.js';
import { sealToken } from '../_shared/payments/vault.js';
import { refreshAccount, ReconnectRequired } from '../_shared/payments/tokens.js';
import { PROVIDER } from '../_shared/payments/mercadopago.js';

const env = name => Deno.env.get(name);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_TIMEOUT_MS = 10000;

// Comparación en tiempo constante (la clave de servicio de la renovación).
function sameText(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

Deno.serve(async request => {
  const config = paymentsConfig(env);
  if (config.missing().length) return json(503, { error: 'not_configured' });
  const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } });
  const gate = await service.rpc('payments_accepting');
  if (gate.error || gate.data !== true) return json(503, { error: 'payments_disabled' });
  const redirectUri = `${config.functionsUrl}/payments-oauth`;
  const panel = (business, result) => Response.redirect(
    `${config.siteUrl}/index.html#panel/${business || ''}/pagos?conexion=${result}`, 302);

  if (request.method === 'POST') {
    const authorization = request.headers.get('Authorization') || '';
    const body = await request.json().catch(() => ({}));

    // Renovación programada: sólo con la clave de servicio del proyecto.
    if (body?.action === 'refresh_due') {
      if (!sameText(authorization, `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY') || ''}`)) {
        return json(401, { error: 'service_only' });
      }
      const withinDays = Math.min(Math.max(Number(body?.within_days) || 30, 1), 200);
      const due = await service.rpc('payment_accounts_expiring', { within_days: withinDays });
      if (due.error) return json(500, { error: 'lookup_failed' });
      const { keys, current } = await config.tokenKeys();
      const result = { refreshed: 0, reconnect_required: 0, unavailable: 0 };
      for (const account of due.data || []) {
        try {
          await refreshAccount(account, { clientId: config.clientId, clientSecret: config.clientSecret, keys, current,
            apiBase: config.apiBase, fetch, timeoutMs: PROVIDER_TIMEOUT_MS,
            markReconnect: reason => service.rpc('payment_account_mark', { business: account.business_id,
              provider: account.provider, status: 'reconnect_required', reason }),
            rotate: async (id, access, refresh, version, expires) => {
              const saved = await service.rpc('payment_account_rotate', { account: id, access_ciphertext: access,
                refresh_ciphertext: refresh, new_key_version: version, new_expires_at: expires });
              if (saved.error) throw new Error('rotate_failed');
            } });
          result.refreshed += 1;
        } catch (error) {
          if (error instanceof ReconnectRequired) result.reconnect_required += 1;
          else result.unavailable += 1;
        }
      }
      return json(200, { checked: (due.data || []).length, ...result });
    }

    const user = await createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'),
      { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } }).auth.getUser();
    if (user.error || !user.data?.user || user.data.user.is_anonymous) return json(401, { error: 'sign_in_required' });
    if (!UUID.test(String(body?.business || ''))) return json(400, { error: 'invalid_business' });
    // Esta función conecta cuentas de un solo proveedor (el del adaptador).
    if ((body?.provider || PROVIDER) !== PROVIDER) return json(400, { error: 'unsupported_provider' });
    const state = randomToken(32);
    const { verifier, challenge } = await pkcePair();
    // La base verifica que es titular y que el comercio cobra online (o es piloto).
    const begin = await service.rpc('payment_oauth_begin', { business: body.business, provider: PROVIDER,
      requested_by: user.data.user.id, state, code_verifier: verifier });
    if (begin.error) return json(403, { error: 'not_allowed' });
    return json(200, { authorization_url: authorizationUrl({ clientId: config.clientId, redirectUri, state, challenge }) });
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    // El `state` guarda el comercio y el code_verifier; se canjea una sola vez.
    const pending = state ? await service.rpc('payment_oauth_lookup', { state }) : { data: null };
    // Cualquier salida sin conexión quema el `state`: nunca se canjea después.
    const discard = async () => (state ? (await service.rpc('payment_oauth_discard', { state })).data : null);
    if (!pending.data) {
      const burned = await discard();
      return panel(burned?.business_id || '', 'vencida');
    }
    const business = pending.data.business_id || '';
    if (!code || url.searchParams.get('error')) {
      await discard();
      return panel(business, 'cancelada');
    }
    if (pending.data.enabled !== true) {
      await discard();
      return panel(business, 'error');
    }
    try {
      const exchange = tokenRequest({ clientId: config.clientId, clientSecret: config.clientSecret, code, redirectUri,
        verifier: pending.data.code_verifier, testToken: pending.data.sandbox === true, apiBase: config.apiBase });
      const response = await fetch(exchange.url, { method: exchange.method, headers: exchange.headers,
        body: JSON.stringify(exchange.body), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
      if (!response.ok) {
        await discard();
        return panel(business, 'error');
      }
      const tokens = parseTokenResponse(await response.json());
      // Un piloto de prueba nunca guarda una cuenta real: se frena acá.
      if (pending.data.sandbox === true && tokens.liveMode !== false) {
        await discard();
        return panel(business, 'error');
      }
      const { keys, current } = await config.tokenKeys();
      const done = await service.rpc('payment_oauth_complete', { state, provider_user_id: tokens.sellerId,
        scopes: tokens.scopes, live_mode: tokens.liveMode, token_expires_at: tokens.expiresAt,
        access_ciphertext: await sealToken(tokens.accessToken, keys[current], current),
        refresh_ciphertext: tokens.refreshToken ? await sealToken(tokens.refreshToken, keys[current], current) : '',
        key_version: current });
      if (done.error) {
        await discard();
        return panel(business, 'error');
      }
      return panel(business, 'ok');
    } catch {
      await discard();
      return panel(business, 'error');
    }
  }
  return json(405, { error: 'method_not_allowed' });
});
