// Unitarias de piezas de interfaz que no necesitan navegador: ilustraciones de
// Sofía, íconos y componentes (todo texto de datos sale escapado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sofia, SCENE_NAMES } from '../../js/ui/sofia.js';
import { icon, ICON_NAMES } from '../../js/ui/icons.js';
import { productCard, storeCard, fairCard, emptyState, banner, stepper } from '../../js/ui/components.js';

test('las ocho escenas pedidas existen y son SVG accesibles con contorno sticker', () => {
  for (const scene of ['bienvenida', 'creando', 'explorando', 'preparando', 'celebrando', 'carrito-vacio', 'buscando', 'comunidad']) {
    assert.ok(SCENE_NAMES.includes(scene), scene);
    const svg = sofia(scene, { size: 200 });
    assert.match(svg, /^<svg class="sofia sofia-[a-z-]+ is-animated"/);
    assert.match(svg, /role="img" aria-label="[^"]{8,}"/);
    assert.match(svg, /feMorphology in="SourceAlpha" operator="dilate"/);
    assert.doesNotMatch(svg, /style="/, 'sin estilos en línea (CSP)');
  }
  // Cada SVG lleva su propio id de filtro: varias Sofías en una misma página no chocan.
  const ids = [sofia('bienvenida'), sofia('bienvenida')].map(s => s.match(/filter id="([^"]+)"/)[1]);
  assert.notEqual(ids[0], ids[1]);
  assert.match(sofia('celebrando', { animated: false }), /class="sofia sofia-celebrando"/);
});

test('íconos de los ocho rubros y de la navegación', () => {
  for (const name of ['ceramica', 'textiles', 'joyeria', 'decoracion', 'cuero', 'arte', 'regionales', 'otros', 'home', 'search', 'fairs', 'heart', 'user', 'cart', 'bell']) {
    assert.ok(ICON_NAMES.includes(name), name);
  }
  assert.match(String(icon('heart', { label: 'Fav "x"' })), /role="img" aria-label="Fav x"/);
  assert.match(String(icon('heart')), /aria-hidden="true"/);
});

test('las tarjetas escapan nombres y textos de los comercios', () => {
  const evil = '<script>alert(1)</script>';
  const card = String(productCard({ id: 'p1', name: evil, price: 1000, image: '', business: { name: evil, locality: evil }, trackStock: true, stock: 1 }));
  assert.doesNotMatch(card, /<script>/);
  assert.match(card, /&lt;script&gt;/);
  assert.match(card, /Últimas 1/);
  assert.doesNotMatch(String(storeCard({ slug: 'x', name: evil, category: evil, locality: '', tagline: evil })), /<script>/);
  const fair = String(fairCard({ slug: 'f', name: evil, venue: evil, locality: 'Neuquén', startsAt: '2026-04-12T13:00:00Z', endsAt: '2026-04-12T22:00:00Z',
    participants: 3, participantLogos: [], status: 'canceled', applicationsOpen: true, cover: '' }));
  assert.doesNotMatch(fair, /<script>/);
  assert.match(fair, /3 expositores confirmados/);
  assert.match(fair, /Cancelada/);
  assert.match(String(emptyState({ title: evil })), /&lt;script&gt;/);
  assert.match(String(banner('warn', evil)), /role="status"/);
  assert.match(String(stepper({ value: 1, max: 1 })), /aria-label="Restar uno" disabled/);
});
