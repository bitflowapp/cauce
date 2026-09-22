import { execSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

export const project = JSON.parse(await readFile(new URL('../../supabase/project.json', import.meta.url), 'utf8'));
if (project.projectRef !== 'ygqbcvxdrewcnzedfcyo' || project.url !== 'https://ygqbcvxdrewcnzedfcyo.supabase.co') {
  throw new Error('Real tests can only target the explicit CAUCE project.');
}
export function publicClient(storage) {
  return createClient(project.url, project.publishableKey, { auth: { persistSession: Boolean(storage),
    storage, autoRefreshToken: false, detectSessionInUrl: false } });
}
export function adminClient() {
  // Credentials are captured in process memory. Never print CLI stdout/stderr/errors.
  let keys;
  try {
    const raw = execSync('npx --yes supabase@2.117.0 projects api-keys --project-ref ygqbcvxdrewcnzedfcyo --reveal -o json',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(raw);
    keys = Array.isArray(parsed) ? parsed : parsed.keys;
  } catch { throw new Error('Could not obtain CAUCE test credentials from authenticated CLI.'); }
  const key = keys?.find(k => k.type === 'secret' && !k.disabled)?.api_key
    || keys?.find(k => k.name === 'service_role')?.api_key;
  if (!key || key.includes('*')) throw new Error('CAUCE server-side test key unavailable.');
  return createClient(project.url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export function requireSuccess(result) {
  if (result.error) throw new Error(`Supabase operation failed (${result.error.code || result.error.status || 'unknown'}).`);
  return result.data;
}
async function provisionSyntheticAdmin(userId) {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('Invalid synthetic user id');
  await mkdir('.local', { recursive: true });
  await writeFile('.local/qa-admin.sql', `insert into private.platform_admins(user_id) values ('${userId}');`);
  try {
    execSync('npx --yes supabase@2.117.0 db query --linked --project-ref ygqbcvxdrewcnzedfcyo --file .local/qa-admin.sql',
      { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error('Could not provision the synthetic CAUCE admin.'); }
}
export async function fixtures(names) {
  const admin = adminClient();
  const run = randomUUID().slice(0, 8);
  const users = {};
  const businesses = [];
  // El orden importa: pedidos y viajes referencian cuentas y comercios con
  // borrado restringido, y los archivos subidos no se van solos.
  async function cleanup() {
    for (const user of Object.values(users)) await user.client.auth.signOut({ scope: 'global' });
    const ids = Object.values(users).map(user => user.id);
    if (ids.length) {
      const owned = requireSuccess(await admin.from('business_memberships').select('business_id').in('user_id', ids));
      for (const row of owned) if (!businesses.includes(row.business_id)) businesses.push(row.business_id);
      requireSuccess(await admin.from('trips').delete().in('passenger_id', ids));
      requireSuccess(await admin.from('orders').delete().in('customer_id', ids));
    }
    for (const id of businesses) {
      requireSuccess(await admin.from('orders').delete().eq('business_id', id));
      const listed = await admin.storage.from('business-media').list(`businesses/${id}`, { limit: 100 });
      for (const folder of listed.data || []) {
        const inner = await admin.storage.from('business-media').list(`businesses/${id}/${folder.name}`, { limit: 100 });
        const paths = [];
        for (const entry of inner.data || []) {
          if (entry.id) { paths.push(`businesses/${id}/${folder.name}/${entry.name}`); continue; }
          const deeper = await admin.storage.from('business-media').list(`businesses/${id}/${folder.name}/${entry.name}`, { limit: 100 });
          for (const leaf of deeper.data || []) paths.push(`businesses/${id}/${folder.name}/${entry.name}/${leaf.name}`);
        }
        if (paths.length) await admin.storage.from('business-media').remove(paths);
      }
      requireSuccess(await admin.from('businesses').delete().eq('id', id));
    }
    for (const user of Object.values(users)) requireSuccess(await admin.auth.admin.deleteUser(user.id));
  }
  try {
    for (const name of names) {
      const email = `cauce-qa-${run}-${name.toLowerCase()}@example.com`;
      const password = `Qa-${randomUUID()}-7`;
      const { user } = requireSuccess(await admin.auth.admin.createUser({ email, password, email_confirm: true,
        user_metadata: { display_name: 'Cuenta Sintética', phone: '' } }));
      const client = publicClient();
      users[name] = { id: user.id, email, password, client };
      if (name === 'admin') await provisionSyntheticAdmin(user.id);
      requireSuccess(await client.auth.signInWithPassword({ email, password }));
    }
    return { admin, users, businesses, cleanup, run };
  } catch (error) { await cleanup(); throw error; }
}
