// Pedidos en PostgreSQL embebido: el servidor resuelve precio, stock y total;
// idempotencia, total confirmado, variantes con stock propio, máquina de
// estados por rol, cobro registrado a mano y aislamiento entre vendedores.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorld, denied, failsWith } from './world.mjs';

let w, A, B;
before(async () => {
  w = await createWorld();
  A = await w.publishedBusiness('merchantA', { name: 'Raíces de Barro', stock: 3 });
  B = await w.publishedBusiness('merchantB', { name: 'Tierra Viva', deliveryFee: null });
  await w.root("insert into public.business_memberships (business_id, user_id, role) values ($1, $2, 'staff')",
    [A.id, w.ids.staffA]);
});
after(async () => { await w.close(); });

const stockOf = async id => (await w.root('select stock from public.products where id = $1', [id])).rows[0].stock;
const variantStock = async id => (await w.root('select stock from public.product_variants where id = $1', [id])).rows[0].stock;
const orderRow = async id => (await w.root('select * from public.orders where id = $1', [id])).rows[0];

test('el precio y el total los pone el servidor, no el navegador', async () => {
  const { id } = await w.order('customerA', A.id, [{ product_id: A.product, quantity: 2, price_ars: 1 }]);
  const row = await orderRow(id);
  assert.equal(Number(row.subtotal_ars), 25000);
  assert.equal(Number(row.total_ars), 25000);
  assert.equal(row.status, 'submitted');
  assert.equal(row.payment_status, 'pending');
  assert.match(row.code, /^FN-\d{4}$/);
  assert.equal(await stockOf(A.product), 1);
});

test('si el precio cambió durante el checkout, el pedido no se crea (U0005)', async () => {
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }], { expectedTotal: 1000 }),
    'Prices changed', 'U0005');
  const ok = await w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }], { expectedTotal: 18000 });
  assert.ok(ok.id);
});

test('el mismo intento devuelve el mismo pedido; con otros datos se rechaza (U0002)', async () => {
  const idem = randomUUID();
  const first = await w.order('stranger', A.id, [{ product_id: A.madeToOrder, quantity: 1 }], { idem });
  const again = await w.order('stranger', A.id, [{ product_id: A.madeToOrder, quantity: 1 }], { idem });
  assert.equal(first.id, again.id);
  await failsWith(assert, w.order('stranger', A.id, [{ product_id: A.madeToOrder, quantity: 2 }], { idem }),
    'Repeated attempt with different data', 'U0002');
});

test('no se vende más de lo que hay: stock por producto y por variante (U0003)', async () => {
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.product, quantity: 2 }]), 'Not enough stock', 'U0003');
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.variantProduct, quantity: 1 }]), 'Variant required');
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.variantProduct, variant_id: A.grande, quantity: 2 }]),
    'Not enough stock', 'U0003');
  const { id } = await w.order('guest1', A.id, [{ product_id: A.variantProduct, variant_id: A.grande, quantity: 1 }]);
  assert.equal(Number((await orderRow(id)).total_ars), 11000);
  assert.equal(await variantStock(A.grande), 0);
  // El fallo de una línea no deja reservas a medias.
  await failsWith(assert, w.order('guest2', A.id, [{ product_id: A.variantProduct, variant_id: A.chica, quantity: 1 },
    { product_id: A.variantProduct, variant_id: A.grande, quantity: 1 }]), 'Not enough stock', 'U0003');
  assert.equal(await variantStock(A.chica), 2);
});

test('una variante de otro producto o de otro comercio no se puede usar', async () => {
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.variantProduct, variant_id: B.chica, quantity: 1 }]),
    'Variant not available');
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: B.product, quantity: 1 }]), 'Product not available');
});

test('envío: fijo suma al total; "a coordinar" queda pendiente y no suma', async () => {
  const fixed = await w.order('organizerA', A.id, [{ product_id: A.madeToOrder, quantity: 1 }], { fulfillment: 'delivery' });
  const a = await orderRow(fixed.id);
  assert.equal(Number(a.delivery_fee_ars), 2500);
  assert.equal(Number(a.total_ars), 20500);
  const toAgree = await w.order('organizerA', B.id, [{ product_id: B.madeToOrder, quantity: 1 }], { fulfillment: 'delivery' });
  const b = await orderRow(toAgree.id);
  assert.equal(Number(b.delivery_fee_ars), 0);
  assert.equal(b.delivery_fee_pending, true);
  await failsWith(assert, w.order('organizerA', A.id, [{ product_id: A.madeToOrder, quantity: 1 }],
    { fulfillment: 'delivery', contactData: { name: 'Sin dirección', phone: '299 4112233', address: '' } }), 'Address required');
});

test('datos de contacto, cantidades y forma de pago se validan en el servidor', async () => {
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }],
    { contactData: { name: 'X', phone: '299 4112233' } }), 'Invalid contact name');
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }],
    { contactData: { name: 'Ana Pérez', phone: 'llamame' } }), 'Invalid contact phone');
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 0 }]), 'Invalid quantity');
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 100 }]), 'Invalid quantity');
  await failsWith(assert, w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }], { payment: 'card' }),
    'Payment method not available');
  await failsWith(assert, w.order('customerB', A.id, []), 'Empty cart');
  await denied(assert, w.as('anon', "select public.create_order($1, gen_random_uuid(), 'pickup', 'cash', null, '{}'::jsonb, '[]'::jsonb, null)", [A.id]));
});

test('nadie escribe la tabla de pedidos directamente', async () => {
  const { id } = await w.order('customerB', B.id, [{ product_id: B.madeToOrder, quantity: 1 }]);
  await denied(assert, w.as('customerB', "update public.orders set total_ars = 1 where id = $1", [id]));
  await denied(assert, w.as('merchantB', "update public.orders set status = 'delivered' where id = $1", [id]));
  await denied(assert, w.as('customerB', "insert into public.order_items (order_id, business_id, customer_id, product_name, unit_price_ars, quantity, total_ars) values ($1, $2, $3, 'x', 1, 1, 1)",
    [id, B.id, w.ids.customerB]));
});

test('cada vendedor ve sólo sus pedidos; cada cliente, sólo los suyos', async () => {
  const mine = await w.order('stranger', B.id, [{ product_id: B.madeToOrder, quantity: 1 }]);
  assert.equal((await w.as('merchantA', 'select id from public.orders where id = $1', [mine.id])).rows.length, 0);
  assert.equal((await w.as('customerB', 'select id from public.orders where id = $1', [mine.id])).rows.length, 0);
  assert.equal((await w.as('customerB', 'select id from public.order_items where order_id = $1', [mine.id])).rows.length, 0);
  assert.equal((await w.as('merchantB', 'select id from public.orders where id = $1', [mine.id])).rows.length, 1);
  assert.equal((await w.as('stranger', 'select id from public.orders where id = $1', [mine.id])).rows.length, 1);
  await denied(assert, w.as('merchantA', "select public.transition_order($1, null, 'accepted', '')", [mine.id]));
  await denied(assert, w.as('customerB', "select public.transition_order($1, null, 'canceled', '')", [mine.id]));
});

test('máquina de estados: retiro acordado de punta a punta con cobro manual', async () => {
  const { id } = await w.order('customerB', A.id, [{ product_id: A.madeToOrder, quantity: 1 }], { payment: 'transfer' });
  await denied(assert, w.as('customerB', "select public.transition_order($1, null, 'accepted', '')", [id]));
  await denied(assert, w.as('merchantA', "select public.transition_order($1, null, 'delivered', '')", [id]));
  await w.as('staffA', "select public.transition_order($1, 1, 'accepted', '')", [id]);
  await failsWith(assert, w.as('merchantA', "select public.transition_order($1, 1, 'preparing', '')", [id]),
    'changed while you were looking', 'U0001');
  await w.as('merchantA', "select public.transition_order($1, 2, 'preparing', '')", [id]);
  await w.as('merchantA', "select public.transition_order($1, null, 'ready', '')", [id]);
  await denied(assert, w.as('merchantA', "select public.transition_order($1, null, 'on_the_way', '')", [id]));
  await w.as('merchantA', "select public.transition_order($1, null, 'delivered', '')", [id]);
  // Entregado no significa cobrado: el pago se registra aparte.
  assert.equal((await orderRow(id)).payment_status, 'pending');
  await denied(assert, w.as('customerB', 'select public.set_order_payment($1, null, true)', [id]));
  await denied(assert, w.as('merchantB', 'select public.set_order_payment($1, null, true)', [id]));
  await w.as('staffA', 'select public.set_order_payment($1, null, true)', [id]);
  const row = await orderRow(id);
  assert.equal(row.payment_status, 'paid');
  assert.ok(row.paid_at);
  const events = (await w.as('customerB', 'select to_status, actor_role from public.order_events where order_id = $1 order by created_at', [id])).rows;
  assert.deepEqual(events.map(e => e.to_status), ['submitted', 'accepted', 'preparing', 'ready', 'delivered', 'delivered']);
});

test('cancelar: el cliente sólo antes de que acepten; el comercio con motivo; vuelve el stock', async () => {
  await w.as('merchantA', 'select public.set_stock($1, null, 4, true)', [A.product]);
  const first = await w.order('customerA', A.id, [{ product_id: A.product, quantity: 2 }]);
  assert.equal(await stockOf(A.product), 2);
  await w.as('customerA', "select public.transition_order($1, null, 'canceled', '')", [first.id]);
  assert.equal(await stockOf(A.product), 4);
  const second = await w.order('customerA', A.id, [{ product_id: A.product, quantity: 1 }]);
  await w.as('merchantA', "select public.transition_order($1, null, 'accepted', '')", [second.id]);
  await denied(assert, w.as('customerA', "select public.transition_order($1, null, 'canceled', '')", [second.id]));
  await failsWith(assert, w.as('merchantA', "select public.transition_order($1, null, 'canceled', 'x')", [second.id]), 'Reason required');
  await w.as('merchantA', "select public.transition_order($1, null, 'canceled', 'Se rompió en el horno')", [second.id]);
  assert.equal(await stockOf(A.product), 4);
  assert.equal((await orderRow(second.id)).cancel_reason, 'Se rompió en el horno');
  await failsWith(assert, w.as('merchantA', 'select public.set_order_payment($1, null, true)', [second.id]), 'Order canceled');
});

test('techo contra abuso: más de 3 pedidos sin atender por persona (U0006)', async () => {
  const shop = await w.publishedBusiness('organizerB', { name: 'Tienda techo' });
  for (let i = 0; i < 3; i += 1) await w.order('editorA', shop.id, [{ product_id: shop.madeToOrder, quantity: 1 }]);
  await failsWith(assert, w.order('editorA', shop.id, [{ product_id: shop.madeToOrder, quantity: 1 }]),
    'Too many pending orders', 'U0006');
});

test('compra sin cuenta (sesión anónima) apagable desde la base', async () => {
  await w.root("update private.platform_features set enabled = false where key = 'guest_checkout'");
  await denied(assert, w.order('guest2', A.id, [{ product_id: A.madeToOrder, quantity: 1 }]));
  await w.root("update private.platform_features set enabled = true where key = 'guest_checkout'");
  assert.ok((await w.order('guest2', A.id, [{ product_id: A.madeToOrder, quantity: 1 }])).id);
});

test('el seguimiento por enlace muestra el estado sin teléfono ni correo', async () => {
  const { id } = await w.order('guest1', A.id, [{ product_id: A.madeToOrder, quantity: 1 }],
    { contactData: { name: 'Lucía Gómez', phone: '299 4555666', email: 'lucia@correo.test' } });
  const token = (await orderRow(id)).tracking_token;
  const tracked = (await w.one('anon', 'select public.track_order($1) as t', [token])).t;
  assert.equal(tracked.status, 'submitted');
  assert.equal(tracked.business.name, 'Raíces de Barro');
  assert.equal(JSON.stringify(tracked).includes('299 4555666'), false);
  assert.equal(JSON.stringify(tracked).includes('lucia@correo.test'), false);
  assert.equal((await w.one('anon', 'select public.track_order($1) as t', [randomUUID()])).t, null);
});

test('una tienda pausada por su dueña no recibe pedidos y vuelve al reanudar', async () => {
  await w.as('merchantB', "update public.businesses set accepting_orders = false where id = $1", [B.id]);
  await failsWith(assert, w.order('customerA', B.id, [{ product_id: B.madeToOrder, quantity: 1 }]), 'Business not taking orders');
  assert.equal((await w.one('anon', 'select public.taking_orders(b) as t from public.businesses b where id = $1', [B.id])).t, false);
  await w.as('merchantB', "update public.businesses set accepting_orders = true where id = $1", [B.id]);
  assert.equal((await w.one('anon', 'select public.taking_orders(b) as t from public.businesses b where id = $1', [B.id])).t, true);
});

test('estadísticas: básicas para todos, ampliadas sólo con Pro', async () => {
  const basic = (await w.one('merchantA', 'select public.business_stats($1, 30) as s', [A.id])).s;
  assert.ok(basic.orders > 0);
  assert.equal(basic.advanced, false);
  assert.equal(basic.top_products, undefined);
  await w.as('admin', "select public.admin_set_subscription($1, null, 'pro', 'active', current_date + 30, 10, 'upgrade')", [A.id]);
  const advanced = (await w.one('merchantA', 'select public.business_stats($1, 30) as s', [A.id])).s;
  assert.equal(advanced.advanced, true);
  assert.ok(Array.isArray(advanced.top_products));
  await denied(assert, w.as('staffA', 'select public.business_stats($1, 30)', [A.id]));
});

test('con variantes, el stock del producto es la suma de las variantes activas', async () => {
  const shop = await w.publishedBusiness('customerB', { name: 'Suma de variantes' });
  // Chicos 2 + Grandes 1 al crearse.
  assert.equal(await stockOf(shop.variantProduct), 3);
  await w.order('stranger', shop.id, [{ product_id: shop.variantProduct, variant_id: shop.chica, quantity: 2 }]);
  assert.equal(await stockOf(shop.variantProduct), 1);
  await w.as('customerB', 'select public.set_stock($1, $2, 6, null)', [shop.variantProduct, shop.grande]);
  assert.equal(await stockOf(shop.variantProduct), 6);
  await failsWith(assert, w.as('customerB', 'select public.set_stock($1, null, 9, null)', [shop.variantProduct]),
    'Stock is per variant');
  await w.as('customerB', 'update public.product_variants set active = false where id = $1', [shop.grande]);
  assert.equal(await stockOf(shop.variantProduct), 0);
});
