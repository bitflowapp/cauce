// Panel remoto del comercio contra Supabase real (stack local). Cada operación
// pasa por el MISMO repositorio que usa la aplicación, con la sesión de cada
// rol: titular, encargado/a y equipo de A, y el titular de otro comercio (B).
// Lo que la interfaz no muestra, igual se intenta: la base tiene que negarlo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRepository } from '../../js/repositories/supabase-repository.js';
import {
  sql, account, guest, makeAdmin, publishedBusiness, order, ok, closeAll,
} from './harness.mjs';

const memory = { getItem: () => null, setItem() {}, removeItem() {} };
const people = {};
const repo = {};
let A, B, riderA, riderB, deliveryA, pickupA, orderB;

// Falla con el código indicado (de la base o del repositorio), nunca en silencio.
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

before(async () => {
  for (const name of ['ownerA', 'managerA', 'staffA', 'ownerB', 'admin']) people[name] = await account(`panel-${name}`);
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Panel Alfa' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Panel Beta' });
  ok(await people.ownerA.client.rpc('add_business_member',
    { business: A.id, member_email: people.managerA.email, member_role: 'manager' }), 'sumar encargado/a');
  ok(await people.ownerA.client.rpc('add_business_member',
    { business: A.id, member_email: people.staffA.email, member_role: 'staff' }), 'sumar equipo');
  for (const name of Object.keys(people)) {
    repo[name] = createSupabaseRepository({ client: people[name].client, storage: memory });
  }
  riderA = await repo.ownerA.command('rider.create', { businessId: A.id, name: 'Reparto Alfa', phone: '2942 555111' });
  riderB = await repo.ownerB.command('rider.create', { businessId: B.id, name: 'Reparto Beta' });
  const line = (product, quantity = 1) => [{ product_id: product.id, quantity }];
  // El envío de la prueba supera el pedido mínimo del comercio ($ 3.000).
  deliveryA = ok(await order(await guest('panel-envio'), A.id, line(A.products.untracked, 3), { fulfillment: 'delivery' }));
  pickupA = ok(await order(await guest('panel-retiro'), A.id, line(A.products.untracked)));
  orderB = ok(await order(await guest('panel-b'), B.id, line(B.products.untracked)));
});

after(async () => { await closeAll(Object.values(people)); });

test('cada rol abre sólo su comercio y lee sólo sus pedidos, su reparto y su equipo', async () => {
  for (const [name, role] of [['ownerA', 'owner'], ['managerA', 'manager'], ['staffA', 'staff']]) {
    const mine = await repo[name].query('myBusinesses');
    assert.deepEqual(mine.map(business => [business.id, business.membershipRole]), [[A.id, role]], `${name}: sólo A`);
    const orders = await repo[name].query('businessOrders', { businessId: A.id });
    assert.ok(orders.some(item => item.id === deliveryA) && orders.some(item => item.id === pickupA), `${name} ve los pedidos de A`);
    assert.ok((await repo[name].query('riders', { businessId: A.id })).some(item => item.id === riderA.id), `${name} ve el reparto de A`);
    // Pedir lo de B con su id: la base no devuelve nada.
    assert.deepEqual(await repo[name].query('businessOrders', { businessId: B.id }), [], `${name} no ve pedidos de B`);
    assert.deepEqual(await repo[name].query('riders', { businessId: B.id }), [], `${name} no ve el reparto de B`);
    await rejects(repo[name].query('order', { orderId: orderB }), 'ORDER_NOT_FOUND', `${name} abre un pedido de B`);
    await rejects(repo[name].query('team', { businessId: B.id }), '42501', `${name} lee el equipo de B`);
  }
  assert.deepEqual(await repo.ownerB.query('businessOrders', { businessId: A.id }), [], 'B no ve pedidos de A');
});

test('pedidos: todo el equipo los mueve con la versión vista; uno ajeno o desactualizado, no', async () => {
  const move = (name, id, nextStatus, extra = {}) => repo[name].command('order.transition',
    { orderId: id, nextStatus, ...extra });
  let version = await versionOf(deliveryA);
  await move('staffA', deliveryA, 'accepted', { expectedVersion: version });
  // La misma versión otra vez (doble toque o dos pantallas): la base lo frena.
  await rejects(move('ownerA', deliveryA, 'preparing', { expectedVersion: version }), 'U0001', 'versión vieja');
  version = await versionOf(deliveryA);
  await move('managerA', deliveryA, 'preparing', { expectedVersion: version });
  await move('ownerA', deliveryA, 'ready', { expectedVersion: await versionOf(deliveryA) });
  // Reparto: asignar a alguien de otro comercio no se puede; a alguien propio, sí (también el equipo).
  await rejects(move('staffA', deliveryA, 'assigned', { expectedVersion: await versionOf(deliveryA), riderId: riderB.id }),
    '23514', 'reparto de otro comercio');
  await move('staffA', deliveryA, 'assigned', { expectedVersion: await versionOf(deliveryA), riderId: riderA.id });
  for (const next of ['picked_up', 'on_the_way', 'delivered']) {
    await move('staffA', deliveryA, next, { expectedVersion: await versionOf(deliveryA) });
  }
  const [done] = await sql`select status, rider_id, payment_status from public.orders where id = ${deliveryA}`;
  assert.deepEqual({ ...done }, { status: 'delivered', rider_id: riderA.id, payment_status: 'settled' });

  // Rechazar exige motivo; con motivo, queda registrado.
  await rejects(move('staffA', pickupA, 'canceled', { reason: '' }), '23514', 'rechazo sin motivo');
  await move('staffA', pickupA, 'canceled', { reason: 'Sin stock de lo pedido' });
  assert.equal((await sql`select cancel_reason from public.orders where id = ${pickupA}`)[0].cancel_reason, 'Sin stock de lo pedido');

  // Un pedido de B, desde A: ni siquiera se sabe si existe.
  for (const name of ['ownerA', 'managerA', 'staffA']) {
    await rejects(move(name, orderB, 'accepted'), '42501', `${name} mueve un pedido de B`);
  }
  assert.equal((await sql`select status from public.orders where id = ${orderB}`)[0].status, 'submitted');
});

test('catálogo: titular y encargado/a crean, editan, desactivan y reactivan; nunca con precio negativo', async () => {
  const created = await repo.managerA.command('product.create', { businessId: A.id,
    product: { name: 'Pan casero', price: 2500, description: 'De masa madre', category: 'Panadería', trackStock: true, stock: 4 } });
  assert.equal(created.price, 2500);
  const edited = await repo.ownerA.command('product.update', { businessId: A.id, productId: created.id,
    patch: { name: 'Pan de campo', price: 2800, description: 'Horneado a leña' } });
  assert.deepEqual([edited.name, edited.price, edited.description], ['Pan de campo', 2800, 'Horneado a leña']);
  assert.equal((await repo.managerA.command('product.update', { businessId: A.id, productId: created.id,
    patch: { archived: true } })).archived, true, 'desactivar');
  assert.equal((await repo.ownerA.command('product.update', { businessId: A.id, productId: created.id,
    patch: { archived: false } })).archived, false, 'reactivar');

  await rejects(repo.ownerA.command('product.update', { businessId: A.id, productId: created.id, patch: { price: -1 } }),
    'INVALID_PRICE', 'precio negativo desde el panel');
  // Aunque alguien salte la interfaz, la base tampoco lo acepta.
  const direct = await people.ownerA.client.from('products').update({ price_ars: -1 }).eq('id', created.id).select();
  assert.equal(direct.error?.code, '23514', 'precio negativo directo');
  assert.equal((await sql`select price_ars::int as price_ars from public.products where id = ${created.id}`)[0].price_ars, 2800);
});

test('catálogo: el equipo sólo marca disponibilidad y stock', async () => {
  const product = A.products.tracked;
  await rejects(repo.staffA.command('product.update', { businessId: A.id, productId: product.id, patch: { price: 1 } }),
    'PRODUCT_FORBIDDEN', 'equipo cambia el precio');
  await rejects(repo.staffA.command('product.create', { businessId: A.id, product: { name: 'Intruso', price: 10 } }),
    ['42501', 'BUSINESS_FORBIDDEN'], 'equipo crea productos');
  const soldOut = await repo.staffA.command('product.update', { businessId: A.id, productId: product.id,
    patch: { available: false } });
  assert.equal(soldOut.available, false);
  const restocked = await repo.staffA.command('product.update', { businessId: A.id, productId: product.id,
    patch: { stock: 7, currentAvailable: true } });
  assert.equal(restocked.stock, 7);
  const [row] = await sql`select price_ars::int as price_ars from public.products where id = ${product.id}`;
  assert.equal(row.price_ars, 9000, 'el precio no cambió');
});

test('catálogo: nadie toca productos ni categorías de otro comercio', async () => {
  const foreign = B.products.untracked;
  await rejects(repo.ownerA.command('product.update', { businessId: A.id, productId: foreign.id, patch: { price: 1 } }),
    'PRODUCT_FORBIDDEN', 'A edita un producto de B');
  await rejects(repo.ownerA.command('product.update', { businessId: B.id, productId: foreign.id, patch: { archived: true } }),
    'PRODUCT_FORBIDDEN', 'A desactiva un producto de B');
  await rejects(repo.staffA.command('product.update', { businessId: B.id, productId: foreign.id, patch: { available: false } }),
    '42501', 'equipo de A agota un producto de B');
  await rejects(repo.ownerA.command('product.create', { businessId: B.id, product: { name: 'Intruso', price: 10 } }),
    ['42501', 'BUSINESS_FORBIDDEN'], 'A carga un producto en B');
  const [row] = await sql`select price_ars::int as price_ars, archived, available from public.products where id = ${foreign.id}`;
  assert.deepEqual({ ...row }, { price_ars: 1200, archived: false, available: true }, 'B intacto');
});

test('categorías: crear, renombrar, ordenar y desactivar, sólo en el propio comercio', async () => {
  const bebidas = await repo.ownerA.command('productCategory.create', { businessId: A.id, name: 'Bebidas' });
  const postres = await repo.managerA.command('productCategory.create', { businessId: A.id, name: 'Postres' });
  await repo.managerA.command('productCategory.update', { businessId: A.id, categoryId: bebidas.id, patch: { name: 'Bebidas frías' } });
  await repo.ownerA.command('productCategory.reorder', { businessId: A.id, order: [postres.id, bebidas.id] });
  await repo.ownerA.command('productCategory.update', { businessId: A.id, categoryId: postres.id, patch: { active: false } });
  const categories = await repo.staffA.query('productCategories', { businessId: A.id });
  const byId = Object.fromEntries(categories.map(item => [item.id, item]));
  assert.equal(byId[bebidas.id].name, 'Bebidas frías');
  assert.ok(byId[postres.id].position < byId[bebidas.id].position, 'el orden elegido');
  assert.equal(byId[postres.id].active, false);

  await rejects(repo.staffA.command('productCategory.update', { businessId: A.id, categoryId: bebidas.id, patch: { name: 'X de equipo' } }),
    'BUSINESS_FORBIDDEN', 'equipo renombra');
  await rejects(repo.staffA.command('productCategory.create', { businessId: A.id, name: 'Del equipo' }),
    ['42501', 'BUSINESS_FORBIDDEN'], 'equipo crea categorías');
  // B, con el id de una categoría de A: por su comercio o por el de A, nada cambia.
  await rejects(repo.ownerB.command('productCategory.update', { businessId: B.id, categoryId: bebidas.id, patch: { name: 'Robada' } }),
    'BUSINESS_FORBIDDEN', 'B renombra una categoría de A');
  await rejects(repo.ownerB.command('productCategory.update', { businessId: A.id, categoryId: bebidas.id, patch: { active: false } }),
    'BUSINESS_FORBIDDEN', 'B desactiva una categoría de A');
  await rejects(repo.ownerB.command('productCategory.reorder', { businessId: A.id, order: [bebidas.id, postres.id] }),
    'BUSINESS_FORBIDDEN', 'B reordena categorías de A');
  const after = Object.fromEntries((await sql`select id, name, position, active from public.product_categories
    where id in ${sql([bebidas.id, postres.id])}`).map(item => [item.id, item]));
  assert.equal(after[bebidas.id].name, 'Bebidas frías');
  assert.ok(after[postres.id].position < after[bebidas.id].position);
  assert.equal(after[bebidas.id].active, true);
});

test('configuración y horarios: titular y encargado/a; equipo y otro comercio, no', async () => {
  const week = [{ weekday: 1, opens: '09:00', closes: '13:00' }, { weekday: 1, opens: '17:00', closes: '21:00' },
    { weekday: 5, opens: '20:00', closes: '01:00' }];
  await repo.managerA.command('business.setHours', { businessId: A.id, hours: week });
  await repo.managerA.command('business.update', { businessId: A.id, patch: { pickupEnabled: true, deliveryEnabled: true,
    deliveryFee: 1800, minimumOrder: 4000, prepMinutes: 25, deliveryMinutes: 20, whatsapp: '2942 401122' } });
  await repo.managerA.command('business.setOpen', { businessId: A.id, open: false });
  const [saved] = (await repo.managerA.query('myBusinesses'));
  assert.deepEqual(saved.hours.map(range => [range.weekday, range.opens.slice(0, 5), range.closes.slice(0, 5)]).sort(),
    [[1, '09:00', '13:00'], [1, '17:00', '21:00'], [5, '20:00', '01:00']], 'la semana tal como se cargó');
  assert.deepEqual([saved.deliveryFee, saved.minimumOrder, saved.prepMinutes, saved.deliveryMinutes],
    [1800, 4000, 25, 20]);
  assert.equal(saved.acceptingOrders, false, 'cerró la atención');
  await repo.ownerA.command('business.setOpen', { businessId: A.id, open: true });

  const attempts = {
    'business.setHours': { businessId: A.id, hours: [] },
    'business.update': { businessId: A.id, patch: { deliveryFee: 1 } },
    'business.setOpen': { businessId: A.id, open: false },
  };
  for (const [command, payload] of Object.entries(attempts)) {
    await rejects(repo.staffA.command(command, payload), ['42501', 'BUSINESS_FORBIDDEN'], `equipo: ${command}`);
    await rejects(repo.ownerB.command(command, payload), ['42501', 'BUSINESS_FORBIDDEN'], `B: ${command}`);
  }
  const [row] = await sql`select delivery_fee_ars::int as delivery_fee_ars, open from public.businesses where id = ${A.id}`;
  assert.deepEqual({ ...row }, { delivery_fee_ars: 1800, open: true });
  assert.equal((await sql`select count(*)::int as total from public.business_hours where business_id = ${A.id}`)[0].total, 3);
});

test('equipo: el titular lo administra, encargado/a lo ve, el equipo no; B no toca a A', async () => {
  assert.equal((await repo.ownerA.query('team', { businessId: A.id })).length, 3);
  assert.equal((await repo.managerA.query('team', { businessId: A.id })).length, 3);
  await rejects(repo.staffA.query('team', { businessId: A.id }), '42501', 'equipo lee el equipo');
  await rejects(repo.managerA.command('team.setRole', { businessId: A.id, userId: people.staffA.id, role: 'manager' }),
    '42501', 'encargado/a asciende');
  await rejects(repo.ownerB.command('team.remove', { businessId: A.id, userId: people.managerA.id }), '42501', 'B quita en A');
  await rejects(repo.ownerB.command('team.add', { businessId: A.id, email: people.ownerB.email, role: 'manager' }),
    '42501', 'B se suma a A');
  await repo.ownerA.command('team.setRole', { businessId: A.id, userId: people.staffA.id, role: 'manager' });
  await repo.ownerA.command('team.setRole', { businessId: A.id, userId: people.staffA.id, role: 'staff' });
  const roles = await sql`select role from public.business_memberships where business_id = ${A.id} order by role`;
  assert.deepEqual(roles.map(item => item.role), ['manager', 'owner', 'staff']);
});

test('reparto: titular y encargado/a cargan y pausan; el equipo sólo lo ve; B no toca a A', async () => {
  const added = await repo.managerA.command('rider.create', { businessId: A.id, name: 'Moto dos' });
  assert.equal((await repo.managerA.command('rider.setActive', { riderId: added.id, active: false })).active, false);
  await rejects(repo.staffA.command('rider.create', { businessId: A.id, name: 'Del equipo' }),
    ['42501', 'BUSINESS_FORBIDDEN'], 'equipo carga reparto');
  await rejects(repo.staffA.command('rider.setActive', { riderId: riderA.id, active: false }), 'BUSINESS_FORBIDDEN', 'equipo pausa');
  await rejects(repo.ownerB.command('rider.setActive', { riderId: riderA.id, active: false }), 'BUSINESS_FORBIDDEN', 'B pausa en A');
  await rejects(repo.ownerB.command('rider.create', { businessId: A.id, name: 'Intruso' }),
    ['42501', 'BUSINESS_FORBIDDEN'], 'B carga reparto en A');
  const [row] = await sql`select active from public.business_riders where id = ${riderA.id}`;
  assert.equal(row.active, true);
});
