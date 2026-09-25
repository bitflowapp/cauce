// Panel remoto del comercio: reglas puras. La prueba de contrato lee la
// máquina de estados de las migraciones: el panel no puede ofrecer un cambio
// que la base rechace, ni esconder uno que la base permite.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import {
  panelSections, resolveSection, groupOrders, orderGroupOf, merchantOrderActions, orderActionLabel,
  deliveryStage, freshOrderIds, localDayKey, panelSummary, openState, closingTime, isUnavailableProduct,
  deliveryBoardData, topProducts, recentSales, ORDER_GROUPS, canManageBusiness,
} from '../js/core/business-panel.js';

const BUSINESS = 'b1';
const LOCALITY = 'alumine';
const scope = { businessId: BUSINESS, localityId: LOCALITY, connected: true };
const order = (status, extra = {}) => ({ id: `o-${status}`, status, fulfillment: 'delivery', businessId: BUSINESS,
  localityId: LOCALITY, riderId: null, createdAt: '2026-09-24T15:00:00.000Z', total: 1000, history: [], ...extra });

async function serverMerchantTransitions() {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const rows = [];
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, dir), 'utf8');
    for (const block of sql.matchAll(/insert into private\.order_transitions[^;]*;/g)) {
      for (const tuple of block[0].matchAll(/\('(\w+)', '(\w+)', '(\w+)', (null|'\w+')\)/g)) {
        rows.push({ from: tuple[1], to: tuple[2], actor: tuple[3], fulfillment: tuple[4] === 'null' ? null : tuple[4].slice(1, -1) });
      }
    }
  }
  return rows.filter(row => row.actor === 'merchant');
}

test('cada rol ve sus secciones; staff opera pedidos, catálogo y reparto', () => {
  const keys = (role, connected) => panelSections(role, { connected }).map(section => section.key);
  const all = ['inicio', 'pedidos', 'catalogo', 'horarios', 'configuracion', 'reparto', 'equipo'];
  assert.deepEqual(keys('owner', true), all);
  assert.deepEqual(keys('manager', true), all);
  assert.deepEqual(keys('staff', true), ['inicio', 'pedidos', 'catalogo', 'reparto']);
  // En la demostración no hay horarios ni equipo en la base.
  assert.deepEqual(keys('owner', false), ['inicio', 'pedidos', 'catalogo', 'configuracion', 'reparto']);
  assert.equal(canManageBusiness('staff'), false);
  assert.equal(canManageBusiness('manager'), true);
});

test('una sección pedida por URL que el rol no ve cae en Inicio', () => {
  const staff = panelSections('staff', { connected: true });
  const owner = panelSections('owner', { connected: true });
  assert.equal(resolveSection('equipo', staff), 'inicio');
  assert.equal(resolveSection('configuracion', staff), 'inicio');
  assert.equal(resolveSection('datos', owner), 'configuracion', 'los enlaces viejos a "datos" siguen andando');
  assert.equal(resolveSection('cualquiera', owner), 'inicio');
  assert.equal(resolveSection(null, owner), 'inicio');
  assert.equal(resolveSection('pedidos', staff), 'pedidos');
});

test('los grupos siguen los estados reales y cubren todos', () => {
  const statuses = ['submitted', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up', 'on_the_way', 'arrived', 'delivered', 'canceled'];
  assert.deepEqual(statuses.map(orderGroupOf),
    ['nuevos', 'aceptados', 'preparando', 'listos', 'reparto', 'reparto', 'reparto', 'reparto', 'completados', 'cancelados']);
  assert.equal(orderGroupOf('draft'), null, 'un borrador nunca llega al panel');
  assert.equal(ORDER_GROUPS.filter(group => group.active).length, 5);
});

test('lo abierto se atiende por orden de llegada; lo cerrado, lo último primero', () => {
  const orders = [
    order('submitted', { id: 'n2', createdAt: '2026-09-24T15:10:00Z' }),
    order('submitted', { id: 'n1', createdAt: '2026-09-24T15:00:00Z' }),
    order('delivered', { id: 'd1', createdAt: '2026-09-24T12:00:00Z' }),
    order('delivered', { id: 'd2', createdAt: '2026-09-24T13:00:00Z' }),
    order('on_the_way', { id: 'r1' }),
  ];
  const groups = groupOrders(orders);
  assert.deepEqual(groups.nuevos.map(item => item.id), ['n1', 'n2']);
  assert.deepEqual(groups.completados.map(item => item.id), ['d2', 'd1']);
  assert.deepEqual(groups.reparto.map(item => item.id), ['r1']);
  assert.deepEqual(groups.aceptados, []);
});

test('contrato: el panel ofrece exactamente las transiciones que la base permite al comercio', async () => {
  const server = await serverMerchantTransitions();
  assert.ok(server.length >= 18, 'se leyeron las transiciones de las migraciones');
  const allowed = (from, to, fulfillment) => server.some(row => row.from === from && row.to === to
    && (row.fulfillment === null || row.fulfillment === fulfillment));
  for (const fulfillment of ['pickup', 'delivery']) {
    for (const status of ['submitted', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up', 'on_the_way', 'arrived']) {
      if (fulfillment === 'pickup' && ['assigned', 'picked_up', 'on_the_way', 'arrived'].includes(status)) continue;
      const current = order(status, { fulfillment, riderId: ['assigned', 'picked_up', 'on_the_way', 'arrived'].includes(status) ? 'r1' : null });
      const { forward, cancel } = merchantOrderActions(current, scope);
      for (const action of forward) {
        assert.ok(allowed(status, action, fulfillment), `el panel ofrece ${status} → ${action} (${fulfillment}) y la base lo rechazaría`);
      }
      if (cancel) assert.ok(allowed(status, 'canceled', fulfillment), `cancelar desde ${status} (${fulfillment})`);
      const offered = new Set([...forward, ...(cancel ? ['canceled'] : [])]);
      for (const row of server.filter(item => item.from === status && (item.fulfillment === null || item.fulfillment === fulfillment))) {
        assert.ok(offered.has(row.to), `la base permite ${status} → ${row.to} (${fulfillment}) y el panel no lo ofrece`);
      }
    }
  }
});

test('pedidos cerrados o de otro comercio no ofrecen acciones', () => {
  assert.deepEqual(merchantOrderActions(order('delivered'), scope), { forward: [], cancel: false });
  assert.deepEqual(merchantOrderActions(order('canceled'), scope), { forward: [], cancel: false });
  const foreign = order('submitted', { businessId: 'otro' });
  assert.deepEqual(merchantOrderActions(foreign, scope), { forward: [], cancel: false });
  // Sin backend real no se ofrece cerrar un envío que ya salió (la demo no lo tiene).
  assert.equal(merchantOrderActions(order('on_the_way', { riderId: 'r1' }), { ...scope, connected: false }).cancel, false);
});

test('los botones dicen lo que pasa, según la modalidad', () => {
  assert.equal(orderActionLabel(order('submitted'), 'canceled'), 'Rechazar');
  assert.equal(orderActionLabel(order('preparing'), 'canceled'), 'Cancelar');
  assert.equal(orderActionLabel(order('accepted'), 'preparing'), 'Empezar a preparar');
  assert.equal(orderActionLabel(order('preparing', { fulfillment: 'pickup' }), 'ready'), 'Listo para retirar');
  assert.equal(orderActionLabel(order('preparing'), 'ready'), 'Listo para enviar');
  assert.equal(orderActionLabel(order('ready', { fulfillment: 'pickup' }), 'delivered'), 'Marcar retirado');
  assert.equal(orderActionLabel(order('on_the_way'), 'delivered'), 'Marcar entregado');
  assert.equal(orderActionLabel(order('picked_up'), 'on_the_way'), 'Salió a entregar');
});

test('la entrega se describe en palabras del comercio', () => {
  assert.equal(deliveryStage(order('ready')), 'Listo: falta asignar quién lo lleva.');
  assert.equal(deliveryStage(order('assigned'), 'Juan'), 'Asignado a Juan: falta que lo retire.');
  assert.equal(deliveryStage(order('on_the_way'), 'Juan'), 'En camino con Juan.');
  assert.equal(deliveryStage(order('ready', { fulfillment: 'pickup' })), '', 'un retiro no tiene entrega');
});

test('reparto: sólo envíos, por etapa, y quién lleva qué', () => {
  const now = new Date('2026-09-24T20:00:00Z');
  const riders = [{ id: 'r1', name: 'Juan', active: true }, { id: 'r2', name: 'Ana', active: true },
    { id: 'r3', name: 'Pausado libre', active: false }, { id: 'r4', name: 'Pausado con pedido', active: false }];
  const orders = [
    order('ready', { id: 'listo-2', createdAt: '2026-09-24T19:10:00Z' }),
    order('ready', { id: 'listo-1', createdAt: '2026-09-24T19:00:00Z' }),
    order('ready', { id: 'retiro', fulfillment: 'pickup' }),
    order('assigned', { id: 'asig', riderId: 'r1' }),
    order('picked_up', { id: 'retirado', riderId: 'r1' }),
    order('on_the_way', { id: 'camino', riderId: 'r4' }),
    order('arrived', { id: 'llego', riderId: 'r2' }),
    order('preparing', { id: 'prep' }),
    order('submitted', { id: 'nuevo' }),
    order('delivered', { id: 'entregado', riderId: 'r1', history: [{ status: 'delivered', at: '2026-09-24T18:00:00Z' }] }),
  ];
  const data = deliveryBoardData(orders, riders, { now });
  assert.deepEqual(data.stages['para-asignar'].map(item => item.id), ['listo-1', 'listo-2'], 'el retiro no es reparto; el más viejo primero');
  assert.deepEqual(data.stages['por-salir'].map(item => item.id), ['asig', 'retirado']);
  assert.deepEqual(data.stages['en-camino'].map(item => item.id).sort(), ['camino', 'llego']);
  assert.equal(data.preparing, 2);
  assert.equal(data.deliveredToday, 1);
  assert.deepEqual(data.load.map(entry => [entry.rider.name, entry.count]),
    [['Juan', 2], ['Ana', 1], ['Pausado con pedido', 1]], 'lo entregado no cuenta; quien está pausado sin pedidos no aparece');
});

test('un pedido nuevo es "fresco" sólo si apareció desde la última mirada', () => {
  const orders = [order('submitted', { id: 'a' }), order('submitted', { id: 'b' }), order('accepted', { id: 'c' })];
  assert.deepEqual(freshOrderIds(orders, undefined), { pending: ['a', 'b'], fresh: [] }, 'la primera carga no suena');
  assert.deepEqual(freshOrderIds(orders, new Set(['a'])).fresh, ['b']);
  assert.deepEqual(freshOrderIds(orders, new Set(['a', 'b'])).fresh, []);
});

test('"hoy" es el día de Aluminé, no el de UTC', () => {
  assert.equal(localDayKey('2026-09-25T02:30:00Z'), '2026-09-24');
  assert.equal(localDayKey('2026-09-25T03:30:00Z'), '2026-09-25');
  assert.equal(localDayKey('no es fecha'), '');
});

test('el resumen del día cuenta lo accionable y suma lo cobrado hoy', () => {
  const now = new Date('2026-09-24T20:00:00Z'); // 17:00 en Aluminé
  const orders = [
    order('submitted', { fulfillment: 'pickup', createdAt: '2026-09-24T19:50:00Z' }),
    order('preparing', { createdAt: '2026-09-24T19:00:00Z' }),
    order('on_the_way', { createdAt: '2026-09-24T18:00:00Z' }),
    order('delivered', { total: 5900, createdAt: '2026-09-24T15:00:00Z',
      history: [{ status: 'submitted', at: '2026-09-24T15:00:00Z' }, { status: 'delivered', at: '2026-09-24T16:00:00Z' }] }),
    order('delivered', { fulfillment: 'pickup', total: 3600, createdAt: '2026-09-24T14:00:00Z', updatedAt: '2026-09-24T14:40:00Z' }),
    // Entregado ayer a la noche (antes de la medianoche de Aluminé): no suma hoy.
    order('delivered', { total: 99999, createdAt: '2026-09-24T01:00:00Z',
      history: [{ status: 'delivered', at: '2026-09-24T02:00:00Z' }] }),
    order('canceled', { createdAt: '2026-09-24T17:00:00Z', updatedAt: '2026-09-24T17:05:00Z' }),
  ];
  const products = [
    { id: 'p1', available: true, archived: false, trackStock: false, stock: 0 },
    { id: 'p2', available: false, archived: false },
    { id: 'p3', available: true, archived: false, trackStock: true, stock: 0 },
    { id: 'p4', available: false, archived: true },
  ];
  assert.deepEqual(panelSummary(orders, products, { now }), {
    newOrders: 1, activeOrders: 2, inProgressAmount: 2000, completedToday: 2, salesToday: 9500, averageTicket: 4750,
    canceledToday: 1, pickupToday: 2, deliveryToday: 3, unavailableProducts: 2, liveProducts: 3,
  });
  assert.equal(panelSummary([], products, { now }).averageTicket, 0, 'sin ventas no hay ticket promedio');
  assert.equal(isUnavailableProduct(products[0]), false, 'sin control de stock, stock 0 no es agotado');
  assert.equal(isUnavailableProduct(products[3]), false, 'lo dado de baja no cuenta como agotado');
});

test('más vendidos hoy: unidades de los pedidos de hoy, sin cancelados, producto y variante aparte', () => {
  const now = new Date('2026-09-24T20:00:00Z');
  const line = (productId, name, quantity, total, variantId = null) => ({ productId, variantId, name, quantity, total });
  const orders = [
    order('delivered', { createdAt: '2026-09-24T15:00:00Z', lines: [line('p1', 'Empanada', 6, 7200), line('p2', 'Pizza · Grande', 1, 9500, 'v2')] }),
    order('preparing', { createdAt: '2026-09-24T19:00:00Z', lines: [line('p1', 'Empanada', 3, 3600), line('p2', 'Pizza · Chica', 2, 12000, 'v1')] }),
    order('canceled', { createdAt: '2026-09-24T19:30:00Z', lines: [line('p3', 'Torta', 50, 50000)] }),
    order('delivered', { createdAt: '2026-09-23T15:00:00Z', lines: [line('p3', 'Torta', 40, 40000)] }),
  ];
  assert.deepEqual(topProducts(orders, { now }), [
    { name: 'Empanada', units: 9, amount: 10800 },
    { name: 'Pizza · Chica', units: 2, amount: 12000 },
    { name: 'Pizza · Grande', units: 1, amount: 9500 },
  ]);
  assert.equal(topProducts(orders, { now, limit: 1 }).length, 1);
  assert.deepEqual(topProducts([], { now }), []);
});

test('últimas ventas: lo entregado, lo más reciente primero', () => {
  const orders = [
    order('delivered', { id: 'vieja', history: [{ status: 'delivered', at: '2026-09-24T12:00:00Z' }] }),
    order('delivered', { id: 'nueva', history: [{ status: 'delivered', at: '2026-09-24T18:00:00Z' }] }),
    order('on_the_way', { id: 'en-camino' }),
    order('canceled', { id: 'cancelada' }),
  ];
  assert.deepEqual(recentSales(orders).map(item => [item.order.id, item.soldAt]),
    [['nueva', '2026-09-24T18:00:00Z'], ['vieja', '2026-09-24T12:00:00Z']]);
  assert.equal(recentSales(orders, { limit: 1 }).length, 1);
});

test('ABIERTO o CERRADO, y por qué', () => {
  const now = new Date('2026-09-24T14:00:00Z'); // jueves 11:00 en Aluminé
  const hours = [{ weekday: 4, opens: '09:00:00', closes: '13:00:00' }, { weekday: 4, opens: '17:00:00', closes: '21:00:00' }];
  const base = { status: 'active', acceptingOrders: true, open: true, hours };
  assert.deepEqual(openState(base, { now }), { open: true, label: 'ABIERTO', canToggle: true, switchOn: true,
    reason: 'Recibiendo pedidos hasta las 13:00.' });
  const off = openState({ ...base, acceptingOrders: false, open: false }, { now });
  assert.equal(off.label, 'CERRADO');
  assert.match(off.reason, /Cerraste la atención/);
  const outside = openState({ ...base, open: false }, { now: new Date('2026-09-24T17:00:00Z') });
  assert.equal(outside.label, 'CERRADO');
  assert.match(outside.reason, /Fuera de horario\. Abre hoy a las 17:00\./);
  assert.match(openState({ ...base, status: 'draft' }).reason, /no está publicado/);
  assert.match(openState({ ...base, status: 'paused' }).reason, /Pausaste/);
  assert.equal(openState({ ...base, status: 'suspended' }).canToggle, false);
  // Demostración: sin interruptor aparte, manda `open`.
  assert.equal(openState({ status: 'active', open: true }, { now }).label, 'ABIERTO');
});

test('el cierre del turno respeta los turnos que cruzan la medianoche', () => {
  const hours = [{ weekday: 5, opens: '20:00:00', closes: '01:00:00' }];
  assert.equal(closingTime(hours, new Date('2026-09-26T00:30:00Z')), '01:00', 'viernes 21:30');
  assert.equal(closingTime(hours, new Date('2026-09-26T03:30:00Z')), '01:00', 'sábado 00:30, turno del viernes');
  assert.equal(closingTime(hours, new Date('2026-09-26T05:00:00Z')), '', 'sábado 02:00, cerrado');
  assert.equal(closingTime([], new Date()), '');
});
