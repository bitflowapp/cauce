// Reparto propio v1 contra Supabase real (stack local): GoTrue, PostgREST y
// Realtime de verdad, con el MISMO repositorio que usa la aplicación. Quien
// reparte ve y mueve sólo lo que su comercio le asignó; todo lo demás se
// intenta igual y la base lo niega.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRepository } from '../../js/repositories/supabase-repository.js';
import {
  sql, account, guest, anonClient, makeAdmin, publishedBusiness, order, ok, closeAll,
} from './harness.mjs';

const memory = { getItem: () => null, setItem() {}, removeItem() {} };
const people = {};
const repo = {};
const channels = [];
let A, B, riderRowA, riderRowB;

async function rejects(promise, codes, label) {
  const expected = [codes].flat();
  try {
    await promise;
  } catch (error) {
    assert.ok(expected.includes(error.code), `${label}: se esperaba ${expected.join(' o ')} y llegó ${error.code} (${error.message})`);
    return;
  }
  assert.fail(`${label}: la operación debía fallar y funcionó`);
}
const versionOf = async id => (await sql`select version from public.orders where id = ${id}`)[0].version;
const codeOf = async id => (await sql`select delivery_code from public.orders where id = ${id}`)[0].delivery_code;
const tokenOf = async id => (await sql`select tracking_token::text as t from public.orders where id = ${id}`)[0].t;
const line = (shop, quantity = 3) => [{ product_id: shop.products.untracked.id, quantity }];

// Un envío listo y asignado, como lo deja el comercio. Cada pedido lo hace una
// compra sin cuenta distinta: la base limita los pedidos seguidos por persona.
async function assignedTo(shop, owner, riderId) {
  const id = ok(await order(await guest('reparto-cliente'), shop.id, line(shop), { fulfillment: 'delivery' }));
  for (const next of ['accepted', 'preparing', 'ready']) {
    await repo[owner].command('order.transition', { orderId: id, expectedVersion: await versionOf(id), nextStatus: next });
  }
  if (riderId) {
    await repo[owner].command('order.transition', { orderId: id, expectedVersion: await versionOf(id),
      nextStatus: 'assigned', riderId });
  }
  return id;
}
const step = async (who, id, next) => repo[who].command('order.transition',
  { orderId: id, expectedVersion: await versionOf(id), nextStatus: next });

before(async () => {
  for (const name of ['ownerA', 'managerA', 'staffA', 'ownerB', 'riderA', 'riderB', 'stranger', 'admin']) {
    people[name] = await account(`reparto-${name}`);
  }
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Reparto Alfa' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Reparto Beta' });
  ok(await people.ownerA.client.rpc('add_business_member',
    { business: A.id, member_email: people.managerA.email, member_role: 'manager' }), 'encargado/a');
  ok(await people.ownerA.client.rpc('add_business_member',
    { business: A.id, member_email: people.staffA.email, member_role: 'staff' }), 'equipo');
  for (const name of Object.keys(people)) repo[name] = createSupabaseRepository({ client: people[name].client, storage: memory });
  riderRowA = await repo.ownerA.command('rider.create', { businessId: A.id, name: 'Moto Alfa', phone: '2942 555111' });
  riderRowB = await repo.ownerB.command('rider.create', { businessId: B.id, name: 'Moto Beta' });
});

after(async () => {
  for (const { client, channel } of channels) await client.removeChannel(channel);
  await closeAll(Object.values(people));
});

test('vincular una cuenta es de titular o encargado/a, por correo, dentro de su comercio', async () => {
  await rejects(repo.staffA.command('rider.linkAccount', { riderId: riderRowA.id, email: people.riderA.email }), '42501', 'equipo');
  await rejects(repo.ownerB.command('rider.linkAccount', { riderId: riderRowA.id, email: people.riderA.email }), '42501', 'otro comercio');
  await rejects(repo.riderA.command('rider.linkAccount', { riderId: riderRowA.id, email: people.riderA.email }), '42501', 'la misma persona');
  await rejects(repo.ownerA.command('rider.linkAccount', { riderId: riderRowA.id, email: 'nadie-reparto@cauce.test' }), 'P0002', 'sin cuenta');
  await rejects(repo.ownerA.command('rider.linkAccount', { riderId: riderRowA.id, email: 'no-es-correo' }), 'INVALID_EMAIL', 'correo inválido');
  await repo.managerA.command('rider.linkAccount', { riderId: riderRowA.id, email: people.riderA.email.toUpperCase() });
  await repo.ownerB.command('rider.linkAccount', { riderId: riderRowB.id, email: people.riderB.email });
  assert.deepEqual(await repo.ownerA.query('riderAccounts', { businessId: A.id }), { [riderRowA.id]: people.riderA.email });
  await rejects(repo.staffA.query('riderAccounts', { businessId: A.id }), '42501', 'el equipo no ve correos');
  await rejects(repo.ownerB.query('riderAccounts', { businessId: A.id }), '42501', 'otro comercio no ve correos');
  const riders = await repo.staffA.query('riders', { businessId: A.id });
  assert.equal(riders.find(item => item.id === riderRowA.id).linked, true, 'el equipo ve que tiene cuenta');
  // La columna no se escribe por fuera de la función.
  const direct = await people.ownerA.client.from('business_riders').update({ user_id: people.stranger.id }).eq('id', riderRowA.id).select();
  assert.ok(direct.error, 'user_id no es escribible directo');
  assert.equal((await sql`select user_id::text as u from public.business_riders where id = ${riderRowA.id}`)[0].u, people.riderA.id);
});

test('la sesión de quien reparte trae el rol de reparto y sólo sus filas', async () => {
  const session = await repo.riderA.session({ fresh: true });
  assert.ok(session.actor.roles.includes('rider'));
  assert.ok(!session.actor.roles.includes('merchant'), 'repartir no es integrar el comercio');
  assert.deepEqual(session.actor.riderIds, [riderRowA.id]);
  assert.ok(!(await repo.stranger.session({ fresh: true })).actor.roles.includes('rider'));
  const profiles = await repo.riderA.query('myRiderProfiles');
  assert.deepEqual(profiles.map(item => item.id), [riderRowA.id]);
  assert.match(profiles[0].businessName, /^Reparto Alfa /);
  // Leer la tabla directo: sólo la fila propia, nunca el reparto del comercio.
  const rows = ok(await people.riderA.client.from('business_riders').select('id'));
  assert.deepEqual(rows.map(row => row.id), [riderRowA.id]);
});

test('quien reparte lee sus entregas por la función: sin código, sin cuenta del cliente, sin pedidos ajenos', async () => {
  const mine = await assignedTo(A, 'ownerA', riderRowA.id);
  const unassigned = await assignedTo(A, 'ownerA', null);
  const foreign = await assignedTo(B, 'ownerB', riderRowB.id);
  const list = await repo.riderA.query('riderOrders');
  const ids = list.map(item => item.id);
  assert.ok(ids.includes(mine));
  assert.ok(!ids.includes(unassigned) && !ids.includes(foreign));
  const item = list.find(entry => entry.id === mine);
  assert.equal(item.status, 'assigned');
  assert.equal(item.customer.address, 'Calle Los Pehuenes 45');
  assert.equal(item.customer.phone, '2942 401122');
  assert.equal(item.business.id, A.id);
  assert.equal(item.locality, 'Aluminé');
  assert.equal(item.total, 3 * 1200 + 1500);
  assert.equal(item.codeAttemptsLeft, 5);
  assert.ok(!('deliveryCode' in item) && !('customerId' in item) && !('trackingToken' in item));
  const raw = ok(await people.riderA.client.rpc('rider_orders'));
  assert.ok(raw.every(entry => !('delivery_code' in entry) && !('customer_id' in entry) && !('tracking_token' in entry)));
  for (const table of ['orders', 'order_items', 'order_events']) {
    assert.deepEqual(ok(await people.riderA.client.from(table).select('*')), [], `sin lectura directa de ${table}`);
  }
  assert.deepEqual((await repo.riderB.query('riderOrders')).map(entry => entry.id), [foreign]);
  assert.deepEqual(await repo.stranger.query('riderOrders'), []);
  const anon = await anonClient().rpc('rider_orders');
  assert.ok(anon.error, 'sin sesión no se ejecuta');
});

test('del comercio a la puerta: retiro, salida, llegada y entrega con el código, y el cliente lo sigue', async () => {
  const id = await assignedTo(A, 'managerA', riderRowA.id);
  const token = await tokenOf(id);
  const track = async () => ok(await anonClient().rpc('track_order', { token })).status;
  await step('riderA', id, 'picked_up');
  assert.equal(await track(), 'picked_up');
  await step('riderA', id, 'on_the_way');
  await step('riderA', id, 'arrived');
  assert.equal(await track(), 'arrived');
  await rejects(step('riderA', id, 'delivered'), '23514', 'entregar sin código');
  const code = await codeOf(id);
  const wrong = code === '0000' ? '1111' : '0000';
  const miss = await repo.riderA.command('order.confirmDelivery', { orderId: id, expectedVersion: await versionOf(id), code: wrong });
  assert.deepEqual({ ok: miss.ok, reason: miss.reason, remaining: miss.remaining }, { ok: false, reason: 'wrong', remaining: 4 });
  assert.equal((await repo.riderA.query('riderOrders')).find(entry => entry.id === id).codeAttemptsLeft, 4);
  const done = await repo.riderA.command('order.confirmDelivery', { orderId: id, expectedVersion: await versionOf(id),
    code: `${code.slice(0, 2)} ${code.slice(2)}` });
  assert.equal(done.ok, true);
  assert.equal(await track(), 'delivered');
  // El comercio lo ve cerrado, cobrado y con quién lo entregó.
  const seen = (await repo.ownerA.query('businessOrders', { businessId: A.id })).find(entry => entry.id === id);
  assert.equal(seen.status, 'delivered');
  assert.equal(seen.paymentStatus, 'settled');
  assert.deepEqual(seen.history.filter(event => event.by === 'rider').map(event => event.status),
    ['picked_up', 'on_the_way', 'arrived', 'delivered']);
  // En el historial de quien reparte ya no están los datos de contacto.
  const closed = (await repo.riderA.query('riderOrders')).find(entry => entry.id === id);
  assert.equal(closed.status, 'delivered');
  assert.equal(closed.customer.phone, '');
  assert.equal(closed.customer.address, '');
});

test('nada fuera de su entrega: ni asignarse, ni cancelar, ni otro comercio, ni el catálogo', async () => {
  const ready = await assignedTo(A, 'ownerA', null);
  await rejects(repo.riderA.command('order.transition', { orderId: ready, expectedVersion: await versionOf(ready),
    nextStatus: 'assigned', riderId: riderRowA.id }), '42501', 'asignarse un pedido');
  const mine = await assignedTo(A, 'ownerA', riderRowA.id);
  await rejects(repo.riderA.command('order.transition', { orderId: mine, expectedVersion: await versionOf(mine),
    nextStatus: 'canceled', reason: 'No llego' }), '42501', 'cancelar');
  await rejects(repo.riderA.command('order.transition', { orderId: mine, expectedVersion: 1, nextStatus: 'picked_up' }),
    'U0001', 'versión vieja');
  const foreign = await assignedTo(B, 'ownerB', riderRowB.id);
  await rejects(step('riderA', foreign, 'picked_up'), '42501', 'pedido de otro comercio');
  await rejects(repo.riderA.command('order.confirmDelivery', { orderId: foreign, expectedVersion: await versionOf(foreign), code: '1234' }),
    '42501', 'código en pedido ajeno');
  await rejects(step('riderB', mine, 'picked_up'), '42501', 'la persona de otro comercio');
  await rejects(step('stranger', mine, 'picked_up'), '42501', 'una cuenta cualquiera');
  const price = await people.riderA.client.from('products').update({ price_ars: 1 }).eq('id', A.products.untracked.id).select();
  assert.ok(price.error || price.data.length === 0, 'no cambia precios');
  const pause = await people.riderA.client.from('business_riders').update({ active: false }).eq('id', riderRowA.id).select();
  assert.ok(pause.error || pause.data.length === 0, 'no se pausa ni se edita');
  await rejects(repo.riderA.command('product.update', { productId: A.products.untracked.id, businessId: A.id, patch: { price: 1 } }),
    ['PRODUCT_FORBIDDEN', '42501', 'BUSINESS_FORBIDDEN'], 'catálogo por el repositorio');
  assert.equal((await sql`select price_ars::int as p from public.products where id = ${A.products.untracked.id}`)[0].p, 1200);
});

test('pausar o desvincular corta el acceso; el comercio completa la entrega sin la aplicación', async () => {
  const id = await assignedTo(A, 'ownerA', riderRowA.id);
  await step('riderA', id, 'picked_up');
  await repo.ownerA.command('rider.setActive', { riderId: riderRowA.id, active: false });
  assert.deepEqual(await repo.riderA.query('riderOrders'), []);
  assert.ok(!(await repo.riderA.session({ fresh: true })).actor.roles.includes('rider'));
  await rejects(step('riderA', id, 'on_the_way'), '42501', 'en pausa');
  await repo.managerA.command('rider.setActive', { riderId: riderRowA.id, active: true });
  await step('riderA', id, 'on_the_way');
  await repo.riderA.command('rider.unlinkAccount', { riderId: riderRowA.id });
  assert.deepEqual(await repo.riderA.query('riderOrders'), []);
  await rejects(step('riderA', id, 'arrived'), '42501', 'desvinculada');
  await step('ownerA', id, 'delivered');
  assert.equal((await sql`select status from public.orders where id = ${id}`)[0].status, 'delivered');
  // Se vuelve a vincular para el resto de las pruebas.
  await repo.ownerA.command('rider.linkAccount', { riderId: riderRowA.id, email: people.riderA.email });
});

test('Realtime no le entrega pedidos a quien reparte: su vista se actualiza consultando', async () => {
  const listen = (client, filter) => new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error('Realtime no confirmó la suscripción')), 30000);
    const channel = client.channel(`qa-reparto-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter }, payload => events.push(payload))
      .on('system', {}, payload => {
        if (payload?.extension === 'postgres_changes' && payload.status === 'ok') { clearTimeout(timer); resolve(events); }
      })
      .subscribe();
    channels.push({ client, channel });
  });
  const riderEvents = await listen(people.riderA.client, `rider_id=eq.${riderRowA.id}`);
  const merchantEvents = await listen(people.ownerA.client, `business_id=eq.${A.id}`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const id = await assignedTo(A, 'ownerA', riderRowA.id);
  await step('riderA', id, 'picked_up');
  const started = Date.now();
  while (Date.now() - started < 8000 && !merchantEvents.some(event => event.new?.id === id && event.new?.status === 'picked_up')) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(merchantEvents.some(event => event.new?.id === id), 'el comercio sí recibe el cambio (control)');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(riderEvents.length, 0, 'la fila completa (con el código de entrega) nunca llega a quien reparte');
});
