// Repositorio del entorno de demostración: ejecuta los comandos de dominio
// contra el almacenamiento del propio navegador.
//
// Es la demostración pública aislada. No hay servidor, no hay datos compartidos
// entre personas ni dispositivos, y no se emite ninguna operación real.
import { CauceError, clone, requireValue } from '../core/errors.js';
import { randomUuid } from '../core/identifiers.js';
import { actorFor } from '../core/accounts.js';
import { initialState, assertValidState, DEMO_IDENTITIES } from '../domain/state.js';
import { runCommand } from '../domain/commands.js';
import { runQuery } from '../domain/queries.js';

export const STORAGE_KEY = 'cauce:demo:database:v2';
export const SESSION_KEY = 'cauce:demo:session:v2';
export const GUEST_KEY = 'cauce:demo:guest:v2';

export function createLocalRepository({
  storage,
  locks = globalThis.navigator?.locks,
  uuid = randomUuid,
  clock = () => new Date().toISOString(),
  seed = initialState,
} = {}) {
  requireValue(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function',
    'STORAGE_UNAVAILABLE', 'El almacenamiento local no está disponible en este navegador.');

  let queue = Promise.resolve();

  const readRaw = key => {
    try { return storage.getItem(key); }
    catch { throw new CauceError('STORAGE_UNAVAILABLE', 'No se puede leer el almacenamiento de este navegador.'); }
  };
  const writeRaw = (key, value) => {
    try { storage.setItem(key, value); }
    catch { throw new CauceError('STORAGE_WRITE_FAILED', 'No se pudo guardar. Liberá espacio o habilitá el almacenamiento.'); }
  };

  const readState = () => {
    const raw = readRaw(STORAGE_KEY);
    if (raw === null) return seed();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new CauceError('CORRUPT_STORAGE', 'Los datos de demostración están dañados. Reinicialos desde Mi actividad.'); }
    return assertValidState(parsed);
  };
  const saveState = state => writeRaw(STORAGE_KEY, JSON.stringify(state));

  const guestId = () => {
    let id = readRaw(GUEST_KEY);
    if (!id) { id = `guest-${uuid()}`; writeRaw(GUEST_KEY, id); }
    return id;
  };

  const readSession = () => {
    const raw = readRaw(SESSION_KEY);
    if (!raw) return { accountId: null };
    try { return JSON.parse(raw); } catch { return { accountId: null }; }
  };
  const writeSession = value => writeRaw(SESSION_KEY, JSON.stringify(value));

  const contextFor = state => {
    const session = readSession();
    const guest = guestId();
    const actor = actorFor(state, session.accountId, { guestId: guest });
    return {
      actor,
      // El carrito y los pedidos de una visita sin cuenta pertenecen a esta identidad anónima.
      ownerId: actor.kind === 'account' ? actor.id : guest,
      now: clock,
      uuid,
      environment: 'demo',
      allowReset: true,
    };
  };

  const mutate = operation => {
    const run = () => {
      const state = readState();
      const result = operation(state);
      saveState(state);
      return result;
    };
    // Web Locks serializa las pestañas del mismo navegador; sin la API, se encola en memoria.
    if (locks?.request) return locks.request('cauce-demo-database-v2', { mode: 'exclusive' }, run);
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  };

  return Object.freeze({
    environment: 'demo',
    capabilities: Object.freeze({
      passwordAuth: false,
      sharedPersistence: false,
      demoIdentities: true,
      reset: true,
    }),

    async session() {
      const state = readState();
      const context = contextFor(state);
      return clone({ actor: context.actor, ownerId: context.ownerId });
    },

    async identities() {
      return DEMO_IDENTITIES.map(identity => ({
        id: identity.id, name: identity.name, label: identity.label,
        hint: identity.hint, roles: [...identity.roles],
      }));
    },

    // En la demostración no hay contraseñas: se elige explícitamente una identidad de ejemplo.
    async signInAsDemoIdentity(accountId) {
      const state = readState();
      const account = state.accounts.find(candidate => candidate.id === accountId);
      requireValue(Boolean(account), 'ACCOUNT_NOT_FOUND', 'Esa identidad de ejemplo no existe.');
      writeSession({ accountId: account.id });
      return clone(actorFor(state, account.id, { guestId: guestId() }));
    },

    async signIn() {
      throw new CauceError('PASSWORD_AUTH_UNAVAILABLE',
        'El entorno de demostración no usa contraseñas. Para probar sesiones autenticadas independientes, ejecutá el entorno local con backend.');
    },

    async signOut() {
      writeSession({ accountId: null });
      return true;
    },

    async register(payload) {
      const created = await mutate(state => {
        const context = contextFor(state);
        const account = runCommand(state, 'account.register', context, payload);
        return account;
      });
      writeSession({ accountId: created.id });
      return created;
    },

    async query(name, payload) {
      const state = readState();
      const context = contextFor(state);
      return clone(runQuery(state, name, context, payload));
    },

    async command(name, payload) {
      return mutate(state => {
        const context = contextFor(state);
        if (name === 'demo.reset') {
          const fresh = seed();
          for (const key of Object.keys(state)) delete state[key];
          Object.assign(state, fresh);
          writeSession({ accountId: null });
          return { reset: true };
        }
        return runCommand(state, name, context, payload);
      });
    },

    async reset() {
      return this.command('demo.reset');
    },
  });
}
