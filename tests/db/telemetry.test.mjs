// Registro de errores de la app: cualquiera con la clave pública puede
// reportar, así que el volumen y el contenido tienen que estar acotados en la
// base, no en el navegador.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './fixture.mjs';

const db = new PGlite();
const user = '30000000-0000-4000-8000-000000000001';
async function report(who, message = 'falla', context = {}) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${who ? 'authenticated' : 'anon'}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [who || '']);
    await tx.query("select set_config('request.jwt.claims', $1, true)",
      [who ? JSON.stringify({ sub: who, role: 'authenticated', is_anonymous: true }) : '']);
    return (await tx.query("select public.report_client_event('frontend_error', 'X', $1, '#panel', 'r1', $2::jsonb) as ok",
      [message, JSON.stringify(context)])).rows[0].ok;
  });
}
const count = async () => (await db.query('select count(*)::int as n from private.client_events')).rows[0].n;

before(async () => {
  await applyMigrations(db);
  await db.query('insert into auth.users (id, email, is_anonymous) values ($1, null, true)', [user]);
});
after(async () => { await db.close(); });

test('nunca guarda correos, teléfonos ni tokens, aunque el navegador no los haya limpiado', async () => {
  assert.equal(await report(null, 'fallo para vecina@example.com tel 2942 555123 token eyJabc.def.ghi',
    { email: 'otra@example.com', 'clave rara': 'x' }), true);
  const row = (await db.query('select message, context from private.client_events order by id desc limit 1')).rows[0];
  assert.doesNotMatch(row.message, /vecina@example\.com|2942 555123|eyJabc/);
  assert.doesNotMatch(JSON.stringify(row.context), /otra@example\.com/);
  assert.equal('clave rara' in row.context, false, 'sólo claves simples');
  await db.query('delete from private.client_events');
});

test('una cuenta no reporta más de 20 errores por minuto', async () => {
  const results = [];
  for (let i = 0; i < 25; i += 1) results.push(await report(user, `falla ${i}`));
  assert.equal(results.filter(Boolean).length, 20);
  assert.equal(await count(), 20);
  await db.query('delete from private.client_events');
});

test('en total, no más de 60 por minuto ni 5.000 por día, sin importar quién reporte', async () => {
  const results = [];
  for (let i = 0; i < 65; i += 1) results.push(await report(null, `visita ${i}`));
  assert.equal(results.filter(Boolean).length, 60);
  // Un día ya lleno (fuera del último minuto) también corta.
  await db.query('delete from private.client_events');
  await db.query(`insert into private.client_events (created_at, kind) select now() - interval '2 hours', 'frontend_error'
    from generate_series(1, 5000)`);
  assert.equal(await report(null, 'una más'), false);
  assert.equal(await count(), 5000);
  // Lo de hace más de un día no cuenta para el techo diario.
  await db.query("update private.client_events set created_at = now() - interval '2 days'");
  assert.equal(await report(null, 'otro día'), true);
});

test('el registro no se lee ni se escribe directo, y sólo administración lo consulta', async () => {
  await assert.rejects(db.transaction(async tx => {
    await tx.exec('set local role anon');
    return tx.query('select * from private.client_events');
  }), error => error.code === '42501');
  await assert.rejects(db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    return tx.query('select * from public.admin_client_events(5)');
  }), error => error.code === '42501');
});
