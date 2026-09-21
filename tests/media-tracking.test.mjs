import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialDemoState } from '../js/data/demo.js';
import { quoteCart } from '../js/core/cart.js';
import { renderCharacter } from '../js/ui/brand-characters.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('la cotización conserva la fotografía del producto para el historial del pedido', () => {
  const state = initialDemoState();
  const business = state.businesses.find(item => item.id === 'orilla');
  const product = state.products.find(item => item.id === 'burger-clasica');
  const quote = quoteCart({
    localityId: business.localityId,
    businessId: business.id,
    lines: [{ productId: product.id, variantId: null, quantity: 1 }],
  }, business, state.products, 'delivery');

  assert.equal(quote.lines[0].image, product.image);
  assert.equal(quote.lines[0].dishType, product.dishType);
});

test('el tracking se declara estimado y no afirma telemetría inexistente', async () => {
  const app = await readFile(resolve(root, 'js/app.js'), 'utf8');
  assert.match(app, /AVANCE ESTIMADO/);
  assert.match(app, /no representa coordenadas en vivo/i);
  assert.match(app, /no representa distancia, ETA ni posición exactas/i);
  assert.match(app, /Sin GPS en tiempo real/);
});

test('las animaciones de tracking son finitas y respetan movimiento reducido', async () => {
  const css = await readFile(resolve(root, 'styles/cauce.css'), 'utf8');
  assert.match(css, /animation:\s*route-advance\s+1\.8s[^;]*both/);
  assert.match(css, /animation:\s*taxi-search-pulse\s+1\.4s[^;]*2\s+both/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.route-visual\.is-moving/);
  assert.doesNotMatch(css, /route-advance[^;]*infinite/);
  assert.doesNotMatch(css, /taxi-search-pulse[^;]*infinite/);
  assert.doesNotMatch(css, /brand-wheel-turn[^;]*infinite/);
});

test('los personajes de marca son SVG livianos, decorativos y contextuales', () => {
  const names = ['shopper', 'courier', 'taxi-driver', 'merchant', 'search', 'celebrate'];
  const drawings = names.map(name => renderCharacter(name, 96));
  assert.equal(new Set(drawings).size, names.length);
  for (const drawing of drawings) {
    assert.match(drawing, /^<svg/);
    assert.match(drawing, /class="brand-character/);
    assert.match(drawing, /aria-hidden="true"/);
    assert.match(drawing, /focusable="false"/);
    assert.doesNotMatch(drawing, /<text\b/);
    assert.ok(drawing.length < 5000, 'cada personaje debe seguir siendo un SVG compacto');
  }
});
