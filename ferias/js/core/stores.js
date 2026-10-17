// Lo que vive sólo en este dispositivo: carritos (hasta confirmar el pedido),
// favoritos y la localidad elegida. Nada de esto es un dato de negocio: los
// pedidos, el stock y los precios viven en la base. Toda lectura y escritura
// tolera un almacenamiento bloqueado (modo privado): se sigue en memoria.
import { MAX_QUANTITY, MAX_LINES } from './cart.js';

const memory = new Map();
function safeStorage(storage) {
  return {
    get(key) { try { return storage?.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } },
    set(key, value) { try { storage?.setItem(key, value); } catch { /* sin almacenamiento */ } memory.set(key, value); },
    remove(key) { try { storage?.removeItem(key); } catch { /* sin almacenamiento */ } memory.delete(key); },
    keys() { try { return storage ? Object.keys(storage) : [...memory.keys()]; } catch { return [...memory.keys()]; } },
  };
}

const CART = 'ferias:cart:v1';
const DEVICE = 'ferias:device:v1';
const FAVORITES = 'ferias:favorites:v1';
const LOCALITY = 'ferias:locality:v1';

export function createStores(storage = globalThis.localStorage) {
  const store = safeStorage(storage);
  let owner = null;

  const deviceId = () => {
    let id = store.get(DEVICE);
    if (!id) { id = `device-${crypto.randomUUID()}`; store.set(DEVICE, id); }
    return id;
  };
  const cartOwner = () => owner || deviceId();
  const key = businessId => `${CART}:${cartOwner()}:${businessId}`;

  function readCart(businessId) {
    let parsed;
    try { parsed = JSON.parse(store.get(key(businessId)) || 'null'); } catch { parsed = null; }
    const lines = Array.isArray(parsed?.lines) ? parsed.lines
      .filter(line => typeof line?.productId === 'string' && Number.isSafeInteger(line.quantity) && line.quantity > 0 && line.quantity <= MAX_QUANTITY)
      .slice(0, MAX_LINES).map(line => ({ productId: line.productId, variantId: line.variantId || null, quantity: line.quantity })) : [];
    return { businessId, lines, requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : undefined };
  }
  function writeCart(cart) {
    if (!cart.lines.length) store.remove(key(cart.businessId));
    else store.set(key(cart.businessId), JSON.stringify({ ...cart, savedAt: new Date().toISOString() }));
    listeners.forEach(fn => fn());
    return cart;
  }
  function allCarts() {
    const prefix = `${CART}:${cartOwner()}:`;
    return store.keys().filter(k => k.startsWith(prefix)).map(k => readCart(k.slice(prefix.length))).filter(c => c.lines.length);
  }
  const listeners = new Set();

  let favorites = null;
  function favoriteSet() {
    if (!favorites) {
      try { favorites = new Set(JSON.parse(store.get(FAVORITES) || '[]').filter(id => typeof id === 'string').slice(0, 300)); }
      catch { favorites = new Set(); }
    }
    return favorites;
  }

  return {
    /** Al ingresar con una cuenta, los carritos del dispositivo pasan a esa cuenta. */
    setOwner(userId) {
      const previous = cartOwner();
      owner = userId || null;
      if (userId && previous !== userId && previous.startsWith('device-')) {
        const from = `${CART}:${previous}:`;
        for (const k of store.keys().filter(name => name.startsWith(from))) {
          const target = `${CART}:${userId}:${k.slice(from.length)}`;
          if (!store.get(target)) store.set(target, store.get(k));
          store.remove(k);
        }
      }
      listeners.forEach(fn => fn());
    },
    readCart, writeCart, allCarts,
    cartCount: () => allCarts().reduce((sum, cart) => sum + cart.lines.reduce((s, l) => s + l.quantity, 0), 0),
    onCartChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    favorites: favoriteSet,
    toggleFavorite(id) {
      const set = favoriteSet();
      if (set.has(id)) set.delete(id); else set.add(id);
      store.set(FAVORITES, JSON.stringify([...set]));
      return set.has(id);
    },
    // '' = todas las localidades (se guarda como 'todas').
    locality: () => { const value = store.get(LOCALITY); return value === 'todas' ? '' : value || 'neuquen'; },
    setLocality(slug) { store.set(LOCALITY, slug || 'todas'); },
  };
}
