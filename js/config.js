/**
 * Configuración de CAUCE · Aluminé.
 *
 * `mode: 'demo'` con `liveOrders` y `livePayments` en false es una compuerta,
 * no un interruptor de conveniencia: ninguna entrega habilita pedidos ni pagos
 * reales mientras no exista una operación productiva verificada.
 * El entorno de ejecución (demostración o backend local) se declara aparte, en
 * js/runtime-env.js.
 */
export const CONFIG = Object.freeze({
  name: 'CAUCE',
  edition: 'Aluminé',
  mode: 'demo',
  liveOrders: false,
  livePayments: false,
  defaultLocality: 'alumine',
  currency: 'ARS',
  locale: 'es-AR',
});
