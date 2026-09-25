// Recorrido de navegador sobre el ENTORNO DE DEMOSTRACIÓN: el que se publica.
//
// Acá no hay backend: todo vive en el navegador de cada persona. Lo que se
// comprueba es que la demostración pública funcione, se identifique como tal y
// no aparente una operación compartida que no existe.
//   node tests/e2e-demo.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, findChrome } from './lib/cdp.mjs';
import { createStaticServer } from '../scripts/server.mjs';

const SHOTS = 'evidence/demo';
const results = [];
let failures = 0;

const step = (name, detail = '') => {
  results.push({ name, detail, ok: true });
  console.log(`  ✔ ${name}${detail ? ` · ${detail}` : ''}`);
};

async function main() {
  if (!findChrome()) {
    console.error('No se encontró Chrome ni Edge. Definí CAUCE_CHROME_PATH.');
    process.exitCode = 1;
    return;
  }
  const server = createStaticServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Demostración estática en ${base}`);
  await mkdir(SHOTS, { recursive: true });

  const browser = await launchBrowser();
  const page = await browser.newPage({ width: 390, height: 844, mobile: true });
  const visit = async hash => {
    await page.goto('about:blank');
    await page.goto(`${base}/index.html${hash}`);
    await page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
  };

  try {
    await visit('#inicio');
    const chip = await page.text('#env-chip');
    if (!/demostraci/i.test(chip)) throw new Error(`El indicador dice "${chip}"`);
    step('La demostración se identifica como tal de forma persistente', chip);

    await visit('#comercios');
    await page.waitForFunction(`document.body.innerText.includes('La Orilla')`);
    step('Se exploran comercios sin crear cuenta');
    await page.screenshot(`${SHOTS}/demo-comercios.png`, { fullPage: true });

    await visit('#comercio/orilla');
    await page.click('[data-action="set-quantity"][data-quantity="1"]');
    await page.waitForFunction(`document.body.innerText.includes('en el carrito')`);
    step('Se arma un carrito');

    await visit('#carrito/orilla/confirmar');
    await page.waitForFunction(`!!document.querySelector('[data-form="checkout"]')`);
    await page.fill('#checkout-name', 'Vecina de prueba');
    await page.fill('#checkout-phone', '2942123456');
    const aviso = await page.text('.confirm-notice');
    if (!/no genera un servicio ni un cobro real/i.test(aviso)) {
      throw new Error('Falta el aviso previo a confirmar');
    }
    step('Antes de confirmar se aclara que no genera servicios ni cobros reales');
    await page.screenshot(`${SHOTS}/demo-confirmacion.png`, { fullPage: true });

    await page.click('[data-form="checkout"] button[type="submit"]');
    await page.waitForFunction(`location.hash.startsWith('#pedido/')`);
    const orderHash = await page.evaluate('location.hash');
    step('El pedido de prueba queda registrado', orderHash);

    // Persistencia tras recargar: es lo único que la demostración sí garantiza.
    await visit(orderHash);
    await page.waitForFunction(`document.body.innerText.includes('Recibido')`);
    step('El pedido sobrevive a recargar la página');

    // Enlaces directos: cada ruta se abre sola, sin pasar por el inicio.
    for (const hash of ['#comercios', '#taxi', '#actividad', '#institucional', '#cuenta', '#panel', '#admin', '#taxista']) {
      await visit(hash);
      const length = await page.evaluate(`document.querySelector('#main').innerText.length`);
      if (!length) throw new Error(`La ruta ${hash} quedó vacía al abrirse directamente`);
    }
    step('Todas las rutas abren directamente y al recargar');

    // Los paneles no son roles intercambiables para cualquier visitante.
    await visit('#admin');
    await page.waitForFunction(`/restringida/i.test(document.querySelector('#main').innerText)`);
    step('Administración está cerrada para una visitante');

    await visit('#cuenta');
    await page.waitForFunction(`!!document.querySelector('[data-action="use-identity"]')`);
    const identidades = await page.text('#main');
    if (!/no usa contraseñas/i.test(identidades)) {
      throw new Error('No se aclara que la demostración no tiene autenticación real');
    }
    step('El acceso a paneles declara que son identidades de ejemplo, no cuentas reales');
    await page.screenshot(`${SHOTS}/demo-acceso.png`, { fullPage: true });

    await page.click('[data-action="use-identity"][data-identity="acc-admin"]');
    await page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
    await visit('#admin');
    await page.waitForFunction(`/comercios pendientes/i.test(document.querySelector('#main').innerText)`);
    step('Con una identidad de ejemplo se llega al panel de administración');

    const errors = page.consoleErrors.filter(message => !/favicon|Failed to load resource/i.test(message));
    if (errors.length) throw new Error(`Errores en consola: ${errors.slice(0, 3).join(' | ')}`);
    step('Sin errores propios en consola');

    // Último, porque provoca a propósito una violación de CSP: se comprueba que
    // el documento publicado no pueda abrir NINGUNA conexión de red.
    const blocked = await page.evaluate(
      `fetch('js/runtime-env.js').then(() => 'permitido').catch(() => 'bloqueado')`);
    if (blocked !== 'bloqueado') throw new Error('El documento publicado permite conexiones de red');
    step('La CSP del documento publicado bloquea toda conexión de red', blocked);
  } catch (error) {
    failures += 1;
    results.push({ name: 'Recorrido de demostración', ok: false, error: String(error.message) });
    console.log(`  ✖ ${error.message}`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  await writeFile('evidence/demo-results.json', JSON.stringify({
    ejecutadoEl: new Date().toISOString(),
    entorno: 'demostración estática (localStorage, sin backend)',
    pasos: results,
    fallos: failures,
  }, null, 2), 'utf8');

  console.log(`\n${results.filter(item => item.ok).length} pasos verificados · ${failures} fallos`);
  if (failures) process.exitCode = 1;
}

await main();
