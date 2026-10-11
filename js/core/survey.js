// Encuesta breve de la Comunidad Fundadora (piloto). Los códigos son los
// mismos que valida private.clean_survey en la base: si se cambia uno, cambia
// en los dos lados (lo controla una prueba unitaria).

/** @typedef {{ key: string, label: string, multiple?: boolean, options: [string, string][] }} SurveyQuestion */

/** @type {readonly SurveyQuestion[]} */
export const SURVEY = Object.freeze([
  { key: 'channels', label: '¿Dónde vendés hoy?', multiple: true,
    options: [['ferias', 'Ferias'], ['redes', 'Instagram o Facebook'], ['whatsapp', 'WhatsApp'], ['local', 'Local o taller propio'], ['otro', 'Otro']] },
  { key: 'fairs_per_month', label: '¿En cuántas ferias participás por mes?',
    options: [['0', 'Ninguna'], ['1', 'Una'], ['2-3', 'Dos o tres'], ['4+', 'Cuatro o más']] },
  { key: 'main_need', label: '¿Qué te ayudaría más?',
    options: [['ventas', 'Vender más'], ['pedidos', 'Ordenar pedidos y encargos'], ['online', 'Tener mi tienda en internet'],
      ['visibilidad', 'Que me conozcan más'], ['ferias', 'Enterarme de ferias y conseguir puesto'], ['otro', 'Otra cosa']] },
  { key: 'price', label: 'Un plan mensual de {price}, ¿te parece…?',
    options: [['accesible', 'Accesible'], ['razonable', 'Razonable si me trae ventas'], ['caro', 'Caro para mí']] },
]);

export const PILOT_LABEL = 'Quiero probar CAUCE en el piloto con mi tienda';

/**
 * Arma la encuesta desde un formulario: sólo códigos conocidos; vacía si no
 * se respondió nada.
 * @param {FormData} data
 */
export function surveyFromForm(data) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const q of SURVEY) {
    const allowed = new Set(q.options.map(([value]) => value));
    if (q.multiple) {
      const values = data.getAll(`sv-${q.key}`).map(String).filter(v => allowed.has(v));
      if (values.length) out[q.key] = values;
    } else {
      const value = String(data.get(`sv-${q.key}`) || '');
      if (allowed.has(value)) out[q.key] = value;
    }
  }
  if (data.get('sv-pilot')) out.pilot = true;
  return out;
}

/**
 * Texto legible de una respuesta guardada.
 * @param {string} key
 * @param {any} value
 */
export function answerLabel(key, value) {
  if (key === 'pilot') return value ? 'Sí' : 'No';
  const q = SURVEY.find(item => item.key === key);
  const label = v => q?.options.find(([code]) => code === v)?.[1] || String(v);
  return Array.isArray(value) ? value.map(label).join(', ') : label(value);
}
