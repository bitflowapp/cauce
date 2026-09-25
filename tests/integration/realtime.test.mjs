// Realtime real: cada suscriptor recibe sólo las filas que RLS le deja leer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { account, anonClient, makeAdmin, publishedBusiness, order, transition, ok, closeAll } from './harness.mjs';

const people = {};
let A;
const channels = [];

before(async () => {
  for (const name of ['ownerA', 'ownerB', 'customerA', 'customerB', 'admin']) people[name] = await account(name);
  await makeAdmin(people.admin);
  A = await publishedBusiness(people.ownerA, people.admin, { name: 'Vivo' });
  // B es un comercio real: escucha como comercio, no como cuenta sin rol.
  await publishedBusiness(people.ownerB, people.admin, { name: 'Otro' });
});
// Cada canal abierto mantiene vivo un WebSocket: se cierran todos.
after(async () => { await closeAll([...Object.values(people), ...channels]); });

// SUBSCRIBED sólo confirma el canal: los cambios de Postgres empiezan a llegar
// cuando Realtime avisa "Subscribed to PostgreSQL" (con el stack en frío, varios
// segundos después). Se espera ese aviso, como hace la aplicación.
function listen(client, filter, timeout = 30000) {
  const events = [];
  return new Promise((resolve, reject) => {
    let lastError = '';
    const timer = setTimeout(() => reject(new Error(`Realtime no confirmó la suscripción a Postgres ${lastError}`)), timeout);
    const channel = client.channel(`qa-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', ...(filter ? { filter } : {}) },
        payload => events.push(payload))
      // Un error acá es transitorio: Realtime reintenta solo y después avisa "ok".
      .on('system', {}, payload => {
        if (payload?.extension !== 'postgres_changes') return;
        if (payload.status !== 'ok') { lastError = String(payload.message || ''); return; }
        clearTimeout(timer);
        resolve({ events, channel });
      })
      .subscribe((state, error) => {
        if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') { clearTimeout(timer); reject(error || new Error(state)); }
      });
    channels.push({ client, channel });
  });
}
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(events, predicate, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (events.some(predicate)) return true;
    await settle(150);
  }
  return false;
}

test('el comercio recibe al instante sus pedidos y nunca los de otro comercio', async () => {
  const mine = await listen(people.ownerA.client, `business_id=eq.${A.id}`);
  const spy = await listen(people.ownerB.client, `business_id=eq.${A.id}`);
  const spyAll = await listen(people.ownerB.client);
  const outsider = await listen(people.customerB.client);
  const anon = await listen(anonClient());
  await settle(500);
  const id = ok(await order(people.customerA, A.id, [{ product_id: A.products.untracked.id, quantity: 1 }]));
  assert.ok(await waitFor(mine.events, event => event.new?.id === id), 'el comercio A ve entrar el pedido');
  await settle(1500);
  for (const [label, listener] of [['comercio B con filtro de A', spy], ['comercio B sin filtro', spyAll],
    ['otro cliente', outsider], ['visita sin sesión', anon]]) {
    assert.equal(listener.events.some(event => event.new?.id === id || event.old?.id === id), false, label);
  }
});

test('la persona ve el cambio de estado de su pedido; otra persona no', async () => {
  const id = ok(await order(people.customerA, A.id, [{ product_id: A.products.untracked.id, quantity: 2 }]));
  const owner = await listen(people.customerA.client, `id=eq.${id}`);
  const stranger = await listen(people.customerB.client, `id=eq.${id}`);
  await settle(500);
  ok(await transition(people.ownerA, id, 'accepted'));
  assert.ok(await waitFor(owner.events, event => event.new?.id === id && event.new?.status === 'accepted'));
  await settle(1500);
  assert.equal(stranger.events.length, 0);
});
