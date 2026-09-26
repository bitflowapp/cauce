// Configuración de pagos de las Edge Functions. SÓLO SERVIDOR.
//
// Todo sale de los secretos de las funciones (supabase secrets set …), nunca
// del repositorio. Sin alguno, las funciones responden 503 y no hacen nada.
//   MP_CLIENT_ID          id de la aplicación de Mercado Pago (OAuth)
//   MP_CLIENT_SECRET      secreto de la aplicación (canje de códigos)
//   MP_WEBHOOK_SECRET     clave secreta de webhooks (firma x-signature)
//   PAYMENTS_TOKEN_KEYS   {"1":"<32 bytes en base64>"}: claves para cifrar tokens
//   CAUCE_SITE_URL        sitio publicado (retornos y redirecciones)
// Sólo para las pruebas del stack local (nunca en el proyecto real):
//   MP_API_BASE           un doble del proveedor en 127.0.0.1 / host.docker.internal,
//                         para provocar demoras, 429 y 500. Cualquier otro valor
//                         se ignora y se usa la API real.
import { importTokenKey } from './vault.js';
import { API_BASE } from './mercadopago.js';

const TEST_HOSTS = new Set(['127.0.0.1', 'localhost', 'host.docker.internal']);

/** @param {string} value */
export function apiBaseFrom(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && TEST_HOSTS.has(url.hostname)) return url.origin;
  } catch { /* sin valor o inválido: la API real */ }
  return API_BASE;
}

export const REQUIRED_SECRETS = Object.freeze(['MP_CLIENT_ID', 'MP_CLIENT_SECRET', 'MP_WEBHOOK_SECRET',
  'PAYMENTS_TOKEN_KEYS']);

/** @param {(name: string) => string | undefined} getEnv */
export function paymentsConfig(getEnv) {
  const read = name => String(getEnv(name) || '').trim();
  const rawKeys = read('PAYMENTS_TOKEN_KEYS');
  return Object.freeze({
    clientId: read('MP_CLIENT_ID'),
    clientSecret: read('MP_CLIENT_SECRET'),
    webhookSecret: read('MP_WEBHOOK_SECRET'),
    siteUrl: (read('CAUCE_SITE_URL') || 'https://bitflowapp.github.io/cauce').replace(/\/+$/, ''),
    functionsUrl: `${read('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1`,
    apiBase: apiBaseFrom(read('MP_API_BASE')),
    // Sólo nombres: nunca valores.
    missing: () => REQUIRED_SECRETS.filter(name => !read(name)),
    // {versión: CryptoKey}; la versión más alta es la que cifra.
    async tokenKeys() {
      let parsed;
      try { parsed = JSON.parse(rawKeys); } catch { throw new Error('PAYMENTS_TOKEN_KEYS no es JSON.'); }
      const entries = Object.entries(parsed || {}).filter(([version]) => /^\d{1,4}$/.test(version));
      if (!entries.length) throw new Error('PAYMENTS_TOKEN_KEYS no tiene claves.');
      const keys = {};
      for (const [version, value] of entries) keys[Number(version)] = await importTokenKey(value);
      const current = Math.max(...Object.keys(keys).map(Number));
      return { keys, current };
    },
  });
}

// El sitio llama a checkout y a OAuth desde el navegador (functions.invoke):
// sin el preflight y la cabecera en cada respuesta, el navegador corta el
// pedido. Sin cookies: la autorización es el JWT de la sesión en
// Authorization, así que el origen no otorga ningún permiso (igual que la API
// REST del proyecto).
export const CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
  'Access-Control-Max-Age': '600',
});
export const preflight = () => new Response(null, { status: 204, headers: CORS });

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...headers },
});
