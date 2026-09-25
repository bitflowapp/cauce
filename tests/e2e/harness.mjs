// E2E del build conectado (`npm run build:local`) contra el stack Supabase
// local, en navegadores reales (Chromium y WebKit). Los datos de partida se
// crean por la API con identidades reales; todo lo demás pasa por la interfaz.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createStaticServer } from '../../scripts/server.mjs';

export * from '../integration/harness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const BASE = 'http://127.0.0.1:4174';
export const EVIDENCE = resolve(root, 'evidence/e2e-produccion');
const ENGINES = { chromium, webkit };
export const browsersToRun = (process.env.CAUCE_E2E_BROWSERS || 'chromium,webkit')
  .split(',').map(name => name.trim()).filter(name => ENGINES[name]);

let server = null;
const problemsOf = new WeakMap();
export async function startPreview() {
  try { await stat(resolve(root, '.local/preview/index.html')); } catch {
    throw new Error('Falta el build local. Ejecutá `npm run build:local` antes de las pruebas E2E.');
  }
  await mkdir(EVIDENCE, { recursive: true });
  server = createStaticServer({ root: resolve(root, '.local/preview'), preview: true });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(4174, '127.0.0.1', resolveListen);
  });
}
export async function stopPreview() {
  await new Promise(resolveClose => (server ? server.close(() => resolveClose()) : resolveClose()));
}

export async function launch(name) {
  return ENGINES[name].launch();
}

// Cada persona usa su propio contexto: almacenamiento y sesión independientes,
// como dos teléfonos distintos.
// `serviceWorkers: 'block'` sólo para demorar respuestas con page.route(), que
// no ve lo que pasa por el service worker.
export async function person(browser, { width = 390, height = 844, label = 'persona', serviceWorkers = 'allow' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires', hasTouch: width < 900, isMobile: false, serviceWorkers });
  const page = await context.newPage();
  const problems = [];
  problemsOf.set(page, problems);
  page.on('pageerror', error => problems.push(`[${label}] pageerror: ${error.message}`));
  page.on('console', message => {
    if (process.env.CAUCE_E2E_DEBUG && message.text().startsWith('[CAUCE:')) console.log(`[${label}] ${message.text()}`);
    if (message.type() !== 'error') return;
    const text = message.text();
    // Una respuesta 4xx esperada (credenciales incorrectas, regla del servidor)
    // la informa la propia prueba; el navegador la repite en consola.
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
    problems.push(`[${label}] console: ${text}`);
  });
  page.on('response', response => {
    if (response.status() >= 500) problems.push(`[${label}] HTTP ${response.status()} ${response.url()}`);
  });
  return { context, page, problems, label };
}

export async function ready(page, timeout = 20000) {
  await page.waitForFunction(() => document.querySelector('#main')?.getAttribute('aria-busy') === 'false',
    null, { timeout });
}

export async function open(page, hash) {
  await page.goto(`${BASE}/index.html${hash}`);
  await ready(page);
}

export async function go(page, hash) {
  await page.evaluate(target => { location.hash = target; }, hash);
  await page.waitForFunction(target => location.hash === target, hash);
  await ready(page);
}

export async function signIn(page, user) {
  await open(page, '#cuenta');
  await page.fill('#signin-email', user.email);
  await page.fill('#signin-password', user.password);
  await page.click('form[data-form="sign-in"] button[type="submit"]');
  await page.waitForFunction(() => !location.hash.startsWith('#cuenta'), null, { timeout: 20000 });
  await ready(page);
}

export async function toastText(page) {
  const toast = page.locator('#toast');
  await toast.waitFor({ state: 'visible', timeout: 15000 });
  return (await toast.textContent()).trim();
}

// Espera un aviso concreto: el anterior puede seguir visible unos segundos.
export async function expectToast(page, expected) {
  await page.waitForFunction(text => {
    const toast = document.querySelector('#toast');
    return toast && !toast.hidden && toast.textContent.trim() === text;
  }, expected, { timeout: 15000 });
  return expected;
}

export async function shot(page, name) {
  // WebKit inyecta una hoja de estilos al capturar y la CSP de CAUCE la
  // bloquea (correcto). Sólo esos avisos, emitidos durante la captura, no
  // cuentan como problemas de la aplicación.
  const problems = problemsOf.get(page) || [];
  const before = problems.length;
  await page.screenshot({ path: resolve(EVIDENCE, `${name}.png`), fullPage: false, caret: 'initial', animations: 'allow' });
  await new Promise(resolveWait => setTimeout(resolveWait, 150));
  const during = problems.splice(before);
  problems.push(...during.filter(text => !/Refused to apply a stylesheet/.test(text)));
}

export async function writeReport(name, data) {
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(resolve(EVIDENCE, `${name}.json`), JSON.stringify(data, null, 2));
}

// Controles de diseño responsive sobre la vista actual.
export async function layoutIssues(page) {
  return page.evaluate(() => {
    const issues = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1) {
      issues.push(`desborde horizontal: ${document.documentElement.scrollWidth}px en ${width}px`);
    }
    const visible = element => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    };
    // Una fila que se desplaza de costado (filtros, categorías) deja a propósito
    // parte de sus botones fuera de la vista: se alcanzan deslizando. Lo que
    // cuenta es que la fila misma entre en la pantalla.
    const scroller = element => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth) return node;
      }
      return null;
    };
    for (const element of document.querySelectorAll('#main button, #main a.button, #main input, #main select, #main textarea, .bottom-nav a')) {
      if (!visible(element) || element.closest('[hidden]')) continue;
      const box = element.getBoundingClientRect();
      const row = scroller(element)?.getBoundingClientRect();
      const reachable = row && row.left >= -1 && row.right <= width + 1;
      if (!reachable && (box.right > width + 1 || box.left < -1)) issues.push(`fuera de pantalla: ${element.textContent.trim().slice(0, 30) || element.name}`);
      const primary = element.matches('button, a.button, .bottom-nav a');
      if (primary && box.height < 40 && !element.matches('.link-button, .qty-button')) {
        issues.push(`área táctil baja (${Math.round(box.height)}px): ${element.textContent.trim().slice(0, 30)}`);
      }
      if (element.matches('.qty-button') && (box.height < 36 || box.width < 36)) {
        issues.push(`control de cantidad pequeño: ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
    }
    for (const input of document.querySelectorAll('#main input:not([type="hidden"]), #main select, #main textarea')) {
      if (!visible(input)) continue;
      const labelled = (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`))
        || input.closest('label') || input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
      if (!labelled) issues.push(`campo sin etiqueta: ${input.name || input.id}`);
    }
    for (const button of document.querySelectorAll('#main button, #main a')) {
      if (!visible(button)) continue;
      const name = (button.getAttribute('aria-label') || button.textContent || '').trim();
      if (!name) issues.push('botón o enlace sin nombre accesible');
    }
    return issues;
  });
}
