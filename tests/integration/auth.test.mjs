// Autenticación contra GoTrue real con SMTP local (Mailpit): el correo sale del
// servidor de Auth por SMTP, llega a una casilla y el enlace se usa como lo
// usaría una persona. Lo único que cambia en producción es el proveedor SMTP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { env, sql, admin, anonClient, ok, mailFor, linkFrom, run, closeAll } from './harness.mjs';

const clients = [];
const fresh = () => { const client = anonClient(); clients.push({ client }); return client; };
const email = name => `qa-${run}-${name}@cauce.test`;
after(async () => { await closeAll(clients); });

async function confirmedAccount(name, password = `Clave${randomUUID().slice(0, 8)}1`) {
  const address = email(name);
  ok(await admin.auth.admin.createUser({ email: address, password, email_confirm: true }));
  return { address, password };
}

test('registro: sin confirmar no entra; el correo llega y el enlace confirma desde otro dispositivo', async () => {
  const address = email('registro');
  const password = `Registro${randomUUID().slice(0, 6)}9`;
  const device = fresh();
  const since = Date.now() - 1000;
  const signup = ok(await device.auth.signUp({ email: address, password,
    options: { data: { display_name: 'Vecina Nueva', phone: '' } } }));
  assert.equal(signup.session, null, 'la cuenta exige confirmar el correo');
  const early = await fresh().auth.signInWithPassword({ email: address, password });
  assert.equal(early.error?.code, 'email_not_confirmed');
  const message = await mailFor(address, { subject: 'Confirmá tu correo en CAUCE', after: since });
  const link = linkFrom(message);
  assert.equal(link.origin + link.pathname, 'http://127.0.0.1:4174/index.html');
  assert.equal(link.searchParams.get('type'), 'email');
  // Otro navegador, sin nada guardado del registro: funciona igual.
  const otherDevice = fresh();
  const verified = ok(await otherDevice.auth.verifyOtp({ token_hash: link.searchParams.get('token_hash'), type: 'email' }));
  assert.equal(verified.user.email, address);
  ok(await fresh().auth.signInWithPassword({ email: address, password }));
  const reused = await fresh().auth.verifyOtp({ token_hash: link.searchParams.get('token_hash'), type: 'email' });
  assert.ok(reused.error, 'un enlace de confirmación se usa una sola vez');
});

test('contraseña incorrecta y cuenta inexistente responden igual', async () => {
  const { address } = await confirmedAccount('login');
  const wrong = await fresh().auth.signInWithPassword({ email: address, password: 'Incorrecta123' });
  const missing = await fresh().auth.signInWithPassword({ email: email('no-existe'), password: 'Incorrecta123' });
  assert.equal(wrong.error?.code, 'invalid_credentials');
  assert.equal(missing.error?.code, 'invalid_credentials');
  assert.equal(wrong.error.message, missing.error.message);
});

test('contraseñas débiles se rechazan en el servidor', async () => {
  for (const password of ['corta1', 'sololetrasaqui', '1234567890']) {
    const result = await fresh().auth.signUp({ email: email(`debil-${password.length}${password[0]}`), password });
    assert.equal(result.error?.code, 'weak_password', password);
  }
});

test('recuperación: el correo llega, el enlace sirve una vez desde cualquier navegador y cambia la clave', async () => {
  const { address, password } = await confirmedAccount('recupero');
  const since = Date.now() - 1000;
  ok(await fresh().auth.resetPasswordForEmail(address, { redirectTo: 'http://127.0.0.1:4174/index.html' }));
  const message = await mailFor(address, { subject: 'Recuperar tu contraseña de CAUCE', after: since });
  const link = linkFrom(message);
  assert.equal(link.searchParams.get('type'), 'recovery');
  assert.equal(message.HTML.includes(link.searchParams.get('token_hash')), true);
  const phone = fresh();
  const session = ok(await phone.auth.verifyOtp({ token_hash: link.searchParams.get('token_hash'), type: 'recovery' }));
  assert.equal(session.user.email, address);
  const next = `Nueva${randomUUID().slice(0, 8)}7`;
  ok(await phone.auth.updateUser({ password: next }));
  assert.equal((await fresh().auth.signInWithPassword({ email: address, password })).error?.code, 'invalid_credentials');
  ok(await fresh().auth.signInWithPassword({ email: address, password: next }));
  const reused = await fresh().auth.verifyOtp({ token_hash: link.searchParams.get('token_hash'), type: 'recovery' });
  assert.ok(reused.error, 'el enlace ya usado no vuelve a servir');
});

test('recuperación: un enlace vencido se rechaza y una casilla desconocida no revela nada', async () => {
  const { address } = await confirmedAccount('vencido');
  const since = Date.now() - 1000;
  ok(await fresh().auth.resetPasswordForEmail(address));
  const link = linkFrom(await mailFor(address, { subject: 'Recuperar tu contraseña de CAUCE', after: since }));
  await sql`update auth.users set recovery_sent_at = now() - interval '2 hours' where email = ${address}`;
  const expired = await fresh().auth.verifyOtp({ token_hash: link.searchParams.get('token_hash'), type: 'recovery' });
  assert.equal(expired.error?.code, 'otp_expired');
  const unknown = await fresh().auth.resetPasswordForEmail(email('desconocida'));
  assert.equal(unknown.error, null, 'la respuesta no distingue si la cuenta existe');
});

test('cambio de contraseña con sesión reciente', async () => {
  const { address, password } = await confirmedAccount('cambio');
  const client = fresh();
  ok(await client.auth.signInWithPassword({ email: address, password }));
  const next = `Cambio${randomUUID().slice(0, 8)}3`;
  ok(await client.auth.updateUser({ password: next }));
  assert.equal((await fresh().auth.signInWithPassword({ email: address, password })).error?.code, 'invalid_credentials');
  ok(await fresh().auth.signInWithPassword({ email: address, password: next }));
});

test('varias sesiones: cerrar una no cierra las otras; cerrar todas sí', async () => {
  const { address, password } = await confirmedAccount('sesiones');
  const phone = fresh();
  const laptop = fresh();
  ok(await phone.auth.signInWithPassword({ email: address, password }));
  ok(await laptop.auth.signInWithPassword({ email: address, password }));
  const phoneRefresh = (await phone.auth.getSession()).data.session.refresh_token;
  ok(await phone.auth.signOut({ scope: 'local' }));
  const revoked = await fresh().auth.refreshSession({ refresh_token: phoneRefresh });
  assert.ok(revoked.error, 'el refresh de la sesión cerrada ya no sirve');
  ok(await laptop.auth.refreshSession());
  ok(await laptop.auth.signOut({ scope: 'global' }));
  const laptopRefresh = await laptop.auth.refreshSession();
  assert.ok(laptopRefresh.error || !laptopRefresh.data.session, 'cierre global revoca todo');
});

test('rotación de refresh: cada uso entrega uno nuevo y un refresh viejo ya no sirve', async () => {
  const { address, password } = await confirmedAccount('rotacion');
  const refresh = async token => ok(await fresh().auth.refreshSession({ refresh_token: token })).session.refresh_token;
  const first = ok(await fresh().auth.signInWithPassword({ email: address, password })).session.refresh_token;
  const second = await refresh(first);
  const third = await refresh(second);
  assert.equal(new Set([first, second, third]).size, 3, 'cada renovación rota el refresh token');
  // Pasado el intervalo de gracia (10 s) un refresh de dos generaciones atrás es
  // un reuso: GoTrue lo rechaza. (Tolera sólo el inmediato anterior al vigente,
  // para una respuesta perdida en la red.)
  await new Promise(resolve => setTimeout(resolve, 11000));
  const stolen = await fresh().auth.refreshSession({ refresh_token: first });
  assert.equal(stolen.error?.code, 'refresh_token_already_used');
});

test('una cuenta deshabilitada no entra ni renueva su sesión', async () => {
  const { address, password } = await confirmedAccount('deshabilitada');
  const client = fresh();
  const session = ok(await client.auth.signInWithPassword({ email: address, password })).session;
  const user = ok(await admin.auth.admin.listUsers({ perPage: 1000 })).users.find(candidate => candidate.email === address);
  ok(await admin.auth.admin.updateUserById(user.id, { ban_duration: '87600h' }));
  assert.equal((await fresh().auth.signInWithPassword({ email: address, password })).error?.code, 'user_banned');
  assert.ok((await fresh().auth.refreshSession({ refresh_token: session.refresh_token })).error);
});

test('un JWT vencido no se degrada a visitante: la API lo rechaza', async () => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: randomUUID(), role: 'authenticated', aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) - 60 });
  const signature = createHmac('sha256', env.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  const expired = createClient(env.url, env.publishableKey, { auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${header}.${payload}.${signature}` } } });
  const result = await expired.from('businesses').select('id').limit(1);
  assert.equal(result.status, 401);
  assert.match(result.error?.code || '', /^PGRST30\d$/);
  assert.match(result.error?.message || '', /expired/i);
});
