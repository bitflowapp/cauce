// Identidades y permisos de CAUCE. Reglas puras y compartidas por los dos entornos.
// El hash de contraseñas vive únicamente en el servidor; acá sólo se valida la forma.
import { requireValue } from './errors.js';
import { sanitizeText, validateCustomerName, isValidArgentinePhone } from './validators.js';

export const ROLES = Object.freeze(['customer', 'merchant', 'driver', 'admin']);

export const ROLE_LABELS = Object.freeze({
  customer: 'Persona usuaria',
  merchant: 'Comercio',
  driver: 'Taxista',
  admin: 'Administración',
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
export const MIN_PASSWORD_LENGTH = 10;

export function normalizeEmail(value) {
  return sanitizeText(value, { fallback: '', maxLength: 120 }).toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 120 && EMAIL.test(email);
}

export function validatePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `La contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.` };
  }
  if (password.length > 200) return { ok: false, message: 'La contraseña es demasiado larga.' };
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { ok: false, message: 'La contraseña debe combinar letras y números.' };
  }
  return { ok: true, message: '' };
}

export function validateSignUp(input, { requirePassword = true } = {}) {
  const email = normalizeEmail(input?.email);
  requireValue(isValidEmail(email), 'INVALID_EMAIL', 'Ingresá un correo electrónico válido.');
  const nameCheck = validateCustomerName(input?.name);
  requireValue(nameCheck.ok, 'INVALID_NAME', nameCheck.message || 'Ingresá tu nombre.');
  const phone = sanitizeText(input?.phone, { fallback: '', maxLength: 24 });
  requireValue(!phone || isValidArgentinePhone(phone), 'INVALID_PHONE', 'Ingresá un teléfono válido o dejalo vacío.');
  if (requirePassword) {
    const passwordCheck = validatePassword(input?.password);
    requireValue(passwordCheck.ok, 'INVALID_PASSWORD', passwordCheck.message);
  }
  return { email, name: nameCheck.name, phone };
}

// El actor es siempre derivado del estado del servidor, nunca de lo que manda el navegador.
export function actorFor(state, accountId, { guestId = null } = {}) {
  const account = state.accounts.find(candidate => candidate.id === accountId);
  if (!account) {
    requireValue(Boolean(guestId), 'SESSION_REQUIRED', 'Necesitás iniciar sesión para continuar.');
    return Object.freeze({ id: guestId, kind: 'guest', roles: ['customer'], email: null, name: 'Invitada/o' });
  }
  const businesses = state.businesses.filter(business => business.ownerId === account.id).map(business => business.id);
  const driver = state.drivers.find(candidate => candidate.accountId === account.id);
  return Object.freeze({
    id: account.id,
    kind: 'account',
    email: account.email,
    name: account.name,
    phone: account.phone,
    roles: Object.freeze([...account.roles]),
    businessIds: Object.freeze(businesses),
    driverId: driver?.id || null,
  });
}

export function hasRole(actor, role) {
  return Boolean(actor?.roles?.includes(role));
}

export function requireRole(actor, role, message) {
  requireValue(hasRole(actor, role), 'ROLE_REQUIRED',
    message || `Esta sección requiere el rol de ${ROLE_LABELS[role] || role}.`);
}

export function requireAccount(actor) {
  requireValue(actor?.kind === 'account', 'SESSION_REQUIRED', 'Necesitás iniciar sesión para continuar.');
  return actor;
}

export function ownsBusiness(actor, business) {
  return Boolean(business) && actor?.kind === 'account' && business.ownerId === actor.id;
}

export function requireBusinessOwnership(actor, business) {
  requireValue(Boolean(business), 'BUSINESS_NOT_FOUND', 'No se encontró el comercio.');
  requireValue(ownsBusiness(actor, business), 'TENANT_MISMATCH',
    'El comercio pertenece a otra cuenta.');
  return business;
}
