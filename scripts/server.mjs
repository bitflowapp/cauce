import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";
export function createStaticServer({ root = ROOT } = {}) {
  const base = resolve(root);
  return createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const finish = (status, text) => { res.statusCode = status; res.end(req.method === 'HEAD' ? '' : text); };
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return finish(403, 'Host no permitido.');
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow','GET, HEAD'); return finish(405,'Método no permitido.'); }
    try {
      const parsed = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(parsed.pathname);
      if (path === '/') path = '/index.html';
      if (path.includes('\0') || path.includes('\\') || path.split('/').some(part=>part==='..'||part==='.')) return finish(400,'Ruta inválida.');
      if (!(path === '/index.html' || /^\/(js|styles|assets)\//.test(path))) return finish(404,'No encontrado.');
      const target = resolve(base, `.${path}`);
      if (!target.startsWith(base + sep)) return finish(403,'Ruta no permitida.');
      const actual = await realpath(target);
      if (!actual.startsWith(base + sep)) return finish(403,'Ruta no permitida.');
      const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.avif':'image/avif'}[extname(actual)];
      if (!mime || !(await stat(actual)).isFile()) return finish(404,'No encontrado.');
      res.setHeader('Content-Type',mime);
      if (req.method==='HEAD') return finish(200,'');
      res.end(await readFile(actual));
    } catch(error) { finish(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400, 'No se pudo abrir el recurso.'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||4173);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT debe estar entre 1024 y 65535.');
  const server=createStaticServer();
  server.on('error',error=>{ console.error(`No se pudo iniciar CAUCE: ${error.message}`);process.exitCode=1; });
  server.listen(port,'127.0.0.1',()=>console.log(`CAUCE · Aluminé — DEMO LOCAL\nhttp://127.0.0.1:${port}\nSin conexiones a La Taba ni pagos. Ctrl+C para detener.`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
