// Estado de dominio de CAUCE. Es la única forma de los datos: la usan tanto el
// entorno de demostración (navegador) como el backend local de pruebas.
import { initialDemoState } from '../data/demo.js';
import { requireValue } from '../core/errors.js';

export const SCHEMA_VERSION = 2;

// Identidades de ejemplo del entorno de demostración. Son ficticias y están
// marcadas como tales; no representan personas ni comercios reales.
export const DEMO_IDENTITIES = Object.freeze([
  Object.freeze({
    id: 'acc-vecina',
    email: 'vecina@demo.cauce.local',
    name: 'Vecina de ejemplo',
    phone: '2942000001',
    roles: Object.freeze(['customer']),
    label: 'Persona usuaria',
    hint: 'Explora comercios, pide con retiro o envío y solicita taxis.',
  }),
  Object.freeze({
    id: 'acc-orilla',
    email: 'comercio@demo.cauce.local',
    name: 'Responsable de La Orilla',
    phone: '2942000002',
    roles: Object.freeze(['customer', 'merchant']),
    label: 'Comercio de ejemplo',
    hint: 'Gestiona el catálogo, los pedidos y el reparto de La Orilla.',
  }),
  Object.freeze({
    id: 'acc-admin',
    email: 'administracion@demo.cauce.local',
    name: 'Administración CAUCE',
    phone: '2942000003',
    roles: Object.freeze(['customer', 'admin']),
    label: 'Administración',
    hint: 'Revisa altas de comercios y de conductores y supervisa la operación.',
  }),
  Object.freeze({
    id: 'acc-taxista',
    email: 'taxista@demo.cauce.local',
    name: 'Conductor de ejemplo',
    phone: '2942000004',
    roles: Object.freeze(['customer', 'driver']),
    label: 'Taxista',
    hint: 'Recibe solicitudes de viaje, acepta y actualiza estados.',
  }),
]);

const OWNER_BY_BUSINESS = Object.freeze({ orilla: 'acc-orilla' });

export function initialState({ seedDemoIdentities = true } = {}) {
  const legacy = initialDemoState();
  const now = '2026-01-01T12:00:00.000Z';

  const businesses = legacy.businesses.map(business => ({
    ...business,
    ownerId: OWNER_BY_BUSINESS[business.id] || 'acc-catalogo-ejemplo',
    status: 'active',
    ownerName: `Responsable de ${business.name}`,
    contactPhone: '2942000000',
    contactEmail: '',
    reference: '',
    deliveryZone: business.deliveryEnabled ? 'Casco urbano de Aluminé' : '',
    reviewNote: '',
    submittedAt: now,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
    sample: true,
  }));

  const products = legacy.products.map(product => ({
    ...product,
    variants: [],
    createdAt: now,
    updatedAt: now,
  }));

  const accounts = seedDemoIdentities
    ? DEMO_IDENTITIES.map(identity => ({
      id: identity.id,
      email: identity.email,
      name: identity.name,
      phone: identity.phone,
      roles: [...identity.roles],
      createdAt: now,
      sample: true,
    }))
    : [];

  const drivers = seedDemoIdentities
    ? [{
      id: 'driver-ejemplo',
      accountId: 'acc-taxista',
      localityId: 'alumine',
      displayName: 'Conductor de ejemplo',
      mobileNumber: 'Móvil 1 (ejemplo)',
      vehicle: 'Vehículo de ejemplo',
      plate: 'DEMO 001',
      phone: '2942000004',
      status: 'active',
      available: false,
      reviewNote: '',
      createdAt: now,
      updatedAt: now,
      sample: true,
    }]
    : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    localities: legacy.localities,
    accounts,
    businesses,
    products,
    riders: legacy.riders,
    drivers,
    orders: [],
    trips: [],
    carts: {},
    requests: {},
    merchantLeads: [],
    auditLog: [],
    sequence: 0,
  };
}

const COLLECTIONS = ['localities', 'accounts', 'businesses', 'products', 'riders', 'drivers', 'orders', 'trips', 'auditLog'];

export function assertValidState(state) {
  requireValue(state && state.schemaVersion === SCHEMA_VERSION, 'CORRUPT_STORAGE',
    'Los datos guardados corresponden a otra versión de CAUCE.');
  for (const key of COLLECTIONS) {
    requireValue(Array.isArray(state[key]), 'CORRUPT_STORAGE', `Falta la colección ${key}.`);
  }
  requireValue(state.carts && typeof state.carts === 'object', 'CORRUPT_STORAGE', 'Faltan los carritos.');
  requireValue(state.requests && typeof state.requests === 'object', 'CORRUPT_STORAGE', 'Falta el registro de idempotencia.');
  return state;
}

// Migración desde el esquema 1 (demo previa, sólo comercios y pedidos).
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schemaVersion === SCHEMA_VERSION) return raw;
  return null;
}
