// Operación del proyecto CAUCE real, paso por paso. Cada paso verifica antes y
// después, se detiene ante cualquier diferencia inesperada y nunca imprime
// secretos. Sin --aplicar sólo informa qué haría.
//
// Lo corre el workflow "Operación de producción" con los secretos del
// repositorio, o quien opera desde su terminal:
//
//   SUPABASE_ACCESS_TOKEN=… node scripts/operacion.mjs estado
//   node scripts/operacion.mjs migrar [--aplicar]
//   node scripts/operacion.mjs auth [--aplicar]
//   node scripts/operacion.mjs correo              confirmación y recuperación con entrega real
//   node scripts/operacion.mjs admin --email x@y [--invitar] [--aplicar]
//   node scripts/operacion.mjs backup              dump, restauración de prueba y copia cifrada
//   node scripts/operacion.mjs limpiar-qa [--aplicar]   residuo de pruebas (cuentas cauce-qa-…)
//   node scripts/operacion.mjs registros [--horas 3]    5xx y errores de cada servicio (Logs Explorer)
//   node scripts/operacion.mjs pagos-estado             funciones, secretos (sólo nombres), pilotos y cuentas
//   node scripts/operacion.mjs pagos-funciones [--aplicar]  despliega las Edge Functions de pagos (cerradas)
//   node scripts/operacion.mjs pagos-limpiar [--aplicar]    saca pilotos, credenciales y comercios QA de pagos
//   node scripts/operacion.mjs pagos-sandbox --aplicar [--modo automatico|asistido|mixto]
//        Mercado Pago real en modo de prueba de punta a punta (cuentas y tarjetas de prueba) y limpieza
//
// --local ensaya el mismo paso contra el stack de `npx supabase start`.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { REQUIRED_SCHEMA } from '../js/core/contract.js';
import {
  PROJECT, SITE_URL, MissingCredential, checklist, hide, log, maskEmail, migrationFiles, redact, safeEmail,
  supabaseCli, target,
} from './lib/proyecto.mjs';
import { disposableInbox, mailpitInbox, tokenLink } from './lib/casilla.mjs';
import { backup, rehearseMigration } from './lib/respaldo.mjs';
import { pagosEstado, pagosFunciones, pagosLimpiar } from './lib/pagos.mjs';
import { pagosSandbox } from './lib/pagos-sandbox.mjs';

const args = process.argv.slice(2);
const step = args[0];
const flag = name => args.includes(`--${name}`);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const apply = flag('aplicar');
const local = flag('local');
// Ensayos: un stack local cualquiera como si fuera el proyecto (sólo 127.0.0.1).
const custom = option('db-url') ? {
  dbUrl: option('db-url'), url: option('api-url'), publishableKey: option('publishable'), serviceKey: option('service'),
} : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = (url, key) => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// ───────────────────────── comprobaciones reutilizables ─────────────────────────

async function remoteVersions(t) {
  const rows = await t.sql('select version from supabase_migrations.schema_migrations order by version');
  return rows.map(row => String(row.version));
}

async function migrationState(t) {
  const files = await migrationFiles();
  const localVersions = files.map(file => file.split('_')[0]);
  const remote = await remoteVersions(t);
  return {
    files, localVersions, remote,
    pending: files.filter(file => !remote.includes(file.split('_')[0])),
    unknown: remote.filter(version => !localVersions.includes(version)),
  };
}

// La configuración de Auth que CAUCE necesita para usuarios reales.
export function authChecks(config, siteUrl = SITE_URL) {
  const allow = String(config.uri_allow_list || '').split(',').map(item => item.trim()).filter(Boolean);
  const localish = value => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(value);
  return [
    ['site_url es el sitio real', config.site_url === siteUrl, config.site_url || '(vacío)'],
    ['URLs de retorno sólo del sitio real', allow.length > 0 && allow.every(item => item.startsWith(siteUrl) && !localish(item)),
      allow.join(', ') || '(vacía)'],
    ['registro de cuentas habilitado', config.disable_signup === false],
    ['correo y contraseña habilitados', config.external_email_enabled === true],
    ['confirmación de correo obligatoria', config.mailer_autoconfirm === false],
    ['compra sin cuenta (sesiones anónimas)', config.external_anonymous_users_enabled === true],
    ['SMTP propio', Boolean(config.smtp_host) && Boolean(config.smtp_admin_email),
      config.smtp_host ? `${config.smtp_host}:${config.smtp_port} · remitente ${config.smtp_admin_email}` : 'sin SMTP'],
    ['plantillas de CAUCE con token_hash', /token_hash/.test(config.mailer_templates_recovery_content || '')
      && /token_hash/.test(config.mailer_templates_confirmation_content || '')],
    ['rotación de refresh tokens', config.refresh_token_rotation_enabled === true],
    ['contraseña de 10+ caracteres', Number(config.password_min_length) >= 10, String(config.password_min_length)],
    ['contraseña con letras y números', /[a-z]/.test(config.password_required_characters || '')
      && /0123456789/.test(config.password_required_characters || ''), config.password_required_characters ? 'sí' : 'sin requisito'],
    ['enlaces de correo vencen en ≤ 1 h', Number(config.mailer_otp_exp) > 0 && Number(config.mailer_otp_exp) <= 3600,
      `${config.mailer_otp_exp} s`],
  ];
}

// Con `authPending` (dentro de migrar), la compra sin cuenta todavía apagada
// es lo esperado: se habilita en el paso auth, recién con la migración que
// limita a las sesiones anónimas ya aplicada.
async function publicSmoke(t, list, { authPending = false } = {}) {
  const headers = { apikey: t.publishableKey, 'Content-Type': 'application/json' };
  const status = await (await fetch(`${t.url}/rest/v1/rpc/app_status`, { method: 'POST', headers, body: '{}' })).json().catch(() => null);
  list.check('app_status responde con el esquema requerido', Number(status?.schema) >= REQUIRED_SCHEMA,
    status ? `esquema ${status.schema} · verticales ${JSON.stringify(status.features)}` : 'sin respuesta');
  const settings = await (await fetch(`${t.url}/auth/v1/settings`, { headers })).json();
  list.check('Auth público: confirmación obligatoria', settings.mailer_autoconfirm === false);
  if (authPending && settings.external?.anonymous_users !== true) {
    list.info('Auth público: compra sin cuenta', 'todavía deshabilitada: la habilita el paso auth, después de migrar');
  } else {
    list.check('Auth público: compra sin cuenta habilitada', settings.external?.anonymous_users === true);
  }
  const closed = [];
  for (const table of ['orders', 'order_items', 'order_events', 'profiles', 'business_contacts', 'business_memberships',
    'business_riders', 'drivers', 'trips']) {
    const response = await fetch(`${t.url}/rest/v1/${table}?select=*&limit=1`, { headers });
    const body = await response.json().catch(() => null);
    if (!(response.ok && Array.isArray(body) && body.length)) closed.push(table);
  }
  list.check('una visita no lee datos privados', closed.length === 9, `${closed.length}/9 tablas cerradas`);
  const catalog = await fetch(`${t.url}/rest/v1/businesses?select=id,name,open_now&limit=5`, { headers });
  list.check('catálogo público legible', catalog.ok, `HTTP ${catalog.status}`);
  const write = await fetch(`${t.url}/rest/v1/orders`, { method: 'POST', headers, body: JSON.stringify({ total_ars: 1 }) });
  list.check('una visita no escribe pedidos', !write.ok, `HTTP ${write.status}`);
  const upload = await fetch(`${t.url}/storage/v1/object/business-media/qa/intruso.txt`, {
    method: 'POST', headers: { apikey: t.publishableKey, Authorization: `Bearer ${t.publishableKey}`, 'Content-Type': 'text/plain' },
    body: 'x',
  });
  list.check('una visita no sube archivos a Storage', !upload.ok, `HTTP ${upload.status}`);
  // Realtime: una visita se suscribe a pedidos y no recibe nada (RLS).
  const visitor = client(t.url, t.publishableKey);
  const joined = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('sin confirmación'), 20000);
    visitor.channel(`qa-${randomBytes(3).toString('hex')}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {})
      .subscribe(state => { if (state === 'SUBSCRIBED') { clearTimeout(timer); resolve(state); } });
  });
  list.check('Realtime acepta suscripciones', joined === 'SUBSCRIBED', joined);
  await visitor.removeAllChannels();
  visitor.realtime.disconnect();
}

// ───────────────────────── pasos ─────────────────────────

async function estado(t, list) {
  if (!t.local) {
    const project = await t.management('');
    list.check('proyecto activo', project.status === 'ACTIVE_HEALTHY', `${project.name} · ${project.region} · ${project.status}`);
    const org = await t.management(`/v1/organizations/${project.organization_id}`).catch(() => null);
    list.info('plan de la organización', org?.plan || 'desconocido');
  }
  const state = await migrationState(t);
  list.info('migraciones', `${state.files.length} en el repo · ${state.remote.length} aplicadas · pendientes: ${state.pending.join(', ') || 'ninguna'}`);
  list.check('historial remoto sin migraciones ajenas al repo', state.unknown.length === 0, state.unknown.join(', ') || 'ok');
  if (!t.local) {
    const config = await t.management('/config/auth');
    for (const [label, ok, detail] of authChecks(config)) list.check(`Auth: ${label}`, ok, detail || '');
    const backups = await t.management('/database/backups').catch(error => ({ error: error.message }));
    if (backups.error) list.fail('backups consultables', backups.error);
    else {
      const done = (backups.backups || []).filter(item => item.status === 'COMPLETED');
      list.info('backups', `${done.length} completos · último ${done.map(item => item.inserted_at).sort().at(-1) || '—'} · PITR ${backups.pitr_enabled ? 'sí' : 'no'}`);
    }
  }
  await publicSmoke(t, list);
}

async function migrar(t, list) {
  // La única migración pendiente admitida es la del contrato que exige este
  // frontend (js/core/contract.js): sin publicar código que la necesite, no se
  // migra nada, y nunca más de una a la vez.
  const expected = option('esperada') || String(REQUIRED_SCHEMA);
  t.link();
  const before = await migrationState(t);
  log('\nHistorial según la CLI:');
  supabaseCli(['migration', 'list', ...t.cliTarget], { allowFail: true });
  if (before.unknown.length) {
    list.fail('historial remoto coincide con el repo', `el proyecto tiene migraciones que el repo no conoce: ${before.unknown.join(', ')}. STOP.`);
    return;
  }
  if (!before.pending.length) {
    list.pass('migraciones al día', `${before.remote.length} aplicadas`);
    await publicSmoke(t, list, { authPending: true });
    return;
  }
  const pendingVersions = before.pending.map(file => file.split('_')[0]);
  if (pendingVersions.length !== 1 || pendingVersions[0] !== expected) {
    list.fail('sólo falta la migración esperada', `pendientes: ${before.pending.join(', ')}; se esperaba sólo ${expected}. STOP.`);
    return;
  }
  list.pass('sólo falta la migración esperada', before.pending[0]);
  log('\nDry-run de la CLI:');
  const dry = supabaseCli(['db', 'push', ...t.cliTarget, '--dry-run'], { allowFail: true });
  // La CLI lista las migraciones dos veces (JSON y texto): se cuentan una vez.
  const listed = [...new Set([...dry.output.matchAll(/(\d{14})_[\w-]+\.sql/g)].map(match => match[1]))];
  const sameSet = listed.length === 1 && listed[0] === expected;
  list.check('el dry-run muestra únicamente la migración esperada', dry.code === 0 && sameSet,
    listed.length ? listed.join(', ') : 'no listó migraciones');
  if (!(dry.code === 0 && sameSet)) return;
  if (!apply) { list.info('sin --aplicar', 'no se aplicó nada'); return; }
  // Antes de tocar producción: la misma migración sobre una copia de sus datos,
  // en un stack descartable con las migraciones que el proyecto ya tiene.
  log('\nEnsayo sobre una copia de los datos:');
  const applied = before.files.filter(file => before.remote.includes(file.split('_')[0]));
  const rehearsed = await rehearseMigration(t, list, { applied, pending: before.pending });
  if (!rehearsed) { list.fail('ensayo previo', 'la migración no pasó el ensayo: no se tocó el proyecto. STOP.'); return; }
  log('\nAplicando:');
  supabaseCli(['db', 'push', ...t.cliTarget, '--yes']);
  const after = await migrationState(t);
  list.check('local y remoto sincronizados', after.pending.length === 0 && after.unknown.length === 0,
    `${after.remote.length} aplicadas`);
  supabaseCli(['migration', 'list', ...t.cliTarget], { allowFail: true });
  await publicSmoke(t, list, { authPending: true });
}

async function auth(t, list) {
  if (t.local) throw new Error('El paso auth configura el proyecto real (en local rige supabase/config.toml).');
  const run = spawnSync(process.execPath, ['scripts/configure-auth.mjs', ...(apply ? ['--apply'] : [])], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env: process.env,
  });
  log(redact(`${run.stdout || ''}${run.stderr || ''}`).trim().split('\n').map(line => `    ${line}`).join('\n'));
  list.check(apply ? 'configuración de Auth aplicada' : 'plan de configuración de Auth', run.status === 0, `código ${run.status}`);
  const config = await t.management('/config/auth');
  for (const [label, ok, detail] of authChecks(config)) list.check(`Auth: ${label}`, ok, detail || '');
}

async function correo(t, list) {
  if (!t.local) {
    const config = await t.management('/config/auth');
    if (!config.smtp_host) {
      list.fail('SMTP propio configurado', 'sin SMTP el correo interno de Supabase sólo entrega al equipo: no se prueba con una casilla externa');
      return;
    }
  }
  const run = randomBytes(4).toString('hex');
  const prefix = `cauce-qa-${run}-correo`;
  const inbox = t.local ? mailpitInbox(t.mailpitUrl, `${prefix}@example.com`) : await disposableInbox(prefix);
  const email = inbox.address;
  const password = `Qa${randomBytes(9).toString('base64url')}7`;
  const next = `Qn${randomBytes(9).toString('base64url')}8`;
  hide(password); hide(next);
  const redirectTo = `${t.siteUrl}/index.html`;
  const service = client(t.url, await t.serviceKey());
  let userId = null;
  let invitedId = null;
  let guest = null;
  try {
    // 1. Alta y confirmación.
    const t0 = Date.now();
    const signup = await client(t.url, t.publishableKey).auth.signUp({ email, password,
      options: { emailRedirectTo: redirectTo, data: { display_name: 'CAUCE QA correo' } } });
    list.check('alta de cuenta de prueba', !signup.error, signup.error?.message || maskEmail(email));
    if (signup.error) return;
    userId = signup.data.user?.id;
    const blocked = await client(t.url, t.publishableKey).auth.signInWithPassword({ email, password });
    list.check('sin confirmar no entra', blocked.error?.code === 'email_not_confirmed', blocked.error?.code || 'entró');
    const confirmation = tokenLink(await inbox.waitFor('Confirmá tu correo en CAUCE', { after: t0 }));
    list.check('llegó el correo de confirmación (entrega real)', true, confirmation.origin + confirmation.pathname);
    list.check('el enlace vuelve al sitio real', `${confirmation.origin}${confirmation.pathname}` === redirectTo,
      `${confirmation.origin}${confirmation.pathname}`);
    const confirmed = await client(t.url, t.publishableKey).auth.verifyOtp({
      token_hash: confirmation.searchParams.get('token_hash'), type: confirmation.searchParams.get('type') });
    list.check('el enlace confirma la cuenta (otro dispositivo)', !confirmed.error && Boolean(confirmed.data.session),
      confirmed.error?.message || 'confirmada');
    const login = await client(t.url, t.publishableKey).auth.signInWithPassword({ email, password });
    list.check('ingreso con la cuenta confirmada', !login.error, login.error?.message || 'ok');

    // 2. Recuperación. El proyecto limita un correo por minuto por casilla.
    let t1 = Date.now();
    let reset = await client(t.url, t.publishableKey).auth.resetPasswordForEmail(email, { redirectTo });
    for (let attempt = 0; reset.error?.code === 'over_email_send_rate_limit' && attempt < 3; attempt += 1) {
      log('    (esperando el tope de un correo por minuto)');
      await sleep(65000);
      t1 = Date.now();
      reset = await client(t.url, t.publishableKey).auth.resetPasswordForEmail(email, { redirectTo });
    }
    list.check('pedido de recuperación aceptado', !reset.error, reset.error?.message || 'ok');
    if (reset.error) return;
    const recovery = tokenLink(await inbox.waitFor('Recuperar tu contraseña de CAUCE', { after: t1 }));
    list.check('llegó el correo de recuperación (entrega real)', true, recovery.origin + recovery.pathname);
    list.check('el enlace de recuperación vuelve al sitio real', `${recovery.origin}${recovery.pathname}` === redirectTo);
    const device = client(t.url, t.publishableKey);
    const opened = await device.auth.verifyOtp({ token_hash: recovery.searchParams.get('token_hash'), type: 'recovery' });
    list.check('el enlace abre sesión de recuperación en otro dispositivo', !opened.error, opened.error?.message || 'ok');
    const changed = await device.auth.updateUser({ password: next });
    list.check('se establece la contraseña nueva', !changed.error, changed.error?.message || 'ok');
    const withNew = await client(t.url, t.publishableKey).auth.signInWithPassword({ email, password: next });
    list.check('ingreso con la contraseña nueva', !withNew.error, withNew.error?.message || 'ok');
    const withOld = await client(t.url, t.publishableKey).auth.signInWithPassword({ email, password });
    list.check('la contraseña anterior ya no entra', withOld.error?.code === 'invalid_credentials', withOld.error?.code || 'entró');
    const reused = await client(t.url, t.publishableKey).auth.verifyOtp({
      token_hash: recovery.searchParams.get('token_hash'), type: 'recovery' });
    list.check('el enlace de recuperación no se puede reutilizar', Boolean(reused.error), reused.error?.code || 'se reutilizó');

    // 3. Invitación, como la usa la administración para sumar a alguien:
    // correo real → enlace → la persona elige su contraseña → ingresa.
    guest = t.local ? mailpitInbox(t.mailpitUrl, `${prefix}-invitado@example.com`) : await disposableInbox(`${prefix}-inv`);
    const t2 = Date.now();
    const invited = await service.auth.admin.inviteUserByEmail(guest.address, { redirectTo });
    list.check('invitación enviada', !invited.error, invited.error?.message || maskEmail(guest.address));
    if (invited.error) return;
    invitedId = invited.data.user?.id;
    const invitation = tokenLink(await guest.waitFor('Te invitaron a CAUCE', { after: t2 }));
    list.check('llegó la invitación (entrega real)', true, invitation.origin + invitation.pathname);
    list.check('la invitación vuelve al sitio real', `${invitation.origin}${invitation.pathname}` === redirectTo);
    const accepter = client(t.url, t.publishableKey);
    const accepted = await accepter.auth.verifyOtp({ token_hash: invitation.searchParams.get('token_hash'), type: 'invite' });
    list.check('el enlace de invitación abre sesión', !accepted.error && Boolean(accepted.data.session),
      accepted.error?.message || 'ok');
    const chosen = `Qi${randomBytes(9).toString('base64url')}6`;
    hide(chosen);
    const set = await accepter.auth.updateUser({ password: chosen });
    list.check('la persona invitada elige su contraseña', !set.error, set.error?.message || 'ok');
    const invitedLogin = await client(t.url, t.publishableKey).auth.signInWithPassword({ email: guest.address, password: chosen });
    list.check('ingresa con la contraseña que eligió', !invitedLogin.error, invitedLogin.error?.message || 'ok');
  } finally {
    for (const [id, label] of [[userId, 'cuenta de prueba eliminada'], [invitedId, 'cuenta invitada eliminada']]) {
      if (!id) continue;
      const removed = await service.auth.admin.deleteUser(id);
      list.check(label, !removed.error, removed.error?.message || 'ok');
    }
    await inbox.close();
    await guest?.close();
  }
}

async function admin(t, list) {
  const email = safeEmail(option('email') || process.env.CAUCE_ADMIN_EMAIL);
  const rows = await t.sql(`select u.id::text as id, u.email_confirmed_at is not null as confirmed,
      exists (select 1 from private.platform_admins a where a.user_id = u.id) as admin
    from auth.users u where lower(u.email) = '${email}' and u.deleted_at is null`);
  const who = maskEmail(email);
  if (!rows.length) {
    if (flag('invitar') && apply) {
      // La persona elige su contraseña desde el correo: no hay contraseñas temporales.
      const invited = await client(t.url, await t.serviceKey()).auth.admin.inviteUserByEmail(email,
        { redirectTo: `${t.siteUrl}/index.html` });
      list.check('invitación enviada', !invited.error, invited.error?.message || `${who}: aceptarla y volver a correr "admin --aplicar"`);
    } else {
      list.fail('existe la cuenta', `no hay una cuenta con ${who}. Registrarse en el sitio o correr con --invitar --aplicar.`);
    }
    return;
  }
  const [user] = rows;
  list.check('la cuenta confirmó su correo', user.confirmed, who);
  if (!user.confirmed) return;
  if (user.admin) list.pass('ya es administración', who);
  else if (apply) {
    await t.sql(`insert into private.platform_admins (user_id) values ('${user.id}') on conflict do nothing`);
    const [check] = await t.sql(`select exists (select 1 from private.platform_admins where user_id = '${user.id}') as ok`);
    list.check('privilegio de administración otorgado en la base', check.ok === true, who);
  } else list.info('sin --aplicar', `se otorgaría administración a ${who}`);
  const [{ total }] = await t.sql('select count(*)::int as total from private.platform_admins');
  list.info('cuentas de administración', String(total));
  // Nadie lo obtiene desde afuera: la tabla no está expuesta por la API.
  const exposed = await fetch(`${t.url}/rest/v1/platform_admins?select=*`, { headers: { apikey: t.publishableKey } });
  list.check('la tabla de administración no se expone por la API', !exposed.ok, `HTTP ${exposed.status}`);
}

// Lo que queda de las pruebas en el proyecto: cuentas con el patrón de QA,
// comercios "CAUCE QA", sus pedidos (y los de cuentas QA) y archivos de
// comercios que ya no existen. No mira ni cuenta nada real.
const QA_EMAIL = "'^cauce-qa-[0-9a-f]{8}-[a-z]+@example\\.com$'";
async function qaResidue(t) {
  const [row] = await t.sql(`with qa_users as (select id from auth.users where email ~ ${QA_EMAIL}),
      qa_businesses as (select id from public.businesses where slug ~ '^cauce-qa-' or name ~ '^CAUCE QA'
        or id in (select business_id from public.business_memberships where role = 'owner' and user_id in (select id from qa_users)))
    select (select count(*)::int from qa_users) as users,
      (select count(*)::int from qa_businesses) as businesses,
      (select count(*)::int from public.orders where business_id in (select id from qa_businesses)
        or customer_id in (select id from qa_users)) as orders,
      (select count(*)::int from storage.objects o where o.bucket_id = 'business-media' and o.name like 'businesses/%'
        and not exists (select 1 from public.businesses b where b.id::text = split_part(o.name, '/', 2))) as storage`);
  return { QA_USERS: Number(row.users), QA_BUSINESSES: Number(row.businesses), QA_ORDERS: Number(row.orders),
    QA_STORAGE: Number(row.storage) };
}

// Residuo de QA: sólo cuentas con el patrón exacto que crean las pruebas
// (cauce-qa-<8 hex>-<rol>@example.com), sus comercios, pedidos y archivos.
async function limpiarQa(t, list) {
  const users = await t.sql(`select id::text as id, email from auth.users
    where email ~ '^cauce-qa-[0-9a-f]{8}-[a-z]+@example\\.com$'`);
  const ids = users.map(user => `'${user.id}'`).join(', ');
  const businesses = users.length ? await t.sql(`select distinct business_id::text as id from public.business_memberships
    where user_id in (${ids}) and role = 'owner'`) : [];
  const [{ n: others }] = await t.sql(`select count(*)::int as n from auth.users
    where email is not null and email !~ '^cauce-qa-[0-9a-f]{8}-[a-z]+@example\\.com$'`);
  list.info('residuo encontrado', `${users.length} cuentas QA · ${businesses.length} comercios QA · ${others} cuentas reales intactas`);
  if (!apply || (!users.length && !businesses.length)) {
    if (!apply) list.info('sin --aplicar', 'no se borró nada');
    for (const [name, count] of Object.entries(await qaResidue(t))) {
      if (apply) list.check(`${name} = 0`, count === 0, String(count)); else list.info(name, String(count));
    }
    return;
  }
  const service = client(t.url, await t.serviceKey());
  const list2 = businesses.map(item => `'${item.id}'`).join(', ');
  if (businesses.length) {
    for (const { id } of businesses) {
      const folders = await service.storage.from('business-media').list(`businesses/${id}`, { limit: 100 });
      const paths = [];
      for (const folder of folders.data || []) {
        const entries = await service.storage.from('business-media').list(`businesses/${id}/${folder.name}`, { limit: 100 });
        for (const entry of entries.data || []) paths.push(`businesses/${id}/${folder.name}/${entry.name}`);
      }
      if (paths.length) await service.storage.from('business-media').remove(paths);
    }
    await t.sql(`delete from public.orders where business_id in (${list2})`);
    await t.sql(`delete from public.businesses where id in (${list2})`);
  }
  if (users.length) await t.sql(`delete from public.orders where customer_id in (${ids})`);
  for (const user of users) await service.auth.admin.deleteUser(user.id);
  list.info('borrado', `${users.length} cuentas y ${businesses.length} comercios QA`);
  const residue = await qaResidue(t);
  for (const [name, count] of Object.entries(residue)) list.check(`${name} = 0`, count === 0, String(count));
}

// Registros del proyecto real por la API (tabla unificada `logs`, SQL de
// ClickHouse): respuestas 5xx de la API y los errores más frecuentes de cada
// servicio en las últimas horas. Los rechazos esperables (RLS, U0005,
// transiciones inválidas de las pruebas de seguridad) aparecen como 4xx y
// errores de la base: se listan para leerlos, y sólo un 5xx (o no poder
// consultarlos) hace fallar el paso.
const STATUS = "toInt32OrZero(log_attributes['response.status_code'])";
const SEVERE = "upper(severity_text) in ('ERROR', 'FATAL', 'PANIC', 'CRITICAL')";
// Última vez que se vio cada grupo (UTC) y quién llamó: separa lo anterior a
// una migración, las pruebas de seguridad de los smokes y el tráfico ajeno.
const LAST = 'toString(toStartOfMinute(max(timestamp))) as last';
const CALLER = `substring(any(log_attributes['request.headers.x_client_info']), 1, 28) as client,
      substring(any(log_attributes['request.headers.referer']), 1, 40) as referer`;
// Un 503 de una función de pagos es su contrato mientras está cerrada (sin
// secretos o sin interruptor ni piloto): se informa aparte. Cualquier otro
// 5xx, también de esas funciones, cuenta como falla.
const PAYMENTS_CLOSED = `${STATUS} = 503 and startsWith(log_attributes['request.path'], '/functions/v1/payments-')`;
const LOG_QUERIES = {
  'API 5xx': `select ${STATUS} as code, log_attributes['request.method'] as method,
      log_attributes['request.path'] as path, count() as n, ${LAST}, ${CALLER}
    from logs where source = 'edge_logs' and ${STATUS} between 500 and 599 and not (${PAYMENTS_CLOSED})
    group by code, method, path order by n desc limit 10`,
  'Funciones de pagos cerradas (503 esperado)': `select log_attributes['request.path'] as path, count() as n, ${LAST}
    from logs where source = 'edge_logs' and ${PAYMENTS_CLOSED} group by path order by n desc limit 5`,
  'API por código': `select ${STATUS} as code, count() as n
    from logs where source = 'edge_logs' group by code order by code limit 20`,
  'API 4xx por ruta': `select ${STATUS} as code, log_attributes['request.method'] as method,
      log_attributes['request.path'] as path, count() as n, ${LAST}, ${CALLER}
    from logs where source = 'edge_logs' and ${STATUS} between 400 and 499
    group by code, method, path order by n desc limit 30`,
  'Eventos por servicio': `select source, severity_text as severity, count() as n
    from logs where source != 'edge_logs' group by source, severity order by source, n desc limit 40`,
  'Errores por servicio': `select source, severity_text as severity, substring(event_message, 1, 180) as message, count() as n, ${LAST}
    from logs where source != 'edge_logs' and (${SEVERE}
      or log_attributes['parsed.error_severity'] in ('ERROR', 'FATAL', 'PANIC')
      or lower(log_attributes['level']) in ('error', 'fatal'))
    group by source, severity, message order by n desc limit 30`,
};
// Los registros de Actions pueden ser públicos: ni correos ni IP de nadie.
const anonymize = text => redact(text)
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[correo]')
  .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
  .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){4,7}\b/gi, '[ip]');

async function registros(t, list) {
  if (t.local) throw new Error('Los registros se consultan en el proyecto real.');
  // La API admite hasta 24 h y redondea al minuto: un minuto de margen.
  const hours = Math.min(Math.max(Number(option('horas')) || 24, 1), 24);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000 + 60 * 1000);
  list.info('ventana', `${start.toISOString()} → ${end.toISOString()}`);
  for (const [label, sql] of Object.entries(LOG_QUERIES)) {
    const query = new URLSearchParams({ sql, iso_timestamp_start: start.toISOString(), iso_timestamp_end: end.toISOString() });
    let rows;
    try {
      // logs.all se retiró (410): el endpoint vigente es /analytics/endpoints/logs.
      const response = await t.management(`/analytics/endpoints/logs?${query}`);
      if (response?.error) throw new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error));
      rows = response?.result || [];
    } catch (error) {
      // El mensaje trae la URL (larga, con el SQL): se muestra sólo el estado y la respuesta.
      const detail = /HTTP (\d+) ([\s\S]*)$/.exec(redact(error.message));
      const text = `no se pudo consultar: ${detail ? `HTTP ${detail[1]} ${detail[2]}` : redact(error.message)}`.slice(0, 400);
      // Sin la consulta de 5xx no hay control: eso no puede pasar en silencio.
      if (label === 'API 5xx') list.check('la API no respondió 5xx', false, text);
      else list.info(label, text);
      continue;
    }
    const text = rows.map(row => Object.values(row).map(value => String(value).replace(/\s+/g, ' ').slice(0, 180)).join(' · ')).join(' | ');
    if (label === 'API 5xx') list.check('la API no respondió 5xx', rows.length === 0, anonymize(text) || 'ninguno');
    else list.info(label, anonymize(text) || 'ninguno');
  }
}

// ───────────────────────── arranque ─────────────────────────

const STEPS = { estado, migrar, auth, correo, admin, backup: (t, checks) => { t.link(); return backup(t, checks); },
  'limpiar-qa': limpiarQa, registros,
  'pagos-estado': (t, checks) => pagosEstado(t, checks),
  'pagos-funciones': (t, checks) => pagosFunciones(t, checks, { apply }),
  'pagos-limpiar': (t, checks) => pagosLimpiar(t, checks, { apply }),
  'pagos-sandbox': (t, checks) => pagosSandbox(t, checks, { apply, mode: option('modo') || 'mixto' }) };
if (!STEPS[step]) {
  console.error(`Paso desconocido: ${step || '(ninguno)'}. Pasos: ${Object.keys(STEPS).join(', ')}.`);
  process.exit(2);
}
const list = checklist(step);
let t;
try {
  t = await target({ local, custom });
  log(`CAUCE · ${step} · ${t.local ? 'stack local' : `proyecto ${PROJECT.projectRef}`} · ${apply ? 'APLICANDO' : 'sólo lectura'}\n`);
  await STEPS[step](t, list, { apply, local, option, flag });
} catch (error) {
  if (error instanceof MissingCredential) {
    list.fail('credenciales', `${error.message} Cargarla como secreto del repositorio (ver PRODUCTION_READINESS.md §3).`);
    // Sin token igual se puede mirar lo público, como cualquier visita.
    if (step === 'estado') await publicSmoke({ url: PROJECT.url, publishableKey: PROJECT.publishableKey }, list).catch(() => {});
  } else {
    list.fail('ejecución', redact(error?.stack || error?.message || String(error)).split('\n').slice(0, 4).join(' | '));
  }
} finally {
  await t?.close?.();
}
await list.save();
log(`\n${list.items.filter(item => item.ok).length} en verde · ${list.failed} en rojo.`);
process.exitCode = list.failed ? 1 : 0;
