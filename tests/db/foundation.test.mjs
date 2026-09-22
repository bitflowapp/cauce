// Executes the migration in embedded PostgreSQL (PGlite), not a policy mock.
// Auth fixtures below replace ONLY the platform-owned auth schema for this test.
// This does not test GoTrue, PostgREST, email, Storage, Realtime or concurrency.
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
