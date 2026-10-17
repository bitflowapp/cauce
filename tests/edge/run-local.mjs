// Corre las Edge Functions de pagos en un runtime real contra el stack local
// de Supabase y un doble del proveedor, y ejecuta tests/edge/functions.test.mjs.
//
//   node tests/edge/run-local.mjs                 Deno (deno en el PATH o DENO_BIN)
//   node tests/edge/run-local.mjs --runtime edge  Supabase Edge Runtime (supabase functions serve)
//   … --runtime edge --browser                    además, la UI de pagos en Chromium y WebKit
//       (tests/edge/browser.test.mjs; necesita el build local: npm run build:local)
//   … --runtime edge --vendor <bundle.js>         igual, con supabase-js empaquetado localmente: sólo
//       para entornos cuyo proxy TLS el runtime no acepta (el runtime no descarga de jsr.io). Escribe un
//       deno.json temporal en cada función y lo borra al terminar.
//
// Los secretos de esta corrida son de mentira y se generan cada vez: nunca son
// los del proyecto real. Sólo corre contra un stack local (127.0.0.1).
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeMercadoPago } from './fake-mercadopago.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const runtime = args.includes('--runtime') ? args[args.indexOf('--runtime') + 1] : 'deno';
const vendor = args.includes('--vendor') ? args[args.indexOf('--vendor') + 1] : '';
const withBrowser = args.includes('--browser');
if (withBrowser && runtime !== 'edge') throw new Error('La UI de pagos necesita las funciones detrás del gateway: --runtime edge.');
const DENO = process.env.DENO_BIN || 'deno';
const FUNCTIONS = ['payments-oauth', 'payments-checkout', 'payments-webhook'];
const children = [];

const status = JSON.parse(execFileSync('npx', ['supabase', 'status', '-o', 'json'], { cwd: ROOT, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'] }));
if (new URL(status.API_URL).hostname !== '127.0.0.1') throw new Error('Sólo contra el stack local.');

const secrets = {
  MP_CLIENT_ID: '8800000000000001',
  MP_CLIENT_SECRET: randomBytes(24).toString('hex'),
  MP_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
  PAYMENTS_TOKEN_KEYS: JSON.stringify({ 1: randomBytes(32).toString('base64') }),
  CAUCE_SITE_URL: 'http://127.0.0.1:4174',
};
const fake = await startFakeMercadoPago({ port: 9911, clientId: secrets.MP_CLIENT_ID, clientSecret: secrets.MP_CLIENT_SECRET });

// Espera a la función. Con `answered(status, body)`, hasta que la respuesta
// salga de su propio código (no del gateway); sin él, cualquier cosa que no
// sea "todavía no hay nada" (502/404).
async function waitFor(url, timeout = 90000, answered = null) {
  const end = Date.now() + timeout;
  let last = 'sin respuesta';
  for (;;) {
    try {
      const response = await fetch(url, { method: 'OPTIONS' });
      const body = await response.text();
      last = `${response.status} ${body.slice(0, 80)}`;
      if (answered ? answered(response.status, body) : response.status !== 502 && response.status !== 404) return;
    } catch { /* todavía no */ }
    if (Date.now() > end) throw new Error(`No arrancó: ${url} (última respuesta: ${last})`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function run(command, commandArgs, env, label) {
  // Grupo propio: al terminar se corta todo el árbol (npx → supabase → docker logs).
  const child = spawn(command, commandArgs, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    detached: true });
  const log = [];
  child.stdout.on('data', chunk => log.push(String(chunk)));
  child.stderr.on('data', chunk => log.push(String(chunk)));
  children.push({ child, label, log });
  return child;
}

let urls = {};
let failClosed = 'no probado';
try {
  if (runtime === 'deno') {
    const base = { SUPABASE_URL: status.API_URL, SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, MP_API_BASE: fake.url };
    FUNCTIONS.forEach((name, index) => {
      const port = 8201 + index;
      run(DENO, ['run', '--no-lock', '--node-modules-dir=none', '--allow-net', '--allow-env', '--allow-read', `supabase/functions/${name}/index.js`],
        { ...base, ...secrets, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}` }, name);
      urls[name] = `http://127.0.0.1:${port}`;
    });
    // Sin secretos: tiene que cerrar (503) sin tocar nada.
    run(DENO, ['run', '--no-lock', '--node-modules-dir=none', '--allow-net', '--allow-env', '--allow-read', 'supabase/functions/payments-webhook/index.js'],
      { ...base, DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:8209' }, 'sin-secretos');
    for (const url of [...Object.values(urls), 'http://127.0.0.1:8209']) await waitFor(url);
    const closed = await fetch('http://127.0.0.1:8209?type=order&data.id=ORDTST01X', { method: 'POST', body: '{}' });
    failClosed = `${closed.status} ${JSON.stringify(await closed.json())}`;
    if (closed.status !== 503) throw new Error(`Sin secretos respondió ${failClosed}`);
  } else if (runtime === 'edge') {
    const dir = `${ROOT}.local/edge`;
    mkdirSync(dir, { recursive: true });
    const envFile = `${dir}/pagos.env`;
    writeFileSync(envFile, Object.entries({ ...secrets, MP_API_BASE: `http://host.docker.internal:${fake.port}` })
      .map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
    if (vendor) {
      mkdirSync(`${ROOT}supabase/functions/.local/vendor`, { recursive: true });
      copyFileSync(vendor, `${ROOT}supabase/functions/.local/vendor/supabase-js.bundle.js`);
      for (const name of FUNCTIONS) {
        writeFileSync(`${ROOT}supabase/functions/${name}/deno.json`, JSON.stringify({ imports: {
          'jsr:@supabase/supabase-js@2': '../.local/vendor/supabase-js.bundle.js' } }, null, 2));
      }
    }
    const serveArgs = ['supabase', 'functions', 'serve', '--env-file', envFile];
    run('npx', serveArgs, {}, 'edge-runtime');
    for (const name of FUNCTIONS) urls[name] = `${status.API_URL}/functions/v1/${name}`;
    // Cada función arranca su worker con el primer pedido (y en el CI resuelve
    // sus dependencias): se espera a que las TRES respondan desde su propio
    // código antes de empezar, para que ninguna prueba cargue con el arranque
    // en frío. checkout y OAuth contestan el preflight (204); el webhook, 405.
    // El webhook, sin pilotos todavía, contesta su propio 503 JSON (compuerta cerrada).
    const answered = { 'payments-oauth': status => status === 204, 'payments-checkout': status => status === 204,
      'payments-webhook': (status, body) => status === 405 || (status === 503 && /payments_disabled|not_configured/.test(body)) };
    for (const name of FUNCTIONS) await waitFor(urls[name], 180000, answered[name]);
    // Al servir, la CLI registra las rutas en el gateway local: se espera a que
    // la API vuelva a responder de corrido antes de empezar.
    let steady = 0;
    for (let tries = 0; steady < 8 && tries < 120; tries += 1) {
      try {
        const response = await fetch(`${status.API_URL}/rest/v1/`, { headers: { apikey: status.ANON_KEY } });
        await response.body?.cancel();
        steady = response.ok ? steady + 1 : 0;
      } catch { steady = 0; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } else {
    throw new Error(`Runtime desconocido: ${runtime}`);
  }

  console.log(`Runtime: ${runtime} · sin secretos: ${failClosed}`);
  const files = ['tests/edge/functions.test.mjs', ...(withBrowser ? ['tests/edge/browser.test.mjs'] : [])];
  const test = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=300000', ...files], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, EDGE_URLS: JSON.stringify(urls), EDGE_FAKE_MP: fake.url, EDGE_WEBHOOK_SECRET: secrets.MP_WEBHOOK_SECRET,
      EDGE_SITE_URL: secrets.CAUCE_SITE_URL, EDGE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, EDGE_ANON_KEY: status.ANON_KEY },
  });
  process.exitCode = await new Promise(resolve => test.on('exit', code => resolve(code ?? 1)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const { child, label, log } of children) {
    if (process.exitCode && log.length) console.error(`── ${label} ──\n${log.join('').slice(-30000)}`);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ya terminó */ }
  }
  // La CLI demora en cerrar: después de unos segundos, se corta sin más.
  await new Promise(resolve => setTimeout(resolve, 5000));
  for (const { child } of children) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ya terminó */ }
    child.stdout.destroy();
    child.stderr.destroy();
  }
  if (vendor) for (const name of FUNCTIONS) rmSync(`${ROOT}supabase/functions/${name}/deno.json`, { force: true });
  if (runtime === 'edge') {
    try { execFileSync('docker', ['rm', '-f', 'supabase_edge_runtime_cauce'], { stdio: 'ignore' }); } catch { /* ya no está */ }
    rmSync(`${ROOT}.local/edge/pagos.env`, { force: true });
  }
  await fake.close();
}
