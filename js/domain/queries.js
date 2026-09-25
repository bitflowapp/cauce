// Lecturas de dominio. Cada consulta recorta lo que el actor puede ver:
// un comercio no ve pedidos de otro y la flota no ve los datos del pasajero.
import { clone, requireValue } from '../core/errors.js';
import { scopeOf } from '../core/scope.js';
import { quoteCart } from '../core/cart.js';
import { hasRole, requireAccount, requireBusinessOwnership } from '../core/accounts.js';
import { isBusinessPubliclyVisible } from '../core/merchant-status.js';
import { offerView, driverPublicView, isExpired } from '../core/taxi-dispatch.js';
import { isTaxiActive, isTaxiOpenForOffers } from '../core/taxi-workflow.js';
import { cartKey, expireStaleTrips } from './commands.js';

function business(state, businessId) {
  const found = state.businesses.find(candidate => candidate.id === businessId);
  requireValue(Boolean(found), 'BUSINESS_NOT_FOUND', 'No se encontró el comercio.');
  return found;
}

export const QUERIES = {
  // ── catálogo público ──
  publicBusinesses(state) {
    return state.businesses
      .filter(isBusinessPubliclyVisible)
      .map(item => clone(item))
      .sort((a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name));
  },

  business(state, context, payload) {
    const found = business(state, payload?.businessId);
    const visible = isBusinessPubliclyVisible(found)
      || (context.actor?.kind === 'account'
        && (found.ownerId === context.actor.id || hasRole(context.actor, 'admin')));
    requireValue(visible, 'BUSINESS_NOT_FOUND', 'No se encontró el comercio.');
    return clone(found);
  },

  products(state, context, payload) {
    const found = business(state, payload?.businessId);
    const privileged = context.actor?.kind === 'account'
      && (found.ownerId === context.actor.id || hasRole(context.actor, 'admin'));
    return state.products
      .filter(product => product.businessId === found.id && product.localityId === found.localityId)
      .filter(product => privileged || !product.archived)
      .map(product => clone(product));
  },

  // ── carritos ──
  cart(state, context, payload) {
    const found = business(state, payload?.businessId);
    return clone(state.carts[cartKey(context.ownerId, found)] || { ...scopeOf(found), version: 1, lines: [] });
  },

  carts(state, context) {
    return state.businesses
      .map(item => ({ business: clone(item), cart: state.carts[cartKey(context.ownerId, item)] }))
      .filter(entry => entry.cart?.lines?.length)
      .map(entry => ({ business: entry.business, cart: clone(entry.cart) }));
  },

  quote(state, context, payload) {
    const found = business(state, payload?.businessId);
    const cart = state.carts[cartKey(context.ownerId, found)] || { ...scopeOf(found), version: 1, lines: [] };
    // `preview`: el total de un comercio cerrado, sólo para mostrarlo.
    return quoteCart(cart, payload?.preview ? { ...found, open: true } : found, state.products, payload?.fulfillment || 'pickup');
  },

  // ── pedidos ──
  myOrders(state, context) {
    return state.orders
      .filter(order => order.customerId === context.ownerId)
      .map(order => clone(order))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  businessOrders(state, context, payload) {
    const actor = requireAccount(context.actor);
    const found = requireBusinessOwnership(actor, business(state, payload?.businessId));
    return state.orders
      .filter(order => order.businessId === found.id && order.localityId === found.localityId)
      .map(order => clone(order))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  order(state, context, payload) {
    const order = state.orders.find(candidate => candidate.id === payload?.orderId);
    requireValue(Boolean(order), 'ORDER_NOT_FOUND', 'No se encontró el pedido.');
    const owner = order.customerId === context.ownerId;
    const merchant = context.actor?.kind === 'account'
      && business(state, order.businessId).ownerId === context.actor.id;
    requireValue(owner || merchant, 'TENANT_MISMATCH', 'El pedido pertenece a otra cuenta.');
    return clone(order);
  },

  riders(state, context, payload) {
    const actor = requireAccount(context.actor);
    const found = requireBusinessOwnership(actor, business(state, payload?.businessId));
    return state.riders
      .filter(rider => rider.businessId === found.id && rider.localityId === found.localityId)
      .map(rider => clone(rider));
  },

  // ── comercios de la cuenta ──
  myBusinesses(state, context) {
    if (context.actor?.kind !== 'account') return [];
    return state.businesses
      .filter(item => item.ownerId === context.actor.id)
      .map(item => clone(item));
  },

  // ── taxis ──
  myTrips(state, context) {
    expireStaleTrips(state, context.now());
    return state.trips
      .filter(trip => trip.passengerId === context.ownerId)
      .map(trip => clone({ ...trip, driver: driverPublicView(state.drivers.find(d => d.id === trip.driverId)) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  myDriver(state, context) {
    if (context.actor?.kind !== 'account') return null;
    const driver = state.drivers.find(candidate => candidate.accountId === context.actor.id);
    return driver ? clone(driver) : null;
  },

  // Solicitudes abiertas visibles para el conductor: sin teléfono ni nombre del pasajero.
  driverOffers(state, context) {
    const actor = requireAccount(context.actor);
    const driver = state.drivers.find(candidate => candidate.accountId === actor.id);
    if (!driver || driver.status !== 'active') return [];
    expireStaleTrips(state, context.now());
    return state.trips
      .filter(trip => isTaxiOpenForOffers(trip.status)
        && trip.driverId === null
        && trip.offeredTo.includes(driver.id)
        && !isExpired(trip, context.now()))
      .map(trip => offerView(trip));
  },

  // Viajes ya asignados al conductor: acá sí necesita el contacto del pasajero.
  driverTrips(state, context) {
    const actor = requireAccount(context.actor);
    const driver = state.drivers.find(candidate => candidate.accountId === actor.id);
    if (!driver) return [];
    return state.trips
      .filter(trip => trip.driverId === driver.id)
      .map(trip => clone(trip))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  // ── administración ──
  adminQueue(state, context) {
    const actor = requireAccount(context.actor);
    requireValue(hasRole(actor, 'admin'), 'ROLE_REQUIRED', 'Sección exclusiva de administración.');
    return {
      businesses: state.businesses
        .filter(item => item.status === 'pending_review')
        .map(item => clone(item)),
      drivers: state.drivers
        .filter(item => item.status === 'pending_review')
        .map(item => clone(item)),
      allBusinesses: state.businesses.map(item => clone(item)),
      allDrivers: state.drivers.map(item => clone(item)),
    };
  },

  // Vista agregada: sin direcciones, sin datos de contacto, sin recorridos individuales.
  adminMetrics(state, context) {
    const actor = requireAccount(context.actor);
    requireValue(hasRole(actor, 'admin'), 'ROLE_REQUIRED', 'Sección exclusiva de administración.');
    const byStatus = collection => collection.reduce((totals, item) => {
      totals[item.status] = (totals[item.status] || 0) + 1;
      return totals;
    }, {});
    const orders = state.orders;
    return {
      generatedAt: context.now(),
      source: 'Operaciones registradas en este entorno.',
      businesses: byStatus(state.businesses),
      drivers: byStatus(state.drivers),
      orders: {
        total: orders.length,
        byStatus: byStatus(orders),
        byFulfillment: orders.reduce((totals, order) => {
          totals[order.fulfillment] = (totals[order.fulfillment] || 0) + 1;
          return totals;
        }, {}),
        delivered: orders.filter(order => order.status === 'delivered').length,
        canceled: orders.filter(order => order.status === 'canceled').length,
      },
      trips: {
        total: state.trips.length,
        byStatus: byStatus(state.trips),
        accepted: state.trips.filter(trip => trip.acceptedAt).length,
      },
    };
  },

  snapshotCounts(state) {
    return {
      businesses: state.businesses.length,
      activeBusinesses: state.businesses.filter(isBusinessPubliclyVisible).length,
      products: state.products.filter(product => !product.archived).length,
      orders: state.orders.length,
      trips: state.trips.length,
      openTrips: state.trips.filter(trip => isTaxiActive(trip.status)).length,
    };
  },
};

export function isQuery(name) {
  return Object.hasOwn(QUERIES, name);
}

export function runQuery(state, name, context, payload) {
  requireValue(isQuery(name), 'UNKNOWN_QUERY', 'Consulta no disponible.');
  return QUERIES[name](state, context, payload);
}
