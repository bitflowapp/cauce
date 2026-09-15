// Portado y adaptado de js/core/delivery-location.js de La Taba.
// Contrato del punto de entrega confirmado: coordenadas finitas, origen declarado y fecha de confirmación.

import { finiteCoordinate } from './geo-point.js';

export const DELIVERY_LOCATION_SOURCES = Object.freeze(['gps', 'map_pin', 'geocoded_confirmed']);
export const DELIVERY_LOCATION_REQUIRED = 'DELIVERY_LOCATION_REQUIRED';
export const DELIVERY_LOCATION_REQUIRED_MESSAGE = 'Confirmá en el mapa dónde te entregamos antes de continuar.';

export const DELIVERY_LOCATION_SOURCE_LABELS = Object.freeze({
  gps: 'Ubicación del dispositivo',
  map_pin: 'Punto marcado en el mapa',
  geocoded_confirmed: 'Dirección geocodificada y confirmada',
});

export const DELIVERY_LOCATION_COARSE_ACCURACY_METERS = 150;

export function isDeliveryLocationSource(value) {
  return DELIVERY_LOCATION_SOURCES.includes(String(value || ''));
}

export function normalizeDeliveryLocation(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const latitude = finiteCoordinate(source.latitude ?? source.lat, 90);
  const longitude = finiteCoordinate(source.longitude ?? source.lng, 180);
  if (latitude == null || longitude == null) return null;

  const locationSource = String(
    source.locationSource ?? source.location_source ?? source.source ?? '',
  ).trim();
  if (!isDeliveryLocationSource(locationSource)) return null;

  const confirmedAt = normalizeInstant(
    source.confirmedAt ?? source.locationConfirmedAt ?? source.location_confirmed_at,
  );
  if (!confirmedAt) return null;

  return {
    latitude,
    longitude,
    locationSource,
    accuracyMeters: nonNegativeNumber(
      source.accuracyMeters ?? source.accuracy ?? source.geolocationAccuracy ?? source.geolocation_accuracy,
    ),
    confirmedAt,
    addressFingerprint: String(
      source.addressFingerprint ?? source.locationConfirmedAddress ?? source.location_confirmed_address ?? '',
    ).trim(),
  };
}

export function deliveryLocationAddressFingerprint(address = {}) {
  const source = address && typeof address === 'object' ? address : {};
  return normalizeFingerprintText([
    source.street ?? source.deliveryStreet,
    source.streetNumber ?? source.street_number ?? source.deliveryStreetNumber,
    source.city ?? source.deliveryCity,
    source.province ?? source.deliveryProvince,
    source.postalCode ?? source.postal_code ?? source.deliveryPostalCode,
  ].filter((part) => String(part ?? '').trim() !== '').join(' '));
}

export function confirmedDeliveryLocationOf(address = {}) {
  const location = normalizeDeliveryLocation({
    latitude: address?.latitude,
    longitude: address?.longitude,
    locationSource: address?.locationSource ?? address?.location_source,
    accuracyMeters: address?.geolocationAccuracy ?? address?.geolocation_accuracy,
    confirmedAt: address?.locationConfirmedAt ?? address?.location_confirmed_at,
    addressFingerprint: address?.locationConfirmedAddress ?? address?.location_confirmed_address,
  });
  if (!location) return null;
  const current = deliveryLocationAddressFingerprint(address);
  if (location.addressFingerprint && current && location.addressFingerprint !== current) return null;
  return location;
}

export function hasConfirmedDeliveryLocation(address = {}) {
  return confirmedDeliveryLocationOf(address) != null;
}

export function requireConfirmedDeliveryLocation({
  fulfillmentType = 'delivery',
  location = null,
  address = null,
} = {}) {
  const mode = String(fulfillmentType || '').trim().toLowerCase();
  if (mode === 'pickup') return { ok: true, skipped: true };
  const confirmed = location
    ? normalizeDeliveryLocation(location)
    : confirmedDeliveryLocationOf(address || {});
  if (!confirmed) {
    return {
      ok: false,
      code: DELIVERY_LOCATION_REQUIRED,
      message: DELIVERY_LOCATION_REQUIRED_MESSAGE,
    };
  }
  return { ok: true, location: confirmed };
}

export function deliveryLocationAccuracyLabel(location = {}) {
  const accuracy = nonNegativeNumber(location?.accuracyMeters ?? location?.accuracy);
  if (accuracy == null) return '';
  const meters = Math.round(accuracy);
  return meters > DELIVERY_LOCATION_COARSE_ACCURACY_METERS
    ? `Precisión aproximada: ${meters} m (amplia)`
    : `Precisión aproximada: ${meters} m`;
}

export function deliveryLocationSourceLabel(location = {}) {
  const key = String(location?.locationSource ?? location?.source ?? '');
  return DELIVERY_LOCATION_SOURCE_LABELS[key] || '';
}

export function geoUri(lat, lng) {
  return `geo:${lat},${lng}?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

export function deliveryDestinationDirectionsUrl(location = {}) {
  const point = plottableDeliveryPoint(location);
  return point ? geoUri(point.latitude, point.longitude) : '';
}

export function deliveryDestinationSearchUrl(location = {}) {
  const point = plottableDeliveryPoint(location);
  return point ? geoUri(point.latitude, point.longitude) : '';
}

export function plottableDeliveryPoint(location = {}) {
  const latitude = finiteCoordinate(location?.latitude ?? location?.lat, 90);
  const longitude = finiteCoordinate(location?.longitude ?? location?.lng, 180);
  if (latitude == null || longitude == null) return null;
  return { latitude, longitude };
}

function nonNegativeNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeInstant(value) {
  if (value == null || String(value).trim() === '') return '';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

const ACCENTS = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n' };

function normalizeFingerprintText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (character) => ACCENTS[character] || character)
    .replace(/\b(av\.?|avda\.?)\b/g, 'avenida')
    .replace(/\b(dpto\.?|depto\.?)\b/g, 'departamento')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
