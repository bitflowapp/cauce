import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CONFIG } from '../js/config.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const failures=[];
async function walk(directory){const result=[];for(const file of await readdir(directory,{withFileTypes:true})){const p=resolve(directory,file.name);if(file.isDirectory())result.push(...await walk(p));else result.push(p);}return result;}
const sources=[...(await walk(resolve(root,'js'))),...(await walk(resolve(root,'scripts'))),...(await walk(resolve(root,'tests')))];
for(const path of sources.filter(path=>/\.(m?js)$/.test(path))){
  try{execFileSync(process.execPath,['--check',path],{stdio:'pipe'});}catch{failures.push(`Sintaxis inválida: ${path}`);}
  const source=await readFile(path,'utf8');
  const imports=[...source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)];
  for(const match of imports){try{await stat(resolve(dirname(path),match[1]));}catch{failures.push(`Import no resuelto: ${path} → ${match[1]}`);}}
}
const expected={ 'js/core/order-workflow.js':'da853c6a66cdd293372a42f5a80081c3119afc7e', 'tests/order-workflow.test.mjs':'b2576b6bfb919d3d16be83011d853f565e084f85' };
for(const [name,hash] of Object.entries(expected)){
  const bytes=await readFile(resolve(root,name));const actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(actual!==hash)failures.push(`La copia heredada cambió: ${name}`);
}
if(CONFIG.mode!=='demo'||CONFIG.liveOrders!==false||CONFIG.livePayments!==false)failures.push('Se intentó habilitar producción.');
const html=await readFile(resolve(root,'index.html'),'utf8');
if(!html.includes("connect-src 'none'"))failures.push('Falta el bloqueo de conexiones externas.');
if(/La Taba|la_taba|la-taba/i.test(html))failures.push('Branding residual visible.');
for(const path of (await walk(resolve(root,'js')))){
  const text=await readFile(path,'utf8');
  if(/https?:\/\//i.test(text))failures.push(`URL de red dentro del runtime demo: ${path}`);
  if(/\b(?:fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(/.test(text))failures.push(`Operación de red inesperada: ${path}`);
  if(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_]+|APP_USR-[0-9A-Za-z-]{20,}/.test(text))failures.push(`Posible credencial: ${path}`);
}
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log(`CHECK PASS · ${sources.filter(path=>/\.(m?js)$/.test(path)).length} archivos JS · imports · 2 hashes heredados · compuerta demo · escaneo estático acotado`);
