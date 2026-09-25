// Configuración de pagos de las Edge Functions. SÓLO SERVIDOR.
//
// Todo sale de los secretos de las funciones (supabase secrets set …), nunca
// del repositorio. Sin alguno, las funciones responden 503 y no hacen nada.
//   MP_CLIENT_ID          id de la aplicación de Mercado Pago (OAuth)
//   MP_CLIENT_SECRET      secreto de la aplicación (canje de códigos)
//   MP_WEBHOOK_SECRET     clave secreta de webhooks (firma x-signature)
//   PAYMENTS_TOKEN_KEYS   {"1":"<32 bytes en base64>"}: claves para cifrar tokens
//   CAUCE_SITE_URL        sitio publicado (retornos y redirecciones)
import { importTokenKey } from './vault.js';

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

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
