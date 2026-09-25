// Acceso al proyecto CAUCE real para operarlo, o al stack local para ensayar la
// misma operación antes. El token de Supabase, la contraseña de la base y la
// clave de servidor viven sólo en memoria: nada de eso se imprime ni se guarda.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';

const root = new URL('../../', import.meta.url);
export const ROOT = root;
export const PROJECT = JSON.parse(await readFile(new URL('supabase/project.json', root), 'utf8'));
if (PROJECT.projectRef !== 'ygqbcvxdrewcnzedfcyo' || PROJECT.url !== 'https://ygqbcvxdrewcnzedfcyo.supabase.co') {
  throw new Error('Esta herramienta sólo opera el proyecto CAUCE.');
}
export const SITE_URL = (process.env.CAUCE_SITE_URL || 'https://bitflowapp.github.io/cauce').replace(/\/+$/, '');

// Variables cuyo valor nunca puede aparecer en pantalla.
const SECRET_ENV = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'CAUCE_SMTP_PASS', 'CAUCE_BACKUP_PASSPHRASE'];
const extraSecrets = new Set();
export function hide(value) { if (value && String(value).length >= 6) extraSecrets.add(String(value)); }
export function redact(text) {
  let out = String(text ?? '');
  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value && value.length >= 6) out = out.split(value).join('[oculto]');
  }
  for (const value of extraSecrets) out = out.split(value).join('[oculto]');
  return out
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, '[clave-servidor]')
    .replace(/(token_hash|access_token|refresh_token|password)=([^&\s"']+)/gi, '$1=[oculto]');
}
export const log = (...parts) => console.log(redact(parts.join(' ')));

export class MissingCredential extends Error {
  constructor(name) { super(`Falta ${name}.`); this.variable = name; }
}

export async function migrationFiles() {
  return (await readdir(new URL('supabase/migrations/', root))).filter(name => /^\d{14}_.+\.sql$/.test(name)).sort();
}

// Correos válidos y sin nada que pueda romper una consulta armada a mano.
export function safeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) throw new Error('Correo inválido.');
  return email;
}
export const maskEmail = email => String(email).replace(/^(.)[^@]*(@.*)$/, '$1***$2');

// Destino: el proyecto real (con el token de la API de administración) o el
// stack local de `npx supabase start`, con la misma interfaz.
export async function target({ local = false, custom = null } = {}) {
  if (custom) {
    for (const value of [custom.dbUrl, custom.url]) {
      if (!['127.0.0.1', 'localhost'].includes(new URL(value).hostname)) throw new Error('Un destino explícito sólo puede ser local.');
    }
    const db = postgres(custom.dbUrl, { max: 2, onnotice: () => {} });
    return {
      local: true, ref: 'ensayo', url: custom.url, publishableKey: custom.publishableKey, siteUrl: 'http://127.0.0.1:4174',
      dbUrl: custom.dbUrl,
      async serviceKey() { return custom.serviceKey; },
      async sql(query) { return [...await db.unsafe(query)]; },
      async management() { throw new Error('La API de administración no existe en un ensayo local.'); },
      // El Postgres local no ofrece TLS y la CLI lo exige por defecto.
      cliTarget: ['--db-url', `${custom.dbUrl}${custom.dbUrl.includes('?') ? '&' : '?'}sslmode=disable`],
      link() {},
      async close() { await db.end({ timeout: 2 }); },
    };
  }
  if (local) {
    const raw = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', 'status', '-o', 'json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const status = JSON.parse(raw.slice(raw.indexOf('{')));
    const db = postgres(status.DB_URL, { max: 2, onnotice: () => {} });
    return {
      local: true, ref: 'local', url: status.API_URL, publishableKey: status.PUBLISHABLE_KEY,
      siteUrl: 'http://127.0.0.1:4174', mailpitUrl: status.MAILPIT_URL, dbUrl: status.DB_URL,
      async serviceKey() { return status.SECRET_KEY; },
      async sql(query) { return [...await db.unsafe(query)]; },
      async management() { throw new Error('La API de administración no existe en el stack local.'); },
      cliTarget: ['--local'],
      link() {},
      async close() { await db.end({ timeout: 2 }); },
    };
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new MissingCredential('SUPABASE_ACCESS_TOKEN');
  const base = `https://api.supabase.com/v1/projects/${PROJECT.projectRef}`;
  async function management(path, { method = 'GET', body } = {}) {
    const url = path.startsWith('https://') ? path : path.startsWith('/v1/') ? `https://api.supabase.com${path}` : `${base}${path}`;
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`API de Supabase ${method} ${path}: HTTP ${response.status} ${redact(text).slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }
  let cachedServiceKey = null;
  return {
    local: false, ref: PROJECT.projectRef, url: PROJECT.url, publishableKey: PROJECT.publishableKey, siteUrl: SITE_URL,
    management,
    // Ejecuta SQL como el editor del dashboard. Sin parámetros: quien llama
    // valida y arma los literales (ver safeEmail).
    async sql(query) { return management('/database/query', { method: 'POST', body: { query } }); },
    async serviceKey() {
      if (cachedServiceKey) return cachedServiceKey;
      const keys = await management('/api-keys?reveal=true');
      const key = keys.find(item => item.type === 'secret' && !item.disabled)?.api_key
        || keys.find(item => item.name === 'service_role')?.api_key;
      if (!key || key.includes('*')) throw new Error('No se pudo obtener la clave de servidor del proyecto.');
      hide(key);
      cachedServiceKey = key;
      return key;
    },
    // Procedimiento documentado por Supabase para CI: vincular y operar con
    // --linked. La contraseña de la base, si está, llega por
    // SUPABASE_DB_PASSWORD; sin ella la CLI usa un rol temporal de la API.
    cliTarget: ['--linked'],
    link() { supabaseCli(['link', '--project-ref', PROJECT.projectRef], { input: '' }); },
    async close() {},
  };
}

// CLI de Supabase con el token en el entorno; la contraseña de la base, si
// existe, va por variable de entorno (nunca en la línea de comandos).
export function supabaseCli(args, { allowFail = false, quiet = false, input = '' } = {}) {
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env }, maxBuffer: 64 * 1024 * 1024, input,
    shell: process.platform === 'win32',
  });
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`).trim();
  if (!quiet && output) console.log(output.split('\n').map(line => `    ${line}`).join('\n'));
  if (result.status !== 0 && !allowFail) {
    throw new Error(`supabase ${args[0]} ${args[1] || ''} terminó con código ${result.status}`);
  }
  return { code: result.status, output };
}

// Resultado de cada comprobación, en pantalla y en evidence/.
export function checklist(name) {
  const items = [];
  return {
    items,
    pass(label, detail = '') { items.push({ label, ok: true, detail }); log(`PASS · ${label}${detail ? ` · ${detail}` : ''}`); },
    fail(label, detail = '') { items.push({ label, ok: false, detail }); log(`FAIL · ${label}${detail ? ` · ${detail}` : ''}`); },
    info(label, detail = '') { items.push({ label, ok: null, detail }); log(`INFO · ${label}${detail ? ` · ${detail}` : ''}`); },
    check(label, ok, detail = '') { return ok ? this.pass(label, detail) : this.fail(label, detail); },
    get failed() { return items.filter(item => item.ok === false).length; },
    async save(extra = {}) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(new URL('evidence/', root), { recursive: true });
      await writeFile(new URL(`evidence/operacion-${name}.json`, root),
        redact(JSON.stringify({ paso: name, at: new Date().toISOString(), items, ...extra }, null, 2)));
    },
  };
}
