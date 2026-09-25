// Seguimiento para quien compra: el estado actual primero, el código de
// entrega a mano y lo secundario plegado. Nada de ubicación en vivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderStatusHero, deliveryCodeCard, orderTimeline, orderDetails, cancellationNotice } from '../js/ui/order-status.js';

const order = (extra = {}) => ({ id: 'o1', code: 'CA-0042', status: 'on_the_way', fulfillment: 'delivery',
  paymentMethod: 'cash_on_delivery', paymentStatus: 'pending_on_delivery', deliveryCode: { code: '1234' },
  customer: { address: 'Los Pehuenes 45 <b>' }, subtotal: 6000, deliveryFee: 1500, total: 7500,
  lines: [{ name: 'Empanada <x>', quantity: 5, unitPrice: 1200, total: 6000 }],
  history: [{ status: 'submitted', at: '2026-09-25T15:00:00Z' }, { status: 'on_the_way', at: '2026-09-25T15:30:00Z' }], ...extra });

test('el estado actual se lee primero, con dónde, quién y cuánto falta', () => {
  const html = orderStatusHero(order(), { times: 'Envío: ~30 min', place: 'Los Pehuenes 45 <b>', courier: 'Reparto de Almacén' });
  for (const text of ['En camino', 'Tené a mano el código de entrega', 'Entrega en: Los Pehuenes 45 &lt;b&gt;', 'Reparto de Almacén',
    'Tiempo declarado por el comercio: Envío: ~30 min', 'no es una ubicación en vivo']) {
    assert.ok(html.includes(text), `falta "${text}"`);
  }
  assert.match(orderStatusHero(order({ status: 'arrived' })), /El reparto informó que llegó/);
  const pickup = orderStatusHero(order({ status: 'ready', fulfillment: 'pickup' }), { place: 'Villegas 245', times: 'x' });
  assert.match(pickup, /Ya podés retirarlo por el comercio/);
  assert.match(pickup, /Retirás en: Villegas 245/);
  assert.doesNotMatch(pickup, /ubicación en vivo/, 'retiro: no hay reparto que informar');
  const done = orderStatusHero(order({ status: 'delivered' }), { times: 'Envío: ~30 min', place: 'x' });
  assert.doesNotMatch(done, /Tiempo declarado|Entrega en/);
  assert.equal(orderStatusHero(order({ status: 'canceled' })), '');
});

test('el código de entrega se muestra sólo mientras hace falta', () => {
  assert.match(deliveryCodeCard(order()), /data-delivery-code>12 34</);
  assert.equal(deliveryCodeCard(order({ status: 'delivered' })), '');
  assert.equal(deliveryCodeCard(order({ status: 'canceled' })), '');
  assert.equal(deliveryCodeCard(order({ fulfillment: 'pickup' })), '');
  assert.equal(deliveryCodeCard(order({ deliveryCode: null })), '');
});

test('la línea de tiempo marca el paso actual y lo ya hecho', () => {
  const html = orderTimeline(order());
  assert.match(html, /timeline-step current"\s+aria-current="step"/);
  assert.equal((html.match(/timeline-step done/g) || []).length, 5, 'recibido, aceptado, preparación, listo y asignado');
  assert.match(html, /Recibido <span class="quiet">·/);
});

test('el detalle queda plegado, con el total y el pago en palabras neutrales', () => {
  const html = orderDetails(order());
  assert.match(html, /<details class="order-details" >/);
  assert.match(html, /Detalle del pedido · 5 productos/);
  assert.ok(html.includes('Empanada &lt;x&gt;'));
  assert.match(html, /Pago: Efectivo al recibir · se paga al comercio/);
  assert.match(orderDetails(order({ paymentMethod: 'online', paymentStatus: 'approved' }), { open: true }),
    /<details class="order-details" open>[\s\S]*Pago: Pago online · Pagado/);
  assert.match(cancellationNotice({ cancellation: { kind: 'rejected', reason: 'Sin <stock>' } }),
    /El comercio no pudo tomar el pedido[\s\S]*Sin &lt;stock&gt;/);
});
