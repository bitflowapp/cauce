// Servidor estático mínimo para la vista previa y las pruebas E2E. Sirve sólo
// archivos dentro de la carpeta indicada, con tipos MIME correctos y sin caché
// para el documento (el resto lleva nombre por contenido).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

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
      const immutable = /\.[0-9A-Za-z]{8,10}\.(js|css)$/.test(path) || path.includes(`${sep}fonts${sep}`);
      let body = await readFile(path);
      const headers = { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'accept-encoding',
        'cache-control': type.startsWith('text/html') || path.endsWith('service-worker.js') ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' };
      // Compresión como la de cualquier hosting estático (texto: brotli o gzip).
      const accepts = String(request.headers['accept-encoding'] || '');
      if (/^(text\/|application\/(json|manifest)|image\/svg)/.test(type) && body.length > 1024) {
        if (/\bbr\b/.test(accepts)) { body = brotliCompressSync(body); headers['content-encoding'] = 'br'; }
        else if (/\bgzip\b/.test(accepts)) { body = gzipSync(body); headers['content-encoding'] = 'gzip'; }
      }
      response.writeHead(200, headers);
      response.end(body);
    } catch {
      response.writeHead(500).end();
    }
  });
}
