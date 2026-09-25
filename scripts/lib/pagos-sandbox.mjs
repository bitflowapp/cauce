// Sandbox de Mercado Pago de punta a punta contra el proyecto REAL, con las
// Edge Functions desplegadas y Mercado Pago real en modo de prueba: cuentas de
// prueba (vendedores A y B, comprador), tarjetas de prueba y órdenes ORDTST….
// Nunca dinero real: el interruptor global sigue apagado, sólo cobran los dos
// comercios "CAUCE QA · Mercado Pago" como piloto en sandbox, la base rechaza
// cuentas reales en un piloto de prueba y todo se borra al final.
//
// Recorre lo que haría la gente, con el build de esta rama servido en
// 127.0.0.1:4174 contra el proyecto real:
//   titular → Panel → Pagos → Conectar → Mercado Pago (cuenta de prueba) → vuelve conectado;
//   comprador → pedido con pago online → Checkout Pro → tarjeta de prueba → webhook firmado →
//   la función lee la orden en la API → aprobado → el comercio acepta el pedido desde el panel.
// Más: rechazado, pendiente, idempotencia (doble toque y reenvío con la misma clave),
// webhooks falsos, aislamiento entre A y B, renovación de tokens, desconexión con
// efectivo como respaldo y registros sin tokens.
//
// Modos (pedido "modo"):
//   automatico  Playwright recorre también las páginas de Mercado Pago;
//   asistido    las páginas de Mercado Pago las completa una persona: el paso
//               imprime la dirección (sandbox, de un solo uso, vence) y espera
//               lo que registra la base;
//   mixto       automático y, si el proveedor frena al navegador (IP o captcha),
//               asistido para ese paso.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createStaticServer } from '../server.mjs';
import { ROOT, SITE_URL, hide, log, redact } from './proyecto.mjs';
import { FUNCTIONS, FUNCTION_SECRETS, TEST_ACCOUNT_SECRETS, QA_SLUG, secretNames } from './pagos.mjs';
import { Blocked, HOLDER, TEST_CARD, SANDBOX_EMAIL, authorizeSeller, payCheckout, safeShot } from './mp-navegador.mjs';

const LOCAL_SITE = 'http://127.0.0.1:4174';
const SANDBOX_SCHEMA = 20260927120000;
const EVIDENCE = new URL('evidence/pagos-sandbox/', ROOT);
const WEBHOOK_WAIT_MS = 180000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const uuid = value => { if (!/^[0-9a-f-]{36}$/.test(String(value))) throw new Error('id inválido'); return `'${value}'`; };
const hhmm = ms => new Date(ms).toISOString().slice(11, 16);

async function appStatus(t) {
  const response = await fetch(`${t.url}/rest/v1/rpc/app_status`, { method: 'POST',
    headers: { apikey: t.publishableKey, 'Content-Type': 'application/json' }, body: '{}' });
  return response.json();
}

export async function pagosSandbox(t, list, { apply, mode = 'mixto' }) {
  if (t.local) throw new Error('El sandbox de Mercado Pago corre contra el proyecto real; en local está npm run test:edge.');
  if (!['automatico', 'asistido', 'mixto'].includes(mode)) throw new Error(`Modo desconocido: ${mode}.`);
  if (!apply) {
    list.fail('pedido con aplicar', 'crea y borra comercios, cuentas y pedidos CAUCE QA: pedirlo con aplicar y confirmar');
    return;
  }
  const run = randomBytes(4).toString('hex');
  const evidence = { run, mode, started: new Date().toISOString(), site: SITE_URL, results: [], ids: {}, trace: {},
    webhook: {}, money: 'ninguno: cuentas y tarjetas de prueba de Mercado Pago' };
  const record = (name, ok, detail = '') => { evidence.results.push({ name, ok, detail: String(detail) }); list.check(name, ok, detail); return ok; };
  const note = (name, detail) => { evidence.results.push({ name, ok: null, detail: String(detail) }); list.info(name, detail); };
  // Cada escenario falla por su cuenta: un error se anota y los demás siguen.
  const scenario = async (name, fn) => {
    try { return await fn(); } catch (error) {
      record(`${name}: terminó sin errores`, false, redact(String(error?.message || error)).split('\n')[0].slice(0, 220));
      return null;
    }
  };
  await mkdir(EVIDENCE, { recursive: true });
  const shot = name => fileURLToPath(new URL(`${name}.png`, EVIDENCE));

  // Las credenciales de las cuentas de prueba nunca aparecen: ni en el
  // registro (hide) ni en las capturas (safeShot las tapa).
  for (const name of TEST_ACCOUNT_SECRETS) hide(process.env[name]);
  const mp = Object.fromEntries(['SELLER_A', 'SELLER_B', 'BUYER'].map(who => [who, {
    user: process.env[`MP_TEST_${who}_USER`] || '', password: process.env[`MP_TEST_${who}_PASSWORD`] || '',
    code: process.env[`MP_TEST_${who}_CODE`] || '' }]));

  // ───────── precondiciones: si algo no está, no se toca nada ─────────
  const status = await appStatus(t);
  record('pagos globales apagados (payments_online = false)', status.features?.payments_online === false,
    String(status.features?.payments_online));
  record('esquema con el piloto por comercio', Number(status.schema) >= SANDBOX_SCHEMA, String(status.schema));
  const deployed = await t.management('/functions');
  for (const name of FUNCTIONS) {
    const found = deployed.find(item => item.slug === name);
    record(`${name} desplegada`, found?.status === 'ACTIVE', found ? `${found.status} · v${found.version}` : 'no está');
  }
  const names = await secretNames(t);
  for (const name of FUNCTION_SECRETS) record(`secreto de las funciones ${name}`, names.includes(name), names.includes(name) ? 'presente' : 'falta');
  for (const name of TEST_ACCOUNT_SECRETS) record(`cuenta de prueba ${name}`, Boolean(process.env[name]), process.env[name] ? 'presente' : 'falta');
  // La renovación programada y el reenvío verificado se autorizan con la clave
  // de servicio que ven las funciones (SUPABASE_SERVICE_ROLE_KEY: la JWT).
  const keys = await t.management('/api-keys?reveal=true');
  const serviceJwt = keys.find(item => item.name === 'service_role')?.api_key || '';
  hide(serviceJwt);
  record('clave de servicio de las funciones disponible', Boolean(serviceJwt) && !serviceJwt.includes('*'), serviceJwt ? 'presente' : 'falta');
  const [pilotsBefore] = await t.sql(`select count(*)::int as n from private.payment_pilot_businesses`);
  record('ningún piloto encendido antes de empezar', Number(pilotsBefore.n) === 0, String(pilotsBefore.n));
  if (list.failed) {
    note('sin cambios', 'faltan condiciones: no se creó nada');
    await writeFile(new URL('resultado.json', EVIDENCE), JSON.stringify({ ...evidence, finished: new Date().toISOString() }, null, 2));
    return;
  }

  const service = createClient(t.url, await t.serviceKey(), clientOptions);
  const created = { users: [], businesses: [] };
  const callFunction = async (name, { token = '', body, method = 'POST', query = '', headers = {} } = {}) => {
    const response = await fetch(`${t.url}/functions/v1/${name}${query}`, { method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', apikey: t.publishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed, location: response.headers.get('location') || '' };
  };

  // ───────── cuentas y comercios CAUCE QA (patrón que limpia limpiar-qa) ─────────
  async function qaUser(role, { admin = false } = {}) {
    const email = `cauce-qa-${run}-${role}@example.com`;
    const password = `Qa${randomBytes(12).toString('base64url')}9`;
    hide(password);
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true,
      user_metadata: { display_name: `CAUCE QA ${role}` } });
    if (error) throw new Error(`cuenta ${role}: ${error.message}`);
    created.users.push(data.user.id);
    const client = createClient(t.url, t.publishableKey, clientOptions);
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw new Error(`ingreso ${role}: ${signed.error.message}`);
    await client.from('profiles').upsert({ user_id: data.user.id, display_name: `CAUCE QA ${role}`, phone: '2942 400000' },
      { onConflict: 'user_id', ignoreDuplicates: true });
    if (admin) await t.sql(`insert into private.platform_admins (user_id) values (${uuid(data.user.id)}) on conflict do nothing`);
    return { id: data.user.id, email, password, client, role,
      token: async () => (await client.auth.getSession()).data.session.access_token };
  }
  const must = (result, label) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; };
  const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].flatMap(weekday => [
    { weekday, opens: '00:00', closes: '12:00' }, { weekday, opens: '12:00', closes: '00:00' }]);
  async function qaBusiness(owner, reviewer, letter) {
    const c = owner.client;
    const name = `CAUCE QA · Mercado Pago ${letter}`;
    const slug = `${QA_SLUG}${letter.toLowerCase()}-${run}`;
    const id = must(await c.rpc('create_business', { business_name: name, business_slug: slug }), 'alta');
    created.businesses.push(id);
    const category = must(await c.from('business_categories').select('id').eq('slug', 'almacen').single(), 'rubro').id;
    must(await c.from('businesses').update({ category_id: category,
      description: 'Comercio de prueba interna de CAUCE para el sandbox de pagos. No atiende pedidos reales.',
      address: 'Prueba interna 1', hours_label: 'Prueba interna', public_phone: '2942 555000', whatsapp: '2942 555001',
      pickup_enabled: true, delivery_enabled: false, minimum_order_ars: 1000, prep_minutes: 20 }).eq('id', id), 'datos');
    must(await c.from('business_contacts').insert({ business_id: id, owner_name: 'CAUCE QA', phone: '2942 555002' }), 'contacto');
    must(await c.rpc('set_business_hours', { business: id, hours: ALL_DAY }), 'horarios');
    const shelf = must(await c.from('product_categories').insert({ business_id: id, name: 'Prueba' }).select().single(), 'categoría');
    const product = must(await c.from('products').insert({ business_id: id, category_id: shelf.id, name: 'Yerba QA',
      price_ars: 1500 }).select().single(), 'producto');
    must(await c.rpc('submit_business_for_review', { business: id }), 'solicitud');
    must(await reviewer.client.rpc('review_business', { business: id, decision: 'active', note: 'Sandbox de pagos QA' }), 'aprobación');
    must(await c.rpc('set_business_presence', { business: id, is_open: true }), 'apertura');
    return { id, name, slug, product: product.id };
  }
  const accountRow = async business => (await t.sql(`select status, provider_user_id, live_mode, token_expires_at::text as expires
    from public.payment_provider_accounts where business_id = ${uuid(business)}`))[0];
  const attemptsOf = async order => t.sql(`select id::text as id, status, status_detail, provider_order_id,
      idempotency_key::text as key, amount_ars::int as amount, checkout_url is not null as has_url
    from public.payment_attempts where order_id = ${uuid(order)} order by created_at`);
  const orderRow = async order => (await t.sql(`select status, payment_status, total_ars::int as total, code
    from public.orders where id = ${uuid(order)}`))[0];
  const eventsOf = async resource => t.sql(`select outcome, detail, action, coalesce(live_mode::text, 'sin dato') as live,
      received_at::text as at from private.payment_events where resource_id = '${String(resource).replace(/[^A-Z0-9]/gi, '')}'
    order by received_at`);
  const eventCount = async () => Number((await t.sql('select count(*)::int as n from private.payment_events'))[0].n);
  async function until(check, { timeout = WEBHOOK_WAIT_MS, every = 3000 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(every);
    }
  }
  const announce = (title, lines) => {
    log(`\n▶ PASO ASISTIDO · ${title}`);
    for (const line of lines) log(`   ${line}`);
    log('');
  };

  let browser = null;
  let server = null;
  let assistedExpired = false;
  const people = {};
  const shops = {};
  const pilots = [];
  try {
    // ───────── armado ─────────
    people.admin = await qaUser('mpadmin', { admin: true });
    people.ownerA = await qaUser('mptitulara');
    people.ownerB = await qaUser('mptitularb');
    people.buyer = await qaUser('mpcliente');
    shops.A = await qaBusiness(people.ownerA, people.admin, 'A');
    shops.B = await qaBusiness(people.ownerB, people.admin, 'B');
    evidence.ids.businesses = { A: shops.A.id, B: shops.B.id };
    // El piloto: sólo estos dos comercios, en sandbox. Nunca el interruptor global.
    await t.sql(`insert into private.payment_pilot_businesses (business_id, sandbox, reason) values
      (${uuid(shops.A.id)}, true, 'CAUCE QA · Mercado Pago'), (${uuid(shops.B.id)}, true, 'CAUCE QA · Mercado Pago')`);
    pilots.push(shops.A.id, shops.B.id);
    const afterPilot = await appStatus(t);
    record('con el piloto encendido, el interruptor global sigue apagado', afterPilot.features?.payments_online === false,
      String(afterPilot.features?.payments_online));

    if (mode !== 'asistido') {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: !process.env.DISPLAY });
      server = createStaticServer({ root: fileURLToPath(new URL('dist-production/', ROOT)), preview: true });
      await new Promise((done, fail) => { server.once('error', fail); server.listen(4174, '127.0.0.1', done); });
    }
    const newPage = async ({ width = 1280, height = 900 } = {}) => {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'es-AR',
        timezoneId: 'America/Argentina/Buenos_Aires' });
      return { context, page: await context.newPage() };
    };
    const ready = page => page.waitForFunction(() => document.querySelector('#main')?.getAttribute('aria-busy') === 'false',
      null, { timeout: 30000 });
    const go = async (page, hash) => {
      await page.evaluate(target => { location.hash = target; }, hash);
      await ready(page);
    };
    const signIn = async (page, person) => {
      await page.goto(`${LOCAL_SITE}/index.html#cuenta`);
      await ready(page);
      await page.fill('#signin-email', person.email);
      await page.fill('#signin-password', person.password);
      await page.click('form[data-form="sign-in"] button[type="submit"]');
      await page.waitForFunction(() => !location.hash.startsWith('#cuenta'), null, { timeout: 30000 });
      await ready(page);
    };

    // ───────── OAuth: conectar la cuenta de prueba de cada comercio ─────────
    async function connect(letter, owner, shop, account) {
      const label = `Vendedor ${letter}`;
      if (mode !== 'asistido') {
        const { context, page } = await newPage();
        // El código y el state de la vuelta se guardan sólo en memoria para
        // probar después que una vuelta repetida no conecta nada.
        let callback = null;
        page.on('request', request => {
          const url = request.url();
          if (url.startsWith(`${t.url}/functions/v1/payments-oauth?`)) {
            const params = new URL(url).searchParams;
            if (params.get('code')) { callback = { code: params.get('code'), state: params.get('state') }; hide(callback.code); hide(callback.state); }
          }
        });
        try {
          await signIn(page, owner);
          await go(page, `#panel/${shop.id}/pagos`);
          const button = page.locator('[data-action="payment-connect"]');
          await button.waitFor({ timeout: 30000 });
          await safeShot(page, shot(`panel-${letter}-antes-de-conectar`));
          await Promise.all([page.waitForURL(url => !url.href.startsWith(LOCAL_SITE), { timeout: 30000 }), button.click()]);
          const trace = evidence.trace[`oauth-${letter}`] = [];
          const result = await authorizeSeller(page, account, { siteUrl: SITE_URL, trace, timeoutMs: 240000 });
          const finalUrl = page.url();
          await safeShot(page, shot(`oauth-${letter}-vuelta`), { hideText: [account.user] });
          record(`OAuth ${label}: sin tokens en la URL final`, !/APP_USR|TEST-|TG-|access_token|refresh_token/i.test(finalUrl), 'URL revisada');
          return { result, via: 'navegador', callback };
        } catch (error) {
          if (!(error instanceof Blocked) || mode !== 'mixto') throw error;
          await safeShot(page, shot(`oauth-${letter}-frenado`), { hideText: [account.user] });
          note(`OAuth ${label}: navegador frenado`, `${error.reason} → paso asistido`);
        } finally {
          await context.close();
        }
      }
      return connectAssisted(letter, owner, shop);
    }
    async function connectAssisted(letter, owner, shop) {
      if (assistedExpired) return { result: null, via: 'asistido (sin persona)' };
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        const started = await callFunction('payments-oauth', { token: await owner.token(), body: { business: shop.id } });
        if (started.status !== 200) return { result: `inicio ${started.status}`, via: 'asistido' };
        const renew = Math.min(Date.now() + 9 * 60 * 1000, deadline);
        announce(`Conectar la cuenta de prueba "CAUCE QA Vendedor ${letter}" al comercio ${shop.name}`, [
          `1. Abrir en una ventana de incógnito: ${started.body.authorization_url}`,
          `2. Ingresar con la cuenta de prueba Vendedor ${letter} (usuario, contraseña y código: secretos MP_TEST_SELLER_${letter}_*).`,
          '3. Tocar "Autorizar". Termina en bitflowapp.github.io/cauce … conexion=ok.',
          `El enlace vale hasta las ${hhmm(renew)} UTC (después se imprime otro). Espera hasta las ${hhmm(deadline)} UTC.`,
        ]);
        const connected = await until(async () => (await accountRow(shop.id))?.status === 'connected',
          { timeout: renew - Date.now(), every: 5000 });
        if (connected) return { result: 'ok', via: 'asistido', callback: null };
      }
      assistedExpired = true;
      return { result: null, via: 'asistido (nadie completó el paso)' };
    }

    evidence.oauth = {};
    for (const [letter, owner, account] of [['A', people.ownerA, mp.SELLER_A], ['B', people.ownerB, mp.SELLER_B]]) await scenario(`OAuth ${letter}`, async () => {
      const shop = shops[letter];
      const outcome = await connect(letter, owner, shop, account);
      const row = await accountRow(shop.id);
      evidence.oauth[letter] = { result: outcome.result, via: outcome.via, trace: evidence.trace[`oauth-${letter}`] || [] };
      evidence.ids[`seller${letter}`] = row?.provider_user_id || null;
      record(`OAuth Vendedor ${letter}: vuelve al panel conectado (${outcome.via})`, outcome.result === 'ok' && row?.status === 'connected',
        `resultado ${outcome.result ?? 'sin terminar'} · cuenta ${row?.status || 'sin fila'}`);
      if (row?.status !== 'connected') return;
      record(`Vendedor ${letter}: cuenta de prueba (live_mode = false en CAUCE)`, row.live_mode === false,
        `vendedor de prueba ${row.provider_user_id}`);
      const [sealed] = await t.sql(`select c.access_token_ciphertext ~ '^v[0-9]+\\.' and c.refresh_token_ciphertext ~ '^v[0-9]+\\.' as sealed,
          position('APP_USR' in c.access_token_ciphertext) = 0 and position('TG-' in c.refresh_token_ciphertext) = 0 as opaque
        from private.payment_provider_credentials c join public.payment_provider_accounts a on a.id = c.account_id
        where a.business_id = ${uuid(shop.id)}`);
      record(`Vendedor ${letter}: tokens cifrados en la base, nunca en claro`, sealed?.sealed === true && sealed?.opaque === true,
        'AES-GCM con versión de clave');
      // Una vuelta repetida (mismo code y state) no canjea nada: el state ya se usó.
      if (outcome.callback) {
        const replay = await callFunction('payments-oauth', { method: 'GET',
          query: `?${new URLSearchParams({ code: outcome.callback.code, state: outcome.callback.state })}` });
        record(`OAuth ${letter}: la vuelta repetida no conecta nada`, replay.status === 302 && /conexion=vencida$/.test(replay.location),
          replay.location.replace(/^.*#/, '#'));
      }
    });
    const connectedA = (await accountRow(shops.A.id))?.status === 'connected';
    const connectedB = (await accountRow(shops.B.id))?.status === 'connected';

    // Estados inválidos de la vuelta (no dependen del proveedor).
    await scenario('OAuth: vueltas inválidas', async () => {
      const wrong = await callFunction('payments-oauth', { method: 'GET',
        query: `?${new URLSearchParams({ code: 'TG-inventado', state: randomBytes(32).toString('base64url') })}` });
      record('OAuth: state incorrecto → no conecta', wrong.status === 302 && /conexion=vencida$/.test(wrong.location), wrong.location.replace(/^.*#/, '#'));
      const late = await callFunction('payments-oauth', { token: await people.ownerA.token(), body: { business: shops.A.id } });
      if (late.status === 200) {
        const state = new URL(late.body.authorization_url).searchParams.get('state');
        hide(state);
        record('OAuth: redirect_uri exacta y PKCE S256 en la autorización',
          new URL(late.body.authorization_url).searchParams.get('redirect_uri') === `${t.url}/functions/v1/payments-oauth`
          && new URL(late.body.authorization_url).searchParams.get('code_challenge_method') === 'S256'
          && new URL(late.body.authorization_url).hostname === 'auth.mercadopago.com.ar', 'auth.mercadopago.com.ar');
        await t.sql(`update private.payment_oauth_states set expires_at = now() - interval '1 minute' where state = '${state.replace(/[^A-Za-z0-9_-]/g, '')}'`);
        const expired = await callFunction('payments-oauth', { method: 'GET', query: `?${new URLSearchParams({ code: 'TG-cualquiera', state })}` });
        record('OAuth: state vencido → no conecta', /conexion=vencida$/.test(expired.location), expired.location.replace(/^.*#/, '#'));
        const cancel = await callFunction('payments-oauth', { token: await people.ownerA.token(), body: { business: shops.A.id } });
        const cancelState = new URL(cancel.body.authorization_url).searchParams.get('state');
        hide(cancelState);
        const denied = await callFunction('payments-oauth', { method: 'GET', query: `?${new URLSearchParams({ error: 'access_denied', state: cancelState })}` });
        record('OAuth: el vendedor cancela → cancelada y el state se quema', /conexion=cancelada$/.test(denied.location),
          denied.location.replace(/^.*#/, '#'));
      }
      const accountA = await accountRow(shops.A.id);
      record('las pruebas de vuelta no tocaron la cuenta conectada', !connectedA || accountA?.status === 'connected', accountA?.status || 'sin fila');
    });

    // El panel muestra lo real: conectado, vendedor de prueba y modo de prueba.
    if (browser && connectedA) await scenario('panel conectado', async () => {
      const { context, page } = await newPage();
      try {
        await signIn(page, people.ownerA);
        await go(page, `#panel/${shops.A.id}/pagos`);
        const text = await page.locator('.pay-panel').innerText();
        record('panel A: conectado, cuenta vendedora de prueba y aviso de modo de prueba',
          /Conectado/.test(text) && /modo de prueba/i.test(text) && text.includes(String(evidence.ids.sellerA)), 'sección Pagos');
        await safeShot(page, shot('panel-A-conectado'));
      } finally { await context.close(); }
    });

    // ───────── pagos ─────────
    const buyerToken = () => people.buyer.token();
    async function onlineOrder(shop) {
      return must(await people.buyer.client.rpc('create_order', { business: shop.id, idem: randomUUID(), fulfillment: 'pickup',
        payment_method: 'online', contact: { name: 'Cliente QA', phone: '2942401122', notes: '', address: '' },
        items: [{ product_id: shop.product, quantity: 2 }], expected_total: null }), 'pedido online');
    }
    // Paga una orden en Checkout Pro con la tarjeta de prueba. Por la UI de
    // CAUCE (pedido desde el comercio, pago online) o, en modo asistido, con
    // el pedido creado igual que la app y la dirección del checkout impresa.
    async function pay(shop, outcome, label) {
      const holder = HOLDER[outcome];
      if (mode !== 'asistido') {
        const { context, page } = await newPage({ width: 390, height: 844 });
        let orderId = null;
        try {
          await signIn(page, people.buyer);
          await go(page, `#comercio/${shop.id}`);
          const card = page.locator('article.product-card', { has: page.locator('h3:text-is("Yerba QA")') });
          await card.getByRole('button', { name: 'Agregar' }).click();
          await ready(page);
          await card.getByRole('button', { name: 'Agregar una unidad' }).click();
          await ready(page);
          await page.locator('.sticky-cart-bar a.button').click();
          await ready(page);
          await page.locator('a.button-continue').click();
          await ready(page);
          await page.fill('#checkout-name', 'Cliente QA');
          await page.fill('#checkout-phone', '2942 401122');
          await page.locator('label.pay-method', { has: page.locator('input[name="paymentMethod"][value="online"]') }).click();
          await page.waitForFunction(() => document.querySelector('input[name="paymentMethod"][value="online"]')?.checked === true,
            null, { timeout: 10000 });
          await safeShot(page, shot(`checkout-${label}-cauce`));
          await Promise.all([page.waitForURL(url => !url.href.startsWith(LOCAL_SITE), { timeout: 45000 }),
            page.locator('button.button-confirm-order').click()]);
          const [latest] = await t.sql(`select id::text as id from public.orders where customer_id = ${uuid(people.buyer.id)}
            and business_id = ${uuid(shop.id)} order by created_at desc limit 1`);
          orderId = latest?.id || null;
          const trace = evidence.trace[`pago-${label}`] = [];
          const shown = await payCheckout(page, { holder, buyer: mp.BUYER, siteUrl: SITE_URL, trace, timeoutMs: 300000 });
          await safeShot(page, shot(`pago-${label}-resultado`), { hideText: [mp.BUYER.user] });
          return { orderId, shown, via: 'navegador', returnedTo: page.url().startsWith(SITE_URL) ? page.url().replace(/\?.*$/, '') : null };
        } catch (error) {
          if (!(error instanceof Blocked) || mode !== 'mixto') throw error;
          await safeShot(page, shot(`pago-${label}-frenado`), { hideText: [mp.BUYER.user] });
          note(`pago ${label}: navegador frenado`, `${error.reason} → paso asistido`);
          if (orderId) return payAssisted(shop, outcome, label, orderId);
        } finally { await context.close(); }
      }
      return payAssisted(shop, outcome, label, null);
    }
    async function payAssisted(shop, outcome, label, existing) {
      if (assistedExpired) return { orderId: existing, shown: null, via: 'asistido (sin persona)' };
      const orderId = existing || await onlineOrder(shop);
      const started = await callFunction('payments-checkout', { token: await buyerToken(), body: { order_id: orderId, flow: 'checkout_pro' } });
      if (started.status !== 200) return { orderId, shown: null, via: `asistido (checkout ${started.status})` };
      const [attempt] = (await attemptsOf(orderId)).slice(-1);
      const deadline = Date.now() + 15 * 60 * 1000;
      announce(`Pagar el pedido de prueba (${label}) en Checkout Pro`, [
        `1. Abrir: ${started.body.checkout_url}`,
        `2. Tarjeta de crédito de prueba ${TEST_CARD.number.replace(/(\d{4})/g, '$1 ').trim()} · CVV ${TEST_CARD.cvv} · vence ${TEST_CARD.expiry}`
          + ` · titular ${HOLDER[outcome]} · DNI ${TEST_CARD.docNumber} · e-mail ${SANDBOX_EMAIL}`,
        '   (o ingresar con la cuenta de prueba Comprador: secretos MP_TEST_BUYER_*).',
        '3. Confirmar el pago y esperar la pantalla del resultado.',
        `Espera hasta las ${hhmm(deadline)} UTC.`,
      ]);
      const moved = await until(async () => (await eventsOf(attempt.provider_order_id)).some(event => event.outcome === 'applied'
        || event.outcome === 'flagged'), { timeout: deadline - Date.now(), every: 5000 });
      if (!moved) assistedExpired = true;
      return { orderId, shown: moved ? outcome : null, via: 'asistido' };
    }
    // Espera lo que registra la base a partir del webhook (nunca del navegador).
    async function settle(orderId, wanted) {
      return until(async () => {
        const [attempt] = (await attemptsOf(orderId)).slice(-1);
        if (!attempt?.provider_order_id) return null;
        const events = await eventsOf(attempt.provider_order_id);
        return events.some(event => event.outcome === 'applied' || event.outcome === 'flagged') && wanted.includes(attempt.status)
          ? { attempt, events } : null;
      });
    }

    evidence.payments = {};
    if (connectedA) {
      // 1) Aprobado: webhook firmado → la función lee la orden → aprobado → el comercio acepta.
      await scenario('pago aprobado', async () => {
      const approved = await pay(shops.A, 'approved', 'aprobado');
      evidence.payments.approved = { via: approved.via, shown: approved.shown, returnedTo: approved.returnedTo || null,
        trace: evidence.trace['pago-aprobado'] || [] };
      const settledOk = approved.orderId ? await settle(approved.orderId, ['approved']) : null;
      if (settledOk) {
        const order = await orderRow(approved.orderId);
        evidence.ids.approved = { order: approved.orderId, attempt: settledOk.attempt.id, providerOrder: settledOk.attempt.provider_order_id };
        evidence.webhook.approved = settledOk.events;
        record('aprobado: orden de prueba (ORDTST…) creada con el importe del pedido', /^ORDTST/.test(settledOk.attempt.provider_order_id)
          && settledOk.attempt.amount === order.total, `${settledOk.attempt.provider_order_id} · $${order.total}`);
        record('aprobado: llegó el webhook firmado y la base quedó aprobada', order.payment_status === 'approved',
          `${settledOk.events.length} notificación(es) · ${settledOk.events.map(event => `${event.action || 'sin acción'}:${event.outcome}`).join(', ')}`);
        const movements = await t.sql(`select kind, status, amount_ars::int as amount, provider_transaction_id is not null as has_id
          from public.payment_transactions where attempt_id = ${uuid(settledOk.attempt.id)}`);
        record('aprobado: el movimiento sale de la API de Orders (id y monto del proveedor)',
          movements.some(movement => movement.kind === 'payment' && movement.status === 'approved' && movement.amount === order.total),
          movements.map(movement => `${movement.kind}/${movement.status}/$${movement.amount}`).join(', ') || 'sin movimientos');
        // El comercio procesa el pedido desde el panel, sin tocar la base.
        if (browser) {
          const { context, page } = await newPage();
          try {
            await signIn(page, people.ownerA);
            await go(page, `#panel/${shops.A.id}/pedidos`);
            const card = page.locator(`article[aria-label="Pedido ${order.code}"]`);
            await card.waitFor({ timeout: 30000 });
            await card.getByRole('button', { name: 'Aceptar', exact: true }).click();
            await ready(page);
            await go(page, `#panel/${shops.A.id}/pagos`);
            // El número sale de la base (business_payment_overview): nunca uno de ejemplo.
            const tile = page.locator('.pay-panel .metric', { hasText: 'Pagos aprobados' }).locator('.metric-value');
            const approvedToday = Number((await tile.innerText()).replace(/\D/g, ''));
            record('panel A: el cobro aprobado figura entre los pagos del día', approvedToday >= 1, `${approvedToday} aprobado(s)`);
            await safeShot(page, shot('panel-A-cobro-aprobado'));
          } finally { await context.close(); }
        } else {
          must(await people.ownerA.client.rpc('transition_order', { order_id: approved.orderId, expected_version: null,
            next_status: 'accepted', rider: null, reason: '' }), 'aceptar');
        }
        record('el comercio aceptó el pedido pagado desde el panel (sin tocar la base)',
          (await orderRow(approved.orderId)).status === 'accepted', (await orderRow(approved.orderId)).status);
      } else {
        record('aprobado: webhook y aprobación en la base', false, approved.orderId ? 'no llegó a tiempo' : 'sin pedido');
      }
      });

      // 2) Idempotencia real: doble toque concurrente y reenvío idéntico al proveedor.
      await scenario('idempotencia', async () => {
        const orderId = await onlineOrder(shops.A);
        const [first, second] = await Promise.all([
          callFunction('payments-checkout', { token: await buyerToken(), body: { order_id: orderId, flow: 'checkout_pro' } }),
          callFunction('payments-checkout', { token: await buyerToken(), body: { order_id: orderId, flow: 'checkout_pro' } })]);
        const attempts = await attemptsOf(orderId);
        const same = first.status === 200 && second.status === 200 && first.body?.checkout_url === second.body?.checkout_url;
        record('idempotencia: doble toque → un intento, una orden, el mismo checkout',
          attempts.length === 1 && Boolean(attempts[0].provider_order_id) && (same || [first.status, second.status].includes(503)),
          `${attempts.length} intento · ${attempts[0]?.provider_order_id || 'sin orden'} · respuestas ${first.status}/${second.status}`);
        if (attempts[0]?.provider_order_id) {
          const replay = await callFunction('payments-checkout', { token: serviceJwt, body: { action: 'replay_order', attempt_id: attempts[0].id } });
          evidence.idempotency = { replay: replay.body, status: replay.status, order: attempts[0].provider_order_id };
          const noNewOrder = replay.status === 200 && (replay.body?.same_order === true
            || replay.body?.provider_code === 'idempotency_key_already_used');
          record('idempotencia: reenvío con la misma clave al proveedor real → ninguna orden nueva', noNewOrder,
            `HTTP ${replay.body?.http_status ?? replay.status} · misma orden ${replay.body?.same_order} · ${replay.body?.provider_code || 'sin error'}`);
        }
      });

      // 3) Rechazado: no se acepta, se explica y se puede reintentar con otro intento.
      await scenario('pago rechazado', async () => {
      const rejected = await pay(shops.A, 'rejected', 'rechazado');
      evidence.payments.rejected = { via: rejected.via, shown: rejected.shown, trace: evidence.trace['pago-rechazado'] || [] };
      const settledRejected = rejected.orderId ? await settle(rejected.orderId, ['rejected']) : null;
      if (settledRejected) {
        const order = await orderRow(rejected.orderId);
        record('rechazado: el pedido queda con el pago rechazado y sin aceptar', order.payment_status === 'rejected' && order.status === 'submitted',
          `${order.payment_status} · ${order.status}`);
        const accept = await people.ownerA.client.rpc('transition_order', { order_id: rejected.orderId, expected_version: null,
          next_status: 'accepted', rider: null, reason: '' });
        record('rechazado: el comercio no puede aceptarlo', Boolean(accept.error), accept.error?.code || 'se aceptó');
        const retry = await callFunction('payments-checkout', { token: await buyerToken(), body: { order_id: rejected.orderId, flow: 'checkout_pro' } });
        const attempts = await attemptsOf(rejected.orderId);
        record('rechazado: reintentar crea otro intento con otra clave y otra orden de prueba', retry.status === 200 && attempts.length === 2
          && attempts[1].key !== attempts[0].key && attempts[1].provider_order_id !== attempts[0].provider_order_id,
          `${attempts.length} intentos`);
        evidence.webhook.rejected = settledRejected.events;
      } else {
        record('rechazado: webhook y estado en la base', false, rejected.orderId ? 'no llegó a tiempo' : 'sin pedido');
      }
      });

      // 4) Pendiente: el pedido espera; el comercio no puede aceptarlo.
      await scenario('pago pendiente', async () => {
      const pending = await pay(shops.A, 'pending', 'pendiente');
      evidence.payments.pending = { via: pending.via, shown: pending.shown, trace: evidence.trace['pago-pendiente'] || [] };
      const settledPending = pending.orderId ? await settle(pending.orderId, ['pending', 'processing']) : null;
      if (settledPending) {
        const order = await orderRow(pending.orderId);
        record('pendiente: pago en proceso, pedido sin aceptar', ['pending', 'processing'].includes(order.payment_status) && order.status === 'submitted',
          `${settledPending.attempt.status} · ${order.status}`);
        const accept = await people.ownerA.client.rpc('transition_order', { order_id: pending.orderId, expected_version: null,
          next_status: 'accepted', rider: null, reason: '' });
        record('pendiente: el comercio no puede aceptarlo hasta que se apruebe', Boolean(accept.error), accept.error?.code || 'se aceptó');
        evidence.webhook.pending = settledPending.events;
      } else {
        record('pendiente: webhook y estado en la base', false, pending.orderId ? 'no llegó a tiempo' : 'sin pedido');
      }
      });

      // 5) Importe distinto (sólo automático): el intento dice otra cosa que lo cobrado → para revisar, nunca aprobado.
      if (mode === 'automatico' || (mode === 'mixto' && !assistedExpired && evidence.payments.approved?.via === 'navegador')) await scenario('importe distinto', async () => {
        const orderId = await onlineOrder(shops.A);
        const started = await callFunction('payments-checkout', { token: await buyerToken(), body: { order_id: orderId, flow: 'checkout_pro' } });
        const [attempt] = await attemptsOf(orderId);
        if (started.status === 200 && attempt) {
          // Simulación de una inconsistencia: la orden del proveedor ya existe con el importe real.
          await t.sql(`update public.payment_attempts set amount_ars = amount_ars + 1 where id = ${uuid(attempt.id)}`);
          const { context, page } = await newPage({ width: 390, height: 844 });
          try {
            await page.goto(started.body.checkout_url);
            evidence.trace['pago-importe'] = [];
            await payCheckout(page, { holder: HOLDER.approved, buyer: mp.BUYER, siteUrl: SITE_URL, trace: evidence.trace['pago-importe'] });
          } catch (error) {
            if (!(error instanceof Blocked)) throw error;
          } finally { await context.close(); }
          const flagged = await until(async () => (await eventsOf(attempt.provider_order_id)).find(event => event.detail === 'amount_mismatch'));
          const order = await orderRow(orderId);
          record('importe distinto: queda para revisar y el pedido no figura pagado', Boolean(flagged) && order.payment_status !== 'approved',
            `${flagged?.outcome || 'sin aviso'} · ${order.payment_status}`);
        }
      }); else {
        note('importe distinto contra el proveedor real', 'omitido (modo asistido): lo cubren las pruebas de las funciones con el doble');
      }
    }

    // ───────── webhook: firma falsa o ausente → 401 y cero cambios ─────────
    await scenario('webhooks inválidos', async () => {
      const target = evidence.ids.approved?.providerOrder || 'ORDTST01SINORDEN';
      const before = await eventCount();
      const body = JSON.stringify({ id: String(Date.now()), live_mode: false, type: 'order', action: 'order.processed',
        user_id: Number(evidence.ids.sellerA || 1), api_version: 'v1', data: { id: target } });
      const post = headers => fetch(`${t.url}/functions/v1/payments-webhook?data.id=${target}&type=order`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-request-id': randomUUID(), ...headers }, body });
      const forged = await post({ 'x-signature': `ts=${Date.now()},v1=${'0'.repeat(64)}` });
      const unsigned = await post({});
      await sleep(3000);
      record('webhook con firma falsa → 401', forged.status === 401, String(forged.status));
      record('webhook sin firma → 401', unsigned.status === 401, String(unsigned.status));
      record('webhooks inválidos: cero notificaciones anotadas', (await eventCount()) === before, 'sin cambios');
      if (evidence.ids.approved) {
        const order = await orderRow(evidence.ids.approved.order);
        record('webhooks inválidos: el pedido aprobado sigue igual', order.payment_status === 'approved', order.payment_status);
      }
    });

    // ───────── aislamiento entre comercios y personas ─────────
    await scenario('aislamiento', async () => {
      const b = people.ownerB.client;
      const foreignAttempts = await b.from('payment_attempts').select('id').eq('business_id', shops.A.id);
      record('B no ve los intentos de A', (foreignAttempts.data || []).length === 0, `${(foreignAttempts.data || []).length} filas`);
      const foreignAccount = await b.from('payment_provider_accounts').select('id').eq('business_id', shops.A.id);
      record('B no ve la cuenta de A', (foreignAccount.data || []).length === 0, `${(foreignAccount.data || []).length} filas`);
      const overview = await b.rpc('business_payment_overview', { business: shops.A.id });
      record('B no lee el resumen de pagos de A', Boolean(overview.error) || !overview.data, overview.error?.code || 'vacío');
      const disconnect = await b.rpc('disconnect_payment_account', { business: shops.A.id, provider: 'mercadopago' });
      record('B no puede desconectar a A', Boolean(disconnect.error), disconnect.error?.code || 'desconectó');
      record('A sigue conectada', !connectedA || (await accountRow(shops.A.id))?.status === 'connected', (await accountRow(shops.A.id))?.status || 'sin fila');
      const anon = createClient(t.url, t.publishableKey, clientOptions);
      for (const table of ['payment_attempts', 'payment_transactions', 'payment_provider_accounts']) {
        const read = await anon.from(table).select('*').limit(1);
        record(`una visita no lee ${table}`, Boolean(read.error) || (read.data || []).length === 0, read.error?.code || `${(read.data || []).length} filas`);
      }
      const credentials = await fetch(`${t.url}/rest/v1/payment_provider_credentials?select=*`, {
        headers: { apikey: t.publishableKey, Authorization: `Bearer ${await people.ownerA.token()}` } });
      record('ni el titular lee las credenciales (esquema privado)', !credentials.ok, `HTTP ${credentials.status}`);
      const stranger = await qaUser('mpextrano');
      if (evidence.ids.approved) {
        const other = await stranger.client.from('payment_attempts').select('id').eq('order_id', evidence.ids.approved.order);
        record('otra persona no ve el pago de un pedido ajeno', (other.data || []).length === 0, `${(other.data || []).length} filas`);
      }
    });

    // ───────── renovación de tokens contra el proveedor real ─────────
    if (connectedA || connectedB) await scenario('renovación', async () => {
      const before = await t.sql(`select a.business_id::text as business, c.expires_at::text as expires, md5(c.access_token_ciphertext) as fingerprint
        from private.payment_provider_credentials c join public.payment_provider_accounts a on a.id = c.account_id
        where a.business_id in (${uuid(shops.A.id)}, ${uuid(shops.B.id)})`);
      const denied = await callFunction('payments-oauth', { token: await people.ownerA.token(), body: { action: 'refresh_due', within_days: 200 } });
      record('renovación programada: sólo con la clave de servicio', denied.status === 401, String(denied.status));
      const swept = await callFunction('payments-oauth', { token: serviceJwt, body: { action: 'refresh_due', within_days: 200 } });
      const after = await t.sql(`select a.business_id::text as business, c.expires_at::text as expires, md5(c.access_token_ciphertext) as fingerprint
        from private.payment_provider_credentials c join public.payment_provider_accounts a on a.id = c.account_id
        where a.business_id in (${uuid(shops.A.id)}, ${uuid(shops.B.id)})`);
      const rotated = after.filter(row => {
        const old = before.find(item => item.business === row.business);
        return old && old.fingerprint !== row.fingerprint && Date.parse(row.expires) >= Date.parse(old.expires);
      });
      evidence.refresh = swept.body;
      record('renovación con el proveedor real: token nuevo cifrado y vencimiento actualizado', swept.status === 200
        && rotated.length === before.length && before.length > 0, `${JSON.stringify(swept.body)} · ${rotated.length}/${before.length} rotados`);
    });

    // ───────── desconexión: el online desaparece y el efectivo sigue ─────────
    if (connectedB) await scenario('desconexión', async () => {
      must(await people.ownerB.client.rpc('disconnect_payment_account', { business: shops.B.id, provider: 'mercadopago' }), 'desconectar B');
      const methods = must(await createClient(t.url, t.publishableKey, clientOptions).rpc('payment_methods', { business: shops.B.id }), 'medios')
        .map(method => method.id);
      record('B desconectada: sin pago online y con efectivo', !methods.includes('online') && methods.includes('cash_on_pickup'), methods.join(', '));
      const online = await people.buyer.client.rpc('create_order', { business: shops.B.id, idem: randomUUID(), fulfillment: 'pickup',
        payment_method: 'online', contact: { name: 'Cliente QA', phone: '2942401122', notes: '', address: '' },
        items: [{ product_id: shops.B.product, quantity: 2 }], expected_total: null });
      record('B desconectada: un pedido online se rechaza', Boolean(online.error), online.error?.code || 'se creó');
      const cash = await people.buyer.client.rpc('create_order', { business: shops.B.id, idem: randomUUID(), fulfillment: 'pickup',
        payment_method: 'cash_on_pickup', contact: { name: 'Cliente QA', phone: '2942401122', notes: '', address: '' },
        items: [{ product_id: shops.B.product, quantity: 2 }], expected_total: null });
      record('B desconectada: el pedido en efectivo sigue funcionando', !cash.error, cash.error?.message || 'creado');
      if (browser) {
        const { context, page } = await newPage();
        try {
          await signIn(page, people.ownerB);
          await go(page, `#panel/${shops.B.id}/pagos`);
          record('panel B: pide volver a conectar', await page.locator('[data-action="payment-connect"]').count() > 0, 'botón Conectar');
          await safeShot(page, shot('panel-B-desconectado'));
        } finally { await context.close(); }
      }
    });

    // ───────── nunca dinero real ─────────
    await scenario('nunca dinero real', async () => {
      const [real] = await t.sql(`select
        (select count(*)::int from public.payment_attempts where provider_order_id is not null and provider_order_id !~ '^ORDTST') as orders,
        (select count(*)::int from public.payment_provider_accounts where live_mode is distinct from false and status = 'connected') as accounts,
        (select count(*)::int from private.payment_events where resource_type = 'order' and resource_id !~ '^ORDTST') as events`);
      record('ninguna orden real: todas ORDTST…', Number(real.orders) === 0 && Number(real.events) === 0, `${real.orders} intentos · ${real.events} avisos`);
      record('ninguna cuenta real conectada', Number(real.accounts) === 0, String(real.accounts));
      const [raw] = await t.sql(`select string_agg(distinct coalesce(live_mode::text, 'sin dato'), ', ') as values
        from private.payment_events where received_at > ${`'${evidence.started}'`}::timestamptz`);
      note('live_mode informado por el proveedor en los avisos (cuentas de prueba con credenciales productivas)', raw?.values || 'sin avisos');
      const final = await appStatus(t);
      record('pagos globales siguen apagados', final.features?.payments_online === false, String(final.features?.payments_online));
    });

    // ───────── registros: ningún token ni tarjeta en las funciones ─────────
    try {
      const sql = `select count() as n from logs where source in ('function_logs', 'function_edge_logs')
        and match(event_message, 'APP_USR-[0-9]|TEST-[0-9]{6}|TG-[0-9a-f]{8}|5031 ?7557 ?3453 ?0604|refresh_token|access_token')`;
      const query = new URLSearchParams({ sql, iso_timestamp_start: evidence.started, iso_timestamp_end: new Date().toISOString() });
      const logs = await t.management(`/analytics/endpoints/logs?${query}`);
      const hits = Number(logs?.result?.[0]?.n ?? NaN);
      record('registros de las funciones sin tokens ni tarjetas', hits === 0, Number.isNaN(hits) ? JSON.stringify(logs?.error || 'sin datos').slice(0, 120) : `${hits} coincidencias`);
    } catch (error) {
      record('registros de las funciones sin tokens ni tarjetas', false, `no se pudieron consultar: ${String(error.message).slice(0, 120)}`);
    }
  } finally {
    // ───────── limpieza: sin piloto, sin credenciales, sin comercios ni cuentas QA ─────────
    const cleanup = [];
    try {
      if (pilots.length) await t.sql(`delete from private.payment_pilot_businesses where business_id in (${pilots.map(uuid).join(', ')})`);
      cleanup.push(`${pilots.length} pilotos apagados`);
      if (created.businesses.length) {
        const ids = created.businesses.map(uuid).join(', ');
        await t.sql(`delete from private.payment_provider_credentials c using public.payment_provider_accounts a
          where a.id = c.account_id and a.business_id in (${ids})`);
        for (const id of created.businesses) {
          if (people.admin) await people.admin.client.rpc('admin_set_business_status', { business: id, next_status: 'suspended', note: 'Fin del sandbox de pagos' });
        }
        await t.sql(`delete from public.orders where business_id in (${ids})`);
        await t.sql(`delete from public.businesses where id in (${ids})`);
        cleanup.push(`${created.businesses.length} comercios QA (con sus pedidos, intentos y cuentas) borrados`);
      }
      for (const id of created.users) await service?.auth.admin.deleteUser(id);
      cleanup.push(`${created.users.length} cuentas QA borradas`);
    } catch (error) {
      cleanup.push(`falló la limpieza: ${String(error.message).slice(0, 160)}`);
    }
    await browser?.close().catch(() => {});
    await new Promise(done => (server ? server.close(() => done()) : done()));
    const [residue] = await t.sql(`select
      (select count(*)::int from private.payment_pilot_businesses) as pilots,
      (select count(*)::int from public.businesses where slug like '${QA_SLUG}%') as businesses,
      (select count(*)::int from auth.users where email like 'cauce-qa-${run}-%') as users,
      (select count(*)::int from public.payment_provider_accounts a join public.businesses b on b.id = a.business_id
        where b.slug like '${QA_SLUG}%') as accounts,
      (select count(*)::int from private.payment_events where received_at > '${evidence.started}'::timestamptz) as events`);
    record('limpieza: sin pilotos', Number(residue.pilots) === 0, String(residue.pilots));
    record('limpieza: sin comercios QA de pagos', Number(residue.businesses) === 0, String(residue.businesses));
    record('limpieza: sin cuentas QA de esta corrida', Number(residue.users) === 0, String(residue.users));
    record('limpieza: sin cuentas ni credenciales del proveedor', Number(residue.accounts) === 0, String(residue.accounts));
    note('residuo esperado', `${residue.events} avisos del proveedor en private.payment_events (ids ORDTST… y resultado, sin datos personales); `
      + 'en Mercado Pago quedan las cuentas de prueba (no se pueden borrar) y sus órdenes de prueba');
    const final = await appStatus(t);
    record('al terminar, pagos globales apagados', final.features?.payments_online === false, String(final.features?.payments_online));
    evidence.cleanup = cleanup;
    evidence.finished = new Date().toISOString();
    await writeFile(new URL('resultado.json', EVIDENCE), JSON.stringify(evidence, null, 2));
  }
}
