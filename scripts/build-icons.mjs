// Genera los íconos PNG y la imagen para compartir (og.png) a partir de los
// SVG de marca, con Chromium. Se versionan: sólo hace falta correrlo si cambia
// la marca.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { sofia } from '../js/ui/sofia.js';
import { sofia as generico } from '../js/ui/personaje-generico.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const favicon = await readFile(resolve(root, 'assets/brand/favicon.svg'), 'utf8');
const fontData = {};
for (const name of ['@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff2', '@fontsource/caveat-brush/files/caveat-brush-latin-400-normal.woff2']) {
  fontData[name] = `data:font/woff2;base64,${(await readFile(resolve(root, 'node_modules', name))).toString('base64')}`;
}
const font = name => fontData[name];
const browser = await chromium.launch();
const page = await browser.newPage();
async function shot(html, width, height, out) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face{font-family:'Lilita One';src:url('${font('@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff2')}')}
    @font-face{font-family:'Caveat Brush';src:url('${font('@fontsource/caveat-brush/files/caveat-brush-latin-400-normal.woff2')}')}
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await writeFile(resolve(root, out), await page.screenshot({ type: 'png', omitBackground: false }));
}
for (const size of [192, 512]) {
  await shot(`<div style="width:${size}px;height:${size}px">${favicon.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>`, size, size, `assets/brand/icon-${size}.png`);
}
await shot(`<div style="width:512px;height:512px;background:#b5432a;display:grid;place-items:center">${favicon.replace('<svg ', '<svg width="380" height="380" ')}</div>`, 512, 512, 'assets/brand/icon-maskable-512.png');
const ogHtml = art => `<div style="width:1200px;height:630px;display:grid;grid-template-columns:1fr 520px;align-items:center;background:repeating-linear-gradient(90deg,#f2557e 0 60px,#ee4a12 60px 120px)">
  <div style="margin-left:70px;background:#fffbf6;border-radius:36px;padding:48px 52px;box-shadow:0 20px 60px rgba(91,46,24,.25)">
    <div style="font-family:'Lilita One';font-size:120px;line-height:1;color:#b5432a">CAUCE</div>
    <div style="font-family:system-ui;font-weight:800;letter-spacing:.22em;font-size:26px;color:#f2557e;margin-top:6px">FERIAS NEUQUÉN</div>
    <div style="font-family:'Caveat Brush';font-size:64px;color:#6a5d24;margin-top:18px">Hecho cerca tuyo.</div></div>
  <div style="align-self:end">${art}</div></div>`;
await shot(ogHtml(sofia('bienvenida', { size: 500, animated: false })), 1200, 630, 'assets/brand/og.png');
// Para builds públicos sin la autorización de Sofía (FERIAS_PERSONAJE=generico).
await shot(ogHtml(generico('bienvenida', { size: 500, animated: false })), 1200, 630, 'assets/brand/og-generico.png');
await browser.close();
console.log('íconos, og.png y og-generico.png generados en assets/brand/');
