// Autenticación por la interfaz, con correos reales entregados por SMTP a Mailpit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  account, admin, closeAll, run, mailFor, linkFrom,
  BASE, startPreview, stopPreview, browsersToRun, launch, person, open, ready, signIn, toastText, expectToast, shot,
} from './harness.mjs';

const people = {};
before(async () => {
  await startPreview();
  for (const engine of browsersToRun) people[engine] = await account(`auth-${engine}`);
});
after(async () => { await stopPreview(); await closeAll(Object.values(people)); });

for (const engine of browsersToRun) {
  test(`${engine}: registro con confirmación por correo, abierta en otro dispositivo`, async () => {
    const browser = await launch(engine);
    try {
      const phone = await person(browser, { label: 'registro' });
      const laptop = await person(browser, { label: 'correo en otro equipo' });
      const email = `qa-${run}-alta-${engine}@cauce.test`;
      const password = `Alta${randomUUID().slice(0, 8)}4`;
      const since = Date.now() - 1000;
      await open(phone.page, '#cuenta');
      await phone.page.getByRole('tab', { name: 'Crear cuenta' }).click();
      await phone.page.fill('#reg-name', 'Titular Nueva');
      await phone.page.fill('#reg-email', email);
      await phone.page.fill('#reg-phone', '2942 402233');
      await phone.page.fill('#reg-password', password);
      await phone.page.locator('form[data-form="register"] button[type="submit"]').click();
      await phone.page.getByText(`Te enviamos un correo a ${email}`).waitFor({ timeout: 15000 });
      // Sin confirmar no entra, y el mensaje dice qué hacer.
      await phone.page.fill('#signin-email', email);
      await phone.page.fill('#signin-password', password);
      await phone.page.locator('form[data-form="sign-in"] button[type="submit"]').click();
      assert.match(await toastText(phone.page), /Confirmá tu correo/);
      const first = linkFrom(await mailFor(email, { subject: 'Confirmá tu correo en CAUCE', after: since }));

      // "¿No te llegó?": se reenvía desde la misma pantalla y vale el enlace nuevo.
      await phone.page.waitForTimeout(1500); // tope de Auth: un correo por segundo por casilla
      const resentAt = Date.now();
      await phone.page.locator('summary', { hasText: '¿No te llegó el correo de confirmación?' }).click();
      await phone.page.fill('#resend-email', email);
      await phone.page.locator('form[data-form="resend-confirmation"] button[type="submit"]').click();
      await phone.page.getByText('Si hay una cuenta sin confirmar con ese correo').waitFor({ timeout: 15000 });
      const link = linkFrom(await mailFor(email, { subject: 'Confirmá tu correo en CAUCE', after: resentAt }));
      assert.notEqual(link.searchParams.get('token_hash'), first.searchParams.get('token_hash'), 'el reenvío trae un enlace nuevo');
      await laptop.page.goto(link.href);
      await laptop.page.getByText('Tu correo quedó confirmado').waitFor({ timeout: 15000 });
      assert.equal(await laptop.page.evaluate(() => location.search), '', 'el token no queda en la barra de direcciones');
      await signIn(phone.page, { email, password });
      assert.equal(await phone.page.locator('#account-link').textContent(), 'TN');
      assert.deepEqual([...phone.problems, ...laptop.problems], []);
    } finally { await browser.close(); }
  });

  test(`${engine}: ingreso, clave incorrecta, sesión que persiste y cierre desde otra pestaña`, async () => {
    const browser = await launch(engine);
    try {
      const user = people[engine];
      const tab = await person(browser, { label: 'pestaña 1' });
      const page = tab.page;
      await open(page, '#cuenta');
      await page.fill('#signin-email', user.email);
      await page.fill('#signin-password', 'ClaveIncorrecta9');
      await page.locator('form[data-form="sign-in"] button[type="submit"]').click();
      assert.equal(await toastText(page), 'Correo o contraseña incorrectos.');
      await page.fill('#signin-email', `nadie-${run}@cauce.test`);
      await page.locator('#toast').evaluate(element => { element.hidden = true; });
      await page.locator('form[data-form="sign-in"] button[type="submit"]').click();
      assert.equal(await toastText(page), 'Correo o contraseña incorrectos.', 'no revela si la cuenta existe');
      await signIn(page, user);
      await page.reload();
      await ready(page);
      assert.notEqual(await page.locator('#account-link').textContent(), 'Ingresar', 'la sesión sobrevive a la recarga');

      // Cambiar la clave con la sesión abierta exige la actual.
      const previous = user.password;
      const changed = `Cambio${randomUUID().slice(0, 8)}5`;
      await open(page, '#cuenta');
      await page.locator('summary', { hasText: 'Cambiar contraseña' }).click();
      await page.fill('#current-password', 'NoEsLaActual9');
      await page.fill('#new-password', changed);
      await page.locator('form[data-form="password-update"] button[type="submit"]').click();
      await expectToast(page, 'La contraseña actual no es correcta.');
      await page.fill('#current-password', previous);
      await page.fill('#new-password', changed);
      await page.locator('form[data-form="password-update"] button[type="submit"]').click();
      await expectToast(page, 'Contraseña actualizada.');
      user.password = changed;

      // Misma persona, segunda pestaña del mismo navegador.
      const second = await tab.context.newPage();
      await second.goto(`${page.url().split('#')[0]}#cuenta`);
      await ready(second);
      await second.getByRole('button', { name: /Cerrar sesión/ }).click();
      await ready(second);
      await page.waitForFunction(() => document.querySelector('#account-link')?.textContent === 'Ingresar', null, { timeout: 15000 });

      // La clave anterior ya no entra; la nueva sí.
      await open(page, '#cuenta');
      await page.fill('#signin-email', user.email);
      await page.fill('#signin-password', previous);
      await page.locator('#toast').evaluate(element => { element.hidden = true; });
      await page.locator('form[data-form="sign-in"] button[type="submit"]').click();
      assert.equal(await toastText(page), 'Correo o contraseña incorrectos.');
      await signIn(page, user);
      assert.deepEqual(tab.problems, []);
    } finally { await browser.close(); }
  });

  test(`${engine}: recuperación de contraseña con el enlace abierto en otro dispositivo`, async () => {
    const browser = await launch(engine);
    try {
      const user = people[engine];
      const phone = await person(browser, { label: 'pide' });
      const mail = await person(browser, { label: 'abre el correo' });
      const again = await person(browser, { label: 'reusa el enlace' });
      const since = Date.now() - 1000;
      await open(phone.page, '#cuenta');
      await phone.page.locator('summary', { hasText: '¿Olvidaste tu contraseña?' }).click();
      await phone.page.fill('#reset-email', user.email);
      await phone.page.locator('form[data-form="password-reset"] button[type="submit"]').click();
      await phone.page.getByText('Si el correo corresponde a una cuenta').waitFor({ timeout: 15000 });
      const link = linkFrom(await mailFor(user.email, { subject: 'Recuperar tu contraseña de CAUCE', after: since }));

      await mail.page.goto(link.href);
      await mail.page.waitForFunction(() => location.hash === '#recuperar');
      await ready(mail.page);
      await shot(mail.page, `${engine}-recuperar-contrasena`);
      const next = `Nueva${randomUUID().slice(0, 8)}8`;
      await mail.page.fill('#recovery-password', next);
      await mail.page.fill('#recovery-confirm', `${next}x`);
      await mail.page.locator('form[data-form="password-recovery"] button[type="submit"]').click();
      assert.equal(await toastText(mail.page), 'Las dos contraseñas no coinciden.');
      await mail.page.fill('#recovery-confirm', next);
      await mail.page.locator('form[data-form="password-recovery"] button[type="submit"]').click();
      await expectToast(mail.page, 'Listo: tu contraseña nueva ya funciona.');

      // El mismo enlace ya no sirve.
      await again.page.goto(link.href);
      await again.page.getByText('El enlace venció o ya se usó').first().waitFor({ timeout: 15000 });

      // La clave anterior deja de funcionar; la nueva entra.
      await open(phone.page, '#cuenta');
      await phone.page.fill('#signin-email', user.email);
      await phone.page.fill('#signin-password', user.password);
      await phone.page.locator('form[data-form="sign-in"] button[type="submit"]').click();
      assert.equal(await toastText(phone.page), 'Correo o contraseña incorrectos.');
      user.password = next;
      await signIn(phone.page, user);
      assert.deepEqual([...phone.problems, ...mail.problems, ...again.problems], []);
    } finally { await browser.close(); }
  });
  test(`${engine}: una invitación lleva a elegir contraseña y después se ingresa con ella`, async () => {
    const browser = await launch(engine);
    try {
      const invited = await person(browser, { label: 'invitada' });
      const email = `qa-${run}-invitada-${engine}@cauce.test`;
      const since = Date.now() - 1000;
      const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${BASE}/index.html` });
      assert.equal(error, null);
      const link = linkFrom(await mailFor(email, { subject: 'Te invitaron a CAUCE', after: since }));
      await invited.page.goto(link.href);
      await invited.page.waitForFunction(() => location.hash === '#recuperar');
      await ready(invited.page);
      await invited.page.getByRole('heading', { name: 'Elegí tu contraseña' }).waitFor();
      const password = `Invita${randomUUID().slice(0, 8)}3`;
      await invited.page.fill('#recovery-password', password);
      await invited.page.fill('#recovery-confirm', password);
      await invited.page.locator('form[data-form="password-recovery"] button[type="submit"]').click();
      await expectToast(invited.page, 'Listo: tu contraseña nueva ya funciona.');
      // Desde otro dispositivo, la contraseña elegida es la que entra.
      const later = await person(browser, { label: 'otro dispositivo' });
      await signIn(later.page, { email, password });
      assert.notEqual(await later.page.locator('#account-link').textContent(), 'Ingresar');
      assert.deepEqual([...invited.problems, ...later.problems], []);
    } finally { await browser.close(); }
  });
}
