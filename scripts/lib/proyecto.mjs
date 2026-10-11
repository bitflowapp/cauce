// Acceso al proyecto Supabase remoto de CAUCE · Ferias para operarlo, o al
// stack local de Ferias para ensayar la misma operación antes. El token de
// Supabase, la contraseña de la base y la frase del respaldo viven sólo en
// memoria: nada de eso se imprime ni se guarda.
//
// Configuración (variables de entorno):
//   FERIAS_PROJECT_REF       ref del proyecto remoto (20 letras; nunca el de Aluminé)
//   SUPABASE_ACCESS_TOKEN    token personal de la API de administración
//   SUPABASE_DB_PASSWORD     contraseña de la base (opcional: sin ella la CLI usa un rol temporal)
//   FERIAS_SITE_URL          dirección pública del sitio (paso auth)
//   FERIAS_SMTP_HOST/PORT/USER/PASS/SENDER   SMTP propio (paso auth; todas o ninguna)
//   FERIAS_BACKUP_PASSPHRASE frase para cifrar el respaldo (16+ caracteres)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Proyecto de CAUCE · Aluminé: esta herramienta jamás lo opera (igual que scripts/build.mjs).
export const FORBIDDEN_PROJECTS = ['ygqbcvxdrewcnzedfcyo'];

// Todo lo que el operador puede configurar, con lo que pide cada paso.
export const SECRETS = [
  { name: 'FERIAS_PROJECT_REF', for: 'todos los pasos remotos' },
  { name: 'SUPABASE_ACCESS_TOKEN', for: 'todos los pasos remotos' },
  { name: 'SUPABASE_DB_PASSWORD', for: 'migrar y respaldo (opcional)' },
  { name: 'FERIAS_SITE_URL', for: 'auth' },
  { name: 'FERIAS_SMTP_HOST', for: 'auth (SMTP propio)' },
  { name: 'FERIAS_SMTP_PORT', for: 'auth (SMTP propio)' },
  { name: 'FERIAS_SMTP_USER', for: 'auth (SMTP propio)' },
  { name: 'FERIAS_SMTP_PASS', for: 'auth (SMTP propio)' },
  { name: 'FERIAS_SMTP_SENDER', for: 'auth (SMTP propio)' },
  { name: 'FERIAS_BACKUP_PASSPHRASE', for: 'respaldo' },
];

// Variables cuyo valor nunca puede aparecer en pantalla.
const SECRET_ENV = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'FERIAS_SMTP_PASS', 'FERIAS_BACKUP_PASSPHRASE'];
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
    .replace(/sbp_[A-Za-z0-9]+/g, '[token]')
    .replace(/(token_hash|access_token|refresh_token|password)=([^&\s"']+)/gi, '$1=[oculto]');
}
export const log = (...parts) => console.log(redact(parts.join(' ')));

// Error de configuración del operador: se muestra el mensaje, sin traza.
export class ConfigError extends Error {}
export class MissingCredential extends ConfigError {
  constructor(name, hint = '') { super(`Falta ${name}.${hint ? ` ${hint}` : ''}`); this.variable = name; }
}

// Sólo nombres: qué está cargado y qué no. Nunca valores.
export const secretsPresent = (env = process.env) => SECRETS.map(item => ({ ...item, present: Boolean(env[item.name]) }));

// El ref tiene que ser de un proyecto propio de Ferias.
export function validateRef(value) {
  const ref = String(value || '').trim();
  if (!ref) throw new MissingCredential('FERIAS_PROJECT_REF', 'Es el ref del proyecto Supabase de Ferias (20 letras minúsculas).');
  if (FORBIDDEN_PROJECTS.includes(ref)) throw new ConfigError('Ese es el proyecto de CAUCE · Aluminé: Ferias usa un proyecto propio.');
  if (!/^[a-z]{20}$/.test(ref)) throw new ConfigError('FERIAS_PROJECT_REF no tiene la forma de un ref de Supabase (20 letras minúsculas).');
  return ref;
}

export async function migrationFiles() {
  return (await readdir(join(ROOT, 'supabase', 'migrations'))).filter(name => /^\d{14}_.+\.sql$/.test(name)).sort();
}

// Correos válidos y sin nada que pueda romper una consulta armada a mano.
export function safeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) throw new Error('Correo inválido.');
  return email;
}
export const maskEmail = email => String(email).replace(/^(.)[^@]*(@.*)$/, '$1***$2');

// Estado del stack local de Ferias (`npm run db:start`).
export function localStatus(workdir = ROOT) {
  let raw;
  try {
    raw = execFileSync(npx, ['supabase', 'status', '-o', 'json'], { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new ConfigError('No hay stack Supabase local de Ferias. Ejecutá `npm run db:start`.');
  }
  return JSON.parse(raw.slice(raw.indexOf('{')));
}

// Destino: el proyecto remoto (con el token de la API de administración) o el
// stack local de Ferias, con la misma interfaz.
export async function target({ local = false } = {}) {
  if (local) {
    const status = localStatus();
    for (const value of [status.API_URL, status.DB_URL]) {
      if (!['127.0.0.1', 'localhost'].includes(new URL(value).hostname)) throw new Error(`--local sólo opera un stack local, no ${value}.`);
    }
    const db = postgres(status.DB_URL, { max: 2, onnotice: () => {} });
    return {
      local: true, ref: 'local', url: status.API_URL, publishableKey: status.PUBLISHABLE_KEY || status.ANON_KEY,
      async sql(query) { return [...await db.unsafe(query)]; },
      async management() { throw new Error('La API de administración no existe en el stack local.'); },
      cliTarget: ['--local'],
      link() {},
      async close() { await db.end({ timeout: 2 }); },
    };
  }
  const ref = validateRef(process.env.FERIAS_PROJECT_REF);
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new MissingCredential('SUPABASE_ACCESS_TOKEN', 'Token personal de https://supabase.com/dashboard/account/tokens.');
  hide(token);
  const base = `https://api.supabase.com/v1/projects/${ref}`;
  async function management(path, { method = 'GET', body } = {}) {
    const url = path.startsWith('/v1/') ? `https://api.supabase.com${path}` : `${base}${path}`;
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`API de Supabase ${method} ${path.split('?')[0]}: HTTP ${response.status} ${redact(text).slice(0, 300)}`);
      // @ts-ignore: dato extra para quien llama.
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }
  // La clave pública (la misma que va en el build): sirve para probar la API como una visita.
  const keys = await management('/api-keys');
  const publishableKey = keys.find(item => item.type === 'publishable')?.api_key
    || keys.find(item => item.name === 'anon')?.api_key;
  return {
    local: false, ref, url: `https://${ref}.supabase.co`, publishableKey,
    management,
    // Ejecuta SQL como el editor del dashboard. Sin parámetros: quien llama
    // valida y arma los literales (ver safeEmail).
    async sql(query) { return management('/database/query', { method: 'POST', body: { query } }); },
    // Procedimiento documentado por Supabase para CI: vincular y operar con
    // --linked. La contraseña de la base, si está, llega por
    // SUPABASE_DB_PASSWORD; sin ella la CLI usa un rol temporal de la API.
    cliTarget: ['--linked'],
    link() { supabaseCli(['link', '--project-ref', ref], { input: '' }); },
    async close() {},
  };
}

// CLI de Supabase con el token en el entorno; la contraseña de la base, si
// existe, va por variable de entorno (nunca en la línea de comandos).
export function supabaseCli(args, { allowFail = false, quiet = false, input = '' } = {}) {
  const result = spawnSync(npx, ['supabase', ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env }, maxBuffer: 64 * 1024 * 1024, input,
    shell: process.platform === 'win32',
  });
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`).trim();
  if (!quiet && output) console.log(output.split('\n').map(line => `    ${line}`).join('\n'));
  if (result.status !== 0 && !allowFail) {
    throw new Error(`supabase ${args[0]} ${args[1] || ''} terminó con código ${result.status}: ${output.slice(-300)}`);
  }
  return { code: result.status, output };
}

// Resultado de cada comprobación, en pantalla y en evidence/ (sin secretos).
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
      await mkdir(join(ROOT, 'evidence'), { recursive: true });
      await writeFile(join(ROOT, 'evidence', `operacion-${name}.json`),
        redact(JSON.stringify({ paso: name, at: new Date().toISOString(), items, ...extra }, null, 2)));
    },
  };
}
