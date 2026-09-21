// Reglas de despacho de taxis para el piloto: asignación simple, explícita y configurable.
// No hay ruteo, ni estimación de distancia, ni posición GPS de los móviles.
import { requireValue } from './errors.js';
import { sanitizeText, validateCustomerName, isValidArgentinePhone } from './validators.js';
import { isTaxiOpenForOffers, isTaxiEngagingForDriver } from './taxi-workflow.js';

export const DISPATCH_POLICY = Object.freeze({
  // Modo de asignación del piloto: la solicitud se ofrece a todos los conductores
  // disponibles y aprobados, y la toma el primero que responde.
  mode: 'open_to_available_drivers',
  // Plazo de vigencia de una solicitud sin respuesta.
  requestTtlMinutes: 10,
  // Cantidad máxima de pasajeros por solicitud.
  maxPassengers: 4,
  // Un pasajero no puede tener más de una solicitud abierta a la vez.
  maxOpenRequestsPerPassenger: 1,
});

export const DRIVER_STATUSES = Object.freeze(['draft', 'pending_review', 'returned', 'active', 'paused']);

export const DRIVER_STATUS_LABELS = Object.freeze({
  draft: 'Borrador',
  pending_review: 'Pendiente de revisión',
  returned: 'Devuelto con observaciones',
  active: 'Habilitado en la demostración',
  paused: 'Pausado',
});

export function isDriverEligible(driver) {
  return driver?.status === 'active';
}

export function isDriverReceivingRequests(driver) {
  return isDriverEligible(driver) && driver?.available === true;
}

export function expiresAt(createdAt, minutes = DISPATCH_POLICY.requestTtlMinutes) {
  return new Date(new Date(createdAt).getTime() + minutes * 60000).toISOString();
}

export function isExpired(trip, now) {
  if (!trip?.expiresAt || !isTaxiOpenForOffers(trip.status)) return false;
  return new Date(now).getTime() >= new Date(trip.expiresAt).getTime();
}

export function validateTripRequest(input) {
  const origin = sanitizeText(input?.origin, { fallback: '', maxLength: 120 });
  requireValue(origin.length >= 3, 'INVALID_ORIGIN', 'Ingresá una dirección o lugar de origen en Aluminé.');
  const destination = sanitizeText(input?.destination, { fallback: '', maxLength: 120 });
  requireValue(destination.length >= 3, 'INVALID_DESTINATION', 'Ingresá una dirección o lugar de destino en Aluminé.');

  const nameCheck = validateCustomerName(input?.passengerName);
  requireValue(nameCheck.ok, 'INVALID_NAME', nameCheck.message || 'Ingresá un nombre de pasajero válido.');

  const phone = sanitizeText(input?.passengerPhone, { fallback: '', maxLength: 24 });
  requireValue(isValidArgentinePhone(phone), 'INVALID_PHONE',
    'Ingresá un teléfono de contacto válido (por ejemplo 2942 000000).');

  const passengers = Number(input?.passengers ?? 1);
  requireValue(Number.isSafeInteger(passengers) && passengers >= 1 && passengers <= DISPATCH_POLICY.maxPassengers,
    'INVALID_PASSENGERS', `La cantidad de pasajeros debe estar entre 1 y ${DISPATCH_POLICY.maxPassengers}.`);

  return {
    origin,
    destination,
    originNote: sanitizeText(input?.originNote, { fallback: '', maxLength: 120 }),
    passengers,
    passenger: { name: nameCheck.name, phone },
  };
}

// Lo que ve un conductor de una solicitud todavía no aceptada: sin teléfono ni nombre completo.
export function offerView(trip) {
  return {
    id: trip.id,
    status: trip.status,
    origin: trip.origin,
    originNote: trip.originNote,
    destination: trip.destination,
    passengers: trip.passengers,
    passengerInitial: (trip.passenger?.name || '?').trim().charAt(0).toUpperCase(),
    createdAt: trip.createdAt,
    expiresAt: trip.expiresAt,
  };
}

// Una vez aceptado, el conductor asignado sí necesita el contacto del pasajero.
export function assignedTripView(trip) {
  return { ...trip, passenger: { ...trip.passenger } };
}

// Lo que ve el pasajero del conductor asignado: identificación del móvil, no datos personales de más.
export function driverPublicView(driver) {
  if (!driver) return null;
  return {
    id: driver.id,
    displayName: driver.displayName,
    mobileNumber: driver.mobileNumber,
    vehicle: driver.vehicle,
    plate: driver.plate,
    phone: driver.phone,
  };
}

export function assertDriverCanAccept(driver, trip, activeTrips) {
  requireValue(isDriverEligible(driver), 'DRIVER_NOT_ELIGIBLE',
    'Tu alta de conductor todavía no fue aprobada por administración.');
  requireValue(driver.available === true, 'DRIVER_UNAVAILABLE',
    'Marcate como disponible para aceptar solicitudes.');
  requireValue(isTaxiOpenForOffers(trip?.status), 'TRIP_NOT_AVAILABLE',
    'La solicitud ya no está disponible.');
  const busy = activeTrips.find(other => other.driverId === driver.id && isTaxiEngagingForDriver(other.status));
  requireValue(!busy, 'DRIVER_BUSY',
    'Ya tenés un viaje en curso. Finalizalo antes de aceptar otro.');
}
