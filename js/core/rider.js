// Portado de js/core/rider.js de La Taba.
// Lógica de selección de pedidos, cola y estados de acción del repartidor.

import {
  ASSIGNABLE_DELIVERY_STATUSES,
  canTransitionOrderStatus,
  isTerminalOrderStatus,
} from './order-status.js';

function normalizeDeliveryMode(value) {
  return value === 'pickup' ? 'pickup' : 'delivery';
}

const RIDER_STATUS_PRIORITY = Object.freeze({
  on_the_way: 0,
  arriving: 1,
  arrived: 1,
  ready: 2,
  assigned: 2,
  picked_up: 0,
});

export function isAssignableDeliveryOrder(order) {
  return Boolean(
    order
      && normalizeDeliveryMode(order.fulfillment || order.deliveryMode) === 'delivery'
      && !isTerminalOrderStatus(order.status)
      && ASSIGNABLE_DELIVERY_STATUSES.includes(order.status),
  );
}

export function getAssignableDeliveryOrder(orders = []) {
  if (!Array.isArray(orders)) return null;
  return [...orders]
    .filter(isAssignableDeliveryOrder)
    .sort((a, b) => {
      const rankDiff = (RIDER_STATUS_PRIORITY[a.status] ?? 99) - (RIDER_STATUS_PRIORITY[b.status] ?? 99);
      if (rankDiff !== 0) return rankDiff;
      return toSortableTime(a.createdAt) - toSortableTime(b.createdAt);
    })[0] || null;
}

// El rider entra en escena cuando el negocio termina de preparar el pedido.
// Recibidos y pedidos en preparación pertenecen exclusivamente a la cola del
// local y nunca deben exponer datos del cliente en la vista de reparto.
const RIDER_QUEUE_STATUSES = Object.freeze(['ready', 'assigned', 'picked_up', 'on_the_way', 'arrived', 'arriving']);
const RIDER_IN_PROGRESS = Object.freeze(['picked_up', 'on_the_way', 'arrived', 'arriving']);

export function isRiderQueueOrder(order) {
  return Boolean(
    order
      && normalizeDeliveryMode(order.fulfillment || order.deliveryMode) === 'delivery'
      && !isTerminalOrderStatus(order.status)
      && RIDER_QUEUE_STATUSES.includes(order.status),
  );
}

// Si hay un reparto en curso, ese manda; si no, el pedido más reciente en cola.
export function getRiderQueueOrder(orders = []) {
  if (!Array.isArray(orders)) return null;
  const queue = orders.filter(isRiderQueueOrder);
  if (!queue.length) return null;

  const inProgress = queue
    .filter((order) => RIDER_IN_PROGRESS.includes(order.status))
    .sort((a, b) => toSortableTime(b.createdAt) - toSortableTime(a.createdAt));
  if (inProgress.length) return inProgress[0];

  return [...queue].sort((a, b) => toSortableTime(b.createdAt) - toSortableTime(a.createdAt))[0];
}

export function isAwaitingPreparation(order) {
  return Boolean(order) && (order.status === 'received' || order.status === 'submitted' || order.status === 'accepted' || order.status === 'preparing');
}

function toSortableTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function getRiderActionState(order) {
  const status = order?.status;
  return {
    canPickUp: (status === 'ready' || status === 'assigned'),
    canLeave: (status === 'picked_up' || status === 'ready' || status === 'assigned'),
    canArrive: status === 'on_the_way',
    canDeliver: status === 'arrived' || status === 'arriving',
  };
}

export function getRouteProgress(order) {
  if (!order) return 0;
  if (order.status === 'delivered') return 1;
  if (order.status === 'arrived' || order.status === 'arriving') return 0.84;
  if (order.status === 'on_the_way') return 0.62;
  if (order.status === 'picked_up') return 0.40;
  return 0.04;
}

export function getRiderStateLabel(order) {
  if (!order) return 'Sin pedido asignado';
  if (order.status === 'delivered') return 'Entregado';
  if (order.status === 'arrived' || order.status === 'arriving') return 'Llegando al cliente';
  if (order.status === 'on_the_way') return 'En camino al cliente';
  if (order.status === 'picked_up') return 'Retirado del local, listo para salir';
  if (order.status === 'assigned') return 'Asignado al repartidor';
  return 'Esperando salida del local';
}
