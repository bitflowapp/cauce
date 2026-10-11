// Dinero en pesos enteros: el servidor guarda y calcula en enteros; acá sólo se muestra.
const FORMAT = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

export function formatARS(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return FORMAT.format(Math.round(amount)).replace(/\u00a0/g, ' ');
}

/** Convierte lo que escribe una persona ("12.500", "12500") en un entero de pesos. */
export function parseARS(text) {
  const digits = String(text ?? '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}
