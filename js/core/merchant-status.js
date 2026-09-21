// Ciclo de vida del alta de comercios en CAUCE.
// Reglas puras: no tocan almacenamiento ni red.
import { requireValue } from './errors.js';
import { sanitizeText } from './validators.js';

export const BUSINESS_STATUSES = Object.freeze(['draft', 'pending_review', 'returned', 'active', 'paused']);

export const BUSINESS_STATUS_LABELS = Object.freeze({
  draft: 'Borrador',
  pending_review: 'Pendiente de revisión',
  returned: 'Devuelto con observaciones',
  active: 'Activo',
  paused: 'Pausado',
});

export const BUSINESS_STATUS_HINTS = Object.freeze({
  draft: 'Completá los datos y el catálogo para solicitar la publicación.',
  pending_review: 'La solicitud está en revisión administrativa de CAUCE.',
  returned: 'Revisá las observaciones, corregí y volvé a enviar la solicitud.',
  active: 'El comercio está publicado y puede recibir pedidos.',
  paused: 'El comercio no aparece en el listado público. Podés reactivarlo cuando quieras.',
});

// Cada transición declara quién puede ejecutarla. La revisión es siempre administrativa.
const TRANSITIONS = Object.freeze({
  draft: Object.freeze({ pending_review: 'merchant' }),
  returned: Object.freeze({ pending_review: 'merchant' }),
  pending_review: Object.freeze({ active: 'admin', returned: 'admin' }),
  active: Object.freeze({ paused: 'merchant', returned: 'admin' }),
  paused: Object.freeze({ active: 'merchant' }),
});

export function isBusinessStatus(status) {
  return BUSINESS_STATUSES.includes(status);
}

export function canTransitionBusiness(from, to, role) {
  if (!isBusinessStatus(from) || !isBusinessStatus(to)) return false;
  const required = TRANSITIONS[from]?.[to];
  if (!required) return false;
  return required === role || (required === 'merchant' && role === 'admin' && to !== 'active');
}

export function isBusinessPubliclyVisible(business) {
  return business?.status === 'active';
}

export function canBusinessReceiveOrders(business) {
  return business?.status === 'active' && business?.open === true;
}

// Requisitos mínimos para pedir publicación. Devuelve la lista de faltantes, no lanza.
export function missingPublicationRequirements(business, products = []) {
  const missing = [];
  if (!sanitizeText(business?.name)) missing.push('Nombre comercial');
  if (!sanitizeText(business?.category)) missing.push('Rubro');
  if (!sanitizeText(business?.ownerName)) missing.push('Responsable');
  if (!sanitizeText(business?.contactPhone)) missing.push('Teléfono de contacto');
  if (!sanitizeText(business?.address)) missing.push('Dirección');
  if (!sanitizeText(business?.hoursLabel)) missing.push('Horarios de atención');
  if (!business?.pickupEnabled && !business?.deliveryEnabled) missing.push('Al menos una modalidad de entrega');
  if (business?.deliveryEnabled) {
    if (!sanitizeText(business?.deliveryZone)) missing.push('Zona de envío');
    if (!Number.isSafeInteger(business?.deliveryFee) || business.deliveryFee < 0) missing.push('Costo de envío');
  }
  const publishable = products.filter(product => !product.archived);
  if (publishable.length < 1) missing.push('Al menos un producto cargado');
  return missing;
}

export function assertCanSubmitForReview(business, products) {
  requireValue(['draft', 'returned'].includes(business?.status), 'INVALID_BUSINESS_STATUS',
    'Solo se puede solicitar publicación desde un borrador o una solicitud devuelta.');
  const missing = missingPublicationRequirements(business, products);
  requireValue(missing.length === 0, 'INCOMPLETE_BUSINESS',
    `Faltan datos para solicitar la publicación: ${missing.join(', ')}.`);
}

export function normalizeReviewNote(value) {
  return sanitizeText(value, { fallback: '', maxLength: 400 });
}
