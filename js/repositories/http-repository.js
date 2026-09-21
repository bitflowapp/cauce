// Repositorio del entorno local con backend: la misma interfaz, pero las reglas
// se ejecutan en el servidor, dentro de una transacción y con la sesión real.
//
// No existe degradación silenciosa: si el servidor no responde o rechaza la
// operación, se propaga el error. Nunca se sustituyen datos simulados.
import { CauceError } from '../core/errors.js';

const OFFLINE_CODE = 'NETWORK_UNAVAILABLE';

export function createHttpRepository({ apiBase = '/api', fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new CauceError('FETCH_UNAVAILABLE', 'Este navegador no puede comunicarse con el backend local.');
  }

  async function call(path, body) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      throw new CauceError(OFFLINE_CODE,
        'No hay conexión con el servidor de CAUCE. La operación no se envió: revisá la conexión y reintentá.');
    }
    let payload = null;
    try { payload = await response.json(); }
    catch {
      throw new CauceError('INVALID_RESPONSE', 'El servidor respondió de forma inesperada.');
    }
    if (!response.ok || payload?.ok === false) {
      throw new CauceError(payload?.code || 'REQUEST_FAILED', payload?.message || 'No se pudo completar la operación.');
    }
    return payload.data;
  }

  return Object.freeze({
    environment: 'local-backend',
    capabilities: Object.freeze({
      passwordAuth: true,
      sharedPersistence: true,
      demoIdentities: false,
      reset: false,
    }),

    async session() { return call('/session'); },
    async identities() { return []; },
    async signIn(credentials) { return call('/sign-in', credentials); },
    async signInAsDemoIdentity() {
      throw new CauceError('DEMO_IDENTITIES_UNAVAILABLE',
        'Este entorno usa cuentas reales con contraseña. Iniciá sesión con tu correo.');
    },
    async signOut() { return call('/sign-out'); },
    async register(payload) { return call('/register', payload); },
    async query(name, payload) { return call('/query', { name, payload }); },
    async command(name, payload) { return call('/command', { name, payload }); },
    async reset() {
      throw new CauceError('RESET_FORBIDDEN', 'El entorno con backend no se reinicia desde la aplicación.');
    },
  });
}

export function isNetworkError(error) {
  return error?.code === OFFLINE_CODE;
}
