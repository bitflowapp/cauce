// Datos de DEMOSTRACIÓN para el stack Supabase LOCAL de CAUCE · Ferias.
//
//   npm run db:reset && npm run seed:demo
//
// Crea cuentas, tiendas, productos con ilustraciones, ferias, inscripciones y
// pedidos usando la API real (cada persona con su propia sesión: todo pasa por
// RLS y por las funciones del servidor). Marca la plataforma con
// `demo_data = true`, así la interfaz muestra la franja «Datos de
// demostración». Se niega a correr contra cualquier host que no sea local.
// Las contraseñas generadas quedan en .local/demo-credenciales.json (no se versiona).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { chromium } from 'playwright';
import { PRODUCT_ART, logoArt, coverArt, fairCoverArt } from './demo-art.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const status = (() => {
  const raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(raw.slice(raw.indexOf('{')));
})();
for (const value of [status.API_URL, status.DB_URL]) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(value).hostname)) throw new Error(`El sembrado de demostración sólo corre en local, no en ${value}.`);
}
const admin = createClient(status.API_URL, status.SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const sql = postgres(status.DB_URL, { max: 2, onnotice: () => {} });
const ok = (result, label) => { if (result.error) throw new Error(`${label}: ${result.error.code || ''} ${result.error.message}`); return result.data; };

const existing = await sql`select 1 from auth.users where email like 'demo.%@ferias.test' limit 1`;
if (existing.length) {
  console.log('Ya hay datos de demostración. Para volver a sembrar: npm run db:reset && npm run seed:demo');
  await sql.end();
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(svgText, width, height) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<html><body style="margin:0">${svgText.replace('<svg ', `<svg style="display:block;width:${width}px;height:${height}px" `)}</body></html>`);
  return page.screenshot({ type: 'jpeg', quality: 84 });
}

const credentials = [];
async function person(key, name, phone) {
  const email = `demo.${key}@ferias.test`;
  const password = `Demo${randomUUID().slice(0, 10)}7x`;
  const created = ok(await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: name, phone } }), `cuenta ${key}`);
  const client = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  ok(await client.auth.signInWithPassword({ email, password }), `ingreso ${key}`);
  ok(await client.from('profiles').insert({ user_id: created.user.id, display_name: name, phone }), `perfil ${key}`);
  credentials.push({ rol: key, email, password });
  return { id: created.user.id, email, client };
}
async function upload(client, path, buffer) {
  ok(await client.storage.from('ferias-media').upload(path, buffer, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' }), `foto ${path}`);
  return path;
}

const DEMO_NOTE = '\n\n(Tienda de demostración: los datos no son reales.)';
const STORES = [
  { key: 'raices', owner: 'Marina Quiroga', name: 'Raíces de Barro', locality: 'neuquen', category: 'ceramica', plan: 'feriante', logo: ['R', '#b5432a', '#fbe5da', 'pot'], cover: ['set-tazas', '#f7ddc4', '#e9c19b'],
    tagline: 'Cerámica artesanal inspirada en la Patagonia.', description: 'Piezas únicas hechas a mano en gres, con paisajes del sur.', whatsapp: '5492995550101', instagram: 'raicesdebarro.demo',
    pickupArea: 'Barrio Bouquet Roldán', delivery: { zone: 'Neuquén capital', fee: 2500, minimum: 10000 },
    products: [
      { name: 'Taza patagónica', art: 'taza', price: 12500, stock: 5, days: [3, 5], featured: true, materials: 'Gres esmaltado, apto lavavajillas', description: 'Taza artesanal de cerámica, inspirada en los paisajes de la Patagonia. Cada pieza es única.' },
      { name: 'Cuenco patagónico', art: 'cuenco', price: 15000, stock: 3, featured: true, materials: 'Gres con esmalte terracota', description: 'Cuenco para sopas, ensaladas o para servir. Hecho a mano en torno.' },
      { name: 'Set de tazas', art: 'set-tazas', price: 28000, stock: 2, materials: 'Tres tazas de gres', description: 'Set de tres tazas con el diseño de montañas, para compartir.' },
      { name: 'Plato pintado a mano', art: 'plato', price: 9800, stock: 6, description: 'Plato hondo con guarda pintada a mano.' },
    ] },
  { key: 'tierraviva', owner: 'Julián Paredes', name: 'Tierra Viva', locality: 'plottier', category: 'decoracion', plan: 'pro', logo: ['T', '#f7ddc4', '#b5432a', 'leaf'], cover: ['maceta', '#e7efe9', '#cfe0d4'],
    tagline: 'Macetas, cuencos y plantas para tu casa.', description: 'Taller familiar de cerámica y macramé en Plottier.', whatsapp: '5492995550202', instagram: 'tierraviva.demo',
    pickupArea: 'Centro de Plottier', delivery: null,
    products: [
      { name: 'Cuenco artesanal', art: 'cuenco', price: 15000, stock: 4, featured: true, description: 'Cuenco esmaltado a mano.' },
      { name: 'Maceta esmaltada', art: 'maceta', price: 11000, stock: 7, featured: true, description: 'Maceta con drenaje y plato.', variants: [['Chica', -2000, 3], ['Mediana', 0, 3], ['Grande', 3500, 1]] },
      { name: 'Colgante de macramé', art: 'macrame', price: 13500, stock: 0, made: true, days: [5, 7], description: 'Colgante tejido a mano en algodón. Se hace por encargo.' },
    ] },
  { key: 'luna', owner: 'Lucía Ferrero', name: 'Luna Accesorios', locality: 'cipolletti', category: 'joyeria', plan: 'entrada', logo: ['L', '#f2557e', '#fffaf2', 'flower'], cover: ['aros', '#fde4ea', '#f7c4d1'],
    tagline: 'Aros y collares de arcilla polimérica.', description: 'Accesorios livianos, coloridos y hechos uno por uno.', whatsapp: '5492995550303', instagram: 'luna.accesorios.demo',
    pickupArea: 'Cipolletti centro', delivery: { zone: 'Cipolletti y Neuquén', fee: null, minimum: 0 },
    products: [
      { name: 'Aros de flor', art: 'aros', price: 9500, featured: true, description: 'Aros de arcilla con gancho de acero quirúrgico.', variants: [['Blancos', 0, 4], ['Naranjas', 0, 2]] },
      { name: 'Collar de semillas', art: 'collar', price: 12000, stock: 3, description: 'Collar con cuentas de colores.' },
      { name: 'Pulsera tejida', art: 'pulsera', price: 5500, stock: 10, description: 'Pulsera tejida en hilo encerado.' },
    ] },
  { key: 'tramas', owner: 'Rosa Antiñir', name: 'Tramas del Sur', locality: 'neuquen', category: 'textiles', plan: 'feriante', logo: ['T', '#6a5d24', '#f7ddc4', 'loom'], cover: ['manta', '#efe2d2', '#e0c6a4'],
    tagline: 'Tejidos en telar y crochet con lana de la región.', description: 'Tejemos con lana de oveja hilada a mano.', whatsapp: '5492995550404', instagram: '',
    pickupArea: 'Barrio Santa Genoveva', delivery: { zone: 'Neuquén capital', fee: 3000, minimum: 15000 },
    products: [
      { name: 'Bolso tejido', art: 'bolso', price: 22000, stock: 2, featured: true, description: 'Bolso tejido a crochet, forrado por dentro.' },
      { name: 'Posavasos tejidos (x4)', art: 'posavasos', price: 7500, stock: 8, description: 'Juego de cuatro posavasos de telar.' },
      { name: 'Manta de telar', art: 'manta', price: 64000, stock: 0, made: true, days: [10, 15], description: 'Manta de lana tejida en telar criollo. Por encargo, con los colores que elijas.' },
    ] },
  { key: 'surmate', owner: 'Diego Calfucura', name: 'Sur Mate', locality: 'neuquen', category: 'cuero', plan: 'feriante', logo: ['S', '#3b2218', '#d9a37a', 'gourd'], cover: ['mate', '#f1dcc6', '#e3c19c'],
    tagline: 'Mates tallados, cuero y sabores regionales.', description: 'Trabajamos calabaza, cuero y dulces de la zona.', whatsapp: '5492995550505', instagram: 'surmate.demo',
    pickupArea: 'Alto Neuquén', delivery: null,
    products: [
      { name: 'Mate tallado', art: 'mate', price: 18000, stock: 4, featured: true, description: 'Mate de calabaza tallado a mano, con virola de alpaca.' },
      { name: 'Billetera de cuero', art: 'billetera', price: 16500, stock: 5, description: 'Billetera de cuero vacuno cosida a mano.' },
      { name: 'Dulce de rosa mosqueta', art: 'dulce', price: 4800, stock: 12, category: 'regionales', description: 'Frasco de 400 g, elaboración artesanal.' },
    ] },
  { key: 'aromas', owner: 'Valeria Sosa', name: 'Aromas del Valle', locality: 'plottier', category: 'decoracion', plan: 'entrada', logo: ['A', '#ee4a12', '#fffaf2', 'flame'], cover: ['vela', '#f3e3d1', '#e6c9a8'],
    tagline: 'Velas de soja y difusores con aromas del valle.', description: 'Velas vertidas a mano con cera de soja y esencias.', whatsapp: '5492995550606', instagram: 'aromasdelvalle.demo',
    pickupArea: 'Plottier', delivery: { zone: 'Plottier y Neuquén', fee: 2000, minimum: 0 },
    products: [
      { name: 'Vela de soja', art: 'vela', price: 8900, featured: true, description: 'Vela en frasco de vidrio, 40 horas de duración.', variants: [['Lavanda', 0, 5], ['Vainilla', 0, 3], ['Pino', 0, 2]] },
      { name: 'Difusor de varillas', art: 'difusor', price: 10500, stock: 4, description: 'Difusor de 120 ml con varillas de ratán.' },
      { name: 'Cuadro de montaña', art: 'cuadro', price: 26000, stock: 1, category: 'arte', description: 'Ilustración original enmarcada, 30 x 30 cm.' },
    ] },
];

console.log('Sembrando datos de demostración en el stack local…');
const adminPerson = await person('admin', 'Administración CAUCE', '299 5550000');
await sql`insert into private.platform_admins (user_id) values (${adminPerson.id})`;
await sql`insert into private.platform_features (key, enabled) values ('demo_data', true) on conflict (key) do update set enabled = true`;

const categoryId = Object.fromEntries((await sql`select slug, id from public.categories`).map(r => [r.slug, r.id]));
const shops = {};
for (const store of STORES) {
  const owner = await person(store.key, store.owner, `299 555${String(Object.keys(shops).length + 1).padStart(4, '0')}`);
  const created = ok(await owner.client.rpc('create_business', { business_name: store.name, locality_slug: store.locality, category_slug: store.category }), `tienda ${store.key}`);
  const id = created.id;
  const logo = await upload(owner.client, `businesses/${id}/logo/${randomUUID()}.jpg`, await render(logoArt(...store.logo), 300, 300));
  const cover = await upload(owner.client, `businesses/${id}/cover/${randomUUID()}.jpg`, await render(coverArt(...store.cover), 1200, 400));
  ok(await owner.client.from('businesses').update({ tagline: store.tagline, description: `${store.description}${DEMO_NOTE}`, whatsapp: store.whatsapp,
    instagram: store.instagram, logo_path: logo, cover_path: cover, pickup_area: store.pickupArea, delivery_enabled: Boolean(store.delivery),
    delivery_zone: store.delivery?.zone || '', delivery_fee_ars: store.delivery ? store.delivery.fee : null, minimum_order_ars: store.delivery?.minimum || 0 }).eq('id', id), `datos ${store.key}`);
  const products = [];
  for (const [index, item] of store.products.entries()) {
    const product = ok(await owner.client.from('products').insert({ business_id: id, name: item.name, description: item.description, materials: item.materials || '',
      price_ars: item.price, category_id: categoryId[item.category || store.category], track_stock: !item.made, stock: item.stock || 0, made_to_order: Boolean(item.made),
      production_days_min: item.days?.[0] || null, production_days_max: item.days?.[1] || null, featured: Boolean(item.featured), position: index }).select('id').single(), `producto ${item.name}`);
    const path = await upload(owner.client, `businesses/${id}/products/${randomUUID()}.jpg`, await render(PRODUCT_ART[item.art](), 600, 600));
    ok(await owner.client.from('product_images').insert({ product_id: product.id, business_id: id, path, alt: item.name, position: 0 }), `foto ${item.name}`);
    const variants = [];
    for (const [i, [name, delta, stock]] of (item.variants || []).entries()) {
      variants.push(ok(await owner.client.from('product_variants').insert({ product_id: product.id, business_id: id, name, price_delta_ars: delta, stock, position: i }).select('id,name').single(), `variante ${name}`));
    }
    products.push({ ...product, name: item.name, price: item.price, variants });
  }
  ok(await owner.client.rpc('submit_business_for_review', { business: id }), `publicación ${store.key}`);
  ok(await adminPerson.client.rpc('review_business', { business: id, decision: 'active', note: 'Demostración', plan: store.plan, trial_days: 60 }), `aprobación ${store.key}`);
  shops[store.key] = { id, owner, products, store };
  console.log(`  · ${store.name} (${store.plan}) con ${products.length} productos`);
}

// Un borrador en revisión, para ver la administración con trabajo pendiente.
const pendingOwner = await person('telar', 'Ana Millaqueo', '299 5550909');
const pending = ok(await pendingOwner.client.rpc('create_business', { business_name: 'Hilos de la Confluencia', locality_slug: 'centenario', category_slug: 'textiles' }), 'tienda pendiente');
const pendingProduct = ok(await pendingOwner.client.from('products').insert({ business_id: pending.id, name: 'Camino de mesa', price_ars: 14000, stock: 2, description: `Tejido en telar.${DEMO_NOTE}` }).select('id').single(), 'producto pendiente');
ok(await pendingOwner.client.from('product_images').insert({ product_id: pendingProduct.id, business_id: pending.id, alt: 'Camino de mesa',
  path: await upload(pendingOwner.client, `businesses/${pending.id}/products/${randomUUID()}.jpg`, await render(PRODUCT_ART.manta(), 600, 600)) }), 'foto pendiente');
ok(await pendingOwner.client.rpc('submit_business_for_review', { business: pending.id }), 'revisión pendiente');

// Organización y ferias.
const organizerPerson = await person('organiza', 'Carla Rivas', '299 5550808');
const organizerId = ok(await adminPerson.client.rpc('admin_create_organizer', { organizer_name: 'Ferias de la Confluencia (demo)', owner_email: organizerPerson.email }), 'organización');
ok(await adminPerson.client.rpc('admin_set_subscription', { organizer: organizerId, plan: 'organizador', plan_status: 'trial', period_end: new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10), grace_days: 10, note: 'Demostración' }), 'plan organizador');
ok(await organizerPerson.client.from('organizers').update({ whatsapp: '5492995550808', description: 'Organización de demostración.' }).eq('id', organizerId), 'datos organización');
const nextWeekday = (weekday, hour, minute = 0) => {
  const now = new Date(Date.now() - 3 * 3600000);
  const add = ((weekday - now.getUTCDay() + 7) % 7) || 7;
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + add, hour + 3, minute));
  return day;
};
const FAIRS = [
  { name: 'Feria del Parque Central', venue: 'Parque Central', address: 'Av. Argentina y Roca', locality: 'neuquen', day: nextWeekday(6, 10), hours: 9, lat: -38.9516, lng: -68.0591, capacity: 60, hue: 0,
    stalls: { raices: 'A12', tierraviva: 'A14', tramas: 'B3', surmate: 'B5', aromas: 'C1' } },
  { name: 'Feria Paseo de la Costa', venue: 'Paseo Costero', address: 'Costanera del río Limay', locality: 'neuquen', day: nextWeekday(0, 11), hours: 7, lat: -38.9792, lng: -68.0587, capacity: 40, hue: 1,
    stalls: { raices: '7', luna: '12', surmate: '15' } },
];
for (const spec of FAIRS) {
  const fair = ok(await organizerPerson.client.rpc('create_fair', { organizer: organizerId, payload: { name: spec.name, venue: spec.venue, address: spec.address,
    locality: spec.locality, starts_at: spec.day.toISOString(), ends_at: new Date(spec.day.getTime() + spec.hours * 3600000).toISOString(),
    latitude: spec.lat, longitude: spec.lng, stall_capacity: spec.capacity, description: `Feria de demostración con artesanos y emprendedores de la región. Música, comida y actividades para chicos.` } }), `feria ${spec.name}`);
  const coverPath = await upload(organizerPerson.client, `fairs/${fair.id}/cover/${randomUUID()}.jpg`, await render(fairCoverArt(spec.hue), 1200, 600));
  ok(await organizerPerson.client.from('fairs').update({ cover_path: coverPath }).eq('id', fair.id), 'portada feria');
  ok(await organizerPerson.client.rpc('set_fair_status', { fair: fair.id, next_status: 'published', reason: '' }), `publicar ${spec.name}`);
  for (const [key, stall] of Object.entries(spec.stalls)) {
    const participation = ok(await shops[key].owner.client.rpc('apply_to_fair', { fair: fair.id, business: shops[key].id }), `inscripción ${key}`);
    ok(await organizerPerson.client.rpc('decide_participation', { participation, decision: 'confirmed', stall, note: '' }), `confirmar ${key}`);
  }
  spec.id = fair.id;
  console.log(`  · ${spec.name} publicada con ${Object.keys(spec.stalls).length} expositores`);
}
ok(await organizerPerson.client.from('fair_announcements').insert({ fair_id: FAIRS[0].id, body: 'El armado empieza a las 8:30 por calle Roca. Traigan alargue: hay tomas cada dos puestos.' }), 'aviso');
const luna = shops.luna;
ok(await luna.owner.client.rpc('apply_to_fair', { fair: FAIRS[0].id, business: luna.id }), 'solicitud pendiente');

// Pedidos de quien compra sin cuenta (sesión anónima real).
async function guestOrder(shopKey, lines, fulfillment, extra = {}) {
  const client = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  ok(await client.auth.signInAnonymously(), 'sesión de compra');
  const shop = shops[shopKey];
  const items = lines.map(([index, quantity, variant]) => ({ product_id: shop.products[index].id, quantity,
    variant_id: variant !== undefined ? shop.products[index].variants[variant].id : null }));
  return ok(await client.rpc('create_order', { business: shop.id, idem: randomUUID(), fulfillment, payment_method: extra.payment || 'transfer',
    fair: extra.fair || null, contact: { name: extra.name, phone: extra.phone, address: extra.address || '', notes: extra.notes || '' }, items }), `pedido ${shopKey}`);
}
await guestOrder('raices', [[0, 1]], 'fair_pickup', { fair: FAIRS[0].id, name: 'Sofía Demo', phone: '299 4001122', notes: 'Es para regalo.' });
await guestOrder('tramas', [[0, 1], [1, 1]], 'delivery', { name: 'Martín Demo', phone: '299 4003344', address: 'Belgrano 450, Neuquén', payment: 'cash' });
const accepted = await guestOrder('raices', [[1, 1]], 'pickup', { name: 'Paula Demo', phone: '299 4005566' });
ok(await shops.raices.owner.client.rpc('transition_order', { order_id: accepted, expected_version: 1, next_status: 'accepted', reason: '' }), 'aceptar pedido');

await browser.close();
await sql.end();
await mkdir(resolve(root, '.local'), { recursive: true });
await writeFile(resolve(root, '.local/demo-credenciales.json'), `${JSON.stringify(credentials, null, 2)}\n`);
console.log(`Listo. ${credentials.length} cuentas de demostración (contraseñas en .local/demo-credenciales.json).`);
console.log('Administración:', credentials[0].email, '· Tienda:', credentials[1].email, '· Organización:', credentials.find(c => c.rol === 'organiza').email);
