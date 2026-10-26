// MiFav · Neuquén Capital — shell de la aplicación.
//
// Enrutador por hash (funciona igual servido desde GitHub Pages o desde el
// backend local), vistas que piden sus datos al repositorio del entorno y un
// único manejador de acciones delegado. Toda la lógica de negocio vive en
// js/domain y js/core: acá sólo se arma la interfaz.
import { CONFIG } from './config.js';
import { RUNTIME_ENV } from './runtime-env.js';
import { createRepository } from './repositories/repository-factory.js';
import { isNetworkError } from './core/network.js';
import { CauceError } from './core/errors.js';
import { REQUIRED_SCHEMA } from './core/contract.js';
import { capabilityLabel } from './core/rubros.js';
import { createTelemetry, classify } from './core/telemetry.js';
import { MAX_RANGES_PER_DAY } from './core/business-hours.js';
import { ROLE_LABELS } from './core/accounts.js';
import { askReason as askReasonDialog, askConfirm as askConfirmDialog } from './ui/dialog.js';
import {
  announceNewOrders, clearOrderAlert, unlockSound, soundReady, soundMuted, setSoundMuted, setBaseTitle,
} from './ui/order-alert.js';
import {
  contactButtons, timesLine, hoursSummary, hoursEditor, readHoursForm, allDaysClosed, teamTab, ROLE_NAMES, ROLE_HINTS,
} from './ui/merchant-tools.js';
import {
  panelSections, resolveSection, canManageBusiness, groupOrders, freshOrderIds, panelSummary, openState,
  isUnavailableProduct, deliveryBoardData, topProducts, recentSales, ORDER_FILTERS,
} from './core/business-panel.js';
import {
  panelNav, openBar, syncBar, newOrdersBanner, ordersBoard, dashboard, deliveryBoard,
} from './ui/business-panel.js';
import { riderHome, riderUnlinked } from './ui/rider.js';
import {
  productThumb, merchantAvatar, availabilityText as storeAvailability, storeHeader, productCard,
  catalogJump, cartBar, cartSubtotal, cartLines, fulfillmentSwitch, totalsList, addButton, quantityControl,
} from './ui/storefront.js';
import { orderStatusHero, deliveryCodeCard, orderTimeline, cancellationNotice, orderDetails } from './ui/order-status.js';
import {
  DEMO_PAYMENT_METHODS, paymentMethodSelector, paymentBadge, paymentReturnView, paymentsSection, orderPaymentNotice,
} from './ui/payments.js';
import {
  checkoutPaymentMethods, cashOnlyMethods, RETURN_OUTCOMES, isWaitingPayment, paymentReturnReference, connectionResult,
} from './core/payment.js';
import { pilotToday, pilotIncidents, businessTodayLine } from './ui/admin-metrics.js';
import { deliveryCodeFeedback } from './core/rider-app.js';
import { renderIcon } from './ui/icons.js';
import { renderCharacter } from './ui/brand-characters.js';
import {
  esc, money, shortDate, timeOnly, relativeMinutes, orderStatusLabel, orderStatusTone,
  fulfillmentLabel, businessStatusLabel, tripStatusLabel, pluralize, initialsOf,
} from './ui/format.js';
import { BUSINESS_STATUS_HINTS, missingPublicationRequirements } from './core/merchant-status.js';
import { PRODUCT_CATEGORIES_SUGGESTED, validateProductInput, validateImageData } from './core/catalog-rules.js';
import {
  MARKETPLACE_CATEGORIES, MARKETPLACE_CATEGORY_NAMES, PRODUCT_CONDITIONS, conditionLabel,
  categoryForBusiness, localityFor, localityLabel, normalizeProductCondition, productCondition,
} from './core/marketplace.js';
import { readFavorites, toggleFavorite, favoriteKey } from './core/favorites.js';
import {
  marketplaceProductCard, marketplaceBusinessCard, categoryTiles, favoriteButton, emptyFavorites, feriaBanner,
} from './ui/marketplace.js';
import { optimizeImage } from './repositories/image-prep.js';
import { DISPATCH_POLICY, DRIVER_STATUS_LABELS } from './core/taxi-dispatch.js';
import { isTaxiActive, isTaxiCancelable, getDriverNextAction } from './core/taxi-workflow.js';
import { allowedActions } from './core/workflow-policy.js';
import { isCommerciallyPurchasable } from './core/commercial.js';
import { formatArgentinePhone } from './core/validators.js';

const main = /** @type {HTMLElement} */ (document.querySelector('#main'));

// `aria-busy="false"` en #main dice que la vista está estable (lo usan las
// tecnologías de asistencia y las pruebas): ningún dibujo en curso, ninguna
// navegación pedida y ninguna acción esperando al servidor. Mientras un
// diálogo espera a la persona, la acción que lo abrió no cuenta.
const busy = { actions: 0, asking: 0, navigating: false, redirecting: false, rendering: false };
function settle() {
  const working = busy.actions - busy.asking > 0 || busy.navigating || busy.redirecting || busy.rendering;
  main.setAttribute('aria-busy', working ? 'true' : 'false');
}
/** @template T @param {Promise<T>} question @returns {Promise<T>} */
async function whileAsking(question) {
  busy.asking += 1;
  settle();
  try { return await question; } finally { busy.asking -= 1; settle(); }
}
/** @param {Parameters<typeof askReasonDialog>[0]} options */
const askReason = options => whileAsking(askReasonDialog(options));
/** @param {Parameters<typeof askConfirmDialog>[0]} options */
const askConfirm = options => whileAsking(askConfirmDialog(options));

// La vidriera crece por tandas: no abruma en el teléfono ni obliga a dibujar
// decenas de tarjetas antes de que la persona elija un rubro.
const PRODUCT_PAGE_SIZE = 24;

const app = {
  repository: null,
  session: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  search: {
    query: '', category: 'Todos', onlyOpen: false, mode: '', condition: '',
    locality: '', sort: 'relevance', shown: PRODUCT_PAGE_SIZE,
  },
  // Borrador de publicación: se confirma en un segundo paso, después de la
  // revisión. Vive sólo en memoria para no guardar archivos ni datos a medias.
  publishReview: null,
  accountTab: 'ingresar',
  activityTab: 'pedidos',
  // Panel del comercio: filtro de pedidos por estado (la sección va en la URL)
  // y los desplegables abiertos, que un redibujo no tiene que cerrar.
  orderFilter: 'activos',
  openDetails: new Set(),
  // Quién reparte, elegido en una tarjeta y todavía sin confirmar: sobrevive
  // a los refrescos de fondo para que "Asignar reparto" asigne a esa persona.
  riderChoice: new Map(),
  formDrafts: new Map(),
  toastTimer: null,
  // Entorno conectado: verticales habilitadas y contrato con la base.
  features: null,
  telemetry: null,
  // Panel del comercio: pedidos ya vistos (para avisar los nuevos) y última
  // actualización confirmada.
  seenOrders: new Map(),
  panelSyncedAt: null,
  liveHealthy: true,
  // Último toque o clic: los refrescos en segundo plano esperan a que termine.
  pointerAt: 0,
};

const isShared = () => Boolean(app.repository?.capabilities?.sharedPersistence);
// El entorno conectado es el que habla con MiFav real: sus errores se muestran.
const isConnected = () => app.repository?.environment === 'supabase';
const actor = () => app.session?.actor || null;
const isSignedIn = () => actor()?.kind === 'account';
const hasRole = role => Boolean(actor()?.roles?.includes(role));
// Favoritos locales. La lista se cachea para no leer el almacenamiento en cada
// tarjeta; cualquier cambio de la interfaz actualiza la caché.
const favoriteStorage = (() => {
  try { return globalThis.localStorage || null; } catch { return null; }
})();
let favoriteCache = null;
const favoriteIds = () => {
  if (favoriteCache === null) favoriteCache = readFavorites(favoriteStorage);
  return favoriteCache;
};
const isProductFavorite = (businessId, productId) => {
  try { return favoriteIds().includes(favoriteKey(businessId, productId)); } catch { return false; }
};
const favoriteCount = () => favoriteIds().length;
// Verticales: en la demostración todo sigue encendido; en el entorno conectado
// decide la base (app_status), para habilitar o apagar sin tocar código.
const feature = name => !isConnected() || app.features?.[name] === true;
// Pagos online: sólo con la base conectada y su interruptor encendido. La
// demostración nunca ofrece un pago online.
const paymentsOnline = () => isConnected() && app.features?.payments_online === true;

// Lo que ve la persona: el mensaje de MiFav, nunca el texto técnico de una
// excepción. El detalle queda en el registro de errores.
function userMessage(error) {
  if (error instanceof CauceError || error?.name === 'CauceError') return error.message;
  app.telemetry?.error(error, { where: 'ui' });
  return 'Ocurrió un problema inesperado. Reintentá en unos segundos; si sigue pasando, avisanos.';
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
  rider: 'entregas',
  explorar: 'comercios',
  busqueda: 'comercios',
  product: 'producto',
  publish: 'publicar',
  favorites: 'favoritos',
  feria: 'ferias',
});

// La ruta es lo que está antes de `?` en el hash; lo de después son
// parámetros (la vuelta del proveedor de pagos o de la conexión de la cuenta).
function route() {
  const path = location.hash.slice(1).split('?')[0];
  const parts = path.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } });
  const page = ROUTE_ALIASES[parts[0]] || parts[0] || 'inicio';
  return { page, param: parts[1] || null, extra: parts[2] || null };
}


// El dibujo empieza con el evento hashchange, que llega después: la vista ya
// está ocupada desde ahora.
const go = hash => {
  if (location.hash !== hash) { busy.navigating = true; settle(); }
  location.hash = hash;
};

// ───────────────────────── utilidades de interfaz ─────────────────────────

function toast(message, tone = 'info') {
  const element = /** @type {HTMLElement|null} */ (document.querySelector('#toast'));
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
const confirmNotice = ({ online = false } = {}) => `
  <p class="confirm-notice">${renderIcon('shield-check', 15)}
    <span>${app.repository?.capabilities?.orders
      ? online
        ? 'El comercio recibe este pedido y lo prepara. En efectivo le pagás al comercio; el pago online va a la cuenta del comercio. MiFav no cobra nada.'
        : 'El comercio recibe este pedido y lo prepara. El pago se coordina con el comercio: MiFav no cobra nada.'
      : `Esta confirmación no genera un servicio ni un cobro real. Queda registrada sólo en ${
        isShared() ? 'el entorno de pruebas' : 'este navegador'}.`}</span>
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
    notice.textContent = isConnected() ? 'Sin conexión. Conservamos lo escrito. Al recuperar la conexión podés reintentar guardar.' : isShared()
      ? 'Sin conexión. No se puede confirmar hasta recuperarla. No quedó ninguna operación enviada a medias.'
      : 'Sin conexión. Podés seguir navegando: esta demostración guarda todo en tu propio navegador.';
    main.prepend(notice);
  }
  // En la demostración no hay servidor: quedarse sin conexión no impide nada.
  if (!isShared()) return;
  // Sólo se revierte lo que deshabilitó la falta de conexión: un botón que la
  // vista deshabilitó por otro motivo (carrito con productos no disponibles,
  // comercio cerrado, datos en revisión) sigue deshabilitado.
  for (const form of main.querySelectorAll(isConnected() ? 'form' : OPERATION_FORMS)) {
    for (const submit of /** @type {NodeListOf<HTMLButtonElement>} */ (form.querySelectorAll('button[type="submit"]'))) {
      if (!app.online && !submit.disabled) {
        submit.disabled = true;
        submit.dataset.offlineDisabled = 'true';
      } else if (app.online && submit.dataset.offlineDisabled === 'true') {
        submit.disabled = false;
        delete submit.dataset.offlineDisabled;
      }
    }
  }
}

function errorView(error) {
  const offline = isNetworkError(error);
  const slow = error?.code === 'NETWORK_TIMEOUT';
  const retry = offline || slow || isConnected()
    ? '<button class="button secondary" type="button" data-action="retry">Reintentar</button>'
    : '';
  return `<section class="notice error" role="alert">
    <h2>${offline ? 'Sin conexión con MiFav' : slow ? 'La conexión está lenta' : 'No pudimos abrir esta vista'}</h2>
    <p>${esc(userMessage(error))}</p>
    <div class="modal-actions">${retry}<a class="button secondary" href="#inicio">Volver al inicio</a></div>
  </section>`;
}

// ───────────────────────── shell ─────────────────────────

function updateShell() {
  const { page } = route();
  const signedIn = isSignedIn();
  const envChip = /** @type {HTMLElement|null} */ (document.querySelector('#env-chip'));
  if (envChip) {
    // En la cabecera va la forma corta, para que entre a 360 px sin recortarse;
    // el pie lleva la frase completa y el detalle está en el título accesible.
    // En producción no hay nada que aclarar: el indicador no se muestra.
    envChip.hidden = isConnected();
    envChip.textContent = RUNTIME_ENV.environment === 'demo' ? 'Demostración' : isConnected() ? '' : 'Pruebas';
    envChip.title = `${RUNTIME_ENV.label}. ${RUNTIME_ENV.description}`;
    envChip.dataset.environment = RUNTIME_ENV.environment;
  }

  const footerEnv = document.querySelector('#footer-env');
  if (footerEnv && !isConnected()) {
    footerEnv.textContent = `${RUNTIME_ENV.label} · ${RUNTIME_ENV.description}`;
  }
  for (const element of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('a[href="#taxi"], a[href="#taxista"]'))) {
    element.hidden = !feature('taxi');
  }

  const accountLink = document.querySelector('#account-link');
  if (accountLink) {
    accountLink.textContent = signedIn ? initialsOf(actor().name) : 'Ingresar';
    accountLink.setAttribute('aria-label', signedIn ? `Cuenta de ${actor().name}` : 'Ingresar a MiFav');
    accountLink.classList.toggle('is-signed', signedIn);
  }

  const cartCount = app.cartCount || 0;
  const cartItem = /** @type {HTMLElement|null} */ (document.querySelector('#header-cart'));
  if (cartItem) {
    cartItem.hidden = false;
    const badge = /** @type {HTMLElement|null} */ (cartItem.querySelector('.cart-badge'));
    if (badge) { badge.textContent = String(cartCount); badge.hidden = cartCount === 0; }
    cartItem.setAttribute('aria-label', cartCount ? `Ver carrito, ${cartCount} productos` : 'Ver carrito');
  }
  for (const badge of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.js-cart-badge'))) {
    badge.textContent = String(cartCount);
    badge.hidden = cartCount === 0;
  }
  const favoriteItem = /** @type {HTMLElement|null} */ (document.querySelector('#bnav-favoritos'));
  if (favoriteItem) {
    const count = favoriteCount();
    const badge = /** @type {HTMLElement|null} */ (favoriteItem.querySelector('.bnav-badge'));
    if (badge) { badge.textContent = String(count); badge.hidden = count === 0; }
    favoriteItem.setAttribute('aria-label', count ? `Favoritos, ${count} guardados` : 'Favoritos');
  }

  const active = {
    inicio: 'bnav-inicio', comercios: 'bnav-comercios', comercio: 'bnav-comercios',
    producto: 'bnav-comercios', favoritos: 'bnav-favoritos', publicar: 'bnav-publicar',
    cuenta: 'bnav-cuenta', actividad: 'bnav-cuenta',
    taxi: 'bnav-taxi', viaje: 'bnav-taxi', carrito: 'bnav-carrito',
  }[page];
  for (const item of document.querySelectorAll('.bottom-nav-item')) {
    item.classList.toggle('active', item.id === active);
    if (item.id === active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }

  document.body.classList.toggle('is-offline', !app.online);
  // Cada área tiene su propia navegación: la barra inferior y el pie de quien
  // compra no tapan el panel, el reparto ni la administración.
  document.body.dataset.area = AREAS[page] || 'cliente';
}

const AREAS = Object.freeze({ panel: 'comercio', entregas: 'reparto', admin: 'admin', taxista: 'reparto' });

// ───────────────────────── vistas públicas ─────────────────────────

const availabilityText = business => storeAvailability(business, { connected: isConnected() });

// La localidad visible es Neuquén Capital, pero los datos históricos conservan
// el id `alumine`. Se compara siempre por la localidad normalizada para que el
// filtro siga funcionando sin migrar pedidos ni sesiones.
const sameLocality = (a, b) => localityFor(a).id === localityFor(b).id;

function filterBusinesses(businesses, catalogs = {}) {
  const query = app.search.query.trim().toLowerCase();
  return businesses.filter(business => {
    if (app.search.onlyOpen && !business.open) return false;
    if (app.search.mode === 'delivery' && !business.deliveryEnabled) return false;
    if (app.search.mode === 'pickup' && !business.pickupEnabled) return false;
    if (app.search.locality && !sameLocality(business.localityId, app.search.locality)) return false;
    if (app.search.category !== 'Todos'
      && categoryForBusiness(business) !== app.search.category
      && business.category !== app.search.category) return false;
    if (!query) return true;
    return [business.name, business.category, business.subtitle, business.description, catalogs[business.id]]
      .filter(Boolean).some(field => field.toLowerCase().includes(query));
  });
}

// Productos publicados de una lista de comercios. La lectura es por comercio
// para respetar el aislamiento de cada tienda; en la demostración son pocos y
// en el piloto se reemplaza por una búsqueda del servidor cuando haga falta.
async function loadProductsFor(businesses) {
  const rows = await Promise.all(businesses.map(async business => {
    try {
      const products = await app.repository.query('products', { businessId: business.id });
      return products.filter(product => !product.archived);
    } catch {
      return [];
    }
  }));
  return rows.flatMap((products, index) => products.map(product => ({ product, business: businesses[index] })));
}

function productMatchesSearch(product, business, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [product.name, product.description, product.category, business?.name, business?.category,
    categoryForBusiness(business), productCondition(product) === 'used' ? 'usado'
      : productCondition(product) === 'new' ? 'nuevo' : '']
    .filter(Boolean).some(field => String(field).toLowerCase().includes(needle));
}

function visibleMarketplaceProducts(entries) {
  const query = app.search.query.trim();
  return entries.filter(({ product, business }) => {
    if (app.search.onlyOpen && !business.open) return false;
    if (app.search.mode === 'delivery' && !business.deliveryEnabled) return false;
    if (app.search.mode === 'pickup' && !business.pickupEnabled) return false;
    if (app.search.locality && !sameLocality(business.localityId, app.search.locality)) return false;
    if (app.search.category !== 'Todos'
      && product.category !== app.search.category
      && categoryForBusiness(business) !== app.search.category) return false;
    if (app.search.condition && productCondition(product) !== app.search.condition) return false;
    return productMatchesSearch(product, business, query);
  });
}

// Filtros rápidos: se combinan con la búsqueda y el rubro.
const QUICK_FILTERS = Object.freeze([
  Object.freeze({ key: 'open', label: 'Abiertos ahora' }),
  Object.freeze({ key: 'delivery', label: 'Con envío' }),
  Object.freeze({ key: 'pickup', label: 'Retiro en el local' }),
]);
const quickFilterActive = key => (key === 'open' ? app.search.onlyOpen : app.search.mode === key);
const quickFilters = () => QUICK_FILTERS.map(filter => `<button class="chip ${quickFilterActive(filter.key) ? 'is-active' : ''}"
  type="button" data-action="quick-filter" data-filter="${filter.key}" aria-pressed="${quickFilterActive(filter.key)}">${esc(filter.label)}</button>`).join('');
const filtersActive = () => Boolean(app.search.query.trim() || app.search.onlyOpen || app.search.mode
  || app.search.category !== 'Todos' || app.search.condition || app.search.locality);

const marketplaceNotice = () => `<p class="mifav-demo-note">
  <span aria-hidden="true">●</span> Demostración: los comercios, productos y precios son ficticios y no representan
  negocios reales de Neuquén capital. No hay pagos reales.
</p>`;

// Condición del artículo. "Todos" es el estado inicial, no un valor de datos.
const conditionChips = () => [['', 'Todos'], ['new', 'Nuevos'], ['used', 'Usados']].map(([value, label]) =>
  `<button class="chip ${app.search.condition === value ? 'is-active' : ''}" type="button"
    data-action="set-condition" data-condition="${value}" aria-pressed="${app.search.condition === value}">${label}</button>`).join('');

const SORT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'relevance', label: 'Destacados' }),
  Object.freeze({ value: 'price-asc', label: 'Menor precio' }),
  Object.freeze({ value: 'price-desc', label: 'Mayor precio' }),
]);
const sortChips = () => SORT_OPTIONS.map(option => `<button class="chip chip-quiet ${app.search.sort === option.value ? 'is-active' : ''}"
  type="button" data-action="sort-products" data-sort="${option.value}"
  aria-pressed="${app.search.sort === option.value}">${option.label}</button>`).join('');

// Orden de la vidriera. Los destacados son una selección editorial del catálogo
// (tener una insignia o estar abierto), no una métrica de ventas inventada.
function sortProductEntries(entries) {
  const rows = [...entries];
  if (app.search.sort === 'price-asc') return rows.sort((a, b) => a.product.price - b.product.price
    || a.product.name.localeCompare(b.product.name));
  if (app.search.sort === 'price-desc') return rows.sort((a, b) => b.product.price - a.product.price
    || a.product.name.localeCompare(b.product.name));
  return rows.sort((a, b) => Number(Boolean(b.product.badge)) - Number(Boolean(a.product.badge))
    || Number(Boolean(b.business.open)) - Number(Boolean(a.business.open))
    || a.product.name.localeCompare(b.product.name));
}

// La portada muestra variedad de rubros, no ocho platos del mismo comercio.
// Se toma el primer artículo de cada categoría y después se completa.
function featuredProductEntries(entries, limit = 8) {
  const picked = [];
  const seen = new Set();
  for (const entry of entries) {
    const category = categoryForBusiness(entry.business) || entry.product.category;
    if (seen.has(category)) continue;
    seen.add(category);
    picked.push(entry);
    if (picked.length >= limit) break;
  }
  if (picked.length < limit) {
    for (const entry of entries) {
      if (picked.includes(entry)) continue;
      picked.push(entry);
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

const marketplaceCategoryNames = businesses => {
  const fromData = businesses.map(categoryForBusiness).filter(Boolean);
  const preferred = MARKETPLACE_CATEGORY_NAMES.filter(name => name !== 'Otros');
  const known = preferred.filter(name => fromData.includes(name));
  const extra = [...new Set(fromData.filter(name => !preferred.includes(name)))];
  return ['Todos', ...known, ...extra, ...(fromData.includes('Otros') ? ['Otros'] : [])];
};

// Convierte una foto elegida por la persona en un data URL ya optimizado. Si el
// navegador no puede comprimirla, se usa el original bajo el mismo tope.
async function publishImageData(file) {
  if (!file || !file.size) return { data: '', file: null };
  requireImageFile(file);
  const optimized = await optimizeImage(file, { maxSide: 1024, quality: 0.82 });
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('No pudimos leer la imagen.'));
    reader.readAsDataURL(optimized);
  });
  return { data, file: optimized };
}

function requireImageFile(file) {
  // Mismo límite de tipos que la carga conectada. El tamaño final se valida
  // sobre el data URL, después de comprimir.
  const types = ['image/jpeg', 'image/png', 'image/webp'];
  if (!types.includes(file.type)) {
    throw new CauceError('INVALID_IMAGE_TYPE', 'Se admiten imágenes JPEG, PNG o WebP.');
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new CauceError('IMAGE_TOO_LARGE', 'La imagen no puede superar 12 MB.');
  }
}

async function viewHome() {
  const taxi = feature('taxi');
  const [businesses, orders, trips] = await Promise.all([
    app.repository.query('publicBusinesses'),
    app.repository.query('myOrders'),
    taxi ? app.repository.query('myTrips') : [],
  ]);
  const productEntries = await loadProductsFor(businesses);
  const marketplaceEntries = sortProductEntries(visibleMarketplaceProducts(productEntries));
  const featuredProducts = featuredProductEntries(marketplaceEntries, 8);
  const openBusinesses = businesses.filter(business => business.open);
  const featuredBusinesses = [...openBusinesses, ...businesses.filter(business => !business.open)].slice(0, 6);
  const productsByBusiness = new Map();
  for (const entry of productEntries) {
    if (!productsByBusiness.has(entry.business.id)) productsByBusiness.set(entry.business.id, []);
    productsByBusiness.get(entry.business.id).push(entry.product);
  }

  const activeOrders = orders.filter(order => !['delivered', 'canceled'].includes(order.status));
  const activeTrip = trips.find(trip => isTaxiActive(trip.status));
  const operation = (activeOrders.length || activeTrip) ? `
    <section class="home-block">
      ${sectionHeading('EN CURSO', activeOrders.length > 1 ? 'Tus pedidos en curso' : 'Tu pedido en curso')}
      <div class="stack">
        ${activeOrders.slice(0, 3).map(order => `
          <a class="op-card" href="#pedido/${esc(order.id)}">
            <span class="op-card-icon">${renderIcon('receipt', 18)}</span>
            <span class="op-card-body">
              <strong>${esc(businesses.find(b => b.id === order.businessId)?.name || 'Comercio')}</strong>
              <span class="quiet">${esc(order.code)} · ${esc(fulfillmentLabel(order.fulfillment))} · ${money(order.total)}</span>
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

  const productBlock = featuredProducts.length
    ? `<div class="mifav-product-grid">${featuredProducts.map(({ product, business }) =>
      marketplaceProductCard({ product, business, favorite: isProductFavorite(business.id, product.id) })).join('')}</div>`
    : emptyState('Todavía no hay productos publicados',
      'Estamos armando la primera vidriera de Neuquén capital. Si tenés un emprendimiento, podés sumarte.',
      '#publicar', 'Publicar un producto', 'merchant');

  const storesBlock = featuredBusinesses.length
    ? `<div class="mifav-store-grid">${featuredBusinesses.map(business =>
      marketplaceBusinessCard({ business, products: productsByBusiness.get(business.id) || [] })).join('')}</div>`
    : `<p class="quiet">Todavía no hay tiendas publicadas en este entorno.</p>`;

  const sellerBlock = `
    <section class="mifav-seller-cta" aria-labelledby="seller-cta-title">
      <div class="mifav-seller-copy">
        <p class="eyebrow">VENDER EN MIFAV</p>
        <h2 id="seller-cta-title">Tu emprendimiento, en la vidriera de la ciudad</h2>
        <p>Publicá productos nuevos o usados, elegí retiro o envío coordinado con el vendedor y gestioná tus ventas desde el panel. Las cuentas nuevas de comercio pasan por revisión administrativa.</p>
        <div class="mifav-seller-actions">
          <a class="button" href="#publicar">Publicar un producto</a>
          <a class="link-button" href="#alta-comercio">Abrir mi comercio</a>
        </div>
      </div>
      <div class="mifav-seller-character" aria-hidden="true">${renderCharacter('merchant', 132)}</div>
    </section>`;

  const advantages = `
    <ul class="mifav-advantages" aria-label="Ventajas de comprar en MiFav">
      <li><span>${renderIcon('pin', 18)}</span><strong>Neuquén capital</strong><small>Buscá por localidad y zona.</small></li>
      <li><span>${renderIcon('store', 18)}</span><strong>Retiro en el local</strong><small>Coordinás con el vendedor.</small></li>
      <li><span>${renderIcon('delivery', 18)}</span><strong>Envío del vendedor</strong><small>Sin costos inventados.</small></li>
      <li><span>${renderIcon('chat', 18)}</span><strong>Contacto directo</strong><small>Cuando el comercio lo habilita.</small></li>
    </ul>`;

  return `
    ${offlineBanner()}
    <section class="mifav-hero" aria-labelledby="home-title">
      <div class="mifav-hero-shape" aria-hidden="true"></div>
      <div class="mifav-hero-body">
        <p class="eyebrow">MIFAV · NEUQUÉN CAPITAL</p>
        <h1 id="home-title">Encontrá lo que buscás.<br><span>Comprá cerca.</span></h1>
        <p class="mifav-hero-lead">Productos nuevos y usados de emprendimientos y comercios de la ciudad. Coordiná retiro o envío con el vendedor: los costos los confirma él antes de cerrar la compra.</p>
        <form class="mifav-search" data-form="home-search" role="search">
          <label class="visually-hidden" for="home-search-input">Buscar productos, marcas o tiendas</label>
          <span class="search-icon" aria-hidden="true">${renderIcon('search', 18)}</span>
          <input id="home-search-input" name="query" type="search" placeholder="Producto o tienda"
            autocomplete="off" enterkeyhint="search">
          <button class="button" type="submit">Buscar</button>
        </form>
        <div class="mifav-hero-quick" role="group" aria-label="Filtros rápidos">
          <button class="chip" type="button" data-action="set-condition" data-condition="new">Nuevos</button>
          <button class="chip" type="button" data-action="set-condition" data-condition="used">Usados</button>
          <button class="chip" type="button" data-action="quick-filter" data-filter="pickup">Con retiro</button>
          <a class="chip" href="#ferias">Feria Neuquén Centro</a>
        </div>
        <p class="mifav-hero-locality">${renderIcon('pin', 14)} Neuquén Capital
          <span>·</span> Por ahora la búsqueda cubre la ciudad. Plottier y Centenario todavía no están habilitadas.</p>
      </div>
      <div class="mifav-hero-character" aria-hidden="true">${renderCharacter('shopper', 170)}</div>
    </section>

    ${operation}

    <section class="home-block">
      ${sectionHeading('CATEGORÍAS', 'Explorá por rubro', '<a class="link-button" href="#comercios">Ver todo</a>')}
      ${categoryTiles({ active: app.search.category })}
    </section>

    <section class="home-block">
      ${sectionHeading('DESTACADOS', 'Productos para descubrir', '<a class="link-button" href="#comercios">Ver más</a>')}
      ${productBlock}
    </section>

    <section class="home-block">
      ${sectionHeading('TIENDAS', 'Emprendimientos y comercios', '<a class="link-button" href="#comercios">Ver todos</a>')}
      ${storesBlock}
    </section>

    ${feriaBanner()}

    ${sellerBlock}

    ${advantages}

    ${taxi ? `
    <section class="home-block home-secondary">
      <a class="secondary-access" href="#taxi">
        <span class="secondary-access-icon" aria-hidden="true">${renderIcon('taxi', 24)}</span>
        <span>
          <strong>Pedir un taxi</strong>
          <span class="quiet">El servicio de MiFav sigue disponible como vertical aparte.</span>
        </span>
      </a>
      <a class="secondary-access" href="#taxista">
        <span class="secondary-access-icon" aria-hidden="true">${renderIcon('taxi', 24)}</span>
        <span>
          <strong>Registrarme como taxista</strong>
          <span class="quiet">Completá tu alta y recibí solicitudes cuando esté aprobada.</span>
        </span>
      </a>
    </section>` : ''}

    <section class="home-block home-secondary">
      <a class="secondary-access quiet-access" href="#institucional">
        <span class="secondary-access-icon" aria-hidden="true">${renderIcon('shield-check', 26)}</span>
        <span>
          <strong>Qué es MiFav</strong>
          <span class="quiet">${isConnected() ? 'Quiénes somos, cómo funciona y a quién consultar.' : 'Alcance, responsabilidades y propuesta de piloto.'}</span>
        </span>
      </a>
    </section>

    ${marketplaceNotice()}`;
}

async function viewBusinesses() {
  const businesses = await app.repository.query('publicBusinesses');
  const entries = await loadProductsFor(businesses);
  const products = sortProductEntries(visibleMarketplaceProducts(entries));
  const shown = Math.max(PRODUCT_PAGE_SIZE, Number(app.search.shown) || PRODUCT_PAGE_SIZE);
  const visibleProducts = products.slice(0, shown);
  // Buscar "pizza" también tiene que encontrar al comercio que la vende, no
  // sólo al que se llama así. En la demostración el catálogo ya está en memoria.
  const catalogs = Object.fromEntries(businesses.map(business => [
    business.id,
    entries.filter(entry => entry.business.id === business.id).map(entry => entry.product.name).join(' '),
  ]));
  const visibleBusinesses = filterBusinesses(businesses, catalogs)
    .sort((a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name));
  const categories = marketplaceCategoryNames(businesses);
  const productsByBusiness = new Map();
  for (const entry of entries) {
    if (!productsByBusiness.has(entry.business.id)) productsByBusiness.set(entry.business.id, []);
    productsByBusiness.get(entry.business.id).push(entry.product);
  }
  const resultLine = filtersActive()
    ? `<p class="results-line quiet" role="status">${pluralize(products.length, 'producto', 'productos')} y
        ${pluralize(visibleBusinesses.length, 'tienda', 'tiendas')}
        <button class="link-button" type="button" data-action="clear-filters">Quitar filtros</button></p>`
    : `<p class="results-line quiet" role="status">${pluralize(products.length, 'producto publicado', 'productos publicados')} ·
        ${pluralize(businesses.length, 'tienda', 'tiendas')} en Neuquén Capital</p>`;

  return `
    ${offlineBanner()}
    <section class="page-header mifav-page-header">
      <p class="eyebrow">EXPLORAR</p>
      <h1 class="page-title">Lo que buscás, en la ciudad</h1>
      <p class="quiet">Productos nuevos y usados de emprendimientos y comercios de Neuquén Capital. El retiro y el envío los coordina cada vendedor.</p>
    </section>

    <form class="search-bar mifav-searchbar" data-form="search" role="search">
      <label class="visually-hidden" for="search-input">Buscar productos, tiendas o rubros</label>
      <span class="search-icon" aria-hidden="true">${renderIcon('search', 18)}</span>
      <input id="search-input" name="query" type="search" placeholder="Producto o tienda"
        value="${esc(app.search.query)}" autocomplete="off" enterkeyhint="search">
      <button class="button" type="submit">Buscar</button>
    </form>

    <div class="mifav-filter-panel">
      <div class="mifav-filter-row" role="group" aria-label="Rubro">
        <span class="mifav-filter-label">${renderIcon('grid', 15)} Rubro</span>
        <div class="mifav-filter-scroll">
          ${categories.map(category => `<button class="chip ${app.search.category === category ? 'is-active' : ''}"
            type="button" data-action="set-category" data-category="${esc(category)}"
            aria-pressed="${app.search.category === category}">${esc(category)}</button>`).join('')}
        </div>
      </div>
      <div class="mifav-filter-row" role="group" aria-label="Condición">
        <span class="mifav-filter-label">${renderIcon('tag', 15)} Estado</span>
        <div class="mifav-filter-scroll">${conditionChips()}</div>
      </div>
      <div class="mifav-filter-row" role="group" aria-label="Entrega">
        <span class="mifav-filter-label">${renderIcon('store', 15)} Entrega</span>
        <div class="mifav-filter-scroll">${quickFilters()}
          <button class="chip ${app.search.locality === 'neuquen-capital' ? 'is-active' : ''}" type="button"
            data-action="set-locality" data-locality="neuquen-capital"
            aria-pressed="${app.search.locality === 'neuquen-capital'}">${renderIcon('pin', 13)} Neuquén Capital</button>
        </div>
      </div>
      <div class="mifav-filter-row" role="group" aria-label="Ordenar">
        <span class="mifav-filter-label">${renderIcon('sliders', 15)} Orden</span>
        <div class="mifav-filter-scroll">${sortChips()}</div>
      </div>
    </div>

    ${resultLine}

    ${products.length
      ? `<div class="mifav-product-grid mifav-product-grid-wide">${visibleProducts.map(({ product, business }) =>
        marketplaceProductCard({ product, business, favorite: isProductFavorite(business.id, product.id) })).join('')}</div>
        ${products.length > visibleProducts.length ? `<div class="mifav-load-more">
          <button class="button secondary" type="button" data-action="show-more-products">
            Ver más productos (${products.length - visibleProducts.length})
          </button>
          <p class="microcopy">Mostrando ${visibleProducts.length} de ${products.length}.</p>
        </div>` : ''}`
      : emptyState('Sin resultados',
        'La búsqueda mira el nombre, la descripción, el rubro y la tienda. Probá con otra palabra o quitá los filtros.',
        '#comercios', 'Ver todo el catálogo', 'bag')}

    ${visibleBusinesses.length ? `
      <section class="home-block">
        ${sectionHeading('TIENDAS', 'Quiénes venden', '<a class="link-button" href="#ferias">Ver ferias</a>')}
        <div class="mifav-store-grid">${visibleBusinesses.slice(0, 12).map(business =>
          marketplaceBusinessCard({ business, products: productsByBusiness.get(business.id) || [] })).join('')}</div>
      </section>` : ''}

    <p class="mifav-locality-note">${renderIcon('pin', 14)} Por ahora la búsqueda cubre Neuquén Capital.
      Plottier y Centenario todavía no están habilitadas.</p>
    ${marketplaceNotice()}`;
}

// Ficha de producto: la decisión de compra con el contexto del vendedor.
async function viewProduct(businessId, productId) {
  if (!businessId || !productId) {
    return emptyState('Producto no encontrado', 'Elegí un producto desde la vidriera.', '#comercios', 'Explorar', 'bag');
  }
  const business = await loadPublicBusiness(businessId);
  if (!business) return unavailableBusiness();
  const [products, cart] = await Promise.all([
    app.repository.query('products', { businessId }),
    app.repository.query('cart', { businessId }),
  ]);
  const product = products.find(candidate => candidate.id === productId && !candidate.archived);
  if (!product) {
    return emptyState('Este producto ya no está disponible',
      'Puede haberse pausado o vendido. Mirá el resto del catálogo de la tienda.',
      `#comercio/${businessId}`, 'Ver la tienda', 'bag');
  }
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const stock = Math.max(0, Number(product.stock) || 0);
  const available = isCommerciallyPurchasable(product) && (product.trackStock === false || stock > 0);
  const prices = variants.map(variant => product.price + (Number(variant.priceDelta) || 0)).filter(value => value > 0);
  const lowest = prices.length ? Math.min(...prices) : product.price;
  const favorite = isProductFavorite(business.id, product.id);
  const condition = productCondition(product);
  const detailCategory = product.category || categoryForBusiness(business);
  const detailMedia = product.image
    ? `<div class="mifav-detail-media"><img class="mifav-detail-image" src="${esc(product.image)}"
        alt="${esc(product.name)}" width="720" height="720"></div>`
    : `<div class="mifav-detail-media is-placeholder">
        <div class="mifav-detail-placeholder" role="img"
          aria-label="Sin foto cargada para ${esc(product.name)}">
          <span class="mifav-detail-monogram" aria-hidden="true">${esc(initialsOf(product.name))}</span>
          <span class="mifav-detail-placeholder-category">${esc(detailCategory)}</span>
          <span class="mifav-detail-placeholder-note">El vendedor todavía no cargó una foto de este artículo.</span>
        </div>
      </div>`;
  const fulfillment = [
    business.pickupEnabled ? `Retiro en ${business.address || 'el local del vendedor'}` : '',
    business.deliveryEnabled ? (business.deliveryFee > 0
      ? `Envío ${money(business.deliveryFee)} coordinado con el vendedor`
      : 'Envío coordinado con el vendedor') : '',
  ].filter(Boolean);
  const actionFor = variant => {
    const line = cart.lines.find(item => item.productId === product.id
      && (variant ? item.variantId === variant.id : !item.variantId));
    const quantity = line?.quantity || 0;
    if (quantity > 0) return quantityControl({ businessId, product, variant, quantity, max: stock });
    return addButton({ businessId, product, variant });
  };

  return `
    ${offlineBanner()}
    ${backLink('#comercios', 'Explorar')}
    <section class="mifav-detail" aria-labelledby="product-title">
      ${detailMedia}
      <div class="mifav-detail-body">
        <div class="mifav-detail-topline">
          <span class="mifav-product-kicker">${esc(detailCategory)}</span>
          ${condition ? `<span class="mifav-condition ${condition === 'used' ? 'is-used' : ''}">${esc(conditionLabel(condition))}</span>` : ''}
        </div>
        <h1 id="product-title">${esc(product.name)}</h1>
        <p class="mifav-detail-price">${variants.length && prices.some(value => value !== lowest) ? '<span class="quiet">desde</span> ' : ''}${money(lowest)}</p>
        ${product.description ? `<p class="mifav-detail-description">${esc(product.description)}</p>` : ''}
        ${available ? '' : `<p class="product-flag">${product.available === false ? 'Agotado por hoy' : 'Sin stock'}</p>`}

        ${variants.length ? `<div class="mifav-variant-list">${variants.map(variant => `
          <div class="mifav-variant">
            <span>${esc(variant.name)}${variant.priceDelta
              ? ` <span class="quiet">${variant.priceDelta > 0 ? '+' : '−'}${money(Math.abs(variant.priceDelta))}</span>` : ''}</span>
            ${available ? actionFor(variant) : ''}
          </div>`).join('')}</div>`
          : available ? `<div class="mifav-detail-actions">${actionFor(null)}</div>` : ''}

        <div class="mifav-detail-favorite">${favoriteButton({
          businessId: business.id, productId: product.id, favorite, name: product.name,
        })}<span>${favorite ? 'Guardado en tus favoritos' : 'Guardar para comparar'}</span></div>

        <section class="mifav-seller-card" aria-labelledby="seller-title">
          ${merchantAvatar(business, 'mifav-seller-avatar')}
          <div class="mifav-seller-info">
            <p class="eyebrow">VENDE</p>
            <h2 id="seller-title"><a href="#comercio/${esc(business.id)}">${esc(business.name)}</a></h2>
            <p class="quiet">${esc(business.subtitle || categoryForBusiness(business))} · ${esc(localityLabel(business.localityId))}</p>
            ${business.ownerName && !/^Responsable de /.test(business.ownerName)
          ? `<p class="microcopy">Responsable: ${esc(business.ownerName)}.</p>` : ''}
          </div>
          <a class="button secondary" href="#comercio/${esc(business.id)}">Ver la tienda</a>
        </section>

        <ul class="mifav-detail-facts">
          ${fulfillment.map(text => `<li>${renderIcon('check', 15)} ${esc(text)}</li>`).join('')}
          <li>${renderIcon('shield-check', 15)} Precio publicado por el vendedor. No incluye costos que no figuren acá.</li>
        </ul>
        ${isConnected() ? contactButtons(business, { compact: true })
          : '<p class="microcopy">Los datos de contacto se comparten al confirmar el pedido. En esta demostración no se envían mensajes reales.</p>'}
      </div>
    </section>`;
}

// Favoritos: una preferencia local, sin cuenta y sin datos privados del vendedor.
async function viewFavorites() {
  const businesses = await app.repository.query('publicBusinesses');
  const entries = await loadProductsFor(businesses);
  const index = new Map(entries.map(entry => [`${entry.business.id}/${entry.product.id}`, entry]));
  const saved = favoriteIds();
  const found = saved.map(key => index.get(key)).filter(Boolean);
  const missing = saved.length - found.length;

  return `
    ${offlineBanner()}
    <section class="page-header mifav-page-header">
      <p class="eyebrow">TUS FAVORITOS</p>
      <h1 class="page-title">Para volver a encontrar</h1>
      <p class="quiet">Se guardan en este navegador, sin crear una cuenta. Todavía no se sincronizan entre dispositivos.</p>
    </section>
    ${found.length
      ? `<p class="results-line quiet" role="status">${pluralize(found.length, 'producto guardado', 'productos guardados')}
          ${missing ? `· ${pluralize(missing, 'publicación ya no disponible', 'publicaciones ya no disponibles')}` : ''}</p>
        <div class="mifav-product-grid">${found.map(({ product, business }) =>
          marketplaceProductCard({ product, business, favorite: true })).join('')}</div>`
      : emptyFavorites()}
    ${saved.length ? `<p class="mifav-locality-note">${renderIcon('heart', 14)} Los favoritos son una lista local.
      Si borrás los datos del navegador, se borran.</p>` : ''}`;
}

// Feria: no se inventan fotos, fechas ni ubicaciones. El espacio de imagen está
// reservado para la fotografía real que aporte la organización.
async function viewFerias() {
  return `
    ${offlineBanner()}
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header mifav-page-header">
      <p class="eyebrow">FERIAS DE LA CIUDAD</p>
      <h1 class="page-title">Feria Neuquén Centro</h1>
      <p class="quiet">Un espacio para que los productos de la feria también se encuentren en MiFav.</p>
    </section>
    ${feriaBanner({ showLink: false })}
    <section class="mifav-feria-info">
      <article>
        <h2>Cómo va a funcionar</h2>
        <p>La feria tendrá su propia vidriera dentro de MiFav. Cada stand va a poder publicar productos y coordinar el retiro en la feria, sin inventar horarios ni ubicaciones.</p>
      </article>
      <article>
        <h2>Qué falta confirmar</h2>
        <p>Fecha, lugar, cantidad de stands y operativo de retiro los confirma la organización. Hasta entonces no mostramos datos de evento ni imágenes que no existan.</p>
      </article>
      <article>
        <h2>Para vender en la feria</h2>
        <p>Si tenés un emprendimiento, podés crear tu cuenta y publicar productos. La participación en la feria se coordina con la organización.</p>
        <a class="button" href="#publicar">Publicar un producto</a>
      </article>
    </section>
    <p class="mifav-locality-note">${renderIcon('pin', 14)} El retiro en feria todavía no está habilitado: requiere que la organización confirme el operativo.</p>`;
}

// Publicación: primero se revisa lo cargado y recién después se guarda. Para un
// comercio nuevo, la vidriera pública espera la aprobación administrativa.
async function viewPublish() {
  if (!isSignedIn()) {
    const identities = app.repository.capabilities.demoIdentities ? await app.repository.identities() : [];
    const seller = identities.find(identity => (identity.roles || []).includes('merchant'));
    return `
      ${backLink('#inicio', 'Inicio')}
      <section class="page-header mifav-page-header">
        <p class="eyebrow">VENDER EN MIFAV</p>
        <h1 class="page-title">Publicá tu producto</h1>
        <p class="quiet">Necesitás una cuenta de vendedor. Desde ahí cargás fotos, precio, condición y disponibilidad, y gestionás tus ventas.</p>
      </section>
      <ol class="steps-list mifav-publish-steps">
        <li>Ingresás o creás tu cuenta.</li>
        <li>Completás los datos de tu comercio y elegís retiro, envío o ambos.</li>
        <li>Cargás el producto y lo revisás antes de confirmar.</li>
        <li>Si el comercio es nuevo, administración revisa el alta antes de que sea visible.</li>
      </ol>
      <div class="notice"><strong>La publicación de un comercio nuevo pasa por revisión administrativa.</strong>
        No prometemos publicación instantánea: la vidriera se activa cuando el alta está aprobada.</div>
      ${seller ? `<button class="secondary-access" type="button" data-action="use-identity"
        data-identity="${esc(seller.id)}" data-return="#publicar">
        <span class="secondary-access-icon" aria-hidden="true">${renderIcon('store', 24)}</span>
        <span><strong>Probar como comercio de ejemplo</strong><span class="quiet">${esc(seller.hint)}</span></span>
      </button>` : ''}
      <a class="button full" href="#cuenta">Ingresar o crear cuenta</a>
      <p class="microcopy">Las identidades de ejemplo son ficticias y sólo existen en esta demostración.</p>`;
  }

  const businesses = await app.repository.query('myBusinesses');
  if (!businesses.length) {
    return `
      ${offlineBanner()}
      ${backLink('#panel', 'Mis comercios')}
      <section class="page-header mifav-page-header">
        <p class="eyebrow">VENDER EN MIFAV</p>
        <h1 class="page-title">Primero, tu comercio</h1>
        <p class="quiet">Para publicar necesitás un comercio asociado a tu cuenta. El alta queda en borrador hasta que la completes y solicites la revisión.</p>
      </section>
      <div class="notice"><strong>No hay un comercio en tu cuenta.</strong> Creá el borrador, cargá el catálogo y solicitá la publicación.</div>
      <a class="button full" href="#alta-comercio">Crear mi comercio</a>`;
  }

  const draft = app.publishReview;
  if (draft) {
    const draftBusiness = businesses.find(business => business.id === draft.businessId) || businesses[0];
    const inReview = draftBusiness.status !== 'active';
    return `
      ${offlineBanner()}
      ${backLink('#publicar', 'Publicar')}
      <section class="page-header mifav-page-header">
        <p class="eyebrow">REVISIÓN</p>
        <h1 class="page-title">Revisá tu publicación</h1>
        <p class="quiet">Esto es lo que se va a guardar. Podés volver y corregir antes de confirmar.</p>
      </section>
      <section class="mifav-review" aria-labelledby="review-title">
        <div class="mifav-review-photo">
          ${draft.imageData ? `<img src="${esc(draft.imageData)}" alt="Foto elegida para ${esc(draft.name)}" width="480" height="480">`
            : `<span class="mifav-product-fallback" aria-hidden="true">${esc(initialsOf(draft.name))}</span>`}
        </div>
        <div class="mifav-review-body">
          <p class="mifav-product-kicker">${esc(draft.category)} · ${esc(conditionLabel(draft.condition))}</p>
          <h2 id="review-title">${esc(draft.name)}</h2>
          <p class="mifav-detail-price">${money(draft.price)}</p>
          ${draft.description ? `<p>${esc(draft.description)}</p>` : ''}
          <dl class="mifav-review-list">
            <div><dt>Comercio</dt><dd>${esc(draftBusiness.name)}</dd></div>
            <div><dt>Disponibilidad</dt><dd>${draft.available ? `Disponible · ${draft.stock} unidades` : 'No disponible por ahora'}</dd></div>
            <div><dt>Retiro</dt><dd>${draftBusiness.pickupEnabled ? 'Habilitado' : 'No habilitado'}</dd></div>
            <div><dt>Envío</dt><dd>${draftBusiness.deliveryEnabled
              ? (draftBusiness.deliveryFee > 0 ? `${money(draftBusiness.deliveryFee)} · coordinado con el vendedor` : 'Coordinado con el vendedor') : 'No habilitado'}</dd></div>
          </dl>
          <div class="notice" role="status"><strong>${inReview ? 'Tu comercio todavía está en revisión.' : 'Tu comercio ya está aprobado.'}</strong>
            ${inReview ? 'La publicación se guarda, pero no se muestra en la vidriera pública hasta que administración apruebe el alta.'
              : 'La publicación queda en tu tienda. Podés pausarla o editarla desde el panel.'}</div>
          <div class="mifav-review-actions">
            <button class="button" type="button" data-action="publish-confirm">Confirmar publicación</button>
            <button class="button secondary" type="button" data-action="publish-cancel">Volver a editar</button>
          </div>
        </div>
      </section>`;
  }

  const businessId = route().param && businesses.some(business => business.id === route().param)
    ? route().param : businesses[0].id;
  const business = businesses.find(item => item.id === businessId) || businesses[0];
  const inReview = business.status !== 'active';
  return `
    ${offlineBanner()}
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header mifav-page-header">
      <p class="eyebrow">VENDER EN MIFAV</p>
      <h1 class="page-title">Nuevo producto</h1>
      <p class="quiet">Cargalo, revisalo y confirmá. La foto es opcional: sin foto mostramos una marca tipográfica, no una imagen inventada.</p>
    </section>
    ${inReview ? `<div class="notice" role="status"><strong>Tu comercio está en revisión.</strong>
      Podés cargar productos, pero no se verán en la vidriera hasta que administración apruebe el alta.</div>` : ''}
    <form class="checkout-form mifav-publish-form" data-form="publish-review">
      ${businesses.length > 1 ? `<div class="field">
        <label for="publish-business">Comercio</label>
        <select id="publish-business" name="business" required>
          ${businesses.map(item => `<option value="${esc(item.id)}" ${item.id === business.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
        </select>
      </div>` : `<input type="hidden" name="business" value="${esc(business.id)}">`}
      <div class="field">
        <label for="publish-name">Título del producto</label>
        <input id="publish-name" name="name" type="text" required minlength="2" maxlength="80"
          placeholder="Ej.: Lámpara de mimbre" autocomplete="off">
      </div>
      <div class="field">
        <label for="publish-description">Descripción</label>
        <textarea id="publish-description" name="description" rows="4" maxlength="280"
          placeholder="Medidas, material, estado y lo que la persona necesita saber."></textarea>
      </div>
      <div class="mifav-form-two">
        <div class="field">
          <label for="publish-category">Categoría</label>
          <select id="publish-category" name="category" required>
            ${MARKETPLACE_CATEGORIES.map(category => `<option value="${esc(category.name)}">${esc(category.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="publish-price">Precio en pesos</label>
          <input id="publish-price" name="price" type="number" inputmode="numeric" min="1" step="1" required>
        </div>
      </div>
      <fieldset class="field mifav-fieldset">
        <legend>Condición</legend>
        <label class="mifav-radio"><input type="radio" name="condition" value="new" checked> Nuevo</label>
        <label class="mifav-radio"><input type="radio" name="condition" value="used"> Usado</label>
      </fieldset>
      <div class="mifav-form-two">
        <div class="field">
          <label for="publish-stock">Unidades disponibles</label>
          <input id="publish-stock" name="stock" type="number" inputmode="numeric" min="0" max="10000" step="1" value="1" required>
        </div>
        <div class="field mifav-check-field">
          <label class="mifav-check"><input type="checkbox" name="available" checked> Mostrar como disponible</label>
          <p class="microcopy">Podés pausarlo después desde el panel.</p>
        </div>
      </div>
      <div class="field">
        <label for="publish-image">Foto principal (opcional)</label>
        <input id="publish-image" name="image" type="file" accept="image/jpeg,image/png,image/webp">
        <p class="microcopy">JPEG, PNG o WebP. Se achica en el navegador. Una foto clara ayuda, pero no es obligatoria.</p>
      </div>
      <div class="mifav-publish-fulfillment">
        <p><strong>Retiro:</strong> ${business.pickupEnabled ? `en ${esc(business.address || 'el local del vendedor')}` : 'no habilitado'}.</p>
        <p><strong>Envío:</strong> ${business.deliveryEnabled
          ? (business.deliveryFee > 0 ? `${money(business.deliveryFee)}, coordinado con el vendedor.` : 'coordinado con el vendedor, sin costo publicado.')
          : 'no habilitado'}.</p>
        <a class="link-button" href="#panel/${esc(business.id)}/configuracion">Editar retiro y envío del comercio</a>
      </div>
      <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Revisar publicación</button>
      <p class="microcopy">No se publica al instante: primero ves esta revisión y después confirmás.</p>
    </form>`;
}

async function loadPublicBusiness(businessId) {
  try {
    return await app.repository.query('business', { businessId });
  } catch (error) {
    if (error?.code === 'BUSINESS_NOT_FOUND') return null;
    throw error;
  }
}

const unavailableBusiness = () => emptyState('Este comercio no está disponible',
  'Puede estar pausado o en revisión. Mirá los otros comercios de Neuquén Capital.', '#comercios', 'Ver comercios', 'bag');

async function viewBusiness(businessId) {
  if (!businessId) return emptyState('Comercio no encontrado', 'Elegí un comercio del listado.');
  const business = await loadPublicBusiness(businessId);
  if (!business) return unavailableBusiness();
  const [products, cart] = await Promise.all([
    app.repository.query('products', { businessId }),
    app.repository.query('cart', { businessId }),
  ]);
  const purchasable = products.filter(product => !product.archived);
  // Las secciones siguen el orden que eligió el comercio; lo que no tiene
  // categoría visible ("Otros") va al final.
  const rankOf = new Map();
  for (const product of purchasable) {
    if (!rankOf.has(product.category)) rankOf.set(product.category, product.categoryPosition ?? Number.MAX_SAFE_INTEGER);
  }
  const categories = [...rankOf.keys()].sort((a, b) => rankOf.get(a) - rankOf.get(b));
  const units = cart.lines.reduce((total, line) => total + line.quantity, 0);

  return `
    ${offlineBanner()}
    ${backLink('#comercios', 'Comercios')}
    ${storeHeader(business, { connected: isConnected(), times: timesLine(business),
      contact: isConnected() ? contactButtons(business, { compact: true }) : '' })}
    ${isConnected() && (business.hours || []).length ? `<details class="hours-details"><summary>Horarios de atención</summary>${hoursSummary(business)}</details>` : ''}

    ${business.open ? '' : `<div class="notice" role="status"><strong>${esc(availabilityText(business))}.</strong> Podés mirar el catálogo y armar tu pedido; se confirma cuando el comercio esté recibiendo pedidos.</div>`}

    ${catalogJump(categories)}
    ${categories.map((category, index) => `
      <section class="catalog-group" id="cat-${index}" aria-labelledby="cat-${index}-title">
        <h2 class="catalog-group-title" id="cat-${index}-title">${esc(category)}</h2>
        <div class="product-grid">${purchasable.filter(product => product.category === category)
          .map(product => productCard(product, { businessId: business.id, lines: cart.lines })).join('')}</div>
      </section>`).join('') || emptyState('Catálogo vacío', 'Este comercio todavía no publicó productos.', '#comercios', 'Ver otros comercios', 'bag')}

    ${cartBar(business.id, { units, subtotal: cartSubtotal(cart.lines, products) })}`;
}

// Retiro o envío: lo elegido en el carrito sigue en la confirmación.
function checkoutMode(business) {
  const stored = draft(`checkout:${business.id}`);
  const modes = [business.pickupEnabled ? 'pickup' : null, business.deliveryEnabled ? 'delivery' : null].filter(Boolean);
  return { stored, modes, fulfillment: modes.includes(stored.fulfillment) ? stored.fulfillment : modes[0] };
}

// Una línea cuyo producto se dio de baja, se agotó o cambió de opciones se
// marca y se puede quitar: nunca queda trabada en el carrito.
function cartDetail(cart, products) {
  return cart.lines.map(line => {
    const product = products.find(candidate => candidate.id === line.productId && !candidate.archived);
    const variant = (product?.variants || []).find(item => item.id === line.variantId) || null;
    const unavailable = !product || !isCommerciallyPurchasable(product)
      || (line.variantId && !variant) || (!line.variantId && (product?.variants || []).length > 0);
    return { line, product, variant, unavailable };
  });
}

async function viewCarts(businessId) {
  if (businessId) return route().extra === 'confirmar' ? viewCheckout(businessId) : viewCart(businessId);
  const carts = await app.repository.query('carts');
  app.cartCount = carts.reduce((total, entry) => total + entry.cart.lines.reduce((sum, line) => sum + line.quantity, 0), 0);
  if (!carts.length) {
    return emptyState('Tu carrito está vacío', 'Elegí un comercio y sumá productos. Cada comercio tiene su propio carrito.',
      '#comercios', 'Ver comercios', 'bag');
  }
  // Con un solo carrito no hay nada que elegir: se muestra directamente.
  if (carts.length === 1) return viewCart(carts[0].business.id);
  return `
    ${offlineBanner()}
    <section class="page-header">
      <h1 class="page-title">Tus carritos</h1>
      <p class="quiet">Cada comercio recibe su propio pedido.</p>
    </section>
    <div class="stack">
      ${carts.map(entry => {
        const units = entry.cart.lines.reduce((total, line) => total + line.quantity, 0);
        return `
          <article class="cart-summary-card">
            ${merchantAvatar(entry.business, 'merchant-avatar-card')}
            <div class="cart-summary-main">
              <h2>${esc(entry.business.name)}</h2>
              <p class="quiet">${pluralize(units, 'producto', 'productos')}</p>
            </div>
            <a class="button" href="#carrito/${esc(entry.business.id)}">Ver carrito</a>
          </article>`;
      }).join('')}
    </div>`;
}

async function viewCart(businessId) {
  const business = await loadPublicBusiness(businessId);
  if (!business) return unavailableBusiness();
  const [products, cart] = await Promise.all([
    app.repository.query('products', { businessId }),
    app.repository.query('cart', { businessId }),
  ]);
  if (!cart.lines.length) {
    return emptyState('Tu carrito está vacío', `Todavía no agregaste productos de ${business.name}.`,
      `#comercio/${business.id}`, 'Ver catálogo', 'bag');
  }
  const { modes, fulfillment } = checkoutMode(business);
  const detail = cartDetail(cart, products);
  const unavailableCount = detail.filter(item => item.unavailable).length;
  const subtotal = cartSubtotal(cart.lines, products);
  const shortfall = fulfillment === 'delivery' && business.minimumOrder > 0 ? business.minimumOrder - subtotal : 0;
  let quote = null;
  let quoteError = '';
  try { quote = await app.repository.query('quote', { businessId, fulfillment, preview: true }); }
  catch (error) { quoteError = userMessage(error); }
  const id = esc(business.id);

  return `
    ${offlineBanner()}
    ${backLink(`#comercio/${business.id}`, business.name)}
    <section class="page-header">
      <h1 class="page-title">Tu carrito</h1>
      <p class="quiet">${esc(business.name)} · ${esc(availabilityText(business))}</p>
    </section>
    ${business.open ? '' : `<div class="notice" role="status"><strong>${esc(availabilityText(business))}.</strong> Podés dejar el pedido armado; se confirma cuando el comercio esté recibiendo pedidos.</div>`}

    <section class="checkout-section">
      <h2 class="checkout-section-title">Cómo lo recibís</h2>
      ${fulfillmentSwitch(business, modes, fulfillment)}
      ${timesLine(business, fulfillment) ? `<p class="microcopy">${esc(timesLine(business, fulfillment))}</p>` : ''}
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Productos</h2>
      ${cartLines(detail, business.id)}
      ${unavailableCount > 1 ? `<button class="link-button" type="button" data-action="remove-unavailable" data-business="${id}">Quitar los ${unavailableCount} productos no disponibles</button>` : ''}
      <a class="link-button cart-more" href="#comercio/${id}">+ Agregar más productos</a>
    </section>

    ${shortfall > 0 ? `<div class="notice" role="status">Te faltan <strong>${money(shortfall)}</strong> para el mínimo de envío
      (${money(business.minimumOrder)}). Sumá productos${modes.includes('pickup') ? ' o elegí retiro' : ''}.</div>`
      : quoteError && !unavailableCount ? `<div class="notice error" role="alert"><strong>Revisá tu pedido.</strong> ${esc(quoteError)}</div>` : ''}

    <section class="checkout-section cart-total" aria-label="Total">
      ${quote ? totalsList(quote, fulfillment) : `<p class="quiet">${unavailableCount
        ? 'Quitá los productos que ya no están disponibles para ver el total.'
        : 'El total aparece cuando el pedido cumple las condiciones del comercio.'}</p>`}
      ${quote ? `<p class="microcopy">${fulfillment === 'delivery' ? 'Incluye el envío del comercio.' : 'Retirás en el local, sin costo.'}
        Al enviar, MiFav vuelve a confirmar precios y disponibilidad.</p>` : ''}
    </section>

    <div class="cart-continue">
      ${quote && !unavailableCount
        ? `<a class="button full button-continue" href="#carrito/${id}/confirmar">Continuar · ${money(quote.total)}</a>`
        : '<button class="button full button-continue" type="button" disabled>Continuar</button>'}
    </div>
    <p class="cart-clear"><button class="link-button danger" type="button" data-action="clear-cart" data-business="${id}">Vaciar carrito</button></p>`;
}

async function viewCheckout(businessId) {
  const business = await loadPublicBusiness(businessId);
  if (!business) return unavailableBusiness();
  const [products, cart, offered] = await Promise.all([
    app.repository.query('products', { businessId }),
    app.repository.query('cart', { businessId }),
    // Formas de pago de este comercio, según la base. Si no responde, sólo efectivo.
    isConnected() ? app.repository.query('paymentMethods', { businessId }).catch(() => null) : null,
  ]);
  if (!cart.lines.length) {
    return emptyState('Tu carrito está vacío', `Todavía no agregaste productos de ${business.name}.`,
      `#comercio/${business.id}`, 'Ver catálogo', 'bag');
  }
  const { stored, modes, fulfillment } = checkoutMode(business);
  const detail = cartDetail(cart, products);
  const unavailableCount = detail.filter(item => item.unavailable).length;
  let quote = null;
  let quoteError = '';
  try { quote = await app.repository.query('quote', { businessId, fulfillment, preview: true }); }
  catch (error) { quoteError = userMessage(error); }
  const notice = app.checkoutNotice?.businessId === businessId ? app.checkoutNotice : null;
  const units = cart.lines.reduce((total, line) => total + line.quantity, 0);

  const connectedMethods = offered ? checkoutPaymentMethods(offered, fulfillment) : [];
  const methods = !isConnected() ? DEMO_PAYMENT_METHODS
    : connectedMethods.length ? connectedMethods : cashOnlyMethods(fulfillment);
  const chosen = methods.some(method => method.id === stored.paymentMethod) ? stored.paymentMethod : methods[0]?.id;
  const onlineMethod = methods.find(method => method.kind === 'online');
  const onlineOffered = Boolean(onlineMethod);
  const payNote = !isConnected()
    ? 'Los pagos en línea no están habilitados en esta entrega. El pedido y el pago son estados independientes.'
    : onlineMethod
      ? `El comercio prepara el pedido cuando ${onlineMethod.label} aprueba el pago. MiFav no ve ni guarda los datos de tu tarjeta.`
      : 'Se paga directamente al comercio. MiFav no cobra ni intermedia el pago.';
  const delivery = fulfillment === 'delivery';
  let step = 0;
  const stepTitle = (key, text) => `<h2 class="checkout-step-title" id="paso-${key}"><span class="step-number" aria-hidden="true">${++step}</span> ${esc(text)}</h2>`;

  return `
    ${offlineBanner()}
    ${backLink(`#carrito/${business.id}`, 'Carrito')}
    <section class="page-header">
      <h1 class="page-title">Confirmar pedido</h1>
      <p class="quiet">${esc(business.name)} · ${pluralize(units, 'producto', 'productos')}</p>
    </section>

    ${notice ? `<div class="notice ${notice.tone === 'error' ? 'error' : ''}" role="alert">${esc(notice.message)}</div>` : ''}
    ${business.open ? '' : `<div class="notice" role="status"><strong>${esc(availabilityText(business))}.</strong> Vas a poder confirmar cuando el comercio esté recibiendo pedidos.</div>`}
    ${unavailableCount ? `<div class="notice error" role="alert"><strong>Cambió la disponibilidad.</strong> Hay productos que ya no se pueden pedir.
      <a class="link-button" href="#carrito/${esc(business.id)}">Revisar el carrito</a></div>` : ''}
    ${quoteError && !unavailableCount ? `<div class="notice error" role="alert"><strong>Revisá tu pedido.</strong> ${esc(quoteError)}
      <a class="link-button" href="#carrito/${esc(business.id)}">Volver al carrito</a></div>` : ''}

    <form class="checkout-form checkout-steps" data-form="checkout" data-business="${esc(business.id)}"
      data-expected-total="${quote ? quote.total : ''}" novalidate>
      <section class="checkout-step" aria-labelledby="paso-entrega">
        ${stepTitle('entrega', 'Entrega')}
        <div class="choice-group" role="radiogroup" aria-labelledby="paso-entrega">
          ${modes.map(mode => `
            <label class="choice ${fulfillment === mode ? 'active' : ''}">
              <input type="radio" name="fulfillment" value="${mode}" ${fulfillment === mode ? 'checked' : ''}>
              <span class="choice-body">
                <strong>${mode === 'pickup' ? 'Retiro en el comercio' : 'Envío del comercio'}</strong>
                <span class="quiet">${mode === 'pickup'
                  ? `${esc(business.address || 'Dirección a confirmar con el comercio')} · sin costo`
                  : `${business.deliveryFee > 0 ? money(business.deliveryFee) : 'Sin costo'}${business.minimumOrder > 0 ? ` · mínimo ${money(business.minimumOrder)}` : ''}${business.deliveryZone ? ` · ${esc(business.deliveryZone)}` : ''}`}</span>
              </span>
            </label>`).join('')}
        </div>
        ${timesLine(business, fulfillment) ? `<p class="microcopy">${esc(timesLine(business, fulfillment))}</p>` : ''}
      </section>

      <section class="checkout-step" aria-labelledby="paso-datos">
        ${stepTitle('datos', 'Tus datos')}
        ${isConnected() && !isSignedIn() ? '<p class="microcopy">No hace falta crear una cuenta. El comercio usa estos datos sólo para este pedido.</p>' : ''}
        <div class="field">
          <label for="checkout-name">Nombre y apellido</label>
          <input id="checkout-name" name="name" type="text" required minlength="2" maxlength="80"
            autocomplete="name" value="${esc(stored.name || (isSignedIn() ? actor().name : ''))}">
        </div>
        <div class="field">
          <label for="checkout-phone">Teléfono de contacto</label>
          <input id="checkout-phone" name="phone" type="tel" required inputmode="tel" autocomplete="tel"
            placeholder="2942 000000" aria-describedby="checkout-phone-help" value="${esc(stored.phone || (isSignedIn() ? actor().phone || '' : ''))}">
          <p class="microcopy" id="checkout-phone-help">El comercio te llama o escribe si hay algún cambio.</p>
        </div>
      </section>

      ${delivery ? `
      <section class="checkout-step" aria-labelledby="paso-direccion">
        ${stepTitle('direccion', 'Dirección')}
        <div class="field">
          <label for="checkout-address">Dirección de entrega</label>
          <input id="checkout-address" name="address" type="text" required minlength="5" maxlength="200"
            autocomplete="street-address" placeholder="Calle, número y referencia" value="${esc(stored.address || '')}">
        </div>
        ${business.deliveryZone ? `
          <label class="check-label">
            <input type="checkbox" name="zoneAcknowledged" ${stored.zoneAcknowledged ? 'checked' : ''}>
            <span>Confirmo que la dirección está dentro de la zona de reparto del comercio (${esc(business.deliveryZone)}).</span>
          </label>` : ''}
      </section>` : ''}

      <section class="checkout-step" aria-labelledby="paso-pago">
        ${stepTitle('pago', 'Forma de pago')}
        ${paymentMethodSelector(methods, chosen, { note: payNote })}
      </section>

      <section class="checkout-step checkout-review" aria-labelledby="paso-confirmacion">
        ${stepTitle('confirmacion', 'Confirmación')}
        <ul class="review-lines" aria-label="Tu pedido">
          ${detail.filter(item => !item.unavailable).map(({ line, product, variant }) => `<li>
            <span>${line.quantity} × ${esc(product.name)}${variant ? ` · ${esc(variant.name)}` : ''}</span>
          </li>`).join('')}
        </ul>
        ${quote ? totalsList(quote, fulfillment) : ''}
        <div class="field">
          <label for="checkout-notes">Nota para el comercio (opcional)</label>
          <textarea id="checkout-notes" name="notes" rows="2" maxlength="280" placeholder="Por ejemplo: sin cebolla, timbre azul">${esc(stored.notes || '')}</textarea>
        </div>
        <p class="microcopy">${isConnected()
          ? 'MiFav confirma precios y disponibilidad al enviar. Si algo cambió, te lo mostramos antes de crear el pedido.'
          : `El importe se recalcula ${isShared() ? 'en el servidor' : 'con el catálogo guardado'} al confirmar.`}</p>
        ${confirmNotice({ online: onlineOffered })}
        <button class="button button-confirm-order full" type="submit" data-online-label="Continuar al pago" data-cash-label="Confirmar pedido"
          ${quote && app.online && business.open && !unavailableCount ? '' : 'disabled'}><span class="confirm-label">${
          chosen === 'online' ? 'Continuar al pago' : 'Confirmar pedido'}</span>${quote ? ` · ${money(quote.total)}` : ''}</button>
        ${!app.online && isShared() ? '<p class="microcopy">Sin conexión no se confirma. Reintentá cuando vuelva.</p>' : ''}
      </section>
    </form>`;
}

// Enlace de seguimiento: abre el pedido desde cualquier dispositivo, sin sesión.
const trackingUrl = token => new URL(`index.html#seguimiento/${token}`, location.href.split('#')[0]).href;

async function viewOrder(orderId) {
  // Sin ninguna sesión (otro navegador, datos borrados) la base no deja leer
  // pedidos: se explica cómo verlo en vez de mostrar un error sin salida.
  if (isConnected() && !actor()?.id) {
    return `${backLink('#inicio', 'Inicio')}
      <section class="page-header"><h1 class="page-title">Tu pedido</h1></section>
      <div class="notice"><strong>Este pedido no está en esta sesión.</strong> Si compraste sin cuenta, abrilo con el enlace de seguimiento que guardaste; si lo hiciste con tu cuenta, ingresá.</div>
      <a class="button full" href="#cuenta">Ingresar</a>`;
  }
  const order = await app.repository.query('order', { orderId });
  const business = await loadPublicBusiness(order.businessId);
  const businessName = business?.name || 'Comercio';
  const canceled = order.status === 'canceled';
  const closed = canceled || order.status === 'delivered';
  const times = !closed && business ? timesLine(business, order.fulfillment) : '';

  return `
    ${offlineBanner()}
    ${backLink('#actividad', 'Mis pedidos')}
    <section class="page-header">
      <span class="eyebrow">PEDIDO ${esc(order.code)}</span>
      <h1 class="page-title">${esc(businessName)}</h1>
      <p class="quiet">${esc(fulfillmentLabel(order.fulfillment))} · ${esc(shortDate(order.createdAt))}</p>
    </section>

    ${canceled ? cancellationNotice(order) : orderStatusHero(order, { times,
      place: order.fulfillment === 'delivery' ? order.customer?.address : business?.address,
      courier: order.riderName || (business ? `Reparto de ${business.name}` : '') })}
    ${orderPaymentNotice(order, { canPay: isConnected() && !closed && order.customerId === actor()?.id, online: app.online })}
    ${deliveryCodeCard(order)}
    ${canceled ? '' : orderTimeline(order)}

    ${isConnected() && business && !closed ? `<section class="checkout-section order-contact">
      <h2 class="checkout-section-title">¿Necesitás hablar con ${esc(businessName)}?</h2>
      ${contactButtons(business) || '<p class="quiet">El comercio no publicó un teléfono.</p>'}
    </section>` : ''}

    ${isConnected() && order.trackingToken && !closed ? `
    <section class="checkout-section tracking-share">
      <h2 class="checkout-section-title">Seguí tu pedido desde cualquier lugar</h2>
      <p class="microcopy">Guardá este enlace: muestra el estado del pedido aunque cambies de teléfono o cierres el navegador.</p>
      <div class="modal-actions">
        <button class="button secondary" type="button" data-action="copy-tracking" data-url="${esc(trackingUrl(order.trackingToken))}">${renderIcon('link', 16)} Copiar enlace</button>
        ${typeof navigator !== 'undefined' && navigator.share ? `<button class="button secondary" type="button" data-action="share-tracking" data-url="${esc(trackingUrl(order.trackingToken))}" data-code="${esc(order.code)}">Compartir</button>` : ''}
      </div>
    </section>` : ''}

    ${orderDetails(order, { open: closed })}

    ${allowedActions(order, { kind: 'customer', id: order.customerId }).includes('canceled') ? `
      <button class="button button-outline-danger full" type="button" data-action="cancel-order"
        data-order="${esc(order.id)}" data-version="${order.version}">Cancelar pedido</button>
      <p class="microcopy">Podés cancelar mientras el comercio no lo haya aceptado.</p>` : ''}`;
}

async function viewTracking(token) {
  let order;
  try {
    order = await app.repository.query('trackOrder', { token });
  } catch (error) {
    if (error?.code === 'ORDER_NOT_FOUND') {
      return emptyState('Pedido no encontrado', error.message, '#comercios', 'Ver comercios', 'bag');
    }
    throw error;
  }
  const canceled = order.status === 'canceled';
  const closed = canceled || order.status === 'delivered';
  return `
    ${offlineBanner()}
    <section class="page-header">
      <span class="eyebrow">PEDIDO ${esc(order.code)}</span>
      <h1 class="page-title">${esc(order.business.name)}</h1>
      <p class="quiet">${esc(fulfillmentLabel(order.fulfillment))} · ${esc(shortDate(order.createdAt))}</p>
    </section>
    ${canceled ? cancellationNotice(order) : orderStatusHero(order, { times: closed ? '' : timesLine(order.business, order.fulfillment),
      place: order.fulfillment === 'delivery' ? order.customer?.address : order.business.address,
      courier: `Reparto de ${order.business.name}` })}
    ${orderPaymentNotice(order)}
    ${deliveryCodeCard(order)}
    ${canceled ? '' : orderTimeline(order)}
    ${closed ? '' : contactButtons(order.business)}
    ${orderDetails(order, { open: closed })}
    <p class="microcopy">Esta página se actualiza sola cada medio minuto.</p>`;
}

// Vuelta desde el proveedor de pagos. La ruta sólo dice por dónde volvió la
// persona: el resultado sale de leer el pago en la base (intento o pedido).
async function viewPaymentReturn(outcome) {
  const known = RETURN_OUTCOMES.includes(outcome) ? outcome : 'pendiente';
  if (!isConnected()) {
    app.paymentWaiting = false;
    return emptyState('Pagos online no habilitados', 'En esta demostración los pedidos se pagan al comercio.',
      '#actividad', 'Mis pedidos', 'bag');
  }
  const reference = paymentReturnReference(location.hash, location.search);
  const payment = actor()?.id ? await app.repository.query('paymentStatus', { reference }) : null;
  app.paymentWaiting = Boolean(payment && payment.paymentMethod === 'online' && isWaitingPayment(payment.paymentStatus));
  return `${offlineBanner()}${paymentReturnView(known, payment)}`;
}

async function viewActivity() {
  const taxi = feature('taxi');
  const [orders, trips, businesses] = await Promise.all([
    app.repository.query('myOrders'),
    taxi ? app.repository.query('myTrips') : [],
    app.repository.query('publicBusinesses'),
  ]);
  const nameOf = id => businesses.find(business => business.id === id)?.name || 'Comercio';
  const tab = taxi ? app.activityTab : 'pedidos';
  const orderItem = order => `
    <a class="op-card" href="#pedido/${esc(order.id)}">
      ${order.lines?.[0]?.image
        ? productThumb(order.lines[0], order.lines[0].name, 'op-card-thumb')
        : `<span class="op-card-icon">${renderIcon('receipt', 18)}</span>`}
      <span class="op-card-body">
        <strong>${esc(nameOf(order.businessId))}</strong>
        <span class="quiet">${esc(order.code)} · ${esc(shortDate(order.createdAt))} · ${money(order.total)}</span>
        ${order.paymentMethod === 'online' ? paymentBadge(order) : ''}
      </span>
      <span class="status-chip ${orderStatusTone(order.status)}">${esc(orderStatusLabel(order))}</span>
    </a>`;
  const active = orders.filter(order => !['delivered', 'canceled'].includes(order.status));
  const past = orders.filter(order => ['delivered', 'canceled'].includes(order.status));

  const ordersList = orders.length ? `
    ${active.length ? `<section class="activity-group" aria-labelledby="actividad-curso">
      <h2 class="checkout-section-title" id="actividad-curso">En curso</h2>
      <div class="stack">${active.map(orderItem).join('')}</div>
    </section>` : ''}
    ${past.length ? `<section class="activity-group" aria-labelledby="actividad-anteriores">
      <h2 class="checkout-section-title" id="actividad-anteriores">Anteriores</h2>
      <div class="stack">${past.map(orderItem).join('')}</div>
    </section>` : ''}`
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
      <h1 class="page-title">${taxi ? 'Mi actividad' : 'Mis pedidos'}</h1>
      ${isSignedIn()
        ? `<p class="quiet">Sesión de ${esc(actor().name)}.</p>`
        : isConnected() && actor()?.anonymous
          ? `<p class="quiet">Compraste sin cuenta: tus pedidos quedan guardados en este dispositivo. Desde cada pedido podés copiar su enlace de seguimiento.</p>`
          : `<p class="quiet">Estás navegando sin cuenta. Tus pedidos quedan asociados a este dispositivo.</p>`}
    </section>

    ${taxi ? `<div class="tabs" role="tablist" aria-label="Tipo de actividad">
      <button class="tab ${tab === 'pedidos' ? 'active' : ''}" type="button" role="tab"
        aria-selected="${tab === 'pedidos'}" data-action="set-activity-tab" data-tab="pedidos">Pedidos</button>
      <button class="tab ${tab === 'viajes' ? 'active' : ''}" type="button" role="tab"
        aria-selected="${tab === 'viajes'}" data-action="set-activity-tab" data-tab="viajes">Viajes</button>
    </div>` : ''}

    ${tab === 'pedidos' ? ordersList : tripsList}

    <section class="home-block home-secondary">
      ${isSignedIn() ? `
        <a class="secondary-access" href="#cuenta">
          <span class="secondary-access-icon" aria-hidden="true">${renderIcon('user', 26)}</span>
          <span><strong>Tu cuenta</strong><span class="quiet">${esc(actor().email || '')} · accesos, datos y cierre de sesión</span></span>
        </a>` : `
        <a class="secondary-access" href="#cuenta">
          <span class="secondary-access-icon" aria-hidden="true">${renderIcon('user', 26)}</span>
          <span><strong>Ingresar o crear cuenta</strong><span class="quiet">${taxi ? 'Necesaria para comercios, taxistas y administración.' : 'Para comercios y su equipo. Para comprar no hace falta.'}</span></span>
        </a>`}
      ${hasRole('merchant') ? `<a class="secondary-access" href="#panel"><span class="secondary-access-icon" aria-hidden="true">${renderIcon('store', 26)}</span><span><strong>Panel de mi comercio</strong><span class="quiet">Pedidos, catálogo y reparto.</span></span></a>` : ''}
      ${hasRole('rider') ? `<a class="secondary-access" href="#entregas"><span class="secondary-access-icon" aria-hidden="true">${renderIcon('delivery', 26)}</span><span><strong>Mis entregas</strong><span class="quiet">Los pedidos que te asignó el comercio.</span></span></a>` : ''}
      ${app.repository.capabilities.reset ? `
        <button class="secondary-access quiet-access" type="button" data-action="reset-demo">
          <span class="secondary-access-icon" aria-hidden="true">${renderIcon('key', 26)}</span>
          <span><strong>Reiniciar datos de demostración</strong><span class="quiet">Borra pedidos, viajes y altas de este navegador.</span></span>
        </button>` : ''}
    </section>`;
}

// ───────────────────────── cuenta ─────────────────────────

async function viewAccount() {
  const notice = app.authNotice ? `<div class="notice" role="status">${esc(app.authNotice)}</div>` : '';
  if (isSignedIn()) {
    const access = (href, icon, title, hint) => `<a class="secondary-access" href="${href}">
      <span class="secondary-access-icon" aria-hidden="true">${renderIcon(icon, 24)}</span>
      <span><strong>${esc(title)}</strong><span class="quiet">${esc(hint)}</span></span></a>`;
    return `
      ${backLink('#actividad', 'Mis pedidos')}
      <section class="page-header">
        <h1 class="page-title">Tu cuenta</h1>
        <p class="quiet">${esc(actor().name)} · ${esc(actor().email || 'sin correo')}</p>
      </section>
      ${notice}
      <section class="checkout-section">
        <h2 class="checkout-section-title">Tus accesos</h2>
        <div class="stack">
          ${hasRole('merchant') ? access('#panel', 'store', 'Panel de mi comercio', 'Pedidos, catálogo, reparto y horarios.')
            : access('#alta-comercio', 'store', 'Sumar mi comercio', 'Creá tu comercio y cargá tu catálogo.')}
          ${hasRole('rider') ? access('#entregas', 'delivery', 'Mis entregas', 'Los pedidos que te asignó el comercio.') : ''}
          ${!feature('taxi') ? '' : hasRole('driver') ? access('#taxista', 'taxi', 'Panel de taxista', 'Disponibilidad y solicitudes.')
            : access('#taxista', 'taxi', 'Registrarme como taxista', 'Completá tu alta.')}
          ${hasRole('admin') ? access('#admin', 'shield-check', 'Administración', 'Altas, comercios y el día en MiFav.') : ''}
          ${access('#actividad', 'receipt', 'Mis pedidos', 'Lo que pediste y su estado.')}
        </div>
        <p class="microcopy">Roles: ${esc(actor().roles.map(role => ROLE_LABELS[role] || role).join(' · '))}.</p>
      </section>
      ${app.repository.capabilities.accountManagement ? `
        <form class="checkout-form" data-form="profile-update">
          <h2 class="checkout-section-title">Datos personales</h2>
          <div class="field">
            <label for="profile-name">Nombre y apellido</label>
            <input id="profile-name" name="name" type="text" required minlength="2" maxlength="80" value="${esc(actor().name)}" autocomplete="name">
          </div>
          <div class="field">
            <label for="profile-phone">Teléfono</label>
            <input id="profile-phone" name="phone" type="tel" inputmode="tel" value="${esc(actor().phone || '')}" autocomplete="tel">
          </div>
          <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Guardar perfil</button>
        </form>
        <details class="account-help" data-keep-open="cuenta-clave" ${app.openDetails.has('cuenta-clave') ? 'open' : ''}>
          <summary>Cambiar contraseña</summary>
          <form class="checkout-form" data-form="password-update">
            <div class="field">
              <label for="current-password">Contraseña actual</label>
              <input id="current-password" name="currentPassword" type="password" required autocomplete="current-password">
            </div>
            <div class="field">
              <label for="new-password">Nueva contraseña</label>
              <input id="new-password" name="password" type="password" required minlength="10" autocomplete="new-password" aria-describedby="new-password-help">
              <p class="microcopy" id="new-password-help">Al menos 10 caracteres, combinando letras y números.</p>
            </div>
            <button class="button secondary full" type="submit" ${app.online ? '' : 'disabled'}>Guardar contraseña</button>
          </form>
        </details>` : ''}
      <button class="button button-outline-danger full account-signout" type="button" data-action="sign-out">Cerrar sesión</button>`;
  }

  const identities = app.repository.capabilities.demoIdentities ? await app.repository.identities() : [];
  const tab = app.accountTab === 'crear' ? 'crear' : 'ingresar';

  return `
    ${offlineBanner()}
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header">
      <h1 class="page-title">Ingresar a MiFav</h1>
      <p class="quiet">${feature('taxi')
        ? 'Comprar y pedir un taxi no requiere cuenta. La cuenta hace falta para comercios, taxistas y administración.'
        : 'Para comprar no hace falta cuenta. La cuenta es para comercios, su equipo y administración.'}</p>
    </section>
    ${notice}

    ${app.repository.capabilities.passwordAuth ? `
      <div class="tabs account-tabs" role="tablist" aria-label="Ingresar o crear una cuenta">
        <button class="tab ${tab === 'ingresar' ? 'active' : ''}" type="button" role="tab" id="tab-ingresar"
          aria-selected="${tab === 'ingresar'}" aria-controls="cuenta-ingresar" data-action="set-account-tab" data-tab="ingresar">Ingresar</button>
        <button class="tab ${tab === 'crear' ? 'active' : ''}" type="button" role="tab" id="tab-crear"
          aria-selected="${tab === 'crear'}" aria-controls="cuenta-crear" data-action="set-account-tab" data-tab="crear">Crear cuenta</button>
      </div>

      <div class="account-panel" role="tabpanel" id="cuenta-ingresar" aria-labelledby="tab-ingresar" data-account-panel="ingresar" ${tab === 'ingresar' ? '' : 'hidden'}>
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
        ${app.repository.capabilities.accountManagement ? `
        <details class="account-help" data-keep-open="cuenta-recuperar" ${app.openDetails.has('cuenta-recuperar') ? 'open' : ''}>
          <summary>¿Olvidaste tu contraseña?</summary>
          <form class="checkout-form" data-form="password-reset">
            <div class="field">
              <label for="reset-email">Correo de tu cuenta</label>
              <input id="reset-email" name="email" type="email" required autocomplete="email" inputmode="email">
            </div>
            <button class="button secondary full" type="submit" ${app.online ? '' : 'disabled'}>Enviar enlace de recuperación</button>
            <p class="microcopy">Te llega un enlace que sirve una sola vez y dura una hora.</p>
          </form>
        </details>` : ''}
        ${app.repository.capabilities.accountManagement ? `
        <details class="account-help" data-keep-open="cuenta-reenviar" ${app.openDetails.has('cuenta-reenviar') ? 'open' : ''}>
          <summary>¿No te llegó el correo de confirmación?</summary>
          <form class="checkout-form" data-form="resend-confirmation">
            <div class="field">
              <label for="resend-email">Correo con el que te registraste</label>
              <input id="resend-email" name="email" type="email" required autocomplete="email" inputmode="email">
            </div>
            <button class="button secondary full" type="submit" ${app.online ? '' : 'disabled'}>Reenviar confirmación</button>
            <p class="microcopy">Revisá también la carpeta de correo no deseado.</p>
          </form>
        </details>` : ''}
      </div>

      <div class="account-panel" role="tabpanel" id="cuenta-crear" aria-labelledby="tab-crear" data-account-panel="crear" ${tab === 'crear' ? '' : 'hidden'}>
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
            <input id="reg-password" name="password" type="password" required minlength="10" autocomplete="new-password" aria-describedby="reg-password-help">
            <p class="microcopy" id="reg-password-help">Al menos 10 caracteres, combinando letras y números.</p>
          </div>
          <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Crear cuenta</button>
        </form>
      </div>`
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

// Llegada desde el enlace de recuperación: la sesión de recuperación ya está
// abierta y sólo falta elegir la contraseña nueva.
async function viewRecovery() {
  if (!isSignedIn()) {
    return `${backLink('#cuenta', 'Ingresar')}
      <section class="page-header"><h1 class="page-title">Recuperar contraseña</h1></section>
      <div class="notice error" role="alert"><strong>El enlace venció o ya se usó.</strong>
        Pedí uno nuevo desde “Ingresar”. Cada enlace sirve una sola vez y dura una hora.</div>
      <a class="button full" href="#cuenta">Pedir un enlace nuevo</a>`;
  }
  return `
    <section class="page-header">
      <h1 class="page-title">${app.invited ? 'Elegí tu contraseña' : 'Elegí tu nueva contraseña'}</h1>
      <p class="quiet">${app.invited ? 'Te invitaron a MiFav. Con esta contraseña vas a ingresar a partir de ahora. · ' : ''}${esc(actor().email || '')}</p>
    </section>
    <form class="checkout-form" data-form="password-recovery" novalidate>
      <div class="field">
        <label for="recovery-password">Nueva contraseña</label>
        <input id="recovery-password" name="password" type="password" required minlength="10" autocomplete="new-password">
        <p class="microcopy">Al menos 10 caracteres, combinando letras y números.</p>
      </div>
      <div class="field">
        <label for="recovery-confirm">Repetí la contraseña</label>
        <input id="recovery-confirm" name="confirm" type="password" required minlength="10" autocomplete="new-password">
      </div>
      <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Guardar contraseña</button>
    </form>`;
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
  // Con backend propio el rubro sale de la lista real; en la demostración
  // sigue siendo texto libre, como estaba.
  const categories = isSignedIn() && app.repository.capabilities.media
    ? await app.repository.query('businessCategories') : [];
  if (!isSignedIn()) {
    return `
      ${backLink('#inicio', 'Inicio')}
      <section class="page-header">
        <h1 class="page-title">Sumar mi comercio</h1>
        <p class="quiet">El alta la hace el propio comercio: creás tu cuenta, cargás tus datos y tu catálogo, y solicitás la publicación.</p>
      </section>
      <section class="brand-intro brand-intro-merchant">
        <div>${renderCharacter('merchant', 128)}</div>
        <p><strong>Tu vidriera, dentro de MiFav.</strong><span>Cargá tus datos, fotos y productos. La publicación se activa después de la revisión de MiFav.</span></p>
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
        <p class="microcopy">La aprobación de MiFav habilita la publicación dentro de la plataforma. No es una habilitación municipal ni reemplaza los permisos que cada comercio necesite.</p>
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
      ${categories.length ? `
        <div class="field">
          <label for="biz-name">Nombre comercial</label>
          <input id="biz-name" name="name" type="text" required minlength="2" maxlength="80">
        </div>
        <div class="field">
          <label for="biz-category">Rubro</label>
          <select id="biz-category" name="category" required>
            <option value="">Elegí un rubro</option>
            ${categories.map(category => `<option value="${esc(category.slug)}">${esc(category.name)}</option>`).join('')}
          </select>
        </div>` : BUSINESS_FORM_FIELDS}
      <button class="button full" type="submit" ${app.online ? '' : 'disabled'}>Crear borrador</button>
    </form>`;
}

async function viewMerchantPanel(businessId) {
  const shownToken = renderToken;
  if (!isSignedIn()) {
    // Sesión vencida o cerrada: después de ingresar vuelve a esta misma sección.
    if (businessId) app.returnTo = location.hash;
    return `${backLink('#inicio', 'Inicio')}
      <section class="page-header"><h1 class="page-title">Panel de comercio</h1></section>
      <div class="notice"><strong>Necesitás iniciar sesión.</strong> El panel muestra únicamente los datos de los comercios de tu cuenta.</div>
      <a class="button full" href="#cuenta">Ingresar</a>`;
  }

  const businesses = await app.repository.query('myBusinesses');
  if (!businessId) {
    if (businesses.length === 1 && !app.panelListShown) {
      app.panelListShown = true;
      // Ocupada hasta llegar al panel del único comercio; si mientras tanto la
      // persona fue a otra vista, no se la lleva de vuelta.
      busy.redirecting = true;
      setTimeout(() => {
        busy.redirecting = false;
        const now = route();
        if (now.page === 'panel' && !now.param) go(`#panel/${businesses[0].id}`);
        else settle();
      }, 0);
    }
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
            <span class="quiet">${esc(ROLE_NAMES[business.membershipRole] || '')}${business.membershipRole ? ' · ' : ''}${esc(BUSINESS_STATUS_HINTS[business.status] || '')}</span>
          </span>
          <span class="status-chip ${business.status === 'active' ? 'done' : business.status === 'pending_review' ? 'ready' : 'received'}">${esc(businessStatusLabel(business.status))}</span>
        </a>`).join('')}</div>`
        : emptyState('Todavía no tenés comercios', 'Creá el primero para empezar a cargar tu catálogo.', '#alta-comercio', 'Crear comercio', 'merchant')}
      <a class="button secondary full" href="#alta-comercio">Agregar otro comercio</a>`;
  }

  const business = businesses.find(candidate => candidate.id === businessId);
  if (!business) {
    return `<section class="notice error" role="alert"><h2>Sin acceso</h2><p>Ese comercio no pertenece a tu cuenta.</p>
      <a class="button secondary" href="#panel">Volver a mis comercios</a></section>`;
  }
  const role = business.membershipRole || 'owner';
  const canManage = canManageBusiness(role);
  const connected = isConnected();
  const sections = panelSections(role, { connected, payments: paymentsOnline() });
  const section = resolveSection(route().extra, sections);

  const [orders, products, riders, categories, team, serverRequirements, productCategories, riderAccounts] = await Promise.all([
    app.repository.query('businessOrders', { businessId }),
    app.repository.query('products', { businessId }),
    ['inicio', 'pedidos', 'reparto'].includes(section) ? app.repository.query('riders', { businessId }) : [],
    canManage && section === 'configuracion' && app.repository.capabilities.media ? app.repository.query('businessCategories') : [],
    section === 'equipo' ? app.repository.query('team', { businessId }) : [],
    // En el entorno conectado los requisitos de publicación los decide el servidor.
    connected && canManage && section === 'configuracion' ? app.repository.query('businessRequirements', { businessId }) : null,
    connected && section === 'catalogo' ? app.repository.query('productCategories', { businessId }) : [],
    connected && canManage && section === 'reparto' ? app.repository.query('riderAccounts', { businessId }) : {},
  ]);
  // Pagos: estado de la cuenta y números reales del día, leídos de la base.
  const paymentOverview = section === 'pagos' ? await app.repository.query('businessPaymentOverview', { businessId }) : null;
  const requirements = serverRequirements || missingPublicationRequirements(business, products);

  // Pedidos nuevos desde la última vez que el panel los mostró: aviso sonoro y
  // visual. La primera carga sólo registra lo que ya estaba. Cuenta recién al
  // mostrarse: un refresco que se descarta no los da por vistos.
  const { pending, fresh } = freshOrderIds(orders, app.seenOrders.get(businessId));
  whenShown = { token: shownToken, run() {
    app.seenOrders.set(businessId, new Set([...(app.seenOrders.get(businessId) || []), ...pending]));
    if (fresh.length) announceNewOrders(fresh.length);
    else if (!pending.length) clearOrderAlert();
    hideFloatingOrderAlert();
  } };
  app.panelSyncedAt = new Date();

  const context = { businessId: business.id, localityId: business.localityId, connected, riders, fresh,
    canManage, online: app.online, riderChoice: app.riderChoice };
  const state = openState(business);
  const operational = ['inicio', 'pedidos'].includes(section);
  if (!ORDER_FILTERS.includes(app.orderFilter)) app.orderFilter = 'activos';

  let content = '';
  if (section === 'inicio') {
    content = dashboard(business, panelSummary(orders, products), {
      newOrders: groupOrders(orders).nuevos, unavailable: products.filter(isUnavailableProduct),
      top: topProducts(orders), sales: recentSales(orders), context, canManage });
  } else if (section === 'pedidos') {
    content = ordersBoard(orders, context, { filter: app.orderFilter, businessActive: business.status === 'active' });
  } else if (section === 'catalogo') {
    content = merchantCatalogTab(business, products, { canManage, categories: productCategories });
  } else if (section === 'configuracion') {
    content = merchantDataTab(business, requirements, categories);
  } else if (section === 'horarios') {
    content = hoursEditor(business, { editable: business.status !== 'suspended', state });
  } else if (section === 'reparto') {
    content = `${deliveryBoard(deliveryBoardData(orders, riders), context, { deliveryEnabled: business.deliveryEnabled !== false })}
      ${canManage ? merchantRidersTab(business, riders, riderAccounts) : ''}`;
  } else if (section === 'equipo') {
    content = teamTab(business, team, { isOwner: role === 'owner', role });
  } else if (section === 'pagos') {
    content = paymentsSection(paymentOverview, { businessId: business.id, isOwner: role === 'owner', online: app.online,
      connection: connectionResult(location.hash) });
  }

  return `
    ${offlineBanner()}
    ${backLink('#panel', 'Mis comercios')}
    <section class="page-header panel-header">
      <span class="eyebrow">${esc(businessStatusLabel(business.status).toUpperCase())} · ${esc((ROLE_NAMES[role] || '').toUpperCase())}</span>
      <h1 class="page-title">${esc(business.name)}</h1>
      ${business.status === 'active' ? '' : `<p class="quiet">${esc(BUSINESS_STATUS_HINTS[business.status] || '')}</p>`}
    </section>

    ${['returned', 'suspended'].includes(business.status) && business.reviewNote ? `
      <div class="notice error" role="alert">
        <strong>${business.status === 'suspended' ? 'Administración suspendió el comercio.' : 'Administración devolvió la solicitud.'}</strong> ${esc(business.reviewNote)}
      </div>` : ''}

    ${operational ? '' : newOrdersBanner(business.id, pending.length)}
    ${panelNav(business.id, sections, section, { newCount: pending.length })}
    ${operational || ['horarios', 'configuracion'].includes(section) ? openBar(business, state, { canManage, online: app.online }) : ''}
    ${role === 'staff' && section === 'inicio' ? `<p class="microcopy panel-role">Tu rol: ${esc(ROLE_NAMES.staff)}. ${esc(ROLE_HINTS.staff)}</p>` : ''}
    ${(operational || section === 'reparto') && connected ? syncBar({ liveHealthy: app.liveHealthy, syncedAt: app.panelSyncedAt, soundOn: soundReady(), muted: soundMuted() }) : ''}
    ${content}`;
}

// Mientras se edita un formulario del panel la vista no se redibuja (se
// perdería lo escrito), pero un pedido nuevo igual tiene que sonar y verse:
// se consulta aparte y se avisa con un cartel fijo, fuera del formulario.
async function peekNewOrders(businessId) {
  try {
    const orders = await app.repository.query('businessOrders', { businessId });
    const seen = app.seenOrders.get(businessId);
    const { pending, fresh } = freshOrderIds(orders, seen);
    app.seenOrders.set(businessId, new Set([...(seen || []), ...pending]));
    if (!fresh.length) return;
    announceNewOrders(fresh.length);
    let alert = /** @type {HTMLAnchorElement|null} */ (document.querySelector('#panel-order-alert'));
    if (!alert) {
      alert = document.createElement('a');
      alert.id = 'panel-order-alert';
      alert.className = 'new-orders-banner is-floating';
      alert.setAttribute('role', 'status');
      document.body.append(alert);
    }
    alert.href = `#panel/${businessId}/pedidos`;
    alert.innerHTML = `${renderIcon('bell', 16)} <span><strong>${pending.length === 1 ? '1 pedido nuevo' : `${pending.length} pedidos nuevos`}</strong> ${pending.length === 1 ? 'espera' : 'esperan'} respuesta</span> <span class="new-orders-banner-cta">Ver pedidos</span>`;
    alert.hidden = false;
  } catch { /* sin red: el próximo sondeo vuelve a intentar */ }
}

function hideFloatingOrderAlert() {
  const alert = /** @type {HTMLElement|null} */ (document.querySelector('#panel-order-alert'));
  if (alert) alert.hidden = true;
}

function mediaField(id, label, current, hint) {
  return `
    <div class="field">
      <label for="${id}">${esc(label)}</label>
      ${current ? `<img class="media-preview" src="${esc(current)}" alt="" width="120" height="120" loading="lazy">` : ''}
      <input id="${id}" name="image" type="file" accept="image/jpeg,image/png,image/webp" data-preview="${id}-preview">
      <p class="microcopy">${esc(hint)}</p>
    </div>`;
}

const variantsText = product => (product.variants || []).map(variant => (variant.priceDelta
  ? `${variant.name} ${variant.priceDelta > 0 ? '+' : '-'}${Math.abs(variant.priceDelta)}` : variant.name)).join(', ');

// Formulario de producto: el mismo para crear y para editar.
function productFields(prefix, product, { connected }) {
  const value = field => esc(product?.[field] ?? '');
  const tracked = product ? product.trackStock : false;
  return `
    <div class="field">
      <label for="${prefix}-name">Nombre</label>
      <input id="${prefix}-name" name="name" type="text" required minlength="2" maxlength="80" value="${value('name')}">
    </div>
    <div class="field">
      <label for="${prefix}-description">Descripción (opcional)</label>
      <input id="${prefix}-description" name="description" type="text" maxlength="280" value="${value('description')}">
    </div>
    <div class="field-row">
      <div class="field">
        <label for="${prefix}-price">Precio en pesos</label>
        <input id="${prefix}-price" name="price" type="number" required min="1" max="10000000" step="1" inputmode="numeric" value="${value('price')}">
      </div>
      <div class="field">
        <label for="${prefix}-stock">Stock</label>
        <input id="${prefix}-stock" name="stock" type="number" min="0" max="10000" step="1" inputmode="numeric"
          value="${product ? esc(product.stock ?? '') : (connected ? '' : '10')}" ${connected ? 'placeholder="Sin control"' : 'required'}>
      </div>
    </div>
    ${connected ? `<label class="check-label">
      <input type="checkbox" name="trackStock" ${tracked ? 'checked' : ''}>
      <span>Controlar stock: MiFav descuenta cada venta y deja de vender en cero. Si no lo marcás, el producto se vende mientras esté disponible y lo marcás agotado a mano.</span>
    </label>` : ''}
    <div class="field">
      <label for="${prefix}-category">Categoría</label>
      <input id="${prefix}-category" name="category" type="text" required maxlength="40" list="categorias" value="${esc(product?.category || 'Otros')}">
    </div>
    <div class="field">
      <label for="${prefix}-condition">Condición</label>
      <select id="${prefix}-condition" name="condition" required>
        ${Object.entries(PRODUCT_CONDITIONS).map(([code, label]) => `<option value="${esc(code)}"
          ${normalizeProductCondition(product?.condition) === code ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <p class="microcopy">Se muestra en la ficha pública. Un artículo usado tiene que describir su estado.</p>
    </div>
    <div class="field">
      <label for="${prefix}-variants">Variantes (opcional)</label>
      <input id="${prefix}-variants" name="variants" type="text" maxlength="200" value="${esc(product ? variantsText(product) : '')}"
        placeholder="Chica, Grande +2000, Familiar +5000">
      <p class="microcopy">Separadas por coma. El número suma o resta sobre el precio base. Si cargás variantes, quien compra elige una.</p>
    </div>`;
}

function categoryManager(business, categories, products) {
  const bid = esc(business.id);
  const counts = new Map();
  for (const product of products) if (!product.archived && product.categoryId) counts.set(product.categoryId, (counts.get(product.categoryId) || 0) + 1);
  return `<details class="panel-disclosure" data-keep-open="catalog-categories" ${app.openDetails.has('catalog-categories') ? 'open' : ''}>
    <summary>Categorías (${categories.length})</summary>
    <p class="microcopy">El orden de esta lista es el que ve el cliente. Una categoría desactivada deja de mostrarse como sección: sus productos siguen a la venta, dentro de “Otros”. Para dejar de vender un producto, desactivalo a él.</p>
    ${categories.length ? `<ul class="plain-list category-list">${categories.map((category, index) => `
      <li class="category-item ${category.active ? '' : 'is-inactive'}">
        <form class="inline-form" data-form="category-rename" data-business="${bid}" data-category="${esc(category.id)}">
          <label class="visually-hidden" for="cat-${esc(category.id)}">Nombre de la categoría ${esc(category.name)}</label>
          <input id="cat-${esc(category.id)}" name="name" type="text" required minlength="2" maxlength="40" value="${esc(category.name)}">
          <button class="button secondary" type="submit">Guardar</button>
        </form>
        <span class="category-meta quiet">${counts.get(category.id) || 0} productos${category.active ? '' : ' · desactivada'}</span>
        <span class="category-actions">
          <button class="link-button" type="button" data-action="category-move" data-business="${bid}" data-category="${esc(category.id)}"
            data-direction="up" ${index === 0 ? 'disabled' : ''} aria-label="Subir ${esc(category.name)}">Subir</button>
          <button class="link-button" type="button" data-action="category-move" data-business="${bid}" data-category="${esc(category.id)}"
            data-direction="down" ${index === categories.length - 1 ? 'disabled' : ''} aria-label="Bajar ${esc(category.name)}">Bajar</button>
          <button class="link-button ${category.active ? 'danger' : ''}" type="button" data-action="category-toggle" data-business="${bid}"
            data-category="${esc(category.id)}" data-active="${category.active ? 'false' : 'true'}">${category.active ? 'Desactivar' : 'Activar'}</button>
        </span>
      </li>`).join('')}</ul>` : '<p class="quiet">Todavía no hay categorías. Se crean solas al cargar un producto, o acá.</p>'}
    <form class="inline-form category-create" data-form="category-create" data-business="${bid}">
      <label class="visually-hidden" for="cat-new">Nueva categoría</label>
      <input id="cat-new" name="name" type="text" required minlength="2" maxlength="40" placeholder="Nueva categoría">
      <button class="button" type="submit" ${app.online ? '' : 'disabled'}>Agregar categoría</button>
    </form>
  </details>`;
}

/** @param {any} business @param {any[]} products @param {{ canManage?: boolean, categories?: any[] }} [options] */
function merchantCatalogTab(business, products, { canManage = true, categories = [] } = {}) {
  const media = Boolean(app.repository.capabilities.media);
  const connected = isConnected();
  const bid = esc(business.id);
  const disabled = app.online ? '' : 'disabled';
  const categoryOptions = [...new Set([...categories.map(category => category.name), ...PRODUCT_CATEGORIES_SUGGESTED])];
  // Mismo orden que ve el cliente: categorías por posición, "Otros" al final.
  const rank = new Map(categories.map((category, index) => [category.id, index]));
  const groups = new Map();
  for (const product of products) {
    const key = product.categoryId || `sin:${product.category}`;
    if (!groups.has(key)) groups.set(key, { key, label: product.category || 'Otros', rank: rank.get(product.categoryId) ?? 999, items: [] });
    groups.get(key).items.push(product);
  }
  const ordered = [...groups.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const live = products.filter(product => !product.archived);
  const unavailable = live.filter(product => product.available === false || (product.trackStock && product.stock <= 0)).length;
  const stockLabel = product => (!connected || product.trackStock ? `stock ${product.stock}` : 'sin control de stock');
  // Precio (y stock, si se controla) sin abrir el formulario completo: lo que
  // más se toca desde el teléfono.
  const quickEdit = product => {
    const pid = esc(product.id);
    const tracked = !connected || product.trackStock;
    return `<form class="inline-form catalog-quick" data-form="product-quick" data-business="${bid}" data-product="${pid}"
      data-tracked="${tracked ? 'true' : 'false'}">
      <label for="quick-price-${pid}">Precio</label>
      <input id="quick-price-${pid}" name="price" type="number" required min="1" max="10000000" step="1" inputmode="numeric" value="${esc(product.price)}">
      ${tracked ? `<label for="quick-stock-${pid}">Stock</label>
      <input id="quick-stock-${pid}" name="stock" type="number" required min="0" max="10000" step="1" inputmode="numeric" value="${esc(product.stock ?? 0)}">` : ''}
      <button class="button secondary" type="submit" ${disabled}>Guardar</button>
    </form>`;
  };

  const row = product => `
    <article class="catalog-row ${product.archived ? 'is-archived' : ''}" aria-label="Producto ${esc(product.name)}">
      <div class="catalog-row-head">
        ${media ? productThumb(product, product.name, 'catalog-row-thumb') : ''}
        <div class="catalog-row-main">
          <strong>${esc(product.name)}</strong>
          <span class="quiet">${money(product.price)} · ${esc(stockLabel(product))}</span>
          ${(product.variants || []).length ? `<span class="quiet">Variantes: ${esc(variantsText(product))}</span>` : ''}
          ${product.archived ? '<span class="status-chip cancelled">Desactivado</span>'
            : product.available === false ? '<span class="status-chip received">No disponible</span>'
              : connected && product.trackStock && product.stock <= 0 ? '<span class="status-chip received">Sin stock</span>' : ''}
        </div>
      </div>
      <div class="catalog-row-actions">
        ${product.archived ? '' : `<button class="link-button" type="button" data-action="product-toggle" data-business="${bid}"
          data-product="${esc(product.id)}" data-field="available" data-value="${product.available ? 'false' : 'true'}" ${disabled}>
          ${product.available ? 'Marcar agotado' : 'Marcar disponible'}</button>`}
        ${canManage ? `<button class="link-button ${product.archived ? '' : 'danger'}" type="button" data-action="product-toggle" data-business="${bid}"
          data-product="${esc(product.id)}" data-field="archived" data-value="${product.archived ? 'false' : 'true'}" ${disabled}>
          ${product.archived ? 'Reactivar' : 'Desactivar'}</button>` : ''}
      </div>
      ${canManage && !product.archived ? quickEdit(product) : ''}
      ${!canManage && connected && product.trackStock && !product.archived ? `<form class="inline-form" data-form="product-stock" data-business="${bid}"
        data-product="${esc(product.id)}" data-available="${product.available ? 'true' : 'false'}">
        <label class="visually-hidden" for="stock-${esc(product.id)}">Stock de ${esc(product.name)}</label>
        <input id="stock-${esc(product.id)}" name="stock" type="number" min="0" max="10000" step="1" value="${product.stock}" inputmode="numeric">
        <button class="button secondary" type="submit" ${disabled}>Guardar stock</button>
      </form>` : ''}
      ${canManage && !product.archived ? `<details class="catalog-edit" data-keep-open="product-${esc(product.id)}" ${app.openDetails.has(`product-${product.id}`) ? 'open' : ''}>
        <summary>Editar ${esc(product.name)}</summary>
        <form class="checkout-form" data-form="product-edit" data-business="${bid}" data-product="${esc(product.id)}">
          ${productFields(`edit-${esc(product.id)}`, product, { connected })}
          <button class="button full" type="submit" ${disabled}>Guardar cambios</button>
        </form>
        ${media ? `<form class="inline-form" data-form="product-image" data-business="${bid}" data-product="${esc(product.id)}">
          <label class="visually-hidden" for="photo-${esc(product.id)}">Foto de ${esc(product.name)}</label>
          <input id="photo-${esc(product.id)}" name="image" type="file" accept="image/jpeg,image/png,image/webp">
          <button class="button secondary" type="submit" ${disabled}>${product.image ? 'Cambiar foto' : 'Subir foto'}</button>
          ${product.image ? `<button class="link-button danger" type="button" data-action="product-photo-remove"
            data-business="${bid}" data-product="${esc(product.id)}">Quitar foto</button>` : ''}
        </form>` : ''}
      </details>` : ''}
    </article>`;

  const createOpen = !products.length || app.openDetails.has('catalog-new');
  return `
    <p class="catalog-summary quiet">${live.length} ${live.length === 1 ? 'producto a la venta' : 'productos a la venta'}${unavailable ? ` · ${unavailable} no disponibles` : ''}${products.length - live.length ? ` · ${products.length - live.length} desactivados` : ''}</p>
    ${canManage ? `<details class="panel-disclosure" data-keep-open="catalog-new" ${createOpen ? 'open' : ''}>
      <summary>Agregar producto</summary>
      <form class="checkout-form" data-form="product-create" data-business="${bid}">
        ${productFields('prod', null, { connected })}
        ${media ? mediaField('prod-image', 'Foto del producto (opcional)', '',
          'JPEG, PNG o WebP, hasta 5 MB. El producto se publica igual si todavía no tenés foto.')
          : '<p class="microcopy">Las fotos se toman de las imágenes incluidas en el proyecto. La carga de fotos propias no está implementada en este entorno.</p>'}
        <button class="button full" type="submit" ${disabled}>Agregar al catálogo</button>
      </form>
    </details>` : `<p class="microcopy">Tu rol en el equipo permite marcar productos agotados o disponibles${connected ? ' y actualizar el stock de los que lo controlan' : ''}.</p>`}
    ${canManage ? `<datalist id="categorias">${categoryOptions.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>` : ''}
    ${canManage && connected ? categoryManager(business, categories, products) : ''}
    ${products.length ? ordered.map(group => `
      <section class="panel-section catalog-group" aria-label="Categoría ${esc(group.label)}">
        <h2 class="checkout-section-title">${esc(group.label)} (${group.items.length})</h2>
        <div class="stack">${group.items.map(row).join('')}</div>
      </section>`).join('')
      : `<p class="quiet">Todavía no cargaste productos.${canManage ? ' Empezá por el formulario de arriba.' : ''}</p>`}`;
}

// Qué ofrece el comercio: los códigos habilitados salen del rubro elegido; la
// base valida que la selección sea un subconjunto y rechaza el resto.
function capabilitiesEditor(business, categories, disabled) {
  const category = categories.find(item => item.slug === business.categorySlug);
  const allowed = category?.capabilities || [];
  const active = Array.isArray(business.capabilities) ? business.capabilities : [];
  if (!allowed.length) {
    return category ? ''
      : '<p class="microcopy">Elegí el rubro para definir qué puede ofrecer el comercio.</p>';
  }
  const boxes = allowed.map(code => {
    const checked = active.includes(code) ? 'checked' : '';
    return `<label class="check-label">
      <input type="checkbox" name="capability-${esc(code)}" value="${esc(code)}" ${checked} ${disabled}>
      <span>${esc(capabilityLabel(code))}</span>
    </label>`;
  }).join('');
  return `<fieldset class="field capability-field">
    <legend class="visually-hidden">Qué ofrece el comercio</legend>
    ${boxes}
    <p class="microcopy">Las opciones dependen del rubro del comercio: la base no acepta capacidades fuera del rubro.</p>
  </fieldset>`;
}

function merchantDataTab(business, missing, categories = []) {
  const editable = !['pending_review', 'suspended'].includes(business.status);
  const media = Boolean(app.repository.capabilities.media);
  const connected = isConnected();
  const disabled = editable ? '' : 'disabled';
  // Un comercio que ya opera cambia a diario envío, mínimo y tiempos: van
  // arriba, con su propio botón. Uno nuevo empieza por sus datos.
  const operationFirst = ['active', 'paused'].includes(business.status);
  const capabilitiesField = connected ? capabilitiesEditor(business, categories, disabled) : '';
  const details = `
        <h2 class="checkout-section-title">Datos del comercio</h2>
        <div class="field">
          <label for="b-name">Nombre comercial</label>
          <input id="b-name" name="name" type="text" required maxlength="80" value="${esc(business.name)}" ${disabled}>
        </div>
        <div class="field">
          <label for="b-category">Rubro</label>
          ${categories.length ? `<select id="b-category" name="category" ${disabled}>
            <option value="">Elegí un rubro</option>
            ${categories.map(category => `<option value="${esc(category.slug)}" ${category.name === business.category ? 'selected' : ''}>${esc(category.name)}</option>`).join('')}
          </select>`
          : `<input id="b-category" name="category" type="text" maxlength="40" value="${esc(business.category || '')}" ${disabled}>`}
        </div>
        ${capabilitiesField}
        ${connected ? `<div class="field">
          <label for="b-description">Descripción corta</label>
          <input id="b-description" name="description" type="text" maxlength="280" value="${esc(business.description || '')}"
            placeholder="Qué vendés, en una frase" ${disabled}>
        </div>` : ''}
        <div class="field">
          <label for="b-owner">Responsable</label>
          <input id="b-owner" name="ownerName" type="text" maxlength="80" value="${esc(business.ownerName || '')}" ${disabled}>
        </div>
        <div class="field">
          <label for="b-phone">Teléfono de contacto con MiFav</label>
          <input id="b-phone" name="contactPhone" type="tel" inputmode="tel" value="${esc(business.contactPhone || '')}" ${disabled}>
          ${connected ? '<p class="microcopy">Privado: sólo lo ve administración de MiFav.</p>' : ''}
        </div>
        ${connected ? `<div class="field-row">
          <div class="field">
            <label for="b-public-phone">Teléfono para clientes</label>
            <input id="b-public-phone" name="publicPhone" type="tel" inputmode="tel" value="${esc(business.publicPhone || '')}" ${disabled}>
          </div>
          <div class="field">
            <label for="b-whatsapp">WhatsApp para clientes</label>
            <input id="b-whatsapp" name="whatsapp" type="tel" inputmode="tel" value="${esc(business.whatsapp || '')}" ${disabled}>
          </div>
        </div>
        <p class="microcopy">Se muestran en tu página para que te consulten por un pedido.</p>` : ''}
        <div class="field">
          <label for="b-address">Dirección</label>
          <input id="b-address" name="address" type="text" maxlength="120" value="${esc(business.address || '')}" ${disabled}>
        </div>
        <div class="field">
          <label for="b-reference">Referencias para llegar</label>
          <input id="b-reference" name="reference" type="text" maxlength="120" value="${esc(business.reference || '')}" ${disabled}>
        </div>
        <div class="field">
          <label for="b-hours">Horarios (texto que ve el cliente)</label>
          <input id="b-hours" name="hoursLabel" type="text" maxlength="80" value="${esc(business.hoursLabel || '')}"
            placeholder="Lunes a sábado de 9 a 13 y de 17 a 21" ${disabled}>
          ${connected ? '<p class="microcopy">Los horarios que controlan cuándo se toman pedidos se cargan en la pestaña Horarios.</p>' : ''}
        </div>`;
  const operation = `
        <h2 class="checkout-section-title" id="operacion">Envío, pedidos y tiempos</h2>
        <label class="check-label">
          <input type="checkbox" name="pickupEnabled" ${business.pickupEnabled ? 'checked' : ''} ${disabled}>
          <span>Retiro en el comercio</span>
        </label>
        <label class="check-label">
          <input type="checkbox" name="deliveryEnabled" ${business.deliveryEnabled ? 'checked' : ''} ${disabled}>
          <span>Envío con reparto propio</span>
        </label>
        <div class="field">
          <label for="b-zone">Zona de envío</label>
          <input id="b-zone" name="deliveryZone" type="text" maxlength="80" value="${esc(business.deliveryZone || '')}"
            placeholder="Neuquén Capital y zonas de reparto" ${disabled}>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="b-fee">Costo de envío en pesos</label>
            <input id="b-fee" name="deliveryFee" type="number" min="0" step="1" value="${business.deliveryFee || 0}" inputmode="numeric" ${disabled}>
          </div>
          <div class="field">
            <label for="b-min">Pedido mínimo para envío</label>
            <input id="b-min" name="minimumOrder" type="number" min="0" step="1" value="${business.minimumOrder || 0}" inputmode="numeric" ${disabled}>
          </div>
        </div>
        ${connected ? `<div class="field-row">
          <div class="field">
            <label for="b-prep">Preparación estimada (minutos)</label>
            <input id="b-prep" name="prepMinutes" type="number" min="5" max="240" step="5" value="${business.prepMinutes ?? ''}" inputmode="numeric" ${disabled}>
          </div>
          <div class="field">
            <label for="b-delivery-min">Envío estimado (minutos)</label>
            <input id="b-delivery-min" name="deliveryMinutes" type="number" min="5" max="240" step="5" value="${business.deliveryMinutes ?? ''}" inputmode="numeric" ${disabled}>
          </div>
        </div>` : ''}`;
  return `
    <section class="panel-section">
      ${business.status === 'pending_review'
        ? '<div class="notice">La solicitud está en revisión. Vas a poder editar cuando administración responda.</div>' : ''}
      <form class="checkout-form" data-form="business-update" data-business="${esc(business.id)}">
        ${operationFirst ? `${operation}
        <button class="button full" type="submit" ${editable && app.online ? '' : 'disabled'}>Guardar envío y tiempos</button>
        ${details}` : `${details}${operation}`}
        <button class="button full" type="submit" ${editable && app.online ? '' : 'disabled'}>Guardar datos</button>
      </form>
    </section>

    ${media ? `<section class="panel-section">
      <h2 class="checkout-section-title">Imagen del comercio</h2>
      <p class="quiet">Las imágenes se guardan en MiFav, dentro de la carpeta de tu comercio. Nadie más puede escribir ahí.</p>
      <form class="checkout-form" data-form="business-media" data-business="${esc(business.id)}" data-slot="logo">
        ${mediaField('biz-logo', 'Logo', business.logo, 'Cuadrada, JPEG, PNG o WebP, hasta 5 MB.')}
        <div class="modal-actions">
          <button class="button" type="submit" ${app.online ? '' : 'disabled'}>Guardar logo</button>
          ${business.logo ? `<button class="link-button danger" type="button" data-action="business-media-remove"
            data-business="${esc(business.id)}" data-slot="logo">Quitar logo</button>` : ''}
        </div>
      </form>
      <form class="checkout-form" data-form="business-media" data-business="${esc(business.id)}" data-slot="cover">
        ${mediaField('biz-cover', 'Portada', business.cover, 'Apaisada, JPEG, PNG o WebP, hasta 5 MB.')}
        <div class="modal-actions">
          <button class="button" type="submit" ${app.online ? '' : 'disabled'}>Guardar portada</button>
          ${business.cover ? `<button class="link-button danger" type="button" data-action="business-media-remove"
            data-business="${esc(business.id)}" data-slot="cover">Quitar portada</button>` : ''}
        </div>
      </form>
    </section>` : ''}

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
          data-business="${esc(business.id)}" data-status="paused">Pausar el comercio</button>
        <p class="microcopy">Pausado no aparece en MiFav ni recibe pedidos. Para un día sin atención alcanza con “Cerrar atención”.</p>` : ''}
      ${business.status === 'paused' ? `
        <button class="button full" type="button" data-action="business-status"
          data-business="${esc(business.id)}" data-status="active">Reactivar el comercio</button>` : ''}
      <p class="microcopy">La aprobación de MiFav habilita la publicación dentro de la plataforma. No constituye una habilitación municipal ni reemplaza los permisos que cada comercio deba tener.</p>
    </section>`;
}

function merchantRidersTab(business, riders, accounts = {}) {
  const connected = isConnected();
  const disabled = app.online ? '' : 'disabled';
  return `
    <section class="panel-section">
      <h2 class="checkout-section-title">Reparto del comercio</h2>
      <p class="quiet">Cada comercio administra su propio reparto. MiFav no opera una flota.</p>
      ${connected ? `<p class="microcopy">Con una cuenta de MiFav vinculada, la persona ve en su teléfono (Mis entregas) sólo los
        pedidos que le asignes: marca retiro, salida y llegada, y entrega con el código del cliente. Sin cuenta, seguís marcando
        cada paso desde acá.</p>` : ''}
      ${riders.length ? `<ul class="plain-list rider-list">${riders.map(rider => `
        <li class="${rider.active === false ? 'is-inactive' : ''}"><span><strong>${esc(rider.name)}</strong>${rider.phone ? ` · ${esc(rider.phone)}` : ''}${rider.active === false ? ' · <span class="quiet">inactivo</span>' : ''}
          ${connected ? `<span class="rider-account">${rider.linked
            ? `${renderIcon('check', 12)} Cuenta vinculada${accounts[rider.id] ? `: ${esc(accounts[rider.id])}` : ''}`
            : 'Sin cuenta vinculada'}</span>` : ''}</span>
          ${connected ? `<span class="rider-row-actions">
            <button class="link-button" type="button" data-action="rider-toggle" data-rider="${esc(rider.id)}"
              data-active="${rider.active === false ? 'true' : 'false'}">${rider.active === false ? 'Reactivar' : 'Pausar'}</button>
            ${rider.linked ? `<button class="link-button" type="button" data-action="rider-unlink" data-rider="${esc(rider.id)}"
              data-name="${esc(rider.name)}" ${disabled}>Desvincular cuenta</button>` : ''}
          </span>` : ''}
          ${connected && !rider.linked && rider.active !== false ? `<form class="inline-form rider-link" data-form="rider-link" data-rider="${esc(rider.id)}">
            <label class="visually-hidden" for="rider-link-${esc(rider.id)}">Correo de la cuenta de ${esc(rider.name)}</label>
            <input id="rider-link-${esc(rider.id)}" name="email" type="email" inputmode="email" autocomplete="off" required
              maxlength="254" placeholder="Correo de su cuenta de MiFav">
            <button class="button secondary" type="submit" ${disabled}>Vincular cuenta</button>
          </form>` : ''}</li>`).join('')}</ul>`
        : '<p class="quiet">Todavía no cargaste personas de reparto. Si repartís vos, cargate con tu nombre.</p>'}
      <form class="checkout-form" data-form="rider-create" data-business="${esc(business.id)}">
        <div class="field">
          <label for="rider-name">Nombre</label>
          <input id="rider-name" name="name" type="text" required minlength="2" maxlength="60">
        </div>
        <div class="field">
          <label for="rider-phone">Teléfono (opcional)</label>
          <input id="rider-phone" name="phone" type="tel" inputmode="tel" maxlength="24">
        </div>
        <button class="button full" type="submit" ${disabled}>Agregar al reparto</button>
      </form>
    </section>`;
}

// ───────────────────────── reparto ─────────────────────────

// Quien reparte para un comercio, desde el teléfono. La base le entrega sólo
// sus pedidos (rider_orders) y decide cada paso; la interfaz sólo los ordena.
async function viewRider() {
  if (!isConnected()) {
    return `${backLink('#inicio', 'Inicio')}
      <section class="page-header"><h1 class="page-title">Mis entregas</h1></section>
      <div class="notice">Las entregas desde el teléfono funcionan con MiFav conectado. En esta demostración el comercio
        marca cada paso desde su panel.</div>`;
  }
  if (!isSignedIn()) {
    // Después de ingresar vuelve acá.
    app.returnTo = '#entregas';
    return `${backLink('#inicio', 'Inicio')}
      <section class="page-header">
        <h1 class="page-title">Mis entregas</h1>
        <p class="quiet">Ingresá con la cuenta que el comercio vinculó a tu reparto.</p>
      </section>
      <a class="button full" href="#cuenta">Ingresar</a>`;
  }
  const [orders, riders] = await Promise.all([
    app.repository.query('riderOrders'),
    app.repository.query('myRiderProfiles'),
  ]);
  if (!riders.some(rider => rider.active) && !orders.length) {
    return `${offlineBanner()}${riderUnlinked(actor().email, { paused: riders.length > 0 })}`;
  }
  const feedback = app.riderFeedback && orders.some(order => order.id === app.riderFeedback.orderId) ? app.riderFeedback : null;
  return `${offlineBanner()}${riderHome({ orders, riders, online: app.online, updatedAt: new Date().toISOString(), feedback })}`;
}

// ───────────────────────── administración ─────────────────────────

async function viewAdmin() {
  if (!hasRole('admin')) {
    return `${backLink('#inicio', 'Inicio')}
      <section class="page-header"><h1 class="page-title">Administración</h1></section>
      <div class="notice error"><strong>Sección restringida.</strong> Requiere una cuenta con rol de administración.</div>
      <a class="button full" href="#cuenta">Ingresar</a>`;
  }
  const [queue, metrics, events, pilot] = await Promise.all([
    app.repository.query('adminQueue'),
    app.repository.query('adminMetrics'),
    isConnected() ? app.repository.query('adminClientEvents').catch(() => []) : [],
    // El día del piloto: si no se puede leer, el resto de la administración sigue.
    isConnected() ? app.repository.query('adminPilotMetrics').catch(() => null) : null,
  ]);
  const todayOf = new Map((pilot?.perBusiness || []).map(item => [item.id, item]));
  const published = (queue.allBusinesses || []).filter(item => ['active', 'paused'].includes(item.status));
  const suspended = (queue.allBusinesses || []).filter(item => item.status === 'suspended');

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
  const pendingCount = queue.businesses.length + (feature('taxi') ? queue.drivers.length : 0);

  // Primero lo que espera una decisión, después lo que necesita atención y
  // recién ahí los números. Lo histórico y los errores, plegados.
  return `
    ${offlineBanner()}
    <section class="page-header admin-header">
      <div>
        <h1 class="page-title">Administración</h1>
        <p class="quiet">${pendingCount ? `${pluralize(pendingCount, 'solicitud espera', 'solicitudes esperan')} revisión.` : 'Sin solicitudes pendientes.'}
          ${!pilot ? '' : (pilot.stuckTotal ?? pilot.stuck.length)
            ? ` ${pluralize(pilot.stuckTotal ?? pilot.stuck.length, 'pedido necesita', 'pedidos necesitan')} atención.`
            : ' Ningún pedido demorado.'}</p>
      </div>
      ${isConnected() ? `<button class="button secondary" type="button" data-action="retry">${renderIcon('refresh', 16)} Actualizar</button>` : ''}
    </section>

    <section class="panel-section">
      <h2 class="checkout-section-title">Comercios pendientes (${queue.businesses.length})</h2>
      ${queue.businesses.length ? `<div class="stack">${queue.businesses.map(item => reviewCard(item, 'business')).join('')}</div>`
        : '<p class="quiet">No hay comercios esperando revisión.</p>'}
    </section>

    ${feature('taxi') ? `<section class="panel-section">
      <h2 class="checkout-section-title">Taxistas pendientes (${queue.drivers.length})</h2>
      ${queue.drivers.length ? `<div class="stack">${queue.drivers.map(item => reviewCard(item, 'driver')).join('')}</div>`
        : '<p class="quiet">No hay altas de conductores esperando revisión.</p>'}
    </section>` : ''}

    ${pilot ? `${pilotIncidents(pilot.stuck, pilot.stuckTotal)}${pilotToday(pilot)}` : isConnected()
      ? '<div class="notice error" role="alert">No se pudieron leer los números de hoy. Actualizá en un momento.</div>' : ''}

    ${isConnected() ? `<section class="panel-section">
      <h2 class="checkout-section-title">Comercios publicados (${published.length})</h2>
      ${published.length ? `<ul class="plain-list admin-business-list">${published.map(item => `
        <li>
          <span class="admin-business-main"><strong>${esc(item.name)}</strong>
            <span class="status-chip ${item.status === 'active' ? 'done' : 'received'}">${esc(businessStatusLabel(item.status))}</span>
            <span class="quiet">${esc(item.category || 'sin rubro')}</span>
            ${businessTodayLine(todayOf.get(item.id))}</span>
          <button class="link-button danger admin-business-action" type="button" data-action="admin-business-status" data-business="${esc(item.id)}"
            data-status="suspended" data-name="${esc(item.name)}">Suspender</button></li>`).join('')}</ul>`
        : '<p class="quiet">Todavía no hay comercios publicados.</p>'}
      ${suspended.length ? `<h3 class="checkout-section-title">Suspendidos (${suspended.length})</h3>
      <ul class="plain-list admin-business-list">${suspended.map(item => `
        <li><span class="admin-business-main"><strong>${esc(item.name)}</strong>${item.reviewNote ? ` <span class="quiet">${esc(item.reviewNote)}</span>` : ''}</span>
          <button class="link-button admin-business-action" type="button" data-action="admin-business-status" data-business="${esc(item.id)}"
            data-status="active" data-name="${esc(item.name)}">Rehabilitar</button></li>`).join('')}</ul>` : ''}
    </section>` : ''}

    ${isConnected() ? `<details class="panel-section admin-fold">
      <summary><span class="checkout-section-title">Errores recientes en dispositivos (${events.length})</span></summary>
      ${events.length ? `<ul class="plain-list event-list">${events.map(event => `
        <li><span class="quiet">${esc(shortDate(event.created_at))}</span> · <strong>${esc(event.kind)}</strong> · ${esc(event.code)}
          ${event.route ? `· ${esc(event.route)}` : ''}<br><span class="microcopy">${esc(event.message)}</span></li>`).join('')}</ul>`
        : '<p class="quiet">Sin errores registrados.</p>'}
      <p class="microcopy">Sin datos personales: correos, teléfonos y tokens se descartan antes de guardar.</p>
    </details>` : ''}

    <details class="panel-section admin-fold" ${isConnected() ? '' : 'open'}>
      <summary><span class="checkout-section-title">Operación registrada desde el inicio</span></summary>
      <p class="microcopy">Origen: ${esc(metrics.source)} Nada de esto es una proyección ni una estimación.</p>
      <dl class="metrics-grid">
        ${counter('Comercios publicados', metrics.businesses.active || 0)}
        ${counter('Comercios en revisión', metrics.businesses.pending_review || 0)}
        ${feature('taxi') ? counter('Taxistas habilitados', metrics.drivers.active || 0) : ''}
        ${counter('Pedidos registrados', metrics.orders.total)}
        ${counter('Pedidos entregados', metrics.orders.delivered)}
        ${counter('Pedidos cancelados', metrics.orders.canceled)}
        ${feature('taxi') ? counter('Viajes solicitados', metrics.trips.total) : ''}
        ${feature('taxi') ? counter('Viajes aceptados', metrics.trips.accepted) : ''}
      </dl>
      <p class="microcopy">Vista agregada: no incluye direcciones de clientes, teléfonos ni recorridos individuales.</p>
    </details>`;
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
            placeholder="Dirección o lugar de Neuquén Capital" value="${esc(stored.origin || '')}">
          <button class="link-button" type="button" data-action="use-location">Usar mi ubicación (opcional)</button>
          <p class="microcopy">Podés escribir la dirección a mano. La ubicación del teléfono es opcional y sólo se pide si la tocás.</p>
        </div>
        <div class="field">
          <label for="taxi-destination">Hasta</label>
          <input id="taxi-destination" name="destination" type="text" required minlength="3" maxlength="120"
            placeholder="Dirección o lugar de Neuquén Capital" value="${esc(stored.destination || '')}">
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
        <p class="quiet">La tarifa y el tiempo de llegada se coordinan con el conductor. MiFav no publica tarifas ni estimaciones de llegada:
          todavía no hay un cuadro tarifario ni datos de operación validados en Neuquén Capital.</p>
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
          los seguros, el cuadro tarifario y las condiciones de operación. MiFav todavía no verifica ninguno de esos requisitos.</p>
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
        <p class="microcopy">La aprobación en MiFav habilita el uso de la plataforma en el piloto. No acredita habilitación municipal,
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

async function viewInstitutionalConnected() {
  const counts = await app.repository.query('snapshotCounts');
  return `
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header">
      <span class="eyebrow">MIFAV · NEUQUÉN CAPITAL</span>
      <h1 class="page-title">Qué es MiFav</h1>
      <p class="quiet">El marketplace de Neuquén Capital para comprar y vender productos nuevos y usados
        de comercios y emprendimientos locales, con trato directo con cada vendedor.</p>
    </section>
    <section class="checkout-section">
      <h2 class="checkout-section-title">Para quienes compran</h2>
      <ul class="plain-list">
        <li>Buscás por producto, rubro o tienda y filtrás por condición, retiro o envío.</li>
        <li>Podés guardar favoritos en este navegador, sin crear una cuenta.</li>
        <li>El retiro y el envío los coordina cada vendedor. MiFav no inventa costos ni tiempos.</li>
        <li>Pagás directamente al vendedor, al retirar o al recibir. MiFav no cobra nada.</li>
        <li>Si el comercio lo habilita, podés contactarlo por WhatsApp desde la ficha.</li>
      </ul>
    </section>
    <section class="checkout-section">
      <h2 class="checkout-section-title">Para los comercios</h2>
      <ul class="plain-list">
        <li>Creás tu cuenta, completás los datos del comercio y solicitás la revisión del alta.</li>
        <li>Cargás productos con foto, precio, condición y disponibilidad desde el panel.</li>
        <li>Recibís los pedidos en un panel que funciona en el celular, con aviso sonoro.</li>
        <li>Administrás tu propio reparto y sumás a tu equipo con distintos permisos.</li>
      </ul>
      <div class="notice"><strong>La publicación de un comercio nuevo pasa por revisión administrativa.</strong>
        No prometemos publicación instantánea: la vidriera se activa cuando el alta está aprobada.</div>
      <a class="button full" href="#publicar">Publicar un producto</a>
    </section>
    <section class="checkout-section">
      <h2 class="checkout-section-title">Responsabilidades</h2>
      <ul class="plain-list">
        <li><strong>LUNA</strong> desarrolla y opera la plataforma y revisa las altas dentro de MiFav.</li>
        <li><strong>Cada vendedor</strong> responde por sus precios, su stock, la preparación, su reparto y las habilitaciones de su actividad.</li>
        <li>La aprobación de MiFav habilita la publicación en la plataforma; no es una habilitación municipal ni reemplaza los permisos que cada comercio necesite.</li>
        <li>El servicio de taxi de MiFav sigue disponible como vertical aparte y conserva sus propias condiciones.</li>
      </ul>
    </section>
    <section class="checkout-section">
      <h2 class="checkout-section-title">Hoy en MiFav</h2>
      <dl class="metrics-grid">
        <div class="metric"><dt>Comercios publicados</dt><dd>${counts.activeBusinesses}</dd></div>
        <div class="metric"><dt>Productos disponibles</dt><dd>${counts.products}</dd></div>
      </dl>
    </section>`;
}

async function viewInstitutional() {
  if (isConnected()) return viewInstitutionalConnected();
  const counts = await app.repository.query('snapshotCounts');
  return `
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header">
      <span class="eyebrow">MIFAV · NEUQUÉN CAPITAL</span>
      <h1 class="page-title">Qué es MiFav y qué propone</h1>
      <p class="quiet">Marketplace local de LUNA para comercios y emprendimientos de Neuquén Capital.
        Este documento describe una propuesta: no hay convenio firmado ni prestadores incorporados.</p>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Qué permite hacer hoy</h2>
      <ul class="plain-list">
        <li>Que una persona busque productos nuevos y usados por rubro, tienda y modalidad de entrega.</li>
        <li>Que un comercio se dé de alta, cargue su catálogo y solicite la publicación.</li>
        <li>Que administración revise cada alta y la apruebe o la devuelva con observaciones.</li>
        <li>Que una persona compre con retiro en el comercio o con envío coordinado con el vendedor.</li>
        <li>Que el comercio gestione sus pedidos y asigne su propio reparto.</li>
      </ul>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Cómo se incorpora un vendedor</h2>
      <ol class="steps-list">
        <li><strong>Comercio:</strong> crea su cuenta, completa datos y modalidades de entrega, carga su catálogo y solicita la publicación. La revisión es administrativa y queda registrada.</li>
        <li><strong>Feria:</strong> la participación y el operativo de retiro los confirma la organización. Hasta entonces no publicamos fechas, ubicaciones ni imágenes de evento.</li>
      </ol>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Responsabilidades</h2>
      <ul class="plain-list">
        <li><strong>LUNA:</strong> desarrolla y opera la plataforma, revisa las altas dentro de MiFav, y sostiene el soporte técnico del piloto.</li>
        <li><strong>Comercios y emprendimientos:</strong> responden por sus precios, su stock, la descripción del estado de cada artículo usado, su reparto y las habilitaciones que su actividad requiera.</li>
        <li><strong>Taxistas de MiFav:</strong> responden por la habilitación, seguros y tarifa del servicio de taxi, que se mantiene como vertical aparte.</li>
        <li><strong>Municipio:</strong> el acompañamiento institucional es lo que se propone evaluar. No hay adhesión ni aval otorgado.</li>
      </ul>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Propuesta de piloto de 90 días</h2>
      <ol class="steps-list">
        <li><strong>Días 1 a 30:</strong> incorporación de un grupo reducido de comercios y emprendimientos, con acompañamiento en la carga de catálogos.</li>
        <li><strong>Días 31 a 60:</strong> operación abierta al público con seguimiento semanal de incidencias.</li>
        <li><strong>Días 61 a 90:</strong> evaluación, ajustes y decisión sobre la continuidad.</li>
      </ol>
      <h3 class="checkout-section-title">Qué se mediría</h3>
      <ul class="plain-list">
        <li>Comercios que completan el alta y llegan a publicar.</li>
        <li>Productos publicados, favoritos guardados y búsquedas sin resultado.</li>
        <li>Pedidos confirmados, entregados, rechazados y cancelados, por modalidad.</li>
        <li>Incidencias reportadas por comercios y por personas usuarias.</li>
      </ul>
      <p class="microcopy">Todas esas métricas salen de operaciones efectivamente registradas en la plataforma. No se publican proyecciones de ventas.</p>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Qué falta para un piloto real</h2>
      <ul class="plain-list">
        <li>Backend gestionado con copias de resguardo y recuperación ante fallos. Hoy el entorno compartido es un servidor local de desarrollo.</li>
        <li>Verificación de identidad de comercios y validación de habilitaciones cuando la actividad lo requiera.</li>
        <li>Definición de pagos. Los cobros en línea están deshabilitados en esta entrega.</li>
        <li>Moderación de productos además del alta del comercio.</li>
        <li>Notificaciones a vendedores y personas usuarias.</li>
        <li>Acuerdo escrito de roles, datos personales y soporte.</li>
      </ul>
    </section>

    <section class="checkout-section">
      <h2 class="checkout-section-title">Estado de este entorno</h2>
      <dl class="metrics-grid">
        <div class="metric"><dt>Comercios publicados</dt><dd>${counts.activeBusinesses}</dd></div>
        <div class="metric"><dt>Productos disponibles</dt><dd>${counts.products}</dd></div>
        <div class="metric"><dt>Pedidos registrados</dt><dd>${counts.orders}</dd></div>
      </dl>
      <p class="microcopy">Son los datos de ${isShared() ? 'este entorno de pruebas' : 'este navegador'}.
        Los comercios y productos de ejemplo son ficticios y fueron preparados para la demostración: no representan negocios reales de Neuquén Capital ni implican su adhesión.</p>
    </section>`;
}

// ───────────────────────── acciones ─────────────────────────

// Errores de validación que tienen un campo: el mensaje queda junto al campo,
// el campo se marca como inválido y recibe el foco (además del aviso).
const FIELD_ERRORS = Object.freeze({
  INVALID_NAME: 'name', INVALID_PHONE: 'phone', ADDRESS_REQUIRED: 'address', ZONE_NOT_CONFIRMED: 'zoneAcknowledged',
  INVALID_EMAIL: 'email', INVALID_PASSWORD: 'password',
});

function markFieldError(form, error) {
  const name = FIELD_ERRORS[error?.code];
  const field = /** @type {HTMLInputElement|null} */ (name ? form?.querySelector(`[name="${name}"]`) : null);
  if (!field) return;
  const id = `${field.id || `${form.dataset.form}-${name}`}-error`;
  let note = document.getElementById(id);
  if (!note) {
    note = document.createElement('p');
    note.className = 'field-error';
    note.id = id;
    (field.closest('.field, .check-label') || field).after(note);
  }
  note.textContent = error.message;
  field.setAttribute('aria-invalid', 'true');
  const described = new Set((field.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
  described.add(id);
  field.setAttribute('aria-describedby', [...described].join(' '));
  field.focus();
}

function clearFieldError(field) {
  if (field?.getAttribute?.('aria-invalid') !== 'true') return;
  field.removeAttribute('aria-invalid');
  const ids = (field.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
  for (const id of ids.filter(value => value.endsWith('-error'))) document.getElementById(id)?.remove();
  const rest = ids.filter(value => !value.endsWith('-error'));
  if (rest.length) field.setAttribute('aria-describedby', rest.join(' ')); else field.removeAttribute('aria-describedby');
}

async function withBusy(element, operation) {
  if (!element || element.dataset.busy === 'true') return;
  element.dataset.busy = 'true';
  const wasDisabled = element.disabled;
  element.disabled = true;
  busy.actions += 1;
  settle();
  try {
    await operation();
  } catch (error) {
    if (isNetworkError(error)) {
      toast('Sin conexión con MiFav. No se envió nada: reintentá cuando vuelva.', 'error');
    } else {
      toast(userMessage(error), 'error');
      markFieldError(element.closest?.('form'), error);
    }
    // Un conflicto de versión o de estado se resuelve mostrando lo actual; tras
    // una conexión lenta también: la operación pudo haber llegado.
    if (['U0001', '42501', 'PRICES_CHANGED', 'U0003', 'NETWORK_TIMEOUT'].includes(error?.code) || error?.technical?.code === 'U0001') {
      render();
    }
  } finally {
    element.dataset.busy = 'false';
    element.disabled = wasDisabled || (isConnected() && !app.online);
    busy.actions -= 1;
    settle();
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
    app.search.shown = PRODUCT_PAGE_SIZE;
    // Los chips del inicio llevan al listado con el rubro elegido.
    if (route().page !== 'comercios') { go('#comercios'); return undefined; }
    return render();
  },
  // Abiertos, con envío o con retiro. Desde el inicio llevan al listado.
  'quick-filter'(element) {
    const key = element.dataset.filter;
    if (key === 'open') app.search.onlyOpen = !app.search.onlyOpen;
    else app.search.mode = app.search.mode === key ? '' : key;
    app.search.shown = PRODUCT_PAGE_SIZE;
    if (route().page !== 'comercios') { go('#comercios'); return undefined; }
    return render();
  },
  'show-more-products'() {
    app.search.shown = Math.max(PRODUCT_PAGE_SIZE, Number(app.search.shown) || PRODUCT_PAGE_SIZE)
      + PRODUCT_PAGE_SIZE;
    return render();
  },
  'clear-filters'() {
    app.search = {
      query: '', category: 'Todos', onlyOpen: false, mode: '', condition: '',
      locality: '', sort: 'relevance', shown: PRODUCT_PAGE_SIZE,
    };
    return render();
  },
  // Favoritos locales: se guarda el par tienda/producto, nunca datos del vendedor.
  'toggle-favorite'(element) {
    const { business, product } = element.dataset;
    try {
      const result = toggleFavorite(favoriteStorage, business, product);
      favoriteCache = result.favorites;
      toast(result.active ? 'Guardado en favoritos.' : 'Quitado de favoritos.');
      return render();
    } catch (error) {
      toast(userMessage(error), 'error');
      return undefined;
    }
  },
  'set-condition'(element) {
    const value = element.dataset.condition || '';
    app.search.condition = app.search.condition === value ? '' : value;
    app.search.shown = PRODUCT_PAGE_SIZE;
    if (route().page !== 'comercios') { go('#comercios'); return undefined; }
    return render();
  },
  'set-locality'(element) {
    const value = element.dataset.locality || '';
    app.search.locality = app.search.locality === value ? '' : value;
    app.search.shown = PRODUCT_PAGE_SIZE;
    if (route().page !== 'comercios') { go('#comercios'); return undefined; }
    return render();
  },
  'sort-products'(element) {
    app.search.sort = element.dataset.sort || 'relevance';
    return render();
  },
  async 'publish-confirm'() {
    const draft = app.publishReview;
    if (!draft) { toast('El borrador ya no está disponible. Volvé a cargarlo.', 'error'); return render(); }
    try {
      const product = await runCommand('product.create', {
        businessId: draft.businessId,
        product: {
          name: draft.name, description: draft.description, category: draft.category,
          condition: draft.condition, price: draft.price, stock: draft.stock,
          trackStock: draft.trackStock, available: draft.available,
        },
        image: isConnected() ? draft.file : draft.imageData,
      });
      app.publishReview = null;
      toast('Publicación guardada. La ves en tu tienda.');
      go(`#producto/${encodeURIComponent(draft.businessId)}/${encodeURIComponent(product.id)}`);
      await render({ focus: true });
    } catch (error) {
      toast(userMessage(error), 'error');
    }
  },
  'publish-cancel'() {
    app.publishReview = null;
    return render();
  },
  // Retiro o envío desde el carrito: cambia el total a la vista y queda
  // elegido para la confirmación.
  'set-fulfillment'(element) {
    draft(`checkout:${element.dataset.business}`, { fulfillment: element.dataset.mode });
    return render();
  },
  // Categorías del catálogo: el hash es la ruta, así que se desplaza sin tocarlo.
  'jump-category'(element) {
    const section = document.getElementById(element.dataset.target || '');
    if (!section) return;
    section.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    section.querySelector('h2')?.setAttribute('tabindex', '-1');
    section.querySelector('h2')?.focus({ preventScroll: true });
  },
  // Ingresar / Crear cuenta sin redibujar: lo que ya se escribió no se pierde.
  'set-account-tab'(element) {
    app.accountTab = element.dataset.tab === 'crear' ? 'crear' : 'ingresar';
    for (const tab of document.querySelectorAll('.account-tabs [role="tab"]')) {
      const selected = /** @type {HTMLElement} */ (tab).dataset.tab === app.accountTab;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }
    for (const panel of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-account-panel]'))) {
      panel.hidden = panel.dataset.accountPanel !== app.accountTab;
    }
  },
  // Pagar online: el servidor crea (o devuelve) el intento y el checkout del
  // proveedor. Nada se da por pagado hasta que lo confirma el proveedor.
  async 'payment-start'(element) {
    const { checkoutUrl } = await runCommand('payment.start', { orderId: element.dataset.order });
    location.assign(checkoutUrl);
  },
  async 'payment-connect'(element) {
    const { authorizationUrl } = await runCommand('payment.connect', { businessId: element.dataset.business,
      provider: element.dataset.provider });
    location.assign(authorizationUrl);
  },
  async 'payment-disconnect'(element) {
    const label = element.dataset.label || 'la cuenta de pagos';
    const confirmed = await askConfirm({
      title: `¿Desconectar ${label}?`,
      message: 'El checkout deja de ofrecer el pago online en el momento. Los pagos ya aprobados no cambian.',
      confirmLabel: 'Desconectar', cancelLabel: 'Volver',
    });
    if (!confirmed) return;
    await runCommand('payment.disconnect', { businessId: element.dataset.business, provider: element.dataset.provider });
    toast(`${label} desconectada del comercio.`);
    await render();
  },
  'set-activity-tab'(element) {
    app.activityTab = element.dataset.tab;
    return render();
  },
  // Cada sección del panel tiene su dirección: recargar, volver atrás o
  // compartir el enlace deja a la persona en el mismo lugar.
  'set-panel-tab'(element) {
    const businessId = element.dataset.business || route().param;
    go(`#panel/${businessId}/${element.dataset.tab}`);
  },
  // Desde el inicio: ir a Pedidos con un filtro ya elegido (por ejemplo, Completados).
  'show-orders'(element) {
    app.orderFilter = ORDER_FILTERS.includes(element.dataset.filter || '') ? element.dataset.filter : 'activos';
    go(`#panel/${element.dataset.business}/pedidos`);
  },
  'order-filter'(element) {
    app.orderFilter = element.dataset.filter || 'activos';
    return render();
  },
  // Cargar la semana en el teléfono son 28 campos: se copia el lunes y se
  // corrige lo distinto. No guarda nada hasta que se toca "Guardar horarios".
  'hours-copy-monday'(element) {
    const form = /** @type {HTMLFormElement|null} */ (element.closest('form'));
    if (!form) return;
    const field = (/** @type {string} */ name) => /** @type {HTMLInputElement|null} */ (form.querySelector(`[name="${name}"]`));
    const closed = field('d1-closed')?.checked === true;
    for (const day of [0, 2, 3, 4, 5, 6]) {
      const box = field(`d${day}-closed`);
      if (box) box.checked = closed;
      for (let index = 0; index < MAX_RANGES_PER_DAY; index += 1) {
        for (const edge of ['opens', 'closes']) {
          const target = field(`d${day}-${index}-${edge}`);
          if (target) target.value = field(`d1-${index}-${edge}`)?.value || '';
        }
      }
    }
    form.dataset.dirty = 'true';
    toast('Copiamos el lunes en toda la semana. Corregí los días distintos y guardá.');
  },
  async 'use-identity'(element) {
    await app.repository.signInAsDemoIdentity(element.dataset.identity);
    app.session = await app.repository.session();
    toast(`Entraste como ${actor().name}.`);
    const target = element.dataset.return || '#actividad';
    go(target);
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
    // Pausar saca el comercio de MiFav: se confirma. Reactivar, no.
    if (element.dataset.status === 'paused') {
      const confirmed = await askConfirm({
        title: '¿Pausar el comercio?',
        message: 'No aparece en MiFav ni recibe pedidos hasta que lo reactives. Para un rato o un día sin atención alcanza con “Cerrar atención”.',
        confirmLabel: 'Pausar', cancelLabel: 'Volver',
      });
      if (!confirmed) return;
    }
    await runCommand('business.setStatus', { businessId: element.dataset.business, status: element.dataset.status });
    toast(element.dataset.status === 'paused' ? 'Comercio pausado: no aparece en MiFav.' : 'Comercio activo otra vez.');
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
  async 'category-toggle'(element) {
    const active = element.dataset.active === 'true';
    await runCommand('productCategory.update', { businessId: element.dataset.business, categoryId: element.dataset.category,
      patch: { active } });
    toast(active ? 'Categoría activada.' : 'Categoría desactivada: sus productos se muestran en “Otros”.');
    await render();
  },
  async 'category-move'(element) {
    const { business, category, direction } = element.dataset;
    const categories = await app.repository.query('productCategories', { businessId: business });
    const ids = categories.map(item => item.id);
    const from = ids.indexOf(category);
    const to = direction === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    await runCommand('productCategory.reorder', { businessId: business, order: ids });
    await render();
  },
  async 'product-photo-remove'(element) {
    const { business, product } = element.dataset;
    await runCommand('product.setImage', { businessId: business, productId: product, file: null });
    toast('Foto quitada.');
    await render();
  },
  async 'business-media-remove'(element) {
    const { business, slot } = element.dataset;
    await runCommand('business.setMedia', { businessId: business, slot, file: null });
    toast(slot === 'cover' ? 'Portada quitada.' : 'Logo quitado.');
    await render();
  },
  // Reparto: retiré, salí, llegué. La base valida que el pedido sea de esta
  // persona y que el paso corresponda.
  async 'rider-step'(element) {
    const { order, version, next } = element.dataset;
    await runCommand('order.transition', { orderId: order, expectedVersion: Number(version), nextStatus: next });
    app.riderFeedback = null;
    toast({ picked_up: 'Pedido retirado. El cliente lo ve en su seguimiento.', on_the_way: 'En camino. El cliente ya lo sabe.',
      arrived: 'Llegaste. Pedile el código al cliente para entregar.' }[next || ''] || 'Listo.');
    await render();
  },
  'rider-refresh'() {
    return render();
  },
  async 'rider-unlink'(element) {
    const confirmed = await askConfirm({
      title: `¿Desvincular la cuenta de ${element.dataset.name || 'esta persona'}?`,
      message: 'Deja de ver sus entregas en el teléfono. Los pedidos asignados siguen en tu panel y los podés completar desde acá.',
      confirmLabel: 'Desvincular', cancelLabel: 'Volver',
    });
    if (!confirmed) return;
    await runCommand('rider.unlinkAccount', { riderId: element.dataset.rider });
    toast('Cuenta desvinculada.');
    await render();
  },
  async 'order-transition'(element) {
    const { order, version, next } = element.dataset;
    let reason = '';
    if (element.dataset.reason === 'required') {
      // Rechazar o cancelar es destructivo: se confirma y se explica.
      reason = await askReason({
        title: next === 'canceled' && element.textContent.trim() === 'Rechazar'
          ? `Rechazar el pedido ${element.dataset.code || ''}` : `Cancelar el pedido ${element.dataset.code || ''}`,
        message: 'La persona ve este motivo en su pedido.',
        label: 'Motivo', placeholder: 'Por ejemplo: nos quedamos sin stock de un producto',
        confirmLabel: element.textContent.trim() || 'Confirmar',
      });
      if (reason === null) return;
    }
    await runCommand('order.transition', {
      orderId: order, expectedVersion: Number(version), nextStatus: next, reason,
    });
    await render();
  },
  async 'cancel-order'(element) {
    const reason = await askReason({
      title: '¿Cancelar el pedido?', message: 'El comercio deja de prepararlo. No se puede deshacer.',
      label: 'Motivo', required: false, confirmLabel: 'Sí, cancelar', cancelLabel: 'No, volver',
    });
    if (reason === null) return;
    await runCommand('order.transition', {
      orderId: element.dataset.order, expectedVersion: Number(element.dataset.version),
      nextStatus: 'canceled', reason,
    });
    toast('Pedido cancelado.');
    await render();
  },
  async 'remove-unavailable'(element) {
    await runCommand('cart.removeUnavailable', { businessId: element.dataset.business });
    toast('Quitamos los productos que ya no están disponibles.');
    await render();
  },
  async 'copy-tracking'(element) {
    const url = element.dataset.url;
    try {
      await navigator.clipboard.writeText(url);
      toast('Enlace copiado. Guardalo para seguir tu pedido.');
    } catch {
      await askConfirm({ title: 'Enlace de seguimiento', message: url, confirmLabel: 'Listo', cancelLabel: 'Cerrar', danger: false });
    }
  },
  async 'share-tracking'(element) {
    try {
      await navigator.share({ title: `Pedido ${element.dataset.code} · MiFav`, url: element.dataset.url });
    } catch { /* compartir cancelado */ }
  },
  async 'refresh-panel'() {
    app.repository.invalidateSession?.();
    await render();
    toast('Panel actualizado.');
  },
  'enable-sound'() {
    setSoundMuted(false);
    unlockSound();
    setTimeout(() => render(), 150);
    toast(soundReady() || unlockSound() ? 'Sonido activado para pedidos nuevos.' : 'Este navegador no permite reproducir sonido.');
  },
  'mute-sound'() {
    setSoundMuted(true);
    toast('Sonido silenciado en este dispositivo. Los pedidos nuevos se siguen avisando en pantalla.');
    return render();
  },
  async 'team-role'(element) {
    const { business, user, role } = element.dataset;
    await runCommand('team.setRole', { businessId: business, userId: user, role });
    toast(role === 'manager' ? 'Ahora administra el comercio.' : 'Ahora atiende pedidos.');
    await render();
  },
  async 'team-remove'(element) {
    const { business, user, name } = element.dataset;
    const confirmed = await askConfirm({ title: `¿Quitar a ${name} del equipo?`,
      message: 'Deja de ver los pedidos y el panel en el momento. Podés volver a sumarle después.',
      confirmLabel: 'Quitar', cancelLabel: 'Volver' });
    if (!confirmed) return;
    await runCommand('team.remove', { businessId: business, userId: user });
    toast(`${name} ya no forma parte del equipo.`);
    await render();
  },
  async 'admin-business-status'(element) {
    const { business, status, name } = element.dataset;
    let note = '';
    if (status === 'suspended') {
      note = await askReason({ title: `Suspender ${name}`, message: 'Deja de aparecer y de recibir pedidos. El comercio ve el motivo.',
        label: 'Motivo', confirmLabel: 'Suspender' });
      if (note === null) return;
    } else if (!await askConfirm({ title: `Rehabilitar ${name}`, message: 'Vuelve a aparecer en MiFav.', confirmLabel: 'Rehabilitar', danger: false })) {
      return;
    }
    await runCommand('admin.setBusinessStatus', { businessId: business, status, note });
    toast(status === 'suspended' ? 'Comercio suspendido.' : 'Comercio rehabilitado.');
    await render();
  },
  async 'rider-toggle'(element) {
    await runCommand('rider.setActive', { riderId: element.dataset.rider, active: element.dataset.active === 'true' });
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
    const input = /** @type {HTMLInputElement} */ (document.querySelector('#taxi-origin'));
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
  async 'profile-update'(form) {
    await app.repository.updateProfile(Object.fromEntries(new FormData(form)));
    app.session = await app.repository.session(); toast('Perfil guardado.'); await render();
  },
  async 'password-reset'(form) {
    await app.repository.requestPasswordReset(new FormData(form).get('email'));
    app.authNotice = 'Si el correo corresponde a una cuenta, recibirás un enlace para recuperar tu contraseña.';
    await render();
  },
  async 'password-update'(form) {
    const data = new FormData(form);
    await app.repository.updatePassword(data.get('password'),
      isConnected() ? { currentPassword: data.get('currentPassword') || '' } : undefined);
    form.reset(); app.authNotice = 'Contraseña actualizada.'; toast('Contraseña actualizada.'); await render();
  },
  async 'password-recovery'(form) {
    const data = new FormData(form);
    const password = String(data.get('password') || '');
    if (password !== String(data.get('confirm') || '')) { toast('Las dos contraseñas no coinciden.', 'error'); return; }
    await app.repository.updatePassword(password);
    app.recovering = false;
    app.invited = false;
    app.session = await app.repository.session({ fresh: true });
    app.authNotice = '';
    toast('Listo: tu contraseña nueva ya funciona.');
    go(hasRole('admin') ? '#admin' : hasRole('merchant') ? '#panel' : '#cuenta');
    await render({ focus: true });
  },
  async 'resend-confirmation'(form) {
    await app.repository.resendConfirmation(new FormData(form).get('email'));
    form.reset();
    app.authNotice = 'Si hay una cuenta sin confirmar con ese correo, te reenviamos el enlace. Revisá también la carpeta de spam.';
    await render();
  },
  async 'business-rename'(form) {
    await app.repository.command('business.rename', Object.fromEntries(new FormData(form)));
    toast('Comercio actualizado.'); await render();
  },
  search(form) {
    app.search.query = String(new FormData(form).get('query') || '');
    app.search.shown = PRODUCT_PAGE_SIZE;
    return render();
  },
  'home-search'(form) {
    app.search.query = String(new FormData(form).get('query') || '').trim();
    app.search.shown = PRODUCT_PAGE_SIZE;
    go('#comercios');
  },
  async 'publish-review'(form) {
    const data = Object.fromEntries(new FormData(form));
    const file = form.querySelector('input[type="file"][name="image"]')?.files?.[0] || null;
    let normalized;
    try {
      normalized = validateProductInput({
        name: data.name, description: data.description || '', category: data.category,
        condition: data.condition, price: Number(data.price), stock: Number(data.stock || 0),
        available: data.available === 'on',
      }, { partial: false });
      const image = file && file.size ? await publishImageData(file) : { data: '', file: null };
      app.publishReview = {
        businessId: String(data.business || ''),
        ...normalized,
        trackStock: true,
        imageData: validateImageData(image.data),
        file: image.file,
      };
      await render({ focus: true });
    } catch (error) {
      toast(userMessage(error), 'error');
    }
  },

  async 'sign-in'(form) {
    const data = Object.fromEntries(new FormData(form));
    await app.repository.signIn({ email: data.email, password: data.password });
    app.session = await app.repository.session();
    app.authNotice = '';
    toast(`Hola, ${actor().name}.`);
    // Si se pidió ingresar a mitad de una compra, se vuelve al carrito.
    const target = app.returnTo || (hasRole('admin') ? '#admin' : hasRole('merchant') ? '#panel'
      : hasRole('rider') ? '#entregas' : '#actividad');
    app.returnTo = null;
    go(target);
    await render({ focus: true });
  },

  async register(form) {
    const data = Object.fromEntries(new FormData(form));
    const result = await app.repository.register(data);
    if (result?.confirmationRequired) {
      form.reset();
      app.accountTab = 'ingresar';
      app.authNotice = `Te enviamos un correo a ${data.email} para confirmar la cuenta. Abrí el enlace (vale una hora) y después ingresá. Si no llega, revisá la carpeta de spam o pedí que lo reenviemos.`;
      await render(); return;
    }
    app.session = await app.repository.session();
    toast('Cuenta creada.');
    go('#actividad');
    await render({ focus: true });
  },

  async 'business-create'(form) {
    const data = Object.fromEntries(new FormData(form));
    const business = await runCommand('business.create', { name: data.name, category: data.category });
    app.session = await app.repository.session();
    toast('Comercio creado como borrador.');
    go(`#panel/${business.id}/configuracion`);
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
    if (isConnected()) {
      Object.assign(patch, { description: data.get('description'), publicPhone: data.get('publicPhone'),
        whatsapp: data.get('whatsapp'), prepMinutes: data.get('prepMinutes'), deliveryMinutes: data.get('deliveryMinutes') });
    }
    // Qué ofrece el comercio: sólo cuando el formulario incluye la sección.
    const capabilityBoxes = form.querySelectorAll('input[name^="capability-"]');
    if (capabilityBoxes.length) {
      patch.capabilities = [...capabilityBoxes].filter(box => box.checked).map(box => box.value);
    }
    await runCommand('business.update', { businessId: form.dataset.business, patch });
    toast('Datos guardados.');
    await render();
  },

  async 'business-hours'(form) {
    const data = new FormData(form);
    if (allDaysClosed(name => data.get(name))) {
      toast('Marcaste todos los días como cerrados. Para dejar de tomar pedidos usá “Cerrar atención”.', 'error');
      return;
    }
    await runCommand('business.setHours', { businessId: form.dataset.business, hours: readHoursForm(form) });
    toast('Horarios guardados.');
    await render();
  },

  async 'team-add'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('team.add', { businessId: form.dataset.business, email: data.email, role: data.role });
    form.reset();
    toast('Listo: ya puede usar el panel de este comercio.');
    await render();
  },

  async 'product-quick'(form) {
    const data = new FormData(form);
    const patch = { price: Number(data.get('price')) };
    if (form.dataset.tracked === 'true') patch.stock = Number(data.get('stock'));
    await runCommand('product.update', { businessId: form.dataset.business, productId: form.dataset.product, patch });
    toast(form.dataset.tracked === 'true' ? 'Precio y stock guardados.' : 'Precio guardado.');
    await render();
  },

  async 'product-stock'(form) {
    await runCommand('product.update', { businessId: form.dataset.business, productId: form.dataset.product,
      patch: { stock: Number(new FormData(form).get('stock')), available: form.dataset.available === 'true' } });
    toast('Stock actualizado.');
    await render();
  },

  async 'product-edit'(form) {
    const data = Object.fromEntries(new FormData(form));
    const connected = isConnected();
    const trackStock = connected ? data.trackStock === 'on' : true;
    const patch = { name: data.name, description: data.description || '', category: data.category,
      condition: data.condition, price: Number(data.price), variants: parseVariants(data.variants) };
    if (connected) patch.trackStock = trackStock;
    if (trackStock) patch.stock = Number(data.stock || 0);
    await runCommand('product.update', { businessId: form.dataset.business, productId: form.dataset.product, patch });
    app.openDetails.delete(`product-${form.dataset.product}`);
    toast('Producto actualizado.');
    await render();
  },

  async 'category-create'(form) {
    const name = String(new FormData(form).get('name') || '');
    await runCommand('productCategory.create', { businessId: form.dataset.business, name });
    toast('Categoría agregada.');
    await render();
  },

  async 'category-rename'(form) {
    await runCommand('productCategory.update', { businessId: form.dataset.business, categoryId: form.dataset.category,
      patch: { name: String(new FormData(form).get('name') || '') } });
    toast('Categoría actualizada.');
    await render();
  },

  async 'product-create'(form) {
    const data = Object.fromEntries(new FormData(form));
    const image = form.querySelector('input[type="file"][name="image"]')?.files?.[0] || null;
    const trackStock = isConnected() ? data.trackStock === 'on' : true;
    await runCommand('product.create', {
      businessId: form.dataset.business,
      product: {
        name: data.name, description: data.description, category: data.category, condition: data.condition,
        price: Number(data.price), stock: trackStock ? Number(data.stock || 0) : 0, trackStock, available: true,
        variants: parseVariants(data.variants),
      },
      image: image && image.size ? image : null,
    });
    form.reset();
    // El formulario queda abierto para cargar el siguiente.
    app.openDetails.add('catalog-new');
    toast(image && image.size ? 'Producto y foto agregados al catálogo.' : 'Producto agregado al catálogo.');
    await render();
  },

  // La imagen sube primero y recién después se guarda la referencia: si falla,
  // el catálogo queda como estaba y el mensaje lo dice.
  async 'product-image'(form) {
    const file = form.querySelector('input[type="file"]')?.files?.[0];
    if (!file || !file.size) { toast('Elegí una imagen para subir.', 'error'); return; }
    await runCommand('product.setImage', { businessId: form.dataset.business, productId: form.dataset.product, file });
    toast('Foto actualizada.');
    await render();
  },

  async 'business-media'(form) {
    const file = form.querySelector('input[type="file"]')?.files?.[0];
    if (!file || !file.size) { toast('Elegí una imagen para subir.', 'error'); return; }
    await runCommand('business.setMedia', { businessId: form.dataset.business, slot: form.dataset.slot, file });
    toast(form.dataset.slot === 'cover' ? 'Portada actualizada.' : 'Logo actualizado.');
    await render();
  },

  async 'rider-create'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('rider.create', { businessId: form.dataset.business, name: data.name, phone: data.phone });
    form.reset();
    toast('Persona de reparto agregada.');
    await render();
  },

  // Entregar con el código del cliente. Un código equivocado vuelve como
  // respuesta (el intento queda registrado en la base), no como error.
  async 'rider-deliver'(form) {
    const data = Object.fromEntries(new FormData(form));
    const result = await runCommand('order.confirmDelivery', {
      orderId: form.dataset.order, expectedVersion: Number(form.dataset.version), code: data.code,
    });
    const feedback = deliveryCodeFeedback(result);
    app.riderFeedback = feedback.ok ? null : { orderId: form.dataset.order, message: feedback.message };
    toast(feedback.message, feedback.ok ? 'info' : 'error');
    await render();
  },

  async 'rider-link'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('rider.linkAccount', { riderId: form.dataset.rider, email: data.email });
    form.reset();
    toast('Cuenta vinculada. La persona ya ve sus entregas en “Mis entregas”.');
    await render();
  },

  async 'assign-rider'(form) {
    const data = Object.fromEntries(new FormData(form));
    await runCommand('order.transition', {
      orderId: form.dataset.order, expectedVersion: Number(form.dataset.version),
      nextStatus: 'assigned', riderId: data.riderId,
    });
    app.riderChoice.delete(form.dataset.order || '');
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
    app.checkoutNotice = null;
    if (isShared() && !app.online) {
      toast('Sin conexión: no se confirmó nada. Reintentá cuando vuelva.', 'error');
      return;
    }
    // El identificador de intento se pide una sola vez por carrito: si la
    // confirmación se repite (doble toque, red lenta, recarga), el servidor
    // devuelve el mismo pedido.
    const requestId = await runCommand('cart.prepareRequest', { businessId });
    const expected = Number(form.dataset.expectedTotal);
    let order;
    try {
      order = await runCommand('order.create', {
        businessId,
        requestId,
        expectedTotal: Number.isSafeInteger(expected) && expected > 0 ? expected : undefined,
        fulfillment: data.fulfillment,
        paymentMethod: data.paymentMethod || 'cash_demo',
        customer: {
          name: data.name, phone: data.phone, address: data.address, notes: data.notes,
          zoneAcknowledged: new FormData(form).get('zoneAcknowledged') === 'on',
        },
      });
    } catch (error) {
      app.telemetry?.orderFailed(error, { business: businessId, fulfillment: data.fulfillment });
      if (error?.code === 'PRICES_CHANGED') {
        app.checkoutNotice = { businessId, tone: 'error', message: Number.isFinite(error.newTotal)
          ? `Los precios cambiaron mientras confirmabas: el nuevo total es ${money(error.newTotal)}. Revisalo y confirmá de nuevo.`
          : error.message };
        await render();
        return;
      }
      if (error?.code === 'GUEST_CHECKOUT_UNAVAILABLE') {
        app.authNotice = 'Para confirmar el pedido, ingresá con tu cuenta. Tu carrito queda guardado.';
        app.returnTo = `#carrito/${businessId}/confirmar`;
        go('#cuenta');
        return;
      }
      throw error;
    }
    app.formDrafts.delete(`checkout:${businessId}`);
    app.session = await app.repository.session();
    // Pago online: el pedido ya existe; ahora se paga en el proveedor. Si el
    // pago no se puede abrir, el pedido queda con el pago pendiente y se
    // puede pagar desde el pedido.
    if (order.paymentMethod === 'online' && !order.alreadyExisted) {
      try {
        const { checkoutUrl } = await runCommand('payment.start', { orderId: order.id });
        location.assign(checkoutUrl);
        return;
      } catch (error) {
        toast(`Pedido ${order.code} creado, pero no pudimos abrir el pago: ${userMessage(error)}`, 'error');
        go(`#pedido/${order.id}`);
        await render({ focus: true });
        return;
      }
    }
    toast(order.alreadyExisted
      ? `Ese pedido ya estaba enviado: ${order.code}.`
      : `Pedido ${order.code} enviado. Te avisamos acá cuando el comercio lo acepte.`);
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
  producto: viewProduct,
  favoritos: viewFavorites,
  ferias: viewFerias,
  publicar: viewPublish,
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
  entregas: viewRider,
  institucional: viewInstitutional,
  recuperar: viewRecovery,
  seguimiento: viewTracking,
  pago: viewPaymentReturn,
};

// Títulos por ruta y rutas que nunca se indexan (paneles y datos personales).
const ROUTE_TITLES = Object.freeze({
  inicio: 'MiFav · Marketplace de Neuquén Capital', comercios: 'Explorar · MiFav', producto: 'Producto · MiFav',
  favoritos: 'Favoritos · MiFav', ferias: 'Ferias · MiFav', publicar: 'Publicar · MiFav',
  carrito: 'Carrito · MiFav', pedido: 'Tu pedido · MiFav',
  actividad: 'Mis pedidos · MiFav', cuenta: 'Tu cuenta · MiFav', 'alta-comercio': 'Sumar mi comercio · MiFav',
  panel: 'Panel del comercio · MiFav', admin: 'Administración · MiFav', institucional: 'Qué es MiFav',
  recuperar: 'Recuperar contraseña · MiFav', seguimiento: 'Seguimiento de pedido · MiFav',
  entregas: 'Mis entregas · MiFav', pago: 'Pago · MiFav', taxi: 'Taxi · MiFav',
});
const PRIVATE_ROUTES = new Set(['carrito', 'pedido', 'actividad', 'cuenta', 'alta-comercio', 'panel', 'admin',
  'recuperar', 'seguimiento', 'taxista', 'viaje', 'entregas', 'pago', 'publicar', 'favoritos']);
const TAXI_ROUTES = new Set(['taxi', 'viaje', 'taxista']);

function applyRouteMeta(page) {
  if (typeof document === 'undefined') return;
  const title = ROUTE_TITLES[page] || 'MiFav · Marketplace de Neuquén Capital';
  setBaseTitle(title);
  if (!/^\(\d+\) Pedido nuevo · /.test(document.title) || page !== 'panel') document.title = title;
  let robots = /** @type {HTMLMetaElement|null} */ (document.querySelector('meta[name="robots"]'));
  if (!robots) {
    robots = document.createElement('meta');
    robots.name = 'robots';
    document.head.append(robots);
  }
  robots.content = PRIVATE_ROUTES.has(page) ? 'noindex, nofollow' : 'index, follow';
}

let renderToken = 0;
// Lo que una vista hace recién cuando se muestra (marcar pedidos como vistos,
// avisar): un redibujo descartado no lo aplica.
/** @type {{ token: number, run: () => void } | null} */
let whenShown = null;

// ── sincronización en vivo ──
// Una suscripción por vista, acotada a lo que esa vista muestra: el comercio
// escucha sus pedidos y la persona los suyos. Nunca se escucha la tabla entera.
// Al cambiar de vista el canal se cierra; no quedan canales abiertos de fondo.
const live = { key: '', stop: null, timer: null };

// Realtime es la vía principal; el sondeo es el respaldo. Un teléfono que se
// bloquea o una red móvil que cambia cortan el WebSocket sin aviso: el panel
// igual se actualiza cada 30 segundos y al volver a la pestaña.
const POLL_MS = Object.freeze({ panel: 30000, pedido: 45000, seguimiento: 30000, taxista: 15000, entregas: 15000, pago: 5000 });

function syncLive(page, param) {
  const me = actor();
  const connected = Boolean(app.repository?.capabilities?.realtime);
  const scopes = [];
  // Sin sesión no hay nada que escuchar: la base rechazaría el canal.
  const panel = page === 'panel' && param && isSignedIn();
  const order = page === 'pedido' && param && me?.id;
  if (connected) {
    if (panel) scopes.push({ kind: 'businessOrders', businessId: param });
    else if (order) scopes.push({ kind: 'order', orderId: param });
    else if (['inicio', 'actividad'].includes(page) && me?.id) {
      scopes.push({ kind: 'myOrders', customerId: me.id });
      if (feature('taxi')) scopes.push({ kind: 'myTrips', passengerId: me.id });
    } else if (['taxi', 'viaje'].includes(page) && me?.id && feature('taxi')) scopes.push({ kind: 'myTrips', passengerId: me.id });
    else if (page === 'taxista' && me?.driverId && feature('taxi')) scopes.push({ kind: 'driverTrips', driverId: me.driverId });
  }
  const pollEvery = connected && (panel || order
    || (page === 'seguimiento' && param) || (page === 'taxista' && me?.driverId)
    || (page === 'entregas' && isSignedIn())
    // La vuelta del pago consulta hasta que el proveedor confirma o rechaza.
    || (page === 'pago' && app.paymentWaiting)) ? POLL_MS[page] : 0;
  const key = `${page}:${param || ''}:${me?.id || ''}:${scopes.length}:${pollEvery}`;
  if (key === live.key) return;
  live.stop?.();
  live.stop = null;
  live.key = key;
  app.liveHealthy = true;
  if (!scopes.length && !pollEvery) return;
  // Un cambio remoto vuelve a pedir los datos por la vía normal, que aplica RLS
  // otra vez: la carga útil del evento nunca se pinta directamente.
  // También en segundo plano: un panel en otra pestaña tiene que sonar y
  // marcar el título cuando entra un pedido.
  // Nunca en medio de un toque: reemplazar la vista entre que se apoya y se
  // levanta el dedo pierde el clic. Se reintenta apenas termina.
  const refresh = () => {
    clearTimeout(live.timer);
    live.timer = setTimeout(function run() {
      if (route().page !== page) return;
      if (isEditing()) {
        // Con un formulario a medio escribir no se redibuja, pero un pedido
        // nuevo igual se avisa.
        if (page === 'panel' && param) peekNewOrders(param);
        return;
      }
      if (Date.now() - app.pointerAt < 600) { live.timer = setTimeout(run, 300); return; }
      render({ background: true });
    }, 250);
  };
  // Cerrar un canal al cambiar de vista es normal: sólo cuenta como falla lo
  // que pasa mientras la vista sigue abierta.
  let active = true;
  const onStatus = status => {
    if (!active) return;
    const healthy = status === 'SUBSCRIBED';
    if (healthy === app.liveHealthy) return;
    app.liveHealthy = healthy;
    if (!healthy && status !== 'CLOSED') {
      app.telemetry?.record('supabase_error', { code: `REALTIME_${status}`, message: 'Canal en vivo interrumpido' });
    }
    refresh();
  };
  const stops = scopes.map(scope => app.repository.watch(scope, refresh, onStatus));
  const poll = pollEvery ? setInterval(refresh, pollEvery) : null;
  live.stop = () => { active = false; clearTimeout(live.timer); if (poll) clearInterval(poll); for (const stop of stops) stop(); };
}

// No se redibuja mientras la persona escribe: se perdería lo que tipeó.
function isEditing() {
  const active = /** @type {HTMLInputElement|null} */ (document.activeElement);
  return Boolean(active && main?.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
    && active.type !== 'button' && active.type !== 'submit')
    // Cambios sin guardar aunque el foco ya esté en otro lado.
    || Boolean(main?.querySelector('form[data-dirty="true"]'));
}

// Rutas cuyo contenido depende de los permisos de la cuenta. En el entorno con
// backend los roles viven en el servidor y pueden cambiar mientras la pestaña
// sigue abierta (por ejemplo, cuando administración aprueba un alta), así que la
// sesión se revalida antes de decidir qué se muestra.
const GATED_ROUTES = new Set(['panel', 'admin', 'taxista', 'cuenta', 'alta-comercio', 'entregas']);

// Si cada desplegable estaba abierto la última vez que la app lo registró.
/** @type {WeakMap<HTMLDetailsElement, boolean>} */
const registeredOpen = new WeakMap();

/** @param {HTMLDetailsElement} details */
function registerOpen(details) {
  const key = details.dataset.keepOpen || '';
  if (details.open) app.openDetails.add(key); else app.openDetails.delete(key);
  registeredOpen.set(details, details.open);
}

const keepOpenDetails = () => /** @type {HTMLDetailsElement[]} */ ([...main.querySelectorAll('details[data-keep-open]')]);

async function render({ focus = false, background = false } = {}) {
  // La ruta se lee ahora: cualquier navegación pedida queda atendida acá.
  busy.navigating = false;
  if (!app.repository) return;
  const token = ++renderToken;
  const { page, param, extra } = route();
  // Ocupada desde el primer instante: mientras se revalida la sesión la vista
  // todavía es la anterior y está por reemplazarse.
  busy.rendering = true;
  settle();
  if (GATED_ROUTES.has(page) && isShared()) {
    try { app.session = await app.repository.session(); }
    catch (error) {
      // Con backend compartido, un fallo de sesión se muestra: nunca se degrada
      // a datos locales ni se sigue mostrando lo que la cuenta anterior veía.
      if (token !== renderToken) return;
      main.innerHTML = errorView(error); busy.rendering = false; settle(); return;
    }
    if (token !== renderToken) return;
  }
  const view = VIEWS[page];
  applyRouteMeta(page);
  try {
    const markup = TAXI_ROUTES.has(page) && !feature('taxi')
      ? emptyState('Sección no disponible', 'Por ahora MiFav funciona para comercios de Neuquén Capital. Esta sección no está habilitada.',
        '#comercios', 'Ver comercios', 'bag')
      : view
      ? await view(param, extra)
      : emptyState('Página no encontrada', 'Volvé al inicio para seguir navegando.', '#inicio', 'Ir al inicio');
    if (token !== renderToken) return;
    // Un refresco de fondo arranca sólo si nadie está escribiendo, pero la
    // consulta tarda: si en ese lapso la persona empezó a escribir, reemplazar
    // la vista borraría lo tipeado. Se descarta (un pedido nuevo igual se
    // avisa) y el próximo refresco lo retoma.
    if (background && isEditing()) {
      if (page === 'panel' && param) peekNewOrders(param);
      busy.rendering = false;
      settle();
      return;
    }
    // `toggle` llega una tarea después del toque (en WebKit, más tarde): si un
    // redibujo de fondo reemplaza la vista en el medio, el aviso le llega a un
    // elemento que ya no está y lo que la persona abrió se cerraba. Lo que
    // cambió y la app todavía no registró se toma del DOM y se aplica sobre el
    // HTML nuevo, que pudo armarse antes del toque. Lo que el código cierra a
    // propósito (al guardar un producto) no se toca.
    const unregistered = new Map();
    for (const details of keepOpenDetails()) {
      if (!registeredOpen.has(details) || details.open === registeredOpen.get(details)) continue;
      unregistered.set(details.dataset.keepOpen, details.open);
      registerOpen(details);
    }
    main.innerHTML = markup;
    for (const details of keepOpenDetails()) {
      if (unregistered.has(details.dataset.keepOpen)) details.open = unregistered.get(details.dataset.keepOpen);
      registeredOpen.set(details, details.open);
    }
    if (whenShown?.token === token) whenShown.run();
    whenShown = null;
  } catch (error) {
    if (token !== renderToken) return;
    main.innerHTML = errorView(error);
  }

  // El contador del carrito alimenta la barra inferior en cualquier vista. En
  // el entorno conectado se lee del dispositivo, sin consultar la red.
  try {
    if (isConnected()) {
      app.cartCount = await app.repository.query('cartCount');
    } else {
      const carts = await app.repository.query('carts');
      app.cartCount = carts.reduce((total, entry) =>
        total + entry.cart.lines.reduce((sum, line) => sum + line.quantity, 0), 0);
    }
  } catch { app.cartCount = app.cartCount || 0; }
  if (token !== renderToken) return;

  updateShell();
  applyOfflineState();
  syncLive(page, param);
  // Recién acá la vista está completa: el contenido, el contador del carrito y
  // la barra inferior coinciden (y `aria-busy` pasa a falso si nada más espera).
  busy.rendering = false;
  settle();
  if (focus) {
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

// ───────────────────────── arranque ─────────────────────────

function bindEvents() {
  document.addEventListener('click', event => {
    const target = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-action]'));
    if (!target) return;
    const handler = ACTIONS[target.dataset.action];
    if (!handler) return;
    if (target.tagName === 'A' && !target.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault();
    withBusy(target, () => handler(target));
  });

  // "Saltar al contenido" no es una ruta: enfoca el contenido sin tocar la
  // dirección (con #main el enrutador mostraba "Página no encontrada").
  document.addEventListener('click', event => {
    if (!/** @type {HTMLElement} */ (event.target).closest?.('a.skip')) return;
    event.preventDefault();
    main.focus();
  });

  document.addEventListener('submit', event => {
    const form = /** @type {HTMLFormElement} */ (event.target);
    const handler = FORMS[form.dataset.form];
    if (!handler) return;
    event.preventDefault();
    const submitter = /** @type {SubmitEvent} */ (event).submitter;
    const button = submitter || form.querySelector('button[type="submit"]');
    withBusy(button || form, () => handler(form, submitter));
  });

  // Un formulario con cambios sin guardar queda marcado: los refrescos de
  // fondo (Realtime, sondeo) no lo pisan hasta que se guarde o se salga.
  const markDirty = event => {
    const form = /** @type {HTMLElement} */ (event.target).closest?.('form');
    if (form && main.contains(form) && form.dataset.form && !['search', 'checkout', 'assign-rider', 'rider-deliver'].includes(form.dataset.form)) {
      form.dataset.dirty = 'true';
    }
  };
  document.addEventListener('input', markDirty);
  // Al corregir un campo marcado, el error se va.
  document.addEventListener('input', event => clearFieldError(/** @type {HTMLElement} */ (event.target)));
  document.addEventListener('change', event => clearFieldError(/** @type {HTMLElement} */ (event.target)));
  document.addEventListener('change', markDirty);
  document.addEventListener('change', event => {
    const select = /** @type {HTMLSelectElement} */ (event.target);
    const form = /** @type {HTMLFormElement|null} */ (select.closest?.('form[data-form="assign-rider"]'));
    if (form?.dataset.order) app.riderChoice.set(form.dataset.order, select.value);
  });
  // Los desplegables marcados con data-keep-open siguen abiertos al redibujar.
  document.addEventListener('toggle', event => {
    const details = /** @type {HTMLDetailsElement} */ (event.target);
    if (details?.dataset?.keepOpen) registerOpen(details);
  }, true);

  // La búsqueda se aplica al escribir, sin recargar la vista entera en cada tecla.
  let searchTimer;
  document.addEventListener('input', event => {
    const searchForm = /** @type {HTMLElement} */ (event.target).closest('form');
    if (searchForm?.dataset.form !== 'search') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => FORMS.search(searchForm), 220);
  });

  document.addEventListener('change', event => {
    const field = /** @type {HTMLInputElement} */ (event.target);
    const form = field.closest('form');
    if (form?.dataset.form !== 'checkout') return;
    // Marcar la opción elegida sin volver a dibujar: no se pierde el foco.
    for (const choice of form.querySelectorAll('.choice')) {
      choice.classList.toggle('active', choice.querySelector('input')?.checked === true);
    }
    if (field.name === 'paymentMethod') {
      const button = /** @type {HTMLElement|null} */ (form.querySelector('.button-confirm-order'));
      const label = button?.querySelector('.confirm-label');
      if (button && label) label.textContent = (field.value === 'online' ? button.dataset.onlineLabel : button.dataset.cashLabel) || '';
      draft(`checkout:${form.dataset.business}`, { paymentMethod: field.value });
    }
    // Cambiar de modalidad sí cambia el formulario (dirección, zona) y el total,
    // así que se guarda lo escrito y se vuelve a dibujar la vista.
    if (field.name === 'fulfillment') {
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
    toast('Conexión recuperada.');
    applyOfflineState();
    // Con backend, volver a tener red es volver a pedir lo actual, salvo que
    // la persona esté escribiendo.
    if (!isConnected() || !isEditing()) render({ background: isConnected() });
  });

  // Volver a la pestaña (o desbloquear el teléfono) actualiza lo que se ve.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !isConnected()) return;
    const { page } = route();
    if (['panel', 'pedido', 'seguimiento', 'actividad', 'inicio', 'pago'].includes(page) && !isEditing()) render({ background: true });
  });

  // El navegador sólo deja sonar avisos después de una interacción.
  document.addEventListener('pointerdown', () => {
    app.pointerAt = Date.now();
    if (route().page === 'panel') unlockSound();
  }, { passive: true, capture: true });

  window.addEventListener('error', event => app.telemetry?.error(event.error || event.message, { where: 'window' }));
  window.addEventListener('unhandledrejection', event => app.telemetry?.error(event.reason, { where: 'promise' }));
}

// Pantalla de error de arranque. Sin handlers inline: la CSP no los permite.
function fatalView(title, message, { retry = true } = {}) {
  if (retry) {
    main.addEventListener('click', event => {
      if (/** @type {HTMLElement} */ (event.target).closest('[data-reload]')) location.reload();
    });
  }
  return `<section class="notice error" role="alert">
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    ${retry ? '<div class="modal-actions"><button class="button" type="button" data-reload>Reintentar</button></div>' : ''}
  </section>`;
}

async function start() {
  main.setAttribute('aria-busy', 'true');
  // Un panel dentro de un iframe ajeno es un vector de clickjacking y GitHub
  // Pages no permite la cabecera frame-ancestors: MiFav no se dibuja embebido.
  if (window.top !== window.self) {
    main.innerHTML = `<section class="notice"><h2>Abrí MiFav en su propia ventana</h2>
      <p><a class="button" href="${esc(location.href)}" target="_top" rel="noopener">Abrir MiFav</a></p></section>`;
    main.setAttribute('aria-busy', 'false');
    return;
  }
  // Al salir de la página el navegador cancela lo que esté en vuelo: nada se
  // reporta durante la descarga.
  window.addEventListener('pagehide', () => { app.unloading = true; });
  window.addEventListener('pageshow', () => { app.unloading = false; });
  app.telemetry = createTelemetry({ release: RUNTIME_ENV.release || RUNTIME_ENV.environment, route: () => location.hash,
    send: RUNTIME_ENV.environment === 'supabase'
      ? event => (app.unloading ? null : app.repository?.reportEvent?.(event)) : null });
  try {
    app.repository = createRepository(CONFIG, {
      runtime: RUNTIME_ENV,
      storage: globalThis.localStorage,
      // Cada falla del backend queda registrada (sin datos personales).
      onError: error => {
        // Sin red, reportar tampoco llega: los cortes quedan en la consola.
        if (error?.code !== 'NETWORK_ERROR'
          && !['23514', 'invalid_credentials', 'weak_password', 'INVALID_CURRENT_PASSWORD'].includes(error?.technical?.code || error?.code)) {
          const technical = { code: error.technical?.code || error.code, message: error.technical?.message || error.message };
          app.telemetry.record(classify(technical, 'supabase_error'), technical);
        }
      },
    });
  } catch (error) {
    app.telemetry.critical(error, { where: 'config' });
    main.innerHTML = fatalView('MiFav no pudo iniciar', 'La configuración de esta versión no es válida. Avisanos para revisarla.', { retry: false });
    main.setAttribute('aria-busy', 'false');
    return;
  }
  updateShell();

  if (isConnected()) {
    // Contrato con la base: sin la versión de esquema esperada no se opera.
    let status;
    try {
      status = await app.repository.query('appStatus');
    } catch (error) {
      main.innerHTML = isNetworkError(error)
        ? fatalView('Sin conexión con MiFav', 'Revisá tu conexión a internet y volvé a intentar.')
        : fatalView('MiFav está en mantenimiento', 'Estamos actualizando la plataforma. Probá de nuevo en unos minutos.');
      if (!isNetworkError(error)) app.telemetry.critical(error, { where: 'app_status' });
      main.setAttribute('aria-busy', 'false');
      return;
    }
    if (!(Number(status?.schema) >= REQUIRED_SCHEMA)) {
      app.telemetry.critical({ code: 'SCHEMA_MISMATCH', message: `Esquema ${status?.schema} < ${REQUIRED_SCHEMA}` });
      main.innerHTML = fatalView('MiFav está en mantenimiento', 'Estamos actualizando la plataforma. Probá de nuevo en unos minutos.');
      main.setAttribute('aria-busy', 'false');
      return;
    }
    app.features = status.features || {};
  }

  try {
    if (isConnected()) {
      app.repository.onAuthChange(event => {
        if (event === 'PASSWORD_RECOVERY') app.recovering = true;
        if (!app.started || !['SIGNED_OUT', 'SIGNED_IN', 'PASSWORD_RECOVERY', 'USER_UPDATED'].includes(event)) return;
        // Otra pestaña cerró la sesión, o la sesión venció: la vista se ajusta
        // al estado real. Nunca se llama al SDK dentro de su propio callback.
        setTimeout(async () => {
          try {
            app.repository.invalidateSession?.();
            const before = actor()?.id || null;
            app.session = await app.repository.session({ fresh: true });
            if (event === 'SIGNED_OUT' && before && !isSignedIn()) toast('Tu sesión se cerró.');
            if (event === 'PASSWORD_RECOVERY') go('#recuperar');
            await render();
          } catch (error) { main.innerHTML = errorView(error); }
        }, 0);
      });
      const callback = await app.repository.completeAuthRedirect(location.href,
        () => history.replaceState(null, '', location.pathname));
      if (callback.handled) {
        app.recovering = callback.recovery;
        app.invited = Boolean(callback.invited);
        if (callback.error) {
          app.authNotice = callback.error.message;
          location.hash = '#cuenta';
        } else if (callback.confirmed) {
          app.authNotice = 'Tu correo quedó confirmado. Ya podés usar tu cuenta.';
          location.hash = '#cuenta';
        }
      }
    }
    app.session = await app.repository.session({ verify: true });
  } catch (error) {
    main.innerHTML = fatalView(isNetworkError(error) ? 'Sin conexión con MiFav' : 'No pudimos abrir tu sesión',
      userMessage(error));
    main.setAttribute('aria-busy', 'false');
    return;
  }
  bindEvents();
  app.started = true;
  if (app.recovering) { app.authNotice = ''; go('#recuperar'); }
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
