// Portado de js/core/delivery-code.js de La Taba.
// Código de seguridad de 4 dígitos para entrega de pedidos a domicilio.

const DELIVERY_CODE_PATTERN = /^\d{4}$/;

export function createDeliveryCode(seed = '') {
  const cryptoCode = randomCryptoCode();
  if (cryptoCode) return cryptoCode;
  return codeFromSeed(`${seed}:${Date.now()}:${Math.random()}`);
}

export function buildDeliveryCode(code, {
  confirmedAt = '',
  confirmedBy = '',
} = {}) {
  const normalized = normalizeDeliveryCodeValue(code);
  if (!normalized) return null;

  const result = { code: normalized };
  const safeConfirmedAt = normalizeIsoDate(confirmedAt, '');
  if (safeConfirmedAt) {
    result.confirmedAt = safeConfirmedAt;
    result.confirmedBy = sanitizeCodeMeta(confirmedBy || 'rider', 40);
  }
  return result;
}

export function normalizeDeliveryCode(raw, { seed = '' } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : { code: raw };
  const code = normalizeDeliveryCodeValue(source.code) || codeFromSeed(seed);
  if (!code) return null;
  return buildDeliveryCode(code, {
    confirmedAt: source.confirmedAt,
    confirmedBy: source.confirmedBy,
  });
}

export function normalizeDeliveryCodeValue(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return DELIVERY_CODE_PATTERN.test(digits) ? digits : '';
}

export function verifyDeliveryCodeValue(deliveryCode, candidate) {
  const normalized = normalizeDeliveryCode(deliveryCode);
  if (!normalized) return { ok: false, message: 'Código de entrega no disponible.' };
  const attempt = normalizeDeliveryCodeValue(candidate);
  if (!attempt) return { ok: false, message: 'Ingresá el código de 4 dígitos del cliente.' };
  if (attempt !== normalized.code) return { ok: false, message: 'Código incorrecto. Revisalo con el cliente.' };
  return { ok: true, message: 'Código de entrega confirmado.' };
}

export function isDeliveryCodeConfirmed(orderOrCode) {
  const raw = orderOrCode?.deliveryCode || orderOrCode;
  const normalized = normalizeDeliveryCode(raw);
  return Boolean(normalized?.confirmedAt);
}

export function formatDeliveryCode(code) {
  const normalized = normalizeDeliveryCodeValue(code);
  return normalized ? `${normalized.slice(0, 2)} ${normalized.slice(2)}` : '';
}

export function formatDeliveryCodeTime(deliveryCode, locale = 'es-AR') {
  const normalized = normalizeDeliveryCode(deliveryCode);
  if (!normalized?.confirmedAt) return '';
  const date = new Date(normalized.confirmedAt);
  if (Number.isNaN(date.getTime())) return '';
  // Hora en formato 24h ("14:05"): el sufijo "p. m." termina en punto y
  // duplicaba el punto final en frases como "Confirmado a las 12:21 p. m..".
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function randomCryptoCode() {
  try {
    const cryptoRef = globalThis.crypto;
    if (!cryptoRef?.getRandomValues) return '';
    const buffer = new Uint32Array(1);
    cryptoRef.getRandomValues(buffer);
    return String(1000 + (buffer[0] % 9000));
  } catch (_) {
    return '';
  }
}

function codeFromSeed(seed) {
  const text = String(seed || '').trim();
  if (!text) return '';
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return String(1000 + (Math.abs(hash) % 9000));
}

function normalizeIsoDate(value, fallback = '') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function sanitizeCodeMeta(value, maxLength) {
  return String(value || '')
    // eslint-disable-next-line no-control-regex -- se eliminan caracteres de control a propósito
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
