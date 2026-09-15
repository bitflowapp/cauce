import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScopedCartKey,
  sanitizeCartSnapshot,
  mergeCartMutation,
  readScopedCart,
  writeScopedCart,
  CART_SCHEMA_VERSION,
} from '../js/core/cart-storage.js';

function createMockStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

test('buildScopedCartKey particiona claves por localidad y comercio', () => {
  const key1 = buildScopedCartKey('alumine', 'orilla');
  const key2 = buildScopedCartKey('alumine', 'horno');
  assert.notEqual(key1, key2);
  assert.equal(key1, 'cauce:cart:v2:alumine:orilla');
});

test('sanitizeCartSnapshot limpia campos no autorizados y descarta identificadores inválidos', () => {
  const dirty = {
    schemaVersion: 1,
    businessId: 'orilla',
    localityId: 'alumine',
    unknownField: 'malicious',
    lines: [
      { productId: 'burger-clasica', quantity: 2, price: 999999 },
      { productId: '../invalid-id', quantity: 5 },
      { productId: 'papas', quantity: -1 },
    ],
  };
  const sanitized = sanitizeCartSnapshot(dirty);
  assert.equal(sanitized.schemaVersion, CART_SCHEMA_VERSION);
  assert.equal(sanitized.lines.length, 1);
  assert.equal(sanitized.lines[0].productId, 'burger-clasica');
  assert.equal(sanitized.lines[0].quantity, 2);
  assert.equal(sanitized.lines[0].price, undefined); // No almacena precios
});

test('readScopedCart y writeScopedCart gestionan ciclo de vida y limpieza de carrito vacío', () => {
  const storage = createMockStorage();
  writeScopedCart(storage, 'alumine', 'orilla', { lines: [{ productId: 'papas', quantity: 3 }] });

  const read = readScopedCart(storage, 'alumine', 'orilla');
  assert.equal(read.lines.length, 1);
  assert.equal(read.lines[0].productId, 'papas');
  assert.equal(read.lines[0].quantity, 3);

  // Escribir carrito vacío elimina la clave del disco
  writeScopedCart(storage, 'alumine', 'orilla', { lines: [] });
  const empty = readScopedCart(storage, 'alumine', 'orilla');
  assert.equal(empty.lines.length, 0);
  assert.equal(storage.getItem(buildScopedCartKey('alumine', 'orilla')), null);
});

test('mergeCartMutation fusiona cambios multi-pestaña sin last-write-wins', () => {
  const base = { lines: [{ productId: 'papas', quantity: 1 }] };
  const tabA = { lines: [{ productId: 'papas', quantity: 2 }] }; // sumó 1
  const tabB = { lines: [{ productId: 'papas', quantity: 1 }, { productId: 'burger', quantity: 1 }] }; // sumó burger

  const merged = mergeCartMutation(base, tabA, tabB);
  assert.equal(merged.lines.find(l => l.productId === 'papas').quantity, 2);
  assert.equal(merged.lines.find(l => l.productId === 'burger').quantity, 1);
});
