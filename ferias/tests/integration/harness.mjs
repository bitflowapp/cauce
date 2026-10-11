// Harness de integración contra el stack Supabase LOCAL de CAUCE · Ferias
// (`npm run db:start`): Postgres, GoTrue, PostgREST, Storage, Realtime y
// Mailpit reales con las migraciones del repositorio. Sin mocks: cada
// identidad obtiene su JWT de GoTrue y todo pasa por RLS. Adaptado del harness
// de CAUCE · Aluminé. Se niega a correr contra un host que no sea local.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

const root = fileURLToPath(new URL('../../', import.meta.url));
function localStatus() {
  try {
    const raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw.slice(raw.indexOf('{')));
  } catch {
    throw new Error('No hay stack Supabase local de Ferias. Ejecutá `npm run db:start` antes de estas pruebas.');
  }
}
const status = localStatus();
export const env = Object.freeze({ url: status.API_URL, publishableKey: status.PUBLISHABLE_KEY, secretKey: status.SECRET_KEY,
  dbUrl: status.DB_URL, mailpitUrl: status.MAILPIT_URL || status.INBUCKET_URL });
for (const value of [env.url, env.dbUrl, env.mailpitUrl]) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(value).hostname)) throw new Error(`Las pruebas de integración sólo corren en local, no contra ${value}.`);
}

export const sql = postgres(env.dbUrl, { max: 4, onnotice: () => {} });
export const admin = createClient(env.url, env.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
export const run = randomUUID().slice(0, 8);
export const anonClient = () => createClient(env.url, env.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

export function ok(result, label = 'operación') {
  if (result.error) {
    const error = new Error(`${label}: ${result.error.code || result.error.statusCode || ''} ${result.error.message}`);
    error.cause = result.error;
    throw error;
  }
  return result.data;
}
export const failsWith = (result, code) => {
  if (!result.error) throw new Error(`Se esperaba el error ${code} y la operación funcionó.`);
  const actual = String(result.error.code || result.error.statusCode || result.error.status || '');
  if (actual !== String(code)) throw new Error(`Se esperaba ${code} y llegó ${actual}: ${result.error.message}`);
  return result.error;
};

// Cuenta confirmada creada por la API administrativa del stack local.
export async function account(name, { phone = '299 4000000' } = {}) {
  const email = `qa-${run}-${name.toLowerCase()}@ferias.test`;
  const password = `Qa${randomUUID().slice(0, 12)}9x`;
  const created = ok(await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: `Prueba ${name}`, phone } }), `crear ${name}`);
  const client = anonClient();
  ok(await client.auth.signInWithPassword({ email, password }), `ingresar ${name}`);
  ok(await client.from('profiles').insert({ user_id: created.user.id, display_name: `Prueba ${name}`, phone }), `perfil ${name}`);
  return { name, id: created.user.id, email, password, client };
}
export async function guest(name) {
  const client = anonClient();
  const data = ok(await client.auth.signInAnonymously(), `sesión anónima ${name}`);
  return { name, id: data.user.id, client };
}
export async function makeAdmin(user) {
  await sql`insert into private.platform_admins (user_id) values (${user.id}) on conflict do nothing`;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const tinyPng = () => PNG;

// Tienda publicada por el recorrido normal: alta, foto, producto, revisión y aprobación.
export async function publishedBusiness(owner, reviewer, { name = 'Tienda', plan = 'feriante', stock = 3 } = {}) {
  const client = owner.client;
  const created = ok(await client.rpc('create_business', { business_name: `${name} ${run}`, locality_slug: 'neuquen', category_slug: 'ceramica' }), 'alta');
  const id = created.id;
  ok(await client.from('businesses').update({ tagline: 'Prueba', whatsapp: '5492994000000', delivery_enabled: true, delivery_zone: 'Neuquén', delivery_fee_ars: 2000 }).eq('id', id), 'datos');
  const product = ok(await client.from('products').insert({ business_id: id, name: 'Taza', price_ars: 12500, stock, track_stock: true }).select().single(), 'producto');
  const path = `businesses/${id}/products/${randomUUID()}.png`;
  ok(await client.storage.from('ferias-media').upload(path, PNG, { contentType: 'image/png' }), 'foto');
  ok(await client.from('product_images').insert({ product_id: product.id, business_id: id, path }), 'foto del producto');
  const made = ok(await client.from('products').insert({ business_id: id, name: 'Mate por encargo', price_ars: 18000, track_stock: false, made_to_order: true }).select().single(), 'encargo');
  ok(await client.rpc('submit_business_for_review', { business: id }), 'revisión');
  ok(await reviewer.client.rpc('review_business', { business: id, decision: 'active', note: 'Prueba', plan, trial_days: 30 }), 'aprobación');
  return { id, slug: created.slug, product, made };
}

export const contact = (extra = {}) => ({ name: 'Vecina de Prueba', phone: '299 4112233', ...extra });
export function order(user, business, items, { fulfillment = 'pickup', idem = randomUUID(), fair = null, expectedTotal = null, payment = 'cash' } = {}) {
  return user.client.rpc('create_order', { business, idem, fulfillment, payment_method: payment, fair,
    contact: fulfillment === 'delivery' ? contact({ address: 'Belgrano 450' }) : contact(), items, expected_total: expectedTotal });
}

// ── Mailpit ──
export async function latestMail(to, { subject = '', timeout = 15000 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const response = await fetch(`${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const data = await response.json();
    const found = (data.messages || []).find(m => !subject || m.Subject.includes(subject));
    if (found) return (await fetch(`${env.mailpitUrl}/api/v1/message/${found.ID}`)).json();
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`No llegó el correo a ${to} (${subject}).`);
}
export const tokenFromMail = message => {
  const match = String(message.HTML || message.Text || '').match(/token_hash=([a-zA-Z0-9_-]+)&(?:amp;)?type=([a-z_]+)/);
  if (!match) throw new Error('El correo no trae el enlace con token_hash.');
  return { tokenHash: match[1], type: match[2] };
};
