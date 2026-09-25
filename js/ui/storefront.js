// Vidriera de CAUCE: tarjetas de comercio, filas de producto, carrito y totales.
// Sólo arman HTML escapado con datos ya leídos. Los precios que se muestran
// son los del catálogo; el total que vale lo recalcula el servidor al confirmar.
import { esc, money, pluralize, initialsOf } from './format.js';
import { renderIcon } from './icons.js';
import { getProductSvg } from '../data/food-assets.js';
import { nextOpening } from '../core/business-hours.js';
import { confirmedPrice, isCommerciallyPurchasable, knownStock } from '../core/commercial.js';

export function productThumb(item, name = '', className = '') {
  const label = name || item?.name || 'Producto';
  const fallback = `<span class="product-thumb-fallback" aria-hidden="true">${esc(initialsOf(label))}</span>`;
  return `<span class="product-thumb ${className}" aria-hidden="true">
    ${fallback}${item?.image ? `<img src="${esc(item.image)}" alt="" loading="lazy" width="96" height="96">` : ''}
  </span>`;
}

export function merchantAvatar(business, className = '') {
  const initials = business.initials || initialsOf(business.name);
  return `<span class="merchant-avatar ${className}" aria-hidden="true">
    ${business.logoImage
      ? `<img src="${esc(business.logoImage)}" alt="" loading="lazy" width="72" height="72">`
      : `<span>${esc(initials)}</span>`}
  </span>`;
}

// Abierto o cerrado, y por qué: el horario manda aunque el comercio se olvide
// de cerrar, y el interruptor manda aunque esté dentro de horario.
export function availabilityText(business, { connected = false, now = new Date() } = {}) {
  if (business.open) return 'Abierto';
  if (connected && business.acceptingOrders) {
    const next = nextOpening(business.hours, now, business.timezone);
    return next ? `Cerrado · ${next.label.replace('Abre ', 'abre ')}` : 'Cerrado';
  }
  return 'Cerrado';
}

// Lo que decide si pedir o no, en el orden en que se lee: cómo llega, cuánto
// sale el envío, el mínimo y el tiempo declarado por el comercio.
export function businessFacts(business) {
  const facts = [];
  if (business.pickupEnabled) facts.push({ icon: 'store', text: 'Retiro' });
  if (business.deliveryEnabled) {
    facts.push({ icon: 'delivery', text: business.deliveryFee > 0 ? `Envío ${money(business.deliveryFee)}` : 'Envío sin costo' });
    if (business.minimumOrder > 0) facts.push({ icon: '', text: `Mínimo ${money(business.minimumOrder)}` });
  }
  const minutes = Number(business.prepMinutes) || 0;
  if (minutes) facts.push({ icon: 'clock', text: `Listo en ~${minutes} min` });
  return facts;
}

const factList = facts => facts.map(fact => `<span class="fact">${fact.icon ? renderIcon(fact.icon, 14) : ''}${esc(fact.text)}</span>`).join('');

export function businessCard(business, { connected = false } = {}) {
  const facts = businessFacts(business);
  const cover = business.coverImage
    ? `<img class="merchant-cover" src="${esc(business.coverImage)}" alt="" loading="lazy" width="640" height="260">`
    : `<span class="merchant-cover merchant-cover-fallback" aria-hidden="true"><span>${esc(business.initials || initialsOf(business.name))}</span></span>`;
  return `
    <a class="catalog-merchant-card store-card ${business.open ? '' : 'is-closed'}" href="#comercio/${esc(business.id)}"
      data-theme="${esc(business.theme || 'sage')}">
      <div class="store-card-cover" aria-hidden="true">${cover}</div>
      <div class="store-card-body">
        <div class="store-card-head">
          ${merchantAvatar(business, 'merchant-avatar-card')}
          <div class="store-card-title">
            <h3>${esc(business.name)}</h3>
            <span class="quiet">${esc(business.category || 'Comercio local')}</span>
          </div>
          <span class="availability ${business.open ? '' : 'closed'}">${esc(availabilityText(business, { connected }))}</span>
        </div>
        <div class="store-card-facts">${facts.length ? factList(facts) : '<span class="fact">Modalidades a confirmar</span>'}</div>
      </div>
    </a>`;
}

// Cabecera de la ficha del comercio: nombre, estado, cómo llega, tiempos y
// mínimo arriba; dirección, zona y contacto después.
export function storeHeader(business, { connected = false, contact = '', times = '' } = {}) {
  const facts = businessFacts(business).filter(fact => fact.icon !== 'clock');
  return `<section class="shop-header store-header" data-theme="${esc(business.theme || 'sage')}">
    <div class="store-header-cover" aria-hidden="true">
      ${business.coverImage ? `<img src="${esc(business.coverImage)}" alt="" width="960" height="320">` : '<span class="shop-cover-fallback"></span>'}
    </div>
    <div class="store-header-main">
      ${merchantAvatar(business, 'merchant-avatar-shop')}
      <div class="store-header-title">
        <h1 class="page-title">${esc(business.name)}</h1>
        <p class="quiet">${esc(business.subtitle || business.category || '')}</p>
      </div>
    </div>
    <div class="store-header-facts">
      <span class="availability ${business.open ? '' : 'closed'}">${esc(availabilityText(business, { connected }))}</span>
      ${factList(facts)}
    </div>
    ${times ? `<p class="store-header-line">${renderIcon('clock', 14)} ${esc(times)}</p>` : ''}
    ${business.address ? `<p class="store-header-line">${renderIcon('pin', 14)} ${esc(business.address)}</p>` : ''}
    ${business.deliveryEnabled && business.deliveryZone ? `<p class="microcopy">Envíos en: ${esc(business.deliveryZone)}.</p>` : ''}
    ${contact}
  </section>`;
}

function productImage(product) {
  if (product.image) return `<img src="${esc(product.image)}" alt="" loading="lazy" width="192" height="192">`;
  const drawing = product.dishType ? getProductSvg(product.dishType) : '';
  return drawing || `<span class="product-mark">${esc(initialsOf(product.name))}</span>`;
}

// Un solo motivo cuando no se puede pedir: nada de "No disponible" repetido.
export function unavailableReason(product) {
  if (product.available === false) return 'Agotado por hoy';
  if (knownStock(product) <= 0) return 'Sin stock';
  return 'No disponible';
}

function quantityControl({ businessId, product, variant = null, quantity, max }) {
  const variantAttr = variant ? ` data-variant="${esc(variant.id)}"` : '';
  const label = variant ? `${product.name} ${variant.name}` : product.name;
  return `<div class="qty-control" role="group" aria-label="Cantidad de ${esc(label)}">
    <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(businessId)}"
      data-product="${esc(product.id)}"${variantAttr} data-quantity="${quantity - 1}" aria-label="Quitar una unidad">−</button>
    <span class="qty-value" aria-live="polite">${quantity}</span>
    <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(businessId)}"
      data-product="${esc(product.id)}"${variantAttr} data-quantity="${quantity + 1}" ${quantity >= max ? 'disabled' : ''}
      aria-label="Agregar una unidad">+</button>
  </div>`;
}

const addButton = ({ businessId, product, variant = null }) => `<button class="button add-btn" type="button"
  data-action="set-quantity" data-business="${esc(businessId)}" data-product="${esc(product.id)}"${variant
    ? ` data-variant="${esc(variant.id)}"` : ''} data-quantity="1">Agregar</button>`;

/**
 * Fila de producto: texto a la izquierda, foto a la derecha, el botón a mano.
 * @param {any} product
 * @param {{ businessId: string, lines: Array<{ productId: string, variantId: string|null, quantity: number }> }} options
 */
export function productCard(product, { businessId, lines }) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const mine = lines.filter(line => line.productId === product.id);
  const quantity = mine.reduce((total, line) => total + line.quantity, 0);
  const stock = knownStock(product);
  const available = isCommerciallyPurchasable(product) && stock > 0;
  const price = confirmedPrice(product);
  // Con opciones de distinto precio se muestra el más bajo, como "desde".
  const prices = variants.map(variant => price + (Number(variant.priceDelta) || 0)).filter(value => value > 0);
  const lowest = prices.length ? Math.min(...prices) : price;
  const varies = prices.some(value => value !== lowest);
  return `
    <article class="product-card product-row ${available ? '' : 'is-unavailable'} ${variants.length ? 'has-variants' : ''}">
      <div class="product-body">
        <h3>${esc(product.name)}</h3>
        ${product.description ? `<p class="quiet product-desc">${esc(product.description)}</p>` : ''}
        <p class="product-price">${varies ? '<span class="quiet">desde</span> ' : ''}${money(lowest)}</p>
        ${available ? '' : `<p class="product-flag">${esc(unavailableReason(product))}</p>`}
      </div>
      <div class="product-media" aria-hidden="true">${productImage(product)}</div>
      ${variants.length ? `
        <div class="variant-list">
          ${variants.map(variant => {
            const count = mine.find(line => line.variantId === variant.id)?.quantity || 0;
            return `
              <div class="variant-row">
                <span class="variant-name">${esc(variant.name)}${variant.priceDelta
                  ? ` <span class="quiet">${variant.priceDelta > 0 ? '+' : '−'}${money(Math.abs(variant.priceDelta))}</span>` : ''}</span>
                ${available ? (count > 0
                  ? quantityControl({ businessId, product, variant, quantity: count, max: quantity >= stock ? count : Number.MAX_SAFE_INTEGER })
                  : addButton({ businessId, product, variant })) : ''}
              </div>`;
          }).join('')}
        </div>`
      : available ? `<div class="product-actions">${quantity > 0
        ? quantityControl({ businessId, product, quantity, max: stock })
        : addButton({ businessId, product })}</div>` : ''}
    </article>`;
}

// Saltar entre categorías sin tocar la dirección (el hash es la ruta).
export function catalogJump(categories) {
  if (categories.length < 2) return '';
  return `<nav class="catalog-jump" aria-label="Categorías del catálogo">
    ${categories.map((category, index) => `<button class="chip" type="button" data-action="jump-category"
      data-target="cat-${index}">${esc(category)}</button>`).join('')}
  </nav>`;
}

// Barra fija del carrito en la ficha: cuántos productos y cuánto van sumando.
export function cartBar(businessId, { units, subtotal }) {
  if (!units) return '';
  return `<div class="sticky-cart-bar" role="region" aria-label="Carrito">
    <span class="cart-bar-info"><strong>${pluralize(units, 'producto', 'productos')} en el carrito</strong>
      <span>${money(subtotal)}</span></span>
    <a class="button" href="#carrito/${esc(businessId)}">Ver carrito</a>
  </div>`;
}

// Subtotal a precio de catálogo de lo que hay en el carrito (sólo para mostrar).
export function cartSubtotal(lines, products) {
  return lines.reduce((sum, line) => {
    const product = products.find(candidate => candidate.id === line.productId && !candidate.archived);
    if (!product || !isCommerciallyPurchasable(product)) return sum;
    const variant = (product.variants || []).find(item => item.id === line.variantId);
    return sum + (confirmedPrice(product) + (variant ? Number(variant.priceDelta) || 0 : 0)) * line.quantity;
  }, 0);
}

/**
 * Líneas del carrito con sus controles. Una línea cuyo producto se dio de
 * baja, se agotó o cambió de opciones se marca y se puede quitar.
 * @param {Array<{ line: any, product: any, variant: any, unavailable: boolean }>} detail
 * @param {string} businessId
 */
export function cartLines(detail, businessId) {
  return `<ul class="cart-lines-list">
    ${detail.map(({ line, product, variant, unavailable }) => {
      const unit = (confirmedPrice(product || {}) || 0) + (variant ? Number(variant.priceDelta) || 0 : 0);
      const variantAttribute = line.variantId ? ` data-variant="${esc(line.variantId)}"` : '';
      const name = product?.name || 'Producto que ya no está en el catálogo';
      return `
      <li class="cart-line ${unavailable ? 'is-unavailable' : ''}">
        <div class="cart-line-product">
          ${productThumb(product, product?.name)}
          <div class="cart-line-info">
            <span class="cart-line-title">${esc(name)}${variant ? ` · ${esc(variant.name)}` : ''}</span>
            <span class="cart-line-unit-price">${unavailable ? 'Ya no está disponible' : `${money(unit)} c/u`}</span>
          </div>
        </div>
        ${unavailable ? `
        <button class="button secondary cart-line-remove" type="button" data-action="set-quantity" data-business="${esc(businessId)}"
          data-product="${esc(line.productId)}"${variantAttribute} data-quantity="0">Quitar</button>` : `
        <div class="cart-line-controls">
          <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(businessId)}"
            data-product="${esc(line.productId)}"${variantAttribute} data-quantity="${line.quantity - 1}" aria-label="Quitar una unidad de ${esc(name)}">−</button>
          <span class="qty-value">${line.quantity}</span>
          <button class="qty-button" type="button" data-action="set-quantity" data-business="${esc(businessId)}"
            data-product="${esc(line.productId)}"${variantAttribute} data-quantity="${line.quantity + 1}" aria-label="Agregar una unidad de ${esc(name)}"
            ${line.quantity >= Math.min(99, knownStock(product) ?? 0) ? 'disabled' : ''}>+</button>
        </div>
        <span class="cart-line-total">${money(unit * line.quantity)}</span>`}
      </li>`;
    }).join('')}
  </ul>`;
}

// Retiro o envío, con lo que cuesta cada uno: el total no sorprende.
export function fulfillmentSwitch(business, modes, current) {
  if (modes.length < 2) {
    const only = modes[0];
    return `<p class="fulfillment-only">${renderIcon(only === 'pickup' ? 'store' : 'delivery', 16)} ${only === 'pickup'
      ? 'Retiro en el comercio' : `Envío del comercio · ${business.deliveryFee > 0 ? money(business.deliveryFee) : 'sin costo'}`}</p>`;
  }
  return `<div class="segmented" role="group" aria-label="Cómo lo recibís">
    ${modes.map(mode => `<button class="segmented-option ${mode === current ? 'is-active' : ''}" type="button"
      data-action="set-fulfillment" data-business="${esc(business.id)}" data-mode="${mode}" aria-pressed="${mode === current}">
      <strong>${renderIcon(mode === 'pickup' ? 'store' : 'delivery', 16)} ${mode === 'pickup' ? 'Retiro' : 'Envío'}</strong>
      <span>${mode === 'pickup' ? 'Sin costo' : business.deliveryFee > 0 ? money(business.deliveryFee) : 'Sin costo'}</span>
    </button>`).join('')}
  </div>`;
}

export function totalsList(quote, fulfillment) {
  return `<dl class="totals">
    <div><dt>Subtotal</dt><dd>${money(quote.subtotal)}</dd></div>
    <div><dt>${fulfillment === 'delivery' ? 'Envío' : 'Retiro'}</dt><dd>${fulfillment === 'delivery'
      ? (quote.deliveryFee > 0 ? money(quote.deliveryFee) : 'Sin costo') : 'Sin costo'}</dd></div>
    <div class="totals-final"><dt>Total</dt><dd>${money(quote.total)}</dd></div>
  </dl>`;
}
