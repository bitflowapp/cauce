// El service worker corre fuera de la aplicación y decide qué queda guardado en
// el dispositivo. Esta prueba lo ejecuta de verdad —no lee su texto— con un
// entorno mínimo, y comprueba qué peticiones toca y cuáles deja pasar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const ORIGIN = 'https://cauce.example';
const source = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');

function headers(entries = {}) {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { has: name => map.has(String(name).toLowerCase()), get: name => map.get(String(name).toLowerCase()) };
}
const request = (url, options = {}) => ({
  url, method: options.method || 'GET', mode: options.mode || 'no-cors',
  credentials: options.credentials || 'same-origin', headers: headers(options.headers),
});

function loadWorker() {
  const listeners = new Map();
  const stored = new Map();
  // La caché real acepta una petición o una ruta: acá se guarda por su URL.
  const keyOf = key => key?.url || String(key);
  const cache = {
    async put(key, value) { stored.set(keyOf(key), value); },
    async match(key) { return stored.get(keyOf(key)) || null; },
    async add() {},
  };
  const fetched = [];
  const context = {
    self: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      location: { origin: ORIGIN },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      async open() { return cache; },
      async keys() { return []; },
      async delete() { return true; },
      async match(key) { return stored.get(keyOf(key)) || null; },
    },
    fetch: async input => { fetched.push(input.url || input); return { ok: true, type: 'basic', clone: () => ({}) }; },
    Response: class { constructor(body, init) { this.body = body; Object.assign(this, init); } },
    URL,
    console,
  };
  runInNewContext(source, context);
  // Devuelve la respuesta que el worker decidió dar, o `null` si no intervino.
  const handle = req => {
    let answered = null;
    listeners.get('fetch')({ request: req, respondWith: value => { answered = value; } });
    return answered;
  };
  return { handle, fetched, stored };
}

test('el worker no intercepta nada de Supabase: Auth, REST, Storage ni Realtime', () => {
  const { handle } = loadWorker();
  for (const url of [
    'https://ygqbcvxdrewcnzedfcyo.supabase.co/auth/v1/token?grant_type=password',
    'https://ygqbcvxdrewcnzedfcyo.supabase.co/rest/v1/orders?select=*',
    'https://ygqbcvxdrewcnzedfcyo.supabase.co/storage/v1/object/public/business-media/x.webp',
    'https://ygqbcvxdrewcnzedfcyo.supabase.co/realtime/v1/websocket',
  ]) {
    assert.equal(handle(request(url)), null, `No debía tocar ${url}`);
  }
});

test('una petición con credenciales o token nunca pasa por la caché', () => {
  const { handle } = loadWorker();
  assert.equal(handle(request(`${ORIGIN}/js/app.js`, { headers: { Authorization: 'Bearer x' } })), null);
  assert.equal(handle(request(`${ORIGIN}/js/app.js`, { headers: { apikey: 'x' } })), null);
  assert.equal(handle(request(`${ORIGIN}/js/app.js`, { credentials: 'include' })), null);
  assert.equal(handle(request(`${ORIGIN}/js/app.js`, { method: 'POST' })), null);
});

test('el enlace de recuperación no se intercepta ni se guarda', () => {
  const { handle, stored } = loadWorker();
  assert.equal(handle(request(`${ORIGIN}/index.html?token_hash=secreto&type=recovery`, { mode: 'navigate' })), null);
  assert.equal(stored.size, 0);
});

test('sólo la cáscara estática se guarda, y el documento va primero a la red', async () => {
  const { handle, fetched, stored } = loadWorker();
  assert.equal(handle(request(`${ORIGIN}/api/orders`)), null);
  assert.equal(handle(request(`${ORIGIN}/algo/privado`)), null);
  const asset = handle(request(`${ORIGIN}/styles/cauce.css`));
  assert.ok(asset, 'Una hoja de estilos propia sí se cachea');
  await asset;
  const document = handle(request(`${ORIGIN}/index.html`, { mode: 'navigate' }));
  assert.ok(document, 'El documento lo sirve el worker');
  await document;
  assert.deepEqual(fetched, [`${ORIGIN}/styles/cauce.css`, `${ORIGIN}/index.html`]);
  assert.deepEqual([...stored.keys()].sort(), [`${ORIGIN}/styles/cauce.css`, './index.html'].sort());
});
