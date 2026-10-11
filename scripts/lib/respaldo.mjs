// Respaldo lógico de CAUCE · Ferias, prueba de restauración y ensayo de
// migraciones sobre una copia de los datos reales (portado de Aluminé).
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
// pero sí cuentas (con contraseñas hasheadas), pedidos y la comunidad
// fundadora: sólo sale de la máquina cifrado con FERIAS_BACKUP_PASSPHRASE. Lo
// que no se cifra queda en una carpeta temporal y se borra al terminar.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { CONFIG } from '../../js/config.js';
import { ROOT, log, migrationFiles, redact, supabaseCli } from './proyecto.mjs';
import { adaptDump, compareSchemas, parseDump, quoted } from './volcado.mjs';

const root = ROOT;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
export const BUCKET = 'ferias-media';
export const REQUIRED_SCHEMA = CONFIG.requiredSchema;

// Estado transitorio de Auth y Storage: no hace falta para volver a operar y
// es lo más sensible (sesiones y tokens vigentes). También las tablas de
// MFA, SSO, OAuth, SCIM y WebAuthn, que Ferias no usa (si algún día se habilita
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

// Stacks temporales: project_id y puertos propios (+1000 y +1010 sobre los de
// Ferias, 55420–55429 → 56420–56439), que no chocan ni con el stack local de
// Ferias ni con el de Aluminé (5432x) ni con sus stacks temporales (5532x).
export const TEMP_STACKS = {
  restauracion: { projectId: 'cauce-ferias-restauracion', offset: 1000 },
  ensayo: { projectId: 'cauce-ferias-ensayo', offset: 1010 },
};

export const COUNT_SQL = `select table_schema || '.' || table_name as name,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as n
  from information_schema.tables
  where table_type = 'BASE TABLE' and (table_schema in ('public', 'private')
    or (table_schema, table_name) in (('auth', 'users'), ('auth', 'identities'), ('storage', 'buckets'), ('storage', 'objects')))
  order by 1`;
const toCounts = rows => Object.fromEntries(rows.map(row => [row.name, Number(row.n)]));

export function tempConfig(source, offset, projectId) {
  return source
    .replace(/^project_id = ".*"$/m, `project_id = "${projectId}"`)
    .replace(/^(\s*(?:shadow_)?port = )(5\d{4})$/gm, (_, key, port) => `${key}${Number(port) + offset}`)
    .replace(/^(\s*inspector_port = )(\d+)$/m, (_, key, port) => `${key}${Number(port) + offset}`)
    .replace(/^site_url = .*$/m, `site_url = "http://127.0.0.1:${4274 + offset}"`);
}

// Dump del origen: conteos, esquema y datos sin estado transitorio.
export async function dumpDatabase(t, out, list) {
  await mkdir(out, { recursive: true });
  const counts = toCounts(await t.sql(COUNT_SQL));
  await writeFile(join(out, 'conteos.json'), JSON.stringify(counts, null, 2));
  list.info('filas en el origen', `${Object.keys(counts).length} tablas · ${counts['public.businesses'] ?? 0} tiendas · ${counts['public.products'] ?? 0} productos · ${counts['public.fairs'] ?? 0} ferias · ${counts['public.orders'] ?? 0} pedidos · ${counts['auth.users'] ?? 0} cuentas · ${counts['storage.objects'] ?? 0} archivos`);
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
export async function withTempStack({ migrations, kind = 'restauracion' }, fn) {
  const { projectId, offset } = TEMP_STACKS[kind];
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
    log(`\nLevantando un stack temporal (${projectId}, puertos +${offset}, ${migrations.length} migraciones)…`);
    const excluded = ['imgproxy', 'studio', 'edge-runtime', 'logflare', 'vector', 'supavisor', 'postgres-meta', 'mailpit', 'realtime'];
    const started = cli(['start', '-x', excluded.join(',')]);
    if (started.status !== 0) throw new Error(`no arrancó el stack temporal: ${redact(`${started.stdout}${started.stderr}`).slice(-400)}`);
    const raw = cli(['status', '-o', 'json']).stdout;
    const status = JSON.parse(raw.slice(raw.indexOf('{')));
    if (!['127.0.0.1', 'localhost'].includes(new URL(status.DB_URL).hostname)) throw new Error('El stack temporal no es local.');
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
  if (load.error) list.fail('los datos se restauran sin errores', `no se pudo ejecutar psql: ${load.error.message}`);
  else list.check('los datos se restauran sin errores', load.status === 0,
    redact(load.stderr || '').trim().slice(0, 300) || `${adapted.tables.length} tablas`);
  return load.status === 0;
}

export function compareCounts(before, after, dumped, { allowGrowth = [] } = {}) {
  const compared = dumped.filter(name => name in before);
  const mismatches = compared.filter(name => allowGrowth.includes(name)
    ? !(after[name] >= before[name]) : after[name] !== before[name]);
  return { compared, mismatches };
}

// Lo que tiene que valer en cualquier base restaurada o migrada de Ferias.
// Sin `contract`, la base es anterior a la migración que exige esta interfaz
// (un backup tomado antes de migrar): el contrato se informa, no se exige.
export async function verifyDatabase({ db, status }, list, { label = 'restaurada', contract = true } = {}) {
  const headers = { apikey: status.PUBLISHABLE_KEY || status.ANON_KEY, 'Content-Type': 'application/json' };
  const [row] = await db.unsafe(`select case when to_regprocedure('public.app_status()') is null then null
    else (public.app_status() ->> 'schema')::bigint end as schema`);
  const api = await (await fetch(`${status.API_URL}/rest/v1/rpc/app_status`, { method: 'POST', headers, body: '{}' })).json().catch(() => null);
  if (contract) {
    list.check(`el contrato de esquema responde (${label})`, Number(row.schema) >= REQUIRED_SCHEMA, `${row.schema} (se necesita ${REQUIRED_SCHEMA})`);
    list.check(`la API publica el contrato (${label})`, Number(api?.schema) >= REQUIRED_SCHEMA, String(api?.schema ?? api?.message ?? 'sin respuesta'));
  } else {
    list.info(`contrato de esquema (${label})`, `${row.schema ?? 'sin app_status'}: el origen todavía tiene migraciones pendientes`);
  }
  const [rls] = await db.unsafe(`select count(*)::int as n, coalesce(string_agg(n.nspname || '.' || c.relname, ', '), '') as names
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`);
  list.check(`RLS activo en todas las tablas (${label})`, rls.n === 0, rls.n ? `sin RLS: ${rls.names}` : 'todas');
  const [policies] = await db.unsafe(`select count(*)::int as n from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%${BUCKET}%'`);
  list.check(`políticas de Storage de ${BUCKET} presentes (${label})`, policies.n > 0, `${policies.n} políticas`);
  const [bucket] = await db.unsafe(`select count(*)::int as n from storage.buckets where id = '${BUCKET}'`);
  list.check(`bucket ${BUCKET} presente (${label})`, bucket.n === 1);
  // Una visita contra la API ve lo mismo que RLS le deja ver a anon en SQL, y nada privado.
  for (const table of ['businesses', 'products', 'fairs']) {
    const visible = await db.begin(async tx => {
      await tx.unsafe(`set local role anon; set local request.jwt.claims = '{"role":"anon"}'`);
      return (await tx.unsafe(`select count(*)::int as n from public.${table}`))[0].n;
    });
    const response = await fetch(`${status.API_URL}/rest/v1/${table}?select=id`, { headers });
    const body = await response.json().catch(() => null);
    list.check(`la API sirve ${table} publicados a una visita (${label})`, Array.isArray(body) && body.length === visible,
      `${Array.isArray(body) ? body.length : `HTTP ${response.status}`} de ${visible}`);
  }
  for (const table of ['orders', 'founding_applications', 'platform_admins']) {
    const response = await fetch(`${status.API_URL}/rest/v1/${table}?select=*&limit=1`, { headers });
    const body = await response.json().catch(() => null);
    list.check(`la API no expone ${table} a una visita (${label})`, !(response.ok && Array.isArray(body) && body.length), `HTTP ${response.status}`);
  }
}

// Ensayo: copia de los datos reales → stack con las migraciones que hoy tiene
// el proyecto → aplicar las pendientes → verificar. Si algo falla acá, no se
// toca el proyecto.
export async function rehearseMigration(t, list, { applied, pending }) {
  const out = await mkdtemp(join(tmpdir(), 'cauce-ferias-ensayo-datos-'));
  const failedBefore = list.failed;
  try {
    const source = await dumpDatabase(t, out, list);
    return await withTempStack({ migrations: applied, kind: 'ensayo' }, async stack => {
      if (!await loadData(stack, source, list)) return false;
      if (pending.length) {
        for (const file of pending) await cp(join(root, 'supabase', 'migrations', file), join(stack.work, 'supabase', 'migrations', file));
        const pushed = stack.cli(['db', 'push', '--local', '--yes']);
        list.check('las migraciones pendientes se aplican sobre la copia de los datos reales', pushed.status === 0,
          pushed.status === 0 ? pending.join(', ') : redact(`${pushed.stdout}${pushed.stderr}`).slice(-400));
        if (pushed.status !== 0) return false;
      } else {
        list.info('ensayo sin migraciones pendientes', 'se verifica la copia restaurada tal cual');
      }
      const after = toCounts(await stack.db.unsafe(COUNT_SQL));
      // Las migraciones pueden sembrar datos de referencia (interruptores, rubros, planes).
      const { compared, mismatches } = compareCounts(source.counts, after, source.dumped,
        { allowGrowth: ['private.platform_features', 'public.localities', 'public.categories', 'public.plans'] });
      list.check('la migración conserva todas las filas', mismatches.length === 0,
        mismatches.length ? mismatches.map(name => `${name}: ${source.counts[name]} → ${after[name]}`).join('; ') : `${compared.length} tablas`);
      await verifyDatabase(stack, list, { label: 'ensayo' });
      return list.failed === failedBefore;
    });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

// Archivos del bucket: el manifiesto siempre; con `photos`, también los archivos
// (se bajan por la URL pública del bucket y se comprueba tamaño y suma).
export async function storageManifest(t, out, list, { photos = false } = {}) {
  const rows = await t.sql(`select name, coalesce((metadata ->> 'size')::bigint, 0) as size, metadata ->> 'mimetype' as mimetype,
      metadata ->> 'eTag' as etag, updated_at::text as updated_at
    from storage.objects where bucket_id = '${BUCKET}' order by name`);
  const objects = rows.map(row => ({ name: row.name, size: Number(row.size), mimetype: row.mimetype, etag: row.etag, updated_at: row.updated_at }));
  const total = objects.reduce((sum, item) => sum + item.size, 0);
  list.info(`archivos de ${BUCKET}`, `${objects.length} objetos · ${(total / 1048576).toFixed(1)} MiB`);
  if (photos) {
    let bad = 0;
    for (const item of objects) {
      if (!/^[A-Za-z0-9/_.-]+$/.test(item.name) || item.name.includes('..')) { bad += 1; item.error = 'nombre inesperado'; continue; }
      const response = await fetch(`${t.url}/storage/v1/object/public/${BUCKET}/${item.name}`);
      if (!response.ok) { bad += 1; item.error = `HTTP ${response.status}`; continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      item.sha256 = createHash('sha256').update(bytes).digest('hex');
      if (item.size && bytes.length !== item.size) { bad += 1; item.error = `tamaño ${bytes.length} ≠ ${item.size}`; }
      const file = join(out, 'fotos', item.name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    list.check(`archivos de ${BUCKET} descargados y verificados`, bad === 0, `${objects.length - bad} de ${objects.length}`);
  } else {
    list.info('fotos', 'sólo el manifiesto (con --fotos se descargan y van dentro de la copia cifrada)');
  }
  await writeFile(join(out, 'storage-manifiesto.json'), JSON.stringify({ bucket: BUCKET, photos, total_bytes: total, objects }, null, 2));
  return { objects, total };
}

// Copia cifrada (AES-256); lo que no se cifra no sale de la máquina. Después
// se prueba descifrarla y listar su contenido.
async function encryptCopy(t, out, stamp, list, files) {
  const passphrase = process.env.FERIAS_BACKUP_PASSPHRASE;
  if (!passphrase || passphrase.length < 16) {
    list.fail('copia cifrada', 'falta FERIAS_BACKUP_PASSPHRASE (16+ caracteres): sin ella no se guarda la copia');
    return null;
  }
  await mkdir(join(root, 'backup'), { recursive: true });
  const archive = join(out, `cauce-ferias-${t.ref}-${stamp}.tar.gz`);
  const encrypted = join(root, 'backup', `${archive.split('/').pop()}.gpg`);
  const tar = spawnSync('tar', ['-czf', archive, '-C', out, ...files], { encoding: 'utf8' });
  if (tar.status !== 0) { list.fail('copia cifrada', `tar: ${tar.stderr.slice(-200)}`); return null; }
  const gpg = spawnSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--symmetric', '--cipher-algo', 'AES256',
    '--passphrase-fd', '0', '-o', encrypted, archive], { input: passphrase, encoding: 'utf8' });
  await rm(archive, { force: true });
  if (gpg.status !== 0) { list.fail('copia cifrada (AES-256)', redact(gpg.stderr).slice(-200)); return null; }
  // Prueba: descifrar a memoria y listar el contenido.
  const decrypted = spawnSync('gpg', ['--batch', '--quiet', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--decrypt', encrypted],
    { input: passphrase, maxBuffer: 1024 * 1024 * 1024 });
  const listed = decrypted.status === 0
    ? spawnSync('tar', ['-tzf', '-'], { input: decrypted.stdout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\n').filter(Boolean)
    : [];
  const complete = files.every(name => listed.some(entry => entry === name || entry.startsWith(`${name}/`)));
  list.check('copia cifrada (AES-256) que se descifra y trae todo', complete,
    `backup/${encrypted.split('/').pop()} · ${listed.length} entradas`);
  return complete ? encrypted : null;
}

export async function backup(t, list, { photos = false } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Lo que no está cifrado vive en una carpeta temporal privada y se borra al final.
  const out = await mkdtemp(join(tmpdir(), 'cauce-ferias-respaldo-'));
  try {
    // 1. Lo que ofrece la plataforma.
    if (!t.local) {
      const info = await t.management('/database/backups').catch(error => ({ error: error.message }));
      if (info.error) list.info('backups automáticos de Supabase', `no consultables: ${info.error}`);
      else {
        const done = (info.backups || []).filter(item => item.status === 'COMPLETED').map(item => item.inserted_at).sort();
        list.info('backups automáticos de Supabase', `${done.length} completos · último ${done.at(-1) || '—'} · PITR ${info.pitr_enabled ? 'sí' : 'no'}`);
      }
    }

    // 2. Dump, manifiesto de Storage y copia cifrada: existe aunque después falle la prueba.
    const source = await dumpDatabase(t, out, list);
    await storageManifest(t, out, list, { photos });
    const files = ['schema.sql', 'data.sql', 'conteos.json', 'storage-manifiesto.json', ...(photos ? ['fotos'] : [])];
    if (photos) await mkdir(join(out, 'fotos'), { recursive: true });
    await encryptCopy(t, out, stamp, list, files);

    // 3. Restauración en un stack nuevo con las migraciones que tiene el
    // origen (un backup previo a migrar se restaura en su versión).
    const repo = await migrationFiles();
    const versions = (await t.sql('select version from supabase_migrations.schema_migrations order by version'))
      .map(row => String(row.version));
    const unknown = versions.filter(version => !repo.some(file => file.startsWith(`${version}_`)));
    if (unknown.length) {
      list.fail('el historial del origen está en el repo', `migraciones desconocidas: ${unknown.join(', ')}`);
      return;
    }
    const migrations = repo.filter(file => versions.includes(file.split('_')[0]));
    const pending = repo.filter(file => !migrations.includes(file));
    if (pending.length) {
      list.info('restauración en la versión del origen', `${migrations.length} de ${repo.length} migraciones · pendientes: ${pending.join(', ')}`);
    }
    const failedBefore = list.failed;
    await withTempStack({ migrations }, async stack => {
      if (!await loadData(stack, source, list)) return;
      const restored = toCounts(await stack.db.unsafe(COUNT_SQL));
      const { compared, mismatches } = compareCounts(source.counts, restored, source.dumped);
      list.check('las filas restauradas coinciden con el origen', compared.length > 0 && mismatches.length === 0,
        mismatches.length ? mismatches.map(name => `${name}: ${source.counts[name]} → ${restored[name]}`).join('; ')
          : `${compared.length} tablas comparadas`);
      // Desvío de esquema: lo restaurado (migraciones del origen) contra el origen.
      const restoredSchema = join(out, 'schema-restaurado.sql');
      const dumped = stack.cli(['db', 'dump', '--local', '-f', restoredSchema]);
      if (dumped.status !== 0) list.fail('dump del esquema restaurado', redact(`${dumped.stdout}${dumped.stderr}`).slice(-300));
      else {
        const { platform, onlySource, onlyRestored } = compareSchemas(await readFile(source.schemaFile, 'utf8'),
          await readFile(restoredSchema, 'utf8'));
        if (platform.length) list.info('privilegios que fija Supabase, no las migraciones', `${platform.length} diferencias de service_role`);
        list.check('el esquema de origen coincide con las migraciones', onlySource.length === 0 && onlyRestored.length === 0,
          onlySource.length || onlyRestored.length
            ? `sólo en el origen (${onlySource.length}): ${onlySource.slice(0, 8).join(' | ') || '—'} · sólo en migraciones (${onlyRestored.length}): ${onlyRestored.slice(0, 8).join(' | ') || '—'}`
            : 'idéntico');
      }
      await verifyDatabase(stack, list, { contract: pending.length === 0 });
      if (list.failed === failedBefore) list.pass('RESTORE_TEST', 'dump → stack nuevo con las migraciones del origen → datos → verificación');
    });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
