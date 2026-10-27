// Alta de un comercio por la interfaz, como la hará el primer comercio real:
// borrador → datos → horarios → catálogo → solicitud → aprobación de
// administración → abrir la atención → visible y comprable para el público.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  account, makeAdmin, closeAll, run,
  startPreview, stopPreview, browsersToRun, launch, person, open, go, ready, signIn, expectToast, shot, layoutIssues,
} from './harness.mjs';

const people = {};
before(async () => {
  await startPreview();
  people.admin = await account('onb-admin');
  await makeAdmin(people.admin);
  for (const engine of browsersToRun) people[engine] = await account(`onb-${engine}`);
});
after(async () => { await stopPreview(); await closeAll(Object.values(people)); });

const tab = (page, key) => page.locator(`[data-action="set-panel-tab"][data-tab="${key}"]`).click().then(() => ready(page));

for (const engine of browsersToRun) {
  test(`${engine}: un comercio se da de alta, administración lo aprueba y queda abierto al público`, async () => {
    const browser = await launch(engine);
    try {
      const shop = await person(browser, { label: 'comercio' });
      const office = await person(browser, { label: 'administración', width: 1280, height: 900 });
      const visitor = await person(browser, { label: 'visita' });
      const name = `Almacén Nuevo ${run} ${engine}`;

      // 1. Borrador.
      await signIn(shop.page, people[engine]);
      await open(shop.page, '#alta-comercio');
      await shop.page.fill('#biz-name', name);
      await shop.page.selectOption('#biz-category', { index: 1 });
      await shop.page.getByRole('button', { name: 'Crear borrador' }).click();
      await shop.page.waitForFunction(() => location.hash.startsWith('#panel/'), null, { timeout: 20000 });
      await ready(shop.page);
      await expectToast(shop.page, 'Comercio creado como borrador.');
      const businessId = await shop.page.evaluate(() => location.hash.split('/')[1]);
      // Todavía no se puede pedir la publicación, y la pantalla dice qué falta.
      const pending = shop.page.locator('.notice', { hasText: 'Falta completar' });
      for (const item of ['Dirección', 'Responsable', 'Teléfono o WhatsApp para clientes']) {
        assert.ok((await pending.textContent()).includes(item), `falta ${item}`);
      }
      assert.equal(await shop.page.getByRole('button', { name: 'Solicitar publicación' }).isDisabled(), true);

      // 2. Datos.
      await shop.page.fill('#b-owner', 'Titular Real');
      await shop.page.fill('#b-phone', '2942 409988');
      await shop.page.fill('#b-whatsapp', '2942 409977');
      await shop.page.fill('#b-address', 'Cristian Joubert 450');
      await shop.page.fill('#b-hours', 'Todos los días');
      await shop.page.fill('#b-prep', '20');
      await shop.page.getByRole('button', { name: 'Guardar datos' }).click();
      await expectToast(shop.page, 'Datos guardados.');

      // 3. Horarios: toda la semana, en dos turnos (el segundo cruza la
      // medianoche), así la prueba no depende de la hora en que corre.
      await tab(shop.page, 'horarios');
      for (let day = 0; day < 7; day += 1) {
        await shop.page.fill(`input[name="d${day}-0-opens"]`, '00:00');
        await shop.page.fill(`input[name="d${day}-0-closes"]`, '12:00');
        await shop.page.fill(`input[name="d${day}-1-opens"]`, '12:00');
        await shop.page.fill(`input[name="d${day}-1-closes"]`, '00:00');
      }
      await shop.page.getByRole('button', { name: 'Guardar horarios' }).click();
      await expectToast(shop.page, 'Horarios guardados.');

      // 4. Catálogo: un producto sin control de stock. Nace pendiente: la
      // aprobación del comercio no publica su catálogo.
      await tab(shop.page, 'catalogo');
      await shop.page.fill('#prod-name', 'Yerba 1 kg');
      await shop.page.fill('#prod-price', '4200');
      await shop.page.getByRole('button', { name: 'Agregar al catálogo' }).click();
      await expectToast(shop.page, 'Producto agregado. Queda pendiente de revisión antes de publicarse.');
      const shopProduct = shop.page.locator('article[aria-label="Producto Yerba 1 kg"]');
      await shopProduct.waitFor();
      assert.ok(await shopProduct.getByText('Pendiente de revisión').isVisible(), 'el comercio ve que falta revisión');

      // 5. Solicitud de publicación.
      await tab(shop.page, 'configuracion');
      await shop.page.getByText('Los datos mínimos están completos.').waitFor();
      await shop.page.getByRole('button', { name: 'Solicitar publicación' }).click();
      await expectToast(shop.page, 'Solicitud enviada. Queda pendiente de revisión administrativa.');
      // Sin aprobar, el público no lo ve.
      await open(visitor.page, '#comercios');
      assert.equal(await visitor.page.locator('.catalog-merchant-card', { hasText: name }).count(), 0);

      // 6. Administración aprueba el comercio. El catálogo sigue pendiente:
      // publicar el comercio no publica sus productos.
      await signIn(office.page, people.admin);
      await open(office.page, '#admin');
      const businessCard = office.page.locator('article.review-card')
        .filter({ has: office.page.locator('form[data-form="review"]') })
        .filter({ hasText: name });
      await businessCard.waitFor();
      assert.ok((await businessCard.textContent()).includes('Titular Real'));
      await businessCard.getByRole('button', { name: 'Aprobar' }).click();
      await expectToast(office.page, 'Alta aprobada.');
      // En escritorio, mientras el aviso está visible, un clic sobre él llega a
      // lo que hay debajo (antes se perdía durante 5 segundos).
      assert.equal(await office.page.evaluate(() => {
        const box = document.querySelector('#toast').getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.id;
      }) === 'toast', false, 'el aviso no intercepta clics');
      await shot(office.page, `${engine}-onboarding-admin`);

      // 7. El comercio abre la atención.
      await open(shop.page, `#panel/${businessId}`);
      await shop.page.getByRole('button', { name: 'Abrir atención' }).click();
      await ready(shop.page);
      await shop.page.getByRole('button', { name: 'Cerrar atención' }).waitFor();

      // 8. El público encuentra el comercio abierto buscándolo, pero todavía no
      // el producto: sin aprobación no aparece en la vidriera ni se puede pedir.
      // (La visita ya estaba en el listado: recarga como lo haría una persona.)
      await visitor.page.reload();
      await ready(visitor.page, 60000);
      await visitor.page.fill('#search-input', name);
      await visitor.page.locator('form[data-form="search"] button[type="submit"]').click();
      await ready(visitor.page, 60000);
      const listed = visitor.page.locator('.mifav-store-card', { hasText: name });
      await listed.waitFor({ timeout: 60000 });
      await listed.click();
      await visitor.page.waitForFunction(id => location.hash === `#comercio/${id}`, businessId);
      await ready(visitor.page);
      assert.equal(await visitor.page.locator('article.product-card', { hasText: 'Yerba 1 kg' }).count(), 0,
        'un producto pendiente no se publica junto con el comercio');
      await shot(visitor.page, `${engine}-onboarding-producto-pendiente`);

      // 9. Administración revisa y aprueba el producto.
      await go(office.page, '#admin');
      const productCard = office.page.locator('article.review-card')
        .filter({ has: office.page.locator('form[data-form="review-product"]') })
        .filter({ hasText: name });
      await productCard.waitFor();
      assert.match(await productCard.textContent(), /Yerba 1 kg/);
      await productCard.getByRole('button', { name: 'Aprobar y publicar' }).click();
      await expectToast(office.page, 'Producto aprobado y publicado.');

      // 10. Ahora sí: el público vuelve a explorar, busca y compra.
      await open(visitor.page, '#comercios', 60000);
      await visitor.page.fill('#search-input', name);
      await visitor.page.locator('form[data-form="search"] button[type="submit"]').click();
      await ready(visitor.page, 60000);
      const reopened = visitor.page.locator('.mifav-store-card', { hasText: name });
      await reopened.waitFor({ timeout: 60000 });
      await reopened.click();
      await visitor.page.waitForFunction(id => location.hash === `#comercio/${id}`, businessId);
      await ready(visitor.page);
      // Contacto directo con el comercio desde su página.
      await visitor.page.locator('a[href^="https://wa.me/549"]').first().waitFor({ timeout: 10000 });
      await visitor.page.locator('article.product-card', { hasText: 'Yerba 1 kg' })
        .getByRole('button', { name: 'Agregar' }).click();
      await ready(visitor.page);
      await visitor.page.locator('.sticky-cart-bar a.button').waitFor();
      // El acceso al carrito queda a la vista, sobre la navegación inferior
      // (antes un overflow en body anulaba el sticky y quedaba bajo el borde).
      const bar = await visitor.page.evaluate(() => {
        const cart = document.querySelector('.sticky-cart-bar').getBoundingClientRect();
        const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
        return { top: cart.top, bottom: cart.bottom, nav: nav.top };
      });
      assert.ok(bar.top >= 0 && bar.bottom <= bar.nav, `barra del carrito a la vista: ${JSON.stringify(bar)}`);
      // Los horarios se despliegan desde la ficha.
      await visitor.page.locator('.hours-details summary').click();
      await visitor.page.locator('.hours-list li').first().waitFor();
      assert.deepEqual(await layoutIssues(visitor.page), []);
      await shot(visitor.page, `${engine}-onboarding-publico`);
      assert.deepEqual([...shop.problems, ...office.problems, ...visitor.problems], []);
    } finally { await browser.close(); }
  });
}
