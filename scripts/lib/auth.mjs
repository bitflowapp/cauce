// Configuración de Auth del proyecto remoto de Ferias, armada desde las mismas
// fuentes que el stack local: supabase/config.toml (políticas y asuntos de los
// correos) y supabase/templates/ (cuerpos de los correos). Funciones puras: las
// prueba tests/unit/operacion.test.mjs; la red la pone scripts/operacion.mjs.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TEMPLATE_NAMES = ['confirmation', 'recovery', 'email_change', 'magic_link', 'invite'];
const PASSWORD_CHARS = {
  letters_digits: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789',
  lower_upper_letters_digits: 'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789',
};
// Topes por IP para usuarios reales: los de config.toml son de pruebas (altos a
// propósito). Mucha gente comparte IP detrás de la red móvil: el de sesiones
// anónimas no puede ser tan bajo que frene compras legítimas.
export const RATE_LIMITS = {
  rate_limit_anonymous_users: 150,
  rate_limit_sign_in_sign_ups: 30,
  rate_limit_token_refresh: 150,
  rate_limit_verify: 30,
};

// Lector mínimo de TOML para lo que usa config.toml: secciones y `clave = valor`
// (texto, número, booleano o lista de textos en una línea).
export function readToml(text) {
  const out = {};
  let section = '';
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1]; continue; }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    let value = pair[2].trim();
    if (/^".*"$/.test(value)) value = JSON.parse(value);
    else if (value === 'true' || value === 'false') value = value === 'true';
    else if (/^-?\d+$/.test(value)) value = Number(value);
    else if (/^\[.*\]$/.test(value)) value = JSON.parse(value);
    out[section ? `${section}.${pair[1]}` : pair[1]] = value;
  }
  return out;
}

// SMTP propio: las cinco variables o ninguna.
export function smtpFromEnv(env) {
  const smtp = {
    host: env.FERIAS_SMTP_HOST, port: env.FERIAS_SMTP_PORT, user: env.FERIAS_SMTP_USER,
    pass: env.FERIAS_SMTP_PASS, sender: env.FERIAS_SMTP_SENDER,
  };
  const declared = Object.entries(smtp).filter(([, value]) => value);
  if (!declared.length) return null;
  if (declared.length < 5) {
    const missing = Object.entries(smtp).filter(([, value]) => !value).map(([key]) => `FERIAS_SMTP_${key.toUpperCase()}`);
    throw new Error(`SMTP incompleto: faltan ${missing.join(', ')} (son todas o ninguna).`);
  }
  if (!/^\d+$/.test(String(smtp.port))) throw new Error('FERIAS_SMTP_PORT tiene que ser un número.');
  return smtp;
}

export function siteFromEnv(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('FERIAS_SITE_URL tiene que ser https.');
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url.hostname)) throw new Error('FERIAS_SITE_URL no puede ser una dirección local.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

// Lo que el proyecto remoto tiene que tener. `templates`: { nombre: html }.
export function desiredAuth({ config, templates, env }) {
  const site = siteFromEnv(env.FERIAS_SITE_URL);
  if (!site) throw new Error('Falta FERIAS_SITE_URL (la dirección pública del sitio): sin ella los enlaces de los correos no vuelven a Ferias.');
  const chars = PASSWORD_CHARS[config['auth.password_requirements']];
  if (config['auth.password_requirements'] && !chars) throw new Error(`password_requirements desconocido: ${config['auth.password_requirements']}.`);
  const payload = {
    site_url: site,
    // Sin comodines: el enlace de un correo sólo puede volver al sitio.
    uri_allow_list: [`${site}/index.html`, `${site}/`].join(','),
    disable_signup: config['auth.enable_signup'] === false,
    external_email_enabled: config['auth.email.enable_signup'] !== false,
    mailer_autoconfirm: config['auth.email.enable_confirmations'] !== true,
    mailer_secure_email_change_enabled: config['auth.email.double_confirm_changes'] === true,
    security_update_password_require_reauthentication: config['auth.email.secure_password_change'] === true,
    mailer_otp_exp: Number(config['auth.email.otp_expiry'] || 3600),
    mailer_otp_length: Number(config['auth.email.otp_length'] || 6),
    // Compra sin cuenta: sesión anónima real, limitada por RLS a sus pedidos.
    external_anonymous_users_enabled: config['auth.enable_anonymous_sign_ins'] === true,
    security_manual_linking_enabled: config['auth.enable_manual_linking'] === true,
    password_min_length: Number(config['auth.minimum_password_length'] || 10),
    password_required_characters: chars || '',
    refresh_token_rotation_enabled: config['auth.enable_refresh_token_rotation'] !== false,
    security_refresh_token_reuse_interval: Number(config['auth.refresh_token_reuse_interval'] ?? 10),
    jwt_exp: Number(config['auth.jwt_expiry'] || 3600),
    ...RATE_LIMITS,
  };
  const smtp = smtpFromEnv(env);
  if (smtp) {
    const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(smtp.sender);
    Object.assign(payload, {
      smtp_host: smtp.host,
      // La API lo declara texto (api.supabase.com/api/v1-json).
      smtp_port: String(Number(smtp.port)),
      smtp_user: smtp.user,
      smtp_pass: smtp.pass,
      smtp_sender_name: match ? match[1] : 'CAUCE · Ferias',
      smtp_admin_email: match ? match[2] : smtp.sender,
      smtp_max_frequency: 60,
      rate_limit_email_sent: 30,
    });
    // Plantillas propias sólo junto con el SMTP propio: con el correo interno de
    // Supabase no llegan a nadie de afuera igual, y la plataforma puede rechazar
    // el cambio entero si se mandan sin SMTP.
    for (const name of TEMPLATE_NAMES) {
      const html = templates[name];
      const subject = config[`auth.email.template.${name}.subject`];
      if (!html || !subject) throw new Error(`Falta la plantilla o el asunto de ${name} (supabase/templates y config.toml).`);
      if (!html.includes('{{ .TokenHash }}')) throw new Error(`La plantilla ${name} no usa token_hash.`);
      payload[`mailer_subjects_${name}`] = subject;
      payload[`mailer_templates_${name}_content`] = html;
    }
  }
  return payload;
}

export async function loadAuthSources(root) {
  const config = readToml(await readFile(join(root, 'supabase', 'config.toml'), 'utf8'));
  const templates = {};
  for (const name of TEMPLATE_NAMES) {
    const path = config[`auth.email.template.${name}.content_path`];
    templates[name] = await readFile(join(root, String(path || `./supabase/templates/${name}.html`)), 'utf8');
  }
  return { config, templates };
}

// Diferencias entre lo que hay y lo que tiene que haber. La contraseña SMTP no
// se puede leer (la API la devuelve oculta): sólo se informa si se manda.
export function diffAuth(current, desired) {
  const rows = [];
  for (const [key, value] of Object.entries(desired)) {
    if (key === 'smtp_pass') { rows.push({ key, ok: Boolean(current.smtp_pass || current.smtp_host), shown: '(oculta)' }); continue; }
    const shown = key.startsWith('mailer_templates_') ? `${String(value).length} caracteres` : JSON.stringify(value);
    const same = String(current?.[key] ?? '') === String(value);
    rows.push({ key, ok: same, shown, now: key.startsWith('mailer_templates_') ? (same ? 'igual' : 'distinta') : JSON.stringify(current?.[key] ?? null) });
  }
  return rows;
}

// Resumen legible (para estado) de lo que importa en Auth, sin secretos.
export function authSummary(config) {
  return [
    ['site_url', config.site_url || '(vacío)'],
    ['URLs de retorno', config.uri_allow_list || '(vacía)'],
    ['confirmación de correo', config.mailer_autoconfirm === false ? 'obligatoria' : 'DESACTIVADA'],
    ['compra sin cuenta (anónimas)', config.external_anonymous_users_enabled ? 'sí' : 'no'],
    ['contraseña mínima', `${config.password_min_length ?? '?'} caracteres${config.password_required_characters ? ' con letras y números' : ''}`],
    ['SMTP propio', config.smtp_host ? `${config.smtp_host}:${config.smtp_port} · ${config.smtp_admin_email}` : 'no (sólo llega al equipo de Supabase)'],
    ['plantillas con token_hash', /token_hash|TokenHash/.test(config.mailer_templates_recovery_content || '') ? 'sí' : 'no'],
    ['tope de sesiones anónimas por IP', String(config.rate_limit_anonymous_users ?? '?')],
  ];
}
