// Service worker de CAUCE · Aluminé.
//
// Sólo hace que la aplicación abra sin conexión y que los recursos estáticos
// carguen rápido. NO guarda operaciones para enviarlas después: si no hay
// conexión, la aplicación lo dice y no confirma nada. Una confirmación en
// diferido daría por recibido un pedido que ningún comercio vio.
const CACHE = 'cauce-shell-v3';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/cauce.css',
  './styles/favicon.svg',
  './js/app.js',
  './js/config.js',
  './js/runtime-env.js',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Un recurso que falle no debe impedir la instalación del resto.
    await Promise.allSettled(SHELL.map(path => cache.add(path)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// Sólo se guarda la cáscara estática de la aplicación. Cualquier otra ruta va a
// la red sin pasar por acá: nada privado —sesión, pedidos, imágenes de un
// comercio, mensajes en vivo— puede quedar guardado en este dispositivo ni
// servirse después a otra sesión del mismo navegador.
const CACHEABLE = /\.(css|js|mjs|svg|png|jpe?g|webp|avif|ico|woff2?|webmanifest)$/i;

function isPrivateRequest(request) {
  return request.headers.has('Authorization')
    || request.headers.has('apikey')
    || request.headers.has('Range')
    || request.credentials === 'include';
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (isPrivateRequest(request)) return;

  const url = new URL(request.url);
  // Supabase (Auth, REST, Storage y Realtime) es otro origen: no se intercepta.
  if (url.origin !== self.location.origin) return;
  // Las llamadas al backend local nunca se cachean ni se responden desde caché:
  // una respuesta vieja aparentaría una operación que no ocurrió.
  if (url.pathname.includes('/api/')) return;
  // Un enlace de confirmación o de recuperación llega con el token en la
  // consulta. Nada con consulta se intercepta ni se guarda: ni el token ni la
  // respuesta que produce pueden quedar en este dispositivo.
  if (url.search) return;

  // El documento va primero a la red, para no servir una versión vieja de la app.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put('./index.html', response.clone()).catch(() => {});
        }
        return response;
      } catch {
        // Ni red ni copia guardada: se explica qué pasa en vez de dejar el
        // error genérico del navegador, que parece una aplicación rota.
        return (await caches.match('./index.html')) || offlineDocument();
      }
    })());
    return;
  }

  if (!CACHEABLE.test(url.pathname)) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch {
      return new Response('', { status: 504, statusText: 'Sin conexión' });
    }
  })());
});

function offlineDocument() {
  const body = `<!doctype html><html lang="es-AR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CAUCE · sin conexión</title></head>
<body style="font-family:system-ui,sans-serif;margin:0;padding:40px 24px;background:#f8fafc;color:#0f172a">
<h1 style="font-size:20px;color:#143d34">Sin conexión</h1>
<p style="font-size:14px;line-height:1.5">No pudimos abrir CAUCE y todavía no hay una copia guardada en este dispositivo.
Volvé a intentar cuando tengas conexión.</p>
<p style="font-size:13px;color:#536b63">No quedó ninguna operación a medias.</p>
</body></html>`;
  return new Response(body, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
