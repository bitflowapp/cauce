export class CauceError extends Error {
  constructor(code, message) { super(message); this.name = 'CauceError'; this.code = code; }
}
export function requireValue(condition, code, message) {
  if (!condition) throw new CauceError(code, message);
}
export function clone(value) { return structuredClone(value); }
