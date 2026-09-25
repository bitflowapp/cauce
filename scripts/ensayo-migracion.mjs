// Ensayo de B1 de punta a punta, sin tocar el proyecto real: un Supabase
// temporal con SÓLO las migraciones que hoy tiene producción, datos cargados
// con las funciones de esa versión (comercio publicado y pedidos en todos los
// estados) y, sobre él, exactamente los comandos que se corren en producción:
// `operacion.mjs backup` antes y después de migrar, y `operacion.mjs migrar`
// (que a su vez ensaya en otro stack antes de aplicar). Al final comprueba los
// datos migrados.
//
// El origen imita además lo que se vio en el proyecto real: Auth de Supabase en
// la nube va por delante de la CLI (tablas, columnas y secuencias que el stack
// local no tiene, como auth.mfa_recovery_code_sets).
//
//   node scripts/ensayo-migracion.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { migrationFiles, redact } from './lib/proyecto.mjs';
import { withTempStack } from './lib/respaldo.mjs';

const PENDING = '20260924120000';
const files = await migrationFiles();
const applied = files.filter(file => file.split('_')[0] < PENDING);
assert.equal(applied.length, files.length - 1, 'la migración pendiente es la última del repo');

const ids = Object.fromEntries(['merchant', 'customer', 'admin'].map(name => [name, randomUUID()]));
const operacion = (args) => spawnSync(process.execPath, ['scripts/operacion.mjs', ...args],
  { cwd: new URL('../', import.meta.url), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    // Frase de prueba: ejercita la copia cifrada sin tocar la real.
    env: { ...process.env, CAUCE_BACKUP_PASSPHRASE: 'frase-de-ensayo-local-cauce' } });
const results = run => redact(`${run.stdout}`).split('\n').filter(line => /^(PASS|FAIL|INFO)/.test(line)).join('\n');

await withTempStack({ migrations: applied, offset: 2000, projectId: 'cauce-origen', realtime: true }, async ({ db, status }) => {
  const as = (user, query, params = []) => db.begin(async tx => {
    await tx.unsafe('set local role authenticated');
    await tx.unsafe(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
      [JSON.stringify({ sub: user, role: 'authenticated', aud: 'authenticated' }), user]);
    return tx.unsafe(query, params);
  });

  // ── datos con la versión anterior ──
  for (const [name, id] of Object.entries(ids)) {
    await db.unsafe(`insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000000', $1,
      'authenticated', 'authenticated', $2, '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}')`,
    [id, `cauce-qa-ensayo-${name}@example.com`]);
    await as(id, 'insert into public.profiles (user_id, display_name) values ($1, $2)', [id, `Ensayo ${name}`]);
  }
  await db.unsafe('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);
  const [{ id: business }] = await as(ids.merchant, "select public.create_business('Almacén Ensayo', 'almacen-ensayo') as id");
  await as(ids.merchant, `update public.businesses set address = 'San Martín 100', hours_label = 'Todos los días',
    delivery_enabled = true, delivery_zone = 'Casco urbano', delivery_fee_ars = 800, minimum_order_ars = 1000,
    category_id = (select id from public.business_categories where slug = 'almacen') where id = $1`, [business]);
  await as(ids.merchant, "insert into public.business_contacts (business_id, owner_name, phone) values ($1, 'Titular', '2942000001')", [business]);
  const [{ id: product }] = await as(ids.merchant,
    "insert into public.products (business_id, name, price_ars, stock) values ($1, 'Yerba', 1500, 20) returning id", [business]);
  await as(ids.merchant, 'select public.submit_business_for_review($1)', [business]);
  await as(ids.admin, "select public.review_business($1, 'active', 'Aprobado')", [business]);
  await as(ids.merchant, 'select public.set_business_presence($1, null, true)', [business]);
  const [{ id: rider }] = await as(ids.merchant, "insert into public.business_riders (business_id, name) values ($1, 'Reparto') returning id", [business]);
  const order = async (fulfillment, quantity) => (await as(ids.customer,
    'select public.create_order($1, $2, $3, $4, $5::jsonb, $6::jsonb) as id',
    [business, randomUUID(), fulfillment, fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup',
      // El driver serializa los jsonb: se pasan objetos, no texto.
      { name: 'Vecina Ensayo', phone: '2942000333', notes: '', address: 'Calle Principal 123' },
      [{ product_id: product, quantity }]]))[0].id;
  const move = (id, version, next, riderId = null, reason = '') =>
    as(ids.merchant, 'select (public.transition_order($1, $2, $3, $4, $5)).status', [id, version, next, riderId, reason]);
  const pending = await order('pickup', 1);
  const done = await order('pickup', 2);
  for (const [version, next] of [[1, 'accepted'], [2, 'preparing'], [3, 'ready'], [4, 'delivered']]) await move(done, version, next);
  const road = await order('delivery', 3);
  for (const [version, next, r] of [[1, 'accepted'], [2, 'preparing'], [3, 'ready'], [4, 'assigned', rider], [5, 'picked_up']]) {
    await move(road, version, next, r || null);
  }
  const [{ n: ordersBefore }] = await db.unsafe('select count(*)::int as n from public.orders');
  console.log(`Origen con ${applied.length} migraciones: 1 comercio publicado, ${ordersBefore} pedidos en curso y cerrados.`);

  // ── Auth y Storage de la nube más nuevos que los de la CLI (lo visto en el
  // proyecto real: auth.mfa_recovery_code_sets, storage.buckets.lifecycle_configuration) ──
  await db.unsafe(`create table auth.mfa_recovery_code_sets (id uuid primary key default gen_random_uuid(),
    user_id uuid, created_at timestamptz not null default now())`);
  await db.unsafe("create table auth.future_table (id int primary key); insert into auth.future_table values (1)");
  await db.unsafe('alter table auth.users add column hosted_only_flag boolean not null default false');
  await db.unsafe('alter table storage.buckets add column lifecycle_configuration jsonb');
  await db.unsafe("create sequence auth.hosted_only_seq; select setval('auth.hosted_only_seq', 5)");

  // ── los comandos de producción, contra este origen ──
  const target = ['--db-url', status.DB_URL, '--api-url', status.API_URL, '--publishable', status.PUBLISHABLE_KEY,
    '--service', status.SECRET_KEY];
  const backupBefore = operacion(['backup', ...target]);
  console.log(`\nBackup antes de migrar:\n${results(backupBefore)}`);
  assert.equal(backupBefore.status, 0, `backup antes de migrar pasa: ${redact(backupBefore.stderr).slice(-300)}`);
  assert.match(backupBefore.stdout, /^PASS · RESTORE_TEST/m);
  assert.match(backupBefore.stdout, /^PASS · copia cifrada/m);
  assert.match(backupBefore.stdout, /omitido: .*auth\.future_table \(1 filas\)/);
  assert.match(backupBefore.stdout, /auth\.users: hosted_only_flag \(con valores/);
  assert.match(backupBefore.stdout, /storage\.buckets: lifecycle_configuration(;|$)/m);
  assert.match(backupBefore.stdout, /^PASS · las migraciones pendientes se aplican sobre la base restaurada/m);
  const dry = operacion(['migrar', ...target]);
  console.log(`\nMigración, dry-run:\n${dry.status === 0 ? results(dry) : redact(`${dry.stdout}${dry.stderr}`)}`);
  assert.equal(dry.status, 0, 'el dry-run pasa');
  const real = operacion(['migrar', ...target, '--aplicar']);
  console.log(`\nMigración aplicada:\n${results(real)}`);
  assert.equal(real.status, 0, `migrar --aplicar pasa: ${redact(real.stderr).slice(-300)}`);
  const backupAfter = operacion(['backup', ...target]);
  console.log(`\nBackup después de migrar:\n${results(backupAfter)}`);
  assert.equal(backupAfter.status, 0, `backup después de migrar pasa: ${redact(backupAfter.stderr).slice(-300)}`);
  assert.match(backupAfter.stdout, /^PASS · el contrato de esquema responde/m);

  // ── lo migrado conserva todo y sigue funcionando ──
  const [state] = await db.unsafe(`select
      (select count(*)::int from public.orders) as orders,
      (select status from public.orders where id = $1) as pending,
      (select status from public.orders where id = $2) as road,
      (select count(*)::int from public.order_events where from_status is null and to_status <> 'submitted') as orphans,
      (select track_stock from public.products where id = $3) as tracked,
      (select stock from public.products where id = $3) as stock`, [pending, road, product]);
  assert.deepEqual(state, { orders: ordersBefore, pending: 'submitted', road: 'picked_up', orphans: 0, tracked: true, stock: 14 });
  assert.equal((await move(road, 6, 'canceled', null, 'No se pudo entregar'))[0].status, 'canceled');
  console.log('\nENSAYO B1 PASS · backup y restauración antes y después, migración aplicada con el mismo comando que en producción, datos intactos y operables.');
});
