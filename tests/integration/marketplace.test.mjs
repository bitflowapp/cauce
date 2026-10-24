// Marketplace multirrubro · fase 1 contra Supabase real (stack local). El
// recorrido completo va por el MISMO repositorio que usa la aplicación: alta
// con rubro, datos y catálogo, revisión administrativa, apertura, compra de una
// vecina sin cuenta y despacho del titular; más las reglas que la interfaz no
// impone pero la base sí (capacidades dentro del rubro y aislamiento entre
// comercios).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRepository } from '../../js/repositories/supabase-repository.js';
import {
  sql, account, guest, makeAdmin, order, transition, ok, failsWith, invisible,
  closeAll,
} from './harness.mjs';

const memory = { getItem: () => null, setItem() {}, removeItem() {} };
const people = {};
const repo = {};
let A;
let B;
let pan;

// Falla con el código indicado (de la base o del repositorio), nunca en silencio.
async function rejects(promise, codes, label) {
  const expected = [codes].flat();
  try {
    await promise;
  } catch (error) {
    assert.ok(expected.includes(error.code || error.technical?.code),
      `${label}: se esperaba ${expected.join(' o ')} y llegó ${(error.code || error.technical?.code)} (${error.message})`);
    return;
  }
  assert.fail(`${label}: la operación debía fallar y funcionó`);
}

before(async () => {
  for (const name of ['sellerA', 'sellerB', 'admin']) people[name] = await account(`market-${name}`);
  await makeAdmin(people.admin);
  for (const name of ['sellerA', 'sellerB', 'admin']) {
    repo[name] = createSupabaseRepository({ client: people[name].client, storage: memory });
  }
  people.buyer = await guest('market-buyer');
  // El segundo titular con su propio borrador de otro rubro, para el aislamiento.
  B = await repo.sellerB.command('business.create', {
    name: 'Servicios del Barrio', category: 'servicios',
    ownerName: 'Titular B', contactPhone: '2942 555022',
  });
});

after(async () => { await closeAll(Object.values(people)); });

test('el borrador nace con rubro y capacidades en una sola llamada al repositorio', async () => {
  A = await repo.sellerA.command('business.create', {
    name: 'Panadería Multirrubro', category: 'panaderia',
    ownerName: 'Titular de Panadería', contactPhone: '2942 555020',
  });
  assert.ok(A.id, 'alta real contra la base');
  const draft = (await sql`select b.status, c.slug as category, b.capabilities
    from public.businesses b left join public.business_categories c on c.id = b.category_id
    where b.id = ${A.id}`)[0];
  assert.equal(draft.status, 'draft');
  assert.equal(draft.category, 'panaderia');
  assert.deepEqual(draft.capabilities, ['products', 'prepared_food']);
  // El rubro se elige desde la lista pública (anon), con sus capacidades.
  pan = ok(await people.buyer.client.from('business_categories')
    .select('slug, name, capabilities').eq('slug', 'panaderia').single());
  assert.deepEqual(pan.capabilities, ['products', 'prepared_food']);
});

test('el titular completa datos y catálogo y la revisión administrativa aprueba', async () => {
  const updated = await repo.sellerA.command('business.update', { businessId: A.id,
    patch: { address: 'Conrado Villegas 40', hoursLabel: 'Lunes a sábado', pickupEnabled: true,
      publicPhone: '2942 555021' } });
  assert.equal(updated.address, 'Conrado Villegas 40');
  const contact = (await sql`select owner_name, phone from public.business_contacts
    where business_id = ${A.id}`)[0];
  assert.deepEqual(contact, { owner_name: 'Titular de Panadería', phone: '2942 555020' });
  pan = await repo.sellerA.command('product.create', { businessId: A.id,
    product: { name: 'Pan de campo', price: 4500, trackStock: true, stock: 10 } });
  assert.equal(pan.stock, 10);
  await repo.sellerA.command('business.submit', { businessId: A.id });
  await repo.admin.command('admin.reviewBusiness', { businessId: A.id, decision: 'approve', note: 'Aprobado en prueba' });
  const approved = (await sql`select status from public.businesses where id = ${A.id}`)[0];
  assert.equal(approved.status, 'active');
  await repo.sellerA.command('business.setOpen', { businessId: A.id, open: true });
  assert.equal((await sql`select "open" from public.businesses where id = ${A.id}`)[0].open, true);
});

test('la vecina compra sin cuenta y el titular despacha el pedido', async () => {
  const id = ok(await order(people.buyer, A.id, [{ product_id: pan.id, quantity: 2 }]));
  failsWith(await transition(people.buyer, id, 'accepted'), '42501');
  for (const next of ['accepted', 'preparing', 'ready', 'delivered']) {
    ok(await transition(people.sellerA, id, next), `transición ${next}`);
  }
  const row = (await sql`select status from public.orders where id = ${id}`)[0];
  assert.equal(row.status, 'delivered');
  const stock = (await sql`select stock from public.products where id = ${pan.id}`)[0].stock;
  assert.equal(stock, 8, 'el stock descontó lo comprado');
});

test('las capacidades se ajustan dentro del rubro y la base rechaza lo ajeno', async () => {
  const reduced = await repo.sellerA.command('business.update', { businessId: A.id,
    patch: { capabilities: ['products'] } });
  assert.deepEqual(reduced.capabilities, ['products']);
  // Restaurar el conjunto completo del rubro también pasa.
  assert.deepEqual(
    (await repo.sellerA.command('business.update', { businessId: A.id,
      patch: { capabilities: ['products', 'prepared_food'] } })).capabilities,
    ['products', 'prepared_food']);
  // Fuera del rubro, la base lo niega aunque el vocabulario lo reconozca.
  await rejects(repo.sellerA.command('business.update', { businessId: A.id,
    patch: { capabilities: ['services'] } }), '23514', 'capacidad de otro rubro');
  assert.deepEqual(
    (await sql`select capabilities from public.businesses where id = ${A.id}`)[0].capabilities,
    ['products', 'prepared_food']);
});

test('el borrador ajeno es invisible para extraños; lo publicado se puede leer, no escribir', async () => {
  const draft = await repo.sellerA.command('business.create', {
    name: 'Borrador Azul de Repuesto', category: 'almacen', ownerName: 'Titular de Panadería',
  });
  const draftRow = (await sql`select capabilities from public.businesses where id = ${draft.id}`)[0];
  assert.deepEqual(draftRow.capabilities, ['products']);
  const ownRow = (await sql`select capabilities from public.businesses where id = ${B.id}`)[0];
  assert.deepEqual(ownRow.capabilities, ['services']);
  // El borrador de A no se ve desde B ni desde la calle (anon).
  assert.equal(await invisible(people.sellerB.client.from('businesses').select('id').eq('id', draft.id)), true);
  assert.equal(await invisible(people.buyer.client.from('businesses').select('id').eq('id', draft.id)), true);
  // Lo publicado sí es público, pero otro titular no lo modifica ni trasmuta
  // sus capacidades: el UPDATE por RLS no toca ni una fila.
  assert.equal(await invisible(people.sellerB.client.from('businesses').select('id').eq('id', A.id)), false);
  assert.equal(await invisible(people.sellerB.client.from('businesses')
    .update({ capabilities: ['services'] }).eq('id', A.id).select()), true);
  assert.deepEqual(
    (await sql`select capabilities from public.businesses where id = ${A.id}`)[0].capabilities,
    ['products', 'prepared_food']);
});
