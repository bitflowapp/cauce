// Horarios de atención. Reglas puras, con la misma semántica que la base
// (private.within_business_hours): cada rango pertenece al día en que abre, y
// si cierra antes de abrir cruza la medianoche. La hora es la de la localidad.
import { requireValue } from './errors.js';

export const WEEKDAYS = Object.freeze(['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']);
export const WEEKDAYS_SHORT = Object.freeze(['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']);
export const MAX_RANGES_PER_DAY = 3;
export const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;

export function minutesOf(value) {
  const match = TIME.exec(String(value || '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export const formatTime = value => {
  const minutes = typeof value === 'number' ? value : minutesOf(value);
  if (minutes == null) return '';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

// Filas tal como las guarda la base: { weekday, opens: 'HH:MM:SS', closes }.
export function normalizeHours(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ weekday: Number(row.weekday), opens: minutesOf(row.opens), closes: minutesOf(row.closes) }))
    .filter(row => Number.isInteger(row.weekday) && row.weekday >= 0 && row.weekday <= 6
      && row.opens != null && row.closes != null && row.opens !== row.closes)
    .sort((a, b) => a.weekday - b.weekday || a.opens - b.opens);
}

// Valida lo que carga el comercio antes de enviarlo: la base vuelve a validar.
export function validateHours(rows) {
  const hours = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const weekday = Number(row.weekday);
    requireValue(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6, 'INVALID_HOURS', 'Día inválido.');
    const opens = minutesOf(row.opens);
    const closes = minutesOf(row.closes);
    requireValue(opens != null && closes != null, 'INVALID_HOURS',
      `Revisá el horario del ${WEEKDAYS[weekday].toLowerCase()}: usá el formato 09:00.`);
    requireValue(opens !== closes, 'INVALID_HOURS',
      `El horario del ${WEEKDAYS[weekday].toLowerCase()} abre y cierra a la misma hora.`);
    hours.push({ weekday, opens: formatTime(opens), closes: formatTime(closes) });
  }
  for (let day = 0; day < 7; day += 1) {
    const ranges = hours.filter(row => row.weekday === day);
    requireValue(ranges.length <= MAX_RANGES_PER_DAY, 'INVALID_HOURS',
      `Se admiten hasta ${MAX_RANGES_PER_DAY} horarios por día.`);
    const keys = new Set(ranges.map(row => row.opens));
    requireValue(keys.size === ranges.length, 'INVALID_HOURS',
      `Hay dos horarios del ${WEEKDAYS[day].toLowerCase()} que abren a la misma hora.`);
  }
  return hours;
}

// Día de la semana y minuto del día en la zona horaria de la localidad.
export function localClock(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function withinHours(rows, date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const hours = normalizeHours(rows);
  if (!hours.length) return true;
  const { weekday, minutes } = localClock(date, timeZone);
  const yesterday = (weekday + 6) % 7;
  return hours.some(range => (range.closes > range.opens
    ? range.weekday === weekday && minutes >= range.opens && minutes < range.closes
    : (range.weekday === weekday && minutes >= range.opens)
      || (range.weekday === yesterday && minutes < range.closes)));
}

// Próxima apertura dentro de los siete días siguientes, para "Abre hoy 18:00".
export function nextOpening(rows, date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const hours = normalizeHours(rows);
  if (!hours.length) return null;
  const { weekday, minutes } = localClock(date, timeZone);
  for (let offset = 0; offset < 8; offset += 1) {
    const day = (weekday + offset) % 7;
    const candidate = hours.find(range => range.weekday === day && (offset > 0 || range.opens > minutes));
    if (candidate) {
      const when = offset === 0 ? 'hoy' : offset === 1 ? 'mañana' : WEEKDAYS[day].toLowerCase();
      return { weekday: day, opens: formatTime(candidate.opens), label: `Abre ${when} a las ${formatTime(candidate.opens)}` };
    }
  }
  return null;
}

// Resumen legible agrupando días consecutivos con el mismo horario.
export function describeHours(rows) {
  const hours = normalizeHours(rows);
  if (!hours.length) return [];
  const signature = day => hours.filter(range => range.weekday === day)
    .map(range => `${formatTime(range.opens)} a ${formatTime(range.closes)}`).join(' y ');
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups = [];
  for (const day of order) {
    const text = signature(day);
    const last = groups[groups.length - 1];
    if (last && last.text === text && order.indexOf(day) === order.indexOf(last.to) + 1) last.to = day;
    else groups.push({ from: day, to: day, text });
  }
  return groups.filter(group => group.text).map(group => ({
    days: group.from === group.to ? WEEKDAYS[group.from]
      : `${WEEKDAYS_SHORT[group.from]} a ${WEEKDAYS_SHORT[group.to]}`,
    hours: group.text,
  }));
}
