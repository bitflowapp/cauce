// Plantillas HTML con escape obligatorio: todo valor interpolado se escapa
// salvo que se marque explícitamente como confiable con `raw()` (íconos e
// ilustraciones generados por la propia aplicación). Es la defensa contra XSS
// de la interfaz: los textos de comercios, productos y pedidos nunca entran
// como HTML.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escape(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, char => ENTITIES[char]);
}

export class Raw {
  /** @param {string} value */
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/** Marca un fragmento como HTML confiable (sólo para markup generado por CAUCE). */
export const raw = value => (value instanceof Raw ? value : new Raw(String(value ?? '')));

function piece(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(piece).join('');
  return escape(value);
}

/**
 * @param {TemplateStringsArray} strings
 * @param {...any} values
 * @returns {Raw}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += piece(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** Atributo opcional: `attr('aria-pressed', on)`. */
export function attr(name, value) {
  if (value === null || value === undefined || value === false) return raw('');
  if (value === true) return raw(` ${name}`);
  return raw(` ${name}="${escape(value)}"`);
}
