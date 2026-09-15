import { CauceError } from '../core/errors.js';
import { createDemoRepository } from './demo-repository.js';
export function createRepository(config, options) {
  if (config?.mode !== 'demo' || config?.liveOrders !== false || config?.livePayments !== false) {
    throw new CauceError('PRODUCTION_NOT_IMPLEMENTED', 'Esta entrega no incluye un backend productivo verificado. No se habilitarán pedidos ni pagos reales.');
  }
  return createDemoRepository(options);
}
