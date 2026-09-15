import { assertScope, scopeKey } from './scope.js';
import { clone, requireValue } from './errors.js';
import { isCommerciallyPurchasable, confirmedPrice, knownStock, normalizeMoneyValue } from './commercial.js';

export const MAX_QUANTITY = 99;

export function emptyCart(scope) {
  scopeKey(scope, 'cart');
  return { ...scope, version: 1, lines: [] };
}

export function validateQuantity(quantity) {
  requireValue(Number.isSafeInteger(quantity) && quantity > 0 && quantity <= MAX_QUANTITY,
    'INVALID_QUANTITY', 'Elegí una cantidad entera entre 1 y 99.');
}

export function changeQuantity(cart, product, quantity) {
  assertScope(product, cart);
  requireValue(Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= MAX_QUANTITY, 'INVALID_QUANTITY', 'Cantidad inválida.');
  if (quantity > 0) {
    validateQuantity(quantity);
    requireValue(isCommerciallyPurchasable(product), 'PRODUCT_UNAVAILABLE', 'El producto no está disponible.');
    requireValue(quantity <= knownStock(product), 'INSUFFICIENT_STOCK', 'No hay stock suficiente.');
  }
  const next = clone(cart);
  next.lines = next.lines.filter(line => line.productId !== product.id);
  if (quantity > 0) next.lines.push({ productId: product.id, quantity });
  delete next.requestId;
  return next;
}

export function validateCartForCheckout(cart, business, products, fulfillment = 'pickup') {
  try {
    const quote = quoteCart(cart, business, products, fulfillment);
    return { ok: true, quote };
  } catch (error) {
    return { ok: false, message: error.message, code: error.code || 'VALIDATION_ERROR' };
  }
}

export function quoteCart(cart, business, products, fulfillment = 'pickup') {
  assertScope(cart, { businessId: business.id, localityId: business.localityId });
  requireValue(['pickup', 'delivery'].includes(fulfillment), 'INVALID_FULFILLMENT', 'Modalidad inválida.');
  requireValue(Array.isArray(cart.lines) && cart.lines.length > 0 && cart.lines.length <= 100, 'EMPTY_CART', 'Tu carrito está vacío.');
  requireValue(business.active && business.open, 'BUSINESS_CLOSED', 'El comercio está cerrado.');
  requireValue(fulfillment === 'pickup' ? business.pickupEnabled : business.deliveryEnabled,
    'FULFILLMENT_DISABLED', 'La modalidad no está disponible.');

  const seen = new Set();
  const lines = cart.lines.map(line => {
    requireValue(!seen.has(line.productId), 'DUPLICATE_PRODUCT', 'El carrito contiene un producto duplicado.');
    seen.add(line.productId);
    validateQuantity(line.quantity);
    const product = products.find(p => p.id === line.productId);
    requireValue(Boolean(product), 'PRODUCT_MISSING', 'Un producto ya no está disponible.');
    assertScope(product, cart);
    requireValue(isCommerciallyPurchasable(product), 'PRODUCT_UNAVAILABLE', 'Un producto dejó de estar disponible.');
    requireValue(line.quantity <= knownStock(product), 'INSUFFICIENT_STOCK', 'El stock cambió. Revisá tu carrito.');
    const unitPrice = confirmedPrice(product);
    requireValue(Number.isSafeInteger(unitPrice) && unitPrice > 0, 'INVALID_PRICE', 'Precio inválido.');
    return { productId: product.id, name: product.name, quantity: line.quantity, unitPrice, total: unitPrice * line.quantity };
  });

  const subtotal = lines.reduce((sum, line) => sum + line.total, 0);
  const deliveryFee = fulfillment === 'delivery' ? normalizeMoneyValue(business.deliveryFee, 0) : 0;
  requireValue(Number.isSafeInteger(deliveryFee) && deliveryFee >= 0 && Number.isSafeInteger(subtotal + deliveryFee), 'INVALID_TOTAL', 'Importe inválido.');
  requireValue(fulfillment !== 'delivery' || subtotal >= (business.minimumOrder || 0), 'MINIMUM_ORDER', `El pedido mínimo para envío es $${business.minimumOrder}.`);
  return { lines, subtotal, deliveryFee, total: subtotal + deliveryFee, currency: 'ARS' };
}
