// Reparto propio v1 en PostgreSQL embebido (PGlite), con las migraciones reales.
// La base se construye tal como está hoy en producción (hasta el hardening), se
// llena con dos comercios, reparto y un envío ya en camino, y recién ahí se
// aplica la migración del reparto: se prueba la actualización con datos y, sobre
// esa base, qué ve y qué mueve cada cuenta. Quien decide es la base, no la
// interfaz: cada negativa sale de RLS o de las funciones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, applyMigration, migrationFiles, versionOf } from './fixture.mjs';

const RIDER = 20260925120000;
const db = new PGlite();
const NAMES = ['ownerA', 'managerA', 'staffA', 'ownerB', 'riderA', 'riderA2', 'riderB', 'customer1', 'customer2',
  'customer3', 'customer4', 'stranger', 'admin', 'guest'];
const ids = Object.fromEntries(NAMES.map((name, i) => [name, `30000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const email = name => `${name.toLowerCase()}@cauce.test`;
const rows = result => result.rows;

async function as(name, sql, params = []) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${name === 'anon' ? 'anon' : 'authenticated'}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [ids[name] || '']);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [ids[name]
      ? JSON.stringify({ sub: ids[name], role: 'authenticated', is_anonymous: name === 'guest' }) : '']);
    return tx.query(sql, params);
  });
}
const one = async (name, sql, params) => rows(await as(name, sql, params))[0];
const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(`${error.code} ${error.message}`));

const shops = {};
const riders = {};
const legacy = {};
let before_;

const contact = { name: 'Vecina de Prueba', phone: '2942401122', notes: 'Timbre roto', address: 'Los Pehuenes 45' };
async function deliveryOrder(customer, shop, quantity = 1) {
  return (await one(customer, 'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as id',
    [shop.id, crypto.randomUUID(), 'delivery', 'cash_on_delivery', JSON.stringify(contact),
      JSON.stringify([{ product_id: shop.product, quantity }]), null])).id;
}
async function pickupOrder(customer, shop) {
  return (await one(customer, 'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as id',
    [shop.id, crypto.randomUUID(), 'pickup', 'cash_on_pickup', JSON.stringify({ name: contact.name, phone: contact.phone }),
      JSON.stringify([{ product_id: shop.product, quantity: 1 }]), null])).id;
}
const version = async id => rows(await db.query('select version from public.orders where id=$1', [id]))[0].version;
const move = async (who, id, status, { rider = null, reason = '', expected } = {}) =>
  one(who, 'select (public.transition_order($1,$2,$3,$4,$5)).status as status',
    [id, expected ?? await version(id), status, rider, reason]);
const confirm = async (who, id, code, expected) =>
  (await one(who, 'select public.confirm_delivery($1,$2,$3) as r', [id, expected ?? await version(id), code])).r;
const codeOf = async id => rows(await db.query('select delivery_code from public.orders where id=$1', [id]))[0].delivery_code;
// Hasta "listo" y asignado a una persona de reparto, como lo hace el comercio.
async function readyFor(id, owner, rider) {
  for (const status of ['accepted', 'preparing', 'ready']) await move(owner, id, status);
  if (rider) await move(owner, id, 'assigned', { rider });
}
const riderList = async name => (await one(name, 'select public.rider_orders() as list')).list;

async function publishedShop(owner, label) {
  const id = (await one(owner, 'select public.create_business($1,$2) as id', [`Comercio ${label}`, `comercio-${label.toLowerCase()}`])).id;
  await as(owner, `update public.businesses set address='San Martín 100', hours_label='Todos los días',
    public_phone='2942555000', delivery_enabled=true, delivery_zone='Casco urbano', delivery_fee_ars=800,
    minimum_order_ars=1000, category_id=(select id from public.business_categories where slug='gastronomia')
    where id=$1`, [id]);
  await as(owner, "insert into public.business_contacts(business_id,owner_name,phone) values ($1,'Titular','2942555001')", [id]);
  const product = (await one(owner, "insert into public.products(business_id,name,price_ars) values ($1,'Empanada',1500) returning id", [id])).id;
  await as(owner, 'select public.submit_business_for_review($1)', [id]);
  await as('admin', "select public.review_business($1,'active','Aprobado')", [id]);
  await as(owner, 'select public.set_business_presence($1,null,true)', [id]);
  return { id, product };
}

before(async () => {
  // Producción hoy: todas las migraciones anteriores al reparto.
  const applied = await applyMigrations(db, { until: RIDER });
  assert.ok(applied.length >= 9, 'se reconstruyó el esquema de producción');
  for (const name of NAMES) {
    await db.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)',
      [ids[name], name === 'guest' ? null : email(name), name === 'guest']);
    if (name !== 'guest') await as(name, 'insert into public.profiles (user_id, display_name) values ($1, $2)', [ids[name], `Prueba ${name}`]);
  }
  await db.query('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);
  shops.A = await publishedShop('ownerA', 'A');
  shops.B = await publishedShop('ownerB', 'B');
  await as('ownerA', "select public.add_business_member($1,$2,'manager')", [shops.A.id, email('managerA')]);
  await as('ownerA', "select public.add_business_member($1,$2,'staff')", [shops.A.id, email('staffA')]);
  for (const [key, shop, owner, name] of [['A1', 'A', 'ownerA', 'Reparto A1'], ['A2', 'A', 'ownerA', 'Reparto A2'],
    ['B1', 'B', 'ownerB', 'Reparto B1']]) {
    riders[key] = (await one(owner, 'insert into public.business_riders(business_id,name,phone) values ($1,$2,$3) returning id',
      [shops[shop].id, name, '2942666000'])).id;
  }
  // Un envío que ya salió antes de la migración, con el código que el cliente ya tiene.
  legacy.road = await deliveryOrder('customer1', shops.A);
  await readyFor(legacy.road, 'ownerA', riders.A1);
  await move('ownerA', legacy.road, 'picked_up');
  legacy.orders = rows(await db.query(`select id, code, status, version, total_ars, tracking_token, delivery_code,
    rider_id from public.orders order by code`));
  legacy.events = rows(await db.query('select count(*)::int as n from public.order_events'))[0].n;
  legacy.riders = rows(await db.query('select id, business_id, name, phone, active from public.business_riders order by name'));
  before_ = (await migrationFiles()).find(file => versionOf(file) === RIDER);
  assert.ok(before_, 'existe la migración del reparto');
  await applyMigration(db, before_);
});
after(async () => { await db.close(); });

// ───────────────── actualización y construcción desde cero ─────────────────
test('la migración corre sobre datos de producción sin tocar pedidos, códigos, historial ni reparto', async () => {
  assert.equal(Number((await one('anon', 'select public.app_status() as s')).s.schema), RIDER);
  assert.deepEqual(rows(await db.query(`select id, code, status, version, total_ars, tracking_token, delivery_code,
    rider_id from public.orders order by code`)), legacy.orders);
  assert.equal(rows(await db.query('select count(*)::int as n from public.order_events'))[0].n, legacy.events);
  assert.deepEqual(rows(await db.query('select id, business_id, name, phone, active from public.business_riders order by name')), legacy.riders);
  assert.equal(rows(await db.query('select count(*)::int as n from public.business_riders where user_id is not null'))[0].n, 0);
});

test('desde cero, todas las migraciones construyen el mismo contrato', async () => {
  const fresh = new PGlite();
  try {
    await applyMigrations(fresh);
    const status = rows(await fresh.query('select private.app_status() as s'))[0].s;
    assert.equal(Number(status.schema), RIDER);
    const transitions = rows(await fresh.query(`select from_status || '>' || to_status as t from private.order_transitions
      where actor_role = 'rider' order by 1`)).map(row => row.t);
    assert.deepEqual(transitions, ['arrived>delivered', 'assigned>picked_up', 'on_the_way>arrived',
      'on_the_way>delivered', 'picked_up>on_the_way']);
    assert.equal(rows(await fresh.query(`select count(*)::int as n from pg_trigger
      where tgname = 'orders_secure_delivery_code'`))[0].n, 1);
  } finally {
    await fresh.close();
  }
});

test('las filas del comercio en la máquina de estados no cambian', async () => {
  const merchant = rows(await db.query(`select from_status || '>' || to_status as t from private.order_transitions
    where actor_role = 'merchant' order by 1`)).map(row => row.t);
  for (const step of ['ready>assigned', 'assigned>picked_up', 'picked_up>on_the_way', 'on_the_way>arrived',
    'on_the_way>delivered', 'arrived>delivered', 'arrived>canceled']) {
    assert.ok(merchant.includes(step), `el comercio conserva ${step}`);
  }
});

// ───────────────── vincular cuentas ─────────────────
test('vincular es de titular o encargado/a, por correo de una cuenta permanente que existe', async () => {
  const link = (who, rider, mail) => as(who, 'select public.link_rider_account($1,$2) as ok', [rider, mail]);
  await rejects(link('staffA', riders.A1, email('riderA')), /42501/);
  await rejects(link('ownerB', riders.A1, email('riderA')), /42501/);
  await rejects(link('riderA', riders.A1, email('riderA')), /42501/);
  await rejects(link('guest', riders.A1, email('riderA')), /42501/);
  await rejects(link('ownerA', crypto.randomUUID(), email('riderA')), /42501/);
  await rejects(link('ownerA', riders.A1, 'nadie@cauce.test'), /P0002/);
  await rejects(link('ownerA', riders.A1, ''), /P0002/);
  assert.equal(rows(await link('managerA', riders.A1, ` ${email('riderA').toUpperCase()} `))[0].ok, true);
  // La misma cuenta no puede ser dos personas de reparto del mismo comercio.
  await rejects(link('ownerA', riders.A2, email('riderA')), /23505/);
  assert.equal(rows(await link('ownerA', riders.A2, email('riderA2')))[0].ok, true);
  assert.equal(rows(await link('ownerB', riders.B1, email('riderB')))[0].ok, true);
  // Una cuenta puede repartir para dos comercios.
  const extra = (await one('ownerB', "insert into public.business_riders(business_id,name) values ($1,'Reparto compartido') returning id", [shops.B.id])).id;
  assert.equal(rows(await link('ownerB', extra, email('riderA')))[0].ok, true);
  await as('ownerB', 'select public.unlink_rider_account($1)', [extra]);
  await as('ownerB', 'delete from public.business_riders where id=$1', [extra]);
});

test('la cuenta vinculada no se escribe por fuera de las funciones', async () => {
  await rejects(as('ownerA', 'update public.business_riders set user_id=$1 where id=$2', [ids.stranger, riders.A1]), /42501/);
  await rejects(as('ownerA', 'insert into public.business_riders(business_id,name,user_id) values ($1,$2,$3)',
    [shops.A.id, 'Colado', ids.stranger]), /42501/);
  const linked = rows(await db.query('select user_id from public.business_riders where id=$1', [riders.A1]))[0].user_id;
  assert.equal(linked, ids.riderA);
});

test('el comercio ve qué cuenta tiene cada persona; nadie más', async () => {
  const accounts = rows(await as('ownerA', 'select rider_id, email from public.business_rider_accounts($1)', [shops.A.id]));
  assert.deepEqual(accounts, [{ rider_id: riders.A1, email: email('riderA') }, { rider_id: riders.A2, email: email('riderA2') }]);
  assert.equal(rows(await as('managerA', 'select * from public.business_rider_accounts($1)', [shops.A.id])).length, 2);
  await rejects(as('staffA', 'select * from public.business_rider_accounts($1)', [shops.A.id]), /42501/);
  await rejects(as('ownerB', 'select * from public.business_rider_accounts($1)', [shops.A.id]), /42501/);
  await rejects(as('riderA', 'select * from public.business_rider_accounts($1)', [shops.A.id]), /42501/);
});

test('quien reparte lee sólo su propia fila de reparto', async () => {
  assert.deepEqual(rows(await as('riderA', 'select id from public.business_riders')).map(row => row.id), [riders.A1]);
  assert.deepEqual(rows(await as('stranger', 'select id from public.business_riders')), []);
  assert.equal(rows(await as('staffA', 'select id from public.business_riders')).length, 2);
});

// ───────────────── lectura acotada ─────────────────
test('la persona de reparto ve sus entregas por función, nunca la tabla de pedidos', async () => {
  const mine = await deliveryOrder('customer2', shops.A);
  await readyFor(mine, 'ownerA', riders.A1);
  const other = await deliveryOrder('customer2', shops.A);
  await readyFor(other, 'ownerA', riders.A2);
  const foreign = await deliveryOrder('customer3', shops.B);
  await readyFor(foreign, 'ownerB', riders.B1);
  const unassigned = await deliveryOrder('customer3', shops.A);
  await readyFor(unassigned, 'ownerA', null);

  for (const table of ['orders', 'order_items', 'order_events']) {
    assert.deepEqual(rows(await as('riderA', `select * from public.${table}`)), [], `sin lectura directa de ${table}`);
  }
  const list = await riderList('riderA');
  const ids_ = list.map(item => item.id);
  assert.ok(ids_.includes(mine) && ids_.includes(legacy.road));
  assert.ok(!ids_.includes(other) && !ids_.includes(foreign) && !ids_.includes(unassigned));
  const item = list.find(entry => entry.id === mine);
  assert.equal(item.status, 'assigned');
  assert.equal(item.contact_phone, contact.phone);
  assert.equal(item.address, contact.address);
  assert.equal(item.notes, contact.notes);
  assert.equal(item.business.name, 'Comercio A');
  assert.equal(item.rider.id, riders.A1);
  assert.equal(Number(item.total_ars), 1500 + 800);
  assert.equal(item.code_attempts_left, 5);
  assert.deepEqual(item.items, [{ name: 'Empanada', variant: '', quantity: 1 }]);
  for (const hidden of ['delivery_code', 'customer_id', 'tracking_token', 'idempotency_key', 'request_fingerprint']) {
    assert.ok(!(hidden in item), `rider_orders no expone ${hidden}`);
  }
  assert.deepEqual((await riderList('riderB')).map(entry => entry.id), [foreign]);
  assert.deepEqual(await riderList('stranger'), []);
  assert.deepEqual(await riderList('guest'), []);
  assert.deepEqual(await riderList('ownerA'), [], 'el comercio lee sus pedidos por RLS, no por esta función');
  await rejects(as('anon', 'select public.rider_orders()'), /42501/);
});

// ───────────────── transiciones ─────────────────
test('la persona de reparto avanza su entrega paso a paso y nada más', async () => {
  const id = await deliveryOrder('customer1', shops.A);
  await readyFor(id, 'ownerA', riders.A1);
  // Saltar pasos, cancelar o entregar sin código: no.
  await rejects(move('riderA', id, 'on_the_way'), /Transition not allowed/);
  await rejects(move('riderA', id, 'canceled', { reason: 'No llego' }), /Transition not allowed/);
  // Otra persona de reparto del mismo comercio, la de otro comercio o una cuenta cualquiera.
  await rejects(move('riderA2', id, 'picked_up'), /belongs to another account/);
  await rejects(move('riderB', id, 'picked_up'), /belongs to another account/);
  await rejects(move('stranger', id, 'picked_up'), /belongs to another account/);
  // Versión vieja: otra persona ya lo movió.
  await rejects(move('riderA', id, 'picked_up', { expected: 1 }), /U0001/);

  assert.equal((await move('riderA', id, 'picked_up')).status, 'picked_up');
  assert.equal((await move('riderA', id, 'on_the_way')).status, 'on_the_way');
  assert.equal((await move('riderA', id, 'arrived')).status, 'arrived');
  await rejects(move('riderA', id, 'delivered'), /Delivery code required/);
  const events = rows(await db.query(`select from_status, to_status, actor_role, actor_id from public.order_events
    where order_id=$1 and actor_role='rider' order by created_at, id`, [id]));
  assert.deepEqual(events.map(event => `${event.from_status}>${event.to_status}`), ['assigned>picked_up', 'picked_up>on_the_way', 'on_the_way>arrived']);
  assert.ok(events.every(event => event.actor_id === ids.riderA));
});

test('nadie se asigna un pedido ni mueve pedidos de otro comercio', async () => {
  const ready = await deliveryOrder('customer1', shops.A);
  await readyFor(ready, 'ownerA', null);
  await rejects(move('riderA', ready, 'assigned', { rider: riders.A1 }), /belongs to another account/);
  const foreign = await deliveryOrder('customer1', shops.B);
  await readyFor(foreign, 'ownerB', riders.B1);
  await rejects(move('riderA', foreign, 'picked_up'), /belongs to another account/);
  await rejects(confirm('riderA', foreign, '0000'), /belongs to another account/);
  // El comercio B no puede asignar su pedido a la persona de reparto de A.
  const foreign2 = await deliveryOrder('customer2', shops.B);
  await readyFor(foreign2, 'ownerB', null);
  await rejects(move('ownerB', foreign2, 'assigned', { rider: riders.A1 }), /Rider not available/);
  // Quien reparte no toca catálogo, precios ni datos del comercio.
  assert.equal(rows(await as('riderA', 'update public.products set price_ars=1 where business_id=$1 returning id', [shops.A.id])).length, 0);
  assert.equal(rows(await as('riderA', "update public.businesses set name='Tomado' where id=$1 returning id", [shops.A.id])).length, 0);
  assert.equal(rows(await as('riderA', 'update public.business_riders set active=false where id=$1 returning id', [riders.A1])).length, 0);
  await rejects(as('riderA', 'select public.set_product_availability($1,false)', [shops.A.product]), /42501|not allowed|Not allowed/i);
});

// ───────────────── código de entrega ─────────────────
test('entregar exige el código del cliente; un intento fallido queda registrado', async () => {
  const id = await deliveryOrder('customer2', shops.A);
  await readyFor(id, 'ownerA', riders.A1);
  await rejects(confirm('riderA', id, await codeOf(id)), /Transition not allowed/);
  await move('riderA', id, 'picked_up');
  await move('riderA', id, 'on_the_way');
  const code = await codeOf(id);
  const wrong = code === '0000' ? '1111' : '0000';
  assert.deepEqual(await confirm('riderA', id, wrong), { ok: false, reason: 'wrong', remaining: 4 });
  assert.deepEqual(await confirm('riderA', id, '12a'), { ok: false, reason: 'format', remaining: 4 });
  assert.equal(rows(await db.query('select status from public.orders where id=$1', [id]))[0].status, 'on_the_way');
  assert.equal(rows(await db.query(`select count(*)::int as n from private.delivery_code_attempts
    where order_id=$1 and not success and actor_id=$2`, [id, ids.riderA]))[0].n, 1);
  // Desde "en camino" también se entrega (entrega directa).
  const done = await confirm('riderA', id, `${code.slice(0, 2)} ${code.slice(2)}`);
  assert.equal(done.ok, true);
  assert.equal(done.status, 'delivered');
  const row = rows(await db.query('select status, payment_status from public.orders where id=$1', [id]))[0];
  assert.deepEqual(row, { status: 'delivered', payment_status: 'settled' });
  const last = rows(await db.query(`select from_status, to_status, actor_role from public.order_events where order_id=$1
    order by created_at desc, id desc limit 1`, [id]))[0];
  assert.deepEqual(last, { from_status: 'on_the_way', to_status: 'delivered', actor_role: 'rider' });
  // El historial cerrado ya no trae datos de contacto.
  const closed = (await riderList('riderA')).find(entry => entry.id === id);
  assert.equal(closed.status, 'delivered');
  assert.equal(closed.contact_phone, '');
  assert.equal(closed.address, '');
});

test('cinco códigos equivocados bloquean la entrega por código; el comercio la cierra igual', async () => {
  const id = await deliveryOrder('customer3', shops.A);
  await readyFor(id, 'ownerA', riders.A1);
  for (const status of ['picked_up', 'on_the_way', 'arrived']) await move('riderA', id, status);
  const code = await codeOf(id);
  const wrong = code === '9999' ? '8888' : '9999';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.deepEqual(await confirm('riderA', id, wrong), { ok: false, reason: 'wrong', remaining: 5 - attempt });
  }
  assert.deepEqual(await confirm('riderA', id, wrong), { ok: false, reason: 'locked', remaining: 0 });
  assert.deepEqual(await confirm('riderA', id, code), { ok: false, reason: 'locked', remaining: 0 }, 'bloqueado aun con el código correcto');
  assert.equal((await riderList('riderA')).find(entry => entry.id === id).code_attempts_left, 0);
  // El comercio no usa el código: confirma con el cliente y cierra.
  await rejects(confirm('ownerA', id, code), /belongs to another account/);
  assert.equal((await move('ownerA', id, 'delivered')).status, 'delivered');
  assert.equal(rows(await db.query(`select count(*)::int as n from private.delivery_code_attempts where order_id=$1`, [id]))[0].n, 5);
});

test('el envío que ya estaba en camino antes de migrar se completa con las reglas nuevas', async () => {
  assert.equal((await move('riderA', legacy.road, 'on_the_way')).status, 'on_the_way');
  const code = legacy.orders.find(order => order.id === legacy.road).delivery_code;
  assert.match(code, /^[0-9]{4}$/);
  assert.equal((await confirm('riderA', legacy.road, code)).ok, true);
});

test('el código nuevo sale sólo en envíos, con cuatro dígitos', async () => {
  const delivery = await deliveryOrder('customer4', shops.B);
  const pickup = await pickupOrder('customer4', shops.B);
  assert.match(await codeOf(delivery), /^[0-9]{4}$/);
  assert.equal(await codeOf(pickup), null);
  const source = rows(await db.query("select prosrc from pg_proc where proname='secure_delivery_code'"))[0].prosrc;
  assert.match(source, /gen_random_uuid/);
  assert.doesNotMatch(source, /random\(\)/);
});

// ───────────────── pausar, desvincular ─────────────────
test('pausar a la persona o desvincular su cuenta corta el acceso en el acto', async () => {
  const id = await deliveryOrder('customer1', shops.A);
  await readyFor(id, 'ownerA', riders.A2);
  await as('ownerA', 'update public.business_riders set active=false where id=$1', [riders.A2]);
  assert.deepEqual(await riderList('riderA2'), []);
  await rejects(move('riderA2', id, 'picked_up'), /belongs to another account/);
  await as('managerA', 'update public.business_riders set active=true where id=$1', [riders.A2]);
  assert.equal((await move('riderA2', id, 'picked_up')).status, 'picked_up');

  await rejects(as('staffA', 'select public.unlink_rider_account($1)', [riders.A2]), /42501/);
  await rejects(as('ownerB', 'select public.unlink_rider_account($1)', [riders.A2]), /42501/);
  await rejects(as('riderA', 'select public.unlink_rider_account($1)', [riders.A2]), /42501/);
  // La propia persona se desvincula.
  assert.equal((await one('riderA2', 'select public.unlink_rider_account($1) as ok', [riders.A2])).ok, true);
  assert.deepEqual(await riderList('riderA2'), []);
  await rejects(move('riderA2', id, 'on_the_way'), /belongs to another account/);
  // El comercio sigue el recorrido sin la aplicación.
  assert.equal((await move('ownerA', id, 'on_the_way')).status, 'on_the_way');
  assert.equal((await move('ownerA', id, 'delivered')).status, 'delivered');
});

test('quien integra el comercio y también reparte actúa como comercio', async () => {
  const shared = (await one('ownerA', "insert into public.business_riders(business_id,name) values ($1,'Encargada que reparte') returning id", [shops.A.id])).id;
  await as('ownerA', 'select public.link_rider_account($1,$2)', [shared, email('managerA')]);
  const id = await deliveryOrder('customer2', shops.A);
  await readyFor(id, 'ownerA', shared);
  await move('managerA', id, 'picked_up');
  const last = rows(await db.query(`select actor_role from public.order_events where order_id=$1
    order by created_at desc, id desc limit 1`, [id]))[0];
  assert.equal(last.actor_role, 'merchant');
});

// ───────────────── contrato de privilegios ─────────────────
test('las funciones de reparto no se ejecutan sin sesión y el registro de intentos es privado', async () => {
  const anon = rows(await db.query(`select p.proname as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.proname in ('rider_orders','confirm_delivery','link_rider_account','unlink_rider_account',
        'business_rider_accounts','is_order_rider','secure_delivery_code')`));
  assert.deepEqual(anon, []);
  const helper = rows(await db.query(`select has_function_privilege('authenticated', 'private.is_order_rider(uuid, uuid)', 'EXECUTE') as can`))[0].can;
  assert.equal(helper, false);
  await rejects(as('ownerA', 'select * from private.delivery_code_attempts'), /42501/);
  await rejects(as('riderA', 'select * from private.delivery_code_attempts'), /42501/);
  await rejects(as('riderA', "insert into public.order_events (order_id,business_id,customer_id,to_status,actor_role) values ($1,$2,$3,'delivered','rider')",
    [legacy.road, shops.A.id, ids.customer1]), /42501/);
});
