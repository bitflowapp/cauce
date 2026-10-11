// Operación del proyecto Supabase remoto de CAUCE · Ferias, paso por paso.
// Cada paso verifica antes y después, se detiene ante cualquier diferencia
// inesperada y nunca imprime secretos. Sin --aplicar sólo informa qué haría;
// con --aplicar exige --confirmar <ref del proyecto>.
//
// Lo corre el workflow "Operación de Ferias" (.github/workflows/operacion.yml)
// con los secretos del entorno `produccion`, o quien opera desde su terminal:
//
//   npm run operacion -- estado                      sólo lectura
//   npm run operacion -- migrar [--aplicar --confirmar <ref>] [--ensayo]
//   npm run operacion -- auth [--aplicar --confirmar <ref>]
//   npm run operacion -- admin --email x@y [--aplicar --confirmar <ref>]
//   npm run operacion -- respaldo [--fotos]          dump, restauración de prueba y copia cifrada
//
// --local ensaya estado, migrar, admin y respaldo contra el stack local de
// Ferias (`npm run db:start`), sin ningún proyecto remoto. Detalle: docs/OPERACION.md.
import { CONFIG } from '../js/config.js';
import { authSummary, desiredAuth, diffAuth, loadAuthSources } from './lib/auth.mjs';
import {
  ConfigError, MissingCredential, ROOT, checklist, log, maskEmail, migrationFiles, redact, safeEmail, secretsPresent, supabaseCli, target,
} from './lib/proyecto.mjs';
import { backup, rehearseMigration } from './lib/respaldo.mjs';

const args = process.argv.slice(2);
const step = args[0];
const flag = name => args.includes(`--${name}`);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const apply = flag('aplicar');
const local = flag('local');
const REQUIRED_SCHEMA = CONFIG.requiredSchema;

// ───────────────────────── comprobaciones reutilizables ─────────────────────────

async function migrationState(t) {
  const files = await migrationFiles();
  const localVersions = files.map(file => file.split('_')[0]);
  const remote = (await t.sql('select version from supabase_migrations.schema_migrations order by version'))
    .map(row => String(row.version));
  const pending = files.filter(file => !remote.includes(file.split('_')[0]));
  const latest = remote.at(-1) || '';
  return {
    files, remote, pending,
    unknown: remote.filter(version => !localVersions.includes(version)),
    // Una pendiente más vieja que la última aplicada: alguien saltó una migración.
    outOfOrder: pending.filter(file => file.split('_')[0] < latest),
  };
}

// El contrato que exige la interfaz (js/config.js) por SQL y por la API pública.
async function contract(t, list) {
  const [row] = await t.sql(`select case when to_regprocedure('public.app_status()') is null then null
    else (public.app_status() ->> 'schema')::bigint end as schema`);
  list.check('contrato de esquema (app_status por SQL)', Number(row?.schema) >= REQUIRED_SCHEMA,
    `${row?.schema ?? 'sin app_status'} · la interfaz necesita ${REQUIRED_SCHEMA}`);
  const response = await fetch(`${t.url}/rest/v1/rpc/app_status`, {
    method: 'POST', headers: { apikey: t.publishableKey, 'Content-Type': 'application/json' }, body: '{}',
  }).catch(error => ({ ok: false, status: error.message, json: async () => null }));
  const api = await response.json().catch(() => null);
  list.check('la API pública responde app_status', response.ok && Number(api?.schema) >= REQUIRED_SCHEMA,
    response.ok ? `esquema ${api?.schema} · interruptores ${JSON.stringify(api?.features || {})}` : `HTTP ${response.status}`);
}

// ───────────────────────── pasos ─────────────────────────

async function estado(t, list) {
  if (!t.local) {
    const project = await t.management('/v1/projects/' + t.ref);
    list.check('proyecto activo', project.status === 'ACTIVE_HEALTHY', `${project.name} · ${project.region} · ${project.status}`);
  }
  const state = await migrationState(t);
  list.info('migraciones', `${state.files.length} en el repo · ${state.remote.length} aplicadas · pendientes: ${state.pending.join(', ') || 'ninguna'}`);
  list.check('historial sin migraciones ajenas al repo', state.unknown.length === 0, state.unknown.join(', ') || 'ok');
  list.check('pendientes en orden (ninguna salteada)', state.outOfOrder.length === 0, state.outOfOrder.join(', ') || 'ok');
  if (state.pending.length) list.info('contrato', 'hay migraciones pendientes: correr `migrar` antes de publicar esta interfaz');
  else await contract(t, list);
  if (t.local) {
    // En local rige supabase/config.toml: se muestra lo que publica Auth.
    const settings = await (await fetch(`${t.url}/auth/v1/settings`, { headers: { apikey: t.publishableKey } })).json();
    list.info('Auth (stack local, config.toml)', `confirmación ${settings.mailer_autoconfirm ? 'desactivada' : 'obligatoria'} · anónimas ${settings.external?.anonymous_users ? 'sí' : 'no'} · registro ${settings.disable_signup ? 'cerrado' : 'abierto'}`);
    list.info('backups de Supabase', 'no aplica al stack local');
    return;
  }
  const config = await t.management('/config/auth');
  for (const [label, value] of authSummary(config)) list.info(`Auth: ${label}`, value);
  try {
    const sources = await loadAuthSources(ROOT);
    const pending = diffAuth(config, desiredAuth({ ...sources, env: process.env })).filter(row => !row.ok);
    list.info('Auth: diferencias con lo previsto', pending.length ? `${pending.length}: ${pending.map(row => row.key).join(', ')} (correr \`auth\`)` : 'ninguna');
  } catch (error) {
    list.info('Auth: diferencias con lo previsto', `no se calculan: ${error.message}`);
  }
  const backups = await t.management('/database/backups').catch(error => ({ error: error.message }));
  if (backups.error) list.info('backups de Supabase', `no consultables: ${backups.error}`);
  else {
    const done = (backups.backups || []).filter(item => item.status === 'COMPLETED');
    list.info('backups de Supabase', `${done.length} completos · último ${done.map(item => item.inserted_at).sort().at(-1) || '—'} · PITR ${backups.pitr_enabled ? 'sí' : 'no'}`);
  }
}

async function migrar(t, list) {
  t.link();
  const before = await migrationState(t);
  log('\nHistorial según la CLI:');
  supabaseCli(['migration', 'list', ...t.cliTarget], { allowFail: true });
  if (before.unknown.length) {
    list.fail('historial coincide con el repo', `el proyecto tiene migraciones que el repo no conoce: ${before.unknown.join(', ')}. STOP.`);
    return;
  }
  if (before.outOfOrder.length) {
    list.fail('pendientes en orden', `${before.outOfOrder.join(', ')} es anterior a la última aplicada. STOP.`);
    return;
  }
  const applied = before.files.filter(file => before.remote.includes(file.split('_')[0]));
  if (!before.pending.length) {
    list.pass('migraciones al día', `${before.remote.length} aplicadas`);
    await contract(t, list);
    // --ensayo: el mismo ensayo que antes de aplicar, aunque no haya nada pendiente.
    if (flag('ensayo')) await rehearseMigration(t, list, { applied, pending: [] });
    return;
  }
  list.info('pendientes', before.pending.join(', '));
  log('\nDry-run de la CLI:');
  const dry = supabaseCli(['db', 'push', ...t.cliTarget, '--dry-run'], { allowFail: true });
  // La CLI puede listar las migraciones más de una vez: se cuentan una vez.
  const listed = [...new Set([...dry.output.matchAll(/(\d{14})_[\w-]+\.sql/g)].map(match => match[1]))].sort();
  const expected = before.pending.map(file => file.split('_')[0]).sort();
  const sameSet = listed.join(',') === expected.join(',');
  list.check('el dry-run muestra exactamente las pendientes', dry.code === 0 && sameSet, listed.join(', ') || 'no listó migraciones');
  if (!(dry.code === 0 && sameSet)) return;
  if (!apply) {
    if (flag('ensayo')) await rehearseMigration(t, list, { applied, pending: before.pending });
    list.info('sin --aplicar', 'no se aplicó nada');
    return;
  }
  // Antes de tocar el proyecto: las pendientes sobre una copia de sus datos,
  // en un stack descartable con las migraciones que el proyecto ya tiene.
  log('\nEnsayo sobre una copia de los datos:');
  const rehearsed = await rehearseMigration(t, list, { applied, pending: before.pending });
  if (!rehearsed) { list.fail('ensayo previo', 'las migraciones no pasaron el ensayo: no se tocó el proyecto. STOP.'); return; }
  log('\nAplicando:');
  supabaseCli(['db', 'push', ...t.cliTarget, '--yes']);
  const after = await migrationState(t);
  list.check('repo y proyecto sincronizados', after.pending.length === 0 && after.unknown.length === 0, `${after.remote.length} aplicadas`);
  await contract(t, list);
}

async function auth(t, list) {
  if (t.local) throw new Error('El paso auth configura el proyecto remoto (en local rige supabase/config.toml).');
  const desired = desiredAuth({ ...await loadAuthSources(ROOT), env: process.env });
  const current = await t.management('/config/auth');
  const rows = diffAuth(current, desired);
  const changes = rows.filter(row => !row.ok);
  for (const row of rows) {
    if (row.key.startsWith('mailer_templates_')) continue;
    if (row.ok) list.info(`Auth: ${row.key}`, `ya está en ${row.shown}`);
    else list.info(`Auth: ${row.key}`, `${row.now ?? '?'} → ${row.shown}`);
  }
  const templates = rows.filter(row => row.key.startsWith('mailer_templates_'));
  list.info('plantillas de correo', templates.length
    ? `${templates.filter(row => !row.ok).length} de ${templates.length} por actualizar (supabase/templates, asuntos de config.toml)`
    : 'se cargan junto con el SMTP propio (faltan FERIAS_SMTP_*)');
  if (!desired.smtp_host) list.info('SMTP propio', 'sin FERIAS_SMTP_*: el correo interno de Supabase sólo entrega al equipo del proyecto');
  if (!changes.length) { list.pass('Auth ya coincide con lo previsto'); return; }
  if (!apply) { list.info('sin --aplicar', `${changes.length} cambios previstos, no se aplicó nada`); return; }
  await t.management('/config/auth', { method: 'PATCH', body: desired });
  const after = await t.management('/config/auth');
  const left = diffAuth(after, desired).filter(row => !row.ok && row.key !== 'smtp_pass');
  list.check('configuración de Auth aplicada', left.length === 0, left.map(row => row.key).join(', ') || `${changes.length} cambios`);
  list.check('confirmación de correo obligatoria', after.mailer_autoconfirm === false);
}

async function admin(t, list) {
  const email = safeEmail(option('email'));
  const who = maskEmail(email);
  const rows = await t.sql(`select u.id::text as id, u.email_confirmed_at is not null as confirmed,
      coalesce(u.is_anonymous, false) as anonymous,
      exists (select 1 from private.platform_admins a where a.user_id = u.id) as admin
    from auth.users u where lower(u.email) = '${email}' and u.deleted_at is null`);
  if (!rows.length) {
    list.fail('existe la cuenta', `no hay una cuenta con ${who}: la persona se registra primero en el sitio publicado.`);
    return;
  }
  const [user] = rows;
  list.check('la cuenta confirmó su correo', user.confirmed === true, who);
  list.check('es una cuenta permanente (no anónima)', user.anonymous === false);
  if (!user.confirmed || user.anonymous) return;
  if (user.admin) list.pass('ya es administración', who);
  else if (apply) {
    await t.sql(`insert into private.platform_admins (user_id) values ('${user.id}') on conflict do nothing`);
    await t.sql(`insert into private.audit_log (actor_role, action, entity, detail)
      values ('system', 'admin_granted', 'platform', jsonb_build_object('user_id', '${user.id}', 'via', 'operacion'))`);
    const [check] = await t.sql(`select exists (select 1 from private.platform_admins where user_id = '${user.id}') as ok`);
    list.check('privilegio de administración otorgado en la base', check.ok === true, who);
  } else list.info('sin --aplicar', `se otorgaría administración a ${who}`);
  const [{ total }] = await t.sql('select count(*)::int as total from private.platform_admins');
  list.info('cuentas de administración', String(total));
  // Nadie lo obtiene desde afuera: la tabla vive en `private`, que la API no expone.
  const exposed = await fetch(`${t.url}/rest/v1/platform_admins?select=*`, { headers: { apikey: t.publishableKey } });
  list.check('la tabla de administración no se expone por la API', !exposed.ok, `HTTP ${exposed.status}`);
}

async function respaldo(t, list) {
  t.link();
  await backup(t, list, { photos: flag('fotos') });
}

// ───────────────────────── arranque ─────────────────────────

const STEPS = { estado, migrar, auth, admin, respaldo };
if (!STEPS[step]) {
  console.error(`Paso desconocido: ${step || '(ninguno)'}. Pasos: ${Object.keys(STEPS).join(', ')}. Ver docs/OPERACION.md.`);
  process.exit(2);
}
const list = checklist(local ? `${step}-local` : step);
// Sólo nombres: qué está cargado y qué no, nunca valores.
log(`Secretos y variables: ${secretsPresent().map(item => `${item.present ? '✔' : '✘'} ${item.name}`).join(' · ')}`);
let t;
try {
  t = await target({ local });
  log(`CAUCE · Ferias · ${step} · ${t.local ? 'stack local' : `proyecto ${t.ref}`} · ${apply ? 'APLICANDO' : 'sólo lectura'}\n`);
  if (apply && option('confirmar') !== t.ref) {
    list.fail('confirmación', `para escribir hay que repetir el ref del proyecto: --confirmar ${t.local ? 'local' : '<ref>'}. No se tocó nada.`);
  } else {
    await STEPS[step](t, list);
  }
} catch (error) {
  if (error instanceof MissingCredential) {
    list.fail('credenciales', `${error.message} Cargarla como secreto del entorno "produccion" (ver docs/OPERACION.md).`);
  } else if (error instanceof ConfigError) {
    list.fail('configuración', redact(error.message));
  } else {
    list.fail('ejecución', redact(error?.stack || error?.message || String(error)).split('\n').slice(0, 4).join(' | '));
  }
} finally {
  await t?.close?.();
}
await list.save();
log(`\n${list.items.filter(item => item.ok).length} en verde · ${list.failed} en rojo.`);
process.exitCode = list.failed ? 1 : 0;
