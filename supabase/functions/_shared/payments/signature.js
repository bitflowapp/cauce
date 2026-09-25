// Firma de los webhooks de Mercado Pago (encabezado x-signature). SÓLO SERVIDOR.
//
//   x-signature: ts=<marca de tiempo>,v1=<HMAC-SHA256 en hexadecimal>
//   manifiesto:  id:<data.id>;request-id:<x-request-id>;ts:<ts>;
//
// Si falta alguno de los valores, se quita del manifiesto (así lo define el
// proveedor). Un data.id alfanumérico va en minúsculas. La clave es la clave
// secreta de webhooks de la aplicación; vive en los secretos de la Edge
// Function y nunca en el repositorio.

const encoder = new TextEncoder();

function parseSignature(header) {
  const parts = Object.create(null);
  for (const piece of String(header || '').split(',')) {
    const [key, ...rest] = piece.split('=');
    const value = rest.join('=').trim();
    if (key && value) parts[key.trim()] = value;
  }
  return { ts: parts.ts || '', v1: (parts.v1 || '').toLowerCase() };
}

export function signatureManifest({ dataId, requestId, ts }) {
  const id = dataId && /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId;
  return `${id ? `id:${id};` : ''}${requestId ? `request-id:${requestId};` : ''}ts:${ts};`;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Comparación en tiempo constante para dos cadenas del mismo largo.
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/**
 * @param {{ signature: string|null, requestId: string|null, dataId: string|null, secret: string,
 *   now?: number, toleranceSeconds?: number|null }} input
 * @returns {Promise<{ valid: boolean, reason: string }>}
 */
export async function verifySignature({ signature, requestId, dataId, secret, now = Date.now(), toleranceSeconds = null }) {
  if (!secret) return { valid: false, reason: 'not_configured' };
  const { ts, v1 } = parseSignature(signature);
  if (!/^\d{9,14}$/.test(ts) || !/^[0-9a-f]{64}$/.test(v1)) return { valid: false, reason: 'malformed' };
  const expected = await hmacHex(secret, signatureManifest({ dataId, requestId, ts }));
  if (!sameText(expected, v1)) return { valid: false, reason: 'mismatch' };
  // Opcional: rechazar marcas viejas. Un reenvío legítimo de una notificación
  // igual se reconcilia leyendo el recurso, así que por defecto no se limita.
  if (toleranceSeconds != null) {
    const millis = ts.length > 11 ? Number(ts) : Number(ts) * 1000;
    if (Math.abs(now - millis) > toleranceSeconds * 1000) return { valid: false, reason: 'stale' };
  }
  return { valid: true, reason: 'ok' };
}

// Para pruebas y herramientas: firma un manifiesto igual que el proveedor.
export async function signForTest({ dataId, requestId, ts, secret }) {
  return `ts=${ts},v1=${await hmacHex(secret, signatureManifest({ dataId, requestId, ts }))}`;
}
