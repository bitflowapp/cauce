// Aplicación de reparto (CAUCE conectado): reglas puras. Qué puede hacer cada
// cuenta lo decide la base (private.order_transitions con actor_role = 'rider'
// y confirm_delivery); acá sólo se ordena y se rotula lo que la base permite.

export const RIDER_OPEN_STATUSES = Object.freeze(['assigned', 'picked_up', 'on_the_way', 'arrived']);
export const RIDER_CLOSED_STATUSES = Object.freeze(['delivered', 'canceled']);
// Intentos con código por pedido antes de que sólo el comercio pueda cerrarlo.
export const DELIVERY_CODE_ATTEMPTS = 5;

// Espejo de las filas `rider` de private.order_transitions, salvo la entrega:
// entregar siempre pasa por el código del cliente.
export const RIDER_STEPS = Object.freeze({
  assigned: Object.freeze({ status: 'picked_up', label: 'Retiré el pedido' }),
  picked_up: Object.freeze({ status: 'on_the_way', label: 'Salí a entregar' }),
  on_the_way: Object.freeze({ status: 'arrived', label: 'Llegué' }),
});
export const CODE_STATUSES = Object.freeze(['on_the_way', 'arrived']);

export const RIDER_STATUS_LABELS = Object.freeze({
  assigned: 'Para retirar',
  picked_up: 'Retirado',
  on_the_way: 'En camino',
  arrived: 'En el domicilio',
  delivered: 'Entregado',
  canceled: 'Cancelado',
});

// Lo más avanzado primero: quien está en la puerta no busca entre pedidos.
const PRIORITY = Object.freeze({ arrived: 0, on_the_way: 1, picked_up: 2, assigned: 3 });

const time = value => {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const isOpenForRider = order => RIDER_OPEN_STATUSES.includes(order?.status);

export function riderStep(order) {
  return RIDER_STEPS[order?.status] || null;
}

export function canConfirmDelivery(order) {
  return CODE_STATUSES.includes(order?.status) && Number(order?.codeAttemptsLeft ?? DELIVERY_CODE_ATTEMPTS) > 0;
}

export function splitRiderOrders(orders = []) {
  const list = Array.isArray(orders) ? orders : [];
  const active = list.filter(isOpenForRider)
    .sort((a, b) => (PRIORITY[a.status] - PRIORITY[b.status]) || (time(a.updatedAt) - time(b.updatedAt)));
  const history = list.filter(order => RIDER_CLOSED_STATUSES.includes(order?.status))
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
  return { active, history };
}

// Enlace universal de Google Maps (abre la aplicación en el teléfono). Sin
// dirección no hay enlace: nunca se inventa un destino.
export function mapsUrl(address, locality = '') {
  const place = String(address || '').replace(/\s+/g, ' ').trim();
  if (place.length < 3) return '';
  const town = String(locality || '').replace(/\s+/g, ' ').trim();
  const query = [place, town && !place.toLowerCase().includes(town.toLowerCase()) ? town : '', 'Argentina']
    .filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// Respuesta de confirm_delivery → mensaje para la persona que reparte.
export function deliveryCodeFeedback(result) {
  if (result?.ok) return { ok: true, tone: 'success', message: 'Entrega confirmada. ¡Gracias!' };
  const remaining = Math.max(0, Number(result?.remaining) || 0);
  switch (result?.reason) {
    case 'format':
      return { ok: false, tone: 'error', message: 'Ingresá los 4 dígitos que te dicta el cliente.' };
    case 'wrong':
      return { ok: false, tone: 'error', message: `Código incorrecto. ${remaining === 1 ? 'Te queda 1 intento' : `Te quedan ${remaining} intentos`}.` };
    case 'locked':
      return { ok: false, tone: 'error',
        message: 'Se agotaron los intentos con código. Avisale al comercio: puede cerrar la entrega desde su panel.' };
    default:
      return { ok: false, tone: 'error', message: 'No se pudo confirmar la entrega. Reintentá.' };
  }
}
