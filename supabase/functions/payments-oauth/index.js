// Edge Function: conexión de la cuenta de Mercado Pago de un comercio (OAuth).
//   POST (con la sesión del titular) {business, provider}  → {authorization_url}
//   GET  ?code&state (vuelta del proveedor)      → redirige a #panel/<id>/pagos
// Sin JWT obligatorio en la plataforma porque la vuelta del proveedor no lo
// trae; el POST verifica la sesión de la persona y la base, que es titular.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { paymentsConfig, json } from '../_shared/payments/config.js';
import { randomToken, pkcePair, authorizationUrl, tokenRequest, parseTokenResponse } from '../_shared/payments/oauth.js';
import { sealToken } from '../_shared/payments/vault.js';
import { PROVIDER } from '../_shared/payments/mercadopago.js';

const env = name => Deno.env.get(name);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async request => {
  const config = paymentsConfig(env);
  if (config.missing().length) return json(503, { error: 'not_configured' });
  const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } });
  const status = await service.rpc('app_status');
  if (status.error || status.data?.features?.payments_online !== true) return json(503, { error: 'payments_disabled' });
  const redirectUri = `${config.functionsUrl}/payments-oauth`;
  const panel = (business, result) => Response.redirect(
    `${config.siteUrl}/index.html#panel/${business || ''}/pagos?conexion=${result}`, 302);

  if (request.method === 'POST') {
    const authorization = request.headers.get('Authorization') || '';
    const user = await createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'),
      { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } }).auth.getUser();
    if (user.error || !user.data?.user || user.data.user.is_anonymous) return json(401, { error: 'sign_in_required' });
    const body = await request.json().catch(() => ({}));
    if (!UUID.test(String(body?.business || ''))) return json(400, { error: 'invalid_business' });
    // Esta función conecta cuentas de un solo proveedor (el del adaptador).
    if ((body?.provider || PROVIDER) !== PROVIDER) return json(400, { error: 'unsupported_provider' });
    const state = randomToken(32);
    const { verifier, challenge } = await pkcePair();
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
    const business = pending.data?.business_id || '';
    if (!pending.data) return panel(business, 'vencida');
    if (!code || url.searchParams.get('error')) return panel(business, 'cancelada');
    try {
      const exchange = tokenRequest({ clientId: config.clientId, clientSecret: config.clientSecret, code, redirectUri,
        verifier: pending.data.code_verifier });
      const response = await fetch(exchange.url, { method: exchange.method, headers: exchange.headers,
        body: JSON.stringify(exchange.body) });
      if (!response.ok) return panel(business, 'error');
      const tokens = parseTokenResponse(await response.json());
      const { keys, current } = await config.tokenKeys();
      const done = await service.rpc('payment_oauth_complete', { state, provider_user_id: tokens.sellerId,
        scopes: tokens.scopes, live_mode: tokens.liveMode, token_expires_at: tokens.expiresAt,
        access_ciphertext: await sealToken(tokens.accessToken, keys[current], current),
        refresh_ciphertext: tokens.refreshToken ? await sealToken(tokens.refreshToken, keys[current], current) : '',
        key_version: current });
      return panel(business, done.error ? 'error' : 'ok');
    } catch {
      return panel(business, 'error');
    }
  }
  return json(405, { error: 'method_not_allowed' });
});
