// Unitarias del núcleo de la interfaz: escape de HTML, dinero, fechas,
// carrito, estados de pedido (contra la tabla SQL), validaciones, enlaces,
// almacenamiento del dispositivo, QR y traducción de errores del servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { html, raw, escape, attr } from '../../js/core/html.js';
import { formatARS, parseARS } from '../../js/core/money.js';
import { dateBadge, timeRange, toLocalInput, fromLocalInput, monthRange } from '../../js/core/dates.js';
import { addToCart, setQuantity, removeFromCart, quoteCart, cartCount, emptyCart } from '../../js/core/cart.js';
import { merchantActions, timelineSteps, buyerCanCancel } from '../../js/core/order-status.js';
import { normalizeWhatsapp, normalizeInstagram, slugify, passwordProblem, isPhone, isEmail } from '../../js/core/validators.js';
import { directionsUrl, mapUrl, whatsappUrl } from '../../js/core/links.js';
import { createStores } from '../../js/core/stores.js';
import { qrSvg } from '../../js/core/qr.js';
import { toAppError, SERVER_MESSAGES, CODE_MESSAGES } from '../../js/repo/messages.js';
import { planFeatures, stateInfo } from '../../js/core/plans.js';

const migrations = async () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  return (await Promise.all(files.map(f => readFile(new URL(f, dir), 'utf8')))).join('\n');
};

test('html escapa todo lo interpolado salvo raw()', () => {
  const evil = '<img src=x onerror="alert(1)">';
  assert.equal(String(html`<p>${evil}</p>`), '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
  assert.equal(String(html`<p>${raw('<b>ok</b>')}</p>`), '<p><b>ok</b></p>');
  assert.equal(String(html`<ul>${['<a>', 'b'].map(x => html`<li>${x}</li>`)}</ul>`), '<ul><li>&lt;a&gt;</li><li>b</li></ul>');
  assert.equal(String(html`${null}${undefined}${false}${0}`), '0');
  assert.equal(escape("`'"), '&#96;&#39;');
  assert.equal(String(attr('data-x', 'a"b')), ' data-x="a&quot;b"');
  assert.equal(String(attr('disabled', true)), ' disabled');
  assert.equal(String(attr('disabled', false)), '');
});

test('dinero en pesos enteros', () => {
  assert.equal(formatARS(12500), '$ 12.500');
  assert.equal(formatARS(0), '$ 0');
  assert.equal(parseARS('12.500'), 12500);
  assert.equal(parseARS('$ 9900'), 9900);
  assert.equal(parseARS(''), null);
});

test('fechas en la hora de Neuquén', () => {
  const start = '2026-04-12T13:00:00.000Z';
  assert.deepEqual(dateBadge(start), { day: 'DOM', num: '12', month: 'ABR' });
  assert.equal(timeRange(start, '2026-04-12T22:00:00.000Z'), '10:00 a 19:00');
  assert.equal(toLocalInput(start), '2026-04-12T10:00');
  assert.equal(fromLocalInput('2026-04-12T10:00'), start);
  assert.equal(fromLocalInput('mañana'), null);
  assert.deepEqual(monthRange(new Date('2026-02-10T15:00:00Z')), { from: '2026-02-01', to: '2026-02-28' });
});

test('carrito de una tienda: suma, topes y cotización con problemas marcados', () => {
  let cart = emptyCart('b1');
  ({ cart } = addToCart(cart, 'p1', null, 2, 3));
  const second = addToCart(cart, 'p1', null, 5, 3);
  assert.equal(second.added, 1, 'no supera el stock disponible');
  cart = second.cart;
  ({ cart } = addToCart(cart, 'p2', 'v1', 1));
  assert.equal(cartCount(cart), 4);
  cart = setQuantity(cart, 'p2', 'v1', 2);
  const products = [
    { id: 'p1', name: 'Taza', price: 12500, available: true, trackStock: true, stock: 2, variants: [] },
    { id: 'p2', name: 'Aros', price: 9500, available: true, trackStock: true, stock: 3, variants: [{ id: 'v1', name: 'Grandes', priceDelta: 1500, stock: 3 }] },
  ];
  const quote = quoteCart(cart, products);
  assert.equal(quote.lines[0].issue, 'short', 'quedan 2 y hay 3 en el carrito');
  assert.equal(quote.lines[1].unitPrice, 11000);
  assert.equal(quote.ready, false);
  const fixed = quoteCart(setQuantity(cart, 'p1', null, 2), products);
  assert.equal(fixed.ready, true);
  assert.equal(fixed.subtotal, 2 * 12500 + 2 * 11000);
  assert.equal(quoteCart(removeFromCart(cart, 'p1', null), [products[1]]).lines.length, 1);
  assert.equal(quoteCart({ businessId: 'b1', lines: [{ productId: 'p2', variantId: null, quantity: 1 }] }, products).lines[0].issue, 'variant');
});

test('las acciones del comercio coinciden con private.order_transitions', async () => {
  const sql = await migrations();
  const block = sql.slice(sql.indexOf('insert into private.order_transitions'), sql.indexOf(';', sql.indexOf('insert into private.order_transitions')));
  const rows = [...block.matchAll(/\('(\w+)', '(\w+)', '(\w+)', '(\w+)'\)/g)].map(m => ({ from: m[1], to: m[2], role: m[3], fulfillment: m[4] }));
  assert.ok(rows.length >= 30);
  for (const fulfillment of ['fair_pickup', 'pickup', 'delivery']) {
    for (const status of ['submitted', 'accepted', 'preparing', 'ready', 'on_the_way', 'delivered', 'canceled']) {
      const fromJs = merchantActions({ status, fulfillment }).map(a => a.next).sort();
      const fromSql = rows.filter(r => r.from === status && r.role === 'merchant' && r.fulfillment === fulfillment).map(r => r.to).sort();
      assert.deepEqual(fromJs, fromSql, `${fulfillment} / ${status}`);
    }
    assert.ok(timelineSteps(fulfillment).every(step => step === 'submitted' || rows.some(r => r.to === step && r.fulfillment === fulfillment)));
  }
  assert.equal(buyerCanCancel({ status: 'submitted' }), true);
  assert.equal(buyerCanCancel({ status: 'accepted' }), false);
  assert.ok(rows.filter(r => r.role === 'customer').every(r => r.from === 'submitted' && r.to === 'canceled'));
});

test('todo error que lanza la base tiene un mensaje en castellano', async () => {
  const sql = await migrations();
  const raisedWithCode = [...sql.matchAll(/raise exception '([^'%]+)'(?: using errcode = '(\w+)')?/g)].map(m => ({ message: m[1], code: m[2] }));
  const raised = new Set(raisedWithCode.map(r => r.message));
  // Los códigos propios (U0001…) se traducen por código; el resto, por mensaje.
  const missing = raisedWithCode.filter(r => !SERVER_MESSAGES[r.message] && !(r.code?.startsWith('U') && CODE_MESSAGES[r.code])).map(r => r.message);
  assert.deepEqual(missing, []);
  const unused = Object.keys(SERVER_MESSAGES).filter(message => !raised.has(message));
  assert.deepEqual(unused, [], 'no quedan traducciones de errores que la base ya no lanza');
});

test('los errores llegan traducidos y sin detalles técnicos en pantalla', () => {
  const stock = toAppError({ code: 'U0003', message: 'Not enough stock' });
  assert.equal(stock.message, SERVER_MESSAGES['Not enough stock'] || 'No queda stock suficiente de un producto. Revisá tu carrito.');
  const prices = toAppError({ code: 'U0005', message: 'Prices changed', details: '25000' });
  assert.equal(prices.code, 'PRICES_CHANGED');
  assert.equal(/** @type {any} */ (prices).newTotal, 25000);
  const network = toAppError({ message: 'Failed to fetch' });
  assert.equal(network.code, 'NETWORK_ERROR');
  const missing = toAppError({ code: '23514', message: 'Faltan datos: Rubro, Al menos un producto con foto' });
  assert.equal(missing.message, 'Faltan datos: Rubro, Al menos un producto con foto');
  const unknown = toAppError({ code: 'XX000', message: 'internal detail with table names' });
  assert.doesNotMatch(unknown.message, /table/);
  assert.equal(unknown.technical.message, 'internal detail with table names');
});

test('validaciones: WhatsApp argentino, Instagram, slug y contraseña', () => {
  assert.equal(normalizeWhatsapp('299 155 123456'), '5492995123456');
  assert.equal(normalizeWhatsapp('2942 15 412345'), '5492942412345');
  assert.equal(normalizeWhatsapp('0299 4123456'), '5492994123456');
  assert.equal(normalizeWhatsapp('2994123456'), '5492994123456');
  assert.equal(normalizeWhatsapp('+54 9 299 412-3456'), '5492994123456');
  assert.equal(normalizeWhatsapp('542994123456'), '5492994123456');
  assert.equal(normalizeWhatsapp('abc'), '');
  assert.equal(normalizeInstagram('https://www.instagram.com/raices.de.barro/?hl=es'), 'raices.de.barro');
  assert.equal(normalizeInstagram('@tierra_viva'), 'tierra_viva');
  assert.equal(slugify('Cerámica Ñandú & Cía.'), 'ceramica-nandu-cia');
  assert.equal(passwordProblem('corta1'), 'La contraseña necesita al menos 10 caracteres.');
  assert.equal(passwordProblem('soloLetrasLargas'), 'Usá letras y números en la contraseña.');
  assert.equal(passwordProblem('Patagonia2026'), '');
  assert.equal(isPhone('299 4112233'), true);
  assert.equal(isPhone('llamame'), false);
  assert.equal(isEmail('ana@correo.com.ar'), true);
  assert.equal(isEmail('ana@'), false);
});

test('enlaces externos: cómo llegar, mapa y WhatsApp', () => {
  assert.equal(directionsUrl({ latitude: -38.95, longitude: -68.06 }), 'https://www.google.com/maps/dir/?api=1&destination=-38.95%2C-68.06');
  assert.match(directionsUrl({ venue: 'Parque Central', locality: 'Neuquén' }), /destination=Parque%20Central%2C%20Neuqu%C3%A9n%2C%20Argentina$/);
  assert.equal(mapUrl({ latitude: -38.95, longitude: -68.06 }), 'https://www.openstreetmap.org/?mlat=-38.95&mlon=-68.06#map=17/-38.95/-68.06');
  assert.equal(whatsappUrl('+54 9 299 4123456', 'Hola & chau'), 'https://wa.me/5492994123456?text=Hola%20%26%20chau');
  assert.equal(whatsappUrl('', 'x'), '');
});

function memoryStorage() {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k),
    get length() { return map.size; }, key: i => [...map.keys()][i], _map: map };
}
test('dispositivo: carritos por identidad, adopción al ingresar, favoritos y localidad', () => {
  const storage = memoryStorage();
  Object.defineProperty(storage, Symbol.iterator, { value: undefined });
  const keysOf = () => [...storage._map.keys()];
  const stores = createStores(new Proxy(storage, { ownKeys: () => keysOf(), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }));
  stores.writeCart({ businessId: 'b1', lines: [{ productId: 'p1', variantId: null, quantity: 2 }] });
  assert.equal(stores.cartCount(), 2);
  stores.setOwner('user-1');
  assert.equal(stores.cartCount(), 2, 'el carrito del dispositivo pasa a la cuenta');
  stores.setOwner(null);
  assert.equal(stores.cartCount(), 0, 'sin sesión no se ve el carrito de la cuenta');
  stores.setOwner('user-1');
  assert.equal(stores.readCart('b1').lines[0].quantity, 2);
  storage.setItem(`ferias:cart:v1:user-1:b2`, '{"lines":[{"productId":"x","quantity":-4}]}');
  assert.equal(stores.readCart('b2').lines.length, 0, 'datos corruptos se descartan');
  assert.equal(stores.toggleFavorite('p9'), true);
  assert.equal(stores.favorites().has('p9'), true);
  assert.equal(stores.toggleFavorite('p9'), false);
  assert.equal(stores.locality(), 'neuquen');
  stores.setLocality('');
  assert.equal(stores.locality(), '');
  stores.setLocality('plottier');
  assert.equal(stores.locality(), 'plottier');
});

test('QR en SVG, sin servicios externos', () => {
  const svg = qrSvg('http://127.0.0.1:4274/index.html#/tienda/raices-de-barro', { label: 'QR "de" prueba' });
  assert.match(svg, /^<svg viewBox="-2 -2 \d+ \d+"/);
  assert.match(svg, /aria-label="QR de prueba"/);
  assert.ok((svg.match(/h1v1h-1z/g) || []).length > 100);
});

test('planes: textos de lo que incluye cada uno y estados', () => {
  const pro = { audience: 'business', max_products: 100, max_images_per_product: 8, staff_seats: 3, fair_pickup: true, advanced_stats: true, featured: true };
  const features = planFeatures(pro);
  assert.ok(features.some(f => f.includes('100 productos')));
  assert.ok(features.some(f => f.includes('Retiro en tu puesto')));
  assert.ok(features.includes('Tienda recomendada en el inicio'));
  assert.equal(stateInfo('grace').tone, 'warn');
  assert.equal(stateInfo('cualquiera').label, 'Sin plan todavía');
});
