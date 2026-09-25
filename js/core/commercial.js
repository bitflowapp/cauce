// Portado y desacoplado de js/core/pricing.js de La Taba.
// Ver docs/PROVENANCE.md y comentarios históricos de hardening.

export const PRICE_PENDING_TITLE = 'Precio a confirmar';
export const PRICE_PENDING_DETAIL = 'Este producto todavía no está disponible para compra.';

export function normalizeDeliveryMode(value) {
  return value === 'pickup' ? 'pickup' : 'delivery';
}

export function normalizeStock(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

export function normalizeQuantity(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.floor(numeric));
}

export function normalizeMoneyValue(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.round(numeric));
}

export function isPricePending(product) {
  if (!product || typeof product !== 'object') return true;
  if (product.pricePending === true) return true;
  // Los dos nombres se miran por separado y CUALQUIERA que diga «pending»
  // gana. Con `??` bastaba que la variante en camelCase dijera «confirmed»
  // para tapar una snake_case que decía lo contrario, y entre dos fuentes que
  // se contradicen sobre si algo se puede vender hay que creerle a la que dice
  // que no.
  const states = [product.priceStatus, product.price_status]
    .map((value) => String(value ?? '').trim().toLowerCase());
  if (states.includes('pending')) return true;
  const amount = Number(product.price);
  return !Number.isFinite(amount) || amount <= 0;
}

/** El precio, o `null` si está pendiente. Nunca devuelve cero por ausencia. */
export function confirmedPrice(product) {
  if (isPricePending(product)) return null;
  return normalizeMoneyValue(product.price, 0);
}

/**
 * El stock se declara ausente con `null`, no con cero: cero es «se agotó» y
 * null es «nadie lo contó todavía». Son estados distintos y la diferencia
 * importa, porque uno se resuelve reponiendo y el otro contando.
 */
export function isStockPending(product) {
  if (!product || typeof product !== 'object') return true;
  const value = product.stock;
  if (value === null || value === undefined || value === '') return true;
  return !Number.isFinite(Number(value));
}

// Un producto sin control de stock (gastronomía, hecho al momento) se vende
// mientras esté disponible: su tope es el de cantidad por línea, no existencias.
export const UNTRACKED_STOCK = 9999;

export function knownStock(product) {
  if (product && typeof product === 'object' && product.trackStock === false) return UNTRACKED_STOCK;
  if (isStockPending(product)) return null;
  return Math.max(0, Math.floor(Number(product.stock)));
}

/**
 * La compuerta comercial completa. Si el producto no tiene precio confirmado,
 * no tiene stock medido mayor a cero, o no está disponible/está archivado,
 * falla cerrado.
 */
export function isCommerciallyPurchasable(product) {
  if (!product || typeof product !== 'object' || isPricePending(product)) return false;
  const stock = knownStock(product);
  return stock !== null && stock > 0 && product.available === true && product.archived !== true;
}

export function calculateItemsSubtotal(items = []) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const rawQuantity = Number(item?.quantity);
    const quantity = Number.isFinite(rawQuantity) ? Math.max(0, Math.floor(rawQuantity)) : 0;
    const unitPrice = normalizeMoneyValue(item?.unitPrice ?? item?.product?.price ?? item?.price, 0);
    return sum + quantity * unitPrice;
  }, 0);
}

export function normalizeDiscountAmount(value, subtotal = 0) {
  const safeSubtotal = normalizeMoneyValue(subtotal, 0);
  const discount = normalizeMoneyValue(value, 0);
  return Math.min(safeSubtotal, discount);
}

export function calculateTotals(itemsOrSubtotal = [], deliveryMode = 'delivery', options = {}) {
  const subtotal = Array.isArray(itemsOrSubtotal)
    ? calculateItemsSubtotal(itemsOrSubtotal)
    : normalizeMoneyValue(itemsOrSubtotal, 0);
  const deliveryFee = normalizeDeliveryMode(deliveryMode) === 'pickup'
    ? 0
    : normalizeMoneyValue(options.deliveryFee, 0);
  const discountTotal = normalizeDiscountAmount(options.discountAmount ?? options.discountTotal, subtotal);
  return {
    subtotal,
    discountTotal,
    deliveryFee,
    total: Math.max(0, subtotal - discountTotal) + deliveryFee,
  };
}
