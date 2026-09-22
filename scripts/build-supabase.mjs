import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = JSON.parse(await readFile(resolve(root, 'supabase/project.json'), 'utf8'));
if (project.projectRef !== 'ygqbcvxdrewcnzedfcyo' || project.url !== 'https://ygqbcvxdrewcnzedfcyo.supabase.co'
  || !project.publishableKey.startsWith('sb_publishable_')) throw new Error('Destino CAUCE inválido.');
const output = resolve(root, '.local/supabase-preview');
await mkdir(resolve(output, 'js'), { recursive: true });
for (const name of ['assets', 'styles', 'manifest.webmanifest']) await cp(resolve(root, name), resolve(output, name), { recursive: true });
let html = await readFile(resolve(root, 'index.html'), 'utf8');
// CSP acotada al proyecto CAUCE: API, WebSocket de Realtime y el bucket de
// imágenes públicas. Sin comodines y sin ningún otro proyecto Supabase.
html = html.replace("connect-src 'none'", `connect-src 'self' ${project.url} wss://ygqbcvxdrewcnzedfcyo.supabase.co`);
html = html.replace("img-src 'self' data:", `img-src 'self' data: blob: ${project.url}`);
html = html.replace('<head>', '<head>\n  <meta name="referrer" content="no-referrer">');
await writeFile(resolve(output, 'index.html'), html);
await build({ absWorkingDir: root, entryPoints: ['js/app.js'], outfile: resolve(output, 'js/app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: false,
  plugins: [{ name: 'explicit-cauce-environment', setup(builder) {
    builder.onLoad({ filter: /[\\/]runtime-env\.js$/ }, () => ({ loader: 'js', resolveDir: root, contents: `
      import { createClient } from '@supabase/supabase-js';
      export const RUNTIME_ENV = Object.freeze({ environment: 'supabase', label: 'CAUCE conectado',
        description: 'Cuentas, comercios, pedidos y viajes guardados en CAUCE, compartidos entre dispositivos.',
        sharedPersistence: true, passwordAuth: true, redirectTo: location.origin + '/index.html',
        client: createClient(${JSON.stringify(project.url)}, ${JSON.stringify(project.publishableKey)}, {
          auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true,
            detectSessionInUrl: true, storageKey: 'cauce:production:auth' }
        }) });` }));
    builder.onLoad({ filter: /[\\/]config\.js$/ }, async args => ({ loader: 'js',
      contents: (await readFile(args.path, 'utf8'))
        .replace(/^(\s*)mode: 'demo'/m, "$1mode: 'production'")
        .replace(/^(\s*)liveOrders: false/m, "$1liveOrders: true") }));
  } }],
});
const bundle = await readFile(resolve(output, 'js/app.js'), 'utf8');
if (/sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(bundle)) {
  throw new Error('Credencial no publicable en el build.');
}
console.log('SUPABASE BUILD PASS · sólo CAUCE · publishable key · sin modificar dist/demo');
