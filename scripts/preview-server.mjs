// Sirve un build conectado para probarlo en el navegador:
//   npm run build:local && npm run preview        → contra el stack Supabase local
//   CAUCE_PREVIEW_DIR=dist-production npm run preview
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './server.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)), process.env.CAUCE_PREVIEW_DIR || '.local/preview');
const port = Number(process.env.PORT || 4174);
const server = createStaticServer({ root, preview: true });
server.on('error', error => { console.error(`No se pudo iniciar la vista previa: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`CAUCE · vista previa del build conectado · http://127.0.0.1:${port} · ${root}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
