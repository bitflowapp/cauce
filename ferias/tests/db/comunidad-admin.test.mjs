// Comunidad fundadora y administración en PostgreSQL embebido: consentimiento
// obligatorio, techo por sesión, datos fuera del alcance público y revisión
// de altas con período de prueba.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, denied, failsWith } from './world.mjs';

let w;
before(async () => { w = await createWorld(); });
after(async () => { await w.close(); });

const application = (extra = {}) => JSON.stringify({ name: 'Marta Quintana', business_name: 'Telar del Limay',
  locality: 'plottier', category: 'textiles', contact: '299 4123456', sells_at_fairs: true, consent: true,
  consent_version: 'v1', ...extra });

test('preinscripción: exige consentimiento y una sesión; con sesión anónima alcanza', async () => {
  await denied(assert, w.as('anon', 'select public.apply_founding($1::jsonb)', [application()]));
  await failsWith(assert, w.as('guest1', 'select public.apply_founding($1::jsonb)', [application({ consent: false })]),
    'Consent required');
  await failsWith(assert, w.as('guest1', 'select public.apply_founding($1::jsonb)', [application({ contact: 'xx' })]),
    'Invalid contact');
  assert.equal((await w.one('guest1', 'select public.apply_founding($1::jsonb) as ok', [application()])).ok, true);
  assert.equal((await w.one('customerA', 'select public.apply_founding($1::jsonb) as ok',
    [application({ contact: 'marta@telar.test' })])).ok, true);
});

test('preinscripción: techo de 3 por sesión y por día', async () => {
  await w.as('guest2', 'select public.apply_founding($1::jsonb)', [application()]);
  await w.as('guest2', 'select public.apply_founding($1::jsonb)', [application()]);
  await w.as('guest2', 'select public.apply_founding($1::jsonb)', [application()]);
  await failsWith(assert, w.as('guest2', 'select public.apply_founding($1::jsonb)', [application()]),
    'Too many requests', 'U0006');
});

test('las solicitudes sólo las ve administración, que puede borrarlas a pedido', async () => {
  await denied(assert, w.as('customerA', 'select * from private.founding_applications'));
  await denied(assert, w.as('merchantA', 'select public.admin_founding_applications()'));
  const list = (await w.one('admin', 'select public.admin_founding_applications() as l')).l;
  assert.equal(list.length, 5);
  assert.equal(list[0].locality, 'Plottier');
  assert.equal(list[0].consent_version, 'v1');
  await w.as('admin', "select public.admin_update_founding($1, 'contacted')", [list[0].id]);
  await w.as('admin', "select public.admin_update_founding($1, 'deleted')", [list[1].id]);
  assert.equal((await w.one('admin', 'select public.admin_founding_applications() as l')).l.length, 4);
  const overview = (await w.one('admin', 'select public.admin_overview() as o')).o;
  assert.equal(overview.founding_new, 3);
});

test('la comunidad fundadora se puede pausar desde la base', async () => {
  await w.root("update private.platform_features set enabled = false where key = 'founding_community'");
  await denied(assert, w.as('customerB', 'select public.apply_founding($1::jsonb)', [application()]));
  await w.root("update private.platform_features set enabled = true where key = 'founding_community'");
});

test('alta: faltantes claros, envío a revisión, devolución con motivo y aprobación con prueba', async () => {
  const shop = (await w.one('merchantA', "select public.create_business('Velas del Valle', 'cipolletti', null) as r")).r;
  let missing = (await w.one('merchantA', 'select public.business_missing_requirements($1) as m', [shop.id])).m;
  assert.deepEqual(missing, ['Rubro', 'Al menos un producto con foto']);
  await failsWith(assert, w.as('merchantA', 'select public.submit_business_for_review($1)', [shop.id]), 'Faltan datos: Rubro');
  await w.as('merchantA', "update public.businesses set category_id = (select id from public.categories where slug = 'decoracion') where id = $1", [shop.id]);
  const product = (await w.one('merchantA', "insert into public.products (business_id, name, price_ars, stock) values ($1, 'Vela de soja', 8900, 4) returning id", [shop.id])).id;
  await w.as('merchantA', 'insert into public.product_images (product_id, business_id, path) values ($1, $2, $3)',
    [product, shop.id, `businesses/${shop.id}/products/11111111-1111-4111-8111-111111111111.webp`]);
  missing = (await w.one('merchantA', 'select public.business_missing_requirements($1) as m', [shop.id])).m;
  assert.deepEqual(missing, []);
  await w.as('merchantA', 'select public.submit_business_for_review($1)', [shop.id]);
  await failsWith(assert, w.as('admin', "select public.review_business($1, 'returned', '', 'entrada', 30)", [shop.id]), 'Reason required');
  await w.as('admin', "select public.review_business($1, 'returned', 'Sumá una foto de portada', 'entrada', 30)", [shop.id]);
  await w.as('merchantA', 'select public.submit_business_for_review($1)', [shop.id]);
  await w.as('admin', "select public.review_business($1, 'active', 'Bienvenida', 'pro', 45)", [shop.id]);
  const rights = (await w.one('merchantA', 'select public.my_entitlements($1) as e', [shop.id])).e;
  assert.equal(rights.state, 'trial');
  assert.equal(rights.plan, 'pro');
  assert.equal(rights.can_sell, true);
  const businesses = (await w.one('admin', 'select public.admin_businesses() as b')).b;
  const row = businesses.find(b => b.id === shop.id);
  assert.equal(row.owner_email, 'merchanta@ferias.test');
  assert.equal(row.subscription.status, 'trial');
});

test('pausar y reanudar la tienda es del comercio; publicar nunca', async () => {
  const shop = (await w.one('admin', 'select public.admin_businesses() as b')).b.find(b => b.name === 'Velas del Valle');
  await w.as('merchantA', "select public.set_business_presence($1, 'paused')", [shop.id]);
  assert.equal((await w.as('anon', 'select id from public.businesses where id = $1', [shop.id])).rows.length, 0);
  await w.as('merchantA', "select public.set_business_presence($1, 'active')", [shop.id]);
  assert.equal((await w.as('anon', 'select id from public.businesses where id = $1', [shop.id])).rows.length, 1);
  const draft = (await w.one('merchantA', "select public.create_business('Otro borrador', 'neuquen', null) as r")).r;
  await failsWith(assert, w.as('merchantA', "select public.set_business_presence($1, 'active')", [draft.id]), 'Transition not allowed');
});

test('una misma persona no abre más de 3 tiendas', async () => {
  await w.as('customerB', "select public.create_business('Uno', 'neuquen', null)");
  await w.as('customerB', "select public.create_business('Dos', 'neuquen', null)");
  await w.as('customerB', "select public.create_business('Tres', 'neuquen', null)");
  await failsWith(assert, w.as('customerB', "select public.create_business('Cuatro', 'neuquen', null)"), 'Business limit reached');
});

test('las altas de comercios se pueden cerrar desde la base', async () => {
  await w.root("update private.platform_features set enabled = false where key = 'merchant_signup'");
  await denied(assert, w.as('stranger', "select public.create_business('Cerrado', 'neuquen', null)"));
  await w.root("update private.platform_features set enabled = true where key = 'merchant_signup'");
  const status = (await w.one('anon', 'select public.app_status() as s')).s;
  assert.equal(status.schema, 20261011120500);
  assert.equal(status.features.merchant_signup, true);
});
