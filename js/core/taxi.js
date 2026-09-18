import { CauceError, requireValue, clone } from './errors.js';
import { randomUuid } from './identifiers.js';
import { validateCustomerName, isValidArgentinePhone, sanitizeText } from './validators.js';
import {
  TAXI_STATUSES,
  TAXI_STATUS_LABELS,
  validateTaxiTransition,
  isTaxiCancelable,
  isTaxiActive,
  getDriverNextAction,
} from './taxi-workflow.js';

export const TAXI_STORAGE_KEY = 'cauce:demo:taxi:v1';

export const DEFAULT_TAXI_DRIVER = Object.freeze({
  id: 'driver-04',
  name: 'Carlos Morales',
  mobileNumber: 'Móvil 04',
  vehicle: 'Chevrolet Classic blanco',
  plate: 'AA 842 CD',
  phone: '2942-551234',
  rating: '4.9',
  completedTrips: 18,
});

export const ALUMINE_TAXI_LOCATIONS = Object.freeze([
  { id: 'plaza', name: 'Plaza San Martín (Centro)', address: 'San Martín y Torcuato Modarelli' },
  { id: 'hospital', name: 'Hospital de Aluminé', address: 'Av. 4 de Febrero 420' },
  { id: 'terminal', name: 'Terminal de Ómnibus', address: 'Ruta Provincial 23' },
  { id: 'costanera', name: 'Costanera Río Aluminé', address: 'Paseo de la Costanera' },
  { id: 'puente', name: 'Acceso Puente Aluminé', address: 'Ruta 23 y Río Aluminé' },
  { id: 'artesanos', name: 'Paseo de los Artesanos', address: 'Av. 4 de Febrero s/n' },
  { id: 'pampa', name: 'Barrio La Pampa', address: 'Calle Los Pehuenes 250' },
  { id: 'polideportivo', name: 'Polideportivo Municipal', address: 'Av. Cristian Joubert' },
]);

export function estimateTaxiFare(origin, destination) {
  const cleanOrigin = String(origin || '').trim().toLowerCase();
  const cleanDest = String(destination || '').trim().toLowerCase();

  let distanceKm = 2.4;
  let durationMin = 7;
  let baseFare = 2200;

  if (cleanOrigin.includes('terminal') || cleanDest.includes('terminal')) {
    distanceKm = 3.2;
    durationMin = 10;
  } else if (cleanOrigin.includes('pampa') || cleanDest.includes('pampa')) {
    distanceKm = 4.1;
    durationMin = 12;
  } else if (cleanOrigin.includes('costanera') || cleanDest.includes('costanera')) {
    distanceKm = 1.8;
    durationMin = 6;
  } else if (cleanOrigin.includes('hospital') || cleanDest.includes('hospital')) {
    distanceKm = 2.1;
    durationMin = 7;
  }

  const estimatedFare = Math.round((baseFare + distanceKm * 550) / 100) * 100;
  const fareMin = Math.round((estimatedFare * 0.9) / 100) * 100;
  const fareMax = Math.round((estimatedFare * 1.15) / 100) * 100;

  return {
    fareEstimated: estimatedFare,
    fareMin,
    fareMax,
    distanceKm: `${distanceKm.toFixed(1).replace('.', ',')} km`,
    durationMin: `${durationMin} min`,
    pickupEta: '3–6 min',
  };
}

function initialTaxiState() {
  return {
    schemaVersion: 1,
    activeTripId: null,
    trips: [],
    driver: { ...DEFAULT_TAXI_DRIVER },
  };
}

function resolveStorage(customStorage) {
  if (customStorage && typeof customStorage.getItem === 'function') {
    return customStorage;
  }
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    return globalThis.localStorage;
  }
  return null;
}

export function getTaxiState(customStorage) {
  const storage = resolveStorage(customStorage);
  if (!storage) return initialTaxiState();

  let raw = null;
  try {
    raw = storage.getItem(TAXI_STORAGE_KEY);
  } catch {
    return initialTaxiState();
  }

  if (!raw) return initialTaxiState();

  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.trips)) {
      return parsed;
    }
    return initialTaxiState();
  } catch {
    return initialTaxiState();
  }
}

export function saveTaxiState(state, customStorage) {
  const storage = resolveStorage(customStorage);
  if (!storage) return;
  try {
    storage.setItem(TAXI_STORAGE_KEY, JSON.stringify(state));
  } catch {
    throw new CauceError(
      'STORAGE_WRITE_FAILED',
      'No se pudo guardar el estado de taxi en el almacenamiento local.'
    );
  }
}

export function createTaxiTrip(
  {
    origin,
    destination,
    originNote = '',
    passengerName,
    passengerPhone,
  },
  {
    storage = null,
    clock = () => new Date().toISOString(),
    uuid = randomUuid,
  } = {}
) {
  const state = getTaxiState(storage);

  // Si ya hay un viaje activo, no duplicar
  if (state.activeTripId) {
    const activeTrip = state.trips.find(t => t.id === state.activeTripId);
    if (activeTrip && isTaxiActive(activeTrip.status)) {
      throw new CauceError(
        'ACTIVE_TRIP_EXISTS',
        'Ya tenés un viaje en curso en Aluminé. Podés seguirlo desde la pantalla de seguimiento.'
      );
    }
  }

  const cleanOrigin = sanitizeText(origin, 120);
  const cleanDest = sanitizeText(destination, 120);
  requireValue(
    cleanOrigin.length >= 3,
    'INVALID_ORIGIN',
    'Ingresá una dirección o lugar de origen válido en Aluminé.'
  );
  requireValue(
    cleanDest.length >= 3,
    'INVALID_DESTINATION',
    'Ingresá una dirección o lugar de destino válido en Aluminé.'
  );

  const cleanName = sanitizeText(passengerName, 80);
  const nameCheck = validateCustomerName(cleanName);
  requireValue(
    nameCheck.ok,
    'INVALID_NAME',
    nameCheck.message || 'Ingresá un nombre de pasajero válido.'
  );

  const cleanPhone = String(passengerPhone || '').trim();
  requireValue(
    isValidArgentinePhone(cleanPhone),
    'INVALID_PHONE',
    'Ingresá un número de teléfono de contacto válido (ej: 2942 551234).'
  );

  const estimate = estimateTaxiFare(cleanOrigin, cleanDest);
  const now = clock();
  const tripId = `taxi-${uuid()}`;

  const newTrip = {
    id: tripId,
    status: 'requested',
    localityId: 'alumine',
    origin: cleanOrigin,
    originNote: sanitizeText(originNote, 120),
    destination: cleanDest,
    passenger: {
      name: cleanName,
      phone: cleanPhone,
    },
    driver: { ...DEFAULT_TAXI_DRIVER },
    estimate,
    paymentMethod: 'cash_demo',
    paymentLabel: 'Efectivo demo / Transferencia al chofer',
    createdAt: now,
    updatedAt: now,
    history: [
      {
        status: 'requested',
        timestamp: now,
        actor: 'passenger',
        note: 'Solicitud enviada desde CAUCE · Aluminé',
      },
    ],
  };

  state.trips.unshift(newTrip);
  state.activeTripId = tripId;
  saveTaxiState(state, storage);

  return clone(newTrip);
}

export function getActiveTaxiTrip(storage = null) {
  const state = getTaxiState(storage);
  if (!state.activeTripId) return null;
  const trip = state.trips.find(t => t.id === state.activeTripId);
  return trip ? clone(trip) : null;
}

export function getTaxiTripById(tripId, storage = null) {
  const state = getTaxiState(storage);
  const trip = state.trips.find(t => t.id === tripId);
  return trip ? clone(trip) : null;
}

export function listTaxiTrips(storage = null) {
  const state = getTaxiState(storage);
  return clone(state.trips);
}

export function advanceTaxiTrip(
  tripId,
  {
    nextStatus = null,
    actor = 'driver',
    note = '',
    storage = null,
    clock = () => new Date().toISOString(),
  } = {}
) {
  const state = getTaxiState(storage);
  const trip = state.trips.find(t => t.id === tripId);
  requireValue(Boolean(trip), 'TRIP_NOT_FOUND', 'No se encontró el viaje solicitado.');

  let targetStatus = nextStatus;
  if (!targetStatus) {
    const nextAction = getDriverNextAction(trip.status);
    requireValue(
      Boolean(nextAction),
      'NO_FURTHER_ACTIONS',
      'El viaje ya no tiene acciones operativas pendientes.'
    );
    targetStatus = nextAction.nextStatus;
  }

  validateTaxiTransition(trip.status, targetStatus);

  const now = clock();
  trip.status = targetStatus;
  trip.updatedAt = now;
  trip.history.push({
    status: targetStatus,
    timestamp: now,
    actor,
    note: note || TAXI_STATUS_LABELS[targetStatus] || targetStatus,
  });

  if (targetStatus === 'completed') {
    // Viaje completado: ya no está activo
    if (state.activeTripId === tripId) {
      state.activeTripId = null;
    }
  }

  saveTaxiState(state, storage);
  return clone(trip);
}

export function cancelTaxiTrip(
  tripId,
  {
    reason = 'Cancelado por el usuario',
    actor = 'passenger',
    storage = null,
    clock = () => new Date().toISOString(),
  } = {}
) {
  const state = getTaxiState(storage);
  const trip = state.trips.find(t => t.id === tripId);
  requireValue(Boolean(trip), 'TRIP_NOT_FOUND', 'No se encontró el viaje.');

  requireValue(
    isTaxiCancelable(trip.status),
    'CANNOT_CANCEL',
    'El viaje ya está en curso o finalizado y no puede cancelarse.'
  );

  validateTaxiTransition(trip.status, 'canceled');

  const now = clock();
  trip.status = 'canceled';
  trip.updatedAt = now;
  trip.history.push({
    status: 'canceled',
    timestamp: now,
    actor,
    note: reason,
  });

  if (state.activeTripId === tripId) {
    state.activeTripId = null;
  }

  saveTaxiState(state, storage);
  return clone(trip);
}

export function resetTaxiState(storage = null) {
  const s = resolveStorage(storage);
  if (s) {
    try {
      s.removeItem(TAXI_STORAGE_KEY);
    } catch (_) {}
  }
}
