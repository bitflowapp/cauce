// Borra lo que dejó una corrida de pruebas interrumpida contra CAUCE.
//
// Sólo toca cuentas sintéticas con el patrón exacto que crean las pruebas
// (`cauce-qa-<8 hex>-<nombre>@example.com`) y lo que cuelga de ellas. Cualquier
// otra fila queda intacta: si hubiera una cuenta real, este script no la ve.
//
// Uso:  node scripts/clean-qa-residue.mjs [--apply]
import { adminClient, project, requireSuccess } from '../tests/lib/supabase-real.mjs';

const QA_EMAIL = /^cauce-qa-[0-9a-f]{8}-[a-z]+@example\.com$/;
const apply = process.argv.includes('--apply');
const admin = adminClient();

const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
if (error) throw new Error('No se pudo listar las cuentas de CAUCE.');
const synthetic = list.users.filter(user => QA_EMAIL.test(user.email || ''));
const real = list.users.length - synthetic.length;

console.log(`Proyecto ${project.projectRef}: ${list.users.length} cuentas, ${synthetic.length} sintéticas.`);
if (real > 0) console.log(`${real} cuenta(s) no sintética(s): no se tocan.`);
if (!synthetic.length) { console.log('No hay residuo de pruebas que borrar.'); process.exit(0); }
for (const user of synthetic) console.log(`  · ${user.email}`);

const ids = synthetic.map(user => user.id);
const owned = requireSuccess(await admin.from('business_memberships').select('business_id').in('user_id', ids));
const businesses = [...new Set(owned.map(row => row.business_id))];
console.log(`Comercios sintéticos: ${businesses.length}.`);

if (!apply) {
  console.log('\nEjecutá otra vez con --apply para borrarlo.');
  process.exit(0);
}

requireSuccess(await admin.from('trips').delete().in('passenger_id', ids));
requireSuccess(await admin.from('orders').delete().in('customer_id', ids));
for (const id of businesses) {
  requireSuccess(await admin.from('orders').delete().eq('business_id', id));
  const paths = [];
  const folders = await admin.storage.from('business-media').list(`businesses/${id}`, { limit: 100 });
  for (const folder of folders.data || []) {
    const entries = await admin.storage.from('business-media').list(`businesses/${id}/${folder.name}`, { limit: 100 });
    for (const entry of entries.data || []) {
      if (entry.id) { paths.push(`businesses/${id}/${folder.name}/${entry.name}`); continue; }
      const leaves = await admin.storage.from('business-media').list(`businesses/${id}/${folder.name}/${entry.name}`, { limit: 100 });
      for (const leaf of leaves.data || []) paths.push(`businesses/${id}/${folder.name}/${entry.name}/${leaf.name}`);
    }
  }
  if (paths.length) await admin.storage.from('business-media').remove(paths);
  requireSuccess(await admin.from('businesses').delete().eq('id', id));
  console.log(`  · comercio ${id}: ${paths.length} archivo(s) borrado(s)`);
}
// `private.platform_admins` cae con la cuenta: la clave foránea es en cascada.
for (const user of synthetic) requireSuccess(await admin.auth.admin.deleteUser(user.id));
console.log(`\nBorradas ${synthetic.length} cuentas sintéticas y ${businesses.length} comercios.`);
