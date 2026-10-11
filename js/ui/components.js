// Piezas de interfaz compartidas. Todo texto de datos pasa por `html` (escape).
import { html, raw, attr } from '../core/html.js';
import { formatARS } from '../core/money.js';
import { dateBadge, timeRange } from '../core/dates.js';
import { STATUS_LABEL } from '../core/order-status.js';
import { icon } from './icons.js';
import { sofia } from './sofia.js';

export const LOGO_RAYS = raw(`<svg class="logo-rays" viewBox="0 0 16 22" aria-hidden="true" focusable="false"><path d="M3 3l4 4M2 11h5M3 19l4-4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`);

export function logo({ large = false, href = '#/' } = {}) {
  return html`<a class="logo${large ? ' logo-lg' : ''}" href="${href}" aria-label="CAUCE · Ferias Neuquén, inicio">
    <span class="logo-word" aria-hidden="true">CAUCE${LOGO_RAYS}</span>
    <span class="logo-sub" aria-hidden="true">FERIAS NEUQUÉN</span>
  </a>`;
}

export const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';

export function storeLogo(store, className = 'store-logo') {
  return html`<span class="${className}">${store?.logo
    ? html`<img src="${store.logo}" alt="" loading="lazy" decoding="async" width="56" height="56">`
    : initials(store?.name)}</span>`;
}

export function placeholderArt(categoryIcon = 'otros') {
  return html`<span class="placeholder-art" aria-hidden="true">${icon(categoryIcon, { size: 64, strokeWidth: 1.3 })}</span>`;
}

export function favButton(productId, active, label = 'Guardar en favoritos') {
  return html`<button type="button" class="fav-btn" data-action="fav" data-id="${productId}" aria-pressed="${active ? 'true' : 'false'}"
    aria-label="${active ? 'Quitar de favoritos' : label}">${icon('heart', { size: 20 })}</button>`;
}

export function stockFlag(product) {
  if (product.madeToOrder) return html`<span class="tag tag-olive product-flag">Por encargo</span>`;
  if (product.available === false) return html`<span class="tag tag-error product-flag">No disponible</span>`;
  if (product.trackStock && product.stock <= 0) return html`<span class="tag tag-error product-flag">Agotado</span>`;
  if (product.trackStock && product.stock <= 2) return html`<span class="tag tag-warn product-flag">Últimas ${product.stock}</span>`;
  return '';
}

export function productCard(product, { favorites = new Set(), showShop = true, categoryIcon = 'otros' } = {}) {
  return html`<article class="product-card reveal">
    <a href="#/producto/${product.id}" class="product-media" aria-label="${product.name}, ${formatARS(product.price)}">
      ${product.image ? html`<img src="${product.image}" alt="" loading="lazy" decoding="async" width="400" height="400">` : placeholderArt(categoryIcon)}
      ${stockFlag(product)}
    </a>
    ${favButton(product.id, favorites.has(product.id))}
    <a href="#/producto/${product.id}" class="product-body" tabindex="-1">
      <span class="product-name">${product.name}</span>
      <span class="product-price">${formatARS(product.price)}</span>
      ${showShop && product.business ? html`
        <span class="product-shop">${icon('store', { size: 14 })}<span>${product.business.name}</span></span>
        ${product.business.locality ? html`<span class="product-loc">${icon('pin', { size: 14 })}<span>${product.business.locality}</span></span>` : ''}` : ''}
    </a>
  </article>`;
}

export function storeCard(store) {
  return html`<a class="store-card reveal" href="#/tienda/${store.slug}">
    ${storeLogo(store)}
    <span class="grow">
      <span class="store-card-name">${store.name}</span>
      <span class="store-card-meta" >${[store.category, store.locality].filter(Boolean).join(' · ')}</span>
      ${store.tagline ? html`<span class="store-card-meta">${store.tagline}</span>` : ''}
    </span>
    ${icon('chevron-right', { size: 18, className: 'muted' })}
  </a>`;
}

// Ilustración de feria para cuando la organización no subió foto.
export function fairArt() {
  return raw(`<svg viewBox="0 0 320 160" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">
    <rect width="320" height="160" fill="#f7ddc4"/>
    <circle cx="262" cy="34" r="18" fill="#ee4a12" opacity=".85"/>
    <path d="M0 118c40-14 80-14 120-4s90 12 130 0 50-10 70-6v52H0z" fill="#e9c19b"/>
    ${[20, 120, 220].map((x, i) => `<g transform="translate(${x} ${54 + (i % 2) * 8})">
      <path d="M0 26 40 6l40 20z" fill="${['#b5432a', '#f2557e', '#6a5d24'][i]}"/>
      <path d="M0 26h80v10c-7 6-13 6-20 0-7 6-13 6-20 0-7 6-13 6-20 0-7 6-13 6-20 0z" fill="${['#ee4a12', '#fbe5da', '#f2557e'][i]}"/>
      <rect x="6" y="36" width="4" height="40" fill="#5a3c2e"/><rect x="70" y="36" width="4" height="40" fill="#5a3c2e"/>
      <rect x="10" y="58" width="60" height="18" rx="3" fill="#fffbf6"/>
      <circle cx="24" cy="54" r="5" fill="#b5432a"/><rect x="36" y="48" width="10" height="10" rx="2" fill="#6a5d24"/><circle cx="58" cy="53" r="6" fill="#f2557e"/>
    </g>`).join('')}
  </svg>`);
}

export function dateBadgeEl(value) {
  const d = dateBadge(value);
  return html`<span class="date-badge" aria-hidden="true"><span class="d-day">${d.day}</span><span class="d-num">${d.num}</span><span class="d-month">${d.month}</span></span>`;
}

export function fairCard(fair) {
  const logos = fair.participantLogos || [];
  return html`<a class="fair-card reveal" href="#/feria/${fair.slug}">
    <span class="fair-media">
      ${fair.cover ? html`<img src="${fair.cover}" alt="" loading="lazy" decoding="async" width="640" height="320">` : fairArt()}
      ${dateBadgeEl(fair.startsAt)}
      ${fair.status === 'canceled' ? html`<span class="tag tag-error canceled-ribbon">Cancelada</span>` : ''}
    </span>
    <span class="fair-body">
      <span class="row between"><span class="fair-title">${fair.name}</span><span class="chev-btn" aria-hidden="true">${icon('chevron-right', { size: 18 })}</span></span>
      <span class="meta-line">${icon('clock', { size: 18 })}${timeRange(fair.startsAt, fair.endsAt)}</span>
      <span class="meta-line">${icon('pin', { size: 18 })}${[fair.venue, fair.locality].filter(Boolean).join(', ')}</span>
      ${fair.participants ? html`<span class="row">
        <span class="avatars">${logos.slice(0, 4).map(src => html`<span class="store-logo"><img src="${src}" alt="" loading="lazy" width="34" height="34"></span>`)}</span>
        <span class="avatars-count">${fair.participants === 1 ? '1 expositor confirmado' : `${fair.participants} expositores confirmados`}</span>
      </span>` : html`<span class="small muted">Inscripciones ${fair.applicationsOpen ? 'abiertas' : 'cerradas'}</span>`}
    </span>
  </a>`;
}

/** @param {{ scene?: string, title: string, text?: string, action?: any }} options */
export function emptyState({ scene = 'buscando', title, text = '', action = '' }) {
  return html`<div class="empty">
    ${raw(sofia(scene, { size: 210 }))}
    <h2 class="empty-title">${title}</h2>
    ${text ? html`<p class="empty-text">${text}</p>` : ''}
    ${action}
  </div>`;
}

export function loading(label = 'Cargando…') {
  return html`<div class="loading-screen" role="status"><span class="spinner" aria-hidden="true"></span><span>${label}</span></div>`;
}

export function errorState(error, { retry = true } = {}) {
  return html`<div class="empty">
    ${raw(sofia('buscando', { size: 190 }))}
    <h2 class="empty-title">Algo no salió bien</h2>
    <p class="empty-text">${error?.message || 'No pudimos cargar esta pantalla.'}</p>
    ${retry ? html`<button class="btn btn-primary" type="button" data-action="retry">${icon('refresh', { size: 18 })}Reintentar</button>` : ''}
  </div>`;
}

/** @param {string} tone @param {string} title @param {any} [text] @param {string} [iconName] */
export function banner(tone, title, text = '', iconName = 'info') {
  return html`<div class="banner${tone ? ` banner-${tone}` : ''}" role="${tone === 'error' ? 'alert' : 'status'}">${icon(iconName, { size: 20 })}
    <div><strong>${title}</strong>${text ? html`<p>${text}</p>` : ''}</div></div>`;
}

export const statusPill = status => html`<span class="status-pill status-${status}">${STATUS_LABEL[status] || status}</span>`;

export function stepper({ value, min = 1, max = 99, action = 'qty', id = '', small = false, label = 'Cantidad' }) {
  return html`<span class="stepper${small ? ' sm' : ''}" role="group" aria-label="${label}">
    <button type="button" data-action="${action}" data-delta="-1"${attr('data-id', id)} aria-label="Restar uno"${attr('disabled', value <= min)}>${icon('minus', { size: 18 })}</button>
    <output aria-live="polite">${value}</output>
    <button type="button" data-action="${action}" data-delta="1"${attr('data-id', id)} aria-label="Sumar uno"${attr('disabled', value >= max)}>${icon('plus', { size: 18 })}</button>
  </span>`;
}

export function backButton(href = '', label = 'Volver') {
  return href
    ? html`<a class="icon-btn solid" href="${href}" aria-label="${label}">${icon('chevron-left')}</a>`
    : html`<button type="button" class="icon-btn solid" data-action="back" aria-label="${label}">${icon('chevron-left')}</button>`;
}

/** @param {string} title @param {{ back?: boolean, backHref?: string, actions?: any }} [options] */
export function pageHeader(title, { back = true, backHref = '', actions = '' } = {}) {
  return html`<div class="row between">
    <div class="row">${back ? backButton(backHref) : ''}<h1 class="page-title">${title}</h1></div>
    ${actions}
  </div>`;
}

export function demoRibbon() {
  return html`<div class="demo-ribbon" role="note">${icon('info', { size: 16 })}Datos de demostración: tiendas, productos y ferias de ejemplo. No son reales.</div>`;
}
