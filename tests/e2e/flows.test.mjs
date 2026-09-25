// Recorridos completos en navegador real: cliente, comercio y seguridad.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  account, makeAdmin, publishedBusiness, closeAll, ok, sql, run,
  startPreview, stopPreview, browsersToRun, launch, person, open, go, ready, signIn, shot,
} from './harness.mjs';

const people = {};
let A, B;

before(async () => {
  await startPreview();
  for (const name of ['ownerA', 'staffA', 'ownerB', 'admin']) people[name] = await account(name);
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Panaderia Vista' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Almacen Ajeno' });
  ok(await people.ownerA.client.rpc('add_business_member', { business: A.id, member_email: people.staffA.email, member_role: 'staff' }));
});
after(async () => { await stopPreview(); await closeAll(Object.values(people)); });

const businessName = business => `${business === A ? 'Panaderia Vista' : 'Almacen Ajeno'} ${run}`;

async function addToCart(page, productName, times = 1) {
  const card = page.locator('article.product-card', { has: page.locator(`h3:text-is("${productName}")`) });
  await card.getByRole('button', { name: 'Agregar' }).click();
  await ready(page);
  for (let i = 1; i < times; i += 1) {
    await card.getByRole('button', { name: 'Agregar una unidad' }).click();
    await ready(page);
  }
}

async function checkout(page, { fulfillment = 'pickup', name = 'Vecina de Prueba', phone = '2942 401122', address = '' } = {}) {
  await page.locator('.sticky-cart-bar a.button').click();
  await ready(page);
  // El carrito muestra el total y lleva a la confirmación.
  await page.locator('a.button-continue').click();
  await ready(page);
  if (fulfillment === 'delivery') {
    await page.locator('input[name="fulfillment"][value="delivery"]').check();
    await ready(page);
    await page.fill('#checkout-address', address);
    const zone = page.locator('input[name="zoneAcknowledged"]');
    if (await zone.count()) await zone.check();
  }
  await page.fill('#checkout-name', name);
  await page.fill('#checkout-phone', phone);
  await page.locator('button.button-confirm-order').click();
  await page.waitForFunction(() => location.hash.startsWith('#pedido/'), null, { timeout: 20000 });
  await ready(page);
  return page.evaluate(() => location.hash.split('/')[1]);
}

async function panelAction(page, code, label) {
  const card = page.locator(`article[aria-label="Pedido ${code}"]`);
  await card.getByRole('button', { name: label, exact: true }).click();
  await ready(page);
}

for (const engine of browsersToRun) {
  test(`${engine}: compra con retiro sin cuenta; el comercio la atiende y el cliente lo ve en vivo`, async () => {
    const browser = await launch(engine);
    try {
      const customer = await person(browser, { label: 'cliente' });
      const merchant = await person(browser, { width: 1280, height: 900, label: 'comercio' });
      const c = customer.page;
      await open(c, '#inicio');
      assert.equal(await c.locator('a[href="#taxi"]:visible').count(), 0, 'taxi no aparece en producción');
      await c.getByRole('link', { name: 'Ver comercios' }).first().click();
      await ready(c);
      await c.locator('a.catalog-merchant-card', { hasText: businessName(A) }).click();
      await ready(c);
      await addToCart(c, 'Empanada de carne', 3);
      const orderId = await checkout(c);
      const code = (await c.locator('.page-header .eyebrow').textContent()).replace('PEDIDO', '').trim();
      assert.match(code, /^CA-\d{4,}$/);
      assert.ok(await c.getByText('Seguí tu pedido desde cualquier lugar').isVisible());
      const [{ total }] = await sql`select total_ars::int as total from public.orders where id = ${orderId}`;
      assert.equal(total, 3600, 'el servidor cobró 3 × 1.200 y sin envío');
      await shot(c, `${engine}-cliente-pedido-enviado`);

      // El comercio entra, ve el pedido nuevo y lo atiende.
      await signIn(merchant.page, people.ownerA);
      const m = merchant.page;
      await m.waitForFunction(() => /^#panel\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 20000 });
      await ready(m);
      // El inicio ya muestra el pedido nuevo; se atiende desde Pedidos.
      await m.locator(`article[aria-label="Pedido ${code}"]`).waitFor({ timeout: 15000 });
      await go(m, `${await m.evaluate(() => location.hash)}/pedidos`);
      const card = m.locator(`article[aria-label="Pedido ${code}"]`);
      await card.waitFor({ timeout: 15000 });
      assert.ok(await card.getByText('Vecina de Prueba').isVisible());
      await shot(m, `${engine}-comercio-pedido-nuevo`);
      await panelAction(m, code, 'Aceptar');
      // Sin recargar: el cambio llega por Realtime.
      await c.locator('.timeline-step.current', { hasText: 'Aceptado' }).waitFor({ timeout: 15000 });
      await panelAction(m, code, 'Empezar a preparar');
      await panelAction(m, code, 'Listo para retirar');
      await c.locator('.timeline-step.current', { hasText: 'Listo para retirar' }).waitFor({ timeout: 15000 });
      await panelAction(m, code, 'Marcar retirado');
      await c.locator('.timeline-step.current', { hasText: 'Retirado' }).waitFor({ timeout: 15000 });
      // Recargar la página directo en la ruta del pedido conserva sesión y estado.
      await c.reload();
      await ready(c);
      assert.ok(await c.locator('.timeline-step.current', { hasText: 'Retirado' }).isVisible());
      await shot(c, `${engine}-cliente-pedido-retirado`);
      assert.deepEqual([...customer.problems, ...merchant.problems], []);
    } finally { await browser.close(); }
  });

  test(`${engine}: envío del comercio con reparto propio y seguimiento desde otro dispositivo`, async () => {
    const browser = await launch(engine);
    try {
      const customer = await person(browser, { label: 'cliente' });
      const other = await person(browser, { label: 'otro dispositivo' });
      const merchant = await person(browser, { width: 1024, height: 900, label: 'comercio' });
      const c = customer.page;
      await open(c, `#comercio/${A.id}`);
      const pizza = c.locator('article.product-card', { has: c.locator('h3:text-is("Pizza")') });
      await pizza.locator('.variant-row', { hasText: 'Grande' }).getByRole('button', { name: 'Agregar' }).click();
      await ready(c);
      const orderId = await checkout(c, { fulfillment: 'delivery', address: 'Los Pehuenes 45, portón verde' });
      const [{ total, fee }] = await sql`select total_ars::int as total, delivery_fee_ars::int as fee from public.orders where id = ${orderId}`;
      assert.deepEqual({ total, fee }, { total: 11000, fee: 1500 });
      const code = (await c.locator('.page-header .eyebrow').textContent()).replace('PEDIDO', '').trim();
      const tracking = await c.locator('[data-action="copy-tracking"]').getAttribute('data-url');
      assert.match(tracking, /#seguimiento\/[0-9a-f-]{36}$/);

      await signIn(merchant.page, people.ownerA);
      const m = merchant.page;
      await m.waitForFunction(() => /^#panel\//.test(location.hash));
      await ready(m);
      await m.getByRole('tab', { name: 'Reparto' }).click();
      await ready(m);
      await m.fill('#rider-name', `Reparto ${engine}`);
      await m.locator('form[data-form="rider-create"] button[type="submit"]').click();
      await ready(m);
      await m.getByRole('tab', { name: /Pedidos/ }).click();
      await ready(m);
      for (const label of ['Aceptar', 'Empezar a preparar', 'Listo para enviar']) await panelAction(m, code, label);
      const card = m.locator(`article[aria-label="Pedido ${code}"]`);
      await card.locator('select[name="riderId"]').selectOption({ label: `Reparto ${engine}` });
      await card.getByRole('button', { name: 'Asignar reparto' }).click();
      await ready(m);
      for (const label of ['Retirado por el reparto', 'Salió a entregar']) await panelAction(m, code, label);

      // Otro teléfono, sin sesión: el enlace de seguimiento muestra el estado.
      await other.page.goto(tracking);
      await ready(other.page);
      assert.ok(await other.page.locator('.timeline-step.current', { hasText: 'En camino' }).isVisible());
      assert.equal(await other.page.getByText('Vecina de Prueba').count(), 0, 'el enlace no muestra datos personales');
      await shot(other.page, `${engine}-seguimiento-otro-dispositivo`);
      await panelAction(m, code, 'Marcar entregado');
      await c.locator('.timeline-step.current', { hasText: 'Entregado' }).waitFor({ timeout: 15000 });
      assert.deepEqual([...customer.problems, ...other.problems, ...merchant.problems], []);
    } finally { await browser.close(); }
  });

  test(`${engine}: un comercio no entra al panel de otro; staff no administra; visitas sin acceso`, async () => {
    const browser = await launch(engine);
    try {
      const owner = await person(browser, { label: 'comercio A' });
      await signIn(owner.page, people.ownerA);
      await go(owner.page, `#panel/${B.id}`);
      assert.ok(await owner.page.getByText('Ese comercio no pertenece a tu cuenta.').isVisible());
      await go(owner.page, '#admin');
      assert.ok(await owner.page.getByText('Sección restringida').isVisible());

      const staff = await person(browser, { label: 'staff A' });
      await signIn(staff.page, people.staffA);
      await go(staff.page, `#panel/${A.id}`);
      const tabs = await staff.page.getByRole('tab').allTextContents();
      assert.deepEqual(tabs.map(text => text.replace(/\d+/g, '').trim()), ['Inicio', 'Pedidos', 'Catálogo', 'Reparto']);
      await staff.page.getByRole('tab', { name: 'Catálogo' }).click();
      await ready(staff.page);
      assert.equal(await staff.page.locator('form[data-form="product-create"]').count(), 0);
      assert.equal(await staff.page.locator('[data-action="toggle-open"]').count(), 0);

      const visitor = await person(browser, { label: 'visita' });
      // Sin sesión no se abre ningún canal en vivo: la base lo rechazaría y
      // quedaría como error en el registro de administración.
      const joins = [];
      visitor.page.on('websocket', socket => socket.on('framesent', frame => {
        if (String(frame.payload).includes('postgres_changes')) joins.push(String(frame.payload));
      }));
      await open(visitor.page, `#panel/${A.id}`);
      assert.ok(await visitor.page.getByText('Necesitás iniciar sesión.').isVisible());
      // Un pedido abierto sin ninguna sesión (otro navegador) explica cómo verlo.
      await go(visitor.page, `#pedido/${randomUUID()}`);
      assert.ok(await visitor.page.getByText('Este pedido no está en esta sesión.').isVisible());
      await visitor.page.waitForTimeout(2000);
      assert.deepEqual(joins, [], 'una visita sin sesión no abre canales en vivo');
      assert.deepEqual([...owner.problems, ...staff.problems, ...visitor.problems], []);
    } finally { await browser.close(); }
  });
}
