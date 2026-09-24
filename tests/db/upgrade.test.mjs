// Actualización de esquema con datos: reconstruye la base tal como estaba antes
// del hardening (lo que hoy tiene el proyecto real), la llena con un comercio
// publicado y pedidos en todos los estados usando las funciones de esa versión,
// y recién ahí aplica la migración nueva. Comprueba que nada se pierde y que lo
// que estaba en curso sigue su camino con las reglas nuevas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, applyMigration, migrationFiles, versionOf } from './fixture.mjs';

const HARDENING = 20260924120000;
const db = new PGlite();
const ids = Object.fromEntries(['merchant', 'customer', 'neighbour', 'admin']
  .map((name, i) => [name, `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const rows = result => result.rows;
async function as(name, sql, params = []) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${name === 'anon' ? 'anon' : 'authenticated'}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [ids[name] || '']);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [ids[name]
      ? JSON.stringify({ sub: ids[name], role: 'authenticated', is_anonymous: false }) : '']);
    return tx.query(sql, params);
  });
}

let business, bread, rider, legacyBefore, eventsBefore;
const orders = {};
const contact = { name: 'Vecina Legada', phone: '2942000333', notes: '' };
const legacyOrder = (key, fulfillment, quantity, extra = {}) => as('customer',
  'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb) as id',
  [business, key, fulfillment, fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup',
    JSON.stringify({ ...contact, ...extra }), JSON.stringify([{ product_id: bread, quantity }])]);
const move = (who, order, version, status, reason = '', riderId = null) => as(who,
  'select (public.transition_order($1,$2,$3,$4,$5)).status as status', [order, version, status, riderId, reason]);

before(async () => {
  const applied = await applyMigrations(db, { until: HARDENING });
  assert.ok(applied.length >= 8, 'se reconstruyó el esquema anterior');

  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${name}@cauce.test`]);
    await as(name, 'insert into public.profiles (user_id, display_name) values ($1, $2)', [id, `Legado ${name}`]);
  }
  await db.query('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);

  // Un comercio publicado con la versión anterior (sin teléfono público ni
  // horarios estructurados: esos campos no existían).
  business = rows(await as('merchant', "select public.create_business('Panadería Legado', 'panaderia-legado') as id"))[0].id;
  await as('merchant', `update public.businesses set address='San Martín 100', hours_label='8 a 20',
    delivery_enabled=true, delivery_zone='Casco urbano', delivery_fee_ars=800, minimum_order_ars=1000,
    category_id=(select id from public.business_categories where slug='panaderia') where id=$1`, [business]);
  await as('merchant', "insert into public.business_contacts(business_id,owner_name,phone) values ($1,'Responsable','2942000001')", [business]);
  bread = rows(await as('merchant',
    "insert into public.products(business_id,name,price_ars,stock) values ($1,'Pan casero',1500,20) returning id", [business]))[0].id;
  await as('merchant', 'select public.submit_business_for_review($1)', [business]);
  await as('admin', "select public.review_business($1,'active','Aprobado')", [business]);
  await as('merchant', 'select public.set_business_presence($1,null,true)', [business]);
  rider = rows(await as('merchant', "insert into public.business_riders(business_id,name) values ($1,'Reparto') returning id", [business]))[0].id;

  // Pedidos en todos los momentos del ciclo.
  orders.pending = { key: crypto.randomUUID(), quantity: 1 };
  orders.pending.id = rows(await legacyOrder(orders.pending.key, 'pickup', 1))[0].id;
  orders.done = { key: crypto.randomUUID() };
  orders.done.id = rows(await legacyOrder(orders.done.key, 'pickup', 2))[0].id;
  for (const [version, status] of [[1, 'accepted'], [2, 'preparing'], [3, 'ready'], [4, 'delivered']]) {
    await move('merchant', orders.done.id, version, status);
  }
  orders.road = { key: crypto.randomUUID() };
  orders.road.id = rows(await legacyOrder(orders.road.key, 'delivery', 3, { address: 'Calle Principal 123' }))[0].id;
  for (const [version, status, riderId] of [[1, 'accepted'], [2, 'preparing'], [3, 'ready'], [4, 'assigned', rider], [5, 'picked_up']]) {
    await move('merchant', orders.road.id, version, status, '', riderId || null);
  }
  orders.gone = { key: crypto.randomUUID() };
  orders.gone.id = rows(await legacyOrder(orders.gone.key, 'pickup', 1))[0].id;
  await move('customer', orders.gone.id, 1, 'canceled', 'Me equivoqué');

  legacyBefore = rows(await db.query(`select id, code, status, version, subtotal_ars, delivery_fee_ars, total_ars,
    tracking_token, delivery_code from public.orders order by code`));
  eventsBefore = rows(await db.query('select count(*)::int as n from public.order_events'))[0].n;
  assert.equal(rows(await db.query('select stock from public.products where id=$1', [bread]))[0].stock, 20 - 1 - 2 - 3);

  const hardening = (await migrationFiles()).find(file => versionOf(file) === HARDENING);
  await applyMigration(db, hardening);
});
after(async () => { await db.close(); });

test('la migración corre sobre datos existentes y declara el esquema nuevo', async () => {
  const status = rows(await as('anon', 'select public.app_status() as s'))[0].s;
  assert.equal(Number(status.schema), HARDENING);
  assert.equal(status.features.taxi, false);
  assert.equal(status.features.guest_checkout, true);
});

test('los pedidos existentes conservan importes, estados, versiones y códigos', async () => {
  const after = rows(await db.query(`select id, code, status, version, subtotal_ars, delivery_fee_ars, total_ars,
    tracking_token, delivery_code from public.orders order by code`));
  assert.deepEqual(after, legacyBefore);
  assert.equal(rows(await db.query('select count(*)::int as n from public.order_events'))[0].n, eventsBefore);
});

test('el historial legado queda completo: cada evento sabe desde qué estado salió', async () => {
  const events = rows(await db.query(`select from_status, to_status from public.order_events
    where order_id=$1 order by created_at, id`, [orders.done.id]));
  assert.deepEqual(events.map(event => event.to_status), ['submitted', 'accepted', 'preparing', 'ready', 'delivered']);
  assert.deepEqual(events.map(event => event.from_status), [null, 'submitted', 'accepted', 'preparing', 'ready']);
  const orphans = rows(await db.query(`select count(*)::int as n from public.order_events e
    where e.from_status is null and e.to_status <> 'submitted'`))[0].n;
  assert.equal(orphans, 0);
});

test('los productos existentes siguen controlando stock y conservan sus existencias', async () => {
  const product = rows(await db.query('select stock, track_stock from public.products where id=$1', [bread]))[0];
  assert.equal(product.track_stock, true);
  assert.equal(product.stock, 14);
  // Los productos nuevos arrancan sin control de stock salvo que se pida.
  const fresh = rows(await as('merchant', "insert into public.products(business_id,name,price_ars) values ($1,'Medialunas',900) returning track_stock", [business]))[0];
  assert.equal(fresh.track_stock, false);
});

test('el comercio publicado sigue publicado y recibiendo pedidos', async () => {
  const shop = rows(await as('anon', 'select status, open, public.open_now(b) as open_now from public.businesses b where id=$1', [business]))[0];
  assert.deepEqual(shop, { status: 'active', open: true, open_now: true });
  // El requisito nuevo (contacto para clientes) se pide al revisar, no despublica.
  assert.deepEqual(rows(await as('merchant', 'select public.business_missing_requirements($1) as m', [business]))[0].m,
    ['Teléfono o WhatsApp para clientes']);
});

test('un envío legado ya retirado puede cerrarse con motivo y devuelve el stock', async () => {
  await assert.rejects(move('merchant', orders.road.id, 6, 'canceled', ''), error => /Reason required/.test(error.message));
  assert.equal(rows(await move('merchant', orders.road.id, 6, 'canceled', 'No se pudo entregar'))[0].status, 'canceled');
  const last = rows(await db.query(`select from_status, to_status from public.order_events where order_id=$1
    order by created_at desc, id desc limit 1`, [orders.road.id]))[0];
  assert.deepEqual(last, { from_status: 'picked_up', to_status: 'canceled' });
  assert.equal(rows(await db.query('select stock from public.products where id=$1', [bread]))[0].stock, 17);
});

test('un pedido legado sin atender sigue su ciclo y registra el estado anterior', async () => {
  assert.equal(rows(await move('merchant', orders.pending.id, 1, 'accepted'))[0].status, 'accepted');
  const last = rows(await db.query(`select from_status, to_status from public.order_events where order_id=$1
    order by created_at desc, id desc limit 1`, [orders.pending.id]))[0];
  assert.deepEqual(last, { from_status: 'submitted', to_status: 'accepted' });
});

test('reintentar un intento hecho antes de migrar devuelve el mismo pedido', async () => {
  const again = rows(await as('customer', 'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as id',
    [business, orders.gone.key, 'pickup', 'cash_on_pickup', JSON.stringify(contact),
      JSON.stringify([{ product_id: bread, quantity: 1 }]), null]))[0].id;
  assert.equal(again, orders.gone.id);
});

test('los pedidos nuevos continúan la numeración y usan el total confirmado', async () => {
  const codes = legacyBefore.map(order => Number(order.code.split('-')[1]));
  await assert.rejects(as('neighbour', 'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',
    [business, crypto.randomUUID(), 'pickup', 'cash_on_pickup', JSON.stringify(contact),
      JSON.stringify([{ product_id: bread, quantity: 1 }]), 1400]), error => error.code === 'U0005');
  const id = rows(await as('neighbour', 'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as id',
    [business, crypto.randomUUID(), 'pickup', 'cash_on_pickup', JSON.stringify(contact),
      JSON.stringify([{ product_id: bread, quantity: 1 }]), 1500]))[0].id;
  const order = rows(await db.query('select code, total_ars from public.orders where id=$1', [id]))[0];
  assert.equal(Number(order.total_ars), 1500);
  assert.ok(Number(order.code.split('-')[1]) > Math.max(...codes));
});
