// Carrito de una sola tienda: un pedido pertenece siempre a un solo vendedor.
// Vive en el dispositivo hasta el checkout; el precio, el stock y el total los
// vuelve a resolver el servidor al confirmar.
export const MAX_QUANTITY = 99;
export const MAX_LINES = 50;

/** @typedef {{ productId: string, variantId: string|null, quantity: number }} CartLine */
/** @typedef {{ businessId: string, lines: CartLine[], requestId?: string }} Cart */

export const emptyCart = businessId => ({ businessId, lines: [] });
const sameLine = (line, productId, variantId) => line.productId === productId && (line.variantId || null) === (variantId || null);

/** @param {Cart} cart */
export function addToCart(cart, productId, variantId, quantity = 1, max = MAX_QUANTITY) {
  const limit = Math.max(0, Math.min(MAX_QUANTITY, max));
  const lines = cart.lines.slice();
  const index = lines.findIndex(line => sameLine(line, productId, variantId));
  const current = index >= 0 ? lines[index].quantity : 0;
  const next = Math.min(limit, current + Math.max(1, Math.floor(quantity)));
  if (next <= 0) return { cart, added: 0 };
  if (index >= 0) lines[index] = { ...lines[index], quantity: next };
  else if (lines.length < MAX_LINES) lines.push({ productId, variantId: variantId || null, quantity: next });
  else return { cart, added: 0 };
  // Cambió el contenido: el intento de compra anterior ya no vale.
  return { cart: { businessId: cart.businessId, lines }, added: next - current };
}

/** @param {Cart} cart */
export function setQuantity(cart, productId, variantId, quantity) {
  const q = Math.floor(Number(quantity));
  const lines = cart.lines
    .map(line => (sameLine(line, productId, variantId) ? { ...line, quantity: Math.min(MAX_QUANTITY, q) } : line))
    .filter(line => line.quantity > 0);
  return { businessId: cart.businessId, lines };
}

export const removeFromCart = (cart, productId, variantId) => setQuantity(cart, productId, variantId, 0);
export const cartCount = cart => cart.lines.reduce((sum, line) => sum + line.quantity, 0);

/**
 * Cotiza el carrito con el catálogo actual. Marca lo que ya no se puede pedir.
 * @param {Cart} cart
 * @param {Array<any>} products con { id, name, price, available, trackStock, stock, variants: [{ id, name, priceDelta, stock }] }
 */
export function quoteCart(cart, products) {
  const byId = new Map(products.map(product => [product.id, product]));
  let subtotal = 0;
  const lines = cart.lines.map(line => {
    const product = byId.get(line.productId);
    if (!product || !product.available) return { ...line, product: product || null, issue: 'unavailable', unitPrice: 0, total: 0 };
    const variant = line.variantId ? product.variants.find(v => v.id === line.variantId) : null;
    if (line.variantId && !variant) return { ...line, product, issue: 'unavailable', unitPrice: 0, total: 0 };
    if (!line.variantId && product.variants.length) return { ...line, product, issue: 'variant', unitPrice: 0, total: 0 };
    const unitPrice = product.price + (variant?.priceDelta || 0);
    const available = product.trackStock ? (variant ? variant.stock : product.stock) : MAX_QUANTITY;
    const issue = available <= 0 ? 'out' : line.quantity > available ? 'short' : null;
    const total = unitPrice * line.quantity;
    if (!issue) subtotal += total;
    return { ...line, product, variant, unitPrice, total, available, issue };
  });
  return { lines, subtotal, ready: lines.length > 0 && lines.every(line => !line.issue) };
}
