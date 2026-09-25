// Credibilidad del texto de la aplicación.
//
// Lo que se protege acá no es un copy concreto, sino tres cosas: que no se
// afirme lo que no está demostrado, que el entorno se identifique siempre, y
// que antes de confirmar quede claro que nada de esto genera una operación real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Busca una frase sólo cuando se AFIRMA. "no hay convenio firmado" es lo
// contrario de afirmar que lo hay, y no debe contar como hallazgo.
const NEGATIONS = /(^|[^a-záéíóúñ])(no|sin|todav[íi]a no|ning[úu]n|ninguna)\s[^.]{0,40}$/i;

function affirmsPhrase(content, phrase) {
  let index = content.indexOf(phrase);
  while (index >= 0) {
    const before = content.slice(Math.max(0, index - 60), index);
    if (!NEGATIONS.test(before)) return true;
    index = content.indexOf(phrase, index + phrase.length);
  }
  return false;
}

async function appText() {
  // Todo el texto de la interfaz: el shell y cada módulo que arma pantallas.
  const ui = (await readdir(resolve(root, 'js/ui'))).filter(name => name.endsWith('.js')).map(name => `js/ui/${name}`);
  const files = ['js/app.js', 'index.html', 'js/domain/state.js', ...ui];
  const parts = await Promise.all(files.map(file => readFile(resolve(root, file), 'utf8')));
  return parts.join('\n');
}

test('no se afirma adhesión, aval ni respaldo municipal', async () => {
  const content = (await appText()).toLowerCase();
  const forbidden = [
    'alianza municipal',
    'plataforma municipal',
    'programa municipal',
    'junto al municipio',
    'avalado por el municipio',
    'respaldo municipal',
    'convenio firmado',
    'adhesión municipal',
    'en convenio con',
    'infraestructura pública',
    'homologado',
    'municipio adherido',
  ];
  for (const phrase of forbidden) {
    assert.equal(affirmsPhrase(content, phrase), false,
      `El texto afirma un respaldo que no existe: "${phrase}"`);
  }
});

test('no se publican cifras, comisiones ni resultados inventados', async () => {
  const content = (await appText()).toLowerCase();
  const forbidden = [
    '25% y 35%',
    '25% de comisión',
    '35% de comisión',
    '100% del valor',
    '100% de los ingresos',
    'comisiones extractivas',
    'comisiones abusivas',
    'comisiones confiscatorias',
    'confiscatorias',
    'predatorias',
    'elimina comisiones',
    'sin intermediarios',
    'soberanía de datos',
    'soberanía tecnológica',
    'servidores extranjeros',
    'queda íntegramente en la comunidad',
    'dinamiza el empleo',
    'fuga de valor local',
    '500+',
    'tarifas dinámicas',
    'satisfacción alto',
  ];
  for (const phrase of forbidden) {
    assert.equal(affirmsPhrase(content, phrase), false,
      `El texto incluye una afirmación no demostrable: "${phrase}"`);
  }
});

test('no se simulan prestadores, identidades ni tiempo real', async () => {
  const content = (await appText()).toLowerCase();
  const forbidden = [
    'chofer habilitado',
    'móviles habilitados',
    'transporte habilitado',
    'en tiempo real',
    'seguimiento gps',
    'comercios adheridos',
    'prestadores adheridos',
  ];
  for (const phrase of forbidden) {
    assert.equal(affirmsPhrase(content, phrase), false,
      `El texto simula algo que no existe en esta entrega: "${phrase}"`);
  }
});

test('el piloto se presenta como propuesta, no como acuerdo', async () => {
  const app = await readFile(resolve(root, 'js/app.js'), 'utf8');
  assert.match(app, /propuesta de piloto de 90 días/i, 'Falta la propuesta de piloto');
  assert.match(app, /no hay convenio firmado ni prestadores incorporados/i,
    'La presentación institucional debe aclarar que no hay convenio ni prestadores');
  assert.match(app, /el acompañamiento institucional es lo que se propone evaluar/i,
    'Debe quedar claro que el acompañamiento municipal es una propuesta');
});

test('la aprobación de CAUCE no se presenta como habilitación municipal', async () => {
  const app = await readFile(resolve(root, 'js/app.js'), 'utf8');
  const matches = app.match(/no (constituye|es) una habilitación municipal/gi) || [];
  assert.ok(matches.length >= 2,
    `La aclaración debe aparecer donde se solicita y donde se explica la publicación (apariciones: ${matches.length})`);
  assert.match(app, /habilitación, seguros|habilitación municipal del servicio/i,
    'El alta de taxista debe dejar pendientes habilitación, seguros y tarifas');
});

test('el entorno se identifica de forma persistente en el shell', async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  assert.match(html, /id="env-chip"/, 'Falta el indicador de entorno en la cabecera');
  assert.match(html, /Demostración</, 'El indicador debe decir qué entorno es');
  const app = await readFile(resolve(root, 'js/app.js'), 'utf8');
  assert.match(app, /envChip\.title = /, 'El indicador debe explicar el entorno al detalle');
});

test('antes de confirmar se aclara que no hay servicio ni cobro real', async () => {
  const app = await readFile(resolve(root, 'js/app.js'), 'utf8');
  assert.match(app, /no genera un servicio ni un cobro real/i);
  // El aviso se usa tanto al confirmar un pedido como al pedir un taxi.
  const uses = app.match(/\$\{confirmNotice\([^)]*\)\}/g) || [];
  assert.ok(uses.length >= 2, `El aviso previo debe aparecer en pedidos y en taxis (apariciones: ${uses.length})`);
});

test('los pagos en línea se declaran deshabilitados', async () => {
  const app = await readFile(resolve(root, 'js/app.js'), 'utf8');
  assert.match(app, /pagos en línea no están habilitados/i);
  assert.match(app, /pedido y el pago son estados independientes/i);
});

test('el pago online sólo se ofrece si la base lo habilita, y nunca se da por pagado desde la pantalla', async () => {
  const app = await readFile(resolve(root, 'js/app.js'), 'utf8');
  // La demostración nunca ofrece pago online; el entorno conectado, sólo con el interruptor.
  assert.match(app, /const paymentsOnline = \(\) => isConnected\(\) && app\.features\?\.payments_online === true;/);
  // Las formas de pago del checkout salen de la base (o sólo efectivo si no responde).
  assert.match(app, /checkoutPaymentMethods\(offered, fulfillment\)/);
  assert.match(app, /cashOnlyMethods\(fulfillment\)/);
  const ui = await readFile(resolve(root, 'js/ui/payments.js'), 'utf8');
  assert.doesNotMatch(ui, /['"]approved['"]\s*[:=]/, 'la interfaz no escribe estados de pago');
  assert.match(ui, /la pantalla no los inventa/i);
});

test('los datos de ejemplo se declaran ficticios', async () => {
  const app = await readFile(resolve(root, 'js/app.js'), 'utf8');
  assert.match(app, /ficticios/i, 'Debe aclararse que los comercios de ejemplo son ficticios');
  assert.match(app, /no representan negocios reales de Aluminé/i);
});

test('no quedan pendientes marcados en las rutas comprometidas', async () => {
  const files = [];
  const walk = async directory => {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(m?js)$/.test(entry.name)) files.push(path);
    }
  };
  await walk('js');
  for (const file of files) {
    const content = await readFile(resolve(root, file), 'utf8');
    // TODO y FIXME son convenciones en mayúsculas: buscarlas sin distinguir
    // mayúsculas confundiría el "todo" del castellano con un pendiente.
    assert.equal(/\bTODO\b|\bFIXME\b|\bXXX\b/.test(content), false,
      `Quedó un pendiente marcado en ${file}`);
    assert.equal(/pr[óo]ximamente/i.test(content), false,
      `Quedó una promesa de "próximamente" en ${file}`);
  }
});
