// Harness de integración contra un stack Supabase LOCAL (`npx supabase start`):
// Postgres, GoTrue, PostgREST, Storage, Realtime y Mailpit de verdad, con las
// migraciones del repositorio. Nada de mocks: cada identidad obtiene su JWT de
// GoTrue y todas las lecturas y escrituras pasan por RLS.
//
// Por diseño estas pruebas se niegan a correr contra cualquier host que no sea
// local: crean cuentas, comercios y pedidos sintéticos.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

function localStatus() {
  try {
    const raw = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', 'status', '-o', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw.slice(raw.indexOf('{')));
  } catch {
    throw new Error('No hay stack Supabase local. Ejecutá `npx supabase start` antes de estas pruebas.');
  }
}

const status = process.env.CAUCE_TEST_SUPABASE_URL ? null : localStatus();
export const env = Object.freeze({
  url: process.env.CAUCE_TEST_SUPABASE_URL || status.API_URL,
  publishableKey: process.env.CAUCE_TEST_PUBLISHABLE_KEY || status.PUBLISHABLE_KEY,
  secretKey: process.env.CAUCE_TEST_SECRET_KEY || status.SECRET_KEY,
  dbUrl: process.env.CAUCE_TEST_DB_URL || status.DB_URL,
  mailpitUrl: process.env.CAUCE_TEST_MAILPIT_URL || status.MAILPIT_URL,
  jwtSecret: process.env.CAUCE_TEST_JWT_SECRET || status.JWT_SECRET,
});
for (const value of [env.url, env.dbUrl, env.mailpitUrl]) {
  const host = new URL(value).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Las pruebas de integración sólo corren contra un stack local, no contra ${host}.`);
  }
}

export const sql = postgres(env.dbUrl, { max: 4, onnotice: () => {} });
export const admin = createClient(env.url, env.secretKey,
  { auth: { persistSession: false, autoRefreshToken: false } });
export const run = randomUUID().slice(0, 8);

export function anonClient() {
  return createClient(env.url, env.publishableKey,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export function ok(result, label = 'operación') {
  if (result.error) {
    const error = new Error(`${label}: ${result.error.code || result.error.status || ''} ${result.error.message}`);
    error.cause = result.error;
    throw error;
  }
  return result.data;
}

// Cuenta permanente confirmada, creada con la API administrativa del stack
// local (equivale a una persona que ya confirmó su correo).
export async function account(name, { phone = '2942 400000' } = {}) {
  const email = `qa-${run}-${name.toLowerCase()}@cauce.test`;
  const password = `Qa${randomUUID().slice(0, 12)}9x`;
  const created = ok(await admin.auth.admin.createUser({ email, password, email_confirm: true,
    user_metadata: { display_name: `Prueba ${name}`, phone } }), `crear ${name}`);
  const client = anonClient();
  ok(await client.auth.signInWithPassword({ email, password }), `ingresar ${name}`);
  ok(await client.from('profiles').insert({ user_id: created.user.id, display_name: `Prueba ${name}`, phone }),
    `perfil ${name}`);
  return { name, id: created.user.id, email, password, client };
}

// Sesión anónima real de GoTrue: la de una persona que compra sin cuenta.
export async function guest(name) {
  const client = anonClient();
  const data = ok(await client.auth.signInAnonymously(), `sesión anónima ${name}`);
  return { name, id: data.user.id, client };
}

export async function makeAdmin(user) {
  await sql`insert into private.platform_admins (user_id) values (${user.id}) on conflict do nothing`;
}

const WEEK = [0, 1, 2, 3, 4, 5, 6];

// Comercio completo y publicado: el recorrido real de alta, revisión y apertura.
export async function publishedBusiness(owner, reviewer, { name = 'Comercio', delivery = true } = {}) {
  const client = owner.client;
  const id = ok(await client.rpc('create_business',
    { business_name: `${name} ${run}`, business_slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${run}` }), 'alta');
  const category = ok(await client.from('business_categories').select('id').eq('slug', 'gastronomia').single()).id;
  ok(await client.from('businesses').update({ category_id: category, address: 'Conrado Villegas 100',
    hours_label: 'Todos los días', public_phone: '2942 555000', delivery_enabled: delivery, pickup_enabled: true,
    delivery_zone: delivery ? 'Casco urbano' : '', delivery_fee_ars: delivery ? 1500 : 0,
    minimum_order_ars: delivery ? 3000 : 0 }).eq('id', id), 'datos');
  ok(await client.from('business_contacts').insert({ business_id: id, owner_name: `Titular ${name}`,
    phone: '2942 555001' }), 'contacto');
  const products = {};
  products.untracked = ok(await client.from('products').insert({ business_id: id, name: 'Empanada de carne',
    price_ars: 1200 }).select().single(), 'producto sin stock');
  products.tracked = ok(await client.from('products').insert({ business_id: id, name: 'Torta del día',
    price_ars: 9000, track_stock: true, stock: 2 }).select().single(), 'producto con stock');
  products.variants = ok(await client.from('products').insert({ business_id: id, name: 'Pizza',
    price_ars: 8000 }).select().single(), 'producto con variantes');
  const variants = ok(await client.from('product_variants').insert([
    { product_id: products.variants.id, business_id: id, name: 'Chica', price_delta_ars: -2000, position: 0 },
    { product_id: products.variants.id, business_id: id, name: 'Grande', price_delta_ars: 1500, position: 1 },
  ]).select(), 'variantes');
  ok(await client.rpc('submit_business_for_review', { business: id }), 'solicitar publicación');
  ok(await reviewer.client.rpc('review_business', { business: id, decision: 'active', note: 'Aprobado en prueba' }), 'aprobar');
  ok(await client.rpc('set_business_presence', { business: id, is_open: true }), 'abrir');
  return { id, products, variants: Object.fromEntries(variants.map(v => [v.name, v])) };
}

export const contact = (extra = {}) => ({ name: 'Vecina de Prueba', phone: '2942 401122', notes: '', ...extra });

export async function order(user, business, lines, { fulfillment = 'pickup', idem = randomUUID(),
  expectedTotal = null, contactData = contact() } = {}) {
  return user.client.rpc('create_order', {
    business, idem, fulfillment,
    payment_method: fulfillment === 'delivery' ? 'cash_on_delivery' : 'cash_on_pickup',
    contact: fulfillment === 'delivery' ? { address: 'Calle Los Pehuenes 45', ...contactData } : contactData,
    items: lines, expected_total: expectedTotal,
  });
}

export async function transition(user, orderId, nextStatus, { version = null, rider = null, reason = '' } = {}) {
  return user.client.rpc('transition_order', { order_id: orderId, expected_version: version,
    next_status: nextStatus, rider, reason });
}

export const failsWith = (result, code) => {
  if (!result.error) throw new Error(`Se esperaba el error ${code} y la operación funcionó.`);
  const actual = String(result.error.code || result.error.statusCode || result.error.status || '');
  if (actual !== String(code)) {
    throw new Error(`Se esperaba ${code} y llegó ${actual}: ${result.error.message}`);
  }
  return result.error;
};

// Lectura denegada: por grant (42501/401) o por RLS (cero filas).
export async function invisible(query) {
  const result = await query;
  if (result.error) return result.error.code === '42501' || result.status === 401 || result.status === 403;
  return Array.isArray(result.data) ? result.data.length === 0 : result.data == null;
}

export async function mailFor(email, { subject, after = 0, timeout = 15000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const response = await fetch(`${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const body = await response.json();
    const found = (body.messages || [])
      .filter(message => !subject || message.Subject === subject)
      .filter(message => new Date(message.Created).getTime() >= after)
      .sort((a, b) => new Date(b.Created) - new Date(a.Created))[0];
    if (found) {
      const detail = await (await fetch(`${env.mailpitUrl}/api/v1/message/${found.ID}`)).json();
      return detail;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`No llegó ningún correo a ${email}${subject ? ` con asunto "${subject}"` : ''}.`);
}

export function linkFrom(message) {
  const match = /href="([^"]*token_hash=[^"]+)"/.exec(message.HTML || '');
  if (!match) throw new Error('El correo no trae un enlace con token_hash.');
  return new URL(match[1].replace(/&amp;/g, '&'));
}

export async function closeAll(users) {
  // Cada cliente con canales abiertos mantiene un WebSocket: se cierra y se
  // espera el cierre para que el proceso de pruebas termine limpio.
  const clients = [...new Set(users.map(user => user.client).filter(Boolean))];
  await Promise.all(clients.map(async client => {
    try { await client.removeAllChannels(); } catch { /* sin canales */ }
    try { await client.realtime.disconnect(); } catch { /* sin conexión abierta */ }
  }));
  await sql.end({ timeout: 5 });
}

export const days = WEEK;
