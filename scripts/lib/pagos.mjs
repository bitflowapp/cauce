// Pagos online en el proyecto real: estado, despliegue de las Edge Functions y
// limpieza del sandbox. Nunca imprime ni guarda un secreto: de los secretos de
// las funciones sólo se leen los NOMBRES.
//
//   pagos-estado     funciones desplegadas, secretos presentes, interruptor,
//                    comercios piloto, cuentas y notificaciones (sólo lectura)
//   pagos-funciones  despliega payments-oauth, payments-checkout y
//                    payments-webhook sólo con los pagos globales apagados y sin
//                    credenciales en el código; crea la clave de cifrado de
//                    tokens si falta (nunca la reemplaza) y verifica que sin
//                    secretos o sin piloto las funciones cierren (503)
//   pagos-limpiar    saca pilotos, credenciales y comercios QA de Mercado Pago
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PROJECT, ROOT, hide, supabaseCli } from './proyecto.mjs';

export const FUNCTIONS = Object.freeze(['payments-oauth', 'payments-checkout', 'payments-webhook']);
export const FUNCTION_SECRETS = Object.freeze(['MP_CLIENT_ID', 'MP_CLIENT_SECRET', 'MP_WEBHOOK_SECRET', 'PAYMENTS_TOKEN_KEYS']);
// Cuentas de prueba de Mercado Pago para el sandbox automático (secretos del
// entorno "produccion" de GitHub, nunca en el repositorio).
export const TEST_ACCOUNT_SECRETS = Object.freeze(['A', 'B'].flatMap(letter =>
  ['USER', 'PASSWORD', 'CODE'].map(part => `MP_TEST_SELLER_${letter}_${part}`))
  .concat(['USER', 'PASSWORD', 'CODE'].map(part => `MP_TEST_BUYER_${part}`)));
export const VERIFY_JWT = Object.freeze({ 'payments-oauth': false, 'payments-checkout': true, 'payments-webhook': false });
// Comercios del sandbox: slug cauce-qa-mp-… (los limpia pagos-limpiar).
export const QA_SLUG = 'cauce-qa-mp-';

async function appStatus(t) {
  const response = await fetch(`${t.url}/rest/v1/rpc/app_status`, { method: 'POST',
    headers: { apikey: t.publishableKey, 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error(`app_status respondió ${response.status}`);
  return response.json();
}

// Sólo nombres: el valor (o su hash) se descarta en el acto.
export async function secretNames(t) {
  if (t.local) return [];
  const rows = await t.management('/secrets');
  return (rows || []).map(row => String(row.name));
}

async function deployedFunctions(t) {
  if (t.local) return [];
  const rows = await t.management('/functions');
  return (rows || []).map(row => ({ slug: row.slug, status: row.status, version: row.version,
    verifyJwt: row.verify_jwt, updatedAt: row.updated_at }));
}

async function pilotRows(t) {
  return t.sql(`select b.slug, p.sandbox from private.payment_pilot_businesses p
    join public.businesses b on b.id = p.business_id order by b.slug`);
}

export async function pagosEstado(t, list) {
  const status = await appStatus(t);
  list.check('pagos globales apagados (payments_online)', status.features?.payments_online === false,
    String(status.features?.payments_online));
  list.info('esquema', String(status.schema));
  const functions = await deployedFunctions(t);
  for (const name of FUNCTIONS) {
    const found = functions.find(item => item.slug === name);
    list.info(`función ${name}`, found ? `${found.status} · v${found.version} · verify_jwt ${found.verifyJwt}` : 'no desplegada');
  }
  const names = await secretNames(t);
  for (const name of FUNCTION_SECRETS) list.info(`secreto ${name}`, names.includes(name) ? 'presente' : 'falta');
  for (const name of TEST_ACCOUNT_SECRETS) list.info(`cuenta de prueba ${name}`, process.env[name] ? 'presente' : 'falta');
  const pilots = await pilotRows(t);
  list.info('comercios piloto', pilots.length ? pilots.map(row => `${row.slug}${row.sandbox ? ' (sandbox)' : ''}`).join(', ') : 'ninguno');
  list.check('ningún piloto fuera de QA', pilots.every(row => row.slug.startsWith(QA_SLUG)),
    pilots.filter(row => !row.slug.startsWith(QA_SLUG)).map(row => row.slug).join(', ') || 'ninguno');
  const accounts = await t.sql(`select status, coalesce(live_mode::text, 'sin dato') as live, count(*)::int as n
    from public.payment_provider_accounts group by 1, 2 order by 1, 2`);
  list.info('cuentas de proveedor', accounts.map(row => `${row.status}/${row.live}: ${row.n}`).join(' · ') || 'ninguna');
  list.check('ninguna cuenta real conectada', !accounts.some(row => row.status === 'connected' && row.live === 'true'),
    accounts.filter(row => row.live === 'true').map(row => `${row.status}: ${row.n}`).join(' · ') || 'ninguna');
  // live_mode del aviso es lo que dice el proveedor (con credenciales productivas
  // de una cuenta de prueba puede venir en true): se muestra tal cual. Lo que
  // separa una orden de prueba de una real es su id (ORDTST…).
  const events = await t.sql(`select outcome, coalesce(live_mode::text, 'sin dato') as live, count(*)::int as n
    from private.payment_events where received_at > now() - interval '24 hours' group by 1, 2 order by 1, 2`);
  list.info('notificaciones 24 h (resultado/live_mode del proveedor)',
    events.map(row => `${row.outcome}/${row.live}: ${row.n}`).join(' · ') || 'ninguna');
  const [real] = await t.sql(`select count(*)::int as n from private.payment_events
    where resource_type = 'order' and resource_id !~ '^ORDTST'`);
  list.check('ninguna orden real notificada (todas ORDTST…)', Number(real.n) === 0, String(real.n));
  const [attempts] = await t.sql(`select count(*)::int as n from public.payment_attempts
    where provider_order_id is not null and provider_order_id !~ '^ORDTST'`);
  list.check('ningún intento con una orden real', Number(attempts.n) === 0, String(attempts.n));
}

// Sin credenciales en el código de las funciones (el escaneo del repositorio).
function scanFunctions(list) {
  const result = spawnSync(process.execPath, ['scripts/secretos.mjs'], { cwd: ROOT, encoding: 'utf8' });
  list.check('sin credenciales en el repositorio (incluidas las funciones)', result.status === 0,
    (result.stdout || result.stderr || '').trim().split('\n').pop());
  return result.status === 0;
}

async function probe(url, init) {
  try {
    const response = await fetch(url, { redirect: 'manual', ...init });
    const text = await response.text();
    return { status: response.status, body: text.slice(0, 120), allowOrigin: response.headers.get('access-control-allow-origin') };
  } catch (error) {
    return { status: 0, body: String(error.message).slice(0, 120), allowOrigin: null };
  }
}

export async function pagosFunciones(t, list, { apply }) {
  const status = await appStatus(t);
  const off = status.features?.payments_online === false;
  list.check('pagos globales apagados antes de desplegar', off, String(status.features?.payments_online));
  const clean = scanFunctions(list);
  if (!off || !clean) throw new Error('No se despliega: los pagos globales tienen que estar apagados y el código sin credenciales.');
  const names = await secretNames(t);
  for (const name of FUNCTION_SECRETS) list.info(`secreto ${name}`, names.includes(name) ? 'presente' : 'falta (la función cierra con 503)');
  if (!apply) {
    list.info('sin --aplicar', 'no se desplegó nada');
    return;
  }
  // La clave que cifra los tokens del vendedor: se crea una vez y nunca se
  // reemplaza (reemplazarla dejaría ilegibles los tokens guardados).
  if (!names.includes('PAYMENTS_TOKEN_KEYS')) {
    const value = JSON.stringify({ 1: randomBytes(32).toString('base64') });
    hide(value);
    await t.management('/secrets', { method: 'POST', body: [{ name: 'PAYMENTS_TOKEN_KEYS', value }] });
    list.info('PAYMENTS_TOKEN_KEYS', 'creada (valor nunca mostrado)');
  } else {
    list.info('PAYMENTS_TOKEN_KEYS', 'ya existía: no se toca');
  }
  // Empaquetado del lado de Supabase (sin Docker) con la configuración de
  // supabase/config.toml: punto de entrada y verify_jwt de cada función.
  supabaseCli(['functions', 'deploy', ...FUNCTIONS, '--project-ref', PROJECT.projectRef, '--use-api']);
  const deployed = await deployedFunctions(t);
  for (const name of FUNCTIONS) {
    const found = deployed.find(item => item.slug === name);
    list.check(`${name} desplegada y activa`, found?.status === 'ACTIVE', found ? `${found.status} · v${found.version}` : 'no está');
    list.check(`${name} verify_jwt = ${VERIFY_JWT[name]}`, found?.verifyJwt === VERIFY_JWT[name], String(found?.verifyJwt));
  }
  // Cerradas: sin firma, sin sesión o sin piloto, nada pasa.
  const base = `${t.url}/functions/v1`;
  const webhook = await probe(`${base}/payments-webhook?type=order&data.id=ORDTST01SONDA`, { method: 'POST', body: '{}',
    headers: { 'Content-Type': 'application/json' } });
  list.check('webhook sin firma: cerrado (503 o 401)', [401, 503].includes(webhook.status), `${webhook.status} ${webhook.body}`);
  const checkout = await probe(`${base}/payments-checkout`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  list.check('checkout sin sesión: 401', checkout.status === 401, `${checkout.status}`);
  const oauth = await probe(`${base}/payments-oauth`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  list.check('OAuth sin sesión: cerrado (503 o 401)', [401, 503].includes(oauth.status), `${oauth.status} ${oauth.body}`);
  // El sitio las llama desde el navegador (functions.invoke): el preflight
  // tiene que pasar el gateway real, también con verify_jwt en checkout.
  for (const name of ['payments-checkout', 'payments-oauth']) {
    const preflight = await probe(`${base}/${name}`, { method: 'OPTIONS', headers: { Origin: new URL(t.siteUrl).origin,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, x-client-info, apikey, content-type' } });
    list.check(`${name}: el navegador puede llamarla (preflight CORS)`, [200, 204].includes(preflight.status)
      && preflight.allowOrigin === '*', `${preflight.status} · allow-origin ${preflight.allowOrigin ?? 'ninguno'}`);
  }
  const after = await appStatus(t);
  list.check('pagos globales siguen apagados', after.features?.payments_online === false, String(after.features?.payments_online));
}

export async function pagosLimpiar(t, list, { apply }) {
  const businesses = await t.sql(`select id::text as id, slug from public.businesses where slug like '${QA_SLUG}%'`);
  const ids = businesses.map(row => `'${row.id}'`).join(', ');
  list.info('comercios QA de pagos', String(businesses.length));
  if (apply && businesses.length) {
    await t.sql(`delete from private.payment_pilot_businesses where business_id in (${ids})`);
    await t.sql(`delete from private.payment_provider_credentials c using public.payment_provider_accounts a
      where a.id = c.account_id and a.business_id in (${ids})`);
    await t.sql(`update public.businesses set status = 'suspended' where id in (${ids})`);
    await t.sql(`delete from public.orders where business_id in (${ids})`);
    await t.sql(`delete from public.businesses where id in (${ids})`);
    list.info('borrado', `${businesses.length} comercios QA de pagos, sus pilotos y credenciales`);
  } else if (!apply) {
    list.info('sin --aplicar', 'no se borró nada');
  }
  const [residue] = await t.sql(`select
    (select count(*)::int from private.payment_pilot_businesses) as pilots,
    (select count(*)::int from public.businesses where slug like '${QA_SLUG}%') as businesses,
    (select count(*)::int from private.payment_provider_credentials c join public.payment_provider_accounts a
      on a.id = c.account_id join public.businesses b on b.id = a.business_id where b.slug like 'cauce-qa-%') as credentials`);
  for (const [name, count] of Object.entries(residue)) {
    if (apply) list.check(`${name} = 0`, Number(count) === 0, String(count)); else list.info(name, String(count));
  }
  const status = await appStatus(t);
  list.check('pagos globales apagados', status.features?.payments_online === false, String(status.features?.payments_online));
}
