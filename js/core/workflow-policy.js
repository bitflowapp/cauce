import { getNextWorkflowStatus, isWorkflowStatus, canTransitionWorkflowStatus } from './order-workflow.js';
import { assertScope } from './scope.js';
import { requireValue } from './errors.js';
export const STATUS_LABELS = Object.freeze({ submitted: 'Recibido', accepted: 'Confirmado', preparing: 'En preparación', ready: 'Listo', assigned: 'Repartidor asignado', picked_up: 'Retirado del comercio', on_the_way: 'En camino', arrived: 'Llegó a destino', delivered: 'Entregado', canceled: 'Cancelado' });
export function allowedActions(order, actor) {
  if (!order || !actor || !isWorkflowStatus(order.status)) return [];
  if (['delivered', 'canceled'].includes(order.status)) return [];
  if (actor.kind === 'customer') return actor.id === order.customerId && order.status === 'submitted' ? ['canceled'] : [];
  try { assertScope(actor, order); } catch { return []; }
  if (actor.kind === 'merchant') {
    const actions = [];
    if (['submitted', 'accepted', 'preparing'].includes(order.status)) actions.push(getNextWorkflowStatus(order.status, order.fulfillment));
    if (order.status === 'ready') actions.push(order.fulfillment === 'pickup' ? 'delivered' : 'assigned');
    if (['submitted', 'accepted', 'preparing', 'ready', 'assigned'].includes(order.status)) actions.push('canceled');
    return actions;
  }
  if (actor.kind === 'rider' && actor.id === order.riderId && order.fulfillment === 'delivery'
      && ['assigned', 'picked_up', 'on_the_way', 'arrived'].includes(order.status)) return [getNextWorkflowStatus(order.status, 'delivery')];
  return [];
}
export function requireTransition(order, nextStatus, actor) {
  // El normalizador heredado admite alias; los comandos nuevos exigen estados canónicos.
  requireValue(isWorkflowStatus(order?.status) && isWorkflowStatus(nextStatus), 'INVALID_STATUS', 'Estado de pedido inválido.');
  requireValue(canTransitionWorkflowStatus(order.status, nextStatus) && allowedActions(order, actor).includes(nextStatus),
    'TRANSITION_FORBIDDEN', 'No podés realizar ese cambio de estado.');
}
