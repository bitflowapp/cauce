// Build de CAUCE · Ferias conectado a Supabase.
//
//   npm run build:local  → stack Supabase local de Ferias (`npm run db:start`) en .local/preview/
//   npm run build        → proyecto remoto propio (variables FERIAS_*) en dist/
//
// Variables para el build remoto: FERIAS_SUPABASE_URL, FERIAS_SUPABASE_PUBLISHABLE_KEY,
// FERIAS_SITE_URL y, opcional, FERIAS_RELEASE / FERIAS_OUT_DIR / FERIAS_PERSONAJE /
// FERIAS_INDEXAR (sólo «si» deja que los buscadores indexen: las vistas previas no). Falla si falta algo,
// si la clave no es pública o si en el bundle aparece una credencial privilegiada.
// Nunca apunta al proyecto de CAUCE · Aluminé.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../js/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = process.argv.includes('--local');
const fail = message => { console.error(`BUILD FAIL · ${message}`); process.exit(1); };
// Proyecto de CAUCE · Aluminé: la derivación jamás se conecta a él.
const FORBIDDEN_PROJECTS = ['ygqbcvxdrewcnzedfcyo'];

function localStack() {
  try {
    const raw = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', 'status', '-o', 'json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const status = JSON.parse(raw.slice(raw.indexOf('{')));
    return { url: status.API_URL, key: status.PUBLISHABLE_KEY || status.ANON_KEY };
  } catch { return fail('No hay stack Supabase local de Ferias. Ejecutá `npm run db:start`.'); }
}

const target = local ? localStack() : { url: process.env.FERIAS_SUPABASE_URL, key: process.env.FERIAS_SUPABASE_PUBLISHABLE_KEY };
const supabaseUrl = String(target.url || '').replace(/\/+$/, '');
const publishableKey = String(target.key || '');
const output = resolve(root, process.env.FERIAS_OUT_DIR || (local ? '.local/preview' : 'dist'));
const siteUrl = String(process.env.FERIAS_SITE_URL || (local ? 'http://127.0.0.1:4274' : '')).replace(/\/+$/, '');

let parsed;
try { parsed = new URL(supabaseUrl); } catch { fail('Falta FERIAS_SUPABASE_URL o no es una URL.'); }
const isLocalHost = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
if (parsed.protocol !== 'https:' && !isLocalHost) fail('La URL de Supabase debe ser https.');
if (!local && !isLocalHost && !/^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname)) fail(`Host de Supabase inesperado: ${parsed.hostname}.`);
if (FORBIDDEN_PROJECTS.some(ref => parsed.hostname.startsWith(ref))) fail('Ese es el proyecto de CAUCE · Aluminé: Ferias usa un proyecto propio.');
if (!siteUrl) fail('Falta FERIAS_SITE_URL (la dirección pública del sitio).');

// Personaje: Sofía sólo en el stack local o con FERIAS_PERSONAJE=sofia explícito,
// que se usa recién con su autorización escrita (docs/PERSONAJE.md). Cualquier
// build remoto usa por defecto el personaje genérico.
const character = process.env.FERIAS_PERSONAJE || (local ? 'sofia' : 'generico');
if (!['sofia', 'generico'].includes(character)) fail('FERIAS_PERSONAJE debe ser "sofia" o "generico".');
const indexable = !local && process.env.FERIAS_INDEXAR === 'si';

function keyRole(key) {
  if (key.startsWith('sb_publishable_')) return 'publishable';
  if (key.startsWith('sb_secret_')) return 'secret';
  const parts = key.split('.');
  if (parts.length === 3) {
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || 'unknown'; } catch { return 'unknown'; }
  }
  return 'unknown';
}
const role = keyRole(publishableKey);
if (!['publishable', 'anon'].includes(role)) {
  fail(role === 'unknown' ? 'Falta la publishable key de Supabase.' : `La clave es de tipo "${role}": en el navegador sólo va la publishable key.`);
}
const relOut = relative(root, output);
if (!relOut || relOut.startsWith('..') || ['js', 'styles', 'assets', 'supabase', 'scripts', 'tests'].includes(relOut.split(sep)[0])) {
  fail(`Carpeta de salida no permitida: ${output}`);
}
let release = process.env.FERIAS_RELEASE || '';
if (!release) {
  try { release = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { release = 'sin-git'; }
}

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'js'), { recursive: true });
await mkdir(resolve(output, 'styles'), { recursive: true });
await mkdir(resolve(output, 'assets/fonts'), { recursive: true });

// Fuentes (SIL OFL 1.1) desde los paquetes de npm: sólo el subconjunto latino.
const FONTS = {
  'lilita-one-latin.woff2': '@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff2',
  'caveat-brush-latin.woff2': '@fontsource/caveat-brush/files/caveat-brush-latin-400-normal.woff2',
  'inter-latin-wght.woff2': '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
};
for (const [name, source] of Object.entries(FONTS)) await cp(resolve(root, 'node_modules', source), resolve(output, 'assets/fonts', name));
await cp(resolve(root, 'assets/brand'), resolve(output, 'assets/brand'), { recursive: true });
await writeFile(resolve(output, 'assets/fonts/LICENCIAS.txt'),
  'Lilita One, Caveat Brush e Inter: SIL Open Font License 1.1 (https://openfontlicense.org). Distribuidas vía Fontsource.\n');

const hash = content => createHash('sha256').update(content).digest('hex').slice(0, 10);
const css = await readFile(resolve(root, 'styles/ferias.css'), 'utf8');
const cssName = `styles/ferias.${hash(css)}.css`;
await writeFile(resolve(output, cssName), css);

const runtimeModule = `
  import { createClient } from '@supabase/supabase-js';
  const base = location.href.split('#')[0].split('?')[0];
  export const RUNTIME_ENV = Object.freeze({
    environment: ${JSON.stringify(local ? 'local' : 'remoto')}, release: ${JSON.stringify(release)},
    siteUrl: ${JSON.stringify(`${siteUrl}/index.html`)}, redirectTo: new URL('index.html', base).href,
    client: createClient(${JSON.stringify(supabaseUrl)}, ${JSON.stringify(publishableKey)}, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'ferias:auth' },
      global: { headers: { 'x-ferias-release': ${JSON.stringify(release)} } },
      realtime: { params: { eventsPerSecond: 5 } },
    }),
  });`;
const result = await build({
  absWorkingDir: root, entryPoints: ['js/app.js'], outdir: resolve(output, 'js'), entryNames: 'app.[hash]', chunkNames: 'parte.[hash]',
  splitting: true, bundle: true, format: 'esm', platform: 'browser', target: ['es2022', 'safari15'], minify: true, sourcemap: false,
  legalComments: 'none', metafile: true, write: true,
  plugins: [{ name: 'ferias-runtime', setup(builder) {
    builder.onLoad({ filter: /[\\/]js[\\/]runtime-env\.js$/ }, () => ({ loader: 'js', resolveDir: root, contents: runtimeModule }));
    if (character === 'generico') {
      builder.onLoad({ filter: /[\\/]js[\\/]ui[\\/]sofia\.js$/ }, async () => ({ loader: 'js', resolveDir: resolve(root, 'js/ui'),
        contents: await readFile(resolve(root, 'js/ui/personaje-generico.js'), 'utf8') }));
    }
  } }],
});
const outputs = Object.entries(result.metafile.outputs).filter(([file]) => file.endsWith('.js'));
const entry = outputs.find(([, meta]) => meta.entryPoint);
const jsName = `js/${entry[0].split('/').pop()}`;
const chunkNames = outputs.filter(([file]) => file !== entry[0]).map(([file]) => `js/${file.split('/').pop()}`);
const bundle = await readFile(resolve(output, jsName), 'utf8');
const chunks = await Promise.all(chunkNames.map(name => readFile(resolve(output, name), 'utf8')));
const allCode = [bundle, ...chunks].join('\n');

if (/sb_secret_[A-Za-z0-9_-]+/.test(allCode)) fail('Hay una secret key en el bundle.');
for (const token of allCode.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || []) {
  if (keyRole(token) !== 'anon') fail('Hay un JWT que no es de rol anon en el bundle.');
}
if (FORBIDDEN_PROJECTS.some(ref => allCode.includes(ref))) fail('El bundle menciona el proyecto de CAUCE · Aluminé.');
if (character === 'generico') {
  if (/Sof(í|\\xED|\\u00ED)a|s-hair-back|sofia-sticker/i.test(allCode)) fail('Build con personaje genérico: el bundle todavía contiene a Sofía.');
  await cp(resolve(root, 'assets/brand/og-generico.png'), resolve(output, 'assets/brand/og.png'));
}
// Presupuesto de lo que descarga quien compra (los paneles van aparte).
const BUDGET = 400 * 1024;
if (bundle.length > BUDGET) fail(`El bundle inicial pesa ${Math.round(bundle.length / 1024)} KB (tope ${BUDGET / 1024} KB).`);
if (allCode.length > 700 * 1024) fail(`El JS total pesa ${Math.round(allCode.length / 1024)} KB (tope 700 KB).`);

const connect = `'self' ${supabaseUrl} ${supabaseUrl.replace(/^http/, 'ws')}`;
const csp = ["default-src 'none'", "script-src 'self'", "style-src 'self'", `img-src 'self' data: blob: ${supabaseUrl}`,
  "font-src 'self'", `connect-src ${connect}`, "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'",
  "form-action 'none'", "object-src 'none'"].join('; ');
let page = await readFile(resolve(root, 'index.html'), 'utf8');
const replace = (pattern, value, label) => {
  const next = page.replace(pattern, value);
  if (next === page) fail(`index.html: no se encontró ${label}.`);
  page = next;
};
replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`, 'la CSP');
replace('href="styles/ferias.css"', `href="${cssName}"`, 'la hoja de estilos');
replace('<script type="module" src="js/app.js"></script>', `<script type="module" src="${jsName}"></script>`, 'el script');
replace(/<meta name="description" content="[^"]*">/, `$&
  <meta name="referrer" content="no-referrer">
  <link rel="canonical" href="${siteUrl}/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="CAUCE · Ferias Neuquén">
  <meta property="og:title" content="CAUCE · Ferias Neuquén — Hecho cerca tuyo">
  <meta property="og:description" content="Productos únicos de artesanos, feriantes y emprendedores de Neuquén, y las próximas ferias.">
  <meta property="og:url" content="${siteUrl}/">
  <meta property="og:image" content="${siteUrl}/assets/brand/og.png">
  <meta property="og:locale" content="es_AR">
  <meta name="robots" content="${indexable ? 'index, follow' : 'noindex'}">`, 'la descripción');
await writeFile(resolve(output, 'index.html'), page);

const manifest = JSON.parse(await readFile(resolve(root, 'manifest.webmanifest'), 'utf8'));
await writeFile(resolve(output, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(output, 'robots.txt'), indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n');
// Encabezados para Cloudflare Pages (otros hostings los ignoran). Lo que una
// meta CSP no puede expresar: no se embebe en marcos ajenos, HSTS, permisos.
await writeFile(resolve(output, '_headers'), `/*
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), payment=(), usb=(), geolocation=(self)
  Strict-Transport-Security: max-age=31536000
${indexable ? '' : '  X-Robots-Tag: noindex\n'}
/js/*
  Cache-Control: public, max-age=31536000, immutable
/styles/*
  Cache-Control: public, max-age=31536000, immutable
/assets/fonts/*
  Cache-Control: public, max-age=31536000, immutable
/service-worker.js
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
`);
await writeFile(resolve(output, '404.html'), `<!doctype html><html lang="es-AR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>CAUCE · Ferias — página no encontrada</title><link rel="stylesheet" href="${new URL(siteUrl).pathname.replace(/\/?$/, '/')}${cssName}"></head>
<body><main class="main"><div class="empty"><h1 class="empty-title">No encontramos esa página</h1>
<p class="empty-text">El enlace puede estar incompleto o haber cambiado.</p><a class="btn btn-primary" href="${siteUrl}/index.html#/">Ir a CAUCE · Ferias</a></div></main></body></html>
`);

const shellFiles = ['./', './index.html', './manifest.webmanifest', `./${cssName}`, `./${jsName}`, ...chunkNames.map(name => `./${name}`), './assets/brand/favicon.svg',
  './assets/brand/icon-192.png', ...Object.keys(FONTS).map(name => `./assets/fonts/${name}`)];
const cacheName = `ferias-${hash(bundle + css + page)}`;
let worker = await readFile(resolve(root, 'service-worker.js'), 'utf8');
const before = worker;
worker = worker.replace(/const CACHE = '[^']+';/, `const CACHE = '${cacheName}';`)
  .replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = ${JSON.stringify(shellFiles, null, 2)};`)
  .replace(/const SUPABASE = '[^']*';/, `const SUPABASE = ${JSON.stringify(new URL(supabaseUrl).origin)};`);
if (worker === before || !worker.includes(cacheName)) fail('No se pudo versionar el service worker.');
await writeFile(resolve(output, 'service-worker.js'), worker);

for (const file of shellFiles.filter(f => f !== './')) {
  try { await stat(resolve(output, file)); } catch { fail(`Falta ${file} en la salida.`); }
}
console.log(`BUILD PASS · ${local ? 'stack local' : parsed.hostname} · personaje ${character} · ${indexable ? 'indexable' : 'noindex'} · release ${release} · esquema ${CONFIG.requiredSchema}`
  + ` · JS inicial ${Math.round(bundle.length / 1024)} KB (+${chunkNames.length} partes, ${Math.round((allCode.length - bundle.length) / 1024)} KB) · CSS ${Math.round(css.length / 1024)} KB · ${relOut}`);
