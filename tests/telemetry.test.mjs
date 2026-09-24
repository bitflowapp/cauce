import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry, scrub, scrubRoute, classify } from '../js/core/telemetry.js';

const quiet = { warn() {} };

test('nunca deja salir correos, teléfonos, tokens ni contraseñas', () => {
  const text = scrub('ana@example.com 2942 123456 eyJhbGciOi.eyJzdWIiOi.firma sb_secret_abc token_hash=xyz password=Clave123');
  assert.equal(/ana@example|123456|eyJhbGciOi|sb_secret_abc|xyz|Clave123/.test(text), false, text);
  assert.equal(scrubRoute('#pedido/0a0b0c0d-1111-4222-8333-444455556666'), '#pedido/:id');
});

test('clasifica errores de sesión, de Supabase y de interfaz', () => {
  assert.equal(classify({ code: 'invalid_credentials' }), 'auth_error');
  assert.equal(classify({ code: 'PGRST301' }), 'supabase_error');
  assert.equal(classify({ code: '42501' }), 'supabase_error');
  assert.equal(classify({ code: 'U0005' }), 'supabase_error');
  assert.equal(classify(new TypeError('x is undefined')), 'frontend_error');
});

test('envía con techo por minuto y sin repetir el mismo error', async () => {
  const sent = [];
  let clock = 0;
  const telemetry = createTelemetry({ send: async event => sent.push(event), now: () => clock, console: quiet, limit: 3 });
  for (let i = 0; i < 5; i += 1) telemetry.error(new Error('mismo error'));
  for (let i = 0; i < 5; i += 1) telemetry.error(new Error(`error ${i}`));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.length, 3);
  clock = 61000;
  telemetry.orderFailed({ code: 'U0003', message: 'Not enough stock' }, { business: 'b1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.at(-1).kind, 'order_failed');
  assert.equal(telemetry.events().length, 11);
});

test('un fallo al reportar nunca rompe la aplicación', async () => {
  const telemetry = createTelemetry({ send: async () => { throw new Error('sin red'); }, console: quiet });
  assert.doesNotThrow(() => telemetry.critical(new Error('fallo')));
  await new Promise(resolve => setTimeout(resolve, 0));
});
