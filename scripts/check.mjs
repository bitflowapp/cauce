// Comprobaciones estáticas previas a las pruebas.
// Verifica sintaxis, imports, las piezas heredadas con hash, la compuerta de
// producción y que el entorno publicado siga aislado.
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CONFIG } from '../js/config.js';
import { RUNTIME_ENV } from '../js/runtime-env.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
const rel = path => relative(root, path).split(sep).join('/');

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

const sources = [
  ...(await walk(resolve(root, 'js'))),
  ...(await walk(resolve(root, 'scripts'))),
  ...(await walk(resolve(root, 'tests'))),
  resolve(root, 'service-worker.js'),
];
const scripts = sources.filter(path => /\.(m?js)$/.test(path));

for (const path of scripts) {
  try { execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' }); }
  catch { failures.push(`Sintaxis inválida: ${rel(path)}`); }
  const source = await readFile(path, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    try { await stat(resolve(dirname(path), match[1])); }
    catch { failures.push(`Import no resuelto: ${rel(path)} → ${match[1]}`); }
  }
}

// Piezas reutilizadas de La Taba: deben permanecer byte a byte idénticas.
const inherited = {
  'js/core/order-workflow.js': 'da853c6a66cdd293372a42f5a80081c3119afc7e',
  'tests/order-workflow.test.mjs': 'b2576b6bfb919d3d16be83011d853f565e084f85',
};
for (const [name, hash] of Object.entries(inherited)) {
  const bytes = await readFile(resolve(root, name));
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== hash) failures.push(`La copia heredada cambió: ${name}`);
}

// La compuerta de producción no se apaga para "hacer que funcione".
if (CONFIG.mode !== 'demo' || CONFIG.liveOrders !== false || CONFIG.livePayments !== false) {
  failures.push('Se intentó habilitar pedidos o pagos reales en la configuración.');
}

// El módulo de entorno versionado es el que se publica: debe seguir aislado.
if (RUNTIME_ENV.environment !== 'demo' || RUNTIME_ENV.apiBase !== null
  || RUNTIME_ENV.sharedPersistence !== false || RUNTIME_ENV.passwordAuth !== false) {
  failures.push('js/runtime-env.js versionado debe declarar el entorno de demostración aislado.');
}

const html = await readFile(resolve(root, 'index.html'), 'utf8');
if (!html.includes("connect-src 'none'")) failures.push('index.html debe bloquear conexiones salientes.');
if (/La Taba|la_taba|la-taba/i.test(html)) failures.push('Branding residual visible en index.html.');

// El acceso a red está permitido sólo donde corresponde: el repositorio HTTP
// (que habla con el backend local) y el service worker. En el resto del runtime
// del navegador, cualquier llamada de red es un error.
const NETWORK_ALLOWED = new Set(['js/repositories/http-repository.js']);
const NETWORK_PATTERN = /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(/;
const CREDENTIAL_PATTERN = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_]+|APP_USR-[0-9A-Za-z-]{20,}/;

for (const path of await walk(resolve(root, 'js'))) {
  const name = rel(path);
  const text = await readFile(path, 'utf8');
  if (CREDENTIAL_PATTERN.test(text)) failures.push(`Posible credencial embebida: ${name}`);
  if (NETWORK_ALLOWED.has(name)) continue;
  if (/https?:\/\//i.test(text.replace(/^\s*\/\/.*$/gm, ''))) failures.push(`URL de red en el runtime: ${name}`);
  if (NETWORK_PATTERN.test(text)) failures.push(`Operación de red inesperada: ${name}`);
}

// El service worker no debe encolar operaciones para enviarlas más tarde.
const worker = await readFile(resolve(root, 'service-worker.js'), 'utf8');
if (/SyncManager|backgroundFetch|sync\.register/i.test(worker)) {
  failures.push('El service worker no debe diferir operaciones: una confirmación en diferido simula un pedido recibido.');
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`CHECK PASS · ${scripts.length} archivos JS · imports · 2 hashes heredados · compuerta demo · entorno publicado aislado · red acotada`);
}
