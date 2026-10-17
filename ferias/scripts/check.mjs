// Compuertas estáticas de CAUCE · Ferias: sintaxis, imports resueltos, nada que
// rompa la CSP (estilos o manejadores en línea), ninguna credencial
// privilegiada en el código del navegador y aislamiento de CAUCE · Aluminé.
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const rel = path => relative(root, path).split(sep).join('/');
const failures = [];
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path)); else out.push(path);
  }
  return out;
}
const browserCode = (await walk(resolve(root, 'js'))).filter(p => p.endsWith('.js'));
const nodeCode = [...await walk(resolve(root, 'scripts')), ...await walk(resolve(root, 'tests'))].filter(p => /\.m?js$/.test(p));
for (const path of [...browserCode, ...nodeCode, resolve(root, 'service-worker.js')]) {
  try { execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' }); } catch { failures.push(`Sintaxis inválida: ${rel(path)}`); }
  const source = await readFile(path, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    try { await stat(resolve(dirname(path), match[1])); } catch { failures.push(`Import no resuelto: ${rel(path)} → ${match[1]}`); }
  }
}
for (const path of [...browserCode, resolve(root, 'index.html')]) {
  const source = await readFile(path, 'utf8');
  const name = rel(path);
  // La CSP es style-src 'self' y script-src 'self': nada en línea.
  if (/\sstyle="/.test(source.replace(/style="display:block;width:\$\{width\}px;height:\$\{height\}px"/g, ''))) failures.push(`Atributo style en línea (lo bloquea la CSP): ${name}`);
  if (/\son(click|load|error|submit|change|input)=/i.test(source)) failures.push(`Manejador en línea (lo bloquea la CSP): ${name}`);
  if (/service_role|sb_secret_/.test(source)) failures.push(`Credencial privilegiada mencionada en código del navegador: ${name}`);
  if (/ygqbcvxdrewcnzedfcyo/.test(source)) failures.push(`Referencia al proyecto de CAUCE · Aluminé: ${name}`);
  if (/\beval\(|new Function\(/.test(source)) failures.push(`eval/new Function: ${name}`);
  if (/document\.write\(/.test(source)) failures.push(`document.write: ${name}`);
  // innerHTML sólo con plantillas escapadas (String(html`…`) o String(componente)).
  for (const match of source.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)) {
    if (!/^\s*String\(/.test(match[1]) && !/^\s*''/.test(match[1])) failures.push(`innerHTML sin plantilla escapada en ${name}: ${match[1].slice(0, 60)}`);
  }
  for (const match of source.matchAll(/insertAdjacentHTML\([^,]+,\s*([^)]+)\)/g)) {
    if (!/^\s*String\(/.test(match[1])) failures.push(`insertAdjacentHTML sin plantilla escapada en ${name}`);
  }
}
const config = await readFile(resolve(root, 'supabase/config.toml'), 'utf8');
if (!/^project_id = "cauce-ferias"$/m.test(config)) failures.push('supabase/config.toml: el project_id debe ser cauce-ferias (aislado de Aluminé).');
if (/^port = 5432[0-9]$/m.test(config)) failures.push('supabase/config.toml: usa puertos del stack de Aluminé (5432x).');
if (failures.length) { console.error(`CHECK FAIL\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log(`CHECK PASS · ${browserCode.length} módulos del navegador · ${nodeCode.length} scripts y pruebas · CSP sin código en línea · sin credenciales privilegiadas · aislado de Aluminé`);
