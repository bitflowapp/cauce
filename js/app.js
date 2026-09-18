import { CONFIG, buildMerchantWhatsAppUrl } from './config.js';
import { createRepository } from './repositories/repository-factory.js';
import { DEMO_CUSTOMER_ID, DEMO_STORAGE_KEY } from './repositories/demo-repository.js';
import { scopeOf } from './core/scope.js';
import { allowedActions, STATUS_LABELS } from './core/workflow-policy.js';
import { confirmedPrice, isCommerciallyPurchasable } from './core/commercial.js';
import { createBusinessSoundService } from './business/sound-service.js';
import { calculateBusinessMetrics } from './core/business-metrics.js';
import { buildKitchenTicket } from './core/kitchen-ticket.js';
import { getProductSvg, getAlumineMapSvg, getAlumineTaxiMapSvg } from './data/food-assets.js';
import { renderPublicOrderTimeline, renderOrderTimeline } from './core/order-timeline.js';
import { formatDeliveryCode } from './core/delivery-code.js';
import { getRiderQueueOrder, getRiderStateLabel, getRouteProgress, isAwaitingPreparation } from './core/rider.js';
import { isValidArgentinePhone, formatArgentinePhone } from './core/validators.js';
import {
  TAXI_STATUS_LABELS,
  TAXI_STATUS_DESCRIPTIONS,
  isTaxiCancelable,
  isTaxiActive,
  getDriverNextAction,
  getPassengerTimelineIndex,
} from './core/taxi-workflow.js';
import {
  DEFAULT_TAXI_DRIVER,
  ALUMINE_TAXI_LOCATIONS,
  estimateTaxiFare,
  createTaxiTrip,
  getActiveTaxiTrip,
  getTaxiTripById,
  listTaxiTrips,
  advanceTaxiTrip,
  cancelTaxiTrip,
  resetTaxiState,
} from './core/taxi.js';

const main = document.querySelector('#main');
const modalContainer = document.querySelector('#modal-container');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const money = value => new Intl.NumberFormat(CONFIG.locale, { style:'currency', currency:'ARS', maximumFractionDigits:0 }).format(value);

const customerActor = { kind:'customer', id:DEMO_CUSTOMER_ID };
const searchState = { query:'', category:'Todos', onlyOpen:false };
const formValues = new Map();
const soundService = createBusinessSoundService();

const TAXI_CHIP_LABELS = {
  plaza: 'Plaza San Martín',
  hospital: 'Hospital',
  terminal: 'Terminal',
  costanera: 'Costanera Río',
  puente: 'Acceso Puente',
  artesanos: 'Paseo Artesanos',
  pampa: 'Bº La Pampa',
  polideportivo: 'Polideportivo'
};

let repository;
let toastTimer;
let activeBusinessTab = 'all';
let pendingSwitchConflict = null;

function toast(message) {
  clearTimeout(toastTimer);
  const element = document.querySelector('#toast');
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}

const go = hash => { location.hash = hash; };
const route = () => location.hash.slice(1).split('/').filter(Boolean);
const themes = new Set(['sage','clay','sand']);
const theme = business => themes.has(business.theme) ? business.theme : 'sage';
const back = (href = '#home', label = 'Volver a los comercios') => `<a class="back" href="${esc(href)}">← ${esc(label)}</a>`;
const empty = (title, message, href = '#home', label = 'Ver comercios', sticker = 'diner') => `<section class="empty"><div class="empty-sticker" aria-hidden="true">${renderSticker(sticker, 64)}</div><h2>${esc(title)}</h2><p>${esc(message)}</p><a class="button" href="${esc(href)}">${esc(label)}</a></section>`;
const demoNotice = () => `<div class="notice"><strong>Estás probando una demostración comercial local de CAUCE · Aluminé.</strong>Los comercios y los datos son de prueba. Los paneles permiten demostrar la experiencia real de un restaurante, un cliente y un repartidor.</div>`;
const merchantActor = business => ({ kind:'merchant', ...scopeOf(business) });
const countCart = cart => (cart?.lines || []).reduce((total, line) => total + line.quantity, 0);
const availability = b => `<span class="availability ${b.open ? '' : 'closed'}">${b.open ? 'Abierto' : 'Cerrado'}</span>`;

function renderIcon(name, size = 16, className = '') {
  const cls = className ? `icon ${className}` : 'icon';
  switch (name) {
    case 'clock':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    case 'delivery':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M15 6h-5a2 2 0 0 0-2 2l-1 5.5h6.5l1.5-4h4.5l1.5 4H22"/><path d="M9 13.5h5.5"/></svg>`;
    case 'bag':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`;
    case 'pin':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
    case 'check':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
    case 'store':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
    case 'bell':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
    case 'bell-off':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    case 'key':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 3-9.5 9.5"/><path d="m15.5 7.5 3 3"/></svg>`;
    case 'receipt':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/></svg>`;
    case 'taxi':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9C1.5 11.2 1 12 1 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>`;
    case 'phone':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
    case 'user':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    case 'shield-check':
      return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`;
    default:
      return '';
  }
}

function renderSticker(name, size = 48, className = '') {
  const cls = className ? `sticker ${className}` : 'sticker';
  switch (name) {
    case 'wave':
      return `<svg class="${cls} sticker-wave" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 11C8 7 12 15 16 11C20 7 24 15 28 11" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 21C8 17 12 25 16 21C20 17 24 25 28 21" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'taxi':
      return `<svg class="${cls} sticker-taxi" width="${size}" height="${size}" viewBox="0 0 80 80" fill="none" aria-hidden="true"><rect x="12" y="32" width="56" height="24" rx="6" fill="#ffffff" stroke="#111817" stroke-width="4"/><path d="M22 32L30 18H50L58 32" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/><circle cx="26" cy="56" r="8" fill="#111817"/><circle cx="26" cy="56" r="3" fill="#ffffff"/><circle cx="54" cy="56" r="8" fill="#111817"/><circle cx="54" cy="56" r="3" fill="#ffffff"/><rect x="34" y="12" width="12" height="6" rx="2" fill="#1d4e73" stroke="#111817" stroke-width="2"/><path d="M28 38H52" stroke="#1d4e73" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 3"/></svg>`;
    case 'coffee':
      return `<svg class="${cls} sticker-coffee" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M12 24H44V42C44 49.7 37.7 56 30 56H26C18.3 56 12 49.7 12 42V24Z" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/><path d="M44 28H48C52.4 28 56 31.6 56 36C56 40.4 52.4 44 48 44H44" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linecap="round"/><ellipse cx="28" cy="24" rx="14" ry="4" fill="#143d34"/><path d="M22 16C20 12 24 9 22 5" stroke="#111817" stroke-width="3" stroke-linecap="round"/><path d="M30 15C28 11 32 8 30 4" stroke="#111817" stroke-width="3" stroke-linecap="round"/><path d="M38 16C36 12 40 9 38 5" stroke="#111817" stroke-width="3" stroke-linecap="round"/></svg>`;
    case 'scooter':
      return `<svg class="${cls} sticker-scooter" width="${size}" height="${size}" viewBox="0 0 80 80" fill="none" aria-hidden="true"><circle cx="20" cy="58" r="10" fill="#ffffff" stroke="#111817" stroke-width="4"/><circle cx="20" cy="58" r="4" fill="#143d34"/><circle cx="62" cy="58" r="10" fill="#ffffff" stroke="#111817" stroke-width="4"/><circle cx="62" cy="58" r="4" fill="#143d34"/><path d="M20 58H36L44 48H56L62 58" stroke="#111817" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M48 48L52 28H44" stroke="#111817" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="12" y="30" width="18" height="18" rx="3" fill="#ffffff" stroke="#111817" stroke-width="4"/><path d="M12 37H30" stroke="#111817" stroke-width="2.5"/><circle cx="21" cy="34" r="1.5" fill="#1d4e73"/><circle cx="42" cy="20" r="7" fill="#ffffff" stroke="#111817" stroke-width="4"/><path d="M38 27L42 42L48 46" stroke="#111817" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 33L50 31" stroke="#111817" stroke-width="4" stroke-linecap="round"/><path d="M4 42H8M2 48H7M5 54H9" stroke="#111817" stroke-width="3" stroke-linecap="round"/></svg>`;
    case 'runner':
      return `<svg class="${cls} sticker-runner" width="${size}" height="${size}" viewBox="0 0 80 80" fill="none" aria-hidden="true"><circle cx="48" cy="20" r="8" fill="#ffffff" stroke="#111817" stroke-width="4"/><path d="M40 18C44 14 54 14 58 17L64 19" stroke="#111817" stroke-width="3.5" stroke-linecap="round"/><circle cx="52" cy="19" r="1.5" fill="#111817"/><path d="M46 28L40 46" stroke="#111817" stroke-width="4" stroke-linecap="round"/><rect x="28" y="27" width="12" height="16" rx="3" fill="#ffffff" stroke="#111817" stroke-width="3.5"/><path d="M34 27V43" stroke="#143d34" stroke-width="2"/><path d="M44 32L54 36L60 30" stroke="#111817" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="58" y="24" width="6" height="10" rx="1.5" fill="#ffffff" stroke="#111817" stroke-width="2"/><path d="M40 46L26 56L18 52" stroke="#111817" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 46L52 54L64 66" stroke="#111817" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="16" cy="52" rx="4" ry="2.5" fill="#111817"/><ellipse cx="66" cy="67" rx="4" ry="2.5" fill="#111817"/><path d="M64 12L68 8M68 16L73 14" stroke="#111817" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    case 'merchant':
      return `<svg class="${cls} sticker-merchant" width="${size}" height="${size}" viewBox="0 0 80 80" fill="none" aria-hidden="true"><path d="M26 24C22 17 30 9 40 9C50 9 58 17 54 24H26Z" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/><circle cx="40" cy="30" r="9" fill="#ffffff" stroke="#111817" stroke-width="4"/><path d="M34 29C35 31 37 31 38 29M42 29C43 31 45 31 46 29" stroke="#111817" stroke-width="2.5" stroke-linecap="round"/><path d="M36 34C38 37 42 37 44 34" stroke="#111817" stroke-width="3" stroke-linecap="round"/><path d="M30 40H50L54 66H26L30 40Z" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/><path d="M34 50H46V58H34V50Z" fill="#edf5fa" stroke="#111817" stroke-width="2.5"/><path d="M30 44L20 50L24 54" stroke="#111817" stroke-width="4" stroke-linecap="round"/><path d="M50 44L60 48L68 44" stroke="#111817" stroke-width="4" stroke-linecap="round"/><ellipse cx="68" cy="42" rx="10" ry="3.5" fill="#ffffff" stroke="#111817" stroke-width="3"/><path d="M63 41C64 36 72 36 73 41Z" fill="#143d34" stroke="#111817" stroke-width="2.5"/><path d="M68 35C67 33 69 32 68 30" stroke="#111817" stroke-width="2" stroke-linecap="round"/><path d="M34 66V74M46 66V74" stroke="#111817" stroke-width="4" stroke-linecap="round"/><ellipse cx="32" cy="74" rx="4" ry="2.5" fill="#111817"/><ellipse cx="48" cy="74" rx="4" ry="2.5" fill="#111817"/><path d="M74 34L77 32M78 39L81 40" stroke="#111817" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    case 'diner':
      return `<svg class="${cls} sticker-diner" width="${size}" height="${size}" viewBox="0 0 80 80" fill="none" aria-hidden="true"><path d="M26 28C22 24 24 16 30 14C36 12 40 10 46 12C52 10 58 14 60 20C64 24 64 32 58 36C60 42 54 46 48 46H28C22 46 20 40 22 34C20 30 22 26 26 28Z" fill="#111817"/><path d="M34 26C34 22 42 22 46 26V36C46 40 34 40 34 36V26Z" fill="#ffffff" stroke="#111817" stroke-width="3.5" stroke-linejoin="round"/><circle cx="42" cy="28" r="1.5" fill="#111817"/><path d="M40 33C42 35 44 34 45 33" stroke="#111817" stroke-width="2.5" stroke-linecap="round"/><path d="M30 46H52L56 70H26L30 46Z" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/><path d="M42 50H50V58H42V50Z" fill="#ffffff" stroke="#111817" stroke-width="3" stroke-linejoin="round"/><path d="M50 52H53C54.5 52 55.5 53.5 55.5 55C55.5 56.5 54.5 58 53 58H50" stroke="#111817" stroke-width="2.5"/><path d="M44 46C43 43 45 41 44 38" stroke="#111817" stroke-width="2" stroke-linecap="round"/><path d="M62 18L63.5 14L65 18L69 19.5L65 21L63.5 25L62 21L58 19.5L62 18Z" fill="#143d34"/></svg>`;
    case 'croissant':
      return `<svg class="${cls} sticker-croissant" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M12 40C10 32 14 20 28 14C42 14 52 24 52 38C52 42 48 44 44 40C40 36 38 28 28 26C20 26 16 34 14 42C13 44 11 43 12 40Z" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/><path d="M26 15C32 20 34 26 30 38" stroke="#111817" stroke-width="3" stroke-linecap="round"/><path d="M38 17C43 23 44 30 40 40" stroke="#111817" stroke-width="3" stroke-linecap="round"/><circle cx="20" cy="24" r="1.5" fill="#143d34"/><path d="M48 10L49 7L50 10L53 11L50 12L49 15L48 12L45 11L48 10Z" fill="#143d34"/><path d="M10 22L11 20L12 22L14 23L12 24L11 26L10 24L8 23L10 22Z" fill="#143d34"/></svg>`;
    case 'burger':
      return `<svg class="${cls} sticker-burger" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M12 28C12 18 20 12 32 12C44 12 52 18 52 28H12Z" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/><circle cx="24" cy="18" r="1.5" fill="#143d34"/><circle cx="32" cy="16" r="1.5" fill="#143d34"/><circle cx="40" cy="20" r="1.5" fill="#143d34"/><path d="M8 32C12 30 16 34 20 32C24 30 28 34 32 32C36 30 40 34 44 32C48 30 52 34 56 32" stroke="#143d34" stroke-width="4" stroke-linecap="round"/><rect x="10" y="36" width="44" height="8" rx="4" fill="#ffffff" stroke="#111817" stroke-width="3.5"/><path d="M12 46H52C52 52 46 54 32 54C18 54 12 52 12 46Z" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/></svg>`;
    case 'bag':
      return `<svg class="${cls} sticker-bag" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M24 24V14C24 10 28 8 32 8C36 8 40 10 40 14V24" fill="none" stroke="#111817" stroke-width="3.5" stroke-linecap="round"/><path d="M14 24H50L46 56H18L14 24Z" fill="#ffffff" stroke="#111817" stroke-width="4" stroke-linejoin="round"/><path d="M12 24H52" stroke="#111817" stroke-width="3" stroke-linecap="round"/><path d="M24 38C26 36 28 40 30 38C32 36 34 40 36 38C38 36 40 40 42 38" stroke="#1d4e73" stroke-width="2.5" stroke-linecap="round"/><path d="M24 43C26 41 28 45 30 43C32 41 34 45 36 43C38 41 40 45 42 43" stroke="#1d4e73" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    case 'chatBubbles':
      return `<svg class="${cls} sticker-chat" width="${size}" height="${Math.round(size * 0.56)}" viewBox="0 0 160 90" fill="none" aria-hidden="true"><rect x="8" y="8" width="138" height="30" rx="15" fill="#ffffff" stroke="#111817" stroke-width="3"/><path d="M25 38L20 45L32 38" fill="#ffffff" stroke="#111817" stroke-width="3" stroke-linejoin="round"/><circle cx="24" cy="23" r="4.5" fill="#22c55e"/><text x="34" y="27" font-family="system-ui, -apple-system, sans-serif" font-size="10" font-weight="700" fill="#111817">¿Tenés empanadas hoy?</text><rect x="22" y="48" width="130" height="30" rx="15" fill="#ffffff" stroke="#111817" stroke-width="3"/><path d="M135 78L142 85L138 78" fill="#ffffff" stroke="#111817" stroke-width="3" stroke-linejoin="round"/><circle cx="38" cy="63" r="4.5" fill="#e11d48"/><text x="48" y="67" font-family="system-ui, -apple-system, sans-serif" font-size="10" font-weight="700" fill="#111817">¿Hacen delivery?</text></svg>`;
    case 'actionLines':
      return `<svg class="${cls} sticker-lines" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 16H12M6 8L14 12M6 24L14 20" stroke="#111817" stroke-width="3" stroke-linecap="round"/></svg>`;
    default:
      return '';
  }
}

function updateNavigation() {
  if (!repository) return;
  const state = repository.snapshot();
  const nonempty = state.businesses.filter(b => repository.cart(b.id).lines.length);
  const totalItems = state.businesses.reduce((total, b) => total + countCart(repository.cart(b.id)), 0);
  const badge = document.querySelector('#cart-count');
  if (badge) badge.textContent = String(totalItems);
  const mobileBadge = document.querySelector('#bnav-cart-badge');
  if (mobileBadge) {
    mobileBadge.textContent = String(totalItems);
    mobileBadge.hidden = totalItems <= 0;
  }

  const cartNav = document.querySelector('#cart-nav');
  const bnavCarts = document.querySelector('#bnav-carts');
  const cartHref = nonempty.length === 1 ? `#cart/${nonempty[0].id}` : '#carts';
  if (cartNav) cartNav.setAttribute('href', cartHref);
  if (bnavCarts) bnavCarts.setAttribute('href', cartHref);

  const navMerchantCta = document.querySelector('.nav-merchant-cta');
  if (navMerchantCta) {
    const whatsAppUrl = buildMerchantWhatsAppUrl();
    if (whatsAppUrl) {
      navMerchantCta.setAttribute('href', whatsAppUrl);
      navMerchantCta.setAttribute('target', '_blank');
      navMerchantCta.setAttribute('rel', 'noopener noreferrer');
    } else {
      navMerchantCta.setAttribute('href', '#home');
      navMerchantCta.removeAttribute('target');
      navMerchantCta.removeAttribute('rel');
    }
  }

  const [currentPage = 'home'] = route();
  document.querySelectorAll('.bottom-nav-item').forEach(item => {
    const id = item.id;
    const isHome = id === 'bnav-home' && (currentPage === 'home' || currentPage === 'shop');
    const isSearch = id === 'bnav-search' && currentPage === 'home' && Boolean(searchState.query);
    const isOrders = id === 'bnav-orders' && (currentPage === 'orders' || currentPage === 'order');
    const isCarts = id === 'bnav-carts' && (currentPage === 'carts' || currentPage === 'cart');
    const isPres = id === 'bnav-pres' && currentPage === 'presentacion';
    item.classList.toggle('active', isHome || isSearch || isOrders || isCarts || isPres);
  });
}

function storesMarkup() {
  const needle = searchState.query.trim().toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
  const normalize = value => value.toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
  const stores = repository.snapshot().businesses
    .filter(b => b.localityId === CONFIG.defaultLocality && b.active)
    .filter(b => !searchState.onlyOpen || b.open)
    .filter(b => searchState.category === 'Todos' || b.category === searchState.category)
    .filter(b => normalize(`${b.name} ${b.category} ${b.description} ${b.subtitle || ''}`).includes(needle));

  if (!stores.length) {
    return empty('No encontramos coincidencias', 'Probá buscar otra comida o restablecer los filtros de categoría.');
  }

  return `<div class="stores">${stores.map(b => {
    const sampleProduct = repository.products(b.id)[0];
    const previewSvg = getProductSvg(sampleProduct?.dishType || 'burger');
    return `<a class="store-card" href="#shop/${esc(b.id)}" data-testid="store-card">
      <div class="store-art" aria-hidden="true">
        <div class="store-art-fallback theme-${theme(b)}">${previewSvg}</div>
        ${b.coverImage ? `<img class="store-cover-img" src="${esc(b.coverImage)}" alt="" loading="lazy">` : ''}
      </div>
      <div class="store-info">
        <div class="store-title">
          <h3>${esc(b.name)}</h3>
          ${availability(b)}
        </div>
        <p class="store-category">${esc(b.category)}</p>
        <div class="store-meta">
          <span>${renderIcon('clock', 13)} ${esc(b.eta)}</span>
          <span>${renderIcon('delivery', 13)} ${b.deliveryEnabled ? `Envío ${money(b.deliveryFee)}` : 'Solo retiro'}</span>
          <span>${renderIcon('bag', 13)} Retiro gratis</span>
        </div>
      </div>
    </a>`;
  }).join('')}</div>`;
}

function home() {
  const businesses = repository.snapshot().businesses.filter(b => b.localityId === CONFIG.defaultLocality && b.active);
  const categories = ['Todos', ...new Set(businesses.map(b => b.category))];
  const whatsAppUrl = buildMerchantWhatsAppUrl();

  return `<section class="hero-editorial">
    <div class="hero-territory-backdrop">
      <img class="hero-territory-image" src="assets/images/territory/alumine-hero-panoramica.webp" alt="" width="1200" height="675" fetchpriority="high">
      <div class="hero-backdrop-overlay"></div>
      <div class="hero-container">
        <div class="hero-copy">
          <span class="eyebrow eyebrow-light">ALUMINÉ</span>
          <h1 class="display-title">PEDÍ FÁCIL.<br>RECIBÍ SIMPLE.</h1>
          <p class="hero-lead">Comida local, directo de tu comunidad.</p>
          <div class="hero-stats">
            <span class="hero-stat">${renderIcon('store', 13)} ${businesses.length} locales</span>
            <span class="hero-stat">${renderIcon('delivery', 13)} Retiro y delivery</span>
            <span class="hero-stat">${renderIcon('clock', 13)} 20–45 min</span>
          </div>
          <div class="hero-cta-group">
            <button class="button button-hero" type="button" data-action="scroll-to" data-target="stores-section">Explorá comercios ↓</button>
            <a class="button secondary button-hero-outline" href="${esc(whatsAppUrl || '#home')}" ${whatsAppUrl ? 'target="_blank" rel="noopener noreferrer"' : ''} data-action="commercial-contact">Sumar mi comercio →</a>
          </div>
        </div>
        <div class="hero-mockup-wrapper" aria-hidden="true">
          <div class="sticker-float sticker-float-top">${renderSticker('coffee', 52)}</div>
          <div class="sticker-float sticker-float-bottom">${renderSticker('runner', 68)}</div>
          <div class="sticker-float sticker-float-lines">${renderSticker('actionLines', 32)}</div>
          <div class="device-mockup">
            <div class="device-mockup-island"></div>
            <div class="device-mockup-screen">
              <div class="mockup-app-header">
                <span class="mockup-brand"><svg class="brand-wave" viewBox="0 0 32 32" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 11C8 7 12 15 16 11C20 7 24 15 28 11"/><path d="M4 21C8 17 12 25 16 21C20 17 24 25 28 21"/></svg> CAUCE</span>
                <span class="mockup-badge">Aluminé</span>
              </div>
              <div class="mockup-search-preview">🔍 ¿Qué querés comer hoy?</div>
              <div class="mockup-store-card">
                <img src="assets/images/merchants/orilla-cover.webp" alt="" class="mockup-img">
                <div class="mockup-store-info">
                  <strong>La Orilla</strong>
                  <span>Hamburguesas caseras</span>
                  <span class="mockup-open">● Abierto · 30–45 min</span>
                </div>
              </div>
              <div class="mockup-store-card">
                <img src="assets/images/merchants/horno-cover.webp" alt="" class="mockup-img">
                <div class="mockup-store-info">
                  <strong>Horno del Sur</strong>
                  <span>Pizzas a la leña</span>
                  <span class="mockup-open">● Abierto · 25–40 min</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <svg class="hero-curve-divider" viewBox="0 0 1440 64" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0,24 C320,64 720,4 1120,44 L1440,20 L1440,64 L0,64 Z" fill="var(--paper)"/>
      </svg>
    </div>
  </section>

  <section class="modules-overview-section" aria-label="Módulos locales de CAUCE">
    <div class="modules-overview-grid">
      <div class="module-card module-card-primary">
        <div>
          <span class="module-badge module-badge-food">${renderIcon('store', 13)} COMERCIO LOCAL</span>
          <h3>Gastronomía & Comercios</h3>
          <p>Explorá los locales de Aluminé con cartas digitales, fotos reales y pedidos para retiro en mostrador o delivery propio.</p>
        </div>
        <div class="module-card-actions">
          <button class="button" type="button" data-action="scroll-to" data-target="stores-section">Ver comercios ↓</button>
          <a class="button secondary" href="#carts">Mi pedido</a>
        </div>
      </div>
      <div class="module-card module-card-taxi">
        <div>
          <span class="module-badge module-badge-taxi">${renderIcon('taxi', 13)} MOVILIDAD LOCAL</span>
          <h3>Taxis de Aluminé</h3>
          <p>Prototipo de movilidad local para coordinar viajes de cercanía y seguir el recorrido de demostración.</p>
        </div>
        <div class="module-card-actions">
          <a class="button" href="#taxi">Pedir un taxi →</a>
          <a class="button secondary" href="#taxi-driver">Panel chofer (demo)</a>
        </div>
      </div>
    </div>
  </section>

  <section id="stores-section" aria-labelledby="stores-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">CATÁLOGO LOCAL</span>
        <h2 id="stores-title" class="section-display-title">COMERCIOS EN ALUMINÉ</h2>
        <p>Explorá la oferta gastronómica y hacé tu pedido en simples pasos.</p>
      </div>
      <span class="quiet">${businesses.length} locales disponibles</span>
    </div>
    <div class="filters">
      <div class="search-box">
        <label class="sr-only" for="search">Buscar comercio o comida</label>
        <input id="search" type="search" aria-label="Buscar comercio o comida" value="${esc(searchState.query)}" placeholder="Buscar un comercio o algo rico…">
      </div>
      <div class="chips-row">
        <div class="chips" aria-label="Categorías">
          ${categories.map(c => `<button type="button" class="chip ${c === searchState.category ? 'active' : ''}" data-action="filter" data-category="${esc(c)}" aria-pressed="${c === searchState.category}">${esc(c)}</button>`).join('')}
        </div>
        <label class="check-label"><input id="only-open" type="checkbox" ${searchState.onlyOpen ? 'checked' : ''}> Solo abiertos</label>
      </div>
    </div>
    <div id="stores-results" aria-live="polite">${storesMarkup()}</div>
    <div class="catalog-merchant-card">
      <div class="catalog-merchant-content">
        <div class="catalog-merchant-icon" aria-hidden="true">${renderSticker('merchant', 44)}</div>
        <div class="catalog-merchant-text">
          <h3>¿Tenés un comercio en Aluminé?</h3>
          <p>Sumá tu local a CAUCE para recibir pedidos directos al comercio y organizar tus entregas.</p>
        </div>
      </div>
      <a class="button button-commercial" href="${esc(whatsAppUrl || '#home')}" ${whatsAppUrl ? 'target="_blank" rel="noopener noreferrer"' : ''} data-action="commercial-contact">Sumar mi comercio</a>
    </div>
  </section>

  <section class="how-it-works-section" aria-labelledby="how-it-works-title">
    <div class="section-center-heading">
      <span class="eyebrow">PASO A PASO</span>
      <h2 id="how-it-works-title" class="section-display-title">CÓMO FUNCIONA CAUCE</h2>
      <p class="section-lead">Comida local, directo de tu comunidad.</p>
    </div>
    <div class="steps-grid">
      <div class="step-card">
        <div class="step-num-badge step-badge-1">1</div>
        <h3>El cliente elige un comercio.</h3>
        <p>Explorá los locales de Aluminé, descubrí platos con fotos reales y revisá cartas actualizadas.</p>
        <div class="step-illustration" aria-hidden="true">${renderSticker('runner', 64)}</div>
      </div>
      <div class="step-card">
        <div class="step-num-badge step-badge-2">2</div>
        <h3>Hace el pedido.</h3>
        <p>Armá tu pedido directo al comercio, seleccioná retiro en local o delivery y confirmá en un toque.</p>
        <div class="step-illustration" aria-hidden="true">${renderSticker('merchant', 64)}</div>
      </div>
      <div class="step-card">
        <div class="step-num-badge step-badge-3">3</div>
        <h3>Retira o sigue el delivery del propio comercio.</h3>
        <p>El local cocina tu comida y la entrega en mostrador o la despacha con código de 4 dígitos seguro.</p>
        <div class="step-illustration" aria-hidden="true">${renderSticker('scooter', 70)}</div>
      </div>
    </div>
  </section>

  <section class="merchant-growth-section" aria-labelledby="merchant-section-title">
    <div class="growth-container">
      <div class="growth-text">
        <div class="growth-sticker-badge" aria-hidden="true">${renderSticker('merchant', 56)}</div>
        <span class="eyebrow">PARA COMERCIOS</span>
        <h2 id="merchant-section-title" class="display-title">Tu comercio, también en CAUCE</h2>
        <p class="growth-lead">Mostrá tu carta digital, recibí pedidos directos y organizá la cocina y el delivery desde un mismo sistema local.</p>
        <ul class="growth-features">
          <li>${renderIcon('check', 16)} <strong>Mostrar tus productos:</strong> fotos, precios y disponibilidad en tiempo real.</li>
          <li>${renderIcon('check', 16)} <strong>Recibir pedidos:</strong> comandas claras listas para cocina y mostrador.</li>
          <li>${renderIcon('check', 16)} <strong>Organizar la preparación:</strong> control de tiempos de espera y estados de pedido.</li>
          <li>${renderIcon('check', 16)} <strong>Ofrecer retiro:</strong> entregas ordenadas en el local sin costo de envío.</li>
          <li>${renderIcon('check', 16)} <strong>Gestionar delivery propio:</strong> repartidores locales con código de 4 dígitos seguro.</li>
          <li>${renderIcon('check', 16)} <strong>Seguir el estado:</strong> trazabilidad directa desde la confirmación hasta la entrega.</li>
        </ul>
        <div class="growth-actions">
          <a class="button button-primary" href="${esc(whatsAppUrl || '#home')}" ${whatsAppUrl ? 'target="_blank" rel="noopener noreferrer"' : ''} data-action="commercial-contact">Sumar mi comercio</a>
          <a class="button secondary" href="#manage">Ver panel demo</a>
        </div>
      </div>
      <div class="growth-preview">
        <div class="growth-sticker-float" aria-hidden="true">${renderSticker('bag', 44)}</div>
        <div class="growth-badge">PANEL COMERCIAL DEMO</div>
        <div class="growth-card">
          <div class="growth-card-header">
            <strong>La Orilla · Panel de cocina</strong>
            <span class="availability">En servicio</span>
          </div>
          <div class="growth-metrics-row">
            <div class="growth-metric">
              <span class="gm-num">En vivo</span>
              <span class="gm-lbl">Aviso sonoro</span>
            </div>
            <div class="growth-metric">
              <span class="gm-num">4 dígitos</span>
              <span class="gm-lbl">Código entrega</span>
            </div>
            <div class="growth-metric">
              <span class="gm-num">Sin costo</span>
              <span class="gm-lbl">Retiro local</span>
            </div>
          </div>
          <div class="growth-comanda-snippet">
            <span class="gcs-title">Comanda cocina lista:</span>
            <code>#CA-0042 · 2x Doble de la casa · Delivery propio</code>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="reality-proof-section" aria-labelledby="reality-proof-title">
    <div class="section-center-heading">
      <span class="eyebrow">DEMOSTRACIÓN OPERATIVA</span>
      <h2 id="reality-proof-title" class="section-display-title">CIRCUITO FUNCIONAL PROBADO</h2>
      <p class="section-lead">CAUCE cuenta con el flujo operativo completo implementado en esta demostración: pedido directo al comercio, comanda de cocina, trazabilidad y reparto propio listos para evaluar en territorio.</p>
    </div>
    <div class="reality-grid">
      <div class="reality-card">
        <div class="reality-card-badge">01 · VECINOS</div>
        <h3>Pedido ágil directo al comercio</h3>
        <p>Catálogo interactivo con fotos, precios confirmados, opciones de retiro o delivery y confirmación en un toque.</p>
        <div class="reality-card-preview">
          <div class="rcp-header">
            <span>La Orilla · Hamburguesas</span>
            <span class="rcp-tag">Confirmado</span>
          </div>
          <div class="rcp-line">1 × Doble de la casa <strong>$ 10.500</strong></div>
          <div class="rcp-meta">Retiro en local · 25–35 min</div>
        </div>
      </div>
      <div class="reality-card">
        <div class="reality-card-badge">02 · COCINA</div>
        <h3>Comanda y panel de control</h3>
        <p>Recepción en tiempo real con aviso sonoro, comanda lista para mostrador o cocina y pausa rápida de platos agotados.</p>
        <div class="reality-card-preview rcp-kitchen">
          <div class="rcp-kitchen-badge">ÚLTIMA COMANDA #CA-0042</div>
          <div class="rcp-ticket-line"><strong>2 ×</strong> Pizza especial muzzarella</div>
          <div class="rcp-ticket-line"><strong>1 ×</strong> Papas rústicas</div>
          <div class="rcp-ticket-foot">Mostrador · Cliente: Juan C.</div>
        </div>
      </div>
      <div class="reality-card">
        <div class="reality-card-badge">03 · SEGUIMIENTO</div>
        <h3>Trazabilidad de estados en vivo</h3>
        <p>Vecino y comercio comparten la evolución del pedido: recibido, en preparación, listo y entregado.</p>
        <div class="reality-card-preview">
          <div class="rcp-timeline">
            <div class="rcp-step done"><span>✓</span> Recibido</div>
            <div class="rcp-step active"><span>●</span> En preparación</div>
            <div class="rcp-step"><span>○</span> Listo</div>
          </div>
          <div class="rcp-eta-note">Demora estimada: 18 min</div>
        </div>
      </div>
      <div class="reality-card">
        <div class="reality-card-badge">04 · REPARTO</div>
        <h3>Delivery propio con código seguro</h3>
        <p>Despacho con repartidores propios del comercio y validación por código de 4 dígitos entre local, repartidor y vecino.</p>
        <div class="reality-card-preview rcp-delivery">
          <div class="rcp-code-display">
            <span class="rcp-code-label">Código de entrega:</span>
            <strong class="rcp-code-val">48 · 21</strong>
          </div>
          <div class="rcp-delivery-status">En camino a Av. San Martín 450</div>
        </div>
      </div>
      <div class="reality-card">
        <div class="reality-card-badge">05 · MOVILIDAD</div>
        <h3>Taxis locales en evaluación</h3>
        <p>Prototipo para evaluar solicitud de viaje, asignación de móvil demo, recorrido esquemático y cobro al chofer.</p>
        <div class="reality-card-preview">
          <div class="rcp-header">
            <span>Móvil DEMO · Conductor demo</span>
            <span class="rcp-tag" style="background:#edf5fa;color:#1d4e73">Asignado</span>
          </div>
          <div class="rcp-line">Plaza San Martín → Hospital</div>
          <div class="rcp-meta">Recorrido esquemático · Pago coordinado con el chofer</div>
        </div>
      </div>
    </div>
  </section>

  <section class="territory-quote-section">
    <div class="territory-quote-card" role="img" aria-label="Pehuenes milenarios en Aluminé">
      <img class="territory-quote-image" src="assets/images/territory/alumine-pehuenes.webp" alt="" width="1200" height="800" loading="lazy">
      <div class="territory-quote-overlay"></div>
      <div class="territory-quote-content">
        <svg class="brand-wave" viewBox="0 0 32 32" width="36" height="36" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
          <path d="M4 11C8 7 12 15 16 11C20 7 24 15 28 11"/>
          <path d="M4 21C8 17 12 25 16 21C20 17 24 25 28 21"/>
        </svg>
        <blockquote>“No venimos a reemplazar lo local. Venimos a darle cauce.”</blockquote>
        <cite>ALUMINÉ · NEUQUÉN · PATAGONIA ARGENTINA</cite>
      </div>
    </div>
  </section>

  <section class="commercial-closing-section" aria-labelledby="closing-title">
    <div class="closing-card">
      <div class="closing-backdrop-art" aria-hidden="true">${renderSticker('wave', 72)}</div>
      <span class="eyebrow eyebrow-light">SUMATE AL CIRCUITO</span>
      <h2 id="closing-title" class="closing-title">¿Tenés un comercio en Aluminé?</h2>
      <p class="closing-lead">Sumate a CAUCE y probemos juntos cómo puede funcionar para tu negocio.</p>
      <div class="closing-actions">
        <a class="button button-closing-primary" href="${esc(whatsAppUrl || '#home')}" ${whatsAppUrl ? 'target="_blank" rel="noopener noreferrer"' : ''} data-action="commercial-contact">Sumar mi comercio</a>
        <button class="button button-closing-secondary" type="button" data-action="scroll-to" data-target="stores-section">Probar CAUCE</button>
      </div>
    </div>
  </section>`;
}

function shop(businessId) {
  const b = repository.business(businessId);
  const products = repository.products(b.id);
  const cart = repository.cart(b.id);
  const categories = [...new Set(products.map(p => p.category))];
  const sampleProduct = products[0];
  const previewSvg = getProductSvg(sampleProduct?.dishType || 'burger');
  const cartItemCount = countCart(cart);
  let currentQuote = null;
  try { if (cartItemCount > 0) currentQuote = repository.quote(b.id, b.pickupEnabled ? 'pickup' : 'delivery'); } catch (_) {}

  return `${back()}
  <section class="shop-hero">
    <div class="shop-initials theme-${theme(b)}" aria-hidden="true">${previewSvg}</div>
    <div>
      <span class="eyebrow">${esc(b.category)} · COMERCIO LOCAL</span>
      <h1>${esc(b.name)}</h1>
      ${b.subtitle ? `<div class="store-subtitle">${esc(b.subtitle)}</div>` : ''}
      <p>${esc(b.description)}</p>
      <div class="shop-info">
        ${availability(b)}
        <span>${renderIcon('clock', 13)} Demora estimada: ${esc(b.eta)}</span>
        <span>${renderIcon('delivery', 13)} ${b.deliveryEnabled ? `Envío ${money(b.deliveryFee)}` : 'Solo retiro'}</span>
        <span>${renderIcon('bag', 13)} Retiro gratis</span>
        ${b.minimumOrder > 0 ? `<span>Mínimo ${money(b.minimumOrder)}</span>` : ''}
      </div>
      <div class="shop-address">${renderIcon('pin', 13)} ${esc(b.address || 'Aluminé, Neuquén')} · ${esc(b.hoursLabel)}</div>
    </div>
  </section>

  ${!b.open ? `<div class="notice closed-notice"><strong>Este local está cerrado en este momento.</strong>Horario de atención: ${esc(b.hoursLabel)}. Podés recorrer la carta completa y conocer los platos.</div>` : ''}

  ${categories.length > 1 ? `
    <nav class="category-nav-bar" aria-label="Categorías de la carta">
      <div class="chips">
        ${categories.map(c => `<button type="button" class="chip" data-action="scroll-to" data-target="cat-${esc(c.replace(/\\s+/g,'-'))}">${esc(c)}</button>`).join('')}
      </div>
    </nav>
  ` : ''}

  <div class="shop-layout">
    <div>
      ${categories.map(category => `
        <section class="product-group" id="cat-${esc(category.replace(/\\s+/g,'-'))}">
          <h2>${esc(category)}</h2>
          ${products.filter(p => p.category === category).map(p => {
            const quantity = cart.lines.find(l => l.productId === p.id)?.quantity || 0;
            const price = confirmedPrice(p);
            const foodSvg = getProductSvg(p.dishType || 'burger');
            return `<article class="product">
              <div class="product-img">
                ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ''}
                ${foodSvg}
              </div>
              <div class="product-details">
                <h3>${esc(p.name)} ${p.badge ? `<span class="dish-badge">${esc(p.badge)}</span>` : ''}</h3>
                <p>${esc(p.description)}</p>
                <span class="product-price">${price === null ? 'No disponible' : money(price)}</span>
              </div>
              <div class="product-action">
                ${quantity > 0 ? `
                  <div class="product-qty-stepper">
                    <button type="button" data-action="quantity" data-business="${esc(b.id)}" data-product="${esc(p.id)}" data-quantity="${quantity - 1}" aria-label="Quitar una unidad de ${esc(p.name)}">−</button>
                    <span>${quantity}</span>
                    <button type="button" data-action="quantity" data-business="${esc(b.id)}" data-product="${esc(p.id)}" data-quantity="${quantity + 1}" aria-label="Agregar una unidad de ${esc(p.name)}" ${quantity >= p.stock || quantity >= 99 ? 'disabled' : ''}>+</button>
                  </div>
                ` : `
                  <button class="add-btn add" type="button" data-action="add" data-business="${esc(b.id)}" data-product="${esc(p.id)}" aria-label="Agregar ${esc(p.name)}" ${!b.open || !isCommerciallyPurchasable(p) || quantity >= p.stock ? 'disabled' : ''}>
                    + Agregar
                  </button>
                `}
                <span class="product-qty">${quantity ? `${quantity} en tu pedido` : (!isCommerciallyPurchasable(p) ? 'Agotado' : '')}</span>
              </div>
            </article>`;
          }).join('')}
        </section>
      `).join('')}
    </div>

    <aside class="sidebox">
      <h3>Tu pedido en este comercio</h3>
      <p>Un solo pedido por comercio para asegurar comida recién hecha y entrega directa.</p>
      ${cart.lines.length > 0 ? `
        <div class="sidebox-cart-items">
          ${cart.lines.map(line => {
            const p = products.find(prod => prod.id === line.productId);
            return `<div class="sidebox-item"><span>${line.quantity} × ${esc(p?.name || line.productId)}</span><strong>${money((p?.price || 0) * line.quantity)}</strong></div>`;
          }).join('')}
        </div>
        <div class="inline-total">
          <span>Subtotal estimado:</span>
          <strong>${currentQuote ? money(currentQuote.subtotal) : '—'}</strong>
        </div>
        <a class="button full" href="#cart/${esc(b.id)}">Ir al checkout →</a>
      ` : `
        <p class="inline-total empty-cart-total">El carrito de este comercio está vacío.</p>
      `}
      <div class="shop-panel-link">
        <p class="microcopy">¿Querés ver este local desde adentro?</p>
        <a class="link-button" href="#business/${esc(b.id)}">Abrir panel del comercio →</a>
      </div>
    </aside>
  </div>

  ${cartItemCount > 0 ? `
    <div class="floating-cart-bar">
      <div>
        <strong>${cartItemCount} producto${cartItemCount === 1 ? '' : 's'} en ${esc(b.name)}</strong>
        <div class="floating-cart-total">Total estimado: ${currentQuote ? money(currentQuote.subtotal) : ''}</div>
      </div>
      <a href="#cart/${esc(b.id)}">Ver mi pedido →</a>
    </div>
  ` : ''}`;
}

function carts() {
  const nonempty = repository.snapshot().businesses.filter(b => repository.cart(b.id).lines.length);
  if (!nonempty.length) {
    return `${back()}
    <h1 class="page-title">Tu carrito</h1>
    ${empty('Todavía no elegiste nada', 'Entrá a un comercio y agregá algo rico.', '#home', 'Explorar comercios')}`;
  }

  const [primary, ...secondary] = nonempty;

  function renderPrimaryMerchantCard(b) {
    const cart = repository.cart(b.id);
    const count = countCart(cart);
    const products = repository.products(b.id);
    let q = null;
    try { q = repository.quote(b.id, b.pickupEnabled ? 'pickup' : 'delivery'); } catch (_) {}
    const itemsSummary = cart.lines.map(l => {
      const p = products.find(item => item.id === l.productId);
      return `${l.quantity} × ${p?.name || 'Producto'}`;
    }).join(' · ');

    return `<article class="card cart-primary-card">
      <div class="cart-primary-main">
        <div class="cart-merchant-media">
          <img src="${esc(b.coverImage)}" alt="" class="cart-merchant-img">
          <span class="store-badge-mini">${esc(b.initials || 'C')}</span>
        </div>
        <div class="cart-merchant-details">
          <h2 class="cart-merchant-name">${esc(b.name)}</h2>
          <p class="cart-merchant-items-summary">${count} producto${count === 1 ? '' : 's'}: ${esc(itemsSummary)}</p>
        </div>
      </div>
      <div class="cart-primary-action-block">
        <div class="cart-primary-subtotal">
          <span class="subtotal-label">Subtotal</span>
          <strong class="subtotal-amount">${q ? money(q.subtotal) : '—'}</strong>
        </div>
        <div class="cart-primary-buttons">
          <a class="button button-continue-order" href="#cart/${esc(b.id)}" data-testid="continue-order-link" aria-label="Continuar pedido en ${esc(b.name)}">Continuar pedido <span aria-hidden="true">→</span></a>
          <button class="link-button cart-clear-link" type="button" data-action="clear-cart" data-business="${esc(b.id)}">Vaciar este carrito</button>
        </div>
      </div>
    </article>`;
  }

  function renderSecondaryMerchantCard(b) {
    const cart = repository.cart(b.id);
    const count = countCart(cart);
    const products = repository.products(b.id);
    let q = null;
    try { q = repository.quote(b.id, b.pickupEnabled ? 'pickup' : 'delivery'); } catch (_) {}
    const itemsSummary = cart.lines.map(l => {
      const p = products.find(item => item.id === l.productId);
      return `${l.quantity} × ${p?.name || 'Producto'}`;
    }).join(' · ');

    return `<article class="card cart-secondary-card">
      <div class="cart-secondary-main">
        <div class="cart-merchant-media-sm">
          <img src="${esc(b.coverImage)}" alt="" class="cart-merchant-img-sm">
          <span class="store-badge-mini">${esc(b.initials || 'C')}</span>
        </div>
        <div class="cart-secondary-details">
          <h3>${esc(b.name)}</h3>
          <p class="quiet compact-summary">${count} producto${count === 1 ? '' : 's'} · Subtotal ${q ? money(q.subtotal) : '—'}</p>
        </div>
      </div>
      <div class="cart-secondary-action-block">
        <a class="button secondary" href="#cart/${esc(b.id)}" data-testid="continue-order-link" aria-label="Continuar pedido en ${esc(b.name)}">Continuar pedido <span aria-hidden="true">→</span></a>
        <button class="link-button cart-clear-link" type="button" data-action="clear-cart" data-business="${esc(b.id)}">Vaciar</button>
      </div>
    </article>`;
  }

  return `${back()}
  <div class="carts-view">
    <div class="carts-view-header">
      <h1 class="page-title">Tu carrito</h1>
      <p class="quiet">Cada comercio prepara y entrega su pedido por separado.</p>
    </div>
    <div class="cart-primary-section">
      ${renderPrimaryMerchantCard(primary)}
    </div>
    ${secondary.length > 0 ? `
      <div class="cart-secondary-section">
        <div class="cart-secondary-header">
          <h2 class="cart-secondary-title">Otros carritos guardados</h2>
          <p class="quiet secondary-description">Comercios donde tenés productos guardados para continuar más tarde.</p>
        </div>
        <div class="cart-secondary-list">
          ${secondary.map(renderSecondaryMerchantCard).join('')}
        </div>
      </div>
    ` : ''}
  </div>`;
}

function cartPage(businessId) {
  const b = repository.business(businessId);
  const cart = repository.cart(b.id);
  const products = repository.products(b.id);

  if (!cart.lines.length) {
    return `${back(`#shop/${b.id}`, b.name)}${empty('Tu carrito está vacío', 'Los productos de este comercio aparecerán acá.', `#shop/${b.id}`, 'Ver la carta')}`;
  }

  const values = {
    fulfillment: b.pickupEnabled ? 'pickup' : 'delivery',
    name: '',
    phone: '',
    address: '',
    reference: '',
    paymentMethod: 'cash_demo',
    notes: '',
    ...formValues.get(b.id),
  };

  let quote = null;
  let quoteError = '';
  try { quote = repository.quote(b.id, values.fulfillment); } catch (error) { quoteError = error.message; }

  return `${back(`#shop/${b.id}`, `Seguir eligiendo en ${b.name}`)}
  <div class="checkout-page-header">
    <h1 class="page-title">Tu pedido en ${esc(b.name)}</h1>
  </div>
  <div class="cart-layout">
    <div class="checkout-main-col">
      <section class="checkout-section">
        <div class="checkout-section-header">
          <h2 class="checkout-section-title">Tu pedido</h2>
        </div>
        <div class="cart-lines-list">
          ${cart.lines.map(line => {
            const p = products.find(item => item.id === line.productId);
            const price = confirmedPrice(p);
            const lineTotal = price !== null ? price * line.quantity : null;
            const foodSvg = getProductSvg(p?.dishType || 'burger');
            return `<div class="cart-line">
              <div class="cart-line-product">
                <div class="cart-product-thumb" aria-hidden="true">
                  ${p?.image ? `<img src="${esc(p.image)}" alt="">` : ''}
                  ${foodSvg}
                </div>
                <div class="cart-line-info">
                  <h3 class="cart-line-title">${esc(p?.name || 'Producto no disponible')}</h3>
                  <span class="cart-line-unit-price">${price === null ? 'Precio no disponible' : `${money(price)} cada uno`}</span>
                </div>
              </div>
              <div class="cart-line-controls">
                <div class="quantity">
                  <button type="button" data-action="quantity" data-business="${esc(b.id)}" data-product="${esc(line.productId)}" data-quantity="${line.quantity - 1}" aria-label="Quitar una unidad de ${esc(p?.name)}">−</button>
                  <span>${line.quantity}</span>
                  <button type="button" data-action="quantity" data-business="${esc(b.id)}" data-product="${esc(line.productId)}" data-quantity="${line.quantity + 1}" aria-label="Agregar una unidad de ${esc(p?.name)}" ${!p || line.quantity >= p.stock || line.quantity >= 99 ? 'disabled' : ''}>+</button>
                </div>
                <strong class="cart-line-total">${lineTotal !== null ? money(lineTotal) : '—'}</strong>
              </div>
            </div>`;
          }).join('')}
        </div>
        <div class="cart-lines-footer">
          <button class="link-button cart-clear-link" type="button" data-action="clear-cart" data-business="${esc(b.id)}">Vaciar este carrito</button>
        </div>
      </section>

      <form id="checkout-form" data-form="checkout" data-business="${esc(b.id)}" class="checkout-form">
        <fieldset class="checkout-sub-section fulfillment-fieldset" data-testid="fulfillment-selector">
          <div class="checkout-section-header">
            <legend class="checkout-section-title">¿Cómo recibís tu pedido?</legend>
          </div>
          <div class="fulfillment-options" role="radiogroup" aria-label="Modalidad de entrega">
            ${b.pickupEnabled ? `
              <div class="fulfillment-option">
                <input type="radio" id="fulfillment-pickup" name="fulfillment" value="pickup" ${values.fulfillment === 'pickup' ? 'checked' : ''} class="fulfillment-radio">
                <label class="fulfillment-card ${values.fulfillment === 'pickup' ? 'active' : ''}" for="fulfillment-pickup">
                  <div class="fulfillment-card-top">
                    <span class="fulfillment-card-title">${renderIcon('bag', 15)} Retiro en local</span>
                    <span class="fulfillment-badge free">Sin costo</span>
                  </div>
                  <p class="fulfillment-card-meta">Retiro en mostrador · ${esc(b.address || 'Aluminé')}</p>
                </label>
              </div>
            ` : ''}
            ${b.deliveryEnabled ? `
              <div class="fulfillment-option">
                <input type="radio" id="fulfillment-delivery" name="fulfillment" value="delivery" ${values.fulfillment === 'delivery' ? 'checked' : ''} class="fulfillment-radio">
                <label class="fulfillment-card ${values.fulfillment === 'delivery' ? 'active' : ''}" for="fulfillment-delivery">
                  <div class="fulfillment-card-top">
                    <span class="fulfillment-card-title">${renderIcon('delivery', 15)} Delivery del comercio</span>
                    <span class="fulfillment-badge fee">${money(b.deliveryFee)}</span>
                  </div>
                  <p class="fulfillment-card-meta">Reparto directo · Demora aprox. ${esc(b.eta)}</p>
                </label>
              </div>
            ` : ''}
          </div>
        </fieldset>

        <section class="checkout-sub-section">
          <div class="checkout-section-header checkout-section-header-row">
            <h2 class="checkout-section-title">Tus datos</h2>
            <button type="button" class="demo-fill-link" data-action="fill-demo-checkout" data-business="${esc(b.id)}" title="Completar campos con datos de ejemplo">
              Usar datos de prueba
            </button>
          </div>
          <div class="form-grid">
            <label class="field" for="checkout-name">
              <span>Nombre y apellido</span>
              <input id="checkout-name" name="name" required minlength="2" maxlength="80" value="${esc(values.name)}" autocomplete="name" placeholder="Ej: Marcela González">
            </label>
            <label class="field" for="checkout-phone">
              <span>Teléfono de contacto</span>
              <input id="checkout-phone" name="phone" type="tel" inputmode="tel" required minlength="8" maxlength="24" value="${esc(values.phone)}" autocomplete="tel" placeholder="Ej: 2942-556677">
            </label>
            ${values.fulfillment === 'delivery' ? `
              <label class="field wide" for="checkout-address">
                <span>Dirección de entrega</span>
                <input id="checkout-address" name="address" required minlength="5" maxlength="200" value="${esc(values.address)}" autocomplete="street-address" placeholder="Ej: Av. 4 de Febrero 450">
              </label>
              <label class="field wide" for="checkout-reference">
                <span>Indicaciones para la entrega (opcional)</span>
                <input id="checkout-reference" name="reference" maxlength="150" value="${esc(values.reference || '')}" autocomplete="off" placeholder="Ej: Casa con reja verde, timbre al fondo">
              </label>
            ` : ''}
          </div>
        </section>

        <section class="checkout-sub-section">
          <div class="checkout-section-header">
            <h2 class="checkout-section-title">Indicaciones para el pedido</h2>
          </div>
          <label class="sr-only" for="checkout-notes">Indicaciones para el pedido</label>
          <textarea id="checkout-notes" name="notes" maxlength="300" placeholder="Ej: sin cebolla, llamar al llegar…">${esc(values.notes)}</textarea>
        </section>
      </form>
    </div>

    <aside class="sidebox checkout-sidebox">
      <div class="sidebox-header">
        <h2 class="sidebox-title">Resumen</h2>
      </div>
      <div class="totals">
        <div class="row"><span>Productos</span><strong>${quote ? money(quote.subtotal) : '—'}</strong></div>
        <div class="row"><span>${values.fulfillment === 'pickup' ? 'Retiro en mostrador' : 'Costo de envío'}</span><strong>${values.fulfillment === 'pickup' ? 'Sin costo' : money(b.deliveryFee)}</strong></div>
        <div class="row total"><span>Total</span><strong class="total-display">${quote ? money(quote.total) : '—'}</strong></div>
      </div>
      ${quoteError ? `<div class="notice error">${esc(quoteError)}</div>` : ''}
      <div class="checkout-sticky-bar">
        <div class="checkout-sticky-meta">
          <span class="checkout-sticky-label">Total</span>
          <strong class="checkout-sticky-amount">${quote ? money(quote.total) : '—'}</strong>
        </div>
        <button class="button full button-confirm-order" type="submit" form="checkout-form" data-testid="confirm-order" ${quote ? '' : 'disabled'}>Confirmar pedido</button>
      </div>
      <p class="microcopy below-note">Demostración comercial · Pago simulado contra entrega</p>
    </aside>
  </div>`;
}

function tracking(orderId) {
  const order = repository.orders(customerActor).find(o => o.id === orderId);
  if (!order) {
    return empty('Pedido no encontrado', 'Este pedido no está guardado en el navegador.', '#orders', 'Ver mis pedidos');
  }
  const b = repository.business(order.businessId);
  const mapSvg = getAlumineMapSvg({
    merchantName: b.name,
    customerAddress: order.customer?.address || 'Mostrador local',
    status: order.status,
    fulfillment: order.fulfillment,
  });

  const deliveryCodeMarkup = (order.fulfillment === 'delivery' && order.deliveryCode?.code)
    ? `<div class="delivery-code-box">
        <div class="code-title">${renderIcon('key', 14)} Código de verificación de entrega</div>
        <div class="code-digits">${esc(formatDeliveryCode(order.deliveryCode.code))}</div>
        <p class="code-desc">Cuando recibas el pedido, decile este código al repartidor: <strong>${esc(formatDeliveryCode(order.deliveryCode.code))}</strong></p>
      </div>`
    : '';

  return `${back('#orders', 'Volver a mis pedidos')}
  <div class="narrow tracking-view">
    <div class="tracking-header">
      <span class="eyebrow">SEGUIMIENTO EN TIEMPO REAL</span>
      <h1 class="page-title">${esc(STATUS_LABELS[order.status] || order.status)}</h1>
      <p class="quiet tracking-order-meta"><span class="order-code-badge">${esc(order.code)}</span> · <strong>${esc(b.name)}</strong> · ${order.fulfillment === 'pickup' ? 'Retiro en mostrador' : 'Delivery del comercio'}</p>
    </div>
    ${renderPublicOrderTimeline(order.status)}
    ${deliveryCodeMarkup}
    ${orderCard(order, customerActor)}
    ${mapSvg}
    <section class="card tracking-history-card">
      <h2>Así va tu pedido</h2>
      <ol class="timeline">
        ${order.history.map(event => `<li>${esc(STATUS_LABELS[event.status] || event.status)}<small>${esc(new Date(event.at).toLocaleString('es-AR'))}</small></li>`).join('')}
      </ol>
      <p class="microcopy">Los estados cambian desde los paneles demo. No hay GPS ni seguimiento de repartidores reales.</p>
    </section>
    <div class="notice"><strong>Probá el otro lado del mostrador.</strong> Podés avanzar y preparar este pedido desde los paneles de demostración.</div>
    <div class="order-actions">
      <a class="button" href="#business/${esc(b.id)}">Abrir panel de ${esc(b.name)}</a>
      ${order.fulfillment === 'delivery' ? `<a class="button secondary" href="#rider/${esc(b.id)}">Abrir reparto demo</a>` : ''}
    </div>
  </div>`;
}

function orders() {
  const all = repository.orders(customerActor);
  return `${back()}
  <h1 class="page-title">Mis pedidos de prueba</h1>
  <p class="quiet">Historial local de este navegador. No son pedidos reales.</p>
  ${all.length ? all.map(o => orderCard(o, customerActor)).join('') : empty('Todavía no hay pedidos', 'Probá el circuito completo: catálogo, carrito, pedido y seguimiento.')}`;
}

function orderCard(order, actor) {
  const b = repository.business(order.businessId);
  const actions = allowedActions(order, actor);
  const actionLabels = {
    accepted: 'Confirmar',
    preparing: 'Preparar',
    ready: 'Marcar listo',
    assigned: 'Asignar repartidor demo',
    picked_up: 'Confirmar retiro',
    on_the_way: 'Salir a reparto',
    arrived: 'Llegué al destino',
    delivered: 'Confirmar entrega',
    canceled: 'Cancelar pedido',
  };

  const isRiderAwaiting = actor.kind === 'rider' && isAwaitingPreparation(order);
  const formattedPhone = order.customer?.phone ? formatArgentinePhone(order.customer.phone) : '';
  const deliveryCodeBadge = (order.fulfillment === 'delivery' && order.deliveryCode?.code)
    ? `<div class="delivery-code-badge"><span>${renderIcon('key', 14)} Código de entrega:</span><strong>${esc(formatDeliveryCode(order.deliveryCode.code))}</strong></div>`
    : '';

  return `<article class="card order-card"><div class="row"><div>
    <span class="order-code">${esc(order.code)}</span>
    <h3>${esc(b.name)}</h3>
    <span class="microcopy">${order.fulfillment === 'pickup' ? 'Retiro por el local' : 'Delivery del comercio'}</span></div>
    <span class="status">${esc(STATUS_LABELS[order.status] || order.status)}</span></div>
    ${actor.kind !== 'customer' ? renderOrderTimeline(order.status) : ''}
    <p class="order-items">${order.lines.map(l => `${l.quantity} × ${esc(l.name)}`).join(' · ')}</p>
    <div class="row"><strong>${money(order.total)}</strong>
      <div class="order-links">
        ${actor.kind === 'merchant' ? `<button class="link-button" type="button" data-action="view-ticket" data-order="${esc(order.id)}" data-business="${esc(b.id)}">${renderIcon('receipt', 13)} Ver comanda</button>` : ''}
        <a class="link-button" href="#order/${esc(order.id)}">Ver seguimiento</a>
      </div>
    </div>
    ${deliveryCodeBadge}
    ${actor.kind === 'rider' ? `
      <div class="rider-mission-card">
        <div class="rider-mission-step origin">
          <span class="rider-mission-badge">RETIRAR EN</span>
          <strong>${esc(b.name)}</strong>
          <span class="quiet microcopy">${esc(b.address || 'Aluminé')}</span>
        </div>
        <div class="rider-mission-step destination">
          <span class="rider-mission-badge">ENTREGAR EN</span>
          ${isRiderAwaiting
            ? `<p class="quiet rider-awaiting">Pedido en cocina. Los datos de contacto y entrega se activan al retirar del local.</p>`
            : `<strong>${esc(order.customer?.name)}</strong>
               <span class="rider-address">${esc(order.customer?.address || 'Dirección de entrega')}</span>
               ${order.customer?.phone ? `<a href="tel:${esc(order.customer.phone)}" class="rider-phone-link">${renderIcon('phone', 12)} ${esc(formattedPhone || order.customer.phone)}</a>` : ''}
               ${order.customer?.notes ? `<span class="rider-notes">Nota: ${esc(order.customer.notes)}</span>` : ''}`
          }
        </div>
      </div>
    ` : ''}
    ${actor.kind === 'merchant' ? (
      `<p class="microcopy below-note">${esc(order.customer?.name)} · ${esc(formattedPhone || order.customer?.phone)}
        ${order.customer?.address ? `<br>${esc(order.customer.address)}` : ''}
        ${order.customer?.notes ? `<br>Nota: ${esc(order.customer.notes)}` : ''}</p>`
    ) : ''}
    ${actions.length > 0 ? `
      <div class="order-actions">
        ${actions.map(status => `<button type="button" class="button ${actor.kind === 'rider' ? 'button-rider-dominant full' : (status === 'canceled' ? 'danger' : '')}" data-action="transition" data-order="${esc(order.id)}" data-version="${order.version}" data-status="${esc(status)}" data-business="${esc(order.businessId)}" data-actor="${esc(actor.kind)}" data-rider="${esc(actor.kind === 'rider' ? actor.id : '')}">${esc(actionLabels[status] || status)}</button>`).join('')}
      </div>
    ` : ''}
  </article>`;
}

function manage() {
  const activeTaxi = getActiveTaxiTrip();
  return `${back()}
  <h1 class="page-title">Paneles de demostración</h1>
  ${demoNotice()}

  <div class="section-heading" style="margin-top: 20px;">
    <div>
      <span class="eyebrow">MÓDULO DE COMERCIO LOCAL</span>
      <h2>Gastronomía y comercios</h2>
      <p>Bandejas de cocina, administración de cartas y reparto propio para locales de Aluminé.</p>
    </div>
  </div>
  <div class="stores">
    ${repository.snapshot().businesses.map(b => `<section class="card"><span class="eyebrow">COMERCIO FICTICIO</span><h2>${esc(b.name)}</h2><p class="quiet">Probá la bandeja, los productos y la apertura del local.</p><div class="stack"><a class="button" href="#business/${esc(b.id)}">Panel del comercio</a>${b.deliveryEnabled ? `<a class="button secondary" href="#rider/${esc(b.id)}">Panel de reparto</a>` : ''}</div></section>`).join('')}
  </div>

  <div class="section-heading" style="margin-top: 36px;">
    <div>
      <span class="eyebrow">MÓDULO DE MOVILIDAD LOCAL (PROTOTIPO)</span>
      <h2>Taxis de Aluminé</h2>
      <p>Prototipo de movilidad local para evaluar la solicitud de viajes y el panel operativo del chofer.</p>
    </div>
  </div>
  <div class="stores">
    <section class="card">
      <span class="eyebrow">VECINO / PASAJERO</span>
      <h2>Pedir un taxi</h2>
      <p class="quiet">Elegí origen y destino en Aluminé y seguí el recorrido esquemático de demostración.</p>
      ${activeTaxi ? `<p class="microcopy" style="color:var(--mountain-blue);font-weight:600;">● Viaje activo en curso (${esc(TAXI_STATUS_LABELS[activeTaxi.status])})</p>` : ''}
      <div class="stack">
        <a class="button" href="#taxi">${activeTaxi ? 'Ver seguimiento del taxi' : 'Solicitar taxi'}</a>
      </div>
    </section>
    <section class="card">
      <span class="eyebrow">CHOFER · MÓVIL DEMO</span>
      <h2>Panel del chofer</h2>
      <p class="quiet">Recepción de viajes, aceptación y avance secuencial de estados de traslado de demostración.</p>
      <div class="stack">
        <a class="button secondary" href="#taxi-driver">Panel del chofer (Móvil DEMO)</a>
      </div>
    </section>
  </div>`;
}

function businessPanel(businessId) {
  const b = repository.business(businessId);
  const actor = merchantActor(b);
  const allOrders = repository.orders(actor);
  const products = repository.products(b.id);
  const metrics = calculateBusinessMetrics(allOrders, products);

  const incomingOrders = allOrders.filter(o => o.status === 'submitted');
  const prepOrders = allOrders.filter(o => ['accepted', 'preparing'].includes(o.status));
  const readyOrders = allOrders.filter(o => ['ready', 'assigned'].includes(o.status));
  const transitOrders = allOrders.filter(o => ['picked_up', 'on_the_way', 'arrived'].includes(o.status));
  const closedOrders = allOrders.filter(o => ['delivered', 'canceled'].includes(o.status));

  function renderOrderSection(title, list, className = '') {
    if (!list.length) return '';
    return `<div class="order-tray">
      <div class="order-tray-title ${className}"><span>${title}</span> <span class="order-tray-badge"><span>${list.length}</span></span></div>
      ${list.map(o => orderCard(o, actor)).join('')}
    </div>`;
  }

  return `${back('#manage', 'Todos los paneles demo')}
  <div class="manage-header">
    <div><span class="eyebrow">PANEL DE COMERCIO · DEMO</span><h1 class="page-title">${esc(b.name)}</h1>${availability(b)}</div>
    <div class="manage-controls">
      <button class="sound-toggle ${!soundService.muted ? 'on' : ''}" type="button" data-action="toggle-sound">
        ${!soundService.muted ? `${renderIcon('bell', 14)} Aviso sonoro: ACTIVO` : `${renderIcon('bell-off', 14)} Aviso sonoro: SILENCIADO`}
      </button>
      <a class="button secondary" href="#shop/${esc(b.id)}">Ver mi carta</a>
      <button class="button secondary" type="button" data-action="toggle-open" data-business="${esc(b.id)}">${b.open ? 'Cerrar' : 'Abrir'} comercio demo</button>
    </div>
  </div>
  ${demoNotice()}

  <div class="tab-bar">
    <button type="button" class="tab-btn ${activeBusinessTab === 'all' ? 'active' : ''}" data-action="set-biz-tab" data-tab="all">Todo</button>
    <button type="button" class="tab-btn ${activeBusinessTab === 'orders' ? 'active' : ''}" data-action="set-biz-tab" data-tab="orders">Pedidos (${allOrders.length})</button>
    <button type="button" class="tab-btn ${activeBusinessTab === 'products' ? 'active' : ''}" data-action="set-biz-tab" data-tab="products">Productos (${products.length})</button>
    <button type="button" class="tab-btn ${activeBusinessTab === 'settings' ? 'active' : ''}" data-action="set-biz-tab" data-tab="settings">Configuración</button>
    <button type="button" class="tab-btn ${activeBusinessTab === 'metrics' ? 'active' : ''}" data-action="set-biz-tab" data-tab="metrics">Resumen comercial</button>
  </div>

  ${activeBusinessTab === 'all' || activeBusinessTab === 'orders' ? `
    <div class="section-heading">
      <div>
        <h2>Pedidos del comercio</h2>
        <p>${allOrders.length} pedidos. Priorizados por urgencia de atención en cocina.</p>
      </div>
      ${b.deliveryEnabled ? `<a class="link-button" href="#rider/${esc(b.id)}">Ir a reparto demo →</a>` : ''}
    </div>
    ${allOrders.length ? `
      ${renderOrderSection('Nuevos pedidos entrantes', incomingOrders, 'incoming')}
      ${renderOrderSection('En cocina y preparación', prepOrders, 'prep')}
      ${renderOrderSection('Listos para entrega / despacho', readyOrders, 'ready')}
      ${renderOrderSection('En reparto a domicilio', transitOrders, 'transit')}
      ${renderOrderSection('Historial de pedidos finalizados', closedOrders, 'closed')}
    ` : empty('La bandeja está vacía', 'Creá un pedido de prueba desde la carta de este comercio.', `#shop/${b.id}`, 'Abrir la carta')}
  ` : ''}

  ${activeBusinessTab === 'all' || activeBusinessTab === 'products' ? `
    <section class="product-group"><h2>Gestión de Carta</h2><p class="quiet">Modificá precios, stock y disponibilidad de platos al instante.</p><div class="edit-products">
      ${products.map(p => `<div class="card edit-product">
        <button type="button" class="product-toggle-btn ${p.available ? 'active' : 'paused'}" data-action="quick-toggle-product" data-business="${esc(b.id)}" data-product="${esc(p.id)}">
          ${p.available ? 'Disponible en carta (tocar para pausar)' : 'Pausado (agotado, tocar para activar)'}
        </button>
        <form data-form="product" data-business="${esc(b.id)}" data-product="${esc(p.id)}">
          <h3>${esc(p.name)}</h3>
          <div class="edit-fields">
            <label class="field" for="edit-price-${p.id}">
              <span>Precio</span>
              <input id="edit-price-${p.id}" name="price" type="number" min="1" max="10000000" step="1" required value="${p.price}">
            </label>
            <label class="field" for="edit-stock-${p.id}">
              <span>Stock disponible</span>
              <input id="edit-stock-${p.id}" name="stock" type="number" min="0" max="10000" step="1" required value="${p.stock}">
            </label>
          </div>
          <label class="check-label product-availability"><input name="available" type="checkbox" ${p.available ? 'checked' : ''}> Disponible</label>
          <button class="button secondary full" type="submit">Guardar cambios demo</button>
        </form>
      </div>`).join('')}
    </div></section>
  ` : ''}

  ${activeBusinessTab === 'all' || activeBusinessTab === 'settings' ? `
    <div class="narrow"><div class="card">
      <h2>Configuración del local</h2><p class="quiet">Ajustá tiempos y modalidad de entrega en Aluminé.</p>
      <form data-form="business-config" data-business="${esc(b.id)}">
        <div class="form-grid">
          <label class="field">Demora estimada<select name="eta">
            <option value="15–25 min" ${b.eta === '15–25 min' ? 'selected' : ''}>15–25 min</option>
            <option value="20–35 min" ${b.eta === '20–35 min' ? 'selected' : ''}>20–35 min</option>
            <option value="25–40 min" ${b.eta === '25–40 min' ? 'selected' : ''}>25–40 min</option>
            <option value="30–45 min" ${b.eta === '30–45 min' ? 'selected' : ''}>30–45 min</option>
            <option value="45–60 min" ${b.eta === '45–60 min' ? 'selected' : ''}>45–60 min</option>
          </select></label>
          <label class="field">Costo de envío demo ($)<input name="deliveryFee" type="number" min="0" step="100" value="${b.deliveryFee}"></label>
          <label class="field wide">Horario de atención<input name="hoursLabel" maxlength="60" value="${esc(b.hoursLabel)}"></label>
          <div class="field wide">
            <label class="check-label"><input name="deliveryEnabled" type="checkbox" ${b.deliveryEnabled ? 'checked' : ''}> Habilitar delivery</label>
            <label class="check-label"><input name="pickupEnabled" type="checkbox" ${b.pickupEnabled ? 'checked' : ''}> Habilitar retiro</label>
          </div>
        </div>
        <button class="button settings-submit" type="submit">Guardar configuración demo</button>
      </form>
    </div></div>
  ` : ''}

  ${activeBusinessTab === 'all' || activeBusinessTab === 'metrics' ? `
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">Ventas demo hoy</div><div class="metric-value">${money(metrics.todayRevenue)}</div><small class="quiet">${metrics.todayOrderCount} pedidos</small></div>
      <div class="metric-card"><div class="metric-label">Ticket promedio</div><div class="metric-value">${money(metrics.averageTicket)}</div><small class="quiet">Por pedido</small></div>
      <div class="metric-card"><div class="metric-label">Pedidos activos</div><div class="metric-value clay-text">${metrics.activeCount}</div><small class="quiet">En preparación</small></div>
      <div class="metric-card"><div class="metric-label">Stock bajo</div><div class="metric-value amber-text">${metrics.lowStockCount}</div><small class="quiet">5 o menos</small></div>
    </div>
    <div class="card"><h3>Platos más pedidos</h3>
      ${metrics.topProducts.length ? `<div>${metrics.topProducts.map((p, i) => `<div class="row metric-product-row"><span><strong>#${i+1}</strong> ${esc(p.name)}</span><strong>${p.quantity} u.</strong></div>`).join('')}</div>` : '<p class="quiet">Los pedidos generarán estadísticas acá.</p>'}
    </div>
  ` : ''}`;
}

function riderPanel(businessId) {
  const b = repository.business(businessId);
  const rider = repository.snapshot().riders.find(r => r.businessId === b.id && r.localityId === b.localityId);
  if (!rider) return `${back('#manage', 'Paneles demo')}${empty('Este comercio no tiene delivery', 'En esta demostración trabaja únicamente con retiro.')}`;

  const actor = { ...rider, kind: 'rider' };
  const all = repository.orders(actor);
  const activeOrder = getRiderQueueOrder(all);
  const riderStatusLabel = getRiderStateLabel(activeOrder);
  const progress = Math.round(getRouteProgress(activeOrder) * 100);

  return `${back(`#business/${b.id}`, 'Volver al panel del comercio')}
  <div class="rider-panel-view">
    <div class="rider-header">
      <div>
        <span class="eyebrow">REPARTO DEL COMERCIO · DESPACHO LOCAL</span>
        <h1 class="page-title">${esc(b.name)}</h1>
      </div>
      <div class="rider-status-bar">
        <span class="rider-name-tag">${renderIcon('delivery', 14)} ${esc(rider.name)}</span>
        <span class="rider-state-tag">${esc(riderStatusLabel)}</span>
        <span class="rider-progress-tag">${progress}%</span>
      </div>
    </div>
    ${all.length ? all.map(o => orderCard(o, actor)).join('') : empty('Todavía no hay pedidos asignados', 'Prepará un pedido con delivery y asignalo desde el panel de este comercio.', `#business/${b.id}`, 'Ir al panel del comercio')}
    <p class="quiet rider-scope-note">Solo aparecen los pedidos asignados a ${esc(rider.name)}. No se comparte una flota entre comercios.</p>
    ${demoNotice()}
  </div>`;
}

function presentacion() {
  return `${back('#home', 'Volver a los comercios')}
  <div class="pres-container">
    <header class="pres-hero-card">
      <div class="pres-hero-inner">
        <span class="eyebrow eyebrow-territory">PROPUESTA DE INFRAESTRUCTURA DIGITAL COMPARTIDA</span>
        <h1 class="display-title">CAUCE · ALUMINÉ</h1>
        <p class="pres-lead">
          Una propuesta tecnológica orientada a facilitar la digitalización de la gastronomía local, conectar a vecinos y visitantes con los comercios de Aluminé y brindar herramientas operativas sencillas y compartidas.
        </p>
        <div class="pres-meta-tags">
          <span class="territory-tag">ALUMINÉ</span>
          <span class="territory-tag">NEUQUÉN</span>
          <span class="territory-tag">PATAGONIA</span>
          <span class="territory-tag">PROPUESTA DE PILOTO</span>
        </div>
      </div>
      <div class="pres-hero-art" aria-hidden="true">${renderSticker('wave', 72)}</div>
    </header>

    <section class="pres-slide-card">
      <div class="pres-slide-header">
        <span class="eyebrow">DIRECCIÓN OPERATIVA</span>
        <h2 class="section-display-title">IMPLEMENTACIÓN POR ETAPAS</h2>
        <p class="quiet">Los tiempos y alcance se definen con los actores participantes según la escala acordada.</p>
      </div>

      <div class="pres-phases-grid">
        <div class="pres-phase-item">
          <span class="pres-phase-num">01</span>
          <span class="pres-stage-tag">Etapa 1</span>
          <strong>Validación y relevamiento</strong>
          <p>Relevamiento con comercios interesados, modalidades de venta, cartas y horarios reales.</p>
        </div>
        <div class="pres-phase-item">
          <span class="pres-phase-num">02</span>
          <span class="pres-stage-tag">Etapa 2</span>
          <strong>Piloto inicial</strong>
          <p>Puesta en marcha con un grupo inicial de locales para validar circuitos de retiro y entrega de cercanía.</p>
        </div>
        <div class="pres-phase-item">
          <span class="pres-phase-num">03</span>
          <span class="pres-stage-tag">Etapa 3</span>
          <strong>Ajuste operativo</strong>
          <p>Análisis conjunto de la experiencia con comerciantes, clientes y repartidores para optimizar herramientas.</p>
        </div>
        <div class="pres-phase-item">
          <span class="pres-phase-num">04</span>
          <span class="pres-stage-tag">Etapa 4</span>
          <strong>Evaluación</strong>
          <p>Revisión de resultados, experiencia de uso e impacto operativo con los actores participantes.</p>
        </div>
        <div class="pres-phase-item">
          <span class="pres-phase-num">05</span>
          <span class="pres-stage-tag">Etapa 5</span>
          <strong>Posible ampliación</strong>
          <p>Definición del esquema permanente e incorporación progresiva de nuevos comercios y rubros.</p>
        </div>
      </div>

      <div class="pres-metrics-row">
        <div class="pres-metric-box">
          <span class="pres-metric-lbl">COMERCIOS PARTICIPANTES</span>
          <span class="pres-metric-val">A definir con el piloto</span>
        </div>
        <div class="pres-metric-box">
          <span class="pres-metric-lbl">PEDIDOS PROCESADOS</span>
          <span class="pres-metric-val">Indicador a medir</span>
        </div>
        <div class="pres-metric-box">
          <span class="pres-metric-lbl">TIEMPOS DE ENTREGA</span>
          <span class="pres-metric-val">Indicador operativo</span>
        </div>
        <div class="pres-metric-box">
          <span class="pres-metric-lbl">EXPERIENCIA DE USO</span>
          <span class="pres-metric-val">A evaluar con participantes</span>
        </div>
      </div>

      <div class="pres-callout-quote pres-quote-with-art">
        <div class="pres-quote-char" aria-hidden="true">${renderSticker('runner', 52)}</div>
        <p>“No venimos a reemplazar lo local. Venimos a darle cauce.”</p>
        <div class="pres-quote-char" aria-hidden="true">${renderSticker('diner', 52)}</div>
      </div>
    </section>

    <section class="pres-slide-card">
      <div class="pres-slide-header pres-diagnostic-header">
        <div>
          <span class="eyebrow">DIAGNÓSTICO TERRITORIAL</span>
          <h2 class="section-display-title">LA OFERTA LOCAL EXISTE, PERO ESTÁ DISPERSA.</h2>
          <p class="quiet">Muchos comercios utilizan distintos canales para comunicar cartas, horarios y recibir consultas. CAUCE propone concentrar esas tareas en una experiencia común.</p>
        </div>
        <div class="pres-header-sticker" aria-hidden="true">
          ${renderSticker('chatBubbles', 145)}
          ${renderSticker('croissant', 44)}
        </div>
      </div>

      <div class="pres-grid-3">
        <div class="pres-card">
          <div class="pres-card-icon">${renderSticker('coffee', 38)}</div>
          <h3>Canales digitales fragmentados</h3>
          <p>Muchos comercios pequeños gestionan consultas, cartas y pedidos a través de distintos canales (mensajería instantánea, redes y llamadas). CAUCE propone concentrar descubrimiento, pedidos y operación en una experiencia digital local común.</p>
        </div>
        <div class="pres-card">
          <div class="pres-card-icon">${renderSticker('burger', 38)}</div>
          <h3>Barreras de digitalización</h3>
          <p>Para un comercio pequeño, implementar por cuenta propia catálogo digital, pedidos en línea, seguimiento y herramientas de gestión requiere tiempo y recursos técnicos considerables.</p>
        </div>
        <div class="pres-card">
          <div class="pres-card-icon">${renderSticker('scooter', 42)}</div>
          <h3>Una experiencia pensada para la localidad</h3>
          <p>CAUCE puede adaptarse a la escala, los horarios de montaña, la estacionalidad turística y las modalidades de entrega propias de Aluminé, respetando la cercanía característica de la comunidad.</p>
        </div>
      </div>

      <div class="pres-callout-quote pres-quote-with-art">
        <div class="pres-quote-char" aria-hidden="true">${renderSticker('merchant', 52)}</div>
        <p>“El salto no es tecnológico: es organizativo. Lo local tiene futuro cuando se organiza con su propia gente.”</p>
      </div>
    </section>

    <section class="pres-slide-card">
      <div class="pres-slide-header">
        <span class="eyebrow">VALOR PARA ALUMINÉ</span>
        <h2 class="section-display-title">MÁS MOVIMIENTO LOCAL.</h2>
      </div>

      <div class="pres-grid-3">
        <div class="pres-pillar-card">
          <div class="pres-pillar-badge social">IMPACTO SOCIAL</div>
          <h3>Cercanía &amp; Trabajo Local</h3>
          <p>Puede facilitar esquemas de reparto de proximidad organizados por los comercios y generar nuevas oportunidades operativas locales, preservando el trato humano y directo entre vecinos.</p>
        </div>
        <div class="pres-pillar-card">
          <div class="pres-pillar-badge economic">IMPACTO ECONÓMICO</div>
          <h3>Circulación en el Pueblo</h3>
          <p>CAUCE propone un canal digital que puede reducir intermediaciones y adaptar su modelo económico a las necesidades de los comercios participantes, buscando fortalecer el ecosistema gastronómico local.</p>
        </div>
        <div class="pres-pillar-card">
          <div class="pres-pillar-badge strategic">IMPACTO ESTRATÉGICO</div>
          <h3>Autonomía Comunitaria</h3>
          <p>Infraestructura digital concebida para la escala cordillerana, con posibilidad de acompañamiento institucional y articulación asociativa con entidades locales.</p>
        </div>
      </div>
    </section>

    <section class="pres-slide-card">
      <div class="pres-slide-header">
        <span class="eyebrow">HERRAMIENTAS OPERATIVAS</span>
        <h2 class="section-display-title">CAUCE como Infraestructura Digital Compartida</h2>
        <p class="pres-lead">Una vidriera digital integrada con herramientas de mostrador, cocina y reparto de cercanía.</p>
      </div>

      <div class="pres-grid-2">
        <div class="pres-card">
          <div class="pres-card-icon">${renderSticker('bag', 38)}</div>
          <h3>1. Vidriera &amp; Catálogo Público</h3>
          <p>Diseño ágil y responsive adaptado a celulares para que vecinos y turistas descubran qué pedir, fotos de platos reales, precios claros y horarios actualizados con gestión directa del comercio.</p>
        </div>
        <div class="pres-card">
          <div class="pres-card-icon">${renderSticker('merchant', 38)}</div>
          <h3>2. Panel Operativo de Pedidos</h3>
          <p>Bandejas de trabajo para mostrador y cocina. Permite confirmar, preparar y despachar comandas sin perder pedidos en chats dispersos ni recurrir a hojas sueltas.</p>
        </div>
        <div class="pres-card">
          <div class="pres-card-icon">${renderSticker('scooter', 42)}</div>
          <h3>3. Hoja de Ruta para Repartidores</h3>
          <p>Panel simple para el repartidor del comercio con datos de entrega, mapa de referencia y confirmación con código de seguridad de 4 dígitos al entregar en mano.</p>
        </div>
        <div class="pres-card">
          <div class="pres-card-icon">${renderSticker('wave', 34)}</div>
          <h3>4. Arquitectura Modular &amp; Independiente</h3>
          <p>El software está diseñado para separar la experiencia de usuario, la lógica de negocio y la infraestructura de datos, facilitando futuras decisiones sobre alojamiento y operación.</p>
        </div>
      </div>

      <div class="pres-slide-subbox">
        <h3>Un Modelo Adaptable a la Realidad Local</h3>
        <p class="pres-model-lead">
          CAUCE puede implementarse con diferentes esquemas de sostenibilidad según las necesidades de los comercios y de las instituciones participantes. El modelo económico definitivo debe definirse junto a los actores del piloto.
        </p>
        <p class="pres-model-detail">
          La propuesta contempla alternativas que van desde la autogestión comercial asociativa hasta un posible acompañamiento institucional o modelo mixto a evaluar junto a la Cámara de Comercio o dependencias locales interesadas.
        </p>
      </div>
    </section>

    <section class="pres-slide-card">
      <div class="pres-slide-header">
        <span class="eyebrow">DEMOSTRACIÓN INTERACTIVA</span>
        <h2 class="section-display-title">CIRCUITO DE PRUEBA SIMULADO</h2>
        <p class="quiet">Recorré las tres perspectivas del sistema con datos de muestra de Aluminé:</p>
      </div>
      <div class="pres-demo-links">
        <div class="pres-demo-card">
          <div>
            <strong>1. Rol Vecino / Turista</strong>
            <span>Elegí un comercio de ejemplo, armá tu pedido y probalo con retiro o envío.</span>
          </div>
          <a class="button secondary small" href="#shop/orilla">Ver catálogo de La Orilla →</a>
        </div>
        <div class="pres-demo-card">
          <div>
            <strong>2. Rol Cocina / Mostrador</strong>
            <span>Recibí el pedido simulado, organizá la comanda y pasalo a preparación.</span>
          </div>
          <a class="button secondary small" href="#business/orilla">Ver panel de comercio →</a>
        </div>
        <div class="pres-demo-card">
          <div>
            <strong>3. Rol Repartidor</strong>
            <span>Visualizá el pedido asignado y completá la entrega con el código de verificación.</span>
          </div>
          <a class="button secondary small" href="#rider/orilla">Ver panel de reparto →</a>
        </div>
      </div>
    </section>

    <section class="pres-slide-card">
      <div class="pres-slide-header">
        <span class="eyebrow">CONSIDERACIONES GENERALES</span>
        <h2 class="section-display-title">PREGUNTAS FRECUENTES</h2>
      </div>
      <div class="pres-grid-2">
        <div class="pres-card">
          <h3>¿Qué equipamiento requiere un comercio?</h3>
          <p>Cualquier dispositivo con navegador web (teléfono móvil, tablet o computadora) con conexión a internet. No exige instalaciones especiales ni equipamiento específico.</p>
        </div>
        <div class="pres-card">
          <h3>¿Cómo se contemplan los pagos?</h3>
          <p>En esta demostración se simula pago en efectivo o contra entrega. En un esquema operativo real, los métodos de cobro se acuerdan según lo que prefiera cada comercio.</p>
        </div>
        <div class="pres-card">
          <h3>¿Cómo se maneja la privacidad de datos?</h3>
          <p>El sistema está pensado para minimizar los datos recabados: la información del pedido se utiliza exclusivamente para su despacho y entrega operativa.</p>
        </div>
        <div class="pres-card">
          <h3>¿Cuál es el siguiente paso sugerido?</h3>
          <p>Presentar la demostración a comerciantes e instituciones locales para recoger devoluciones y definir si existe interés en coordinar un piloto.</p>
        </div>
      </div>
    </section>

    <div class="pres-return">
      <a class="button" href="#home">Volver al inicio y explorar comercios →</a>
    </div>
  </div>`;
}

function updateTaxiEstimateFromForm() {
  // Prototipo: no se emiten cotizaciones ni distancias GPS simuladas sin validación real
}

function taxiPage(tripId) {
  if (tripId) {
    return taxiTrackingPage(tripId);
  }
  const activeTrip = getActiveTaxiTrip();
  if (activeTrip && isTaxiActive(activeTrip.status)) {
    return taxiTrackingPage(activeTrip.id);
  }

  const pastTrips = listTaxiTrips().filter(t => !isTaxiActive(t.status));
  const whatsAppUrl = buildMerchantWhatsAppUrl();

  return `${back('#home', 'Volver al inicio')}
  <div class="taxi-page-container">
    <header class="taxi-hero-header">
      <span class="eyebrow">MOVILIDAD LOCAL · PROTOTIPO</span>
      <h1 class="page-title">Pedí un taxi</h1>
      <p class="quiet">Prototipo para evaluar la solicitud de viajes locales, recorrido esquemático y cobro directo con el chofer.</p>
    </header>

    <div class="taxi-form-card">
      <form data-form="taxi-request" id="taxi-request-form">
        <fieldset class="taxi-fieldset">
          <legend class="taxi-legend">${renderIcon('pin', 14)} Origen / Dónde te subís</legend>
          <input class="taxi-input" type="text" name="origin" id="taxi-origin-input" required value="Plaza San Martín" placeholder="Ej: Plaza San Martín, Hospital, Terminal...">
          <div class="taxi-shortcuts-row" aria-label="Lugares frecuentes de subida">
            ${ALUMINE_TAXI_LOCATIONS.slice(0, 4).map(loc => `<button type="button" class="taxi-chip" data-action="fill-taxi-origin" data-value="${esc(loc.name)}">${esc(TAXI_CHIP_LABELS[loc.id] || loc.name)}</button>`).join('')}
          </div>
          <div style="margin-top: 10px;">
            <input class="taxi-input" type="text" name="originNote" placeholder="Referencia opcional (ej: puerta principal, esquina...)">
          </div>
        </fieldset>

        <fieldset class="taxi-fieldset">
          <legend class="taxi-legend">${renderIcon('delivery', 14)} Destino / Dónde vas</legend>
          <input class="taxi-input" type="text" name="destination" id="taxi-destination-input" required value="Hospital de Aluminé" placeholder="¿A qué lugar o calle vas en Aluminé?">
          <div class="taxi-shortcuts-row" aria-label="Lugares frecuentes de destino">
            ${ALUMINE_TAXI_LOCATIONS.slice(1, 5).map(loc => `<button type="button" class="taxi-chip" data-action="fill-taxi-destination" data-value="${esc(loc.name)}">${esc(TAXI_CHIP_LABELS[loc.id] || loc.name)}</button>`).join('')}
          </div>
        </fieldset>

        <fieldset class="taxi-fieldset">
          <legend class="taxi-legend">${renderIcon('user', 14)} Pasajero y contacto</legend>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;">
            <div>
              <label class="sr-only" for="taxi-passenger-name">Nombre del pasajero</label>
              <input class="taxi-input" type="text" name="passengerName" id="taxi-passenger-name" required value="Pasajero Demo" placeholder="Nombre completo">
            </div>
            <div>
              <label class="sr-only" for="taxi-passenger-phone">Teléfono de contacto</label>
              <input class="taxi-input" type="tel" name="passengerPhone" id="taxi-passenger-phone" required value="2942 000000" placeholder="Teléfono de contacto para coordinar">
            </div>
          </div>
        </fieldset>

        <div class="taxi-estimate-box" id="taxi-estimate-box">
          <div class="taxi-estimate-item">
            <span class="taxi-estimate-label">Tarifa del viaje</span>
            <span class="taxi-estimate-value" style="font-size:15px;">Tarifa a coordinar con el servicio</span>
          </div>
          <div class="taxi-estimate-item">
            <span class="taxi-estimate-label">Trayecto</span>
            <span class="taxi-estimate-value" style="font-size:15px;">Recorrido de demostración</span>
          </div>
          <div class="taxi-estimate-item">
            <span class="taxi-estimate-label">Llegada estimada</span>
            <span class="taxi-estimate-value" style="font-size:15px;">Tiempo a confirmar</span>
          </div>
          <div class="taxi-estimate-item">
            <span class="taxi-estimate-label">Modalidad</span>
            <span class="taxi-estimate-value" style="font-size:14px;color:var(--ink)">Efectivo / Transfer al chofer</span>
          </div>
        </div>
        <p class="microcopy quiet" style="margin: -8px 0 16px; text-align: center;">Demostración funcional · Sin asignación ni geolocalización real</p>

        <button type="submit" class="button button-primary full" style="min-height:48px;font-size:16px;">
          ${renderIcon('taxi', 16)} Solicitar taxi en Aluminé
        </button>
      </form>
    </div>

    <div class="taxi-driver-banner">
      <div>
        <strong>¿Sos taxista o prestador de transporte en Aluminé?</strong>
        <p>Sumate al diálogo sobre este prototipo para evaluar juntos cómo adaptarlo a la realidad local.</p>
      </div>
      <a class="button secondary" href="${esc(whatsAppUrl || '#home')}" ${whatsAppUrl ? 'target="_blank" rel="noopener noreferrer"' : ''} data-action="commercial-contact">Sumarme a la conversación</a>
    </div>

    ${pastTrips.length > 0 ? `
      <section style="margin-top: 32px;">
        <h2 style="font-size: 16px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 12px;">Viajes anteriores</h2>
        <div style="display:flex; flex-direction:column; gap: 10px;">
          ${pastTrips.slice(0, 3).map(t => `
            <div class="card" style="padding: 14px 18px; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <strong>${esc(t.origin)} → ${esc(t.destination)}</strong>
                <div class="microcopy">${esc(t.driver?.mobileNumber || 'Móvil DEMO')} · ${esc(t.driver?.name || 'Conductor demo')} · ${esc(TAXI_STATUS_LABELS[t.status])}</div>
              </div>
              <div>
                <a class="link-button" href="#taxi/${esc(t.id)}">Ver detalle</a>
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    ` : ''}
  </div>`;
}

function taxiTrackingPage(tripId) {
  const trip = tripId ? getTaxiTripById(tripId) : getActiveTaxiTrip();
  if (!trip) {
    return `${back('#taxi', 'Volver a movilidad')}
    ${empty('Viaje no encontrado', 'No se encontró el viaje solicitado o ya fue cerrado.', '#taxi', 'Pedir un taxi')}`;
  }

  const statusLabel = TAXI_STATUS_LABELS[trip.status] || trip.status;
  const statusDesc = TAXI_STATUS_DESCRIPTIONS[trip.status] || '';
  const nextAction = getDriverNextAction(trip.status);
  const cancelable = isTaxiCancelable(trip.status);
  const mapSvg = getAlumineTaxiMapSvg({
    origin: trip.origin,
    destination: trip.destination,
    status: trip.status,
    driverName: trip.driver?.name || 'Conductor demo',
    mobileNumber: trip.driver?.mobileNumber || 'Móvil DEMO',
  });

  const timelineSteps = [
    { label: 'Solicitud', done: ['accepted', 'driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip', 'completed'].includes(trip.status), active: ['requested', 'searching'].includes(trip.status) },
    { label: 'Asignado', done: ['driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip', 'completed'].includes(trip.status), active: trip.status === 'accepted' },
    { label: 'En camino', done: ['passenger_on_board', 'in_trip', 'completed'].includes(trip.status), active: ['driver_on_way', 'driver_arrived'].includes(trip.status) },
    { label: 'En viaje', done: trip.status === 'completed', active: ['passenger_on_board', 'in_trip'].includes(trip.status) },
    { label: 'Destino', done: trip.status === 'completed', active: false },
  ];

  return `${back('#home', 'Volver al inicio')}
  <div class="taxi-page-container">
    <div class="taxi-tracking-header">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap: 12px; margin-bottom: 12px;">
        <div>
          <span class="eyebrow">SEGUIMIENTO DE VIAJE (PROTOTIPO) · ALUMINÉ</span>
          <h1 class="page-title" style="margin:4px 0 6px;">${esc(trip.origin)} → ${esc(trip.destination)}</h1>
          <p class="quiet" style="margin:0;">${esc(statusDesc)}</p>
        </div>
        <div>
          <span class="taxi-status-badge taxi-status-${esc(trip.status)}">
            ● ${esc(statusLabel)}
          </span>
        </div>
      </div>

      <ol class="timeline" aria-label="Progreso del viaje" style="margin: 20px 0 12px;">
        ${timelineSteps.map(s => `<li class="${s.done ? 'done' : s.active ? 'active' : ''}"><span>${s.done ? '✓' : s.active ? '●' : '○'}</span> ${esc(s.label)}</li>`).join('')}
      </ol>
    </div>

    ${mapSvg}
    <p class="microcopy quiet" style="text-align:center;margin:6px 0 14px;">Recorrido esquemático · Demostración funcional sin geolocalización real</p>

    <div class="taxi-driver-card">
      <div class="taxi-driver-avatar" aria-hidden="true">🚖</div>
      <div class="taxi-driver-info">
        <div style="display:flex; align-items:center; gap: 8px;">
          <span class="taxi-driver-name">${esc(trip.driver?.name || 'Conductor demo')}</span>
        </div>
        <p class="taxi-driver-vehicle">${esc(trip.driver?.mobileNumber || 'Móvil DEMO')} · ${esc(trip.driver?.vehicle || 'Vehículo de demostración')} (${esc(trip.driver?.plate || 'Patente DEMO')})</p>
      </div>
    </div>

    <div class="taxi-details-grid">
      <div class="taxi-detail-item">
        <span class="taxi-detail-label">Punto de subida</span>
        <span class="taxi-detail-value">${esc(trip.origin)} ${trip.originNote ? `<span class="quiet">(${esc(trip.originNote)})</span>` : ''}</span>
      </div>
      <div class="taxi-detail-item">
        <span class="taxi-detail-label">Destino</span>
        <span class="taxi-detail-value">${esc(trip.destination)}</span>
      </div>
      <div class="taxi-detail-item">
        <span class="taxi-detail-label">Tarifa</span>
        <span class="taxi-detail-value">A coordinar con el chofer</span>
      </div>
      <div class="taxi-detail-item">
        <span class="taxi-detail-label">Forma de pago</span>
        <span class="taxi-detail-value">Efectivo / Transferencia al chofer</span>
      </div>
      <div class="taxi-detail-item">
        <span class="taxi-detail-label">Pasajero</span>
        <span class="taxi-detail-value">${esc(trip.passenger?.name || 'Pasajero')}</span>
      </div>
      <div class="taxi-detail-item">
        <span class="taxi-detail-label">Identificador</span>
        <span class="taxi-detail-value"><code>${esc(trip.id.slice(0, 14))}</code></span>
      </div>
    </div>

    <div style="margin-top: 20px; display:flex; gap: 12px; flex-wrap:wrap; align-items:center;">
      ${cancelable ? `
        <button type="button" class="button secondary" data-action="cancel-taxi-trip" data-trip-id="${esc(trip.id)}">
          Cancelar viaje
        </button>
      ` : ''}
      ${trip.status === 'completed' ? `
        <a class="button button-primary" href="#taxi">Pedir otro taxi</a>
      ` : ''}
      <a class="button secondary" href="#taxi-driver">Ir al panel del chofer</a>
    </div>

    ${nextAction ? `
      <div class="taxi-demo-controls">
        <div>
          <span class="taxi-demo-controls-label">Demostración en vivo:</span>
          <span style="font-size:13px; color:#334155; margin-left:6px;">Próxima acción: <strong>${esc(nextAction.label)}</strong></span>
        </div>
        <button type="button" class="button" data-action="demo-advance-taxi" data-trip-id="${esc(trip.id)}" style="min-height:38px;padding:6px 14px;font-size:13px;">
          Avanzar a "${esc(nextAction.label)}" →
        </button>
      </div>
    ` : ''}
  </div>`;
}

function taxiDriverPage() {
  const activeTrip = getActiveTaxiTrip();
  const nextAction = activeTrip ? getDriverNextAction(activeTrip.status) : null;
  const completedTrips = listTaxiTrips().filter(t => t.status === 'completed');

  return `${back('#manage', 'Todos los paneles demo')}
  <div class="taxi-driver-panel">
    <div class="taxi-driver-status-card">
      <div>
        <span class="eyebrow">PANEL DEL CHOFER · DEMOSTRACIÓN OPERATIVA</span>
        <h1 class="page-title" style="margin:4px 0 6px;">Móvil DEMO · Conductor demo</h1>
        <p class="quiet" style="margin:0;">Vehículo de demostración (Patente DEMO) · Demostración operativa</p>
      </div>
      <div>
        <span class="taxi-driver-badge-live">En servicio demo</span>
      </div>
    </div>

    ${activeTrip ? `
      <div class="taxi-driver-action-card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 14px;">
          <div>
            <span class="eyebrow" style="color:var(--mountain-blue);">VIAJE ASIGNADO</span>
            <h2 style="margin:4px 0 6px; font-size:20px;">${esc(activeTrip.origin)} → ${esc(activeTrip.destination)}</h2>
            <p class="quiet" style="margin:0;">Pasajero: <strong>${esc(activeTrip.passenger?.name)}</strong> · <span class="quiet">${esc(activeTrip.passenger?.phone)}</span></p>
          </div>
          <span class="taxi-status-badge taxi-status-${esc(activeTrip.status)}">
            ${esc(TAXI_STATUS_LABELS[activeTrip.status])}
          </span>
        </div>

        <div style="background:var(--paper); border:1px solid var(--line); border-radius:var(--radius-sm); padding:14px; margin: 14px 0; display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div>
            <span class="quiet microcopy">Subida:</span>
            <div style="font-weight:600;font-size:14px;">${esc(activeTrip.origin)} ${activeTrip.originNote ? `(${esc(activeTrip.originNote)})` : ''}</div>
          </div>
          <div>
            <span class="quiet microcopy">Bajada:</span>
            <div style="font-weight:600;font-size:14px;">${esc(activeTrip.destination)}</div>
          </div>
          <div>
            <span class="quiet microcopy">Tarifa del viaje:</span>
            <div style="font-weight:700;font-size:15px;color:var(--mountain-blue)">Informada por el chofer</div>
          </div>
          <div>
            <span class="quiet microcopy">Medio:</span>
            <div style="font-weight:600;font-size:14px;">Efectivo / Transferencia al chofer</div>
          </div>
        </div>

        ${nextAction ? `
          <button type="button" class="taxi-action-big-btn" data-action="driver-advance-taxi" data-trip-id="${esc(activeTrip.id)}">
            ${esc(nextAction.label)} (${esc(nextAction.description)}) →
          </button>
        ` : ''}

        <div style="margin-top: 16px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <a class="link-button" href="#taxi/${esc(activeTrip.id)}">Ver vista del pasajero</a>
          ${isTaxiCancelable(activeTrip.status) ? `
            <button type="button" class="button secondary" data-action="cancel-taxi-trip" data-trip-id="${esc(activeTrip.id)}" style="min-height:36px;padding:4px 12px;font-size:13px;">
              Rechazar / Cancelar viaje
            </button>
          ` : ''}
        </div>
      </div>
    ` : `
      <div class="taxi-form-card" style="text-align:center; padding: 36px 20px;">
        <div style="font-size: 40px; margin-bottom: 12px;">🚖</div>
        <h2>Sin viajes activos en este momento</h2>
        <p class="quiet" style="max-width: 440px; margin: 0 auto 20px;">
          Los nuevos pedidos de taxi solicitados por vecinos de Aluminé aparecerán aquí para que el chofer los acepte e inicie el recorrido.
        </p>
        <div style="display:flex; justify-content:center; gap:12px; flex-wrap:wrap;">
          <button type="button" class="button button-primary" data-action="demo-create-taxi-trip">
            Crear viaje de prueba en Aluminé
          </button>
          <a class="button secondary" href="#taxi">Ir a pedir un taxi</a>
        </div>
      </div>
    `}

    <div style="margin-top: 32px;">
      <h2 style="font-size: 16px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 14px;">Resumen del turno demo</h2>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;">
        <div class="card" style="padding: 16px;">
          <span class="quiet microcopy">Viajes de demostración</span>
          <strong style="font-size: 22px; color: var(--ink); display:block; margin-top:4px;">${completedTrips.length}</strong>
        </div>
        <div class="card" style="padding: 16px;">
          <span class="quiet microcopy">Modalidad operativa</span>
          <strong style="font-size: 16px; color: var(--mountain-blue); display:block; margin-top:4px;">Prototipo local</strong>
        </div>
      </div>
    </div>
  </div>`;
}

function render({ focus = false } = {}) {
  if (!repository) return;
  try {
    const [page = 'home', id] = route();
    const isCartFlow = page === 'cart' || page === 'carts';
    const footer = document.querySelector('.footer');
    if (footer) {
      footer.classList.toggle('footer-compact', isCartFlow);
    }
    const pages = {
      home,
      shop: () => shop(id),
      cart: () => cartPage(id),
      carts,
      orders,
      order: () => tracking(id),
      manage,
      business: () => businessPanel(id),
      rider: () => riderPanel(id),
      taxi: () => taxiPage(id),
      'taxi-driver': taxiDriverPage,
      presentacion
    };
    main.innerHTML = Object.hasOwn(pages, page) ? pages[page]() : empty('Página no encontrada', 'Volvé al inicio para seguir explorando.');
    updateNavigation();
  } catch (error) {
    main.innerHTML = `<section class="notice error"><h2>No pudimos abrir esta vista</h2><p>${esc(error.message)}</p><a href="#home" class="button secondary">Volver al inicio</a></section>`;
  }
  if (focus) {
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

function rememberForm(form) {
  if (form?.dataset.form === 'checkout') {
    formValues.set(form.dataset.business, {
      ...formValues.get(form.dataset.business),
      ...Object.fromEntries(new FormData(form))
    });
  }
}

function openDemoModal() {
  if (!modalContainer) return;
  modalContainer.innerHTML = `<div class="modal-overlay">
    <div class="modal-card">
      <button class="modal-close" type="button" data-action="close-modal" aria-label="Cerrar modal">×</button>
      <span class="eyebrow clay-text">DEMOSTRACIÓN COMERCIAL · ALUMINÉ</span>
      <h2 id="demo-modal-title">Acerca de esta demostración</h2>
      <p class="modal-intro">
        Estás interactuando con la versión de demostración comercial de <strong>CAUCE · Aluminé</strong>.
      </p>
      <div class="modal-note">
        <div>• <strong>Comercios y productos ficticios</strong>: representan locales y platos típicos de Aluminé con fines ilustrativos.</div>
        <div>• <strong>Cobros reales desactivados</strong>: simula pagos contra entrega (efectivo demo). Ninguna transacción genera cargos reales.</div>
        <div>• <strong>Aislamiento en navegador</strong>: los pedidos y carritos se guardan exclusivamente en este dispositivo (localStorage).</div>
        <div>• <strong>Circuito completo</strong>: podés alternar entre cliente, cocina con comanda térmica y repartidor con código de seguridad.</div>
      </div>
      <div class="modal-actions">
        <button class="button danger" type="button" data-action="reset-demo">Reiniciar datos demo</button>
        <a class="button secondary" href="#presentacion" data-action="close-modal">Ver presentación institucional</a>
        <button class="button secondary modal-dismiss" type="button" data-action="close-modal">Cerrar</button>
      </div>
    </div>
  </div>`;
  modalContainer.setAttribute('aria-labelledby', 'demo-modal-title');
  modalContainer.showModal();
}

function openJoinModal() {
  if (!modalContainer) return;
  const whatsAppUrl = buildMerchantWhatsAppUrl();
  modalContainer.innerHTML = `<div class="modal-overlay">
    <div class="modal-card">
      <button class="modal-close" type="button" data-action="close-modal" aria-label="Cerrar modal">×</button>
      <span class="eyebrow">SUMATE A CAUCE · ALUMINÉ</span>
      <h2 id="join-modal-title">Sumá tu comercio a la red local</h2>
      <p class="quiet modal-intro">Publicá tu carta digital, recibí pedidos para retiro o delivery y administrá tu cocina desde tu celular o PC.</p>
      ${whatsAppUrl ? `
        <div class="modal-whatsapp-banner">
          <div>
            <strong>Conversación directa por WhatsApp</strong>
            <p>Escribinos para coordinar la adhesión de tu local o coordinar una reunión breve.</p>
          </div>
          <a class="button button-whatsapp" href="${esc(whatsAppUrl)}" target="_blank" rel="noopener noreferrer">Sumar mi comercio por WhatsApp →</a>
        </div>
        <div class="modal-divider-text"><span>o completá tus datos en el formulario</span></div>
      ` : ''}
      <div class="modal-note">
        <div>${renderIcon('check', 13)} <strong>Herramienta directa y local</strong>: pensada para acompañar la actividad del comercio sin intermediaciones complejas.</div>
        <div>${renderIcon('check', 13)} <strong>Menú digital y comanda para cocina</strong>: controlá disponibilidad de platos y tiempos de espera en tiempo real.</div>
        <div>${renderIcon('check', 13)} <strong>Retiro en mostrador o delivery propio</strong>: adaptable a los horarios y modalidades de cada local.</div>
      </div>
      <form id="join-form">
        <div class="form-grid">
          <label class="field">Tu nombre y apellido
            <input name="name" required minlength="2" placeholder="Ej: Patricia Morales">
          </label>
          <label class="field">Nombre de tu comercio
            <input name="businessName" required minlength="2" placeholder="Ej: Pizzería del Valle">
          </label>
          <label class="field">Rubro gastronómico
            <select name="category">
              <option value="Hamburguesería">Hamburguesería</option>
              <option value="Pizzería / Empanadas">Pizzería / Empanadas</option>
              <option value="Rotisería / Minutas">Rotisería / Minutas</option>
              <option value="Cafetería / Pastelería">Cafetería / Pastelería</option>
              <option value="Cervecería / Cocina">Cervecería / Cocina</option>
              <option value="Comida casera / Pastas">Comida casera / Pastas</option>
              <option value="Panadería">Panadería / Confitería</option>
            </select>
          </label>
          <label class="field">Teléfono o WhatsApp
            <input name="phone" type="tel" inputmode="tel" required minlength="8" placeholder="Ej: 2942-556677">
          </label>
          <label class="field">Dirección en Aluminé
            <input name="address" placeholder="Ej: Av. 4 de Febrero 320">
          </label>
          <label class="field">Cantidad aprox. de platos
            <select name="productCount">
              <option value="1 a 15 platos">Hasta 15 platos</option>
              <option value="15 a 40 platos">De 15 a 40 platos</option>
              <option value="Más de 40 platos">Más de 40 platos</option>
            </select>
          </label>
          <label class="field wide">Comentario o consulta adicional
            <textarea name="notes" placeholder="Contanos sobre tu local o tus horarios…"></textarea>
          </label>
        </div>
        <div class="modal-actions">
          <button class="button full" type="submit">Enviar solicitud de incorporación</button>
          <button class="button secondary" type="button" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>
  </div>`;
  modalContainer.setAttribute('aria-labelledby', 'join-modal-title');
  modalContainer.showModal();
}

function openSwitchStoreModal(conflict) {
  if (!modalContainer) return;
  modalContainer.innerHTML = `<div class="modal-overlay">
    <div class="modal-card">
      <span class="eyebrow clay-text">CAMBIO DE COMERCIO</span>
      <h2 id="switch-modal-title">¿Querés cambiar de comercio?</h2>
      <p>Ya tenés productos de <strong>${esc(conflict.existingBusiness.name)}</strong> en tu pedido.</p>
      <p class="quiet secondary-description">En CAUCE cada pedido se procesa por comercio individual para garantizar tiempos de elaboración y frescura.</p>
      <div class="modal-actions modal-actions-stacked">
        <button class="button danger full" type="button" data-action="confirm-switch-store">
          Vaciar pedido de ${esc(conflict.existingBusiness.name)} y pedir en ${esc(conflict.newBusiness.name)}
        </button>
        <button class="button secondary full" type="button" data-action="close-modal">
          Mantener mi pedido en ${esc(conflict.existingBusiness.name)}
        </button>
      </div>
    </div>
  </div>`;
  modalContainer.setAttribute('aria-labelledby', 'switch-modal-title');
  modalContainer.showModal();
}

function openTicketModal(order, businessName) {
  if (!modalContainer) return;
  const ticketText = buildKitchenTicket(order, businessName);
  modalContainer.innerHTML = `<div class="modal-overlay">
    <div class="modal-card">
      <button class="modal-close" type="button" data-action="close-modal" aria-label="Cerrar modal">×</button>
      <span class="eyebrow">VISTA DE COCINA / MOSTRADOR</span>
      <h2 id="ticket-modal-title">Comanda de cocina</h2>
      <p class="quiet microcopy">Formato de impresión térmica para cocina y despacho.</p>
      <div class="ticket-container">${esc(ticketText)}</div>
      <div class="modal-actions">
        <button class="button full" type="button" data-action="copy-ticket" data-text="${esc(ticketText)}">${renderIcon('receipt', 14)} Copiar comanda</button>
        <button class="button secondary" type="button" data-action="close-modal">Cerrar</button>
      </div>
    </div>
  </div>`;
  modalContainer.setAttribute('aria-labelledby', 'ticket-modal-title');
  modalContainer.showModal();
}

function closeModal() {
  if (modalContainer) {
    modalContainer.close();
    modalContainer.innerHTML = '';
  }
  pendingSwitchConflict = null;
}

async function doAction(button) {
  const { action, business: businessId, product: productId } = button.dataset;

  if (action === 'scroll-to') {
    const target = document.getElementById(button.dataset.target);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }

  if (action === 'filter') {
    searchState.category = button.dataset.category;
    render();
    return;
  }

  if (action === 'open-demo-modal') {
    openDemoModal();
    return;
  }

  if (action === 'reset-demo') {
    closeModal();
    await resetDemonstration();
    return;
  }

  if (action === 'focus-search') {
    if (!location.hash.startsWith('#home')) go('home');
    setTimeout(() => {
      const searchInput = document.querySelector('#search');
      if (searchInput) {
        searchInput.focus();
        searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 80);
    return;
  }

  if (action === 'commercial-contact') {
    const whatsAppUrl = buildMerchantWhatsAppUrl();
    if (whatsAppUrl) {
      if (button.tagName !== 'A' || !button.href || !button.href.includes('wa.me')) {
        window.open(whatsAppUrl, '_blank', 'noopener,noreferrer');
      }
    } else {
      openJoinModal();
    }
    return;
  }

  if (action === 'open-join-modal') {
    openJoinModal();
    return;
  }

  if (action === 'close-modal') {
    closeModal();
    return;
  }

  if (action === 'fill-taxi-origin') {
    const input = document.querySelector('#taxi-origin-input');
    if (input) {
      input.value = button.dataset.value;
      updateTaxiEstimateFromForm();
    }
    return;
  }

  if (action === 'fill-taxi-destination') {
    const input = document.querySelector('#taxi-destination-input');
    if (input) {
      input.value = button.dataset.value;
      updateTaxiEstimateFromForm();
    }
    return;
  }

  if (action === 'demo-advance-taxi') {
    const tripId = button.dataset.tripId;
    advanceTaxiTrip(tripId);
    toast('Viaje de taxi avanzado.');
    render();
    return;
  }

  if (action === 'driver-advance-taxi') {
    const tripId = button.dataset.tripId;
    advanceTaxiTrip(tripId);
    toast('Estado de viaje actualizado por el chofer.');
    render();
    return;
  }

  if (action === 'cancel-taxi-trip') {
    if (confirm('¿Deseás cancelar este viaje de taxi?')) {
      const tripId = button.dataset.tripId;
      cancelTaxiTrip(tripId, { reason: 'Cancelado por el usuario' });
      toast('El viaje de taxi ha sido cancelado.');
      render();
    }
    return;
  }

  if (action === 'demo-create-taxi-trip') {
    createTaxiTrip({
      origin: 'Plaza San Martín',
      destination: 'Hospital de Aluminé',
      passengerName: 'Pasajero Demo',
      passengerPhone: '2942 000000',
    });
    toast('¡Viaje de prueba creado! El chofer ya puede gestionarlo.');
    render();
    return;
  }

  if (action === 'toggle-sound') {
    soundService.setMuted(!soundService.muted);
    if (!soundService.muted) {
      await soundService.playNewOrder();
      toast('Aviso sonoro activado (tono armónico).');
    } else {
      toast('Aviso sonoro silenciado.');
    }
    render();
    return;
  }

  if (action === 'set-biz-tab') {
    activeBusinessTab = button.dataset.tab;
    render();
    return;
  }

  if (action === 'quick-toggle-product') {
    const b = repository.business(businessId);
    const p = repository.products(b.id).find(item => item.id === productId);
    if (p) {
      await repository.updateProduct(
        b.id,
        p.id,
        {
          price: p.price,
          stock: p.stock,
          available: !p.available,
        },
        merchantActor(b)
      );
      render();
      toast(p.available ? `${p.name} pausado (agotado).` : `${p.name} disponible en carta.`);
    }
    return;
  }

  if (action === 'view-ticket') {
    const b = repository.business(businessId);
    const order = repository.orders(merchantActor(b)).find(o => o.id === button.dataset.order);
    if (order) openTicketModal(order, b.name);
    return;
  }

  if (action === 'copy-ticket') {
    const text = button.dataset.text;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast('Comanda copiada al portapapeles.');
      } else {
        toast('Comanda lista para imprimir.');
      }
    } catch (_) {
      toast('Comanda lista para imprimir.');
    }
    return;
  }

  if (action === 'add') {
    const current = repository.cart(businessId).lines.find(l => l.productId === productId)?.quantity || 0;
    await repository.setQuantity(businessId, productId, current + 1);
    toast('Agregado al carrito de este comercio.');
    return;
  }

  if (action === 'confirm-switch-store') {
    if (pendingSwitchConflict) {
      await repository.clearCart(pendingSwitchConflict.existingBusiness.id);
      await repository.setQuantity(pendingSwitchConflict.newBusiness.id, pendingSwitchConflict.productId, 1);
      closeModal();
      toast(`Carrito anterior vaciado. Agregado a ${pendingSwitchConflict.newBusiness.name}.`);
      render();
    }
    return;
  }

  if (action === 'quantity') {
    await repository.setQuantity(businessId, productId, Number(button.dataset.quantity));
    return;
  }

  if (action === 'clear-cart') {
    await repository.clearCart(businessId);
    return;
  }

  if (action === 'fill-demo-checkout') {
    const bId = button.dataset.business;
    const b = repository.business(bId);
    const current = formValues.get(bId) || {};
    formValues.set(bId, {
      fulfillment: b?.pickupEnabled ? 'pickup' : 'delivery',
      ...current,
      name: 'Marcela González',
      phone: '2942-556677',
      address: 'Av. 4 de Febrero 450',
      reference: 'Casa con reja verde, timbre al fondo',
    });
    render();
    toast('Datos de prueba cargados en el formulario.');
    return;
  }

  if (action === 'toggle-open') {
    const b = repository.business(businessId);
    await repository.setBusinessOpen(b.id, !b.open, merchantActor(b));
    return;
  }

  if (action === 'transition') {
    const b = repository.business(businessId);
    let actor;
    if (button.dataset.actor === 'customer') actor = customerActor;
    else if (button.dataset.actor === 'merchant') actor = merchantActor(b);
    else actor = { kind: 'rider', ...scopeOf(b), id: button.dataset.rider };

    const rider = repository.snapshot().riders.find(r => r.businessId === b.id && r.localityId === b.localityId);
    await repository.transition({
      orderId: button.dataset.order,
      expectedVersion: Number(button.dataset.version),
      nextStatus: button.dataset.status,
      actor,
      riderId: rider?.id,
    });

    if (['accepted', 'preparing'].includes(button.dataset.status) && !soundService.muted) {
      await soundService.playNewOrder();
    }
    toast('Estado del pedido demo actualizado.');
    return;
  }
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action], a[data-action]');
  if (!button || button.disabled) return;
  const currentHash = location.hash;
  if (button.tagName === 'BUTTON') button.disabled = true;
  try {
    await doAction(button);
    if (location.hash === currentHash) render();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button.tagName === 'BUTTON') button.disabled = false;
  }
});

if (modalContainer) {
  modalContainer.addEventListener('submit', async event => {
    if (event.target.id === 'join-form') {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      await repository.addMerchantLead(data);
      modalContainer.innerHTML = `<div class="modal-overlay">
        <div class="modal-card modal-success">
          <div class="modal-success-icon">${renderIcon('check', 40)}</div>
          <span class="eyebrow">SOLICITUD REGISTRADA</span>
          <h2 id="join-modal-title">¡Gracias ${esc(data.name || '')}!</h2>
          <p class="modal-success-copy">
            Registramos la solicitud para incorporar a <strong>${esc(data.businessName || 'tu comercio')}</strong> en CAUCE · Aluminé. En una implementación operativa real, el equipo local se contactará por WhatsApp al <strong>${esc(data.phone || '')}</strong> para dar de alta la carta y entregarte tu panel.
          </p>
          <button class="button" type="button" data-action="close-modal">Entendido</button>
        </div>
      </div>`;
      modalContainer.querySelector('[data-action="close-modal"]').focus();
      toast('¡Solicitud demo registrada con éxito!');
    }
  });
}

main.addEventListener('input', event => {
  if (event.target.id === 'search') {
    searchState.query = event.target.value;
    const results = document.querySelector('#stores-results');
    if (results) results.innerHTML = storesMarkup();
  }
  if (event.target.id === 'taxi-origin-input' || event.target.id === 'taxi-destination-input') {
    updateTaxiEstimateFromForm();
  }
  rememberForm(event.target.closest('form'));
});

main.addEventListener('change', event => {
  if (event.target.id === 'only-open') {
    searchState.onlyOpen = event.target.checked;
    const results = document.querySelector('#stores-results');
    if (results) results.innerHTML = storesMarkup();
  }
  if (event.target.name === 'fulfillment') {
    rememberForm(event.target.closest('form'));
    render();
    document.querySelector(`input[name="fulfillment"][value="${event.target.value}"]`)?.focus();
  }
});

window.addEventListener('error', event => {
  const target = event.target;
  if (target && target.tagName === 'IMG') {
    target.classList.add('img-hidden');
    target.style.display = 'none';
  }
}, true);

main.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.dataset.form) return;
  event.preventDefault();
  const buttons = [...document.querySelectorAll('button[type="submit"]')];
  buttons.forEach(b => b.disabled = true);
  const values = Object.fromEntries(new FormData(form));

  try {
    if (form.dataset.form === 'checkout') {
      rememberForm(form);
      const businessId = form.dataset.business;
      const requestId = await repository.prepareRequest(businessId);
      const lines = repository.cart(businessId).lines;
      const order = await repository.createOrder({
        businessId,
        requestId,
        lines,
        fulfillment: values.fulfillment,
        customer: values,
        paymentMethod: 'cash_demo',
      });
      formValues.delete(businessId);
      go(`order/${order.id}`);
      if (!soundService.muted) await soundService.playNewOrder();
      toast('Pedido de prueba creado. No se envió a ningún comercio.');
    } else if (form.dataset.form === 'taxi-request') {
      const trip = createTaxiTrip({
        origin: values.origin,
        originNote: values.originNote,
        destination: values.destination,
        passengerName: values.passengerName,
        passengerPhone: values.passengerPhone,
      });
      go(`taxi/${trip.id}`);
      render();
      toast('¡Viaje solicitado! Buscando móvil en Aluminé...');
    } else if (form.dataset.form === 'product') {
      const b = repository.business(form.dataset.business);
      await repository.updateProduct(
        b.id,
        form.dataset.product,
        {
          price: Number(values.price),
          stock: Number(values.stock),
          available: values.available === 'on',
        },
        merchantActor(b)
      );
      render();
      toast('Producto de demostración actualizado.');
    } else if (form.dataset.form === 'business-config') {
      const b = repository.business(form.dataset.business);
      await repository.updateBusinessConfig(
        b.id,
        {
          eta: values.eta,
          deliveryFee: Number(values.deliveryFee),
          hoursLabel: values.hoursLabel,
          deliveryEnabled: values.deliveryEnabled === 'on',
          pickupEnabled: values.pickupEnabled === 'on',
        },
        merchantActor(b)
      );
      render();
      toast('Configuración del local guardada.');
    }
  } catch (error) {
    toast(error.message);
    buttons.forEach(b => b.disabled = false);
  }
});

async function resetDemonstration() {
  if (!confirm('¿Borrar todos los pedidos, carritos y cambios de esta demostración?')) return;
  try {
    if (repository) {
      try {
        await repository.reset();
      } catch (error) {
        if (error.code !== 'CORRUPT_STORAGE') throw error;
        localStorage.removeItem(DEMO_STORAGE_KEY);
      }
    } else {
      localStorage.removeItem(DEMO_STORAGE_KEY);
    }
    resetTaxiState();
    formValues.clear();
    repository = createRepository(CONFIG, { storage: localStorage });
    go('home');
    render();
    toast('Demostración reiniciada.');
  } catch (error) {
    toast(error.message);
  }
}

document.querySelector('#reset-demo')?.addEventListener('click', resetDemonstration);
document.querySelector('#banner-reset-demo')?.addEventListener('click', resetDemonstration);

window.addEventListener('hashchange', () => render({ focus: true }));
window.addEventListener('storage', event => {
  if (event.key === DEMO_STORAGE_KEY) {
    render();
    toast('Se actualizaron los datos de otra pestaña.');
  }
});

try {
  if (typeof location !== 'undefined' && location.search.includes('demo=1')) {
    localStorage.removeItem(DEMO_STORAGE_KEY);
  }
  repository = createRepository(CONFIG, { storage: localStorage });
  render();
} catch (error) {
  main.innerHTML = `<div class="notice error"><h1 class="page-title">No se pudo iniciar</h1><p>${esc(error.message)}</p></div>`;
}
