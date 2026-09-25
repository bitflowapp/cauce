// Navegadores reales contra el sitio publicado, contra el build de producción
// servido en 4174 antes de publicar (CAUCE_SMOKE_SITE=build, proyecto real) o
// contra el build local y el stack local (CAUCE_SMOKE_LOCAL=1).
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createStaticServer } from '../../scripts/server.mjs';
import { BUILD, LOCAL, t } from './qa.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const SITE = LOCAL || BUILD ? 'http://127.0.0.1:4174' : t.siteUrl;
export const EVIDENCE = resolve(root, 'evidence/produccion');
const ENGINES = { chromium, webkit };
export const engines = (process.env.CAUCE_E2E_BROWSERS || 'chromium,webkit').split(',').map(name => name.trim())
  .filter(name => ENGINES[name]);

let server = null;
export async function startSite() {
  await mkdir(EVIDENCE, { recursive: true });
  if (!LOCAL && !BUILD) return;
  const dir = resolve(root, LOCAL ? '.local/preview' : 'dist-production');
  await stat(resolve(dir, 'index.html'));
  server = createStaticServer({ root: dir, preview: true });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(4174, '127.0.0.1', resolveListen); });
}
export async function stopSite() { await new Promise(done => (server ? server.close(() => done()) : done())); }

export const launch = name => ENGINES[name].launch();

export async function person(browser, { width = 390, height = 844, label = 'persona' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires', hasTouch: width < 900 });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(`[${label}] pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Una respuesta 4xx esperada (regla del servidor) la informa la prueba.
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
    if (/Refused to apply a stylesheet/.test(text)) return; // captura de WebKit
    problems.push(`[${label}] console: ${text}`);
  });
  page.on('response', response => {
    if (response.status() >= 500) problems.push(`[${label}] HTTP ${response.status()} ${response.url()}`);
  });
  return { context, page, problems, label };
}

export async function ready(page, timeout = 30000) {
  await page.waitForFunction(() => document.querySelector('#main')?.getAttribute('aria-busy') === 'false', null, { timeout });
}
export async function open(page, hash) {
  await page.goto(`${SITE}/index.html${hash}`);
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
  await page.waitForFunction(() => !location.hash.startsWith('#cuenta'), null, { timeout: 30000 });
  await ready(page);
}
export async function shot(page, name) {
  await page.screenshot({ path: resolve(EVIDENCE, `${name}.png`), fullPage: false });
}
export async function report(name, data) {
  await writeFile(resolve(EVIDENCE, `${name}.json`), JSON.stringify(data, null, 2));
}

// Desbordes, controles fuera de pantalla y botones con área táctil baja.
export async function layoutIssues(page) {
  return page.evaluate(() => {
    const issues = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1) issues.push(`desborde horizontal: ${document.documentElement.scrollWidth}px en ${width}px`);
    // Una fila desplazable (rubros) puede tener elementos fuera de la pantalla
    // a propósito: cuenta el contenedor, que sí tiene que entrar.
    const scroller = element => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowX)) return node;
      }
      return null;
    };
    for (const element of document.querySelectorAll('#main button, #main a.button, #main input, #main select, .bottom-nav a')) {
      const style = getComputedStyle(element);
      const own = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !own.width || element.closest('[hidden]')) continue;
      const box = (scroller(element) || element).getBoundingClientRect();
      if (box.right > width + 1 || box.left < -1) issues.push(`fuera de pantalla: ${element.textContent.trim().slice(0, 30) || element.name}`);
    }
    return issues;
  });
}
