import { requireValue } from './errors.js';
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function validId(id) { return typeof id === 'string' && ID.test(id); }
export function scopeOf(business) {
  requireValue(validId(business?.id) && validId(business?.localityId), 'INVALID_SCOPE', 'El comercio no tiene un ámbito válido.');
  return Object.freeze({ businessId: business.id, localityId: business.localityId });
}
export function sameScope(a, b) {
  return Boolean(a && b && validId(a.businessId) && validId(a.localityId)
    && a.businessId === b.businessId && a.localityId === b.localityId);
}
export function assertScope(record, scope) {
  requireValue(sameScope(record, scope), 'TENANT_MISMATCH', 'El recurso pertenece a otro comercio o localidad.');
}
export function scopeKey(scope, resource) {
  requireValue(validId(scope?.businessId) && validId(scope?.localityId) && validId(resource), 'INVALID_SCOPE', 'Ámbito inválido.');
  return `cauce:demo:v1:${scope.localityId}:${scope.businessId}:${resource}`;
}
