// OAuth del vendedor con Mercado Pago. SÓLO SERVIDOR.
//
// Flujo (autorización con PKCE):
//   1. el titular toca "Conectar Mercado Pago" en el panel;
//   2. la Edge Function verifica su sesión, genera `state` y el par PKCE, los
//      guarda (payment_oauth_begin) y devuelve la URL de autorización;
//   3. el proveedor vuelve a la Edge Function con `code` y `state`;
//   4. la Edge Function canjea el código por los tokens (con el client secret
//      y el code_verifier), los cifra y los guarda (payment_oauth_complete);
//   5. redirige al panel: #panel/<comercio>/pagos.
// Ningún token pasa por el navegador ni por localStorage.
import { AUTH_BASE, API_BASE } from './mercadopago.js';

const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Valor aleatorio para `state` y `code_verifier`. */
export function randomToken(bytes = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Par PKCE S256. */
export async function pkcePair() {
  const verifier = randomToken(48);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: toBase64Url(digest) };
}

// El stack local de Supabase sirve las funciones por http (kong, 127.0.0.1):
// sólo ahí se admite. El proyecto real siempre es https.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', 'kong', 'host.docker.internal']);

export function authorizationUrl({ clientId, redirectUri, state, challenge }) {
  if (!clientId || !redirectUri || !state || !challenge) throw new Error('Faltan datos para autorizar.');
  const target = new URL(redirectUri);
  if (target.protocol !== 'https:' && !LOCAL_HOSTS.has(target.hostname)) {
    throw new Error('La URL de retorno tiene que ser https.');
  }
  const url = new URL(AUTH_BASE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('platform_id', 'mp');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

// Canje del código. Va del servidor al proveedor; nunca desde el navegador.
// Un piloto en sandbox pide credenciales de prueba (test_token): nunca reales.
export function tokenRequest({ clientId, clientSecret, code, redirectUri, verifier, testToken = false,
  apiBase = API_BASE }) {
  if (!clientId || !clientSecret || !code || !redirectUri || !verifier) throw new Error('Faltan datos para el canje.');
  return {
    url: `${apiBase}/oauth/token`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code,
      redirect_uri: redirectUri, code_verifier: verifier, ...(testToken ? { test_token: true } : {}) },
  };
}

export function refreshRequest({ clientId, clientSecret, refreshToken, apiBase = API_BASE }) {
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Faltan datos para renovar.');
  return {
    url: `${apiBase}/oauth/token`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken },
  };
}

// Respuesta del canje → lo que se guarda. Los tokens salen de acá sólo para
// cifrarse; los metadatos (vendedor, alcances, vencimiento) van a la cuenta.
export function parseTokenResponse(json, now = Date.now()) {
  const accessToken = typeof json?.access_token === 'string' ? json.access_token : '';
  const refreshToken = typeof json?.refresh_token === 'string' ? json.refresh_token : '';
  const userId = json?.user_id != null ? String(json.user_id) : '';
  const expiresIn = Number(json?.expires_in);
  if (!accessToken || !userId || !/^\d{1,20}$/.test(userId)) throw new Error('Respuesta de autorización incompleta.');
  return {
    accessToken,
    refreshToken,
    sellerId: userId,
    scopes: String(json?.scope || '').split(/\s+/).filter(Boolean),
    liveMode: json?.live_mode === true,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : null,
  };
}
