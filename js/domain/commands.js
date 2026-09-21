// Comandos de dominio de CAUCE.
//
// Cada comando es una función pura sobre el estado: no conoce el almacenamiento,
// el transporte ni el navegador. El entorno de demostración los ejecuta contra
// localStorage y el backend local de pruebas los ejecuta dentro de una transacción.
// El "actor" siempre lo resuelve quien ejecuta a partir de su sesión, nunca el cliente.
import { CauceError, requireValue, clone } from '../core/errors.js';
import { scopeOf, scopeKey, assertScope } from '../core/scope.js';
import { emptyCart, changeQuantity, quoteCart } from '../core/cart.js';
import { requireTransition, allowedActions } from '../core/workflow-policy.js';
import { buildDeliveryCode, createDeliveryCode } from '../core/delivery-code.js';
import { sanitizeText, sanitizeNotes, validateCustomerName, isValidArgentinePhone } from '../core/validators.js';
import { validateProductInput, slugify, validateImageReference } from '../core/catalog-rules.js';
import {
  assertCanSubmitForReview, canTransitionBusiness, normalizeReviewNote,
  missingPublicationRequirements,
} from '../core/merchant-status.js';
import {
  requireAccount, requireRole, requireBusinessOwnership, hasRole, validateSignUp, normalizeEmail,
} from '../core/accounts.js';
import {
  DISPATCH_POLICY, assertDriverCanAccept, expiresAt, isExpired, validateTripRequest,
} from '../core/taxi-dispatch.js';
import {
  isTaxiOpenForOffers, isTaxiActive, isTaxiCancelable, validateTaxiTransition,
  getDriverNextAction, TAXI_STATUS_LABELS,
} from '../core/taxi-workflow.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_PAYMENT_METHODS = Object.freeze(['cash_demo', 'transfer_demo']);

export const PAYMENT_METHOD_LABELS = Object.freeze({
  cash_demo: 'Efectivo al recibir (prueba)',
  transfer_demo: 'Transferencia al comercio (prueba)',
});

// ───────────────────────── utilidades internas ─────────────────────────

export function cartKey(ownerId, business) {
  requireValue(Boolean(ownerId), 'SESSION_REQUIRED', 'No hay una identidad para el carrito.');
  return `${ownerId}|${scopeKey(scopeOf(business), 'cart')}`;
}

function findBusiness(state, businessId) {
  const business = state.businesses.find(candidate => candidate.id === businessId);
  requireValue(Boolean(business), 'BUSINESS_NOT_FOUND', 'No se encontró el comercio.');
  return business;
}

function findOrder(state, orderId) {
  const order = state.orders.find(candidate => candidate.id === orderId);
  requireValue(Boolean(order), 'ORDER_NOT_FOUND', 'No se encontró el pedido.');
  return order;
}

function findTrip(state, tripId) {
  const trip = state.trips.find(candidate => candidate.id === tripId);
  requireValue(Boolean(trip), 'TRIP_NOT_FOUND', 'No se encontró el viaje.');
  return trip;
}

function driverOf(state, actor) {
  const driver = state.drivers.find(candidate => candidate.accountId === actor?.id);
  requireValue(Boolean(driver), 'DRIVER_NOT_FOUND', 'Todavía no completaste tu alta como conductor.');
  return driver;
}

function businessProducts(state, business) {
  return state.products.filter(product => product.businessId === business.id && product.localityId === business.localityId);
}

function cartOf(state, ownerId, business) {
  return state.carts[cartKey(ownerId, business)] || emptyCart(scopeOf(business));
}

function syncBusinessFlags(business) {
  // cart.js y el resto del motor heredado leen `active`: se mantiene derivado del estado de alta.
  business.active = business.status === 'active';
  if (business.status !== 'active') business.open = false;
  return business;
}

function audit(state, context, type, detail) {
  state.auditLog.push({
    id: context.uuid(),
    at: context.now(),
    actorId: context.actor?.id || null,
    type,
    detail,
  });
  if (state.auditLog.length > 500) state.auditLog.splice(0, state.auditLog.length - 500);
}

// El barrido de vencimientos corre antes de cada comando: una solicitud sin
// respuesta no puede quedar abierta para siempre.
export function expireStaleTrips(state, now) {
  let changed = 0;
  for (const trip of state.trips) {
    if (!isExpired(trip, now)) continue;
    trip.status = 'expired';
    trip.updatedAt = now;
    trip.history.push({ status: 'expired', timestamp: now, actor: 'system', note: 'La solicitud venció sin respuesta.' });
    changed += 1;
  }
  return changed;
}

function merchantActorFor(business) {
  return { kind: 'merchant', ...scopeOf(business) };
}

// ───────────────────────── cuentas ─────────────────────────

const accountCommands = {
  'account.register'(state, context, payload) {
    const profile = validateSignUp(payload, { requirePassword: false });
    const exists = state.accounts.some(account => account.email === profile.email);
    requireValue(!exists, 'EMAIL_TAKEN', 'Ya existe una cuenta con ese correo.');
    const roles = Array.isArray(payload?.roles) && payload.roles.length
      ? [...new Set(['customer', ...payload.roles.filter(role => ['merchant', 'driver'].includes(role))])]
      : ['customer'];
    const account = {
      id: payload?.id || `acc-${context.uuid()}`,
      email: profile.email,
      name: profile.name,
      phone: profile.phone,
      roles,
      createdAt: context.now(),
    };
    state.accounts.push(account);
    audit(state, context, 'account.register', { accountId: account.id, roles });
    return account;
  },

  'account.addRole'(state, context, payload) {
    const actor = requireAccount(context.actor);
    requireValue(['merchant', 'driver'].includes(payload?.role), 'INVALID_ROLE', 'Rol no disponible para autogestión.');
    const account = state.accounts.find(candidate => candidate.id === actor.id);
    requireValue(Boolean(account), 'SESSION_REQUIRED', 'Sesión inválida.');
    if (!account.roles.includes(payload.role)) account.roles.push(payload.role);
    return account;
  },
};

// ───────────────────────── alta y gestión de comercios ─────────────────────────

const BUSINESS_TEXT_FIELDS = Object.freeze({
  name: 80, subtitle: 80, description: 280, category: 40, ownerName: 80,
  contactPhone: 24, contactEmail: 120, address: 120, reference: 120,
  hoursLabel: 80, deliveryZone: 80, eta: 40,
});

function applyBusinessPatch(business, patch) {
  for (const [field, maxLength] of Object.entries(BUSINESS_TEXT_FIELDS)) {
    if (!Object.hasOwn(patch, field)) continue;
    business[field] = sanitizeText(patch[field], { fallback: '', maxLength });
  }
  if (Object.hasOwn(patch, 'contactPhone') && business.contactPhone) {
    requireValue(isValidArgentinePhone(business.contactPhone), 'INVALID_PHONE',
      'Ingresá un teléfono de contacto válido.');
  }
  for (const flag of ['pickupEnabled', 'deliveryEnabled']) {
    if (!Object.hasOwn(patch, flag)) continue;
    requireValue(typeof patch[flag] === 'boolean', 'INVALID_VALUE', 'Modalidad de entrega inválida.');
    business[flag] = patch[flag];
  }
  for (const amount of ['deliveryFee', 'minimumOrder']) {
    if (!Object.hasOwn(patch, amount)) continue;
    const value = Number(patch[amount]);
    requireValue(Number.isSafeInteger(value) && value >= 0 && value <= 10000000,
      'INVALID_AMOUNT', 'Los importes deben ser enteros mayores o iguales a cero.');
    business[amount] = value;
  }
  if (Object.hasOwn(patch, 'coverImage')) business.coverImage = validateImageReference(patch.coverImage);
  if (Object.hasOwn(patch, 'theme')) {
    const theme = sanitizeText(patch.theme, { fallback: 'sage', maxLength: 12 });
    business.theme = ['sage', 'clay', 'sand'].includes(theme) ? theme : 'sage';
  }
  return business;
}

const businessCommands = {
  'business.create'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const owned = state.businesses.filter(business => business.ownerId === actor.id);
    requireValue(owned.length < 5, 'BUSINESS_LIMIT', 'Alcanzaste el máximo de comercios por cuenta.');
    const name = sanitizeText(payload?.name, { fallback: '', maxLength: 80 });
    requireValue(name.length >= 2, 'INVALID_BUSINESS_NAME', 'Ingresá el nombre comercial.');
    const base = slugify(name, 'comercio');
    let id = base;
    let suffix = 1;
    while (state.businesses.some(business => business.id === id)) { id = `${base}-${++suffix}`; }
    const now = context.now();
    const account = state.accounts.find(candidate => candidate.id === actor.id);
    if (account && !account.roles.includes('merchant')) account.roles.push('merchant');
    const business = syncBusinessFlags({
      id,
      localityId: 'alumine',
      ownerId: actor.id,
      name,
      subtitle: '',
      description: '',
      category: '',
      initials: name.slice(0, 2).toUpperCase(),
      theme: 'sage',
      status: 'draft',
      open: false,
      active: false,
      pickupEnabled: true,
      deliveryEnabled: false,
      deliveryFee: 0,
      minimumOrder: 0,
      deliveryZone: '',
      ownerName: actor.name,
      contactPhone: actor.phone || '',
      contactEmail: actor.email,
      address: '',
      reference: '',
      hoursLabel: '',
      eta: '',
      coverImage: '',
      badge: '',
      reviewNote: '',
      submittedAt: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    applyBusinessPatch(business, payload || {});
    state.businesses.push(business);
    audit(state, context, 'business.create', { businessId: business.id });
    return business;
  },

  'business.update'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const business = requireBusinessOwnership(actor, findBusiness(state, payload?.businessId));
    requireValue(business.status !== 'pending_review', 'BUSINESS_LOCKED',
      'La solicitud está en revisión. Esperá la respuesta de administración para volver a editar.');
    applyBusinessPatch(business, payload?.patch || {});
    business.updatedAt = context.now();
    return syncBusinessFlags(business);
  },

  'business.submit'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const business = requireBusinessOwnership(actor, findBusiness(state, payload?.businessId));
    assertCanSubmitForReview(business, businessProducts(state, business));
    requireValue(canTransitionBusiness(business.status, 'pending_review', 'merchant'),
      'INVALID_BUSINESS_STATUS', 'La solicitud no puede enviarse desde este estado.');
    business.status = 'pending_review';
    business.reviewNote = '';
    business.submittedAt = context.now();
    business.updatedAt = business.submittedAt;
    audit(state, context, 'business.submit', { businessId: business.id });
    return syncBusinessFlags(business);
  },

  'business.setOpen'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const business = requireBusinessOwnership(actor, findBusiness(state, payload?.businessId));
    requireValue(business.status === 'active', 'BUSINESS_NOT_ACTIVE',
      'Solo un comercio publicado puede abrir o cerrar la atención.');
    requireValue(typeof payload?.open === 'boolean', 'INVALID_VALUE', 'Estado inválido.');
    business.open = payload.open;
    business.updatedAt = context.now();
    return business;
  },

  'business.setStatus'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const business = requireBusinessOwnership(actor, findBusiness(state, payload?.businessId));
    const next = payload?.status;
    requireValue(['paused', 'active'].includes(next), 'INVALID_BUSINESS_STATUS', 'Cambio de estado no permitido.');
    requireValue(canTransitionBusiness(business.status, next, 'merchant'), 'INVALID_BUSINESS_STATUS',
      'No se puede pasar a ese estado desde el actual.');
    business.status = next;
    business.updatedAt = context.now();
    audit(state, context, 'business.setStatus', { businessId: business.id, status: next });
    return syncBusinessFlags(business);
  },
};

// ───────────────────────── catálogo ─────────────────────────

function requireCatalogAccess(state, context, businessId) {
  const actor = requireAccount(context.actor);
  return requireBusinessOwnership(actor, findBusiness(state, businessId));
}

const catalogCommands = {
  'product.create'(state, context, payload) {
    const business = requireCatalogAccess(state, context, payload?.businessId);
    const fields = validateProductInput(payload?.product || {}, { partial: false });
    requireValue(businessProducts(state, business).length < 120, 'CATALOG_LIMIT',
      'El catálogo admite hasta 120 productos por comercio.');
    const base = slugify(fields.name, 'producto');
    let id = `${business.id}-${base}`;
    let suffix = 1;
    while (state.products.some(product => product.id === id)) { id = `${business.id}-${base}-${++suffix}`; }
    const now = context.now();
    const product = {
      id,
      businessId: business.id,
      localityId: business.localityId,
      priceStatus: 'confirmed',
      archived: false,
      badge: '',
      dishType: 'burger',
      image: '',
      variants: [],
      ...fields,
      createdAt: now,
      updatedAt: now,
    };
    state.products.push(product);
    audit(state, context, 'product.create', { businessId: business.id, productId: product.id });
    return product;
  },

  // Cada comercio administra su propio reparto: da de alta a su gente, nadie más.
  'rider.create'(state, context, payload) {
    const business = requireCatalogAccess(state, context, payload?.businessId);
    const name = sanitizeText(payload?.name, { fallback: '', maxLength: 60 });
    requireValue(name.length >= 2, 'INVALID_NAME', 'Ingresá el nombre de la persona que reparte.');
    const existing = state.riders.filter(rider => rider.businessId === business.id);
    requireValue(existing.length < 10, 'RIDER_LIMIT', 'Se admiten hasta 10 personas de reparto por comercio.');
    const rider = {
      id: `rider-${context.uuid()}`,
      businessId: business.id,
      localityId: business.localityId,
      name,
      phone: sanitizeText(payload?.phone, { fallback: '', maxLength: 24 }),
      createdAt: context.now(),
    };
    state.riders.push(rider);
    audit(state, context, 'rider.create', { businessId: business.id, riderId: rider.id });
    return rider;
  },

  'product.update'(state, context, payload) {
    const business = requireCatalogAccess(state, context, payload?.businessId);
    const product = state.products.find(candidate => candidate.id === payload?.productId);
    requireValue(Boolean(product), 'PRODUCT_NOT_FOUND', 'No se encontró el producto.');
    assertScope(product, scopeOf(business));
    const fields = validateProductInput(payload?.patch || {}, { partial: true });
    requireValue(Object.keys(fields).length > 0, 'EMPTY_PATCH', 'No hay cambios para guardar.');
    Object.assign(product, fields);
    product.updatedAt = context.now();
    return product;
  },
};

// ───────────────────────── revisión administrativa ─────────────────────────

const adminCommands = {
  'admin.reviewBusiness'(state, context, payload) {
    const actor = requireAccount(context.actor);
    requireRole(actor, 'admin', 'La revisión de altas corresponde a administración.');
    const business = findBusiness(state, payload?.businessId);
    const decision = payload?.decision;
    requireValue(['approve', 'return'].includes(decision), 'INVALID_DECISION', 'Decisión inválida.');
    const note = normalizeReviewNote(payload?.note);
    if (decision === 'return') {
      requireValue(note.length >= 8, 'REVIEW_NOTE_REQUIRED',
        'Indicá el motivo de la devolución para que el comercio pueda corregir.');
    }
    const next = decision === 'approve' ? 'active' : 'returned';
    requireValue(canTransitionBusiness(business.status, next, 'admin'), 'INVALID_BUSINESS_STATUS',
      'El comercio no está en un estado revisable.');
    business.status = next;
    business.reviewNote = decision === 'return' ? note : '';
    business.reviewedAt = context.now();
    business.updatedAt = business.reviewedAt;
    if (next === 'active') business.open = true;
    audit(state, context, 'admin.reviewBusiness', { businessId: business.id, decision });
    return syncBusinessFlags(business);
  },

  'admin.reviewDriver'(state, context, payload) {
    const actor = requireAccount(context.actor);
    requireRole(actor, 'admin', 'La revisión de altas corresponde a administración.');
    const driver = state.drivers.find(candidate => candidate.id === payload?.driverId);
    requireValue(Boolean(driver), 'DRIVER_NOT_FOUND', 'No se encontró el conductor.');
    const decision = payload?.decision;
    requireValue(['approve', 'return'].includes(decision), 'INVALID_DECISION', 'Decisión inválida.');
    const note = normalizeReviewNote(payload?.note);
    if (decision === 'return') {
      requireValue(note.length >= 8, 'REVIEW_NOTE_REQUIRED', 'Indicá el motivo de la devolución.');
    }
    requireValue(driver.status === 'pending_review', 'INVALID_DRIVER_STATUS',
      'El alta del conductor no está pendiente de revisión.');
    driver.status = decision === 'approve' ? 'active' : 'returned';
    driver.reviewNote = decision === 'return' ? note : '';
    driver.available = false;
    driver.updatedAt = context.now();
    audit(state, context, 'admin.reviewDriver', { driverId: driver.id, decision });
    return driver;
  },
};

// ───────────────────────── carrito y pedidos ─────────────────────────

const cartCommands = {
  'cart.setQuantity'(state, context, payload) {
    const ownerId = context.ownerId;
    const business = findBusiness(state, payload?.businessId);
    const product = state.products.find(candidate => candidate.id === payload?.productId);
    requireValue(Boolean(product), 'PRODUCT_NOT_FOUND', 'No se encontró el producto.');
    requireValue(business.status === 'active', 'BUSINESS_NOT_ACTIVE', 'El comercio no está publicado.');
    const next = changeQuantity(cartOf(state, ownerId, business), product, Number(payload?.quantity));
    state.carts[cartKey(ownerId, business)] = next;
    return next;
  },

  'cart.clear'(state, context, payload) {
    const ownerId = context.ownerId;
    const business = findBusiness(state, payload?.businessId);
    const next = emptyCart(scopeOf(business));
    state.carts[cartKey(ownerId, business)] = next;
    return next;
  },

  'cart.prepareRequest'(state, context, payload) {
    const ownerId = context.ownerId;
    const business = findBusiness(state, payload?.businessId);
    const cart = cartOf(state, ownerId, business);
    requireValue(cart.lines.length > 0, 'EMPTY_CART', 'Tu carrito está vacío.');
    cart.requestId ||= context.uuid();
    state.carts[cartKey(ownerId, business)] = cart;
    return cart.requestId;
  },
};

const orderCommands = {
  'order.create'(state, context, payload) {
    const ownerId = context.ownerId;
    const business = findBusiness(state, payload?.businessId);
    requireValue(UUID.test(payload?.requestId || ''), 'INVALID_REQUEST_ID', 'Identificador de intento inválido.');
    const paymentMethod = payload?.paymentMethod || 'cash_demo';
    requireValue(DEMO_PAYMENT_METHODS.includes(paymentMethod), 'PAYMENTS_DISABLED',
      'Los pagos reales están deshabilitados en esta entrega. Elegí una forma de pago de prueba.');
    const fulfillment = payload?.fulfillment;
    requireValue(['pickup', 'delivery'].includes(fulfillment), 'INVALID_FULFILLMENT', 'Modalidad inválida.');

    const nameCheck = validateCustomerName(payload?.customer?.name);
    requireValue(nameCheck.ok, 'INVALID_NAME', nameCheck.message || 'Ingresá un nombre de contacto.');
    const phone = sanitizeText(payload?.customer?.phone, { fallback: '', maxLength: 24 });
    requireValue(isValidArgentinePhone(phone), 'INVALID_PHONE', 'Ingresá un teléfono de contacto válido.');
    const address = fulfillment === 'delivery' ? sanitizeText(payload?.customer?.address, { maxLength: 200 }) : '';
    requireValue(fulfillment !== 'delivery' || address.length >= 5, 'ADDRESS_REQUIRED',
      'Ingresá la dirección de entrega.');
    if (fulfillment === 'delivery' && business.deliveryZone) {
      requireValue(payload?.customer?.zoneAcknowledged === true, 'ZONE_NOT_CONFIRMED',
        `Confirmá que la dirección está dentro de la zona de reparto: ${business.deliveryZone}.`);
    }
    const notes = sanitizeNotes(payload?.customer?.notes, '');
    const person = { name: nameCheck.name, phone, address, notes };

    // El intento se resuelve ANTES de mirar el carrito: si la confirmación se
    // repite (doble toque, reintento tras un error de red), el carrito ya está
    // vacío y aun así hay que devolver el mismo pedido, no crear otro ni fallar.
    const fingerprint = JSON.stringify({ fulfillment, person, paymentMethod });
    const key = `${ownerId}:${business.localityId}:${business.id}:${payload.requestId}`;
    if (Object.hasOwn(state.requests, key)) {
      const previous = state.requests[key];
      requireValue(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT',
        'Ese intento ya se usó con otros datos. Revisá tus pedidos antes de crear otro.');
      return findOrder(state, previous.orderId);
    }

    // El total nunca se toma del navegador: se recalcula contra el catálogo guardado.
    const cart = cartOf(state, ownerId, business);
    requireValue(cart.lines.length > 0, 'EMPTY_CART', 'Tu carrito está vacío.');
    requireValue(cart.requestId === payload.requestId, 'STALE_REQUEST',
      'El carrito cambió desde que abriste la confirmación. Revisalo y confirmá de nuevo.');
    const payloadLines = cart.lines
      .map(line => ({ productId: line.productId, quantity: line.quantity }))
      .sort((a, b) => String(a.productId).localeCompare(String(b.productId)));
    requireValue(state.orders.length < 1000, 'DEMO_LIMIT', 'El entorno admite hasta 1000 pedidos.');

    const quote = quoteCart({ ...scopeOf(business), lines: payloadLines }, business, state.products, fulfillment);
    for (const line of quote.lines) {
      state.products.find(product => product.id === line.productId).stock -= line.quantity;
    }
    const now = context.now();
    const orderId = context.uuid();
    const order = {
      id: orderId,
      code: `CA-${String(++state.sequence).padStart(4, '0')}`,
      trackingToken: context.uuid(),
      deliveryCode: fulfillment === 'delivery' ? buildDeliveryCode(createDeliveryCode(orderId)) : null,
      ...scopeOf(business),
      customerId: ownerId,
      customerAccountId: context.actor?.kind === 'account' ? context.actor.id : null,
      customer: person,
      fulfillment,
      paymentMethod,
      paymentStatus: 'pending_on_delivery',
      status: 'submitted',
      version: 1,
      ...quote,
      createdAt: now,
      updatedAt: now,
      riderId: null,
      cancellation: null,
      history: [{ status: 'submitted', at: now }],
      environment: context.environment || 'demo',
    };
    state.orders.push(order);
    state.requests[key] = { fingerprint, orderId };
    const current = cartOf(state, ownerId, business);
    if (current.requestId === payload.requestId) {
      state.carts[cartKey(ownerId, business)] = emptyCart(scopeOf(business));
    }
    audit(state, context, 'order.create', { orderId, businessId: business.id, total: order.total });
    return order;
  },

  'order.transition'(state, context, payload) {
    const order = findOrder(state, payload?.orderId);
    requireValue(order.version === Number(payload?.expectedVersion), 'STALE_ORDER',
      'El pedido cambió mientras lo mirabas. Actualizá la vista y reintentá.');
    const business = findBusiness(state, order.businessId);
    const nextStatus = payload?.nextStatus;
    const actor = resolveOrderActor(state, context, order, business, nextStatus);
    requireTransition(order, nextStatus, actor);

    if (nextStatus === 'assigned') {
      const rider = state.riders.find(candidate => candidate.id === payload?.riderId);
      requireValue(Boolean(rider), 'RIDER_REQUIRED', 'Elegí un repartidor del comercio.');
      assertScope(rider, order);
      order.riderId = rider.id;
    }
    if (nextStatus === 'delivered' && order.deliveryCode) {
      order.deliveryCode = buildDeliveryCode(order.deliveryCode.code, {
        confirmedAt: context.now(), confirmedBy: actor.id || actor.kind,
      });
    }
    if (nextStatus === 'canceled') {
      const reason = normalizeReviewNote(payload?.reason);
      const byMerchant = actor.kind === 'merchant';
      if (byMerchant) {
        requireValue(reason.length >= 4, 'REASON_REQUIRED',
          'Indicá el motivo para que la persona sepa por qué no se puede preparar.');
      }
      order.cancellation = {
        kind: byMerchant && order.status === 'submitted' ? 'rejected' : 'canceled',
        by: actor.kind,
        reason: reason || 'Sin motivo indicado',
        at: context.now(),
      };
      for (const line of order.lines) {
        const product = state.products.find(candidate => candidate.id === line.productId);
        if (product) { assertScope(product, order); product.stock += line.quantity; }
      }
    }
    order.status = nextStatus;
    order.version += 1;
    order.updatedAt = context.now();
    order.history.push({ status: nextStatus, at: order.updatedAt });
    audit(state, context, 'order.transition', { orderId: order.id, status: nextStatus });
    return order;
  },
};

// El actor que aplica a un pedido se deriva del estado, nunca de lo que declare el cliente.
//
// El reparto de un comercio es personal del propio comercio, no cuentas
// independientes: quien opera el panel de reparto es la persona responsable del
// comercio. Por eso, si la cuenta es dueña del comercio, se le permite actuar
// como el repartidor asignado a ese pedido —y sólo a ese—. Fuera del comercio
// dueño, ningún actor puede tocar el pedido.
function resolveOrderActor(state, context, order, business, nextStatus) {
  const actor = context.actor;
  if (actor?.kind === 'account' && business.ownerId === actor.id) {
    const asMerchant = merchantActorFor(business);
    if (allowedActions(order, asMerchant).includes(nextStatus)) return asMerchant;
    if (order.riderId) {
      const rider = state.riders.find(candidate => candidate.id === order.riderId);
      if (rider && rider.businessId === business.id) {
        return { kind: 'rider', id: rider.id, businessId: order.businessId, localityId: order.localityId };
      }
    }
    return asMerchant;
  }
  requireValue(order.customerId === context.ownerId, 'TENANT_MISMATCH', 'El pedido pertenece a otra persona.');
  return { kind: 'customer', id: order.customerId };
}

// ───────────────────────── taxis ─────────────────────────

const driverCommands = {
  'driver.apply'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const existing = state.drivers.find(candidate => candidate.accountId === actor.id);
    const displayName = sanitizeText(payload?.displayName, { fallback: actor.name, maxLength: 80 });
    requireValue(displayName.length >= 2, 'INVALID_NAME', 'Ingresá el nombre con el que operás.');
    const vehicle = sanitizeText(payload?.vehicle, { fallback: '', maxLength: 60 });
    requireValue(vehicle.length >= 3, 'INVALID_VEHICLE', 'Indicá marca y modelo del vehículo.');
    const plate = sanitizeText(payload?.plate, { fallback: '', maxLength: 12 }).toUpperCase();
    requireValue(plate.length >= 5, 'INVALID_PLATE', 'Ingresá la patente del vehículo.');
    const phone = sanitizeText(payload?.phone, { fallback: actor.phone || '', maxLength: 24 });
    requireValue(isValidArgentinePhone(phone), 'INVALID_PHONE', 'Ingresá un teléfono de contacto válido.');
    const mobileNumber = sanitizeText(payload?.mobileNumber, { fallback: '', maxLength: 40 });

    const account = state.accounts.find(candidate => candidate.id === actor.id);
    if (account && !account.roles.includes('driver')) account.roles.push('driver');

    const now = context.now();
    if (existing) {
      requireValue(['draft', 'returned'].includes(existing.status), 'INVALID_DRIVER_STATUS',
        'Tu alta ya fue enviada. Esperá la respuesta de administración.');
      Object.assign(existing, { displayName, vehicle, plate, phone, mobileNumber, status: 'pending_review', reviewNote: '', updatedAt: now });
      audit(state, context, 'driver.apply', { driverId: existing.id, resubmitted: true });
      return existing;
    }
    const driver = {
      id: `driver-${context.uuid()}`,
      accountId: actor.id,
      localityId: 'alumine',
      displayName, vehicle, plate, phone, mobileNumber,
      status: 'pending_review',
      available: false,
      reviewNote: '',
      createdAt: now,
      updatedAt: now,
    };
    state.drivers.push(driver);
    audit(state, context, 'driver.apply', { driverId: driver.id });
    return driver;
  },

  'driver.setAvailability'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const driver = driverOf(state, actor);
    requireValue(driver.status === 'active', 'DRIVER_NOT_ELIGIBLE',
      'Tu alta todavía no fue aprobada por administración.');
    requireValue(typeof payload?.available === 'boolean', 'INVALID_VALUE', 'Valor de disponibilidad inválido.');
    driver.available = payload.available;
    driver.updatedAt = context.now();
    return driver;
  },
};

const tripCommands = {
  'trip.request'(state, context, payload) {
    const ownerId = context.ownerId;
    const request = validateTripRequest(payload);
    const open = state.trips.filter(trip => trip.passengerId === ownerId && isTaxiActive(trip.status));
    requireValue(open.length < DISPATCH_POLICY.maxOpenRequestsPerPassenger, 'ACTIVE_TRIP_EXISTS',
      'Ya tenés una solicitud de viaje en curso. Seguila o cancelala antes de pedir otra.');

    const availableDrivers = state.drivers.filter(driver => driver.status === 'active' && driver.available);
    const now = context.now();
    const trip = {
      id: `taxi-${context.uuid()}`,
      localityId: 'alumine',
      passengerId: ownerId,
      passengerAccountId: context.actor?.kind === 'account' ? context.actor.id : null,
      ...request,
      driverId: null,
      status: availableDrivers.length > 0 ? 'searching' : 'no_availability',
      paymentMethod: 'cash_demo',
      paymentLabel: 'A coordinar con el conductor (prueba)',
      dispatchMode: DISPATCH_POLICY.mode,
      offeredTo: availableDrivers.map(driver => driver.id),
      createdAt: now,
      updatedAt: now,
      expiresAt: expiresAt(now),
      history: [{
        status: availableDrivers.length > 0 ? 'searching' : 'no_availability',
        timestamp: now,
        actor: 'passenger',
        note: availableDrivers.length > 0
          ? `Solicitud ofrecida a ${availableDrivers.length} conductor(es) disponible(s).`
          : 'No hay conductores disponibles en este momento.',
      }],
      environment: context.environment || 'demo',
    };
    if (trip.status === 'no_availability') trip.expiresAt = null;
    state.trips.unshift(trip);
    audit(state, context, 'trip.request', { tripId: trip.id, offered: trip.offeredTo.length });
    return trip;
  },

  // Aceptación atómica: el primer conductor que llega gana; el segundo recibe un error explícito.
  'trip.accept'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const driver = driverOf(state, actor);
    const trip = findTrip(state, payload?.tripId);
    // El barrido de vencimientos ya corrió, así que acá se mira el estado resultante.
    requireValue(trip.status !== 'expired' && !isExpired(trip, context.now()), 'TRIP_EXPIRED',
      'La solicitud venció y ya no puede tomarse.');
    requireValue(trip.driverId === null, 'TRIP_ALREADY_TAKEN', 'Otro conductor tomó esta solicitud.');
    assertDriverCanAccept(driver, trip, state.trips);
    requireValue(trip.offeredTo.includes(driver.id), 'TRIP_NOT_OFFERED',
      'Esta solicitud no fue ofrecida a tu móvil.');
    validateTaxiTransition(trip.status, 'accepted');
    const now = context.now();
    trip.driverId = driver.id;
    trip.status = 'accepted';
    trip.acceptedAt = now;
    trip.updatedAt = now;
    trip.expiresAt = null;
    trip.history.push({ status: 'accepted', timestamp: now, actor: 'driver', note: `Aceptado por ${driver.displayName}.` });
    audit(state, context, 'trip.accept', { tripId: trip.id, driverId: driver.id });
    return trip;
  },

  'trip.advance'(state, context, payload) {
    const actor = requireAccount(context.actor);
    const driver = driverOf(state, actor);
    const trip = findTrip(state, payload?.tripId);
    requireValue(trip.driverId === driver.id, 'TENANT_MISMATCH', 'El viaje está asignado a otro conductor.');
    const nextAction = getDriverNextAction(trip.status);
    requireValue(Boolean(nextAction), 'NO_FURTHER_ACTIONS', 'El viaje no tiene acciones pendientes.');
    const target = payload?.nextStatus || nextAction.nextStatus;
    requireValue(target === nextAction.nextStatus, 'INVALID_TRANSITION',
      'Ese cambio de estado no sigue el orden del viaje.');
    validateTaxiTransition(trip.status, target);
    const now = context.now();
    trip.status = target;
    trip.updatedAt = now;
    trip.history.push({ status: target, timestamp: now, actor: 'driver', note: TAXI_STATUS_LABELS[target] });
    audit(state, context, 'trip.advance', { tripId: trip.id, status: target });
    return trip;
  },

  'trip.cancel'(state, context, payload) {
    const trip = findTrip(state, payload?.tripId);
    const isPassenger = trip.passengerId === context.ownerId;
    const driver = context.actor?.kind === 'account'
      ? state.drivers.find(candidate => candidate.accountId === context.actor.id)
      : null;
    const isDriver = Boolean(driver) && trip.driverId === driver.id;
    requireValue(isPassenger || isDriver, 'TENANT_MISMATCH', 'El viaje pertenece a otra persona.');
    requireValue(isTaxiCancelable(trip.status), 'CANNOT_CANCEL',
      'El viaje ya está en curso o finalizado y no puede cancelarse.');
    validateTaxiTransition(trip.status, 'canceled');
    const reason = sanitizeText(payload?.reason, { fallback: 'Sin motivo indicado', maxLength: 200 });
    const now = context.now();
    trip.status = 'canceled';
    trip.updatedAt = now;
    trip.canceledBy = isPassenger ? 'passenger' : 'driver';
    trip.history.push({ status: 'canceled', timestamp: now, actor: trip.canceledBy, note: reason });
    audit(state, context, 'trip.cancel', { tripId: trip.id, by: trip.canceledBy });
    return trip;
  },
};

// ───────────────────────── registro ─────────────────────────

export const COMMANDS = Object.freeze({
  ...accountCommands,
  ...businessCommands,
  ...catalogCommands,
  ...adminCommands,
  ...cartCommands,
  ...orderCommands,
  ...driverCommands,
  ...tripCommands,
  'demo.reset'(state, context) {
    requireValue(context.allowReset === true, 'RESET_FORBIDDEN',
      'El reinicio de datos sólo está disponible en el entorno de demostración.');
    return { reset: true };
  },
});

export function isCommand(name) {
  return Object.hasOwn(COMMANDS, name);
}

export function runCommand(state, name, context, payload) {
  requireValue(isCommand(name), 'UNKNOWN_COMMAND', 'Operación no disponible.');
  expireStaleTrips(state, context.now());
  const result = COMMANDS[name](state, context, payload);
  return clone(result);
}

export { CauceError };
