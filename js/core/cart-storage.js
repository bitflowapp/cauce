// Portado y adaptado de js/core/production-cart-storage.js de La Taba.
// Persistencia deliberadamente mínima, sanitizada, con expiración (72h) y fusión multi-pestaña
// particionada por localidad y comercio (localityId / businessId).

export const CART_SCHEMA_VERSION = 2;
export const CART_MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72 horas

const MAX_LINES = 100;
const MAX_QUANTITY_PER_LINE = 99;
const SAFE_ID = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;

export function buildScopedCartKey(localityId, businessId) {
  const loc = String(localityId || '').trim();
  const biz = String(businessId || '').trim();
  return `cauce:cart:v2:${loc}:${biz}`;
}

export function sanitizeCartSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schemaVersion: CART_SCHEMA_VERSION,
    businessId: String(source.businessId || '').trim(),
    localityId: String(source.localityId || '').trim(),
    lines: sanitizeLines(source.lines, 'productId'),
  };
}

export function mergeCartMutation(baseValue, localValue, remoteValue) {
  const base = sanitizeCartSnapshot(baseValue);
  const local = sanitizeCartSnapshot(localValue);
  const remote = sanitizeCartSnapshot(remoteValue);
  return {
    schemaVersion: CART_SCHEMA_VERSION,
    businessId: local.businessId || remote.businessId || base.businessId,
    localityId: local.localityId || remote.localityId || base.localityId,
    lines: mergeLineMutation(base.lines, local.lines, remote.lines, 'productId'),
  };
}

export function readScopedCart(storage, localityId, businessId, { now = Date.now() } = {}) {
  const key = buildScopedCartKey(localityId, businessId);
  let raw = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch (_) {
    return sanitizeCartSnapshot({ localityId, businessId, lines: [] });
  }

  if (!raw) return sanitizeCartSnapshot({ localityId, businessId, lines: [] });

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = null;
  }

  if (!parsed
    || Number(parsed.schemaVersion) !== CART_SCHEMA_VERSION
    || isExpired(parsed.savedAt, now)) {
    try { storage?.removeItem(key); } catch (_) {}
    return sanitizeCartSnapshot({ localityId, businessId, lines: [] });
  }

  const snapshot = sanitizeCartSnapshot(parsed);
  if (!snapshot.lines.length) {
    try { storage?.removeItem(key); } catch (_) {}
  }
  return snapshot;
}

export function writeScopedCart(storage, localityId, businessId, value, { now = Date.now() } = {}) {
  const key = buildScopedCartKey(localityId, businessId);
  const snapshot = sanitizeCartSnapshot({ ...value, localityId, businessId });
  if (!snapshot.lines.length) {
    try { storage?.removeItem(key); } catch (_) {}
    return true;
  }
  const payload = JSON.stringify({
    ...snapshot,
    savedAt: new Date(keptTimestamp(storage, key, snapshot, now)).toISOString(),
  });
  try {
    storage?.setItem(key, payload);
    return true;
  } catch (_) {
    return false;
  }
}

function keptTimestamp(storage, key, snapshot, now) {
  let previous = null;
  try {
    const raw = storage?.getItem(key);
    if (raw) previous = JSON.parse(raw);
  } catch (_) {}
  if (!previous || Number(previous.schemaVersion) !== CART_SCHEMA_VERSION) return now;
  const previousAt = Date.parse(String(previous.savedAt || ''));
  if (!Number.isFinite(previousAt) || isExpired(previous.savedAt, now)) return now;
  const unchanged = JSON.stringify(sanitizeCartSnapshot(previous).lines) === JSON.stringify(snapshot.lines);
  return unchanged ? previousAt : now;
}

function isExpired(savedAt, now) {
  const timestamp = Date.parse(String(savedAt || ''));
  if (!Number.isFinite(timestamp)) return true;
  return Math.abs(now - timestamp) > CART_MAX_AGE_MS;
}

function sanitizeLines(lines, idField) {
  if (!Array.isArray(lines)) return [];
  const quantities = new Map();

  for (const line of lines.slice(0, MAX_LINES * 2)) {
    const id = String(line?.[idField] || '').trim();
    if (!SAFE_ID.test(id)) continue;
    const quantity = Math.floor(Number(line?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const current = quantities.get(id) || 0;
    quantities.set(id, Math.min(MAX_QUANTITY_PER_LINE, current + quantity));
    if (quantities.size >= MAX_LINES) break;
  }

  return [...quantities.entries()].map(([id, quantity]) => ({ [idField]: id, quantity }));
}

function mergeLineMutation(baseLines, localLines, remoteLines, idField) {
  const quantities = (lines) => new Map(lines.map((line) => [line[idField], line.quantity]));
  const base = quantities(baseLines);
  const local = quantities(localLines);
  const remote = quantities(remoteLines);
  const orderedIds = [...new Set([
    ...remote.keys(),
    ...local.keys(),
    ...base.keys(),
  ])];
  const merged = [];

  for (const id of orderedIds) {
    const before = base.get(id) || 0;
    const mine = local.get(id) || 0;
    const theirs = remote.get(id) || 0;
    const quantity = mine === before
      ? theirs
      : Math.max(0, Math.min(MAX_QUANTITY_PER_LINE, theirs + mine - before));
    if (quantity > 0) merged.push({ [idField]: id, quantity });
    if (merged.length >= MAX_LINES) break;
  }
  return merged;
}
