import { chromium, devices } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { findChrome } from './lib/cdp.mjs';
import { createStaticServer } from '../scripts/server.mjs';

const out = process.env.OUT_DIR || 'evidence/mifav';
const executablePath = findChrome();
if (!executablePath) {
  console.error('No se encontró Chrome ni Edge. Definí CAUCE_CHROME_PATH.');
  process.exit(1);
}
await mkdir(out, { recursive: true });

// Recorrido autocontenido: sirve la aplicación y usa el Chrome instalado.
const server = createStaticServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lV0fWQAAAABJRU5ErkJggg==', 'base64');
const results = [];
const browser = await chromium.launch({ executablePath });

function watch(page, errors) {
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
}

async function settle(page) {
  await page.waitForFunction(() => document.querySelector('#main')?.getAttribute('aria-busy') === 'false');
}

async function shot(page, name, { fullPage = false } = {}) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage });
}

async function metrics(page) {
  return page.evaluate(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.innerText || '',
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    cards: document.querySelectorAll('.mifav-product-card').length,
    navVisible: (() => { const nav = document.querySelector('.mifav-bottom-nav'); return nav ? getComputedStyle(nav).display !== 'none' : false; })(),
  }));
}

// ── Escritorio ──────────────────────────────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(base, { waitUntil: 'networkidle' });
  await settle(page);

  await page.fill('#home-search-input', 'lámpara');
  await page.press('#home-search-input', 'Enter');
  await page.waitForSelector('.mifav-product-card');
  await settle(page);
  const searchH1 = await page.locator('h1').innerText();
  const searchCards = await page.locator('.mifav-product-card').count();
  const searchNames = await page.locator('.mifav-product-name').allInnerTexts();
  results.push({ step: 'desktop-search-lampara', searchH1, searchCards, searchNames });

  await page.click('[data-action="clear-filters"]');
  await page.waitForSelector('.mifav-product-card');
  await settle(page);
  const allCards = await page.locator('.mifav-product-card').count();
  await shot(page, 'desktop-explore', { fullPage: true });
  results.push({ step: 'desktop-explore', allCards, metrics: await metrics(page) });

  await page.click('[data-action="set-condition"][data-condition="used"]');
  await settle(page);
  const usedCards = await page.locator('.mifav-product-card').count();
  const usedConditions = await page.locator('.mifav-condition').allInnerTexts();
  results.push({ step: 'desktop-filter-used', usedCards, usedConditions });
  if (!usedCards || usedConditions.some(text => !/usado/i.test(text))) throw new Error('El filtro Usados devolvió artículos nuevos');

  await page.click('[data-action="clear-filters"]');
  await settle(page);
  await page.click('[data-action="set-category"][data-category="Tecnología"]');
  await settle(page);
  const techCards = await page.locator('.mifav-product-card').count();
  const techNames = await page.locator('.mifav-product-name').allInnerTexts();
  results.push({ step: 'desktop-filter-technology', techCards, techNames });

  await page.click('[data-action="clear-filters"]');
  await page.waitForSelector('a[href="#producto/taller-malva/camisa-lino"]');
  await page.click('a[href="#producto/taller-malva/camisa-lino"]');
  await page.waitForSelector('.mifav-detail');
  await settle(page);
  const detail = {
    h1: await page.locator('.mifav-detail-body h1').innerText(),
    price: await page.locator('.mifav-detail-price').innerText(),
    seller: await page.locator('.mifav-seller-card h2').innerText(),
    condition: await page.locator('.mifav-detail-topline .mifav-condition').innerText(),
    facts: await page.locator('.mifav-detail-facts li').allInnerTexts(),
  };
  await shot(page, 'desktop-product', { fullPage: true });
  results.push({ step: 'desktop-product', detail });

  await page.click('.mifav-detail-favorite .favorite-button');
  await settle(page);
  const pressed = await page.locator('.mifav-detail-favorite .favorite-button').getAttribute('aria-pressed');
  await page.goto(`${base}/#favoritos`, { waitUntil: 'networkidle' });
  await settle(page);
  const favoriteNames = await page.locator('.mifav-product-name').allInnerTexts();
  await shot(page, 'desktop-favorites', { fullPage: true });
  results.push({ step: 'desktop-favorites', pressed, favoriteNames });

  await page.goto(`${base}/#ferias`, { waitUntil: 'networkidle' });
  await settle(page);
  await shot(page, 'desktop-ferias', { fullPage: true });
  results.push({ step: 'desktop-ferias', h1: await page.locator('h1').innerText() });

  await page.goto(`${base}/#publicar`, { waitUntil: 'networkidle' });
  await settle(page);
  const gate = await page.locator('#main').innerText();
  await page.click('[data-action="use-identity"]');
  await page.waitForSelector('[data-form="publish-review"]');
  await settle(page);
  await page.fill('#publish-name', 'Lámpara de prueba');
  await page.fill('#publish-description', 'Pantalla tejida en mimbre. Usada, en buen estado.');
  await page.selectOption('#publish-category', 'Hogar');
  await page.check('input[name="condition"][value="used"]');
  await page.fill('#publish-price', '17500');
  await page.fill('#publish-stock', '2');
  await page.setInputFiles('#publish-image', { name: 'lampara.png', mimeType: 'image/png', buffer: PNG });
  await page.click('[data-form="publish-review"] button[type="submit"]');
  await page.waitForSelector('.mifav-review');
  await settle(page);
  const review = {
    title: await page.locator('.mifav-review-body h2').innerText(),
    kicker: await page.locator('.mifav-review-body .mifav-product-kicker').innerText(),
    notice: await page.locator('.mifav-review-body .notice').innerText(),
    image: await page.locator('.mifav-review-photo img').count(),
  };
  await shot(page, 'desktop-publish-review', { fullPage: true });
  await page.click('[data-action="publish-confirm"]');
  await page.waitForFunction(() => location.hash.startsWith('#producto/'));
  await settle(page);
  const published = {
    hash: await page.evaluate(() => location.hash),
    h1: await page.locator('.mifav-detail-body h1').innerText(),
    price: await page.locator('.mifav-detail-price').innerText(),
    condition: await page.locator('.mifav-detail-topline .mifav-condition').innerText(),
    hasImage: await page.locator('.mifav-detail-media img').count(),
  };
  results.push({ step: 'desktop-publish', gate: gate.slice(0, 300), review, published, errors });
  await context.close();
}

// ── Móvil ───────────────────────────────────────────────────────────────────
{
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(base, { waitUntil: 'networkidle' });
  await settle(page);
  const searchBox = await page.evaluate(() => {
    const form = document.querySelector('.mifav-search');
    const input = form.querySelector('input');
    const icon = form.querySelector('.search-icon');
    const button = form.querySelector('button');
    return {
      formHeight: Math.round(form.getBoundingClientRect().height),
      iconPosition: getComputedStyle(icon).position,
      iconTop: Math.round(icon.getBoundingClientRect().top),
      inputTop: Math.round(input.getBoundingClientRect().top),
      buttonTop: Math.round(button.getBoundingClientRect().top),
      inputWidth: Math.round(input.getBoundingClientRect().width),
    };
  });
  await shot(page, 'mobile-home-viewport');
  await page.click('#bnav-comercios');
  await page.waitForSelector('.mifav-product-card');
  await settle(page);
  const mobileExplore = await metrics(page);
  const filterScroll = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.mifav-filter-scroll')];
    return rows.map(row => ({ clientWidth: row.clientWidth, scrollWidth: row.scrollWidth }));
  });
  await shot(page, 'mobile-explore', { fullPage: true });
  results.push({ step: 'mobile-explore', searchBox, mobileExplore, filterScroll });

  await page.click('a[href="#producto/taller-malva/camisa-lino"]');
  await page.waitForSelector('.mifav-detail');
  await settle(page);
  await page.click('.mifav-detail-favorite .favorite-button');
  await settle(page);
  await shot(page, 'mobile-product', { fullPage: true });
  await page.goto(`${base}/#favoritos`, { waitUntil: 'networkidle' });
  await settle(page);
  await shot(page, 'mobile-favorites', { fullPage: true });
  const mobileFavorites = await page.locator('.mifav-product-name').allInnerTexts();
  await page.goto(`${base}/#publicar`, { waitUntil: 'networkidle' });
  await settle(page);
  await shot(page, 'mobile-publish-gate', { fullPage: true });
  await page.goto(`${base}/#ferias`, { waitUntil: 'networkidle' });
  await settle(page);
  await shot(page, 'mobile-ferias', { fullPage: true });
  results.push({ step: 'mobile-flow', mobileFavorites, errors });
  await context.close();
}

await writeFile(`${out}/journey-results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
await new Promise(resolve => server.close(resolve));
