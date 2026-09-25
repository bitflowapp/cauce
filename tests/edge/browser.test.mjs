// La UI de pagos en navegadores reales (Chromium y WebKit) con las Edge
// Functions en Supabase Edge Runtime, detrás del gateway del stack local (el
// mismo origen que usa el sitio: CORS y verify_jwt de verdad), y el doble del
// proveedor. Las páginas de Mercado Pago se simulan interceptando su dominio
// en el navegador: esto prueba CAUCE (botones, redirecciones, retorno, panel),
// no a Mercado Pago, que se valida en el sandbox real (pagos-sandbox).
//
//   titular: Panel → Pagos → Conectar → "Mercado Pago" → vuelve conectado;
//   comprador: pedido con pago online → "Checkout Pro" → vuelve a #/pago/exito
//   ANTES del webhook y ve "Estamos confirmando" (el retorno no aprueba nada);
//   con el webhook firmado la misma pantalla pasa a "Pago aprobado";
//   titular: acepta el pedido pagado; rechazado → reintento desde el pedido.
//
// Lo corre tests/edge/run-local.mjs --runtime edge --browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, account, makeAdmin, publishedBusiness, closeAll } from '../integration/harness.mjs';
import { startPreview, stopPreview, launch, person, ready, go, signIn, shot, browsersToRun } from '../e2e/harness.mjs';
import { signForTest } from '../../supabase/functions/_shared/payments/signature.js';
import { fakeControl } from './fake-mercadopago.mjs';

const URLS = JSON.parse(process.env.EDGE_URLS || '{}');
const fake = fakeControl(process.env.EDGE_FAKE_MP || 'http://127.0.0.1:9911');
const SECRET = process.env.EDGE_WEBHOOK_SECRET || '';
const people = {};
const shops = {};
let outcome = 'approved';
let webhookOnVisit = true;

async function notify(orderId, seller) {
  const requestId = randomUUID();
  const ts = String(Date.now());
  const body = { id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, live_mode: true, type: 'order', action: 'order.processed',
    user_id: Number(seller), api_version: 'v1', application_id: '1', date_created: new Date().toISOString(), data: { id: orderId } };
  const response = await fetch(`${URLS['payments-webhook']}?data.id=${encodeURIComponent(orderId)}&type=order`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId,
      'x-signature': await signForTest({ dataId: orderId, requestId, ts, secret: SECRET }) } });
  assert.equal(response.status, 200);
}
const bounce = target => ({ status: 200, contentType: 'text/html',
  body: `<!doctype html><title>Mercado Pago (simulado)</title><script>location.replace(${JSON.stringify(target)})</script>` });

// "Mercado Pago" dentro del navegador: autorización y checkout.
async function simulateProvider(context, seller) {
  await context.route('https://auth.mercadopago.com.ar/**', async route => {
    const url = new URL(route.request().url());
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    const code = await fake.authorize({ seller, challenge: url.searchParams.get('code_challenge'), redirectUri: redirect.href });
    // La función arma su URL interna (kong); el navegador llega por el gateway del stack.
    const api = new URL(URLS['payments-oauth']).origin;
    await route.fulfill(bounce(`${api}${redirect.pathname}?${new URLSearchParams({ code, state: url.searchParams.get('state') })}`));
  });
  await context.route('https://www.mercadopago.com.ar/checkout/**', async route => {
    const orderId = new URL(route.request().url()).searchParams.get('order_id');
    const state = await fake.state();
    const order = state.orders.find(item => item.id === orderId);
    const sent = state.requests.find(item => item.kind === 'order' && item.body?.external_reference === order.external_reference);
    const back = sent.body.config.online;
    if (outcome === 'approved') {
      await fake.setOrder(orderId, { status: 'processed', status_detail: 'accredited', total_paid_amount: order.total_amount,
        transactions: { payments: [{ id: `PAYTST01${Date.now()}`, amount: order.total_amount, paid_amount: order.total_amount,
          status: 'processed', status_detail: 'accredited', payment_method: { id: 'master', type: 'credit_card' } }] } });
    } else {
      await fake.setOrder(orderId, { status: 'failed', status_detail: 'rejected_by_issuer',
        transactions: { payments: [{ id: `PAYTST01${Date.now()}`, amount: order.total_amount, paid_amount: '0.00',
          status: 'failed', status_detail: 'rejected_by_issuer', payment_method: { id: 'master', type: 'credit_card' } }] } });
    }
    if (webhookOnVisit) await notify(orderId, seller);
    await route.fulfill(bounce(outcome === 'approved' ? back.success_url : back.failure_url));
  });
}

async function buyOnline(page, shop) {
  await go(page, `#comercio/${shop.id}`);
  const card = page.locator('article.product-card', { has: page.locator('h3:text-is("Empanada de carne")') });
  await card.getByRole('button', { name: 'Agregar' }).click();
  await ready(page);
  await card.getByRole('button', { name: 'Agregar una unidad' }).click();
  await ready(page);
  await page.locator('.sticky-cart-bar a.button').click();
  await ready(page);
  await page.locator('a.button-continue').click();
  await ready(page);
  await page.fill('#checkout-name', 'Cliente QA');
  await page.fill('#checkout-phone', '2942 401122');
  const online = page.locator('label.pay-method', { has: page.locator('input[name="paymentMethod"][value="online"]') });
  await online.click();
  await page.waitForFunction(() => document.querySelector('input[name="paymentMethod"][value="online"]')?.checked === true);
  await page.locator('button.button-confirm-order').click();
  await page.waitForURL(/#\/pago\//, { timeout: 30000 });
  await ready(page);
}
const latestOrder = async (buyer, shop) => (await sql`select id, code, status, payment_status from public.orders
  where customer_id = ${buyer.id} and business_id = ${shop.id} order by created_at desc limit 1`)[0];

before(async () => {
  await startPreview();
  people.admin = await account('pagos-admin');
  await makeAdmin(people.admin);
  for (const engine of browsersToRun) {
    people[`owner-${engine}`] = await account(`pagos-titular-${engine}`);
    people[`buyer-${engine}`] = await account(`pagos-cliente-${engine}`);
    shops[engine] = await publishedBusiness(people[`owner-${engine}`], people.admin, { name: `Pagos ${engine}`, delivery: false });
    await sql`insert into private.payment_pilot_businesses (business_id, sandbox, reason)
      values (${shops[engine].id}, true, 'CAUCE QA · navegador')`;
  }
});
after(async () => {
  const ids = Object.values(shops).map(shop => shop.id);
  if (ids.length) {
    await sql`delete from private.payment_pilot_businesses where business_id in ${sql(ids)}`;
    await sql`delete from public.payment_provider_accounts where business_id in ${sql(ids)}`;
  }
  await stopPreview();
  await closeAll(Object.values(people));
});

for (const [index, engine] of browsersToRun.entries()) {
  test(`${engine}: el titular conecta la cuenta desde el panel y vuelve conectado (modo de prueba)`, async () => {
    const browser = await launch(engine);
    try {
      const owner = await person(browser, { width: 1280, height: 900, label: 'titular' });
      await simulateProvider(owner.context, `71000001${index}0`);
      await signIn(owner.page, people[`owner-${engine}`]);
      await go(owner.page, `#panel/${shops[engine].id}/pagos`);
      await owner.page.locator('[data-action="payment-connect"]').click();
      await owner.page.waitForURL(/conexion=ok/, { timeout: 30000 });
      await ready(owner.page);
      const panel = owner.page.locator('.pay-panel');
      await panel.getByText('Cuenta conectada. Ya se pueden cobrar pedidos online.').waitFor({ timeout: 20000 });
      const text = await panel.innerText();
      assert.match(text, /Conectado/);
      assert.match(text, /modo de prueba/i);
      assert.doesNotMatch(owner.page.url(), /APP_USR|TG-|token/i, 'ningún token en la URL');
      await shot(owner.page, `${engine}-pagos-conectado`);
      assert.deepEqual(owner.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: pago online aprobado; el retorno no aprueba, el webhook sí; el comercio acepta`, async () => {
    const browser = await launch(engine);
    try {
      const buyer = await person(browser, { label: 'comprador' });
      const seller = `71000001${index}0`;
      await simulateProvider(buyer.context, seller);
      outcome = 'approved';
      webhookOnVisit = false;
      await signIn(buyer.page, people[`buyer-${engine}`]);
      await buyOnline(buyer.page, shops[engine]);
      // Volvió a "éxito" sin webhook: la pantalla espera la confirmación.
      assert.match(buyer.page.url(), /#\/pago\/exito\?intento=/);
      await buyer.page.getByRole('heading', { name: 'Estamos confirmando tu pago' }).waitFor({ timeout: 20000 });
      const order = await latestOrder(people[`buyer-${engine}`], shops[engine]);
      assert.equal(order.payment_status, 'pending', 'la URL de retorno no aprobó nada');
      // Llega el webhook firmado: la misma pantalla pasa a aprobado (lee la base).
      const [attempt] = await sql`select provider_order_id from public.payment_attempts where order_id = ${order.id}`;
      await notify(attempt.provider_order_id, seller);
      await buyer.page.getByRole('heading', { name: 'Pago aprobado' }).waitFor({ timeout: 30000 });
      await shot(buyer.page, `${engine}-pago-aprobado`);
      assert.equal((await latestOrder(people[`buyer-${engine}`], shops[engine])).payment_status, 'approved');

      const owner = await person(browser, { width: 1280, height: 900, label: 'titular' });
      await signIn(owner.page, people[`owner-${engine}`]);
      await go(owner.page, `#panel/${shops[engine].id}/pedidos`);
      const card = owner.page.locator(`article[aria-label="Pedido ${order.code}"]`);
      await card.waitFor({ timeout: 20000 });
      await card.getByRole('button', { name: 'Aceptar', exact: true }).click();
      await ready(owner.page);
      assert.equal((await latestOrder(people[`buyer-${engine}`], shops[engine])).status, 'accepted');
      assert.deepEqual([...buyer.problems, ...owner.problems], []);
    } finally { await browser.close(); }
  });

  test(`${engine}: pago rechazado; se explica y se reintenta desde el pedido con otro intento`, async () => {
    const browser = await launch(engine);
    try {
      const buyer = await person(browser, { label: 'comprador' });
      const seller = `71000001${index}0`;
      await simulateProvider(buyer.context, seller);
      outcome = 'rejected';
      webhookOnVisit = true;
      await signIn(buyer.page, people[`buyer-${engine}`]);
      await buyOnline(buyer.page, shops[engine]);
      assert.match(buyer.page.url(), /#\/pago\/error\?intento=/);
      await buyer.page.getByRole('heading', { name: 'El pago fue rechazado' }).waitFor({ timeout: 30000 });
      const order = await latestOrder(people[`buyer-${engine}`], shops[engine]);
      assert.deepEqual({ status: order.status, payment: order.payment_status }, { status: 'submitted', payment: 'rejected' });
      await buyer.page.getByRole('link', { name: 'Ver mi pedido' }).click();
      await ready(buyer.page);
      outcome = 'approved';
      await buyer.page.locator('[data-action="payment-start"]').click();
      await buyer.page.waitForURL(/#\/pago\/exito/, { timeout: 30000 });
      await buyer.page.getByRole('heading', { name: 'Pago aprobado' }).waitFor({ timeout: 30000 });
      const attempts = await sql`select status, idempotency_key::text as key from public.payment_attempts
        where order_id = ${order.id} order by created_at`;
      assert.deepEqual(attempts.map(attempt => attempt.status), ['rejected', 'approved']);
      assert.notEqual(attempts[0].key, attempts[1].key, 'otra clave de idempotencia');
      await shot(buyer.page, `${engine}-pago-reintento-aprobado`);
      assert.deepEqual(buyer.problems, []);
    } finally { await browser.close(); }
  });
}
