// Captura pantallas reales de la aplicación servida localmente.
// Uso: node tests/capture-screens.mjs <carpeta-destino> [--base http://127.0.0.1:4173]
import { launchBrowser } from './lib/cdp.mjs';
import { createStaticServer } from '../scripts/server.mjs';

const output = process.argv[2] || 'evidence/screens';
const baseIndex = process.argv.indexOf('--base');
const externalBase = baseIndex > -1 ? process.argv[baseIndex + 1] : null;

const ROUTES = [
  ['home', '#home'],
  ['comercios', '#comercios'],
  ['taxi', '#taxi'],
  ['actividad', '#actividad'],
  ['institucional', '#institucional'],
];

const WIDTHS = [360, 390, 430];

async function withServer(run) {
  if (externalBase) return run(externalBase);
  const server = createStaticServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { return await run(`http://127.0.0.1:${port}`); }
  finally { server.close(); }
}

await withServer(async base => {
  const browser = await launchBrowser();
  const results = [];
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage({ width, height: 844, mobile: true });
      for (const [name, hash] of ROUTES) {
        await page.goto(`${base}/index.html${hash}`);
        await page.waitForFunction('document.querySelector("#main")?.children.length > 0').catch(() => {});
        const file = `${output}/${width}-${name}.png`;
        await page.screenshot(file, { fullPage: true });
        const overflow = await page.evaluate(
          'document.documentElement.scrollWidth - document.documentElement.clientWidth');
        results.push({ width, route: hash, file, horizontalOverflowPx: overflow });
      }
      await page.close();
    }
    const desktop = await browser.newPage({ width: 1440, height: 900, mobile: false });
    for (const [name, hash] of ROUTES) {
      await desktop.goto(`${base}/index.html${hash}`);
      const file = `${output}/desktop-${name}.png`;
      await desktop.screenshot(file, { fullPage: true });
      results.push({ width: 1440, route: hash, file, horizontalOverflowPx: 0 });
    }
    await desktop.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
});
