// Panel remoto del comercio: piezas de interfaz. Lo que el comercio necesita
// ver en cada tarjeta, con lo escrito por el cliente siempre escapado.
import assert from 'node:assert/strict';
import test from 'node:test';
import { orderCard, ordersBoard, dashboard, newOrdersBanner, panelNav, deliveryBoard, syncBar, openBar } from '../js/ui/business-panel.js';
import { soundMuted, setSoundMuted, soundReady } from '../js/ui/order-alert.js';
import { hoursEditor, hoursFromEntries, allDaysClosed } from '../js/ui/merchant-tools.js';
import { panelSections, deliveryBoardData } from '../js/core/business-panel.js';

const context = { businessId: 'b1', localityId: 'alumine', connected: true, canManage: true, online: true,
  riders: [{ id: 'r1', name: 'Juan', active: true }, { id: 'r2', name: 'Inactiva', active: false }], fresh: [],
  now: Date.parse('2026-09-24T15:10:00Z') };
const order = (extra = {}) => ({
  id: 'o1', code: 'CA-0042', businessId: 'b1', localityId: 'alumine', status: 'ready', fulfillment: 'delivery',
  paymentMethod: 'cash_on_delivery', version: 3, riderId: null, createdAt: '2026-09-24T15:00:00Z',
  customer: { name: 'Rosa <img src=x onerror=alert(1)>', phone: '2942 401122', address: 'Los Pehuenes 45 "portón"',
    notes: 'Sin <b>sal</b>' },
  lines: [{ name: 'Empanada de carne', quantity: 2, total: 2400 }, { name: 'Pizza · Grande', quantity: 1, total: 9500 }],
  subtotal: 11900, deliveryFee: 1500, total: 13400, deliveryCode: { code: '1234' }, history: [], ...extra,
});

test('la tarjeta muestra todo lo que el comercio necesita para atender', () => {
  const html = orderCard(order(), context);
  for (const text of ['CA-0042', 'hace 10 min', 'Envío', 'Efectivo', '2 ×', 'Empanada de carne', '1 ×', 'Pizza · Grande',
    'Total', '13.400', 'incluye envío', 'Listo: falta asignar quién lo lleva.', '12 34']) {
    assert.ok(html.includes(text), `falta "${text}"`);
  }
  assert.match(html, /href="tel:2942401122"/);
  assert.match(html, /href="https:\/\/wa\.me\/5492942401122"/);
  assert.match(html, /aria-label="Entrega del pedido CA-0042"/);
  // Asignar reparto: sólo con quienes están activos.
  assert.match(html, /data-form="assign-rider"/);
  assert.ok(html.includes('>Juan<') && !html.includes('Inactiva'), 'sólo el reparto activo');
  assert.match(html, /data-next="canceled"[^>]*data-reason="required"/);
});

test('lo que escribe el cliente nunca se interpreta como HTML', () => {
  const html = orderCard(order(), context);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<b>sal</b>'), false);
  assert.ok(html.includes('Rosa &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('Los Pehuenes 45 &quot;portón&quot;'));
});

test('un pedido nuevo de retiro: aceptar o rechazar, sin sección de entrega', () => {
  const html = orderCard(order({ status: 'submitted', fulfillment: 'pickup', deliveryFee: 0, total: 11900, deliveryCode: null }), context);
  assert.match(html, /data-next="accepted"[^>]*>Aceptar</);
  assert.match(html, />Rechazar</);
  assert.match(html, /class="order-panel-card is-new/);
  assert.equal(html.includes('Entrega del pedido'), false);
  assert.ok(html.includes('Retiro'));
});

test('sin conexión los botones quedan deshabilitados; sin reparto cargado se explica', () => {
  const offline = orderCard(order({ status: 'accepted' }), { ...context, online: false });
  assert.match(offline, /data-next="preparing" disabled>Empezar a preparar</);
  const staff = orderCard(order(), { ...context, canManage: false, riders: [] });
  assert.ok(staff.includes('pedíselo a quien administra el comercio'));
  const owner = orderCard(order(), { ...context, riders: [] });
  assert.match(owner, /data-tab="reparto">Cargar quién reparte</);
});

test('el tablero muestra primero lo nuevo y los contadores de cada estado', () => {
  const orders = [order({ id: 'a', status: 'preparing' }), order({ id: 'b', status: 'delivered' })];
  const html = ordersBoard(orders, context, { filter: 'activos' });
  assert.ok(html.includes('Todavía no tenés pedidos nuevos.'), 'Nuevos se muestra aunque esté vacío');
  assert.ok(html.indexOf('grupo-nuevos') < html.indexOf('grupo-preparando'));
  assert.equal(html.includes('grupo-completados'), false, 'lo cerrado no ocupa lugar en activos');
  assert.match(html, /data-filter="activos" aria-pressed="true">\s*Activos <span class="filter-chip-count">1</);
  assert.match(html, /data-filter="completados" aria-pressed="false">\s*Completados <span class="filter-chip-count">1</);
  const closed = ordersBoard(orders, context, { filter: 'completados' });
  assert.ok(closed.includes('grupo-completados') && !closed.includes('grupo-preparando'));
});

test('el inicio: lo vendido hoy, números accionables, más vendidos, últimas ventas y sin disponibilidad', () => {
  const summary = { newOrders: 2, activeOrders: 3, inProgressAmount: 8200, completedToday: 4, salesToday: 15000,
    averageTicket: 3750, canceledToday: 0, pickupToday: 5, deliveryToday: 1, unavailableProducts: 1, liveProducts: 12 };
  const html = dashboard({ id: 'b1', status: 'active' }, summary, { newOrders: [], context,
    unavailable: [{ id: 'p1', name: 'Torta', available: false }],
    top: [{ name: 'Empanada <b>', units: 9, amount: 10800 }],
    sales: [{ order: order({ status: 'delivered', code: 'CA-0099', total: 3600, fulfillment: 'pickup' }), soldAt: '2026-09-24T15:05:00Z' }] });
  for (const text of ['Vendido hoy', '15.000', '+ $\u00a08.200 en curso', 'Pedidos nuevos', 'Pedidos activos', 'Completados hoy',
    'Ticket promedio', '3.750', 'Retiro · Envío', '5 · 1', 'Sin disponibilidad', 'de 12 productos',
    'Más vendidos hoy', '9 u.', '10.800', 'Últimas ventas', 'CA-0099', 'hace 5 min']) {
    assert.ok(html.includes(text), `falta "${text}"`);
  }
  assert.ok(html.includes('Empanada &lt;b&gt;'), 'el nombre del producto se escapa');
  assert.match(html, /class="metric is-alert" href="#panel\/b1\/pedidos"/);
  assert.match(html, /data-product="p1" data-field="available" data-value="true">Marcar disponible</);
  assert.match(html, /data-action="show-orders"[^>]*data-filter="completados"/);
  // Sin pedidos esperando, primero los números; con pedidos, primero atenderlos.
  assert.ok(html.indexOf('Vendido hoy') < html.indexOf('Esperan respuesta'));
  const busy = dashboard({ id: 'b1', status: 'active' }, summary, { newOrders: [order({ status: 'submitted' })], context });
  assert.ok(busy.indexOf('Esperan respuesta') < busy.indexOf('Vendido hoy'));
  // Sin ventas: guion en el ticket y textos de vacío.
  const empty = dashboard({ id: 'b1', status: 'active' }, { ...summary, completedToday: 0, averageTicket: 0 }, { context });
  assert.match(empty, /Ticket promedio<\/span><strong class="metric-value">—/);
  assert.ok(empty.includes('Todavía no hay ventas hoy.') && empty.includes('Todavía no hay ventas entregadas.'));
});

test('abierto o cerrado, y pausar o reactivar, sólo para quien administra', () => {
  const open = { open: true, label: 'ABIERTO', reason: 'Recibiendo pedidos.', canToggle: true, switchOn: true };
  const owner = openBar({ id: 'b1', status: 'active' }, open, { canManage: true });
  assert.match(owner, /data-action="toggle-open"[^>]*data-open="false"[\s\S]*Cerrar atención/);
  assert.match(owner, /data-action="business-status"[^>]*data-status="paused"[^>]*>Pausar el comercio</);
  const paused = openBar({ id: 'b1', status: 'paused' },
    { open: false, label: 'CERRADO', reason: 'Pausaste el comercio.', canToggle: false }, { canManage: true });
  assert.match(paused, /data-status="active"[^>]*>Reactivar el comercio</);
  assert.equal(/toggle-open/.test(paused), false);
  assert.equal(/data-action=/.test(openBar({ id: 'b1', status: 'active' }, open, { canManage: false })), false, 'el equipo sólo ve el estado');
  assert.match(openBar({ id: 'b1', status: 'active' }, open, { canManage: true, online: false }), /toggle-open[^>]*disabled/);
});

test('navegación por secciones y aviso de pedidos nuevos', () => {
  const nav = panelNav('b1', panelSections('staff', { connected: true }), 'pedidos', { newCount: 2 });
  assert.match(nav, /data-tab="pedidos">Pedidos <span class="tab-badge"/);
  assert.equal(nav.includes('data-tab="configuracion"'), false, 'staff no ve configuración');
  const owner = panelNav('b1', panelSections('owner', { connected: true }), 'inicio');
  assert.deepEqual([...owner.matchAll(/data-tab="(\w+)"/g)].map(match => match[1]),
    ['inicio', 'pedidos', 'catalogo', 'reparto', 'horarios', 'configuracion', 'equipo'], 'lo operativo primero');
  assert.equal([...owner.matchAll(/class="tab[^"]*is-admin/g)].length, 3, 'horarios, configuración y equipo van en la fila de administración');
  assert.equal(newOrdersBanner('b1', 0), '');
  assert.match(newOrdersBanner('b1', 3), /href="#panel\/b1\/pedidos"[\s\S]*3 pedidos nuevos/);
});

test('horarios: cerrado por día y todos los turnos que ya había', () => {
  const business = { id: 'b1', hours: [
    { weekday: 1, opens: '08:00:00', closes: '10:00:00' }, { weekday: 1, opens: '12:00:00', closes: '14:00:00' },
    { weekday: 1, opens: '18:00:00', closes: '22:00:00' }, { weekday: 2, opens: '09:00:00', closes: '13:00:00' },
  ] };
  const html = hoursEditor(business);
  assert.ok(html.includes('name="d1-2-opens" value="18:00"'), 'el tercer turno del lunes se ve (y no se pierde al guardar)');
  assert.ok(html.includes('name="d2-2-opens"'), 'todos los días tienen tantos lugares como el que más turnos tiene');
  const twoSlots = hoursEditor({ id: 'b1', hours: [{ weekday: 1, opens: '09:00:00', closes: '13:00:00' }] });
  assert.ok(twoSlots.includes('name="d6-1-opens"') && !twoSlots.includes('-2-opens"'), 'sin terceros turnos, dos lugares por día');
  assert.match(html, /name="d0-closed" checked/, 'con horarios cargados, el domingo sin turnos está cerrado');
  assert.equal(/name="d1-closed" checked/.test(html), false);
  assert.ok(html.includes('Así lo ve el cliente'));
  assert.equal(/name="d\d-closed" checked/.test(hoursEditor({ id: 'b1', hours: [] })), false, 'sin horarios, nada marcado cerrado');

  const form = new Map(Object.entries({ 'd1-0-opens': '09:00', 'd1-0-closes': '13:00', 'd1-2-opens': '18:00', 'd1-2-closes': '22:00',
    'd2-closed': 'on', 'd2-0-opens': '09:00', 'd2-0-closes': '13:00' }));
  assert.deepEqual(hoursFromEntries(name => form.get(name)), [
    { weekday: 1, opens: '09:00', closes: '13:00' }, { weekday: 1, opens: '18:00', closes: '22:00' },
  ], 'un día cerrado no aporta turnos aunque tenga horas escritas');
});

test('horarios: los siete días cerrados no se guardan como "sin horario"', () => {
  const week = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [`d${day}-closed`, 'on']));
  assert.equal(allDaysClosed(name => week[name]), true);
  delete week['d3-closed'];
  assert.equal(allDaysClosed(name => week[name]), false);
});

test('reparto: tablero de envíos, quién lleva qué y la elección que no se pierde', () => {
  const orders = [order(), order({ id: 'o2', code: 'CA-0043', status: 'on_the_way', riderId: 'r1' }),
    order({ id: 'o3', code: 'CA-0044', status: 'ready', fulfillment: 'pickup' })];
  const riders = [...context.riders, { id: 'r3', name: 'Beto', active: true, phone: '2942 555111' }];
  const html = deliveryBoard(deliveryBoardData(orders, riders, { now: new Date(context.now) }), { ...context, riders });
  assert.ok(html.includes('aria-label="Pedido CA-0042"') && html.includes('aria-label="Pedido CA-0043"'));
  assert.equal(html.includes('CA-0044'), false, 'un retiro no aparece en reparto');
  assert.match(html, /<strong>Juan<\/strong> · 1 pedido en curso/);
  assert.match(html, /<strong>Beto<\/strong> · sin pedidos[\s\S]*href="tel:2942555111"/);
  assert.equal(html.includes('Inactiva'), false);
  assert.ok(html.includes('Nadie tiene un pedido por salir.'));
  assert.ok(deliveryBoard(deliveryBoardData([], []), context, { deliveryEnabled: false }).includes('no ofrece envío'));

  // Una persona elegida y todavía sin confirmar sigue elegida tras un refresco.
  const chosen = orderCard(order(), { ...context, riders, riderChoice: new Map([['o1', 'r3']]) });
  assert.match(chosen, /<option value="r3" selected>Beto</);
  assert.equal(/<option value="r1" selected>/.test(chosen), false);
  assert.match(orderCard(order(), { ...context, online: false }), /type="submit" disabled>Asignar reparto</);
});

test('sonido de pedidos: opcional, se silencia y se vuelve a activar', () => {
  assert.match(syncBar({ soundOn: false }), /data-action="enable-sound"[\s\S]*Activar sonido de pedidos/);
  assert.match(syncBar({ soundOn: true }), /data-action="mute-sound"[\s\S]*Silenciar/);
  assert.match(syncBar({ soundOn: false, muted: true }), /data-action="enable-sound"[\s\S]*Sonido silenciado · Activar/);
  assert.match(syncBar({ liveHealthy: false }), /Reconectando: revisamos cada 30 segundos/);
  setSoundMuted(true);
  assert.equal(soundMuted(), true);
  assert.equal(soundReady(), false, 'silenciado nunca suena');
  setSoundMuted(false);
  assert.equal(soundMuted(), false);
});
