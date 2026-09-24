// Configura Auth del proyecto CAUCE (y sólo de ese proyecto) con la API de
// administración de Supabase: plantillas de correo en castellano, URLs
// permitidas y, si se declaran, las credenciales SMTP propias.
//
// Uso:
//   SUPABASE_ACCESS_TOKEN=... node scripts/configure-auth.mjs [--apply]
//   SUPABASE_ACCESS_TOKEN=... CAUCE_SITE_URL=https://... \
//     CAUCE_SMTP_HOST=smtp.resend.com CAUCE_SMTP_PORT=465 \
//     CAUCE_SMTP_USER=resend CAUCE_SMTP_PASS=... \
//     CAUCE_SMTP_SENDER="CAUCE Aluminé <hola@tu-dominio>" \
//     node scripts/configure-auth.mjs --apply
//
// Sin --apply sólo informa qué cambiaría. Nunca imprime la contraseña SMTP ni
// el token: lo que se ve en pantalla se puede pegar en un ticket sin riesgo.
import { readFile } from 'node:fs/promises';

const project = JSON.parse(await readFile(new URL('../supabase/project.json', import.meta.url), 'utf8'));
if (project.projectRef !== 'ygqbcvxdrewcnzedfcyo') {
  throw new Error('Este script sólo configura el proyecto CAUCE.');
}
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error(`Falta SUPABASE_ACCESS_TOKEN.
Generá uno personal en https://supabase.com/dashboard/account/tokens y exportalo
en la terminal antes de ejecutar este script. No lo guardes en el repositorio.`);
  process.exit(1);
}
const apply = process.argv.includes('--apply');
const endpoint = `https://api.supabase.com/v1/projects/${project.projectRef}/config/auth`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// Las plantillas son las mismas que usa el stack local (supabase/templates):
// una sola fuente. Los enlaces vuelven a la aplicación con token_hash, así que
// funcionan aunque la persona abra el correo en otro navegador o dispositivo.
const TEMPLATES = {
  confirmation: 'Confirmá tu correo en CAUCE',
  recovery: 'Recuperar tu contraseña de CAUCE',
  email_change: 'Confirmá tu nuevo correo en CAUCE',
  magic_link: 'Tu enlace de acceso a CAUCE',
  invite: 'Te invitaron a CAUCE',
};
const templates = {};
for (const [name, subject] of Object.entries(TEMPLATES)) {
  const html = await readFile(new URL(`../supabase/templates/${name}.html`, import.meta.url), 'utf8');
  if (!html.includes('{{ .TokenHash }}')) throw new Error(`La plantilla ${name} no usa token_hash.`);
  templates[`mailer_subjects_${name}`] = subject;
  templates[`mailer_templates_${name}_content`] = html;
}

const payload = {
  ...templates,
  // Compra sin cuenta: sesión anónima real, limitada por RLS a sus pedidos.
  external_anonymous_users_enabled: true,
  // Muchas personas comparten IP detrás de la red móvil: el tope por IP no
  // puede ser el de pruebas (30/h) sin frenar compras legítimas.
  rate_limit_anonymous_users: Number(process.env.CAUCE_ANONYMOUS_RATE_LIMIT || 150),
  mailer_autoconfirm: false,
};

// URLs: el enlace del correo vuelve exactamente a donde se sirve la aplicación.
const site = process.env.CAUCE_SITE_URL;
if (site) {
  const url = new URL(site);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('La URL del sitio debe ser https, salvo en pruebas locales.');
  }
  const base = url.origin + url.pathname.replace(/\/$/, '');
  payload.site_url = base;
  payload.uri_allow_list = [`${base}/index.html`, `${base}/`].join(',');
  // Sin comodines: el enlace de un correo sólo puede volver a CAUCE.
  if (/[*?]/.test(payload.uri_allow_list)) throw new Error('La lista de URLs no admite comodines.');
}

// SMTP propio. Sin estas variables el proyecto sigue con el correo interno de
// Supabase, que sólo entrega a integrantes del equipo: no sirve para vecinos.
const smtp = {
  host: process.env.CAUCE_SMTP_HOST,
  port: process.env.CAUCE_SMTP_PORT,
  user: process.env.CAUCE_SMTP_USER,
  pass: process.env.CAUCE_SMTP_PASS,
  sender: process.env.CAUCE_SMTP_SENDER,
};
const declared = Object.entries(smtp).filter(([, value]) => value);
if (declared.length && declared.length < 5) {
  throw new Error(`Faltan variables SMTP: ${Object.entries(smtp).filter(([, v]) => !v).map(([k]) => k).join(', ')}.`);
}
if (declared.length === 5) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(smtp.sender);
  payload.smtp_host = smtp.host;
  payload.smtp_port = Number(smtp.port);
  payload.smtp_user = smtp.user;
  payload.smtp_pass = smtp.pass;
  payload.smtp_sender_name = match ? match[1] : 'CAUCE Aluminé';
  payload.smtp_admin_email = match ? match[2] : smtp.sender;
  payload.smtp_max_frequency = 60;
  payload.rate_limit_email_sent = Number(process.env.CAUCE_EMAIL_RATE_LIMIT || 30);
}

const visible = Object.fromEntries(Object.entries(payload)
  .map(([key, value]) => [key, key === 'smtp_pass' ? '(oculta)' : value])
  .filter(([key]) => !key.startsWith('mailer_templates_')));
console.log(apply ? 'Aplicando a CAUCE:' : 'Cambios previstos (no se aplicó nada):');
console.log(JSON.stringify(visible, null, 2));
console.log(`Plantillas de correo: ${Object.keys(templates).filter(key => key.startsWith('mailer_templates_')).length} en castellano, con token_hash.`);

if (!apply) {
  console.log('\nEjecutá otra vez con --apply para escribir la configuración.');
  process.exit(0);
}

const response = await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify(payload) });
if (!response.ok) {
  console.error(`La API rechazó el cambio (${response.status}).`);
  console.error((await response.text()).slice(0, 400));
  process.exit(1);
}
const current = await (await fetch(endpoint, { headers })).json();
console.log('\nEstado real después del cambio:');
console.log(JSON.stringify({
  site_url: current.site_url,
  uri_allow_list: current.uri_allow_list,
  smtp_host: current.smtp_host || '(sin SMTP propio: sólo llega a integrantes del equipo Supabase)',
  smtp_sender: current.smtp_admin_email || null,
  rate_limit_email_sent: current.rate_limit_email_sent,
  mailer_autoconfirm: current.mailer_autoconfirm,
  anonymous_sign_ins: current.external_anonymous_users_enabled,
  rate_limit_anonymous_users: current.rate_limit_anonymous_users,
  password_hibp_enabled: current.password_hibp_enabled,
  minimum_password_length: current.password_min_length,
}, null, 2));
if (current.mailer_autoconfirm) {
  console.error('\nATENCIÓN: la confirmación de correo está desactivada en el proyecto.');
  process.exit(1);
}
