// Recorrido real contra CAUCE: catálogo, imágenes, pedidos, sincronización en
// vivo, reparto y taxi. Usa cuentas sintéticas independientes y las elimina al
// terminar. No imprime tokens, contraseñas ni claves.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixtures, publicClient, project, requireSuccess } from './lib/supabase-real.mjs';
import { createSupabaseRepository } from '../js/repositories/supabase-repository.js';

const results = [];
const check = async (name, fn) => { await fn(); results.push(name); console.log(`PASS · ${name}`); };
const rejects = async (promise, code) => {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `esperaba ${code} y llegó ${error.code}: ${error.message}`);
    return true;
  });
};
function memoryStorage() {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key), clear: () => map.clear() };
}
// PNG real de 1×1: el servicio de Storage valida el tipo declarado.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const imageFile = (name = 'foto.png') => new File([PNG], name, { type: 'image/png' });

const fixture = await fixtures(['customerA', 'customerB', 'merchantA', 'merchantB', 'staff', 'admin', 'driverA', 'driverB']);
const repos = Object.fromEntries(Object.entries(fixture.users)
  .map(([name, user]) => [name, createSupabaseRepository({ client: user.client, storage: memoryStorage() })]));
const waitFor = (condition, label, timeout = 12000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (condition()) return resolve(true);
    if (Date.now() - started > timeout) return reject(new Error(`Sin evento en vivo: ${label}`));
    setTimeout(tick, 150);
  };
  tick();
});

let businessA, businessB, productA, variantA, orderId;
try {
  await check('El comercio arma su catálogo real con categoría, variantes y stock', async () => {
    businessA = (await repos.merchantA.command('business.create',
      { name: 'Panadería Sintética A', category: 'panaderia', ownerName: 'Responsable A', contactPhone: '2942000001' })).id;
    businessB = (await repos.merchantB.command('business.create',
      { name: 'Almacén Sintético B', category: 'almacen', ownerName: 'Responsable B', contactPhone: '2942000002' })).id;
    fixture.businesses.push(businessA, businessB);
    const product = await repos.merchantA.command('product.create', {
      businessId: businessA,
      product: { name: 'Pan casero', description: 'De la prueba', category: 'Panificados', price: 1800, stock: 10,
        available: true, variants: [{ name: 'Medio kilo', priceDelta: 0 }, { name: 'Kilo', priceDelta: 1200 }] },
    });
    productA = product.id;
    variantA = product.variants.find(variant => variant.name === 'Kilo').id;
    assert.equal(product.price, 1800);
    assert.equal(product.variants.length, 2);
    assert.equal(product.category, 'Panificados');
  });

  await check('Las imágenes quedan aisladas por comercio en Storage', async () => {
    const withPhoto = await repos.merchantA.command('product.setImage',
      { businessId: businessA, productId: productA, file: imageFile() });
    assert.match(withPhoto.imagePath, new RegExp(`^businesses/${businessA}/products/${productA}/`));
    assert.ok(withPhoto.image.startsWith(`${project.url}/storage/v1/object/public/business-media/`));
    const logo = await repos.merchantA.command('business.setMedia',
      { businessId: businessA, slot: 'logo', file: imageFile('logo.png') });
    assert.match(logo.logoPath, new RegExp(`^businesses/${businessA}/logo/`));
    // Otro comercio, el equipo del propio comercio y una cuenta común no escriben acá.
    for (const [name, message] of [['merchantB', 'ajeno'], ['customerA', 'sin comercio'], ['staff', 'equipo']]) {
      const forbidden = await fixture.users[name].client.storage.from('business-media')
        .upload(`businesses/${businessA}/products/${productA}/intruso-${message.length}.png`, PNG, { contentType: 'image/png' });
      assert.ok(forbidden.error, `Debía rechazar la subida de ${name}`);
    }
    // Tampoco se listan ni se borran archivos de otro comercio.
    const listed = await fixture.users.merchantB.client.storage.from('business-media').list(`businesses/${businessA}/logo`);
    assert.deepEqual(listed.data ?? [], []);
    const removed = await fixture.users.merchantB.client.storage.from('business-media').remove([logo.logoPath]);
    assert.ok(removed.error || (removed.data ?? []).length === 0, 'No debía borrar archivos ajenos');
    assert.ok((await repos.merchantA.query('products', { businessId: businessA }))[0].image);
    // Tipo y tamaño se validan antes de tocar la red.
    await rejects(repos.merchantA.command('product.setImage',
      { businessId: businessA, productId: productA, file: new File(['x'], 'a.txt', { type: 'text/plain' }) }),
    'INVALID_IMAGE_TYPE');
  });

  await check('Publicar depende de administración y de una solicitud completa', async () => {
    await rejects(repos.merchantA.command('business.submit', { businessId: businessA }), '23514');
    await repos.merchantA.command('business.update', { businessId: businessA, patch: {
      address: 'Ruta 23 y Cristian Joubert', hoursLabel: 'Lunes a sábado de 9 a 13',
      pickupEnabled: true, deliveryEnabled: true, deliveryZone: 'Casco urbano', deliveryFee: 1200, minimumOrder: 1000,
      ownerName: 'Responsable A', contactPhone: '2942000001' } });
    assert.deepEqual(await repos.merchantA.query('businessRequirements', { businessId: businessA }), []);
    await repos.merchantA.command('business.submit', { businessId: businessA });
    await rejects(repos.merchantA.command('admin.reviewBusiness', { businessId: businessA, decision: 'approve' }), '42501');
    await rejects(repos.customerA.command('admin.reviewBusiness', { businessId: businessA, decision: 'approve' }), '42501');
    await repos.admin.command('admin.reviewBusiness', { businessId: businessA, decision: 'approve', note: 'Aprobado' });
    await repos.merchantA.command('business.setOpen', { businessId: businessA, open: true });
    const published = await repos.merchantA.query('business', { businessId: businessA });
    assert.equal(published.status, 'active');
    assert.equal(published.open, true);
  });

  await check('Otro dispositivo ve el catálogo publicado y nunca el borrador vecino', async () => {
    const visible = await repos.customerB.query('publicBusinesses');
    assert.ok(visible.some(business => business.id === businessA));
    assert.ok(!visible.some(business => business.id === businessB));
    const anon = createSupabaseRepository({ client: publicClient(), storage: memoryStorage() });
    const anonProducts = await anon.query('products', { businessId: businessA });
    assert.equal(anonProducts.length, 1);
    assert.equal(anonProducts[0].name, 'Pan casero');
    assert.deepEqual(await anon.query('products', { businessId: businessB }), []);
    // El contacto del comercio no viaja en la vista pública.
    const publicBusiness = await anon.query('business', { businessId: businessA });
    assert.equal(publicBusiness.contactPhone, '');
    assert.equal((await repos.merchantA.query('myBusinesses'))[0].contactPhone, '2942000001');
    assert.equal((await repos.merchantB.query('myBusinesses'))[0].id, businessB);
  });

  await check('El total lo calcula el servidor y el pedido llega al comercio', async () => {
    await repos.customerA.command('cart.setQuantity',
      { businessId: businessA, productId: productA, variantId: variantA, quantity: 2 });
    const quote = await repos.customerA.query('quote', { businessId: businessA, fulfillment: 'pickup' });
    assert.equal(quote.total, 6000);
    const requestId = await repos.customerA.command('cart.prepareRequest', { businessId: businessA });
    const order = await repos.customerA.command('order.create', { businessId: businessA, requestId,
      fulfillment: 'pickup', customer: { name: 'Vecina Sintética', phone: '2942000111', notes: 'Sin sal' } });
    orderId = order.id;
    assert.equal(order.total, 6000);
    assert.equal(order.subtotal, 6000);
    assert.equal(order.deliveryFee, 0);
    assert.equal(order.status, 'submitted');
    assert.equal(order.lines[0].name, 'Pan casero · Kilo');
    assert.ok(order.lines[0].image, 'La línea guarda la foto del producto');
    assert.equal((await repos.merchantA.query('businessOrders', { businessId: businessA })).length, 1);
    assert.equal((await repos.merchantA.query('products', { businessId: businessA }))[0].stock, 8);
  });

  await check('Un intento repetido no duplica el pedido, ni siquiera en paralelo', async () => {
    await repos.customerA.command('cart.setQuantity',
      { businessId: businessA, productId: productA, variantId: variantA, quantity: 1 });
    const requestId = await repos.customerA.command('cart.prepareRequest', { businessId: businessA });
    const payload = { businessId: businessA, requestId, fulfillment: 'pickup',
      customer: { name: 'Vecina Sintética', phone: '2942000111' } };
    // Doble toque real: dos llamadas simultáneas con el mismo intento.
    const [first, second] = await Promise.all([
      fixture.users.customerA.client.rpc('create_order', { business: businessA, idem: requestId,
        fulfillment: 'pickup', payment_method: 'cash_on_pickup',
        contact: { name: 'Vecina Sintética', phone: '2942000111', address: '', notes: '' },
        items: [{ product_id: productA, variant_id: variantA, quantity: 1 }] }),
      fixture.users.customerA.client.rpc('create_order', { business: businessA, idem: requestId,
        fulfillment: 'pickup', payment_method: 'cash_on_pickup',
        contact: { name: 'Vecina Sintética', phone: '2942000111', address: '', notes: '' },
        items: [{ product_id: productA, variant_id: variantA, quantity: 1 }] }),
    ]);
    assert.ok(!first.error && !second.error, 'Ninguna de las dos llamadas debía fallar');
    assert.equal(first.data, second.data, 'Las dos devuelven el mismo pedido');
    assert.equal((await repos.customerA.query('myOrders')).length, 2);
    assert.equal((await repos.merchantA.query('products', { businessId: businessA }))[0].stock, 7);
    // El mismo intento con otros datos no se acepta en silencio.
    await rejects(repos.customerA.command('order.create', { ...payload,
      customer: { name: 'Otra Persona', phone: '2942000222' } }), 'U0002');
  });

  await check('El pedido es del cliente y del comercio: nadie más lo ve ni lo mueve', async () => {
    assert.deepEqual(await repos.customerB.query('myOrders'), []);
    assert.deepEqual(await repos.merchantB.query('businessOrders', { businessId: businessB }), []);
    await rejects(repos.customerB.query('order', { orderId }), 'ORDER_NOT_FOUND');
    assert.deepEqual(requireSuccess(await fixture.users.merchantB.client.from('orders').select('*')), []);
    assert.deepEqual(requireSuccess(await fixture.users.customerB.client.from('order_items').select('*')), []);
    assert.ok((await publicClient().from('orders').select('*').limit(1)).error, 'Anónimo no lee pedidos');
    // Ni el importe ni el estado se tocan desde el cliente: la tabla no admite
    // escritura directa de nadie, ni siquiera del comercio dueño del pedido.
    assert.ok((await fixture.users.customerA.client.from('orders')
      .update({ total_ars: 1 }).eq('id', orderId).select()).error, 'El cliente no cambia el total');
    assert.ok((await fixture.users.merchantA.client.from('orders')
      .update({ status: 'delivered' }).eq('id', orderId).select()).error, 'El comercio no cambia el estado a mano');
    assert.ok((await fixture.users.customerA.client.from('order_items')
      .update({ unit_price_ars: 1 }).eq('order_id', orderId).select()).error, 'Nadie reescribe una línea');
    await rejects(repos.customerA.command('order.transition',
      { orderId, expectedVersion: 1, nextStatus: 'delivered' }), '42501');
    await rejects(repos.merchantB.command('order.transition',
      { orderId, expectedVersion: 1, nextStatus: 'accepted' }), '42501');
    await rejects(repos.merchantA.command('order.transition',
      { orderId, expectedVersion: 9, nextStatus: 'accepted' }), 'U0001');
  });

  await check('El comercio recibe el pedido sin recargar y el cliente ve el cambio', async () => {
    const merchantEvents = [];
    const customerEvents = [];
    const stopMerchant = repos.merchantA.watch({ kind: 'businessOrders', businessId: businessA },
      payload => merchantEvents.push(payload));
    const stopOther = repos.merchantB.watch({ kind: 'businessOrders', businessId: businessB },
      payload => merchantEvents.push({ leak: payload }));
    await new Promise(resolve => setTimeout(resolve, 2500));

    await repos.customerA.command('cart.setQuantity',
      { businessId: businessA, productId: productA, variantId: variantA, quantity: 1 });
    const requestId = await repos.customerA.command('cart.prepareRequest', { businessId: businessA });
    const live = await repos.customerA.command('order.create', { businessId: businessA, requestId,
      fulfillment: 'pickup', customer: { name: 'Vecina Sintética', phone: '2942000111' } });
    await waitFor(() => merchantEvents.some(event => event.new?.id === live.id), 'el comercio recibe el pedido');

    const stopCustomer = repos.customerA.watch({ kind: 'order', orderId: live.id },
      payload => customerEvents.push(payload));
    await new Promise(resolve => setTimeout(resolve, 2500));
    await repos.merchantA.command('order.transition', { orderId: live.id, expectedVersion: 1, nextStatus: 'accepted' });
    await waitFor(() => customerEvents.some(event => event.new?.status === 'accepted'), 'el cliente ve el cambio de estado');

    assert.ok(!merchantEvents.some(event => event.leak), 'El comercio vecino no recibió nada');
    stopMerchant(); stopOther(); stopCustomer();
  });

  await check('El envío suma el costo del comercio y lo entrega su propio reparto', async () => {
    const rider = await repos.merchantA.command('rider.create',
      { businessId: businessA, name: 'Reparto Sintético', phone: '2942000333' });
    const foreign = await repos.merchantB.command('rider.create', { businessId: businessB, name: 'Reparto Ajeno' });
    assert.deepEqual(await repos.merchantB.query('riders', { businessId: businessA }), []);
    await repos.customerA.command('cart.setQuantity',
      { businessId: businessA, productId: productA, variantId: variantA, quantity: 1 });
    const requestId = await repos.customerA.command('cart.prepareRequest', { businessId: businessA });
    const order = await repos.customerA.command('order.create', { businessId: businessA, requestId,
      fulfillment: 'delivery', customer: { name: 'Vecina Sintética', phone: '2942000111', address: 'Calle Principal 123' } });
    assert.equal(order.subtotal, 3000);
    assert.equal(order.deliveryFee, 1200);
    assert.equal(order.total, 4200);
    assert.match(order.deliveryCode.code, /^\d{4}$/);
    let version = order.version;
    const advance = async next => {
      const updated = await repos.merchantA.command('order.transition',
        { orderId: order.id, expectedVersion: version, nextStatus: next, riderId: next === 'assigned' ? rider.id : null });
      version = updated.version;
      return updated;
    };
    await advance('accepted'); await advance('preparing'); await advance('ready');
    await rejects(repos.merchantA.command('order.transition', { orderId: order.id,
      expectedVersion: version, nextStatus: 'assigned', riderId: foreign.id }), '23514');
    assert.equal((await advance('assigned')).riderId, rider.id);
    await advance('picked_up'); await advance('on_the_way'); await advance('arrived');
    const delivered = await advance('delivered');
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.paymentStatus, 'settled');
    assert.equal(delivered.history.length, 9);
  });

  await check('Dos taxistas no pueden tomar el mismo viaje', async () => {
    for (const name of ['driverA', 'driverB']) {
      await repos[name].command('driver.apply', { displayName: `Conductor Sintético ${name.slice(-1)}`,
        mobileNumber: 'Móvil de prueba', vehicle: 'Auto', plate: `QA ${name.slice(-1)}00`, phone: '2942000444' });
      await rejects(repos[name].command('driver.setAvailability', { available: true }), '42501');
      const driver = await repos[name].query('myDriver');
      await repos.admin.command('admin.reviewDriver', { driverId: driver.id, decision: 'approve' });
      await repos[name].command('driver.setAvailability', { available: true });
    }
    const trip = await repos.customerA.command('trip.request', { origin: 'Ruta 23 y el río',
      destination: 'Hospital de Aluminé', originNote: 'Portón azul', passengers: 2,
      passengerName: 'Vecina Sintética', passengerPhone: '2942000111' });
    // Antes de aceptar, la oferta no lleva teléfono ni nombre completo.
    const offers = await repos.driverA.query('driverOffers');
    const offered = offers.find(item => item.id === trip.id);
    assert.ok(offered, 'El conductor habilitado ve la solicitud');
    assert.equal(offered.passengerInitial, 'V');
    assert.equal(JSON.stringify(offered).includes('2942000111'), false);
    assert.deepEqual(await repos.driverA.query('driverTrips'), []);
    assert.deepEqual(requireSuccess(await fixture.users.driverA.client.from('trips').select('*')), []);

    // Carrera real: las dos aceptaciones salen a la vez.
    const [first, second] = await Promise.allSettled([
      repos.driverA.command('trip.accept', { tripId: trip.id }),
      repos.driverB.command('trip.accept', { tripId: trip.id }),
    ]);
    const winners = [first, second].filter(result => result.status === 'fulfilled');
    const losers = [first, second].filter(result => result.status === 'rejected');
    assert.equal(winners.length, 1, 'Sólo un conductor toma el viaje');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, 'U0004');
    const winner = winners[0].value.driverId;
    const passengerView = (await repos.customerA.query('myTrips'))[0];
    assert.equal(passengerView.driverId, winner);
    assert.ok(passengerView.driver.plate, 'El pasajero ve la identificación del móvil');
    const loserName = (await repos.driverA.query('myDriver')).id === winner ? 'driverB' : 'driverA';
    assert.deepEqual(await repos[loserName].query('driverTrips'), []);
    assert.deepEqual(requireSuccess(await fixture.users[loserName].client.from('trips').select('*')), []);
    assert.deepEqual(await repos[loserName].query('driverOffers'), []);
    await rejects(repos[loserName].command('trip.advance',
      { tripId: trip.id, nextStatus: 'driver_on_way' }), '42501');
    await rejects(repos.customerA.command('trip.advance',
      { tripId: trip.id, nextStatus: 'completed' }), '42501');
    const winnerName = loserName === 'driverA' ? 'driverB' : 'driverA';
    for (const next of ['driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip', 'completed']) {
      assert.equal((await repos[winnerName].command('trip.advance', { tripId: trip.id, nextStatus: next })).status, next);
    }
  });

  await check('Una cuenta común no escala a comercio, administración ni conductor', async () => {
    // La política rechaza el INSERT: PostgREST devuelve 42501, no una fila vacía.
    await rejects(repos.customerB.command('product.create',
      { businessId: businessA, product: { name: 'Intruso', price: 100, stock: 1, available: true, category: 'Otros' } }),
    '42501');
    await rejects(repos.staff.query('adminBusinesses'), 'ROLE_REQUIRED');
    await rejects(repos.customerA.query('adminQueue'), 'ROLE_REQUIRED');
    await rejects(repos.customerA.command('admin.reviewDriver',
      { driverId: (await repos.driverA.query('myDriver')).id, decision: 'approve' }), '42501');
    assert.deepEqual(requireSuccess(await fixture.users.customerA.client.from('drivers').select('*')), []);
    assert.deepEqual(requireSuccess(await fixture.users.customerA.client.from('business_contacts').select('*')), []);
    assert.deepEqual(requireSuccess(await publicClient().from('products').select('*').eq('business_id', businessB)), []);
  });
} finally {
  await fixture.cleanup();
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/supabase-operations.json', JSON.stringify({ at: new Date().toISOString(),
    project: project.projectRef, checks: results, syntheticDataCleaned: true,
    limitations: ['No prueba entrega SMTP ni registro público por correo.',
      'No prueba cobros: el pago se coordina en mano.'] }, null, 2));
}
console.log(`\n${results.length} comprobaciones reales aprobadas contra CAUCE.`);
