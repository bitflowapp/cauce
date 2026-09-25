export class CauceError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CauceError';
    this.code = code;
    /** Detalle técnico para el registro; nunca se muestra. @type {{ code: string, message: string, status?: number|null }|undefined} */
    this.technical = undefined;
    /** Total recalculado cuando cambió un precio. @type {number|undefined} */
    this.newTotal = undefined;
  }
}
export function requireValue(condition, code, message) {
  if (!condition) throw new CauceError(code, message);
}
export function clone(value) { return structuredClone(value); }
