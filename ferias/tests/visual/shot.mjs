// Captura rápida de una ruta (herramienta de desarrollo):
//   node tests/visual/shot.mjs '#/ruta' salida.png [ancho] [alto] [full]
import { chromium } from 'playwright';

const [hash = '#/', out = 'shot.png', width = '390', height = '844', full = ''] = process.argv.slice(2);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires' });
const page = await context.newPage();
const problems = [];
page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
await page.goto(`http://127.0.0.1:4274/index.html${hash}`);
await page.waitForFunction(() => document.querySelector('#main')?.getAttribute('aria-busy') === 'false', null, { timeout: 20000 }).catch(() => problems.push('timeout'));
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await page.screenshot({ path: out, fullPage: full === 'full' });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log(JSON.stringify({ hash, overflow, problems }));
await browser.close();
