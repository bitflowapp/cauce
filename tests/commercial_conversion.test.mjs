import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAUCE_CONTACT_WHATSAPP,
  CONFIG,
  buildMerchantWhatsAppUrl,
} from '../js/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('configuración comercial exporta CAUCE_CONTACT_WHATSAPP y está ligada a CONFIG', () => {
  assert.equal(typeof CAUCE_CONTACT_WHATSAPP, 'string');
  assert.equal(CAUCE_CONTACT_WHATSAPP, '5492996209136');
  assert.equal(CONFIG.contactWhatsApp, CAUCE_CONTACT_WHATSAPP);
  const defaultUrl = buildMerchantWhatsAppUrl();
  assert.match(defaultUrl, /^https:\/\/wa\.me\/5492996209136\?text=/);
});

test('buildMerchantWhatsAppUrl genera URL válida con número configurado y mensaje precargado', () => {
  const url = buildMerchantWhatsAppUrl('5492942123456');
  assert.ok(url);
  assert.match(url, /^https:\/\/wa\.me\/5492942123456\?text=/);
  const expectedMsg = 'Hola, vi CAUCE · Aluminé y me interesa conocer cómo podría sumar mi comercio.';
  assert.ok(url.includes(encodeURIComponent(expectedMsg)));
});

test('buildMerchantWhatsAppUrl sanea formatos con símbolos y espacios', () => {
  const url = buildMerchantWhatsAppUrl('+54 9 2942-123456');
  assert.ok(url);
  assert.match(url, /^https:\/\/wa\.me\/5492942123456\?text=/);
});

test('buildMerchantWhatsAppUrl retorna null cuando el argumento no tiene número (evita CTAs rotos)', () => {
  assert.equal(buildMerchantWhatsAppUrl(''), null);
  assert.equal(buildMerchantWhatsAppUrl(null), null);
  assert.equal(buildMerchantWhatsAppUrl('123'), null); // Demasiado corto para ser un teléfono internacional válido
});

test('CTA comercial "Sumar mi comercio" existe en las ubicaciones estratégicas del DOM/código', async () => {
  const indexHtml = await readFile(resolve(root, 'index.html'), 'utf8');
  const appJs = await readFile(resolve(root, 'js/app.js'), 'utf8');

  // 1. Header desktop
  assert.ok(
    indexHtml.includes('Sumar mi comercio') && indexHtml.includes('nav-merchant-cta') && indexHtml.includes('https://wa.me/5492996209136'),
    'Falta CTA comercial en el header de navegación o no apunta a WhatsApp'
  );

  // 2. Hero
  assert.ok(
    appJs.includes('Sumar mi comercio →'),
    'Falta CTA comercial en el hero editorial'
  );

  // 3. Post-catálogo
  assert.ok(
    appJs.includes('catalog-merchant-card') && appJs.includes('Sumar mi comercio'),
    'Falta card de conversión post-catálogo de comercios'
  );

  // 4. Sección Para comercios
  assert.ok(
    appJs.includes('Tu comercio, también en CAUCE'),
    'Falta título sobrio de la sección comercial'
  );

  // 5. Cierre comercial
  assert.ok(
    appJs.includes('commercial-closing-section') && appJs.includes('¿Tenés un comercio en Aluminé?'),
    'Falta sección de cierre comercial al final de la home'
  );

  // 6. CTA secundario Probar CAUCE
  assert.ok(
    appJs.includes('Probar CAUCE'),
    'Falta CTA secundario "Probar CAUCE" en el cierre comercial'
  );
});

test('manejador de acción comercial previene links rotos derivando a modal si no hay WhatsApp', async () => {
  const appJs = await readFile(resolve(root, 'js/app.js'), 'utf8');
  assert.ok(
    appJs.includes("action === 'commercial-contact'"),
    'Falta manejador explícito para commercial-contact'
  );
  assert.ok(
    appJs.includes('openJoinModal();'),
    'El manejador debe invocar openJoinModal cuando WhatsApp no está configurado'
  );
});

test('sección de credibilidad funcional muestra capacidades reales sin afirmaciones infladas', async () => {
  const appJs = await readFile(resolve(root, 'js/app.js'), 'utf8');

  // Sección de prueba técnica
  assert.ok(
    appJs.includes('reality-proof-section') && appJs.includes('CIRCUITO FUNCIONAL PROBADO'),
    'Falta sección de prueba de producto funcional ("CIRCUITO FUNCIONAL PROBADO")'
  );

  // 4 capacidades reales del circuito
  assert.ok(appJs.includes('Pedido ágil directo al comercio'), 'Falta capacidad 1: pedido directo');
  assert.ok(appJs.includes('Comanda y panel de control'), 'Falta capacidad 2: panel/cocina');
  assert.ok(appJs.includes('Trazabilidad de estados en vivo'), 'Falta capacidad 3: seguimiento');
  assert.ok(appJs.includes('Delivery propio con código seguro'), 'Falta capacidad 4: delivery propio');

  // Ausencia de "sin intermediarios" en favor de formulación más precisa
  assert.equal(
    appJs.includes('sin intermediarios'),
    false,
    'No debe existir la expresión "sin intermediarios"; usar "directo al comercio"'
  );
});

test('ausencia estricta de jerga publicitaria genérica e IA en el nuevo copy comercial', async () => {
  const appJs = await readFile(resolve(root, 'js/app.js'), 'utf8');
  const forbiddenAI = [
    'Revolucioná tu negocio',
    'Llevá tu negocio al siguiente nivel',
    'Potenciá tus ventas con tecnología',
    'revoluciona tu negocio',
    'siguiente nivel',
    'potencia tus ventas',
  ];

  for (const phrase of forbiddenAI) {
    assert.equal(
      appJs.toLowerCase().includes(phrase.toLowerCase()),
      false,
      `Frase publicitaria artificial detectada: "${phrase}"`
    );
  }
});

test('navegación y componentes transaccionales permanecen completamente intactos', async () => {
  const indexHtml = await readFile(resolve(root, 'index.html'), 'utf8');
  const appJs = await readFile(resolve(root, 'js/app.js'), 'utf8');

  // Nav transaccional
  assert.ok(indexHtml.includes('href="#home"'), 'Ruta home intacta');
  assert.ok(indexHtml.includes('href="#presentacion"'), 'Ruta presentación intacta');
  assert.ok(indexHtml.includes('href="#orders"'), 'Ruta órdenes intacta');
  assert.ok(indexHtml.includes('href="#carts"'), 'Ruta carritos intacta');

  // Bottom nav
  assert.ok(indexHtml.includes('id="bnav-home"'), 'Bottom nav home intacta');
  assert.ok(indexHtml.includes('id="bnav-search"'), 'Bottom nav search intacta');
  assert.ok(indexHtml.includes('id="bnav-orders"'), 'Bottom nav orders intacta');
  assert.ok(indexHtml.includes('id="bnav-carts"'), 'Bottom nav carts intacta');

  // Lógica de tienda y checkout
  assert.ok(appJs.includes('function shop(businessId)'), 'Función shop intacta');
  assert.ok(appJs.includes('function carts()'), 'Función carts intacta');
  assert.ok(appJs.includes('function cartPage(businessId)'), 'Función cartPage intacta');
  assert.ok(appJs.includes('function tracking(orderId)'), 'Función tracking intacta');
});
