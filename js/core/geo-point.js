// Portado de js/core/geo-point.js de La Taba.
// Definición estricta de qué cuenta como coordenada en el cliente. Prohíbe inventar ubicaciones.

export const LATITUDE_LIMIT = 90;
export const LONGITUDE_LIMIT = 180;

export function finiteCoordinate(value, limit) {
  if (value == null) return null;
  if (typeof value === 'boolean') return null;
  if (Array.isArray(value)) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > limit) return null;
  return numeric;
}

export function finiteLatitude(value) {
  return finiteCoordinate(value, LATITUDE_LIMIT);
}

export function finiteLongitude(value) {
  return finiteCoordinate(value, LONGITUDE_LIMIT);
}

export function coordinatePair(latValue, lngValue) {
  const lat = finiteLatitude(latValue);
  const lng = finiteLongitude(lngValue);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

export function isGeoPoint(point) {
  return coordinatePair(point?.lat, point?.lng) != null;
}
