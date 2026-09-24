// Comprobación de SÓLO LECTURA contra el proyecto CAUCE real y el sitio
// publicado. No crea cuentas, comercios ni pedidos: usa la publishable key como
// cualquier visita. Sirve para saber, antes y después de publicar, si el
// esquema remoto tiene las migraciones que exige este frontend y si los datos
// privados siguen cerrados.
//
//   npm run smoke:production
//   CAUCE_SITE_URL=https://bitflowapp.github.io/cauce npm run smoke:production
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { REQUIRED_SCHEMA } from '../js/core/contract.js';

const project = JSON.parse(await readFile(new URL('../supabase/project.json', import.meta.url), 'utf8'));
const url = process.env.CAUCE_SUPABASE_URL || project.url;
const key = process.env.CAUCE_SUPABASE_PUBLISHABLE_KEY || project.publishableKey;
const site = (process.env.CAUCE_SITE_URL || 'https://bitflowapp.github.io/cauce').replace(/\/+$/, '');
const headers = { apikey: key, 'Content-Type': 'application/json' };
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS · ${name}${detail ? ` · ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`FAIL · ${name} · ${error.message}`);
  }
};
const get = (path, init = {}) => fetch(`${url}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });

await check('esquema remoto compatible con este frontend', async () => {
  const response = await get('/rest/v1/rpc/app_status', { method: 'POST', body: '{}' });
  if (response.status === 404) throw new Error(`faltan migraciones: app_status no existe (se requiere ${REQUIRED_SCHEMA})`);
  const status = await response.json();
  if (!(Number(status.schema) >= REQUIRED_SCHEMA)) throw new Error(`esquema ${status.schema}, se requiere ${REQUIRED_SCHEMA}`);
  return `esquema ${status.schema} · verticales ${JSON.stringify(status.features)}`;
});

await check('una visita no lee datos privados', async () => {
  const closed = [];
  for (const table of ['orders', 'order_items', 'profiles', 'business_contacts', 'business_memberships', 'drivers', 'trips']) {
    const response = await get(`/rest/v1/${table}?select=*&limit=1`);
    const body = await response.json();
    if (response.ok && Array.isArray(body) && body.length) throw new Error(`${table} devolvió filas`);
    closed.push(table);
  }
  return `${closed.length} tablas cerradas`;
});

await check('Auth: confirmación de correo obligatoria', async () => {
  const settings = await (await get('/auth/v1/settings')).json();
  if (settings.mailer_autoconfirm) throw new Error('la confirmación de correo está desactivada');
  return `compra sin cuenta ${settings.external?.anonymous_users ? 'habilitada' : 'DESHABILITADA'}`;
});

await check('compra sin cuenta habilitada en Auth', async () => {
  const settings = await (await get('/auth/v1/settings')).json();
  if (!settings.external?.anonymous_users) throw new Error('falta habilitar anonymous sign-ins (scripts/configure-auth.mjs)');
});

await check('sitio publicado sirve el build conectado', async () => {
  const response = await fetch(`${site}/index.html`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (html.includes("connect-src 'none'")) throw new Error('el sitio publica la demostración, no el build conectado');
  if (!html.includes(new URL(url).host)) throw new Error('la CSP publicada no apunta a este proyecto');
  const script = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
  const js = await fetch(`${site}/${script}`);
  if (!js.ok) throw new Error(`no carga ${script}`);
  return script;
});

await mkdir('evidence', { recursive: true });
await writeFile('evidence/production-smoke.json', JSON.stringify({ at: new Date().toISOString(), url, site, results }, null, 2));
const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed} de ${results.length} comprobaciones en verde.`);
process.exitCode = failed ? 1 : 0;
