// Error que la interfaz puede mostrar tal cual: mensaje en castellano, sin
// detalles técnicos. El detalle va aparte (`technical`) para el registro.
export class AppError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    /** @type {{ code?: string, message?: string, status?: number|null }|null} */
    this.technical = null;
  }
}

export function requireValue(condition, code, message) {
  if (!condition) throw new AppError(code, message);
}
