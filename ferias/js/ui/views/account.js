// Cuenta: ingresar, crear cuenta (con confirmación por correo), recuperar y
// elegir contraseña, perfil y accesos a los paneles. Y el alta de la tienda.
import { html, raw } from '../../core/html.js';
import { clean, isEmail, isPhone, isName, passwordProblem } from '../../core/validators.js';
import { icon } from '../icons.js';
import { sofia } from '../sofia.js';
import { banner, pageHeader } from '../components.js';

const passwordField = (id, label, autocomplete) => html`<div class="field"><label for="${id}">${label}</label>
  <div class="input-group input-group-end"><input id="${id}" name="password" type="password" class="input" autocomplete="${autocomplete}" minlength="10" maxlength="72" required>
  <button type="button" class="btn btn-secondary btn-sm toggle-pass" data-action="toggle-pass" data-target="${id}" aria-label="Mostrar contraseña">${icon('eye', { size: 18 })}</button></div></div>`;

function bindPasswordToggles(root) {
  root.addEventListener('click', event => {
    const el = /** @type {HTMLElement} */ (event.target).closest('[data-action="toggle-pass"]');
    if (!el) return;
    const input = /** @type {HTMLInputElement} */ (root.querySelector(`#${el.getAttribute('data-target')}`));
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
    el.innerHTML = String(icon(show ? 'eye-off' : 'eye', { size: 18 }));
  });
}

async function withBusy(button, fn) {
  button.classList.add('is-busy');
  try { return await fn(); } finally { button.classList.remove('is-busy'); }
}

export async function account(ctx) {
  const mode = ctx.params.mode || '';
  const session = ctx.session;
  if (mode === 'nueva-clave') return newPassword(ctx);
  if (session.kind === 'account' && !['confirmar'].includes(mode)) return profile(ctx);
  if (mode === 'recuperar') return recover(ctx);
  if (mode === 'confirmar') return confirmEmail(ctx);
  const signup = mode === 'crear';
  const next = ctx.query.next || '';
  return {
    chrome: 'shop', nav: 'cuenta', title: signup ? 'Crear cuenta' : 'Ingresar',
    html: html`
      <div class="auth-wrap">
        <section class="card card-pad stack">
          <div class="center-items stack gap-sm">${raw(sofia(signup ? 'comunidad' : 'bienvenida', { size: 150 }))}
            <h1 class="page-title">${signup ? 'Creá tu cuenta' : 'Ingresá a CAUCE'}</h1>
            <p class="small muted">${signup ? 'Para abrir tu tienda, organizar ferias o seguir tus compras.' : 'Comprar no requiere cuenta: la necesitás para vender u organizar.'}</p></div>
          <div class="segmented" role="tablist">
            <a href="#/cuenta${next ? `?next=${encodeURIComponent(next)}` : ''}"${raw(signup ? '' : ' aria-current="page"')}>Ingresar</a>
            <a href="#/cuenta/crear${next ? `?next=${encodeURIComponent(next)}` : ''}"${raw(signup ? ' aria-current="page"' : '')}>Crear cuenta</a>
          </div>
          ${signup ? html`<form class="form" data-form="signup" novalidate>
            <div class="field"><label for="su-name">Nombre y apellido</label><input id="su-name" name="name" class="input" autocomplete="name" maxlength="80" required></div>
            <div class="field"><label for="su-email">Correo electrónico</label><input id="su-email" name="email" type="email" class="input" autocomplete="email" maxlength="120" required></div>
            <div class="field"><label for="su-phone">Teléfono o WhatsApp</label><input id="su-phone" name="phone" type="tel" class="input" autocomplete="tel" maxlength="24" required></div>
            ${passwordField('su-password', 'Contraseña (10 o más, con letras y números)', 'new-password')}
            <p class="field-error" id="su-error" role="alert" hidden></p>
            <button class="btn btn-primary btn-block" type="submit">Crear cuenta</button>
            <p class="xsmall muted center">Te mandamos un correo para confirmar la dirección.</p>
          </form>` : html`<form class="form" data-form="signin" novalidate>
            <div class="field"><label for="si-email">Correo electrónico</label><input id="si-email" name="email" type="email" class="input" autocomplete="email" maxlength="120" required></div>
            ${passwordField('si-password', 'Contraseña', 'current-password')}
            <p class="field-error" id="si-error" role="alert" hidden></p>
            <button class="btn btn-primary btn-block" type="submit">Ingresar</button>
            <a class="link-more center-row" href="#/cuenta/recuperar">¿Olvidaste tu contraseña?</a>
          </form>`}
        </section>
      </div>`,
    mount(root) {
      bindPasswordToggles(root);
      root.querySelector('[data-form="signin"]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const data = new FormData(form);
        const error = root.querySelector('#si-error');
        const email = clean(data.get('email'), 120);
        if (!isEmail(email) || !data.get('password')) { error.textContent = 'Completá tu correo y tu contraseña.'; error.hidden = false; return; }
        await withBusy(form.querySelector('button[type="submit"]'), async () => {
          try {
            const session = await ctx.repo.signIn({ email, password: String(data.get('password')) });
            ctx.toast(`¡Hola, ${session.user.name.split(' ')[0]}!`, 'ok');
            ctx.navigate(next || (session.memberships.length ? '/panel' : session.organizers.length ? '/organizador' : session.admin ? '/admin' : '/cuenta'));
          } catch (caught) {
            error.textContent = caught.message;
            error.hidden = false;
            if (caught.technical?.code === 'email_not_confirmed') {
              error.insertAdjacentHTML('beforeend', String(html` <a href="#/cuenta/confirmar?email=${encodeURIComponent(email)}">Reenviar confirmación</a>`));
            }
          }
        });
      });
      root.querySelector('[data-form="signup"]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const data = new FormData(form);
        const error = root.querySelector('#su-error');
        const input = { name: clean(data.get('name'), 80), email: clean(data.get('email'), 120), phone: clean(data.get('phone'), 24), password: String(data.get('password') || '') };
        const problem = !isName(input.name) ? 'Escribí tu nombre.' : !isEmail(input.email) ? 'Revisá el correo.'
          : !isPhone(input.phone) ? 'Ingresá un teléfono válido.' : passwordProblem(input.password);
        if (problem) { error.textContent = problem; error.hidden = false; return; }
        error.hidden = true;
        await withBusy(form.querySelector('button[type="submit"]'), async () => {
          try {
            const result = await ctx.repo.signUp(input);
            if (result.needsConfirmation) ctx.navigate(`/cuenta/confirmar?email=${encodeURIComponent(input.email)}`);
            else ctx.navigate(next || '/alta');
          } catch (caught) { error.textContent = caught.message; error.hidden = false; }
        });
      });
    },
  };
}

function confirmEmail(ctx) {
  const email = clean(ctx.query.email, 120);
  return {
    chrome: 'shop', nav: 'cuenta', title: 'Confirmá tu correo',
    html: html`<div class="auth-wrap"><section class="card card-pad stack center-items">
      ${raw(sofia('preparando', { size: 180 }))}
      <h1 class="page-title">Revisá tu correo</h1>
      <p>Te mandamos un enlace a <strong>${email || 'tu casilla'}</strong>. Tocalo para confirmar tu cuenta: funciona también desde otro dispositivo.</p>
      <p class="small muted">Si no llega en unos minutos, mirá en spam o pedí otro.</p>
      ${email ? html`<button type="button" class="btn btn-secondary" data-action="resend">Reenviar el correo</button>` : ''}
      <a class="link-more" href="#/cuenta">Ya confirmé, quiero ingresar</a>
    </section></div>`,
    mount(root) {
      root.querySelector('[data-action="resend"]')?.addEventListener('click', async event => {
        const button = /** @type {HTMLElement} */ (event.currentTarget);
        await withBusy(button, async () => {
          try { await ctx.repo.resendConfirmation(email); ctx.toast('Te mandamos otro correo.', 'ok'); } catch (error) { ctx.toast(error.message, 'error'); }
        });
      });
    },
  };
}

function recover(ctx) {
  return {
    chrome: 'shop', nav: 'cuenta', title: 'Recuperar contraseña',
    html: html`<div class="auth-wrap"><section class="card card-pad stack">
      ${pageHeader('Recuperar contraseña', { backHref: '#/cuenta' })}
      <p class="muted">Escribí tu correo y te mandamos un enlace para elegir una contraseña nueva.</p>
      <form class="form" data-form="recover" novalidate>
        <div class="field"><label for="rc-email">Correo electrónico</label><input id="rc-email" name="email" type="email" class="input" autocomplete="email" required></div>
        <p class="field-error" id="rc-error" role="alert" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">Enviar enlace</button>
      </form>
      <div id="rc-done" hidden>${banner('ok', 'Listo', 'Si hay una cuenta con ese correo, te llega un enlace en unos minutos. Vence en una hora.', 'check')}</div>
    </section></div>`,
    mount(root) {
      root.querySelector('[data-form="recover"]').addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const email = clean(new FormData(form).get('email'), 120);
        const error = root.querySelector('#rc-error');
        if (!isEmail(email)) { error.textContent = 'Revisá el correo.'; error.hidden = false; return; }
        await withBusy(form.querySelector('button'), async () => {
          try { await ctx.repo.requestPasswordReset(email); form.hidden = true; root.querySelector('#rc-done').hidden = false; }
          catch (caught) { error.textContent = caught.message; error.hidden = false; }
        });
      });
    },
  };
}

function newPassword(ctx) {
  if (ctx.session.kind !== 'account') {
    return { chrome: 'shop', nav: 'cuenta', title: 'Nueva contraseña', html: html`<div class="auth-wrap"><section class="card card-pad stack">
      ${banner('warn', 'El enlace venció o ya se usó', 'Pedí uno nuevo para elegir tu contraseña.', 'alert')}
      <a class="btn btn-primary" href="#/cuenta/recuperar">Pedir otro enlace</a></section></div>` };
  }
  return {
    chrome: 'shop', nav: 'cuenta', title: 'Nueva contraseña',
    html: html`<div class="auth-wrap"><section class="card card-pad stack">
      <h1 class="page-title">Elegí tu contraseña nueva</h1>
      <form class="form" data-form="new-password" novalidate>
        ${passwordField('np-password', 'Contraseña nueva (10 o más, con letras y números)', 'new-password')}
        <p class="field-error" id="np-error" role="alert" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">Guardar contraseña</button>
      </form></section></div>`,
    mount(root) {
      bindPasswordToggles(root);
      root.querySelector('[data-form="new-password"]').addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const password = String(new FormData(form).get('password') || '');
        const error = root.querySelector('#np-error');
        const problem = passwordProblem(password);
        if (problem) { error.textContent = problem; error.hidden = false; return; }
        await withBusy(form.querySelector('button[type="submit"]'), async () => {
          try { await ctx.repo.updatePassword(password); ctx.toast('Contraseña actualizada.', 'ok'); ctx.navigate('/cuenta'); }
          catch (caught) { error.textContent = caught.message; error.hidden = false; }
        });
      });
    },
  };
}

function profile(ctx) {
  const { user, memberships, organizers, admin } = ctx.session;
  return {
    chrome: 'shop', nav: 'cuenta', title: 'Mi cuenta',
    html: html`
      ${pageHeader('Mi cuenta', { back: false })}
      <div class="two-col mt">
        <div class="stack">
          <nav class="menu" aria-label="Mis espacios">
            ${memberships.length ? memberships.map(m => html`<a class="menu-item" href="#/panel?tienda=${m.businessId}">${icon('store')}<span>${m.name}<span class="small muted block">Mi tienda · ${m.role === 'owner' ? 'titular' : m.role === 'manager' ? 'encargado/a' : 'ayudante'}</span></span>${icon('chevron-right', { size: 18 })}</a>`)
    : html`<a class="menu-item" href="#/alta">${icon('store')}<span>Abrir mi tienda<span class="small muted block">Vendé tus productos y recibí pedidos</span></span>${icon('chevron-right', { size: 18 })}</a>`}
            ${organizers.map(o => html`<a class="menu-item" href="#/organizador?org=${o.organizerId}">${icon('fairs')}<span>${o.name}<span class="small muted block">Organización de ferias</span></span>${icon('chevron-right', { size: 18 })}</a>`)}
            ${admin ? html`<a class="menu-item" href="#/admin">${icon('shield')}<span>Administración de CAUCE</span>${icon('chevron-right', { size: 18 })}</a>` : ''}
            <a class="menu-item" href="#/mis-pedidos">${icon('orders')}<span>Mis pedidos</span>${icon('chevron-right', { size: 18 })}</a>
            <a class="menu-item" href="#/favoritos">${icon('heart')}<span>Favoritos</span>${icon('chevron-right', { size: 18 })}</a>
            <a class="menu-item" href="#/planes">${icon('tag')}<span>Planes para vender</span>${icon('chevron-right', { size: 18 })}</a>
          </nav>
        </div>
        <div class="stack">
          <section class="card card-pad stack">
            <h2 class="section-title">Mis datos</h2>
            <form class="form" data-form="profile" novalidate>
              <div class="field"><label for="pf-name">Nombre</label><input id="pf-name" name="name" class="input" value="${user.name}" maxlength="80" autocomplete="name"></div>
              <div class="field"><label for="pf-phone">Teléfono</label><input id="pf-phone" name="phone" class="input" value="${user.phone}" maxlength="24" autocomplete="tel"></div>
              <div class="field"><span class="field-label">Correo</span><span class="muted">${user.email}</span></div>
              <p class="field-error" id="pf-error" role="alert" hidden></p>
              <button class="btn btn-secondary" type="submit">Guardar</button>
            </form>
          </section>
          <section class="card card-pad stack">
            <h2 class="section-title">Seguridad</h2>
            <a class="menu-item card" href="#/cuenta/nueva-clave">${icon('lock')}<span>Cambiar contraseña</span>${icon('chevron-right', { size: 18 })}</a>
            <button type="button" class="btn btn-danger" data-action="signout">${icon('logout', { size: 18 })}Cerrar sesión</button>
          </section>
        </div>
      </div>`,
    mount(root) {
      root.querySelector('[data-action="signout"]').addEventListener('click', async () => {
        await ctx.repo.signOut();
        ctx.toast('Cerraste sesión.');
        ctx.navigate('/');
      });
      root.querySelector('[data-form="profile"]').addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const data = new FormData(form);
        const error = root.querySelector('#pf-error');
        const name = clean(data.get('name'), 80); const phone = clean(data.get('phone'), 24);
        if (!isName(name) || (phone && !isPhone(phone))) { error.textContent = 'Revisá nombre y teléfono.'; error.hidden = false; return; }
        await withBusy(form.querySelector('button'), async () => {
          try { await ctx.repo.updateProfile({ name, phone }); ctx.toast('Datos guardados.', 'ok'); } catch (caught) { error.textContent = caught.message; error.hidden = false; }
        });
      });
    },
  };
}

// ══════════ alta de la tienda ══════════
export async function onboarding(ctx) {
  const session = ctx.session;
  if (session.kind === 'account' && session.memberships.some(m => m.role === 'owner') && !ctx.query.nueva) return { redirect: '/panel' };
  const ref = await ctx.repo.referenceData();
  const signedIn = session.kind === 'account';
  return {
    chrome: 'shop', nav: '', title: 'Abrir mi tienda',
    html: html`
      <div class="two-col mt">
        <section class="stack">
          <p class="mano onboarding-kicker">Abrí tu tienda en 3 pasos</p>
          <h1 class="page-title">Mostrá lo que creás y recibí pedidos</h1>
          <ol class="steps">
            <li class="${signedIn ? 'is-done' : 'is-current'}"><span class="check-circle${signedIn ? '' : ' is-pending'}">${icon('check', { size: 14, strokeWidth: 3 })}</span><span><strong>Tu cuenta</strong><span class="small muted block">Correo y contraseña. Te pedimos confirmar el correo.</span></span></li>
            <li class="${signedIn ? 'is-current' : ''}"><span class="check-circle is-pending">${icon('check', { size: 14, strokeWidth: 3 })}</span><span><strong>Tu tienda</strong><span class="small muted block">Nombre, localidad y rubro. Lo demás lo completás después.</span></span></li>
            <li><span class="check-circle is-pending">${icon('check', { size: 14, strokeWidth: 3 })}</span><span><strong>Tus productos</strong><span class="small muted block">Fotos desde el teléfono, precio y stock. Después pedís la publicación.</span></span></li>
          </ol>
          ${signedIn ? html`<form class="card card-pad form" data-form="business" novalidate>
            <div class="field"><label for="ob-name">Nombre de tu tienda o emprendimiento</label><input id="ob-name" name="name" class="input" maxlength="80" required placeholder="Ej.: Raíces de Barro"></div>
            <div class="grid-2">
              <div class="field"><label for="ob-loc">Localidad</label><select id="ob-loc" name="locality" class="select">${ref.localities.map(l => html`<option value="${l.slug}"${raw(l.slug === ctx.stores.locality() ? ' selected' : '')}>${l.name}</option>`)}</select></div>
              <div class="field"><label for="ob-cat">Rubro principal</label><select id="ob-cat" name="category" class="select">${ref.categories.map(c => html`<option value="${c.slug}">${c.name}</option>`)}</select></div>
            </div>
            <p class="field-error" id="ob-error" role="alert" hidden></p>
            <button class="btn btn-primary btn-block" type="submit">Crear mi tienda</button>
            <p class="xsmall muted center">La tienda queda en borrador hasta que pidas la publicación.</p>
          </form>` : html`<div class="row wrap"><a class="btn btn-primary" href="#/cuenta/crear?next=%2Falta">Crear mi cuenta</a><a class="btn btn-secondary" href="#/cuenta?next=%2Falta">Ya tengo cuenta</a></div>`}
        </section>
        <aside class="card card-pad stack center-items">${raw(sofia('creando', { size: 260 }))}
          <p class="small muted">Sin formularios largos: empezás con lo básico y la tienda te va guiando.</p>
          <a class="link-more" href="#/planes">Ver planes ${icon('chevron-right', { size: 16 })}</a></aside>
      </div>`,
    mount(root) {
      root.querySelector('[data-form="business"]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const data = new FormData(form);
        const error = root.querySelector('#ob-error');
        const name = clean(data.get('name'), 80);
        if (name.length < 2) { error.textContent = 'Escribí el nombre de tu tienda.'; error.hidden = false; return; }
        await withBusy(form.querySelector('button'), async () => {
          try {
            const created = await ctx.repo.createBusiness({ name, locality: String(data.get('locality')), category: String(data.get('category')) });
            ctx.toast('¡Tu tienda está creada! Sigamos con los detalles.', 'ok');
            ctx.navigate(`/panel?tienda=${created.id}`);
          } catch (caught) { error.textContent = caught.message; error.hidden = false; }
        });
      });
    },
  };
}

