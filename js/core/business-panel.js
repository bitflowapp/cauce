// Panel remoto del comercio: reglas puras de presentación. Qué secciones ve
// cada rol, cómo se agrupan los pedidos por estado, qué acción ofrece cada
// uno y qué resume el día. La base sigue siendo la autoridad (RLS, RPC y
// private.order_transitions): esto sólo decide qué se muestra y qué se ofrece.
import { allowedActions } from './workflow-policy.js';
import { DEFAULT_TIMEZONE, localClock, nextOpening, normalizeHours, formatTime } from './business-hours.js';

// ── secciones ──
// `manage`: titular y encargado/a. `connected`: sólo con el backend real
// (horarios y equipo viven en la base; la demostración no los tiene).
export const PANEL_SECTIONS = Object.freeze([
  Object.freeze({ key: 'inicio', label: 'Inicio', manage: false, connected: false }),
  Object.freeze({ key: 'pedidos', label: 'Pedidos', manage: false, connected: false }),
  Object.freeze({ key: 'catalogo', label: 'Catálogo', manage: false, connected: false }),
  Object.freeze({ key: 'horarios', label: 'Horarios', manage: true, connected: true }),
  Object.freeze({ key: 'configuracion', label: 'Configuración', manage: true, connected: false }),
  Object.freeze({ key: 'reparto', label: 'Reparto', manage: true, connected: false }),
  Object.freeze({ key: 'equipo', label: 'Equipo', manage: true, connected: true }),
]);
const SECTION_ALIASES = Object.freeze({ datos: 'configuracion', resumen: 'inicio' });

export const canManageBusiness = role => role === 'owner' || role === 'manager';

export function panelSections(role, { connected = false } = {}) {
  const manage = canManageBusiness(role);
  return PANEL_SECTIONS.filter(section => (!section.manage || manage) && (!section.connected || connected));
}

// Una sección pedida por URL que el rol no ve (o que no existe) cae en Inicio.
export function resolveSection(requested, sections) {
  const key = SECTION_ALIASES[requested] || requested;
  return sections.some(section => section.key === key) ? key : 'inicio';
}

// ── pedidos por estado ──
// Los grupos siguen la máquina de estados real: "asignado" ya es reparto (la
// próxima acción es de quien reparte), aunque todavía no haya salido.
export const ORDER_GROUPS = Object.freeze([
  Object.freeze({ key: 'nuevos', label: 'Nuevos', statuses: Object.freeze(['submitted']), active: true,
    empty: 'Todavía no tenés pedidos nuevos.' }),
  Object.freeze({ key: 'aceptados', label: 'Aceptados', statuses: Object.freeze(['accepted']), active: true,
    empty: 'Nada aceptado esperando preparación.' }),
  Object.freeze({ key: 'preparando', label: 'Preparando', statuses: Object.freeze(['preparing']), active: true,
    empty: 'Nada en preparación.' }),
  Object.freeze({ key: 'listos', label: 'Listos', statuses: Object.freeze(['ready']), active: true,
    empty: 'Nada listo esperando retiro o reparto.' }),
  Object.freeze({ key: 'reparto', label: 'En reparto', statuses: Object.freeze(['assigned', 'picked_up', 'on_the_way', 'arrived']),
    active: true, empty: 'Nada en reparto.' }),
  Object.freeze({ key: 'completados', label: 'Completados', statuses: Object.freeze(['delivered']), active: false,
    empty: 'Todavía no completaste pedidos en las últimas horas.' }),
  Object.freeze({ key: 'cancelados', label: 'Cancelados', statuses: Object.freeze(['canceled']), active: false,
    empty: 'Sin pedidos cancelados ni rechazados en las últimas horas.' }),
]);
export const ACTIVE_GROUPS = Object.freeze(ORDER_GROUPS.filter(group => group.active).map(group => group.key));
export const ORDER_FILTERS = Object.freeze(['activos', ...ORDER_GROUPS.map(group => group.key)]);

export function orderGroupOf(status) {
  return ORDER_GROUPS.find(group => group.statuses.includes(status))?.key || null;
}

const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));

// Lo abierto se atiende por orden de llegada (el más viejo primero); lo
// cerrado se lee del más reciente al más viejo.
export function groupOrders(orders = []) {
  const groups = Object.fromEntries(ORDER_GROUPS.map(group => [group.key, []]));
  for (const order of orders) {
    const key = orderGroupOf(order?.status);
    if (key) groups[key].push(order);
  }
  for (const group of ORDER_GROUPS) {
    groups[group.key].sort(group.active ? byCreated : (a, b) => byCreated(b, a));
  }
  return groups;
}

export const isOpenOrder = order => !['delivered', 'canceled'].includes(order?.status);

// ── acciones del comercio ──
// Espejo de private.order_transitions para actor_role = 'merchant': el
// comercio también mueve los pasos del reparto propio (la persona que reparte
// no tiene cuenta), cierra un envío fallido con motivo y puede marcar
// entregado directo desde "en camino".
/** @param {any} order @param {{ businessId?: string, localityId?: string, connected?: boolean }} [scope] */
export function merchantOrderActions(order, { businessId, localityId, connected = false } = {}) {
  if (!order || !isOpenOrder(order)) return { forward: [], cancel: false };
  const merchant = { kind: 'merchant', businessId, localityId };
  const rider = order.riderId ? { kind: 'rider', id: order.riderId, businessId, localityId } : null;
  const delivery = order.fulfillment === 'delivery';
  const options = [
    ...allowedActions(order, merchant),
    ...(rider ? allowedActions(order, rider) : []),
    ...(connected && delivery && order.status === 'on_the_way' ? ['delivered'] : []),
    ...(connected && delivery && ['picked_up', 'on_the_way', 'arrived'].includes(order.status) ? ['canceled'] : []),
  ].filter(Boolean);
  const unique = [...new Set(options)];
  return { forward: unique.filter(action => action !== 'canceled'), cancel: unique.includes('canceled') };
}

export function orderActionLabel(order, action) {
  const pickup = order?.fulfillment === 'pickup';
  switch (action) {
    case 'accepted': return 'Aceptar';
    case 'preparing': return 'Empezar a preparar';
    case 'ready': return pickup ? 'Listo para retirar' : 'Listo para enviar';
    case 'assigned': return 'Asignar reparto';
    case 'picked_up': return 'Retirado por el reparto';
    case 'on_the_way': return 'Salió a entregar';
    case 'arrived': return 'Llegó a destino';
    case 'delivered': return pickup ? 'Marcar retirado' : 'Marcar entregado';
    case 'canceled': return order?.status === 'submitted' ? 'Rechazar' : 'Cancelar';
    default: return action;
  }
}

// Estado de la entrega en palabras del comercio (sólo envíos).
export function deliveryStage(order, riderName = '') {
  if (!order || order.fulfillment !== 'delivery') return '';
  const who = riderName ? ` con ${riderName}` : '';
  switch (order.status) {
    case 'submitted': case 'accepted': case 'preparing': return 'Todavía no sale: el pedido se está atendiendo.';
    case 'ready': return 'Listo: falta asignar quién lo lleva.';
    case 'assigned': return `Asignado${riderName ? ` a ${riderName}` : ''}: falta que lo retire.`;
    case 'picked_up': return `Retirado${who}: por salir.`;
    case 'on_the_way': return `En camino${who}.`;
    case 'arrived': return `Llegó a destino${who}: falta la entrega.`;
    case 'delivered': return 'Entregado.';
    case 'canceled': return 'Envío cancelado.';
    default: return '';
  }
}

// ── pedidos nuevos ──
// Nuevo = recibido y todavía sin respuesta. "Fresco" = apareció desde la
// última vez que el panel miró (la primera carga sólo registra lo que había).
export function freshOrderIds(orders, seen) {
  const pending = orders.filter(order => order?.status === 'submitted').map(order => order.id);
  return { pending, fresh: seen ? pending.filter(id => !seen.has(id)) : [] };
}

// ── el día del comercio ──
export function localDayKey(value, timeZone = DEFAULT_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const closedAt = (order, status) => (order.history || []).filter(event => event.status === status)
  .map(event => event.at).sort().pop() || order.updatedAt || order.createdAt;

export const isUnavailableProduct = product => !product?.archived
  && (product?.available === false || (product?.trackStock === true && Number(product?.stock) <= 0));

// Lo que el titular necesita saber de un vistazo. "Vendido hoy" suma lo
// entregado hoy (hora de la localidad): es lo que efectivamente se cobró.
export function panelSummary(orders = [], products = [], { now = new Date(), timeZone = DEFAULT_TIMEZONE } = {}) {
  const today = localDayKey(now, timeZone);
  const isToday = value => localDayKey(value, timeZone) === today;
  const completedToday = orders.filter(order => order.status === 'delivered' && isToday(closedAt(order, 'delivered')));
  const createdToday = orders.filter(order => order.status !== 'canceled' && isToday(order.createdAt));
  return {
    newOrders: orders.filter(order => order.status === 'submitted').length,
    activeOrders: orders.filter(order => isOpenOrder(order) && order.status !== 'submitted').length,
    completedToday: completedToday.length,
    salesToday: completedToday.reduce((sum, order) => sum + (Number(order.total) || 0), 0),
    canceledToday: orders.filter(order => order.status === 'canceled' && isToday(closedAt(order, 'canceled'))).length,
    pickupToday: createdToday.filter(order => order.fulfillment === 'pickup').length,
    deliveryToday: createdToday.filter(order => order.fulfillment === 'delivery').length,
    unavailableProducts: products.filter(isUnavailableProduct).length,
    liveProducts: products.filter(product => !product?.archived).length,
  };
}

// ── abierto o cerrado, y por qué ──
// `open` lo calcula la base (publicado + interruptor + horario). En la
// demostración no hay horario ni interruptor aparte: manda `open`.
export function openState(business, { now = new Date(), timeZone = DEFAULT_TIMEZONE } = {}) {
  const status = business?.status;
  if (status !== 'active') {
    const reason = status === 'paused' ? 'Pausaste el comercio: no aparece en CAUCE.'
      : status === 'suspended' ? 'Administración suspendió el comercio.'
        : 'El comercio todavía no está publicado.';
    return { open: false, label: 'CERRADO', reason, canToggle: false };
  }
  const switchOn = business.acceptingOrders ?? business.open === true;
  if (!switchOn) {
    return { open: false, label: 'CERRADO', reason: 'Cerraste la atención: no se toman pedidos.', canToggle: true, switchOn };
  }
  if (!business.open) {
    const next = nextOpening(business.hours, now, timeZone);
    return { open: false, label: 'CERRADO', canToggle: true, switchOn,
      reason: `Fuera de horario. ${next ? `${next.label}.` : 'Revisá los horarios cargados.'}` };
  }
  const until = closingTime(business.hours, now, timeZone);
  return { open: true, label: 'ABIERTO', canToggle: true, switchOn,
    reason: until ? `Recibiendo pedidos hasta las ${until}.` : 'Recibiendo pedidos.' };
}

// Hora de cierre del turno en curso (con la misma semántica que la base).
export function closingTime(rows, now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const hours = normalizeHours(rows);
  if (!hours.length) return '';
  const { weekday, minutes } = localClock(now, timeZone);
  const yesterday = (weekday + 6) % 7;
  const current = hours.find(range => (range.closes > range.opens
    ? range.weekday === weekday && minutes >= range.opens && minutes < range.closes
    : (range.weekday === weekday && minutes >= range.opens) || (range.weekday === yesterday && minutes < range.closes)));
  return current ? formatTime(current.closes) : '';
}
