// CAUCE · marketplace multirrubro, fase 1 (docs/CAUCE-MARKETPLACE-MULTIRRUBRO-20261024.md).
// Vocabulario de capacidades por comercio y normalización de la entrada del
// panel. Reglas puras: no tocan red ni almacenamiento. La base (`businesses`,
// disparadores de la migración 20261024100000) es la última autoridad; esto
// guía la vista y evita envíos inútiles. La tabla de rubros de lanzamiento
// vive en `rubro-catalogo.js`, fuera del grafo de la interfaz.

import { requireValue } from './errors.js';
import { sanitizeText } from './validators.js';

// Vocabulario cerrado. Ampliarlo es una decisión de producto: se suma aquí y en
// la migración, nunca sólo en datos.
export const CAPABILITIES = Object.freeze({
  products: 'Productos y catálogo',
  prepared_food: 'Comida preparada',
  services: 'Servicios y turnos',
});

export const CAPABILITY_CODES = Object.freeze(Object.keys(CAPABILITIES));

export const MAX_CAPABILITIES_PER_BUSINESS = Object.freeze(8);
export const MAX_BUSINESSES_PER_ACCOUNT = Object.freeze(3);

export function isCapability(value) {
  return CAPABILITY_CODES.includes(value);
}

// Normaliza la entrada de una persona o de la base a la lista canónica:
// únicos, del vocabulario, acotados en cantidad. `raw` puede ser un array de
// códigos o una cadena separada por comas. Lanza CauceError ante inválidos.
export function sanitizeCapabilities(raw) {
  const candidates = Array.isArray(raw)
    ? raw.map(item => sanitizeText(item, { fallback: '', maxLength: 40 }).replace(/\s+/g, '_').toLowerCase())
    : sanitizeText(raw, { fallback: '', maxLength: 200 }).split(',');
  // El tope es sobre lo recibido, no sobre lo deduplicado: un envío inflado no
  // pasa, aunque repita el mismo código.
  requireValue(candidates.length <= MAX_CAPABILITIES_PER_BUSINESS, 'TOO_MANY_CAPABILITIES',
    `Se admiten hasta ${MAX_CAPABILITIES_PER_BUSINESS} capacidades por comercio.`);
  const seen = [];
  for (const candidate of candidates) {
    const code = candidate.trim();
    requireValue(code !== '', 'INVALID_CAPABILITIES', 'Hay un valor de capacidad vacío.');
    requireValue(CAPABILITY_CODES.includes(code), 'INVALID_CAPABILITIES',
      `Capacidad no admitida: ${code}`);
    if (!seen.includes(code)) seen.push(code);
  }
  return CAPABILITY_CODES.filter(code => seen.includes(code));
}

export function capabilityLabel(code) {
  return CAPABILITIES[code] || code;
}
