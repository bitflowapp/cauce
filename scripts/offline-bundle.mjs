// Empaquetador acotado al grafo ESM de esta entrega, sin dependencias externas.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const modules=new Map();
const symbols=new Map();
async function add(path){
  const id=relative(root,path).replaceAll('\\','/');
  if(modules.has(id))return id;
  let source=await readFile(path,'utf8');modules.set(id,'');
  const imports=[...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/g)];
  for(const match of imports){
    if(!match[2].startsWith('.'))throw new Error('Solo se permiten imports locales.');
    const dependency=await add(resolve(dirname(path),match[2]));
    const bindings=match[1].split(',').map(value=>value.trim()).filter(Boolean).map(value=>value.replace(/\s+as\s+/,': ')).join(', ');
    source=source.replace(match[0],`const { ${bindings} } = require(${JSON.stringify(dependency)});`);
  }
  const names=[...source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map(m=>m[1]);
  source=source.replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\s)/g,'');
  if(/\bimport\s*[{(']/.test(source)||/\bexport\s/.test(source))throw new Error(`Forma ESM no soportada: ${id}`);
  symbols.set(id,names);modules.set(id,source);return id;
}
const entry=await add(resolve(root,'js/app.js'));
const bundle=`(() => {\n'use strict';\nconst modules = {\n${[...modules].map(([id,source])=>`${JSON.stringify(id)}: (exports, require) => {\n${source}\nObject.assign(exports, {${symbols.get(id).join(',')}});\n}`).join(',\n')}\n};\nconst cache = new Map();\nfunction require(id) { if(cache.has(id))return cache.get(id);const result=Object.create(null);cache.set(id,result);modules[id](result,require);return result; }\nrequire(${JSON.stringify(entry)});\n})();`;
await mkdir(resolve(root,'evidence'),{recursive:true});
await writeFile(resolve(root,'evidence/offline.bundle.js'),bundle);
const css=(await readFile(resolve(root,'styles/cauce.css'),'utf8')).replaceAll("url('../assets/", "url('assets/");
let html=await readFile(resolve(root,'index.html'),'utf8');
const hash=value=>createHash('sha256').update(value).digest('base64');
html=html.replace(/<link[^>]+rel="(?:stylesheet|icon|modulepreload|preload)"[^>]*>/g,'')
  .replace(/<script type="module" src="js\/app.js"><\/script>/,'')
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(bundle)}'; style-src 'sha256-${hash(css)}'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'">`)
  .replace('</head>',`<style>${css}</style></head>`)
  .replace('</body>',`<script>${bundle}</script></body>`);
await writeFile(resolve(root,'CAUCE-demo.html'),html);
try { await writeFile(resolve(root,'dist/CAUCE-demo.html'),html); } catch (_) { /* sin dist/ no se copia */ }
console.log(`OFFLINE BUILD PASS · ${modules.size} módulos empaquetados · CSP con hashes · sin acceso a red`);
