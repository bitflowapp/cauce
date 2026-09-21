// Variantes simples de producto: identidad de línea, precio y stock compartido.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRepository } from '../js/repositories/local-repository.js';
import { initialState } from '../js/domain/state.js';
import { normalizeVariants, MAX_PRODUCT_VARIANTS } from '../js/core/catalog-rules.js';
import { changeQuantity, quoteCart, resolveVariant, lineUnitPrice } from '../js/core/cart.js';
import { scopeOf } from '../js/core/scope.js';

const code = expected => error => error.code === expected;

function setup() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  return createLocalRepository({ storage, uuid, locks: null, seed: initialState, clock: () => new Date().toISOString() });
}

async function withVariants(repo) {
  await repo.signInAsDemoIdentity('acc-orilla');
  return repo.command('product.create', {
    businessId: 'orilla',
    product: {
      name: 'Limonada por tamaño',
      description: 'Limón, menta y jengibre.',
      category: 'Bebidas',
      price: 2500,
      stock: 10,
      available: true,
      variants: [
        { name: 'Chica', priceDelta: 0 },
        { name: 'Grande', priceDelta: 1200 },
        { name: 'Promoción', priceDelta: -300 },
      ],
    },
  });
}

test('las variantes se normalizan con nombre e identificador propios', () => {
  const variants = normalizeVariants([{ name: ' Grande ', priceDelta: 1200 }, { name: 'Chica' }]);
  assert.equal(variants.length, 2);
  assert.equal(variants[0].name, 'Grande');
  assert.equal(variants[0].id, 'grande');
  assert.equal(variants[1].priceDelta, 0);
});

test('se rechazan variantes repetidas, sin nombre, con precio inválido o de más', () => {
  assert.throws(() => normalizeVariants([{ name: 'Grande' }, { name: 'grande' }]), code('DUPLICATE_VARIANT'));
  assert.throws(() => normalizeVariants([{ name: 'X' }]), code('INVALID_VARIANT'));
  assert.throws(() => normalizeVariants([{ name: 'Grande', priceDelta: 1.5 }]), code('INVALID_VARIANT_PRICE'));
  const tooMany = Array.from({ length: MAX_PRODUCT_VARIANTS + 1 }, (unused, index) => ({ name: `Opción ${index}` }));
  assert.throws(() => normalizeVariants(tooMany), code('TOO_MANY_VARIANTS'));
});

test('un producto con variantes exige elegir una', () => {
  const product = { id: 'p', businessId: 'b', localityId: 'l', price: 1000, stock: 5, available: true,
    variants: [{ id: 'chica', name: 'Chica', priceDelta: 0 }] };
  assert.throws(() => resolveVariant(product, null), code('VARIANT_REQUIRED'));
  assert.throws(() => resolveVariant(product, 'inexistente'), code('VARIANT_NOT_FOUND'));
  assert.equal(resolveVariant(product, 'chica').name, 'Chica');
});

test('la variante ajusta el precio unitario sobre el precio base', () => {
  const product = { price: 2500, priceStatus: 'confirmed', stock: 5, available: true };
  assert.equal(lineUnitPrice(product, null), 2500);
  assert.equal(lineUnitPrice(product, { priceDelta: 1200 }), 3700);
  assert.equal(lineUnitPrice(product, { priceDelta: -300 }), 2200);
  assert.throws(() => lineUnitPrice({ price: 100, priceStatus: 'confirmed' }, { priceDelta: -100 }), code('INVALID_PRICE'));
});

test('dos variantes del mismo producto son dos líneas distintas', () => {
  const scope = { businessId: 'orilla', localityId: 'alumine' };
  const product = { id: 'limonada', ...scope, price: 2500, priceStatus: 'confirmed', stock: 10, available: true,
    variants: [{ id: 'chica', name: 'Chica', priceDelta: 0 }, { id: 'grande', name: 'Grande', priceDelta: 1200 }] };
  let cart = { ...scope, version: 1, lines: [] };
  cart = changeQuantity(cart, product, 1, 'chica');
  cart = changeQuantity(cart, product, 2, 'grande');
  assert.equal(cart.lines.length, 2);
  // Cambiar una no toca la otra.
  cart = changeQuantity(cart, product, 0, 'chica');
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0].variantId, 'grande');
});

test('la cotización nombra la variante y suma su diferencia', () => {
  const scope = { businessId: 'orilla', localityId: 'alumine' };
  const product = { id: 'limonada', ...scope, name: 'Limonada', price: 2500, priceStatus: 'confirmed',
    stock: 10, available: true, archived: false,
    variants: [{ id: 'chica', name: 'Chica', priceDelta: 0 }, { id: 'grande', name: 'Grande', priceDelta: 1200 }] };
  const business = { id: 'orilla', localityId: 'alumine', active: true, open: true, pickupEnabled: true,
    deliveryEnabled: false, deliveryFee: 0, minimumOrder: 0 };
  const cart = { ...scope, version: 1, lines: [
    { productId: 'limonada', variantId: 'chica', quantity: 1 },
    { productId: 'limonada', variantId: 'grande', quantity: 2 },
  ] };
  const quote = quoteCart(cart, business, [product], 'pickup');
  assert.equal(quote.lines[0].name, 'Limonada · Chica');
  assert.equal(quote.lines[1].name, 'Limonada · Grande');
  assert.equal(quote.lines[1].unitPrice, 3700);
  assert.equal(quote.subtotal, 2500 + 3700 * 2);
});

test('el stock es del producto y lo comparten sus variantes', () => {
  const scope = { businessId: 'orilla', localityId: 'alumine' };
  const product = { id: 'limonada', ...scope, name: 'Limonada', price: 2500, priceStatus: 'confirmed',
    stock: 3, available: true, archived: false,
    variants: [{ id: 'chica', name: 'Chica', priceDelta: 0 }, { id: 'grande', name: 'Grande', priceDelta: 1200 }] };
  const business = { id: 'orilla', localityId: 'alumine', active: true, open: true, pickupEnabled: true,
    deliveryEnabled: false, deliveryFee: 0, minimumOrder: 0 };
  const cart = { ...scope, version: 1, lines: [
    { productId: 'limonada', variantId: 'chica', quantity: 2 },
    { productId: 'limonada', variantId: 'grande', quantity: 2 },
  ] };
  assert.throws(() => quoteCart(cart, business, [product], 'pickup'), code('INSUFFICIENT_STOCK'));
});

test('circuito completo: el comercio publica variantes y se compra una', async () => {
  const repo = setup();
  const product = await withVariants(repo);
  assert.equal(product.variants.length, 3);

  await repo.signOut();
  await repo.command('cart.setQuantity', {
    businessId: 'orilla', productId: product.id, quantity: 2, variantId: 'grande',
  });
  const quote = await repo.query('quote', { businessId: 'orilla', fulfillment: 'pickup' });
  assert.equal(quote.lines[0].unitPrice, 3700);
  assert.equal(quote.total, 7400);

  const requestId = await repo.command('cart.prepareRequest', { businessId: 'orilla' });
  const order = await repo.command('order.create', {
    businessId: 'orilla', requestId, fulfillment: 'pickup',
    customer: { name: 'Vecina de prueba', phone: '2942123456' },
  });
  assert.equal(order.total, 7400);
  assert.match(order.lines[0].name, /Grande/);

  const after = await repo.query('products', { businessId: 'orilla' });
  assert.equal(after.find(item => item.id === product.id).stock, 8);
});

test('sin elegir variante no se puede agregar un producto que las tiene', async () => {
  const repo = setup();
  const product = await withVariants(repo);
  await repo.signOut();
  await assert.rejects(
    repo.command('cart.setQuantity', { businessId: 'orilla', productId: product.id, quantity: 1 }),
    code('VARIANT_REQUIRED'));
});

test('los productos sin variantes siguen funcionando igual', async () => {
  const repo = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'burger-clasica', quantity: 1 });
  const cart = await repo.query('cart', { businessId: 'orilla' });
  assert.equal(cart.lines[0].variantId, null);
  assert.equal((await repo.query('quote', { businessId: 'orilla' })).total, 10500);
});
