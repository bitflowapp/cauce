// Recorridos completos en navegadores reales (Chromium y WebKit) contra el
// build local y el stack Supabase local de CAUCE · Ferias.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPreview, stopPreview, launch, person, open, go, signIn, expectToast, shot, browsersToRun, ready,
  sql, admin, run, ok, account, guest, makeAdmin, publishedBusiness, order, latestMail, tinyPng } from './harness.mjs';

let reviewer, merchantA, merchantB, organizerUser, shopA, organizerId, fairId, fairSlug;
const created = { emails: [] };

before(async () => {
  await startPreview();
  reviewer = await account('AdminE2E');
  await makeAdmin(reviewer);
  merchantA = await account('TallerE2E');
  merchantB = await account('OtraE2E');
  organizerUser = await account('OrgE2E');
  shopA = await publishedBusiness(merchantA, reviewer, { name: 'Taller', stock: 6 });
  await publishedBusiness(merchantB, reviewer, { name: 'Otra', plan: 'entrada' });
  organizerId = ok(await reviewer.client.rpc('admin_create_organizer', { organizer_name: `Org E2E ${run}`, owner_email: organizerUser.email }), 'org');
  ok(await reviewer.client.rpc('admin_set_subscription', { organizer: organizerId, plan: 'organizador', plan_status: 'active', period_end: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) }), 'plan');
  const starts = new Date(Date.now() + 4 * 86400000);
  const fair = ok(await organizerUser.client.rpc('create_fair', { organizer: organizerId, payload: { name: `Feria E2E ${run}`, venue: 'Parque E2E', locality: 'neuquen',
    starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 8 * 3600000).toISOString(), latitude: -38.95, longitude: -68.06 } }), 'feria');
  ok(await organizerUser.client.rpc('set_fair_status', { fair: fair.id, next_status: 'published', reason: '' }), 'publicar');
  const p = ok(await merchantA.client.rpc('apply_to_fair', { fair: fair.id, business: shopA.id }), 'inscripción');
  ok(await organizerUser.client.rpc('decide_participation', { participation: p, decision: 'confirmed', stall: 'B9', note: '' }), 'puesto');
  fairId = fair.id; fairSlug = fair.slug;
});

after(async () => {
  try {
    const users = await sql`select id from auth.users where email like ${`qa-${run}-%`}`;
    const ids = users.map(u => u.id);
    const owned = ids.length ? await sql`select business_id from public.business_memberships where user_id = any(${ids}) and role = 'owner'` : [];
    const bids = owned.map(b => b.business_id);
    if (bids.length) {
      await sql`delete from public.orders where business_id = any(${bids})`;
      const files = await sql`select name from storage.objects where bucket_id = 'ferias-media' and split_part(name, '/', 2) = any(${bids.map(String)})`;
      if (files.length) await admin.storage.from('ferias-media').remove(files.map(f => f.name));
      await sql`delete from public.fair_participations where business_id = any(${bids})`;
      await sql`delete from public.businesses where id = any(${bids})`;
    }
    const orgs = ids.length ? await sql`select organizer_id from public.organizer_members where user_id = any(${ids})` : [];
    if (orgs.length) {
      const fairs = await sql`select id from public.fairs where organizer_id = any(${orgs.map(o => o.organizer_id)})`;
      await sql`delete from public.orders where fair_id = any(${fairs.map(f => f.id)})`;
      await sql`delete from public.fairs where organizer_id = any(${orgs.map(o => o.organizer_id)})`;
      await sql`delete from public.organizers where id = any(${orgs.map(o => o.organizer_id)})`;
    }
    if (ids.length) await sql`delete from public.orders where customer_id = any(${ids})`;
    await sql`delete from private.founding_applications where name like ${`% ${run}`}`;
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  } finally {
    await sql.end();
    await stopPreview();
  }
});

for (const engine of browsersToRun) {
  test(`[${engine}] compra sin cuenta con retiro en feria, de la tienda al seguimiento`, async t => {
    const browser = await launch(engine);
    if (!browser) { t.skip(`${engine} no está instalado en esta máquina (corre en CI)`); return; }
    const buyer = await person(browser, { label: `compradora-${engine}` });
    const { page } = buyer;
    try {
      await open(page, `#/tienda/${shopA.slug}`);
      assert.match(await page.locator('.store-name').textContent(), /Taller/);
      await page.click(`a.product-media[href="#/producto/${shopA.product.id}"]`);
      await ready(page);
      assert.equal((await page.locator('.detail-title').textContent()).trim(), 'Taza');
      await page.click('[data-action="add"]');
      await expectToast(page, 'Agregado al carrito');
      assert.equal((await page.locator('.header .badge-dot').textContent()).trim(), '1');
      await go(page, '#/carrito');
      await page.check(`input[name="fulfillment"][value="fair:${fairId}"]`);
      await page.fill('#co-name', 'Lucía Compradora');
      await page.fill('#co-phone', '299 4556677');
      await page.check('input[name="payment"][value="cash"]');
      await shot(page, `${engine}-checkout-feria`);
      await page.click('[data-action="confirm"]');
      await page.waitForFunction(() => location.hash.startsWith('#/pedido/'), null, { timeout: 20000 });
      await ready(page);
      await page.getByText('¡Pedido enviado!').waitFor();
      await page.getByText('B9', { exact: true }).waitFor();
      await shot(page, `${engine}-pedido-enviado`);
      const token = (await page.evaluate(() => location.hash)).split('/')[2].split('?')[0];
      const [row] = await sql`select fulfillment, pickup_stall, total_ars, payment_method, contact_name from public.orders where tracking_token = ${token}`;
      assert.deepEqual({ ...row, total_ars: Number(row.total_ars) }, { fulfillment: 'fair_pickup', pickup_stall: 'B9', total_ars: 12500, payment_method: 'cash', contact_name: 'Lucía Compradora' });
      await go(page, '#/mis-pedidos');
      await page.locator('.order-card').first().waitFor();
      assert.match(await page.locator('.order-card').first().textContent(), /Feria E2E/);
      assert.equal(await page.locator('.header .badge-dot').count(), 0, 'el carrito quedó vacío');
      assert.deepEqual(buyer.problems, []);
    } finally { await browser.close(); }
  });

  test(`[${engine}] alta guiada: cuenta con confirmación por correo, tienda, producto con foto y publicación aprobada`, async t => {
    const browser = await launch(engine);
    if (!browser) { t.skip(`${engine} no está instalado en esta máquina (corre en CI)`); return; }
    const seller = await person(browser, { label: `vendedora-${engine}` });
    const reviewerUi = await person(browser, { label: `admin-${engine}`, width: 1280, height: 900 });
    const visitor = await person(browser, { label: `visita-${engine}` });
    const email = `qa-${run}-alta-${engine}@ferias.test`;
    const password = `Alta${randomUUID().slice(0, 8)}55`;
    const shopName = `Cerámica ${engine} ${run}`;
    try {
      const { page } = seller;
      await open(page, '#/alta');
      await page.click('a[href="#/cuenta/crear?next=%2Falta"]');
      await ready(page);
      await page.fill('#su-name', 'Rosa Vendedora');
      await page.fill('#su-email', email);
      await page.fill('#su-phone', '299 4778899');
      await page.fill('#su-password', password);
      await page.click('form[data-form="signup"] button[type="submit"]');
      await page.waitForFunction(() => location.hash.startsWith('#/cuenta/confirmar'), null, { timeout: 20000 });
      const mail = await latestMail(email, { subject: 'Confirmá tu correo' });
      const link = String(mail.HTML).match(/href="([^"]*token_hash=[^"]+)"/)[1].replace(/&amp;/g, '&');
      await page.goto(link);
      await page.waitForFunction(() => location.hash.startsWith('#/alta'), null, { timeout: 20000 });
      await ready(page);
      await page.fill('#ob-name', shopName);
      await page.selectOption('#ob-loc', 'plottier');
      await page.selectOption('#ob-cat', 'ceramica');
      await page.click('form[data-form="business"] button[type="submit"]');
      await page.waitForFunction(() => location.hash.startsWith('#/panel'), null, { timeout: 20000 });
      await ready(page);
      await page.getByText('Preparemos tu tienda').waitFor();
      await shot(page, `${engine}-panel-checklist`);
      // Primer producto con foto, desde el formulario del panel.
      await go(page, '#/panel/producto/nuevo');
      await page.setInputFiles('input[data-input="images"]', { name: 'taza.png', mimeType: 'image/png', buffer: tinyPng() });
      await page.locator('#images img').first().waitFor();
      await page.fill('#pr-name', 'Taza de prueba');
      await page.fill('#pr-price', '9900');
      await page.fill('#pr-stock', '4');
      await page.click('form[data-form="product"] button[type="submit"]');
      await expectToast(page, 'Producto publicado');
      await page.waitForFunction(() => location.hash === '#/panel/productos');
      await ready(page);
      await page.getByText('Taza de prueba').waitFor();
      await go(page, '#/panel');
      await page.click('[data-action="submit"]');
      await expectToast(page, 'Enviada');
      await page.getByText('Estamos revisando tu tienda').waitFor();
      const [business] = await sql`select b.id, b.slug, b.status from public.businesses b where b.name = ${shopName}`;
      assert.equal(business.status, 'pending_review');
      const [image] = await sql`select count(*)::int as n from public.product_images where business_id = ${business.id}`;
      assert.equal(image.n, 1, 'la foto quedó en Storage y en la base');
      // La administración aprueba desde su panel.
      await signIn(reviewerUi.page, reviewer);
      await go(reviewerUi.page, '#/admin/tiendas?f=pending_review');
      await reviewerUi.page.selectOption(`#rp-${business.id}`, 'feriante');
      await reviewerUi.page.click(`[data-action="approve"][data-id="${business.id}"]`);
      await expectToast(reviewerUi.page, 'Tienda publicada');
      await shot(reviewerUi.page, `${engine}-admin-aprobada`);
      // Ya es pública.
      await open(visitor.page, `#/tienda/${business.slug}`);
      assert.equal((await visitor.page.locator('.store-name').textContent()).trim(), shopName);
      await visitor.page.getByText('Taza de prueba').waitFor();
      created.emails.push(email);
      assert.deepEqual([...seller.problems, ...reviewerUi.problems, ...visitor.problems], []);
    } finally { await browser.close(); }
  });

  test(`[${engine}] el comercio recibe el pedido en vivo, lo prepara, lo entrega y registra el cobro`, async t => {
    const browser = await launch(engine);
    if (!browser) { t.skip(`${engine} no está instalado en esta máquina (corre en CI)`); return; }
    const merchant = await person(browser, { label: `comercio-${engine}` });
    const { page } = merchant;
    try {
      await signIn(page, merchantA);
      await go(page, `#/panel/pedidos?tienda=${shopA.id}`);
      await page.waitForTimeout(1500);
      const shopper = await guest(`pedido-${engine}`);
      const orderId = ok(await order(shopper, shopA.id, [{ product_id: shopA.made.id, quantity: 1 }]), 'pedido');
      await expectToast(page, 'Nuevo pedido');
      const card = page.locator(`[data-order="${orderId}"]`);
      await card.waitFor();
      await shot(page, `${engine}-panel-pedido-nuevo`);
      await card.locator('[data-next="accepted"]').click();
      await expectToast(page, 'Aceptado');
      await page.click('[data-action="filter"][data-f="curso"]');
      await page.locator(`[data-order="${orderId}"] [data-next="ready"]`).click();
      await expectToast(page, 'Listo');
      await page.click('[data-action="filter"][data-f="listos"]');
      await page.locator(`[data-order="${orderId}"] [data-next="delivered"]`).click();
      await expectToast(page, 'Entregado');
      await page.click('[data-action="filter"][data-f="cerrados"]');
      await page.locator(`[data-order="${orderId}"] [data-action="paid"]`).click();
      await page.click('#sheet [data-sheet="ok"]');
      await expectToast(page, 'Cobro registrado');
      const [row] = await sql`select status, payment_status, version from public.orders where id = ${orderId}`;
      assert.deepEqual({ status: row.status, payment_status: row.payment_status }, { status: 'delivered', payment_status: 'paid' });
      const [tracking] = await sql`select tracking_token from public.orders where id = ${orderId}`;
      const visitor = await person(browser, { label: `seguimiento-${engine}` });
      await open(visitor.page, `#/pedido/${tracking.tracking_token}`);
      await visitor.page.getByText('¡Pedido entregado!', { exact: false }).waitFor();
      assert.deepEqual([...merchant.problems, ...visitor.problems], []);
    } finally { await browser.close(); }
  });

  test(`[${engine}] organizador: crea y publica una feria; una tienda se inscribe y recibe su puesto`, async t => {
    const browser = await launch(engine);
    if (!browser) { t.skip(`${engine} no está instalado en esta máquina (corre en CI)`); return; }
    const org = await person(browser, { label: `organiza-${engine}` });
    const seller = await person(browser, { label: `tienda-${engine}` });
    const visitor = await person(browser, { label: `visita-${engine}` });
    const name = `Feria UI ${engine} ${run}`;
    try {
      await signIn(org.page, organizerUser);
      await go(org.page, '#/organizador/nueva');
      const start = new Date(Date.now() + 6 * 86400000);
      const local = d => new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 16);
      await org.page.fill('#fa-name', name);
      await org.page.fill('#fa-start', local(start));
      await org.page.fill('#fa-end', local(new Date(start.getTime() + 7 * 3600000)));
      await org.page.fill('#fa-venue', 'Plaza de las Banderas');
      await org.page.fill('#fa-address', 'Av. Argentina 100');
      await org.page.fill('#fa-cap', '30');
      await org.page.click('form[data-form="fair"] button[type="submit"]');
      await org.page.waitForFunction(() => location.hash.startsWith('#/organizador/feria/'), null, { timeout: 20000 });
      await ready(org.page);
      await org.page.click('[data-action="status"][data-next="published"]');
      await expectToast(org.page, 'Feria publicada');
      const [fair] = await sql`select id, slug, status from public.fairs where name = ${name}`;
      assert.equal(fair.status, 'published');
      await signIn(seller.page, merchantA);
      await go(seller.page, `#/panel/ferias?tienda=${shopA.id}`);
      await seller.page.click(`[data-action="apply"][data-fair="${fair.id}"]`);
      await expectToast(seller.page, 'Solicitud enviada');
      const [participation] = await sql`select id from public.fair_participations where fair_id = ${fair.id} and business_id = ${shopA.id}`;
      await go(org.page, `#/organizador/feria/${fair.id}?tab=participantes`);
      await org.page.fill(`#stall-${participation.id}`, 'c3');
      await org.page.click(`[data-action="confirm"][data-id="${participation.id}"]`);
      await expectToast(org.page, 'Participación confirmada');
      await shot(org.page, `${engine}-organizador-participantes`);
      await open(visitor.page, `#/feria/${fair.slug}`);
      await visitor.page.getByText('Puesto C3').waitFor();
      await shot(visitor.page, `${engine}-feria-publica`);
      assert.deepEqual([...org.problems, ...seller.problems, ...visitor.problems], []);
    } finally { await browser.close(); }
  });

  test(`[${engine}] comunidad fundadora con encuesta; administración ve el resumen, filtra el piloto y descarga el CSV`, async t => {
    const browser = await launch(engine);
    if (!browser) { t.skip(`${engine} no está instalado en esta máquina (corre en CI)`); return; }
    const visitor = await person(browser, { label: `fundadora-${engine}` });
    const reviewerUi = await person(browser, { width: 1280, height: 900, label: `admin-com-${engine}` });
    const name = `Ana ${engine} ${run}`;
    try {
      await open(visitor.page, '#/comunidad');
      await visitor.page.fill('#fd-name', name);
      await visitor.page.fill('#fd-contact', '299 4778899');
      await visitor.page.click('.survey > summary');
      await visitor.page.check('input[name="sv-channels"][value="ferias"]');
      await visitor.page.check('input[name="sv-channels"][value="whatsapp"]');
      await visitor.page.check('input[name="sv-fairs_per_month"][value="2-3"]');
      await visitor.page.check('input[name="sv-main_need"][value="pedidos"]');
      await visitor.page.check('input[name="sv-price"][value="razonable"]');
      await visitor.page.check('input[name="sv-pilot"]');
      await visitor.page.check('input[name="consent"]');
      await visitor.page.click('[data-form="founding"] button[type="submit"]');
      await visitor.page.getByText('¡Gracias por sumarte!').waitFor();

      await signIn(reviewerUi.page, reviewer);
      await go(reviewerUi.page, '#/admin/comunidad?piloto=1');
      const card = reviewerUi.page.locator('article', { hasText: name });
      await card.waitFor();
      assert.match(await card.textContent(), /Ferias, WhatsApp/);
      assert.match(await card.textContent(), /Ordenar pedidos y encargos/);
      assert.match(await reviewerUi.page.locator('#main').textContent(), /respondieron/);
      await shot(reviewerUi.page, `${engine}-admin-comunidad-encuesta`);
      const [download] = await Promise.all([reviewerUi.page.waitForEvent('download'), reviewerUi.page.click('[data-action="founding-csv"]')]);
      assert.match(download.suggestedFilename(), /^cauce-ferias-comunidad-\d{4}-\d{2}-\d{2}\.csv$/);
      const csv = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
      assert.match(csv, new RegExp(name));
      assert.match(csv, /"Ferias, WhatsApp"/);
      assert.deepEqual([...visitor.problems, ...reviewerUi.problems], []);
    } finally { await browser.close(); }
  });

  test(`[${engine}] controles de acceso desde la interfaz`, async t => {
    const browser = await launch(engine);
    if (!browser) { t.skip(`${engine} no está instalado en esta máquina (corre en CI)`); return; }
    const visitor = await person(browser, { label: `visita-${engine}` });
    const other = await person(browser, { label: `otra-${engine}` });
    try {
      await open(visitor.page, '#/panel');
      await visitor.page.waitForFunction(() => location.hash.startsWith('#/cuenta'));
      await signIn(other.page, merchantB);
      await go(other.page, `#/panel?tienda=${shopA.id}`);
      assert.match(await other.page.locator('.panel-head-name').textContent(), /Otra/);
      assert.doesNotMatch(await other.page.locator('#main').textContent(), /Taller/);
      await go(other.page, '#/admin');
      await other.page.getByText('Sección exclusiva').waitFor();
      await go(other.page, '#/organizador');
      await other.page.getByText('Todavía no organizás ferias').waitFor();
      // Plan de entrada: el retiro en feria aparece deshabilitado en su tienda.
      await go(other.page, '#/panel/tienda');
      assert.equal(await other.page.locator('input[name="fairPickup"]').isDisabled(), true);
      assert.deepEqual([...visitor.problems, ...other.problems], []);
    } finally { await browser.close(); }
  });

  test(`[${engine}] anchos extremos, movimiento reducido y teclado`, async t => {
    const browser = await launch(engine);
    if (!browser) { t.skip(`${engine} no está instalado en esta máquina (corre en CI)`); return; }
    try {
      for (const width of [320, 1440]) {
        const visitor = await person(browser, { width, height: 900, label: `ancho-${width}` });
        for (const hash of ['#/', `#/producto/${shopA.product.id}`, `#/feria/${fairSlug}`, '#/ferias?loc=']) {
          await open(visitor.page, hash);
          const overflow = await visitor.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.equal(overflow, 0, `${hash} a ${width}px no debe desbordar`);
        }
        assert.deepEqual(visitor.problems, []);
        await visitor.context.close();
      }
      const calm = await person(browser, { reducedMotion: 'reduce', label: 'calma' });
      await open(calm.page, '#/');
      assert.equal(await calm.page.evaluate(() => getComputedStyle(document.querySelector('.sofia .s-wave')).animationName), 'none');
      const lively = await person(browser, { label: 'movimiento' });
      await open(lively.page, '#/');
      assert.equal(await lively.page.evaluate(() => getComputedStyle(document.querySelector('.sofia .s-wave')).animationName), 'wave');
      // En la primera carga, lo primero que toma el foco es «Saltar al contenido».
      await lively.page.keyboard.press('Tab');
      assert.equal(await lively.page.evaluate(() => document.activeElement?.className), 'skip');
      await lively.page.keyboard.press('Enter');
      assert.equal(await lively.page.evaluate(() => document.activeElement?.id), 'main');
    } finally { await browser.close(); }
  });
}
