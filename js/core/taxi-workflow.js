import { requireValue } from './errors.js';

export const TAXI_STATUSES = Object.freeze([
  'requested',
  'searching',
  'accepted',
  'driver_on_way',
  'driver_arrived',
  'passenger_on_board',
  'in_trip',
  'completed',
  'canceled',
  'expired',
  'no_availability',
]);

export const TAXI_STATUS_LABELS = Object.freeze({
  requested: 'Solicitud creada',
  searching: 'Buscando taxi disponible',
  accepted: 'Taxi asignado',
  driver_on_way: 'Chofer en camino',
  driver_arrived: 'Chofer en el origen',
  passenger_on_board: 'Pasajero a bordo',
  in_trip: 'Viaje en curso',
  completed: 'Viaje finalizado',
  canceled: 'Viaje cancelado',
  expired: 'Solicitud vencida',
  no_availability: 'Sin taxis disponibles',
});

export const TAXI_STATUS_DESCRIPTIONS = Object.freeze({
  requested: 'Tu solicitud de viaje fue registrada en el prototipo local.',
  searching: 'Buscando móvil de demostración en Aluminé.',
  accepted: 'Un chofer de prueba aceptó tu viaje de demostración.',
  driver_on_way: 'El móvil se desplaza en el recorrido esquemático hacia tu punto de encuentro.',
  driver_arrived: 'El taxi está esperando en la puerta o punto de subida.',
  passenger_on_board: 'Pasajero a bordo del vehículo.',
  in_trip: 'En viaje directo hacia el destino indicado.',
  completed: 'Llegaron a destino. Cobro coordinado con el chofer.',
  canceled: 'El viaje fue cancelado.',
  expired: 'Ningún conductor respondió dentro del plazo de la solicitud.',
  no_availability: 'No hay conductores disponibles en este momento.',
});

const ALLOWED_TRANSITIONS = Object.freeze({
  requested: Object.freeze(['searching', 'accepted', 'canceled', 'expired', 'no_availability']),
  searching: Object.freeze(['accepted', 'canceled', 'expired', 'no_availability']),
  accepted: Object.freeze(['driver_on_way', 'canceled']),
  driver_on_way: Object.freeze(['driver_arrived', 'canceled']),
  driver_arrived: Object.freeze(['passenger_on_board', 'canceled']),
  passenger_on_board: Object.freeze(['in_trip', 'canceled']),
  in_trip: Object.freeze(['completed']),
  completed: Object.freeze([]),
  canceled: Object.freeze([]),
  expired: Object.freeze([]),
  no_availability: Object.freeze([]),
});

export function canTransitionTaxi(fromStatus, toStatus) {
  if (!ALLOWED_TRANSITIONS[fromStatus]) return false;
  return ALLOWED_TRANSITIONS[fromStatus].includes(toStatus);
}

export function validateTaxiTransition(fromStatus, toStatus) {
  requireValue(
    TAXI_STATUSES.includes(fromStatus),
    'INVALID_STATUS',
    `Estado de taxi de origen desconocido: "${fromStatus}".`
  );
  requireValue(
    TAXI_STATUSES.includes(toStatus),
    'INVALID_STATUS',
    `Estado de taxi de destino desconocido: "${toStatus}".`
  );
  if (fromStatus === toStatus) return true;
  requireValue(
    canTransitionTaxi(fromStatus, toStatus),
    'INVALID_TRANSITION',
    `Transición de viaje no permitida: de "${TAXI_STATUS_LABELS[fromStatus] || fromStatus}" a "${TAXI_STATUS_LABELS[toStatus] || toStatus}".`
  );
  return true;
}

export function isTaxiCancelable(status) {
  return [
    'requested',
    'searching',
    'accepted',
    'driver_on_way',
    'driver_arrived',
    'passenger_on_board',
  ].includes(status);
}

export const TERMINAL_TAXI_STATUSES = Object.freeze(['completed', 'canceled', 'expired', 'no_availability']);

export function isTaxiActive(status) {
  return !TERMINAL_TAXI_STATUSES.includes(status);
}

// Estados en los que la solicitud sigue abierta para que un conductor responda.
export function isTaxiOpenForOffers(status) {
  return status === 'requested' || status === 'searching';
}

// Un conductor no puede tomar otro viaje mientras tenga uno en curso.
export function isTaxiEngagingForDriver(status) {
  return ['accepted', 'driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip'].includes(status);
}

export function getDriverNextAction(status) {
  switch (status) {
    case 'requested':
    case 'searching':
      return {
        action: 'accept',
        label: 'Aceptar viaje',
        nextStatus: 'accepted',
        description: 'Asignar el viaje a tu móvil',
      };
    case 'accepted':
      return {
        action: 'start_to_passenger',
        label: 'Voy hacia pasajero',
        nextStatus: 'driver_on_way',
        description: 'Iniciar recorrido al punto de encuentro',
      };
    case 'driver_on_way':
      return {
        action: 'confirm_arrived',
        label: 'Llegué al origen',
        nextStatus: 'driver_arrived',
        description: 'Avisar al pasajero que estás esperando',
      };
    case 'driver_arrived':
      return {
        action: 'passenger_boarded',
        label: 'Pasajero a bordo',
        nextStatus: 'passenger_on_board',
        description: 'Confirmar que el pasajero subió al móvil',
      };
    case 'passenger_on_board':
      return {
        action: 'start_trip',
        label: 'Iniciar viaje a destino',
        nextStatus: 'in_trip',
        description: 'Comenzar el traslado hacia el destino',
      };
    case 'in_trip':
      return {
        action: 'complete_trip',
        label: 'Finalizar viaje',
        nextStatus: 'completed',
        description: 'Completar el servicio y cerrar el viaje',
      };
    default:
      return null;
  }
}

export function getPassengerTimelineIndex(status) {
  switch (status) {
    case 'requested':
    case 'searching':
      return 0;
    case 'accepted':
      return 1;
    case 'driver_on_way':
    case 'driver_arrived':
      return 2;
    case 'passenger_on_board':
    case 'in_trip':
      return 3;
    case 'completed':
      return 4;
    default:
      return -1;
  }
}
