// Métricas del piloto (administración): normalización y piezas de interfaz.
// Lo que escribió un comercio (su nombre) siempre escapado; nada del cliente.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mapPilotMetrics, durationText, STUCK_REASONS } from '../js/core/pilot-metrics.js';
import { pilotToday, pilotIncidents, businessTodayLine } from '../js/ui/admin-metrics.js';

const raw = {
  generated_at: '2026-09-25T18:30:00Z', day_start: '2026-09-25T03:00:00Z', timezone: 'America/Argentina/Buenos_Aires',
  businesses: { active: 7, paused: 1, suspended: 1, pending_review: 2, open_now: 5 },
  today: { orders: 23, pickup: 15, delivery: 8, in_progress: 4, delivered: 17, canceled: 2, gross_ars: 214500, average_ticket_ars: 12618 },
  per_business: [{ id: 'b1', name: 'Almacén <b>Sur</b>', status: 'active', open_now: true, orders: 9, delivered: 8, gross_ars: 98000 }],
  stuck: [{ id: 'o1', code: 'CA-0107', status: 'submitted', fulfillment: 'pickup', business_id: 'b1',
    business: 'Almacén <b>Sur</b>', phone: '2942 555000', minutes: 22 },
  { id: 'o2', code: 'CA-0099', status: 'on_the_way', fulfillment: 'delivery', business_id: 'b2', business: 'Otro', phone: '', minutes: 135 }],
  errors_24h: { total: 3, critical: 1 },
};

test('normaliza lo que devuelve la base, con ceros donde falta', () => {
  const m = mapPilotMetrics(raw);
  assert.deepEqual(m.businesses, { active: 7, paused: 1, suspended: 1, pendingReview: 2, openNow: 5 });
  assert.deepEqual(m.today, { orders: 23, pickup: 15, delivery: 8, inProgress: 4, delivered: 17, canceled: 2,
    gross: 214500, averageTicket: 12618 });
  assert.equal(m.stuck[0].reason, STUCK_REASONS.submitted);
  assert.equal(m.stuck[1].reason, 'En camino hace mucho');
  assert.deepEqual(m.errors, { total: 3, critical: 1 });
  const empty = mapPilotMetrics({});
  assert.deepEqual(empty.today, { orders: 0, pickup: 0, delivery: 0, inProgress: 0, delivered: 0, canceled: 0, gross: 0, averageTicket: 0 });
  assert.deepEqual([empty.perBusiness, empty.stuck], [[], []]);
});

test('los minutos se leen como tiempo', () => {
  assert.equal(durationText(22), '22 min');
  assert.equal(durationText(60), '1 h');
  assert.equal(durationText(135), '2 h 15 min');
  assert.equal(durationText(60 * 50), '2 d');
  assert.equal(durationText(-4), '0 min');
});

test('"Hoy en CAUCE" trae los números del día y explica qué es cada uno', () => {
  const html = pilotToday(mapPilotMetrics(raw));
  for (const text of ['Hoy en CAUCE', 'Comercios activos', '5 abiertos ahora', 'Pedidos hoy', '15 retiro · 8 envío',
    'Completados hoy', '2 cancelados', 'Volumen bruto hoy', '214.500', 'ticket', '12.618', 'En curso ahora',
    'Errores 24 h', '1 críticos', 'America/Argentina/Buenos_Aires', 'con envío incluido']) {
    assert.ok(html.includes(text), `falta "${text}"`);
  }
});

test('lo que necesita atención se puede resolver con una llamada, sin datos del cliente', () => {
  const html = pilotIncidents(mapPilotMetrics(raw).stuck);
  assert.match(html, /Necesitan atención \(2\)/);
  assert.match(html, /<strong>CA-0107<\/strong> · Almacén &lt;b&gt;Sur&lt;\/b&gt;/);
  assert.match(html, /Sin respuesta del comercio · hace 22 min/);
  assert.match(html, /href="tel:2942555000"/);
  assert.match(html, /En camino hace mucho · hace 2 h 15 min/);
  assert.equal((html.match(/Llamar al comercio/g) || []).length, 1, 'sin teléfono no hay botón');
  assert.doesNotMatch(html, /<b>Sur<\/b>/);
  assert.match(pilotIncidents([]), /Ningún pedido lleva demasiado tiempo sin moverse/);
  const capped = pilotIncidents(mapPilotMetrics(raw).stuck, 27);
  assert.match(capped, /Necesitan atención \(27\)/);
  assert.match(capped, /Se muestran los 2 que más esperan\./);
  assert.equal(mapPilotMetrics({ ...raw, stuck_total: 27 }).stuckTotal, 27);
  assert.equal(mapPilotMetrics(raw).stuckTotal, 2, 'sin total, cuenta los listados');
});

test('cada comercio publicado muestra su día', () => {
  const [line] = mapPilotMetrics(raw).perBusiness;
  assert.match(businessTodayLine(line), /Abierto · 9 pedidos\s+hoy · 8 completados · \$\u00a098\.000/);
  assert.match(businessTodayLine({ ...line, openNow: false, orders: 1, delivered: 1, gross: 0 }), /Cerrado · 1 pedido\s+hoy · 1 completado/);
  assert.equal(businessTodayLine(undefined), '');
});
