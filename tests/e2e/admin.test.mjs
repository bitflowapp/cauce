// Administración de la plataforma en navegador real (Chromium y WebKit) contra
// el stack local: el día del piloto en números, lo que necesita atención con
// una llamada al comercio, el estado de cada comercio y suspender/rehabilitar.
// Y un comercio no entra a administración ni por la API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  account, guest, makeAdmin, publishedBusiness, closeAll, order, ok, sql, env,
  startPreview, stopPreview, browsersToRun, launch, person, go, ready, signIn, shot, layoutIssues, expectToast,
} from './harness.mjs';

const people = {};
let A, B, stuck;

before(async () => {
  await startPreview();
  for (const name of ['ownerA', 'ownerB', 'admin']) people[name] = await account(`adm-${name}`);
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Admin Vista' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Admin Otro' });
  // Hoy en A: un retiro entregado. En B: un pedido sin respuesta hace 25 minutos.
  const buyer = await guest('adm-cliente');
  const done = ok(await order(buyer, A.id, [{ product_id: A.products.untracked.id, quantity: 2 }]));
  for (const next of ['accepted', 'preparing', 'ready', 'delivered']) {
    ok(await people.ownerA.client.rpc('transition_order', { order_id: done, next_status: next }));
  }
  stuck = ok(await order(await guest('adm-espera'), B.id, [{ product_id: B.products.untracked.id, quantity: 1 }]));
  // El que más espera de todos (la lista muestra los 20 más viejos): así la
  // prueba no depende de lo que dejaron otras corridas en el stack local.
  await sql`update public.orders set updated_at = least(now() - interval '25 minutes',
    (select min(updated_at) - interval '1 minute' from public.orders where status not in ('delivered', 'canceled')))
    where id = ${stuck}`;
});
after(async () => { await stopPreview(); await closeAll(Object.values(people)); });

const codeOf = async id => (await sql`select code from public.orders where id = ${id}`)[0].code;

for (const engine of browsersToRun) {
  test(`${engine}: administración ve el día del piloto, lo que necesita atención y el estado de cada comercio`, async () => {
    const browser = await launch(engine);
    try {
      const office = await person(browser, { width: 390, height: 844, label: 'administración' });
      const p = office.page;
      await signIn(p, people.admin);
      await go(p, '#admin');
      const today = p.locator('.admin-today');
      assert.ok(await today.getByRole('heading', { name: 'Hoy en CAUCE' }).isVisible());
      const tile = label => today.locator('.metric', { hasText: label }).locator('dd');
      assert.ok(Number(await tile('Comercios activos').textContent()) >= 2);
      assert.ok(Number(await tile('Pedidos hoy').textContent()) >= 2);
      assert.ok(Number(await tile('Completados hoy').textContent()) >= 1);
      assert.match(await tile('Volumen bruto hoy').textContent(), /\$\s?\d/);
      // El pedido que espera respuesta, con el comercio y una llamada; sin datos del cliente.
      const incidents = p.locator('.admin-incidents');
      const code = await codeOf(stuck);
      const item = incidents.locator('li', { hasText: code });
      assert.match(await item.textContent(), /Admin Otro[\s\S]*Sin respuesta del comercio · hace \d+ (min|h|d)/);
      assert.equal(await item.getByRole('link', { name: 'Llamar al comercio' }).getAttribute('href'), 'tel:2942555000');
      assert.doesNotMatch(await incidents.textContent(), /Vecina de Prueba|2942 401122|Pehuenes/);
      // Cada comercio publicado con su día.
      const line = p.locator('.admin-business-list li', { hasText: 'Admin Vista' });
      assert.match(await line.locator('.admin-business-today').textContent(), /Abierto · \d+ pedidos?\s+hoy · \d+ completados? · \$/);
      assert.deepEqual(await layoutIssues(p), [], 'a 390 px entra sin desbordes');
      await shot(p, `${engine}-admin-hoy-390`);

      // Suspender (con motivo) saca al comercio de CAUCE; rehabilitarlo lo devuelve.
      const dialog = p.locator('dialog.cauce-dialog');
      await p.locator('.admin-business-list li', { hasText: 'Admin Otro' }).getByRole('button', { name: 'Suspender' }).click();
      await dialog.waitFor();
      await dialog.locator('textarea').fill('Prueba de administración');
      await dialog.getByRole('button', { name: 'Suspender', exact: true }).click();
      await expectToast(p, 'Comercio suspendido.');
      await ready(p);
      assert.equal((await sql`select status from public.businesses where id = ${B.id}`)[0].status, 'suspended');
      await p.locator('.admin-business-list li', { hasText: 'Admin Otro' }).getByRole('button', { name: 'Rehabilitar' }).click();
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Rehabilitar', exact: true }).click();
      await expectToast(p, 'Comercio rehabilitado.');
      await ready(p);
      assert.equal((await sql`select status from public.businesses where id = ${B.id}`)[0].status, 'active');
      for (const width of [320, 768, 1280]) {
        await p.setViewportSize({ width, height: width < 900 ? 844 : 900 });
        await go(p, '#admin');
        assert.deepEqual(await layoutIssues(p), [], `${engine} ${width}px`);
      }
      assert.deepEqual(office.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: un comercio no entra a administración ni lee las métricas por la API`, async () => {
    const browser = await launch(engine);
    try {
      const owner = await person(browser, { width: 390, height: 844, label: 'titular' });
      const m = owner.page;
      await signIn(m, people.ownerA);
      await go(m, '#admin');
      assert.ok(await m.getByText('Sección restringida.').isVisible());
      assert.equal(await m.locator('.admin-today').count(), 0);
      const result = await m.evaluate(async ({ url, key }) => {
        const token = JSON.parse(localStorage.getItem('cauce:production:auth')).access_token;
        const response = await fetch(`${url}/rest/v1/rpc/admin_pilot_metrics`, { method: 'POST', body: '{}',
          headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
        return { status: response.status, body: await response.text() };
      }, { url: env.url, key: env.publishableKey });
      assert.ok(result.status >= 400 && /Administration only|42501/.test(result.body), `${result.status} ${result.body}`);
      assert.deepEqual(owner.problems, []);
    } finally { await browser.close(); }
  });
}
