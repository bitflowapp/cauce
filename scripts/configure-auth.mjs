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

const brand = body => `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;line-height:1.6">
  <p style="font-size:18px;font-weight:700;color:#143d34;margin:0 0 12px">CAUCE · Aluminé</p>
  ${body}
  <p style="font-size:12px;color:#536b63;margin-top:24px">Si no pediste esto, podés ignorar este mensaje.
  Nadie puede entrar a tu cuenta sólo por recibirlo.</p>
</div>`;

// Plantillas en castellano rioplatense, sin tecnicismos y sin exponer el token
// fuera del enlace.
const templates = {
  mailer_subjects_confirmation: 'Confirmá tu correo en CAUCE',
  mailer_templates_confirmation_content: brand(`
  <p>Tocá el botón para confirmar este correo y terminar de crear tu cuenta.</p>
  <p><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#143d34;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Confirmar mi correo</a></p>
  <p style="font-size:13px;color:#536b63">El enlace vence en una hora y se usa una sola vez.</p>`),
  mailer_subjects_recovery: 'Recuperar tu contraseña de CAUCE',
  mailer_templates_recovery_content: brand(`
  <p>Pediste cambiar la contraseña de tu cuenta. Tocá el botón para elegir una nueva.</p>
  <p><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#143d34;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Elegir una contraseña nueva</a></p>
  <p style="font-size:13px;color:#536b63">El enlace vence en una hora y se usa una sola vez.
  Tu contraseña actual sigue funcionando hasta que elijas la nueva.</p>`),
  mailer_subjects_email_change: 'Confirmá tu nuevo correo en CAUCE',
  mailer_templates_email_change_content: brand(`
  <p>Pediste usar {{ .NewEmail }} como correo de tu cuenta. Confirmalo para que el cambio tenga efecto.</p>
  <p><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#143d34;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Confirmar el nuevo correo</a></p>`),
  mailer_subjects_magic_link: 'Tu enlace de acceso a CAUCE',
  mailer_templates_magic_link_content: brand(`
  <p>Tocá el botón para entrar a tu cuenta.</p>
  <p><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#143d34;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Entrar a CAUCE</a></p>`),
};

const payload = { ...templates };

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
console.log(`Plantillas de correo: ${Object.keys(templates).filter(key => key.startsWith('mailer_templates_')).length} en castellano.`);

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
  password_hibp_enabled: current.password_hibp_enabled,
  minimum_password_length: current.password_min_length,
}, null, 2));
if (current.mailer_autoconfirm) {
  console.error('\nATENCIÓN: la confirmación de correo está desactivada en el proyecto.');
  process.exit(1);
}
