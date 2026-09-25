// Aplicación de reparto: reglas puras y piezas de interfaz. La prueba de
// contrato lee la máquina de estados de las migraciones: la aplicación no puede
// ofrecer un paso que la base rechace ni esconder uno que permite.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import {
  RIDER_STEPS, CODE_STATUSES, RIDER_OPEN_STATUSES, DELIVERY_CODE_ATTEMPTS, riderStep, canConfirmDelivery,
  splitRiderOrders, mapsUrl, deliveryCodeFeedback,
} from '../js/core/rider-app.js';
import { riderCard, riderHome, riderUnlinked } from '../js/ui/rider.js';

async function serverRiderTransitions() {
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
  return rows.filter(row => row.actor === 'rider');
}

const order = (extra = {}) => ({
  id: 'o1', code: 'CA-0107', status: 'assigned', version: 5, locality: 'Aluminé', riderId: 'r1',
  business: { id: 'b1', name: 'Almacén <b>Sur</b>', address: 'San Martín 100', phone: '2942 555000' },
  customer: { name: 'Rosa <img src=x onerror=alert(1)>', phone: '2942 401122', address: 'Los Pehuenes 45 "portón"',
    notes: 'Timbre <script>roto</script>' },
  paymentMethod: 'cash_on_delivery', total: 4800, codeAttemptsLeft: 5,
  lines: [{ name: 'Empanada de carne', quantity: 3 }], createdAt: '2026-09-25T15:00:00Z', updatedAt: '2026-09-25T15:20:00Z',
  ...extra,
});

test('los pasos de quien reparte son exactamente los de la base, y entregar va siempre con código', async () => {
  const rows = await serverRiderTransitions();
  assert.ok(rows.length, 'hay filas de reparto en las migraciones');
  assert.ok(rows.every(row => row.fulfillment === 'delivery'), 'sólo en envíos');
  const steps = rows.filter(row => row.to !== 'delivered').map(row => `${row.from}>${row.to}`).sort();
  assert.deepEqual(steps, Object.entries(RIDER_STEPS).map(([from, step]) => `${from}>${step.status}`).sort());
  assert.deepEqual(rows.filter(row => row.to === 'delivered').map(row => row.from).sort(), [...CODE_STATUSES].sort());
  assert.ok(!rows.some(row => row.to === 'canceled' || row.to === 'assigned'), 'nunca cancela ni se asigna');
  assert.deepEqual(RIDER_OPEN_STATUSES, ['assigned', 'picked_up', 'on_the_way', 'arrived']);
});

test('el paso siguiente sigue el estado y el código aparece desde "en camino"', () => {
  assert.equal(riderStep(order()).status, 'picked_up');
  assert.equal(riderStep(order({ status: 'picked_up' })).label, 'Salí a entregar');
  assert.equal(riderStep(order({ status: 'on_the_way' })).status, 'arrived');
  assert.equal(riderStep(order({ status: 'arrived' })), null);
  assert.equal(riderStep(order({ status: 'delivered' })), null);
  assert.equal(canConfirmDelivery(order()), false);
  assert.equal(canConfirmDelivery(order({ status: 'on_the_way' })), true);
  assert.equal(canConfirmDelivery(order({ status: 'arrived' })), true);
  assert.equal(canConfirmDelivery(order({ status: 'arrived', codeAttemptsLeft: 0 })), false, 'bloqueado: cierra el comercio');
});

test('en curso primero lo más avanzado; el historial, lo último primero', () => {
  const list = [
    order({ id: 'a', status: 'assigned', updatedAt: '2026-09-25T15:00:00Z' }),
    order({ id: 'b', status: 'arrived', updatedAt: '2026-09-25T15:30:00Z' }),
    order({ id: 'c', status: 'delivered', updatedAt: '2026-09-25T14:00:00Z' }),
    order({ id: 'd', status: 'on_the_way', updatedAt: '2026-09-25T15:10:00Z' }),
    order({ id: 'e', status: 'canceled', updatedAt: '2026-09-25T16:00:00Z' }),
    order({ id: 'f', status: 'assigned', updatedAt: '2026-09-25T14:50:00Z' }),
  ];
  const { active, history } = splitRiderOrders(list);
  assert.deepEqual(active.map(item => item.id), ['b', 'd', 'f', 'a']);
  assert.deepEqual(history.map(item => item.id), ['e', 'c']);
  assert.deepEqual(splitRiderOrders(null), { active: [], history: [] });
});

test('el enlace a Maps usa la dirección y la localidad, y no inventa destinos', () => {
  const url = new URL(mapsUrl('Los Pehuenes 45', 'Aluminé'));
  assert.equal(url.origin + url.pathname, 'https://www.google.com/maps/search/');
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('query'), 'Los Pehuenes 45, Aluminé, Argentina');
  assert.equal(new URL(mapsUrl('Conrado Villegas 10, Aluminé', 'Aluminé')).searchParams.get('query'),
    'Conrado Villegas 10, Aluminé, Argentina', 'no repite la localidad');
  assert.equal(new URL(mapsUrl('  Calle   & "Rara"  ', '')).searchParams.get('query'), 'Calle & "Rara", Argentina');
  assert.equal(mapsUrl('', 'Aluminé'), '');
  assert.equal(mapsUrl('  ', 'Aluminé'), '');
});

test('cada respuesta del código se explica a la persona', () => {
  assert.deepEqual(deliveryCodeFeedback({ ok: true }), { ok: true, tone: 'success', message: 'Entrega confirmada. ¡Gracias!' });
  assert.match(deliveryCodeFeedback({ ok: false, reason: 'wrong', remaining: 3 }).message, /Te quedan 3 intentos/);
  assert.match(deliveryCodeFeedback({ ok: false, reason: 'wrong', remaining: 1 }).message, /Te queda 1 intento\./);
  assert.match(deliveryCodeFeedback({ ok: false, reason: 'locked', remaining: 0 }).message, /Avisale al comercio/);
  assert.match(deliveryCodeFeedback({ ok: false, reason: 'format', remaining: 5 }).message, /4 dígitos/);
  assert.equal(deliveryCodeFeedback(null).ok, false);
  assert.equal(DELIVERY_CODE_ATTEMPTS, 5);
});

test('la tarjeta trae destino, contacto, importe y un solo paso, todo escapado', () => {
  const html = riderCard(order());
  for (const text of ['CA-0107', 'Para retirar', 'Los Pehuenes 45 &quot;portón&quot;', 'Abrir en Maps', 'Llamar', 'WhatsApp',
    '3 ×', 'Empanada de carne', 'A cobrar · Efectivo al recibir', '4.800', 'Retiré el pedido', 'Llamar al comercio']) {
    assert.ok(html.includes(text), `falta "${text}"`);
  }
  assert.match(html, /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=Los%20Pehuenes%2045%20%22port%C3%B3n%22%2C%20Alumin%C3%A9%2C%20Argentina"/);
  assert.match(html, /href="tel:2942401122"/);
  assert.match(html, /href="https:\/\/wa\.me\/5492942401122"/);
  assert.match(html, /href="tel:2942555000"/);
  assert.match(html, /data-action="rider-step" data-order="o1"\s+data-version="5" data-next="picked_up"/);
  assert.doesNotMatch(html, /<img src=x|<script>|<b>Sur<\/b>/, 'nada de lo escrito por otros se interpreta');
  assert.doesNotMatch(html, /data-form="rider-deliver"/, 'sin código hasta salir');
  assert.doesNotMatch(html, /delivery_code|Código de entrega: /, 'nunca muestra el código del cliente');
});

test('desde "en camino" se entrega con el código del cliente; bloqueado, se llama al comercio', () => {
  const way = riderCard(order({ status: 'on_the_way', version: 7 }));
  assert.match(way, /data-next="arrived"/);
  assert.match(way, /<form class="rider-code" data-form="rider-deliver" data-order="o1" data-version="7">/);
  assert.match(way, /inputmode="numeric" autocomplete="one-time-code"/);
  const arrived = riderCard(order({ status: 'arrived', codeAttemptsLeft: 2 }));
  assert.doesNotMatch(arrived, /data-action="rider-step"/);
  assert.match(arrived, /Quedan 2 intentos/);
  const locked = riderCard(order({ status: 'arrived', codeAttemptsLeft: 0 }));
  assert.doesNotMatch(locked, /data-form="rider-deliver"/);
  assert.match(locked, /Se agotaron los intentos con código/);
  const feedback = riderCard(order({ status: 'arrived' }), { feedback: { orderId: 'o1', message: 'Código <mal>' } });
  assert.match(feedback, /role="alert">Código &lt;mal&gt;<\/p>/);
  assert.match(riderCard(order(), { online: false }), /data-next="picked_up" disabled>/, 'sin conexión no se envía');
});

test('la pantalla ordena en curso y últimos 7 días, con lo cobrado', () => {
  const html = riderHome({
    orders: [order({ id: 'x', status: 'on_the_way' }), order({ id: 'y', code: 'CA-0100', status: 'delivered', total: 2500 }),
      order({ id: 'z', code: 'CA-0099', status: 'canceled', total: 900 })],
    riders: [{ id: 'r1', active: true, businessName: 'Almacén <b>Sur</b>' }], updatedAt: '2026-09-25T15:30:00Z',
  });
  assert.match(html, /<h1 id="rider-title">Tus entregas<\/h1>/);
  assert.match(html, /Para Almacén &lt;b&gt;Sur&lt;\/b&gt;/);
  assert.match(html, /aria-label="Entregas en curso"/);
  assert.match(html, /Últimos 7 días/);
  assert.match(html, /1 entrega · \$\u00a02\.500 cobrados/);
  assert.ok(html.indexOf('CA-0107') < html.indexOf('CA-0100'), 'lo que está en curso va primero');
  const empty = riderHome({ orders: [], riders: [{ id: 'r1', active: true, businessName: 'A' }] });
  assert.match(empty, /No tenés entregas asignadas/);
  assert.doesNotMatch(empty, /Últimos 7 días/);
});

test('sin vínculo o en pausa, la pantalla dice qué hacer', () => {
  const unlinked = riderUnlinked('ana<x>@cauce.test');
  assert.match(unlinked, /Reparto → Vincular cuenta/);
  assert.match(unlinked, /ana&lt;x&gt;@cauce\.test/);
  assert.match(riderUnlinked('', { paused: true }), /Tu reparto está en pausa/);
});
