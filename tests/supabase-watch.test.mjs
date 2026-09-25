// Suscripción en vivo del repositorio Supabase, con un cliente Realtime mínimo:
// fija cuándo la aplicación vuelve a consultar. El comportamiento del servidor
// (SUBSCRIBED primero, "Subscribed to PostgreSQL" segundos después) está
// comprobado contra el stack real en tests/integration/realtime.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRepository } from '../js/repositories/supabase-repository.js';

function fakeRealtime() {
  const channels = [];
  const client = {
    auth: {},
    from() { throw new Error('esta prueba no consulta tablas'); },
    channel(name) {
      const handlers = [];
      const channel = {
        name, handlers, removed: false, status: null,
        on(type, filter, callback) { handlers.push({ type, filter, callback }); return channel; },
        subscribe(callback) { channel.status = callback; return channel; },
        emit(type, payload) { for (const handler of handlers) if (handler.type === type) handler.callback(payload); },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel(channel) { channel.removed = true; },
  };
  return { client, channels };
}
const memory = { getItem: () => null, setItem() {}, removeItem() {} };

test('el panel vuelve a consultar cuando Realtime confirma que los cambios de Postgres ya llegan', () => {
  const { client, channels } = fakeRealtime();
  const repository = createSupabaseRepository({ client, redirectTo: 'http://127.0.0.1:4174/index.html', storage: memory });
  const seen = [];
  const statuses = [];
  const stop = repository.watch({ kind: 'businessOrders', businessId: 'b1' }, payload => seen.push(payload),
    status => statuses.push(status));
  const [channel] = channels;
  assert.deepEqual(channel.handlers.find(handler => handler.type === 'postgres_changes').filter,
    { event: '*', schema: 'public', table: 'orders', filter: 'business_id=eq.b1' });

  // El canal está unido, pero un pedido creado ahora todavía no generaría evento.
  channel.status('SUBSCRIBED');
  assert.deepEqual(seen, []);
  // Un fallo al suscribirse a Postgres se informa; Realtime reintenta solo.
  channel.emit('system', { extension: 'postgres_changes', status: 'error', message: 'reintentando' });
  assert.deepEqual(statuses, ['SUBSCRIBED', 'CHANNEL_ERROR']);
  // Confirmado: se vuelve a consultar para cubrir lo que pasó en el hueco.
  channel.emit('system', { extension: 'postgres_changes', status: 'ok', message: 'Subscribed to PostgreSQL' });
  assert.deepEqual(seen, [{ eventType: 'READY' }]);
  assert.deepEqual(statuses, ['SUBSCRIBED', 'CHANNEL_ERROR', 'SUBSCRIBED']);
  // Avisos de otras extensiones no disparan nada.
  channel.emit('system', { extension: 'broadcast', status: 'ok' });
  assert.equal(seen.length, 1);

  stop();
  assert.equal(channel.removed, true);
});

test('cada vista escucha sólo su alcance y un alcance desconocido no abre canal', () => {
  const { client, channels } = fakeRealtime();
  const repository = createSupabaseRepository({ client, redirectTo: 'http://127.0.0.1:4174/index.html', storage: memory });
  repository.watch({ kind: 'order', orderId: 'o1' }, () => {});
  repository.watch({ kind: 'myOrders', customerId: 'c1' }, () => {});
  assert.deepEqual(channels.map(channel => channel.handlers.find(handler => handler.type === 'postgres_changes').filter.filter),
    ['id=eq.o1', 'customer_id=eq.c1']);
  const stop = repository.watch({ kind: 'todo' }, () => {});
  assert.equal(channels.length, 2);
  stop();
});

// Conexión trabada: sin respuesta ni error. El repositorio corta la consulta
// y avisa en vez de dejar el panel esperando para siempre.
function queryClient(respond) {
  const builder = {
    signal: null,
    select() { return builder; }, eq() { return builder; }, or() { return builder; },
    order() { return builder; }, limit() { return builder; }, maybeSingle() { return builder; },
    abortSignal(signal) { builder.signal = signal; return builder; },
    then(resolve, reject) { return respond(builder.signal).then(resolve, reject); },
  };
  return { auth: {}, from: () => builder, rpc: () => builder };
}

test('una consulta trabada se corta y se avisa como conexión lenta', async () => {
  // Como postgrest-js: un fetch abortado vuelve como { error }, no como excepción.
  const client = queryClient(signal => new Promise(resolve => signal.addEventListener('abort',
    () => resolve({ data: null, error: { message: 'AbortError: signal is aborted without reason', code: '' } }))));
  const reported = [];
  const repository = createSupabaseRepository({ client, storage: memory, requestTimeoutMs: 30,
    onError: error => reported.push(error.code) });
  const started = Date.now();
  await assert.rejects(repository.query('businessOrders', { businessId: 'b1' }),
    error => error.code === 'NETWORK_TIMEOUT' && /muy lenta/.test(error.message));
  assert.ok(Date.now() - started < 2000, 'no espera más que el límite');
  assert.deepEqual(reported, ['NETWORK_TIMEOUT'], 'queda en el registro de errores de la app');
});

test('una respuesta a tiempo pasa sin cambios', async () => {
  const client = queryClient(() => Promise.resolve({ data: [], error: null }));
  const repository = createSupabaseRepository({ client, storage: memory, requestTimeoutMs: 1000 });
  assert.deepEqual(await repository.query('businessOrders', { businessId: 'b1' }), []);
});
