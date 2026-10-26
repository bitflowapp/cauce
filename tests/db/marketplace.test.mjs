// Marketplace multirrubro · fase 1: taxonomía de rubros, capacidades del
// comercio, alta atómica con rubro y moderación administrativa.
// Se ejecuta en PostgreSQL embebido (PGlite) con las migraciones reales: no es
// una imitación de las políticas, es el mismo SQL que corre el proyecto.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, applyMigration, migrationFiles, versionOf } from './fixture.mjs';
import { BUSINESS_CATEGORIES } from '../../js/core/rubro-catalogo.js';
import { REQUIRED_SCHEMA } from '../../js/core/contract.js';

const db = new PGlite();
const ids = Object.fromEntries(['vendorA', 'vendorB', 'vendorMany', 'fresh', 'seller', 'admin']
  .map((name, i) => [name, `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const rows = result => result.rows;

async function as(name, sql, params = []) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${name === 'anon' ? 'anon' : 'authenticated'}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [ids[name] || '']);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [ids[name]
      ? JSON.stringify({ sub: ids[name], role: 'authenticated', is_anonymous: false })
      : '']);
    return tx.query(sql, params);
  });
}
const denied = promise => assert.rejects(promise, error => error.code === '42501');

before(async () => {
  await applyMigrations(db);
  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${name}@cauce.test`]);
    if (name !== 'fresh') {
      await as(name, 'insert into public.profiles (user_id, display_name) values ($1, $2)', [id, `Sintético ${name}`]);
    }
  }
  await db.query('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);
});

after(async () => { await db.close(); });

// ───────────────── taxonomía ─────────────────
test('la taxonomía sembrada en la base es la lista de lanzamiento del marketplace', async () => {
  const stored = rows(await db.query(`select slug, name, position, capabilities
    from public.business_categories order by position`));
  assert.deepEqual(stored, BUSINESS_CATEGORIES.map(category => ({
    slug: category.slug, name: category.name, position: category.position,
    capabilities: [...category.capabilities],
  })));
  // Venta pública: los clientes anónimos ven la lista activa.
  assert.equal(rows(await as('anon', 'select id from public.business_categories')).length, stored.length);
});

test('el contrato de esquema es el que exige este frontend', async () => {
  const status = rows(await as('anon', 'select public.app_status() as s'))[0].s;
  assert.equal(Number(status.schema), REQUIRED_SCHEMA);
});

// ───────────────── alta atómica con rubro ─────────────────
let bakery;
test('el borrador nace con rubro y capacidades en una sola llamada', async () => {
  bakery = rows(await as('vendorA', "select public.create_business('Panadería Sintética', 'panaderia-sintetica', 'alumine', 'panaderia') as id"))[0].id;
  const business = rows(await as('vendorA', `select status, c.name as category, b.capabilities
    from public.businesses b left join public.business_categories c on c.id = b.category_id where b.id = $1`, [bakery]))[0];
  assert.equal(business.status, 'draft');
  assert.equal(business.category, 'Panadería');
  assert.deepEqual([...business.capabilities], ['products', 'prepared_food']);
  const membership = rows(await db.query('select user_id, role from public.business_memberships where business_id = $1', [bakery]));
  assert.deepEqual(membership, [{ user_id: ids.vendorA, role: 'owner' }]);
  // Sin sesión no hay alta, ni siquiera con datos completos.
  await denied(as('anon', "select public.create_business('Intruso', 'intruso', 'alumine', 'panaderia')"));
});

test('un alta sin perfil o con rubro o localidad desconocidos no deja rastro', async () => {
  await assert.rejects(as('fresh', "select public.create_business('Sin perfil', 'sin-perfil', 'alumine', 'almacen')"),
    error => error.code === '23514');
  await assert.rejects(as('vendorA', "select public.create_business('Rubro fantasma', 'rubro-fantasma', 'alumine', 'telefonia')"),
    error => error.code === '23514');
  await assert.rejects(as('vendorA', "select public.create_business('Localidad fantasma', 'localidad-fantasma', 'otra', 'almacen')"),
    error => error.code === '23514');
  for (const slug of ['sin-perfil', 'rubro-fantasma', 'localidad-fantasma']) {
    assert.equal(rows(await db.query('select 1 from public.businesses where slug = $1', [slug])).length, 0);
  }
});

test('la firma de tres parámetros sigue vigente y sin rubro queda vacía', async () => {
  const id = rows(await as('vendorB', "select public.create_business('Almacén Legado', 'almacen-legado') as id"))[0].id;
  const business = rows(await db.query('select category_id::text as category, capabilities from public.businesses where id = $1', [id]))[0];
  assert.equal(business.category, null);
  assert.deepEqual([...business.capabilities], []);
});

test('anti-spam: ninguna cuenta administra más comercios que el tope', async () => {
  for (const slug of ['almacen', 'kiosco', 'servicios']) {
    await as('vendorMany', `select public.create_business('Comercio ${slug}', 'sp-${slug}', 'alumine', '${slug}')`);
  }
  await assert.rejects(as('vendorMany', "select public.create_business('Comercio cuatro', 'sp-cuatro', 'alumine', 'otros')"),
    error => error.code === '23514');
  assert.equal(rows(await db.query('select 1 from public.businesses where slug = $1', ['sp-cuatro'])).length, 0);
  // La pertenencia ajena no agrava el tope: sólo cuentan los comercios propios.
  await db.query("insert into public.business_memberships (business_id, user_id, role) values ($1, $2, 'staff')", [bakery, ids.vendorMany]);
  // Y ser staff de otro comercio sigue sin dar permisos de edición.
  assert.equal(rows(await as('vendorMany', "update public.businesses set name='Intrusión staff' where id = $1 returning id", [bakery])).length, 0);
  assert.equal(rows(await db.query('select count(*)::int as n from public.businesses where slug like $1', ['sp-%']))[0].n, 3);
});

// ───────────────── capacidades del comercio ─────────────────
test('el titular ajusta capacidades dentro de lo que su rubro habilita', async () => {
  assert.deepEqual(
    [...rows(await as('vendorA', "update public.businesses set capabilities = array['prepared_food'] where id = $1 returning capabilities", [bakery]))[0].capabilities],
    ['prepared_food']);
  // El rubro Talleres habilita servicios; el cambio de rubro y el ajuste de
  // capacidades van juntos porque el disparador valida la pareja resultante.
  await as('vendorA', "update public.businesses set category_id = (select id from public.business_categories where slug = 'talleres'),"
    + " capabilities = array['services'] where id = $1", [bakery]);
  await assert.rejects(as('vendorA', "update public.businesses set capabilities = array['services','products'] where id = $1", [bakery]),
    error => error.code === '23514');
  assert.deepEqual(
    [...rows(await as('vendorA', "update public.businesses set capabilities = array['services'] where id = $1 returning capabilities", [bakery]))[0].capabilities],
    ['services']);
  await assert.rejects(as('vendorA', "update public.businesses set capabilities = array['servicios-digitales'] where id = $1", [bakery]),
    error => error.code === '23514');
  // El borrador legado sin rubro puede declarar del vocabulario, pero no más.
  const legacy = rows(await db.query("select id from public.businesses where slug = 'almacen-legado'"))[0].id;
  await assert.rejects(as('vendorB', "update public.businesses set capabilities = array['menu'] where id = $1", [legacy]),
    error => error.code === '23514');
  assert.deepEqual(
    [...rows(await as('vendorB', "update public.businesses set capabilities = array['products'] where id = $1 returning capabilities", [legacy]))[0].capabilities],
    ['products']);
});

test('las capacidades de otro comercio son intocables y su borrador invisible', async () => {
  assert.equal(rows(await as('vendorB', "update public.businesses set capabilities = array['products'] where id = $1 returning id", [bakery])).length, 0);
  assert.equal(rows(await as('vendorB', 'select id from public.businesses where id = $1', [bakery])).length, 0);
  await denied(as('anon', "update public.businesses set capabilities = array['products'] where id = $1", [bakery]));
});

// ───────────────── taxonomía administrable ─────────────────
// Se descompone el registro compuesto una sola vez (CTE volátil: sin aplazado
// no se re-ejecuta el efecto), igual que se consume accept_trip en operaciones.
const TAXONOMY_RPC = 'with upserted as (select public.admin_upsert_business_category($1, $2, $3::smallint, $4::text[], $5) as row)'
  + ' select (row).* from upserted';

test('sólo administración ajusta la taxonomía, y la base valida cada campo', async () => {
  await denied(as('vendorA', "select public.admin_upsert_business_category('telefonia', 'Telefonía', 900::smallint, array['services'])"));
  const created = rows(await as('admin', TAXONOMY_RPC, ['telefonia', 'Telefonía', 900, ['services'], true]))[0];
  assert.deepEqual([...created.capabilities], ['services']);
  assert.equal(created.active, true);
  // Ajuste del mismo rubro: mismo slug, otra carta de capacidades.
  const updated = rows(await as('admin', TAXONOMY_RPC, ['telefonia', 'Telefonía y equipos', 910, [], true]))[0];
  assert.deepEqual([...updated.capabilities], []);
  await assert.rejects(as('admin', TAXONOMY_RPC, ['telefonia', 'Telefonía', 900, ['menu'], true]), error => error.code === '23514');
  // Sin administración tampoco cambia lo existente.
  await denied(as('vendorB', TAXONOMY_RPC, ['panaderia', 'Panadería invadida', 20, ['products'], true]));
});

test('un rubro inhabilitado no se elige y deja de mostrarse', async () => {
  const paused = rows(await as('admin', TAXONOMY_RPC, ['telefonia', 'Telefonía', 900, ['services'], false]))[0];
  assert.equal(paused.active, false);
  await assert.rejects(as('vendorB', "select public.create_business('Sin rubro posible', 'sin-rubro-posible', 'alumine', 'telefonia')"),
    error => error.code === '23514');
  const visible = rows(await as('anon', 'select slug from public.business_categories order by position')).map(row => row.slug);
  assert.equal(visible.includes('telefonia'), false);
  // Reactivar vuelve a la lista pública.
  await as('admin', TAXONOMY_RPC, ['telefonia', 'Telefonía', 900, ['services'], true]);
  assert.equal(rows(await as('anon', 'select slug from public.business_categories')).some(row => row.slug === 'telefonia'), true);
});

// ───────────────── migración aditiva sobre datos existentes ─────────────────
// Las dos migraciones nuevas se prueban una después de la otra sobre una base
// viva: primero la taxonomía (20261024100000) y después la condición del
// artículo (REQUIRED_SCHEMA). Así cada una se aplica como llegaría a producción.
test('las migraciones nuevas corren sobre una base viva sin alterar sus datos', async () => {
  const TAXONOMY_SCHEMA = 20261024100000;
  const step = new PGlite();
  try {
    assert.ok((await migrationFiles()).some(file => versionOf(file) === REQUIRED_SCHEMA), 'la migración nueva está en el repo');
    assert.ok(REQUIRED_SCHEMA > TAXONOMY_SCHEMA, 'la migración de condición va después de la taxonomía');
    const applied = await applyMigrations(step, { until: TAXONOMY_SCHEMA });
    assert.ok(applied.length >= 12, 'se reconstruyó el esquema anterior');
    await step.query("insert into auth.users (id, email) values ($1, 'previo@cauce.test')", [ids.vendorA]);
    await step.query("insert into auth.users (id, email) values ($1, 'previoadmin@cauce.test')", [ids.admin]);
    await step.query('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);
    await step.transaction(async tx => {
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [ids.vendorA]);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.vendorA, role: 'authenticated' })]);
      await tx.query('insert into public.profiles (user_id, display_name) values ($1, $2)', [ids.vendorA, 'Previa']);
      await tx.query("select public.create_business('Comercio Previo', 'comercio-previo')");
      await tx.query("update public.businesses set category_id = (select id from public.business_categories where slug = 'ferreteria'),"
        + " address = 'Ruta 23 km 40', hours_label = 'Todos los días', whatsapp = '2942 555000' where slug = 'comercio-previo'");
      await tx.query("insert into public.business_contacts (business_id, owner_name, phone)"
        + " values ((select id from public.businesses where slug = 'comercio-previo'), 'Titular Previa', '2942000111')");
      await tx.query("insert into public.products (business_id, name, price_ars, stock)"
        + " values ((select id from public.businesses where slug = 'comercio-previo'), 'Clavo aluminio', 900, 25)");
      await tx.query("select public.submit_business_for_review((select id from public.businesses where slug = 'comercio-previo'))");
    });
    assert.equal(rows(await step.query("select status from public.businesses where slug = 'comercio-previo'"))[0].status, 'pending_review');
    const taxonomyFile = (await migrationFiles()).find(name => versionOf(name) === TAXONOMY_SCHEMA);
    await applyMigration(step, taxonomyFile);
    // El alta en revisión conserva su estado y gana las capacidades de su rubro.
    const migrated = rows(await step.query(`select b.status, c.slug as category, b.capabilities
      from public.businesses b join public.business_categories c on c.id = b.category_id
      where b.slug = 'comercio-previo'`))[0];
    assert.equal(migrated.status, 'pending_review');
    assert.equal(migrated.category, 'ferreteria');
    assert.deepEqual([...migrated.capabilities], ['products', 'services']);

    // La migración de condición es aditiva: el producto previo queda 'new',
    // conserva su stock y el estado del comercio no cambia.
    const conditionFile = (await migrationFiles()).find(name => versionOf(name) === REQUIRED_SCHEMA);
    await applyMigration(step, conditionFile);
    const product = rows(await step.query(`select p.name, p.condition, p.stock, p.price_ars, b.status
      from public.products p join public.businesses b on b.id = p.business_id
      where b.slug = 'comercio-previo'`))[0];
    assert.equal(product.name, 'Clavo aluminio');
    assert.equal(product.condition, 'new');
    assert.equal(product.stock, 25);
    assert.equal(Number(product.price_ars), 900);
    assert.equal(product.status, 'pending_review');
    // La base rechaza una condición fuera del contrato.
    await assert.rejects(step.query("update public.products set condition = 'roto' where name = 'Clavo aluminio'"));
    // El contrato nuevo es exigible después de migrada la base.
    assert.equal(Number(rows(await step.query("select (private.app_status() ->> 'schema') as s"))[0].s), REQUIRED_SCHEMA);
  } finally {
    await step.close();
  }
});
