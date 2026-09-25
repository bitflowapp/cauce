// Pagos: el vocabulario neutral que usa la interfaz. Ningún estado del
// proveedor, ninguna forma de pago que la base no haya ofrecido, y ninguna
// pantalla que dé un pago por aprobado sin leerlo de la base.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYMENT_STATES, PAYMENT_TRANSITIONS, canTransitionPayment, orderPayment, canPrepare, checkoutPaymentMethods,
  cashOnlyMethods, paymentReturnState, RETURN_OUTCOMES, isPaid, isWaitingPayment, PAYMENT_METHOD_LABELS,
} from '../js/core/payment.js';

test('los estados neutrales son los del contrato', () => {
  assert.deepEqual([...PAYMENT_STATES], ['not_required', 'pending', 'processing', 'approved', 'rejected', 'cancelled',
    'refunded', 'partially_refunded', 'expired']);
  for (const [from, list] of Object.entries(PAYMENT_TRANSITIONS)) {
    assert.ok(PAYMENT_STATES.includes(from));
    for (const to of list) assert.ok(PAYMENT_STATES.includes(to), `${from} → ${to}`);
  }
});

test('la máquina de estados admite lo que el proveedor puede informar y nada más', () => {
  assert.equal(canTransitionPayment('pending', 'approved'), true);
  assert.equal(canTransitionPayment('processing', 'rejected'), true);
  assert.equal(canTransitionPayment('approved', 'partially_refunded'), true);
  assert.equal(canTransitionPayment('partially_refunded', 'refunded'), true);
  assert.equal(canTransitionPayment('approved', 'approved'), true, 'la misma noticia dos veces no es un salto');
  // Un aprobado después de cerrar el intento es plata cobrada: se refleja (y se revisa).
  for (const from of ['rejected', 'expired', 'cancelled']) assert.equal(canTransitionPayment(from, 'approved'), true, from);
  for (const [from, to] of [['approved', 'pending'], ['refunded', 'approved'], ['rejected', 'pending'],
    ['expired', 'processing'], ['cancelled', 'refunded'], ['pending', 'refunded'], ['pending', 'not_required']]) {
    assert.equal(canTransitionPayment(from, to), false, `${from} → ${to}`);
  }
  assert.equal(canTransitionPayment('approved', 'accredited'), false, 'un estado del proveedor no es un estado de CAUCE');
});

test('el pago de un pedido se ve en términos neutrales, efectivo u online', () => {
  const cash = orderPayment({ paymentMethod: 'cash_on_delivery', paymentStatus: 'pending_on_delivery', fulfillment: 'delivery' });
  assert.deepEqual({ ...cash }, { kind: 'cash', state: 'not_required', collected: false, label: 'Efectivo al recibir',
    tone: 'neutral', method: 'Efectivo al recibir' });
  assert.equal(orderPayment({ paymentMethod: 'cash_on_pickup', paymentStatus: 'settled' }).label, 'Cobrado en efectivo');
  const pending = orderPayment({ paymentMethod: 'online', paymentStatus: 'pending' });
  assert.deepEqual({ kind: pending.kind, state: pending.state, collected: pending.collected, label: pending.label },
    { kind: 'online', state: 'pending', collected: false, label: 'Pago pendiente' });
  assert.equal(orderPayment({ paymentMethod: 'online', paymentStatus: 'approved' }).collected, true);
  assert.equal(orderPayment({ paymentMethod: 'online', paymentStatus: 'partially_refunded' }).collected, true);
  // Un valor desconocido nunca se muestra como pagado.
  assert.equal(orderPayment({ paymentMethod: 'online', paymentStatus: 'accredited' }).state, 'pending');
  assert.equal(isPaid('approved') && !isPaid('pending') && isWaitingPayment('processing'), true);
});

test('un pedido online se prepara recién con el pago aprobado; el efectivo, como siempre', () => {
  assert.equal(canPrepare({ paymentMethod: 'cash_on_pickup', paymentStatus: 'pending_on_delivery' }), true);
  assert.equal(canPrepare({ paymentMethod: 'online', paymentStatus: 'pending' }), false);
  assert.equal(canPrepare({ paymentMethod: 'online', paymentStatus: 'processing' }), false);
  assert.equal(canPrepare({ paymentMethod: 'online', paymentStatus: 'approved' }), true);
});

test('el checkout muestra sólo las formas que ofreció la base, para la modalidad elegida', () => {
  const cashOnly = [{ id: 'cash_on_pickup', kind: 'cash', fulfillment: 'pickup' }, { id: 'cash_on_delivery', kind: 'cash', fulfillment: 'delivery' }];
  assert.deepEqual(checkoutPaymentMethods(cashOnly, 'pickup').map(method => method.id), ['cash_on_pickup']);
  assert.deepEqual(checkoutPaymentMethods(cashOnly, 'delivery').map(method => method.id), ['cash_on_delivery']);
  const withOnline = [...cashOnly, { id: 'online', kind: 'online', provider: 'mercadopago', label: 'Mercado Pago', flows: ['checkout_pro'] }];
  const offered = checkoutPaymentMethods(withOnline, 'delivery');
  assert.deepEqual(offered.map(method => [method.id, method.kind, method.label]),
    [['cash_on_delivery', 'cash', 'Efectivo al recibir'], ['online', 'online', 'Mercado Pago']]);
  // Nada que la base no ofreció: ni online sin proveedor, ni formas inventadas.
  assert.deepEqual(checkoutPaymentMethods([{ id: 'online', kind: 'online' }], 'pickup'), []);
  assert.deepEqual(checkoutPaymentMethods([{ id: 'tarjeta', kind: 'card' }], 'pickup'), []);
  assert.deepEqual(checkoutPaymentMethods(null, 'pickup'), []);
  assert.deepEqual(cashOnlyMethods('pickup').map(method => method.id), ['cash_on_pickup']);
  assert.equal(PAYMENT_METHOD_LABELS.online, 'Pago online');
});

test('las páginas de retorno nunca dan un pago por aprobado sin leerlo de la base', () => {
  assert.deepEqual([...RETURN_OUTCOMES], ['exito', 'pendiente', 'error']);
  // La URL dice "éxito" pero la base todavía no confirmó: se espera.
  for (const outcome of RETURN_OUTCOMES) {
    const waiting = paymentReturnState(outcome, { paymentMethod: 'online', paymentStatus: 'pending' });
    assert.equal(waiting.final, false);
    assert.doesNotMatch(waiting.title, /aprobado/i);
  }
  assert.equal(paymentReturnState('error', { paymentMethod: 'online', paymentStatus: 'approved' }).title, 'Pago aprobado');
  assert.equal(paymentReturnState('exito', { paymentMethod: 'online', paymentStatus: 'rejected' }).tone, 'error');
  assert.equal(paymentReturnState('exito', null).title, 'No encontramos este pago');
  assert.equal(paymentReturnState('exito', { paymentMethod: 'cash_on_pickup', paymentStatus: 'pending_on_delivery' }).title,
    'Este pedido no tiene pago online');
});
