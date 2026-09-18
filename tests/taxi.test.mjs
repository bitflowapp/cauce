import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaxiTrip,
  getActiveTaxiTrip,
  getTaxiTripById,
  listTaxiTrips,
  advanceTaxiTrip,
  cancelTaxiTrip,
  resetTaxiState,
  estimateTaxiFare,
  TAXI_STORAGE_KEY,
  DEFAULT_TAXI_DRIVER,
} from '../js/core/taxi.js';

function createMockStorage() {
  const map = new Map();
  return {
    getItem: key => map.get(String(key)) ?? null,
    setItem: (key, val) => map.set(String(key), String(val)),
    removeItem: key => map.delete(String(key)),
    clear: () => map.clear(),
  };
}

const code = expected => err => err.code === expected;

test('estimación de tarifa de taxi arroja valores plausibles en Aluminé', () => {
  const est1 = estimateTaxiFare('Plaza San Martín', 'Hospital de Aluminé');
  assert.ok(est1.fareEstimated >= 2500 && est1.fareEstimated <= 5000);
  assert.ok(est1.distanceKm.includes('km'));
  assert.ok(est1.durationMin.includes('min'));
  assert.ok(est1.pickupEta.includes('min'));

  const est2 = estimateTaxiFare('Terminal de Ómnibus', 'Barrio La Pampa');
  assert.ok(est2.fareEstimated > est1.fareEstimated);
});

test('creación de viaje de taxi valida campos requeridos', () => {
  const storage = createMockStorage();

  // Origen corto
  assert.throws(
    () => createTaxiTrip({ origin: 'a', destination: 'Hospital', passengerName: 'Juan', passengerPhone: '2942-551234' }, { storage }),
    code('INVALID_ORIGIN')
  );

  // Destino corto
  assert.throws(
    () => createTaxiTrip({ origin: 'Plaza', destination: 'b', passengerName: 'Juan', passengerPhone: '2942-551234' }, { storage }),
    code('INVALID_DESTINATION')
  );

  // Nombre inválido
  assert.throws(
    () => createTaxiTrip({ origin: 'Plaza', destination: 'Hospital', passengerName: '!', passengerPhone: '2942-551234' }, { storage }),
    code('INVALID_NAME')
  );

  // Teléfono inválido
  assert.throws(
    () => createTaxiTrip({ origin: 'Plaza', destination: 'Hospital', passengerName: 'Juan Pérez', passengerPhone: '111' }, { storage }),
    code('INVALID_PHONE')
  );
});

test('circuito completo de taxi: creación, asignación, viaje y finalización', () => {
  const storage = createMockStorage();
  let time = 1000;
  const clock = () => new Date(time += 60000).toISOString();
  let seq = 1;
  const uuid = () => `mock-uuid-${seq++}`;

  // 1. Crear viaje
  const trip = createTaxiTrip(
    {
      origin: 'Plaza San Martín',
      destination: 'Hospital de Aluminé',
      originNote: 'Frente al banco',
      passengerName: 'Laura Gómez',
      passengerPhone: '2942 558899',
    },
    { storage, clock, uuid }
  );

  assert.equal(trip.status, 'requested');
  assert.equal(trip.passenger.name, 'Laura Gómez');
  assert.equal(trip.driver.mobileNumber, 'Móvil 04');
  assert.ok(trip.estimate.fareEstimated > 0);

  // 2. Comprobar que está activo
  const active1 = getActiveTaxiTrip(storage);
  assert.equal(active1.id, trip.id);
  assert.equal(active1.status, 'requested');

  // 3. Chofer acepta viaje -> accepted
  const s1 = advanceTaxiTrip(trip.id, { storage, clock });
  assert.equal(s1.status, 'accepted');

  // 4. Chofer en camino -> driver_on_way
  const s2 = advanceTaxiTrip(trip.id, { storage, clock });
  assert.equal(s2.status, 'driver_on_way');

  // 5. Chofer llegó -> driver_arrived
  const s3 = advanceTaxiTrip(trip.id, { storage, clock });
  assert.equal(s3.status, 'driver_arrived');

  // 6. Pasajero a bordo -> passenger_on_board
  const s4 = advanceTaxiTrip(trip.id, { storage, clock });
  assert.equal(s4.status, 'passenger_on_board');

  // 7. Iniciar viaje -> in_trip
  const s5 = advanceTaxiTrip(trip.id, { storage, clock });
  assert.equal(s5.status, 'in_trip');

  // En curso: no puede cancelarse
  assert.throws(
    () => cancelTaxiTrip(trip.id, { storage, clock }),
    code('CANNOT_CANCEL')
  );

  // 8. Finalizar viaje -> completed
  const s6 = advanceTaxiTrip(trip.id, { storage, clock });
  assert.equal(s6.status, 'completed');

  // Tras completed: no hay viaje activo pendiente
  assert.equal(getActiveTaxiTrip(storage), null);

  // Pero el viaje persiste en el historial
  const saved = getTaxiTripById(trip.id, storage);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.history.length, 7); // requested + 6 transiciones
});

test('persistencia y prevención de viaje duplicado', () => {
  const storage = createMockStorage();
  createTaxiTrip(
    {
      origin: 'Costanera',
      destination: 'Terminal',
      passengerName: 'Pedro Rossi',
      passengerPhone: '2942 443322',
    },
    { storage }
  );

  // Segundo pedido simultáneo debe ser rechazado
  assert.throws(
    () =>
      createTaxiTrip(
        {
          origin: 'Plaza',
          destination: 'Centro',
          passengerName: 'Pedro Rossi',
          passengerPhone: '2942 443322',
        },
        { storage }
      ),
    code('ACTIVE_TRIP_EXISTS')
  );

  // Persiste en storage bajo TAXI_STORAGE_KEY
  const raw = storage.getItem(TAXI_STORAGE_KEY);
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.trips.length, 1);
  assert.equal(parsed.trips[0].passenger.name, 'Pedro Rossi');
});

test('cancelación de viaje antes de iniciar', () => {
  const storage = createMockStorage();
  const trip = createTaxiTrip(
    {
      origin: 'Plaza San Martín',
      destination: 'Terminal de Ómnibus',
      passengerName: 'Ana Belén',
      passengerPhone: '2942 112233',
    },
    { storage }
  );

  advanceTaxiTrip(trip.id, { storage }); // accepted

  const canceled = cancelTaxiTrip(trip.id, { reason: 'Pasajero decidió no viajar', storage });
  assert.equal(canceled.status, 'canceled');
  assert.equal(getActiveTaxiTrip(storage), null);

  // Nuevo viaje ahora es permitido
  const nextTrip = createTaxiTrip(
    {
      origin: 'Plaza San Martín',
      destination: 'Hospital',
      passengerName: 'Ana Belén',
      passengerPhone: '2942 112233',
    },
    { storage }
  );
  assert.equal(nextTrip.status, 'requested');
});

test('reset limpia el estado de taxis', () => {
  const storage = createMockStorage();
  createTaxiTrip(
    {
      origin: 'Plaza San Martín',
      destination: 'Hospital',
      passengerName: 'Mariano',
      passengerPhone: '2942 998877',
    },
    { storage }
  );
  assert.ok(storage.getItem(TAXI_STORAGE_KEY));
  resetTaxiState(storage);
  assert.equal(storage.getItem(TAXI_STORAGE_KEY), null);
});
