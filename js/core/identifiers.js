import { requireValue } from './errors.js';
export function randomUuid(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
  requireValue(typeof cryptoImpl?.getRandomValues === 'function', 'CRYPTO_UNAVAILABLE', 'El navegador no dispone de aleatoriedad segura. Abrí la demo desde el servidor local.');
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
