// Invariantes del repositorio del entorno de demostración.
//
// Son las mismas comprobaciones que cubrían el repositorio anterior, ahora
// contra el que realmente usa la aplicación publicada. Las reglas viven en
// js/domain, así que lo que se verifica acá vale para los dos entornos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRepository, STORAGE_KEY } from '../js/repositories/local-repository.js';
import { createRepository } from '../js/repositories/repository-factory.js';
import { RUNTIME_ENV } from '../js/runtime-env.js';
import { CONFIG } from '../js/config.js';
import { initialState } from '../js/domain/state.js';
import { scopeOf, scopeKey, assertScope } from '../js/core/scope.js';
import { quoteCart } from '../js/core/cart.js';
import { isPricePending, knownStock, isCommerciallyPurchasable } from '../js/core/commercial.js';
import { requireTransition, allowedActions } from '../js/core/workflow-policy.js';
import { randomUuid } from '../js/core/identifiers.js';

const code = expected => error => error.code === expected;

function setup({ seed = initialState, storage: customStorage } = {}) {
  const values = new Map();
  const storage = customStorage || {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const repo = createLocalRepository({
    storage, uuid, locks: null, seed,
    clock: () => new Date(1789444800000 + counter * 1000).toISOString(),
  });
  return { repo, storage, values, uuid };
}

const CUSTOMER = { name: 'Cliente de prueba', phone: '2942123456', address: 'Calle de prueba 123', notes: '' };

async function asMerchant(repo, accountId = 'acc-orilla') {
  await repo.signInAsDemoIdentity(accountId);
  return repo;
}

async function placeOrder(repo, businessId = 'orilla', fulfillment = 'pickup', extra = {}) {
  const productId = businessId === 'orilla' ? 'burger-clasica' : 'pizza-muzza';
  await repo.command('cart.setQuantity', { businessId, productId, quantity: 1 });
  const requestId = await repo.command('cart.prepareRequest', { businessId });
  const payload = {
    businessId, requestId, fulfillment,
    customer: { ...CUSTOMER, zoneAcknowledged: true, ...extra.customer },
    paymentMethod: extra.paymentMethod,
  };
  return { order: await repo.command('order.create', payload), payload };
}

// ── ámbito y carritos ──

test('los carritos de dos comercios tienen claves distintas', async () => {
  const { repo } = setup();
  const orilla = await repo.query('business', { businessId: 'orilla' });
  const horno = await repo.query('business', { businessId: 'horno' });
  assert.notEqual(scopeKey(scopeOf(orilla), 'cart'), scopeKey(scopeOf(horno), 'cart'));
});

test('la localidad participa del ámbito', () => {
  assert.throws(
    () => assertScope({ businessId: 'orilla', localityId: 'otra' }, { businessId: 'orilla', localityId: 'alumine' }),
    code('TENANT_MISMATCH'));
});

test('identificadores inseguros no construyen claves', () => {
  assert.throws(() => scopeKey({ businessId: '../test', localityId: 'alumine' }, 'cart'), code('INVALID_SCOPE'));
});

test('un producto ajeno no entra al carrito', async () => {
  const { repo } = setup();
  await assert.rejects(
    repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'pizza-muzza', quantity: 1 }),
    code('TENANT_MISMATCH'));
});

test('dos carritos conservan su contenido separado', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'burger-clasica', quantity: 1 });
  await repo.command('cart.setQuantity', { businessId: 'horno', productId: 'pizza-muzza', quantity: 2 });
  assert.equal((await repo.query('cart', { businessId: 'orilla' })).lines[0].quantity, 1);
  assert.equal((await repo.query('cart', { businessId: 'horno' })).lines[0].quantity, 2);
});

test('el carrito persiste entre instancias', async () => {
  const { repo, storage } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 2 });
  const revived = createLocalRepository({ storage, locks: null });
  assert.equal((await revived.query('cart', { businessId: 'orilla' })).lines[0].quantity, 2);
});

for (const quantity of [-1, 1.5, NaN, Infinity, '2', 100]) {
  test(`rechaza cantidad inválida ${quantity}`, async () => {
    const { repo } = setup();
    await assert.rejects(
      repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity }),
      code('INVALID_QUANTITY'));
  });
}

test('cantidad cero elimina un producto', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 1 });
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 0 });
  assert.equal((await repo.query('cart', { businessId: 'orilla' })).lines.length, 0);
});

// ── precios y disponibilidad ──

for (const price of [null, undefined, '', 0, -1, NaN, Infinity]) {
  test(`precio no comercial ${String(price)} bloqueado`, () => {
    assert.equal(isPricePending({ price, priceStatus: 'confirmed' }), true);
  });
}

test('price_status pendiente prevalece sobre camelCase confirmado', () => {
  assert.equal(isPricePending({ price: 10, priceStatus: 'confirmed', price_status: 'pending' }), true);
});

test('stock desconocido no es stock cero', () => {
  assert.equal(knownStock({ stock: null }), null);
  assert.equal(knownStock({ stock: 0 }), 0);
});

test('un producto archivado no es comprable', () => {
  assert.equal(isCommerciallyPurchasable({ price: 10, stock: 1, available: true, archived: true }), false);
});

// ── cotización ──

test('retirar no cobra envío', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'burger-clasica', quantity: 1 });
  const quote = await repo.query('quote', { businessId: 'orilla', fulfillment: 'pickup' });
  assert.equal(quote.deliveryFee, 0);
  assert.equal(quote.total, 10500);
});

test('delivery usa solo la tarifa del comercio', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'burger-clasica', quantity: 1 });
  assert.equal((await repo.query('quote', { businessId: 'orilla', fulfillment: 'delivery' })).total, 12000);
});

test('pedido mínimo se calcula sobre los productos', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 1 });
  await assert.rejects(repo.query('quote', { businessId: 'orilla', fulfillment: 'delivery' }), code('MINIMUM_ORDER'));
});

test('un comercio cerrado no admite pedidos', async () => {
  const { repo } = setup();
  await asMerchant(repo);
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'burger-clasica', quantity: 1 });
  await repo.command('business.setOpen', { businessId: 'orilla', open: false });
  await assert.rejects(repo.query('quote', { businessId: 'orilla' }), code('BUSINESS_CLOSED'));
});

test('se rechazan productos duplicados', () => {
  const state = initialState();
  const business = state.businesses[0];
  assert.throws(() => quoteCart(
    { ...scopeOf(business), lines: [{ productId: 'papas', quantity: 1 }, { productId: 'papas', quantity: 1 }] },
    business, state.products), code('DUPLICATE_PRODUCT'));
});

// ── pedidos ──

test('pedido descuenta stock y vacía solo su carrito', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'horno', productId: 'pizza-muzza', quantity: 1 });
  await placeOrder(repo);
  const products = await repo.query('products', { businessId: 'orilla' });
  assert.equal(products.find(product => product.id === 'burger-clasica').stock, 29);
  assert.equal((await repo.query('cart', { businessId: 'orilla' })).lines.length, 0);
  assert.equal((await repo.query('cart', { businessId: 'horno' })).lines.length, 1);
});

test('reintento idempotente no crea ni descuenta dos veces', async () => {
  const { repo } = setup();
  const { order, payload } = await placeOrder(repo);
  const repeat = await repo.command('order.create', payload);
  assert.equal(repeat.id, order.id);
  assert.equal((await repo.query('myOrders')).length, 1);
  const products = await repo.query('products', { businessId: 'orilla' });
  assert.equal(products.find(product => product.id === 'burger-clasica').stock, 29);
});

test('misma clave y distinto payload se rechazan', async () => {
  const { repo } = setup();
  const { payload } = await placeOrder(repo);
  await assert.rejects(
    repo.command('order.create', { ...payload, customer: { ...payload.customer, name: 'Otro ejemplo' } }),
    code('IDEMPOTENCY_CONFLICT'));
});

test('la clave de intento es durable entre instancias', async () => {
  const { repo, storage } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 1 });
  const first = await repo.command('cart.prepareRequest', { businessId: 'orilla' });
  const revived = createLocalRepository({ storage, locks: null });
  assert.equal(await revived.command('cart.prepareRequest', { businessId: 'orilla' }), first);
});

test('modificar cantidades invalida el intento anterior', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 1 });
  const first = await repo.command('cart.prepareRequest', { businessId: 'orilla' });
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 2 });
  assert.notEqual(await repo.command('cart.prepareRequest', { businessId: 'orilla' }), first);
});

test('el importe se recalcula y se ignora cualquier total enviado por el cliente', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'burger-clasica', quantity: 1 });
  const requestId = await repo.command('cart.prepareRequest', { businessId: 'orilla' });
  const order = await repo.command('order.create', {
    businessId: 'orilla', requestId, fulfillment: 'pickup', customer: CUSTOMER,
    total: 1, subtotal: 1, lines: [{ productId: 'burger-clasica', quantity: 1, unitPrice: 1 }],
  });
  assert.equal(order.total, 10500);
});

test('pedido con envío exige dirección', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'burger-clasica', quantity: 1 });
  const requestId = await repo.command('cart.prepareRequest', { businessId: 'orilla' });
  await assert.rejects(repo.command('order.create', {
    businessId: 'orilla', requestId, fulfillment: 'delivery',
    customer: { ...CUSTOMER, address: '' },
  }), code('ADDRESS_REQUIRED'));
});

test('Mercado Pago permanece bloqueado en el repositorio', async () => {
  const { repo } = setup();
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 1 });
  const requestId = await repo.command('cart.prepareRequest', { businessId: 'orilla' });
  await assert.rejects(repo.command('order.create', {
    businessId: 'orilla', requestId, fulfillment: 'pickup', customer: CUSTOMER, paymentMethod: 'mercadopago',
  }), code('PAYMENTS_DISABLED'));
});

test('no hay fallback de producción hacia demostración', () => {
  assert.throws(() => createRepository({ ...CONFIG, mode: 'production' }, { runtime: RUNTIME_ENV }),
    code('PRODUCTION_NOT_IMPLEMENTED'));
  assert.throws(() => createRepository({ ...CONFIG, livePayments: true }, { runtime: RUNTIME_ENV }),
    code('PRODUCTION_NOT_IMPLEMENTED'));
});

test('sin entorno declarado no se construye ningún repositorio', () => {
  assert.throws(() => createRepository(CONFIG, {}), code('RUNTIME_ENV_MISSING'));
  assert.throws(() => createRepository(CONFIG, { runtime: { environment: 'produccion' } }), code('UNKNOWN_ENVIRONMENT'));
});

// ── aislamiento y transiciones ──

test('el panel de un comercio no enumera pedidos de otro', async () => {
  const { repo } = setup();
  await placeOrder(repo, 'orilla');
  await placeOrder(repo, 'horno');
  await asMerchant(repo);
  const orders = await repo.query('businessOrders', { businessId: 'orilla' });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].businessId, 'orilla');
});

test('un comercio no accede a pedidos de otro', async () => {
  const { repo } = setup();
  await placeOrder(repo, 'horno');
  await asMerchant(repo);
  await assert.rejects(repo.query('businessOrders', { businessId: 'horno' }), code('TENANT_MISMATCH'));
});

test('estado desconocido no se normaliza a uno autorizado', () => {
  assert.throws(() => requireTransition({ status: 'desconocido' }, 'accepted', { kind: 'merchant' }), code('INVALID_STATUS'));
});

test('el flujo de retiro no entra a reparto', async () => {
  const { repo } = setup();
  let { order } = await placeOrder(repo, 'orilla', 'pickup');
  await asMerchant(repo);
  for (const nextStatus of ['accepted', 'preparing', 'ready']) {
    order = await repo.command('order.transition', { orderId: order.id, expectedVersion: order.version, nextStatus });
  }
  const business = await repo.query('business', { businessId: 'orilla' });
  assert.deepEqual(allowedActions(order, { kind: 'merchant', ...scopeOf(business) }), ['delivered', 'canceled']);
  await assert.rejects(repo.command('order.transition', {
    orderId: order.id, expectedVersion: order.version, nextStatus: 'assigned', riderId: 'rider-orilla',
  }), code('TRANSITION_FORBIDDEN'));
});

test('circuito completo de envío con reparto propio', async () => {
  const { repo } = setup();
  let { order } = await placeOrder(repo, 'orilla', 'delivery');
  await asMerchant(repo);
  for (const nextStatus of ['accepted', 'preparing', 'ready', 'assigned']) {
    order = await repo.command('order.transition', {
      orderId: order.id, expectedVersion: order.version, nextStatus, riderId: 'rider-orilla',
    });
  }
  for (const nextStatus of ['picked_up', 'on_the_way', 'arrived', 'delivered']) {
    order = await repo.command('order.transition', { orderId: order.id, expectedVersion: order.version, nextStatus });
  }
  assert.equal(order.status, 'delivered');
  assert.equal(order.history.length, 9);
});

test('no se asigna un repartidor de otro comercio', async () => {
  const { repo } = setup();
  let { order } = await placeOrder(repo, 'orilla', 'delivery');
  await asMerchant(repo);
  for (const nextStatus of ['accepted', 'preparing', 'ready']) {
    order = await repo.command('order.transition', { orderId: order.id, expectedVersion: order.version, nextStatus });
  }
  await assert.rejects(repo.command('order.transition', {
    orderId: order.id, expectedVersion: order.version, nextStatus: 'assigned', riderId: 'rider-horno',
  }), code('TENANT_MISMATCH'));
});

test('una versión de pedido obsoleta no sobreescribe el estado', async () => {
  const { repo } = setup();
  const { order } = await placeOrder(repo);
  await asMerchant(repo);
  await repo.command('order.transition', { orderId: order.id, expectedVersion: 1, nextStatus: 'accepted' });
  await assert.rejects(
    repo.command('order.transition', { orderId: order.id, expectedVersion: 1, nextStatus: 'preparing' }),
    code('STALE_ORDER'));
});

test('cancelar devuelve stock una única vez', async () => {
  const { repo } = setup();
  const { order } = await placeOrder(repo);
  await repo.command('order.transition', { orderId: order.id, expectedVersion: 1, nextStatus: 'canceled' });
  const afterCancel = await repo.query('products', { businessId: 'orilla' });
  assert.equal(afterCancel.find(product => product.id === 'burger-clasica').stock, 30);
  await asMerchant(repo);
  await assert.rejects(
    repo.command('order.transition', { orderId: order.id, expectedVersion: 2, nextStatus: 'canceled', reason: 'otra vez' }),
    code('TRANSITION_FORBIDDEN'));
  const afterRetry = await repo.query('products', { businessId: 'orilla' });
  assert.equal(afterRetry.find(product => product.id === 'burger-clasica').stock, 30);
});

// ── catálogo ──

test('no se cambia el propietario de un producto mediante patch', async () => {
  const { repo } = setup();
  await asMerchant(repo);
  await assert.rejects(
    repo.command('product.update', { businessId: 'orilla', productId: 'papas', patch: { businessId: 'horno' } }),
    code('EMPTY_PATCH'));
  const product = (await repo.query('products', { businessId: 'orilla' })).find(item => item.id === 'papas');
  assert.equal(product.businessId, 'orilla');
});

test('el comercio no cambia precios ajenos', async () => {
  const { repo } = setup();
  await asMerchant(repo);
  await assert.rejects(
    repo.command('product.update', { businessId: 'horno', productId: 'pizza-muzza', patch: { price: 1 } }),
    code('TENANT_MISMATCH'));
});

test('editar precio actualiza la cotización', async () => {
  const { repo } = setup();
  await asMerchant(repo);
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 1 });
  await repo.command('product.update', { businessId: 'orilla', productId: 'papas', patch: { price: 6000 } });
  assert.equal((await repo.query('quote', { businessId: 'orilla' })).total, 6000);
});

// ── almacenamiento ──

test('fallo de escritura no se presenta como guardado', async () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const { repo } = setup({ storage });
  await assert.rejects(
    repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 1 }),
    code('STORAGE_WRITE_FAILED'));
});

test('datos corruptos no se borran silenciosamente', async () => {
  const { repo, values } = setup();
  values.set(STORAGE_KEY, 'roto');
  await assert.rejects(repo.query('publicBusinesses'), code('CORRUPT_STORAGE'));
  assert.equal(values.get(STORAGE_KEY), 'roto');
});

test('dos pedidos simultáneos no sobrevenden', async () => {
  const seed = () => {
    const state = initialState();
    state.products.find(product => product.id === 'papas').stock = 1;
    return state;
  };
  const { repo } = setup({ seed });
  await repo.command('cart.setQuantity', { businessId: 'orilla', productId: 'papas', quantity: 1 });
  const requestId = await repo.command('cart.prepareRequest', { businessId: 'orilla' });
  const payload = { businessId: 'orilla', requestId, fulfillment: 'pickup', customer: CUSTOMER };
  const results = await Promise.allSettled([
    repo.command('order.create', payload),
    repo.command('order.create', payload),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2, 'el reintento idéntico devuelve el mismo pedido');
  const ids = new Set(results.map(result => result.value.id));
  assert.equal(ids.size, 1, 'se creó un único pedido');
  const products = await repo.query('products', { businessId: 'orilla' });
  assert.equal(products.find(product => product.id === 'papas').stock, 0);
});

test('las lecturas devuelven copias, no el estado interno', async () => {
  const { repo } = setup();
  const businesses = await repo.query('publicBusinesses');
  businesses[0].name = 'alterado';
  const again = await repo.query('publicBusinesses');
  assert.notEqual(again[0].name, 'alterado');
});

// ── identificadores ──

test('UUID alternativo usa aleatoriedad criptográfica y bits v4', () => {
  assert.match(randomUuid({ getRandomValues: bytes => bytes.fill(9) }),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('sin fuente segura no se generan identificadores débiles', () => {
  assert.throws(() => randomUuid({}), code('CRYPTO_UNAVAILABLE'));
});
