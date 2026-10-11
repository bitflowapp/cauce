// Integración real: GoTrue (correo vía Mailpit), PostgREST, Storage y Realtime
// del stack local de CAUCE · Ferias, más el repositorio de la propia
// aplicación (js/repo) usado tal cual lo usa el navegador.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRepository } from '../../js/repo/supabase-repository.js';
import { env, sql, admin, run, anonClient, ok, failsWith, account, guest, makeAdmin, publishedBusiness, order,
  latestMail, tokenFromMail, tinyPng } from './harness.mjs';

let reviewer, merchantA, merchantB, shopA, shopB, buyer;
before(async () => {
  reviewer = await account('Revisora');
  await makeAdmin(reviewer);
  merchantA = await account('ComercioA');
  merchantB = await account('ComercioB');
  buyer = await account('Compradora');
  shopA = await publishedBusiness(merchantA, reviewer, { name: 'Raices', stock: 1 });
  shopB = await publishedBusiness(merchantB, reviewer, { name: 'Tramas', plan: 'entrada' });
});
after(async () => {
  try { await cleanup(); } finally { await sql.end(); }
});
async function cleanup() {
  // Limpieza de lo creado por esta corrida (cuentas qa-<run>-…).
  const users = await sql`select id from auth.users where email like ${`qa-${run}-%`}`;
  const ids = users.map(u => u.id);
  if (ids.length) {
    const businesses = await sql`select business_id from public.business_memberships where user_id = any(${ids}) and role = 'owner'`;
    const bids = businesses.map(b => b.business_id);
    if (bids.length) {
      await sql`delete from public.orders where business_id = any(${bids})`;
      const files = await sql`select name from storage.objects where bucket_id = 'ferias-media' and split_part(name, '/', 2) = any(${bids.map(String)})`;
      if (files.length) ok(await admin.storage.from('ferias-media').remove(files.map(f => f.name)), 'borrar archivos');
      await sql`delete from public.fair_participations where business_id = any(${bids})`;
      await sql`delete from public.businesses where id = any(${bids})`;
    }
    await sql`delete from public.orders where customer_id = any(${ids})`;
    const orgs = await sql`select organizer_id from public.organizer_members where user_id = any(${ids})`;
    if (orgs.length) {
      await sql`delete from public.fairs where organizer_id = any(${orgs.map(o => o.organizer_id)})`;
      await sql`delete from public.organizers where id = any(${orgs.map(o => o.organizer_id)})`;
    }
    // Las sesiones anónimas de esta corrida también se limpian (sin pedidos ya).
    for (const id of ids) ok(await admin.auth.admin.deleteUser(id), 'borrar cuenta');
  }
}

test('registro real: sin confirmar no entra; el enlace del correo confirma desde otro dispositivo', async () => {
  const email = `qa-${run}-registro@ferias.test`;
  const password = `Clave${randomUUID().slice(0, 8)}42`;
  const device1 = anonClient();
  const signup = ok(await device1.auth.signUp({ email, password, options: { data: { display_name: 'Nueva Vendedora', phone: '299 4111111' } } }), 'registro');
  assert.equal(signup.session, null);
  failsWith(await device1.auth.signInWithPassword({ email, password }), 'email_not_confirmed');
  const mail = await latestMail(email, { subject: 'Confirmá tu correo en CAUCE · Ferias' });
  assert.match(mail.HTML, /CAUCE/);
  const { tokenHash, type } = tokenFromMail(mail);
  const device2 = anonClient();
  ok(await device2.auth.verifyOtp({ token_hash: tokenHash, type }), 'confirmar');
  ok(await device1.auth.signInWithPassword({ email, password }), 'ingreso tras confirmar');
  // El mismo enlace no se reutiliza.
  assert.ok((await anonClient().auth.verifyOtp({ token_hash: tokenHash, type })).error);
});

test('contraseña débil o corta: la rechaza el servidor', async () => {
  const result = await anonClient().auth.signUp({ email: `qa-${run}-debil@ferias.test`, password: 'abc123' });
  assert.ok(result.error, 'GoTrue debe rechazar la contraseña');
  assert.equal(result.error.code, 'weak_password');
});

test('recuperación real: el enlace fija la nueva y la anterior deja de valer', async () => {
  const client = anonClient();
  ok(await client.auth.resetPasswordForEmail(merchantB.email), 'pedir recuperación');
  const mail = await latestMail(merchantB.email, { subject: 'Recuperar tu contraseña de CAUCE · Ferias' });
  const { tokenHash, type } = tokenFromMail(mail);
  assert.equal(type, 'recovery');
  const other = anonClient();
  ok(await other.auth.verifyOtp({ token_hash: tokenHash, type }), 'verificar recuperación');
  const next = `Nueva${randomUUID().slice(0, 8)}77`;
  ok(await other.auth.updateUser({ password: next }), 'nueva contraseña');
  failsWith(await anonClient().auth.signInWithPassword({ email: merchantB.email, password: merchantB.password }), 'invalid_credentials');
  ok(await anonClient().auth.signInWithPassword({ email: merchantB.email, password: next }), 'ingreso con la nueva');
  merchantB.password = next;
});

test('Storage: cada comercio sube sólo a su carpeta; el tipo y la ruta se validan', async () => {
  const own = `businesses/${shopA.id}/logo/${randomUUID()}.png`;
  ok(await merchantA.client.storage.from('ferias-media').upload(own, tinyPng(), { contentType: 'image/png' }), 'propia');
  const foreign = await merchantB.client.storage.from('ferias-media').upload(`businesses/${shopA.id}/logo/${randomUUID()}.png`, tinyPng(), { contentType: 'image/png' });
  assert.ok(foreign.error, 'otro comercio no puede subir');
  const anonymous = await (await guest('Intrusa')).client.storage.from('ferias-media').upload(`businesses/${shopA.id}/logo/${randomUUID()}.png`, tinyPng(), { contentType: 'image/png' });
  assert.ok(anonymous.error, 'una sesión anónima no puede subir');
  const svg = await merchantA.client.storage.from('ferias-media').upload(`businesses/${shopA.id}/logo/${randomUUID()}.svg`, Buffer.from('<svg/>'), { contentType: 'image/svg+xml' });
  assert.ok(svg.error, 'SVG no admitido');
  const big = await merchantA.client.storage.from('ferias-media').upload(`businesses/${shopA.id}/cover/${randomUUID()}.png`, Buffer.alloc(5 * 1024 * 1024 + 10), { contentType: 'image/png' });
  assert.ok(big.error, 'más de 5 MB no admitido');
  // La foto publicada se puede ver sin sesión (bucket público con rutas impredecibles).
  const url = anonClient().storage.from('ferias-media').getPublicUrl(own).data.publicUrl;
  assert.equal((await fetch(url)).status, 200);
  const removeForeign = await merchantB.client.storage.from('ferias-media').remove([own]);
  assert.equal((removeForeign.data || []).length, 0, 'otro comercio no borra archivos ajenos');
});

test('el mismo intento enviado seis veces en paralelo crea un solo pedido', async () => {
  const shopper = await guest('Paralela');
  const idem = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => order(shopper, shopA.id, [{ product_id: shopA.made.id, quantity: 1 }], { idem })));
  const ids = new Set(results.map(r => ok(r, 'pedido paralelo')));
  assert.equal(ids.size, 1);
  assert.equal((await sql`select count(*)::int as n from public.orders where idempotency_key = ${idem}`)[0].n, 1);
});

test('la última unidad en stock la gana un solo pedido', async () => {
  const [one, two] = [await guest('Primera'), await guest('Segunda')];
  const results = await Promise.all([one, two].map(g => order(g, shopA.id, [{ product_id: shopA.product.id, quantity: 1 }])));
  const won = results.filter(r => !r.error);
  const lost = results.filter(r => r.error);
  assert.equal(won.length, 1);
  assert.equal(lost[0].error.code, 'U0003');
  assert.equal((await sql`select stock from public.products where id = ${shopA.product.id}`)[0].stock, 0);
});

test('precio cambiado durante el checkout: no se crea el pedido (U0005)', async () => {
  failsWith(await order(buyer, shopB.id, [{ product_id: shopB.made.id, quantity: 1 }], { expectedTotal: 100 }), 'U0005');
});

test('PostgREST respeta RLS entre comercios y clientes', async () => {
  const placed = ok(await order(buyer, shopB.id, [{ product_id: shopB.made.id, quantity: 1 }]), 'pedido');
  assert.equal(ok(await merchantA.client.from('orders').select('id').eq('id', placed), 'A lee').length, 0);
  assert.equal(ok(await merchantB.client.from('orders').select('id').eq('id', placed), 'B lee').length, 1);
  failsWith(await anonClient().from('orders').select('id'), '42501');
  assert.ok((await merchantA.client.rpc('transition_order', { order_id: placed, expected_version: null, next_status: 'accepted', reason: '' })).error);
  assert.ok((await buyer.client.from('orders').update({ total_ars: 1 }).eq('id', placed)).error);
  assert.equal(ok(await merchantA.client.from('business_contacts').select('*').eq('business_id', shopB.id), 'contacto ajeno').length, 0);
});

test('Realtime entrega a cada comercio sólo sus pedidos', async () => {
  const received = { A: [], B: [] };
  const channels = [];
  for (const [key, merchant, shop] of [['A', merchantA, shopA], ['B', merchantB, shopB]]) {
    merchant.client.realtime.setAuth((await merchant.client.auth.getSession()).data.session.access_token);
    const channel = merchant.client.channel(`qa-${key}-${run}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' },
      payload => received[key].push(payload.new.business_id));
    await new Promise((resolve, reject) => channel.subscribe(state => (state === 'SUBSCRIBED' ? resolve() : state === 'CHANNEL_ERROR' ? reject(new Error(state)) : null)));
    channels.push([merchant, channel, shop]);
  }
  ok(await order(await guest('Realtime'), shopB.id, [{ product_id: shopB.made.id, quantity: 1 }]), 'pedido a B');
  const until = Date.now() + 8000;
  while (!received.B.length && Date.now() < until) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 800));
  assert.ok(received.B.length >= 1, 'B recibe su pedido');
  assert.ok(received.B.every(id => id === shopB.id));
  assert.equal(received.A.filter(id => id === shopB.id).length, 0, 'A no recibe pedidos de B');
  for (const [merchant, channel] of channels) await merchant.client.removeChannel(channel);
});

test('ferias de punta a punta por la API: organizador, inscripción, puesto y retiro en feria', async () => {
  const organizer = await account('Organiza');
  const organizerId = ok(await reviewer.client.rpc('admin_create_organizer', { organizer_name: `Org ${run}`, owner_email: organizer.email }), 'organización');
  ok(await reviewer.client.rpc('admin_set_subscription', { organizer: organizerId, plan: 'organizador', plan_status: 'active', period_end: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10) }), 'plan');
  const starts = new Date(Date.now() + 3 * 86400000);
  const fair = ok(await organizer.client.rpc('create_fair', { organizer: organizerId, payload: { name: `Feria ${run}`, venue: 'Plaza', locality: 'neuquen',
    starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 6 * 3600000).toISOString() } }), 'feria');
  ok(await organizer.client.rpc('set_fair_status', { fair: fair.id, next_status: 'published', reason: '' }), 'publicar');
  const participation = ok(await merchantA.client.rpc('apply_to_fair', { fair: fair.id, business: shopA.id }), 'inscripción');
  assert.ok((await merchantB.client.rpc('decide_participation', { participation, decision: 'confirmed', stall: 'X1', note: '' })).error);
  ok(await organizer.client.rpc('decide_participation', { participation, decision: 'confirmed', stall: 'A7', note: '' }), 'confirmar');
  const placed = ok(await order(buyer, shopA.id, [{ product_id: shopA.made.id, quantity: 1 }], { fulfillment: 'fair_pickup', fair: fair.id }), 'retiro en feria');
  const tracked = ok(await anonClient().rpc('track_order', { token: (await sql`select tracking_token from public.orders where id = ${placed}`)[0].tracking_token }), 'seguimiento');
  assert.equal(tracked.pickup.stall, 'A7');
  // Plan de entrada: no ofrece retiro en el puesto.
  const p2 = ok(await merchantB.client.rpc('apply_to_fair', { fair: fair.id, business: shopB.id }), 'inscripción B');
  ok(await organizer.client.rpc('decide_participation', { participation: p2, decision: 'confirmed', stall: 'A8', note: '' }), 'confirmar B');
  failsWith(await order(buyer, shopB.id, [{ product_id: shopB.made.id, quantity: 1 }], { fulfillment: 'fair_pickup', fair: fair.id }), '23514');
});

test('el repositorio de la aplicación funciona contra el backend real', async () => {
  const client = anonClient();
  const repo = createRepository({ client, siteUrl: 'http://127.0.0.1:4274/index.html', redirectTo: 'http://127.0.0.1:4274/index.html' });
  const status = await repo.appStatus();
  assert.equal(status.schema, 20261011120500);
  const store = await repo.storeBySlug(shopA.slug);
  assert.equal(store.business.id, shopA.id);
  assert.equal(store.business.takingOrders, true);
  assert.equal(store.business.offersFairPickup, true);
  assert.ok(store.products.some(p => p.name === 'Mate por encargo'));
  const search = await repo.searchProducts({ q: 'encargo', locality: 'neuquen' });
  assert.ok(search.items.some(p => p.business.id === shopA.id));
  const detail = await repo.product(shopA.made.id);
  assert.equal(detail.product.madeToOrder, true);
  // Compra sin cuenta con el repositorio: abre una sesión anónima real.
  const created = await repo.createOrder({ businessId: shopA.id, idem: randomUUID(), fulfillment: 'pickup', paymentMethod: 'transfer',
    contact: { name: 'Cliente Repo', phone: '299 4222222', email: '', notes: '' }, items: [{ product_id: shopA.made.id, quantity: 1, variant_id: null }], expectedTotal: 18000 });
  assert.match(created.code, /^FN-/);
  const tracked = await repo.trackOrder(created.trackingToken);
  assert.equal(tracked.status, 'submitted');
  const mine = await repo.myOrders();
  assert.ok(mine.some(o => o.id === created.id));
  // Un error del servidor llega traducido.
  await assert.rejects(repo.createOrder({ businessId: shopA.id, idem: randomUUID(), fulfillment: 'delivery', paymentMethod: 'cash',
    contact: { name: 'Cliente Repo', phone: '299 4222222', address: '' }, items: [{ product_id: shopA.made.id, quantity: 1 }], expectedTotal: null }),
  error => error.message === 'Ingresá la dirección de entrega.');
  // El comercio ve el pedido en su panel por el mismo repositorio.
  const merchantRepo = createRepository({ client: merchantA.client, siteUrl: '', redirectTo: '' });
  const panelOrders = await merchantRepo.panelOrders(shopA.id, { open: true });
  assert.ok(panelOrders.some(o => o.id === created.id && o.contact.name === 'Cliente Repo'));
  const session = await merchantRepo.session({ fresh: true });
  assert.equal(session.kind, 'account');
  assert.ok(session.memberships.some(m => m.businessId === shopA.id && m.role === 'owner'));
  assert.equal(env.url.startsWith('http://127.0.0.1'), true);
});
