// Comprobación de aislamiento entre vendedores en la DEMOSTRACIÓN publicada.
// Un vendedor no debe ver el panel, los pedidos ni los datos privados de otro.
// Cada comprobación usa la interfaz real; no se inyectan datos por consola.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { findChrome } from './lib/cdp.mjs';
import { createStaticServer } from '../scripts/server.mjs';

const out = process.env.OUT_DIR || 'evidence/mifav';
const executablePath = findChrome();
if (!executablePath) {
  console.error('No se encontró Chrome ni Edge. Definí CAUCE_CHROME_PATH.');
  process.exit(1);
}
await mkdir(out, { recursive: true });

// La comprobación levanta su propio servidor para que el comando sea
// reproducible sin depender de un proceso abierto en otra terminal.
const server = createStaticServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const errors = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', error => errors.push(error.message));

const settle = () => page.waitForFunction(
  () => document.querySelector('#main')?.getAttribute('aria-busy') === 'false');
const visit = async hash => {
  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' });
  await settle();
};
const mainText = () => page.locator('#main').innerText();

async function signOut() {
  await visit('#cuenta');
  const button = page.locator('[data-action="sign-out"]');
  if (await button.count()) {
    await button.first().click();
    await page.waitForFunction(() => !/#cuenta/.test(location.hash) || !!document.querySelector('[data-action="use-identity"]'));
    await page.waitForTimeout(300);
  }
}

async function signIn(identity) {
  await signOut();
  await visit('#cuenta');
  await page.click(`[data-action="use-identity"][data-identity="${identity}"]`);
  await page.waitForTimeout(700);
  await settle();
}

// 1. Una clienta compra en La Orilla. El pedido queda guardado en esta misma
//    demostración (localStorage), así que ambos vendedores podrán intentar abrirlo.
await visit('#comercio/orilla');
await page.click('[data-action="set-quantity"][data-quantity="1"]');
await page.waitForFunction(() => document.body.innerText.includes('en el carrito'));
await visit('#carrito/orilla/confirmar');
await page.fill('#checkout-name', 'Clienta de aislamiento');
await page.fill('#checkout-phone', '2942555000');
await page.click('[data-form="checkout"] button[type="submit"]');
await page.waitForFunction(() => location.hash.startsWith('#pedido/'));
const orderHash = await page.evaluate(() => location.hash);
const orderId = orderHash.replace('#pedido/', '');
const guestOrder = await mainText();
check('Se crea un pedido real de demostración en La Orilla', Boolean(orderId), orderHash);
check('La clienta ve su pedido recién confirmado', /CA-0001/.test(guestOrder) && /La Orilla/.test(guestOrder),
  guestOrder.slice(0, 80).replace(/\n+/g, ' '));

// 2. Titular de La Orilla: ve su panel, su pedido y los datos privados de la
//    clienta que sólo le corresponden al comercio que recibió el pedido.
await signIn('acc-orilla');
await visit('#panel');
check('La Orilla entra a su panel', await page.evaluate(() => location.hash) === '#panel/orilla',
  await page.evaluate(() => location.hash));
const orillaPanel = await mainText();
check('El panel de La Orilla muestra su comercio', /La Orilla/.test(orillaPanel));
await visit('#panel/orilla/pedidos');
const orillaOrders = await mainText();
check('La Orilla ve el pedido en su panel', /CA-0001/.test(orillaOrders));
check('La Orilla ve los datos privados de su clienta',
  /Clienta de aislamiento/.test(orillaOrders) && /294 255 5000/.test(orillaOrders),
  orillaOrders.slice(0, 140).replace(/\n+/g, ' '));
await visit(`#pedido/${orderId}`);
const orillaOrder = await mainText();
check('La Orilla puede abrir su propio pedido', /CA-0001/.test(orillaOrder) && /La Orilla/.test(orillaOrder),
  orillaOrder.slice(0, 90).replace(/\n+/g, ' '));

// 3. La Orilla intenta entrar al panel de Taller Malva por URL directa.
for (const hash of ['#panel/taller-malva', '#panel/taller-malva/pedidos', '#panel/taller-malva/catalogo']) {
  await visit(hash);
  const text = await mainText();
  check(`La Orilla no accede a ${hash}`, /Sin acceso/.test(text) && /no pertenece a tu cuenta/i.test(text),
    text.slice(0, 80).replace(/\n+/g, ' '));
}
await page.screenshot({ path: `${out}/isolation-orilla-denied.png`, fullPage: true });

// 4. Taller Malva (otro titular) no ve La Orilla ni su pedido.
await signIn('acc-taller');
await visit('#panel');
const tallerHash = await page.evaluate(() => location.hash);
const tallerPanel = await mainText();
check('Taller Malva entra a su propio panel', tallerHash === '#panel' && /Taller Malva/.test(tallerPanel),
  tallerHash);
check('Taller Malva ve sus emprendimientos y no La Orilla',
  /Taller Malva/.test(tallerPanel) && /Tecno Pampa/.test(tallerPanel) && !/La Orilla/.test(tallerPanel));
await page.screenshot({ path: `${out}/isolation-taller-panel.png`, fullPage: true });
await visit('#panel/taller-malva');
check('Taller Malva entra a uno de sus comercios', /Taller Malva/.test(await mainText()));

await visit('#panel/orilla');
const tallerForeignPanel = await mainText();
check('Taller Malva no accede al panel de La Orilla', /Sin acceso/.test(tallerForeignPanel),
  tallerForeignPanel.slice(0, 80).replace(/\n+/g, ' '));

await visit(`#pedido/${orderId}`);
const tallerOrder = await mainText();
const leaked = /Clienta de aislamiento|2942555000|Rivadavia|La Orilla/.test(tallerOrder);
check('Taller Malva no puede abrir el pedido de La Orilla', !leaked,
  tallerOrder.slice(0, 100).replace(/\n+/g, ' '));
await page.screenshot({ path: `${out}/isolation-taller-order-denied.png`, fullPage: true });

// 5. El pedido sigue siendo privado: la clienta lo vio al confirmarlo y el
//    otro vendedor no puede abrirlo. Al cambiar de identidad, la demostración
//    deja de asociar el pedido de invitada a la nueva cuenta (no hay traspaso).
check('Sin errores de consola durante el recorrido', errors.length === 0, errors.join(' | '));

await writeFile(`${out}/isolation-results.json`, JSON.stringify({
  ejecutadoEl: new Date().toISOString(),
  base,
  orderHash,
  results,
  errors,
}, null, 2));
console.log(`\n${results.filter(item => item.ok).length}/${results.length} comprobaciones de aislamiento`);
await browser.close();
await new Promise(resolve => server.close(resolve));
