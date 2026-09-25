// Portado de js/core/validators.js de La Taba.
// Protecciones contra caracteres de control, formato de teléfonos argentinos y nombres de clientes.

// eslint-disable-next-line no-control-regex -- se eliminan caracteres de control a propósito
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PAYMENT_METHODS = new Set(['coordinate', 'cash', 'transfer', 'mercado_pago_future', 'cash_demo', 'transfer_demo', 'mercadopago_demo']);

export function sanitizeText(value, { fallback = '', maxLength = 160 } = {}) {
  const raw = value == null ? '' : String(value);
  const cleaned = raw
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = cleaned || fallback;
  return safe.slice(0, maxLength);
}

export function sanitizeNotes(value, fallback = 'Sin notas') {
  return sanitizeText(value, { fallback, maxLength: 360 });
}

export function normalizePaymentMethod(value, fallback = 'coordinate') {
  const candidate = sanitizeText(value, { fallback, maxLength: 40 });
  return PAYMENT_METHODS.has(candidate) ? candidate : fallback;
}

export function hasText(value) {
  return sanitizeText(value).length > 0;
}

export function validateRequiredStreetNumber(value) {
  const streetNumber = sanitizeText(value, { fallback: '', maxLength: 24 });
  if (!streetNumber) {
    return { ok: false, streetNumber, message: 'Ingresá el número de la calle.' };
  }
  return { ok: true, streetNumber, message: '' };
}

export function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function normalizeCustomerName(value) {
  return sanitizeText(value, { fallback: '', maxLength: 80 });
}

export function validateCustomerName(value) {
  const name = sanitizeText(value, { fallback: '', maxLength: 160 });
  if (name.length < 2) {
    return { ok: false, name, message: 'Ingresá un nombre de al menos 2 caracteres.' };
  }
  if (name.length > 80) {
    return { ok: false, name, message: 'El nombre puede tener hasta 80 caracteres.' };
  }
  if (!/\p{L}/u.test(name)) {
    return { ok: false, name, message: 'El nombre debe incluir letras.' };
  }
  return { ok: true, name, message: '' };
}

export function normalizeArgentinePhone(value) {
  return normalizePhoneDigits(value).slice(0, 13);
}

export function formatArgentinePhone(value) {
  const digits = normalizeArgentinePhone(value);
  if (digits.length < 8) return digits;
  const local = digits.slice(-7);
  const prefix = digits.slice(0, -7);
  return [prefix, local.slice(0, 3), local.slice(3)].filter(Boolean).join(' ');
}

export function isValidArgentinePhone(value) {
  const digits = normalizeArgentinePhone(value);
  return digits.length >= 10
    && digits.length <= 13
    && !/^(\d)\1+$/.test(digits);
}

export function isPlausibleStreetAddress(value) {
  const text = sanitizeText(value, { maxLength: 120 });
  return text.length >= 6 && /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(text) && /\d/.test(text);
}

export function isValidDeliveryZone(value) {
  return sanitizeText(value, { maxLength: 80 }).length >= 3;
}
