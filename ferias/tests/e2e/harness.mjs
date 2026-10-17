// E2E del build local (`npm run build:local`) contra el stack Supabase local
// de Ferias, en navegadores reales. Los datos de partida se crean por la API
// con identidades reales; lo que se prueba pasa por la interfaz.
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createStaticServer } from '../../scripts/serve.mjs';

export * from '../integration/harness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const BASE = 'http://127.0.0.1:4274/index.html';
export const EVIDENCE = resolve(root, 'evidence/e2e');
const ENGINES = { chromium, webkit };
export const browsersToRun = (process.env.FERIAS_E2E_BROWSERS || 'chromium,webkit').split(',').map(s => s.trim()).filter(name => ENGINES[name]);

let server = null;
export async function startPreview() {
  try { await stat(resolve(root, '.local/preview/index.html')); } catch { throw new Error('Falta el build local: `npm run build:local`.'); }
  await mkdir(EVIDENCE, { recursive: true });
  if (await fetch(BASE).then(r => r.ok).catch(() => false)) return;
  server = createStaticServer({ root: resolve(root, '.local/preview') });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(4274, '127.0.0.1', done); });
}
export const stopPreview = () => new Promise(done => (server ? server.close(() => done()) : done()));

/** Lanza el motor; si no está instalado en esta máquina devuelve null (la prueba lo informa). */
// Fuera del CI, un navegador sin instalar se omite; en el CI, falta = falla.
export async function launch(name) {
  try { return await ENGINES[name].launch(); } catch (error) {
    if (!process.env.CI && /Executable doesn't exist/.test(String(error.message))) return null;
    throw error;
  }
}

export async function person(browser, { width = 390, height = 844, label = 'persona', reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires',
    hasTouch: width < 900, reducedMotion, permissions: [] });
  const page = await context.newPage();
  const problems = [];
  problemsOf.set(page, problems);
  page.on('pageerror', error => problems.push(`[${label}] pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/status of 4\d\d/.test(text)) return;
    problems.push(`[${label}] console: ${text}`);
  });
  page.on('response', response => { if (response.status() >= 500) problems.push(`[${label}] HTTP ${response.status()} ${response.url()}`); });
  return { context, page, problems, label };
}

export async function ready(page, timeout = 25000) {
  await page.waitForFunction(() => document.querySelector('#main')?.getAttribute('aria-busy') === 'false', null, { timeout });
}
export async function open(page, hash) { await page.goto(`${BASE}${hash}`); await ready(page); }
export async function go(page, hash) {
  await page.evaluate(target => { location.hash = target; }, hash);
  await page.waitForFunction(target => location.hash === target, hash);
  await ready(page);
}
export async function signIn(page, user) {
  await open(page, '#/cuenta');
  await page.fill('#si-email', user.email);
  await page.fill('#si-password', user.password);
  await page.click('form[data-form="signin"] button[type="submit"]');
  await page.waitForFunction(() => !location.hash.startsWith('#/cuenta'), null, { timeout: 20000 });
  await ready(page);
}
export async function expectToast(page, pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  try {
    await page.waitForFunction(source => {
      const toast = document.querySelector('#toast');
      return toast && !toast.hidden && new RegExp(source).test(toast.textContent);
    }, regex.source, { timeout: 15000 });
  } catch (error) {
    const seen = await page.evaluate(() => `${document.querySelector('#toast')?.textContent || '(sin aviso)'} · ${location.hash}`).catch(() => '');
    throw new Error(`No apareció el aviso ${regex}: ${seen}`, { cause: error });
  }
}
const problemsOf = new WeakMap();
// Al capturar, Playwright inyecta una hoja de estilos (oculta el cursor y frena
// animaciones); en WebKit la CSP de la aplicación la bloquea, y está bien. Sólo
// esos avisos, emitidos durante la captura, no cuentan como problemas.
export async function shot(page, name) {
  const problems = problemsOf.get(page) || [];
  const before = problems.length;
  await page.screenshot({ path: resolve(EVIDENCE, `${name}.png`), animations: 'disabled' });
  await new Promise(done => setTimeout(done, 150));
  const during = problems.splice(before);
  problems.push(...during.filter(text => !/Refused to apply a stylesheet/.test(text)));
}
export const textOf = async (page, selector) => (await page.locator(selector).first().textContent() || '').trim();
