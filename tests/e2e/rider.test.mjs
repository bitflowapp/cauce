// Reparto propio en navegador real (Chromium y WebKit) contra el stack local:
// el comercio vincula la cuenta de su persona de reparto y le asigna un envío
// desde el panel; la persona lo retira, sale, llega y lo entrega con el código
// del cliente desde el teléfono; el cliente lo sigue por su enlace. Y lo que no
// le corresponde, no lo ve ni por la interfaz ni por la API con su sesión.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  account, guest, makeAdmin, publishedBusiness, closeAll, order, ok, sql, env, anonClient,
  startPreview, stopPreview, browsersToRun, launch, person, go, ready, signIn, shot, layoutIssues, expectToast,
} from './harness.mjs';

const people = {};
const riders = {};
let A, B, orderOfB;

before(async () => {
  await startPreview();
  for (const name of ['ownerA', 'ownerB', 'stranger', 'admin']) people[name] = await account(`rd-${name}`);
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Reparto Vista' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Reparto Ajeno' });
  // Una persona de reparto por motor: cada navegador vincula la suya.
  for (const engine of browsersToRun) {
    const user = await account(`rd-rider-${engine}`);
    const row = ok(await people.ownerA.client.from('business_riders')
      .insert({ business_id: A.id, name: `Moto ${engine}`, phone: '2942 555111' }).select().single());
    riders[engine] = { user, row };
  }
  const rowB = ok(await people.ownerB.client.from('business_riders').insert({ business_id: B.id, name: 'Moto Ajena' }).select().single());
  orderOfB = await deliveryOrder(B);
  await advance(people.ownerB, orderOfB, ['accepted', 'preparing', 'ready']);
  ok(await people.ownerB.client.rpc('transition_order', { order_id: orderOfB, next_status: 'assigned', rider: rowB.id }));
});
after(async () => { await stopPreview(); await closeAll([...Object.values(people), ...Object.values(riders).map(item => item.user)]); });

// Un envío real de una compra sin cuenta distinta cada vez (tres unidades
// superan el pedido mínimo).
async function deliveryOrder(business) {
  const buyer = await guest(`rd-${Math.random().toString(36).slice(2, 8)}`);
  return ok(await order(buyer, business.id, [{ product_id: business.products.untracked.id, quantity: 3 }],
    { fulfillment: 'delivery', contactData: { name: 'Vecina de Prueba', phone: '2942 401122', notes: 'Portón verde' } }));
}
async function advance(owner, id, steps) {
  for (const next of steps) ok(await owner.client.rpc('transition_order', { order_id: id, next_status: next }));
}
const row = async id => (await sql`select code, status, payment_status, delivery_code, tracking_token::text as token
  from public.orders where id = ${id}`)[0];
const riderCard = (page, code) => page.locator(`article[aria-label="Entrega ${code}"]`);

for (const engine of browsersToRun) {
  test(`${engine}: el comercio vincula y asigna; la persona entrega desde el teléfono con el código del cliente`, async () => {
    const browser = await launch(engine);
    try {
      const { user, row: riderRow } = riders[engine];
      // ── el comercio, en su teléfono: vincula la cuenta ──
      const owner = await person(browser, { width: 390, height: 844, label: 'titular' });
      const m = owner.page;
      await signIn(m, people.ownerA);
      await go(m, `#panel/${A.id}/reparto`);
      const riderItem = m.locator('.rider-list li', { hasText: `Moto ${engine}` });
      assert.match(await riderItem.textContent(), /Sin cuenta vinculada/);
      await riderItem.locator('input[name="email"]').fill(user.email);
      await riderItem.getByRole('button', { name: 'Vincular cuenta' }).click();
      await expectToast(m, 'Cuenta vinculada. La persona ya ve sus entregas en “Mis entregas”.');
      await ready(m);
      assert.match(await m.locator('.rider-list li', { hasText: `Moto ${engine}` }).textContent(), new RegExp(`Cuenta vinculada: ${user.email}`));

      // ── un envío listo, asignado desde el panel ──
      const id = await deliveryOrder(A);
      await advance(people.ownerA, id, ['accepted', 'preparing', 'ready']);
      const { code } = await row(id);
      await go(m, `#panel/${A.id}/pedidos`);
      const orderCard = m.locator(`article[aria-label="Pedido ${code}"]`).first();
      await orderCard.locator('select[name="riderId"]').selectOption(riderRow.id);
      await orderCard.getByRole('button', { name: 'Asignar reparto' }).click();
      await expectToast(m, 'Reparto asignado.');
      assert.equal((await row(id)).status, 'assigned');

      // ── la persona de reparto, en su teléfono ──
      const courier = await person(browser, { width: 390, height: 844, label: 'reparto' });
      const r = courier.page;
      await signIn(r, user);
      await r.waitForFunction(() => location.hash === '#entregas', null, { timeout: 20000 });
      await ready(r);
      assert.ok(await r.getByRole('heading', { name: 'Tus entregas', exact: true }).isVisible());
      const card = riderCard(r, code);
      await card.waitFor({ timeout: 20000 });
      const text = await card.textContent();
      for (const expected of ['Para retirar', 'Calle Los Pehuenes 45', 'Vecina de Prueba', 'Portón verde', 'A cobrar']) {
        assert.ok(text.includes(expected), `la tarjeta muestra "${expected}"`);
      }
      assert.doesNotMatch(text, new RegExp((await row(id)).delivery_code), 'nunca muestra el código del cliente');
      const maps = await card.getByRole('link', { name: 'Abrir en Maps' }).getAttribute('href');
      assert.match(maps, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Calle%20Los%20Pehuenes%2045%2C%20Alumin%C3%A9/);
      assert.equal(await card.getByRole('link', { name: 'Llamar', exact: true }).getAttribute('href'), 'tel:2942401122');
      assert.deepEqual(await layoutIssues(r), [], 'a 390 px entra sin desbordes ni controles chicos');
      await shot(r, `${engine}-reparto-asignado`);

      // Retiro, salida y llegada: cada toque es un paso en la base y en el seguimiento.
      const tracking = async () => ok(await anonClient().rpc('track_order', { token: (await row(id)).token })).status;
      await card.getByRole('button', { name: 'Retiré el pedido' }).click();
      await expectToast(r, 'Pedido retirado. El cliente lo ve en su seguimiento.');
      assert.equal(await tracking(), 'picked_up');
      await riderCard(r, code).getByRole('button', { name: 'Salí a entregar' }).click();
      await expectToast(r, 'En camino. El cliente ya lo sabe.');
      await riderCard(r, code).getByRole('button', { name: 'Llegué' }).click();
      await expectToast(r, 'Llegaste. Pedile el código al cliente para entregar.');
      assert.equal(await tracking(), 'arrived');
      await shot(r, `${engine}-reparto-en-la-puerta`);

      // El cliente ve lo mismo en su enlace de seguimiento, sin cuenta.
      const client = await person(browser, { width: 390, height: 844, label: 'cliente' });
      await client.page.goto(`http://127.0.0.1:4174/index.html#seguimiento/${(await row(id)).token}`);
      await ready(client.page);
      assert.match(await client.page.locator('#main').textContent(), /Llegó a destino/);

      // Un código equivocado no entrega y lo explica; el correcto, sí.
      const secret = (await row(id)).delivery_code;
      const wrong = secret === '0000' ? '1111' : '0000';
      await riderCard(r, code).locator('input[name="code"]').fill(wrong);
      await riderCard(r, code).getByRole('button', { name: 'Entregar' }).click();
      await ready(r);
      assert.match(await riderCard(r, code).locator('.rider-feedback').textContent(), /Código incorrecto\. Te quedan 4 intentos\./);
      assert.equal((await row(id)).status, 'arrived');
      await riderCard(r, code).locator('input[name="code"]').fill(`${secret.slice(0, 2)} ${secret.slice(2)}`);
      await riderCard(r, code).getByRole('button', { name: 'Entregar' }).click();
      await expectToast(r, 'Entrega confirmada. ¡Gracias!');
      await ready(r);
      assert.deepEqual(await row(id).then(({ status, payment_status: paid }) => [status, paid]), ['delivered', 'settled']);
      assert.equal(await riderCard(r, code).count(), 0, 'sale de las entregas en curso');
      assert.match(await r.locator('.rider-history').textContent(), new RegExp(`${code}[\\s\\S]*Entregado`));
      await shot(r, `${engine}-reparto-entregado`);

      // El seguimiento del cliente y el panel del comercio lo ven cerrado.
      await client.page.reload();
      await ready(client.page);
      assert.match(await client.page.locator('#main').textContent(), /Entregado/);
      await go(m, `#panel/${A.id}/pedidos`);
      await m.locator('[data-action="order-filter"][data-filter="completados"]').click();
      await ready(m);
      assert.ok(await m.locator(`article[aria-label="Pedido ${code}"]`).first().isVisible(), 'el comercio lo ve en Completados');
      assert.deepEqual([...owner.problems, ...courier.problems, ...client.problems], []);
    } finally { await browser.close(); }
  });

  test(`${engine}: quien reparte no entra al panel ni ve pedidos ajenos; sin vínculo, la pantalla dice qué hacer`, async () => {
    const browser = await launch(engine);
    try {
      const outsider = await person(browser, { width: 390, height: 844, label: 'sin vínculo' });
      await signIn(outsider.page, people.stranger);
      await go(outsider.page, '#entregas');
      assert.ok(await outsider.page.getByText('Tu cuenta todavía no reparte para ningún comercio').isVisible());

      const { user } = riders[engine];
      const courier = await person(browser, { width: 390, height: 844, label: 'reparto' });
      const r = courier.page;
      await signIn(r, user);
      for (const section of ['', '/pedidos', '/catalogo', '/reparto']) {
        await go(r, `#panel/${A.id}${section}`);
        assert.ok(await r.getByText('Ese comercio no pertenece a tu cuenta.').isVisible(), `#panel/A${section}`);
      }
      await go(r, '#entregas');
      assert.equal(await r.locator(`article[aria-label^="Entrega"]`).filter({ hasText: 'Reparto Ajeno' }).count(), 0);
      // Con el token de la sesión del navegador, directo contra la API.
      const results = await r.evaluate(async ({ url, key, foreign, product, business, rider }) => {
        const token = JSON.parse(localStorage.getItem('cauce:production:auth')).access_token;
        const headers = { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
        const call = async (path, init = {}) => {
          const response = await fetch(`${url}${path}`, { headers, ...init });
          return { status: response.status, body: await response.text() };
        };
        return {
          orders: await call('/rest/v1/orders?select=id,delivery_code'),
          events: await call('/rest/v1/order_events?select=id'),
          foreign: await call('/rest/v1/rpc/transition_order', { method: 'POST',
            body: JSON.stringify({ order_id: foreign, next_status: 'picked_up' }) }),
          confirm: await call('/rest/v1/rpc/confirm_delivery', { method: 'POST',
            body: JSON.stringify({ order_id: foreign, expected_version: null, code: '1234' }) }),
          price: await call(`/rest/v1/products?id=eq.${product}`, { method: 'PATCH', body: JSON.stringify({ price_ars: 1 }) }),
          link: await call('/rest/v1/rpc/link_rider_account', { method: 'POST',
            body: JSON.stringify({ rider, account_email: 'otra@cauce.test' }) }),
          accounts: await call('/rest/v1/rpc/business_rider_accounts', { method: 'POST', body: JSON.stringify({ business }) }),
          mine: await call('/rest/v1/rpc/rider_orders', { method: 'POST', body: '{}' }),
        };
      }, { url: env.url, key: env.publishableKey, foreign: orderOfB, product: A.products.untracked.id, business: A.id,
        rider: riders[engine].row.id });
      assert.equal(results.orders.body, '[]', 'la tabla de pedidos no se lee');
      assert.equal(results.events.body, '[]', 'el historial no se lee');
      assert.equal(results.price.body, '[]', 'el precio no se modifica');
      for (const key of ['foreign', 'confirm', 'link', 'accounts']) {
        assert.ok(results[key].status >= 400 && /42501/.test(results[key].body), `${key}: ${results[key].status} ${results[key].body}`);
      }
      assert.doesNotMatch(results.mine.body, /delivery_code|tracking_token|customer_id/, 'la lectura propia no trae datos de más');
      const [foreignRow] = await sql`select status from public.orders where id = ${orderOfB}`;
      const [price] = await sql`select price_ars::int as price from public.products where id = ${A.products.untracked.id}`;
      assert.deepEqual([foreignRow.status, price.price], ['assigned', 1200], 'todo intacto');
      assert.deepEqual([...outsider.problems, ...courier.problems], []);
    } finally { await browser.close(); }
  });

  test(`${engine}: Mis entregas entra en 320, 375, 390, 430, 768 y 1280 sin desbordes ni controles chicos`, async () => {
    const browser = await launch(engine);
    try {
      const { user, row: riderRow } = riders[engine];
      // Una entrega en cada momento: para retirar, en camino (con el código) y cerrada.
      const ids = [await deliveryOrder(A), await deliveryOrder(A), await deliveryOrder(A)];
      for (const id of ids) {
        await advance(people.ownerA, id, ['accepted', 'preparing', 'ready']);
        ok(await people.ownerA.client.rpc('transition_order', { order_id: id, next_status: 'assigned', rider: riderRow.id }));
      }
      await advance(user, ids[1], ['picked_up', 'on_the_way']);
      await advance(user, ids[2], ['picked_up', 'on_the_way']);
      const secret = (await row(ids[2])).delivery_code;
      assert.equal(ok(await user.client.rpc('confirm_delivery', { order_id: ids[2], expected_version: null, code: secret })).ok, true);
      for (const width of [320, 375, 390, 430, 768, 1280]) {
        const courier = await person(browser, { width, height: width < 900 ? 844 : 900, label: `reparto ${width}` });
        await signIn(courier.page, user);
        await go(courier.page, '#entregas');
        assert.ok(await courier.page.locator('form[data-form="rider-deliver"]').first().isVisible(), 'el código se ve');
        assert.deepEqual(await layoutIssues(courier.page), [], `${engine} ${width}px`);
        if ([320, 390].includes(width)) await shot(courier.page, `${engine}-reparto-${width}`);
        assert.deepEqual(courier.problems, []);
        await courier.context.close();
      }
    } finally { await browser.close(); }
  });
}
