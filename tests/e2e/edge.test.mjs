// Casos límite del checkout y de la operación, en navegador real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  account, makeAdmin, publishedBusiness, closeAll, ok, sql, run,
  startPreview, stopPreview, browsersToRun, launch, person, open, go, ready, signIn, expectToast, shot,
} from './harness.mjs';

const people = {};
let E;

before(async () => {
  await startPreview();
  for (const name of ['owner', 'admin']) people[name] = await account(`edge-${name}`);
  await makeAdmin(people.admin);
  E = await publishedBusiness(people.owner, people.admin, { name: 'Casos Limite' });
});
after(async () => { await stopPreview(); await closeAll(Object.values(people)); });

const setPrice = async price => ok(await people.owner.client.from('products').update({ price_ars: price }).eq('id', E.products.untracked.id));
const setAvailable = async available => ok(await people.owner.client.rpc('set_product_availability',
  { product: E.products.untracked.id, is_available: available }));
const setOpen = async open => ok(await people.owner.client.rpc('set_business_presence', { business: E.id, is_open: open }));

async function cartWith(page, times = 1) {
  await open(page, `#comercio/${E.id}`);
  const card = page.locator('article.product-card', { has: page.locator('h3:text-is("Empanada de carne")') });
  await card.getByRole('button', { name: 'Agregar' }).click();
  await ready(page);
  for (let i = 1; i < times; i += 1) {
    await card.getByRole('button', { name: 'Agregar una unidad' }).click();
    await ready(page);
  }
  await go(page, `#carrito/${E.id}`);
}
async function fillContact(page, name) {
  await page.fill('#checkout-name', name);
  await page.fill('#checkout-phone', '2942 403344');
}

for (const engine of browsersToRun) {
  test(`${engine}: si el precio cambia mientras confirma, ve el total nuevo antes de pedir`, async () => {
    const browser = await launch(engine);
    try {
      await setPrice(1200);
      const buyer = await person(browser, { label: 'cliente' });
      const page = buyer.page;
      await cartWith(page, 2);
      assert.match(await page.locator('.totals-final dd').textContent(), /2\.400/);
      await setPrice(1500);
      await fillContact(page, `Precio ${engine} ${run}`);
      await page.locator('button.button-confirm-order').click();
      await page.getByText('Los precios cambiaron mientras confirmabas').waitFor({ timeout: 15000 });
      assert.match(await page.locator('[role="alert"]').first().textContent(), /3\.000/);
      assert.match(await page.locator('.totals-final dd').textContent(), /3\.000/);
      const [{ count: before }] = await sql`select count(*)::int from public.orders where contact_name = ${`Precio ${engine} ${run}`}`;
      assert.equal(before, 0, 'no se creó nada con el precio viejo');
      await fillContact(page, `Precio ${engine} ${run}`);
      await page.locator('button.button-confirm-order').click();
      await page.waitForFunction(() => location.hash.startsWith('#pedido/'), null, { timeout: 20000 });
      const [{ total }] = await sql`select total_ars::int as total from public.orders where contact_name = ${`Precio ${engine} ${run}`}`;
      assert.equal(total, 3000);
      assert.deepEqual(buyer.problems, []);
    } finally { await setPrice(1200); await browser.close(); }
  });

  test(`${engine}: doble toque, producto agotado con carrito armado, cerrado y sin conexión`, async () => {
    const browser = await launch(engine);
    try {
      const buyer = await person(browser, { label: 'cliente' });
      const page = buyer.page;
      // Doble toque en confirmar: un solo pedido.
      await cartWith(page);
      await fillContact(page, `Doble ${engine} ${run}`);
      await page.locator('button.button-confirm-order').dblclick();
      await page.waitForFunction(() => location.hash.startsWith('#pedido/'), null, { timeout: 20000 });
      await ready(page);
      const [{ count }] = await sql`select count(*)::int from public.orders where contact_name = ${`Doble ${engine} ${run}`}`;
      assert.equal(count, 1);

      // Se agota lo que ya estaba en el carrito: se marca y se puede quitar.
      await cartWith(page);
      await setAvailable(false);
      await page.reload();
      await ready(page);
      const line = page.locator('.cart-line.is-unavailable');
      assert.equal(await line.count(), 1);
      assert.ok(await page.locator('button.button-confirm-order').isDisabled());
      await line.getByRole('button', { name: 'Quitar' }).click();
      await ready(page);
      assert.ok(await page.getByText('Carrito vacío').isVisible());
      await setAvailable(true);

      // Comercio cerrado: se puede armar el carrito, no confirmar.
      await cartWith(page);
      await setOpen(false);
      await page.reload();
      await ready(page);
      assert.ok(await page.locator('button.button-confirm-order').isDisabled());
      assert.ok(await page.getByText(/Cerrado/).first().isVisible());
      await setOpen(true);
      await page.reload();
      await ready(page);
      assert.ok(await page.locator('button.button-confirm-order').isEnabled());

      // Sin conexión: se avisa y no se envía nada; al volver, se puede confirmar.
      await buyer.context.setOffline(true);
      await page.waitForFunction(() => document.body.classList.contains('is-offline'));
      assert.ok(await page.locator('button.button-confirm-order').isDisabled());
      await shot(page, `${engine}-checkout-sin-conexion`);
      await buyer.context.setOffline(false);
      await page.waitForFunction(() => !document.body.classList.contains('is-offline'));
      await ready(page);
      assert.ok(await page.locator('button.button-confirm-order').isEnabled());
      assert.deepEqual(buyer.problems.filter(text => !/ERR_INTERNET_DISCONNECTED|network connection was lost|Load failed|Failed to fetch/i.test(text)), []);
    } finally { await setAvailable(true); await setOpen(true); await browser.close(); }
  });

  test(`${engine}: cancelar pide confirmación (y "volver" no cancela); rechazar exige motivo`, async () => {
    const browser = await launch(engine);
    try {
      const buyer = await person(browser, { label: 'cliente' });
      const merchant = await person(browser, { width: 1200, height: 900, label: 'comercio' });
      const page = buyer.page;
      await cartWith(page);
      await fillContact(page, `Cancelo ${engine} ${run}`);
      await page.locator('button.button-confirm-order').click();
      await page.waitForFunction(() => location.hash.startsWith('#pedido/'), null, { timeout: 20000 });
      await ready(page);
      await page.getByRole('button', { name: 'Cancelar pedido' }).click();
      const dialog = page.locator('dialog.cauce-dialog');
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'No, volver' }).click();
      await dialog.waitFor({ state: 'detached' });
      const [{ status }] = await sql`select status from public.orders where contact_name = ${`Cancelo ${engine} ${run}`}`;
      assert.equal(status, 'submitted', 'volver no cancela el pedido');
      await page.getByRole('button', { name: 'Cancelar pedido' }).click();
      await dialog.getByRole('button', { name: 'Sí, cancelar' }).click();
      await expectToast(page, 'Pedido cancelado.');

      // El comercio rechaza: sin motivo no avanza; con motivo, la persona lo ve.
      await cartWith(page);
      await fillContact(page, `Rechazo ${engine} ${run}`);
      await page.locator('button.button-confirm-order').click();
      await page.waitForFunction(() => location.hash.startsWith('#pedido/'), null, { timeout: 20000 });
      await ready(page);
      const code = (await page.locator('.page-header .eyebrow').textContent()).replace('PEDIDO', '').trim();
      await signIn(merchant.page, people.owner);
      const m = merchant.page;
      await m.waitForFunction(() => /^#panel\//.test(location.hash));
      await ready(m);
      const card = m.locator(`article[aria-label="Pedido ${code}"]`);
      await card.getByRole('button', { name: 'Rechazar' }).click();
      const reject = m.locator('dialog.cauce-dialog');
      await reject.waitFor();
      await reject.locator('button[type="submit"]').click();
      assert.ok(await reject.getByText('Escribí un motivo').isVisible());
      await reject.locator('textarea').fill('Se nos terminó la masa');
      await reject.locator('button[type="submit"]').click();
      await reject.waitFor({ state: 'detached' });
      await page.getByText('El comercio no pudo tomar el pedido.').waitFor({ timeout: 15000 });
      assert.ok(await page.getByText('Se nos terminó la masa').isVisible());
      await shot(page, `${engine}-pedido-rechazado`);
      assert.deepEqual([...buyer.problems, ...merchant.problems], []);
    } finally { await browser.close(); }
  });
}
