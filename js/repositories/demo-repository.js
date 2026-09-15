import { initialDemoState } from '../data/demo.js';
import { CauceError, clone, requireValue } from '../core/errors.js';
import { scopeOf, scopeKey, assertScope } from '../core/scope.js';
import { emptyCart, changeQuantity, quoteCart } from '../core/cart.js';
import { requireTransition } from '../core/workflow-policy.js';
import { randomUuid } from '../core/identifiers.js';
import { validateCustomerName, isValidArgentinePhone, sanitizeText, sanitizeNotes } from '../core/validators.js';
import { createDeliveryCode, buildDeliveryCode } from '../core/delivery-code.js';

export const DEMO_STORAGE_KEY = 'cauce:demo:database:v1';
export const DEMO_CUSTOMER_ID = 'customer-demo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDemoRepository({ storage, locks = globalThis.navigator?.locks,
  uuid = randomUuid, clock = () => new Date().toISOString(), seed = initialDemoState } = {}) {
  requireValue(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function', 'STORAGE_UNAVAILABLE', 'El almacenamiento local no está disponible.');
  let queue = Promise.resolve();
  const read = () => {
    let raw;
    try { raw = storage.getItem(DEMO_STORAGE_KEY); } catch { throw new CauceError('STORAGE_UNAVAILABLE', 'No se puede leer el almacenamiento local.'); }
    if (raw === null) return seed();
    try {
      const state = JSON.parse(raw);
      requireValue(state?.schemaVersion === 1 && Array.isArray(state.businesses) && Array.isArray(state.products)
        && Array.isArray(state.orders) && state.carts && state.requests, 'CORRUPT_STORAGE', 'Datos locales incompatibles.');
      return state;
    } catch { throw new CauceError('CORRUPT_STORAGE', 'Los datos de demostración están dañados. Podés reiniciarlos desde el pie de página.'); }
  };
  const save = state => {
    try { storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state)); }
    catch { throw new CauceError('STORAGE_WRITE_FAILED', 'No se pudo guardar. Liberá espacio o habilitá el almacenamiento.'); }
  };
  const mutate = operation => {
    const run = () => {
      const state = read();
      const result = operation(state);
      save(state);
      return clone(result);
    };
    if (locks?.request) return locks.request('cauce-demo-database-v1', { mode: 'exclusive' }, run);
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  };
  const businessFrom = (state, businessId) => {
    const business = state.businesses.find(b => b.id === businessId);
    requireValue(Boolean(business), 'BUSINESS_NOT_FOUND', 'No se encontró el comercio.');
    return business;
  };
  const cartFrom = (state, business) => {
    const scope = scopeOf(business);
    return state.carts[scopeKey(scope, 'cart')] || emptyCart(scope);
  };
  const merchantCheck = (actor, business) => {
    requireValue(actor?.kind === 'merchant', 'ROLE_REQUIRED', 'Esta acción corresponde al comercio.');
    assertScope(actor, scopeOf(business));
  };
  return Object.freeze({
    mode: 'demo',
    snapshot: () => clone(read()),
    business: id => clone(businessFrom(read(), id)),
    products: businessId => {
      const state = read(); const business = businessFrom(state, businessId);
      return clone(state.products.filter(p => p.businessId === business.id && p.localityId === business.localityId));
    },
    cart: businessId => {
      const state = read(); return clone(cartFrom(state, businessFrom(state, businessId)));
    },
    setQuantity: (businessId, productId, quantity) => mutate(state => {
      const business = businessFrom(state, businessId);
      const product = state.products.find(p => p.id === productId);
      requireValue(Boolean(product), 'PRODUCT_NOT_FOUND', 'No se encontró el producto.');
      const next = changeQuantity(cartFrom(state, business), product, quantity);
      state.carts[scopeKey(scopeOf(business), 'cart')] = next;
      return next;
    }),
    clearCart: businessId => mutate(state => {
      const business = businessFrom(state, businessId); const next = emptyCart(scopeOf(business));
      state.carts[scopeKey(next, 'cart')] = next; return next;
    }),
    prepareRequest: businessId => mutate(state => {
      const business = businessFrom(state, businessId); const cart = cartFrom(state, business);
      requireValue(cart.lines.length > 0, 'EMPTY_CART', 'Tu carrito está vacío.');
      cart.requestId ||= uuid();
      state.carts[scopeKey(cart, 'cart')] = cart;
      return cart.requestId;
    }),
    quote: (businessId, fulfillment = 'pickup') => {
      const state = read(); const business = businessFrom(state, businessId);
      return quoteCart(cartFrom(state, business), business, state.products, fulfillment);
    },
    createOrder: ({ businessId, requestId, lines, fulfillment, customer, paymentMethod = 'cash_demo' }) => mutate(state => {
      const business = businessFrom(state, businessId);
      requireValue(UUID.test(requestId || ''), 'INVALID_REQUEST_ID', 'Identificador de pedido inválido.');
      requireValue(paymentMethod === 'cash_demo', 'PAYMENTS_DISABLED', 'Los pagos reales están deshabilitados.');
      requireValue(['pickup', 'delivery'].includes(fulfillment), 'INVALID_FULFILLMENT', 'Modalidad inválida.');
      const text = value => typeof value === 'string' ? value.trim() : '';
      const rawName = text(customer?.name);
      const nameCheck = validateCustomerName(rawName);
      requireValue(nameCheck.ok, 'INVALID_NAME', 'Ingresá un nombre de entre 2 y 80 caracteres.');
      const rawPhone = text(customer?.phone);
      requireValue(isValidArgentinePhone(rawPhone) || /^[0-9 +()-]{8,24}$/.test(rawPhone), 'INVALID_PHONE', 'Ingresá un teléfono de ejemplo válido.');
      const addressText = fulfillment === 'delivery' ? sanitizeText(customer?.address, { maxLength: 200 }) : '';
      requireValue(fulfillment !== 'delivery' || addressText.length >= 5, 'ADDRESS_REQUIRED', 'Ingresá una dirección de ejemplo para el envío.');
      const notesText = sanitizeNotes(customer?.notes, '');
      requireValue(addressText.length <= 200 && notesText.length <= 300, 'TEXT_TOO_LONG', 'La dirección o las notas son demasiado largas.');
      const person = { name: rawName, phone: rawPhone, address: addressText, notes: notesText };
      requireValue(Array.isArray(lines) && lines.length > 0 && lines.length <= 100, 'EMPTY_CART', 'El carrito está vacío o es demasiado grande.');
      const payloadLines = lines.map(line => ({ productId: line?.productId, quantity: line?.quantity }))
        .sort((a, b) => String(a.productId).localeCompare(String(b.productId)));
      const fingerprint = JSON.stringify({ lines: payloadLines, fulfillment, person, paymentMethod });
      const key = `${business.localityId}:${business.id}:${requestId}`;
      if (Object.hasOwn(state.requests, key)) {
        const previous = state.requests[key];
        requireValue(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Ese intento ya fue usado con otros datos. Revisá los pedidos antes de crear otro.');
        const order = state.orders.find(o => o.id === previous.orderId);
        requireValue(Boolean(order), 'CORRUPT_STORAGE', 'El registro del pedido está incompleto.');
        return order;
      }
      requireValue(state.orders.length < 500, 'DEMO_LIMIT', 'La demo admite hasta 500 pedidos. Reiniciala para continuar.');
      const cart = { ...scopeOf(business), lines: payloadLines };
      const quote = quoteCart(cart, business, state.products, fulfillment);
      for (const line of quote.lines) state.products.find(p => p.id === line.productId).stock -= line.quantity;
      const now = clock();
      const orderId = uuid();
      const deliveryCode = fulfillment === 'delivery' ? buildDeliveryCode(createDeliveryCode(orderId)) : null;
      const trackingToken = uuid();
      const order = { id: orderId, code: `CA-${String(++state.sequence).padStart(4, '0')}`, trackingToken, deliveryCode, ...scopeOf(business),
        customerId: DEMO_CUSTOMER_ID, customer: person, fulfillment, paymentMethod, status: 'submitted', version: 1,
        ...quote, createdAt: now, updatedAt: now, riderId: null, history: [{ status: 'submitted', at: now }], demo: true };
      state.orders.push(order);
      state.requests[key] = { fingerprint, orderId: order.id };
      // No borrar un carrito distinto enviado por otra pestaña.
      const current = cartFrom(state, business);
      if (current.requestId === requestId) state.carts[scopeKey(current, 'cart')] = emptyCart(scopeOf(business));
      return order;
    }),
    orders: actor => {
      const state = read();
      return clone(state.orders.filter(order => {
        if (actor?.kind === 'customer') return order.customerId === actor.id;
        try { assertScope(actor, order); } catch { return false; }
        return actor.kind === 'merchant' || (actor.kind === 'rider' && actor.id === order.riderId);
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    },
    publicTracking: tokenOrId => {
      const state = read();
      const order = state.orders.find(o => o.trackingToken === tokenOrId || o.id === tokenOrId);
      if (!order) return null;
      const business = state.businesses.find(b => b.id === order.businessId);
      return clone({
        id: order.id,
        code: order.code,
        trackingToken: order.trackingToken,
        businessId: order.businessId,
        businessName: business?.name || 'Comercio',
        localityId: order.localityId,
        status: order.status,
        fulfillment: order.fulfillment,
        deliveryFee: order.deliveryFee,
        subtotal: order.subtotal,
        total: order.total,
        lines: order.lines,
        history: order.history,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        customerAddress: order.customer?.address || '',
        deliveryCode: order.deliveryCode?.code || null,
      });
    },
    transition: ({ orderId, expectedVersion, nextStatus, actor, riderId = null }) => mutate(state => {
      const order = state.orders.find(o => o.id === orderId);
      requireValue(Boolean(order), 'ORDER_NOT_FOUND', 'Pedido no encontrado.');
      requireValue(order.version === expectedVersion, 'STALE_ORDER', 'El pedido cambió. Actualizá la vista y reintentá.');
      requireTransition(order, nextStatus, actor);
      if (nextStatus === 'assigned') {
        const rider = state.riders.find(r => r.id === riderId);
        requireValue(Boolean(rider), 'RIDER_REQUIRED', 'Elegí un repartidor del comercio.');
        assertScope(rider, order); order.riderId = rider.id;
      }
      if (nextStatus === 'delivered' && order.deliveryCode) {
        order.deliveryCode = buildDeliveryCode(order.deliveryCode.code, { confirmedAt: clock(), confirmedBy: actor.id || 'rider' });
      }
      if (nextStatus === 'canceled') {
        for (const line of order.lines) {
          const product = state.products.find(p => p.id === line.productId);
          if (product) { assertScope(product, order); product.stock += line.quantity; }
        }
      }
      order.status = nextStatus; order.version += 1; order.updatedAt = clock();
      order.history.push({ status: nextStatus, at: order.updatedAt });
      return order;
    }),
    setBusinessOpen: (businessId, open, actor) => mutate(state => {
      const business = businessFrom(state, businessId); merchantCheck(actor, business);
      requireValue(typeof open === 'boolean', 'INVALID_VALUE', 'Estado inválido.'); business.open = open; return business;
    }),
    updateBusinessConfig: (businessId, patch, actor) => mutate(state => {
      const business = businessFrom(state, businessId); merchantCheck(actor, business);
      if (patch.eta) business.eta = String(patch.eta).slice(0, 40);
      if (patch.hoursLabel) business.hoursLabel = String(patch.hoursLabel).slice(0, 60);
      if (typeof patch.deliveryFee === 'number') business.deliveryFee = Math.max(0, Math.floor(patch.deliveryFee));
      if (typeof patch.deliveryEnabled === 'boolean') business.deliveryEnabled = patch.deliveryEnabled;
      if (typeof patch.pickupEnabled === 'boolean') business.pickupEnabled = patch.pickupEnabled;
      return business;
    }),
    addMerchantLead: lead => mutate(state => {
      state.merchantLeads ||= [];
      state.merchantLeads.push({ ...lead, id: uuid(), at: clock() });
      return true;
    }),
    merchantLeads: () => clone(read().merchantLeads || []),
    updateProduct: (businessId, productId, patch, actor) => mutate(state => {
      const business = businessFrom(state, businessId); merchantCheck(actor, business);
      const product = state.products.find(p => p.id === productId);
      requireValue(Boolean(product), 'PRODUCT_NOT_FOUND', 'Producto no encontrado.'); assertScope(product, scopeOf(business));
      requireValue(patch && Object.keys(patch).every(key => ['price', 'stock', 'available'].includes(key)), 'FIELD_FORBIDDEN', 'No se puede modificar ese campo.');
      if (Object.hasOwn(patch, 'price')) requireValue(Number.isSafeInteger(patch.price) && patch.price > 0 && patch.price <= 10000000, 'INVALID_PRICE', 'El precio debe ser un entero positivo.');
      if (Object.hasOwn(patch, 'stock')) requireValue(Number.isSafeInteger(patch.stock) && patch.stock >= 0 && patch.stock <= 10000, 'INVALID_STOCK', 'Stock inválido.');
      if (Object.hasOwn(patch, 'available')) requireValue(typeof patch.available === 'boolean', 'INVALID_VALUE', 'Disponibilidad inválida.');
      Object.assign(product, patch); return product;
    }),
    reset: () => mutate(state => { const next = seed(); for (const key of Object.keys(state)) delete state[key]; Object.assign(state, next); return true; }),
  });
}
