// Panel remoto del comercio en navegador real (Chromium y WebKit) contra el
// stack local: titular, encargado/a, equipo, catálogo, configuración,
// aislamiento entre comercios y anchos de teléfono, tablet y computadora.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  account, guest, makeAdmin, publishedBusiness, closeAll, order, ok, sql, run, env, anonClient,
  startPreview, stopPreview, browsersToRun, launch, person, go, ready, signIn, shot, layoutIssues, expectToast,
} from './harness.mjs';

const people = {};
let A, B, C, orderOfB;

before(async () => {
  await startPreview();
  for (const name of ['ownerA', 'managerA', 'staffA', 'ownerB', 'ownerC', 'admin']) people[name] = await account(`bp-${name}`);
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Panel Vista' });
  B = await publishedBusiness(people.ownerB, people.admin, { name: 'Panel Ajeno' });
  // Configuración en un comercio aparte: cambiar horarios no puede cerrar el
  // comercio en el que las otras pruebas hacen pedidos.
  C = await publishedBusiness(people.ownerC, people.admin, { name: 'Panel Ajustes' });
  ok(await people.ownerA.client.rpc('add_business_member',
    { business: A.id, member_email: people.managerA.email, member_role: 'manager' }));
  ok(await people.ownerA.client.rpc('add_business_member',
    { business: A.id, member_email: people.staffA.email, member_role: 'staff' }));
  ok(await people.ownerA.client.from('business_riders').insert({ business_id: A.id, name: 'Reparto Vista', phone: '2942 555111' }));
  orderOfB = (await newOrder(B)).id;
});
after(async () => { await stopPreview(); await closeAll(Object.values(people)); });

// Un pedido real de una persona distinta cada vez (la base limita los pedidos
// pendientes por persona). Tres unidades superan el pedido mínimo del envío.
async function newOrder(business, { fulfillment = 'pickup', notes = '' } = {}) {
  const buyer = await guest(`bp-${Math.random().toString(36).slice(2, 8)}`);
  const id = ok(await order(buyer, business.id, [{ product_id: business.products.untracked.id, quantity: 3 }],
    { fulfillment, contactData: { name: 'Vecina de Prueba', phone: '2942 401122', notes } }));
  const [{ code }] = await sql`select code from public.orders where id = ${id}`;
  return { id, code };
}

const card = (page, code) => page.locator(`article[aria-label="Pedido ${code}"]`).first();

async function panelAction(page, code, label) {
  await card(page, code).getByRole('button', { name: label, exact: true }).click();
  await ready(page);
}

async function landOnPanel(page, user) {
  await signIn(page, user);
  await page.waitForFunction(() => /^#panel\/[0-9a-f-]{36}/.test(location.hash), null, { timeout: 20000 });
  await ready(page);
}

const statusOf = async id => (await sql`select status from public.orders where id = ${id}`)[0].status;

for (const engine of browsersToRun) {
  test(`${engine}: titular en el teléfono: inicio → pedidos → aceptar → preparar → listo → completar`, async () => {
    const browser = await launch(engine);
    try {
      const owner = await person(browser, { width: 390, height: 844, label: 'titular' });
      const m = owner.page;
      await landOnPanel(m, people.ownerA);
      assert.ok(await m.getByRole('heading', { name: 'Hoy', exact: true }).isVisible(), 'el titular llega al inicio del panel');
      assert.ok(await m.locator('.panel-openbar .open-flag').isVisible(), 'ABIERTO o CERRADO a la vista');

      // Entra un pedido mientras mira el inicio: aparece sin recargar.
      const { id, code } = await newOrder(A, { notes: 'Sin sal' });
      await card(m, code).waitFor({ timeout: 45000 });
      await m.waitForFunction(() => /Pedido nuevo/.test(document.title), null, { timeout: 10000 });
      assert.match(await m.locator('#panel-atender').textContent(), /Esperan respuesta \(\d+\)/);
      await shot(m, `${engine}-panel-inicio-pedido-nuevo`);

      await m.getByRole('tab', { name: /Pedidos/ }).click();
      await ready(m);
      const nuevos = m.locator('section.orders-group', { has: m.locator('#grupo-nuevos') });
      assert.ok(await nuevos.locator(`article[aria-label="Pedido ${code}"]`).isVisible(), 'en el grupo Nuevos');
      assert.match(await card(m, code).textContent(), /Sin sal/);
      await panelAction(m, code, 'Aceptar');
      assert.equal(await statusOf(id), 'accepted');
      await panelAction(m, code, 'Empezar a preparar');
      await panelAction(m, code, 'Listo para retirar');
      assert.equal(await statusOf(id), 'ready');
      await panelAction(m, code, 'Marcar retirado');
      assert.equal(await statusOf(id), 'delivered');
      assert.equal(await m.locator(`article[aria-label="Pedido ${code}"]`).count(), 0, 'lo completado sale de la vista activa');

      await m.locator('[data-action="order-filter"][data-filter="completados"]').click();
      await ready(m);
      assert.ok(await card(m, code).isVisible(), 'queda en Completados');

      // El inicio como control remoto: lo vendido, el ticket, lo más vendido y las últimas ventas.
      await m.getByRole('tab', { name: 'Inicio' }).click();
      await ready(m);
      const completed = Number(await m.locator('.metric', { hasText: 'Completados hoy' }).locator('.metric-value').textContent());
      assert.ok(completed >= 1);
      assert.match(await m.locator('.panel-sales-value').textContent(), /\$\s?\d/);
      assert.match(await m.locator('.metric', { hasText: 'Ticket promedio' }).textContent(), /\$\s?\d/);
      assert.ok(await m.locator('.recent-sales').getByText(code).isVisible(), 'la venta aparece en Últimas ventas');
      assert.ok(await m.locator('.top-products').getByText('Empanada de carne').isVisible(), 'y el producto en Más vendidos hoy');
      await shot(m, `${engine}-panel-inicio-despues`);
      await m.getByRole('button', { name: 'Ver completados' }).click();
      await ready(m);
      assert.ok(await card(m, code).isVisible(), '"Ver completados" lleva a Pedidos con ese filtro');
      assert.deepEqual(owner.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: catálogo: crear → editar → desactivar → reactivar; categorías; un formulario a medio escribir no se pisa`, async () => {
    const browser = await launch(engine);
    try {
      const owner = await person(browser, { width: 1280, height: 900, label: 'titular' });
      const m = owner.page;
      await landOnPanel(m, people.ownerA);
      await go(m, `#panel/${A.id}/catalogo`);
      const name = `Pan ${engine} ${run}`;
      // Un redibujo de fondo justo después del toque no cierra lo que se abrió.
      // El aviso `toggle` se descarta, como cuando le llega a un elemento que el
      // redibujo ya reemplazó (así falló una vez en WebKit).
      const create = m.locator('details[data-keep-open="catalog-new"]');
      if (await create.getAttribute('open') !== null) { await create.locator('summary').click(); await ready(m); }
      await m.evaluate(() => {
        const details = /** @type {HTMLDetailsElement} */ (document.querySelector('details[data-keep-open="catalog-new"]'));
        details.dataset.stale = 'true';
        const drop = event => {
          if (event.target !== details) return;
          event.stopImmediatePropagation();
          window.removeEventListener('toggle', drop, true);
        };
        window.addEventListener('toggle', drop, true);
        details.querySelector('summary').click();
        window.dispatchEvent(new Event('online'));
      });
      await m.waitForFunction(() => {
        const details = /** @type {HTMLElement|null} */ (document.querySelector('details[data-keep-open="catalog-new"]'));
        return Boolean(details && !details.dataset.stale);
      });
      await ready(m);
      assert.notEqual(await create.getAttribute('open'), null, 'el formulario recién abierto sigue abierto después del redibujo');
      // Un refresco de fondo que ya estaba en camino cuando la persona empezó a
      // escribir no borra lo tipeado.
      await m.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        const field = /** @type {HTMLInputElement} */ (document.querySelector('#prod-name'));
        field.focus();
        field.value = 'Pan';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await ready(m);
      assert.equal(await m.inputValue('#prod-name'), 'Pan', 'lo que se empezó a escribir durante el refresco sigue ahí');
      await m.fill('#prod-name', name);
      await m.fill('#prod-description', 'De masa madre');
      await m.fill('#prod-price', '2500');
      await m.fill('#prod-category', `Panadería ${engine}`);
      await m.locator('form[data-form="product-create"] button[type="submit"]').click();
      await ready(m);
      const row = m.locator(`article[aria-label="Producto ${name}"]`);
      await row.waitFor();

      // Editar: a medio escribir entra un pedido; el texto sigue ahí y se avisa igual.
      await row.locator('details.catalog-edit > summary').click();
      const form = row.locator('form[data-form="product-edit"]');
      await form.locator('input[name="name"]').fill(`${name} de campo`);
      await form.locator('input[name="price"]').fill('2800');
      await newOrder(A);
      await m.locator('#panel-order-alert').waitFor({ timeout: 45000 });
      assert.equal(await form.locator('input[name="name"]').inputValue(), `${name} de campo`, 'lo escrito no se pierde');
      await form.locator('button[type="submit"]').click();
      await ready(m);
      const edited = m.locator(`article[aria-label="Producto ${name} de campo"]`);
      await edited.waitFor();
      assert.match(await edited.textContent(), /2\.800/);
      assert.equal(await edited.locator('details.catalog-edit').getAttribute('open'), null, 'guardar cierra la edición');
      const [saved] = await sql`select id, price_ars::int as price, description from public.products
        where business_id = ${A.id} and name = ${`${name} de campo`}`;
      assert.deepEqual({ price: saved.price, description: saved.description }, { price: 2800, description: 'De masa madre' });

      await edited.getByRole('button', { name: 'Desactivar' }).click();
      await ready(m);
      assert.equal((await sql`select archived from public.products where id = ${saved.id}`)[0].archived, true);
      assert.ok(await edited.getByText('Desactivado').isVisible());
      await edited.getByRole('button', { name: 'Reactivar' }).click();
      await ready(m);
      assert.equal((await sql`select archived from public.products where id = ${saved.id}`)[0].archived, false);

      // Categorías: una nueva (por nombre queda última) sube al principio, que
      // es el orden que ve el cliente.
      const categories = m.locator('details[data-keep-open="catalog-categories"]');
      if (await categories.getAttribute('open') === null) await categories.locator('summary').click();
      await m.fill('#cat-new', `Vinos ${engine}`);
      await m.locator('form[data-form="category-create"] button[type="submit"]').click();
      await ready(m);
      let moves = 0;
      for (; moves < 6; moves += 1) {
        const up = m.getByRole('button', { name: `Subir Vinos ${engine}`, exact: true });
        if (await up.isDisabled()) break;
        await up.click();
        await ready(m);
      }
      assert.ok(moves >= 1, 'hubo que reordenar');
      const [first] = await sql`select name from public.product_categories where business_id = ${A.id} order by position, name limit 1`;
      assert.equal(first.name, `Vinos ${engine}`);
      await shot(m, `${engine}-panel-catalogo`);
      assert.deepEqual(owner.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: configuración: horarios, retiro y envío se guardan y siguen ahí al recargar`, async () => {
    const browser = await launch(engine);
    try {
      const owner = await person(browser, { width: 390, height: 844, label: 'titular C' });
      const m = owner.page;
      await landOnPanel(m, people.ownerC);
      await go(m, `#panel/${C.id}/horarios`);
      await m.fill('[name="d1-0-opens"]', '00:00');
      await m.fill('[name="d1-0-closes"]', '23:55');
      await m.click('[data-action="hours-copy-monday"]');
      await m.check('[name="d0-closed"]');
      await m.locator('form[data-form="business-hours"] button[type="submit"]').click();
      await expectToast(m, 'Horarios guardados.');
      await ready(m);
      const hours = await sql`select weekday, to_char(opens, 'HH24:MI') as opens, to_char(closes, 'HH24:MI') as closes
        from public.business_hours where business_id = ${C.id} order by weekday`;
      assert.deepEqual(hours.map(row => row.weekday), [1, 2, 3, 4, 5, 6], 'el domingo quedó cerrado');
      assert.ok(hours.every(row => row.opens === '00:00' && row.closes === '23:55'));

      await go(m, `#panel/${C.id}/configuracion`);
      await m.uncheck('input[name="pickupEnabled"]');
      await m.fill('#b-fee', '1800');
      await m.fill('#b-min', '3500');
      await m.fill('#b-prep', '20');
      await m.getByRole('button', { name: 'Guardar envío y tiempos' }).click();
      await expectToast(m, 'Datos guardados.');
      await ready(m);

      await m.reload();
      await ready(m);
      assert.equal(await m.locator('input[name="pickupEnabled"]').isChecked(), false);
      assert.equal(await m.locator('input[name="deliveryEnabled"]').isChecked(), true);
      assert.deepEqual([await m.inputValue('#b-fee'), await m.inputValue('#b-min'), await m.inputValue('#b-prep')], ['1800', '3500', '20']);
      await go(m, `#panel/${C.id}/horarios`);
      assert.equal(await m.inputValue('[name="d3-0-opens"]'), '00:00');
      assert.equal(await m.locator('[name="d0-closed"]').isChecked(), true);
      assert.ok(await m.getByText('Así lo ve el cliente').isVisible());
      // Volver a como estaba para la corrida del otro navegador.
      ok(await people.ownerC.client.rpc('set_business_hours', { business: C.id, hours: [] }));
      ok(await people.ownerC.client.from('businesses').update({ pickup_enabled: true }).eq('id', C.id));
      assert.deepEqual(owner.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: control remoto en el teléfono: precio al toque, envío arriba, pausar, reactivar y abrir`, async () => {
    const browser = await launch(engine);
    try {
      const owner = await person(browser, { width: 390, height: 844, label: 'titular C' });
      const m = owner.page;
      await landOnPanel(m, people.ownerC);
      // Dos filas de secciones: lo de todos los días arriba, la administración abajo.
      const rowOf = async name => (await m.getByRole('tab', { name, exact: true }).boundingBox()).y;
      assert.equal(await rowOf('Inicio'), await rowOf('Reparto'));
      assert.ok(await rowOf('Horarios') > await rowOf('Inicio'));

      // Precio y stock desde la fila del producto, sin abrir el formulario completo.
      await go(m, `#panel/${C.id}/catalogo`);
      const row = m.locator('article[aria-label="Producto Torta del día"]');
      await row.locator('input[name="price"]').first().fill('9900');
      await row.locator('form[data-form="product-quick"] input[name="stock"]').fill('5');
      await row.locator('form[data-form="product-quick"]').getByRole('button', { name: 'Guardar', exact: true }).click();
      await expectToast(m, 'Precio y stock guardados.');
      await ready(m);
      const [torta] = await sql`select price_ars::int as price, stock from public.products where id = ${C.products.tracked.id}`;
      assert.deepEqual({ ...torta }, { price: 9900, stock: 5 });

      // Costo de envío y pedido mínimo, lo primero de Configuración.
      await go(m, `#panel/${C.id}/configuracion`);
      const first = await m.locator('form[data-form="business-update"] .checkout-section-title').first().textContent();
      assert.equal(first.trim(), 'Envío, pedidos y tiempos');
      await m.fill('#b-fee', '2100');
      await m.fill('#b-min', '4000');
      await m.getByRole('button', { name: 'Guardar envío y tiempos' }).click();
      await expectToast(m, 'Datos guardados.');
      await ready(m);
      const [fees] = await sql`select delivery_fee_ars::int as fee, minimum_order_ars::int as minimum from public.businesses where id = ${C.id}`;
      assert.deepEqual({ ...fees }, { fee: 2100, minimum: 4000 });

      // Pausar pide confirmación ("Volver" no pausa) y saca el comercio de CAUCE.
      await go(m, `#panel/${C.id}/inicio`);
      const dialog = m.locator('dialog.cauce-dialog');
      await m.getByRole('button', { name: 'Pausar el comercio' }).click();
      await dialog.getByRole('button', { name: 'Volver' }).click();
      await ready(m);
      assert.equal((await sql`select status from public.businesses where id = ${C.id}`)[0].status, 'active');
      await m.getByRole('button', { name: 'Pausar el comercio' }).click();
      await dialog.getByRole('button', { name: 'Pausar', exact: true }).click();
      await ready(m);
      assert.equal((await sql`select status from public.businesses where id = ${C.id}`)[0].status, 'paused');
      assert.match(await m.locator('.panel-openbar').textContent(), /CERRADO[\s\S]*Pausaste el comercio/);
      assert.deepEqual(ok(await anonClient().from('businesses').select('id').eq('id', C.id)), [], 'pausado no se ve en CAUCE');
      // Reactivar lo vuelve a publicar con la atención cerrada: se abre con un toque.
      await m.getByRole('button', { name: 'Reactivar el comercio' }).click();
      await ready(m);
      await m.getByRole('button', { name: 'Abrir atención' }).click();
      await ready(m);
      assert.match(await m.locator('.panel-openbar').textContent(), /ABIERTO/);
      const [state] = await sql`select status, open from public.businesses where id = ${C.id}`;
      assert.deepEqual({ ...state }, { status: 'active', open: true });
      await shot(m, `${engine}-panel-control-remoto`);
      assert.deepEqual(owner.problems, []);
    } finally {
      // C queda publicado y abierto para la corrida del otro navegador.
      await people.ownerC.client.rpc('set_business_presence', { business: C.id, next_status: 'active' });
      await people.ownerC.client.rpc('set_business_presence', { business: C.id, is_open: true });
      await browser.close();
    }
  });

  test(`${engine}: encargado/a en la tablet: atiende, cierra y abre la atención, ve el equipo sin cambiarlo`, async () => {
    const browser = await launch(engine);
    try {
      const manager = await person(browser, { width: 768, height: 1024, label: 'encargado/a' });
      const m = manager.page;
      await landOnPanel(m, people.managerA);
      const tabs = (await m.getByRole('tab').allTextContents()).map(text => text.replace(/\d+/g, '').trim());
      assert.deepEqual(tabs, ['Inicio', 'Pedidos', 'Catálogo', 'Reparto', 'Horarios', 'Configuración', 'Equipo']);
      const { id, code } = await newOrder(A, { fulfillment: 'delivery' });
      await go(m, `#panel/${A.id}/pedidos`);
      await panelAction(m, code, 'Aceptar');
      await panelAction(m, code, 'Empezar a preparar');
      await panelAction(m, code, 'Listo para enviar');
      await go(m, `#panel/${A.id}/reparto`);
      const pending = m.locator('section.orders-group', { has: m.locator('#reparto-para-asignar') });
      await pending.locator(`article[aria-label="Pedido ${code}"]`).waitFor();
      await card(m, code).locator('select[name="riderId"]').selectOption({ label: 'Reparto Vista' });
      await card(m, code).getByRole('button', { name: 'Asignar reparto' }).click();
      await ready(m);
      assert.equal(await statusOf(id), 'assigned');
      assert.match(await m.locator('.rider-load').textContent(), /Reparto Vista · \d+ pedidos? en curso/);

      await go(m, `#panel/${A.id}/inicio`);
      await m.getByRole('button', { name: 'Cerrar atención' }).click();
      await ready(m);
      assert.match(await m.locator('.panel-openbar').textContent(), /CERRADO[\s\S]*Cerraste la atención/);
      assert.equal((await sql`select open from public.businesses where id = ${A.id}`)[0].open, false);
      await m.getByRole('button', { name: 'Abrir atención' }).click();
      await ready(m);
      assert.match(await m.locator('.panel-openbar').textContent(), /ABIERTO/);

      await go(m, `#panel/${A.id}/equipo`);
      assert.equal(await m.locator('.team-member').count(), 3);
      assert.equal(await m.locator('form[data-form="team-add"]').count(), 0, 'sólo el titular suma gente');
      assert.equal(await m.locator('[data-action="team-role"], [data-action="team-remove"]').count(), 0);
      assert.ok(await m.getByText('Tu rol: Encargado/a.').isVisible());
      assert.deepEqual(manager.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: equipo (staff) atiende, rechaza con motivo y marca agotados; no ve administración`, async () => {
    const browser = await launch(engine);
    try {
      const staff = await person(browser, { width: 390, height: 844, label: 'equipo' });
      const m = staff.page;
      await landOnPanel(m, people.staffA);
      const tabs = (await m.getByRole('tab').allTextContents()).map(text => text.replace(/\d+/g, '').trim());
      assert.deepEqual(tabs, ['Inicio', 'Pedidos', 'Catálogo', 'Reparto']);
      assert.ok(await m.getByText('Tu rol: Equipo.').isVisible());
      // Una sección de administración por URL cae en Inicio.
      for (const section of ['configuracion', 'horarios', 'equipo']) {
        await go(m, `#panel/${A.id}/${section}`);
        assert.ok(await m.getByRole('heading', { name: 'Hoy', exact: true }).isVisible(), `${section} no se abre para el equipo`);
        assert.equal(await m.locator('form[data-form="business-update"], form[data-form="business-hours"], form[data-form="team-add"]').count(), 0);
      }

      const accepted = await newOrder(A);
      const rejected = await newOrder(A);
      await go(m, `#panel/${A.id}/pedidos`);
      await panelAction(m, accepted.code, 'Aceptar');
      assert.equal(await statusOf(accepted.id), 'accepted');
      await card(m, rejected.code).getByRole('button', { name: 'Rechazar', exact: true }).click();
      const dialog = m.locator('dialog.cauce-dialog');
      await dialog.locator('#cauce-dialog-reason').fill('Nos quedamos sin empanadas');
      await dialog.getByRole('button', { name: 'Rechazar' }).click();
      await ready(m);
      const [row] = await sql`select status, cancel_reason from public.orders where id = ${rejected.id}`;
      assert.deepEqual({ ...row }, { status: 'canceled', cancel_reason: 'Nos quedamos sin empanadas' });

      await go(m, `#panel/${A.id}/catalogo`);
      assert.equal(await m.locator('form[data-form="product-create"], form[data-form="product-edit"]').count(), 0);
      assert.equal(await m.getByRole('button', { name: 'Desactivar' }).count(), 0);
      const product = m.locator('article[aria-label="Producto Empanada de carne"]');
      await product.getByRole('button', { name: 'Marcar agotado' }).click();
      await ready(m);
      assert.equal((await sql`select available from public.products where id = ${A.products.untracked.id}`)[0].available, false);
      await product.getByRole('button', { name: 'Marcar disponible' }).click();
      await ready(m);
      assert.equal((await sql`select available from public.products where id = ${A.products.untracked.id}`)[0].available, true);

      await go(m, `#panel/${A.id}/reparto`);
      assert.ok(await m.getByRole('heading', { name: 'Envíos ahora' }).isVisible());
      assert.equal(await m.locator('form[data-form="rider-create"], [data-action="rider-toggle"]').count(), 0);
      assert.deepEqual(staff.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: seguridad: A no abre ni mueve lo de B, ni por la interfaz ni por la API con su sesión`, async () => {
    const browser = await launch(engine);
    try {
      const owner = await person(browser, { width: 390, height: 844, label: 'titular A' });
      const m = owner.page;
      await landOnPanel(m, people.ownerA);
      for (const section of ['', '/pedidos', '/catalogo', '/equipo']) {
        await go(m, `#panel/${B.id}${section}`);
        assert.ok(await m.getByText('Ese comercio no pertenece a tu cuenta.').isVisible(), `#panel/B${section}`);
      }
      // Con el token de la sesión del navegador, directo contra la API.
      const results = await m.evaluate(async ({ url, key, order, product, business }) => {
        // La sesión que guardó la propia aplicación (clave fija del build).
        const token = JSON.parse(localStorage.getItem('cauce:production:auth')).access_token;
        const headers = { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
        const call = async (path, init = {}) => {
          const response = await fetch(`${url}${path}`, { headers, ...init });
          return { status: response.status, body: await response.text() };
        };
        return {
          read: await call(`/rest/v1/orders?select=id&id=eq.${order}`),
          transition: await call('/rest/v1/rpc/transition_order', { method: 'POST',
            body: JSON.stringify({ order_id: order, next_status: 'accepted' }) }),
          price: await call(`/rest/v1/products?id=eq.${product}`, { method: 'PATCH', body: JSON.stringify({ price_ars: 1 }) }),
          riders: await call(`/rest/v1/business_riders?select=id&business_id=eq.${business}`),
          team: await call('/rest/v1/rpc/business_team', { method: 'POST', body: JSON.stringify({ business }) }),
          hours: await call('/rest/v1/rpc/set_business_hours', { method: 'POST', body: JSON.stringify({ business, hours: [] }) }),
        };
      }, { url: env.url, key: env.publishableKey, order: orderOfB, product: B.products.untracked.id, business: B.id });
      assert.equal(results.read.body, '[]', 'el pedido de B no se lee');
      assert.equal(results.riders.body, '[]', 'el reparto de B no se lee');
      assert.equal(results.price.body, '[]', 'el precio de B no se modifica');
      for (const key of ['transition', 'team', 'hours']) {
        assert.ok(results[key].status >= 400 && /42501/.test(results[key].body), `${key}: ${results[key].status} ${results[key].body}`);
      }
      const [orderRow] = await sql`select status from public.orders where id = ${orderOfB}`;
      const [productRow] = await sql`select price_ars::int as price from public.products where id = ${B.products.untracked.id}`;
      assert.deepEqual([orderRow.status, productRow.price], ['submitted', 1200], 'B intacto');
      assert.deepEqual(owner.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: el panel entra en 320, 375, 390, 430, 768, 1280 y 1440 sin desbordes ni controles chicos`, async () => {
    const browser = await launch(engine);
    const report = {};
    try {
      // Con algo en cada estado, para que el tablero tenga tarjetas reales.
      const ready1 = await newOrder(A, { fulfillment: 'delivery' });
      for (const next of ['accepted', 'preparing', 'ready']) {
        ok(await people.ownerA.client.rpc('transition_order', { order_id: ready1.id, next_status: next }));
      }
      await newOrder(A);
      for (const width of [320, 375, 390, 430, 768, 1280, 1440]) {
        const owner = await person(browser, { width, height: width < 900 ? 844 : 900, label: `titular ${width}` });
        const m = owner.page;
        await landOnPanel(m, people.ownerA);
        for (const section of ['inicio', 'pedidos', 'catalogo', 'horarios', 'configuracion', 'reparto', 'equipo']) {
          await go(m, `#panel/${A.id}/${section}`);
          const issues = await layoutIssues(m);
          report[`${width}/${section}`] = issues;
          assert.deepEqual(issues, [], `${engine} ${width}px ${section}`);
        }
        if ([320, 390, 768, 1280].includes(width)) {
          await go(m, `#panel/${A.id}/pedidos`);
          await shot(m, `${engine}-panel-pedidos-${width}`);
        }
        assert.deepEqual(owner.problems, []);
        await owner.context.close();
      }
    } finally { await browser.close(); }
  });
}
