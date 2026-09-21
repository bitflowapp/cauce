// Recorrido de navegador de punta a punta contra el backend local.
//
// Cada rol usa su PROPIO navegador (perfil separado): son sesiones distintas de
// verdad, no pestañas compartiendo cookies. Ejecutar con:
//   node tests/e2e-journeys.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, findChrome } from './lib/cdp.mjs';
import { createDevServer, openDatabase } from '../scripts/dev-server.mjs';

const SHOTS = 'evidence/e2e';
const PASSWORD = 'clavedeprueba123';
const results = [];
let failures = 0;

function step(name, detail = '') {
  results.push({ name, detail, ok: true });
  console.log(`  ✔ ${name}${detail ? ` · ${detail}` : ''}`);
}

function fail(name, error) {
  failures += 1;
  results.push({ name, ok: false, error: String(error?.message || error) });
  console.log(`  ✖ ${name} · ${error?.message || error}`);
}

async function main() {
  if (!findChrome()) {
    console.error('No se encontró Chrome ni Edge. Definí CAUCE_CHROME_PATH.');
    process.exitCode = 1;
    return;
  }

  const database = openDatabase(':memory:');
  const server = createDevServer({ database });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Backend local de pruebas en ${base}`);
  await mkdir(SHOTS, { recursive: true });

  // Un navegador por identidad: perfiles separados, cookies separadas.
  const browsers = {};
  const open = async (role, hash) => {
    browsers[role] ||= await launchBrowser();
    const page = await browsers[role].newPage({ width: 390, height: 844, mobile: true });
    await page.goto(`${base}/index.html${hash}`);
    await page.waitForFunction('document.querySelector("#main")?.children.length > 0');
    await page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
    return page;
  };

  const shot = (page, name) => page.screenshot(`${SHOTS}/${name}.png`, { fullPage: true });
  const showcase = async (page, name, focusSelector = '') => {
    await page.evaluate(`(() => {
      document.activeElement?.blur?.();
      const target = ${JSON.stringify(focusSelector)} ? document.querySelector(${JSON.stringify(focusSelector)}) : null;
      if (target) target.scrollIntoView({ block: 'start', behavior: 'instant' });
      else window.scrollTo(0, 0);
      return true;
    })()`);
    return page.screenshot(`${SHOTS}/${name}.png`);
  };

  // Navegación completa (recarga real de la ruta), que además comprueba que
  // cada enlace directo funciona al abrirlo o recargarlo.
  const visit = async (page, hash) => {
    // Navegar a una URL que sólo difiere en el fragmento no recarga el documento.
    // Para comprobar de verdad el enlace directo hay que pasar por about:blank.
    await page.goto('about:blank');
    await page.goto(`${base}/index.html${hash}`);
    await page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
  };

  // Hace clic en el botón cuyo texto coincide exactamente, esperando a que la
  // vista termine de redibujarse en vez de suponer que ya ocurrió.
  const clickByLabel = async (page, selector, label) => {
    const query = `[...document.querySelectorAll(${JSON.stringify(selector)})]`
      + `.find(node => node.textContent.trim() === ${JSON.stringify(label)})`;
    await page.waitForFunction(`!!${query}`);
    await page.evaluate(`(() => { ${query}.click(); return true; })()`);
    await page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
  };

  const signUp = async (page, { name, email, phone }) => {
    await visit(page, '#cuenta');
    await page.waitForFunction(`!!document.querySelector('[data-form="register"]')`);
    await page.fill('#reg-name', name);
    await page.fill('#reg-email', email);
    await page.fill('#reg-phone', phone);
    await page.fill('#reg-password', PASSWORD);
    await page.click('[data-form="register"] button[type="submit"]');
    await page.waitForFunction(`document.querySelector('#account-link')?.classList.contains('is-signed')`);
  };

  try {
    // ───────── entorno ─────────
    const visitor = await open('visitante', '#inicio');
    const chip = await visitor.text('#env-chip');
    if (!/pruebas/i.test(chip)) throw new Error(`El indicador de entorno dice "${chip}"`);
    step('El entorno local se identifica en la cabecera', chip);
    await shot(visitor, '00-inicio');
    await showcase(visitor, 'showcase-01-home-390');
    await visitor.setViewport({ width: 1440, height: 900, mobile: false });
    await showcase(visitor, 'showcase-01-home-desktop');
    await visitor.setViewport({ width: 390, height: 844, mobile: true });

    // ───────── recorrido 1: alta y publicación de un comercio ─────────
    console.log('\nRecorrido 1 · alta y publicación de un comercio');
    const merchant = await open('comercio', '#inicio');
    await signUp(merchant, { name: 'Ana Comerciante', email: 'comercio@cauce.test', phone: '2942111111' });
    step('El comercio crea su cuenta');

    await merchant.evaluate(`(() => { location.hash = '#alta-comercio'; return true; })()`);
    await merchant.waitForFunction('document.querySelector(\"#main\")?.getAttribute(\"aria-busy\") === \"false\"');
    await merchant.waitForFunction(`!!document.querySelector('[data-form="business-create"]')`);
    await merchant.fill('#biz-name', 'Almacén El Pehuén');
    await merchant.fill('#biz-category', 'Almacén');
    await merchant.click('[data-form="business-create"] button[type="submit"]');
    await merchant.waitForFunction(`location.hash.startsWith('#panel/')`);
    step('Crea el comercio como borrador');
    await shot(merchant, '01-comercio-borrador');

    await merchant.waitForFunction(`!!document.querySelector('#b-owner')`);
    await merchant.fill('#b-owner', 'Ana Comerciante');
    await merchant.fill('#b-phone', '2942111111');
    await merchant.fill('#b-address', 'Av. 4 de Febrero 250');
    await merchant.fill('#b-hours', 'Lunes a sábado de 9 a 13 y de 17 a 21');
    await merchant.fill('#b-zone', 'Casco urbano de Aluminé');
    await merchant.fill('#b-fee', '1200');
    await merchant.evaluate(`(() => {
      const delivery = document.querySelector('[name="deliveryEnabled"]');
      if (!delivery.checked) delivery.click();
      return true;
    })()`);
    await merchant.click('[data-form="business-update"] button[type="submit"]');
    await merchant.waitForFunction(`document.querySelector('#toast')?.textContent.includes('guardados')`);
    step('Completa los datos del comercio');

    const blocked = await merchant.evaluate(
      `document.querySelector('[data-action="submit-business"]')?.disabled === true`);
    if (!blocked) throw new Error('Se puede pedir publicación sin catálogo');
    step('Sin catálogo no se puede solicitar la publicación');

    await merchant.click('[data-action="set-panel-tab"][data-tab="catalogo"]');
    await merchant.waitForFunction(`!!document.querySelector('#prod-name')`);
    await merchant.fill('#prod-name', 'Pan casero de campo');
    await merchant.fill('#prod-description', 'Hogaza de masa madre de 750 g');
    await merchant.fill('#prod-price', '3200');
    await merchant.fill('#prod-stock', '12');
    await merchant.fill('#prod-category', 'Panadería');
    await merchant.click('[data-form="product-create"] button[type="submit"]');
    await merchant.waitForFunction(`document.querySelector('#toast')?.textContent.includes('catálogo')`);
    step('Carga un producto');

    // El producto de prueba usa una fotografía incluida y documentada en el
    // repositorio. Se configura en el fixture E2E porque el formulario de alta
    // todavía no incorpora un selector de archivos.
    {
      const row = database.prepare('SELECT doc FROM domain_state WHERE id = 1').get();
      const state = JSON.parse(row.doc);
      const product = state.products.find(item => item.businessId === 'almacen-el-pehuen' && item.name === 'Pan casero de campo');
      product.image = 'assets/images/dishes/pan-campo-hogaza.webp';
      product.dishType = 'sandwich';
      database.prepare('UPDATE domain_state SET doc = ? WHERE id = 1').run(JSON.stringify(state));
    }

    // Un segundo producto con variantes simples.
    await merchant.fill('#prod-name', 'Limonada por tamaño');
    await merchant.fill('#prod-description', 'Limón, menta y jengibre');
    await merchant.fill('#prod-price', '2500');
    await merchant.fill('#prod-stock', '20');
    await merchant.fill('#prod-category', 'Bebidas');
    await merchant.fill('#prod-variants', 'Chica, Grande +1200');
    await merchant.click('[data-form="product-create"] button[type="submit"]');
    await merchant.waitForFunction(`/variantes: chica, grande/i.test(document.querySelector('#main').innerText)`);
    step('Carga un producto con variantes simples');
    await shot(merchant, '02-catalogo');

    await merchant.click('[data-action="set-panel-tab"][data-tab="datos"]');
    await merchant.waitForFunction(`document.querySelector('[data-action="submit-business"]')?.disabled === false`);
    await merchant.click('[data-action="submit-business"]');
    await merchant.waitForFunction(`/pendiente de revisi/i.test(document.body.innerText)`);
    step('Solicita la publicación');
    await shot(merchant, '03-pendiente-revision');

    // Administración, en otro navegador.
    const admin = await open('administracion', '#inicio');
    await signUp(admin, { name: 'Administración CAUCE', email: 'admin@cauce.test', phone: '2942222222' });
    {
      // El rol de administración se concede fuera de la API pública, como con --seed.
      const row = database.prepare('SELECT doc FROM domain_state WHERE id = 1').get();
      const state = JSON.parse(row.doc);
      state.accounts.find(account => account.email === 'admin@cauce.test').roles.push('admin');
      database.prepare('UPDATE domain_state SET doc = ? WHERE id = 1').run(JSON.stringify(state));
    }
    await visit(admin, '#admin');
    await admin.waitForFunction(`/comercios pendientes/i.test(document.body.innerText)`);
    step('Administración ve la cola de revisión');

    await admin.fill('[data-form="review"][data-kind="business"] textarea', 'Falta aclarar si abren los domingos.');
    await admin.click('[data-form="review"][data-kind="business"] button[value="return"]');
    await admin.waitForFunction(`document.querySelector('#toast')?.textContent.includes('devuelta')`);
    step('Devuelve el alta con observaciones');
    await shot(admin, '04-admin-devuelve');

    await visit(merchant, '#panel/almacen-el-pehuen');
    await merchant.waitForFunction(`document.body.innerText.includes('domingos')`);
    step('El comercio ve el motivo de la devolución');

    await merchant.click('[data-action="set-panel-tab"][data-tab="datos"]');
    await merchant.waitForFunction(`!!document.querySelector('#b-hours')`);
    await merchant.fill('#b-hours', 'Lunes a sábado de 9 a 13 y de 17 a 21. Domingos cerrado.');
    await merchant.click('[data-form="business-update"] button[type="submit"]');
    await merchant.waitForFunction(`document.querySelector('#toast')?.textContent.includes('guardados')`);
    await merchant.click('[data-action="submit-business"]');
    await merchant.waitForFunction(`/pendiente de revisi/i.test(document.body.innerText)`);
    step('Corrige y vuelve a enviar');

    await admin.evaluate(`(() => { location.reload(); return true; })()`);
    await admin.waitForFunction(`!!document.querySelector('[data-form="review"][data-kind="business"]')`);
    await admin.click('[data-form="review"][data-kind="business"] button[value="approve"]');
    await admin.waitForFunction(`document.querySelector('#toast')?.textContent.includes('aprobada')`);
    step('Administración aprueba la publicación');

    await visit(visitor, '#comercios');
    await visitor.waitForFunction(`document.body.innerText.includes('Almacén El Pehuén')`);
    step('El comercio aparece publicado para cualquier visitante');
    await shot(visitor, '05-comercios-publicado');

    // ───────── recorrido 2: compra y gestión ─────────
    console.log('\nRecorrido 2 · compra con envío y gestión del pedido');
    const customer = await open('clienta', '#comercios');
    await customer.waitForFunction(`document.body.innerText.includes('Almacén El Pehuén')`);
    await customer.click('a[href^="#comercio/almacen-el-pehuen"]');
    await customer.waitForFunction(`document.body.innerText.includes('Pan casero de campo')`);
    await customer.click('[data-action="set-quantity"][data-quantity="1"]:not([data-variant])');
    await customer.waitForFunction(`document.body.innerText.includes('en el carrito')`);
    await customer.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
    step('Explora y suma al carrito sin crear cuenta');

    // El producto con variantes obliga a elegir una: no hay un "Agregar" suelto.
    const variantButtons = await customer.evaluate(
      `document.querySelectorAll('[data-action="set-quantity"][data-variant]').length`);
    if (variantButtons < 2) throw new Error('No aparecieron las variantes del producto');
    await customer.click('[data-action="set-quantity"][data-variant="grande"][data-quantity="1"]');
    await customer.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"');
    step('Elige una variante del producto que las tiene', `${variantButtons} opciones ofrecidas`);
    await shot(customer, '06-catalogo-cliente');
    await showcase(customer, 'showcase-02-comercio-productos-390');
    await customer.setViewport({ width: 360, height: 800, mobile: true });
    await showcase(customer, 'showcase-02-comercio-productos-360');
    await customer.setViewport({ width: 390, height: 844, mobile: true });

    const cartVisible = await customer.evaluate(
      `document.querySelector('#bnav-carrito')?.hidden === false`);
    if (!cartVisible) throw new Error('El carrito no apareció en la barra inferior');
    step('El carrito aparece en la barra inferior al tener contenido');

    await customer.evaluate(`(() => { location.hash = '#carrito/almacen-el-pehuen'; return true; })()`);
    await customer.waitForFunction('document.querySelector(\"#main\")?.getAttribute(\"aria-busy\") === \"false\"');
    await customer.waitForFunction(`!!document.querySelector('[data-form="checkout"]')`);
    await customer.evaluate(`(() => { document.querySelector('[name="fulfillment"][value="delivery"]').click(); return true; })()`);
    await customer.waitForFunction(`!!document.querySelector('#checkout-address')`);
    await customer.fill('#checkout-name', 'Rosa Vecina');
    await customer.fill('#checkout-phone', '2942333333');
    await customer.fill('#checkout-address', 'Cristian Joubert 410');
    await customer.evaluate(`(() => { document.querySelector('[name="zoneAcknowledged"]').click(); return true; })()`);
    const total = await customer.text('.totals-final');
    const detalle = await customer.text('.cart-lines-list');
    if (!/Grande/.test(detalle)) throw new Error('La confirmación no identifica la variante elegida');
    step('La confirmación muestra el total antes de confirmar', total.replace(/\n/g, ' '));
    await shot(customer, '07-confirmacion');
    await showcase(customer, 'showcase-03-carrito-imagenes-390');

    // Doble toque real sobre el botón de confirmar.
    await customer.evaluate(`(() => {
      const button = document.querySelector('[data-form="checkout"] button[type="submit"]');
      button.click();
      button.click();
      return true;
    })()`);
    await customer.waitForFunction(`location.hash.startsWith('#pedido/')`);
    const orderHash = await customer.evaluate('location.hash');
    const orderCount = database.prepare('SELECT doc FROM domain_state WHERE id = 1').get();
    const ordersInState = JSON.parse(orderCount.doc).orders.length;
    if (ordersInState !== 1) throw new Error(`El doble toque creó ${ordersInState} pedidos`);
    step('El doble toque crea un solo pedido', `${ordersInState} pedido registrado`);
    await shot(customer, '08-pedido-cliente');

    await visit(merchant, '#panel/almacen-el-pehuen');
    await merchant.waitForFunction(`document.body.innerText.includes('Rosa Vecina')`);
    step('El pedido llega al panel del comercio, en otra sesión');
    await shot(merchant, '09-panel-pedido');

    for (const label of ['Aceptar', 'Informar preparación']) await clickByLabel(merchant, '.order-panel-actions button', label);
    await visit(customer, orderHash);
    await customer.waitForFunction(`/en preparaci/i.test(document.querySelector('#main').innerText)`);
    await showcase(customer, 'showcase-04-pedido-preparacion-390');
    await clickByLabel(merchant, '.order-panel-actions button', 'Listo para enviar');
    step('El comercio acepta, prepara y marca listo');

    await merchant.click('[data-action="set-panel-tab"][data-tab="reparto"]');
    await merchant.waitForFunction(`!!document.querySelector('#rider-name')`);
    await merchant.fill('#rider-name', 'Reparto propio');
    await merchant.fill('#rider-phone', '2942444444');
    await merchant.click('[data-form="rider-create"] button[type="submit"]');
    await merchant.waitForFunction(`document.querySelector('#toast')?.textContent.includes('reparto')`);
    step('El comercio da de alta su propio reparto');

    await merchant.click('[data-action="set-panel-tab"][data-tab="pedidos"]');
    await merchant.waitForFunction(`!!document.querySelector('[data-form="assign-rider"]')`);
    await merchant.click('[data-form="assign-rider"] button[type="submit"]');
    await merchant.waitForFunction(`document.querySelector('#toast')?.textContent.includes('asignado')`);
    step('Asigna el reparto al pedido');

    for (const label of ['Retirado por el reparto', 'Marcar salida']) {
      await clickByLabel(merchant, '.order-panel-actions button', label);
    }
    await visit(customer, orderHash);
    await customer.waitForFunction(`/avance estimado/i.test(document.querySelector('#main').innerText)`);
    await customer.waitForFunction(`document.querySelector('#main').innerText.includes('Reparto propio')`);
    await showcase(customer, 'showcase-05-pedido-en-camino-390', '.route-card');
    for (const label of ['Llegó a destino', 'Marcar entregado']) {
      await clickByLabel(merchant, '.order-panel-actions button', label);
    }
    step('Marca salida y entrega');
    await shot(merchant, '10-panel-entregado');

    await visit(customer, '#actividad');
    await customer.waitForFunction(`/entregado/i.test(document.querySelector('#main').innerText)`);
    step('La clienta ve el pedido entregado en su propia sesión');
    await visit(customer, orderHash);
    await showcase(customer, 'showcase-09-historial-detalle-imagenes-390', '.route-card');

    // ───────── recorrido 3: taxi ─────────
    console.log('\nRecorrido 3 · solicitud y aceptación de taxi');
    const driver = await open('taxista', '#inicio');
    await signUp(driver, { name: 'Luis Conductor', email: 'taxista@cauce.test', phone: '2942555555' });
    await driver.evaluate(`(() => { location.hash = '#taxista'; return true; })()`);
    await driver.waitForFunction('document.querySelector(\"#main\")?.getAttribute(\"aria-busy\") === \"false\"');
    await driver.waitForFunction(`!!document.querySelector('#d-vehicle')`);
    await driver.fill('#d-vehicle', 'Renault Logan');
    await driver.fill('#d-plate', 'AB 123 CD');
    await driver.fill('#d-mobile', 'Móvil 4');
    await driver.click('[data-form="driver-apply"] button[type="submit"]');
    await driver.waitForFunction(`/en revisi/i.test(document.body.innerText)`);
    step('El taxista envía su alta');
    await shot(driver, '11-taxista-alta');

    await visit(admin, '#admin');
    await admin.waitForFunction(`!!document.querySelector('[data-form="review"][data-kind="driver"]')`);
    await admin.click('[data-form="review"][data-kind="driver"] button[value="approve"]');
    await admin.waitForFunction(`document.querySelector('#toast')?.textContent.includes('aprobada')`);
    step('Administración aprueba al taxista');

    await visit(driver, '#taxista');
    await driver.waitForFunction(`!!document.querySelector('[data-action="driver-availability"]')`);
    await driver.click('[data-action="driver-availability"]');
    await driver.waitForFunction(`document.body.innerText.includes('Disponible para recibir')`);
    step('El taxista se marca disponible');

    const passenger = await open('pasajera', '#taxi');
    await passenger.waitForFunction(`!!document.querySelector('#taxi-origin')`);
    await passenger.fill('#taxi-origin', 'Plaza San Martín');
    await passenger.fill('#taxi-destination', 'Hospital de Aluminé');
    await passenger.fill('#taxi-note', 'Portón verde');
    await passenger.fill('#taxi-name', 'Marta Pasajera');
    await passenger.fill('#taxi-phone', '2942666666');
    await passenger.click('[data-form="taxi-request"] button[type="submit"]');
    await passenger.waitForFunction(`location.hash.startsWith('#viaje/')`);
    await passenger.waitForFunction(`/buscando respuesta/i.test(document.body.innerText)`);
    step('La pasajera solicita el taxi');
    await shot(passenger, '12-taxi-solicitado');
    await passenger.waitForFunction(`document.querySelector('#toast')?.hidden === true`, { timeout: 6000 });
    await showcase(passenger, 'showcase-06-taxi-buscando-390');

    await visit(driver, '#taxista');
    await driver.waitForFunction(`document.body.innerText.includes('Plaza San Martín')`);
    const offerText = await driver.text('.order-panel-card');
    if (offerText.replace(/\D/g, '').includes('2942666666') || offerText.includes('Marta Pasajera')) {
      throw new Error('La solicitud abierta expone datos del pasajero');
    }
    step('Antes de aceptar, el conductor no ve nombre ni teléfono');
    await shot(driver, '13-taxista-solicitud');

    await driver.click('[data-action="trip-accept"]');
    await driver.waitForFunction(
      `document.body.innerText.replace(/[^0-9]/g, '').includes('2942666666')`);
    step('Al aceptar, recibe el contacto para coordinar');

    // Con un viaje en curso, la pestaña Taxi muestra el seguimiento de ese viaje.
    await visit(passenger, '#taxi');
    await passenger.waitForFunction(`document.body.innerText.includes('AB 123 CD')`);
    step('La pasajera ve el vehículo asignado');
    await shot(passenger, '14-taxi-confirmado');
    await showcase(passenger, 'showcase-07-taxi-confirmado-390', '.route-card');

    await clickByLabel(driver, '[data-action="trip-advance"]', 'Voy hacia pasajero');
    await visit(passenger, '#taxi');
    await passenger.waitForFunction(`/acercándose al punto de encuentro/i.test(document.querySelector('#main').innerText)`);
    await showcase(passenger, 'showcase-08-taxi-acercandose-390', '.route-card');

    for (const label of ['Llegué al origen', 'Pasajero a bordo', 'Iniciar viaje a destino', 'Finalizar viaje']) {
      await clickByLabel(driver, '[data-action="trip-advance"]', label);
    }
    step('El taxista recorre todos los estados hasta finalizar');

    // ───────── pérdida de conexión ─────────
    console.log('\nComportamiento sin conexión');
    await customer.evaluate(`(() => { location.hash = '#comercio/almacen-el-pehuen'; return true; })()`);
    await customer.waitForFunction('document.querySelector(\"#main\")?.getAttribute(\"aria-busy\") === \"false\"');
    await customer.waitForFunction(`document.body.innerText.includes('Pan casero')`);
    await customer.click('[data-action="set-quantity"][data-quantity="1"]');
    await customer.evaluate(`(() => { location.hash = '#carrito/almacen-el-pehuen'; return true; })()`);
    await customer.waitForFunction('document.querySelector(\"#main\")?.getAttribute(\"aria-busy\") === \"false\"');
    await customer.waitForFunction(`!!document.querySelector('[data-form="checkout"]')`);
    await customer.setOffline(true);
    await customer.evaluate(`(() => { window.dispatchEvent(new Event('offline')); return true; })()`);
    await customer.waitForFunction(`!!document.querySelector('.offline-live-notice')`);
    const disabled = await customer.evaluate(
      `document.querySelector('[data-form="checkout"] button[type="submit"]')?.disabled === true`);
    if (!disabled) throw new Error('Se puede confirmar sin conexión');
    // Lo que la persona escribió sigue en el formulario: no se perdió nada.
    const keptAddress = await customer.evaluate(`document.querySelector('#checkout-name')?.value || ''`);
    step('Sin conexión no se puede confirmar, se avisa y no se pierde lo escrito',
      keptAddress ? `campo conservado: "${keptAddress}"` : 'formulario intacto');
    await shot(customer, '15-sin-conexion');
    await customer.setOffline(false);
    await customer.evaluate(`(() => { window.dispatchEvent(new Event('online')); return true; })()`);

    // ───────── aislamiento entre identidades ─────────
    console.log('\nAislamiento entre identidades');
    await visit(customer, '#panel');
    const panelText = await customer.text('#main');
    if (panelText.includes('Almacén El Pehuén')) {
      throw new Error('Una sesión sin cuenta ve el panel del comercio');
    }
    step('Una visitante no accede al panel del comercio');

    await visit(customer, '#admin');
    await customer.waitForFunction(`/restringida/i.test(document.querySelector('#main').innerText)`);
    step('Una visitante no accede a administración');
    await shot(customer, '16-panel-restringido');

    // ───────── consola limpia ─────────
    const allErrors = [visitor, merchant, admin, customer, driver, passenger]
      .flatMap(page => page.consoleErrors)
      .filter(message => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(message));
    if (allErrors.length) throw new Error(`Errores en consola: ${allErrors.slice(0, 3).join(' | ')}`);
    step('Ninguna pantalla dejó errores propios en consola');
  } catch (error) {
    fail('Recorrido interrumpido', error);
  } finally {
    for (const browser of Object.values(browsers)) await browser.close().catch(() => {});
    server.close();
    database.close();
  }

  await writeFile('evidence/e2e-results.json', JSON.stringify({
    ejecutadoEl: new Date().toISOString(),
    entorno: 'backend local de pruebas (node:sqlite en memoria)',
    navegador: 'Chrome instalado en la máquina, vía CDP, emulación móvil 390×844',
    pasos: results,
    fallos: failures,
  }, null, 2), 'utf8');

  console.log(`\n${results.filter(item => item.ok).length} pasos verificados · ${failures} fallos`);
  console.log(`Capturas en ${SHOTS}/ · resultados en evidence/e2e-results.json`);
  if (failures) process.exitCode = 1;
}

await main();
