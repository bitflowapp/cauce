// Un mundo sintético sobre PostgreSQL embebido (PGlite) con las migraciones
// reales de CAUCE · Ferias. Cada identidad actúa con el rol y los claims que
// PostgREST le daría a su JWT, así que todo pasa por RLS y por los grants.
// No prueba GoTrue, PostgREST, Storage ni Realtime: eso es tests/integration.
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './fixture.mjs';

export const NAMES = ['admin', 'merchantA', 'managerA', 'staffA', 'merchantB', 'customerA', 'customerB',
  'organizerA', 'editorA', 'organizerB', 'stranger', 'guest1', 'guest2'];

export async function createWorld() {
  const db = new PGlite();
  await applyMigrations(db);
  const ids = Object.fromEntries(NAMES.map((name, i) => [name, `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
  const anonymous = name => name.startsWith('guest');

  async function as(name, sql, params = []) {
    return db.transaction(async tx => {
      await tx.exec(`set local role ${name === 'anon' ? 'anon' : 'authenticated'}`);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [ids[name] || '']);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [ids[name]
        ? JSON.stringify({ sub: ids[name], role: 'authenticated', is_anonymous: anonymous(name) }) : '']);
      return tx.query(sql, params);
    });
  }
  const one = async (name, sql, params) => (await as(name, sql, params)).rows[0];
  const root = (sql, params = []) => db.query(sql, params);

  for (const name of NAMES) {
    await root('insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)',
      [ids[name], anonymous(name) ? null : `${name.toLowerCase()}@ferias.test`, anonymous(name)]);
    if (!anonymous(name)) {
      await as(name, 'insert into public.profiles (user_id, display_name, phone) values ($1, $2, $3)',
        [ids[name], `Persona ${name}`, '299 4000000']);
    }
  }
  await root('insert into private.platform_admins (user_id) values ($1)', [ids.admin]);

  // Comercio publicado por el recorrido normal: alta, datos, producto con foto,
  // pedido de publicación y aprobación de administración con un plan.
  async function publishedBusiness(owner, { name = `Tienda ${owner}`, plan = 'feriante', delivery = true,
    deliveryFee = 2500, stock = 5 } = {}) {
    const created = (await one(owner, "select public.create_business($1, 'neuquen', 'ceramica') as r", [name])).r;
    const id = created.id;
    await as(owner, `update public.businesses set tagline = 'Hecho a mano', whatsapp = '5492994000000',
      delivery_enabled = $2, delivery_zone = $3, delivery_fee_ars = $4, pickup_area = 'Centro' where id = $1`,
    [id, delivery, delivery ? 'Neuquén capital' : '', deliveryFee]);
    const product = await one(owner, `insert into public.products (business_id, name, price_ars, stock, track_stock)
      values ($1, 'Taza patagónica', 12500, $2, true) returning id`, [id, stock]);
    await as(owner, 'insert into public.product_images (product_id, business_id, path) values ($1, $2, $3)',
      [product.id, id, `businesses/${id}/products/${randomUUID()}.webp`]);
    const variants = await one(owner, `insert into public.products (business_id, name, price_ars, track_stock)
      values ($1, 'Aros de flor', 9500, true) returning id`, [id]);
    const chica = await one(owner, `insert into public.product_variants (product_id, business_id, name, price_delta_ars, stock)
      values ($1, $2, 'Chicos', 0, 2) returning id`, [variants.id, id]);
    const grande = await one(owner, `insert into public.product_variants (product_id, business_id, name, price_delta_ars, stock)
      values ($1, $2, 'Grandes', 1500, 1) returning id`, [variants.id, id]);
    const madeToOrder = await one(owner, `insert into public.products (business_id, name, price_ars, track_stock,
      made_to_order, production_days_min, production_days_max) values ($1, 'Mate tallado', 18000, false, true, 3, 5)
      returning id`, [id]);
    await as(owner, 'select public.submit_business_for_review($1)', [id]);
    await as('admin', "select public.review_business($1, 'active', 'Aprobado', $2, 30)", [id, plan]);
    return { id, slug: created.slug, product: product.id, variantProduct: variants.id, chica: chica.id,
      grande: grande.id, madeToOrder: madeToOrder.id };
  }

  const contact = (extra = {}) => ({ name: 'Vecina de Prueba', phone: '299 4112233', ...extra });

  async function order(name, business, items, { fulfillment = 'pickup', idem = randomUUID(), fair = null,
    expectedTotal = null, payment = 'cash', contactData = contact() } = {}) {
    const payload = fulfillment === 'delivery' ? { address: 'Avenida Argentina 1200', ...contactData } : contactData;
    return one(name, `select public.create_order($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) as id`,
      [business, idem, fulfillment, payment, fair, JSON.stringify(payload), JSON.stringify(items), expectedTotal]);
  }

  async function organizer(ownerName, label = 'Organización') {
    const id = (await one('admin', 'select public.admin_create_organizer($1, $2) as id',
      [`${label} ${ownerName}`, `${ownerName.toLowerCase()}@ferias.test`])).id;
    return id;
  }

  async function publishedFair(ownerName, organizerId, { capacity = 50, days = 7 } = {}) {
    const starts = new Date(Date.now() + days * 86400000);
    const ends = new Date(starts.getTime() + 8 * 3600000);
    const fair = (await one(ownerName, 'select public.create_fair($1, $2::jsonb) as r', [organizerId, JSON.stringify({
      name: 'Feria del Parque Central', venue: 'Parque Central', address: 'Av. Argentina y Roca',
      locality: 'neuquen', starts_at: starts.toISOString(), ends_at: ends.toISOString(), stall_capacity: capacity,
      latitude: -38.9516, longitude: -68.0591 })])).r;
    await one('admin', `select public.admin_set_subscription(null, $1, 'organizador', 'active', (current_date + 30), 10, '')`,
      [organizerId]);
    await as(ownerName, "select public.set_fair_status($1, 'published', '')", [fair.id]);
    return fair;
  }

  return { db, ids, as, one, root, publishedBusiness, order, contact, organizer, publishedFair,
    close: () => db.close() };
}

export const denied = (assert, promise, code = '42501') => assert.rejects(promise, error => {
  if (error.code !== code) throw new Error(`Se esperaba ${code} y llegó ${error.code}: ${error.message}`);
  return true;
});
export const failsWith = (assert, promise, message, code) => assert.rejects(promise, error => {
  if (code && error.code !== code) throw new Error(`Se esperaba ${code} y llegó ${error.code}: ${error.message}`);
  if (message && !String(error.message).includes(message)) {
    throw new Error(`Se esperaba "${message}" y llegó: ${error.message}`);
  }
  return true;
});
