import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/cdp.mjs';
import { createStaticServer } from '../scripts/server.mjs';
import { fixtures, project, requireSuccess } from './lib/supabase-real.mjs';

const fixture = await fixtures(['merchantA', 'merchantB']);
const server = createStaticServer({ root: fileURLToPath(new URL('../.local/supabase-preview', import.meta.url)), supabase: true });
const browsers = [];
const steps = [];
let passed = false;
const step = name => { steps.push(name); console.log(`PASS · ${name}`); };
const base = 'http://127.0.0.1:4174';
const ready = page => page.waitForFunction('document.querySelector("#main")?.getAttribute("aria-busy") === "false"', { timeout: 25000 });
async function visit(page, route) { await page.goto(`${base}/index.html#${route}`); await ready(page); }
async function login(page, user) {
  await visit(page, 'cuenta');
  await page.fill('#signin-email', user.email); await page.fill('#signin-password', user.password);
  await page.click('[data-form="sign-in"] button[type="submit"]');
  await page.waitForFunction('!!document.querySelector("#profile-name")', { timeout: 25000 });
  await ready(page);
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4174, '127.0.0.1', resolve); });
  for (let i = 0; i < 2; i++) browsers.push(await launchBrowser());
  const mobile = await browsers[0].newPage({ width: 390, height: 844, mobile: true });
  const desktop = await browsers[1].newPage({ width: 1440, height: 900, mobile: false });
  await login(mobile, fixture.users.merchantA); step('Login desde navegador móvil con Supabase Auth real');
  await mobile.reload(); await ready(mobile);
  assert.ok(await mobile.evaluate('!!document.querySelector("#profile-name")')); step('Sesión persiste al recargar');
  await mobile.fill('#profile-name', 'Persona Compartida');
  await mobile.click('[data-form="profile-update"] button');
  await mobile.waitForFunction('document.querySelector("#profile-name")?.value === "Persona Compartida"');
  await visit(mobile, 'panel');
  await mobile.fill('#biz-name', 'Negocio Compartido'); await mobile.click('[data-form="business-create"] button');
  await mobile.waitForFunction('!!document.querySelector("#connected-business-name")', { timeout: 25000 });
  await ready(mobile); const businessRoute = await mobile.evaluate('location.hash');
  step('Comercio y membresía creados desde la interfaz y persistidos en Postgres');
  await login(desktop, fixture.users.merchantA);
  assert.equal(await desktop.evaluate('document.querySelector("#profile-name").value'), 'Persona Compartida');
  await visit(desktop, businessRoute.slice(1));
  assert.equal(await desktop.evaluate('document.querySelector("#connected-business-name").value'), 'Negocio Compartido');
  step('Otra sesión independiente recibe perfil y comercio compartidos');
  await desktop.fill('#connected-business-name', 'Nombre Desde Computadora');
  await desktop.click('[data-form="business-rename"] button');
  await desktop.waitForFunction('document.querySelector("h1")?.textContent === "Nombre Desde Computadora"');
  await mobile.reload(); await ready(mobile);
  assert.equal(await mobile.evaluate('document.querySelector("#connected-business-name").value'), 'Nombre Desde Computadora');
  step('Cambio de nombre desde computadora visible al recargar sesión móvil');
  await mkdir('evidence/supabase', { recursive: true });
  await mobile.screenshot('evidence/supabase/mobile-business.png');
  await desktop.screenshot('evidence/supabase/desktop-business.png');
  await visit(desktop, 'cuenta'); await desktop.click('[data-action="sign-out"]');
  await desktop.waitForFunction('location.hash === "#inicio"');
  await visit(desktop, 'cuenta');
  await desktop.waitForFunction('!!document.querySelector("#signin-email")'); step('Logout elimina acceso autenticado');
  await login(desktop, fixture.users.merchantB); await visit(desktop, businessRoute.slice(1));
  assert.match(await desktop.text('#main'), /Sin acceso/); step('Cuenta comercial B no abre por URL el negocio de A');
  const link = requireSuccess(await fixture.admin.auth.admin.generateLink({ type: 'recovery', email: fixture.users.merchantA.email }));
  await mobile.goto(`${base}/index.html?token_hash=${encodeURIComponent(link.properties.hashed_token)}&type=recovery`);
  await ready(mobile);
  await mobile.waitForFunction('!!document.querySelector("#new-password")');
  assert.equal(await mobile.evaluate('location.search'), '');
  await mobile.fill('#new-password', `Restored-${crypto.randomUUID()}-9`);
  await mobile.click('[data-form="password-update"] button');
  await mobile.waitForFunction('document.querySelector("#main")?.innerText.includes("Contraseña actualizada.")', { timeout: 25000 });
  step('Callback de recuperación verifica token real, limpia URL y cambia contraseña (sin probar SMTP)');
  await visit(mobile, businessRoute.slice(1));
  await mobile.setOffline(true); await mobile.fill('#connected-business-name', 'Cambio Sin Red');
  await mobile.waitForFunction('document.querySelector("[data-form=business-rename] button").disabled');
  assert.equal(await mobile.evaluate('document.querySelector("[data-form=business-rename] button").disabled'), true);
  assert.equal(await mobile.evaluate('document.querySelector("#connected-business-name").value'), 'Cambio Sin Red');
  await mobile.setOffline(false);
  await mobile.waitForFunction('!document.querySelector("[data-form=business-rename] button").disabled');
  assert.equal(await mobile.evaluate('document.querySelector("#connected-business-name").value'), 'Cambio Sin Red');
  step('Offline conserva lo escrito al reconectar y bloquea envío mientras no hay red');
  const errors = [...mobile.consoleErrors, ...desktop.consoleErrors].filter(message => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|favicon/.test(message));
  assert.deepEqual(errors, []); step('Sin errores propios de JavaScript');
  passed = true;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  server.close();
  await fixture.cleanup();
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/supabase-phase1-browser.json', JSON.stringify({ at: new Date().toISOString(),
    project: project.projectRef, passed, steps, note: 'Chrome emulado 390/1440. No teléfono físico. Datos sintéticos eliminados.' }, null, 2));
}
