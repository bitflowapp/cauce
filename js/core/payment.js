// Pagos: vocabulario neutral de CAUCE, sin ningún proveedor adentro.
//
// El pedido y el pago son estados separados. El efectivo conserva sus dos
// estados de siempre en la base (`pending_on_delivery` → `settled`); el pago
// online usa los estados neutrales de abajo, que el servidor traduce desde el
// proveedor. La interfaz nunca decide que algo se pagó: lo lee de la base.

// Formas de pago visibles.
export const PAYMENT_METHOD_LABELS = Object.freeze({
  cash_demo: 'Efectivo al recibir (prueba)',
  transfer_demo: 'Transferencia al comercio (prueba)',
  cash_on_delivery: 'Efectivo al recibir',
  cash_on_pickup: 'Efectivo al retirar',
  online: 'Pago online',
});

// Estados neutrales. `not_required`: pedido en efectivo, no hay pago online
// que esperar (no se guarda en la base, es la vista neutral del efectivo).
export const PAYMENT_STATES = Object.freeze(['not_required', 'pending', 'processing', 'approved', 'rejected',
  'cancelled', 'refunded', 'partially_refunded', 'expired']);

// Máquina de estados de un intento de pago. Es la misma tabla que
// private.payment_status_transitions (una prueba las compara). Repetir el
// estado actual no es un salto: es la misma noticia dos veces.
export const PAYMENT_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['processing', 'approved', 'rejected', 'cancelled', 'expired']),
  processing: Object.freeze(['approved', 'rejected', 'cancelled', 'expired']),
  approved: Object.freeze(['refunded', 'partially_refunded']),
  partially_refunded: Object.freeze(['refunded']),
});

export function canTransitionPayment(from, to) {
  if (!PAYMENT_STATES.includes(from) || !PAYMENT_STATES.includes(to)) return false;
  return from === to || (PAYMENT_TRANSITIONS[from] || []).includes(to);
}

// Estados en los que ya no se espera nada del pagador.
export const SETTLED_PAYMENT_STATES = Object.freeze(['approved', 'rejected', 'cancelled', 'refunded',
  'partially_refunded', 'expired']);
export const isWaitingPayment = state => state === 'pending' || state === 'processing';
export const isPaid = state => state === 'approved' || state === 'partially_refunded';

// Lo que ve quien compra, por estado del pago online.
const ONLINE_LABELS = Object.freeze({
  pending: 'Pago pendiente',
  processing: 'Pago en revisión',
  approved: 'Pagado',
  rejected: 'Pago rechazado',
  cancelled: 'Pago anulado',
  refunded: 'Pago devuelto',
  partially_refunded: 'Devolución parcial',
  expired: 'Pago vencido',
});
const ONLINE_TONES = Object.freeze({
  pending: 'pending', processing: 'pending', approved: 'success', rejected: 'error', cancelled: 'neutral',
  refunded: 'neutral', partially_refunded: 'neutral', expired: 'error',
});

// Vista neutral del pago de un pedido, para cualquier pantalla.
export function orderPayment(order) {
  if (order?.paymentMethod === 'online') {
    const state = PAYMENT_STATES.includes(order.paymentStatus) && order.paymentStatus !== 'not_required'
      ? order.paymentStatus : 'pending';
    return Object.freeze({ kind: 'online', state, collected: isPaid(state), label: ONLINE_LABELS[state],
      tone: ONLINE_TONES[state], method: PAYMENT_METHOD_LABELS.online });
  }
  const collected = order?.paymentStatus === 'settled';
  const method = PAYMENT_METHOD_LABELS[order?.paymentMethod]
    || (order?.fulfillment === 'pickup' ? PAYMENT_METHOD_LABELS.cash_on_pickup : PAYMENT_METHOD_LABELS.cash_on_delivery);
  return Object.freeze({ kind: 'cash', state: 'not_required', collected,
    label: collected ? 'Cobrado en efectivo' : method, tone: collected ? 'success' : 'neutral', method });
}

// Un pedido online se prepara recién con el pago aprobado (la base lo exige
// igual: transition_order devuelve U0007).
export const canPrepare = order => order?.paymentMethod !== 'online' || order?.paymentStatus === 'approved';

// ── formas de pago del checkout ──
// La base dice qué ofrece cada comercio (payment_methods). Acá sólo se
// ordenan y se describen para la modalidad elegida: nunca se agrega una
// forma que la base no ofreció.
export function checkoutPaymentMethods(methods, fulfillment) {
  const list = Array.isArray(methods) ? methods : [];
  const cashId = fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup';
  const result = [];
  const cash = list.find(method => method?.kind === 'cash' && method.id === cashId);
  if (cash) {
    result.push(Object.freeze({ id: cash.id, kind: 'cash', label: PAYMENT_METHOD_LABELS[cash.id],
      detail: fulfillment === 'delivery' ? 'Le pagás a quien te entrega el pedido.' : 'Le pagás al comercio cuando retirás.' }));
  }
  const online = list.find(method => method?.kind === 'online' && method.id === 'online');
  if (online && typeof online.provider === 'string' && online.provider) {
    result.push(Object.freeze({ id: 'online', kind: 'online', provider: online.provider,
      label: String(online.label || 'Pago online'),
      detail: 'Pagás ahora y el comercio recibe el pedido con el pago aprobado.' }));
  }
  return result;
}

// Sin respuesta de la base (versión anterior o error), el checkout ofrece sólo
// el efectivo de la modalidad: nunca inventa una forma online.
export const cashOnlyMethods = fulfillment => checkoutPaymentMethods([
  { id: fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup', kind: 'cash' },
], fulfillment);

// ── retorno desde el proveedor ──
// #/pago/exito, #/pago/pendiente y #/pago/error. La ruta sólo elige el primer
// mensaje; lo que se muestra como resultado sale del estado real en la base.
export const RETURN_OUTCOMES = Object.freeze(['exito', 'pendiente', 'error']);

export function paymentReturnState(outcome, payment) {
  if (!payment) {
    return Object.freeze({ tone: 'neutral', final: true, title: 'No encontramos este pago',
      message: 'El enlace no corresponde a un pedido de esta sesión. Si pagaste, el comercio lo ve en su panel.' });
  }
  if (payment.paymentMethod !== 'online') {
    return Object.freeze({ tone: 'neutral', final: true, title: 'Este pedido no tiene pago online',
      message: 'Se paga en efectivo al comercio. Seguí el pedido desde "Mis pedidos".' });
  }
  const state = payment.paymentStatus;
  if (state === 'approved' || state === 'partially_refunded') {
    return Object.freeze({ tone: 'success', final: true, title: 'Pago aprobado',
      message: 'El proveedor confirmó el pago. El comercio ya puede preparar tu pedido.' });
  }
  if (state === 'rejected' || state === 'expired' || state === 'cancelled') {
    return Object.freeze({ tone: 'error', final: true, title: state === 'rejected' ? 'El pago fue rechazado' : 'El pago no se completó',
      message: 'El proveedor no aprobó el cobro. Podés intentar de nuevo desde tu pedido.' });
  }
  if (state === 'refunded') {
    return Object.freeze({ tone: 'neutral', final: true, title: 'Pago devuelto',
      message: 'El proveedor informó la devolución del pago.' });
  }
  // Pendiente o en revisión: se espera la confirmación del proveedor, aunque la
  // URL diga "éxito".
  return Object.freeze({ tone: 'pending', final: false,
    title: outcome === 'error' ? 'Estamos revisando tu pago' : 'Estamos confirmando tu pago',
    message: 'Esperamos la confirmación del proveedor. Esta pantalla se actualiza sola; no hace falta pagar de nuevo.' });
}
