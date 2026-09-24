// Checkout y ciclo de vida de pedidos contra Supabase real (stack local).
// El servidor es la autoridad: precio, envío, total, stock, estado y comercio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  sql, account, guest, anonClient, makeAdmin, publishedBusiness, order, transition, ok, failsWith,
  contact, closeAll,
} from './harness.mjs';

const people = {};
const customers = [];
let turn = 0;
let A, B;
// Cada cliente tiene un tope de pedidos sin atender: las pruebas rotan cuentas
// para medir una regla por vez.
const nextCustomer = () => customers[turn++ % customers.length];
const line = (product, quantity = 1, variant = null) => ({ product_id: product.id, quantity,
  ...(variant ? { variant_id: variant.id } : {}) });

before(async () => {
  for (const name of ['owner', 'ownerB', 'admin']) people[name] = await account(name);
  for (let i = 0; i < 14; i += 1) customers.push(await account(`cliente${i}`));
  people.guest = await guest('guest');
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.owner, people.admin, { name: 'Pedidos' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Vecino' });
});

after(async () => { await closeAll([...Object.values(people), ...customers]); });

test('el servidor calcula precio, envío y total: el cliente sólo elige productos', async () => {
  const buyer = nextCustomer();
  const pickupId = ok(await order(buyer, A.id, [{ ...line(A.products.untracked, 2), price_ars: 1, unit_price_ars: 1 }]));
  const pickup = ok(await buyer.client.from('orders').select('*,order_items!order_items_business_scope(*)').eq('id', pickupId).single());
  assert.equal(Number(pickup.subtotal_ars), 2400);
  assert.equal(Number(pickup.delivery_fee_ars), 0);
  assert.equal(Number(pickup.total_ars), 2400);
  assert.equal(pickup.order_items[0].product_name, 'Empanada de carne');
  assert.equal(pickup.status, 'submitted');
  assert.equal(pickup.delivery_code, null);

  const deliveryId = ok(await order(buyer, A.id, [line(A.products.variants, 1, A.variants.Grande)], { fulfillment: 'delivery' }));
  const delivery = ok(await buyer.client.from('orders').select('*').eq('id', deliveryId).single());
  assert.equal(Number(delivery.subtotal_ars), 9500, 'precio base más la diferencia de la variante');
  assert.equal(Number(delivery.delivery_fee_ars), 1500);
  assert.equal(Number(delivery.total_ars), 11000);
  assert.match(delivery.delivery_code, /^\d{4}$/);
  assert.equal(delivery.address, 'Calle Los Pehuenes 45');
});

test('si el precio cambia durante el checkout el pedido no se crea y se informa el total nuevo', async () => {
  const buyer = nextCustomer();
  const idem = randomUUID();
  ok(await people.owner.client.from('products').update({ price_ars: 1300 }).eq('id', A.products.untracked.id));
  const stale = failsWith(await order(buyer, A.id, [line(A.products.untracked, 2)], { idem, expectedTotal: 2400 }), 'U0005');
  assert.equal(stale.details, '2600');
  const [{ count }] = await sql`select count(*)::int from public.orders where idempotency_key = ${idem}`;
  assert.equal(count, 0, 'ningún pedido a medias');
  const confirmed = ok(await order(buyer, A.id, [line(A.products.untracked, 2)], { idem, expectedTotal: 2600 }));
  const row = ok(await buyer.client.from('orders').select('total_ars').eq('id', confirmed).single());
  assert.equal(Number(row.total_ars), 2600);
  ok(await people.owner.client.from('products').update({ price_ars: 1200 }).eq('id', A.products.untracked.id));
});

test('el mismo intento enviado seis veces en paralelo crea un solo pedido', async () => {
  const buyer = nextCustomer();
  const idem = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 },
    () => order(buyer, A.id, [line(A.products.untracked, 3)], { idem })));
  const ids = new Set(results.map(result => ok(result)));
  assert.equal(ids.size, 1);
  const [{ count }] = await sql`select count(*)::int from public.orders where idempotency_key = ${idem}`;
  assert.equal(count, 1);
  const changed = failsWith(await order(buyer, A.id, [line(A.products.untracked, 4)], { idem }), 'U0002');
  assert.match(changed.message, /Repeated attempt/);
});

test('con stock controlado, la última unidad la gana un solo pedido', async () => {
  ok(await people.owner.client.rpc('set_product_availability',
    { product: A.products.tracked.id, is_available: true, next_stock: 1 }));
  const racers = [nextCustomer(), nextCustomer(), nextCustomer(), nextCustomer()];
  const results = await Promise.all(racers.map(buyer => order(buyer, A.id, [line(A.products.tracked, 1)])));
  const winners = results.filter(result => !result.error);
  const losers = results.filter(result => result.error);
  assert.equal(winners.length, 1);
  assert.ok(losers.every(result => result.error.code === 'U0003'));
  const stock = async () => ok(await people.owner.client.from('products').select('stock').eq('id', A.products.tracked.id).single()).stock;
  assert.equal(await stock(), 0);
  const winner = racers[results.indexOf(winners[0])];
  ok(await transition(winner, winners[0].data, 'canceled'));
  assert.equal(await stock(), 1, 'cancelar devuelve la unidad');
  // Sin control de stock no hay agotamiento por cantidad.
  ok(await order(nextCustomer(), A.id, [line(A.products.untracked, 60)]));
  const untracked = ok(await people.owner.client.from('products').select('stock,track_stock').eq('id', A.products.untracked.id).single());
  assert.deepEqual(untracked, { stock: 0, track_stock: false });
});

test('checkout: comercio, producto, variante, cantidad, modalidad y datos se validan en la base', async () => {
  const buyer = nextCustomer();
  const bad = [
    [[line(A.products.variants, 1)], {}, 'Variant required'],
    [[line(A.products.variants, 1, B.variants.Chica)], {}, 'Variant not available'],
    [[line(B.products.untracked, 1)], {}, 'Product not available'],
    [[{ product_id: A.products.untracked.id, quantity: 0 }], {}, 'Invalid quantity'],
    [[{ product_id: A.products.untracked.id, quantity: 100 }], {}, 'Invalid quantity'],
    [[{ product_id: A.products.untracked.id, quantity: -1 }], {}, 'Invalid quantity'],
    [[{ product_id: A.products.untracked.id, quantity: 1.5 }], {}, 'Invalid quantity'],
    [[{ product_id: A.products.untracked.id, quantity: 'dos' }], {}, 'Invalid quantity'],
    [[{ product_id: 'no-es-un-id', quantity: 1 }], {}, 'Invalid quantity'],
    [[], {}, 'Empty cart'],
    [Array.from({ length: 101 }, () => line(A.products.untracked, 1)), {}, 'Empty cart'],
    [[line(A.products.untracked, 1)], { fulfillment: 'delivery', contactData: contact({ address: '' }) }, 'Address required'],
    [[line(A.products.untracked, 1)], { fulfillment: 'delivery' }, 'Minimum order not reached'],
    [[line(A.products.untracked, 1)], { contactData: contact({ name: 'X' }) }, 'Invalid contact name'],
    [[line(A.products.untracked, 1)], { contactData: contact({ phone: 'llamame' }) }, 'Invalid contact phone'],
  ];
  for (const [lines, options, message] of bad) {
    const error = failsWith(await order(buyer, A.id, lines, options), '23514');
    assert.equal(error.message, message);
  }
  const mismatch = await buyer.client.rpc('create_order', { business: A.id, idem: randomUUID(), fulfillment: 'pickup',
    payment_method: 'cash_on_delivery', contact: contact(), items: [line(A.products.untracked, 1)] });
  assert.equal(failsWith(mismatch, '23514').message, 'Payment method not available');
  const [{ count }] = await sql`select count(*)::int from public.orders where customer_id = ${buyer.id}`;
  assert.equal(count, 0, 'ninguna validación fallida dejó un pedido');
});

test('comercio cerrado, fuera de horario, pausado o producto no disponible: no hay pedido', async () => {
  const buyer = nextCustomer();
  const owner = people.owner.client;
  ok(await owner.rpc('set_business_presence', { business: A.id, is_open: false }));
  assert.equal(failsWith(await order(buyer, A.id, [line(A.products.untracked)]), '23514').message, 'Business closed');
  ok(await owner.rpc('set_business_presence', { business: A.id, is_open: true }));

  // Un único horario que no incluye este momento: dentro de 2 a 3 horas.
  const [{ dow, opens, closes }] = await sql`select extract(dow from t)::int as dow,
    to_char(t + interval '2 hours', 'HH24:MI') as opens, to_char(t + interval '3 hours', 'HH24:MI') as closes
    from (select now() at time zone 'America/Argentina/Buenos_Aires' as t) s`;
  ok(await owner.from('business_hours').insert({ business_id: A.id, weekday: dow, opens, closes }));
  const anonymous = anonClient();
  const listed = ok(await anonymous.from('businesses').select('id,open_now').eq('id', A.id).single());
  assert.equal(listed.open_now, false, 'el listado público ya lo muestra cerrado');
  assert.equal(failsWith(await order(buyer, A.id, [line(A.products.untracked)]), '23514').message, 'Business closed');
  ok(await owner.from('business_hours').delete().eq('business_id', A.id));
  assert.equal(ok(await anonymous.from('businesses').select('open_now').eq('id', A.id).single()).open_now, true);

  ok(await owner.rpc('set_product_availability', { product: A.products.untracked.id, is_available: false }));
  assert.equal(failsWith(await order(buyer, A.id, [line(A.products.untracked)]), '23514').message, 'Product not available');
  ok(await owner.rpc('set_product_availability', { product: A.products.untracked.id, is_available: true }));

  ok(await owner.from('businesses').update({ pickup_enabled: false }).eq('id', A.id));
  assert.equal(failsWith(await order(buyer, A.id, [line(A.products.untracked)]), '23514').message, 'Pickup not available');
  ok(await owner.from('businesses').update({ pickup_enabled: true }).eq('id', A.id));

  ok(await owner.rpc('set_business_presence', { business: A.id, next_status: 'paused' }));
  assert.equal(failsWith(await order(buyer, A.id, [line(A.products.untracked)]), '23514').message, 'Business not available');
  ok(await owner.rpc('set_business_presence', { business: A.id, next_status: 'active', is_open: true }));
});

test('un horario que cruza la medianoche se interpreta en la hora local', async () => {
  const owner = people.owner.client;
  const [{ dow }] = await sql`select extract(dow from now() at time zone 'America/Argentina/Buenos_Aires')::int as dow`;
  const yesterday = (dow + 6) % 7;
  const at = hour => sql`select private.within_business_hours(${A.id}::uuid,
    ((now() at time zone 'America/Argentina/Buenos_Aires')::date + ${hour}::time) at time zone 'America/Argentina/Buenos_Aires') as open`;
  ok(await owner.from('business_hours').insert({ business_id: A.id, weekday: yesterday, opens: '20:00', closes: '02:00' }));
  assert.equal((await at('01:30'))[0].open, true, 'la madrugada de hoy pertenece al turno de ayer');
  assert.equal((await at('02:30'))[0].open, false);
  ok(await owner.from('business_hours').delete().eq('business_id', A.id));
});

test('límite contra abuso: pocos pedidos sin atender por persona', async () => {
  const buyer = nextCustomer();
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(ok(await order(buyer, A.id, [line(A.products.untracked)])));
  failsWith(await order(buyer, A.id, [line(A.products.untracked)]), 'U0006');
  ok(await transition(people.owner, ids[0], 'accepted'));
  ok(await order(buyer, A.id, [line(A.products.untracked)]));
});

test('retiro: sólo el comercio avanza, en orden, con control de versión e historial completo', async () => {
  const buyer = nextCustomer();
  const id = ok(await order(buyer, A.id, [line(A.products.untracked, 2)]));
  failsWith(await transition(buyer, id, 'accepted'), '42501');
  failsWith(await transition(people.ownerB, id, 'accepted'), '42501');
  failsWith(await transition(people.owner, id, 'ready'), '42501');
  failsWith(await transition(people.owner, id, 'delivered'), '42501');
  failsWith(await transition(people.owner, id, 'assigned'), '42501');
  failsWith(await transition(people.owner, id, 'accepted', { version: 7 }), 'U0001');
  let version = 1;
  for (const next of ['accepted', 'preparing', 'ready', 'delivered']) {
    const row = ok(await transition(people.owner, id, next, { version }));
    assert.equal(row.status, next);
    version = row.version;
  }
  failsWith(await transition(people.owner, id, 'preparing'), '42501');
  failsWith(await transition(people.owner, id, 'canceled', { reason: 'Tarde' }), '42501');
  failsWith(await transition(buyer, id, 'canceled'), '42501');
  const row = ok(await buyer.client.from('orders').select('status,payment_status').eq('id', id).single());
  assert.deepEqual(row, { status: 'delivered', payment_status: 'settled' });
  const history = ok(await buyer.client.from('order_events').select('from_status,to_status,actor_role,created_at')
    .eq('order_id', id).order('created_at'));
  assert.deepEqual(history.map(event => [event.from_status, event.to_status]), [
    [null, 'submitted'], ['submitted', 'accepted'], ['accepted', 'preparing'], ['preparing', 'ready'], ['ready', 'delivered'],
  ]);
  assert.deepEqual(history.map(event => event.actor_role), ['customer', 'merchant', 'merchant', 'merchant', 'merchant']);
  const times = history.map(event => Date.parse(event.created_at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('envío: reparto propio del comercio y cierre con motivo si no se pudo entregar', async () => {
  const buyer = nextCustomer();
  const owner = people.owner.client;
  const rider = ok(await owner.from('business_riders').insert({ business_id: A.id, name: `Reparto ${Date.now()}` }).select().single());
  const foreignRider = ok(await people.ownerB.client.from('business_riders').insert({ business_id: B.id, name: `Ajeno ${Date.now()}` }).select().single());
  const id = ok(await order(buyer, A.id, [line(A.products.variants, 1, A.variants.Grande)], { fulfillment: 'delivery' }));
  for (const next of ['accepted', 'preparing', 'ready']) ok(await transition(people.owner, id, next));
  assert.equal(failsWith(await transition(people.owner, id, 'assigned'), '23514').message, 'Choose who delivers');
  assert.equal(failsWith(await transition(people.owner, id, 'assigned', { rider: foreignRider.id }), '23514').message, 'Rider not available');
  ok(await transition(people.owner, id, 'assigned', { rider: rider.id }));
  ok(await transition(people.owner, id, 'picked_up'));
  ok(await transition(people.owner, id, 'on_the_way'));
  assert.equal(failsWith(await transition(people.owner, id, 'canceled'), '23514').message, 'Reason required');
  const closed = ok(await transition(people.owner, id, 'canceled', { reason: 'Nadie atendió en el domicilio' }));
  assert.equal(closed.status, 'canceled');
  assert.equal(closed.cancel_reason, 'Nadie atendió en el domicilio');
  const last = ok(await buyer.client.from('order_events').select('from_status,to_status,note')
    .eq('order_id', id).order('created_at', { ascending: false }).limit(1).single());
  assert.deepEqual(last, { from_status: 'on_the_way', to_status: 'canceled', note: 'Nadie atendió en el domicilio' });
});

test('el comercio rechaza con motivo; la persona cancela sólo antes de que lo acepten', async () => {
  const buyer = nextCustomer();
  const first = ok(await order(buyer, A.id, [line(A.products.untracked)]));
  assert.equal(failsWith(await transition(people.owner, first, 'canceled', { reason: ' ' }), '23514').message, 'Reason required');
  ok(await transition(people.owner, first, 'canceled', { reason: 'Nos quedamos sin masa' }));
  const second = ok(await order(buyer, A.id, [line(A.products.untracked)]));
  ok(await transition(people.owner, second, 'accepted'));
  failsWith(await transition(buyer, second, 'canceled'), '42501');
});

test('seguimiento por enlace: estado y detalle sin datos personales', async () => {
  const buyer = people.guest;
  const id = ok(await order(buyer, A.id, [line(A.products.untracked, 2)], { contactData: contact({ name: 'Nombre Privado' }) }));
  const { tracking_token: token } = ok(await buyer.client.from('orders').select('tracking_token').eq('id', id).single());
  ok(await transition(people.owner, id, 'accepted'));
  const tracked = ok(await anonClient().rpc('track_order', { token }));
  assert.equal(tracked.status, 'accepted');
  assert.equal(tracked.items[0].quantity, 2);
  assert.deepEqual(tracked.history.map(step => step.status), ['submitted', 'accepted']);
  const serialized = JSON.stringify(tracked);
  assert.equal(serialized.includes('Nombre Privado'), false);
  assert.equal(serialized.includes('2942 401122'), false);
  assert.equal(ok(await anonClient().rpc('track_order', { token: randomUUID() })), null);
});

test('los códigos de pedido no se truncan después del 9.999', async () => {
  // La secuencia sólo avanza: retrocederla chocaría con códigos ya emitidos.
  const [{ start }] = await sql`select setval('private.order_code_seq', greatest(9998,
    (select coalesce(max(substring(code from 4)::bigint), 0) from public.orders))) as start`;
  const expected = [1, 2, 3].map(step => {
    const n = Number(start) + step;
    return `CA-${n < 10000 ? String(n).padStart(4, '0') : n}`;
  });
  const codes = [];
  for (let i = 0; i < 3; i += 1) {
    const buyer = nextCustomer();
    const id = ok(await order(buyer, A.id, [line(A.products.untracked)]));
    codes.push(ok(await buyer.client.from('orders').select('code').eq('id', id).single()).code);
  }
  assert.deepEqual(codes, expected);
  assert.ok(codes.every(code => /^CA-\d{4,}$/.test(code)));
});
