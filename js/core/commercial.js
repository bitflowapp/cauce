// Extraído y desacoplado de js/core/pricing.js de La Taba. Ver docs/PROVENANCE.md.
export function normalizeMoneyValue(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.round(numeric));
}
export function isPricePending(product) {
  if (!product || typeof product !== 'object') return true;
  if (product.pricePending === true) return true;
  const states = [product.priceStatus, product.price_status]
    .map((value) => String(value ?? '').trim().toLowerCase());
  if (states.includes('pending')) return true;
  const amount = Number(product.price);
  return !Number.isFinite(amount) || amount <= 0;
}
export function confirmedPrice(product) {
  if (isPricePending(product)) return null;
  return normalizeMoneyValue(product.price, 0);
}
export function isStockPending(product) {
  if (!product || typeof product !== 'object') return true;
  const value = product.stock;
  if (value === null || value === undefined || value === '') return true;
  return !Number.isFinite(Number(value));
}
export function knownStock(product) {
  if (isStockPending(product)) return null;
  return Math.max(0, Math.floor(Number(product.stock)));
}
export function isCommerciallyPurchasable(product) {
  if (!product || typeof product !== 'object' || isPricePending(product)) return false;
  const stock = knownStock(product);
  return stock !== null && stock > 0 && product.available === true && product.archived !== true;
}
