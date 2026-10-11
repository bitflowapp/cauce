// Estados del pedido: refleja `private.order_transitions` (la base decide).
export const STATUS_LABEL = Object.freeze({
  submitted: 'Enviado', accepted: 'Aceptado', preparing: 'En preparación', ready: 'Listo',
  on_the_way: 'En camino', delivered: 'Entregado', canceled: 'Cancelado',
});

export const FULFILLMENT_LABEL = Object.freeze({
  fair_pickup: 'Retiro en feria', pickup: 'Retiro acordado', delivery: 'Envío a domicilio',
});

export const PAYMENT_LABEL = Object.freeze({ cash: 'Efectivo', transfer: 'Transferencia al vendedor' });

/** Texto que lee quien compró en cada estado. */
export function buyerMessage(order) {
  const where = order.fulfillment === 'fair_pickup' ? 'en el puesto de la feria'
    : order.fulfillment === 'pickup' ? 'en el lugar que acuerden' : 'en tu domicilio';
  switch (order.status) {
    case 'submitted': return 'El vendedor recibió tu pedido y lo va a confirmar pronto.';
    case 'accepted': return 'Tu pedido fue aceptado.';
    case 'preparing': return 'Están preparando tu pedido con dedicación.';
    case 'ready': return order.fulfillment === 'delivery' ? 'Tu pedido está listo para salir.' : `Tu pedido está listo para retirar ${where}.`;
    case 'on_the_way': return 'Tu pedido va en camino.';
    case 'delivered': return '¡Pedido entregado! Gracias por comprar cerca.';
    case 'canceled': return 'El pedido fue cancelado.';
    default: return '';
  }
}

/** Pasos del seguimiento según la forma de entrega. */
export function timelineSteps(fulfillment) {
  return fulfillment === 'delivery'
    ? ['submitted', 'accepted', 'preparing', 'ready', 'on_the_way', 'delivered']
    : ['submitted', 'accepted', 'preparing', 'ready', 'delivered'];
}

/** Próximas acciones del comercio (mismas reglas que la base). */
export function merchantActions(order) {
  const actions = [];
  const add = (next, label, tone = 'primary') => actions.push({ next, label, tone });
  switch (order.status) {
    case 'submitted': add('accepted', 'Aceptar pedido'); break;
    case 'accepted': add('preparing', 'Empezar a preparar'); add('ready', 'Ya está listo', 'secondary'); break;
    case 'preparing': add('ready', 'Marcar listo'); break;
    case 'ready':
      if (order.fulfillment === 'delivery') add('on_the_way', 'Salió a entregar');
      else add('delivered', 'Entregado');
      break;
    case 'on_the_way': add('delivered', 'Entregado'); break;
    default: break;
  }
  if (['submitted', 'accepted', 'preparing', 'ready', 'on_the_way'].includes(order.status)) {
    actions.push({ next: 'canceled', label: order.status === 'submitted' ? 'Rechazar' : 'Cancelar', tone: 'danger' });
  }
  return actions;
}

export const isOpen = order => !['delivered', 'canceled'].includes(order.status);
export const buyerCanCancel = order => order.status === 'submitted';
