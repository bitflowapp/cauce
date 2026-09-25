// Métricas del piloto en PostgreSQL embebido (PGlite), con las migraciones
// reales: sólo administración las lee; "hoy" es el día local de la localidad;
// los números salen de pedidos reales y las incidencias no traen datos del
// cliente.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './fixture.mjs';
import { REQUIRED_SCHEMA } from '../../js/core/contract.js';

const db = new PGlite();
const NAMES = ['ownerA', 'ownerB', 'ownerC', 'admin', 'c1', 'c2', 'c3', 'c4'];
const ids = Object.fromEntries(NAMES.map((name, i) => [name, `40000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
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
const one = async (name, sql, params) => rows(await as(name, sql, params))[0];
const metrics = async () => (await one('admin', 'select public.admin_pilot_metrics() as m')).m;
const shops = {};

async function publishedShop(owner, label) {
  const id = (await one(owner, 'select public.create_business($1,$2) as id', [`Comercio ${label}`, `comercio-${label.toLowerCase()}`])).id;
  await as(owner, `update public.businesses set address='San Martín 100', hours_label='Todos los días',
    public_phone='2942 555000', delivery_enabled=true, delivery_zone='Casco urbano', delivery_fee_ars=800,
    minimum_order_ars=1000, category_id=(select id from public.business_categories where slug='gastronomia') where id=$1`, [id]);
  await as(owner, "insert into public.business_contacts(business_id,owner_name,phone) values ($1,'Titular','2942555001')", [id]);
  const product = (await one(owner, "insert into public.products(business_id,name,price_ars) values ($1,'Empanada',1500) returning id", [id])).id;
  await as(owner, 'select public.submit_business_for_review($1)', [id]);
  await as('admin', "select public.review_business($1,'active','Aprobado')", [id]);
  await as(owner, 'select public.set_business_presence($1,null,true)', [id]);
  return { id, product, owner };
}
async function newOrder(customer, shop, fulfillment = 'pickup', quantity = 1) {
  return (await one(customer, 'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as id',
    [shop.id, crypto.randomUUID(), fulfillment, fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup',
      JSON.stringify({ name: 'Vecina Privada', phone: '2942401122', notes: 'Timbre', address: 'Los Pehuenes 45' }),
      JSON.stringify([{ product_id: shop.product, quantity }]), null])).id;
}
const move = (who, id, status, reason = '') => as(who, 'select public.transition_order($1,null,$2,null,$3)', [id, status, reason]);
async function deliverPickup(shop, id) {
  for (const status of ['accepted', 'preparing', 'ready', 'delivered']) await move(shop.owner, id, status);
}
const orders = {};

before(async () => {
  await applyMigrations(db);
  for (const name of NAMES) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [ids[name], `${name}@cauce.test`]);
    await as(name, 'insert into public.profiles (user_id, display_name) values ($1, $2)', [ids[name], `Prueba ${name}`]);
  }
  await db.query('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);
  shops.A = await publishedShop('ownerA', 'A');
  shops.B = await publishedShop('ownerB', 'B');
  shops.C = await publishedShop('ownerC', 'C');
  await as('admin', "select public.admin_set_business_status($1,'suspended','Prueba')", [shops.C.id]);

  // Hoy en A: dos retiros entregados (1.500 y 3.000), un envío abierto y uno cancelado.
  orders.p1 = await newOrder('c1', shops.A);
  orders.p2 = await newOrder('c2', shops.A, 'pickup', 2);
  await deliverPickup(shops.A, orders.p1);
  await deliverPickup(shops.A, orders.p2);
  orders.open = await newOrder('c3', shops.A, 'delivery', 1);
  orders.gone = await newOrder('c4', shops.A);
  await move('ownerA', orders.gone, 'canceled', 'Sin stock');
  // En B: uno sin respuesta hace 20 minutos (incidencia) y uno reciente.
  orders.stuck = await newOrder('c1', shops.B);
  await db.query("update public.orders set updated_at = now() - interval '20 minutes' where id = $1", [orders.stuck]);
  orders.fresh = await newOrder('c2', shops.B);
  // Uno de ayer (hora local): no cuenta como de hoy.
  orders.yesterday = await newOrder('c3', shops.B);
  const start = (await metrics()).day_start;
  await db.query("update public.orders set created_at = $2::timestamptz - interval '1 minute', updated_at = now() where id = $1",
    [orders.yesterday, start]);
  await db.query("insert into private.client_events (kind, code, message) values ('critical','SCHEMA','x'),('frontend_error','X','y')");
});
after(async () => { await db.close(); });

test('sólo administración lee las métricas del piloto', async () => {
  for (const name of ['ownerA', 'c1']) {
    await assert.rejects(as(name, 'select public.admin_pilot_metrics()'), error => /Administration only/.test(error.message));
  }
  await assert.rejects(as('anon', 'select public.admin_pilot_metrics()'), error => error.code === '42501');
  const anon = rows(await db.query(`select has_function_privilege('anon', 'public.admin_pilot_metrics()', 'EXECUTE') as can`))[0].can;
  assert.equal(anon, false);
});

test('"hoy" empieza a las 00:00 de la localidad y los números salen de los pedidos', async () => {
  const m = await metrics();
  assert.equal(m.timezone, 'America/Argentina/Buenos_Aires');
  const local = rows(await db.query("select to_char($1::timestamptz at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') as t",
    [m.day_start]))[0].t;
  assert.equal(local, '00:00');
  assert.deepEqual(m.today, {
    orders: 6, pickup: 5, delivery: 1, in_progress: 4, delivered: 2, canceled: 1,
    gross_ars: 1500 + 3000, average_ticket_ars: 2250,
  });
  assert.deepEqual(m.businesses, { active: 2, paused: 0, suspended: 1, pending_review: 0, open_now: 2 });
  assert.deepEqual(m.errors_24h, { total: 2, critical: 1 });
});

test('cada comercio publicado con su día; el suspendido no figura', async () => {
  const m = await metrics();
  const byName = Object.fromEntries(m.per_business.map(item => [item.name, item]));
  assert.deepEqual(Object.keys(byName).sort(), ['Comercio A', 'Comercio B']);
  assert.deepEqual({ orders: byName['Comercio A'].orders, delivered: byName['Comercio A'].delivered,
    gross: byName['Comercio A'].gross_ars, open: byName['Comercio A'].open_now },
  { orders: 4, delivered: 2, gross: 4500, open: true });
  assert.equal(byName['Comercio B'].orders, 2, 'el pedido de ayer no cuenta');
  assert.equal(m.per_business[0].name, 'Comercio A', 'primero el que más vendió');
});

test('las incidencias traen comercio, código y minutos, nunca datos del cliente', async () => {
  const m = await metrics();
  const codes = m.stuck.map(item => item.id);
  assert.ok(codes.includes(orders.stuck), 'el pedido sin respuesta hace 20 min');
  assert.ok(!codes.includes(orders.fresh), 'el reciente no');
  assert.ok(m.stuck_total >= m.stuck.length && m.stuck_total >= 1);
  const item = m.stuck.find(entry => entry.id === orders.stuck);
  assert.equal(item.status, 'submitted');
  assert.equal(item.business, 'Comercio B');
  assert.equal(item.phone, '2942 555000');
  assert.ok(item.minutes >= 19 && item.minutes <= 21);
  assert.deepEqual(Object.keys(item).sort(), ['business', 'business_id', 'code', 'fulfillment', 'id', 'minutes', 'phone', 'status']);
  const text = JSON.stringify(m);
  for (const secret of ['Vecina Privada', '2942401122', 'Los Pehuenes', 'Timbre', ids.c1]) {
    assert.ok(!text.includes(secret), `las métricas no incluyen "${secret}"`);
  }
});

test('con más de 20 pedidos quietos se listan los 20 que más esperan y el total los cuenta a todos', async () => {
  const [{ locality }] = rows(await db.query('select locality_id as locality from public.businesses where id = $1', [shops.B.id]));
  const inserted = rows(await db.query(`insert into public.orders (code, business_id, locality_id, customer_id,
      idempotency_key, request_fingerprint, fulfillment, payment_method, contact_name, contact_phone,
      subtotal_ars, delivery_fee_ars, total_ars, updated_at)
    select 'QA-' || n, $1, $2, $3, gen_random_uuid(), 'qa', 'pickup', 'cash_on_pickup', 'Vecina Privada', '2942401122',
      1500, 0, 1500, now() - make_interval(hours => 2, mins => n)
    from generate_series(1, 22) n returning id`, [shops.B.id, locality, ids.c4]));
  try {
    const m = await metrics();
    assert.equal(m.stuck.length, 20);
    assert.ok(m.stuck_total >= 23, `total ${m.stuck_total}`);
    assert.equal(m.stuck[0].code, 'QA-22', 'primero el que más espera');
    assert.ok(m.stuck.every((item, index) => index === 0 || item.minutes <= m.stuck[index - 1].minutes));
    assert.ok(!m.stuck.some(item => item.id === orders.stuck), 'el de 20 minutos queda fuera de los 20');
  } finally {
    await db.query('delete from public.orders where id = any($1::uuid[])', [inserted.map(row => row.id)]);
  }
});

test('la migración sólo agrega funciones y declara el contrato nuevo', async () => {
  assert.equal(Number((await one('anon', 'select public.app_status() as s')).s.schema), REQUIRED_SCHEMA);
  const definer = rows(await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef`));
  assert.deepEqual(definer, [], 'ninguna función con privilegios en public');
});
