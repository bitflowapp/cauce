// Smoke obligatorio después de publicar, sobre el sitio PUBLICADO y el proyecto
// real: visita, compra sin cuenta y con cuenta, retiro y envío atendidos por
// titular y encargado, seguimiento por enlace, seguridad (panel sin sesión,
// comercio ajeno, precio y estado manipulados), 320–1440 px, Chromium y
// WebKit. Usa sólo dos comercios "CAUCE QA" creados para la corrida y los
// borra al final (también si algo falla).
//
//   SUPABASE_ACCESS_TOKEN=… npm run smoke:publicado
//   CAUCE_SMOKE_LOCAL=1 npm run smoke:publicado     ensayo contra build y stack locales
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { LOCAL, cleanup, ok, orderRow, qaAccount, qaBusiness, t } from './qa.mjs';
import {
  SITE, engines, go, launch, layoutIssues, open, person, ready, report, shot, signIn, startSite, stopSite,
} from './navegador.mjs';

const people = {};
let A;
let B;
let setupError = null;
const results = [];

before(async () => {
  await startSite();
  // Primero: el sitio publicado tiene que ser el build conectado a este proyecto.
  const html = await (await fetch(`${SITE}/index.html`)).text();
  if (html.includes("connect-src 'none'")) throw new Error(`${SITE} publica la demostración, no el build conectado.`);
  if (!html.includes(new URL(t.url).host)) throw new Error(`${SITE} no apunta al proyecto ${t.ref}.`);
  try {
    people.admin = await qaAccount('admin', { admin: true });
    for (const role of ['owner', 'manager', 'staff', 'ownerb', 'cliente']) people[role] = await qaAccount(role);
    A = await qaBusiness(people.owner, people.admin, { label: 'Almacen', manager: people.manager, staff: people.staff });
    B = await qaBusiness(people.ownerb, people.admin, { label: 'Otro' });
  } catch (error) { setupError = error; throw error; }
});

after(async () => {
  let cleaned = 'sin limpieza';
  try { cleaned = await cleanup(people.admin); } finally {
    await report('smoke-publicado', { at: new Date().toISOString(), site: SITE, project: t.ref, local: LOCAL, results, cleaned,
      setupError: setupError?.message || null });
    await stopSite();
    // Conexiones abiertas mantendrían vivo el proceso de pruebas.
    await t.close();
  }
  console.log(`Limpieza: ${cleaned}`);
});

async function addToCart(page, productName, times = 1) {
  const card = page.locator('article.product-card', { has: page.locator(`h3:text-is("${productName}")`) });
  await card.getByRole('button', { name: 'Agregar' }).click();
  await ready(page);
  for (let i = 1; i < times; i += 1) {
    await card.getByRole('button', { name: 'Agregar una unidad' }).click();
    await ready(page);
  }
}

async function checkout(page, { fulfillment = 'pickup', name = 'Vecina QA', address = '' } = {}) {
  const bar = page.locator('.sticky-cart-bar a.button');
  await bar.waitFor({ timeout: 30000 });
  const box = await page.evaluate(() => {
    const cart = document.querySelector('.sticky-cart-bar')?.getBoundingClientRect();
    const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
    return cart && { top: cart.top, bottom: cart.bottom, nav: nav && getComputedStyle(document.querySelector('.bottom-nav')).display !== 'none' ? nav.top : innerHeight };
  });
  if (!box) await shot(page, `falla-carrito-${Date.now()}`);
  assert.ok(box && box.top >= 0 && box.bottom <= box.nav, `"Ver carrito" a la vista: ${JSON.stringify(box)} en ${await page.evaluate(() => location.hash)}`);
  await bar.click();
  await ready(page);
  if (fulfillment === 'delivery') {
    await page.locator('input[name="fulfillment"][value="delivery"]').check();
    await ready(page);
    await page.fill('#checkout-address', address);
    const zone = page.locator('input[name="zoneAcknowledged"]');
    if (await zone.count()) await zone.check();
  }
  await page.fill('#checkout-name', name);
  await page.fill('#checkout-phone', '2942 401122');
  await page.locator('button.button-confirm-order').click();
  await page.waitForFunction(() => location.hash.startsWith('#pedido/'), null, { timeout: 30000 });
  await ready(page);
  const id = await page.evaluate(() => location.hash.split('/')[1]);
  const code = (await page.locator('.page-header .eyebrow').textContent()).replace('PEDIDO', '').trim();
  return { id, code };
}

async function panelAction(page, code, label) {
  const card = page.locator(`article[aria-label="Pedido ${code}"]`);
  await card.waitFor({ timeout: 30000 });
  await card.getByRole('button', { name: label, exact: true }).click();
  await ready(page);
}

const record = (name, ok) => results.push({ name, ok });

for (const engine of engines) {
  test(`${engine}: visita, compra sin cuenta con retiro, atención del titular y seguimiento`, async () => {
    const browser = await launch(engine);
    try {
      const visitor = await person(browser, { label: 'visita' });
      const tracker = await person(browser, { label: 'otro dispositivo' });
      const owner = await person(browser, { width: 1280, height: 900, label: 'titular' });
      const v = visitor.page;
      await open(v, '#inicio');
      await go(v, '#comercios');
      await v.locator('a.catalog-merchant-card', { hasText: A.name }).click();
      await ready(v);
      await addToCart(v, 'Yerba QA', 2);
      const order = await checkout(v);
      const row = await orderRow(order.id);
      assert.deepEqual({ total: row.total, status: row.status }, { total: 3000, status: 'submitted' },
        'el servidor cobró 2 × 1.500 y sin envío');
      const tracking = await v.locator('[data-action="copy-tracking"]').getAttribute('data-url');
      assert.ok(tracking.startsWith(SITE), 'el enlace de seguimiento es del sitio publicado');

      await signIn(owner.page, people.owner);
      await go(owner.page, `#panel/${A.id}`);
      for (const label of ['Aceptar', 'Informar preparación', 'Listo para retirar']) await panelAction(owner.page, order.code, label);
      await v.locator('.timeline-step.current', { hasText: 'Listo para retirar' }).waitFor({ timeout: 30000 });
      await tracker.page.goto(tracking);
      await ready(tracker.page);
      assert.ok(await tracker.page.locator('.timeline-step.current', { hasText: 'Listo para retirar' }).isVisible());
      assert.equal(await tracker.page.getByText('Vecina QA').count(), 0, 'el seguimiento no muestra datos personales');
      await panelAction(owner.page, order.code, 'Marcar retirado');
      await v.locator('.timeline-step.current', { hasText: 'Retirado' }).waitFor({ timeout: 30000 });
      await shot(v, `${engine}-publicado-pedido-retirado`);
      assert.deepEqual([...visitor.problems, ...tracker.problems, ...owner.problems], []);
      record(`${engine}: compra sin cuenta y retiro`, true);
    } finally { await browser.close(); }
  });

  test(`${engine}: cliente con cuenta, envío y reparto atendidos por el encargado`, async () => {
    const browser = await launch(engine);
    try {
      const customer = await person(browser, { label: 'cliente' });
      const manager = await person(browser, { width: 1024, height: 900, label: 'encargado' });
      const c = customer.page;
      await signIn(c, people.cliente);
      await go(c, `#comercio/${A.id}`);
      await addToCart(c, 'Torta QA');
      const order = await checkout(c, { fulfillment: 'delivery', name: 'Cliente QA', address: 'Prueba interna 45' });
      const row = await orderRow(order.id);
      assert.deepEqual({ total: row.total, fee: row.fee, customer: row.customer },
        { total: 5900, fee: 900, customer: people.cliente.id });

      await signIn(manager.page, people.manager);
      await go(manager.page, `#panel/${A.id}`);
      const m = manager.page;
      for (const label of ['Aceptar', 'Informar preparación', 'Listo para enviar']) await panelAction(m, order.code, label);
      const card = m.locator(`article[aria-label="Pedido ${order.code}"]`);
      await card.locator('select[name="riderId"]').selectOption({ label: A.rider.name });
      await card.getByRole('button', { name: 'Asignar reparto' }).click();
      await ready(m);
      for (const label of ['Retirado por el reparto', 'Marcar salida', 'Marcar entregado']) await panelAction(m, order.code, label);
      await c.locator('.timeline-step.current', { hasText: 'Entregado' }).waitFor({ timeout: 30000 });
      await go(c, '#actividad');
      assert.ok(await c.getByText(order.code).first().isVisible(), 'el pedido figura en su actividad');
      assert.deepEqual([...customer.problems, ...manager.problems], []);
      record(`${engine}: cuenta, envío y reparto`, true);
    } finally { await browser.close(); }
  });

  test(`${engine}: 320, 390, 430, 1280 y 1440 px sin desbordes`, async () => {
    const browser = await launch(engine);
    try {
      const issues = [];
      // Una sesión por rol; el diseño responde al ancho con CSS, así que
      // alcanza con cambiar el tamaño de la ventana.
      const visitor = await person(browser, { label: 'visita' });
      const owner = await person(browser, { label: 'titular' });
      await open(visitor.page, '#inicio');
      await signIn(owner.page, people.owner);
      for (const width of [320, 390, 430, 1280, 1440]) {
        const size = { width, height: width < 900 ? 800 : 900 };
        await visitor.page.setViewportSize(size);
        for (const hash of ['#inicio', '#comercios', `#comercio/${A.id}`]) {
          await go(visitor.page, hash);
          for (const issue of await layoutIssues(visitor.page)) issues.push(`${width}px ${hash}: ${issue}`);
        }
        await owner.page.setViewportSize(size);
        await go(owner.page, `#panel/${A.id}`);
        for (const issue of await layoutIssues(owner.page)) issues.push(`${width}px panel: ${issue}`);
        if (width === 320 || width === 1440) {
          await shot(visitor.page, `${engine}-publicado-comercio-${width}`);
          await shot(owner.page, `${engine}-publicado-panel-${width}`);
        }
      }
      issues.push(...visitor.problems, ...owner.problems);
      assert.deepEqual(issues, []);
      record(`${engine}: anchos`, true);
    } finally { await browser.close(); }
  });
}

test('seguridad sobre el sitio y la API publicados', async () => {
  const browser = await launch(engines[0]);
  try {
    // Panel sin sesión, cliente y otro comercio: nadie entra al panel de A.
    const anonymous = await person(browser, { label: 'sin sesión' });
    await open(anonymous.page, `#panel/${A.id}`);
    assert.ok(await anonymous.page.getByText('Necesitás iniciar sesión.').isVisible());
    for (const who of ['cliente', 'ownerb']) {
      const intruder = await person(browser, { label: who });
      await signIn(intruder.page, people[who]);
      await go(intruder.page, `#panel/${A.id}`);
      assert.ok(await intruder.page.getByText('Ese comercio no pertenece a tu cuenta.').isVisible(), `${who} no entra al panel de A`);
      await go(intruder.page, '#admin');
      assert.ok(await intruder.page.getByText('Sección restringida.').isVisible(), `${who} no entra a administración`);
    }
    // Equipo: opera pedidos, no administra catálogo ni datos.
    const staff = await person(browser, { width: 1280, height: 900, label: 'equipo' });
    await signIn(staff.page, people.staff);
    await go(staff.page, `#panel/${A.id}`);
    assert.equal(await staff.page.locator('[data-action="set-panel-tab"][data-tab="datos"]').count(), 0);
    // Administración temporal de QA sí entra.
    const admin = await person(browser, { width: 1280, height: 900, label: 'administración' });
    await signIn(admin.page, people.admin);
    await go(admin.page, '#admin');
    assert.ok(await admin.page.getByRole('heading', { name: 'Administración' }).isVisible());
  } finally { await browser.close(); }

  // API: precio, estado, tabla directa y pedidos ajenos.
  const lines = [{ product_id: A.products.untracked.id, quantity: 1 }];
  const priced = await people.cliente.client.rpc('create_order', { business: A.id, idem: randomUUID(), fulfillment: 'pickup',
    payment_method: 'cash_on_pickup', contact: { name: 'Cliente QA', phone: '2942 401122', notes: '' }, items: lines, expected_total: 1 });
  assert.equal(priced.error?.code, 'U0005', 'un precio manipulado no crea el pedido');
  const id = ok(await people.cliente.client.rpc('create_order', { business: A.id, idem: randomUUID(), fulfillment: 'pickup',
    payment_method: 'cash_on_pickup', contact: { name: 'Cliente QA', phone: '2942 401122', notes: '' }, items: lines, expected_total: 1500 }), 'pedido');
  assert.ok((await people.cliente.client.from('orders').update({ total_ars: 1 }).eq('id', id)).error, 'el total no se escribe directo');
  const self = await people.cliente.client.rpc('transition_order', { order_id: id, expected_version: null, next_status: 'accepted', rider: null, reason: '' });
  assert.equal(self.error?.code, '42501', 'el cliente no acepta su propio pedido');
  const skip = await people.owner.client.rpc('transition_order', { order_id: id, expected_version: null, next_status: 'delivered', rider: null, reason: '' });
  assert.ok(skip.error, 'el comercio no salta estados');
  assert.deepEqual(ok(await people.ownerb.client.from('orders').select('id').eq('business_id', A.id), 'ajenos'), []);
  const visitor = createClient(t.url, t.publishableKey, { auth: { persistSession: false } });
  const anon = await visitor.from('orders').select('id').limit(1);
  assert.ok(anon.error || anon.data.length === 0, 'una visita no lee pedidos');
  assert.equal((await visitor.from('businesses').select('id').eq('id', B.id)).data?.length, 1, 'el catálogo publicado sí es público');
  ok(await people.owner.client.rpc('transition_order', { order_id: id, expected_version: null, next_status: 'canceled',
    rider: null, reason: 'Prueba de seguridad QA' }), 'rechazo con motivo');
  record('seguridad', true);
});
