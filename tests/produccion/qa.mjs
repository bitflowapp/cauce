// Datos de QA para el smoke del sitio publicado: dos comercios "CAUCE QA"
// con titular, encargado, equipo, rubro, productos, horarios, retiro y envío;
// una cuenta de cliente y una administración temporal. Todo con cuentas
// cauce-qa-<corrida>-<rol>@example.com (el mismo patrón que limpia
// scripts/clean-qa-residue.mjs) y todo se borra al final.
//
// Contra el proyecto real hace falta SUPABASE_ACCESS_TOKEN (la clave de
// servidor se pide a la API de administración y queda en memoria). Con
// CAUCE_SMOKE_LOCAL=1 usa el stack local.
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { hide, target } from '../../scripts/lib/proyecto.mjs';

export const LOCAL = process.env.CAUCE_SMOKE_LOCAL === '1';
export const t = await target({ local: LOCAL });
export const run = randomBytes(4).toString('hex');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
export const service = createClient(t.url, await t.serviceKey(), options);

const created = { users: [], businesses: [] };
// Las tablas se leen y limpian con SQL del dueño de la base (la misma vía que
// usa scripts/operacion.mjs): la clave de servidor queda sólo para Auth y no
// hace falta concederle privilegios sobre las tablas.
const uuid = value => { if (!/^[0-9a-f-]{36}$/.test(String(value))) throw new Error('id inválido'); return `'${value}'`; };
export async function orderRow(id) {
  const [row] = await t.sql(`select total_ars::int as total, delivery_fee_ars::int as fee, status, customer_id::text as customer
    from public.orders where id = ${uuid(id)}`);
  return row && { ...row, total: Number(row.total), fee: Number(row.fee) };
}
export const ok = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.code || ''} ${result.error.message}`);
  return result.data;
};

export async function qaAccount(role, { admin = false } = {}) {
  const email = `cauce-qa-${run}-${role}@example.com`;
  const password = `Qa${randomBytes(12).toString('base64url')}9`;
  hide(password);
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true,
    user_metadata: { display_name: `CAUCE QA ${role}` } });
  if (error) throw new Error(`cuenta ${role}: ${error.message}`);
  created.users.push(data.user.id);
  const client = createClient(t.url, t.publishableKey, options);
  ok(await client.auth.signInWithPassword({ email, password }), `ingreso ${role}`);
  // Como la app: crear el perfil si falta, sin pisar nada (no requiere UPDATE).
  ok(await client.from('profiles').upsert({ user_id: data.user.id, display_name: `CAUCE QA ${role}`, phone: '2942 400000' },
    { onConflict: 'user_id', ignoreDuplicates: true }), `perfil ${role}`);
  if (admin) await t.sql(`insert into private.platform_admins (user_id) values ('${data.user.id}') on conflict do nothing`);
  return { id: data.user.id, email, password, client, role };
}

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].flatMap(weekday => [
  { weekday, opens: '00:00', closes: '12:00' }, { weekday, opens: '12:00', closes: '00:00' }]);

export async function qaBusiness(owner, reviewer, { label, manager, staff }) {
  const c = owner.client;
  const name = `CAUCE QA · ${label} ${run}`;
  const id = ok(await c.rpc('create_business', { business_name: name, business_slug: `cauce-qa-${label.toLowerCase()}-${run}` }), 'alta');
  created.businesses.push(id);
  const category = ok(await c.from('business_categories').select('id').eq('slug', 'almacen').single(), 'rubro').id;
  ok(await c.from('businesses').update({
    category_id: category, description: 'Comercio de prueba interna de CAUCE. No atiende pedidos reales.',
    address: 'Prueba interna 1', hours_label: 'Prueba interna', public_phone: '2942 555000', whatsapp: '2942 555001',
    pickup_enabled: true, delivery_enabled: true, delivery_zone: 'Casco urbano (prueba)', delivery_fee_ars: 900,
    minimum_order_ars: 1000, prep_minutes: 20, delivery_minutes: 30,
  }).eq('id', id), 'datos');
  ok(await c.from('business_contacts').insert({ business_id: id, owner_name: 'CAUCE QA', phone: '2942 555002' }), 'contacto');
  ok(await c.rpc('set_business_hours', { business: id, hours: ALL_DAY }), 'horarios');
  const shelf = ok(await c.from('product_categories').insert({ business_id: id, name: 'Prueba' }).select().single(), 'categoría');
  const products = {
    untracked: ok(await c.from('products').insert({ business_id: id, category_id: shelf.id, name: 'Yerba QA',
      price_ars: 1500 }).select().single(), 'producto'),
    tracked: ok(await c.from('products').insert({ business_id: id, category_id: shelf.id, name: 'Torta QA',
      price_ars: 5000, track_stock: true, stock: 5 }).select().single(), 'producto con stock'),
  };
  const rider = ok(await c.from('business_riders').insert({ business_id: id, name: `Reparto QA ${run}` }).select().single(), 'reparto');
  if (manager) ok(await c.rpc('add_business_member', { business: id, member_email: manager.email, member_role: 'manager' }), 'encargado');
  if (staff) ok(await c.rpc('add_business_member', { business: id, member_email: staff.email, member_role: 'staff' }), 'equipo');
  ok(await c.rpc('submit_business_for_review', { business: id }), 'solicitud');
  ok(await reviewer.client.rpc('review_business', { business: id, decision: 'active', note: 'Smoke QA' }), 'aprobación');
  ok(await c.rpc('set_business_presence', { business: id, is_open: true }), 'apertura');
  return { id, name, products, rider };
}

// Suspende primero (desaparece del sitio en el acto) y después borra todo lo
// de esta corrida: pedidos, comercios y cuentas, incluidas las sesiones
// anónimas que compraron en los comercios QA.
export async function cleanup(reviewer) {
  const report = [];
  for (const id of created.businesses) {
    if (reviewer) await reviewer.client.rpc('admin_set_business_status', { business: id, next_status: 'suspended', note: 'Fin del smoke QA' });
  }
  if (created.businesses.length) {
    const list = created.businesses.map(uuid).join(', ');
    const orders = await t.sql(`select customer_id::text as customer_id from public.orders where business_id in (${list})`);
    const guests = [...new Set(orders.map(order => order.customer_id))].filter(id => !created.users.includes(id));
    for (const guest of guests) {
      const user = (await service.auth.admin.getUserById(guest)).data?.user;
      if (user?.is_anonymous) created.users.push(guest);
    }
    await t.sql(`delete from public.orders where business_id in (${list})`);
    await t.sql(`delete from public.businesses where id in (${list})`);
    report.push(`${orders.length} pedidos y ${created.businesses.length} comercios QA borrados`);
  }
  for (const id of created.users) await service.auth.admin.deleteUser(id);
  report.push(`${created.users.length} cuentas QA borradas`);
  const left = await t.sql(`select id from public.businesses where slug like 'cauce-qa-%-${run}'`);
  if (left.length) throw new Error(`quedaron ${left.length} comercios QA sin borrar`);
  return report.join(' · ');
}
