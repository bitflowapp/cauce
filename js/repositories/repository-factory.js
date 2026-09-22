import { CauceError } from '../core/errors.js';
import { createLocalRepository } from './local-repository.js';
import { createHttpRepository } from './http-repository.js';
import { createSupabaseRepository } from './supabase-repository.js';

// La compuerta de producción se mantiene: esta entrega no habilita pedidos ni
// pagos reales en ningún entorno. `mode: 'demo'` con `liveOrders`/`livePayments`
// en false es un requisito, no un interruptor que se pueda apagar para "que funcione".
export function assertNonProductionConfig(config) {
  if (config?.mode !== 'demo' || config?.liveOrders !== false || config?.livePayments !== false) {
    throw new CauceError('PRODUCTION_NOT_IMPLEMENTED',
      'Esta entrega no incluye una operación productiva verificada. No se habilitarán pedidos ni pagos reales.');
  }
}

/**
 * Selecciona el repositorio según el entorno resuelto en tiempo de compilación.
 * No hay detección automática ni degradación de backend a simulación: si el
 * entorno declara `local-backend`, se usa el backend y sus errores se propagan.
 */
export function createRepository(config, options = {}) {
  if (options.runtime?.environment === 'supabase') {
    // La compuerta que queda abierta es la de pedidos reales entre vecinos y
    // comercios. El cobro en línea sigue cerrado: se paga en mano, y ninguna
    // entrega puede encenderlo cambiando una bandera.
    if (config?.mode !== 'production' || config.liveOrders !== true || config.livePayments !== false) {
      throw new CauceError('INVALID_PRODUCTION_CONFIG', 'La configuración conectada de CAUCE no es válida.');
    }
    return createSupabaseRepository({ client: options.runtime.client, redirectTo: options.runtime.redirectTo,
      storage: options.storage });
  }
  assertNonProductionConfig(config);
  const runtime = options.runtime;
  if (!runtime || typeof runtime.environment !== 'string') {
    throw new CauceError('RUNTIME_ENV_MISSING', 'No se pudo determinar el entorno de ejecución.');
  }
  if (runtime.environment === 'local-backend') {
    return createHttpRepository({ apiBase: runtime.apiBase || '/api', fetchImpl: options.fetchImpl });
  }
  if (runtime.environment === 'demo') {
    return createLocalRepository(options);
  }
  throw new CauceError('UNKNOWN_ENVIRONMENT', `Entorno de ejecución desconocido: ${runtime.environment}.`);
}
