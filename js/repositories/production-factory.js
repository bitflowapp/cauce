import { CauceError } from '../core/errors.js';
import { createSupabaseRepository } from './supabase-repository.js';

// Fábrica del build de producción: sólo existe el repositorio conectado. Ni la
// demostración, ni sus datos, ni el backend de desarrollo entran en el bundle.
export function createRepository(config, options = {}) {
  if (options.runtime?.environment !== 'supabase' || config?.mode !== 'production'
    || config.liveOrders !== true || config.livePayments !== false) {
    throw new CauceError('INVALID_PRODUCTION_CONFIG', 'La configuración de CAUCE no es válida.');
  }
  return createSupabaseRepository({ client: options.runtime.client, redirectTo: options.runtime.redirectTo,
    storage: options.storage, onError: options.onError });
}
