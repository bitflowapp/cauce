// El ensayo de una migración sobre la copia de los datos reales: ninguna tabla
// pierde filas; sólo los datos de referencia pueden crecer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCounts, REFERENCE_TABLES } from '../scripts/lib/respaldo.mjs';

test('una migración puede sumar datos de referencia pero nunca cambiar filas de datos', () => {
  const dumped = ['public.orders', 'private.payment_status_transitions', 'private.order_transitions'];
  const before = { 'public.orders': 10, 'private.payment_status_transitions': 12, 'private.order_transitions': 20 };
  // Tres transiciones nuevas de pagos (rechazado/vencido/cancelado → aprobado): admitido.
  const grown = compareCounts(before, { ...before, 'private.payment_status_transitions': 15 }, dumped,
    { allowGrowth: REFERENCE_TABLES });
  assert.deepEqual(grown.mismatches, []);
  assert.equal(grown.compared.length, 3);
  // Una tabla de referencia que se achica, o una tabla de datos que cambia: se frena.
  const shrunk = compareCounts(before, { ...before, 'private.order_transitions': 19 }, dumped, { allowGrowth: REFERENCE_TABLES });
  assert.deepEqual(shrunk.mismatches, ['private.order_transitions']);
  for (const orders of [9, 11]) {
    const changed = compareCounts(before, { ...before, 'public.orders': orders }, dumped, { allowGrowth: REFERENCE_TABLES });
    assert.deepEqual(changed.mismatches, ['public.orders'], String(orders));
  }
  // Sin lista de referencia (restauración de un backup): todo idéntico.
  assert.deepEqual(compareCounts(before, { ...before, 'private.payment_status_transitions': 15 }, dumped).mismatches,
    ['private.payment_status_transitions']);
});
