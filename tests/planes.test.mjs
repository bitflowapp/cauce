import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANES_ORIENTATIVOS, validarPreciosPlanes } from '../js/core/planes.js';

test('precios orientativos se pueden configurar sin habilitar cobros ni límites', () => {
  assert.equal(validarPreciosPlanes(PLANES_ORIENTATIVOS), true);
  const configurados = PLANES_ORIENTATIVOS.map(plan => ({ ...plan, mensualArs: 25000 }));
  assert.equal(validarPreciosPlanes(configurados), true);
  assert.equal(PLANES_ORIENTATIVOS[0].mensualArs, 19900);
  assert.equal(validarPreciosPlanes(configurados.map(plan => ({ ...plan, mensualArs: -1 }))), false);
  assert.equal(validarPreciosPlanes([configurados[0], configurados[0], configurados[2]]), false);
});
