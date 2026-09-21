// CAUCE · Aluminé — shell de la aplicación.
//
// Enrutador por hash (funciona igual servido desde GitHub Pages o desde el
// backend local), vistas que piden sus datos al repositorio del entorno y un
// único manejador de acciones delegado. Toda la lógica de negocio vive en
// js/domain y js/core: acá sólo se arma la interfaz.
import { CONFIG } from './config.js';
import { RUNTIME_ENV } from './runtime-env.js';
import { createRepository } from './repositories/repository-factory.js';
import { isNetworkError } from './repositories/http-repository.js';
import { renderIcon, renderSticker } from './ui/icons.js';
import { renderCharacter } from './ui/brand-characters.js';
import {
  esc, money, shortDate, timeOnly, relativeMinutes, orderStatusLabel, orderStatusTone,
  stepsFor, stepIndex, fulfillmentLabel, paymentLabel, businessStatusLabel, tripStatusLabel,
  pluralize, initialsOf,
} from './ui/format.js';
import { getProductSvg } from './data/food-assets.js';
import { BUSINESS_STATUS_HINTS, missingPublicationRequirements } from './core/merchant-status.js';
import { PRODUCT_CATEGORIES_SUGGESTED } from './core/catalog-rules.js';
import { DISPATCH_POLICY, DRIVER_STATUS_LABELS } from './core/taxi-dispatch.js';
import { isTaxiActive, isTaxiCancelable, getDriverNextAction } from './core/taxi-workflow.js';
import { allowedActions } from './core/workflow-policy.js';
import { formatDeliveryCode } from './core/delivery-code.js';
import { confirmedPrice, isCommerciallyPurchasable, knownStock } from './core/commercial.js';
import { formatArgentinePhone } from './core/validators.js';

const main = document.querySelector('#main');

const app = {
  repository: null,
  session: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  search: { query: '', category: 'Todos', onlyOpen: false },
  activityTab: 'pedidos',
  panelTab: 'pedidos',
  formDrafts: new Map(),
  toastTimer: null,
};

const isShared = () => Boolean(app.repository?.capabilities?.sharedPersistence);
const actor = () => app.session?.actor || null;
const isSignedIn = () => actor()?.kind === 'account';
const hasRole = role => Boolean(actor()?.roles?.includes(role));

function productThumb(item, name = '', className = '') {
  const label = name || item?.name || 'Producto';
  const fallback = `<span class="product-thumb-fallback" aria-hidden="true">${esc(initialsOf(label))}</span>`;
  return `<span class="product-thumb ${className}" aria-hidden="true">
    ${fallback}${item?.image ? `<img src="${esc(item.image)}" alt="" loading="lazy" width="96" height="96">` : ''}
  </span>`;
}

function merchantAvatar(business, className = '') {
  const initials = business.initials || initialsOf(business.name);
  return `<span class="merchant-avatar ${className}" aria-hidden="true">
    ${business.logoImage
      ? `<img src="${esc(business.logoImage)}" alt="" loading="lazy" width="72" height="72">`
      : `<span>${esc(initials)}</span>`}
  </span>`;
}

const DELIVERY_TRACK_PROGRESS = Object.freeze({
  assigned: 12,
  picked_up: 32,
  on_the_way: 68,
  arrived: 94,
  delivered: 100,
});

function renderOrderMoment(order) {
  const moment = {
    received: ['merchant', 'Pedido recibido', 'El comercio ya puede revisarlo y confirmar si lo toma.'],
    accepted: ['merchant', 'Pedido aceptado', 'El comercio confirmó que puede prepararlo.'],
    preparing: ['merchant', 'Preparando tu pedido', 'El comercio está trabajando en los productos del pedido.'],
    ready: ['shopper', 'Pedido listo', order.fulfillment === 'delivery' ? 'Está listo para asignar el reparto.' : 'Ya podés retirarlo por el comercio.'],
  }[order.status];
  if (!moment) return '';
  return `<section class="brand-status-card" aria-labelledby="order-moment-title">
    <div class="brand-status-copy"><span class="route-kicker">ESTADO ACTUAL</span><h2 id="order-moment-title">${esc(moment[1])}</h2><p>${esc(moment[2])}</p></div>
    <div class="brand-status-character" aria-hidden="true">${renderCharacter(moment[0], 112)}</div>
  </section>`;
}

function renderDeliveryTracking(order, business) {
  const progress = DELIVERY_TRACK_PROGRESS[order.status];
  if (order.fulfillment !== 'delivery' || progress == null) return '';
  const active = order.status === 'on_the_way';
  const operationalEta = {
    assigned: 'Salida pendiente',
    picked_up: 'Pedido retirado del comercio',
    on_the_way: 'Entrega próxima · sin ETA telemétrica',
    arrived: 'El reparto informó que llegó',
    delivered: 'Entrega completada',
  }[order.status];
  const riderLabel = order.riderName || `Reparto de ${business.name}`;
  const character = order.status === 'delivered' ? 'celebrate' : 'courier';
  return `
    <section class="route-card route-card-delivery" aria-labelledby="delivery-tracking-title">
      <div class="route-card-heading">
        <div>
          <span class="route-kicker">AVANCE ESTIMADO</span>
          <h2 id="delivery-tracking-title">${esc(orderStatusLabel(order))}</h2>
        </div>
        <span class="estimate-chip">Sin GPS en tiempo real</span>
      </div>
      <div class="route-visual progress-${progress} ${active ? 'is-moving' : ''}" aria-hidden="true">
        <span class="route-line"><span class="route-line-complete"></span></span>
        <span class="route-node route-node-start">${renderIcon('store', 15)}</span>
        <span class="route-vehicle route-character-vehicle">${renderCharacter(character, 82)}</span>
        <span class="route-node route-node-end">${renderIcon('pin', 15)}</span>
      </div>
      <div class="route-places">
        <span><small>Origen</small><strong>${esc(business.name)}</strong></span>
        <span><small>Destino</small><strong>${esc(order.customer?.address || 'Dirección confirmada')}</strong></span>
      </div>
      <div class="route-summary">
        <span>${renderIcon('delivery', 18)} <strong>${esc(riderLabel)}</strong></span>
        <span>${renderIcon('clock', 18)} ${esc(operationalEta)}</span>
      </div>
      <p class="route-disclaimer">La posición ilustra el estado operativo informado por el comercio o el reparto; no representa coordenadas en vivo.</p>
    </section>`;
}

const TAXI_TRACK_PROGRESS = Object.freeze({
  accepted: 16,
  driver_on_way: 58,
  driver_arrived: 92,
  passenger_on_board: 52,
  in_trip: 72,
  completed: 100,
});

function renderTaxiTracking(trip) {
  const closedMoment = {
    no_availability: ['Sin disponibilidad', 'No hubo conductores disponibles para tomar esta solicitud.'],
    expired: ['Solicitud vencida', 'La búsqueda terminó sin una respuesta dentro del plazo.'],
    canceled: ['Viaje cancelado', 'La solicitud se cerró y el vehículo dejó de avanzar.'],
  }[trip.status];
  if (closedMoment) {
    return `<section class="brand-status-card brand-status-taxi" aria-labelledby="taxi-closed-title">
      <div class="brand-status-copy"><span class="route-kicker">ESTADO DEL VIAJE</span><h2 id="taxi-closed-title">${esc(closedMoment[0])}</h2><p>${esc(closedMoment[1])}</p></div>
      <div class="brand-status-character" aria-hidden="true">${renderCharacter(trip.status === 'canceled' ? 'taxi-driver' : 'search', 112)}</div>
    </section>`;
  }
  if (trip.status === 'searching') {
    return `
      <section class="route-card taxi-search-card" aria-labelledby="taxi-search-title">
        <div class="route-card-heading">
          <div><span class="route-kicker">SOLICITUD ACTIVA</span><h2 id="taxi-search-title">Buscando respuesta</h2></div>
          <span class="estimate-chip">Sin ubicación en vivo</span>
        </div>
        <div class="taxi-search-visual" aria-hidden="true"><span></span>${renderCharacter('search', 104)}</div>
        <p class="route-status-copy">Consultando conductores disponibles. La pantalla cambia cuando uno acepta.</p>
      </section>`;
  }
  const progress = TAXI_TRACK_PROGRESS[trip.status];
  if (!trip.driver || progress == null) return '';
  const approaching = ['accepted', 'driver_on_way', 'driver_arrived'].includes(trip.status);
  const statusCopy = {
    accepted: 'Taxi confirmado · salida a coordinar',
    driver_on_way: 'Acercándose al punto de encuentro',
    driver_arrived: 'El conductor informó que llegó',
    passenger_on_board: 'Pasajero a bordo',
    in_trip: 'Viaje iniciado · sin ETA telemétrica',
    completed: 'Viaje finalizado',
  }[trip.status];
  return `
    <section class="route-card route-card-taxi" aria-labelledby="taxi-tracking-title">
      <div class="route-card-heading">
        <div><span class="route-kicker">AVANCE ESTIMADO</span><h2 id="taxi-tracking-title">${esc(tripStatusLabel(trip.status))}</h2></div>
        <span class="estimate-chip">Demostración · sin GPS</span>
      </div>
      <div class="route-visual progress-${progress} ${trip.status === 'driver_on_way' ? 'is-moving' : ''}" aria-hidden="true">
        <span class="route-line"><span class="route-line-complete"></span></span>
        <span class="route-node route-node-start">${renderIcon('pin', 15)}</span>
        <span class="route-vehicle route-character-vehicle route-vehicle-taxi">${renderCharacter(trip.status === 'completed' ? 'celebrate' : 'taxi-driver', 86)}</span>
        <span class="route-node route-node-end">${renderIcon('pin', 15)}</span>
      </div>
      <div class="route-places">
        <span><small>${approaching ? 'Punto de encuentro' : 'Origen'}</small><strong>${esc(trip.origin)}</strong></span>
        <span><small>Destino</small><strong>${esc(trip.destination)}</strong></span>
      </div>
      <div class="route-summary">
        <span>${renderIcon('user', 18)} <strong>${esc(trip.driver.displayName)}</strong></span>
        <span>${renderIcon('clock', 18)} ${esc(statusCopy)}</span>
      </div>
      <p class="route-disclaimer">El automóvil se mueve según el estado informado por el conductor. No representa distancia, ETA ni posición exactas.</p>
    </section>`;
}

// ───────────────────────── enrutador ─────────────────────────

const ROUTE_ALIASES = Object.freeze({
  home: 'inicio',
  shop: 'comercio',
  cart: 'carrito',
  carts: 'carrito',
  orders: 'actividad',
  order: 'pedido',
  manage: 'panel',
  business: 'panel',
  presentacion: 'institucional',
  'taxi-driver': 'taxista',
  rider: 'panel',
});

function route() {
  const parts = location.hash.slice(1).split('/').filter(Boolean).map(decodeURIComponent);
  const page = ROUTE_ALIASES[parts[0]] || parts[0] || 'inicio';
  return { page, param: parts[1] || null, extra: parts[2] || null };
}

const go = hash => { location.hash = hash; };

// ───────────────────────── utilidades de interfaz ─────────────────────────

function toast(message, tone = 'info') {
  const element = document.querySelector('#toast');
  if (!element) return;
  clearTimeout(app.toastTimer);
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = false;
  app.toastTimer = setTimeout(() => { element.hidden = true; }, 5200);
}

function draft(key, values) {
  if (values) app.formDrafts.set(key, { ...app.formDrafts.get(key), ...values });
  return app.formDrafts.get(key) || {};
}

const backLink = (href, label) => `<a class="back" href="${esc(href)}">← ${esc(label)}</a>`;

// "Chica, Grande +2000, Familiar -500" -> variantes con su diferencia de precio.
// La validación real la hace el dominio; acá sólo se interpreta lo escrito.
function parseVariants(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return text.split(',').map(part => {
    const match = part.trim().match(/^(.*?)\s*([+\u2212-]\s*\d+)?$/);
    const name = (match?.[1] || part).trim();
    const raw = (match?.[2] || '').replace(/\s+/g, '').replace('\u2212', '-');
    return { name, priceDelta: raw ? Number(raw) : 0 };
  }).filter(variant => variant.name);
}

const EMPTY_CHARACTERS = Object.freeze({
  diner: 'search', bag: 'shopper', merchant: 'merchant', taxi: 'taxi-driver', wave: 'search',
});

const emptyState = (title, message, href = '#comercios', label = 'Ver comercios', sticker = 'diner') => `
  <section class="empty">
    <div class="empty-sticker empty-character" aria-hidden="true">${renderCharacter(EMPTY_CHARACTERS[sticker] || sticker, 112)}</div>
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    <a class="button" href="${esc(href)}">${esc(label)}</a>
  </section>`;

const sectionHeading = (eyebrow, title, extra = '') => `
  <div class="section-heading">
    <span class="eyebrow">${esc(eyebrow)}</span>
    <h2>${esc(title)}</h2>
    ${extra}
  </div>`;

// Aviso obligatorio antes de confirmar: ninguna operación llega a un comercio real.
const confirmNotice = () => `
  <p class="confirm-notice">${renderIcon('shield-check', 15)}
    <span>Esta confirmación no genera un servicio ni un cobro real. Queda registrada sólo en ${
      isShared() ? 'el entorno de pruebas' : 'este navegador'}.</span>
  </p>`;

const offlineBanner = () => (app.online ? '' : `
  <div class="notice offline-notice" role="status">
    <strong>Sin conexión.</strong>
    ${isShared()
      ? 'No se puede confirmar nada hasta recuperar la conexión con el servidor. Nada quedó enviado a medias.'
      : 'Podés seguir navegando: esta demostración guarda todo en tu propio navegador.'}
  </div>`);

// Bloquea la confirmación y muestra el aviso sin tocar lo que ya está escrito.
const OPERATION_FORMS = '[data-form="checkout"], [data-form="taxi-request"]';

function applyOfflineState() {
  if (!main) return;
  const existing = main.querySelector('.offline-live-notice');
  if (app.online) {
    existing?.remove();
  } else if (!existing) {
    const notice = document.createElement('div');
    notice.className = 'notice offline-notice offline-live-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = isShared()
      ? 'Sin conexión. No se puede confirmar hasta recuperarla. No quedó ninguna operación enviada a medias.'
      : 'Sin conexión. Podés seguir navegando: esta demostración guarda todo en tu propio navegador.';
    main.prepend(notice);
  }
  // En la demostración no hay servidor: quedarse sin conexión no impide nada.
  if (!isShared()) return;
  for (const form of main.querySelectorAll(OPERATION_FORMS)) {
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !app.online;
  }
}

function errorView(error) {
  const retry = isNetworkError(error)
    ? '<button class="button secondary" type="button" data-action="retry">Reintentar</button>'
    : '';
  return `<section class="notice error">
    <h2>No pudimos abrir esta vista</h2>
    <p>${esc(error?.message || 'Ocurrió un error inesperado.')}</p>
    <div class="modal-actions">${retry}<a class="button secondary" href="#inicio">Volver al inicio</a></div>
  </section>`;
}

// ───────────────────────── shell ─────────────────────────

function updateShell() {
  const { page } = route();
  const signedIn = isSignedIn();

  const envChip = document.querySelector('#env-chip');
  if (envChip) {
    // En la cabecera va la forma corta, para que entre a 360 px sin recortarse;
    // el pie lleva la frase completa y el detalle está en el título accesible.
    envChip.textContent = RUNTIME_ENV.environment === 'demo' ? 'Demostración' : 'Pruebas';
    envChip.title = `${RUNTIME_ENV.label}. ${RUNTIME_ENV.description}`;
    envChip.dataset.environment = RUNTIME_ENV.environment;
  }

  const footerEnv = document.querySelector('#footer-env');
  if (footerEnv) {
    footerEnv.textContent = `${RUNTIME_ENV.label} · ${RUNTIME_ENV.description}`;
  }

  const accountLink = document.querySelector('#account-link');
  if (accountLink) {
    accountLink.textContent = signedIn ? initialsOf(actor().name) : 'Ingresar';
    accountLink.setAttribute('aria-label', signedIn ? `Cuenta de ${actor().name}` : 'Ingresar a CAUCE');
    accountLink.classList.toggle('is-signed', signedIn);
  }

  const cartCount = app.cartCount || 0;
  const cartItem = document.querySelector('#bnav-carrito');
  if (cartItem) {
    cartItem.hidden = cartCount === 0;
    const badge = cartItem.querySelector('.bnav-badge');
    if (badge) { badge.textContent = String(cartCount); badge.hidden = cartCount === 0; }
  }

  const active = {
    inicio: 'bnav-inicio', comercios: 'bnav-comercios', comercio: 'bnav-comercios',
    taxi: 'bnav-taxi', viaje: 'bnav-taxi', actividad: 'bnav-actividad', pedido: 'bnav-actividad',
    carrito: 'bnav-carrito',
  }[page];
  for (const item of document.querySelectorAll('.bottom-nav-item')) {
    item.classList.toggle('active', item.id === active);
    if (item.id === active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }

  document.body.classList.toggle('is-offline', !app.online);
}

// ───────────────────────── vistas públicas ─────────────────────────

function businessCard(business) {
  const modes = [
    business.pickupEnabled ? 'Retiro' : null,
    business.deliveryEnabled ? (business.deliveryFee > 0 ? `Envío ${money(business.deliveryFee)}` : 'Envío sin costo') : null,
  ].filter(Boolean).join(' · ');
  const cover = business.coverImage
    ? `<img class="merchant-cover" src="${esc(business.coverImage)}" alt="" loading="lazy" width="640" height="360">`
    : `<div class="merchant-cover merchant-cover-fallback" aria-hidden="true"><span>${esc(business.initials || initialsOf(business.name))}</span></div>`;
  return `
    <a class="catalog-merchant-card" href="#comercio/${esc(business.id)}" data-theme="${esc(business.theme || 'sage')}">
      <div class="merchant-cover-wrap">${cover}${merchantAvatar(business, 'merchant-avatar-card')}</div>
      <div class="catalog-merchant-content">
        <div class="catalog-merchant-text">
          <h3>${esc(business.name)}</h3>
          <p class="quiet">${esc(business.category || 'Comercio local')}${business.subtitle ? ` · ${esc(business.subtitle)}` : ''}</p>
        </div>
        <span class="availability ${business.open ? '' : 'closed'}">${business.open ? 'Abierto' : 'Cerrado'}</span>
      </div>
      <p class="merchant-modes">${renderIcon('bag', 14)} ${esc(modes || 'Modalidades a confirmar')}</p>
    </a>`;
}

function filterBusinesses(businesses, catalogs = {}) {
  const query = app.search.query.trim().toLowerCase();
  return businesses.filter(business => {
    if (app.search.onlyOpen && !business.open) return false;
    if (app.search.category !== 'Todos' && business.category !== app.search.category) return false;
    if (!query) return true;
    return [business.name, business.category, business.subtitle, business.description, catalogs[business.id]]
      .filter(Boolean).some(field => field.toLowerCase().includes(query));
  });
}

async function viewHome() {
  const [businesses, carts, orders, trips] = await Promise.all([
    app.repository.query('publicBusinesses'),
    app.repository.query('carts'),
    app.repository.query('myOrders'),
    app.repository.query('myTrips'),
  ]);
  app.cartCount = carts.reduce((total, entry) => total + entry.cart.lines.reduce((sum, line) => sum + line.quantity, 0), 0);

  const activeOrders = orders.filter(order => !['delivered', 'canceled'].includes(order.status));
  const activeTrip = trips.find(trip => isTaxiActive(trip.status));
  const open = businesses.filter(business => business.open);

  const operation = (activeOrders.length || activeTrip) ? `
    <section class="home-block">
      ${sectionHeading('EN CURSO', 'Tu operación activa')}
      <div class="stack">
        ${activeOrders.slice(0, 2).map(order => `
          <a class="op-card" href="#pedido/${esc(order.id)}">
            <span class="op-card-icon">${renderIcon('receipt', 18)}</span>
            <span class="op-card-body">
              <strong>${esc(order.code)} · ${esc(businesses.find(b => b.id === order.businessId)?.name || 'Comercio')}</strong>
              <span class="quiet">${esc(orderStatusLabel(order))} · ${esc(fulfillmentLabel(order.fulfillment))}</span>
            </span>
            <span class="status-chip ${orderStatusTone(order.status)}">${esc(orderStatusLabel(order))}</span>
          </a>`).join('')}
        ${activeTrip ? `
          <a class="op-card" href="#viaje/${esc(activeTrip.id)}">
            <span class="op-card-icon">${renderIcon('taxi', 18)}</span>
            <span class="op-card-body">
              <strong>${esc(activeTrip.origin)} → ${esc(activeTrip.destination)}</strong>
              <span class="quiet">${esc(tripStatusLabel(activeTrip.status))}</span>
            </span>
            <span class="status-chip ${activeTrip.driverId ? 'ready' : 'received'}">${esc(tripStatusLabel(activeTrip.status))}</span>
          </a>` : ''}
      </div>
    </section>` : '';

  return `
    ${offlineBanner()}
    <section class="home-hero">
      <div class="home-hero-media" aria-hidden="true">
        <img src="assets/images/territory/alumine-hero-panoramica.webp" alt="" width="1200" height="600" fetchpriority="high">
      </div>
      <div class="home-hero-body">
        <p class="eyebrow">CAUCE · ALUMINÉ</p>
        <h1>Comprá local.<br>Movete por Aluminé.</h1>
        <div class="home-actions">
          <a class="button button-hero" href="#comercios">${renderIcon('store', 18)} Ver comercios</a>
          <a class="button button-hero-outline" href="#taxi">${renderIcon('taxi', 18)} Pedir un taxi</a>
        </div>
      </div>
      <div class="home-hero-character" aria-hidden="true">${renderCharacter('shopper', 180)}</div>
    </section>

    ${operation}

    <section class="home-block">
      ${sectionHeading('COMERCIOS', open.length ? 'Abiertos ahora' : 'Comercios en CAUCE',
        `<a class="link-button" href="#comercios">Ver todos</a>`)}
      ${businesses.length
        ? `<div class="merchant-grid">${(open.length ? open : businesses).slice(0, 4).map(businessCard).join('')}</div>`
        : `<p class="quiet">Todavía no hay comercios publicados en este entorno.</p>`}
    </section>

    <section class="home-block home-secondary">
      <a class="secondary-access" href="#alta-comercio">
        <span class="secondary-access-icon" aria-hidden="true">${renderSticker('merchant', 40)}</span>
        <span>
          <strong>Sumar mi comercio</strong>
          <span class="quiet">Creá tu cuenta, cargá tu catálogo y solicitá la publicación.</span>
        </span>
      </a>
      <a class="secondary-access" href="#taxista">
        <span class="secondary-access-icon" aria-hidden="true">${renderSticker('taxi', 40)}</span>
        <span>
          <strong>Registrarme como taxista</strong>
          <span class="quiet">Completá tu alta y recibí solicitudes cuando esté aprobada.</span>
        </span>
      </a>
      <a class="secondary-access quiet-access" href="#institucional">
        <span class="secondary-access-icon" aria-hidden="true">${renderIcon('shield-check', 26)}</span>
        <span>
          <strong>Qué es CAUCE</strong>
          <span class="quiet">Alcance, responsabilidades y propuesta de piloto.</span>
        </span>
      </a>
    </section>`;
}

async function viewBusinesses() {
  const businesses = await app.repository.query('publicBusinesses');
  const categories = ['Todos', ...new Set(businesses.map(business => business.category).filter(Boolean))];
  // Buscar "pizza" tiene que encontrar al comercio que vende pizza, no sólo al
  // que se llama así: se consulta el catálogo de cada comercio publicado.
  const catalogs = app.search.query.trim()
    ? Object.fromEntries(await Promise.all(businesses.map(async business => [
      business.id,
      (await app.repository.query('products', { businessId: business.id })).map(product => product.name).join(' '),
    ])))
    : {};
  const visible = filterBusinesses(businesses, catalogs);

  return `
    ${offlineBanner()}
    <section class="page-header">
      <h1 class="page-title">Comercios de Aluminé</h1>
      <p class="quiet">${pluralize(businesses.length, 'comercio publicado', 'comercios publicados')} en este entorno · contenido ficticio de demostración.</p>
    </section>

    <form class="search-bar" data-form="search" role="search">
      <label class="visually-hidden" for="search-input">Buscar comercios o productos</label>
      <span class="search-icon" aria-hidden="true">${renderIcon('bag', 16)}</span>
      <input id="search-input" name="query" type="search" placeholder="Buscar comercio o rubro"
        value="${esc(app.search.query)}" autocomplete="off" enterkeyhint="search">
      <label class="check-label">
        <input type="checkbox" name="onlyOpen" ${app.search.onlyOpen ? 'checked' : ''}>
        <span>Sólo abiertos</span>
      </label>
    </form>

    <div class="category-nav-bar" role="tablist" aria-label="Rubros">
      ${categories.map(category => `
        <button class="category-pill ${app.search.category === category ? 'active' : ''}" type="button"
          role="tab" aria-selected="${app.search.category === category}"
          data-action="set-category" data-category="${esc(category)}">${esc(category)}</button>`).join('')}
    </div>

    ${visible.length
      ? `<div class="merchant-grid">${visible.map(businessCard).join('')}</div>`
      : emptyState('Sin resultados',
        'La búsqueda mira el nombre del comercio, su rubro y sus productos. Probá con otra palabra o quitá los filtros.',
        '#comercios', 'Ver todos los comercios', 'bag')}`;
}

async function viewBusiness(businessId) {
  if (!businessId) return emptyState('Comercio no encontrado', 'Elegí un comercio del listado.');
  const [business, products, cart] = await Promise.all([
    app.repository.query('business', { businessId }),
    app.repository.query('products', { businessId }),
    app.repository.query('cart', { businessId }),
  ]);
  const lines = new Map(cart.lines.map(line => [line.productId, line.quantity]));
  const purchasable = products.filter(product => !product.archived);
  const categories = [...new Set(purchasable.map(product => product.category))];
  const count = cart.lines.reduce((total, line) => total + line.quantity, 0);

  const productCard = product => {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    // Con variantes, cada combinacion es una linea propia del carrito.
    const quantity = variants.length
      ? cart.lines.filter(line => line.productId === product.id).reduce((total, line) => total + line.quantity, 0)
      : (lines.get(product.id) || 0);
    const stock = knownStock(product);
    const available = isCommerciallyPurchasable(product) && stock > 0;
    const image = product.image
      ? `<img src="${esc(product.image)}" alt="" loading="lazy" width="320" height="240">`
      : product.dishType
        ? getProductSvg(product.dishType)
        : `<span class="product-mark">${esc(initialsOf(product.name))}</span>`;
    return `
      <article class="product-card ${available ? '' : 'is-unavailable'}">
        <div class="product-media" aria-hidden="true">${image}</div>
        <div class="product-body">
          <h3>${esc(product.name)}</h3>
          ${product.description ? `<p class="quiet">${esc(product.description)}</p>` : ''}
          <p class="product-price">${money(confirmedPrice(product))}</p>
          ${available ? '' : `<p class="product-flag">${stock <= 0 ? 'Sin stock' : 'No disponible'}</p>`}
        </div>
        ${variants.length ? `
          <div class="variant-list">
            ${variants.map(variant => {
              const line = cart.lines.find(item => item.productId === product.id && item.variantId === variant.id);
              const count = line?.quantity || 0;
              return `
                <div class="variant-row">
                  <span class="variant-name">${esc(variant.name)}${variant.priceDelta
                    ? ` <span class="quiet">${variant.priceDelta > 0 ? '+' : '−'}${money(Math.abs(variant.priceDelta))}</span>` : ''}</span>
                  ${available ? (count > 0 ? `
                    <div class="qty-control" role="group" aria-label="Cantidad de ${esc(product.name)} ${esc(variant.name)}">
                      <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                        data-product="${esc(product.id)}" data-variant="${esc(variant.id)}" data-quantity="${count - 1}"
                        aria-label="Quitar una unidad">−</button>
                      <span class="qty-value" aria-live="polite">${count}</span>
                      <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                        data-product="${esc(product.id)}" data-variant="${esc(variant.id)}" data-quantity="${count + 1}"
                        ${quantity >= stock ? 'disabled' : ''} aria-label="Agregar una unidad">+</button>
                    </div>` : `
                    <button class="button secondary add-btn" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                      data-product="${esc(product.id)}" data-variant="${esc(variant.id)}" data-quantity="1">Agregar</button>`)
                    : '<span class="quiet">No disponible</span>'}
                </div>`;
            }).join('')}
          </div>`
        : `
        <div class="product-actions">
          ${available ? (quantity > 0 ? `
            <div class="qty-control" role="group" aria-label="Cantidad de ${esc(product.name)}">
              <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                data-product="${esc(product.id)}" data-quantity="${quantity - 1}" aria-label="Quitar una unidad">−</button>
              <span class="qty-value" aria-live="polite">${quantity}</span>
              <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                data-product="${esc(product.id)}" data-quantity="${quantity + 1}" ${quantity >= stock ? 'disabled' : ''}
                aria-label="Agregar una unidad">+</button>
            </div>` : `
            <button class="button add-btn" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
              data-product="${esc(product.id)}" data-quantity="1">Agregar</button>`)
            : '<span class="quiet">No disponible</span>'}
        </div>`}
      </article>`;
  };

  return `
    ${offlineBanner()}
    ${backLink('#comercios', 'Comercios')}
    <section class="shop-header" data-theme="${esc(business.theme || 'sage')}">
      <div class="shop-cover">
        ${business.coverImage
          ? `<img src="${esc(business.coverImage)}" alt="" width="960" height="360">`
          : `<div class="shop-cover-fallback" aria-hidden="true"></div>`}
        ${merchantAvatar(business, 'merchant-avatar-shop')}
      </div>
      <div class="shop-header-text">
        <h1 class="page-title">${esc(business.name)}</h1>
        <p class="quiet">${esc(business.subtitle || business.category || '')}</p>
        <div class="shop-meta">
          <span class="availability ${business.open ? '' : 'closed'}">${business.open ? 'Abierto' : 'Cerrado'}</span>
          ${business.hoursLabel ? `<span>${renderIcon('clock', 14)} ${esc(business.hoursLabel)}</span>` : ''}
          ${business.address ? `<span>${renderIcon('pin', 14)} ${esc(business.address)}</span>` : ''}
        </div>
        <div class="shop-meta">
          ${business.pickupEnabled ? `<span class="tag">${renderIcon('bag', 13)} Retiro en el comercio</span>` : ''}
          ${business.deliveryEnabled ? `<span class="tag">${renderIcon('delivery', 13)} Envío ${business.deliveryFee > 0 ? money(business.deliveryFee) : 'sin costo'}${business.minimumOrder > 0 ? ` · mínimo ${money(business.minimumOrder)}` : ''}</span>` : ''}
        </div>
        ${business.deliveryZone ? `<p class="microcopy">Zona de envío declarada por el comercio: ${esc(business.deliveryZone)}.</p>` : ''}
      </div>
    </section>

    ${business.open ? '' : `<div class="notice"><strong>El comercio está cerrado.</strong> Podés mirar el catálogo, pero no confirmar pedidos hasta que vuelva a abrir.</div>`}

    ${categories.map(category => `
      <section class="catalog-group">
        <h2 class="catalog-group-title">${esc(category)}</h2>
        <div class="product-grid">${purchasable.filter(product => product.category === category).map(productCard).join('')}</div>
      </section>`).join('') || emptyState('Catálogo vacío', 'Este comercio todavía no publicó productos.', '#comercios', 'Ver otros comercios', 'bag')}

    ${count > 0 ? `
      <div class="sticky-cart-bar">
        <span>${pluralize(count, 'producto', 'productos')} en el carrito</span>
        <a class="button" href="#carrito/${esc(business.id)}">Ver carrito</a>
      </div>` : ''}`;
}

async function viewCarts(businessId) {
  if (businessId) return viewCheckout(businessId);
  const carts = await app.repository.query('carts');
  app.cartCount = carts.reduce((total, entry) => total + entry.cart.lines.reduce((sum, line) => sum + line.quantity, 0), 0);
  if (!carts.length) {
    return emptyState('Tu carrito está vacío', 'Elegí un comercio y sumá productos. Cada comercio tiene su propio carrito.',
      '#comercios', 'Ver comercios', 'bag');
  }
  return `
    ${offlineBanner()}
    <section class="page-header">
      <h1 class="page-title">Tus carritos</h1>
      <p class="quiet">Un pedido por comercio. Los carritos se mantienen separados.</p>
    </section>
    <div class="stack">
      ${carts.map(entry => {
        const units = entry.cart.lines.reduce((total, line) => total + line.quantity, 0);
        return `
          <article class="cart-summary-card">
            <div class="cart-summary-main">
              <h2>${esc(entry.business.name)}</h2>
              <p class="quiet">${pluralize(units, 'producto', 'productos')}</p>
            </div>
            <div class="cart-summary-actions">
              <button class="link-button danger" type="button" data-action="clear-cart" data-business="${esc(entry.business.id)}">Vaciar</button>
              <a class="button" href="#carrito/${esc(entry.business.id)}">Continuar</a>
            </div>
          </article>`;
      }).join('')}
    </div>`;
}

async function viewCheckout(businessId) {
  const [business, products, cart] = await Promise.all([
    app.repository.query('business', { businessId }),
    app.repository.query('products', { businessId }),
    app.repository.query('cart', { businessId }),
  ]);
  if (!cart.lines.length) {
    return emptyState('Carrito vacío', `Todavía no agregaste productos de ${business.name}.`,
      `#comercio/${business.id}`, 'Ver catálogo', 'bag');
  }

  const stored = draft(`checkout:${businessId}`);
  const modes = [
    business.pickupEnabled ? 'pickup' : null,
    business.deliveryEnabled ? 'delivery' : null,
  ].filter(Boolean);
  const fulfillment = modes.includes(stored.fulfillment) ? stored.fulfillment : modes[0];

  let quote = null;
  let quoteError = '';
  try { quote = await app.repository.query('quote', { businessId, fulfillment }); }
  catch (error) { quoteError = error.message; }

  const detail = cart.lines.map(line => {
    const product = products.find(candidate => candidate.id === line.productId);
    const variant = (product?.variants || []).find(item => item.id === line.variantId) || null;
    return { line, product, variant };
  });

  return `
    ${offlineBanner()}
    ${backLink(`#comercio/${business.id}`, business.name)}
    <section class="page-header">
      <h1 class="page-title">Confirmar pedido</h1>
      <p class="quiet">${esc(business.name)}</p>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Tu pedido</h2>
      <ul class="cart-lines-list">
        ${detail.map(({ line, product, variant }) => {
          const unit = confirmedPrice(product || {}) + (variant ? Number(variant.priceDelta) || 0 : 0);
          const variantAttribute = line.variantId ? ` data-variant="${esc(line.variantId)}"` : '';
          return `
          <li class="cart-line">
            <div class="cart-line-product">
              ${productThumb(product, product?.name)}
              <div class="cart-line-info">
                <span class="cart-line-title">${esc(product?.name || 'Producto')}${variant ? ` · ${esc(variant.name)}` : ''}</span>
                <span class="cart-line-unit-price">${money(unit)} c/u</span>
              </div>
            </div>
            <div class="cart-line-controls">
              <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                data-product="${esc(line.productId)}"${variantAttribute} data-quantity="${line.quantity - 1}" aria-label="Quitar una unidad">−</button>
              <span class="qty-value">${line.quantity}</span>
              <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                data-product="${esc(line.productId)}"${variantAttribute} data-quantity="${line.quantity + 1}" aria-label="Agregar una unidad">+</button>
            </div>
            <span class="cart-line-total">${money(unit * line.quantity)}</span>
          </li>`;
        }).join('')}
      </ul>
    </section>

    ${quoteError ? `<div class="notice error"><strong>Revisá tu carrito.</strong> ${esc(quoteError)}</div>` : ''}

    <form class="checkout-form" data-form="checkout" data-business="${esc(business.id)}">
      <section class="checkout-section">
        <h2 class="checkout-section-title">Cómo lo recibís</h2>
        <div class="choice-group" role="radiogroup" aria-label="Modalidad de entrega">
          ${modes.map(mode => `
            <label class="choice ${fulfillment === mode ? 'active' : ''}">
              <input type="radio" name="fulfillment" value="${mode}" ${fulfillment === mode ? 'checked' : ''}>
              <span class="choice-body">
                <strong>${mode === 'pickup' ? 'Retiro en el comercio' : 'Envío del comercio'}</strong>
                <span class="quiet">${mode === 'pickup'
                  ? esc(business.address || 'Dirección a confirmar con el comercio')
                  : `${business.deliveryFee > 0 ? money(business.deliveryFee) : 'Sin costo'}${business.deliveryZone ? ` · ${esc(business.deliveryZone)}` : ''}`}</span>
              </span>
            </label>`).join('')}
        </div>
      </section>

      <section class="checkout-section">
        <h2 class="checkout-section-title">Tus datos</h2>
        <div class="field">
          <label for="checkout-name">Nombre y apellido</label>
          <input id="checkout-name" name="name" type="text" required minlength="2" maxlength="80"
            autocomplete="name" value="${esc(stored.name || (isSignedIn() ? actor().name : ''))}">
        </div>
        <div class="field">
          <label for="checkout-phone">Teléfono de contacto</label>
          <input id="checkout-phone" name="phone" type="tel" required inputmode="tel" autocomplete="tel"
            placeholder="2942 000000" value="${esc(stored.phone || (isSignedIn() ? actor().phone || '' : ''))}">
        </div>
        ${fulfillment === 'delivery' ? `
          <div class="field">
            <label for="checkout-address">Dirección de entrega</label>
            <input id="checkout-address" name="address" type="text" required minlength="5" maxlength="200"
              autocomplete="street-address" placeholder="Calle y número" value="${esc(stored.address || '')}">
          </div>
          ${business.deliveryZone ? `
            <label class="check-label">
              <input type="checkbox" name="zoneAcknowledged" ${stored.zoneAcknowledged ? 'checked' : ''}>
              <span>Confirmo que la dirección está dentro de la zona de reparto del comercio (${esc(business.deliveryZone)}).</span>
            </label>` : ''}` : ''}
        <div class="field">
          <label for="checkout-notes">Notas para el comercio (opcional)</label>
          <textarea id="checkout-notes" name="notes" rows="2" maxlength="300">${esc(stored.notes || '')}</textarea>
        </div>
      </section>

      <section class="checkout-section">
        <h2 class="checkout-section-title">Forma de pago</h2>
        <div class="choice-group" role="radiogroup" aria-label="Forma de pago">
          <label class="choice ${(stored.paymentMethod || 'cash_demo') === 'cash_demo' ? 'active' : ''}">
            <input type="radio" name="paymentMethod" value="cash_demo" ${(stored.paymentMethod || 'cash_demo') === 'cash_demo' ? 'checked' : ''}>
            <span class="choice-body"><strong>Efectivo al recibir</strong><span class="quiet">Prueba · no se cobra nada</span></span>
          </label>
          <label class="choice ${stored.paymentMethod === 'transfer_demo' ? 'active' : ''}">
            <input type="radio" name="paymentMethod" value="transfer_demo" ${stored.paymentMethod === 'transfer_demo' ? 'checked' : ''}>
            <span class="choice-body"><strong>Transferencia al comercio</strong><span class="quiet">Prueba · no se cobra nada</span></span>
          </label>
        </div>
        <p class="microcopy">Los pagos en línea no están habilitados en esta entrega. El pedido y el pago son estados independientes.</p>
      </section>

      <section class="checkout-section checkout-total">
        <h2 class="checkout-section-title">Total</h2>
        ${quote ? `
          <dl class="totals">
            <div><dt>Subtotal</dt><dd>${money(quote.subtotal)}</dd></div>
            <div><dt>${fulfillment === 'delivery' ? 'Envío' : 'Retiro'}</dt><dd>${fulfillment === 'delivery' ? money(quote.deliveryFee) : 'Sin costo'}</dd></div>
            <div class="totals-final"><dt>Total</dt><dd>${money(quote.total)}</dd></div>
          </dl>
          <p class="microcopy">El importe se recalcula ${isShared() ? 'en el servidor' : 'con el catálogo guardado'} al confirmar.</p>`
        : '<p class="quiet">No se puede calcular el total hasta resolver los avisos de arriba.</p>'}
      </section>

      ${confirmNotice()}

      <button class="button button-confirm-order full" type="submit"
        ${quote && app.online ? '' : 'disabled'}>Confirmar pedido</button>
      ${!app.online && isShared() ? '<p class="microcopy">Sin conexión no se confirma. Reintentá cuando vuelva.</p>' : ''}
    </form>`;
}

async function viewOrder(orderId) {
  const order = await app.repository.query('order', { orderId });
  const business = await app.repository.query('business', { businessId: order.businessId });
  const steps = stepsFor(order.fulfillment);
  const current = stepIndex(order);
  const canceled = order.status === 'canceled';

  return `
    ${offlineBanner()}
    ${backLink('#actividad', 'Mi actividad')}
    <section class="page-header">
      <span class="eyebrow">PEDIDO ${esc(order.code)}</span>
      <h1 class="page-title">${esc(business.name)}</h1>
      <p class="quiet">${esc(fulfillmentLabel(order.fulfillment))} · ${esc(shortDate(order.createdAt))}</p>
    </section>

    ${canceled ? `
      <div class="notice ${order.cancellation?.kind === 'rejected' ? 'error' : ''}">
        <strong>${order.cancellation?.kind === 'rejected' ? 'El comercio no pudo tomar el pedido.' : 'Pedido cancelado.'}</strong>
        ${order.cancellation?.reason ? esc(order.cancellation.reason) : ''}
      </div>`
    : `<ol class="timeline" aria-label="Estado del pedido">
        ${steps.map((step, index) => `
          <li class="timeline-step ${index < current ? 'done' : index === current ? 'current' : ''}">
            <span class="timeline-dot" aria-hidden="true"></span>
            <span>${esc(orderStatusLabel({ ...order, status: step }))}</span>
          </li>`).join('')}
      </ol>`}

    ${canceled ? '' : renderOrderMoment(order)}
    ${canceled ? '' : renderDeliveryTracking(order, business)}

    <section class="checkout-section">
      <h2 class="checkout-section-title">Detalle</h2>
      <ul class="cart-lines-list">
        ${order.lines.map(line => `
          <li class="cart-line">
            <div class="cart-line-product">
              ${productThumb(line, line.name)}
              <div class="cart-line-info">
                <span class="cart-line-title">${esc(line.name)}</span>
                <span class="cart-line-unit-price">${line.quantity} × ${money(line.unitPrice)}</span>
              </div>
            </div>
            <span class="cart-line-total">${money(line.total)}</span>
          </li>`).join('')}
      </ul>
      <dl class="totals">
        <div><dt>Subtotal</dt><dd>${money(order.subtotal)}</dd></div>
        <div><dt>Envío</dt><dd>${order.deliveryFee > 0 ? money(order.deliveryFee) : 'Sin costo'}</dd></div>
        <div class="totals-final"><dt>Total</dt><dd>${money(order.total)}</dd></div>
      </dl>
      <p class="microcopy">Pago: ${esc(paymentLabel(order.paymentMethod))} · Estado del pago: pendiente al momento de la entrega.</p>
      ${order.deliveryCode ? `<p class="microcopy">Código de entrega: <strong>${esc(formatDeliveryCode(order.deliveryCode.code))}</strong></p>` : ''}
      ${order.customer?.address ? `<p class="microcopy">Dirección: ${esc(order.customer.address)}</p>` : ''}
    </section>

    ${allowedActions(order, { kind: 'customer', id: order.customerId }).includes('canceled') ? `
      <button class="button danger full" type="button" data-action="cancel-order"
        data-order="${esc(order.id)}" data-version="${order.version}">Cancelar pedido</button>` : ''}`;
}

async function viewActivity() {
  const [orders, trips, businesses] = await Promise.all([
    app.repository.query('myOrders'),
    app.repository.query('myTrips'),
    app.repository.query('publicBusinesses'),
  ]);
  const nameOf = id => businesses.find(business => business.id === id)?.name || 'Comercio';
  const tab = app.activityTab;

  const ordersList = orders.length ? `
    <div class="stack">
      ${orders.map(order => `
        <a class="op-card" href="#pedido/${esc(order.id)}">
          ${order.lines?.[0]?.image
            ? productThumb(order.lines[0], order.lines[0].name, 'op-card-thumb')
            : `<span class="op-card-icon">${renderIcon('receipt', 18)}</span>`}
          <span class="op-card-body">
            <strong>${esc(order.code)} · ${esc(nameOf(order.businessId))}</strong>
            <span class="quiet">${esc(shortDate(order.createdAt))} · ${money(order.total)}</span>
          </span>
          <span class="status-chip ${orderStatusTone(order.status)}">${esc(orderStatusLabel(order))}</span>
        </a>`).join('')}
    </div>`
    : emptyState('Todavía no hiciste pedidos', 'Cuando pidas a un comercio, vas a ver acá el estado y el detalle.',
      '#comercios', 'Ver comercios', 'bag');

  const tripsList = trips.length ? `
    <div class="stack">
      ${trips.map(trip => `
        <a class="op-card" href="#viaje/${esc(trip.id)}">
          <span class="op-card-icon">${renderIcon('taxi', 18)}</span>
          <span class="op-card-body">
            <strong>${esc(trip.origin)} → ${esc(trip.destination)}</strong>
            <span class="quiet">${esc(shortDate(trip.createdAt))}</span>
          </span>
          <span class="status-chip ${isTaxiActive(trip.status) ? 'ready' : trip.status === 'completed' ? 'done' : 'cancelled'}">${esc(tripStatusLabel(trip.status))}</span>
        </a>`).join('')}
    </div>`
    : emptyState('Todavía no pediste viajes', 'Cuando solicites un taxi, vas a poder seguirlo desde acá.',
      '#taxi', 'Pedir un taxi', 'taxi');

  return `
    ${offlineBanner()}
    <section class="page-header">
      <h1 class="page-title">Mi actividad</h1>
      ${isSignedIn()
        ? `<p class="quiet">Sesión de ${esc(actor().name)}.</p>`
        : `<p class="quiet">Estás navegando sin cuenta. Tus pedidos quedan asociados a este dispositivo.</p>`}
    </section>

    <div class="tabs" role="tablist" aria-label="Tipo de actividad">
      <button class="tab ${tab === 'pedidos' ? 'active' : ''}" type="button" role="tab"
        aria-selected="${tab === 'pedidos'}" data-action="set-activity-tab" data-tab="pedidos">Pedidos</button>
      <button class="tab ${tab === 'viajes' ? 'active' : ''}" type="button" role="tab"
        aria-selected="${tab === 'viajes'}" data-action="set-activity-tab" data-tab="viajes">Viajes</button>
    </div>

    ${tab === 'pedidos' ? ordersList : tripsList}

    <section class="home-block home-secondary">
      ${isSignedIn() ? `
        <button class="secondary-access" type="button" data-action="sign-out">
          <span class="secondary-access-icon" aria-hidden="true">${renderIcon('user', 26)}</span>
          <span><strong>Cerrar sesión</strong><span class="quiet">${esc(actor().email || '')}</span></span>
        </button>` : `
        <a class="secondary-access" href="#cuenta">
          <span class="secondary-access-icon" aria-hidden="true">${renderIcon('user', 26)}</span>
          <span><strong>Ingresar o crear cuenta</strong><span class="quiet">Necesaria para comercios, taxistas y administración.</span></span>
        </a>`}
      ${hasRole('merchant') ? `<a class="secondary-access" href="#panel"><span class="secondary-access-icon" aria-hidden="true">${renderIcon('store', 26)}</span><span><strong>Panel de mi comercio</strong><span class="quiet">Pedidos, catálogo y reparto.</span></span></a>` : ''}
      ${hasRole('driver') ? `<a class="secondary-access" href="#taxista"><span class="secondary-access-icon" aria-hidden="true">${renderIcon('taxi', 26)}</span><span><strong>Panel de taxista</strong><span class="quiet">Disponibilidad y solicitudes.</span></span></a>` : ''}
      ${hasRole('admin') ? `<a class="secondary-access" href="#admin"><span class="secondary-access-icon" aria-hidden="true">${renderIcon('shield-check', 26)}</span><span><strong>Administración</strong><span class="quiet">Altas pendientes y supervisión.</span></span></a>` : ''}
      ${app.repository.capabilities.reset ? `
        <button class="secondary-access quiet-access" type="button" data-action="reset-demo">
          <span class="secondary-access-icon" aria-hidden="true">${renderIcon('key', 26)}</span>
          <span><strong>Reiniciar datos de demostración</strong><span class="quiet">Borra pedidos, viajes y altas de este navegador.</span></span>
        </button>` : ''}
    </section>`;
}

// ───────────────────────── cuenta ─────────────────────────

async function viewAccount() {
  if (isSignedIn()) {
    return `
      ${backLink('#actividad', 'Mi actividad')}
      <section class="page-header">
        <h1 class="page-title">Tu cuenta</h1>
        <p class="quiet">${esc(actor().name)} · ${esc(actor().email || 'sin correo')}</p>
      </section>
      <section class="checkout-section">
        <h2 class="checkout-section-title">Accesos</h2>
        <p class="quiet">Roles: ${esc(actor().roles.join(', '))}</p>
        <div class="stack">
          ${hasRole('merchant') ? '<a class="button secondary" href="#panel">Panel de mi comercio</a>' : '<a class="button secondary" href="#alta-comercio">Sumar mi comercio</a>'}
          ${hasRole('driver') ? '<a class="button secondary" href="#taxista">Panel de taxista</a>' : '<a class="button secondary" href="#taxista">Registrarme como taxista</a>'}
          ${hasRole('admin') ? '<a class="button secondary" href="#admin">Administración</a>' : ''}
          <button class="button danger" type="button" data-action="sign-out">Cerrar sesión</button>
        </div>
      </section>`;
  }

  const identities = app.repository.capabilities.demoIdentities ? await app.repository.identities() : [];

  return `
    ${offlineBanner()}
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header">
      <h1 class="page-title">Ingresar a CAUCE</h1>
      <p class="quiet">Comprar y pedir un taxi no requiere cuenta. La cuenta hace falta para comercios, taxistas y administración.</p>
    </section>

    ${app.repository.capabilities.passwordAuth ? `
      <form class="checkout-form" data-form="sign-in">
        <h2 class="checkout-section-title">Ya tengo cuenta</h2>
        <div class="field">
          <label for="signin-email">Correo</label>
          <input id="signin-email" name="email" type="email" required autocomplete="email" inputmode="email">
        </div>
        <div class="field">
          <label for="signin-password">Contraseña</label>
          <input id="signin-password" name="password" type="password" required autocomplete="current-password">
        </div>
        <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Ingresar</button>
      </form>

      <form class="checkout-form" data-form="register">
        <h2 class="checkout-section-title">Crear una cuenta</h2>
        <div class="field">
          <label for="reg-name">Nombre y apellido</label>
          <input id="reg-name" name="name" type="text" required minlength="2" maxlength="80" autocomplete="name">
        </div>
        <div class="field">
          <label for="reg-email">Correo</label>
          <input id="reg-email" name="email" type="email" required autocomplete="email" inputmode="email">
        </div>
        <div class="field">
          <label for="reg-phone">Teléfono</label>
          <input id="reg-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="2942 000000">
        </div>
        <div class="field">
          <label for="reg-password">Contraseña</label>
          <input id="reg-password" name="password" type="password" required minlength="10" autocomplete="new-password">
          <p class="microcopy">Al menos 10 caracteres, combinando letras y números.</p>
        </div>
        <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Crear cuenta</button>
      </form>`
    : `
      <div class="notice">
        <strong>Esta demostración no usa contraseñas.</strong>
        Para probar sesiones autenticadas independientes entre personas, hay que ejecutar el entorno local con backend.
        Acá podés entrar con una identidad de ejemplo para recorrer cada panel.
      </div>
      <section class="checkout-section">
        <h2 class="checkout-section-title">Identidades de ejemplo</h2>
        <div class="stack">
          ${identities.map(identity => `
            <button class="secondary-access" type="button" data-action="use-identity" data-identity="${esc(identity.id)}">
              <span class="secondary-access-icon" aria-hidden="true">${renderIcon('user', 24)}</span>
              <span>
                <strong>${esc(identity.label)}</strong>
                <span class="quiet">${esc(identity.hint)}</span>
              </span>
            </button>`).join('')}
        </div>
        <p class="microcopy">Son personas ficticias creadas para la demostración. No representan cuentas reales.</p>
      </section>`}`;
}

// ───────────────────────── alta y panel de comercio ─────────────────────────

const BUSINESS_FORM_FIELDS = `
  <div class="field">
    <label for="biz-name">Nombre comercial</label>
    <input id="biz-name" name="name" type="text" required minlength="2" maxlength="80">
  </div>
  <div class="field">
    <label for="biz-category">Rubro</label>
    <input id="biz-category" name="category" type="text" required maxlength="40" placeholder="Panadería, almacén, rotisería…">
  </div>`;

async function viewBusinessSignup() {
  if (!isSignedIn()) {
    return `
      ${backLink('#inicio', 'Inicio')}
      <section class="page-header">
        <h1 class="page-title">Sumar mi comercio</h1>
        <p class="quiet">El alta la hace el propio comercio: creás tu cuenta, cargás tus datos y tu catálogo, y solicitás la publicación.</p>
      </section>
      <section class="brand-intro brand-intro-merchant">
        <div>${renderCharacter('merchant', 128)}</div>
        <p><strong>Tu vidriera, dentro de CAUCE.</strong><span>Cargá tus datos, fotos y productos. La publicación se activa después de la revisión de CAUCE.</span></p>
      </section>
      <div class="notice"><strong>Primero necesitás una cuenta.</strong> Es la que después usás para gestionar tus pedidos.</div>
      <a class="button full" href="#cuenta">Ingresar o crear cuenta</a>
      <section class="checkout-section">
        <h2 class="checkout-section-title">Cómo sigue</h2>
        <ol class="steps-list">
          <li>Creás tu cuenta.</li>
          <li>Completás los datos del comercio y las modalidades de entrega.</li>
          <li>Cargás al menos un producto.</li>
          <li>Solicitás la publicación.</li>
          <li>Administración revisa el alta y la aprueba o la devuelve con observaciones.</li>
        </ol>
        <p class="microcopy">La aprobación de CAUCE habilita la publicación dentro de la plataforma. No es una habilitación municipal ni reemplaza los permisos que cada comercio necesite.</p>
      </section>`;
  }

  return `
    ${backLink('#panel', 'Mis comercios')}
    <section class="page-header">
      <h1 class="page-title">Nuevo comercio</h1>
      <p class="quiet">Se crea como borrador. Vas a poder completar el resto y cargar productos antes de solicitar la publicación.</p>
    </section>
    <section class="brand-intro brand-intro-merchant">
      <div>${renderCharacter('merchant', 112)}</div>
      <p><strong>Empezá por lo esencial.</strong><span>Después vas a sumar identidad, catálogo y modalidades de entrega.</span></p>
    </section>
    <form class="checkout-form" data-form="business-create">
      ${BUSINESS_FORM_FIELDS}
      <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Crear borrador</button>
    </form>`;
}

async function viewMerchantPanel(businessId) {
  if (!isSignedIn()) {
    return `${backLink('#inicio', 'Inicio')}
      <section class="page-header"><h1 class="page-title">Panel de comercio</h1></section>
      <div class="notice"><strong>Necesitás iniciar sesión.</strong> El panel muestra únicamente los datos del comercio de tu cuenta.</div>
      <a class="button full" href="#cuenta">Ingresar</a>`;
  }

  const businesses = await app.repository.query('myBusinesses');
  if (!businessId) {
    return `
      ${offlineBanner()}
      <section class="page-header">
        <h1 class="page-title">Mis comercios</h1>
        <p class="quiet">Cada comercio ve sólo sus pedidos, su catálogo y su reparto.</p>
      </section>
      ${businesses.length ? `<div class="stack">${businesses.map(business => `
        <a class="op-card" href="#panel/${esc(business.id)}">
          <span class="op-card-icon">${renderIcon('store', 18)}</span>
          <span class="op-card-body">
            <strong>${esc(business.name)}</strong>
            <span class="quiet">${esc(BUSINESS_STATUS_HINTS[business.status] || '')}</span>
          </span>
          <span class="status-chip ${business.status === 'active' ? 'done' : business.status === 'pending_review' ? 'ready' : 'received'}">${esc(businessStatusLabel(business.status))}</span>
        </a>`).join('')}</div>`
        : emptyState('Todavía no tenés comercios', 'Creá el primero para empezar a cargar tu catálogo.', '#alta-comercio', 'Crear comercio', 'merchant')}
      <a class="button secondary full" href="#alta-comercio">Agregar otro comercio</a>`;
  }

  const business = businesses.find(candidate => candidate.id === businessId);
  if (!business) {
    return `<section class="notice error"><h2>Sin acceso</h2><p>Ese comercio no pertenece a tu cuenta.</p>
      <a class="button secondary" href="#panel">Volver a mis comercios</a></section>`;
  }

  const [orders, products, riders] = await Promise.all([
    app.repository.query('businessOrders', { businessId }),
    app.repository.query('products', { businessId }),
    app.repository.query('riders', { businessId }),
  ]);

  const missing = missingPublicationRequirements(business, products);
  const tab = app.panelTab;

  return `
    ${offlineBanner()}
    ${backLink('#panel', 'Mis comercios')}
    <section class="page-header">
      <span class="eyebrow">${esc(businessStatusLabel(business.status).toUpperCase())}</span>
      <h1 class="page-title">${esc(business.name)}</h1>
      <p class="quiet">${esc(BUSINESS_STATUS_HINTS[business.status] || '')}</p>
    </section>

    ${business.status === 'returned' && business.reviewNote ? `
      <div class="notice error">
        <strong>Administración devolvió la solicitud.</strong> ${esc(business.reviewNote)}
      </div>` : ''}

    ${business.status === 'active' ? `
      <div class="panel-openbar">
        <span>${business.open ? 'Recibiendo pedidos' : 'Cerrado: no recibe pedidos'}</span>
        <button class="button ${business.open ? 'danger' : ''}" type="button" data-action="toggle-open"
          data-business="${esc(business.id)}" data-open="${business.open ? 'false' : 'true'}">
          ${business.open ? 'Cerrar atención' : 'Abrir atención'}
        </button>
      </div>` : ''}

    <div class="tabs" role="tablist" aria-label="Secciones del panel">
      ${[['pedidos', 'Pedidos'], ['catalogo', 'Catálogo'], ['datos', 'Datos'], ['reparto', 'Reparto']].map(([key, label]) => `
        <button class="tab ${tab === key ? 'active' : ''}" type="button" role="tab" aria-selected="${tab === key}"
          data-action="set-panel-tab" data-tab="${key}">${label}</button>`).join('')}
    </div>

    ${tab === 'pedidos' ? merchantOrdersTab(business, orders, riders) : ''}
    ${tab === 'catalogo' ? merchantCatalogTab(business, products) : ''}
    ${tab === 'datos' ? merchantDataTab(business, missing) : ''}
    ${tab === 'reparto' ? merchantRidersTab(business, riders) : ''}`;
}

function merchantOrdersTab(business, orders, riders) {
  const pending = orders.filter(order => !['delivered', 'canceled'].includes(order.status));
  const closed = orders.filter(order => ['delivered', 'canceled'].includes(order.status));
  const merchantActor = { kind: 'merchant', businessId: business.id, localityId: business.localityId };

  const actionLabel = (order, action) => {
    if (action === 'canceled') return order.status === 'submitted' ? 'Rechazar' : 'Cancelar';
    if (action === 'accepted') return 'Aceptar';
    if (action === 'preparing') return 'Informar preparación';
    if (action === 'ready') return order.fulfillment === 'pickup' ? 'Listo para retirar' : 'Listo para enviar';
    if (action === 'assigned') return 'Asignar reparto';
    if (action === 'picked_up') return 'Retirado por el reparto';
    if (action === 'on_the_way') return 'Marcar salida';
    if (action === 'arrived') return 'Llegó a destino';
    if (action === 'delivered') return order.fulfillment === 'pickup' ? 'Marcar retirado' : 'Marcar entregado';
    return action;
  };

  const orderRow = order => {
    const merchantOptions = allowedActions(order, merchantActor).filter(Boolean);
    const riderActor = order.riderId
      ? { kind: 'rider', id: order.riderId, businessId: business.id, localityId: business.localityId }
      : null;
    const riderOptions = riderActor ? allowedActions(order, riderActor).filter(Boolean) : [];
    const options = [...new Set([...merchantOptions, ...riderOptions])];
    const riderName = riders.find(rider => rider.id === order.riderId)?.name;

    return `
      <article class="order-panel-card">
        <header class="order-panel-head">
          <div>
            <strong>${esc(order.code)}</strong>
            <span class="quiet"> · ${esc(fulfillmentLabel(order.fulfillment))} · ${esc(timeOnly(order.createdAt))}</span>
          </div>
          <span class="status-chip ${orderStatusTone(order.status)}">${esc(orderStatusLabel(order))}</span>
        </header>
        <ul class="order-panel-lines">
          ${order.lines.map(line => `<li>${line.quantity} × ${esc(line.name)}</li>`).join('')}
        </ul>
        <p class="microcopy">${esc(order.customer.name)} · ${esc(formatArgentinePhone(order.customer.phone))}${order.customer.address ? ` · ${esc(order.customer.address)}` : ''}</p>
        ${order.customer.notes ? `<p class="microcopy">Notas: ${esc(order.customer.notes)}</p>` : ''}
        <p class="order-panel-total">${money(order.total)} · ${esc(paymentLabel(order.paymentMethod))}</p>
        ${riderName ? `<p class="microcopy">Reparto: ${esc(riderName)}</p>` : ''}
        ${order.cancellation ? `<p class="microcopy">Motivo: ${esc(order.cancellation.reason)}</p>` : ''}
        ${options.length ? `<div class="order-panel-actions">
          ${options.map(action => {
            if (action === 'assigned') {
              if (!riders.length) {
                return `<a class="button secondary" href="#panel/${esc(business.id)}" data-action="set-panel-tab" data-tab="reparto">Dar de alta reparto</a>`;
              }
              return `<form class="inline-form" data-form="assign-rider" data-order="${esc(order.id)}" data-version="${order.version}">
                <label class="visually-hidden" for="rider-${esc(order.id)}">Repartidor para ${esc(order.code)}</label>
                <select id="rider-${esc(order.id)}" name="riderId" required>
                  ${riders.map(rider => `<option value="${esc(rider.id)}">${esc(rider.name)}</option>`).join('')}
                </select>
                <button class="button" type="submit">Asignar reparto</button>
              </form>`;
            }
            const danger = action === 'canceled' ? 'danger' : '';
            return `<button class="button ${danger}" type="button" data-action="order-transition"
              data-order="${esc(order.id)}" data-version="${order.version}" data-next="${esc(action)}"
              ${action === 'canceled' ? 'data-reason="required"' : ''}>${esc(actionLabel(order, action))}</button>`;
          }).join('')}
        </div>` : ''}
      </article>`;
  };

  return `
    <section class="panel-section">
      <h2 class="checkout-section-title">Requieren atención (${pending.length})</h2>
      ${pending.length ? `<div class="stack">${pending.map(orderRow).join('')}</div>`
        : '<p class="quiet">No hay pedidos pendientes en este momento.</p>'}
    </section>
    ${closed.length ? `
      <section class="panel-section">
        <h2 class="checkout-section-title">Cerrados (${closed.length})</h2>
        <div class="stack">${closed.slice(0, 10).map(orderRow).join('')}</div>
      </section>` : ''}`;
}

function merchantCatalogTab(business, products) {
  return `
    <section class="panel-section">
      <h2 class="checkout-section-title">Nuevo producto</h2>
      <form class="checkout-form" data-form="product-create" data-business="${esc(business.id)}">
        <div class="field">
          <label for="prod-name">Nombre</label>
          <input id="prod-name" name="name" type="text" required minlength="2" maxlength="80">
        </div>
        <div class="field">
          <label for="prod-description">Descripción</label>
          <input id="prod-description" name="description" type="text" maxlength="280">
        </div>
        <div class="field-row">
          <div class="field">
            <label for="prod-price">Precio</label>
            <input id="prod-price" name="price" type="number" required min="1" step="1" inputmode="numeric">
          </div>
          <div class="field">
            <label for="prod-stock">Stock</label>
            <input id="prod-stock" name="stock" type="number" required min="0" step="1" value="10" inputmode="numeric">
          </div>
        </div>
        <div class="field">
          <label for="prod-category">Categoría</label>
          <input id="prod-category" name="category" type="text" required maxlength="40" list="categorias" value="Otros">
          <datalist id="categorias">
            ${PRODUCT_CATEGORIES_SUGGESTED.map(category => `<option value="${esc(category)}"></option>`).join('')}
          </datalist>
        </div>
        <div class="field">
          <label for="prod-variants">Variantes (opcional)</label>
          <input id="prod-variants" name="variants" type="text" maxlength="200"
            placeholder="Chica, Grande +2000, Familiar +5000">
          <p class="microcopy">Separadas por coma. El número suma o resta sobre el precio base.
            Si cargás variantes, quien compra elige una.</p>
        </div>
        <p class="microcopy">Las fotos se toman de las imágenes incluidas en el proyecto. La carga de fotos propias no está implementada en esta entrega.</p>
        <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Agregar al catálogo</button>
      </form>
    </section>

    <section class="panel-section">
      <h2 class="checkout-section-title">Catálogo (${products.filter(product => !product.archived).length})</h2>
      ${products.length ? `<div class="stack">${products.map(product => `
        <article class="catalog-row ${product.archived ? 'is-archived' : ''}">
          <div class="catalog-row-main">
            <strong>${esc(product.name)}</strong>
            <span class="quiet">${esc(product.category)} · ${money(product.price)} · stock ${product.stock}</span>
            ${(product.variants || []).length
              ? `<span class="quiet">Variantes: ${esc((product.variants || []).map(variant =>
                  variant.priceDelta ? `${variant.name} ${variant.priceDelta > 0 ? '+' : '−'}${Math.abs(variant.priceDelta)}` : variant.name).join(', '))}</span>`
              : ''}
            ${product.archived ? '<span class="status-chip cancelled">Dado de baja</span>'
              : product.available ? '' : '<span class="status-chip received">Agotado</span>'}
          </div>
          <form class="inline-form" data-form="product-update" data-business="${esc(business.id)}" data-product="${esc(product.id)}">
            <label class="visually-hidden" for="price-${esc(product.id)}">Precio de ${esc(product.name)}</label>
            <input id="price-${esc(product.id)}" name="price" type="number" min="1" step="1" value="${product.price}" inputmode="numeric">
            <label class="visually-hidden" for="stock-${esc(product.id)}">Stock de ${esc(product.name)}</label>
            <input id="stock-${esc(product.id)}" name="stock" type="number" min="0" step="1" value="${product.stock}" inputmode="numeric">
            <button class="button secondary" type="submit">Guardar</button>
          </form>
          <div class="catalog-row-actions">
            <button class="link-button" type="button" data-action="product-toggle" data-business="${esc(business.id)}"
              data-product="${esc(product.id)}" data-field="available" data-value="${product.available ? 'false' : 'true'}">
              ${product.available ? 'Marcar agotado' : 'Marcar disponible'}
            </button>
            <button class="link-button danger" type="button" data-action="product-toggle" data-business="${esc(business.id)}"
              data-product="${esc(product.id)}" data-field="archived" data-value="${product.archived ? 'false' : 'true'}">
              ${product.archived ? 'Reactivar' : 'Dar de baja'}
            </button>
          </div>
        </article>`).join('')}</div>`
        : '<p class="quiet">Todavía no cargaste productos.</p>'}
    </section>`;
}

function merchantDataTab(business, missing) {
  const editable = business.status !== 'pending_review';
  return `
    <section class="panel-section">
      ${business.status === 'pending_review'
        ? '<div class="notice">La solicitud está en revisión. Vas a poder editar cuando administración responda.</div>' : ''}
      <form class="checkout-form" data-form="business-update" data-business="${esc(business.id)}">
        <h2 class="checkout-section-title">Datos del comercio</h2>
        <div class="field">
          <label for="b-name">Nombre comercial</label>
          <input id="b-name" name="name" type="text" required maxlength="80" value="${esc(business.name)}" ${editable ? '' : 'disabled'}>
        </div>
        <div class="field">
          <label for="b-category">Rubro</label>
          <input id="b-category" name="category" type="text" maxlength="40" value="${esc(business.category || '')}" ${editable ? '' : 'disabled'}>
        </div>
        <div class="field">
          <label for="b-owner">Responsable</label>
          <input id="b-owner" name="ownerName" type="text" maxlength="80" value="${esc(business.ownerName || '')}" ${editable ? '' : 'disabled'}>
        </div>
        <div class="field">
          <label for="b-phone">Teléfono de contacto</label>
          <input id="b-phone" name="contactPhone" type="tel" inputmode="tel" value="${esc(business.contactPhone || '')}" ${editable ? '' : 'disabled'}>
        </div>
        <div class="field">
          <label for="b-address">Dirección</label>
          <input id="b-address" name="address" type="text" maxlength="120" value="${esc(business.address || '')}" ${editable ? '' : 'disabled'}>
        </div>
        <div class="field">
          <label for="b-reference">Referencias para llegar</label>
          <input id="b-reference" name="reference" type="text" maxlength="120" value="${esc(business.reference || '')}" ${editable ? '' : 'disabled'}>
        </div>
        <div class="field">
          <label for="b-hours">Horarios de atención</label>
          <input id="b-hours" name="hoursLabel" type="text" maxlength="80" value="${esc(business.hoursLabel || '')}"
            placeholder="Lunes a sábado de 9 a 13 y de 17 a 21" ${editable ? '' : 'disabled'}>
        </div>

        <h2 class="checkout-section-title">Modalidades de entrega</h2>
        <label class="check-label">
          <input type="checkbox" name="pickupEnabled" ${business.pickupEnabled ? 'checked' : ''} ${editable ? '' : 'disabled'}>
          <span>Retiro en el comercio</span>
        </label>
        <label class="check-label">
          <input type="checkbox" name="deliveryEnabled" ${business.deliveryEnabled ? 'checked' : ''} ${editable ? '' : 'disabled'}>
          <span>Envío con reparto propio</span>
        </label>
        <div class="field">
          <label for="b-zone">Zona de envío</label>
          <input id="b-zone" name="deliveryZone" type="text" maxlength="80" value="${esc(business.deliveryZone || '')}"
            placeholder="Casco urbano de Aluminé" ${editable ? '' : 'disabled'}>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="b-fee">Costo de envío</label>
            <input id="b-fee" name="deliveryFee" type="number" min="0" step="1" value="${business.deliveryFee || 0}" inputmode="numeric" ${editable ? '' : 'disabled'}>
          </div>
          <div class="field">
            <label for="b-min">Pedido mínimo para envío</label>
            <input id="b-min" name="minimumOrder" type="number" min="0" step="1" value="${business.minimumOrder || 0}" inputmode="numeric" ${editable ? '' : 'disabled'}>
          </div>
        </div>
        <button class="button full" type="submit" ${editable && app.online ? '' : 'disabled'}>Guardar datos</button>
      </form>
    </section>

    <section class="panel-section">
      <h2 class="checkout-section-title">Publicación</h2>
      ${missing.length ? `
        <div class="notice">
          <strong>Falta completar para solicitar la publicación:</strong>
          <ul class="plain-list">${missing.map(item => `<li>${esc(item)}</li>`).join('')}</ul>
        </div>` : '<p class="quiet">Los datos mínimos están completos.</p>'}
      ${['draft', 'returned'].includes(business.status) ? `
        <button class="button full" type="button" data-action="submit-business" data-business="${esc(business.id)}"
          ${missing.length || !app.online ? 'disabled' : ''}>Solicitar publicación</button>` : ''}
      ${business.status === 'active' ? `
        <button class="button secondary full" type="button" data-action="business-status"
          data-business="${esc(business.id)}" data-status="paused">Pausar el comercio</button>` : ''}
      ${business.status === 'paused' ? `
        <button class="button full" type="button" data-action="business-status"
          data-business="${esc(business.id)}" data-status="active">Reactivar el comercio</button>` : ''}
      <p class="microcopy">La aprobación de CAUCE habilita la publicación dentro de la plataforma. No constituye una habilitación municipal ni reemplaza los permisos que cada comercio deba tener.</p>
    </section>`;
}

function merchantRidersTab(business, riders) {
  return `
    <section class="panel-section">
      <h2 class="checkout-section-title">Reparto del comercio</h2>
      <p class="quiet">Cada comercio administra su propio reparto. CAUCE no opera una flota.</p>
      ${riders.length ? `<ul class="plain-list">${riders.map(rider => `
        <li><strong>${esc(rider.name)}</strong>${rider.phone ? ` · ${esc(rider.phone)}` : ''}</li>`).join('')}</ul>`
        : '<p class="quiet">Todavía no cargaste personas de reparto.</p>'}
      <form class="checkout-form" data-form="rider-create" data-business="${esc(business.id)}">
        <div class="field">
          <label for="rider-name">Nombre</label>
          <input id="rider-name" name="name" type="text" required minlength="2" maxlength="60">
        </div>
        <div class="field">
          <label for="rider-phone">Teléfono (opcional)</label>
          <input id="rider-phone" name="phone" type="tel" inputmode="tel" maxlength="24">
        </div>
        <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Agregar al reparto</button>
      </form>
    </section>`;
}

// ───────────────────────── administración ─────────────────────────

async function viewAdmin() {
  if (!hasRole('admin')) {
    return `${backLink('#inicio', 'Inicio')}
      <section class="page-header"><h1 class="page-title">Administración</h1></section>
      <div class="notice error"><strong>Sección restringida.</strong> Requiere una cuenta con rol de administración.</div>
      <a class="button full" href="#cuenta">Ingresar</a>`;
  }
  const [queue, metrics] = await Promise.all([
    app.repository.query('adminQueue'),
    app.repository.query('adminMetrics'),
  ]);

  const reviewCard = (item, kind) => `
    <article class="review-card">
      <header class="order-panel-head">
        <div>
          <strong>${esc(kind === 'business' ? item.name : item.displayName)}</strong>
          <span class="quiet"> · ${esc(kind === 'business' ? (item.category || 'Sin rubro') : `${item.vehicle} · ${item.plate}`)}</span>
        </div>
        <span class="status-chip ready">${esc(kind === 'business' ? businessStatusLabel(item.status) : DRIVER_STATUS_LABELS[item.status])}</span>
      </header>
      ${kind === 'business' ? `
        <ul class="plain-list">
          <li>Responsable: ${esc(item.ownerName || '—')}</li>
          <li>Contacto: ${esc(item.contactPhone || '—')}</li>
          <li>Dirección: ${esc(item.address || '—')}</li>
          <li>Horarios: ${esc(item.hoursLabel || '—')}</li>
          <li>Entrega: ${[item.pickupEnabled ? 'retiro' : null, item.deliveryEnabled ? `envío (${item.deliveryZone || 'zona sin declarar'})` : null].filter(Boolean).join(' y ') || '—'}</li>
        </ul>` : `
        <ul class="plain-list">
          <li>Teléfono: ${esc(item.phone || '—')}</li>
          <li>Móvil: ${esc(item.mobileNumber || '—')}</li>
        </ul>`}
      <form class="checkout-form" data-form="review" data-kind="${kind}" data-id="${esc(kind === 'business' ? item.id : item.id)}">
        <div class="field">
          <label for="note-${esc(item.id)}">Observaciones (obligatorias para devolver)</label>
          <textarea id="note-${esc(item.id)}" name="note" rows="2" maxlength="400"></textarea>
        </div>
        <div class="order-panel-actions">
          <button class="button" type="submit" name="decision" value="approve">Aprobar</button>
          <button class="button danger" type="submit" name="decision" value="return">Devolver con observaciones</button>
        </div>
      </form>
    </article>`;

  const counter = (label, value) => `<div class="metric"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

  return `
    ${offlineBanner()}
    <section class="page-header">
      <h1 class="page-title">Administración</h1>
      <p class="quiet">Revisión de altas y supervisión agregada de la operación.</p>
    </section>

    <section class="panel-section">
      <h2 class="checkout-section-title">Comercios pendientes (${queue.businesses.length})</h2>
      ${queue.businesses.length ? `<div class="stack">${queue.businesses.map(item => reviewCard(item, 'business')).join('')}</div>`
        : '<p class="quiet">No hay comercios esperando revisión.</p>'}
    </section>

    <section class="panel-section">
      <h2 class="checkout-section-title">Taxistas pendientes (${queue.drivers.length})</h2>
      ${queue.drivers.length ? `<div class="stack">${queue.drivers.map(item => reviewCard(item, 'driver')).join('')}</div>`
        : '<p class="quiet">No hay altas de conductores esperando revisión.</p>'}
    </section>

    <section class="panel-section">
      <h2 class="checkout-section-title">Operación registrada</h2>
      <p class="microcopy">Origen: ${esc(metrics.source)} Nada de esto es una proyección ni una estimación.</p>
      <dl class="metrics-grid">
        ${counter('Comercios publicados', metrics.businesses.active || 0)}
        ${counter('Comercios en revisión', metrics.businesses.pending_review || 0)}
        ${counter('Taxistas habilitados', metrics.drivers.active || 0)}
        ${counter('Pedidos registrados', metrics.orders.total)}
        ${counter('Pedidos entregados', metrics.orders.delivered)}
        ${counter('Pedidos cancelados', metrics.orders.canceled)}
        ${counter('Viajes solicitados', metrics.trips.total)}
        ${counter('Viajes aceptados', metrics.trips.accepted)}
      </dl>
      <p class="microcopy">Vista agregada: no incluye direcciones de clientes, teléfonos ni recorridos individuales.</p>
    </section>`;
}

// ───────────────────────── taxis ─────────────────────────

async function viewTaxi() {
  const trips = await app.repository.query('myTrips');
  const active = trips.find(trip => isTaxiActive(trip.status));
  if (active) return viewTrip(active.id, trips);

  const stored = draft('taxi');
  const recent = trips.slice(0, 3);

  return `
    ${offlineBanner()}
    <section class="page-header">
      <h1 class="page-title">Pedir un taxi</h1>
      <p class="quiet">Tu solicitud se ofrece a los conductores habilitados que estén disponibles. La toma el primero que responde.</p>
    </section>

    <form class="checkout-form" data-form="taxi-request">
      <section class="checkout-section">
        <h2 class="checkout-section-title">Recorrido</h2>
        <div class="field">
          <label for="taxi-origin">Desde</label>
          <input id="taxi-origin" name="origin" type="text" required minlength="3" maxlength="120"
            placeholder="Dirección o lugar de Aluminé" value="${esc(stored.origin || '')}">
          <button class="link-button" type="button" data-action="use-location">Usar mi ubicación (opcional)</button>
          <p class="microcopy">Podés escribir la dirección a mano. La ubicación del teléfono es opcional y sólo se pide si la tocás.</p>
        </div>
        <div class="field">
          <label for="taxi-destination">Hasta</label>
          <input id="taxi-destination" name="destination" type="text" required minlength="3" maxlength="120"
            placeholder="Dirección o lugar de Aluminé" value="${esc(stored.destination || '')}">
        </div>
        <div class="field">
          <label for="taxi-note">Referencia (opcional)</label>
          <input id="taxi-note" name="originNote" type="text" maxlength="120"
            placeholder="Portón verde, esquina del almacén…" value="${esc(stored.originNote || '')}">
        </div>
        <div class="field">
          <label for="taxi-passengers">Cantidad de pasajeros</label>
          <select id="taxi-passengers" name="passengers">
            ${Array.from({ length: DISPATCH_POLICY.maxPassengers }, (unused, index) => index + 1).map(number => `
              <option value="${number}" ${String(stored.passengers || 1) === String(number) ? 'selected' : ''}>${number}</option>`).join('')}
          </select>
        </div>
      </section>

      <section class="checkout-section">
        <h2 class="checkout-section-title">Tus datos</h2>
        <div class="field">
          <label for="taxi-name">Nombre</label>
          <input id="taxi-name" name="passengerName" type="text" required minlength="2" maxlength="80"
            autocomplete="name" value="${esc(stored.passengerName || (isSignedIn() ? actor().name : ''))}">
        </div>
        <div class="field">
          <label for="taxi-phone">Teléfono</label>
          <input id="taxi-phone" name="passengerPhone" type="tel" required inputmode="tel" autocomplete="tel"
            placeholder="2942 000000" value="${esc(stored.passengerPhone || (isSignedIn() ? actor().phone || '' : ''))}">
        </div>
        <p class="microcopy">El conductor ve tu teléfono recién cuando acepta el viaje. Antes de eso, la flota sólo ve el recorrido.</p>
      </section>

      <section class="checkout-section">
        <h2 class="checkout-section-title">Tarifa y tiempos</h2>
        <p class="quiet">La tarifa y el tiempo de llegada se coordinan con el conductor. CAUCE no publica tarifas ni estimaciones de llegada:
          todavía no hay un cuadro tarifario ni datos de operación validados en Aluminé.</p>
      </section>

      ${confirmNotice()}
      <button class="button button-confirm-order full" type="submit" ${app.online ? '' : 'disabled'}>Solicitar taxi</button>
      <p class="microcopy">La solicitud vence a los ${DISPATCH_POLICY.requestTtlMinutes} minutos si ningún conductor responde.</p>
    </form>

    ${recent.length ? `
      <section class="panel-section">
        <h2 class="checkout-section-title">Viajes anteriores</h2>
        <div class="stack">
          ${recent.map(trip => `
            <a class="op-card" href="#viaje/${esc(trip.id)}">
              <span class="op-card-icon">${renderIcon('taxi', 18)}</span>
              <span class="op-card-body">
                <strong>${esc(trip.origin)} → ${esc(trip.destination)}</strong>
                <span class="quiet">${esc(shortDate(trip.createdAt))}</span>
              </span>
              <span class="status-chip ${trip.status === 'completed' ? 'done' : 'cancelled'}">${esc(tripStatusLabel(trip.status))}</span>
            </a>`).join('')}
        </div>
      </section>` : ''}`;
}

async function viewTrip(tripId, preloaded = null) {
  const trips = preloaded || await app.repository.query('myTrips');
  const trip = trips.find(candidate => candidate.id === tripId);
  if (!trip) return emptyState('Viaje no encontrado', 'Puede que se haya cerrado o pertenezca a otra sesión.', '#taxi', 'Pedir un taxi', 'taxi');

  const steps = [
    ['searching', 'Buscando respuesta'],
    ['accepted', 'Confirmado'],
    ['driver_on_way', 'En camino al origen'],
    ['in_trip', 'Viaje iniciado'],
    ['completed', 'Finalizado'],
  ];
  const order = ['searching', 'accepted', 'driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip', 'completed'];
  const position = order.indexOf(trip.status);
  const reached = key => position >= order.indexOf(key);
  const closed = !isTaxiActive(trip.status);

  return `
    ${offlineBanner()}
    ${backLink('#actividad', 'Mi actividad')}
    <section class="page-header">
      <span class="eyebrow">VIAJE</span>
      <h1 class="page-title">${esc(trip.origin)} → ${esc(trip.destination)}</h1>
      <p class="quiet">${esc(shortDate(trip.createdAt))} · ${pluralize(trip.passengers, 'pasajero', 'pasajeros')}</p>
    </section>

    ${trip.status === 'no_availability' ? `
      <div class="notice"><strong>No hay conductores disponibles en este momento.</strong>
        La solicitud quedó registrada pero no se ofreció a nadie. Podés volver a intentar más tarde.</div>` : ''}
    ${trip.status === 'expired' ? `
      <div class="notice"><strong>La solicitud venció.</strong> Ningún conductor respondió dentro de los ${DISPATCH_POLICY.requestTtlMinutes} minutos.</div>` : ''}
    ${trip.status === 'canceled' ? `
      <div class="notice"><strong>Viaje cancelado.</strong> ${esc(trip.history.at(-1)?.note || '')}</div>` : ''}

    ${renderTaxiTracking(trip)}

    ${closed ? '' : `
      <ol class="timeline" aria-label="Estado del viaje">
        ${steps.map(([key, label]) => `
          <li class="timeline-step ${trip.status === key ? 'current' : reached(key) ? 'done' : ''}">
            <span class="timeline-dot" aria-hidden="true"></span>
            <span>${esc(label)}</span>
          </li>`).join('')}
      </ol>`}

    ${trip.status === 'searching' ? `
      <div class="notice">
        <strong>Esperando respuesta.</strong>
        Se ofreció a ${pluralize(trip.offeredTo.length, 'conductor disponible', 'conductores disponibles')}.
        ${trip.expiresAt ? esc(relativeMinutes(trip.expiresAt)) : ''}
      </div>` : ''}

    ${trip.driver ? `
      <section class="checkout-section">
        <h2 class="checkout-section-title">Conductor asignado</h2>
        <ul class="plain-list">
          <li><strong>${esc(trip.driver.displayName)}</strong></li>
          <li>Vehículo: ${esc(trip.driver.vehicle)}</li>
          <li>Patente: ${esc(trip.driver.plate)}</li>
          ${trip.driver.mobileNumber ? `<li>Móvil: ${esc(trip.driver.mobileNumber)}</li>` : ''}
          ${trip.driver.phone ? `<li>Teléfono: ${esc(formatArgentinePhone(trip.driver.phone))}</li>` : ''}
        </ul>
        <p class="microcopy">Datos del entorno de prueba. La patente puede ser sintética y no identifica un servicio real.</p>
      </section>` : ''}

    <section class="checkout-section">
      <h2 class="checkout-section-title">Historial</h2>
      <ul class="plain-list">
        ${trip.history.map(entry => `<li>${esc(timeOnly(entry.timestamp))} · ${esc(tripStatusLabel(entry.status))}${entry.note ? ` — ${esc(entry.note)}` : ''}</li>`).join('')}
      </ul>
    </section>

    ${isTaxiCancelable(trip.status) ? `
      <button class="button danger full" type="button" data-action="cancel-trip" data-trip="${esc(trip.id)}">Cancelar solicitud</button>`
      : closed ? '<a class="button full" href="#taxi">Pedir otro viaje</a>' : ''}`;
}

async function viewDriver() {
  if (!isSignedIn()) {
    return `${backLink('#inicio', 'Inicio')}
      <section class="page-header">
        <h1 class="page-title">Registrarme como taxista</h1>
        <p class="quiet">Para recibir solicitudes necesitás una cuenta y que administración apruebe tu alta.</p>
      </section>
      <a class="button full" href="#cuenta">Ingresar o crear cuenta</a>
      <section class="checkout-section">
        <h2 class="checkout-section-title">Qué falta para operar de verdad</h2>
        <p class="quiet">La activación de viajes reales queda condicionada a validar la habilitación municipal del servicio,
          los seguros, el cuadro tarifario y las condiciones de operación. CAUCE todavía no verifica ninguno de esos requisitos.</p>
      </section>`;
  }

  const driver = await app.repository.query('myDriver');
  if (!driver || ['draft', 'returned'].includes(driver.status)) {
    return `
      ${offlineBanner()}
      ${backLink('#actividad', 'Mi actividad')}
      <section class="page-header">
        <h1 class="page-title">Alta de taxista</h1>
        <p class="quiet">Completá tus datos y enviá la solicitud. Administración la revisa antes de habilitarte.</p>
      </section>
      ${driver?.status === 'returned' && driver.reviewNote
        ? `<div class="notice error"><strong>Tu alta fue devuelta.</strong> ${esc(driver.reviewNote)}</div>` : ''}
      <form class="checkout-form" data-form="driver-apply">
        <div class="field">
          <label for="d-name">Nombre con el que operás</label>
          <input id="d-name" name="displayName" type="text" required minlength="2" maxlength="80" value="${esc(driver?.displayName || actor().name)}">
        </div>
        <div class="field">
          <label for="d-vehicle">Vehículo (marca y modelo)</label>
          <input id="d-vehicle" name="vehicle" type="text" required minlength="3" maxlength="60" value="${esc(driver?.vehicle || '')}">
        </div>
        <div class="field">
          <label for="d-plate">Patente</label>
          <input id="d-plate" name="plate" type="text" required minlength="5" maxlength="12" value="${esc(driver?.plate || '')}">
        </div>
        <div class="field">
          <label for="d-mobile">Número de móvil (opcional)</label>
          <input id="d-mobile" name="mobileNumber" type="text" maxlength="40" value="${esc(driver?.mobileNumber || '')}">
        </div>
        <div class="field">
          <label for="d-phone">Teléfono de contacto</label>
          <input id="d-phone" name="phone" type="tel" required inputmode="tel" value="${esc(driver?.phone || actor().phone || '')}">
        </div>
        <p class="microcopy">La aprobación en CAUCE habilita el uso de la plataforma en el piloto. No acredita habilitación municipal,
          seguro ni cuadro tarifario: esos requisitos siguen pendientes de validación.</p>
        <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Enviar solicitud</button>
      </form>`;
  }

  if (driver.status === 'pending_review') {
    return `
      ${backLink('#actividad', 'Mi actividad')}
      <section class="page-header"><h1 class="page-title">Alta enviada</h1></section>
      <div class="notice"><strong>Tu alta está en revisión administrativa.</strong> Vas a poder marcarte disponible cuando sea aprobada.</div>
      <ul class="plain-list">
        <li>${esc(driver.displayName)}</li>
        <li>${esc(driver.vehicle)} · ${esc(driver.plate)}</li>
      </ul>`;
  }

  const [offers, myTrips] = await Promise.all([
    app.repository.query('driverOffers'),
    app.repository.query('driverTrips'),
  ]);
  const activeTrip = myTrips.find(trip => isTaxiActive(trip.status));
  const nextAction = activeTrip ? getDriverNextAction(activeTrip.status) : null;

  return `
    ${offlineBanner()}
    ${backLink('#actividad', 'Mi actividad')}
    <section class="page-header">
      <span class="eyebrow">TAXISTA</span>
      <h1 class="page-title">${esc(driver.displayName)}</h1>
      <p class="quiet">${esc(driver.vehicle)} · ${esc(driver.plate)}</p>
    </section>

    <div class="panel-openbar">
      <span>${driver.available ? 'Disponible para recibir solicitudes' : 'No disponible'}</span>
      <button class="button ${driver.available ? 'danger' : ''}" type="button" data-action="driver-availability"
        data-available="${driver.available ? 'false' : 'true'}">${driver.available ? 'Marcarme no disponible' : 'Marcarme disponible'}</button>
    </div>

    ${activeTrip ? `
      <section class="panel-section">
        <h2 class="checkout-section-title">Viaje en curso</h2>
        <article class="order-panel-card">
          <header class="order-panel-head">
            <div><strong>${esc(activeTrip.origin)} → ${esc(activeTrip.destination)}</strong></div>
            <span class="status-chip ready">${esc(tripStatusLabel(activeTrip.status))}</span>
          </header>
          <ul class="plain-list">
            <li>Pasajero: ${esc(activeTrip.passenger.name)}</li>
            <li>Teléfono: ${esc(formatArgentinePhone(activeTrip.passenger.phone))}</li>
            ${activeTrip.originNote ? `<li>Referencia: ${esc(activeTrip.originNote)}</li>` : ''}
            <li>${pluralize(activeTrip.passengers, 'pasajero', 'pasajeros')}</li>
          </ul>
          <div class="order-panel-actions">
            ${nextAction ? `<button class="button" type="button" data-action="trip-advance"
              data-trip="${esc(activeTrip.id)}" data-next="${esc(nextAction.nextStatus)}">${esc(nextAction.label)}</button>` : ''}
            ${isTaxiCancelable(activeTrip.status) ? `<button class="button danger" type="button" data-action="cancel-trip"
              data-trip="${esc(activeTrip.id)}">Cancelar</button>` : ''}
          </div>
        </article>
      </section>` : ''}

    <section class="panel-section">
      <h2 class="checkout-section-title">Solicitudes abiertas (${offers.length})</h2>
      ${!driver.available ? '<p class="quiet">Marcate disponible para recibir solicitudes.</p>' : ''}
      ${offers.length ? `<div class="stack">${offers.map(offer => `
        <article class="order-panel-card">
          <header class="order-panel-head">
            <div><strong>${esc(offer.origin)} → ${esc(offer.destination)}</strong></div>
            <span class="status-chip received">${esc(relativeMinutes(offer.expiresAt))}</span>
          </header>
          <ul class="plain-list">
            ${offer.originNote ? `<li>Referencia: ${esc(offer.originNote)}</li>` : ''}
            <li>${pluralize(offer.passengers, 'pasajero', 'pasajeros')}</li>
            <li>Solicitado por ${esc(offer.passengerInitial)}.</li>
          </ul>
          <p class="microcopy">Vas a ver el nombre y el teléfono cuando aceptes.</p>
          <div class="order-panel-actions">
            <button class="button" type="button" data-action="trip-accept" data-trip="${esc(offer.id)}"
              ${activeTrip ? 'disabled' : ''}>Aceptar viaje</button>
          </div>
        </article>`).join('')}</div>`
        : '<p class="quiet">No hay solicitudes abiertas en este momento.</p>'}
      ${activeTrip ? '<p class="microcopy">No podés tomar otra solicitud mientras tengas un viaje en curso.</p>' : ''}
    </section>

    ${myTrips.length ? `
      <section class="panel-section">
        <h2 class="checkout-section-title">Tus viajes</h2>
        <ul class="plain-list">
          ${myTrips.slice(0, 8).map(trip => `<li>${esc(shortDate(trip.createdAt))} · ${esc(trip.origin)} → ${esc(trip.destination)} · ${esc(tripStatusLabel(trip.status))}</li>`).join('')}
        </ul>
      </section>` : ''}`;
}

// ───────────────────────── institucional ─────────────────────────

async function viewInstitutional() {
  const counts = await app.repository.query('snapshotCounts');
  return `
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header">
      <span class="eyebrow">CAUCE · ALUMINÉ</span>
      <h1 class="page-title">Qué es CAUCE y qué propone</h1>
      <p class="quiet">Plataforma local de LUNA para comercio y movilidad en Aluminé.
        Este documento describe una propuesta: no hay convenio firmado ni prestadores incorporados.</p>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Qué permite hacer hoy</h2>
      <ul class="plain-list">
        <li>Que un comercio se dé de alta, cargue su catálogo y solicite la publicación.</li>
        <li>Que administración revise cada alta y la apruebe o la devuelva con observaciones.</li>
        <li>Que una persona compre con retiro en el comercio o con envío del propio comercio.</li>
        <li>Que el comercio gestione sus pedidos y asigne su reparto.</li>
        <li>Que una persona solicite un taxi y un conductor habilitado lo acepte.</li>
      </ul>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Cómo se incorpora un prestador</h2>
      <ol class="steps-list">
        <li><strong>Comercio:</strong> crea su cuenta, completa datos y modalidades de entrega, carga su catálogo y solicita la publicación. La revisión es administrativa y queda registrada.</li>
        <li><strong>Taxista:</strong> crea su cuenta, declara vehículo y patente y envía su alta. Recibe solicitudes recién cuando es aprobado y se marca disponible.</li>
      </ol>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Responsabilidades</h2>
      <ul class="plain-list">
        <li><strong>LUNA:</strong> desarrolla y opera la plataforma, revisa las altas dentro de CAUCE, y sostiene el soporte técnico del piloto.</li>
        <li><strong>Comercios:</strong> responden por sus precios, su stock, la preparación, su reparto y las habilitaciones que su actividad requiera.</li>
        <li><strong>Taxistas:</strong> responden por la habilitación del servicio, el seguro, el vehículo y la tarifa que acuerden con la persona pasajera.</li>
        <li><strong>Municipio:</strong> el acompañamiento institucional es lo que se propone evaluar. No hay adhesión ni aval otorgado.</li>
      </ul>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Propuesta de piloto de 90 días</h2>
      <ol class="steps-list">
        <li><strong>Días 1 a 30:</strong> incorporación de un grupo reducido de comercios y conductores, con acompañamiento en la carga de catálogos.</li>
        <li><strong>Días 31 a 60:</strong> operación abierta al público con seguimiento semanal de incidencias.</li>
        <li><strong>Días 61 a 90:</strong> evaluación, ajustes y decisión sobre la continuidad.</li>
      </ol>
      <h3 class="checkout-section-title">Qué se mediría</h3>
      <ul class="plain-list">
        <li>Comercios que completan el alta y llegan a publicar.</li>
        <li>Pedidos confirmados, entregados, rechazados y cancelados, por modalidad.</li>
        <li>Solicitudes de taxi, aceptadas, vencidas y sin disponibilidad.</li>
        <li>Tiempo entre la solicitud y la respuesta del prestador.</li>
        <li>Incidencias reportadas por comercios y por personas usuarias.</li>
      </ul>
      <p class="microcopy">Todas esas métricas salen de operaciones efectivamente registradas en la plataforma. No se publican proyecciones de ventas.</p>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Qué falta para un piloto real</h2>
      <ul class="plain-list">
        <li>Backend gestionado con copias de resguardo y recuperación ante fallos. Hoy el entorno compartido es un servidor local de desarrollo.</li>
        <li>Verificación de identidad de comercios y conductores, y validación de habilitaciones, seguros y cuadro tarifario del servicio de taxis.</li>
        <li>Definición de pagos. Los cobros en línea están deshabilitados en esta entrega.</li>
        <li>Carga de fotografías propias por parte de cada comercio.</li>
        <li>Notificaciones a prestadores y personas usuarias.</li>
        <li>Acuerdo escrito de roles, datos personales y soporte.</li>
      </ul>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Estado de este entorno</h2>
      <dl class="metrics-grid">
        <div class="metric"><dt>Comercios publicados</dt><dd>${counts.activeBusinesses}</dd></div>
        <div class="metric"><dt>Productos disponibles</dt><dd>${counts.products}</dd></div>
        <div class="metric"><dt>Pedidos registrados</dt><dd>${counts.orders}</dd></div>
        <div class="metric"><dt>Viajes registrados</dt><dd>${counts.trips}</dd></div>
      </dl>
      <p class="microcopy">Son los datos de ${isShared() ? 'este entorno de pruebas' : 'este navegador'}.
        Los comercios de ejemplo son ficticios y fueron preparados para la demostración: no representan negocios reales de Aluminé ni implican su adhesión.</p>
    </section>`;
}

// ───────────────────────── acciones ─────────────────────────

async function withBusy(element, operation) {
  if (!element || element.dataset.busy === 'true') return;
  element.dataset.busy = 'true';
  const wasDisabled = element.disabled;
  element.disabled = true;
  try {
    await operation();
  } catch (error) {
    if (isNetworkError(error)) {
      toast('Sin conexión con el servidor. No se envió nada: reintentá cuando vuelva.', 'error');
    } else {
      toast(error?.message || 'No se pudo completar la operación.', 'error');
    }
  } finally {
    element.dataset.busy = 'false';
    element.disabled = wasDisabled;
  }
}

async function runCommand(name, payload) {
  const result = await app.repository.command(name, payload);
  return result;
}

const ACTIONS = {
  async 'set-quantity'(element) {
    const { business, product, quantity, variant } = element.dataset;
    await runCommand('cart.setQuantity', {
      businessId: business, productId: product, quantity: Number(quantity), variantId: variant || null,
    });
    await render();
  },
  async 'clear-cart'(element) {
    await runCommand('cart.clear', { businessId: element.dataset.business });
    toast('Carrito vaciado.');
    await render();
  },
  'set-category'(element) {
    app.search.category = element.dataset.category;
    return render();
  },
  'set-activity-tab'(element) {
    app.activityTab = element.dataset.tab;
    return render();
  },
  'set-panel-tab'(element) {
    app.panelTab = element.dataset.tab;
    return render();
  },
  async 'use-identity'(element) {
    await app.repository.signInAsDemoIdentity(element.dataset.identity);
    app.session = await app.repository.session();
    toast(`Entraste como ${actor().name}.`);
    go('#actividad');
    await render({ focus: true });
  },
  async 'sign-out'() {
    await app.repository.signOut();
    app.session = await app.repository.session();
    toast('Cerraste la sesión.');
    go('#inicio');
    await render({ focus: true });
  },
  async 'submit-business'(element) {
    await runCommand('business.submit', { businessId: element.dataset.business });
    toast('Solicitud enviada. Queda pendiente de revisión administrativa.');
    await render();
  },
  async 'business-status'(element) {
    await runCommand('business.setStatus', { businessId: element.dataset.business, status: element.dataset.status });
    await render();
  },
  async 'toggle-open'(element) {
    await runCommand('business.setOpen', {
      businessId: element.dataset.business, open: element.dataset.open === 'true',
    });
    await render();
  },
  async 'product-toggle'(element) {
    const { business, product, field, value } = element.dataset;
    await runCommand('product.update', { businessId: business, productId: product, patch: { [field]: value === 'true' } });
    await render();
  },
  async 'order-transition'(element) {
    const { order, version, next } = element.dataset;
    let reason;
    if (element.dataset.reason === 'required') {
      reason = window.prompt('Indicá el motivo para que la persona sepa qué pasó:');
      if (reason === null) return;
      if (!reason.trim()) { toast('Hace falta un motivo.', 'error'); return; }
    }
    await runCommand('order.transition', {
      orderId: order, expectedVersion: Number(version), nextStatus: next, reason,
    });
    await render();
  },
  async 'cancel-order'(element) {
    const reason = window.prompt('¿Por qué cancelás el pedido? (opcional)') ?? '';
    await runCommand('order.transition', {
      orderId: element.dataset.order, expectedVersion: Number(element.dataset.version),
      nextStatus: 'canceled', reason,
    });
    toast('Pedido cancelado.');
    await render();
  },
  async 'driver-availability'(element) {
    await runCommand('driver.setAvailability', { available: element.dataset.available === 'true' });
    await render();
  },
  async 'trip-accept'(element) {
    await runCommand('trip.accept', { tripId: element.dataset.trip });
    toast('Aceptaste el viaje. Ya podés ver los datos de contacto.');
    await render();
  },
  async 'trip-advance'(element) {
    await runCommand('trip.advance', { tripId: element.dataset.trip, nextStatus: element.dataset.next });
    await render();
  },
  async 'cancel-trip'(element) {
    const reason = window.prompt('¿Por qué cancelás el viaje? (opcional)') ?? '';
    await runCommand('trip.cancel', { tripId: element.dataset.trip, reason });
    toast('Viaje cancelado.');
    await render();
  },
  async 'reset-demo'() {
    if (!window.confirm('Esto borra pedidos, viajes y altas guardados en este navegador. ¿Seguimos?')) return;
    await app.repository.reset();
    app.session = await app.repository.session();
    toast('Datos de demostración reiniciados.');
    go('#inicio');
    await render({ focus: true });
  },
  async retry() { await render(); },
  'use-location'(element) {
    const input = document.querySelector('#taxi-origin');
    if (!navigator.geolocation) { toast('Este navegador no ofrece ubicación.', 'error'); return; }
    element.disabled = true;
    element.textContent = 'Buscando ubicación…';
    navigator.geolocation.getCurrentPosition(position => {
      const { latitude, longitude } = position.coords;
      input.value = `Ubicación aproximada ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      element.disabled = false;
      element.textContent = 'Usar mi ubicación (opcional)';
      toast('Se completó el origen con tus coordenadas. Podés corregirlo a mano.');
    }, () => {
      element.disabled = false;
      element.textContent = 'Usar mi ubicación (opcional)';
      toast('No se pudo obtener la ubicación. Escribí la dirección a mano.', 'error');
    }, { enableHighAccuracy: false, timeout: 8000 });
  },
};

const FORMS = {
  search(form) {
    const data = new FormData(form);
    app.search.query = String(data.get('query') || '');
    app.search.onlyOpen = data.get('onlyOpen') === 'on';
    return render();
  },

  async 'sign-in'(form) {
    const data = Object.fromEntries(new FormData(form));
    await app.repository.signIn({ email: data.email, password: data.password });
    app.session = await app.repository.session();
    toast(`Hola, ${actor().name}.`);
    go('#actividad');
    await render({ focus: true });
  },

  async register(form) {
    const data = Object.fromEntries(new FormData(form));
    await app.repository.register(data);
    app.session = await app.repository.session();
    toast('Cuenta creada.');
    go('#actividad');
    await render({ focus: true });
  },

  async 'business-create'(form) {
    const data = Object.fromEntries(new FormData(form));
    const business = await runCommand('business.create', { name: data.name, category: data.category });
    app.session = await app.repository.session();
    app.panelTab = 'datos';
    toast('Comercio creado como borrador.');
    go(`#panel/${business.id}`);
    await render({ focus: true });
  },

  async 'business-update'(form) {
    const data = new FormData(form);
    const patch = {
      name: data.get('name'), category: data.get('category'), ownerName: data.get('ownerName'),
      contactPhone: data.get('contactPhone'), address: data.get('address'), reference: data.get('reference'),
      hoursLabel: data.get('hoursLabel'), deliveryZone: data.get('deliveryZone'),
      pickupEnabled: data.get('pickupEnabled') === 'on',
      deliveryEnabled: data.get('deliveryEnabled') === 'on',
      deliveryFee: Number(data.get('deliveryFee') || 0),
      minimumOrder: Number(data.get('minimumOrder') || 0),
    };
    await runCommand('business.update', { businessId: form.dataset.business, patch });
    toast('Datos guardados.');
    await render();
  },

  async 'product-create'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('product.create', {
      businessId: form.dataset.business,
      product: {
        name: data.name, description: data.description, category: data.category,
        price: Number(data.price), stock: Number(data.stock), available: true,
        variants: parseVariants(data.variants),
      },
    });
    form.reset();
    toast('Producto agregado al catálogo.');
    await render();
  },

  async 'product-update'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('product.update', {
      businessId: form.dataset.business, productId: form.dataset.product,
      patch: { price: Number(data.price), stock: Number(data.stock) },
    });
    toast('Producto actualizado.');
    await render();
  },

  async 'rider-create'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('rider.create', { businessId: form.dataset.business, name: data.name, phone: data.phone });
    form.reset();
    toast('Persona de reparto agregada.');
    await render();
  },

  async 'assign-rider'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('order.transition', {
      orderId: form.dataset.order, expectedVersion: Number(form.dataset.version),
      nextStatus: 'assigned', riderId: data.riderId,
    });
    toast('Reparto asignado.');
    await render();
  },

  async review(form, submitter) {
    const data = Object.fromEntries(new FormData(form));
    const decision = submitter?.value || 'approve';
    const command = form.dataset.kind === 'business' ? 'admin.reviewBusiness' : 'admin.reviewDriver';
    const payload = form.dataset.kind === 'business'
      ? { businessId: form.dataset.id, decision, note: data.note }
      : { driverId: form.dataset.id, decision, note: data.note };
    await runCommand(command, payload);
    toast(decision === 'approve' ? 'Alta aprobada.' : 'Alta devuelta con observaciones.');
    await render();
  },

  async checkout(form) {
    const businessId = form.dataset.business;
    const data = Object.fromEntries(new FormData(form));
    draft(`checkout:${businessId}`, {
      ...data, zoneAcknowledged: new FormData(form).get('zoneAcknowledged') === 'on',
    });
    if (isShared() && !app.online) {
      toast('Sin conexión: no se confirmó nada. Reintentá cuando vuelva.', 'error');
      return;
    }
    // El identificador de intento se pide una sola vez por carrito: si la
    // confirmación se repite, el servidor devuelve el mismo pedido.
    const requestId = await runCommand('cart.prepareRequest', { businessId });
    const order = await runCommand('order.create', {
      businessId,
      requestId,
      fulfillment: data.fulfillment,
      paymentMethod: data.paymentMethod || 'cash_demo',
      customer: {
        name: data.name, phone: data.phone, address: data.address, notes: data.notes,
        zoneAcknowledged: new FormData(form).get('zoneAcknowledged') === 'on',
      },
    });
    app.formDrafts.delete(`checkout:${businessId}`);
    toast(`Pedido ${order.code} enviado al comercio.`);
    go(`#pedido/${order.id}`);
    await render({ focus: true });
  },

  async 'taxi-request'(form) {
    const data = Object.fromEntries(new FormData(form));
    draft('taxi', data);
    if (isShared() && !app.online) {
      toast('Sin conexión: la solicitud no se envió. Reintentá cuando vuelva.', 'error');
      return;
    }
    const trip = await runCommand('trip.request', { ...data, passengers: Number(data.passengers || 1) });
    app.formDrafts.delete('taxi');
    toast(trip.status === 'no_availability'
      ? 'No hay conductores disponibles ahora mismo.'
      : 'Solicitud enviada. Esperando respuesta.');
    go(`#viaje/${trip.id}`);
    await render({ focus: true });
  },

  async 'driver-apply'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('driver.apply', data);
    app.session = await app.repository.session();
    toast('Alta enviada. Queda pendiente de revisión administrativa.');
    await render();
  },
};

// ───────────────────────── render ─────────────────────────

const VIEWS = {
  inicio: viewHome,
  comercios: viewBusinesses,
  comercio: viewBusiness,
  carrito: viewCarts,
  pedido: viewOrder,
  actividad: viewActivity,
  cuenta: viewAccount,
  'alta-comercio': viewBusinessSignup,
  panel: viewMerchantPanel,
  admin: viewAdmin,
  taxi: viewTaxi,
  viaje: viewTrip,
  taxista: viewDriver,
  institucional: viewInstitutional,
};

let renderToken = 0;

// Rutas cuyo contenido depende de los permisos de la cuenta. En el entorno con
// backend los roles viven en el servidor y pueden cambiar mientras la pestaña
// sigue abierta (por ejemplo, cuando administración aprueba un alta), así que la
// sesión se revalida antes de decidir qué se muestra.
const GATED_ROUTES = new Set(['panel', 'admin', 'taxista', 'cuenta', 'alta-comercio']);

async function render({ focus = false } = {}) {
  if (!app.repository) return;
  const token = ++renderToken;
  const { page, param } = route();
  if (GATED_ROUTES.has(page) && isShared()) {
    try { app.session = await app.repository.session(); }
    catch { /* si el servidor no responde, la vista lo informa igual */ }
    if (token !== renderToken) return;
  }
  const view = VIEWS[page];
  main.setAttribute('aria-busy', 'true');
  try {
    const markup = view
      ? await view(param)
      : emptyState('Página no encontrada', 'Volvé al inicio para seguir navegando.', '#inicio', 'Ir al inicio');
    if (token !== renderToken) return;
    main.innerHTML = markup;
  } catch (error) {
    if (token !== renderToken) return;
    main.innerHTML = errorView(error);
  }

  // El contador del carrito alimenta la barra inferior en cualquier vista.
  try {
    const carts = await app.repository.query('carts');
    app.cartCount = carts.reduce((total, entry) =>
      total + entry.cart.lines.reduce((sum, line) => sum + line.quantity, 0), 0);
  } catch { app.cartCount = app.cartCount || 0; }
  if (token !== renderToken) return;

  updateShell();
  applyOfflineState();
  // Recién acá la vista está completa: el contenido, el contador del carrito y
  // la barra inferior coinciden. `aria-busy="false"` es esa señal.
  main.setAttribute('aria-busy', 'false');
  if (focus) {
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

// ───────────────────────── arranque ─────────────────────────

function bindEvents() {
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const handler = ACTIONS[target.dataset.action];
    if (!handler) return;
    if (target.tagName === 'A' && !target.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault();
    withBusy(target, () => handler(target));
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    const handler = FORMS[form.dataset.form];
    if (!handler) return;
    event.preventDefault();
    const submitter = event.submitter;
    const button = submitter || form.querySelector('button[type="submit"]');
    withBusy(button || form, () => handler(form, submitter));
  });

  // La búsqueda se aplica al escribir, sin recargar la vista entera en cada tecla.
  let searchTimer;
  document.addEventListener('input', event => {
    if (event.target.closest('form')?.dataset.form !== 'search') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => FORMS.search(event.target.closest('form')), 220);
  });

  document.addEventListener('change', event => {
    const form = event.target.closest('form');
    if (form?.dataset.form !== 'checkout') return;
    // Marcar la opción elegida sin volver a dibujar: no se pierde el foco.
    for (const choice of form.querySelectorAll('.choice')) {
      choice.classList.toggle('active', choice.querySelector('input')?.checked === true);
    }
    // Cambiar de modalidad sí cambia el formulario (dirección, zona) y el total,
    // así que se guarda lo escrito y se vuelve a dibujar la vista.
    if (event.target.name === 'fulfillment') {
      const data = Object.fromEntries(new FormData(form));
      draft(`checkout:${form.dataset.business}`, {
        ...data,
        zoneAcknowledged: new FormData(form).get('zoneAcknowledged') === 'on',
      });
      render();
    }
  });

  window.addEventListener('hashchange', () => render({ focus: true }));

  window.addEventListener('offline', () => {
    app.online = false;
    updateShell();
    // No se vuelve a dibujar: sin conexión las consultas fallarían y la vista se
    // reemplazaría por un error, borrando lo que la persona venía completando.
    // Se avisa y se bloquea la confirmación, dejando el formulario intacto.
    applyOfflineState();
    toast('Te quedaste sin conexión. No se envió ninguna operación.', 'error');
  });

  window.addEventListener('online', () => {
    app.online = true;
    updateShell();
    toast('Conexión recuperada. Podés reintentar.');
    render();
  });
}

async function start() {
  try {
    app.repository = createRepository(CONFIG, {
      runtime: RUNTIME_ENV,
      storage: globalThis.localStorage,
    });
    app.session = await app.repository.session();
  } catch (error) {
    main.innerHTML = `<section class="notice error">
      <h2>CAUCE no pudo iniciar</h2>
      <p>${esc(error.message)}</p>
      <p class="microcopy">Entorno declarado: ${esc(RUNTIME_ENV.environment)}.</p>
    </section>`;
    return;
  }
  bindEvents();
  if (!location.hash) location.hash = '#inicio';
  await render();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  navigator.serviceWorker.register('service-worker.js').catch(() => {
    // La app funciona igual sin instalación offline; no se avisa al usuario.
  });
}

start();
