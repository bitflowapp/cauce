// Favoritos de MiFav.
//
// Se guardan en el navegador para que una persona pueda comparar y volver a
// encontrar artículos sin crear una cuenta. No son datos privados del vendedor
// ni reemplazan una lista del servidor: son una preferencia local. El día que
// exista la cuenta con favoritos sincronizados, esta interfaz se conserva y se
// reemplaza sólo el almacenamiento.
import { requireValue } from './errors.js';

export const FAVORITES_KEY = 'mifav:favorites:v1';
export const MAX_FAVORITES = 200;

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export function favoriteKey(businessId, productId) {
  const business = String(businessId || '');
  const product = String(productId || '');
  requireValue(ID.test(business) && ID.test(product), 'INVALID_FAVORITE', 'Favorito inválido.');
  return `${business}/${product}`;
}

export function parseFavoriteKey(value) {
  const [businessId, productId, ...rest] = String(value || '').split('/');
  if (rest.length || !businessId || !productId || !ID.test(businessId) || !ID.test(productId)) return null;
  return { businessId, productId };
}

export function normalizeFavorites(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const output = [];
  for (const value of input) {
    const key = typeof value === 'string' ? value : '';
    const parsed = parseFavoriteKey(key);
    if (!parsed || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
    if (output.length >= MAX_FAVORITES) break;
  }
  return output;
}

export function readFavorites(storage, key = FAVORITES_KEY) {
  if (!storage || typeof storage.getItem !== 'function') return [];
  try {
    return normalizeFavorites(JSON.parse(storage.getItem(key) || '[]'));
  } catch {
    return [];
  }
}

export function writeFavorites(storage, values, key = FAVORITES_KEY) {
  const clean = normalizeFavorites(values);
  if (storage && typeof storage.setItem === 'function') {
    try { storage.setItem(key, JSON.stringify(clean)); } catch { /* cuota llena: se conserva la lista en memoria */ }
  }
  return clean;
}

export function hasFavorite(storage, businessId, productId, key = FAVORITES_KEY) {
  let favorite;
  try { favorite = favoriteKey(businessId, productId); } catch { return false; }
  return readFavorites(storage, key).includes(favorite);
}

export function toggleFavorite(storage, businessId, productId, key = FAVORITES_KEY) {
  const favorite = favoriteKey(businessId, productId);
  const current = readFavorites(storage, key);
  const exists = current.includes(favorite);
  const next = exists
    ? current.filter(value => value !== favorite)
    : normalizeFavorites([...current, favorite]);
  writeFavorites(storage, next, key);
  return { favorite, active: !exists, favorites: next };
}
