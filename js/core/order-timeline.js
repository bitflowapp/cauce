// Portado de js/core/order-timeline.js de La Taba.
// Línea de estado UNIFICADA del pedido: mismo vocabulario para Cliente, Negocio y Rider.

export const ORDER_TIMELINE_STEPS = Object.freeze([
  { key: 'received', label: 'Recibido' },
  { key: 'preparing', label: 'En preparación' },
  { key: 'ready', label: 'Listo' },
  { key: 'delivery', label: 'En reparto' },
  { key: 'delivered', label: 'Entregado' },
]);

export const PUBLIC_ORDER_TIMELINE_STEPS = Object.freeze([
  { key: 'confirmed', label: 'Confirmado' },
  { key: 'preparing', label: 'Preparando' },
  { key: 'delivery', label: 'En camino' },
  { key: 'delivered', label: 'Entregado' },
]);

export function orderTimelineIndex(status) {
  if (['accepted', 'preparing'].includes(status)) return 1;
  if (['ready', 'assigned'].includes(status)) return 2;
  if (['picked_up', 'on_the_way', 'arrived', 'arriving'].includes(status)) return 3;
  if (status === 'delivered') return 4;
  return 0; // received, submitted, draft
}

export function publicOrderTimelineIndex(status) {
  if (['accepted', 'preparing', 'ready', 'assigned'].includes(status)) return 1;
  if (['picked_up', 'on_the_way', 'arrived', 'arriving'].includes(status)) return 2;
  if (status === 'delivered') return 3;
  return 0; // draft/submitted/received y estados desconocidos
}

export function renderOrderTimeline(status, { className = '' } = {}) {
  return renderTimeline(ORDER_TIMELINE_STEPS, orderTimelineIndex(status), status, className, 'operational');
}

export function renderPublicOrderTimeline(status, { className = '' } = {}) {
  const steps = (status === 'arriving' || status === 'arrived')
    ? PUBLIC_ORDER_TIMELINE_STEPS.map((step) => (
      step.key === 'delivery' ? { ...step, label: 'Llegó' } : step
    ))
    : PUBLIC_ORDER_TIMELINE_STEPS;
  return renderTimeline(
    steps,
    publicOrderTimelineIndex(status),
    status,
    className,
    'public',
  );
}

function renderTimeline(stepsConfig, stepIndex, status, className, surface) {
  const isCancelled = status === 'cancelled' || status === 'canceled';
  const steps = stepsConfig.map((step, index) => {
    let cls = 'pending';
    if (!isCancelled && index < stepIndex) cls = 'done';
    if (!isCancelled && index === stepIndex) cls = 'current';
    const current = cls === 'current' ? ' aria-current="step"' : '';
    return `<div class="track-step ${cls}" role="listitem"${current}><span class="track-dot" aria-hidden="true"></span><small>${step.label}</small></div>`;
  }).join('');
  const classes = ['track-steps', className, surface].filter(Boolean).join(' ');
  const label = isCancelled ? 'Pedido cancelado' : 'Progreso del pedido';
  return `<div class="${classes}" role="list" aria-label="${label}">${steps}</div>`;
}
