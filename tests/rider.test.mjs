import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAssignableDeliveryOrder,
  getAssignableDeliveryOrder,
  getRiderQueueOrder,
  isAwaitingPreparation,
  getRiderActionState,
  getRouteProgress,
  getRiderStateLabel,
} from '../js/core/rider.js';

test('isAssignableDeliveryOrder solo acepta pedidos de delivery en estados listos o en reparto', () => {
  assert.equal(isAssignableDeliveryOrder({ fulfillment: 'delivery', status: 'ready' }), true);
  assert.equal(isAssignableDeliveryOrder({ fulfillment: 'delivery', status: 'on_the_way' }), true);
  assert.equal(isAssignableDeliveryOrder({ fulfillment: 'delivery', status: 'delivered' }), false); // terminal
  assert.equal(isAssignableDeliveryOrder({ fulfillment: 'pickup', status: 'ready' }), false); // pickup
  assert.equal(isAssignableDeliveryOrder({ fulfillment: 'delivery', status: 'preparing' }), false); // aún en cocina
});

test('getAssignableDeliveryOrder prioriza pedidos en camino sobre listos y por antigüedad', () => {
  const orders = [
    { id: '1', fulfillment: 'delivery', status: 'ready', createdAt: '2026-09-15T12:00:00Z' },
    { id: '2', fulfillment: 'delivery', status: 'on_the_way', createdAt: '2026-09-15T12:10:00Z' },
  ];
  const chosen = getAssignableDeliveryOrder(orders);
  assert.equal(chosen.id, '2'); // on_the_way tiene prioridad
});

test('getRiderQueueOrder prioriza el pedido en viaje activo', () => {
  const queue = [
    { id: '1', fulfillment: 'delivery', status: 'ready', createdAt: '2026-09-15T12:00:00Z' },
    { id: '2', fulfillment: 'delivery', status: 'on_the_way', createdAt: '2026-09-15T12:05:00Z' },
  ];
  assert.equal(getRiderQueueOrder(queue).id, '2');
});

test('isAwaitingPreparation protege datos del cliente mientras el local prepara', () => {
  assert.equal(isAwaitingPreparation({ status: 'submitted' }), true);
  assert.equal(isAwaitingPreparation({ status: 'accepted' }), true);
  assert.equal(isAwaitingPreparation({ status: 'preparing' }), true);
  assert.equal(isAwaitingPreparation({ status: 'ready' }), false);
  assert.equal(isAwaitingPreparation({ status: 'on_the_way' }), false);
});

test('getRiderActionState y progreso de ruta calculan estados de transición', () => {
  assert.deepEqual(getRiderActionState({ status: 'ready' }), {
    canPickUp: true,
    canLeave: true,
    canArrive: false,
    canDeliver: false,
  });

  assert.equal(getRouteProgress({ status: 'delivered' }), 1);
  assert.equal(getRouteProgress({ status: 'on_the_way' }), 0.62);
  assert.equal(getRiderStateLabel({ status: 'on_the_way' }), 'En camino al cliente');
});
