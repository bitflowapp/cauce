// Recorre las páginas REALES de Mercado Pago (modo de prueba) con un navegador:
// ingreso de una cuenta de prueba, consentimiento OAuth y pago en Checkout Pro
// con tarjetas de prueba. Sin conocer el diseño exacto de cada pantalla: en
// cada vuelta mira qué hay visible (en la página y en sus iframes) y hace UNA
// acción, hasta llegar a la dirección esperada.
//
// Nunca deja rastro de un valor: el registro de acciones guarda sólo nombres
// ("usuario", "contraseña", "código") y las capturas tapan todos los campos y
// el nombre de la cuenta. Si el proveedor bloquea la IP o pide un captcha, se
// detiene con Blocked: eso lo resuelve una persona (modo asistido), no un truco.

export class Blocked extends Error {
  constructor(reason) {
    super(`El proveedor frenó la automatización: ${reason}.`);
    this.name = 'Blocked';
    this.reason = reason;
  }
}

// Un desafío que pide una persona. Un reCAPTCHA invisible (el sello
// "protegido por reCAPTCHA" de muchas páginas de ingreso) no lo es.
const CAPTCHA_TEXT = /no soy un robot|no sos un robot|verific(á|a) que (sos|eres) (una persona|humano)|resolv(é|e) el desaf[ií]o/i;
const CAPTCHA_FRAME = /recaptcha|hcaptcha|captcha/i;
const IP_BLOCK_TEXT = /Hubo un error accediendo a esta p[aá]gina|Access Denied|Request blocked/i;
// Tarjeta de prueba pública de la documentación de Mercado Pago (Argentina).
export const TEST_CARD = Object.freeze({ number: '5031755734530604', cvv: '123', expiry: '11/30', month: '11', year: '30',
  docType: 'DNI', docNumber: '12345678' });
// Titular → resultado del pago de prueba (documentación de tarjetas de prueba).
export const HOLDER = Object.freeze({ approved: 'APRO', rejected: 'OTHE', pending: 'CONT' });
export const SANDBOX_EMAIL = 'test@testuser.com';

// Texto visible de la página y sus iframes, sin los del captcha (su sello
// dice "reCAPTCHA" aunque no haya ningún desafío).
async function bodyText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    if (CAPTCHA_FRAME.test(frame.url())) continue;
    parts.push(await frame.evaluate(() => document.body?.innerText || '').catch(() => ''));
  }
  return parts.join('\n');
}

// ¿Hay un desafío de captcha a la vista? El sello invisible no cuenta; el
// cuadro "No soy un robot" o la ventana del desafío, sí.
async function visibleCaptcha(page) {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!CAPTCHA_FRAME.test(url) || /size=invisible/.test(url)) continue;
    const element = await frame.frameElement().catch(() => null);
    if (!element) continue;
    const shown = await element.evaluate(node => {
      const box = node.getBoundingClientRect();
      const inView = box.width > 30 && box.height > 30 && box.bottom > 0 && box.right > 0
        && box.top < innerHeight && box.left < innerWidth;
      const style = getComputedStyle(node);
      return inView && style.visibility !== 'hidden' && style.display !== 'none'
        && (typeof node.checkVisibility !== 'function' || node.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
    }).catch(() => false);
    if (shown) return true;
  }
  return false;
}

// Primer elemento visible y habilitado que cumpla `selector` en cualquier frame.
async function firstVisible(page, selector, { empty = false } = {}) {
  for (const frame of page.frames()) {
    const handles = await frame.$$(selector).catch(() => []);
    for (const handle of handles) {
      const ok = await handle.evaluate((element, onlyEmpty) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const visible = box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        return visible && !element.disabled && !element.readOnly && (!onlyEmpty || !element.value);
      }, empty).catch(() => false);
      if (ok) return handle;
    }
  }
  return null;
}

// Un campo por lo que dice de sí mismo: name, id, placeholder, aria-label,
// autocomplete, data-testid y el texto de su etiqueta.
async function fieldFor(page, pattern, { tag = 'input', empty = true } = {}) {
  for (const frame of page.frames()) {
    const handle = await frame.evaluateHandle(([source, flags, wanted, onlyEmpty]) => {
      const test = new RegExp(source, flags);
      const candidates = [...document.querySelectorAll(wanted)];
      const describe = element => [element.name, element.id, element.placeholder, element.getAttribute('aria-label'),
        element.getAttribute('autocomplete'), element.getAttribute('data-testid'),
        element.labels?.[0]?.textContent, element.closest('label')?.textContent,
        element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : '']
        .filter(Boolean).join(' | ');
      return candidates.find(element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!(box.width > 0 && box.height > 0) || style.visibility === 'hidden' || element.disabled) return false;
        if (element.type === 'hidden' || element.type === 'radio' || element.type === 'checkbox') return false;
        if (onlyEmpty && element.tagName !== 'SELECT' && element.value) return false;
        return test.test(describe(element));
      }) || null;
    }, [pattern.source, pattern.flags, tag, empty]).catch(() => null);
    const element = handle?.asElement();
    if (element) return element;
  }
  return null;
}

// Botón, enlace, opción o radio por su texto visible, en cualquier frame.
async function clickable(page, pattern) {
  for (const frame of page.frames()) {
    const handle = await frame.evaluateHandle(([source, flags]) => {
      const test = new RegExp(source, flags);
      const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="option"], [role="radio"], '
        + 'label, li[id], input[type="submit"], input[type="radio"] + *')];
      return candidates.find(element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const text = (element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && !element.disabled
          && element.getAttribute('aria-disabled') !== 'true' && text.length < 120 && test.test(text);
      }) || null;
    }, [pattern.source, pattern.flags]).catch(() => null);
    const element = handle?.asElement();
    if (element) return element;
  }
  return null;
}

async function type(handle, value) {
  await handle.click({ timeout: 5000 }).catch(() => {});
  await handle.fill('').catch(() => {});
  // Tecla por tecla: los campos con máscara (tarjeta, vencimiento) validan al tipear.
  await handle.type(String(value), { delay: 40 });
}

// Captura sin datos: tapa todos los campos (en la página y en sus iframes) y
// cualquier texto con el nombre de la cuenta.
export async function safeShot(page, path, { hideText = [] } = {}) {
  const mask = [page.locator('input, select, textarea')];
  for (const frame of page.frames().slice(1)) mask.push(frame.locator('input, select, textarea'));
  for (const text of hideText.filter(Boolean)) mask.push(page.getByText(text, { exact: false }));
  await page.screenshot({ path, fullPage: false, mask, maskColor: '#444' }).catch(() => {});
}

async function checkBlocked(page) {
  const text = await bodyText(page);
  if (IP_BLOCK_TEXT.test(text)) throw new Blocked('la página del proveedor respondió "acceso bloqueado" (IP del servidor de pruebas)');
  if (CAPTCHA_TEXT.test(text) || await visibleCaptcha(page)) throw new Blocked('pidió resolver un captcha');
  return text;
}

/**
 * Hace una acción por vuelta hasta que `done(url, text)` sea verdadero.
 * @param {import('playwright').Page} page
 * @param {{ done: (url: string, text: string) => boolean, actions: Array<{ name: string, run: (page: any) => Promise<boolean> }>,
 *   trace: string[], timeoutMs?: number, maxRepeats?: number }} plan
 */
export async function drive(page, { done, actions, trace, timeoutMs = 240000, maxRepeats = 4 }) {
  const end = Date.now() + timeoutMs;
  const counts = new Map();
  while (Date.now() < end) {
    const text = await checkBlocked(page);
    if (done(page.url(), text)) return true;
    let acted = false;
    for (const action of actions) {
      if ((counts.get(action.name) || 0) >= maxRepeats) continue;
      if (await action.run(page).catch(() => false)) {
        counts.set(action.name, (counts.get(action.name) || 0) + 1);
        trace.push(action.name);
        acted = true;
        break;
      }
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(acted ? 1500 : 1000);
  }
  return false;
}

const fill = (pattern, value, options) => async page => {
  const field = await fieldFor(page, pattern, options);
  if (!field) return false;
  if (field.evaluate && (await field.evaluate(element => element.tagName)) === 'SELECT') {
    await field.selectOption({ label: String(value) }).catch(() => field.selectOption(String(value)));
    return true;
  }
  await type(field, value);
  return true;
};
const press = pattern => async page => {
  const target = await clickable(page, pattern);
  if (!target) return false;
  await target.click({ timeout: 5000 });
  return true;
};

// Acciones del ingreso de una cuenta de prueba (usuario → contraseña →
// código por correo, que para una cuenta de prueba figura en el panel).
function loginActions(account) {
  return [
    { name: 'país: Argentina', run: async page => {
      const trigger = await firstVisible(page, '#dropdown-crossite-trigger');
      if (!trigger) return false;
      await trigger.click();
      const option = await firstVisible(page, '#dropdown-crossite-menu-list-option-AR');
      if (!option) return false;
      await option.click();
      return press(/^Confirmar$/)(page);
    } },
    { name: 'usuario', run: async page => {
      const field = await firstVisible(page, '#user_id, input[name="user_id"], input[autocomplete="username"], input[type="email"]',
        { empty: true });
      if (!field) return false;
      await type(field, account.user);
      await (await clickable(page, /^(Continuar|Siguiente)$/))?.click({ timeout: 5000 }).catch(() => field.press('Enter'));
      return true;
    } },
    { name: 'contraseña', run: async page => {
      const field = await firstVisible(page, 'input[type="password"]', { empty: true });
      if (!field) return false;
      await type(field, account.password);
      await (await clickable(page, /^(Iniciar sesi[oó]n|Ingresar|Continuar)$/))?.click({ timeout: 5000 })
        .catch(() => field.press('Enter'));
      return true;
    } },
    { name: 'código de verificación', run: async page => {
      if (!account.code) return false;
      // Sólo en la pantalla que lo pide: nunca en un campo de la tarjeta.
      if (!/(c[oó]digo que te enviamos|ingres(á|a) el c[oó]digo|c[oó]digo de verificaci[oó]n|verific(á|a) tu identidad)/i
        .test(await bodyText(page))) return false;
      const single = await firstVisible(page, 'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i]',
        { empty: true });
      if (single && (await single.getAttribute('maxlength')) !== '1') {
        await type(single, account.code);
      } else {
        // Un casillero por dígito.
        let boxes = [];
        for (const frame of page.frames()) {
          boxes = await frame.$$('input[maxlength="1"]');
          if (boxes.length >= 4) break;
        }
        if (boxes.length < 4) return false;
        const digits = String(account.code).split('');
        for (let index = 0; index < Math.min(boxes.length, digits.length); index += 1) await boxes[index].type(digits[index]);
      }
      await (await clickable(page, /^(Confirmar|Validar|Continuar|Verificar)$/))?.click({ timeout: 5000 }).catch(() => {});
      return true;
    } },
    { name: 'validar por e-mail', run: async page => {
      const text = await bodyText(page);
      if (!/valid(á|a)|verific|identidad|c[oó]digo/i.test(text)) return false;
      return press(/^(E-?mail|Correo electr[oó]nico|Enviar c[oó]digo por e-?mail)/i)(page);
    } },
    { name: 'omitir sugerencia', run: press(/^(Ahora no|Omitir|Saltar|No, gracias|M[aá]s tarde|Recordarme m[aá]s tarde)$/i) },
  ];
}

/**
 * Consentimiento OAuth en Mercado Pago con una cuenta de prueba de vendedor.
 * Termina cuando el navegador vuelve al sitio con ?conexion=<resultado>.
 */
export async function authorizeSeller(page, account, { siteUrl, trace, timeoutMs }) {
  const back = url => url.startsWith(siteUrl) && /[?&]conexion=/.test(url);
  const ok = await drive(page, {
    trace, timeoutMs,
    done: url => back(url),
    actions: [
      ...loginActions(account),
      { name: 'autorizar', run: async page => (new URL(page.url()).hostname.startsWith('auth.mercadopago')
        ? press(/^(Autorizar|Permitir|Aceptar|Continuar)$/)(page) : false) },
    ],
  });
  if (!ok) return null;
  return new URL(page.url()).hash.match(/conexion=([a-z_]+)/)?.[1] || null;
}

/**
 * Pago en Checkout Pro con la tarjeta de prueba. `holder` decide el
 * resultado (APRO, OTHE, CONT). Si el checkout pide ingresar, usa la cuenta
 * de prueba compradora. Termina en la pantalla de resultado o al volver al sitio.
 * @returns {Promise<'approved'|'rejected'|'pending'|null>}
 */
export async function payCheckout(page, { holder, buyer, siteUrl, trace, timeoutMs = 300000 }) {
  let result = null;
  // El resultado se lee recién después de tocar "Pagar": antes, cualquier
  // palabra de la página ("listo", "pendiente") sería una falsa lectura.
  let submitted = false;
  const verdict = text => {
    if (/(se acredit|pago aprobado|listo!|¡listo|ya pagaste|pago realizado)/i.test(text)) return 'approved';
    if (/(rechaz|no pudimos procesar|no se pudo procesar|no pudimos realizar)/i.test(text)) return 'rejected';
    if (/(estamos procesando|en proceso|pendiente de acreditaci|revisando tu pago|procesando tu pago)/i.test(text)) return 'pending';
    return null;
  };
  const card = TEST_CARD;
  const ok = await drive(page, {
    trace, timeoutMs, maxRepeats: 5,
    done: (url, text) => {
      if (url.startsWith(siteUrl)) { result = result || (/#\/pago\/exito/.test(url) ? 'approved' : null); return true; }
      if (!submitted) return false;
      result = verdict(text);
      return Boolean(result);
    },
    actions: [
      // Datos de la tarjeta (secure fields en iframes o campos comunes).
      { name: 'número de tarjeta', run: fill(/card.?number|n[uú]mero de (la )?tarjeta|cardNumber/i, card.number) },
      { name: 'titular', run: fill(/^(?!.*(documento|DNI|identifica)).*(titular|cardholder|nombre (y apellido )?(como|del|en la)|name on card)/i,
        holder) },
      { name: 'vencimiento', run: fill(/vencimiento|expira|expiration|MM ?\/ ?AA/i, card.expiry) },
      { name: 'mes de vencimiento', run: fill(/^(?!.*a[ñn]o).*(mes|month)/i, card.month) },
      { name: 'año de vencimiento', run: fill(/a[ñn]o|year/i, card.year) },
      { name: 'código de seguridad', run: fill(/c[oó]digo de seguridad|security.?code|cvv|cvc/i, card.cvv) },
      { name: 'tipo de documento', run: fill(/tipo de documento|identification.?type|doc.?type/i, card.docType,
        { tag: 'select', empty: false }) },
      { name: 'documento', run: fill(/n[uú]mero de documento|identification.?number|doc.?number|documento|DNI/i, card.docNumber) },
      { name: 'e-mail del comprobante', run: fill(/^(?!.*(usuario|user_id|tel[eé]fono)).*(e-?mail|correo)/i, SANDBOX_EMAIL) },
      // Ingreso, sólo si el checkout lo exige.
      ...loginActions(buyer),
      // Avance.
      { name: 'pagar', run: async page => {
        const pressed = await press(/^(Pagar|Confirmar pago|Pagar \$ ?[\d.,]+)$/i)(page);
        if (pressed) submitted = true;
        return pressed;
      } },
      { name: '1 cuota', run: press(/^1 cuota|^1x|^1 pago|^En 1 cuota/i) },
      { name: 'tarjeta de crédito', run: press(/^(Tarjeta de cr[eé]dito|Nueva tarjeta de cr[eé]dito|Agregar tarjeta|Nueva tarjeta)$/i) },
      { name: 'como invitado', run: press(/(Pagar|Continuar|Comprar) (como invitado|sin (cuenta|ingresar))|Otros medios de pago/i) },
      { name: 'continuar', run: press(/^(Continuar|Siguiente)$/i) },
    ],
  });
  return ok ? result : null;
}
