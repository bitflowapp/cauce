// Facturación: sólo la lógica que no es fiscal (docs/CONTRATO-FACTURACION-ARCA.md).
// Ninguna prueba simula una autorización de ARCA ni arma un CAE: eso existe sólo
// cuando ARCA lo devuelve, en el servidor.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  normalizeCuit, cuitCheckDigit, isValidCuit, formatCuit, maskCuit, defaultVoucherType, voucherLabel, invoiceAmounts,
  amountsConsistent, invoiceDetail, canRequestInvoice, canTransitionInvoice, isLiveInvoice, nextRetryAt,
  RETRY_SCHEDULE_MINUTES, formatVoucherNumber, invoiceStatusText, INVOICE_STATES, LIVE_STATES,
} from '../js/core/invoicing.js';

// CUIT público de la propia ARCA (ex AFIP): 33-69345023-9.
const ARCA_CUIT = '33693450239';

test('CUIT: 11 dígitos, prefijo vigente y dígito verificador módulo 11', () => {
  assert.equal(normalizeCuit('33-69345023-9'), ARCA_CUIT);
  assert.equal(normalizeCuit('3369345023'), '');
  assert.equal(cuitCheckDigit('3369345023'), 9);
  assert.equal(isValidCuit('33-69345023-9'), true);
  assert.equal(isValidCuit('33-69345023-8'), false, 'otro dígito verificador');
  assert.equal(isValidCuit('99-69345023-9'), false, 'prefijo inexistente');
  assert.equal(isValidCuit(''), false);
  assert.equal(isValidCuit(null), false);
  // Una base cuyo dígito sería 10 no tiene CUIT válido con ese prefijo.
  const base = Array.from({ length: 1000 }, (_, i) => `20${String(10000000 + i * 7919).padStart(8, '0')}`)
    .find(candidate => cuitCheckDigit(candidate) === null);
  assert.ok(base, 'hay bases sin dígito posible');
  for (let digit = 0; digit <= 9; digit += 1) assert.equal(isValidCuit(`${base}${digit}`), false);
  // 2·5 + 0·4 + 1·3 + 2·2 + 3·7 + 4·6 + 5·5 + 6·4 + 7·3 + 8·2 = 148; 11 − (148 mód 11) = 6.
  assert.equal(cuitCheckDigit('2012345678'), 6);
  assert.equal(isValidCuit('20-12345678-6'), true);
});

test('CUIT para mostrar: con guiones o enmascarado', () => {
  assert.equal(formatCuit(ARCA_CUIT), '33-69345023-9');
  assert.equal(maskCuit(ARCA_CUIT), '33-•••••023-9');
  assert.equal(formatCuit('123'), '');
  assert.equal(maskCuit(''), '');
});

test('el tipo por defecto sigue la condición frente al IVA', () => {
  assert.equal(defaultVoucherType('monotributo'), 11);
  assert.equal(defaultVoucherType('exento'), 11);
  assert.equal(defaultVoucherType('responsable_inscripto'), 6);
  assert.equal(defaultVoucherType('otra'), null);
  assert.equal(voucherLabel(11), 'Factura C');
  assert.equal(voucherLabel(6), 'Factura B');
  assert.equal(voucherLabel(99), '');
});

test('los importes salen del pedido: Factura C es neto; A y B esperan la alícuota por producto', () => {
  const order = { total: 5900, subtotal: 5000, deliveryFee: 900 };
  const c = invoiceAmounts(order, 11);
  assert.deepEqual(c, { ok: true, amounts: { neto: 5900, iva: 0, exento: 0, noGravado: 0, tributos: 0, total: 5900 } });
  assert.equal(amountsConsistent(c.amounts), true);
  assert.deepEqual(invoiceAmounts(order, 6), { ok: false, reason: 'vat_rates_required' });
  assert.deepEqual(invoiceAmounts(order, 1), { ok: false, reason: 'vat_rates_required' });
  assert.deepEqual(invoiceAmounts({ total: 0 }, 11), { ok: false, reason: 'invalid_total' });
  assert.deepEqual(invoiceAmounts({ total: 10.5 }, 11), { ok: false, reason: 'invalid_total' });
  assert.equal(amountsConsistent({ neto: 100, iva: 21, exento: 0, noGravado: 0, tributos: 0, total: 121 }), true);
  assert.equal(amountsConsistent({ neto: 100, iva: 21, exento: 0, noGravado: 0, tributos: 0, total: 120 }), false);
  assert.equal(amountsConsistent(null), false);
});

test('el detalle impreso lleva los productos y el envío como renglón propio', () => {
  const detail = invoiceDetail({ deliveryFee: 900, lines: [{ name: 'Yerba', quantity: 2, unitPrice: 1500, total: 3000 },
    { name: 'Torta', quantity: 1, total: 2000 }] });
  assert.deepEqual(detail, [
    { description: 'Yerba', quantity: 2, unitPrice: 1500, total: 3000 },
    { description: 'Torta', quantity: 1, unitPrice: 2000, total: 2000 },
    { description: 'Envío', quantity: 1, unitPrice: 900, total: 900 },
  ]);
  assert.deepEqual(invoiceDetail({ lines: [] }), []);
});

test('facturan titular y encargado/a, un pedido entregado y cobrado, una sola vez', () => {
  const order = { status: 'delivered', paymentStatus: 'settled' };
  const profile = { estado: 'lista' };
  assert.deepEqual(canRequestInvoice({ order, profile, role: 'owner' }), { ok: true });
  assert.deepEqual(canRequestInvoice({ order, profile, role: 'manager' }), { ok: true });
  assert.equal(canRequestInvoice({ order, profile, role: 'staff' }).reason, 'role');
  assert.equal(canRequestInvoice({ order, profile, role: 'customer' }).reason, 'role');
  assert.equal(canRequestInvoice({ order: { ...order, status: 'ready' }, profile, role: 'owner' }).reason, 'not_delivered');
  assert.equal(canRequestInvoice({ order: { ...order, paymentStatus: 'pending_on_delivery' }, profile, role: 'owner' }).reason, 'not_settled');
  assert.equal(canRequestInvoice({ order, profile: { estado: 'borrador' }, role: 'owner' }).reason, 'profile_not_ready');
  assert.equal(canRequestInvoice({ order, profile, role: 'owner', liveInvoice: { estado: 'pendiente' } }).reason, 'already_invoiced');
});

test('máquina de estados: nunca se reenvía a ciegas y una autorizada no cambia', () => {
  assert.deepEqual(INVOICE_STATES, ['pendiente', 'enviando', 'autorizada', 'rechazada', 'error', 'incierta']);
  assert.equal(canTransitionInvoice('pendiente', 'enviando'), true);
  assert.equal(canTransitionInvoice('enviando', 'incierta'), true);
  assert.equal(canTransitionInvoice('incierta', 'enviando'), false, 'incierta se consulta, no se reenvía');
  assert.equal(canTransitionInvoice('incierta', 'pendiente'), true, 'si ARCA no lo tiene, vuelve a la cola');
  for (const next of INVOICE_STATES) assert.equal(canTransitionInvoice('autorizada', next), false);
  assert.equal(canTransitionInvoice('pendiente', 'autorizada'), false, 'sin pasar por ARCA no hay autorización');
  assert.deepEqual(LIVE_STATES, ['pendiente', 'enviando', 'autorizada', 'incierta']);
  assert.equal(isLiveInvoice({ estado: 'rechazada' }), false);
  assert.equal(isLiveInvoice({ estado: 'incierta' }), true);
});

test('reintentos escalonados con tope', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  assert.deepEqual(RETRY_SCHEDULE_MINUTES, [1, 2, 5, 15, 60]);
  assert.equal(nextRetryAt(1, now), '2026-09-25T12:01:00.000Z');
  assert.equal(nextRetryAt(5, now), '2026-09-25T13:00:00.000Z');
  assert.equal(nextRetryAt(6, now), null, 'pasado el tope, acción humana');
  assert.equal(nextRetryAt(0, now), null);
});

test('número de comprobante y textos de la tarjeta, sin inventar una autorización', () => {
  assert.equal(formatVoucherNumber(3, 123), '0003-00000123');
  assert.equal(formatVoucherNumber(12345, 1), '12345-00000001');
  assert.equal(formatVoucherNumber(0, 1), '');
  assert.equal(formatVoucherNumber(3, 0), '');
  assert.equal(invoiceStatusText({ estado: 'pendiente' }).text, 'Emitiendo factura…');
  assert.equal(invoiceStatusText({ estado: 'incierta' }).text, 'Confirmando con ARCA…');
  assert.match(invoiceStatusText({ estado: 'rechazada', ultimoError: 'Fecha fuera de rango' }).text, /ARCA rechazó la factura: Fecha fuera de rango/);
  assert.match(invoiceStatusText({ estado: 'error', proximoIntentoAt: 'x' }, { timeText: () => '12:05' }).text, /Reintentamos a las 12:05/);
  // "Autorizada" sin CAE, número o vencimiento no se muestra como factura.
  assert.deepEqual(invoiceStatusText({ estado: 'autorizada', tipo: 11, puntoVenta: 3, numero: 1 }),
    { tone: 'error', text: 'Comprobante incompleto: revisalo con soporte.' });
  assert.equal(invoiceStatusText(null).text, '');
});

test('el módulo no habla con ARCA ni conoce secretos', async () => {
  const source = await readFile(new URL('../js/core/invoicing.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(source, /BEGIN (RSA |EC )?PRIVATE KEY|\bToken\b.*\bSign\b/);
});
