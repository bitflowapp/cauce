import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeliveryCode,
  buildDeliveryCode,
  normalizeDeliveryCode,
  normalizeDeliveryCodeValue,
  verifyDeliveryCodeValue,
  formatDeliveryCode,
  isDeliveryCodeConfirmed,
  formatDeliveryCodeTime,
} from '../js/core/delivery-code.js';

test('createDeliveryCode genera exactamente 4 dígitos', () => {
  const code = createDeliveryCode('test-order-seed');
  assert.match(code, /^\d{4}$/);
});

test('buildDeliveryCode normaliza y permite confirmación con fecha y actor', () => {
  const code = buildDeliveryCode('4567');
  assert.deepEqual(code, { code: '4567' });

  const confirmed = buildDeliveryCode('4567', {
    confirmedAt: '2026-09-15T18:30:00.000Z',
    confirmedBy: 'rider-juan',
  });
  assert.equal(confirmed.confirmedAt, '2026-09-15T18:30:00.000Z');
  assert.equal(confirmed.confirmedBy, 'rider-juan');
  assert.equal(isDeliveryCodeConfirmed(confirmed), true);
});

test('verifyDeliveryCodeValue valida coincidencias y rechaza intentos erróneos', () => {
  const deliveryCode = buildDeliveryCode('7890');
  assert.deepEqual(verifyDeliveryCodeValue(deliveryCode, '7890'), { ok: true, message: 'Código de entrega confirmado.' });
  assert.equal(verifyDeliveryCodeValue(deliveryCode, '1111').ok, false);
  assert.equal(verifyDeliveryCodeValue(deliveryCode, '').ok, false);
  assert.equal(verifyDeliveryCodeValue(null, '7890').ok, false);
});

test('formatDeliveryCode formatea como dos grupos de 2 dígitos', () => {
  assert.equal(formatDeliveryCode('5566'), '55 66');
  assert.equal(formatDeliveryCode(''), '');
});

test('formatDeliveryCodeTime formatea hora en ciclo 24h sin punto duplicado', () => {
  const confirmed = buildDeliveryCode('1234', { confirmedAt: '2026-09-15T14:05:00.000Z' });
  const timeStr = formatDeliveryCodeTime(confirmed);
  assert.ok(timeStr.length > 0);
  assert.equal(timeStr.includes('..'), false);
});
