import { createStaticServer } from './server.mjs';
import { fileURLToPath } from 'node:url';
const server = createStaticServer({ root: fileURLToPath(new URL('../.local/supabase-preview', import.meta.url)),
  supabase: true });
server.listen(4174, '127.0.0.1', () => console.log('CAUCE conectado · http://127.0.0.1:4174 · cuentas reales; pedidos deshabilitados'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
