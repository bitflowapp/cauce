// Fotos livianas: sin las APIs del navegador (o si algo falla) se sube el
// archivo original, nunca se bloquea la carga.
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeImage, IMAGE_SIDES } from '../js/repositories/image-prep.js';

test('cada lugar tiene su tamaño máximo', () => {
  assert.deepEqual({ ...IMAGE_SIDES }, { cover: 1600, logo: 512, product: 1024 });
});

test('sin canvas ni createImageBitmap se sube el original', async () => {
  const file = new Blob([new Uint8Array(2048)], { type: 'image/jpeg' });
  assert.equal(await optimizeImage(file), file);
  assert.equal(await optimizeImage(null), null);
});

test('si el navegador no puede decodificar la imagen, también el original', async () => {
  const file = new Blob([new Uint8Array(4096)], { type: 'image/png' });
  globalThis.document = /** @type {any} */ ({ createElement: () => ({}) });
  globalThis.createImageBitmap = async () => { throw new Error('formato raro'); };
  try {
    assert.equal(await optimizeImage(file), file);
  } finally {
    delete globalThis.document;
    delete globalThis.createImageBitmap;
  }
});
