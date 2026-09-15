import { cp, mkdir, rm, lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(root,'dist');
try{if((await lstat(output)).isSymbolicLink())throw new Error('dist no puede ser un enlace simbólico.');}catch(error){if(error.code!=='ENOENT')throw error;}
await rm(output,{recursive:true,force:true});await mkdir(output);
for(const name of ['index.html','js','styles'])await cp(resolve(root,name),resolve(output,name),{recursive:true});
await writeFile(resolve(output,'DEPLOYMENT-NOTICE.txt'),'CAUCE 0.2.0 — DEMOSTRACIÓN LOCAL. No es una release candidata de producción. Sin autenticación, backend, pagos ni GPS reales.\n');
console.log('BUILD PASS · dist contiene solo la demo estática; no incluye tests, docs ni scripts.');
