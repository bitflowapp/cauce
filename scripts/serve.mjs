// Servidor estático mínimo para la vista previa y las pruebas E2E. Sirve sólo
// archivos dentro de la carpeta indicada, con tipos MIME correctos y sin caché
// para el documento (el resto lleva nombre por contenido).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };

export function createStaticServer({ root }) {
  const base = resolve(root);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      let path = normalize(join(base, decodeURIComponent(url.pathname)));
      if (path !== base && !path.startsWith(base + sep)) { response.writeHead(403).end(); return; }
      let info = await stat(path).catch(() => null);
      if (info?.isDirectory()) { path = join(path, 'index.html'); info = await stat(path).catch(() => null); }
      if (!info) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado'); return; }
      const type = TYPES[extname(path)] || 'application/octet-stream';
      const immutable = /\.[0-9a-f]{10}\.(js|css)$/.test(path) || path.includes(`${sep}fonts${sep}`);
      response.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'cache-control': type.startsWith('text/html') || path.endsWith('service-worker.js') ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' });
      response.end(await readFile(path));
    } catch {
      response.writeHead(500).end();
    }
  });
}
