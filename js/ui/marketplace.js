// Tarjetas comerciales de MiFav. Sólo arman HTML con datos ya leídos: no
// consultan, no guardan y no inventan disponibilidad, envíos ni cercanía.
import { esc, money, initialsOf } from './format.js';
import { renderIcon } from './icons.js';
import { conditionLabel, categoryForBusiness, localityLabel, MARKETPLACE_CATEGORIES, productCondition } from '../core/marketplace.js';

function productVisual(product) {
  if (product?.image) {
    return `<img src="${esc(product.image)}" alt="" loading="lazy" width="360" height="360">`;
  }
  return `<span class="mifav-product-fallback" aria-hidden="true">${esc(initialsOf(product?.name || 'Producto'))}</span>`;
}

/**
 * Tarjeta de producto para la vidriera. No incluye botón de compra: la compra
 * se decide en la ficha del comercio, donde se ven retiro, envío y stock.
 * @param {{ product: any, business: any, favorite?: boolean }} options
 */
export function marketplaceProductCard({ product, business, favorite = false }) {
  const seller = business?.name || 'Emprendimiento';
  const category = product?.category || (business ? categoryForBusiness(business) : 'Producto');
  const condition = productCondition(product);
  const soldOut = product?.available === false
    || (product?.trackStock !== false && Number(product?.stock) <= 0);
  const href = `#producto/${esc(business?.id || product?.businessId || '')}/${esc(product?.id || '')}`;
  return `<article class="mifav-product-card ${soldOut ? 'is-unavailable' : ''}" data-theme="${esc(business?.theme || 'rose')}">
    <a class="mifav-product-link" href="${href}">
      <span class="mifav-product-media" aria-hidden="true">${productVisual(product)}</span>
      <span class="mifav-product-body">
        <span class="mifav-product-kicker">${esc(category)}</span>
        <span class="mifav-product-name">${esc(product?.name || 'Producto')}</span>
        <span class="mifav-product-seller">${esc(seller)}</span>
        <span class="mifav-product-foot">
          <span class="mifav-product-price">${money(product?.price || 0)}</span>
          ${condition ? `<span class="mifav-condition ${condition === 'used' ? 'is-used' : ''}">${esc(conditionLabel(condition))}</span>` : ''}
        </span>
        ${soldOut ? '<span class="mifav-soldout">Sin stock</span>' : ''}
      </span>
    </a>
    <button class="favorite-button ${favorite ? 'is-active' : ''}" type="button"
      data-action="toggle-favorite" data-business="${esc(business?.id || product?.businessId || '')}"
      data-product="${esc(product?.id || '')}" aria-pressed="${favorite ? 'true' : 'false'}"
      aria-label="${favorite ? 'Quitar de favoritos' : 'Guardar en favoritos'}: ${esc(product?.name || 'producto')}">
      ${renderIcon(favorite ? 'heart-filled' : 'heart', 18)}
    </button>
  </article>`;
}

/** Bloque de un emprendimiento dentro de la búsqueda. */
export function marketplaceBusinessCard({ business, products = [] }) {
  const cover = business?.coverImage
    ? `<img src="${esc(business.coverImage)}" alt="" loading="lazy" width="640" height="300">`
    : `<span class="mifav-store-fallback" aria-hidden="true">${esc(business?.initials || initialsOf(business?.name || 'Tienda'))}</span>`;
  const preview = products.slice(0, 3).map(product => `<span class="mifav-store-preview-item">
      ${product?.image ? `<img src="${esc(product.image)}" alt="" loading="lazy" width="80" height="80">` : `<span>${esc(initialsOf(product?.name || ''))}</span>`}
    </span>`).join('');
  const pickup = business?.pickupEnabled ? 'Retiro' : '';
  const delivery = business?.deliveryEnabled ? 'Envío del vendedor' : '';
  return `<a class="mifav-store-card" href="#comercio/${esc(business?.id || '')}">
    <span class="mifav-store-cover" aria-hidden="true">${cover}</span>
    <span class="mifav-store-body">
      <span class="mifav-product-kicker">${esc(categoryForBusiness(business))}</span>
      <strong>${esc(business?.name || 'Emprendimiento')}</strong>
      <span class="quiet">${esc(business?.subtitle || business?.description || 'Tienda de la comunidad')}</span>
      <span class="mifav-store-meta">
        ${renderIcon('pin', 13)} ${esc(localityLabel(business?.localityId))}
        ${pickup ? `<span class="dot">·</span>${esc(pickup)}` : ''}
        ${delivery ? `<span class="dot">·</span>${esc(delivery)}` : ''}
      </span>
      ${preview ? `<span class="mifav-store-preview" aria-hidden="true">${preview}</span>` : ''}
    </span>
  </a>`;
}

export function categoryTiles({ active = '' } = {}) {
  return `<div class="mifav-category-grid" role="list">
    ${MARKETPLACE_CATEGORIES.filter(category => category.id !== 'otros').map(category => `<button class="mifav-category ${active === category.name ? 'is-active' : ''}" type="button"
      role="listitem" data-action="set-category" data-category="${esc(category.name)}"
      aria-pressed="${active === category.name}">
      <span class="mifav-category-icon">${renderIcon(category.icon, 21)}</span>
      <span class="mifav-category-name">${esc(category.name)}</span>
      <span class="mifav-category-hint">${esc(category.hint)}</span>
    </button>`).join('')}
  </div>`;
}

export function favoriteButton({ businessId, productId, favorite, name = 'producto' }) {
  return `<button class="favorite-button ${favorite ? 'is-active' : ''}" type="button"
    data-action="toggle-favorite" data-business="${esc(businessId)}" data-product="${esc(productId)}"
    aria-pressed="${favorite ? 'true' : 'false'}"
    aria-label="${favorite ? 'Quitar de favoritos' : 'Guardar en favoritos'}: ${esc(name)}">
    ${renderIcon(favorite ? 'heart-filled' : 'heart', 18)}
  </button>`;
}

export function emptyFavorites() {
  return `<section class="mifav-empty-favorites">
    <span class="mifav-empty-icon" aria-hidden="true">${renderIcon('heart', 34)}</span>
    <h2>Todavía no guardaste favoritos</h2>
    <p>Cuando encuentres algo que te guste, tocá el corazón. Queda guardado en este navegador para que lo puedas comparar después.</p>
    <a class="button" href="#comercios">Explorar productos</a>
  </section>`;
}

/** Espacio reservado: no se inventa una fotografía de un evento real. */
export function feriaBanner({ showLink = true } = {}) {
  return `<section class="mifav-feria" aria-labelledby="feria-title">
    <div class="mifav-feria-photo" role="img" aria-label="Espacio reservado para una fotografía real de la Feria Neuquén Centro">
      <span>${renderIcon('pin', 22)}</span>
      <strong>Foto real de la feria</strong>
      <small>Espacio reservado. No usamos imágenes de eventos inventados.</small>
    </div>
    <div class="mifav-feria-copy">
      <p class="eyebrow">FERIA NEUQUÉN CENTRO</p>
      <h2 id="feria-title">La feria también vive en MiFav</h2>
      <p>Estamos preparando el espacio para que puedas reservar y retirar en la feria. Fechas, ubicación y stands se publican cuando la organización los confirme.</p>
      <div class="mifav-feria-actions">
        ${showLink ? '<a class="button secondary" href="#ferias">Ver la feria</a>' : ''}
        <a class="link-button" href="#publicar">Quiero vender en la feria</a>
      </div>
    </div>
  </section>`;
}
