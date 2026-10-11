// Service worker de CAUCE · Ferias: guarda sólo la cáscara de la aplicación
// (documento, JS, CSS, fuentes e íconos) para abrir rápido y sin conexión.
// Nunca guarda respuestas de Supabase ni URLs con parámetros (los enlaces de
// confirmación y recuperación no quedan en caché). El build fija la versión.
const CACHE = 'ferias-dev';
const SHELL = [];
const SUPABASE = '';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('ferias-') && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || (SUPABASE && url.origin === SUPABASE) || url.search) return;
  if (request.mode === 'navigate') {
    // Red primero para el documento: después de publicar, llega la versión nueva.
    event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(request).then(hit => hit || fetch(request)));
});
