// Auditoría responsive, accesibilidad básica y rendimiento del build conectado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  account, makeAdmin, publishedBusiness, closeAll, ok, order, sql,
  startPreview, stopPreview, browsersToRun, launch, person, open, go, ready, signIn, shot, layoutIssues, writeReport, BASE,
} from './harness.mjs';

const WIDTHS = [320, 375, 390, 430, 768, 1024, 1440];
const people = {};
let R, orderId, token;
const report = { screens: [], contrast: [], keyboard: {}, performance: {} };

before(async () => {
  await startPreview();
  for (const name of ['owner', 'admin', 'buyer']) people[name] = await account(`audit-${name}`);
  await makeAdmin(people.admin);
  R = await publishedBusiness(people.owner, people.admin, { name: 'Auditoria Visual' });
  ok(await people.owner.client.rpc('set_business_hours', { business: R.id, hours: [0, 1, 2, 3, 4, 5, 6]
    .flatMap(weekday => [{ weekday, opens: '00:00', closes: '12:00' }, { weekday, opens: '12:00', closes: '23:59' }]) }));
  ok(await people.owner.client.from('businesses').update({ whatsapp: '2942 555111', prep_minutes: 25, delivery_minutes: 20,
    description: 'Panadería y rotisería del centro, con envío en el casco urbano.' }).eq('id', R.id));
  orderId = ok(await order(people.buyer, R.id, [{ product_id: R.products.untracked.id, quantity: 2 }], { fulfillment: 'pickup' }));
  [{ tracking_token: token }] = await sql`select tracking_token from public.orders where id = ${orderId}`;
});
after(async () => {
  await writeReport('audit', report);
  await stopPreview();
  await closeAll(Object.values(people));
});

// Contraste WCAG del texto visible contra su fondo efectivo.
async function contrastIssues(page) {
  return page.evaluate(() => {
    const parse = value => (value.match(/[\d.]+/g) || []).map(Number);
    const luminance = ([r, g, b]) => {
      const channel = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const background = element => {
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage && style.backgroundImage !== 'none') return null;
        const color = parse(style.backgroundColor);
        if (color.length >= 3 && (color.length < 4 || color[3] > 0.95)) return color.slice(0, 3);
      }
      return [255, 255, 255];
    };
    const issues = [];
    const seen = new Set();
    for (const element of document.querySelectorAll('#main *, .header *, .bottom-nav *')) {
      const text = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
      if (!text || seen.has(text)) continue;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!box.width || !box.height || style.visibility === 'hidden' || Number(style.opacity) < 0.5) continue;
      if (element.closest('[aria-hidden="true"], .visually-hidden, [hidden]')) continue;
      const bg = background(element);
      if (!bg) continue;
      const fg = parse(style.color).slice(0, 3);
      const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      const ratio = (light + 0.05) / (dark + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        seen.add(text);
        issues.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 40)}"`);
      }
    }
    return issues;
  });
}

for (const engine of browsersToRun) {
  test(`${engine}: pantallas críticas sin desbordes, botones fuera de pantalla ni campos sin etiqueta`, async () => {
    const browser = await launch(engine);
    const failures = [];
    try {
      for (const width of WIDTHS) {
        const height = width < 768 ? 800 : 900;
        const visitor = await person(browser, { width, height, label: `visita ${width}` });
        const buyer = await person(browser, { width, height, label: `cliente ${width}` });
        const merchant = await person(browser, { width, height, label: `comercio ${width}` });
        await buyer.page.goto(`${BASE}/index.html#inicio`);
        // La sesión del cliente es la de la API: se copia al almacenamiento.
        const { data } = await people.buyer.client.auth.getSession();
        await buyer.page.evaluate(session => localStorage.setItem('cauce:production:auth', JSON.stringify(session)), data.session);
        await signIn(merchant.page, people.owner);
        const screens = [
          [visitor, '#inicio'], [visitor, '#comercios'], [visitor, `#comercio/${R.id}`], [visitor, '#cuenta'],
          [visitor, '#institucional'], [visitor, `#seguimiento/${token}`],
          [buyer, `#pedido/${orderId}`], [buyer, '#actividad'],
          [merchant, `#panel/${R.id}`], [merchant, `#panel/${R.id}/pedidos`], [merchant, `#panel/${R.id}/catalogo`],
          [merchant, `#panel/${R.id}/configuracion`], [merchant, `#panel/${R.id}/horarios`], [merchant, `#panel/${R.id}/reparto`],
          [merchant, `#panel/${R.id}/equipo`],
        ];
        for (const [who, hash] of screens) {
          if (who.page.url().endsWith(hash)) await who.page.reload(); else await open(who.page, hash);
          await ready(who.page);
          const issues = await layoutIssues(who.page);
          const contrast = width === 390 ? await contrastIssues(who.page) : [];
          const name = hash;
          report.screens.push({ engine, width, screen: name, issues });
          if (contrast.length) report.contrast.push({ engine, screen: name, contrast });
          for (const issue of [...issues, ...contrast.map(item => `contraste ${item}`)]) failures.push(`${engine} ${width}px ${name}: ${issue}`);
          if ([320, 390, 768, 1440].includes(width)) {
            await shot(who.page, `${engine}-${width}-${name.replace(/[#/:]+/g, '_').replace(/_[0-9a-f-]{36}/, '')}`);
          }
        }
        // Carrito con productos, en el mismo ancho.
        await open(visitor.page, `#comercio/${R.id}`);
        await visitor.page.locator('article.product-card', { has: visitor.page.locator('h3:text-is("Empanada de carne")') })
          .getByRole('button', { name: 'Agregar' }).click();
        await ready(visitor.page);
        await go(visitor.page, `#carrito/${R.id}`);
        for (const issue of await layoutIssues(visitor.page)) failures.push(`${engine} ${width}px #carrito: ${issue}`);
        if ([320, 390, 1440].includes(width)) await shot(visitor.page, `${engine}-${width}-carrito`);
        for (const who of [visitor, buyer, merchant]) {
          failures.push(...who.problems);
          await who.context.close();
        }
      }
      assert.deepEqual(failures, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: diálogo usable a 320 px y navegación por teclado`, async () => {
    const browser = await launch(engine);
    try {
      const merchant = await person(browser, { width: 320, height: 640, label: 'comercio 320' });
      const pending = ok(await order(people.buyer, R.id, [{ product_id: R.products.untracked.id, quantity: 1 }]));
      await signIn(merchant.page, people.owner);
      await go(merchant.page, `#panel/${R.id}`);
      const [{ code }] = await sql`select code from public.orders where id = ${pending}`;
      await merchant.page.locator(`article[aria-label="Pedido ${code}"]`).getByRole('button', { name: 'Rechazar' }).click();
      const dialog = merchant.page.locator('dialog.cauce-dialog');
      await dialog.waitFor();
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 320, 'el diálogo entra en 320 px');
      for (const button of await dialog.locator('button').all()) {
        const rect = await button.boundingBox();
        assert.ok(rect.y + rect.height <= 640 && rect.height >= 40, 'botones del diálogo visibles y tocables');
      }
      await merchant.page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal((await sql`select status from public.orders where id = ${pending}`)[0].status, 'submitted');
      await shot(merchant.page, `${engine}-320-panel-tras-dialogo`);

      // Teclado: saltar al contenido, llegar a "Agregar" y agregar sin mouse.
      const visitor = await person(browser, { width: 390, height: 800, label: 'teclado' });
      await open(visitor.page, `#comercio/${R.id}`);
      await visitor.page.keyboard.press('Tab');
      assert.equal(await visitor.page.evaluate(() => document.activeElement?.className), 'skip');
      // Enter en "Saltar al contenido": el foco va al contenido y la ruta no cambia.
      await visitor.page.keyboard.press('Enter');
      assert.deepEqual(await visitor.page.evaluate(() => [location.hash, document.activeElement?.id]), [`#comercio/${R.id}`, 'main']);
      let reached = false;
      for (let i = 0; i < 40 && !reached; i += 1) {
        await visitor.page.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
        reached = await visitor.page.evaluate(() => document.activeElement?.textContent?.trim() === 'Agregar');
      }
      assert.ok(reached, 'el botón Agregar se alcanza con el teclado');
      const outline = await visitor.page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
      });
      assert.ok(outline, 'el foco se ve');
      await visitor.page.keyboard.press('Enter');
      await visitor.page.locator('.sticky-cart-bar').waitFor();
      report.keyboard[engine] = 'saltar al contenido, tabular hasta Agregar, foco visible y Enter agregan al carrito';
      assert.deepEqual([...merchant.problems, ...visitor.problems], []);
    } finally { await browser.close(); }
  });
}

test('rendimiento con red móvil (1,6 Mbps, 150 ms) y CPU 4× más lenta', { skip: !browsersToRun.includes('chromium') }, async () => {
  const browser = await launch('chromium');
  try {
    const measure = async (context, page, label, reload = false) => {
      const started = Date.now();
      if (reload) await page.reload(); else await page.goto(`${BASE}/index.html#inicio`);
      await ready(page, 60000);
      const elapsed = Date.now() - started;
      const bytes = await page.evaluate(() => performance.getEntriesByType('resource')
        .concat(performance.getEntriesByType('navigation')).reduce((sum, entry) => sum + (entry.transferSize || 0), 0));
      report.performance[label] = { ms: elapsed, transferredKB: Math.round(bytes / 1024) };
      return elapsed;
    };
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const cold = await measure(context, page, 'primera visita');
    const warm = await measure(context, page, 'visita repetida', true);
    assert.ok(cold < 12000, `primera visita en ${cold} ms`);
    assert.ok(warm < 6000, `visita repetida en ${warm} ms`);
  } finally { await browser.close(); }
});
