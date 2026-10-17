// Validaciones de formulario: ayudan a la persona antes de enviar. La base
// vuelve a validar todo (restricciones y funciones), así que nada de esto es
// la última palabra.
export const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanMultiline = (value, max = 1200) => String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

export const isEmail = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '').trim()) && String(value).length <= 120;
export const isPhone = value => /^[0-9 +()-]{6,24}$/.test(String(value || '').trim()) && /\d{6,}/.test(String(value).replace(/\D/g, ''));
export const isName = value => clean(value).length >= 2 && clean(value).length <= 80;

export function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < 10) return 'La contraseña necesita al menos 10 caracteres.';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return 'Usá letras y números en la contraseña.';
  return '';
}

/** WhatsApp en formato internacional sin signos (wa.me). Argentina por defecto. */
export function normalizeWhatsapp(value) {
  let digits = String(value || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  if (digits.startsWith('54')) {
    if (!digits.startsWith('549') && digits.length === 12) digits = `549${digits.slice(2)}`;
  } else if (digits.length === 10) {
    digits = `549${digits}`;
  } else if (digits.length === 12) {
    // Código de área (2 a 4 cifras) + 15 + número: se quita el 15.
    const area = [3, 4, 2].find(len => digits.slice(len, len + 2) === '15');
    if (area) digits = `549${digits.slice(0, area)}${digits.slice(area + 2)}`;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

export const normalizeInstagram = value => String(value || '').trim().replace(/^@+/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
  .replace(/[/?#].*$/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 30);

export const slugify = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
