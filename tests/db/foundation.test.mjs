// Executes the migration in embedded PostgreSQL (PGlite), not a policy mock.
// Auth and storage fixtures below replace ONLY the platform-owned schemas, with
// the same shape the policies rely on (storage.objects.name, bucket_id).
// This does not test GoTrue, PostgREST, email, the Storage API, Realtime or
// concurrency: the real Storage service adds its own checks on top of these rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './fixture.mjs';

const db = new PGlite();
const ids = Object.fromEntries(['customerA', 'customerB', 'merchantA', 'merchantB', 'driverA', 'admin', 'manager', 'staff', 'driverB']
  .map((name, i) => [name, `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
let businessA, businessB;
async function as(name, sql, params = []) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${name === 'anon' ? 'anon' : 'authenticated'}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [ids[name] || '']);
    // Igual que PostgREST: los claims completos del JWT, con is_anonymous.
    await tx.query("select set_config('request.jwt.claims', $1, true)", [ids[name]
      ? JSON.stringify({ sub: ids[name], role: 'authenticated', is_anonymous: name.startsWith('guest') })
      : '']);
    return tx.query(sql, params);
  });
}
const denied = promise => assert.rejects(promise, error => error.code === '42501');

before(async () => {
  await applyMigrations(db);
  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${name.toLowerCase()}@cauce.test`]);
    await as(name, 'insert into public.profiles (user_id, display_name) values ($1, $2)', [id, `Synthetic ${name}`]);
  }
  await db.query('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);
  businessA = (await as('merchantA', "select public.create_business('Synthetic A', 'synthetic-a') as id")).rows[0].id;
  businessB = (await as('merchantB', "select public.create_business('Synthetic B', 'synthetic-b') as id")).rows[0].id;
  await db.query("insert into public.business_memberships (business_id,user_id,role) values ($1,$2,'manager'),($1,$3,'staff')",
    [businessA, ids.manager, ids.staff]);
});
after(async () => { await db.close(); });

test('schema rebuild: every public and private table has RLS', async () => {
  const result = await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind='r' and not c.relrowsecurity`);
  assert.deepEqual(result.rows, []);
});
test('anonymous visitor sees Aluminé but no drafts', async () => {
  assert.equal((await as('anon', 'select slug from public.localities')).rows[0].slug, 'alumine');
  assert.equal((await as('anon', 'select * from public.businesses')).rows.length, 0);
  await denied(as('anon', 'select * from public.profiles'));
  await denied(as('anon', "select public.create_business('Intruder','intruder')"));
});
test('customer A cannot read customer B profile; driver and admin also see only self', async () => {
  for (const name of ['customerA', 'driverA', 'admin']) {
    assert.deepEqual((await as(name, 'select user_id from public.profiles')).rows, [{ user_id: ids[name] }]);
  }
});
test('profile can be edited by owner but cannot be reassigned or forged', async () => {
  assert.equal((await as('customerA', "update public.profiles set display_name='Updated Name' where user_id=$1 returning user_id", [ids.customerA])).rows.length, 1);
  assert.equal((await as('customerA', "update public.profiles set display_name='Intruder' where user_id=$1 returning user_id", [ids.customerB])).rows.length, 0);
  await denied(as('customerA', 'update public.profiles set user_id=$1 where user_id=$2', [ids.customerB, ids.customerA]));
  await denied(as('customerA', "insert into public.profiles(user_id,display_name) values ($1,'Intruder')", [ids.customerB]));
  await denied(as('customerA', 'delete from public.profiles'));
});
test('merchant A cannot see draft or membership of B', async () => {
  assert.deepEqual((await as('merchantA', 'select id from public.businesses')).rows, [{ id: businessA }]);
  const memberships = (await as('merchantA', 'select business_id,user_id,role from public.business_memberships')).rows;
  assert.deepEqual(memberships, [{ business_id: businessA, user_id: ids.merchantA, role: 'owner' }]);
});
test('merchant A cannot modify B, change tenancy or self-approve', async () => {
  assert.equal((await as('merchantA', "update public.businesses set name='Intruder' where id=$1 returning id", [businessB])).rows.length, 0);
  await denied(as('merchantA', "update public.businesses set status='active' where id=$1", [businessA]));
  await denied(as('merchantA', 'update public.businesses set locality_id=gen_random_uuid() where id=$1', [businessA]));
  await denied(as('merchantA', "insert into public.businesses(locality_id,name,slug,status) select id,'Intruder','intruder','active' from public.localities"));
});
test('manager can edit own business; staff and ordinary customer cannot', async () => {
  assert.equal((await as('manager', "update public.businesses set name='Managed A' where id=$1 returning id", [businessA])).rows.length, 1);
  for (const name of ['staff', 'customerA', 'driverA']) {
    assert.equal((await as(name, "update public.businesses set name='Intruder' where id=$1 returning id", [businessA])).rows.length, 0);
  }
});
test('no account can self-grant memberships, promote itself or delete memberships', async () => {
  for (const name of ['customerA', 'merchantA', 'staff', 'admin']) {
    await denied(as(name, "insert into public.business_memberships(business_id,user_id,role) values ($1,$2,'owner')", [businessB, ids[name]]));
    await denied(as(name, "update public.business_memberships set role='owner'"));
    await denied(as(name, 'delete from public.business_memberships'));
  }
});
test('user-editable metadata does not confer administration', async () => {
  await db.query(`update auth.users set raw_user_meta_data='{"role":"admin","roles":["admin"]}' where id=$1`, [ids.customerA]);
  assert.equal((await as('customerA', 'select private.is_admin() as allowed')).rows[0].allowed, false);
  assert.equal((await as('customerA', 'select * from public.businesses')).rows.length, 0);
  await denied(as('customerA', 'insert into private.platform_admins(user_id) values ($1)', [ids.customerA]));
});
test('explicit admin can review drafts without obtaining profile access or generic write privileges', async () => {
  assert.equal((await as('admin', 'select private.is_admin() as allowed')).rows[0].allowed, true);
  assert.equal((await as('admin', 'select * from public.businesses')).rows.length, 2);
  await denied(as('admin', "update public.businesses set status='active'"));
});
test('failed bootstrap leaves neither business nor owner behind', async () => {
  await assert.rejects(as('merchantA', "select public.create_business('Duplicate','synthetic-b')"), e => e.code === '23505');
  await assert.rejects(as('merchantA', "select public.create_business('Unknown locality','unknown','unknown')"), e => e.code === '23514');
  assert.equal((await db.query('select count(*)::int as n from public.businesses')).rows[0].n, 2);
  assert.equal((await db.query('select count(*)::int as n from public.business_memberships')).rows[0].n, 4);
});
test('privileged implementation independently checks missing auth.uid', async () => {
  await denied(as('missingIdentity', "select private.create_business('Intruder','intruder','alumine')"));
  assert.equal((await as('missingIdentity', 'select private.is_admin() as allowed')).rows[0].allowed, false);
});
test('active business is public, but memberships and profiles remain private', async () => {
  await db.query("update public.businesses set status='active' where id=$1", [businessB]);
  assert.deepEqual((await as('anon', 'select id from public.businesses')).rows, [{ id: businessB }]);
  await denied(as('anon', 'select * from public.business_memberships'));
  assert.equal((await as('customerA', 'select * from public.business_memberships')).rows.length, 0);
  await db.query("update public.businesses set status='draft' where id=$1", [businessB]);
});
test('no public definer functions and no anonymous execute on private helpers', async () => {
  const result = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef`);
  assert.deepEqual(result.rows, []);
  await denied(as('anon', 'select private.is_admin()'));
});

// ───────────────── catálogo, medios y ciclo de alta ─────────────────
const rows = result => result.rows;
let categoryA, productA, productB;

test('owner builds a catalog; the neighbouring business cannot read or touch it', async () => {
  categoryA = rows(await as('merchantA', "insert into public.product_categories(business_id,name) values ($1,'Panificados') returning id", [businessA]))[0].id;
  productA = rows(await as('merchantA',
    "insert into public.products(business_id,category_id,name,price_ars,stock,track_stock) values ($1,$2,'Pan casero',1800,10,true) returning id",
    [businessA, categoryA]))[0].id;
  productB = rows(await as('merchantB',
    "insert into public.products(business_id,name,price_ars,stock) values ($1,'Producto B',2500,5) returning id", [businessB]))[0].id;
  // La localidad la deriva el servidor desde el comercio, no el cliente.
  const scope = rows(await as('merchantA', 'select locality_id from public.products where id=$1', [productA]))[0];
  assert.equal(scope.locality_id, rows(await db.query('select locality_id from public.businesses where id=$1', [businessA]))[0].locality_id);
  assert.deepEqual(rows(await as('merchantA', 'select id from public.products order by name')), [{ id: productA }]);
  assert.deepEqual(rows(await as('merchantB', 'select id from public.products')), [{ id: productB }]);
  assert.equal(rows(await as('merchantA', "update public.products set name='Intrusion' where id=$1 returning id", [productB])).length, 0);
  assert.equal(rows(await as('merchantA', 'delete from public.products where id=$1 returning id', [productB])).length, 0);
});

test('a product cannot borrow another business category, locality or image path', async () => {
  await assert.rejects(as('merchantB',
    "insert into public.products(business_id,category_id,name,price_ars) values ($1,$2,'Robado',100)", [businessB, categoryA]),
  error => error.code === '23503');
  await denied(as('merchantA', 'update public.products set locality_id=gen_random_uuid() where id=$1', [productA]));
  await denied(as('merchantA', 'update public.products set business_id=$1 where id=$2', [businessB, productA]));
  await assert.rejects(as('merchantA',
    'update public.products set image_path=$1 where id=$2', [`businesses/${businessB}/products/x.webp`, productA]),
  error => error.code === '23514');
  assert.equal(rows(await as('merchantA',
    'update public.products set image_path=$1 where id=$2 returning id', [`businesses/${businessA}/products/${productA}/x.webp`, productA])).length, 1);
});

test('staff marks availability through the guarded call and never by direct write', async () => {
  // Una fila fuera de la politica no da error: no afecta ninguna fila.
  assert.equal(rows(await as('staff', 'update public.products set available=false where id=$1 returning id', [productA])).length, 0);
  await denied(as('staff', "insert into public.products(business_id,name,price_ars) values ($1,'De staff',100)", [businessA]));
  assert.equal(rows(await as('staff', 'select (public.set_product_availability($1,false,3)).available as available', [productA]))[0].available, false);
  assert.equal(rows(await as('merchantA', 'select available,stock from public.products where id=$1', [productA]))[0].stock, 3);
  await denied(as('merchantB', 'select public.set_product_availability($1,true,99)', [productA]));
  await denied(as('customerA', 'select public.set_product_availability($1,true,99)', [productA]));
  await as('merchantA', 'select public.set_product_availability($1,true,10)', [productA]);
});

test('variants stay inside their product and respect the documented limit', async () => {
  for (const name of ['Chico', 'Mediano', 'Grande']) {
    await as('merchantA', 'insert into public.product_variants(product_id,business_id,name,price_delta_ars) values ($1,$2,$3,200)',
      [productA, businessA, name]);
  }
  await denied(as('merchantB', 'insert into public.product_variants(product_id,business_id,name) values ($1,$2,$3)',
    [productA, businessA, 'Intruso']));
  await assert.rejects(as('merchantB', 'insert into public.product_variants(product_id,business_id,name) values ($1,$2,$3)',
    [productA, businessB, 'Cruzado']), error => error.code === '23503');
  for (const name of ['V4', 'V5', 'V6']) {
    await as('merchantA', 'insert into public.product_variants(product_id,business_id,name) values ($1,$2,$3)', [productA, businessA, name]);
  }
  await assert.rejects(as('merchantA', 'insert into public.product_variants(product_id,business_id,name) values ($1,$2,$3)',
    [productA, businessA, 'V7']), error => error.code === '23514');
});

test('private contact data belongs to the business and to administration only', async () => {
  await as('merchantA', "insert into public.business_contacts(business_id,owner_name,phone) values ($1,'Responsable A','2942000001')", [businessA]);
  assert.equal(rows(await as('merchantA', 'select phone from public.business_contacts')).length, 1);
  assert.equal(rows(await as('staff', 'select phone from public.business_contacts')).length, 1);
  assert.equal(rows(await as('merchantB', 'select phone from public.business_contacts')).length, 0);
  assert.equal(rows(await as('customerA', 'select phone from public.business_contacts')).length, 0);
  await denied(as('anon', 'select phone from public.business_contacts'));
  assert.equal(rows(await as('admin', 'select phone from public.business_contacts')).length, 1);
  assert.equal(rows(await as('staff', "update public.business_contacts set phone='0' where business_id=$1 returning business_id", [businessA])).length, 0);
});

test('publication requires a complete application and is decided only by administration', async () => {
  assert.ok(rows(await as('merchantA', 'select public.business_missing_requirements($1) as missing', [businessA]))[0].missing.length > 0);
  await assert.rejects(as('merchantA', 'select public.submit_business_for_review($1)', [businessA]), error => error.code === '23514');
  await as('merchantA', `update public.businesses set address='Ruta 23', hours_label='9 a 13 y 17 a 21',
    category_id=(select id from public.business_categories where slug='panaderia') where id=$1`, [businessA]);
  // Sin un canal de contacto para clientes todavía no se puede publicar.
  assert.deepEqual(rows(await as('merchantA', 'select public.business_missing_requirements($1) as missing', [businessA]))[0].missing,
    ['Teléfono o WhatsApp para clientes']);
  await as('merchantA', "update public.businesses set whatsapp='2942 555000' where id=$1", [businessA]);
  assert.deepEqual(rows(await as('merchantA', 'select public.business_missing_requirements($1) as missing', [businessA]))[0].missing, []);
  await denied(as('customerA', 'select public.submit_business_for_review($1)', [businessA]));
  assert.equal(rows(await as('merchantA', 'select public.submit_business_for_review($1) as status', [businessA]))[0].status, 'pending_review');
  await denied(as('merchantA', "select public.review_business($1,'active','')", [businessA]));
  await denied(as('staff', "select public.review_business($1,'active','')", [businessA]));
  await denied(as('customerA', "select public.review_business($1,'active','')", [businessA]));
  await assert.rejects(as('admin', "select public.review_business($1,'deleted','')", [businessA]), error => error.code === '23514');
  assert.equal(rows(await as('admin', "select public.review_business($1,'active','Aprobado') as decision", [businessA]))[0].decision, 'active');
  assert.equal(rows(await as('merchantA', 'select status from public.businesses where id=$1', [businessA]))[0].status, 'active');
  assert.equal(rows(await as('merchantA', 'select count(*)::int as n from public.business_review_events'))[0].n, 2);
  assert.equal(rows(await as('merchantB', 'select count(*)::int as n from public.business_review_events'))[0].n, 0);
});

test('opening and pausing belong to the business; publishing never does', async () => {
  assert.equal(rows(await as('merchantA', 'select public.set_business_presence($1,null,true) as status', [businessA]))[0].status, 'active');
  assert.equal(rows(await as('merchantA', 'select open from public.businesses where id=$1', [businessA]))[0].open, true);
  await denied(as('staff', 'select public.set_business_presence($1,null,false)', [businessA]));
  await assert.rejects(as('merchantB', "select public.set_business_presence($1,'active',null)", [businessB]), error => error.code === '23514');
  assert.equal(rows(await as('merchantA', "select public.set_business_presence($1,'paused',null) as status", [businessA]))[0].status, 'paused');
  assert.equal(rows(await as('merchantA', 'select open from public.businesses where id=$1', [businessA]))[0].open, false);
  await assert.rejects(as('merchantA', 'select public.set_business_presence($1,null,true)', [businessA]), error => error.code === '23514');
  await as('merchantA', "select public.set_business_presence($1,'active',true)", [businessA]);
});

test('the public catalog shows a published business and hides drafts and archived items', async () => {
  // `archived` no se puede fijar al crear: sólo se da de baja un producto existente.
  await denied(as('merchantA', "insert into public.products(business_id,name,price_ars,archived) values ($1,'Producto de baja',900,true)", [businessA]));
  const hidden = rows(await as('merchantA',
    "insert into public.products(business_id,name,price_ars) values ($1,'Producto de baja',900) returning id", [businessA]))[0].id;
  await as('merchantA', 'update public.products set archived=true where id=$1', [hidden]);
  assert.deepEqual(rows(await as('anon', 'select id from public.products order by name')).map(row => row.id), [productA]);
  assert.deepEqual(rows(await as('customerA', 'select id from public.products')).map(row => row.id), [productA]);
  assert.equal(rows(await as('anon', 'select count(*)::int as n from public.product_variants'))[0].n, 6);
  assert.equal(rows(await as('anon', 'select count(*)::int as n from public.product_categories'))[0].n, 1);
  assert.equal(rows(await as('merchantA', 'select count(*)::int as n from public.products'))[0].n, 2);
  await denied(as('anon', "insert into public.products(business_id,name,price_ars) values ($1,'Intruso',100)", [businessA]));
  await denied(as('customerA', "insert into public.products(business_id,name,price_ars) values ($1,'Intruso',100)", [businessA]));
  await as('merchantA', 'delete from public.products where id=$1', [hidden]);
});

test('media paths isolate every business and keep staff out of uploads', async () => {
  const upload = (who, path) => as(who, 'insert into storage.objects(bucket_id,name) values ($1,$2)', ['business-media', path]);
  await upload('merchantA', `businesses/${businessA}/logo/logo.webp`);
  await upload('merchantA', `businesses/${businessA}/products/${productA}/photo.webp`);
  await denied(upload('merchantA', `businesses/${businessB}/logo/logo.webp`));
  await denied(upload('merchantA', `businesses/${businessA}/../${businessB}/logo/logo.webp`));
  await denied(upload('merchantA', 'logo.webp'));
  await denied(upload('staff', `businesses/${businessA}/products/${productA}/staff.webp`));
  await denied(upload('customerA', `businesses/${businessA}/logo/logo.webp`));
  assert.equal(rows(await as('manager', 'select count(*)::int as n from storage.objects'))[0].n, 2);
  assert.equal(rows(await as('staff', 'select count(*)::int as n from storage.objects'))[0].n, 2);
  assert.equal(rows(await as('merchantB', 'select count(*)::int as n from storage.objects'))[0].n, 0);
  assert.equal(rows(await as('customerA', 'select count(*)::int as n from storage.objects'))[0].n, 0);
  assert.equal(rows(await as('merchantB', 'delete from storage.objects returning id')).length, 0);
  assert.equal(rows(await as('merchantB', "update storage.objects set name='robado' returning id")).length, 0);
  assert.equal(rows(await as('merchantA', 'delete from storage.objects returning id')).length, 2);
});

// ───────────────── pedidos, reparto y viajes ─────────────────
const variantOf = async () => rows(await as('merchantA',
  'select id from public.product_variants where product_id=$1 order by name limit 1', [productA]))[0].id;
const itemsFor = (variant, quantity = 1) => JSON.stringify([{ product_id: productA, variant_id: variant, quantity }]);
const contact = JSON.stringify({ name: 'Vecina Sintética', phone: '2942000111', notes: 'Sin sal' });
const orderCall = (who, business, key, fulfillment, items, contactJson = contact) => as(who,
  'select public.create_order($1,$2,$3,$4,$5::jsonb,$6::jsonb) as id',
  [business, key, fulfillment, fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup', contactJson, items]);
let orderA, keyA;

test('the server prices the order, the client only chooses products', async () => {
  const variant = await variantOf();
  keyA = crypto.randomUUID();
  orderA = rows(await orderCall('customerA', businessA, keyA, 'pickup', itemsFor(variant, 2)))[0].id;
  const order = rows(await as('customerA', 'select * from public.orders where id=$1', [orderA]))[0];
  // 1800 de base + 200 de la variante, por dos unidades. Sin envío en retiro.
  assert.equal(Number(order.subtotal_ars), 4000);
  assert.equal(Number(order.delivery_fee_ars), 0);
  assert.equal(Number(order.total_ars), 4000);
  assert.equal(order.status, 'submitted');
  assert.match(order.code, /^CA-\d{4}$/);
  assert.equal(rows(await as('customerA', 'select stock from public.products where id=$1', [productA]))[0].stock, 8);
  const items = rows(await as('customerA', 'select product_name,variant_name,unit_price_ars,total_ars from public.order_items where order_id=$1', [orderA]));
  assert.equal(items.length, 1);
  assert.equal(items[0].product_name, 'Pan casero');
  assert.equal(Number(items[0].unit_price_ars), 2000);
});

test('the same attempt never creates a second order and a changed attempt is refused', async () => {
  const variant = await variantOf();
  assert.equal(rows(await orderCall('customerA', businessA, keyA, 'pickup', itemsFor(variant, 2)))[0].id, orderA);
  assert.equal(rows(await as('customerA', 'select count(*)::int as n from public.orders'))[0].n, 1);
  assert.equal(rows(await as('customerA', 'select stock from public.products where id=$1', [productA]))[0].stock, 8);
  await assert.rejects(orderCall('customerA', businessA, keyA, 'pickup', itemsFor(variant, 3)),
    error => error.code === 'U0002');
});

test('an order snapshot survives later catalog edits', async () => {
  await as('merchantA', "update public.products set name='Pan casero grande', price_ars=5000 where id=$1", [productA]);
  const items = rows(await as('customerA', 'select product_name,unit_price_ars from public.order_items where order_id=$1', [orderA]));
  assert.equal(items[0].product_name, 'Pan casero');
  assert.equal(Number(items[0].unit_price_ars), 2000);
  await as('merchantA', "update public.products set name='Pan casero', price_ars=1800 where id=$1", [productA]);
});

test('stock, closed shops and unavailable products stop an order before it is created', async () => {
  const variant = await variantOf();
  await assert.rejects(orderCall('customerA', businessA, crypto.randomUUID(), 'pickup', itemsFor(variant, 99)),
    error => error.code === 'U0003');
  await assert.rejects(orderCall('customerA', businessA, crypto.randomUUID(), 'delivery', itemsFor(variant, 1)),
    error => error.code === '23514');
  await assert.rejects(orderCall('customerA', businessA, crypto.randomUUID(), 'pickup', JSON.stringify([])),
    error => error.code === '23514');
  // Un producto de otro comercio no entra en el pedido aunque se lo nombre.
  await assert.rejects(orderCall('customerA', businessA, crypto.randomUUID(), 'pickup',
    JSON.stringify([{ product_id: productB, quantity: 1 }])), error => error.code === '23514');
  await as('merchantA', "select public.set_business_presence($1,null,false)", [businessA]);
  await assert.rejects(orderCall('customerB', businessA, crypto.randomUUID(), 'pickup', itemsFor(variant, 1)),
    error => error.code === '23514');
  await as('merchantA', "select public.set_business_presence($1,null,true)", [businessA]);
  assert.equal(rows(await as('customerA', 'select stock from public.products where id=$1', [productA]))[0].stock, 8);
});

test('an order is visible to its customer and its business, to nobody else', async () => {
  assert.equal(rows(await as('customerA', 'select id from public.orders')).length, 1);
  assert.equal(rows(await as('merchantA', 'select id from public.orders')).length, 1);
  assert.equal(rows(await as('staff', 'select id from public.orders')).length, 1);
  assert.equal(rows(await as('customerB', 'select id from public.orders')).length, 0);
  assert.equal(rows(await as('merchantB', 'select id from public.orders')).length, 0);
  assert.equal(rows(await as('admin', 'select id from public.orders')).length, 0);
  await denied(as('anon', 'select id from public.orders'));
  assert.equal(rows(await as('customerB', 'select id from public.order_items')).length, 0);
  assert.equal(rows(await as('merchantB', 'select id from public.order_events')).length, 0);
  // Sin INSERT ni UPDATE directos: la única vía es la función con reglas.
  await denied(as('customerA', "update public.orders set total_ars=1 where id=$1", [orderA]));
  await denied(as('customerA', "update public.orders set status='delivered' where id=$1", [orderA]));
  await denied(as('merchantA', "update public.orders set status='delivered' where id=$1", [orderA]));
  await denied(as('customerA', "insert into public.orders(code,business_id,locality_id,customer_id,idempotency_key,request_fingerprint,fulfillment,payment_method,contact_name,contact_phone,subtotal_ars,total_ars) values ('CA-9999',$1,$2,$3,gen_random_uuid(),'x','pickup','cash_on_pickup','X','2942000000',1,1)",
    [businessA, null, ids.customerA]));
});

test('only the business advances an order, and never out of order', async () => {
  const move = (who, status, version, rider = null) => as(who,
    'select (public.transition_order($1,$2,$3,$4,$5)).status as status', [orderA, version, status, rider, '']);
  await assert.rejects(move('customerA', 'delivered', 1), error => error.code === '42501');
  await assert.rejects(move('customerA', 'preparing', 1), error => error.code === '42501');
  await assert.rejects(move('merchantB', 'accepted', 1), error => error.code === '42501');
  await assert.rejects(move('customerB', 'accepted', 1), error => error.code === '42501');
  await assert.rejects(move('merchantA', 'ready', 1), error => error.code === '42501');
  await assert.rejects(move('merchantA', 'accepted', 7), error => error.code === 'U0001');
  assert.equal(rows(await move('merchantA', 'accepted', 1))[0].status, 'accepted');
  assert.equal(rows(await move('merchantA', 'preparing', 2))[0].status, 'preparing');
  assert.equal(rows(await move('merchantA', 'ready', 3))[0].status, 'ready');
  // En retiro no hay asignación de reparto.
  await assert.rejects(move('merchantA', 'assigned', 4), error => error.code === '42501');
  assert.equal(rows(await move('merchantA', 'delivered', 4))[0].status, 'delivered');
  assert.equal(rows(await as('merchantA', 'select payment_status from public.orders where id=$1', [orderA]))[0].payment_status, 'settled');
  await assert.rejects(move('merchantA', 'canceled', 5), error => error.code === '42501');
  assert.equal(rows(await as('customerA', 'select count(*)::int as n from public.order_events where order_id=$1', [orderA]))[0].n, 5);
});

test('delivery assigns only riders of the same business and cancelling returns stock', async () => {
  await as('merchantA', `update public.businesses set delivery_enabled=true, delivery_zone='Casco urbano',
    delivery_fee_ars=1200, minimum_order_ars=1000 where id=$1`, [businessA]);
  const riderA = rows(await as('merchantA', "insert into public.business_riders(business_id,name,phone) values ($1,'Reparto A','2942000222') returning id", [businessA]))[0].id;
  const riderB = rows(await as('merchantB', "insert into public.business_riders(business_id,name) values ($1,'Reparto B') returning id", [businessB]))[0].id;
  assert.equal(rows(await as('merchantB', 'select id from public.business_riders')).length, 1);
  assert.equal(rows(await as('customerA', 'select id from public.business_riders')).length, 0);
  const variant = await variantOf();
  const delivery = rows(await orderCall('customerA', businessA, crypto.randomUUID(), 'delivery', itemsFor(variant, 1),
    JSON.stringify({ name: 'Vecina Sintética', phone: '2942000111', address: 'Calle Principal 123' })))[0].id;
  const order = rows(await as('customerA', 'select subtotal_ars,delivery_fee_ars,total_ars,delivery_code from public.orders where id=$1', [delivery]))[0];
  assert.equal(Number(order.subtotal_ars), 2000);
  assert.equal(Number(order.delivery_fee_ars), 1200);
  assert.equal(Number(order.total_ars), 3200);
  assert.match(order.delivery_code, /^\d{4}$/);
  const move = (who, status, version, rider = null) => as(who,
    'select (public.transition_order($1,$2,$3,$4,$5)).status as status', [delivery, version, status, rider, '']);
  await move('merchantA', 'accepted', 1);
  await move('merchantA', 'preparing', 2);
  await move('merchantA', 'ready', 3);
  await assert.rejects(move('merchantA', 'assigned', 4, riderB), error => error.code === '23514');
  await assert.rejects(move('merchantA', 'assigned', 4, null), error => error.code === '23514');
  assert.equal(rows(await move('merchantA', 'assigned', 4, riderA))[0].status, 'assigned');
  assert.equal(rows(await move('merchantA', 'picked_up', 5))[0].status, 'picked_up');
  assert.equal(rows(await move('merchantA', 'on_the_way', 6))[0].status, 'on_the_way');
  assert.equal(rows(await move('merchantA', 'arrived', 7))[0].status, 'arrived');
  assert.equal(rows(await move('merchantA', 'delivered', 8))[0].status, 'delivered');

  const cancelable = rows(await orderCall('customerA', businessA, crypto.randomUUID(), 'pickup', itemsFor(variant, 2)))[0].id;
  assert.equal(rows(await as('customerA', 'select stock from public.products where id=$1', [productA]))[0].stock, 5);
  assert.equal(rows(await as('customerA',
    'select (public.transition_order($1,1,$2,null,$3)).status as status', [cancelable, 'canceled', 'Me arrepentí']))[0].status, 'canceled');
  assert.equal(rows(await as('customerA', 'select stock from public.products where id=$1', [productA]))[0].stock, 7);
});

test('taxi is switched off by default and its logic survives for a later stage', async () => {
  await denied(as('driverA', "select public.apply_as_driver('Conductor Sintético A','Móvil 1','Auto','AAA111','2942000333')"));
  await denied(as('customerA', "select public.request_trip('Ruta 23','Hospital','',1,'Vecina Sintética','2942000111')"));
  assert.deepEqual(rows(await as('driverA', 'select * from public.driver_offers()')), []);
  // Habilitar la vertical es una decisión de operación, no de código.
  await db.query("update private.platform_features set enabled = true where key = 'taxi'");
});

test('a driver only exists after administration approves the application', async () => {
  await as('driverA', "select public.apply_as_driver('Conductor Sintético A','Móvil 1','Auto','AAA111','2942000333')");
  await as('driverB', "select public.apply_as_driver('Conductor Sintético B','Móvil 2','Auto','BBB222','2942000444')");
  assert.equal(rows(await as('driverA', 'select status,available from public.drivers'))[0].status, 'pending_review');
  assert.equal(rows(await as('driverA', 'select id from public.drivers')).length, 1);
  assert.equal(rows(await as('driverB', 'select id from public.drivers')).length, 1);
  assert.equal(rows(await as('customerA', 'select id from public.drivers')).length, 0);
  await denied(as('driverA', 'select public.set_driver_availability(true)'));
  await denied(as('driverA', "select public.review_driver((select id from public.drivers limit 1),'active','')"));
  await denied(as('customerA', 'select public.admin_drivers()'));
  assert.equal(rows(await as('admin', 'select id from public.admin_drivers()')).length, 2);
  for (const who of ['driverA', 'driverB']) {
    const id = rows(await as(who, 'select id from public.drivers'))[0].id;
    await as('admin', "select public.review_driver($1,'active','Aprobado')", [id]);
    await as(who, 'select public.set_driver_availability(true)');
  }
});

test('two drivers cannot take the same trip and the loser is told so', async () => {
  const trip = rows(await as('customerA',
    "select (public.request_trip('Ruta 23','Hospital','Portón azul',2,'Vecina Sintética','2942000111')).id as id"))[0].id;
  await assert.rejects(as('customerA',
    "select public.request_trip('Otra','Otro','',1,'Vecina Sintética','2942000111')"), error => error.code === '23514');
  // Antes de aceptar, la oferta no revela nombre ni teléfono.
  const offers = rows(await as('driverA', 'select * from public.driver_offers()'));
  assert.equal(offers.length, 1);
  assert.equal(offers[0].passenger_initial, 'V');
  assert.ok(!Object.keys(offers[0]).some(key => /phone|passenger_name/.test(key)));
  assert.equal(rows(await as('driverA', 'select id from public.trips')).length, 0);
  assert.equal(rows(await as('driverB', 'select id from public.trips')).length, 0);
  assert.equal(rows(await as('customerB', 'select id from public.trips')).length, 0);
  await denied(as('anon', 'select id from public.trips'));

  assert.equal(rows(await as('driverA', 'select (public.accept_trip($1)).status as status', [trip]))[0].status, 'accepted');
  await assert.rejects(as('driverB', 'select public.accept_trip($1)', [trip]), error => error.code === 'U0004');
  assert.equal(rows(await as('driverB', 'select * from public.driver_offers()')).length, 0);
  assert.equal(rows(await as('driverA', 'select passenger_phone from public.trips'))[0].passenger_phone, '2942000111');
  assert.equal(rows(await as('driverB', 'select id from public.trips')).length, 0);
  const assigned = rows(await as('customerA', 'select (public.trip_driver($1)).plate as plate', [trip]))[0];
  assert.equal(assigned.plate, 'AAA111');
  assert.equal(rows(await as('customerB', 'select (public.trip_driver($1)).plate as plate', [trip]))[0].plate, null);

  await assert.rejects(as('driverB', "select public.transition_trip($1,'driver_on_way','')", [trip]), error => error.code === '42501');
  await assert.rejects(as('customerA', "select public.transition_trip($1,'completed','')", [trip]), error => error.code === '42501');
  await assert.rejects(as('driverA', "select public.transition_trip($1,'completed','')", [trip]), error => error.code === '42501');
  for (const next of ['driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip', 'completed']) {
    assert.equal(rows(await as('driverA', 'select (public.transition_trip($1,$2,$3)).status as status', [trip, next, '']))[0].status, next);
  }
  assert.equal(rows(await as('customerA', 'select count(*)::int as n from public.trip_events where trip_id=$1', [trip]))[0].n, 7);
  assert.equal(rows(await as('customerB', 'select count(*)::int as n from public.trip_events'))[0].n, 0);
});

test('two lines of the same product neither oversell nor block an available sale', async () => {
  const variants = rows(await as('merchantA',
    'select id from public.product_variants where product_id=$1 order by name limit 2', [productA]));
  await as('merchantA', 'select public.set_product_availability($1,true,10)', [productA]);
  const items = JSON.stringify([
    { product_id: productA, variant_id: variants[0].id, quantity: 5 },
    { product_id: productA, variant_id: variants[1].id, quantity: 5 },
  ]);
  // Diez unidades disponibles y diez pedidas: el pedido entra completo.
  const order = rows(await orderCall('customerB', businessA, crypto.randomUUID(), 'pickup', items))[0].id;
  assert.equal(rows(await as('merchantA', 'select stock from public.products where id=$1', [productA]))[0].stock, 0);
  assert.equal(Number(rows(await as('customerB', 'select total_ars from public.orders where id=$1', [order]))[0].total_ars), 20000);
  // Una unidad más ya no existe.
  await assert.rejects(orderCall('customerB', businessA, crypto.randomUUID(), 'pickup',
    JSON.stringify([{ product_id: productA, variant_id: variants[0].id, quantity: 1 }])), error => error.code === 'U0003');
  // Al cancelar se devuelven las diez, no cinco.
  await as('customerB', 'select public.transition_order($1,1,$2,null,$3)', [order, 'canceled', 'Prueba']);
  assert.equal(rows(await as('merchantA', 'select stock from public.products where id=$1', [productA]))[0].stock, 10);
});

// ───────────────── auditoría del esquema construido ─────────────────
test('a visitor without session executes only the explicit public contract', async () => {
  const result = await db.query(`select n.nspname||'.'||p.proname as name
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1`);
  assert.deepEqual(result.rows.map(row => row.name), [
    'private.app_status', 'private.business_open_now', 'private.report_client_event', 'private.track_order',
    'public.app_status', 'public.open_now', 'public.report_client_event', 'public.track_order',
  ]);
});
test('every CAUCE function pins its search_path and stays out of public if privileged', async () => {
  const loose = await db.query(`select n.nspname||'.'||p.proname as name
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f'
      and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))`);
  assert.deepEqual(loose.rows, []);
  const definer = await db.query(`select p.proname as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef`);
  assert.deepEqual(definer.rows, []);
});
test('no view is exposed, and none could run with the definer privileges', async () => {
  const views = await db.query(`select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('v','m')
      and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'off') <> 'true'`);
  assert.deepEqual(views.rows, []);
});
test('no anonymous or authenticated account writes a table directly beyond its columns', async () => {
  // anon nunca escribe; `authenticated` sólo tiene DELETE donde el propio
  // comercio da de baja su catálogo o su reparto. INSERT y UPDATE son por columna.
  const anon = await db.query(`select table_name as name, privilege_type as p from information_schema.role_table_grants
    where grantee='anon' and privilege_type <> 'SELECT' and table_schema in ('public','private')`);
  assert.deepEqual(anon.rows, []);
  const writes = await db.query(`select table_name||' '||privilege_type as grant_name from information_schema.role_table_grants
    where grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
      and table_schema in ('public','private') order by 1`);
  assert.deepEqual(writes.rows.map(row => row.grant_name), [
    'business_hours DELETE', 'business_riders DELETE', 'product_categories DELETE', 'product_variants DELETE',
    'products DELETE',
  ]);
});
test('orders and trips accept no direct writes from any client role', async () => {
  const result = await db.query(`select table_name as name, privilege_type as p, grantee
    from information_schema.role_table_grants
    where table_name in ('orders','order_items','order_events','trips','trip_events','drivers')
      and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'`);
  assert.deepEqual(result.rows, []);
  const columns = await db.query(`select table_name as name from information_schema.column_privileges
    where table_name in ('orders','order_items','order_events','trips','trip_events')
      and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'`);
  assert.deepEqual(columns.rows, []);
});
