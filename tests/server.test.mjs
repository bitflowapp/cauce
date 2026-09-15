import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createStaticServer } from '../scripts/server.mjs';
async function withServer(action){const server=createStaticServer();server.listen(0,'127.0.0.1');await once(server,'listening');try{await action(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(resolve=>server.close(resolve));}}
test('HTTP sirve la aplicación y bloquea conexiones externas por CSP',()=>withServer(async url=>{const r=await fetch(url);assert.equal(r.status,200);assert.match(await r.text(),/CAUCE/);assert.match(r.headers.get('content-security-policy'),/connect-src 'none'/);}));
test('HTTP no sirve documentación, scripts, tests ni .env',()=>withServer(async url=>{for(const path of ['/scripts/server.mjs','/.env','/docs/AUDIT.md','/package.json','/tests/cauce.test.mjs'])assert.equal((await fetch(url+path)).status,404);}));
test('HTTP deniega métodos de escritura',()=>withServer(async url=>assert.equal((await fetch(url,{method:'POST'})).status,405)));
test('HTTP rechaza host ajeno',()=>withServer(async url=>{
  // node:http permite enviar Host literalmente; fetch puede normalizarlo.
  const status=await new Promise((resolve,reject)=>{const request=get(url,{headers:{host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});
  assert.equal(status,403);
}));
test('HTTP sirve módulos con MIME correcto',()=>withServer(async url=>{const r=await fetch(url+'/js/core/order-workflow.js');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);}));
test('HTTP no expone rutas codificadas fuera del árbol público',()=>withServer(async url=>{for(const p of ['/js/%2e%2e%2f.env','/js/%2e%2e%2fscripts%2fserver.mjs','/styles/%00.css'])assert.ok((await fetch(url+p)).status>=400);}));
