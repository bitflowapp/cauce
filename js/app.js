// CAUCE · Aluminé — shell de la aplicación.
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
import { createTelemetry, classify } from './core/telemetry.js';
import { nextOpening, MAX_RANGES_PER_DAY } from './core/business-hours.js';
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

const app = {
  repository: null,
  session: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  search: { query: '', category: 'Todos', onlyOpen: false },
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
// El entorno conectado es el que habla con CAUCE real: sus errores se muestran.
const isConnected = () => app.repository?.environment === 'supabase';
const actor = () => app.session?.actor || null;
const isSignedIn = () => actor()?.kind === 'account';
const hasRole = role => Boolean(actor()?.roles?.includes(role));
// Verticales: en la demostración todo sigue encendido; en el entorno conectado
// decide la base (app_status), para habilitar o apagar sin tocar código.
const feature = name => !isConnected() || app.features?.[name] === true;

// Lo que ve la persona: el mensaje de CAUCE, nunca el texto técnico de una
// excepción. El detalle queda en el registro de errores.
function userMessage(error) {
  if (error instanceof CauceError || error?.name === 'CauceError') return error.message;
  app.telemetry?.error(error, { where: 'ui' });
  return 'Ocurrió un problema inesperado. Reintentá en unos segundos; si sigue pasando, avisanos.';
}

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
    submitted: ['merchant', 'Pedido enviado', 'El comercio lo recibió y en breve confirma si lo toma.'],
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
const confirmNotice = () => `
  <p class="confirm-notice">${renderIcon('shield-check', 15)}
    <span>${app.repository?.capabilities?.orders
      ? 'El comercio recibe este pedido y lo prepara. El pago se coordina con el comercio: CAUCE no cobra nada.'
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
    <h2>${offline ? 'Sin conexión con CAUCE' : slow ? 'La conexión está lenta' : 'No pudimos abrir esta vista'}</h2>
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
    accountLink.setAttribute('aria-label', signedIn ? `Cuenta de ${actor().name}` : 'Ingresar a CAUCE');
    accountLink.classList.toggle('is-signed', signedIn);
  }

  const cartCount = app.cartCount || 0;
  const cartItem = /** @type {HTMLElement|null} */ (document.querySelector('#bnav-carrito'));
  if (cartItem) {
    cartItem.hidden = cartCount === 0;
    const badge = /** @type {HTMLElement|null} */ (cartItem.querySelector('.bnav-badge'));
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

// Abierto o cerrado, y por qué: el horario manda aunque el comercio se olvide
// de cerrar, y el interruptor manda aunque esté dentro de horario.
function availabilityText(business) {
  if (business.open) return 'Abierto';
  if (isConnected() && business.acceptingOrders) {
    const next = nextOpening(business.hours, new Date(), business.timezone);
    return next ? `Cerrado · ${next.label.replace('Abre ', 'abre ')}` : 'Cerrado';
  }
  return 'Cerrado';
}

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
        <span class="availability ${business.open ? '' : 'closed'}">${esc(availabilityText(business))}</span>
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
  const taxi = feature('taxi');
  const [businesses, orders, trips] = await Promise.all([
    app.repository.query('publicBusinesses'),
    app.repository.query('myOrders'),
    taxi ? app.repository.query('myTrips') : [],
  ]);

  const activeOrders = orders.filter(order => !['delivered', 'canceled'].includes(order.status));
  const activeTrip = trips.find(trip => isTaxiActive(trip.status));
  const open = businesses.filter(business => business.open);

  const operation = (activeOrders.length || activeTrip) ? `
    <section class="home-block">
      ${sectionHeading('EN CURSO', activeOrders.length > 1 ? 'Tus pedidos en curso' : 'Tu pedido en curso')}
      <div class="stack">
        ${activeOrders.slice(0, 3).map(order => `
          <a class="op-card" href="#pedido/${esc(order.id)}">
            <span class="op-card-icon">${renderIcon('receipt', 18)}</span>
            <span class="op-card-body">
              <strong>${esc(order.code)} · ${esc(businesses.find(b => b.id === order.businessId)?.name || 'Comercio')}</strong>
              <span class="quiet">${esc(fulfillmentLabel(order.fulfillment))} · ${money(order.total)}</span>
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

  const businessesBlock = businesses.length
    ? `<div class="merchant-grid">${(open.length ? open : businesses).slice(0, 4).map(businessCard).join('')}</div>`
    : isConnected()
      ? `<div class="notice"><strong>Estamos sumando los primeros comercios de Aluminé.</strong>
          Muy pronto vas a poder pedir desde acá. ¿Tenés un comercio? Sumalo en pocos pasos.</div>`
      : '<p class="quiet">Todavía no hay comercios publicados en este entorno.</p>';

  return `
    ${offlineBanner()}
    <section class="home-hero">
      <div class="home-hero-media" aria-hidden="true">
        <img src="assets/images/territory/alumine-hero-panoramica.webp" alt="" width="1200" height="600" fetchpriority="high">
      </div>
      <div class="home-hero-body">
        <p class="eyebrow">CAUCE · ALUMINÉ</p>
        <h1>${taxi ? 'Comprá local.<br>Movete por Aluminé.' : 'Comprá en los comercios<br>de Aluminé.'}</h1>
        ${taxi ? '' : '<p class="home-hero-lead">Retirá en el local o recibilo con el reparto del propio comercio. Sin crear una cuenta.</p>'}
        <div class="home-actions">
          <a class="button button-hero" href="#comercios">${renderIcon('store', 18)} Ver comercios</a>
          ${taxi
            ? `<a class="button button-hero-outline" href="#taxi">${renderIcon('taxi', 18)} Pedir un taxi</a>`
            : `<a class="button button-hero-outline" href="#actividad">${renderIcon('receipt', 18)} Mis pedidos</a>`}
        </div>
      </div>
      <div class="home-hero-character" aria-hidden="true">${renderCharacter('shopper', 180)}</div>
    </section>

    ${operation}

    <section class="home-block">
      ${sectionHeading('COMERCIOS', open.length ? 'Abiertos ahora' : 'Comercios en CAUCE',
        businesses.length ? `<a class="link-button" href="#comercios">Ver todos</a>` : '')}
      ${businessesBlock}
    </section>

    ${isConnected() ? `
    <section class="home-block">
      ${sectionHeading('CÓMO FUNCIONA', 'Pedir es simple')}
      <ol class="how-steps">
        <li><strong>Elegí un comercio</strong><span>Mirá el catálogo con precios y qué está disponible hoy.</span></li>
        <li><strong>Confirmá tu pedido</strong><span>Retiro en el local o envío del comercio. Pagás al recibir o al retirar.</span></li>
        <li><strong>Seguilo en vivo</strong><span>Ves cuando lo aceptan, lo preparan y sale. Te damos un enlace para no perderlo.</span></li>
      </ol>
    </section>` : ''}

    <section class="home-block home-secondary">
      <a class="secondary-access" href="#alta-comercio">
        <span class="secondary-access-icon" aria-hidden="true">${renderSticker('merchant', 40)}</span>
        <span>
          <strong>Sumar mi comercio</strong>
          <span class="quiet">Creá tu cuenta, cargá tu catálogo y empezá a recibir pedidos.</span>
        </span>
      </a>
      ${taxi ? `
      <a class="secondary-access" href="#taxista">
        <span class="secondary-access-icon" aria-hidden="true">${renderSticker('taxi', 40)}</span>
        <span>
          <strong>Registrarme como taxista</strong>
          <span class="quiet">Completá tu alta y recibí solicitudes cuando esté aprobada.</span>
        </span>
      </a>` : ''}
      <a class="secondary-access quiet-access" href="#institucional">
        <span class="secondary-access-icon" aria-hidden="true">${renderIcon('shield-check', 26)}</span>
        <span>
          <strong>Qué es CAUCE</strong>
          <span class="quiet">${isConnected() ? 'Quiénes somos, cómo funciona y a quién consultar.' : 'Alcance, responsabilidades y propuesta de piloto.'}</span>
        </span>
      </a>
    </section>`;
}

async function viewBusinesses() {
  const businesses = await app.repository.query('publicBusinesses');
  const categories = ['Todos', ...new Set(businesses.map(business => business.category).filter(Boolean))];
  // Buscar "pizza" tiene que encontrar al comercio que vende pizza, no sólo al
  // que se llama así: se consulta el catálogo de cada comercio publicado.
  // En el entorno conectado es una sola consulta para todos los catálogos.
  const catalogs = !app.search.query.trim() ? {}
    : isConnected() ? await app.repository.query('searchCatalog', { query: app.search.query })
    : Object.fromEntries(await Promise.all(businesses.map(async business => [
      business.id,
      (await app.repository.query('products', { businessId: business.id })).map(product => product.name).join(' '),
    ])));
  const visible = filterBusinesses(businesses, catalogs);

  return `
    ${offlineBanner()}
    <section class="page-header">
      <h1 class="page-title">Comercios de Aluminé</h1>
      <p class="quiet">${isConnected()
        ? `${pluralize(businesses.length, 'comercio publicado', 'comercios publicados')} · ${pluralize(businesses.filter(business => business.open).length, 'abierto ahora', 'abiertos ahora')}`
        : `${pluralize(businesses.length, 'comercio publicado', 'comercios publicados')} en este entorno · contenido ficticio de demostración.`}</p>
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

    ${!businesses.length
      ? emptyState('Todavía no hay comercios publicados',
        'Estamos sumando los primeros comercios de Aluminé. Volvé pronto, o sumá el tuyo.',
        '#alta-comercio', 'Sumar mi comercio', 'merchant')
      : visible.length
      ? `<div class="merchant-grid">${visible.map(businessCard).join('')}</div>`
      : emptyState('Sin resultados',
        'La búsqueda mira el nombre del comercio, su rubro y sus productos. Probá con otra palabra o quitá los filtros.',
        '#comercios', 'Ver todos los comercios', 'bag')}`;
}

// Un comercio pausado, suspendido o en borrador no es público: se explica en
// lugar de mostrar un error.
async function loadPublicBusiness(businessId) {
  try {
    return await app.repository.query('business', { businessId });
  } catch (error) {
    if (error?.code === 'BUSINESS_NOT_FOUND') return null;
    throw error;
  }
}

const unavailableBusiness = () => emptyState('Este comercio no está disponible',
  'Puede estar pausado o en revisión. Mirá los otros comercios de Aluminé.', '#comercios', 'Ver comercios', 'bag');

async function viewBusiness(businessId) {
  if (!businessId) return emptyState('Comercio no encontrado', 'Elegí un comercio del listado.');
  const business = await loadPublicBusiness(businessId);
  if (!business) return unavailableBusiness();
  const [products, cart] = await Promise.all([
    app.repository.query('products', { businessId }),
    app.repository.query('cart', { businessId }),
  ]);
  const lines = new Map(cart.lines.map(line => [line.productId, line.quantity]));
  const purchasable = products.filter(product => !product.archived);
  // Las secciones siguen el orden que eligió el comercio; lo que no tiene
  // categoría visible ("Otros") va al final.
  const rankOf = new Map();
  for (const product of purchasable) {
    if (!rankOf.has(product.category)) rankOf.set(product.category, product.categoryPosition ?? Number.MAX_SAFE_INTEGER);
  }
  const categories = [...rankOf.keys()].sort((a, b) => rankOf.get(a) - rankOf.get(b));
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
          ${available ? '' : `<p class="product-flag">${product.available === false ? 'Agotado por hoy' : stock <= 0 ? 'Sin stock' : 'No disponible'}</p>`}
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
          <span class="availability ${business.open ? '' : 'closed'}">${esc(availabilityText(business))}</span>
          ${business.hoursLabel && !(business.hours || []).length ? `<span>${renderIcon('clock', 14)} ${esc(business.hoursLabel)}</span>` : ''}
          ${business.address ? `<span>${renderIcon('pin', 14)} ${esc(business.address)}</span>` : ''}
          ${timesLine(business) ? `<span>${renderIcon('clock', 14)} ${esc(timesLine(business))}</span>` : ''}
        </div>
        <div class="shop-meta">
          ${business.pickupEnabled ? `<span class="tag">${renderIcon('bag', 13)} Retiro en el comercio</span>` : ''}
          ${business.deliveryEnabled ? `<span class="tag">${renderIcon('delivery', 13)} Envío ${business.deliveryFee > 0 ? money(business.deliveryFee) : 'sin costo'}${business.minimumOrder > 0 ? ` · mínimo ${money(business.minimumOrder)}` : ''}</span>` : ''}
        </div>
        ${business.deliveryZone ? `<p class="microcopy">Zona de envío declarada por el comercio: ${esc(business.deliveryZone)}.</p>` : ''}
        ${isConnected() ? contactButtons(business, { compact: true }) : ''}
      </div>
    </section>
    ${isConnected() && (business.hours || []).length ? `<details class="hours-details"><summary>Horarios de atención</summary>${hoursSummary(business)}</details>` : ''}

    ${business.open ? '' : `<div class="notice" role="status"><strong>${esc(availabilityText(business))}.</strong> Podés mirar el catálogo y armar tu pedido; se confirma cuando el comercio esté recibiendo pedidos.</div>`}

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
  const business = await loadPublicBusiness(businessId);
  if (!business) return unavailableBusiness();
  const [products, cart] = await Promise.all([
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
  catch (error) { quoteError = userMessage(error); }

  // Una línea cuyo producto se dio de baja, se agotó o cambió de opciones se
  // marca y se puede quitar: nunca queda trabada en el carrito.
  const detail = cart.lines.map(line => {
    const product = products.find(candidate => candidate.id === line.productId && !candidate.archived);
    const variant = (product?.variants || []).find(item => item.id === line.variantId) || null;
    const unavailable = !product || !isCommerciallyPurchasable(product)
      || (line.variantId && !variant) || (!line.variantId && (product?.variants || []).length > 0);
    return { line, product, variant, unavailable };
  });
  const unavailableCount = detail.filter(item => item.unavailable).length;
  const notice = app.checkoutNotice?.businessId === businessId ? app.checkoutNotice : null;

  return `
    ${offlineBanner()}
    ${backLink(`#comercio/${business.id}`, business.name)}
    <section class="page-header">
      <h1 class="page-title">Confirmar pedido</h1>
      <p class="quiet">${esc(business.name)}${timesLine(business, fulfillment) ? ` · ${esc(timesLine(business, fulfillment))}` : ''}</p>
    </section>

    ${notice ? `<div class="notice ${notice.tone === 'error' ? 'error' : ''}" role="alert">${esc(notice.message)}</div>` : ''}
    ${business.open ? '' : `<div class="notice" role="status"><strong>${esc(availabilityText(business))}.</strong> Vas a poder confirmar cuando el comercio esté recibiendo pedidos.</div>`}

    <section class="checkout-section">
      <h2 class="checkout-section-title">Tu pedido</h2>
      <ul class="cart-lines-list">
        ${detail.map(({ line, product, variant, unavailable }) => {
          const unit = (confirmedPrice(product || {}) || 0) + (variant ? Number(variant.priceDelta) || 0 : 0);
          const variantAttribute = line.variantId ? ` data-variant="${esc(line.variantId)}"` : '';
          return `
          <li class="cart-line ${unavailable ? 'is-unavailable' : ''}">
            <div class="cart-line-product">
              ${productThumb(product, product?.name)}
              <div class="cart-line-info">
                <span class="cart-line-title">${esc(product?.name || 'Producto que ya no está en el catálogo')}${variant ? ` · ${esc(variant.name)}` : ''}</span>
                <span class="cart-line-unit-price">${unavailable ? 'No disponible' : `${money(unit)} c/u`}</span>
              </div>
            </div>
            ${unavailable ? `
            <button class="button secondary" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
              data-product="${esc(line.productId)}"${variantAttribute} data-quantity="0">Quitar</button>` : `
            <div class="cart-line-controls">
              <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                data-product="${esc(line.productId)}"${variantAttribute} data-quantity="${line.quantity - 1}" aria-label="Quitar una unidad de ${esc(product.name)}">−</button>
              <span class="qty-value">${line.quantity}</span>
              <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(business.id)}"
                data-product="${esc(line.productId)}"${variantAttribute} data-quantity="${line.quantity + 1}" aria-label="Agregar una unidad de ${esc(product.name)}"
                ${line.quantity >= Math.min(99, knownStock(product) ?? 0) ? 'disabled' : ''}>+</button>
            </div>
            <span class="cart-line-total">${money(unit * line.quantity)}</span>`}
          </li>`;
        }).join('')}
      </ul>
      ${unavailableCount > 1 ? `<button class="link-button" type="button" data-action="remove-unavailable" data-business="${esc(business.id)}">Quitar los ${unavailableCount} productos no disponibles</button>` : ''}
    </section>

    ${quoteError && !unavailableCount ? `<div class="notice error" role="alert"><strong>Revisá tu pedido.</strong> ${esc(quoteError)}</div>` : ''}

    <form class="checkout-form" data-form="checkout" data-business="${esc(business.id)}"
      data-expected-total="${quote ? quote.total : ''}" novalidate>
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
                  : `${business.deliveryFee > 0 ? money(business.deliveryFee) : 'Sin costo'}${business.minimumOrder > 0 ? ` · mínimo ${money(business.minimumOrder)}` : ''}${business.deliveryZone ? ` · ${esc(business.deliveryZone)}` : ''}`}</span>
              </span>
            </label>`).join('')}
        </div>
      </section>

      <section class="checkout-section">
        <h2 class="checkout-section-title">Tus datos</h2>
        ${isConnected() && !isSignedIn() ? `<p class="microcopy">No hace falta crear una cuenta. El comercio usa estos datos sólo para este pedido.</p>` : ''}
        <div class="field">
          <label for="checkout-name">Nombre y apellido</label>
          <input id="checkout-name" name="name" type="text" required minlength="2" maxlength="80"
            autocomplete="name" value="${esc(stored.name || (isSignedIn() ? actor().name : ''))}">
        </div>
        <div class="field">
          <label for="checkout-phone">Teléfono de contacto</label>
          <input id="checkout-phone" name="phone" type="tel" required inputmode="tel" autocomplete="tel"
            placeholder="2942 000000" value="${esc(stored.phone || (isSignedIn() ? actor().phone || '' : ''))}">
          <p class="microcopy">El comercio te llama o escribe si hay algún cambio.</p>
        </div>
        ${fulfillment === 'delivery' ? `
          <div class="field">
            <label for="checkout-address">Dirección de entrega</label>
            <input id="checkout-address" name="address" type="text" required minlength="5" maxlength="200"
              autocomplete="street-address" placeholder="Calle, número y referencia" value="${esc(stored.address || '')}">
          </div>
          ${business.deliveryZone ? `
            <label class="check-label">
              <input type="checkbox" name="zoneAcknowledged" ${stored.zoneAcknowledged ? 'checked' : ''}>
              <span>Confirmo que la dirección está dentro de la zona de reparto del comercio (${esc(business.deliveryZone)}).</span>
            </label>` : ''}` : ''}
        <div class="field">
          <label for="checkout-notes">Notas para el comercio (opcional)</label>
          <textarea id="checkout-notes" name="notes" rows="2" maxlength="280">${esc(stored.notes || '')}</textarea>
        </div>
      </section>

      <section class="checkout-section">
        <h2 class="checkout-section-title">Forma de pago</h2>
        ${app.repository.capabilities.orders ? `
          <div class="choice-group" role="radiogroup" aria-label="Forma de pago">
            <label class="choice active">
              <input type="radio" name="paymentMethod" value="cash" checked>
              <span class="choice-body"><strong>${fulfillment === 'delivery' ? 'Efectivo al recibir' : 'Efectivo al retirar'}</strong>
                <span class="quiet">Se paga directamente al comercio</span></span>
            </label>
          </div>
          <p class="microcopy">CAUCE no cobra ni intermedia el pago.</p>`
        : `
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
          <p class="microcopy">Los pagos en línea no están habilitados en esta entrega. El pedido y el pago son estados independientes.</p>`}
      </section>

      <section class="checkout-section checkout-total">
        <h2 class="checkout-section-title">Total</h2>
        ${quote ? `
          <dl class="totals">
            <div><dt>Subtotal</dt><dd>${money(quote.subtotal)}</dd></div>
            <div><dt>${fulfillment === 'delivery' ? 'Envío' : 'Retiro'}</dt><dd>${fulfillment === 'delivery' ? money(quote.deliveryFee) : 'Sin costo'}</dd></div>
            <div class="totals-final"><dt>Total</dt><dd>${money(quote.total)}</dd></div>
          </dl>
          <p class="microcopy">${isConnected()
            ? 'CAUCE confirma precios y disponibilidad al enviar. Si algo cambió, te lo mostramos antes de crear el pedido.'
            : `El importe se recalcula ${isShared() ? 'en el servidor' : 'con el catálogo guardado'} al confirmar.`}</p>`
        : `<p class="quiet">${unavailableCount ? 'Quitá los productos no disponibles para ver el total.' : 'No se puede calcular el total hasta resolver los avisos de arriba.'}</p>`}
      </section>

      ${confirmNotice()}

      <button class="button button-confirm-order full" type="submit"
        ${quote && app.online && business.open ? '' : 'disabled'}>Confirmar pedido${quote ? ` · ${money(quote.total)}` : ''}</button>
      ${!app.online && isShared() ? '<p class="microcopy">Sin conexión no se confirma. Reintentá cuando vuelva.</p>' : ''}
    </form>`;
}

// Enlace de seguimiento: abre el pedido desde cualquier dispositivo, sin sesión.
const trackingUrl = token => new URL(`index.html#seguimiento/${token}`, location.href.split('#')[0]).href;

function orderTimeline(order) {
  const steps = stepsFor(order.fulfillment);
  const current = stepIndex(order);
  const reached = new Map((order.history || []).map(step => [step.status, step.at]));
  return `<ol class="timeline" aria-label="Estado del pedido">
    ${steps.map((step, index) => `
      <li class="timeline-step ${index < current ? 'done' : index === current ? 'current' : ''}"
        ${index === current ? 'aria-current="step"' : ''}>
        <span class="timeline-dot" aria-hidden="true"></span>
        <span>${esc(orderStatusLabel({ ...order, status: step }))}${reached.get(step) ? ` <span class="quiet">· ${esc(timeOnly(reached.get(step)))}</span>` : ''}</span>
      </li>`).join('')}
  </ol>`;
}

function orderDetail(order) {
  return `<section class="checkout-section">
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
      <p class="microcopy">Pago: ${esc(paymentLabel(order.paymentMethod))}${order.status === 'delivered' ? '' : ' · se paga al comercio en la entrega.'}</p>
      ${order.deliveryCode && order.status !== 'delivered' ? `<p class="microcopy">Código de entrega: <strong>${esc(formatDeliveryCode(order.deliveryCode.code))}</strong> · decíselo a quien te entrega el pedido.</p>` : ''}
      ${order.customer?.address ? `<p class="microcopy">Dirección: ${esc(order.customer.address)}</p>` : ''}
    </section>`;
}

function cancellationNotice(order) {
  return `<div class="notice ${order.cancellation?.kind === 'rejected' ? 'error' : ''}" role="status">
    <strong>${order.cancellation?.kind === 'rejected' ? 'El comercio no pudo tomar el pedido.' : 'Pedido cancelado.'}</strong>
    ${order.cancellation?.reason ? `Motivo: ${esc(order.cancellation.reason)}` : ''}
  </div>`;
}

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

  return `
    ${offlineBanner()}
    ${backLink('#actividad', 'Mis pedidos')}
    <section class="page-header">
      <span class="eyebrow">PEDIDO ${esc(order.code)}</span>
      <h1 class="page-title">${esc(businessName)}</h1>
      <p class="quiet">${esc(fulfillmentLabel(order.fulfillment))} · ${esc(shortDate(order.createdAt))}</p>
    </section>

    ${canceled ? cancellationNotice(order) : orderTimeline(order)}
    ${canceled || !business ? '' : renderOrderMoment(order)}
    ${canceled || !business ? '' : renderDeliveryTracking(order, business)}
    ${!closed && business && timesLine(business, order.fulfillment) ? `<p class="microcopy">Tiempo estimado declarado por el comercio: ${esc(timesLine(business, order.fulfillment))}.</p>` : ''}

    ${isConnected() && order.trackingToken && !closed ? `
    <section class="checkout-section tracking-share">
      <h2 class="checkout-section-title">Seguí tu pedido desde cualquier lugar</h2>
      <p class="microcopy">Guardá este enlace: muestra el estado del pedido aunque cambies de teléfono o cierres el navegador.</p>
      <div class="modal-actions">
        <button class="button secondary" type="button" data-action="copy-tracking" data-url="${esc(trackingUrl(order.trackingToken))}">${renderIcon('link', 16)} Copiar enlace</button>
        ${typeof navigator !== 'undefined' && navigator.share ? `<button class="button secondary" type="button" data-action="share-tracking" data-url="${esc(trackingUrl(order.trackingToken))}" data-code="${esc(order.code)}">Compartir</button>` : ''}
      </div>
    </section>` : ''}

    ${isConnected() && business && !closed ? `<section class="checkout-section">
      <h2 class="checkout-section-title">¿Necesitás hablar con ${esc(businessName)}?</h2>
      ${contactButtons(business) || '<p class="quiet">El comercio no publicó un teléfono.</p>'}
    </section>` : ''}

    ${orderDetail(order)}

    ${allowedActions(order, { kind: 'customer', id: order.customerId }).includes('canceled') ? `
      <button class="button danger full" type="button" data-action="cancel-order"
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
  return `
    ${offlineBanner()}
    <section class="page-header">
      <span class="eyebrow">PEDIDO ${esc(order.code)}</span>
      <h1 class="page-title">${esc(order.business.name)}</h1>
      <p class="quiet">${esc(fulfillmentLabel(order.fulfillment))} · ${esc(shortDate(order.createdAt))}</p>
    </section>
    ${canceled ? cancellationNotice(order) : orderTimeline(order)}
    ${canceled ? '' : renderOrderMoment(order)}
    ${!canceled && order.status !== 'delivered' && timesLine(order.business, order.fulfillment)
      ? `<p class="microcopy">Tiempo estimado declarado por el comercio: ${esc(timesLine(order.business, order.fulfillment))}.</p>` : ''}
    ${canceled || order.status === 'delivered' ? '' : contactButtons(order.business)}
    ${orderDetail(order)}
    <p class="microcopy">Esta página se actualiza sola cada medio minuto.</p>`;
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
        <button class="secondary-access" type="button" data-action="sign-out">
          <span class="secondary-access-icon" aria-hidden="true">${renderIcon('user', 26)}</span>
          <span><strong>Cerrar sesión</strong><span class="quiet">${esc(actor().email || '')}</span></span>
        </button>` : `
        <a class="secondary-access" href="#cuenta">
          <span class="secondary-access-icon" aria-hidden="true">${renderIcon('user', 26)}</span>
          <span><strong>Ingresar o crear cuenta</strong><span class="quiet">${taxi ? 'Necesaria para comercios, taxistas y administración.' : 'Para comercios y su equipo. Para comprar no hace falta.'}</span></span>
        </a>`}
      ${hasRole('merchant') ? `<a class="secondary-access" href="#panel"><span class="secondary-access-icon" aria-hidden="true">${renderIcon('store', 26)}</span><span><strong>Panel de mi comercio</strong><span class="quiet">Pedidos, catálogo y reparto.</span></span></a>` : ''}
      ${hasRole('driver') && taxi ? `<a class="secondary-access" href="#taxista"><span class="secondary-access-icon" aria-hidden="true">${renderIcon('taxi', 26)}</span><span><strong>Panel de taxista</strong><span class="quiet">Disponibilidad y solicitudes.</span></span></a>` : ''}
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
  const notice = app.authNotice ? `<div class="notice" role="status">${esc(app.authNotice)}</div>` : '';
  if (isSignedIn()) {
    return `
      ${backLink('#actividad', 'Mi actividad')}
      <section class="page-header">
        <h1 class="page-title">Tu cuenta</h1>
        <p class="quiet">${esc(actor().name)} · ${esc(actor().email || 'sin correo')}</p>
      </section>
      ${notice}
      <section class="checkout-section">
        <h2 class="checkout-section-title">Accesos</h2>
        <p class="quiet">Accesos: ${esc(actor().roles.map(role => ROLE_LABELS[role] || role).join(' · '))}</p>
        <div class="stack">
          ${hasRole('merchant') ? '<a class="button secondary" href="#panel">Panel de mi comercio</a>' : '<a class="button secondary" href="#alta-comercio">Sumar mi comercio</a>'}
          ${!feature('taxi') ? '' : hasRole('driver') ? '<a class="button secondary" href="#taxista">Panel de taxista</a>' : '<a class="button secondary" href="#taxista">Registrarme como taxista</a>'}
          ${hasRole('admin') ? '<a class="button secondary" href="#admin">Administración</a>' : ''}
          <button class="button danger" type="button" data-action="sign-out">Cerrar sesión</button>
        </div>
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
        <form class="checkout-form" data-form="password-update">
          <h2 class="checkout-section-title">Cambiar contraseña</h2>
          <div class="field">
            <label for="current-password">Contraseña actual</label>
            <input id="current-password" name="currentPassword" type="password" required autocomplete="current-password">
          </div>
          <div class="field">
            <label for="new-password">Nueva contraseña</label>
            <input id="new-password" name="password" type="password" required minlength="10" autocomplete="new-password">
            <p class="microcopy">Al menos 10 caracteres, combinando letras y números.</p>
          </div>
          <button class="button secondary full" type="submit" ${app.online ? '' : 'disabled'}>Guardar contraseña</button>
        </form>` : ''}`;
  }

  const identities = app.repository.capabilities.demoIdentities ? await app.repository.identities() : [];

  return `
    ${offlineBanner()}
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header">
      <h1 class="page-title">Ingresar a CAUCE</h1>
      <p class="quiet">${feature('taxi')
        ? 'Comprar y pedir un taxi no requiere cuenta. La cuenta hace falta para comercios, taxistas y administración.'
        : 'Para comprar no hace falta cuenta. La cuenta es para comercios, su equipo y administración.'}</p>
    </section>
    ${notice}

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
      </form>

      ${app.repository.capabilities.accountManagement ? `
      <form class="checkout-form" data-form="password-reset">
        <h2 class="checkout-section-title">Recuperar contraseña</h2>
        <div class="field">
          <label for="reset-email">Correo de tu cuenta</label>
          <input id="reset-email" name="email" type="email" required autocomplete="email" inputmode="email">
        </div>
        <button class="button secondary full" type="submit" ${app.online ? '' : 'disabled'}>Enviar enlace de recuperación</button>
      </form>
      <form class="checkout-form" data-form="resend-confirmation">
        <h2 class="checkout-section-title">¿No te llegó el correo de confirmación?</h2>
        <div class="field">
          <label for="resend-email">Correo con el que te registraste</label>
          <input id="resend-email" name="email" type="email" required autocomplete="email" inputmode="email">
        </div>
        <button class="button secondary full" type="submit" ${app.online ? '' : 'disabled'}>Reenviar confirmación</button>
        <p class="microcopy">Revisá también la carpeta de correo no deseado.</p>
      </form>` : ''}`
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
      <p class="quiet">${app.invited ? 'Te invitaron a CAUCE. Con esta contraseña vas a ingresar a partir de ahora. · ' : ''}${esc(actor().email || '')}</p>
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
  const sections = panelSections(role, { connected });
  const section = resolveSection(route().extra, sections);

  const [orders, products, riders, categories, team, serverRequirements, productCategories] = await Promise.all([
    app.repository.query('businessOrders', { businessId }),
    app.repository.query('products', { businessId }),
    ['inicio', 'pedidos', 'reparto'].includes(section) ? app.repository.query('riders', { businessId }) : [],
    canManage && section === 'configuracion' && app.repository.capabilities.media ? app.repository.query('businessCategories') : [],
    section === 'equipo' ? app.repository.query('team', { businessId }) : [],
    // En el entorno conectado los requisitos de publicación los decide el servidor.
    connected && canManage && section === 'configuracion' ? app.repository.query('businessRequirements', { businessId }) : null,
    connected && section === 'catalogo' ? app.repository.query('productCategories', { businessId }) : [],
  ]);
  const requirements = serverRequirements || missingPublicationRequirements(business, products);

  // Pedidos nuevos desde la última vez que el panel los vio: aviso sonoro y
  // visual. La primera carga sólo registra lo que ya estaba.
  const seen = app.seenOrders.get(businessId);
  const { pending, fresh } = freshOrderIds(orders, seen);
  app.seenOrders.set(businessId, new Set([...(seen || []), ...pending]));
  if (fresh.length) announceNewOrders(fresh.length);
  else if (!pending.length) clearOrderAlert();
  hideFloatingOrderAlert();
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
      ${canManage ? merchantRidersTab(business, riders) : ''}`;
  } else if (section === 'equipo') {
    content = teamTab(business, team, { isOwner: role === 'owner', role });
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
      <span>Controlar stock: CAUCE descuenta cada venta y deja de vender en cero. Si no lo marcás, el producto se vende mientras esté disponible y lo marcás agotado a mano.</span>
    </label>` : ''}
    <div class="field">
      <label for="${prefix}-category">Categoría</label>
      <input id="${prefix}-category" name="category" type="text" required maxlength="40" list="categorias" value="${esc(product?.category || 'Otros')}">
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

function merchantDataTab(business, missing, categories = []) {
  const editable = !['pending_review', 'suspended'].includes(business.status);
  const media = Boolean(app.repository.capabilities.media);
  const connected = isConnected();
  const disabled = editable ? '' : 'disabled';
  return `
    <section class="panel-section">
      ${business.status === 'pending_review'
        ? '<div class="notice">La solicitud está en revisión. Vas a poder editar cuando administración responda.</div>' : ''}
      <form class="checkout-form" data-form="business-update" data-business="${esc(business.id)}">
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
          <label for="b-phone">Teléfono de contacto con CAUCE</label>
          <input id="b-phone" name="contactPhone" type="tel" inputmode="tel" value="${esc(business.contactPhone || '')}" ${disabled}>
          ${connected ? '<p class="microcopy">Privado: sólo lo ve administración de CAUCE.</p>' : ''}
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
        </div>

        <h2 class="checkout-section-title">Modalidades de entrega</h2>
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
            placeholder="Casco urbano de Aluminé" ${disabled}>
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
        </div>` : ''}
        <button class="button full" type="submit" ${editable && app.online ? '' : 'disabled'}>Guardar datos</button>
      </form>
    </section>

    ${media ? `<section class="panel-section">
      <h2 class="checkout-section-title">Imagen del comercio</h2>
      <p class="quiet">Las imágenes se guardan en CAUCE, dentro de la carpeta de tu comercio. Nadie más puede escribir ahí.</p>
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
        <p class="microcopy">Pausado no aparece en CAUCE ni recibe pedidos. Para un día sin atención alcanza con “Cerrar atención”.</p>` : ''}
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
      ${riders.length ? `<ul class="plain-list rider-list">${riders.map(rider => `
        <li class="${rider.active === false ? 'is-inactive' : ''}"><span><strong>${esc(rider.name)}</strong>${rider.phone ? ` · ${esc(rider.phone)}` : ''}${rider.active === false ? ' · <span class="quiet">inactivo</span>' : ''}</span>
          ${isConnected() ? `<button class="link-button" type="button" data-action="rider-toggle" data-rider="${esc(rider.id)}"
            data-active="${rider.active === false ? 'true' : 'false'}">${rider.active === false ? 'Reactivar' : 'Pausar'}</button>` : ''}</li>`).join('')}</ul>`
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
  const [queue, metrics, events] = await Promise.all([
    app.repository.query('adminQueue'),
    app.repository.query('adminMetrics'),
    isConnected() ? app.repository.query('adminClientEvents').catch(() => []) : [],
  ]);
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

    ${feature('taxi') ? `<section class="panel-section">
      <h2 class="checkout-section-title">Taxistas pendientes (${queue.drivers.length})</h2>
      ${queue.drivers.length ? `<div class="stack">${queue.drivers.map(item => reviewCard(item, 'driver')).join('')}</div>`
        : '<p class="quiet">No hay altas de conductores esperando revisión.</p>'}
    </section>` : ''}

    ${isConnected() ? `<section class="panel-section">
      <h2 class="checkout-section-title">Comercios publicados (${published.length})</h2>
      ${published.length ? `<ul class="plain-list admin-business-list">${published.map(item => `
        <li><span><strong>${esc(item.name)}</strong> · ${esc(businessStatusLabel(item.status))} · ${esc(item.category || 'sin rubro')}</span>
          <button class="link-button danger" type="button" data-action="admin-business-status" data-business="${esc(item.id)}"
            data-status="suspended" data-name="${esc(item.name)}">Suspender</button></li>`).join('')}</ul>`
        : '<p class="quiet">Todavía no hay comercios publicados.</p>'}
      ${suspended.length ? `<h3 class="checkout-section-title">Suspendidos (${suspended.length})</h3>
      <ul class="plain-list admin-business-list">${suspended.map(item => `
        <li><span><strong>${esc(item.name)}</strong>${item.reviewNote ? ` · ${esc(item.reviewNote)}` : ''}</span>
          <button class="link-button" type="button" data-action="admin-business-status" data-business="${esc(item.id)}"
            data-status="active" data-name="${esc(item.name)}">Rehabilitar</button></li>`).join('')}</ul>` : ''}
    </section>` : ''}

    <section class="panel-section">
      <h2 class="checkout-section-title">Operación registrada</h2>
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
    </section>

    ${isConnected() ? `<section class="panel-section">
      <h2 class="checkout-section-title">Errores recientes en dispositivos (${events.length})</h2>
      ${events.length ? `<ul class="plain-list event-list">${events.map(event => `
        <li><span class="quiet">${esc(shortDate(event.created_at))}</span> · <strong>${esc(event.kind)}</strong> · ${esc(event.code)}
          ${event.route ? `· ${esc(event.route)}` : ''}<br><span class="microcopy">${esc(event.message)}</span></li>`).join('')}</ul>`
        : '<p class="quiet">Sin errores registrados.</p>'}
      <p class="microcopy">Sin datos personales: correos, teléfonos y tokens se descartan antes de guardar.</p>
    </section>` : ''}`;
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

async function viewInstitutionalConnected() {
  const counts = await app.repository.query('snapshotCounts');
  return `
    ${backLink('#inicio', 'Inicio')}
    <section class="page-header">
      <span class="eyebrow">CAUCE · ALUMINÉ</span>
      <h1 class="page-title">Qué es CAUCE</h1>
      <p class="quiet">Una plataforma local para que los comercios de Aluminé reciban pedidos en línea
        y los vecinos compren fácil, con trato directo con cada comercio.</p>
    </section>
    <section class="checkout-section">
      <h2 class="checkout-section-title">Para quienes compran</h2>
      <ul class="plain-list">
        <li>Elegís un comercio, armás tu pedido y lo confirmás sin crear una cuenta.</li>
        <li>Retirás en el local o lo recibís con el reparto del propio comercio.</li>
        <li>Pagás directamente al comercio, al retirar o al recibir. CAUCE no cobra nada.</li>
        <li>Seguís el estado del pedido en vivo y guardás un enlace para verlo desde cualquier lugar.</li>
      </ul>
    </section>
    <section class="checkout-section">
      <h2 class="checkout-section-title">Para los comercios</h2>
      <ul class="plain-list">
        <li>Cargás tus datos, horarios y catálogo; CAUCE revisa el alta antes de publicarla.</li>
        <li>Recibís los pedidos en un panel que funciona en el celular, con aviso sonoro.</li>
        <li>Sumás a tu equipo con distintos permisos y administrás tu propio reparto.</li>
      </ul>
      <a class="button full" href="#alta-comercio">Sumar mi comercio</a>
    </section>
    <section class="checkout-section">
      <h2 class="checkout-section-title">Responsabilidades</h2>
      <ul class="plain-list">
        <li><strong>LUNA</strong> desarrolla y opera la plataforma y revisa las altas dentro de CAUCE.</li>
        <li><strong>Cada comercio</strong> responde por sus precios, su stock, la preparación, su reparto y las habilitaciones de su actividad.</li>
        <li>La aprobación de CAUCE habilita la publicación en la plataforma; no reemplaza permisos municipales.</li>
      </ul>
    </section>
    <section class="checkout-section">
      <h2 class="checkout-section-title">Hoy en CAUCE</h2>
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
  busy.actions += 1;
  settle();
  try {
    await operation();
  } catch (error) {
    if (isNetworkError(error)) {
      toast('Sin conexión con CAUCE. No se envió nada: reintentá cuando vuelva.', 'error');
    } else {
      toast(userMessage(error), 'error');
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
    return render();
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
      await navigator.share({ title: `Pedido ${element.dataset.code} · CAUCE`, url: element.dataset.url });
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
    } else if (!await askConfirm({ title: `Rehabilitar ${name}`, message: 'Vuelve a aparecer en CAUCE.', confirmLabel: 'Rehabilitar', danger: false })) {
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
    const data = new FormData(form);
    app.search.query = String(data.get('query') || '');
    app.search.onlyOpen = data.get('onlyOpen') === 'on';
    return render();
  },

  async 'sign-in'(form) {
    const data = Object.fromEntries(new FormData(form));
    await app.repository.signIn({ email: data.email, password: data.password });
    app.session = await app.repository.session();
    app.authNotice = '';
    toast(`Hola, ${actor().name}.`);
    // Si se pidió ingresar a mitad de una compra, se vuelve al carrito.
    const target = app.returnTo || (hasRole('admin') ? '#admin' : hasRole('merchant') ? '#panel' : '#actividad');
    app.returnTo = null;
    go(target);
    await render({ focus: true });
  },

  async register(form) {
    const data = Object.fromEntries(new FormData(form));
    const result = await app.repository.register(data);
    if (result?.confirmationRequired) {
      form.reset();
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
      price: Number(data.price), variants: parseVariants(data.variants) };
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
        name: data.name, description: data.description, category: data.category,
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
        app.returnTo = `#carrito/${businessId}`;
        go('#cuenta');
        return;
      }
      throw error;
    }
    app.formDrafts.delete(`checkout:${businessId}`);
    app.session = await app.repository.session();
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
  recuperar: viewRecovery,
  seguimiento: viewTracking,
};

// Títulos por ruta y rutas que nunca se indexan (paneles y datos personales).
const ROUTE_TITLES = Object.freeze({
  inicio: 'CAUCE · Aluminé', comercios: 'Comercios · CAUCE', carrito: 'Carrito · CAUCE', pedido: 'Tu pedido · CAUCE',
  actividad: 'Mis pedidos · CAUCE', cuenta: 'Tu cuenta · CAUCE', 'alta-comercio': 'Sumar mi comercio · CAUCE',
  panel: 'Panel del comercio · CAUCE', admin: 'Administración · CAUCE', institucional: 'Qué es CAUCE',
  recuperar: 'Recuperar contraseña · CAUCE', seguimiento: 'Seguimiento de pedido · CAUCE',
});
const PRIVATE_ROUTES = new Set(['carrito', 'pedido', 'actividad', 'cuenta', 'alta-comercio', 'panel', 'admin',
  'recuperar', 'seguimiento', 'taxista', 'viaje']);
const TAXI_ROUTES = new Set(['taxi', 'viaje', 'taxista']);

function applyRouteMeta(page) {
  if (typeof document === 'undefined') return;
  const title = ROUTE_TITLES[page] || 'CAUCE · Aluminé';
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

// ── sincronización en vivo ──
// Una suscripción por vista, acotada a lo que esa vista muestra: el comercio
// escucha sus pedidos y la persona los suyos. Nunca se escucha la tabla entera.
// Al cambiar de vista el canal se cierra; no quedan canales abiertos de fondo.
const live = { key: '', stop: null, timer: null };

// Realtime es la vía principal; el sondeo es el respaldo. Un teléfono que se
// bloquea o una red móvil que cambia cortan el WebSocket sin aviso: el panel
// igual se actualiza cada 30 segundos y al volver a la pestaña.
const POLL_MS = Object.freeze({ panel: 30000, pedido: 45000, seguimiento: 30000, taxista: 15000 });

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
    || (page === 'seguimiento' && param) || (page === 'taxista' && me?.driverId)) ? POLL_MS[page] : 0;
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
      render();
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
const GATED_ROUTES = new Set(['panel', 'admin', 'taxista', 'cuenta', 'alta-comercio']);

async function render({ focus = false } = {}) {
  // La ruta se lee ahora: cualquier navegación pedida queda atendida acá.
  busy.navigating = false;
  if (!app.repository) return;
  const token = ++renderToken;
  const { page, param } = route();
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
      ? emptyState('Sección no disponible', 'Por ahora CAUCE funciona para comercios de Aluminé. Esta sección no está habilitada.',
        '#comercios', 'Ver comercios', 'bag')
      : view
      ? await view(param)
      : emptyState('Página no encontrada', 'Volvé al inicio para seguir navegando.', '#inicio', 'Ir al inicio');
    if (token !== renderToken) return;
    main.innerHTML = markup;
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
    if (form && main.contains(form) && form.dataset.form && !['search', 'checkout', 'assign-rider'].includes(form.dataset.form)) {
      form.dataset.dirty = 'true';
    }
  };
  document.addEventListener('input', markDirty);
  document.addEventListener('change', markDirty);
  document.addEventListener('change', event => {
    const select = /** @type {HTMLSelectElement} */ (event.target);
    const form = /** @type {HTMLFormElement|null} */ (select.closest?.('form[data-form="assign-rider"]'));
    if (form?.dataset.order) app.riderChoice.set(form.dataset.order, select.value);
  });
  // Los desplegables marcados con data-keep-open siguen abiertos al redibujar.
  document.addEventListener('toggle', event => {
    const details = /** @type {HTMLDetailsElement} */ (event.target);
    const key = details?.dataset?.keepOpen;
    if (!key) return;
    if (details.open) app.openDetails.add(key); else app.openDetails.delete(key);
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
    if (!isConnected() || !isEditing()) render();
  });

  // Volver a la pestaña (o desbloquear el teléfono) actualiza lo que se ve.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !isConnected()) return;
    const { page } = route();
    if (['panel', 'pedido', 'seguimiento', 'actividad', 'inicio'].includes(page) && !isEditing()) render();
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
  // Pages no permite la cabecera frame-ancestors: CAUCE no se dibuja embebido.
  if (window.top !== window.self) {
    main.innerHTML = `<section class="notice"><h2>Abrí CAUCE en su propia ventana</h2>
      <p><a class="button" href="${esc(location.href)}" target="_top" rel="noopener">Abrir CAUCE</a></p></section>`;
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
    main.innerHTML = fatalView('CAUCE no pudo iniciar', 'La configuración de esta versión no es válida. Avisanos para revisarla.', { retry: false });
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
        ? fatalView('Sin conexión con CAUCE', 'Revisá tu conexión a internet y volvé a intentar.')
        : fatalView('CAUCE está en mantenimiento', 'Estamos actualizando la plataforma. Probá de nuevo en unos minutos.');
      if (!isNetworkError(error)) app.telemetry.critical(error, { where: 'app_status' });
      main.setAttribute('aria-busy', 'false');
      return;
    }
    if (!(Number(status?.schema) >= REQUIRED_SCHEMA)) {
      app.telemetry.critical({ code: 'SCHEMA_MISMATCH', message: `Esquema ${status?.schema} < ${REQUIRED_SCHEMA}` });
      main.innerHTML = fatalView('CAUCE está en mantenimiento', 'Estamos actualizando la plataforma. Probá de nuevo en unos minutos.');
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
    main.innerHTML = fatalView(isNetworkError(error) ? 'Sin conexión con CAUCE' : 'No pudimos abrir tu sesión',
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
