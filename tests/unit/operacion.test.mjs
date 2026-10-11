// Herramientas de operación (scripts/operacion.mjs y scripts/lib/*): las partes
// puras, sin red ni base. El recorrido completo contra el stack local se prueba
// con `npm run operacion -- respaldo --local` (ver docs/OPERACION.md).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { desiredAuth, diffAuth, loadAuthSources, readToml, smtpFromEnv } from '../../scripts/lib/auth.mjs';
import { ROOT, redact, secretsPresent, validateRef } from '../../scripts/lib/proyecto.mjs';
import { DATA_EXCLUDE, TEMP_STACKS, compareCounts, tempConfig } from '../../scripts/lib/respaldo.mjs';

const SMTP = {
  FERIAS_SMTP_HOST: 'smtp.example.com', FERIAS_SMTP_PORT: '465', FERIAS_SMTP_USER: 'ferias',
  FERIAS_SMTP_PASS: 'clave-smtp-de-prueba', FERIAS_SMTP_SENDER: 'CAUCE · Ferias <hola@ferias.example>',
};

test('el ref tiene que ser de un proyecto propio: nunca el de Aluminé', () => {
  assert.throws(() => validateRef(''), /Falta FERIAS_PROJECT_REF/);
  assert.throws(() => validateRef('ygqbcvxdrewcnzedfcyo'), /Aluminé/);
  assert.throws(() => validateRef('https://abc.supabase.co'), /forma de un ref/);
  assert.equal(validateRef(' abcdefghijklmnopqrst '), 'abcdefghijklmnopqrst');
});

test('de los secretos sólo se informa el nombre, nunca el valor', () => {
  const listed = secretsPresent({ SUPABASE_ACCESS_TOKEN: 'sbp_valor_secreto', FERIAS_BACKUP_PASSPHRASE: 'frase' });
  assert.ok(listed.find(item => item.name === 'SUPABASE_ACCESS_TOKEN').present);
  assert.ok(!listed.find(item => item.name === 'FERIAS_PROJECT_REF').present);
  assert.doesNotMatch(JSON.stringify(listed), /sbp_valor_secreto|frase"/);
  assert.equal(redact('token sbp_0123456789abcdef y sb_secret_abcDEF123'), 'token [token] y [clave-servidor]');
});

test('los stacks temporales no chocan con Ferias local (5542x) ni con Aluminé (5432x/5532x)', async () => {
  const source = await readFile(new URL('supabase/config.toml', `file://${ROOT}`), 'utf8');
  for (const { projectId, offset } of Object.values(TEMP_STACKS)) {
    const config = tempConfig(source, offset, projectId);
    assert.match(config, new RegExp(`^project_id = "${projectId}"$`, 'm'));
    const ports = [...config.matchAll(/^\s*(?:shadow_)?port = (\d+)$/gm)].map(match => Number(match[1]));
    assert.ok(ports.length >= 6);
    for (const port of ports) {
      assert.ok(port >= 56420 && port <= 56439, `puerto ${port} fuera del rango de los stacks temporales`);
    }
    assert.doesNotMatch(config, /^site_url = "http:\/\/127\.0\.0\.1:4274"$/m);
  }
  assert.notEqual(TEMP_STACKS.restauracion.projectId, TEMP_STACKS.ensayo.projectId);
});

test('el respaldo no lleva sesiones ni tokens', () => {
  for (const table of ['auth.sessions', 'auth.refresh_tokens', 'auth.one_time_tokens', 'auth.flow_state']) {
    assert.ok(DATA_EXCLUDE.includes(table), table);
  }
  assert.ok(!DATA_EXCLUDE.includes('auth.users'));
  assert.ok(!DATA_EXCLUDE.some(name => /^(public|private)\./.test(name)));
});

test('conteos: iguales salvo las tablas que una migración puede sembrar', () => {
  const before = { 'public.orders': 3, 'private.platform_features': 4 };
  assert.deepEqual(compareCounts(before, { 'public.orders': 3, 'private.platform_features': 5 }, Object.keys(before),
    { allowGrowth: ['private.platform_features'] }).mismatches, []);
  assert.deepEqual(compareCounts(before, { 'public.orders': 2, 'private.platform_features': 4 }, Object.keys(before)).mismatches,
    ['public.orders']);
});

test('lee de config.toml lo que usa Auth', async () => {
  const config = readToml(await readFile(new URL('supabase/config.toml', `file://${ROOT}`), 'utf8'));
  assert.equal(config.project_id, 'cauce-ferias');
  assert.equal(config['auth.minimum_password_length'], 10);
  assert.equal(config['auth.enable_anonymous_sign_ins'], true);
  assert.equal(config['auth.email.enable_confirmations'], true);
  assert.match(config['auth.email.template.recovery.subject'], /Ferias/);
  assert.ok(Array.isArray(config['auth.additional_redirect_urls']));
});

test('Auth previsto: sitio https, confirmación obligatoria, anónimas, contraseña 10+ con letras y números', async () => {
  const sources = await loadAuthSources(ROOT);
  assert.throws(() => desiredAuth({ ...sources, env: {} }), /FERIAS_SITE_URL/);
  assert.throws(() => desiredAuth({ ...sources, env: { FERIAS_SITE_URL: 'http://ferias.example' } }), /https/);
  const plan = desiredAuth({ ...sources, env: { FERIAS_SITE_URL: 'https://ferias.example/app/' } });
  assert.equal(plan.site_url, 'https://ferias.example/app');
  assert.equal(plan.uri_allow_list, 'https://ferias.example/app/index.html,https://ferias.example/app/');
  assert.equal(plan.mailer_autoconfirm, false);
  assert.equal(plan.external_anonymous_users_enabled, true);
  assert.equal(plan.password_min_length, 10);
  assert.match(plan.password_required_characters, /a-?z|abc/);
  assert.match(plan.password_required_characters, /0123456789/);
  // Sin SMTP propio no se mandan plantillas ni datos SMTP.
  assert.ok(!Object.keys(plan).some(key => key.startsWith('smtp_') || key.startsWith('mailer_templates_')));
});

test('SMTP: las cinco variables o ninguna; con SMTP van plantillas y asuntos del repo', async () => {
  assert.equal(smtpFromEnv({}), null);
  assert.throws(() => smtpFromEnv({ FERIAS_SMTP_HOST: 'smtp.example.com' }), /FERIAS_SMTP_PASS/);
  const sources = await loadAuthSources(ROOT);
  const plan = desiredAuth({ ...sources, env: { FERIAS_SITE_URL: 'https://ferias.example', ...SMTP } });
  assert.equal(plan.smtp_port, '465');
  assert.equal(plan.smtp_admin_email, 'hola@ferias.example');
  assert.equal(plan.smtp_sender_name, 'CAUCE · Ferias');
  for (const name of ['confirmation', 'recovery', 'email_change', 'magic_link', 'invite']) {
    assert.match(plan[`mailer_templates_${name}_content`], /\{\{ \.TokenHash \}\}/);
    assert.equal(plan[`mailer_subjects_${name}`], sources.config[`auth.email.template.${name}.subject`]);
  }
  // La contraseña SMTP nunca se muestra en el plan.
  const rows = diffAuth({}, plan);
  assert.equal(rows.find(row => row.key === 'smtp_pass').shown, '(oculta)');
  assert.doesNotMatch(JSON.stringify(rows), /clave-smtp-de-prueba/);
});

test('diferencias de Auth: sólo lo que cambia', () => {
  const rows = diffAuth({ site_url: 'https://a.example', mailer_autoconfirm: true },
    { site_url: 'https://a.example', mailer_autoconfirm: false });
  assert.deepEqual(rows.filter(row => !row.ok).map(row => row.key), ['mailer_autoconfirm']);
});
