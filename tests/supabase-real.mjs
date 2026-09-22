import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixtures, publicClient, project, requireSuccess } from './lib/supabase-real.mjs';
import { createSupabaseRepository } from '../js/repositories/supabase-repository.js';

const results = [];
const fixture = await fixtures(['customerA', 'customerB', 'merchantA', 'merchantB', 'driverA', 'admin', 'manager', 'staff']);
const repo = name => createSupabaseRepository({ client: fixture.users[name].client });
const check = async (name, fn) => { await fn(); results.push(name); console.log(`PASS · ${name}`); };
const denied = result => assert.ok(result.error, 'Expected a denied write');
try {
  await check('Auth login real y profiles para ocho identidades independientes', async () => {
    for (const name of Object.keys(fixture.users)) {
      assert.equal((await repo(name).session()).actor.id, fixture.users[name].id);
    }
  });
  let a, b;
  await check('Alta transaccional de dos comercios y membresías derivadas del servidor', async () => {
    a = (await repo('merchantA').command('business.create', { name: 'Comercio Sintético A' })).id; fixture.businesses.push(a);
    b = (await repo('merchantB').command('business.create', { name: 'Comercio Sintético B' })).id; fixture.businesses.push(b);
    assert.deepEqual((await repo('merchantA').session()).actor.businessIds, [a]);
    assert.deepEqual((await repo('merchantB').session()).actor.businessIds, [b]);
  });
  await check('Cliente A, taxista y cuenta común no leen perfiles ajenos', async () => {
    for (const name of ['customerA', 'driverA', 'admin']) {
      const rows = requireSuccess(await fixture.users[name].client.from('profiles').select('user_id'));
      assert.deepEqual(rows, [{ user_id: fixture.users[name].id }]);
    }
  });
  await check('Comercio A no lee ni modifica el borrador de B', async () => {
    assert.deepEqual((await repo('merchantA').query('myBusinesses')).map(x => x.id), [a]);
    assert.deepEqual(requireSuccess(await fixture.users.merchantA.client.from('businesses').select('*').eq('id', b)), []);
    assert.deepEqual(requireSuccess(await fixture.users.merchantA.client.from('businesses').update({ name: 'Intrusión' }).eq('id', b).select()), []);
    assert.equal((await repo('merchantB').query('myBusinesses'))[0].name, 'Comercio Sintético B');
  });
  await check('Manager edita su comercio; staff sólo lee y ninguno accede al ajeno', async () => {
    requireSuccess(await fixture.admin.from('business_memberships').insert([
      { business_id: a, user_id: fixture.users.manager.id, role: 'manager' },
      { business_id: a, user_id: fixture.users.staff.id, role: 'staff' },
    ]));
    assert.equal((await repo('manager').query('myBusinesses'))[0].localityId, 'alumine');
    assert.equal((await repo('staff').query('myBusinesses'))[0].membershipRole, 'staff');
    await repo('manager').command('business.rename', { businessId: a, name: 'Cambio Por Manager' });
    assert.deepEqual(requireSuccess(await fixture.users.staff.client.from('businesses').update({ name: 'Intrusión' }).eq('id', a).select()), []);
    for (const name of ['manager', 'staff']) {
      assert.deepEqual(requireSuccess(await fixture.users[name].client.from('businesses').select('*').eq('id', b)), []);
      denied(await fixture.users[name].client.from('business_memberships').update({ role: 'owner' }).eq('user_id', fixture.users[name].id));
    }
  });
  await check('Cliente no aprueba negocios ni altera identidad/tenancy', async () => {
    for (const name of ['customerA', 'merchantA']) {
      denied(await fixture.users[name].client.from('businesses').update({ status: 'active' }).eq('id', a));
      denied(await fixture.users[name].client.from('businesses').update({ locality_id: crypto.randomUUID() }).eq('id', a));
      denied(await fixture.users[name].client.from('business_memberships').insert({ business_id: b, user_id: fixture.users[name].id, role: 'owner' }));
    }
  });
  await check('Metadata admin no concede permisos; esquema privado no expuesto', async () => {
    requireSuccess(await fixture.users.customerA.client.auth.updateUser({ data: { role: 'admin', roles: ['admin'] } }));
    assert.deepEqual((await repo('customerA').session()).actor.roles, ['customer']);
    assert.deepEqual(requireSuccess(await fixture.users.customerA.client.from('businesses').select('*')), []);
    denied(await fixture.users.customerA.client.schema('private').from('platform_admins').select('*'));
  });
  await check('Admin provisionado explícitamente revisa comercios pero no perfiles privados', async () => {
    assert.ok((await repo('admin').session()).actor.roles.includes('admin'));
    const rows = await repo('admin').query('adminBusinesses');
    assert.ok(rows.some(row => row.id === a) && rows.some(row => row.id === b));
    await assert.rejects(repo('customerA').query('adminBusinesses'), error => error.code === 'ROLE_REQUIRED');
    assert.deepEqual(requireSuccess(await fixture.users.admin.client.from('profiles').select('user_id')),
      [{ user_id: fixture.users.admin.id }]);
  });
  await check('Token de recuperación real es de un solo uso y permite cambiar contraseña', async () => {
    const user = fixture.users.driverA;
    const link = requireSuccess(await fixture.admin.auth.admin.generateLink({ type: 'recovery', email: user.email }));
    const recovery = publicClient();
    requireSuccess(await recovery.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'recovery' }));
    denied(await publicClient().auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'recovery' }));
    await createSupabaseRepository({ client: recovery }).updatePassword(`Recovered-${crypto.randomUUID()}-7`);
    await recovery.auth.signOut();
  });
  await check('Dos sesiones independientes leen el mismo perfil y negocio actualizado', async () => {
    const u = fixture.users.merchantA;
    const second = publicClient(); requireSuccess(await second.auth.signInWithPassword({ email: u.email, password: u.password }));
    const secondRepo = createSupabaseRepository({ client: second });
    await repo('merchantA').updateProfile({ name: 'Nombre Compartido', phone: '' });
    await repo('merchantA').command('business.rename', { businessId: a, name: 'Nombre Compartido Comercial' });
    assert.equal((await secondRepo.session()).actor.name, 'Nombre Compartido');
    assert.equal((await secondRepo.query('myBusinesses'))[0].name, 'Nombre Compartido Comercial');
    await second.auth.signOut();
  });
  await check('Sesión persistente restaurada, cambio de contraseña y logout real', async () => {
    const values = new Map(); const storage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
    const u = fixture.users.customerB;
    const first = publicClient(storage); requireSuccess(await first.auth.signInWithPassword({ email: u.email, password: u.password }));
    const restored = publicClient(storage); assert.equal(requireSuccess(await restored.auth.getUser()).user.id, u.id);
    const newPassword = `Updated-${crypto.randomUUID()}-9`;
    await createSupabaseRepository({ client: restored }).updatePassword(newPassword);
    await restored.auth.signOut();
    denied(await publicClient().auth.signInWithPassword({ email: u.email, password: u.password }));
    requireSuccess(await restored.auth.signInWithPassword({ email: u.email, password: newPassword }));
    const refreshToken = requireSuccess(await restored.auth.getSession()).session.refresh_token;
    await restored.auth.signOut();
    denied(await publicClient().auth.refreshSession({ refresh_token: refreshToken }));
    assert.equal(requireSuccess(await publicClient(storage).auth.getSession()).session, null);
  });
  await check('Anon puede leer localidad y no perfiles ni borradores', async () => {
    const anon = publicClient();
    assert.equal(requireSuccess(await anon.from('localities').select('slug'))[0].slug, 'alumine');
    denied(await anon.from('profiles').select('*'));
    assert.deepEqual(requireSuccess(await anon.from('businesses').select('*')), []);
  });
} finally {
  await fixture.cleanup();
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/supabase-phase1-api.json', JSON.stringify({ at: new Date().toISOString(),
    project: project.projectRef, checks: results, syntheticDataCleaned: true,
    limitations: ['No prueba entrega SMTP, signup público ni recuperación por correo.', 'No prueba pedidos, catálogo, Storage ni taxi.'] }, null, 2));
}
