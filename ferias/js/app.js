// Shell de CAUCE · Ferias Neuquén: arranque, enrutador por hash, encabezado,
// navegación, avisos y diálogos. Cada vista consulta por la vía normal y
// devuelve su HTML (siempre escapado) y, si hace falta, sus manejadores.
import { RUNTIME_ENV } from './runtime-env.js';
import { CONFIG } from './config.js';
import { html, raw } from './core/html.js';
import { AppError } from './core/errors.js';
import { createStores } from './core/stores.js';
import { createRepository } from './repo/supabase-repository.js';
import { icon } from './ui/icons.js';
import { logo, loading, errorState, demoRibbon } from './ui/components.js';
import { sofia } from './ui/sofia.js';
import * as shop from './ui/views/shop.js';
import * as buy from './ui/views/buy.js';
import * as account from './ui/views/account.js';

// Los paneles de comercio, organización y administración se cargan sólo cuando
// se abren: quien compra no descarga ese código.
const lazy = (loader, name) => async ctx => (await loader())[name](ctx);
const panel = { home: lazy(() => import('./ui/views/panel.js'), 'home'), section: lazy(() => import('./ui/views/panel.js'), 'section') };
const organizer = { home: lazy(() => import('./ui/views/organizer.js'), 'home'), fair: lazy(() => import('./ui/views/organizer.js'), 'fair') };
const admin = { home: lazy(() => import('./ui/views/admin.js'), 'home') };

/** @type {Array<[string, (ctx: any) => Promise<any>]>} */
const ROUTES = [
  ['/', shop.home], ['/explorar', shop.explore], ['/tienda/:slug', shop.store], ['/producto/:id', shop.product],
  ['/ferias', shop.fairs], ['/feria/:slug', shop.fair], ['/favoritos', shop.favorites], ['/comunidad', shop.community],
  ['/planes', shop.plans], ['/sobre', shop.about],
  ['/carrito', buy.cart], ['/checkout/:businessId', buy.checkout], ['/pedido/:token', buy.tracking], ['/mis-pedidos', buy.myOrders],
  ['/cuenta', account.account], ['/cuenta/:mode', account.account], ['/alta', account.onboarding],
  ['/panel', panel.home], ['/panel/:section', panel.section], ['/panel/:section/:id', panel.section],
  ['/organizador', organizer.home], ['/organizador/feria/:id', organizer.fair], ['/organizador/:section', organizer.home],
  ['/admin', admin.home], ['/admin/:section', admin.home],
];

const main = /** @type {HTMLElement} */ (document.getElementById('main'));
const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const stores = createStores();
let repo = null;
let status = null;
let current = { cleanup: null, path: '', token: 0 };
const errorTimes = [];

function compile(pattern) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; })}/?$`);
  return path => {
    const match = path.match(regex);
    return match ? Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])])) : null;
  };
}
const compiled = ROUTES.map(([pattern, view]) => ({ match: compile(pattern), view }));

function parseHash() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = hash.split('?');
  return { path: path.startsWith('/') ? path : `/${path}`, query: Object.fromEntries(new URLSearchParams(search)) };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (location.hash === target) { render(); return; }
  if (replace) history.replaceState(null, '', target); else location.hash = target;
  if (replace) render();
}

// ── avisos y diálogos ──
let toastTimer = null;
export function toast(message, tone = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${tone ? ` is-${tone}` : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, tone === 'error' ? 6500 : 3800);
}

/**
 * Hoja de diálogo: confirmar, pedir un motivo o mostrar contenido.
 * @param {{ title: string, text?: string, confirm?: string, cancel?: string, tone?: string, input?: { label: string, required?: boolean, min?: number, placeholder?: string }, body?: any }} options
 * @returns {Promise<false|string|true>}
 */
export function dialog({ title, text = '', confirm = 'Confirmar', cancel = 'Cancelar', tone = 'primary', input = null, body = null }) {
  return new Promise(resolve => {
    const el = /** @type {HTMLDialogElement} */ (document.getElementById('sheet'));
    el.innerHTML = String(html`<form method="dialog" class="sheet-body">
      <div class="sheet-handle" aria-hidden="true"></div>
      <h2 class="section-title" id="sheet-title">${title}</h2>
      ${text ? html`<p class="muted">${text}</p>` : ''}
      ${body || ''}
      ${input ? html`<div class="field"><label for="sheet-input">${input.label}</label>
        <textarea id="sheet-input" class="textarea" rows="3" maxlength="200" placeholder="${input.placeholder || ''}"></textarea>
        <span class="field-error" id="sheet-error" hidden></span></div>` : ''}
      <div class="sheet-actions">
        ${cancel ? html`<button type="button" class="btn btn-secondary" data-sheet="cancel">${cancel}</button>` : ''}
        ${confirm ? html`<button type="submit" class="btn btn-${tone}" data-sheet="ok">${confirm}</button>` : ''}
      </div>
    </form>`);
    el.setAttribute('aria-labelledby', 'sheet-title');
    const done = value => { el.close(); resolve(value); };
    el.querySelector('[data-sheet="cancel"]')?.addEventListener('click', () => done(false));
    el.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      if (input) {
        const value = /** @type {HTMLTextAreaElement} */ (el.querySelector('#sheet-input')).value.trim();
        if (input.required && value.length < (input.min || 3)) {
          const error = /** @type {HTMLElement} */ (el.querySelector('#sheet-error'));
          error.textContent = `Escribí al menos ${input.min || 3} letras.`;
          error.hidden = false;
          return;
        }
        done(value);
      } else done(true);
    });
    el.addEventListener('cancel', () => resolve(false), { once: true });
    el.showModal();
    /** @type {HTMLElement} */ (el.querySelector(input ? '#sheet-input' : '[data-sheet="ok"]') || el.querySelector('button'))?.focus();
  });
}

// ── encabezado y navegación ──
async function headerHtml(chrome, nav, session) {
  const cartCount = stores.cartCount();
  const ref = await repo.referenceData().catch(() => ({ localities: [] }));
  const locality = stores.locality();
  const shopNav = [['/', 'Inicio', 'inicio'], ['/explorar', 'Explorar', 'explorar'], ['/ferias', 'Ferias', 'ferias'],
    ['/favoritos', 'Favoritos', 'favoritos'], ['/cuenta', 'Cuenta', 'cuenta']];
  const workspaces = [
    session.memberships.length ? ['/panel', 'Mi tienda', 'panel'] : null,
    session.organizers.length ? ['/organizador', 'Organizador', 'organizador'] : null,
    session.admin ? ['/admin', 'Administración', 'admin'] : null,
  ].filter(Boolean);
  const links = chrome === 'shop' ? shopNav : [['/', 'Ver tienda pública', 'inicio'], ...workspaces];
  return html`<div class="header-inner">
    ${logo()}
    ${chrome === 'shop' ? html`<label class="header-locality">${icon('pin', { size: 18 })}<span class="sr-only">Localidad</span>
      <select id="locality-select" aria-label="Localidad">
        <option value=""${raw(locality === '' ? ' selected' : '')}>Todo Neuquén</option>
        ${ref.localities.map(l => html`<option value="${l.slug}"${raw(l.slug === locality ? ' selected' : '')}>${l.name}</option>`)}
      </select>${icon('chevron-down', { size: 16 })}</label>` : ''}
    <nav class="header-nav" aria-label="Principal">${links.map(([href, label, key]) => html`<a href="#${href}"${raw(key === nav ? ' aria-current="page"' : '')}>${label}</a>`)}</nav>
    <div class="header-actions">
      ${chrome === 'shop' ? html`
        <a class="icon-btn" href="#/mis-pedidos" aria-label="Mis pedidos">${icon('bell')}</a>
        <a class="icon-btn" href="#/carrito" aria-label="Carrito${cartCount ? `, ${cartCount} productos` : ''}">${icon('cart')}${cartCount ? html`<span class="badge-dot">${cartCount > 99 ? '99+' : cartCount}</span>` : ''}</a>`
    : html`<a class="icon-btn" href="#/cuenta" aria-label="Mi cuenta">${icon('user')}</a>`}
    </div>
  </div>`;
}

function bottomNavHtml(chrome, nav, extra = {}) {
  const sets = {
    shop: [['/', 'Inicio', 'home', 'inicio'], ['/explorar', 'Explorar', 'search', 'explorar'], ['/ferias', 'Ferias', 'fairs', 'ferias'],
      ['/favoritos', 'Favoritos', 'heart', 'favoritos'], ['/cuenta', 'Cuenta', 'user', 'cuenta']],
    panel: [['/panel', 'Inicio', 'home', 'panel'], ['/panel/pedidos', 'Pedidos', 'orders', 'pedidos'], ['/panel/productos', 'Productos', 'box', 'productos'],
      ['/panel/ferias', 'Ferias', 'fairs', 'ferias'], ['/panel/mas', 'Más', 'more', 'mas']],
    organizer: [['/organizador', 'Ferias', 'fairs', 'ferias'], ['/organizador/nueva', 'Nueva', 'plus', 'nueva'],
      ['/organizador/equipo', 'Equipo', 'users', 'equipo'], ['/cuenta', 'Cuenta', 'user', 'cuenta']],
    admin: [['/admin', 'Resumen', 'chart', 'resumen'], ['/admin/tiendas', 'Tiendas', 'store', 'tiendas'], ['/admin/organizadores', 'Ferias', 'fairs', 'organizadores'],
      ['/admin/comunidad', 'Comunidad', 'users', 'comunidad'], ['/admin/registro', 'Registro', 'shield', 'registro']],
  };
  const items = sets[chrome];
  if (!items) return '';
  return html`<nav class="bottom-nav" aria-label="Navegación"><div class="bottom-nav-inner">
    ${items.map(([href, label, iconName, key]) => html`<a href="#${href}"${raw(key === nav ? ' aria-current="page"' : '')}>
      ${icon(key === nav && iconName === 'home' ? 'home-fill' : iconName, { size: 24 })}<span>${label}</span>
      ${extra[key] ? html`<span class="badge-dot">${extra[key]}</span>` : ''}</a>`)}
  </div></nav>`;
}

function footerHtml() {
  return html`<footer class="footer"><div class="footer-inner">
    ${logo()}
    <p class="mano footer-tagline">Hecho cerca tuyo.</p>
    <div class="footer-links">
      <a href="#/sobre">Qué es CAUCE</a><a href="#/planes">Planes para vender</a><a href="#/comunidad">Comunidad fundadora</a>
      <a href="#/alta">Abrir mi tienda</a><a href="#/mis-pedidos">Seguir un pedido</a>
    </div>
    <p class="footer-note">CAUCE · Ferias Neuquén es una plataforma de LUNA Proyectos para artesanos, feriantes y emprendedores locales.
      Los pagos se coordinan directamente con cada vendedor.</p>
  </div></footer>`;
}

// ── render ──
async function render() {
  const { path, query } = parseHash();
  const token = ++current.token;
  current.cleanup?.();
  current.cleanup = null;
  main.setAttribute('aria-busy', 'true');
  const route = compiled.map(r => ({ view: r.view, params: r.match(path) })).find(r => r.params);
  if (!route) { navigate('/', { replace: true }); return; }
  const samePage = current.path === path;
  if (!samePage) main.innerHTML = String(loading());
  let session;
  try { session = await repo.session(); } catch { session = { kind: 'visitor', user: null, memberships: [], organizers: [], admin: false }; }
  stores.setOwner(session.kind === 'account' ? session.user.id : null);
  const ctx = { params: route.params, query, path, repo, stores, session, status, navigate, toast, dialog, refresh: () => render(),
    isCurrent: () => token === current.token };
  let view;
  try {
    view = await route.view(ctx);
  } catch (error) {
    view = { chrome: 'shop', nav: '', title: 'CAUCE · Ferias', html: errorState(error) };
    if (!(error instanceof AppError)) reportError('frontend_error', error);
  }
  if (token !== current.token) return;
  if (view.redirect) { navigate(view.redirect, { replace: true }); return; }
  const chrome = view.chrome || 'shop';
  const header = document.getElementById('header');
  header.hidden = chrome === 'bare';
  if (chrome !== 'bare') header.innerHTML = String(await headerHtml(chrome, view.nav, session));
  if (token !== current.token) return;
  document.getElementById('bottom-nav-slot').innerHTML = String(bottomNavHtml(chrome, view.nav, view.navBadges || {}));
  document.getElementById('footer-slot').innerHTML = String(chrome === 'shop' ? footerHtml() : '');
  document.getElementById('demo-slot').innerHTML = String(status?.features?.demo_data ? demoRibbon() : '');
  main.className = `main${chrome === 'bare' ? ' is-bare' : ''}`;
  // Cada vista vive en un contenedor nuevo: sus manejadores se van con su DOM y
  // nunca se acumulan entre navegaciones.
  const root = document.createElement('div');
  root.className = 'view';
  root.innerHTML = String(view.html);
  main.replaceChildren(root);
  document.title = view.title ? `${view.title} · CAUCE Ferias` : CONFIG.name;
  main.setAttribute('aria-busy', 'false');
  // En la primera carga el foco queda al principio (para «Saltar al contenido»);
  // en cada navegación pasa al contenido nuevo.
  if (!samePage) { window.scrollTo(0, 0); if (current.path) main.focus({ preventScroll: true }); }
  current.path = path;
  try { current.cleanup = view.mount?.(root, ctx) || null; } catch (error) { reportError('frontend_error', error); }
}

// ── manejadores globales ──
function bindGlobal() {
  window.addEventListener('hashchange', () => render());
  document.addEventListener('change', event => {
    const target = /** @type {HTMLSelectElement} */ (event.target);
    if (target.id === 'locality-select') {
      stores.setLocality(target.value);
      if (['/', '/explorar', '/ferias'].includes(parseHash().path)) {
        const { path, query } = parseHash();
        if (path === '/') render();
        else navigate(`${path}?${new URLSearchParams({ ...query, loc: target.value }).toString()}`);
      }
    }
  });
  document.addEventListener('click', async event => {
    // «Saltar al contenido» sin tocar el hash (el enrutador lo usa para las rutas).
    if (/** @type {HTMLElement} */ (event.target).closest('.skip')) { event.preventDefault(); main.focus(); return; }
    const el = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    if (action === 'back') { event.preventDefault(); if (history.length > 1) history.back(); else navigate('/'); }
    if (action === 'retry') { event.preventDefault(); render(); }
    if (action === 'fav') {
      event.preventDefault();
      const on = stores.toggleFavorite(el.getAttribute('data-id'));
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.setAttribute('aria-label', on ? 'Quitar de favoritos' : 'Guardar en favoritos');
      toast(on ? 'Guardado en favoritos' : 'Quitado de favoritos');
    }
  });
  stores.onCartChange(() => {
    const badge = document.querySelector('.header a[href="#/carrito"]');
    if (!badge) return;
    const count = stores.cartCount();
    badge.setAttribute('aria-label', `Carrito${count ? `, ${count} productos` : ''}`);
    badge.querySelector('.badge-dot')?.remove();
    if (count) badge.insertAdjacentHTML('beforeend', String(html`<span class="badge-dot">${count > 99 ? '99+' : count}</span>`));
  });
  const header = document.getElementById('header');
  window.addEventListener('scroll', () => header.classList.toggle('is-scrolled', window.scrollY > 4), { passive: true });
  window.addEventListener('error', event => reportError('frontend_error', event.error || new Error(event.message)));
  window.addEventListener('unhandledrejection', event => {
    if (event.reason instanceof AppError) return;
    reportError('frontend_error', event.reason);
  });
}

function reportError(kind, error) {
  const now = Date.now();
  while (errorTimes.length && now - errorTimes[0] > 60000) errorTimes.shift();
  if (errorTimes.length >= 5 || !repo) return;
  errorTimes.push(now);
  repo.reportEvent(kind, { code: String(error?.code || error?.name || 'Error').slice(0, 60),
    message: String(error?.message || error || '').slice(0, 300), route: parseHash().path.slice(0, 80), release: RUNTIME_ENV.release });
}

// Enlaces de correo (confirmación, recuperación): ?token_hash=…&type=…
async function handleAuthLink() {
  const params = new URLSearchParams(location.search);
  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  if (!tokenHash || !type) return;
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
  try {
    await repo.verifyLink(tokenHash, type);
    if (type === 'recovery') { location.hash = '#/cuenta/nueva-clave'; return; }
    toast('¡Listo! Tu correo quedó confirmado.', 'ok');
    const session = await repo.session({ fresh: true });
    location.hash = session.memberships.length ? '#/panel' : '#/alta';
  } catch (error) {
    toast(error.message || 'El enlace venció o ya se usó. Pedí uno nuevo.', 'error');
    location.hash = '#/cuenta';
  }
}

function fatal(title, text) {
  main.className = 'main is-bare';
  main.innerHTML = String(html`<div class="empty">${raw(sofia('buscando', { size: 200 }))}
    <h1 class="empty-title">${title}</h1><p class="empty-text">${text}</p></div>`);
  main.setAttribute('aria-busy', 'false');
}

async function boot() {
  if (!RUNTIME_ENV.client) {
    fatal('Falta compilar CAUCE', 'Esta copia no está conectada a ningún backend. Corré `npm run dev` (stack Supabase local) siguiendo docs/INSTALACION.md.');
    return;
  }
  repo = createRepository({ client: RUNTIME_ENV.client, siteUrl: RUNTIME_ENV.siteUrl, redirectTo: RUNTIME_ENV.redirectTo,
    onError: error => { if (error.code !== 'NETWORK_ERROR') reportError('supabase_error', { code: error.technical?.code || error.code, message: error.technical?.message || error.message }); } });
  try {
    status = await repo.appStatus();
  } catch (error) {
    fatal('No pudimos conectarnos', error.message || 'Revisá tu conexión y recargá la página.');
    return;
  }
  if (Number(status?.schema || 0) < CONFIG.requiredSchema) {
    fatal('Estamos actualizando CAUCE', 'Volvé a intentar en unos minutos.');
    return;
  }
  repo.onAuthChange(event => {
    if (['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED'].includes(event)) render();
  });
  bindGlobal();
  await repo.session({ verify: true }).catch(() => null);
  await handleAuthLink();
  app.classList.add('is-ready');
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

boot();
