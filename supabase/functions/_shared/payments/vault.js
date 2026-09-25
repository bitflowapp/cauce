// Cifrado de los tokens del vendedor. SÓLO SERVIDOR.
//
// AES-256-GCM con una clave que vive en los secretos de la Edge Function
// (PAYMENTS_TOKEN_KEY, 32 bytes en base64) y nunca entra a la base: la base
// guarda `v<versión>.<iv>.<cifrado>` y no puede descifrarlo. Rotar la clave es
// agregar una versión nueva y volver a cifrar al refrescar cada token.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

/** @param {string} base64Key @returns {Promise<CryptoKey>} */
export async function importTokenKey(base64Key) {
  let raw;
  try { raw = fromBase64(String(base64Key || '')); } catch { throw new Error('Clave de cifrado inválida.'); }
  if (raw.length !== 32) throw new Error('La clave de cifrado tiene que tener 32 bytes.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** @param {string} plaintext @param {CryptoKey} key @param {number} version */
export async function sealToken(plaintext, key, version) {
  if (!plaintext) throw new Error('No hay token para cifrar.');
  if (!Number.isInteger(version) || version < 1) throw new Error('Versión de clave inválida.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additional = encoder.encode(`cauce-token-v${version}`);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additional },
    key, encoder.encode(plaintext)));
  return `v${version}.${toBase64(iv)}.${toBase64(sealed)}`;
}

/** @param {string} sealed @param {Record<number, CryptoKey>} keys */
export async function openToken(sealed, keys) {
  const match = /^v(\d{1,4})\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/.exec(String(sealed || ''));
  if (!match) throw new Error('Token cifrado con formato inválido.');
  const version = Number(match[1]);
  const key = keys[version];
  if (!key) throw new Error(`No hay clave para la versión ${version}.`);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(match[2]),
    additionalData: encoder.encode(`cauce-token-v${version}`) }, key, fromBase64(match[3]));
  return decoder.decode(plain);
}
