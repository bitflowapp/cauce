// Hoja de personaje: renderiza todas las escenas de Sofía en Chromium y guarda
// una captura (docs/evidencia/sofia-escenas.png). Sirve para revisar que las
// proporciones se mantengan entre poses.
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { sofia, SCENE_NAMES } from '../js/ui/sofia.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, process.argv[2] || 'docs/evidencia/sofia-escenas.png');
const fonts = resolve(root, 'node_modules/@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff2');
const css = await readFile(resolve(root, 'styles/ferias.css'), 'utf8').catch(() => '');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'Lilita One';src:url('data:font/woff2;base64,${(await readFile(fonts)).toString('base64')}') format('woff2')}
body{margin:0;background:#faf2e8;font-family:system-ui;color:#3b2218}
.grid{display:grid;grid-template-columns:repeat(3,260px);gap:18px;padding:24px}
figure{margin:0;background:#fffaf4;border-radius:18px;padding:12px;text-align:center}
figcaption{font-size:14px;margin-top:6px}
${css}
</style></head><body><div class="grid">${SCENE_NAMES.map(name => `<figure>${sofia(name, { size: 236, animated: false })}<figcaption>${name}</figcaption></figure>`).join('')}</div></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 880, height: 900 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await mkdir(resolve(out, '..'), { recursive: true });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(`hoja de personaje → ${out}`);
