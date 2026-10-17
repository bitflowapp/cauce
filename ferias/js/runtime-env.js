// Entorno de ejecución: se reemplaza al compilar (scripts/build.mjs) por uno
// que crea el cliente de Supabase con la URL y la publishable key del entorno
// elegido. Sin compilar no hay backend: la app muestra cómo levantarlo, nunca
// datos simulados.
/**
 * @typedef {object} RuntimeEnv
 * @property {string} environment
 * @property {string} release
 * @property {string} siteUrl
 * @property {string} redirectTo
 * @property {any} client
 */
/** @type {Readonly<RuntimeEnv>} */
export const RUNTIME_ENV = Object.freeze({
  environment: 'sin-compilar',
  release: 'dev',
  siteUrl: '',
  redirectTo: '',
  client: null,
});
