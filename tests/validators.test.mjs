import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidArgentinePhone,
  formatArgentinePhone,
  validateCustomerName,
  sanitizeText,
  sanitizeNotes,
  isPlausibleStreetAddress,
  validateRequiredStreetNumber,
} from '../js/core/validators.js';

test('validación de teléfono argentino acepta números plausibles y rechaza repetidos o cortos', () => {
  assert.equal(isValidArgentinePhone('2942556677'), true);
  assert.equal(isValidArgentinePhone('299 555-1234'), true);
  assert.equal(isValidArgentinePhone('+54 9 2942 556677'), true);
  assert.equal(isValidArgentinePhone('1111111111'), false); // todos dígitos repetidos
  assert.equal(isValidArgentinePhone('0000000000'), false);
  assert.equal(isValidArgentinePhone('123'), false); // muy corto
  assert.equal(isValidArgentinePhone(''), false);
});

test('formateo de teléfono argentino separa prefijo y bloques locales', () => {
  assert.equal(formatArgentinePhone('2942556677'), '294 255 6677');
  assert.equal(formatArgentinePhone('123'), '123');
});

test('validación de nombre de cliente exige letras, longitud adecuada y rechaza símbolos puros', () => {
  assert.deepEqual(validateCustomerName('  María Luna  '), { ok: true, name: 'María Luna', message: '' });
  assert.equal(validateCustomerName('M').ok, false); // menos de 2 chars
  assert.equal(validateCustomerName('$$$###').ok, false); // sin letras
  assert.equal(validateCustomerName('a'.repeat(81)).ok, false); // más de 80 chars
});

test('saneamiento de texto y notas elimina caracteres de control y normaliza espacios', () => {
  const dirty = "Hola\u0000\u0007 mundo\t\tcon   espacios\r\n";
  assert.equal(sanitizeText(dirty), 'Hola mundo con espacios');
  assert.equal(sanitizeNotes('  Nota con muchos espacios  '), 'Nota con muchos espacios');
});

test('dirección plausible exige letras y número', () => {
  assert.equal(isPlausibleStreetAddress('Av. 4 de Febrero 450'), true);
  assert.equal(isPlausibleStreetAddress('Ruta 23 km 5'), true);
  assert.equal(isPlausibleStreetAddress('SinNumero'), false);
  assert.equal(isPlausibleStreetAddress('12345'), false);
});

test('número de calle requerido valida presencia de dato', () => {
  assert.equal(validateRequiredStreetNumber('450').ok, true);
  assert.equal(validateRequiredStreetNumber('   ').ok, false);
});
