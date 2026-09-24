// Entorno de ejecución de CAUCE, resuelto en tiempo de compilación.
//
// Este archivo, tal como está versionado, describe el ENTORNO DE DEMOSTRACIÓN:
// el que se publica en GitHub Pages. Guarda todo en el navegador de cada persona,
// no tiene backend y no comparte datos entre dispositivos.
//
// El servidor local de pruebas (`npm run dev`) sirve en su lugar una versión
// generada de este mismo módulo que declara `local-backend`. No hay detección
// automática ni degradación silenciosa: si el entorno dice `local-backend` y la
// API no responde, la aplicación falla de forma visible en vez de simular.
/**
 * @typedef {object} RuntimeEnv
 * @property {string} environment
 * @property {string|null} [apiBase]
 * @property {string} label
 * @property {string} description
 * @property {boolean} sharedPersistence
 * @property {boolean} passwordAuth
 * @property {string} [release]
 * @property {any} [client]
 * @property {string} [redirectTo]
 * @property {string} [siteUrl]
 * @property {string} [supabaseUrl]
 */
/** @type {Readonly<RuntimeEnv>} */
export const RUNTIME_ENV = Object.freeze({
  environment: 'demo',
  apiBase: null,
  label: 'Entorno de demostración',
  description: 'Datos de ejemplo guardados sólo en este navegador. No hay servidor ni operaciones reales.',
  sharedPersistence: false,
  passwordAuth: false,
});
