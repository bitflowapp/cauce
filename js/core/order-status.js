// Portado de js/core/order-status.js de La Taba.
// Catálogo de estados y reglas de transición de la máquina de estados.

export const ORDER_STATUSES = Object.freeze([
  'received',
  'preparing',
  'ready',
  'on_the_way',
  'arriving',
  'delivered',
  'cancelled',
  // compatibilidad con workflow authority
  'draft',
  'submitted',
  'accepted',
  'assigned',
  'picked_up',
  'arrived',
  'canceled',
]);

export const DELIVERY_STATUS_FLOW = Object.freeze(['received', 'preparing', 'ready', 'on_the_way', 'delivered']);
export const PICKUP_STATUS_FLOW = Object.freeze(['received', 'preparing', 'ready', 'delivered']);
export const TERMINAL_ORDER_STATUSES = Object.freeze(['delivered', 'cancelled', 'canceled']);
export const ASSIGNABLE_DELIVERY_STATUSES = Object.freeze(['ready', 'on_the_way', 'arriving', 'assigned', 'picked_up', 'arrived']);

export const ORDER_STATUS_LABELS = Object.freeze({
  draft: 'Borrador',
  submitted: 'Recibido',
  received: 'Recibido',
  accepted: 'Aceptado',
  preparing: 'En preparación',
  ready: 'Listo para enviar',
  assigned: 'Repartidor asignado',
  picked_up: 'Retirado por repartidor',
  on_the_way: 'En camino',
  arriving: 'Llegando',
  arrived: 'Llegó al destino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
  canceled: 'Cancelado',
});

export const ORDER_STATUS_CLASSES = Object.freeze({
  draft: 'received',
  submitted: 'received',
  received: 'received',
  accepted: 'preparing',
  preparing: 'preparing',
  ready: 'ready',
  assigned: 'ready',
  picked_up: 'way',
  on_the_way: 'way',
  arriving: 'way',
  arrived: 'way',
  delivered: 'done',
  cancelled: 'cancelled',
  canceled: 'cancelled',
});

export function isValidOrderStatus(status) {
  return ORDER_STATUSES.includes(status);
}

export function normalizeOrderStatus(status, fallback = 'received') {
  return isValidOrderStatus(status) ? status : fallback;
}

export function isTerminalOrderStatus(status) {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function getOrderStatusFlow(deliveryMode = 'delivery') {
  return deliveryMode === 'pickup' ? PICKUP_STATUS_FLOW : DELIVERY_STATUS_FLOW;
}

export function getNextOrderStatus(order) {
  if (!order || isTerminalOrderStatus(order.status)) return null;
  const flow = getOrderStatusFlow(order.deliveryMode);
  const index = flow.indexOf(order.status);
  return index >= 0 ? flow[index + 1] || null : null;
}

export function canTransitionOrderStatus(order, nextStatus) {
  if (!order || !isValidOrderStatus(nextStatus)) return false;
  const current = normalizeOrderStatus(order.status);
  if (isTerminalOrderStatus(current)) return false;
  if (nextStatus === 'cancelled' || nextStatus === 'canceled') return true;
  if (nextStatus === current) return false;

  if (order.deliveryMode === 'pickup' && (nextStatus === 'on_the_way' || nextStatus === 'arriving' || nextStatus === 'arrived')) return false;

  if (current === 'on_the_way' && (nextStatus === 'arriving' || nextStatus === 'arrived' || nextStatus === 'delivered')) return true;
  if ((current === 'arriving' || current === 'arrived') && nextStatus === 'delivered') return true;

  return getNextOrderStatus({ ...order, status: current }) === nextStatus;
}
