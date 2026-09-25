// Forma de la experiencia: qué se puede hacer en la primera pantalla, cómo se
// incorpora un prestador y qué NO debe estar expuesto como si fuera un rol
// intercambiable para cualquier visitante.
//
// Reemplaza a la suite de conversión anterior, que verificaba un botón de
// WhatsApp como vía de alta. Ese camino ya no existe: el alta la hace el propio
// comercio dentro de la plataforma y pasa por revisión administrativa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../js/domain/commands.js';
import { QUERIES } from '../js/domain/queries.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(resolve(root, file), 'utf8');

test('la primera pantalla ofrece las dos acciones principales', async () => {
  const app = await read('js/app.js');
  const home = app.slice(app.indexOf('async function viewHome'), app.indexOf('async function viewBusinesses'));
  const hero = home.slice(home.indexOf('<section class="home-hero">'), home.indexOf('${operation}'));
  assert.match(hero, /Comprá local/);
  assert.match(hero, /Movete por Aluminé/);
  assert.match(hero, /href="#comercios">.*Ver comercios/s, 'Falta el acceso a comercios');
  assert.match(hero, /href="#taxi">.*Pedir un taxi/s, 'Falta el acceso a taxi');
});

test('los accesos para prestadores son secundarios, no principales', async () => {
  const app = await read('js/app.js');
  const home = app.slice(app.indexOf('async function viewHome'), app.indexOf('async function viewBusinesses'));
  const hero = home.slice(home.indexOf('<section class="home-hero">'), home.indexOf('${operation}'));
  assert.equal(/Sumar mi comercio|taxista/i.test(hero), false,
    'El alta de prestadores no debe competir con las acciones principales');
  assert.match(home, /href="#alta-comercio"[\s\S]*Sumar mi comercio/);
  assert.match(home, /href="#taxista"[\s\S]*Registrarme como taxista/);
});

test('la navegación móvil es Inicio, Comercios, Taxi y Mi actividad', async () => {
  const html = await read('index.html');
  const nav = html.slice(html.indexOf('<nav class="bottom-nav"'), html.indexOf('</nav>'));
  for (const [id, label] of [
    ['bnav-inicio', 'Inicio'],
    ['bnav-comercios', 'Comercios'],
    ['bnav-taxi', 'Taxi'],
    ['bnav-actividad', 'Mi actividad'],
  ]) {
    assert.match(nav, new RegExp(`id="${id}"`), `Falta el acceso ${label}`);
    assert.ok(nav.includes(`>${label}<`), `Falta la etiqueta ${label}`);
  }
  // El carrito aparece sólo cuando tiene contenido.
  assert.match(nav, /id="bnav-carrito"[^>]*hidden/, 'El carrito debe empezar oculto');
  const app = await read('js/app.js');
  assert.match(app, /cartItem\.hidden = cartCount === 0/);
});

test('la información institucional vive en una ruta aparte', async () => {
  const app = await read('js/app.js');
  assert.match(app, /institucional: viewInstitutional/);
  const home = app.slice(app.indexOf('async function viewHome'), app.indexOf('async function viewBusinesses'));
  // En el inicio queda un acceso, no el bloque institucional entero.
  assert.match(home, /href="#institucional"/);
  // En el inicio hay un enlace; el desarrollo institucional vive en su ruta.
  for (const section of ['Días 1 a 30', 'Qué se mediría', 'Responsabilidades', 'Qué falta para un piloto real']) {
    assert.equal(home.includes(section), false,
      `El bloque institucional "${section}" no debe estar desplegado en el inicio`);
  }
  const institutional = app.slice(app.indexOf('async function viewInstitutional'));
  for (const section of ['Días 1 a 30', 'Qué se mediría', 'Responsabilidades', 'Qué falta para un piloto real']) {
    assert.ok(institutional.includes(section), `Falta "${section}" en la presentación institucional`);
  }
});

test('el alta de comercio es un circuito propio con revisión, no un enlace externo', async () => {
  const app = await read('js/app.js');
  // WhatsApp existe como canal de contacto del comercio con sus clientes; el
  // alta del comercio, en cambio, nunca se deriva afuera de la plataforma.
  const signup = app.slice(app.indexOf('async function viewBusinessSignup'), app.indexOf('const PANEL_TABS'));
  assert.ok(signup.length > 200, 'No se encontró la vista de alta');
  assert.equal(/wa\.me|whatsapp/i.test(signup), false,
    'El alta no puede derivarse a WhatsApp: tiene que ocurrir dentro de la plataforma');
  for (const command of ['business.create', 'business.update', 'business.submit', 'admin.reviewBusiness']) {
    assert.ok(Object.hasOwn(COMMANDS, command), `Falta el comando ${command}`);
  }
  assert.match(app, /data-form="business-create"/);
  assert.match(app, /data-action="submit-business"/);
  assert.match(app, /data-form="review"/);
});

test('el catálogo se gestiona desde el panel del propio comercio', async () => {
  for (const command of ['product.create', 'product.update', 'rider.create']) {
    assert.ok(Object.hasOwn(COMMANDS, command), `Falta el comando ${command}`);
  }
  const app = await read('js/app.js');
  assert.match(app, /data-form="product-create"/);
  assert.match(app, /data-action="product-toggle"/);
  assert.match(app, /Dar de baja/);
});

test('el panel prioriza los pedidos que requieren atención', async () => {
  const app = await read('js/app.js');
  const panel = app.slice(app.indexOf('function merchantOrdersTab'), app.indexOf('function merchantCatalogTab'));
  assert.match(panel, /Requieren atención/);
  // Las acciones operativas, no gráficos.
  for (const label of ['Aceptar', 'Rechazar', 'Informar preparación', 'Asignar reparto', 'Marcar salida']) {
    assert.ok(panel.includes(label), `Falta la acción "${label}" en el panel`);
  }
  assert.equal(/gráfico|chart|canvas/i.test(panel), false, 'El panel no debe llenarse de gráficos');
});

test('los paneles internos exigen sesión y rol, no un parámetro de URL', async () => {
  const app = await read('js/app.js');
  // Nada de habilitar administración por querystring.
  assert.equal(/searchParams|URLSearchParams|[?&]admin=/.test(app), false,
    'No puede haber acceso administrativo por parámetro de URL');
  assert.match(app, /async function viewAdmin\(\) \{\s*if \(!hasRole\('admin'\)\)/,
    'Administración debe verificar el rol antes de mostrar nada');
  assert.match(app, /async function viewMerchantPanel[\s\S]{0,200}if \(!isSignedIn\(\)\)/,
    'El panel del comercio debe exigir sesión');
  // Y el servidor lo verifica de nuevo, no confía en la interfaz.
  assert.ok(Object.hasOwn(QUERIES, 'adminQueue'));
});

test('el taxi es un servicio con alta, revisión y despacho, no un botón inerte', async () => {
  const app = await read('js/app.js');
  for (const command of ['driver.apply', 'driver.setAvailability', 'trip.request', 'trip.accept', 'trip.advance', 'trip.cancel']) {
    assert.ok(Object.hasOwn(COMMANDS, command), `Falta el comando ${command}`);
  }
  assert.match(app, /data-form="taxi-request"/);
  assert.match(app, /data-action="trip-accept"/);
  // La dirección manual alcanza: el GPS es opcional y se pide sólo al tocarlo.
  assert.match(app, /data-action="use-location"/);
  assert.match(app, /La ubicación del teléfono es opcional/i);
  assert.match(app, /Podés escribir la dirección a mano/i);
});

test('no se muestran calificaciones inventadas de los comercios', async () => {
  const app = await read('js/app.js');
  assert.equal(/ratingDemo|★|⭐/.test(app), false,
    'No deben mostrarse calificaciones: no hay reseñas reales que las respalden');
});
