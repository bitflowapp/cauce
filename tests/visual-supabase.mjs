import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/server.mjs';
import { launchBrowser } from './lib/cdp.mjs';
const server = createStaticServer({ root: fileURLToPath(new URL('../.local/supabase-preview', import.meta.url)), supabase: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launchBrowser();
const rows = [];
try {
  await mkdir('evidence/supabase', { recursive: true });
  for (const width of [360, 390, 430, 1440]) {
    const page = await browser.newPage({ width, height: 900, mobile: width < 1000 });
    for (const route of ['inicio', 'cuenta']) {
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html#${route}`);
      await page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
      const measurement = await page.evaluate(`(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        heading: document.querySelector('#main h1')?.textContent,
        hiddenLinksVisible: [...document.querySelectorAll('a[hidden]')].filter(a => a.getBoundingClientRect().height > 0).length,
        smallButtons: [...document.querySelectorAll('#main button')].filter(b => b.getBoundingClientRect().height < 44).length,
      }))()`);
      assert.equal(measurement.overflow, false);
      assert.equal(measurement.hiddenLinksVisible, 0);
      assert.equal(measurement.smallButtons, 0);
      assert.match(measurement.heading, route === 'inicio' ? /CAUCE/ : /Ingresar a CAUCE/);
      await page.screenshot(`evidence/supabase/${width}-${route}.png`, { fullPage: true });
      rows.push({ width, route, ...measurement });
    }
    await page.close();
  }
  console.log(`SUPABASE VISUAL PASS · ${rows.length} pantallas · sin overflow ni accesos ocultos visibles`);
} finally {
  await browser.close(); server.close();
  await writeFile('evidence/supabase-visual.json', JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
}
