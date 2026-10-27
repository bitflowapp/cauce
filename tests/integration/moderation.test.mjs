// Moderación de productos contra Supabase real (stack local): un alta nace
// pendiente, la vidriera sólo muestra aprobados y el pedido no puede incluir
// nada sin aprobar. Sólo administración decide; el comercio corrige y reenvía.
// Todo queda auditado y cada comercio ve únicamente su propio historial.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRepository } from '../../js/repositories/supabase-repository.js';
import {
  sql, account, guest, makeAdmin, order, ok, failsWith, invisible, closeAll, run,
} from './harness.mjs';

const memory = { getItem: () => null, setItem() {}, removeItem() {} };
const people = {};
const repo = {};
const panName = `Pan de campo ${run}`;
const searchTerm = `campo ${run}`;
let A;
let pan;
let pending;

async function rejects(promise, codes, label) {
  const expected = [codes].flat();
  try {
    await promise;
  } catch (error) {
    assert.ok(expected.includes(error.code || error.technical?.code),
      `${label}: se esperaba ${expected.join(' o ')} y llegó ${error.code || error.technical?.code} (${error.message})`);
    return;
  }
  assert.fail(`${label}: la operación debía fallar y funcionó`);
}

async function createBusiness(name) {
  const business = await repo.sellerA.command('business.create', {
    name, category: 'gastronomia', ownerName: 'Titular de Moderación', contactPhone: '2942 555030',
  });
  await repo.sellerA.command('business.update', { businessId: business.id,
    patch: { address: 'Conrado Villegas 30', hoursLabel: 'Lunes a sábado', pickupEnabled: true,
      publicPhone: '2942 555030' } });
  return business;
}

async function publish(business) {
  await repo.sellerA.command('business.submit', { businessId: business.id });
  await repo.admin.command('admin.reviewBusiness', { businessId: business.id, decision: 'approve', note: 'Aprobado en prueba' });
  await repo.sellerA.command('business.setOpen', { businessId: business.id, open: true });
}

before(async () => {
  for (const name of ['sellerA', 'sellerB', 'admin']) people[name] = await account(`mod-${name}`);
  people.buyer = await guest('mod-buyer');
  await makeAdmin(people.admin);
  for (const name of ['sellerA', 'sellerB', 'admin', 'buyer']) {
    repo[name] = createSupabaseRepository({ client: people[name].client, storage: memory });
  }
  A = await createBusiness('Moderación Alfa');
  // El producto que habilita la publicación del comercio también nace
  // pendiente: publicar el comercio no publica su catálogo.
  pan = await repo.sellerA.command('product.create', { businessId: A.id,
    product: { name: panName, price: 4500, trackStock: true, stock: 10 } });
  pending = pan;
  await publish(A);
});

after(async () => { await closeAll(Object.values(people)); });

test('un producto nuevo nace pendiente: no se publica, no se busca y no se puede pedir', async () => {
  assert.equal(pending.status, 'pending');
  assert.equal((await repo.sellerA.query('products', { businessId: A.id })).length, 0, 'la vidriera no lo muestra');
  assert.equal((await repo.sellerA.query('products', { businessId: A.id, includeAll: true }))[0].status, 'pending',
    'el panel del comercio sí lo muestra');
  assert.equal(await invisible(people.buyer.client.from('products').select('id').eq('id', pending.id)), true);
  assert.equal(await invisible(people.sellerB.client.from('products').select('id').eq('id', pending.id)), true,
    'otro comercio no ve el borrador ajeno');
  assert.deepEqual(await repo.buyer.query('searchCatalog', { query: searchTerm }), {}, 'la búsqueda pública no lo encuentra');
  failsWith(await order(people.buyer, A.id, [{ product_id: pending.id, quantity: 1 }]), '23514');

  const queue = await repo.admin.query('adminQueue');
  assert.equal(queue.products.some(item => item.id === pending.id && item.businessName.includes('Moderación Alfa')), true);

  // El propio comercio no puede aprobarse, ni otro comercio revisar.
  await rejects(repo.sellerA.command('admin.reviewProduct', { productId: pending.id, decision: 'approve', note: '' }),
    '42501', 'el comercio se autoaprueba');
  await rejects(repo.sellerB.command('admin.reviewProduct', { productId: pending.id, decision: 'approve', note: '' }),
    '42501', 'otro comercio aprueba');

  await repo.admin.command('admin.reviewProduct', { productId: pending.id, decision: 'approve', note: 'Aprobado en prueba' });
  const visible = await repo.buyer.query('products', { businessId: A.id });
  assert.deepEqual(visible.map(item => item.id), [pending.id]);
  assert.deepEqual(Object.keys(await repo.buyer.query('searchCatalog', { query: searchTerm })), [A.id]);
  const id = ok(await order(people.buyer, A.id, [{ product_id: pending.id, quantity: 1 }]));
  assert.ok(id, 'el producto aprobado se puede pedir');

  const events = ok(await people.sellerA.client.from('product_review_events')
    .select('from_status,to_status,actor_id,actor_role,note').eq('product_id', pending.id).order('created_at'));
  assert.deepEqual(events.map(event => [event.from_status, event.to_status, event.actor_role, event.note]),
    [['pending', 'approved', 'admin', 'Aprobado en prueba']]);
  assert.equal(events[0].actor_id, people.admin.id);
  assert.equal(await invisible(people.sellerB.client.from('product_review_events').select('id').eq('product_id', pending.id)), true);
});

test('rechazo con observación, reenvío del comercio y nueva aprobación', async () => {
  const product = await repo.sellerA.command('product.create', { businessId: A.id,
    product: { name: 'Torta de prueba', price: 9000 } });
  await rejects(repo.admin.command('admin.reviewProduct', { productId: product.id, decision: 'reject', note: '' }),
    'REVIEW_NOTE_REQUIRED', 'rechazo sin motivo');
  await repo.admin.command('admin.reviewProduct', { productId: product.id, decision: 'reject',
    note: 'Falta describir los ingredientes' });
  const mine = (await repo.sellerA.query('products', { businessId: A.id, includeAll: true }))
    .find(item => item.id === product.id);
  assert.deepEqual([mine.status, mine.reviewNote], ['rejected', 'Falta describir los ingredientes']);
  assert.equal(await invisible(people.buyer.client.from('products').select('id').eq('id', product.id)), true);

  await rejects(repo.sellerB.command('product.submit', { productId: product.id }), '42501', 'otro comercio lo reenvía');
  assert.equal(await repo.sellerA.command('product.submit', { productId: product.id }), 'pending');
  assert.equal((await repo.sellerA.query('products', { businessId: A.id, includeAll: true }))
    .find(item => item.id === product.id).status, 'pending');
  await repo.admin.command('admin.reviewProduct', { productId: product.id, decision: 'approve', note: 'Corregido' });
  assert.equal(await invisible(people.buyer.client.from('products').select('id').eq('id', product.id)), false);

  const events = ok(await people.sellerA.client.from('product_review_events')
    .select('from_status,to_status,actor_role').eq('product_id', product.id).order('created_at'));
  assert.deepEqual(events.map(event => [event.from_status, event.to_status, event.actor_role]),
    [['pending', 'rejected', 'admin'], ['rejected', 'pending', 'merchant'], ['pending', 'approved', 'admin']]);
});

test('suspender lo publicado lo retira de la vidriera; el comercio puede reenviarlo', async () => {
  await repo.admin.command('admin.reviewProduct', { productId: pan.id, decision: 'suspend',
    note: 'Revisar el precio publicado' });
  assert.equal(await invisible(people.buyer.client.from('products').select('id').eq('id', pan.id)), true);
  failsWith(await order(people.buyer, A.id, [{ product_id: pan.id, quantity: 1 }]), '23514');
  const queue = await repo.admin.query('adminQueue');
  assert.equal(queue.productHistory.some(item => item.id === pan.id && item.reviewNote === 'Revisar el precio publicado'), true);

  assert.equal(await repo.sellerA.command('product.submit', { productId: pan.id }), 'pending');
  await repo.admin.command('admin.reviewProduct', { productId: pan.id, decision: 'approve', note: 'Revisado' });
  assert.equal((await repo.buyer.query('products', { businessId: A.id })).some(item => item.id === pan.id), true);

  const events = ok(await people.sellerA.client.from('product_review_events')
    .select('from_status,to_status,actor_role,note').eq('product_id', pan.id).order('created_at'));
  assert.deepEqual(events.map(event => [event.from_status, event.to_status, event.actor_role]),
    [['pending', 'approved', 'admin'], ['approved', 'suspended', 'admin'], ['suspended', 'pending', 'merchant'], ['pending', 'approved', 'admin']]);
  assert.equal((await sql`select count(*)::int as n from public.product_review_events where product_id = ${pan.id}`)[0].n, 4);
});
