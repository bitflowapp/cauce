export const ORDER_WORKFLOW_STATUSES = Object.freeze([
  'draft',
  'submitted',
  'accepted',
  'preparing',
  'ready',
  'assigned',
  'picked_up',
  'on_the_way',
  'arrived',
  'delivered',
  'canceled',
]);

export const TERMINAL_WORKFLOW_STATUSES = Object.freeze(['delivered', 'canceled']);

export const DEMO_TO_WORKFLOW_STATUS = Object.freeze({
  received: 'submitted',
  rejected: 'canceled',
  preparing: 'preparing',
  ready: 'ready',
  on_the_way: 'on_the_way',
  arriving: 'arrived',
  delivered: 'delivered',
  cancelled: 'canceled',
});

export const WORKFLOW_TO_DEMO_STATUS = Object.freeze({
  draft: 'received',
  submitted: 'received',
  accepted: 'preparing',
  preparing: 'preparing',
  ready: 'ready',
  assigned: 'ready',
  picked_up: 'on_the_way',
  on_the_way: 'on_the_way',
  arrived: 'arriving',
  delivered: 'delivered',
  canceled: 'cancelled',
});

export const ORDER_WORKFLOW_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['submitted', 'canceled']),
  submitted: Object.freeze(['accepted', 'preparing', 'canceled']),
  accepted: Object.freeze(['preparing', 'canceled']),
  preparing: Object.freeze(['ready', 'canceled']),
  ready: Object.freeze(['assigned', 'picked_up', 'on_the_way', 'delivered', 'canceled']),
  assigned: Object.freeze(['picked_up', 'on_the_way', 'canceled']),
  picked_up: Object.freeze(['on_the_way', 'canceled']),
  on_the_way: Object.freeze(['arrived', 'delivered', 'canceled']),
  arrived: Object.freeze(['delivered', 'canceled']),
  delivered: Object.freeze([]),
  canceled: Object.freeze([]),
});

const DELIVERY_FLOW = Object.freeze([
  'draft',
  'submitted',
  'accepted',
  'preparing',
  'ready',
  'assigned',
  'picked_up',
  'on_the_way',
  'arrived',
  'delivered',
]);

const PICKUP_FLOW = Object.freeze([
  'draft',
  'submitted',
  'accepted',
  'preparing',
  'ready',
  'delivered',
]);

export function isWorkflowStatus(status) {
  return ORDER_WORKFLOW_STATUSES.includes(status);
}

export function normalizeWorkflowStatus(status, fallback = 'submitted') {
  const raw = String(status || '').trim();
  const mapped = DEMO_TO_WORKFLOW_STATUS[raw] || raw;
  return isWorkflowStatus(mapped) ? mapped : fallback;
}

export function toDemoOrderStatus(status) {
  return WORKFLOW_TO_DEMO_STATUS[normalizeWorkflowStatus(status)] || 'received';
}

export function isTerminalWorkflowStatus(status) {
  return TERMINAL_WORKFLOW_STATUSES.includes(normalizeWorkflowStatus(status));
}

export function canTransitionWorkflowStatus(fromStatus, toStatus) {
  const from = normalizeWorkflowStatus(fromStatus);
  const to = normalizeWorkflowStatus(toStatus);
  if (from === to) return false;
  return ORDER_WORKFLOW_TRANSITIONS[from]?.includes(to) || false;
}

export function getWorkflowFlow(fulfillmentType = 'delivery') {
  return fulfillmentType === 'pickup' ? PICKUP_FLOW : DELIVERY_FLOW;
}

export function getNextWorkflowStatus(status, fulfillmentType = 'delivery') {
  const current = normalizeWorkflowStatus(status);
  if (isTerminalWorkflowStatus(current)) return null;
  const flow = getWorkflowFlow(fulfillmentType);
  const index = flow.indexOf(current);
  return index >= 0 ? flow[index + 1] || null : null;
}
