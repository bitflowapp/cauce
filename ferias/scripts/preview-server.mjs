// Vista previa del build local: http://127.0.0.1:4274
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './serve.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)), process.env.FERIAS_PREVIEW_DIR || '.local/preview');
const port = Number(process.env.PORT || 4274);
createStaticServer({ root }).listen(port, '127.0.0.1', () => {
  console.log(`CAUCE · Ferias en http://127.0.0.1:${port}/index.html  (sirviendo ${root})`);
});
