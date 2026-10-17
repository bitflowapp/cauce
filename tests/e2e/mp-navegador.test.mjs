// El conductor de las páginas de Mercado Pago (scripts/lib/mp-navegador.mjs)
// contra páginas SIMULADAS en un navegador real: ingreso (usuario, contraseña,
// código por casilleros), consentimiento, checkout con tarjeta, un reCAPTCHA
// invisible que no frena nada, un desafío visible y un bloqueo por IP que sí.
// Cada página exige que el valor correcto haya caído en el campo correcto.
// Prueba la lógica del conductor, no a Mercado Pago (eso es pagos-sandbox).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { authorizeSeller, payCheckout, Blocked, HOLDER, TEST_CARD, SANDBOX_EMAIL } from '../../scripts/lib/mp-navegador.mjs';

const SITE = 'https://sitio.test';
const ACCOUNT = { user: 'TESTUSER1234567', password: 'clave-de-prueba', code: '246810' };
const html = (title, body) => ({ status: 200, contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><html lang="es"><head><title>${title}</title></head><body>${body}</body></html>` });
const invisibleCaptcha = '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible" '
  + 'style="width:256px;height:60px;position:fixed;bottom:0;right:0;border:0"></iframe>';
const go = target => `location.href = ${JSON.stringify(target)}`;
// Un botón con su código en el atributo onclick, escapado como HTML.
const button = (label, code, extra = '') => `<button ${extra} onclick="${code.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${label}</button>`;

// Un "Mercado Pago" en memoria: cada pantalla sólo avanza con el dato correcto.
async function provider(context, { challenge = false, blockedIp = false } = {}) {
  await context.route('https://www.google.com/recaptcha/**', route => route.fulfill(html('reCAPTCHA',
    '<p>protegido por reCAPTCHA · Privacidad · Condiciones</p>')));
  await context.route('https://auth.mercadopago.com.ar/**', route => {
    if (blockedIp) return route.fulfill(html('Mercado Libre', '<h1>Hubo un error accediendo a esta pagina...</h1>'));
    return route.fulfill(html('Autorizar', `<h1>CAUCE Sandbox quiere acceder a tu cuenta</h1>
      ${button('Autorizar', go(`${SITE}/index.html#panel/x/pagos?conexion=ok`))}`));
  });
  await context.route('https://www.mercadolibre.com/login/**', route => {
    const step = new URL(route.request().url()).pathname.split('/').pop();
    if (step === 'usuario') {
      return route.fulfill(html('Ingresá', `${invisibleCaptcha}
        <label for="user_id">E-mail, teléfono o usuario</label><input id="user_id" name="user_id">
        ${button('Continuar', `document.querySelector('#user_id').value === ${JSON.stringify(ACCOUNT.user)}
          ? ${go('https://www.mercadolibre.com/login/clave')} : document.body.append('usuario incorrecto')`, 'type="submit"')}`));
    }
    if (step === 'clave') {
      return route.fulfill(html('Contraseña', `${challenge ? '<iframe src="https://www.google.com/recaptcha/api2/bframe?k=x" style="width:400px;height:580px;border:0"></iframe>' : invisibleCaptcha}
        <label for="password">Contraseña</label><input id="password" type="password">
        ${button('Iniciar sesión', `document.querySelector('#password').value === ${JSON.stringify(ACCOUNT.password)}
          ? ${go('https://www.mercadolibre.com/login/codigo')} : document.body.append('clave incorrecta')`)}`));
    }
    // Código: un casillero por dígito.
    return route.fulfill(html('Código', `<h1>Ingresá el código que te enviamos por e-mail</h1>
      ${[0, 1, 2, 3, 4, 5].map(index => `<input maxlength="1" aria-label="Dígito ${index + 1}">`).join('')}
      ${button('Confirmar', `[...document.querySelectorAll('input')].map(input => input.value).join('') === ${JSON.stringify(ACCOUNT.code)}
        ? ${go('https://auth.mercadopago.com.ar/authorization?consent=1')} : document.body.append('código incorrecto')`)}`));
  });
  await context.route(`${SITE}/**`, route => route.fulfill(html('CAUCE', '<p>Panel</p>')));
}

// Checkout con tarjeta: el titular decide el resultado; cada campo se valida.
async function checkout(context) {
  const expected = { cardNumber: TEST_CARD.number, cardExpiration: TEST_CARD.expiry, securityCode: TEST_CARD.cvv,
    docNumber: TEST_CARD.docNumber, email: SANDBOX_EMAIL };
  await context.route('https://www.mercadopago.com.ar/checkout/**', route => {
    const step = new URL(route.request().url()).searchParams.get('paso') || 'inicio';
    if (step === 'inicio') {
      return route.fulfill(html('Checkout', `<p>Todo listo para pagar tu pedido. Si el pago queda pendiente te avisamos.</p>
        ${button('Tarjeta de crédito', go('https://www.mercadopago.com.ar/checkout/v1?paso=tarjeta'))}
        ${button('Dinero disponible', go('https://www.mercadopago.com.ar/checkout/v1?paso=login'))}`));
    }
    if (step === 'tarjeta') {
      return route.fulfill(html('Tarjeta', `
        <label>Número de tarjeta <input name="cardNumber"></label>
        <label>Nombre del titular como figura en la tarjeta <input name="cardholderName"></label>
        <label>Vencimiento (MM/AA) <input name="cardExpiration"></label>
        <label>Código de seguridad <input name="securityCode"></label>
        <label>Tipo de documento <select name="docType"><option>CI</option><option>DNI</option></select></label>
        <label>Número de documento del titular <input name="docNumber"></label>
        <label>E-mail para el comprobante <input name="email" type="email"></label>
        ${button('Continuar', `
          const value = name => document.querySelector('[name=' + name + ']').value;
          const ok = ${JSON.stringify(expected)};
          const wrong = Object.keys(ok).filter(name => value(name).replace(/\\s/g, '') !== ok[name]);
          if (value('docType') !== 'DNI') wrong.push('docType');
          sessionStorage.setItem('titular', value('cardholderName'));
          wrong.length ? document.body.append('mal: ' + wrong.join(',')) : ${go('https://www.mercadopago.com.ar/checkout/v1?paso=cuotas')}`)}`));
    }
    if (step === 'cuotas') {
      return route.fulfill(html('Cuotas', `<p>Elegí la cantidad de cuotas</p>
        ${button('1 cuota de $ 3.000', go('https://www.mercadopago.com.ar/checkout/v1?paso=revisar'))}
        ${button('3 cuotas de $ 1.000', "document.body.append('cuotas equivocadas')")}`));
    }
    if (step === 'revisar') {
      return route.fulfill(html('Revisá', `<p>Revisá y confirmá tu pago</p>
        ${button('Pagar', go('https://www.mercadopago.com.ar/checkout/v1?paso=resultado'))}`));
    }
    return route.fulfill(html('Resultado', `<h1 id="resultado"></h1><script>
      const holder = sessionStorage.getItem('titular');
      document.querySelector('#resultado').textContent = holder === 'APRO' ? '¡Listo! Se acreditó tu pago'
        : holder === 'OTHE' ? 'Tu pago fue rechazado' : holder === 'CONT' ? 'Estamos procesando tu pago' : 'titular inesperado';
    </script>`));
  });
}

test('conductor: ingreso con usuario, contraseña y código por casilleros, y consentimiento; el reCAPTCHA invisible no frena', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ locale: 'es-AR' });
    await provider(context);
    const page = await context.newPage();
    await page.goto('https://www.mercadolibre.com/login/usuario');
    const trace = [];
    const result = await authorizeSeller(page, ACCOUNT, { siteUrl: SITE, trace, timeoutMs: 60000 });
    assert.equal(result, 'ok');
    assert.deepEqual(trace, ['usuario', 'contraseña', 'código de verificación', 'autorizar']);
    assert.equal(JSON.stringify(trace).includes(ACCOUNT.user), false, 'el rastro no guarda valores');
  } finally { await browser.close(); }
});

test('conductor: un desafío de captcha visible o el bloqueo por IP frenan con Blocked', async () => {
  const browser = await chromium.launch();
  try {
    for (const [options, reason] of [[{ challenge: true }, /captcha/], [{ blockedIp: true }, /bloqueado/]]) {
      const context = await browser.newContext();
      await provider(context, options);
      const page = await context.newPage();
      await page.goto(options.blockedIp ? 'https://auth.mercadopago.com.ar/authorization?x=1' : 'https://www.mercadolibre.com/login/usuario');
      await assert.rejects(authorizeSeller(page, ACCOUNT, { siteUrl: SITE, trace: [], timeoutMs: 30000 }),
        error => error instanceof Blocked && reason.test(error.message));
      await context.close();
    }
  } finally { await browser.close(); }
});

for (const [outcome, holder] of Object.entries(HOLDER)) {
  test(`conductor: checkout con la tarjeta de prueba y titular ${holder} → ${outcome}`, async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ locale: 'es-AR' });
      await checkout(context);
      const page = await context.newPage();
      await page.goto('https://www.mercadopago.com.ar/checkout/v1?paso=inicio');
      const trace = [];
      const result = await payCheckout(page, { holder, buyer: ACCOUNT, siteUrl: SITE, trace, timeoutMs: 90000 });
      assert.equal(result, outcome, trace.join(' → '));
      // "Todo listo" y "pendiente" en la primera pantalla no se leyeron como resultado.
      assert.ok(trace.includes('pagar'), 'sólo después de pagar');
      for (const field of ['número de tarjeta', 'titular', 'vencimiento', 'código de seguridad', 'documento', 'e-mail del comprobante']) {
        assert.ok(trace.includes(field), field);
      }
      assert.equal(trace.filter(name => ['usuario', 'contraseña', 'código de verificación'].includes(name)).length, 0,
        'no intentó ingresar ni escribió el código en la tarjeta');
    } finally { await browser.close(); }
  });
}
