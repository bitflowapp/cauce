// Seguridad del esquema en PostgreSQL embebido: RLS en todas las tablas,
// aislamiento entre comercios, personal acotado, administración no
// autoconcedible y datos privados fuera del alcance público.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorld, denied, failsWith } from './world.mjs';

let w, A, B;
before(async () => {
  w = await createWorld();
  A = await w.publishedBusiness('merchantA', { name: 'Raíces de Barro' });
  B = await w.publishedBusiness('merchantB', { name: 'Tierra Viva' });
  await w.root("insert into public.business_memberships (business_id, user_id, role) values ($1, $2, 'manager'), ($1, $3, 'staff')",
    [A.id, w.ids.managerA, w.ids.staffA]);
});
after(async () => { await w.close(); });

test('toda tabla de public y private tiene RLS activado', async () => {
  const { rows } = await w.root(`select n.nspname || '.' || c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(rows, []);
});

test('ninguna función SECURITY DEFINER queda en public (sólo envoltorios invoker)', async () => {
  const { rows } = await w.root(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef`);
  assert.deepEqual(rows, []);
});

test('toda función SECURITY DEFINER fija search_path vacío', async () => {
  const { rows } = await w.root(`select n.nspname || '.' || p.proname as name from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not coalesce(p.proconfig @> array['search_path=""'], false)`);
  assert.deepEqual(rows, []);
});

test('una visita sin sesión ve el catálogo publicado y nada privado', async () => {
  assert.ok((await w.as('anon', 'select slug from public.localities')).rows.some(r => r.slug === 'neuquen'));
  assert.equal((await w.as('anon', 'select count(*)::int as n from public.categories')).rows[0].n, 8);
  assert.equal((await w.as('anon', "select code from public.plans where code = 'entrada'")).rows.length, 1);
  const shops = (await w.as('anon', 'select id from public.businesses')).rows.map(r => r.id).sort();
  assert.deepEqual(shops, [A.id, B.id].sort());
  await denied(assert, w.as('anon', 'select * from public.profiles'));
  await denied(assert, w.as('anon', 'select * from public.orders'));
  await denied(assert, w.as('anon', 'select * from public.business_contacts'));
  await denied(assert, w.as('anon', 'select * from public.subscriptions'));
  await denied(assert, w.as('anon', "select public.create_business('Intrusa', 'neuquen', null)"));
  await denied(assert, w.as('anon', 'select * from private.audit_log'));
});

test('un borrador no se ve en público ni para otro comercio', async () => {
  const draft = (await w.one('merchantB', "select public.create_business('Borrador B', 'plottier', null) as r")).r;
  assert.equal((await w.as('anon', 'select id from public.businesses where id = $1', [draft.id])).rows.length, 0);
  assert.equal((await w.as('merchantA', 'select id from public.businesses where id = $1', [draft.id])).rows.length, 0);
  assert.equal((await w.as('merchantB', 'select id from public.businesses where id = $1', [draft.id])).rows.length, 1);
  assert.equal((await w.as('admin', 'select id from public.businesses where id = $1', [draft.id])).rows.length, 1);
});

test('el slug lo resuelve el servidor y no se repite', async () => {
  const first = (await w.one('customerA', "select public.create_business('Lana & Telar', 'neuquen', 'textiles') as r")).r;
  const second = (await w.one('customerB', "select public.create_business('Lana y Telar', 'neuquen', 'textiles') as r")).r;
  assert.equal(first.slug, 'lana-telar');
  assert.equal(second.slug, 'lana-y-telar');
  const third = (await w.one('stranger', "select public.create_business('Lana & Telar', 'neuquen', 'textiles') as r")).r;
  assert.equal(third.slug, 'lana-telar-2');
});

test('comercio A no lee ni modifica nada privado de B', async () => {
  assert.equal((await w.as('merchantA', "update public.businesses set name = 'Intrusa' where id = $1 returning id", [B.id])).rows.length, 0);
  assert.equal((await w.as('merchantA', 'select * from public.business_contacts where business_id = $1', [B.id])).rows.length, 0);
  assert.equal((await w.as('merchantA', 'select * from public.subscriptions where business_id = $1', [B.id])).rows.length, 0);
  assert.equal((await w.as('merchantA', "update public.products set price_ars = 1 where business_id = $1 returning id", [B.id])).rows.length, 0);
  await denied(assert, w.as('merchantA', "insert into public.products (business_id, name, price_ars) values ($1, 'Intruso', 100)", [B.id]));
  await denied(assert, w.as('merchantA', 'select public.business_team($1)', [B.id]));
  await denied(assert, w.as('merchantA', 'select public.my_entitlements($1)', [B.id]));
  await denied(assert, w.as('merchantA', 'select public.business_stats($1, 30)', [B.id]));
  await denied(assert, w.as('merchantA', "select public.set_stock($1, null, 0, false)", [B.product]));
});

test('nadie se autopublica ni cambia el estado, el slug o la suscripción por la tabla', async () => {
  await denied(assert, w.as('merchantA', "update public.businesses set status = 'active' where id = $1", [A.id]));
  await denied(assert, w.as('merchantA', "update public.businesses set slug = 'otra' where id = $1", [A.id]));
  await denied(assert, w.as('merchantA', "insert into public.subscriptions (business_id, plan_code, status, period_end) values ($1, 'pro', 'active', current_date + 300)", [A.id]));
  await denied(assert, w.as('merchantA', "update public.subscriptions set plan_code = 'pro' where business_id = $1", [A.id]));
  await denied(assert, w.as('merchantA', "select public.review_business($1, 'active', '', 'pro', 30)", [A.id]));
  await denied(assert, w.as('merchantA', "select public.admin_set_subscription($1, null, 'pro', 'active', current_date + 300, 10, '')", [A.id]));
});

test('user_metadata no concede administración; sólo la tabla privada', async () => {
  await w.root(`update auth.users set raw_user_meta_data = '{"role":"admin"}' where id = $1`, [w.ids.stranger]);
  assert.equal((await w.one('stranger', 'select public.my_access() as ok')).ok, false);
  assert.equal((await w.one('admin', 'select public.my_access() as ok')).ok, true);
  await denied(assert, w.as('stranger', 'select public.admin_overview()'));
  await denied(assert, w.as('stranger', 'select public.admin_audit_log(10)'));
  await denied(assert, w.as('merchantA', 'insert into private.platform_admins (user_id) values ($1)', [w.ids.merchantA]));
});

test('el personal opera stock pero no edita el catálogo ni el comercio', async () => {
  await w.as('staffA', 'select public.set_stock($1, null, 7, true)', [A.product]);
  assert.equal((await w.one('merchantA', 'select stock from public.products where id = $1', [A.product])).stock, 7);
  assert.equal((await w.as('staffA', "update public.products set price_ars = 1 where id = $1 returning id", [A.product])).rows.length, 0);
  assert.equal((await w.as('staffA', "update public.businesses set name = 'Otro' where id = $1 returning id", [A.id])).rows.length, 0);
  await denied(assert, w.as('staffA', "insert into public.products (business_id, name, price_ars) values ($1, 'Nuevo', 100)", [A.id]));
  // El encargado sí edita catálogo.
  assert.equal((await w.as('managerA', "update public.products set description = 'Esmaltada' where id = $1 returning id", [A.product])).rows.length, 1);
});

test('el equipo respeta los lugares del plan y sólo lo maneja la persona titular', async () => {
  // Plan Feriante: 1 lugar de ayuda, ya ocupado por manager + staff (sembrados por la base).
  await failsWith(assert, w.as('merchantA', "select public.add_business_member($1, 'stranger@ferias.test', 'staff')", [A.id]),
    'Plan limit: team', 'U0010');
  await denied(assert, w.as('managerA', "select public.add_business_member($1, 'stranger@ferias.test', 'staff')", [A.id]));
  const solo = await w.publishedBusiness('customerB', { name: 'Solo Feriante', plan: 'feriante' });
  assert.equal((await w.one('customerB', "select public.add_business_member($1, 'stranger@ferias.test', 'staff') as r", [solo.id])).r, 'staff');
  await failsWith(assert, w.as('customerB', "select public.add_business_member($1, 'customera@ferias.test', 'staff')", [solo.id]),
    'Plan limit: team', 'U0010');
  // Quitar a alguien del equipo le corta el acceso en el acto.
  await w.as('customerB', 'select public.remove_business_member($1, $2)', [solo.id, w.ids.stranger]);
  await denied(assert, w.as('stranger', 'select public.set_stock($1, null, 1, true)', [solo.product]));
});

test('perfiles: cada persona ve y edita sólo el suyo; la sesión anónima no crea perfil', async () => {
  assert.deepEqual((await w.as('customerA', 'select user_id from public.profiles')).rows, [{ user_id: w.ids.customerA }]);
  assert.equal((await w.as('customerA', "update public.profiles set display_name = 'Intrusa' where user_id = $1 returning user_id", [w.ids.customerB])).rows.length, 0);
  await denied(assert, w.as('guest1', "insert into public.profiles (user_id, display_name) values ($1, 'Anónima')", [w.ids.guest1]));
});

test('medios: rutas de otro comercio, formas inválidas y escritura anónima se rechazan', async () => {
  const ok = `businesses/${A.id}/products/${randomUUID()}.webp`;
  await w.as('merchantA', "insert into storage.objects (bucket_id, name) values ('ferias-media', $1)", [ok]);
  await denied(assert, w.as('merchantB', "insert into storage.objects (bucket_id, name) values ('ferias-media', $1)",
    [`businesses/${A.id}/products/${randomUUID()}.webp`]));
  await denied(assert, w.as('merchantA', "insert into storage.objects (bucket_id, name) values ('ferias-media', $1)",
    [`businesses/${A.id}/products/../../${B.id}/x.webp`]));
  await denied(assert, w.as('merchantA', "insert into storage.objects (bucket_id, name) values ('ferias-media', $1)",
    [`businesses/${A.id}/products/${randomUUID()}.svg`]));
  await denied(assert, w.as('staffA', "insert into storage.objects (bucket_id, name) values ('ferias-media', $1)",
    [`businesses/${A.id}/logo/${randomUUID()}.png`]));
  await denied(assert, w.as('guest1', "insert into storage.objects (bucket_id, name) values ('ferias-media', $1)",
    [`businesses/${A.id}/logo/${randomUUID()}.png`]));
  await denied(assert, w.as('merchantA', "update public.product_images set path = $2 where product_id = $1",
    [A.product, `businesses/${B.id}/products/${randomUUID()}.webp`]));
});

test('el registro de errores borra correos y teléfonos y no es legible por el cliente', async () => {
  await w.as('anon', "select public.report_client_event('frontend_error', 'X', 'falló para ana@correo.com tel 299 155 1234', '#/carrito', 'r1', '{}'::jsonb)");
  const { rows } = await w.root('select message from private.client_events order by id desc limit 1');
  assert.equal(rows[0].message, 'falló para [correo] tel [número]');
  await denied(assert, w.as('merchantA', 'select * from private.client_events'));
});
