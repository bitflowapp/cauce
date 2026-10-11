// Fechas de ferias y pedidos en la hora de Neuquén (UTC−3, sin horario de verano).
export const TIME_ZONE = 'America/Argentina/Salta';
const OFFSET = '-03:00';

const part = (date, options) => new Intl.DateTimeFormat('es-AR', { timeZone: TIME_ZONE, ...options }).format(date);
const toDate = value => (value instanceof Date ? value : new Date(value));

export function dateBadge(value) {
  const date = toDate(value);
  return {
    day: part(date, { weekday: 'short' }).replace('.', '').slice(0, 3).toUpperCase(),
    num: part(date, { day: 'numeric' }),
    month: part(date, { month: 'short' }).replace('.', '').slice(0, 3).toUpperCase(),
  };
}

export function timeRange(start, end) {
  const a = part(toDate(start), { hour: '2-digit', minute: '2-digit', hour12: false });
  const b = part(toDate(end), { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = dayKey(start) === dayKey(end);
  return sameDay ? `${a} a ${b}` : `${a} a ${shortDate(end)} ${b}`;
}

export function dayKey(value) {
  return part(toDate(value), { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** "sáb 12 abr" */
export function shortDate(value) {
  const date = toDate(value);
  return `${part(date, { weekday: 'short' }).replace('.', '')} ${part(date, { day: 'numeric' })} ${part(date, { month: 'short' }).replace('.', '')}`;
}

/** "sábado 12 de abril" */
export function longDate(value) {
  return part(toDate(value), { weekday: 'long', day: 'numeric', month: 'long' });
}

/** "12/04 14:35" */
export function dateTime(value) {
  return part(toDate(value), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function relative(value, now = Date.now()) {
  const minutes = Math.round((now - toDate(value).getTime()) / 60000);
  if (minutes < 1) return 'recién';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return dateTime(value);
}

/** Valor para <input type="datetime-local"> en la hora de Neuquén. */
export function toLocalInput(value) {
  const date = toDate(value);
  const pieces = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date).map(p => [p.type, p.value]));
  return `${pieces.year}-${pieces.month}-${pieces.day}T${pieces.hour === '24' ? '00' : pieces.hour}:${pieces.minute}`;
}

/** Lo que se escribió en un datetime-local (hora de Neuquén) como ISO. */
export function fromLocalInput(text) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(text || ''))) return null;
  const date = new Date(`${text}:00${OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Primer y último día del mes de `value`, como fechas YYYY-MM-DD de Neuquén. */
export function monthRange(value = new Date(), offset = 0) {
  const [y, m] = dayKey(value).split('/').reverse().map(Number).slice(0, 2);
  const base = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
  const iso = d => d.toISOString().slice(0, 10);
  return { from: iso(base), to: iso(last) };
}
