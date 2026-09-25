// Respaldo lógico de CAUCE, prueba de restauración y ensayo de migraciones
// sobre una copia de los datos reales.
//
// El dump de esquema de la CLI no incluye las políticas de Storage (viven en el
// esquema `storage`), así que restaurar sólo desde ese archivo dejaría el
// bucket sin reglas. La restauración se hace como se haría en un desastre:
// migraciones del repo + datos. Después se comparan los conteos, el contrato
// de esquema, RLS, las políticas de Storage y el esquema resultante contra el
// del origen (cualquier diferencia es un cambio hecho a mano fuera de las
// migraciones).
//
// El dump de datos no incluye sesiones, refresh tokens ni registros de Auth,
// pero sí cuentas (con contraseñas hasheadas) y pedidos: sólo sale de la
// máquina cifrado con CAUCE_BACKUP_PASSPHRASE.
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { REQUIRED_SCHEMA } from '../../js/core/contract.js';
import { ROOT, log, migrationFiles, redact, supabaseCli } from './proyecto.mjs';
import { adaptDump, parseDump, quoted } from './volcado.mjs';

const root = fileURLToPath(ROOT);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Estado transitorio de Auth y Storage: no hace falta para volver a operar y
// es lo más sensible (sesiones y tokens vigentes). También las tablas de
// MFA, SSO, OAuth, SCIM y WebAuthn, que CAUCE no usa (si algún día se habilita
// MFA, sus factores tienen que volver al respaldo), y el registro de
// migraciones propio de cada servicio, que en otro proyecto ya existe.
export const DATA_EXCLUDE = [
  'auth.sessions', 'auth.refresh_tokens', 'auth.one_time_tokens', 'auth.flow_state', 'auth.audit_log_entries',
  'auth.mfa_challenges', 'auth.mfa_amr_claims', 'auth.mfa_factors', 'auth.mfa_recovery_code_sets',
  'auth.mfa_recovery_codes', 'auth.saml_providers', 'auth.saml_relay_states', 'auth.sso_providers',
  'auth.sso_domains', 'auth.oauth_authorizations', 'auth.oauth_client_states', 'auth.oauth_clients',
  'auth.oauth_consents', 'auth.custom_oauth_providers', 'auth.scim_tokens', 'auth.scim_users',
  'auth.webauthn_challenges', 'auth.webauthn_credentials', 'auth.instances', 'auth.schema_migrations',
  'storage.migrations', 'storage.s3_multipart_uploads', 'storage.s3_multipart_uploads_parts',
  'supabase_functions.hooks', 'storage.buckets_analytics', 'storage.buckets_vectors',
  'storage.iceberg_namespaces', 'storage.iceberg_tables', 'storage.vector_indexes',
];

// Plan → respaldo que ofrece Supabase (documentación pública de Supabase; la
// existencia real de backups se comprueba con la API).
const PLAN_RETENTION = { free: 'sin backups diarios', pro: '7 días', team: '14 días', enterprise: 'hasta 30 días' };

export const COUNT_SQL = `select table_schema || '.' || table_name as name,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as n
  from information_schema.tables
  where table_type = 'BASE TABLE' and (table_schema in ('public', 'private')
    or (table_schema, table_name) in (('auth', 'users'), ('auth', 'identities'), ('storage', 'buckets'), ('storage', 'objects')))
  order by 1`;
const toCounts = rows => Object.fromEntries(rows.map(row => [row.name, Number(row.n)]));

const normalizeSchema = text => String(text).split('\n')
  .map(line => line.trimEnd())
  .filter(line => line && !line.startsWith('--') && !/^SET |^SELECT pg_catalog\.set_config|^RESET ALL|^GRANT .* TO "service_role";$/.test(line))
  .join('\n');

function tempConfig(source, offset, projectId) {
  return source
    .replace(/^project_id = ".*"$/m, `project_id = "${projectId}"`)
    .replace(/^(\s*(?:shadow_)?port = )(5\d{4})$/gm, (_, key, port) => `${key}${Number(port) + offset}`)
    .replace(/^(\s*inspector_port = )(\d+)$/m, (_, key, port) => `${key}${Number(port) + offset}`)
    .replace(/^site_url = .*$/m, `site_url = "http://127.0.0.1:${4174 + offset}"`);
}

// Dump del origen: conteos, esquema y datos sin estado transitorio.
export async function dumpDatabase(t, out, list) {
  await mkdir(out, { recursive: true });
  const counts = toCounts(await t.sql(COUNT_SQL));
  await writeFile(join(out, 'conteos.json'), JSON.stringify(counts, null, 2));
  list.info('filas en el origen', `${Object.keys(counts).length} tablas · ${counts['public.businesses'] ?? 0} comercios · ${counts['public.orders'] ?? 0} pedidos · ${counts['auth.users'] ?? 0} cuentas`);
  supabaseCli(['db', 'dump', ...t.cliTarget, '-f', join(out, 'schema.sql')], { quiet: true });
  supabaseCli(['db', 'dump', ...t.cliTarget, '--data-only', '--use-copy', '-x', DATA_EXCLUDE.join(','),
    '-f', join(out, 'data.sql')], { quiet: true });
  const data = await readFile(join(out, 'data.sql'), 'utf8');
  const dumped = [...data.matchAll(/^COPY "([a-z_]+)"\."([a-z_0-9]+)"/gm)].map(match => `${match[1]}.${match[2]}`);
  list.check('dump de esquema y datos generados', dumped.length > 0 && !dumped.some(name => DATA_EXCLUDE.includes(name)),
    `${dumped.length} tablas con datos, sin sesiones ni tokens`);
  return { counts, dumped, schemaFile: join(out, 'schema.sql'), dataFile: join(out, 'data.sql') };
}

// Stack Supabase temporal y descartable, con las migraciones indicadas.
export async function withTempStack({ migrations, offset = 1000, projectId = 'cauce-restauracion', realtime = false }, fn) {
  const work = await mkdtemp(join(tmpdir(), `${projectId}-`));
  await mkdir(join(work, 'supabase', 'migrations'), { recursive: true });
  await writeFile(join(work, 'supabase', 'config.toml'),
    tempConfig(await readFile(join(root, 'supabase', 'config.toml'), 'utf8'), offset, projectId));
  for (const file of migrations) {
    await cp(join(root, 'supabase', 'migrations', file), join(work, 'supabase', 'migrations', file));
  }
  await cp(join(root, 'supabase', 'templates'), join(work, 'supabase', 'templates'), { recursive: true });
  await writeFile(join(work, 'supabase', 'seed.sql'), '');
  const cli = (cliArgs, options = {}) => spawnSync(npx, ['supabase', ...cliArgs, '--workdir', work],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: '', shell: process.platform === 'win32', ...options });
  let db;
  try {
    log(`\nLevantando un stack temporal (${projectId}, ${migrations.length} migraciones)…`);
    const excluded = ['imgproxy', 'studio', 'edge-runtime', 'logflare', 'vector', 'supavisor', 'postgres-meta', 'mailpit',
      ...(realtime ? [] : ['realtime'])];
    const started = cli(['start', '-x', excluded.join(',')]);
    if (started.status !== 0) throw new Error(`no arrancó el stack temporal: ${redact(started.stderr).slice(-400)}`);
    const raw = cli(['status', '-o', 'json']).stdout;
    const status = JSON.parse(raw.slice(raw.indexOf('{')));
    const adminUrl = status.DB_URL.replace('//postgres:', '//supabase_admin:');
    db = postgres(adminUrl, { max: 1, onnotice: () => {} });
    return await fn({ work, cli, status, adminUrl, db });
  } finally {
    await db?.end({ timeout: 2 }).catch(() => {});
    cli(['stop', '--no-backup']);
    await rm(work, { recursive: true, force: true });
  }
}

// Carga el dump de datos sobre las tablas del stack temporal, adaptado a lo
// que ese stack tiene (ver volcado.mjs).
export async function loadData({ db, adminUrl, work }, { dataFile }, list) {
  const target = { columns: new Map(), sequences: new Set() };
  for (const row of await db.unsafe(`select table_schema || '.' || table_name as name, column_name as column
      from information_schema.columns where table_schema not in ('pg_catalog', 'information_schema')`)) {
    if (!target.columns.has(row.name)) target.columns.set(row.name, new Set());
    target.columns.get(row.name).add(row.column);
  }
  for (const row of await db.unsafe(`select schemaname || '.' || sequencename as name from pg_sequences`)) {
    target.sequences.add(row.name);
  }
  const adapted = adaptDump(parseDump(await readFile(dataFile, 'utf8')), target);
  if (adapted.omitted.length) {
    list.info('Auth/Storage del origen más nuevos que el stack de prueba', `omitido: ${adapted.omitted.join('; ')}`);
  }
  if (adapted.problems.length) {
    list.fail('los datos se restauran sin errores', adapted.problems.join('; '));
    return false;
  }
  const file = join(work, 'datos-adaptados.sql');
  await writeFile(file, adapted.sql);
  if (adapted.tables.length) await db.unsafe(`truncate ${adapted.tables.map(quoted).join(', ')} cascade`);
  const load = spawnSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  list.check('los datos se restauran sin errores', load.status === 0,
    redact(load.stderr || '').trim().slice(0, 300) || `${adapted.tables.length} tablas`);
  return load.status === 0;
}

export function compareCounts(before, after, dumped, { allowGrowth = [] } = {}) {
  const compared = dumped.filter(name => name in before);
  const mismatches = compared.filter(name => allowGrowth.includes(name)
    ? !(after[name] >= before[name]) : after[name] !== before[name]);
  return { compared, mismatches };
}

// Lo que tiene que valer en cualquier base restaurada o migrada. Sin
// `contract`, la base es anterior a la migración que publica app_status (un
// backup tomado antes de migrar): se verifica todo lo demás.
export async function verifyDatabase({ db, status }, list, { label = 'restaurada', contract = true } = {}) {
  const headers = { apikey: status.PUBLISHABLE_KEY, 'Content-Type': 'application/json' };
  if (contract) {
    const [row] = await db.unsafe(`select (public.app_status() ->> 'schema')::bigint as schema`);
    list.check(`el contrato de esquema responde (${label})`, Number(row.schema) >= REQUIRED_SCHEMA, String(row.schema));
    const api = await (await fetch(`${status.API_URL}/rest/v1/rpc/app_status`, { method: 'POST', headers, body: '{}' })).json().catch(() => null);
    list.check(`la API publica el contrato nuevo (${label})`, Number(api?.schema) >= REQUIRED_SCHEMA, String(api?.schema ?? api?.message ?? 'sin respuesta'));
  } else {
    list.info(`contrato de esquema (${label})`, 'el origen todavía no tiene app_status: migración pendiente');
  }
  const [rls] = await db.unsafe(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`);
  list.check(`RLS activo en todas las tablas (${label})`, rls.n === 0, `${rls.n} sin RLS`);
  const [policies] = await db.unsafe(`select count(*)::int as n from pg_policies where schemaname = 'storage' and tablename = 'objects'`);
  list.check(`políticas de Storage presentes (${label})`, policies.n > 0, `${policies.n} políticas`);
  // Una visita contra la API: ve el catálogo, no los pedidos.
  const businesses = await (await fetch(`${status.API_URL}/rest/v1/businesses?select=id&status=eq.active`, { headers })).json();
  const [{ active }] = await db.unsafe(`select count(*)::int as active from public.businesses where status = 'active'`);
  list.check(`la API sirve el catálogo publicado (${label})`, Array.isArray(businesses) && businesses.length === active,
    `${Array.isArray(businesses) ? businesses.length : 'error'} de ${active}`);
  const orders = await (await fetch(`${status.API_URL}/rest/v1/orders?select=id&limit=1`, { headers })).json().catch(() => []);
  list.check(`la API no expone pedidos a una visita (${label})`, !(Array.isArray(orders) && orders.length));
}

// Ensayo: copia de los datos reales → stack con las migraciones que hoy tiene
// el proyecto → aplicar las pendientes → verificar. Si algo falla acá, no se
// toca producción.
export async function rehearseMigration(t, list, { applied, pending }) {
  const out = await mkdtemp(join(tmpdir(), 'cauce-ensayo-'));
  try {
    const source = await dumpDatabase(t, out, list);
    return await withTempStack({ migrations: applied, projectId: 'cauce-ensayo' }, async stack => {
      if (!await loadData(stack, source, list)) return false;
      for (const file of pending) await cp(join(root, 'supabase', 'migrations', file), join(stack.work, 'supabase', 'migrations', file));
      const pushed = stack.cli(['db', 'push', '--local', '--yes']);
      list.check('la migración pendiente se aplica sobre la copia de los datos reales', pushed.status === 0,
        pushed.status === 0 ? pending.join(', ') : redact(`${pushed.stdout}${pushed.stderr}`).slice(-400));
      if (pushed.status !== 0) return false;
      const after = toCounts(await stack.db.unsafe(COUNT_SQL));
      const { compared, mismatches } = compareCounts(source.counts, after, source.dumped,
        { allowGrowth: ['private.order_transitions', 'private.platform_features'] });
      list.check('la migración conserva todas las filas', mismatches.length === 0,
        mismatches.length ? mismatches.map(name => `${name}: ${source.counts[name]} → ${after[name]}`).join('; ') : `${compared.length} tablas`);
      await verifyDatabase(stack, list, { label: 'ensayo' });
      return list.failed === 0;
    });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

// Copia externa cifrada; lo que no se cifra no sale de la máquina.
async function encryptCopy(t, out, stamp, list) {
  const passphrase = process.env.CAUCE_BACKUP_PASSPHRASE;
  if (!passphrase || passphrase.length < 16) {
    list.info('copia externa', 'sin CAUCE_BACKUP_PASSPHRASE (16+ caracteres) no se guarda la copia: sólo la prueba de restauración');
    return;
  }
  const archive = join(root, 'backup', `cauce-${t.ref}-${stamp}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', out, 'schema.sql', 'data.sql', 'conteos.json']);
  const encrypted = spawnSync('gpg', ['--batch', '--yes', '--symmetric', '--cipher-algo', 'AES256',
    '--passphrase-fd', '0', '-o', `${archive}.gpg`, archive], { input: passphrase, encoding: 'utf8' });
  await rm(archive, { force: true });
  list.check('copia cifrada (AES-256) lista para guardar fuera de Supabase', encrypted.status === 0, `${archive.split('/').pop()}.gpg`);
}

export async function backup(t, list) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = join(root, 'backup', stamp);

  // 1. Lo que ofrece la plataforma.
  if (!t.local) {
    const project = await t.management('');
    const org = await t.management(`/v1/organizations/${project.organization_id}`).catch(() => null);
    const info = await t.management('/database/backups');
    const done = (info.backups || []).filter(item => item.status === 'COMPLETED')
      .map(item => item.inserted_at).sort();
    const latest = done.at(-1);
    const fresh = latest && Date.now() - Date.parse(latest) < 48 * 3600 * 1000;
    list.check('BACKUP_AVAILABLE · backups automáticos de Supabase', Boolean(fresh),
      `${done.length} completos · último ${latest || '—'}`);
    list.info('BACKUP_FREQUENCY', info.pitr_enabled ? 'continua (PITR)' : done.length > 1 ? 'diaria' : 'sin historial suficiente');
    list.info('BACKUP_RETENTION', `${info.pitr_enabled ? 'PITR habilitado · ' : ''}plan ${org?.plan || 'desconocido'}: ${PLAN_RETENTION[org?.plan] || 'ver dashboard'}`);
  }

  // 2. Dump y 3. copia cifrada: existe aunque después falle la prueba.
  const source = await dumpDatabase(t, out, list);
  try {
    await encryptCopy(t, out, stamp, list);

    // 4. Restauración en un stack nuevo con las migraciones que tiene el
    // origen (un backup previo a migrar se restaura en su versión).
    const files = await migrationFiles();
    const versions = (await t.sql('select version from supabase_migrations.schema_migrations order by version'))
      .map(row => String(row.version));
    const unknown = versions.filter(version => !files.some(file => file.startsWith(`${version}_`)));
    if (unknown.length) {
      list.fail('el historial del origen está en el repo', `migraciones desconocidas: ${unknown.join(', ')}`);
      return;
    }
    const migrations = files.filter(file => versions.includes(file.split('_')[0]));
    const pending = files.filter(file => !migrations.includes(file));
    if (pending.length) {
      list.info('restauración en la versión del origen', `${migrations.length} de ${files.length} migraciones · pendientes: ${pending.join(', ')}`);
    }
    const [{ contract }] = await t.sql(`select to_regprocedure('public.app_status()') is not null as contract`);
    await withTempStack({ migrations }, async stack => {
      if (!await loadData(stack, source, list)) return;
      const restored = toCounts(await stack.db.unsafe(COUNT_SQL));
      const { compared, mismatches } = compareCounts(source.counts, restored, source.dumped);
      list.check('las filas restauradas coinciden con el origen', compared.length > 0 && mismatches.length === 0,
        mismatches.length ? mismatches.map(name => `${name}: ${source.counts[name]} → ${restored[name]}`).join('; ')
          : `${compared.length} tablas comparadas`);
      // Desvío de esquema: lo restaurado (migraciones del origen) contra el origen.
      const restoredSchema = join(out, 'schema-restaurado.sql');
      const dumpRestored = stack.cli(['db', 'dump', '--local', '-f', restoredSchema]);
      if (dumpRestored.status !== 0) list.fail('dump del esquema restaurado', redact(dumpRestored.stderr).slice(-300));
      else {
        const a = normalizeSchema(await readFile(source.schemaFile, 'utf8')).split('\n');
        const b = normalizeSchema(await readFile(restoredSchema, 'utf8')).split('\n');
        const setA = new Set(a);
        const setB = new Set(b);
        const onlySource = a.filter(line => !setB.has(line));
        const onlyRestored = b.filter(line => !setA.has(line));
        list.check('el esquema de origen coincide con las migraciones', onlySource.length === 0 && onlyRestored.length === 0,
          onlySource.length || onlyRestored.length
            ? `sólo en el origen (${onlySource.length}): ${onlySource.slice(0, 8).join(' | ') || '—'} · sólo en migraciones (${onlyRestored.length}): ${onlyRestored.slice(0, 8).join(' | ') || '—'}`
            : 'idéntico');
      }
      // Y lo pendiente sobre la copia restaurada: lo mismo que después aplica
      // `migrar` en el proyecto, ensayado con sus propios datos.
      let ready = Boolean(contract);
      if (pending.length) {
        for (const file of pending) await cp(join(root, 'supabase', 'migrations', file), join(stack.work, 'supabase', 'migrations', file));
        const pushed = stack.cli(['db', 'push', '--local', '--yes']);
        list.check('las migraciones pendientes se aplican sobre la base restaurada', pushed.status === 0,
          pushed.status === 0 ? pending.join(', ') : redact(`${pushed.stdout}${pushed.stderr}`).slice(-300));
        ready = ready || pushed.status === 0;
      }
      await verifyDatabase(stack, list, { contract: ready });
      if (list.failed === 0) list.pass('RESTORE_TEST', 'dump → stack nuevo con las migraciones del origen → datos → verificación');
    });
  } finally {
    // Del proyecto real sólo queda la copia cifrada.
    if (!t.local) await rm(out, { recursive: true, force: true });
  }
}
