// Executes the migration in embedded PostgreSQL (PGlite), not a policy mock.
// Auth and storage fixtures below replace ONLY the platform-owned schemas, with
// the same shape the policies rely on (storage.objects.name, bucket_id).
// This does not test GoTrue, PostgREST, email, the Storage API, Realtime or
// concurrency: the real Storage service adds its own checks on top of these rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const ids = Object.fromEntries(['customerA', 'customerB', 'merchantA', 'merchantB', 'driverA', 'admin', 'manager', 'staff']
  .map((name, i) => [name, `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
let businessA, businessB;
async function as(name, sql, params = []) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${name === 'anon' ? 'anon' : 'authenticated'}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [ids[name] || '']);
    return tx.query(sql, params);
  });
}
const denied = promise => assert.rejects(promise, error => error.code === '42501');

before(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create schema storage;
    create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
      file_size_limit bigint, allowed_mime_types text[], created_at timestamptz not null default now());
    create table storage.objects (id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id), name text not null, owner uuid,
      metadata jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated;
    grant select on storage.buckets to anon, authenticated;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
    -- Exercise old Supabase defaults too: migrations must revoke these grants.
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users (id) values ($1)', [id]);
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
    "insert into public.products(business_id,category_id,name,price_ars,stock) values ($1,$2,'Pan casero',1800,10) returning id",
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
