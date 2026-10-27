// Build de CAUCE conectado a Supabase: el artefacto que se publica en producción.
//
//   npm run build:production   → proyecto CAUCE real (supabase/project.json) en dist-production/
//   npm run build:local        → stack local (`npx supabase start`) en .local/preview/
//
// También acepta CAUCE_SUPABASE_URL, CAUCE_SUPABASE_PUBLISHABLE_KEY, CAUCE_OUT_DIR,
// CAUCE_SITE_URL y CAUCE_RELEASE. Falla si falta algo, si la clave no es pública
// o si en el bundle aparece una credencial o código de la demostración.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_SCHEMA } from '../js/core/contract.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = process.argv.includes('--local');
const fail = message => { console.error(`BUILD FAIL · ${message}`); process.exit(1); };

function localStack() {
  // Node ≥24 en Windows se niega a lanzar .cmd sin shell (`EINVAL`): se intenta
  // el ejecutable real `supabase` y, como respaldo, npx con shell.
  for (const [command, options] of [['supabase', {}], ['npx', { shell: true }]]) {
    try {
      const args = [...command === 'npx' ? ['supabase'] : [], 'status', '-o', 'json'];
      const raw = execFileSync(process.platform === 'win32' && command === 'npx' ? 'npx.cmd' : command,
        args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options });
      const status = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      return { url: status.API_URL, publishableKey: status.PUBLISHABLE_KEY };
    } catch { /* se prueba el próximo lanzador */ }
  }
  return fail('No hay stack Supabase local. Ejecutá `npm run db:start`.');
}

const project = JSON.parse(await readFile(resolve(root, 'supabase/project.json'), 'utf8'));
const target = local ? localStack() : { url: project.url, publishableKey: project.publishableKey };
const supabaseUrl = (process.env.CAUCE_SUPABASE_URL || target.url || '').replace(/\/+$/, '');
const publishableKey = process.env.CAUCE_SUPABASE_PUBLISHABLE_KEY || target.publishableKey || '';
const output = resolve(root, process.env.CAUCE_OUT_DIR || (local ? '.local/preview' : 'dist-production'));

// ── validación de la configuración ──
let parsedUrl;
try { parsedUrl = new URL(supabaseUrl); } catch { fail('CAUCE_SUPABASE_URL falta o no es una URL.'); }
const isLocalHost = ['127.0.0.1', 'localhost'].includes(parsedUrl.hostname);
if (parsedUrl.protocol !== 'https:' && !isLocalHost) fail('La URL de Supabase debe ser https.');
if (!local && !isLocalHost && !/^[a-z0-9]{20}\.supabase\.co$/.test(parsedUrl.hostname)) {
  fail(`Host de Supabase inesperado: ${parsedUrl.hostname}.`);
}
function keyRole(key) {
  if (key.startsWith('sb_publishable_')) return 'publishable';
  if (key.startsWith('sb_secret_')) return 'secret';
  const parts = key.split('.');
  if (parts.length === 3) {
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || 'unknown'; }
    catch { return 'unknown'; }
  }
  return 'unknown';
}
const role = keyRole(publishableKey);
if (!['publishable', 'anon'].includes(role)) {
  fail(role === 'unknown' ? 'Falta la publishable key de Supabase.'
    : `La clave es de tipo "${role}": en el navegador sólo va la publishable key.`);
}
const relOut = relative(root, output);
if (!relOut || relOut.startsWith('..') || relOut.split(sep)[0] === '' || ['js', 'styles', 'assets', 'supabase'].includes(relOut)) {
  fail(`Carpeta de salida no permitida: ${output}`);
}
let release = process.env.CAUCE_RELEASE || '';
if (!release) {
  try { release = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { release = 'sin-git'; }
}
const siteUrl = (process.env.CAUCE_SITE_URL || (local ? 'http://127.0.0.1:4174' : 'https://bitflowapp.github.io/cauce'))
  .replace(/\/+$/, '');

// ── salida limpia ──
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'js'), { recursive: true });
await mkdir(resolve(output, 'styles'), { recursive: true });

// Sólo recursos de la aplicación: las fotos de productos y comercios de la
// demostración no se publican en producción.
const ASSET_DIRS = ['assets/images/territory', 'assets/brand'];
for (const dir of ASSET_DIRS) {
  try { await cp(resolve(root, dir), resolve(output, dir), { recursive: true }); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
for (const file of ['assets/images/icon-192.png', 'assets/images/icon-512.png', 'assets/images/icon-maskable-512.png',
  'styles/favicon.svg']) {
  await cp(resolve(root, file), resolve(output, file));
}

const hash = content => createHash('sha256').update(content).digest('hex').slice(0, 10);

// ── CSS con nombre por contenido ──
const css = `${await readFile(resolve(root, 'styles/cauce.css'), 'utf8')}\n${await readFile(resolve(root, 'styles/mifav.css'), 'utf8')}`;
const cssName = `styles/mifav.${hash(css)}.css`;
await writeFile(resolve(output, cssName), css);

// ── JavaScript ──
const runtimeModule = `
  import { createClient } from '@supabase/supabase-js';
  const base = location.href.split('#')[0].split('?')[0];
  export const RUNTIME_ENV = Object.freeze({
    environment: 'supabase', label: 'MiFav', release: ${JSON.stringify(release)},
    description: 'Marketplace de Neuquén Capital: productos de comercios y emprendimientos locales.',
    sharedPersistence: true, passwordAuth: true,
    supabaseUrl: ${JSON.stringify(supabaseUrl)}, siteUrl: ${JSON.stringify(siteUrl)},
    redirectTo: new URL('index.html', base).href,
    client: createClient(${JSON.stringify(supabaseUrl)}, ${JSON.stringify(publishableKey)}, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true,
        detectSessionInUrl: false, storageKey: 'cauce:production:auth' },
      global: { headers: { 'x-cauce-release': ${JSON.stringify(release)} } },
    }),
  });`;
const result = await build({
  absWorkingDir: root, entryPoints: ['js/app.js'], outdir: resolve(output, 'js'), entryNames: 'app.[hash]',
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022', 'safari15'], minify: true,
  sourcemap: false, legalComments: 'none', metafile: true, write: true,
  define: { 'globalThis.CAUCE_PRODUCTION': 'true' },
  plugins: [{ name: 'cauce-production', setup(builder) {
    builder.onLoad({ filter: /[\\/]js[\\/]runtime-env\.js$/ }, () => ({ loader: 'js', resolveDir: root, contents: runtimeModule }));
    builder.onLoad({ filter: /[\\/]js[\\/]config\.js$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      const contents = source.replace(/^(\s*)mode: 'demo'/m, "$1mode: 'production'")
        .replace(/^(\s*)liveOrders: false/m, '$1liveOrders: true');
      if (contents === source) fail('No se pudo fijar el modo producción en js/config.js.');
      return { loader: 'js', contents };
    });
    // Las ilustraciones de platos son de la demostración: en producción un
    // producto sin foto lleva la marca neutra con sus iniciales.
    builder.onLoad({ filter: /[\\/]js[\\/]data[\\/]food-assets\.js$/ }, () => ({ loader: 'js',
      contents: "export function getProductSvg() { return ''; }" }));
    // La fábrica de producción no importa la demostración ni el backend de desarrollo.
    builder.onResolve({ filter: /repository-factory\.js$/ }, () => ({
      path: resolve(root, 'js/repositories/production-factory.js') }));
  } }],
});
const jsFile = Object.keys(result.metafile.outputs).find(file => file.endsWith('.js'));
const jsName = `js/${jsFile.split('/').pop()}`;
const bundle = await readFile(resolve(output, jsName), 'utf8');

// ── controles sobre el bundle ──
if (/sb_secret_[A-Za-z0-9_-]+/.test(bundle)) fail('Hay una secret key en el bundle.');
for (const token of bundle.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || []) {
  if (keyRole(token) !== 'anon') fail('Hay un JWT que no es de rol anon en el bundle.');
}
const inputs = Object.keys(result.metafile.inputs);
const leaked = inputs.filter(file => /js\/(data\/demo|domain\/|repositories\/(local|http)-repository)/.test(file));
if (leaked.length) fail(`Código de la demostración en el bundle: ${leaked.join(', ')}`);
// El marketplace multirrubro sumó vidriera, ficha de producto, favoritos y
// publicación: ~36 KB minificados sobre el presupuesto anterior de 520 KB.
// El nuevo tope es explícito y sigue exigiendo dividir el bundle si se supera.
const BUDGET = 600 * 1024;
if (bundle.length > BUDGET) fail(`El bundle pesa ${Math.round(bundle.length / 1024)} KB (tope ${BUDGET / 1024} KB).`);

// ── documento ──
const connect = `'self' ${supabaseUrl} ${supabaseUrl.replace(/^http/, 'ws')}`;
const csp = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", `img-src 'self' data: blob: ${supabaseUrl}`,
  "font-src 'self'", `connect-src ${connect}`, "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'",
  "form-action 'none'", "object-src 'none'",
].join('; ');
let html = await readFile(resolve(root, 'index.html'), 'utf8');
const replace = (pattern, value, label) => {
  const next = html.replace(pattern, value);
  if (next === html) fail(`index.html: no se encontró ${label}.`);
  html = next;
};
replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`, 'la CSP');
replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="MiFav · marketplace de Neuquén Capital: productos nuevos y usados de comercios y emprendimientos locales, con retiro o envío coordinado con el vendedor.">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${siteUrl}/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="MiFav · Neuquén Capital">
  <meta property="og:title" content="MiFav — marketplace de Neuquén Capital">
  <meta property="og:description" content="Encontrá productos nuevos y usados de emprendimientos y comercios de Neuquén Capital. Retiro o envío coordinado con el vendedor.">
  <meta property="og:url" content="${siteUrl}/">
  <meta property="og:image" content="${siteUrl}/assets/images/icon-512.png">
  <meta property="og:locale" content="es_AR">
  <meta name="twitter:card" content="summary_large_image">`, 'la descripción');
replace('href="styles/cauce.css"', `href="${cssName}"`, 'la hoja de estilos');
replace(/\s*<link rel="stylesheet" href="styles\/mifav\.css">/, '', 'la hoja de estilos de MiFav');
replace(/\s*<link rel="modulepreload"[^>]*>/g, '', 'los modulepreload de la demo');
replace('<script type="module" src="js/app.js"></script>', `<script type="module" src="${jsName}"></script>`, 'el script');
replace(/(<span class="env-chip" id="env-chip")[^>]*>[^<]*<\/span>/, '$1 hidden></span>', 'el indicador de entorno');
replace('<main id="main" tabindex="-1" aria-busy="false">', '<main id="main" tabindex="-1" aria-busy="true">', 'el estado inicial del contenido');
replace(/<p class="footer-note" id="footer-env">[^<]*<\/p>/,
  '<p class="footer-note" id="footer-env">MiFav · plataforma local de LUNA para comercios y emprendimientos de Neuquén Capital.</p>', 'la nota del pie');
replace(/\s*<a class="link-button" href="#taxista">[^<]*<\/a>/, '', 'el enlace de taxistas del pie');
replace('<span class="footer-sub">Comprá cerca. Comprá en Neuquén.</span>', '<span class="footer-sub">Comprá cerca. Comprá en Neuquén Capital.</span>', 'el lema del pie');
await writeFile(resolve(output, 'index.html'), html);

// ── manifest, robots, 404 ──
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.webmanifest'), 'utf8'));
manifest.name = 'MiFav · Neuquén Capital';
manifest.short_name = 'MiFav';
manifest.description = 'Marketplace de Neuquén Capital: productos nuevos y usados de comercios y emprendimientos locales.';
manifest.categories = ['shopping', 'lifestyle'];
manifest.shortcuts = [
  { name: 'Explorar productos', url: './index.html#comercios' },
  { name: 'Publicar un producto', url: './index.html#publicar' },
  { name: 'Mis favoritos', url: './index.html#favoritos' },
];
await writeFile(resolve(output, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(output, 'robots.txt'), `User-agent: *\nAllow: /\n`);
await writeFile(resolve(output, '.nojekyll'), '');
// GitHub Pages sirve 404.html para cualquier ruta: las URLs van absolutas.
const basePath = new URL(siteUrl).pathname.replace(/\/?$/, '/');
await writeFile(resolve(output, '404.html'), `<!doctype html>
<html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>MiFav · página no encontrada</title>
<link rel="stylesheet" href="${basePath}${cssName}"></head>
<body><main class="main" style="padding:48px 16px;max-width:560px;margin:0 auto">
<h1 class="page-title">No encontramos esa página</h1>
<p class="quiet">El enlace puede estar incompleto o haber cambiado.</p>
<p><a class="button" href="${siteUrl}/index.html#inicio">Ir a MiFav</a></p></main></body></html>
`);

// ── service worker con versión por contenido ──
const shellFiles = ['./', './index.html', './manifest.webmanifest', `./${cssName}`, `./${jsName}`, './styles/favicon.svg',
  './assets/images/icon-192.png', './assets/images/territory/alumine-hero-panoramica.webp'];
const cacheName = `cauce-${hash(bundle + css + html)}`;
let worker = await readFile(resolve(root, 'service-worker.js'), 'utf8');
const workerBefore = worker;
worker = worker.replace(/const CACHE = '[^']+';/, `const CACHE = '${cacheName}';`)
  .replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = ${JSON.stringify(shellFiles, null, 2)};`);
if (worker === workerBefore || !worker.includes(cacheName) || !worker.includes(jsName)) fail('No se pudo versionar el service worker.');
await writeFile(resolve(output, 'service-worker.js'), worker);

// ── verificación final: todo lo referenciado existe ──
for (const file of shellFiles.filter(file => file !== './')) {
  try { await stat(resolve(output, file)); } catch { fail(`Falta ${file} en la salida.`); }
}
async function size(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    total += entry.isDirectory() ? await size(path) : (await stat(path)).size;
  }
  return total;
}
console.log(`BUILD PRODUCTION PASS · ${local ? 'stack local' : parsedUrl.hostname} · release ${release}`
  + ` · esquema ${REQUIRED_SCHEMA} · JS ${Math.round(bundle.length / 1024)} KB · total ${Math.round(await size(output) / 1024)} KB`
  + ` · ${relOut}`);
