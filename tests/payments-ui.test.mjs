// Pagos en la interfaz: sólo se dibuja lo que la base ofreció, el estado
// sale de la base y ningún proveedor está escrito a mano en las pantallas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  paymentMethodSelector, paymentBadge, paymentReturnView, paymentsSection, orderPaymentNotice, DEMO_PAYMENT_METHODS,
} from '../js/ui/payments.js';
import { checkoutPaymentMethods, paymentReturnReference, connectionResult } from '../js/core/payment.js';

const offered = [{ id: 'cash_on_pickup', kind: 'cash' }, { id: 'cash_on_delivery', kind: 'cash' },
  { id: 'online', kind: 'online', provider: 'proveedor', label: 'Pagos <Sur>', flows: ['checkout_pro'] }];

test('el selector muestra lo ofrecido y nada más, con una opción elegida', () => {
  const cashOnly = paymentMethodSelector(checkoutPaymentMethods(offered.slice(0, 2), 'pickup'), 'online');
  assert.equal((cashOnly.match(/name="paymentMethod"/g) || []).length, 1);
  assert.match(cashOnly, /value="cash_on_pickup" checked/, 'una forma que no está no queda elegida');
  const both = paymentMethodSelector(checkoutPaymentMethods(offered, 'delivery'), 'online', { note: 'Nota <b>' });
  assert.match(both, /value="cash_on_delivery"/);
  assert.match(both, /value="online" checked/);
  assert.ok(both.includes('Pagos &lt;Sur&gt;'), 'el nombre del proveedor sale de la base y se escapa');
  assert.match(both, /aria-describedby="pay-note"/);
  assert.ok(both.includes('Nota &lt;b&gt;'));
  assert.match(both, /<fieldset class="pay-methods"[\s\S]*<legend class="visually-hidden">Forma de pago<\/legend>/);
  assert.deepEqual(DEMO_PAYMENT_METHODS.map(method => method.id), ['cash_demo', 'transfer_demo']);
});

test('la insignia del pago habla en estados neutrales', () => {
  assert.match(paymentBadge({ paymentMethod: 'online', paymentStatus: 'approved' }), /is-success[^>]*>Pagado</);
  assert.match(paymentBadge({ paymentMethod: 'online', paymentStatus: 'pending' }), /is-pending[^>]*>Pago pendiente</);
  assert.match(paymentBadge({ paymentMethod: 'online', paymentStatus: 'rejected' }), /is-error[^>]*>Pago rechazado</);
  assert.match(paymentBadge({ paymentMethod: 'cash_on_pickup', paymentStatus: 'pending_on_delivery' }, { compact: true }),
    />Efectivo al retirar</);
  assert.match(paymentBadge({ paymentMethod: 'cash_on_delivery', paymentStatus: 'settled' }, { compact: true }), />Cobrado</);
});

test('la vuelta del proveedor no aprueba nada por su cuenta', () => {
  const waiting = paymentReturnView('exito', { paymentMethod: 'online', paymentStatus: 'pending', orderId: 'o1', code: 'CA-0001' });
  assert.match(waiting, /Estamos confirmando tu pago/);
  assert.match(waiting, /consulta el estado del pago cada pocos segundos/);
  assert.match(waiting, /href="#pedido\/o1"/);
  assert.doesNotMatch(waiting, /Pago aprobado/);
  assert.match(paymentReturnView('error', { paymentMethod: 'online', paymentStatus: 'approved' }), /Pago aprobado/);
  assert.match(paymentReturnView('exito', null), /No encontramos este pago/);
});

test('la referencia de vuelta es un UUID puesto por CAUCE, o no se consulta nada', () => {
  const id = '0b8e2f6e-3f2a-4a47-9d86-1f7b3c1e9a10';
  assert.equal(paymentReturnReference(`#pago/exito?intento=${id}`, ''), id);
  assert.equal(paymentReturnReference('#pago/exito', `?collection_id=1&external_reference=${id}`), id);
  assert.equal(paymentReturnReference('#pago/exito?intento=1 or 1=1', ''), '');
  assert.equal(paymentReturnReference('#pago/exito', ''), '');
  assert.equal(connectionResult('#panel/b1/pagos?conexion=ok'), 'ok');
  assert.equal(connectionResult('#panel/b1/pagos?conexion=<script>'), '');
  // Cuenta que no corresponde al modo del comercio: se explica, no se guardó nada.
  for (const [result, text] of [['cuenta_real', 'sólo se conectan cuentas de prueba'], ['cuenta_prueba', 'conectá la cuenta real']]) {
    assert.equal(connectionResult(`#panel/b1/pagos?conexion=${result}`), result);
    const html = paymentsSection(overview(), { businessId: 'b1', isOwner: true, connection: result });
    assert.ok(html.includes(text), result);
    assert.ok(html.includes('No se guardó nada'), result);
  }
});

const overview = (extra = {}) => ({ enabled: true, providers: [{ provider: 'proveedor', label: 'Pagos Sur' }], accounts: [],
  today: { approved: 0, approved_ars: 0, pending: 0, rejected: 0, refunded: 0, to_refund: 0 }, last_synced_at: null, ...extra });

test('la sección Pagos muestra el estado real de la cuenta y quién puede conectarla', () => {
  const idle = paymentsSection(overview(), { businessId: 'b1', isOwner: true });
  assert.match(idle, /No conectado/);
  assert.match(idle, /data-action="payment-connect" data-business="b1" data-provider="proveedor"[^>]*>Conectar Pagos Sur</);
  assert.match(idle, /Todavía no hay pagos online/, 'sin cuenta no se inventan números');
  assert.doesNotMatch(idle, /metric-value/);
  const manager = paymentsSection(overview(), { businessId: 'b1', isOwner: false });
  assert.doesNotMatch(manager, /data-action="payment-connect"/);
  assert.match(manager, /lo hace la persona titular/);
  const connected = paymentsSection(overview({
    accounts: [{ provider: 'proveedor', status: 'connected', provider_user_id: '424242', live_mode: false }],
    today: { approved: 2, approved_ars: 15000, pending: 1, rejected: 0, refunded: 1, to_refund: 1 },
    last_synced_at: '2026-09-25T15:00:00Z' }), { businessId: 'b1', isOwner: true, connection: 'ok' });
  for (const text of ['Conectado', 'Cuenta vendedora 424242', 'modo de prueba', 'Desconectar', 'Cuenta conectada', '15.000',
    '1 por devolver', 'Última novedad del proveedor']) {
    assert.ok(connected.includes(text), `falta "${text}"`);
  }
  assert.match(paymentsSection(overview({ to_review: 2 }), { businessId: 'b1', isOwner: true }), /2 pagos para revisar/);
  assert.doesNotMatch(idle, /para revisar/);
  assert.match(paymentsSection(overview({ accounts: [{ provider: 'proveedor', status: 'reconnect_required' }] }),
    { businessId: 'b1', isOwner: true }), /Requiere reconexión[\s\S]*Volver a conectar/);
  assert.match(paymentsSection(overview({ accounts: [{ provider: 'proveedor', status: 'connecting' }] }),
    { businessId: 'b1', isOwner: true }), /Conectando/);
});

test('el aviso del pedido online deja pagar sólo a quien compró y mientras falta el pago', () => {
  const order = extra => ({ id: 'o1', total: 7500, paymentMethod: 'online', paymentStatus: 'pending', ...extra });
  assert.equal(orderPaymentNotice({ paymentMethod: 'cash_on_pickup', paymentStatus: 'pending_on_delivery' }), '');
  assert.match(orderPaymentNotice(order(), { canPay: true }), /data-action="payment-start" data-order="o1"[\s\S]*Pagar ahora/);
  assert.doesNotMatch(orderPaymentNotice(order(), { canPay: false }), /payment-start/);
  assert.doesNotMatch(orderPaymentNotice(order({ paymentStatus: 'approved' }), { canPay: true }), /payment-start/);
  assert.doesNotMatch(orderPaymentNotice(order({ paymentStatus: 'processing' }), { canPay: true }), /payment-start/,
    'mientras el proveedor procesa un pago no se ofrece pagar otra vez');
  assert.match(orderPaymentNotice(order({ paymentStatus: 'rejected' }), { canPay: true }), /Intentar el pago de nuevo/);
  assert.match(orderPaymentNotice(order({ paymentStatus: 'approved' })), /Pagado/);
});

test('ninguna pantalla nombra a un proveedor: lo nombra la base', async () => {
  for (const file of ['js/ui/payments.js', 'js/ui/order-status.js', 'js/ui/business-panel.js', 'js/ui/rider.js', 'js/app.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /mercado ?pago/i, `${file} no debe nombrar al proveedor`);
  }
});
