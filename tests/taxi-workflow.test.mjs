import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAXI_STATUSES,
  TAXI_STATUS_LABELS,
  canTransitionTaxi,
  validateTaxiTransition,
  isTaxiCancelable,
  isTaxiActive,
  getDriverNextAction,
  getPassengerTimelineIndex,
} from '../js/core/taxi-workflow.js';

test('estados de taxi definen exactamente los 9 estados requeridos', () => {
  assert.equal(TAXI_STATUSES.length, 9);
  const expected = [
    'requested',
    'searching',
    'accepted',
    'driver_on_way',
    'driver_arrived',
    'passenger_on_board',
    'in_trip',
    'completed',
    'canceled',
  ];
  assert.deepEqual([...TAXI_STATUSES], expected);
  for (const status of TAXI_STATUSES) {
    assert.ok(TAXI_STATUS_LABELS[status], `Falta label para estado ${status}`);
  }
});

test('circuito secuencial completo del taxista y pasajero es válido', () => {
  // requested -> searching -> accepted -> driver_on_way -> driver_arrived -> passenger_on_board -> in_trip -> completed
  assert.ok(canTransitionTaxi('requested', 'searching'));
  assert.ok(canTransitionTaxi('searching', 'accepted'));
  assert.ok(canTransitionTaxi('accepted', 'driver_on_way'));
  assert.ok(canTransitionTaxi('driver_on_way', 'driver_arrived'));
  assert.ok(canTransitionTaxi('driver_arrived', 'passenger_on_board'));
  assert.ok(canTransitionTaxi('passenger_on_board', 'in_trip'));
  assert.ok(canTransitionTaxi('in_trip', 'completed'));
});

test('asignación directa de taxi desde requested a accepted es válida', () => {
  assert.ok(canTransitionTaxi('requested', 'accepted'));
});

test('estados imposibles son estrictamente rechazados', () => {
  // No se puede iniciar viaje antes de que el chofer llegue y suba el pasajero
  assert.equal(canTransitionTaxi('requested', 'in_trip'), false);
  assert.equal(canTransitionTaxi('searching', 'in_trip'), false);
  assert.equal(canTransitionTaxi('accepted', 'in_trip'), false);
  assert.equal(canTransitionTaxi('driver_on_way', 'in_trip'), false);

  // No se puede finalizar antes de iniciar el viaje
  assert.equal(canTransitionTaxi('requested', 'completed'), false);
  assert.equal(canTransitionTaxi('accepted', 'completed'), false);
  assert.equal(canTransitionTaxi('driver_arrived', 'completed'), false);
  assert.equal(canTransitionTaxi('passenger_on_board', 'completed'), false);

  // Estados terminales no transicionan
  assert.equal(canTransitionTaxi('completed', 'requested'), false);
  assert.equal(canTransitionTaxi('completed', 'in_trip'), false);
  assert.equal(canTransitionTaxi('canceled', 'accepted'), false);

  // validateTaxiTransition lanza CauceError con INVALID_TRANSITION
  assert.throws(
    () => validateTaxiTransition('requested', 'completed'),
    /Transición de viaje no permitida/
  );
});

test('cancelación solo es posible antes de que el viaje esté en curso', () => {
  assert.ok(isTaxiCancelable('requested'));
  assert.ok(isTaxiCancelable('searching'));
  assert.ok(isTaxiCancelable('accepted'));
  assert.ok(isTaxiCancelable('driver_on_way'));
  assert.ok(isTaxiCancelable('driver_arrived'));
  assert.ok(isTaxiCancelable('passenger_on_board'));

  assert.equal(isTaxiCancelable('in_trip'), false);
  assert.equal(isTaxiCancelable('completed'), false);
  assert.equal(isTaxiCancelable('canceled'), false);

  assert.throws(
    () => validateTaxiTransition('in_trip', 'canceled'),
    /Transición de viaje no permitida/
  );
});

test('acciones del taxista evolucionan ordenadamente', () => {
  const a1 = getDriverNextAction('requested');
  assert.equal(a1.nextStatus, 'accepted');

  const a2 = getDriverNextAction('accepted');
  assert.equal(a2.nextStatus, 'driver_on_way');

  const a3 = getDriverNextAction('driver_on_way');
  assert.equal(a3.nextStatus, 'driver_arrived');

  const a4 = getDriverNextAction('driver_arrived');
  assert.equal(a4.nextStatus, 'passenger_on_board');

  const a5 = getDriverNextAction('passenger_on_board');
  assert.equal(a5.nextStatus, 'in_trip');

  const a6 = getDriverNextAction('in_trip');
  assert.equal(a6.nextStatus, 'completed');

  assert.equal(getDriverNextAction('completed'), null);
  assert.equal(getDriverNextAction('canceled'), null);
});

test('timeline de pasajero mapea índices consistentes', () => {
  assert.equal(getPassengerTimelineIndex('requested'), 0);
  assert.equal(getPassengerTimelineIndex('searching'), 0);
  assert.equal(getPassengerTimelineIndex('accepted'), 1);
  assert.equal(getPassengerTimelineIndex('driver_on_way'), 2);
  assert.equal(getPassengerTimelineIndex('driver_arrived'), 2);
  assert.equal(getPassengerTimelineIndex('passenger_on_board'), 3);
  assert.equal(getPassengerTimelineIndex('in_trip'), 3);
  assert.equal(getPassengerTimelineIndex('completed'), 4);
});
