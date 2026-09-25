// Vidriera: tarjeta de comercio, fila de producto, carrito y totales. Lo que
// carga el comercio siempre se escapa, y lo que no se puede pedir lo dice una
// sola vez.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  businessCard, businessFacts, productCard, cartBar, cartSubtotal, cartLines, fulfillmentSwitch, catalogJump, totalsList,
  unavailableReason, storeHeader,
} from '../js/ui/storefront.js';

const business = (extra = {}) => ({ id: 'b1', name: 'Almacén <b>Pehuén</b>', category: 'Almacén', open: true,
  pickupEnabled: true, deliveryEnabled: true, deliveryFee: 1500, minimumOrder: 5000, prepMinutes: 15, deliveryMinutes: 30,
  address: 'Conrado Villegas 245', deliveryZone: 'Casco urbano', ...extra });
const product = (extra = {}) => ({ id: 'p1', businessId: 'b1', localityId: 'alumine', name: 'Yerba "mate"', description: 'Con palo',
  price: 4800, stock: 10, trackStock: true, available: true, archived: false, variants: [], ...extra });

test('la tarjeta del comercio dice cómo llega, cuánto sale y cuándo está listo', () => {
  const html = businessCard(business());
  assert.ok(html.includes('Almacén &lt;b&gt;Pehuén&lt;/b&gt;'), 'el nombre se escapa');
  for (const text of ['Retiro', 'Envío', '1.500', 'Mínimo', '5.000', 'Listo en ~15 min', 'Abierto']) {
    assert.ok(html.includes(text), `falta "${text}"`);
  }
  assert.match(html, /class="catalog-merchant-card store-card "/);
  const closed = businessCard(business({ open: false }));
  assert.match(closed, /store-card is-closed/);
  assert.match(closed, /availability closed">Cerrado</);
  assert.deepEqual(businessFacts(business({ pickupEnabled: false, deliveryEnabled: false, prepMinutes: 0 })), []);
  assert.match(businessCard(business({ pickupEnabled: false, deliveryEnabled: false, prepMinutes: 0 })), /Modalidades a confirmar/);
});

test('la cabecera de la ficha no repite datos y escapa lo cargado', () => {
  const html = storeHeader(business({ subtitle: '<i>regional</i>' }), { times: 'Preparación: ~15 min' });
  assert.ok(html.includes('&lt;i&gt;regional&lt;/i&gt;'));
  assert.ok(html.includes('Envíos en: Casco urbano.'));
  assert.equal((html.match(/Preparación/g) || []).length, 1);
});

test('la fila de producto ofrece un solo botón y la cantidad cuando ya está en el carrito', () => {
  const fresh = productCard(product(), { businessId: 'b1', lines: [] });
  assert.ok(fresh.includes('Yerba &quot;mate&quot;'));
  assert.equal((fresh.match(/>Agregar</g) || []).length, 1);
  assert.match(fresh, /data-action="set-quantity"[^>]*data-quantity="1"/);
  const inCart = productCard(product(), { businessId: 'b1', lines: [{ productId: 'p1', variantId: null, quantity: 2 }] });
  assert.doesNotMatch(inCart, />Agregar</);
  assert.match(inCart, /aria-label="Agregar una unidad"/);
  assert.match(inCart, /aria-label="Quitar una unidad"/);
  assert.match(inCart, /qty-value" aria-live="polite">2</);
  // Tope de stock: el "+" se deshabilita.
  const full = productCard(product({ stock: 2 }), { businessId: 'b1', lines: [{ productId: 'p1', variantId: null, quantity: 2 }] });
  assert.match(full, /data-quantity="3" disabled/);
});

test('un producto que no se puede pedir lo dice una vez y no ofrece botón', () => {
  for (const [extra, reason] of [[{ available: false }, 'Agotado por hoy'], [{ stock: 0 }, 'Sin stock']]) {
    const html = productCard(product(extra), { businessId: 'b1', lines: [] });
    assert.equal((html.match(new RegExp(reason, 'g')) || []).length, 1, reason);
    assert.doesNotMatch(html, /No disponible/);
    assert.doesNotMatch(html, /data-action="set-quantity"/);
    assert.match(html, /is-unavailable/);
  }
  assert.equal(unavailableReason(product({ available: false })), 'Agotado por hoy');
});

test('con opciones de distinto precio se muestra el más bajo como "desde"', () => {
  const variants = [{ id: 'v1', name: 'Chica', priceDelta: -2000 }, { id: 'v2', name: 'Grande', priceDelta: 1500 }];
  const html = productCard(product({ price: 8000, variants }), { businessId: 'b1', lines: [] });
  assert.match(html, /<span class="quiet">desde<\/span> \$\s?6\.000/);
  assert.equal((html.match(/class="variant-row"/g) || []).length, 2);
  const same = productCard(product({ price: 8000, variants: [{ id: 'v1', name: 'Única', priceDelta: 0 }] }), { businessId: 'b1', lines: [] });
  assert.doesNotMatch(same, /desde/);
});

test('la barra del carrito muestra cuánto va sumando y lleva al carrito', () => {
  assert.equal(cartBar('b1', { units: 0, subtotal: 0 }), '');
  const html = cartBar('b1', { units: 3, subtotal: 7200 });
  assert.match(html, /3 productos en el carrito/);
  assert.match(html, /7\.200/);
  assert.match(html, /<a class="button" href="#carrito\/b1">Ver carrito<\/a>/);
});

test('el subtotal a la vista ignora lo que ya no se puede pedir y suma las opciones', () => {
  const products = [product(), product({ id: 'p2', price: 1000, variants: [{ id: 'v1', name: 'Grande', priceDelta: 500 }] }),
    product({ id: 'p3', archived: true })];
  const lines = [{ productId: 'p1', variantId: null, quantity: 2 }, { productId: 'p2', variantId: 'v1', quantity: 1 },
    { productId: 'p3', variantId: null, quantity: 4 }, { productId: 'nada', variantId: null, quantity: 1 }];
  assert.equal(cartSubtotal(lines, products), 2 * 4800 + 1500);
});

test('retiro o envío con su costo, y totales sin sorpresas', () => {
  const both = fulfillmentSwitch(business(), ['pickup', 'delivery'], 'delivery');
  assert.match(both, /data-mode="pickup" aria-pressed="false"/);
  assert.match(both, /data-mode="delivery" aria-pressed="true"/);
  assert.match(both, /Sin costo/);
  assert.match(both, /1\.500/);
  assert.match(fulfillmentSwitch(business(), ['pickup'], 'pickup'), /Retiro en el comercio/);
  const totals = totalsList({ subtotal: 6000, deliveryFee: 1500, total: 7500 }, 'delivery');
  for (const text of ['Subtotal', '6.000', 'Envío', '1.500', 'Total', '7.500']) assert.ok(totals.includes(text), text);
  assert.match(totalsList({ subtotal: 6000, deliveryFee: 0, total: 6000 }, 'pickup'), /Retiro<\/dt><dd>Sin costo/);
});

test('las líneas del carrito se pueden quitar cuando el producto ya no está', () => {
  const html = cartLines([
    { line: { productId: 'p1', variantId: null, quantity: 2 }, product: product(), variant: null, unavailable: false },
    { line: { productId: 'p9', variantId: null, quantity: 1 }, product: null, variant: null, unavailable: true },
  ], 'b1');
  assert.match(html, /aria-label="Quitar una unidad de Yerba &quot;mate&quot;"/);
  assert.match(html, /Ya no está disponible/);
  assert.match(html, /data-product="p9" data-quantity="0">Quitar</);
});

test('las categorías se saltan sin tocar la dirección', () => {
  assert.equal(catalogJump(['Almacén']), '');
  const html = catalogJump(['Almacén', 'Bebidas <x>']);
  assert.match(html, /data-action="jump-category"\s+data-target="cat-1">Bebidas &lt;x&gt;</);
  assert.doesNotMatch(html, /href="#/);
});
