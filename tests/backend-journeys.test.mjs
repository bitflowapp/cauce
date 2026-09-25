// Recorridos completos contra el backend local, con sesiones autenticadas
// independientes (cada cliente tiene su propia cookie de sesión).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, expectOk, expectFail, publishBusiness } from './lib/api-client.mjs';

const PASSWORD = 'clavedeprueba123';

let harness;
before(async () => { harness = await startTestServer(); });
after(async () => { await harness.close(); });

async function accounts(prefix) {
  const merchant = harness.client(`${prefix}-comercio`);
  const admin = harness.client(`${prefix}-admin`);
  const customer = harness.client(`${prefix}-clienta`);
  expectOk(await merchant.register({ email: `${prefix}-m@cauce.test`, name: 'Responsable comercio', phone: '2942111111', password: PASSWORD }));
  expectOk(await admin.register({ email: `${prefix}-a@cauce.test`, name: 'Administración', phone: '2942222222', password: PASSWORD }));
  expectOk(await customer.register({ email: `${prefix}-c@cauce.test`, name: 'Vecina de prueba', phone: '2942333333', password: PASSWORD }));
  harness.grantAdmin(`${prefix}-a@cauce.test`);
  return { merchant, admin, customer };
}

describe('recorrido 1 · alta y publicación de un comercio', () => {
  test('el comercio recorre borrador, revisión y publicación', async () => {
    const { merchant, admin, customer } = await accounts('alta');

    const business = expectOk(await merchant.command('business.create', { name: 'Verdulería del Río', category: 'Almacén' }));
    assert.equal(business.status, 'draft');
    assert.equal(business.active, false);

    // Un comercio en borrador no aparece en el listado público.
    const publicBefore = expectOk(await customer.query('publicBusinesses'));
    assert.ok(!publicBefore.some(item => item.id === business.id));

    expectFail(await merchant.command('business.submit', { businessId: business.id }),
      'INCOMPLETE_BUSINESS', 'enviar sin datos');

    expectOk(await merchant.command('business.update', {
      businessId: business.id,
      patch: {
        ownerName: 'Responsable', contactPhone: '2942111111', address: 'Av. principal 10',
        hoursLabel: 'Lunes a viernes de 9 a 18', pickupEnabled: true, deliveryEnabled: false,
      },
    }));
    expectFail(await merchant.command('business.submit', { businessId: business.id }),
      'INCOMPLETE_BUSINESS', 'enviar sin catálogo');

    expectOk(await merchant.command('product.create', {
      businessId: business.id,
      product: { name: 'Manzanas por kilo', price: 2500, category: 'Almacén', available: true, stock: 20, description: 'Fruta de estación' },
    }));

    const submitted = expectOk(await merchant.command('business.submit', { businessId: business.id }));
    assert.equal(submitted.status, 'pending_review');

    // Mientras está en revisión, el comercio no puede seguir editando.
    expectFail(await merchant.command('business.update', { businessId: business.id, patch: { address: 'Otra calle 20' } }),
      'BUSINESS_LOCKED', 'editar en revisión');

    const returned = expectOk(await admin.command('admin.reviewBusiness', {
      businessId: business.id, decision: 'return', note: 'Falta indicar el horario de la tarde.',
    }));
    assert.equal(returned.status, 'returned');
    assert.match(returned.reviewNote, /horario/i);

    expectOk(await merchant.command('business.update', { businessId: business.id, patch: { hoursLabel: 'Lunes a viernes de 9 a 13 y de 17 a 20' } }));
    expectOk(await merchant.command('business.submit', { businessId: business.id }));
    const approved = expectOk(await admin.command('admin.reviewBusiness', { businessId: business.id, decision: 'approve' }));
    assert.equal(approved.status, 'active');
    assert.equal(approved.active, true);

    const publicAfter = expectOk(await customer.query('publicBusinesses'));
    assert.ok(publicAfter.some(item => item.id === business.id));
  });

  test('la devolución exige un motivo utilizable', async () => {
    const { merchant, admin } = await accounts('motivo');
    const business = expectOk(await merchant.command('business.create', { name: 'Panadería motivo', category: 'Panadería' }));
    expectOk(await merchant.command('business.update', {
      businessId: business.id,
      patch: {
        ownerName: 'Responsable', contactPhone: '2942111111', address: 'Calle 5',
        hoursLabel: 'Todos los días de 8 a 13', pickupEnabled: true, deliveryEnabled: false,
      },
    }));
    expectOk(await merchant.command('product.create', {
      businessId: business.id,
      product: { name: 'Pan francés', price: 2000, category: 'Panadería', available: true, stock: 5, description: 'Por kilo' },
    }));
    expectOk(await merchant.command('business.submit', { businessId: business.id }));
    expectFail(await admin.command('admin.reviewBusiness', { businessId: business.id, decision: 'return', note: 'no' }),
      'REVIEW_NOTE_REQUIRED', 'devolver con un motivo vacío');
    const returned = expectOk(await admin.command('admin.reviewBusiness', {
      businessId: business.id, decision: 'return', note: 'Falta la dirección exacta y una referencia.',
    }));
    assert.equal(returned.status, 'returned');
  });

  test('la cola de revisión y la aprobación son exclusivas de administración', async () => {
    const { merchant, admin, customer } = await accounts('permisos');
    const business = expectOk(await merchant.command('business.create', { name: 'Kiosco permisos', category: 'Almacén' }));
    expectFail(await merchant.query('adminQueue'), 'ROLE_REQUIRED', 'comercio consultando la cola');
    expectFail(await customer.query('adminQueue'), 'ROLE_REQUIRED', 'clienta consultando la cola');
    expectFail(await customer.command('admin.reviewBusiness', { businessId: business.id, decision: 'approve' }),
      'ROLE_REQUIRED', 'clienta aprobando');
    expectOk(await admin.query('adminQueue'));
  });
});

describe('recorrido 2 · compra, gestión y reparto', () => {
  test('retiro: recibido, aceptado, en preparación, listo y retirado', async () => {
    const { merchant, admin, customer } = await accounts('retiro');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Rotisería retiro', delivery: false });

    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 2 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));
    const order = expectOk(await customer.command('order.create', {
      businessId: business.id, requestId, fulfillment: 'pickup', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333' },
    }));
    assert.equal(order.status, 'submitted');
    assert.equal(order.total, 6000, 'el total se recalcula en el servidor');

    let current = order;
    for (const next of ['accepted', 'preparing', 'ready', 'delivered']) {
      current = expectOk(await merchant.command('order.transition', {
        orderId: current.id, expectedVersion: current.version, nextStatus: next,
      }), `transición a ${next}`);
      assert.equal(current.status, next);
    }
    assert.equal(current.history.length, 5);
  });

  test('envío: el pedido llega hasta entregado con repartidor propio del comercio', async () => {
    const { merchant, admin, customer } = await accounts('envio');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Almacén envío', delivery: true });

    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 1 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));

    expectFail(await customer.command('order.create', {
      businessId: business.id, requestId, fulfillment: 'delivery', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333', address: 'Calle 1 Nº 200' },
    }), 'ZONE_NOT_CONFIRMED', 'envío sin confirmar la zona de cobertura');

    const order = expectOk(await customer.command('order.create', {
      businessId: business.id, requestId, fulfillment: 'delivery', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333', address: 'Calle 1 Nº 200', zoneAcknowledged: true },
    }));
    assert.equal(order.deliveryFee, 1200);
    assert.equal(order.total, order.subtotal + order.deliveryFee);
    assert.ok(order.deliveryCode, 'el envío genera código de entrega');

    // Un comercio nuevo no tiene reparto: lo da de alta el propio comercio.
    assert.equal(expectOk(await merchant.query('riders', { businessId: business.id })).length, 0);
    expectOk(await merchant.command('rider.create', { businessId: business.id, name: 'Reparto propio', phone: '2942777777' }));
    const riders = expectOk(await merchant.query('riders', { businessId: business.id }));
    assert.equal(riders.length, 1);

    let current = order;
    for (const next of ['accepted', 'preparing', 'ready']) {
      current = expectOk(await merchant.command('order.transition', {
        orderId: current.id, expectedVersion: current.version, nextStatus: next,
      }));
    }
    current = expectOk(await merchant.command('order.transition', {
      orderId: current.id, expectedVersion: current.version, nextStatus: 'assigned', riderId: riders[0]?.id,
    }), 'asignar repartidor');
    assert.equal(current.riderId, riders[0].id);

    // El motor heredado exige marcar la llegada antes de la entrega.
    for (const next of ['picked_up', 'on_the_way', 'arrived', 'delivered']) {
      current = expectOk(await merchant.command('order.transition', {
        orderId: current.id, expectedVersion: current.version, nextStatus: next,
      }), `transición a ${next}`);
    }
    assert.equal(current.status, 'delivered');
    assert.ok(current.deliveryCode.confirmedAt, 'la entrega confirma el código');
  });

  test('carritos separados por comercio', async () => {
    const { merchant, admin, customer } = await accounts('carritos');
    const first = await publishBusiness(harness, { merchant, admin, name: 'Comercio uno', delivery: false });
    const second = await publishBusiness(harness, { merchant, admin, name: 'Comercio dos', delivery: false });

    expectOk(await customer.command('cart.setQuantity', { businessId: first.business.id, productId: first.product.id, quantity: 2 }));
    expectOk(await customer.command('cart.setQuantity', { businessId: second.business.id, productId: second.product.id, quantity: 3 }));

    const carts = expectOk(await customer.query('carts'));
    assert.equal(carts.length, 2);
    assert.equal(carts.find(entry => entry.business.id === first.business.id).cart.lines[0].quantity, 2);
    assert.equal(carts.find(entry => entry.business.id === second.business.id).cart.lines[0].quantity, 3);

    // Vaciar uno no toca el otro.
    expectOk(await customer.command('cart.clear', { businessId: first.business.id }));
    const remaining = expectOk(await customer.query('carts'));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].business.id, second.business.id);
  });

  test('confirmar dos veces el mismo intento crea un solo pedido', async () => {
    const { merchant, admin, customer } = await accounts('idempotencia');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Comercio idempotente', delivery: false });
    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 1 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));
    const payload = {
      businessId: business.id, requestId, fulfillment: 'pickup', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333' },
    };
    // Doble toque real: las dos confirmaciones salen a la vez.
    const [first, second] = await Promise.all([
      customer.command('order.create', payload),
      customer.command('order.create', payload),
    ]);
    const ids = [first, second].filter(result => result.ok).map(result => result.data.id);
    assert.ok(ids.length >= 1, 'al menos una confirmación debe prosperar');
    assert.equal(new Set(ids).size, 1, 'ambas confirmaciones devuelven el mismo pedido');

    const orders = expectOk(await customer.query('myOrders'));
    assert.equal(orders.filter(order => order.businessId === business.id).length, 1);

    // Reusar el intento con otros datos es un conflicto explícito.
    expectFail(await customer.command('order.create', { ...payload, customer: { name: 'Otra persona', phone: '2942999999' } }),
      'IDEMPOTENCY_CONFLICT', 'reusar el intento con otros datos');
  });

  test('rechazo del comercio con motivo y reposición de stock', async () => {
    const { merchant, admin, customer } = await accounts('rechazo');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Comercio rechazo', delivery: false });
    const before = expectOk(await customer.query('products', { businessId: business.id }))[0].stock;

    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 3 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));
    const order = expectOk(await customer.command('order.create', {
      businessId: business.id, requestId, fulfillment: 'pickup', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333' },
    }));
    const during = expectOk(await customer.query('products', { businessId: business.id }))[0].stock;
    assert.equal(during, before - 3, 'el stock se descuenta al confirmar');

    expectFail(await merchant.command('order.transition', {
      orderId: order.id, expectedVersion: order.version, nextStatus: 'canceled',
    }), 'REASON_REQUIRED', 'rechazar sin motivo');

    const rejected = expectOk(await merchant.command('order.transition', {
      orderId: order.id, expectedVersion: order.version, nextStatus: 'canceled', reason: 'No tenemos stock esta tarde.',
    }));
    assert.equal(rejected.status, 'canceled');
    assert.equal(rejected.cancellation.kind, 'rejected');
    assert.match(rejected.cancellation.reason, /stock/i);

    const after = expectOk(await customer.query('products', { businessId: business.id }))[0].stock;
    assert.equal(after, before, 'el rechazo repone el stock');
  });

  test('transiciones inválidas y versiones vencidas se rechazan', async () => {
    const { merchant, admin, customer } = await accounts('transiciones');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Comercio transiciones', delivery: false });
    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 1 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));
    const order = expectOk(await customer.command('order.create', {
      businessId: business.id, requestId, fulfillment: 'pickup', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333' },
    }));

    expectFail(await merchant.command('order.transition', {
      orderId: order.id, expectedVersion: order.version, nextStatus: 'delivered',
    }), 'TRANSITION_FORBIDDEN', 'saltar de recibido a entregado');

    const accepted = expectOk(await merchant.command('order.transition', {
      orderId: order.id, expectedVersion: order.version, nextStatus: 'accepted',
    }));
    expectFail(await merchant.command('order.transition', {
      orderId: order.id, expectedVersion: order.version, nextStatus: 'preparing',
    }), 'STALE_ORDER', 'usar una versión vencida');
    assert.equal(accepted.version, order.version + 1);
  });

  test('un comercio no accede a pedidos, catálogo ni repartidores de otro', async () => {
    const { merchant, admin, customer } = await accounts('aislamiento');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Comercio propio', delivery: true });

    const intruder = harness.client('comercio-ajeno');
    expectOk(await intruder.register({ email: 'intruso@cauce.test', name: 'Comercio ajeno', phone: '2942444444', password: PASSWORD }));

    expectFail(await intruder.query('businessOrders', { businessId: business.id }), 'TENANT_MISMATCH', 'ver pedidos ajenos');
    expectFail(await intruder.query('riders', { businessId: business.id }), 'TENANT_MISMATCH', 'ver repartidores ajenos');
    expectFail(await intruder.command('product.create', {
      businessId: business.id, product: { name: 'Producto intruso', price: 100, category: 'Otros', available: true, stock: 1 },
    }), 'TENANT_MISMATCH', 'cargar producto en catálogo ajeno');
    expectFail(await intruder.command('product.update', {
      businessId: business.id, productId: product.id, patch: { price: 1 },
    }), 'TENANT_MISMATCH', 'editar producto ajeno');
    expectFail(await intruder.command('business.setOpen', { businessId: business.id, open: false }),
      'TENANT_MISMATCH', 'abrir o cerrar un comercio ajeno');

    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 1 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));
    const order = expectOk(await customer.command('order.create', {
      businessId: business.id, requestId, fulfillment: 'pickup', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333' },
    }));
    expectFail(await intruder.command('order.transition', {
      orderId: order.id, expectedVersion: order.version, nextStatus: 'accepted',
    }), 'TENANT_MISMATCH', 'operar un pedido ajeno');
    expectFail(await intruder.query('order', { orderId: order.id }), 'TENANT_MISMATCH', 'leer un pedido ajeno');
  });

  test('sin sesión no se accede a paneles internos', async () => {
    const anonymous = harness.client('anónimo');
    expectFail(await anonymous.query('adminQueue'), 'SESSION_REQUIRED', 'cola administrativa sin sesión');
    expectFail(await anonymous.query('driverOffers'), 'SESSION_REQUIRED', 'solicitudes de taxi sin sesión');
    expectFail(await anonymous.command('business.create', { name: 'Comercio anónimo' }), 'SESSION_REQUIRED', 'crear comercio sin sesión');
    // Explorar sí es público: sin cuenta se ven comercios y se arma el carrito.
    assert.deepEqual(expectOk(await anonymous.query('myBusinesses')), []);
    assert.ok(expectOk(await anonymous.query('publicBusinesses')).length > 0);
  });

  test('los pagos reales están bloqueados en el servidor', async () => {
    const { merchant, admin, customer } = await accounts('pagos');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Comercio pagos', delivery: false });
    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 1 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));
    for (const paymentMethod of ['mercadopago', 'mercado_pago', 'card', 'transfer']) {
      expectFail(await customer.command('order.create', {
        businessId: business.id, requestId, fulfillment: 'pickup', paymentMethod,
        customer: { name: 'Vecina de prueba', phone: '2942333333' },
      }), 'PAYMENTS_DISABLED', `pago con ${paymentMethod}`);
    }
  });
});

describe('recorrido 3 · solicitud y aceptación de taxi', () => {
  // Cada escena levanta su propio servidor: la disponibilidad de conductores es
  // global al entorno, así que aislar es la única forma de que las aserciones
  // sobre "a cuántos se ofreció" signifiquen algo.
  const scenes = [];
  after(async () => { for (const scene of scenes) await scene.close(); });

  async function taxiScene(prefix, { driverCount = 1 } = {}) {
    const harness = await startTestServer();
    scenes.push(harness);
    const admin = harness.client(`${prefix}-admin`);
    const passenger = harness.client(`${prefix}-pasajera`);
    expectOk(await admin.register({ email: `${prefix}-a@cauce.test`, name: 'Administración', phone: '2942222222', password: PASSWORD }));
    expectOk(await passenger.register({ email: `${prefix}-p@cauce.test`, name: 'Pasajera de prueba', phone: '2942555555', password: PASSWORD }));
    harness.grantAdmin(`${prefix}-a@cauce.test`);

    const drivers = [];
    for (let index = 0; index < driverCount; index += 1) {
      const driver = harness.client(`${prefix}-taxista-${index}`);
      expectOk(await driver.register({ email: `${prefix}-t${index}@cauce.test`, name: `Conductor ${index}`, phone: `294266666${index}`, password: PASSWORD }));
      const profile = expectOk(await driver.command('driver.apply', {
        displayName: `Conductor ${index}`, vehicle: 'Auto de prueba', plate: `TEST 0${index}`, phone: `294266666${index}`,
        mobileNumber: `Móvil ${index}`,
      }));
      expectOk(await admin.command('admin.reviewDriver', { driverId: profile.id, decision: 'approve' }));
      expectOk(await driver.command('driver.setAvailability', { available: true }));
      drivers.push({ client: driver, profile });
    }
    return { harness, admin, passenger, drivers };
  }

  const tripPayload = {
    origin: 'Plaza San Martín', destination: 'Hospital de Aluminé', originNote: 'Portón verde',
    passengers: 2, passengerName: 'Pasajera de prueba', passengerPhone: '2942555555',
  };

  test('el alta del taxista requiere revisión administrativa', async () => {
    const { harness, admin, drivers } = await taxiScene('altataxi', { driverCount: 0 });
    const driver = harness.client('altataxi-nuevo');
    expectOk(await driver.register({ email: 'altataxi-n@cauce.test', name: 'Conductor nuevo', phone: '2942777777', password: PASSWORD }));

    expectFail(await driver.command('driver.setAvailability', { available: true }), 'DRIVER_NOT_FOUND', 'disponibilidad sin alta');

    const profile = expectOk(await driver.command('driver.apply', {
      displayName: 'Conductor nuevo', vehicle: 'Auto de prueba', plate: 'TEST 99', phone: '2942777777',
    }));
    assert.equal(profile.status, 'pending_review');
    expectFail(await driver.command('driver.setAvailability', { available: true }), 'DRIVER_NOT_ELIGIBLE', 'disponibilidad sin aprobación');

    const returned = expectOk(await admin.command('admin.reviewDriver', {
      driverId: profile.id, decision: 'return', note: 'Falta indicar el número de móvil.',
    }));
    assert.equal(returned.status, 'returned');

    expectOk(await driver.command('driver.apply', {
      displayName: 'Conductor nuevo', vehicle: 'Auto de prueba', plate: 'TEST 99', phone: '2942777777', mobileNumber: 'Móvil 9',
    }));
    const approved = expectOk(await admin.command('admin.reviewDriver', { driverId: profile.id, decision: 'approve' }));
    assert.equal(approved.status, 'active');
    expectOk(await driver.command('driver.setAvailability', { available: true }));
    assert.equal(drivers.length, 0);
  });

  test('viaje completo: solicitud, aceptación y estados', async () => {
    const { passenger, drivers } = await taxiScene('viaje', { driverCount: 1 });
    const trip = expectOk(await passenger.command('trip.request', tripPayload));
    assert.equal(trip.status, 'searching');
    assert.equal(trip.driverId, null);
    assert.ok(trip.expiresAt, 'la solicitud tiene vencimiento');

    const offers = expectOk(await drivers[0].client.query('driverOffers'));
    assert.equal(offers.length, 1);
    assert.equal(offers[0].id, trip.id);
    // Antes de aceptar, el conductor no ve datos personales del pasajero.
    assert.equal(offers[0].passenger, undefined);
    assert.equal(offers[0].passengerPhone, undefined);
    assert.equal(offers[0].passengerInitial, 'P');

    const accepted = expectOk(await drivers[0].client.command('trip.accept', { tripId: trip.id }));
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.driverId, drivers[0].profile.id);

    // Ya asignado, el conductor sí ve el contacto para coordinar.
    const assigned = expectOk(await drivers[0].client.query('driverTrips'));
    assert.equal(assigned[0].passenger.phone, '2942555555');

    // La pasajera ve el vehículo asignado.
    const mine = expectOk(await passenger.query('myTrips'));
    assert.equal(mine[0].driver.plate, 'TEST 00');

    let current;
    for (const next of ['driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip', 'completed']) {
      current = expectOk(await drivers[0].client.command('trip.advance', { tripId: trip.id, nextStatus: next }), `avanzar a ${next}`);
      assert.equal(current.status, next);
    }
  });

  test('dos taxistas no pueden aceptar el mismo viaje', async () => {
    const { passenger, drivers } = await taxiScene('carrera', { driverCount: 2 });
    const trip = expectOk(await passenger.command('trip.request', tripPayload));
    assert.equal(trip.offeredTo.length, 2);

    const [first, second] = await Promise.all([
      drivers[0].client.command('trip.accept', { tripId: trip.id }),
      drivers[1].client.command('trip.accept', { tripId: trip.id }),
    ]);
    const winners = [first, second].filter(result => result.ok);
    const losers = [first, second].filter(result => !result.ok);
    assert.equal(winners.length, 1, 'sólo un conductor puede tomar el viaje');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].code, 'TRIP_ALREADY_TAKEN');

    // El perdedor tampoco puede operar el viaje después.
    const loserClient = losers[0] === first ? drivers[0].client : drivers[1].client;
    expectFail(await loserClient.command('trip.advance', { tripId: trip.id, nextStatus: 'driver_on_way' }),
      'TENANT_MISMATCH', 'avanzar un viaje ajeno');
  });

  test('un taxista con viaje en curso no puede tomar otro', async () => {
    const { harness, passenger, drivers } = await taxiScene('ocupado', { driverCount: 1 });
    const other = harness.client('ocupado-pasajera2');
    expectOk(await other.register({ email: 'ocupado-p2@cauce.test', name: 'Otra pasajera', phone: '2942888888', password: PASSWORD }));

    const first = expectOk(await passenger.command('trip.request', tripPayload));
    expectOk(await drivers[0].client.command('trip.accept', { tripId: first.id }));

    const second = expectOk(await other.command('trip.request', {
      ...tripPayload, passengerName: 'Otra pasajera', passengerPhone: '2942888888',
    }));
    expectFail(await drivers[0].client.command('trip.accept', { tripId: second.id }), 'DRIVER_BUSY', 'aceptar con viaje en curso');
  });

  test('sin conductores disponibles la solicitud queda sin disponibilidad', async () => {
    const { passenger } = await taxiScene('sindisponibles', { driverCount: 0 });
    const trip = expectOk(await passenger.command('trip.request', tripPayload));
    assert.equal(trip.status, 'no_availability');
    assert.equal(trip.expiresAt, null);
    assert.equal(trip.offeredTo.length, 0);
  });

  test('una solicitud sin respuesta vence', async () => {
    const { harness, passenger, drivers } = await taxiScene('vencida', { driverCount: 1 });
    const trip = expectOk(await passenger.command('trip.request', tripPayload));

    // Se adelanta el vencimiento directamente en el estado guardado.
    const row = harness.database.prepare('SELECT doc FROM domain_state WHERE id = 1').get();
    const state = JSON.parse(row.doc);
    state.trips.find(item => item.id === trip.id).expiresAt = new Date(Date.now() - 1000).toISOString();
    harness.database.prepare('UPDATE domain_state SET doc = ? WHERE id = 1').run(JSON.stringify(state));

    const offers = expectOk(await drivers[0].client.query('driverOffers'));
    assert.ok(!offers.some(offer => offer.id === trip.id), 'la solicitud vencida sale de la lista');
    expectFail(await drivers[0].client.command('trip.accept', { tripId: trip.id }), 'TRIP_EXPIRED', 'aceptar una solicitud vencida');

    const mine = expectOk(await passenger.query('myTrips'));
    assert.equal(mine.find(item => item.id === trip.id).status, 'expired');
  });

  test('la pasajera no acumula solicitudes abiertas y puede cancelar', async () => {
    const { passenger, drivers } = await taxiScene('cancelar', { driverCount: 1 });
    const trip = expectOk(await passenger.command('trip.request', tripPayload));
    expectFail(await passenger.command('trip.request', tripPayload), 'ACTIVE_TRIP_EXISTS', 'segunda solicitud abierta');

    const canceled = expectOk(await passenger.command('trip.cancel', { tripId: trip.id, reason: 'Conseguí otro medio.' }));
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.canceledBy, 'passenger');

    // Cancelado el anterior, se puede volver a pedir.
    const again = expectOk(await passenger.command('trip.request', tripPayload));
    expectOk(await drivers[0].client.command('trip.accept', { tripId: again.id }));
    // Ya iniciado el viaje no se puede cancelar.
    for (const next of ['driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip']) {
      expectOk(await drivers[0].client.command('trip.advance', { tripId: again.id, nextStatus: next }));
    }
    expectFail(await passenger.command('trip.cancel', { tripId: again.id }), 'CANNOT_CANCEL', 'cancelar un viaje en curso');
  });

  test('la flota no ve solicitudes ajenas ni datos del pasajero', async () => {
    const { harness, passenger, drivers } = await taxiScene('privacidad', { driverCount: 1 });
    const outsider = harness.client('privacidad-externo');
    expectOk(await outsider.register({ email: 'privacidad-x@cauce.test', name: 'Persona externa', phone: '2942999999', password: PASSWORD }));

    const trip = expectOk(await passenger.command('trip.request', tripPayload));
    // Una cuenta sin alta de conductor no recibe ofertas.
    const offers = expectOk(await outsider.query('driverOffers'));
    assert.equal(offers.length, 0);
    expectFail(await outsider.command('trip.accept', { tripId: trip.id }), 'DRIVER_NOT_FOUND', 'aceptar sin ser conductor');
    assert.ok(drivers.length === 1);
  });
});

describe('sesiones y persistencia compartida', () => {
  test('la sesión sobrevive y el cierre de sesión la corta', async () => {
    const client = harness.client('sesion');
    expectOk(await client.register({ email: 'sesion@cauce.test', name: 'Persona sesión', phone: '2942121212', password: PASSWORD }));
    const before = expectOk(await client.session());
    assert.equal(before.actor.kind, 'account');
    assert.equal(before.actor.email, 'sesion@cauce.test');

    expectOk(await client.signOut());
    const after = expectOk(await client.session());
    assert.equal(after.actor.kind, 'guest', 'tras cerrar sesión se vuelve a una identidad anónima');

    expectFail(await client.signIn({ email: 'sesion@cauce.test', password: 'incorrecta1' }), 'INVALID_CREDENTIALS', 'contraseña incorrecta');
    const again = expectOk(await client.signIn({ email: 'sesion@cauce.test', password: PASSWORD }));
    assert.equal(again.email, 'sesion@cauce.test');
  });

  test('dos sesiones distintas ven la misma operación compartida', async () => {
    const { merchant, admin, customer } = await accounts('compartida');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Comercio compartido', delivery: false });
    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 1 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));
    const order = expectOk(await customer.command('order.create', {
      businessId: business.id, requestId, fulfillment: 'pickup', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333' },
    }));

    // El pedido creado en la sesión de la clienta aparece en la sesión del comercio.
    const merchantView = expectOk(await merchant.query('businessOrders', { businessId: business.id }));
    assert.ok(merchantView.some(item => item.id === order.id));

    // Y el cambio del comercio se ve desde la sesión de la clienta.
    expectOk(await merchant.command('order.transition', {
      orderId: order.id, expectedVersion: order.version, nextStatus: 'accepted',
    }));
    const customerView = expectOk(await customer.query('order', { orderId: order.id }));
    assert.equal(customerView.status, 'accepted');
  });

  test('las métricas administrativas son agregadas y sin datos personales', async () => {
    const { merchant, admin, customer } = await accounts('metricas');
    const { business, product } = await publishBusiness(harness, { merchant, admin, name: 'Comercio métricas', delivery: false });
    expectOk(await customer.command('cart.setQuantity', { businessId: business.id, productId: product.id, quantity: 1 }));
    const requestId = expectOk(await customer.command('cart.prepareRequest', { businessId: business.id }));
    expectOk(await customer.command('order.create', {
      businessId: business.id, requestId, fulfillment: 'pickup', paymentMethod: 'cash_demo',
      customer: { name: 'Vecina de prueba', phone: '2942333333' },
    }));

    const metrics = expectOk(await admin.query('adminMetrics'));
    const serialized = JSON.stringify(metrics);
    assert.ok(metrics.orders.total >= 1);
    assert.ok(!serialized.includes('2942333333'), 'las métricas no incluyen teléfonos');
    assert.ok(!serialized.includes('Vecina de prueba'), 'las métricas no incluyen nombres');
    assert.match(metrics.source, /registrad/i);
  });
});
