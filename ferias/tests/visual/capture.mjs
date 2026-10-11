// Auditoría visual y responsive contra el build local con datos de demostración
// (`npm run db:reset && npm run seed:demo && npm run build:local`, vista previa en
// el puerto 4274). Recorre las pantallas públicas y los paneles en 320, 360,
// 390, 430, 768, 1280 y 1440 px; mide desborde horizontal, errores de consola,
// respuestas 5xx, controles táctiles chicos y textos sin contraste suficiente.
// Guarda capturas en evidence/visual/ y un informe JSON.
//
//   node tests/visual/capture.mjs [--browsers=chromium,webkit] [--widths=390,1280]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { createStaticServer } from '../../scripts/serve.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const WIDTHS = (arg('widths') || '320,360,390,430,768,1280,1440').split(',').map(Number);
const ENGINES = { chromium, webkit };
const BROWSERS = (arg('browsers') || 'chromium').split(',').filter(name => ENGINES[name]);
const OUT = resolve(root, 'evidence/visual');
const BASE = 'http://127.0.0.1:4274/index.html';

const credentials = JSON.parse(await readFile(resolve(root, '.local/demo-credenciales.json'), 'utf8'));
const cred = role => credentials.find(c => c.rol === role);
const status = JSON.parse((s => s.slice(s.indexOf('{')))(execFileSync('npx', ['supabase', 'status', '-o', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })));
const anon = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false } });
const taza = (await anon.from('products').select('id').eq('name', 'Taza patagónica').single()).data.id;
const fairRow = (await anon.from('fairs').select('id,slug').eq('name', 'Feria del Parque Central').single()).data;
const fair = fairRow.slug;
const tracking = (await (async () => {
  const merchant = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false } });
  await merchant.auth.signInWithPassword({ email: cred('raices').email, password: cred('raices').password });
  const { data } = await merchant.from('orders').select('tracking_token').eq('fulfillment', 'fair_pickup').limit(1).single();
  return data.tracking_token;
})());

const PUBLIC = [
  ['inicio', '#/'], ['explorar', '#/explorar?loc='], ['tienda', '#/tienda/tierra-viva'], ['producto', `#/producto/${taza}`],
  ['ferias', '#/ferias?loc='], ['feria', `#/feria/${fair}`], ['comunidad', '#/comunidad'], ['planes', '#/planes'], ['sobre', '#/sobre'],
  ['seguimiento', `#/pedido/${tracking}`], ['carrito-vacio', '#/carrito'], ['cuenta', '#/cuenta'], ['crear-cuenta', '#/cuenta/crear'],
  ['alta', '#/alta'], ['busqueda-vacia', '#/explorar?q=zzzzzz&loc='],
];
const PRIVATE = {
  raices: [['panel', '#/panel'], ['panel-pedidos', '#/panel/pedidos'], ['panel-productos', '#/panel/productos'],
    ['panel-producto', '#/panel/producto/nuevo'], ['panel-inventario', '#/panel/inventario'], ['panel-tienda', '#/panel/tienda'],
    ['panel-ferias', '#/panel/ferias'], ['panel-estadisticas', '#/panel/estadisticas'], ['panel-plan', '#/panel/plan'], ['panel-equipo', '#/panel/equipo']],
  organiza: [['organizador', '#/organizador'], ['organizador-feria', `#/organizador/feria/${fairRow.id}`],
    ['organizador-participantes', `#/organizador/feria/${fairRow.id}?tab=participantes`], ['organizador-nueva', '#/organizador/nueva']],
  admin: [['admin', '#/admin'], ['admin-tiendas', '#/admin/tiendas'], ['admin-organizadores', '#/admin/organizadores'], ['admin-comunidad', '#/admin/comunidad'], ['admin-registro', '#/admin/registro']],
};

async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#main')?.getAttribute('aria-busy') === 'false', null, { timeout: 25000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

// Mediciones dentro de la página: desborde, objetivos táctiles y contraste.
function measure() {
  const luminance = rgb => {
    const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = color => (color.match(/[\d.]+/g) || []).map(Number);
  const background = el => {
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage !== 'none') return null;
      const [r, g, b, a = 1] = parse(cs.backgroundColor);
      if (a > 0.9) return [r, g, b];
    }
    return [255, 255, 255];
  };
  const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const wide = [...document.querySelectorAll('#main *')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > document.documentElement.clientWidth + 1 && !el.closest('.chips,.scroller,.categories,.tabs,.segmented,.table-wrap,.gallery-track,.cover,.gallery');
  }).slice(0, 5).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
  const small = [...document.querySelectorAll('a[href], button, input, select, textarea')].filter(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || el.closest('.sr-only,[hidden]') || getComputedStyle(el).visibility === 'hidden') return false;
    if (el.matches('input[type="checkbox"], input[type="radio"], input[type="file"]') && el.closest('label')) return false;
    if (el.matches('.footer-links a, p a, .kv a, .link-more, .chips a, .xsmall a') ) return false;
    return r.height < 32 || r.width < 32;
  }).slice(0, 6).map(el => `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
  const lowContrast = [];
  for (const el of document.querySelectorAll('#main p, #main span, #main a, #main strong, #main h1, #main h2, #main h3, #main button, #main label, #main dd, #main dt, #main li')) {
    if (!el.childNodes.length || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || el.closest('[hidden],.sr-only,svg')) continue;
    const bg = background(el);
    if (!bg) continue;
    const fg = parse(cs.color);
    const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.6 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) lowContrast.push(`${el.textContent.trim().slice(0, 30)} (${ratio.toFixed(2)})`);
    if (lowContrast.length >= 6) break;
  }
  return { overflow, wide, small, lowContrast };
}

// Si ya hay una vista previa corriendo en 4274, se usa esa.
const running = await fetch(BASE).then(r => r.ok).catch(() => false);
const server = running ? null : createStaticServer({ root: resolve(root, '.local/preview') });
if (server) await new Promise((done, fail) => { server.once('error', fail); server.listen(4274, '127.0.0.1', done); });
const report = [];
for (const engine of BROWSERS) {
  const browser = await ENGINES[engine].launch();
  for (const width of WIDTHS) {
    const height = width >= 1024 ? 900 : width >= 700 ? 1024 : 844;
    const shoot = async (context, list, label) => {
      const page = await context.newPage();
      const problems = [];
      page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
      page.on('console', message => { if (message.type() === 'error' && !/status of 4\d\d/.test(message.text())) problems.push(`console: ${message.text().slice(0, 160)}`); });
      page.on('response', response => { if (response.status() >= 500) problems.push(`HTTP ${response.status()} ${response.url()}`); });
      for (const [name, hash] of list) {
        problems.length = 0;
        await page.goto(`${BASE}${hash}`);
        await ready(page).catch(() => problems.push('timeout'));
        const metrics = await page.evaluate(measure);
        await mkdir(resolve(OUT, engine, String(width)), { recursive: true });
        await page.screenshot({ path: resolve(OUT, engine, String(width), `${name}.png`), fullPage: false, animations: 'disabled' });
        report.push({ engine, width, name, who: label, ...metrics, problems: [...problems] });
        const flag = metrics.overflow > 0 || metrics.wide.length || problems.length ? '✗' : '✓';
        console.log(`${flag} ${engine} ${String(width).padStart(4)} ${name.padEnd(20)} desborde=${metrics.overflow} ${metrics.wide.join(' ')} ${problems.join(' | ')}`);
      }
      await page.close();
    };
    const visitor = await browser.newContext({ viewport: { width, height }, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', hasTouch: width < 900, reducedMotion: 'reduce' });
    await shoot(visitor, PUBLIC, 'visita');
    // Carrito con un producto, para ver el checkout.
    const buyer = await visitor.newPage();
    await buyer.goto(`${BASE}#/producto/${taza}`);
    await ready(buyer);
    await buyer.click('[data-action="add"]');
    await buyer.close();
    await shoot(visitor, [['carrito', '#/carrito']], 'visita');
    await visitor.close();
    for (const [role, list] of Object.entries(PRIVATE)) {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', hasTouch: width < 900, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(`${BASE}#/cuenta`);
      await ready(page);
      await page.fill('#si-email', cred(role).email);
      await page.fill('#si-password', cred(role).password);
      await page.click('form[data-form="signin"] button[type="submit"]');
      await page.waitForFunction(() => !location.hash.startsWith('#/cuenta'), null, { timeout: 20000 });
      await page.close();
      await shoot(context, list, role);
      await context.close();
    }
  }
  await browser.close();
}
server?.close();
await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'informe.json'), JSON.stringify(report, null, 2));
const failing = report.filter(r => r.overflow > 0 || r.wide.length || r.problems.length);
const touch = report.filter(r => r.small.length && r.width < 900);
const contrast = report.filter(r => r.lowContrast.length);
console.log(`\n${report.length} capturas · ${failing.length} con desborde o errores · ${touch.length} con controles chicos (móvil) · ${contrast.length} con texto de bajo contraste`);
for (const r of touch.slice(0, 8)) console.log(`  táctil ${r.engine} ${r.width} ${r.name}: ${r.small.join(', ')}`);
for (const r of contrast.slice(0, 8)) console.log(`  contraste ${r.engine} ${r.width} ${r.name}: ${r.lowContrast.join(', ')}`);
process.exitCode = failing.length ? 1 : 0;
