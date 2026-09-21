// Backend local de desarrollo de CAUCE.
//
// Qué es: un servidor de pruebas que corre en tu máquina y da lo que la
// demostración pública NO puede dar: persistencia compartida entre sesiones y
// autenticación real con contraseña. Sirve la misma aplicación y ejecuta
// exactamente las mismas reglas de dominio (js/domain/commands.js), pero dentro
// de una transacción de SQLite y con el actor resuelto desde la sesión.
//
// Qué NO es: no es producción, no cobra, no envía nada a terceros, y sólo
// escucha en 127.0.0.1.
import { createServer } from 'node:http';
import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

import { initialState, assertValidState } from '../js/domain/state.js';
import { runCommand, isCommand } from '../js/domain/commands.js';
import { runQuery, isQuery } from '../js/domain/queries.js';
import { actorFor, validateSignUp, normalizeEmail, validatePassword } from '../js/core/accounts.js';
import { CauceError } from '../js/core/errors.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

const SESSION_COOKIE = 'cauce_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
const SIGN_IN_MAX_ATTEMPTS = 10;

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";
// El service worker hereda la CSP de su propia respuesta, no la del documento.
const WORKER_CSP = "default-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'";

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
};

// ───────────────────────── almacenamiento ─────────────────────────

export function openDatabase(file = ':memory:') {
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS domain_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      doc TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS credentials (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT,
      guest_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  const existing = database.prepare('SELECT doc FROM domain_state WHERE id = 1').get();
  if (!existing) {
    // El backend local arranca sin identidades de ejemplo precargadas:
    // las cuentas se crean con `--seed` o desde la propia aplicación.
    const seed = initialState({ seedDemoIdentities: false });
    database.prepare('INSERT INTO domain_state (id, doc, revision) VALUES (1, ?, 0)')
      .run(JSON.stringify(seed));
  }
  return database;
}

function readState(database) {
  const row = database.prepare('SELECT doc FROM domain_state WHERE id = 1').get();
  return assertValidState(JSON.parse(row.doc));
}

function writeState(database, state) {
  database.prepare('UPDATE domain_state SET doc = ?, revision = revision + 1 WHERE id = 1')
    .run(JSON.stringify(state));
}

// Toda mutación corre en una transacción inmediata: dos conductores que aceptan
// el mismo viaje se serializan y el segundo recibe TRIP_ALREADY_TAKEN.
function transact(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const state = readState(database);
    const result = operation(state);
    writeState(database, state);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* la transacción ya se cerró */ }
    throw error;
  }
}

// ───────────────────────── credenciales y sesiones ─────────────────────────

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, salt, expected) {
  const actual = scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target);
}

const tokenHash = token => createHash('sha256').update(token).digest('hex');

function createSession(database, { accountId = null, guestId }) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  database.prepare('INSERT INTO sessions (token_hash, account_id, guest_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash(token), accountId, guestId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString());
  return token;
}

function loadSession(database, token) {
  if (!token) return null;
  const row = database.prepare('SELECT account_id, guest_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return null;
  }
  return { accountId: row.account_id, guestId: row.guest_id };
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return [part.trim(), ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

// Cookie de sesión: HttpOnly y SameSite=Lax. Sin `Secure` porque el entorno de
// pruebas corre en http://127.0.0.1; en cualquier despliegue real sería obligatorio.
function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

// ───────────────────────── servidor ─────────────────────────

export function createDevServer({ database = openDatabase(), root = ROOT, apiBase = '/api' } = {}) {
  const base = resolve(root);
  const signInAttempts = new Map();

  const tooManyAttempts = key => {
    const entry = signInAttempts.get(key);
    if (!entry) return false;
    if (Date.now() - entry.first > SIGN_IN_WINDOW_MS) { signInAttempts.delete(key); return false; }
    return entry.count >= SIGN_IN_MAX_ATTEMPTS;
  };
  const noteAttempt = key => {
    const entry = signInAttempts.get(key);
    if (!entry || Date.now() - entry.first > SIGN_IN_WINDOW_MS) signInAttempts.set(key, { first: Date.now(), count: 1 });
    else entry.count += 1;
  };

  const server = createServer(async (request, response) => {
    const isWorker = (request.url || '').startsWith('/service-worker.js');
    response.setHeader('Content-Security-Policy', isWorker ? WORKER_CSP : CSP);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');

    const host = request.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      response.statusCode = 403;
      return response.end('El entorno de pruebas sólo acepta conexiones locales.');
    }

    const url = new URL(request.url, `http://${host}`);
    if (url.pathname.startsWith(apiBase)) return handleApi(request, response, url);
    return handleStatic(request, response, url);
  });

  async function handleApi(request, response, url) {
    const respond = (status, body) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return respond(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Método no permitido.' });
    }

    let body;
    try { body = await readJsonBody(request); }
    catch (error) {
      return respond(400, { ok: false, code: error.code || 'INVALID_BODY', message: error.message });
    }

    const cookies = parseCookies(request.headers.cookie);
    let session = loadSession(database, cookies[SESSION_COOKIE]);
    let issuedToken = null;
    if (!session) {
      const guestId = `guest-${crypto.randomUUID()}`;
      issuedToken = createSession(database, { guestId });
      session = { accountId: null, guestId };
    }

    const route = url.pathname.slice(apiBase.length);
    const context = state => ({
      actor: actorFor(state, session.accountId, { guestId: session.guestId }),
      ownerId: session.accountId || session.guestId,
      now: () => new Date().toISOString(),
      uuid: () => crypto.randomUUID(),
      environment: 'local-backend',
      allowReset: false,
    });

    const setCookieIfNeeded = token => {
      if (token) response.setHeader('Set-Cookie', sessionCookie(token));
    };

    try {
      if (route === '/session') {
        const state = readState(database);
        const resolved = context(state);
        setCookieIfNeeded(issuedToken);
        return respond(200, { ok: true, data: { actor: resolved.actor, ownerId: resolved.ownerId } });
      }

      if (route === '/register') {
        const profile = validateSignUp(body, { requirePassword: true });
        const passwordCheck = validatePassword(body?.password);
        if (!passwordCheck.ok) throw new CauceError('INVALID_PASSWORD', passwordCheck.message);
        const existing = database.prepare('SELECT account_id FROM credentials WHERE email = ?').get(profile.email);
        if (existing) throw new CauceError('EMAIL_TAKEN', 'Ya existe una cuenta con ese correo.');

        const account = transact(database, state => runCommand(state, 'account.register', context(state), {
          ...body, email: profile.email,
        }));
        const { salt, hash } = hashPassword(body.password);
        database.prepare('INSERT INTO credentials (account_id, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(account.id, profile.email, salt, hash, new Date().toISOString());
        const token = createSession(database, { accountId: account.id, guestId: session.guestId });
        response.setHeader('Set-Cookie', sessionCookie(token));
        return respond(200, { ok: true, data: account });
      }

      if (route === '/sign-in') {
        const email = normalizeEmail(body?.email);
        const key = `${email}`;
        if (tooManyAttempts(key)) {
          throw new CauceError('TOO_MANY_ATTEMPTS', 'Demasiados intentos. Esperá unos minutos antes de reintentar.');
        }
        const row = database.prepare('SELECT account_id, salt, password_hash FROM credentials WHERE email = ?').get(email);
        const valid = Boolean(row) && typeof body?.password === 'string'
          && verifyPassword(body.password, row.salt, row.password_hash);
        if (!valid) {
          noteAttempt(key);
          throw new CauceError('INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
        }
        signInAttempts.delete(key);
        const token = createSession(database, { accountId: row.account_id, guestId: session.guestId });
        response.setHeader('Set-Cookie', sessionCookie(token));
        const state = readState(database);
        return respond(200, { ok: true, data: actorFor(state, row.account_id, { guestId: session.guestId }) });
      }

      if (route === '/sign-out') {
        const token = cookies[SESSION_COOKIE];
        if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
        response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
        return respond(200, { ok: true, data: true });
      }

      if (route === '/query') {
        if (!isQuery(body?.name)) throw new CauceError('UNKNOWN_QUERY', 'Consulta no disponible.');
        const state = readState(database);
        const data = runQuery(state, body.name, context(state), body.payload);
        setCookieIfNeeded(issuedToken);
        return respond(200, { ok: true, data });
      }

      if (route === '/command') {
        if (!isCommand(body?.name)) throw new CauceError('UNKNOWN_COMMAND', 'Operación no disponible.');
        const data = transact(database, state => runCommand(state, body.name, context(state), body.payload));
        setCookieIfNeeded(issuedToken);
        return respond(200, { ok: true, data });
      }

      return respond(404, { ok: false, code: 'UNKNOWN_ROUTE', message: 'Ruta de API inexistente.' });
    } catch (error) {
      const code = error?.code || 'INTERNAL_ERROR';
      const status = statusForCode(code);
      if (status >= 500) console.error('[cauce-dev]', error);
      return respond(status, {
        ok: false,
        code,
        message: error instanceof CauceError ? error.message : 'No se pudo completar la operación.',
      });
    }
  }

  async function handleStatic(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      response.statusCode = 405;
      return response.end('Método no permitido.');
    }
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    if (path.includes('\0') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) {
      response.statusCode = 400;
      return response.end('Ruta inválida.');
    }

    // El módulo de entorno se genera: es lo único que distingue este entorno del público.
    if (path === '/js/runtime-env.js') {
      response.statusCode = 200;
      response.setHeader('Content-Type', MIME['.js']);
      return response.end(runtimeEnvModule(apiBase));
    }

    if (!(path === '/index.html' || /^\/(js|styles|assets)\//.test(path) || path === '/manifest.webmanifest' || path === '/service-worker.js')) {
      response.statusCode = 404;
      return response.end('No encontrado.');
    }

    try {
      const target = resolve(base, `.${path}`);
      if (!target.startsWith(base + sep)) { response.statusCode = 403; return response.end('Ruta no permitida.'); }
      const actual = await realpath(target);
      if (!actual.startsWith(base + sep)) { response.statusCode = 403; return response.end('Ruta no permitida.'); }
      const mime = MIME[extname(actual)];
      if (!mime || !(await stat(actual)).isFile()) { response.statusCode = 404; return response.end('No encontrado.'); }

      let content = await readFile(actual);
      if (path === '/index.html') {
        // El documento versionado bloquea toda conexión (es el que se publica).
        // Acá se habilita únicamente el mismo origen, para hablar con esta API.
        // El indicador de entorno se corrige en el HTML servido para que no
        // aparezca "Demostración" ni por un instante antes de que corra el script.
        content = Buffer.from(String(content)
          .replace("connect-src 'none'", "connect-src 'self'")
          .replace(/(<span class="env-chip"[^>]*>)[^<]*(<\/span>)/, '$1Pruebas$2')
          .replace(/(<p class="footer-note" id="footer-env">)[^<]*(<\/p>)/,
            '$1Entorno de pruebas local · Backend local con sesiones autenticadas y persistencia compartida.$2'), 'utf8');
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', mime);
      if (request.method === 'HEAD') return response.end('');
      return response.end(content);
    } catch (error) {
      response.statusCode = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400;
      return response.end('No se pudo abrir el recurso.');
    }
  }

  server.database = database;
  return server;
}

function runtimeEnvModule(apiBase) {
  return `// Generado por scripts/dev-server.mjs para el entorno local con backend.\n`
    + `export const RUNTIME_ENV = Object.freeze({\n`
    + `  environment: 'local-backend',\n`
    + `  apiBase: ${JSON.stringify(apiBase)},\n`
    + `  label: 'Entorno de pruebas local',\n`
    + `  description: 'Backend local con sesiones autenticadas y persistencia compartida. No genera operaciones reales.',\n`
    + `  sharedPersistence: true,\n`
    + `  passwordAuth: true,\n`
    + `});\n`;
}

function statusForCode(code) {
  if (['SESSION_REQUIRED', 'INVALID_CREDENTIALS'].includes(code)) return 401;
  if (['ROLE_REQUIRED', 'TENANT_MISMATCH', 'RESET_FORBIDDEN', 'PAYMENTS_DISABLED'].includes(code)) return 403;
  if (['BUSINESS_NOT_FOUND', 'ORDER_NOT_FOUND', 'PRODUCT_NOT_FOUND', 'TRIP_NOT_FOUND', 'DRIVER_NOT_FOUND', 'UNKNOWN_ROUTE'].includes(code)) return 404;
  if (['STALE_ORDER', 'TRIP_ALREADY_TAKEN', 'IDEMPOTENCY_CONFLICT', 'EMAIL_TAKEN', 'ACTIVE_TRIP_EXISTS', 'DRIVER_BUSY'].includes(code)) return 409;
  if (code === 'TOO_MANY_ATTEMPTS') return 429;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}

function readJsonBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new CauceError('BODY_TOO_LARGE', 'El cuerpo de la solicitud es demasiado grande.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolvePromise({});
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { rejectPromise(new CauceError('INVALID_JSON', 'El cuerpo de la solicitud no es JSON válido.')); }
    });
    request.on('error', () => rejectPromise(new CauceError('REQUEST_ABORTED', 'La solicitud se interrumpió.')));
  });
}

// ───────────────────────── semilla de cuentas de prueba ─────────────────────────

// Crea cuentas sintéticas con contraseñas generadas al azar y las escribe en un
// archivo local ignorado por git. Nunca se versionan contraseñas.
export function seedTestAccounts(database, { file } = {}) {
  const definitions = [
    { key: 'clienta', name: 'Vecina de prueba', email: 'clienta@cauce.test', roles: ['customer'] },
    { key: 'comercio', name: 'Responsable de comercio', email: 'comercio@cauce.test', roles: ['customer', 'merchant'] },
    { key: 'admin', name: 'Administración CAUCE', email: 'admin@cauce.test', roles: ['customer', 'admin'] },
    { key: 'taxista', name: 'Conductor de prueba', email: 'taxista@cauce.test', roles: ['customer', 'driver'] },
  ];
  const created = [];
  for (const definition of definitions) {
    const existing = database.prepare('SELECT account_id FROM credentials WHERE email = ?').get(definition.email);
    if (existing) { created.push({ ...definition, password: null, alreadyExisted: true }); continue; }
    const password = `${randomBytes(9).toString('base64url')}7a`;
    const account = transact(database, state => runCommand(state, 'account.register', {
      actor: null, ownerId: 'system', now: () => new Date().toISOString(), uuid: () => crypto.randomUUID(),
      environment: 'local-backend', allowReset: false,
    }, { email: definition.email, name: definition.name, phone: '2942000000', roles: definition.roles }));
    // `account.register` sólo concede customer/merchant/driver: administración se asigna acá.
    if (definition.roles.includes('admin')) {
      transact(database, state => {
        const stored = state.accounts.find(candidate => candidate.id === account.id);
        if (stored && !stored.roles.includes('admin')) stored.roles.push('admin');
        return stored;
      });
    }
    const { salt, hash } = hashPassword(password);
    database.prepare('INSERT INTO credentials (account_id, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(account.id, definition.email, salt, hash, new Date().toISOString());
    created.push({ ...definition, accountId: account.id, password, alreadyExisted: false });
  }
  return { created, file };
}

// ───────────────────────── arranque ─────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4180);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT debe estar entre 1024 y 65535.');
  const dataDir = resolve(ROOT, '.local');
  await mkdir(dataDir, { recursive: true });
  const database = openDatabase(resolve(dataDir, 'cauce-dev.sqlite'));
  const server = createDevServer({ database });

  if (process.argv.includes('--seed')) {
    const credentialsFile = resolve(dataDir, 'dev-credentials.json');
    const { created } = seedTestAccounts(database);
    const fresh = created.filter(entry => !entry.alreadyExisted);
    if (fresh.length) {
      await writeFile(credentialsFile, JSON.stringify({
        aviso: 'Cuentas sintéticas del entorno local de pruebas. Archivo NO versionado. Regenerable borrando .local/.',
        generadoEl: new Date().toISOString(),
        cuentas: fresh.map(entry => ({ rol: entry.key, email: entry.email, password: entry.password })),
      }, null, 2), 'utf8');
      console.log(`Cuentas de prueba creadas. Credenciales en ${credentialsFile}`);
    } else {
      console.log('Las cuentas de prueba ya existían. Credenciales previas en .local/dev-credentials.json');
    }
  }

  server.listen(port, '127.0.0.1', () => {
    console.log([
      'CAUCE · Aluminé — ENTORNO LOCAL DE PRUEBAS (backend)',
      `http://127.0.0.1:${port}`,
      'Persistencia compartida en .local/cauce-dev.sqlite · sesiones con contraseña.',
      'No genera pedidos, viajes ni cobros reales. Ctrl+C para detener.',
    ].join('\n'));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => { database.close(); process.exit(0); }));
  }
}
