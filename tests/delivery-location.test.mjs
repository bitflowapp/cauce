import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finiteCoordinate,
  finiteLatitude,
  finiteLongitude,
} from '../js/core/geo-point.js';
import {
  normalizeDeliveryLocation,
  deliveryLocationAddressFingerprint,
  requireConfirmedDeliveryLocation,
  DELIVERY_LOCATION_REQUIRED,
} from '../js/core/delivery-location.js';

test('finiteCoordinate rechaza valores no medidos y preserva el cero numérico real', () => {
  assert.equal(finiteCoordinate(0, 90), 0); // cero medido real
  assert.equal(finiteCoordinate(-39.23, 90), -39.23);
  assert.equal(finiteCoordinate(false, 90), null); // booleano Number(false) es 0
  assert.equal(finiteCoordinate(true, 90), null); // booleano Number(true) es 1
  assert.equal(finiteCoordinate('', 90), null);
  assert.equal(finiteCoordinate('   ', 90), null);
  assert.equal(finiteCoordinate([], 90), null);
  assert.equal(finiteCoordinate(null, 90), null);
  assert.equal(finiteCoordinate(undefined, 90), null);
  assert.equal(finiteCoordinate(95, 90), null); // fuera de límite
});

test('normalizeDeliveryLocation exige coordenadas, origen válido y momento de confirmación', () => {
  const valid = {
    latitude: -39.234,
    longitude: -70.912,
    locationSource: 'gps',
    confirmedAt: '2026-09-15T18:00:00.000Z',
    addressFingerprint: 'av 4 de febrero 450',
  };
  const normalized = normalizeDeliveryLocation(valid);
  assert.equal(normalized.latitude, -39.234);
  assert.equal(normalized.longitude, -70.912);
  assert.equal(normalized.locationSource, 'gps');

  // Sin fuente declarada falla
  assert.equal(normalizeDeliveryLocation({ ...valid, locationSource: 'invalid' }), null);
  // Sin confirmedAt falla
  assert.equal(normalizeDeliveryLocation({ ...valid, confirmedAt: '' }), null);
});

test('deliveryLocationAddressFingerprint normaliza abreviaturas y tildes omitiendo piso/depto', () => {
  const fp1 = deliveryLocationAddressFingerprint({
    street: 'Av. 4 de Febrero',
    streetNumber: '450',
    city: 'Aluminé',
    province: 'Neuquén',
  });
  const fp2 = deliveryLocationAddressFingerprint({
    street: 'Avenida 4 de Febrero',
    streetNumber: '450',
    city: 'Alumine',
    province: 'Neuquen',
  });
  assert.equal(fp1, fp2);
  assert.ok(fp1.includes('avenida 4 de febrero 450 alumine neuquen'));
});

test('requireConfirmedDeliveryLocation omite confirmación en retiro y la exige en delivery', () => {
  assert.deepEqual(requireConfirmedDeliveryLocation({ fulfillmentType: 'pickup' }), { ok: true, skipped: true });

  const resultWithoutLoc = requireConfirmedDeliveryLocation({ fulfillmentType: 'delivery', location: null });
  assert.equal(resultWithoutLoc.ok, false);
  assert.equal(resultWithoutLoc.code, DELIVERY_LOCATION_REQUIRED);

  const resultWithLoc = requireConfirmedDeliveryLocation({
    fulfillmentType: 'delivery',
    location: {
      latitude: -39.234,
      longitude: -70.912,
      locationSource: 'map_pin',
      confirmedAt: '2026-09-15T18:00:00Z',
    },
  });
  assert.equal(resultWithLoc.ok, true);
});
