// Recorrido de punta a punta contra CAUCE real, con navegadores independientes:
// comercio en un teléfono emulado, administración y clientela en computadoras
// separadas. Cada perfil tiene su propio almacenamiento: son sesiones distintas.
// Los datos sintéticos se eliminan al terminar.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/cdp.mjs';
import { createStaticServer } from '../scripts/server.mjs';
import { fixtures, project, requireSuccess } from './lib/supabase-real.mjs';

const fixture = await fixtures(['merchantA', 'merchantB', 'admin', 'customerA']);
const server = createStaticServer({ root: fileURLToPath(new URL('../.local/supabase-preview', import.meta.url)), supabase: true });
const browsers = [];
const steps = [];
let passed = false;
const step = name => { steps.push(name); console.log(`PASS · ${name}`); };
const base = 'http://127.0.0.1:4174';
const ready = page => page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"', { timeout: 30000 });
// Ir al mismo hash no vuelve a navegar: si ya estábamos ahí hay que recargar,
// o la pantalla sigue mostrando lo que se dibujó antes del cambio remoto.
async function visit(page, route) {
  const target = `${base}/index.html#${route}`;
  const current = await page.evaluate('location.href').catch(() => '');
  await page.goto(target);
  if (current === target) await page.reload();
  await ready(page);
}
async function login(page, user) {
  await visit(page, 'cuenta');
  await page.fill('#signin-email', user.email); await page.fill('#signin-password', user.password);
  await press(page, '[data-form="sign-in"] button[type="submit"]');
  // Al entrar, CAUCE lleva a «Mi actividad»: volvemos a la cuenta para editarla.
  await page.waitForFunction('location.hash === "#actividad"', { timeout: 30000 });
  await visit(page, 'cuenta');
  await page.waitForFunction('!!document.querySelector("#profile-name")', { timeout: 30000 });
}
// El clic de CDP va a las coordenadas del elemento: si quedó fuera de pantalla,
// hay que traerlo antes o el clic cae en otro lado.
async function press(page, selector) {
  await page.waitForFunction(`!!document.querySelector(${JSON.stringify(selector)})`, { timeout: 30000 });
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
  await page.click(selector);
}
async function tab(page, name) {
  await press(page, `[data-action="set-panel-tab"][data-tab="${name}"]`);
  await ready(page);
}
// Una foto real de 1×1 puesta en el input, como si la hubiera elegido alguien.
const attachPhoto = (page, selector) => page.evaluate(`(() => {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
    char => char.charCodeAt(0));
  const file = new File([bytes], 'producto.png', { type: 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.querySelector(${JSON.stringify(selector)});
  input.files = transfer.files;
  return input.files.length;
})()`);

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4174, '127.0.0.1', resolve); });
  for (let i = 0; i < 3; i++) browsers.push(await launchBrowser());
  const phone = await browsers[0].newPage({ width: 390, height: 844, mobile: true });
  const admin = await browsers[1].newPage({ width: 1440, height: 900, mobile: false });
  const customer = await browsers[2].newPage({ width: 1280, height: 900, mobile: false });

  // ── 1. el comercio se registra desde un teléfono ──
  await login(phone, fixture.users.merchantA); step('Ingreso real desde teléfono emulado con Supabase Auth');
  await phone.reload(); await ready(phone);
  assert.ok(await phone.evaluate('!!document.querySelector("#profile-name")')); step('La sesión sobrevive a recargar');

  await visit(phone, 'alta-comercio');
  await phone.fill('#biz-name', 'Panadería del Recorrido');
  await phone.fill('#biz-category', 'panaderia');
  await press(phone, '[data-form="business-create"] button[type="submit"]');
  await phone.waitForFunction('location.hash.startsWith("#panel/")', { timeout: 30000 });
  await ready(phone);
  const panelRoute = (await phone.evaluate('location.hash')).slice(1);
  const businessId = panelRoute.split('/')[1];
  fixture.businesses.push(businessId);
  step('Alta de comercio desde la interfaz, guardada en Postgres');

  await tab(phone, 'datos');
  for (const [selector, value] of [['#b-owner', 'Responsable del Recorrido'], ['#b-phone', '2942000111'],
    ['#b-address', 'Ruta 23 y Cristian Joubert'], ['#b-hours', 'Lunes a sábado de 9 a 13']]) {
    await phone.fill(selector, value);
  }
  await phone.evaluate('document.querySelector("#b-category").value = "panaderia"');
  await press(phone, '[data-form="business-update"] button[type="submit"]');
  await phone.waitForFunction('document.querySelector("#main")?.innerText.includes("Al menos un producto cargado")', { timeout: 30000 });
  step('Datos del comercio guardados; la publicación todavía pide catálogo');

  // ── 2. carga un producto con foto propia ──
  await tab(phone, 'catalogo');
  await phone.fill('#prod-name', 'Pan casero');
  await phone.fill('#prod-price', '1800');
  await phone.fill('#prod-stock', '12');
  await phone.fill('#prod-category', 'Panificados');
  assert.equal(await attachPhoto(phone, '#prod-image'), 1);
  await press(phone, '[data-form="product-create"] button[type="submit"]');
  await phone.waitForFunction('document.querySelector("#main")?.innerText.includes("Pan casero")', { timeout: 30000 });
  await ready(phone);
  await phone.waitForFunction(
    `!!document.querySelector('.catalog-row img[src*="${project.url}/storage/v1/object/public/business-media/"]')`,
    { timeout: 30000 });
  // La miniatura carga de forma diferida: primero se la trae a pantalla y
  // recién después se comprueba que el navegador la haya podido descargar.
  await phone.evaluate(`document.querySelector('.catalog-row img').scrollIntoView({ block: 'center' })`);
  await phone.waitForFunction(`document.querySelector('.catalog-row img').naturalWidth > 0`, { timeout: 30000 });
  step('La foto sube a Storage y el navegador la descarga desde CAUCE');
  step('Producto con foto propia cargado desde el panel del comercio');

  await tab(phone, 'datos');
  await press(phone, '[data-action="submit-business"]');
  await phone.waitForFunction('document.querySelector("#main")?.innerText.includes("en revisión")', { timeout: 30000 });
  step('El comercio solicita la publicación; no puede aprobarse solo');

  // ── 3. administración aprueba desde otra computadora ──
  await login(admin, fixture.users.admin);
  await visit(admin, 'admin');
  await admin.waitForFunction('document.querySelector("#main")?.innerText.includes("Panadería del Recorrido")', { timeout: 30000 });
  await press(admin, `[data-form="review"][data-kind="business"][data-id="${businessId}"] button[value="approve"]`);
  await admin.waitForFunction('document.querySelector("#main")?.innerText.includes("Alta aprobada")'
    + ' || !document.querySelector("[data-form=review][data-kind=business]")', { timeout: 30000 });
  await ready(admin);
  assert.equal(await admin.evaluate(`!!document.querySelector('[data-form="review"][data-kind="business"][data-id="${businessId}"]')`), false,
    'El comercio salió de la cola de revisión');
  step('Administración aprueba el alta desde una sesión independiente');

  await visit(phone, panelRoute);
  await phone.waitForFunction('!!document.querySelector("[data-action=toggle-open]")', { timeout: 30000 });
  await press(phone, '[data-action="toggle-open"]');
  await phone.waitForFunction('document.querySelector("#main")?.innerText.includes("Recibiendo pedidos")', { timeout: 30000 });
  step('El comercio abre la atención y queda publicado');

  // ── 4. la clientela lo ve desde otro dispositivo y pide ──
  await login(customer, fixture.users.customerA);
  await visit(customer, 'comercios');
  await customer.waitForFunction('document.querySelector("#main")?.innerText.includes("Panadería del Recorrido")', { timeout: 30000 });
  step('El catálogo aparece en otro dispositivo sin compartir nada por el navegador');

  await visit(customer, `comercio/${businessId}`);
  await customer.waitForFunction(`!!document.querySelector('[data-action="set-quantity"][data-quantity="1"]')`, { timeout: 30000 });
  await press(customer, '[data-action="set-quantity"][data-quantity="1"]');
  await customer.waitForFunction('!!document.querySelector(".qty-value")', { timeout: 30000 });
  await visit(customer, `carrito/${businessId}`);
  await customer.waitForFunction('!!document.querySelector("[data-form=checkout]")', { timeout: 30000 });
  const total = await customer.evaluate('document.querySelector(".totals-final dd")?.textContent || ""');
  assert.match(total, /1\.?800/, `El total lo calcula el servidor: ${total}`);
  step('El importe del checkout lo resuelve el catálogo guardado, no el navegador');

  // ── 5. el pedido llega al comercio sin recargar ──
  await visit(phone, panelRoute);
  await tab(phone, 'pedidos');
  await customer.fill('#checkout-name', 'Vecina del Recorrido');
  await customer.fill('#checkout-phone', '2942000222');
  await press(customer, '[data-form="checkout"] button[type="submit"]');
  await customer.waitForFunction('location.hash.startsWith("#pedido/")', { timeout: 30000 });
  await ready(customer);
  const orderCode = await customer.evaluate('document.querySelector(".eyebrow")?.textContent || ""');
  assert.match(orderCode, /CA-\d{4}/);
  await phone.waitForFunction(`document.querySelector("#main")?.innerText.includes(${JSON.stringify(orderCode.replace('PEDIDO ', ''))})`,
    { timeout: 30000 });
  step('El pedido aparece en el panel del comercio sin recargar la página');

  await press(phone, '[data-action="order-transition"][data-next="accepted"]');
  await customer.waitForFunction('document.querySelector("#main")?.innerText.includes("Aceptado")', { timeout: 30000 });
  step('El cambio de estado llega al cliente sin recargar');

  await mkdir('evidence/supabase', { recursive: true });
  await phone.screenshot('evidence/supabase/telefono-comercio.png');
  await customer.screenshot('evidence/supabase/cliente-pedido.png');
  await admin.screenshot('evidence/supabase/administracion.png');

  // ── 6. aislamiento y recuperación ──
  await login(admin, fixture.users.merchantB);
  await visit(admin, panelRoute);
  assert.match(await admin.text('#main'), /Sin acceso|no pertenece/);
  step('Otra cuenta comercial no abre por URL el panel ajeno');

  const link = requireSuccess(await fixture.admin.auth.admin.generateLink({ type: 'recovery', email: fixture.users.merchantA.email }));
  await phone.goto(`${base}/index.html?token_hash=${encodeURIComponent(link.properties.hashed_token)}&type=recovery`);
  await ready(phone);
  await phone.waitForFunction('!!document.querySelector("#new-password")');
  assert.equal(await phone.evaluate('location.search'), '');
  await phone.fill('#new-password', `Restored-${crypto.randomUUID()}-9`);
  await press(phone, '[data-form="password-update"] button');
  await phone.waitForFunction('document.querySelector("#main")?.innerText.includes("Contraseña actualizada.")', { timeout: 30000 });
  step('El callback de recuperación verifica un token real y limpia la URL (no prueba entrega de correo)');

  await visit(phone, panelRoute);
  await tab(phone, 'datos');
  await phone.setOffline(true);
  await phone.fill('#b-address', 'Cambio Sin Red');
  await phone.waitForFunction('document.querySelector("[data-form=business-update] button[type=submit]").disabled');
  assert.equal(await phone.evaluate('document.querySelector("#b-address").value'), 'Cambio Sin Red');
  await phone.setOffline(false);
  await phone.waitForFunction('!document.querySelector("[data-form=business-update] button[type=submit]").disabled');
  assert.equal(await phone.evaluate('document.querySelector("#b-address").value'), 'Cambio Sin Red');
  step('Sin conexión se conserva lo escrito y no se puede enviar a medias');

  const errors = [...phone.consoleErrors, ...customer.consoleErrors, ...admin.consoleErrors]
    .filter(message => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|favicon/.test(message));
  assert.deepEqual(errors, []); step('Sin errores propios de JavaScript en ninguna de las tres sesiones');
  passed = true;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  server.close();
  await fixture.cleanup();
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/supabase-phase1-browser.json', JSON.stringify({ at: new Date().toISOString(),
    project: project.projectRef, passed, steps,
    note: 'Chrome emulado 390/1280/1440 en tres perfiles independientes. No es un teléfono físico. Datos sintéticos eliminados.' }, null, 2));
}
