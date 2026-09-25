// Panel remoto del comercio: reglas puras de presentación. Qué secciones ve
// cada rol, cómo se agrupan los pedidos por estado, qué acción ofrece cada
// uno y qué resume el día. La base sigue siendo la autoridad (RLS, RPC y
// private.order_transitions): esto sólo decide qué se muestra y qué se ofrece.
import { allowedActions } from './workflow-policy.js';
import { DEFAULT_TIMEZONE, localClock, nextOpening, normalizeHours, formatTime } from './business-hours.js';

// ── secciones ──
// `manage`: titular y encargado/a. `connected`: sólo con el backend real
// (horarios y equipo viven en la base; la demostración no los tiene).
// Primero lo operativo (todo el equipo), después la administración: en el
// teléfono quedan en dos filas, la de uso diario arriba.
export const PANEL_SECTIONS = Object.freeze([
  Object.freeze({ key: 'inicio', label: 'Inicio', manage: false, connected: false }),
  Object.freeze({ key: 'pedidos', label: 'Pedidos', manage: false, connected: false }),
  Object.freeze({ key: 'catalogo', label: 'Catálogo', manage: false, connected: false }),
  // Reparto es operativo para todo el equipo; cargar o pausar a quien reparte
  // (business_riders) sólo lo permite la base a titular y encargado/a.
  Object.freeze({ key: 'reparto', label: 'Reparto', manage: false, connected: false }),
  Object.freeze({ key: 'horarios', label: 'Horarios', manage: true, connected: true }),
  Object.freeze({ key: 'configuracion', label: 'Configuración', manage: true, connected: false }),
  Object.freeze({ key: 'equipo', label: 'Equipo', manage: true, connected: true }),
  // Pagos online: sólo con el interruptor de la plataforma encendido.
  Object.freeze({ key: 'pagos', label: 'Pagos', manage: true, connected: true, payments: true }),
]);
const SECTION_ALIASES = Object.freeze({ datos: 'configuracion', resumen: 'inicio' });

export const canManageBusiness = role => role === 'owner' || role === 'manager';

export function panelSections(role, { connected = false, payments = false } = {}) {
  const manage = canManageBusiness(role);
  return PANEL_SECTIONS.filter(section => (!section.manage || manage) && (!section.connected || connected)
    && (!('payments' in section) || payments));
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

// ── tablero de reparto ──
// Sólo envíos: qué falta asignar, qué está por salir y qué va en camino, y
// cuántos pedidos lleva cada persona de reparto en este momento.
export const DELIVERY_STAGES = Object.freeze([
  Object.freeze({ key: 'para-asignar', label: 'Para asignar', statuses: Object.freeze(['ready']),
    empty: 'Nada listo esperando reparto.' }),
  Object.freeze({ key: 'por-salir', label: 'Asignados, por salir', statuses: Object.freeze(['assigned', 'picked_up']),
    empty: 'Nadie tiene un pedido por salir.' }),
  Object.freeze({ key: 'en-camino', label: 'En camino', statuses: Object.freeze(['on_the_way', 'arrived']),
    empty: 'Nada en camino.' }),
]);
const ON_ROAD = Object.freeze(['assigned', 'picked_up', 'on_the_way', 'arrived']);

/** @param {any[]} orders @param {any[]} riders @param {{ now?: Date, timeZone?: string }} [options] */
export function deliveryBoardData(orders = [], riders = [], { now = new Date(), timeZone = DEFAULT_TIMEZONE } = {}) {
  const delivery = orders.filter(order => order?.fulfillment === 'delivery');
  const today = localDayKey(now, timeZone);
  const load = riders.map(rider => ({ rider,
    count: delivery.filter(order => order.riderId === rider.id && ON_ROAD.includes(order.status)).length }));
  return {
    stages: Object.fromEntries(DELIVERY_STAGES.map(stage => [stage.key,
      delivery.filter(order => stage.statuses.includes(order.status)).sort(byCreated)])),
    preparing: delivery.filter(order => ['submitted', 'accepted', 'preparing'].includes(order.status)).length,
    deliveredToday: delivery.filter(order => order.status === 'delivered'
      && localDayKey(closedAt(order, 'delivered'), timeZone) === today).length,
    // Quien está pausado sólo aparece si todavía lleva algo.
    load: load.filter(entry => entry.rider.active !== false || entry.count > 0),
  };
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
// entregado hoy (hora de la localidad): es lo que efectivamente se cobró. Lo
// aceptado que todavía no se entregó se muestra aparte, como "en curso".
export function panelSummary(orders = [], products = [], { now = new Date(), timeZone = DEFAULT_TIMEZONE } = {}) {
  const today = localDayKey(now, timeZone);
  const isToday = value => localDayKey(value, timeZone) === today;
  const completedToday = orders.filter(order => order.status === 'delivered' && isToday(closedAt(order, 'delivered')));
  const createdToday = orders.filter(order => order.status !== 'canceled' && isToday(order.createdAt));
  const active = orders.filter(order => isOpenOrder(order) && order.status !== 'submitted');
  const salesToday = completedToday.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  return {
    newOrders: orders.filter(order => order.status === 'submitted').length,
    activeOrders: active.length,
    inProgressAmount: active.reduce((sum, order) => sum + (Number(order.total) || 0), 0),
    completedToday: completedToday.length,
    salesToday,
    averageTicket: completedToday.length ? Math.round(salesToday / completedToday.length) : 0,
    canceledToday: orders.filter(order => order.status === 'canceled' && isToday(closedAt(order, 'canceled'))).length,
    pickupToday: createdToday.filter(order => order.fulfillment === 'pickup').length,
    deliveryToday: createdToday.filter(order => order.fulfillment === 'delivery').length,
    unavailableProducts: products.filter(isUnavailableProduct).length,
    liveProducts: products.filter(product => !product?.archived).length,
  };
}

// Más vendidos hoy: unidades en los pedidos de hoy que no se cancelaron
// (incluye lo que está en curso). Producto y variante cuentan por separado.
/** @param {any[]} orders @param {{ now?: Date, timeZone?: string, limit?: number }} [options] */
export function topProducts(orders = [], { now = new Date(), timeZone = DEFAULT_TIMEZONE, limit = 5 } = {}) {
  const today = localDayKey(now, timeZone);
  const totals = new Map();
  for (const order of orders) {
    if (order?.status === 'canceled' || localDayKey(order?.createdAt, timeZone) !== today) continue;
    for (const line of order.lines || []) {
      const key = `${line.productId || line.name}|${line.variantId || ''}`;
      const entry = totals.get(key) || { name: line.name, units: 0, amount: 0 };
      entry.units += Number(line.quantity) || 0;
      entry.amount += Number(line.total) || 0;
      totals.set(key, entry);
    }
  }
  return [...totals.values()].filter(entry => entry.units > 0)
    .sort((a, b) => b.units - a.units || b.amount - a.amount || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// Últimas ventas: lo entregado, de lo más reciente a lo más viejo.
/** @param {any[]} orders @param {{ limit?: number }} [options] */
export function recentSales(orders = [], { limit = 5 } = {}) {
  return orders.filter(order => order?.status === 'delivered')
    .map(order => ({ order, soldAt: closedAt(order, 'delivered') }))
    .sort((a, b) => String(b.soldAt || '').localeCompare(String(a.soldAt || '')))
    .slice(0, limit);
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
