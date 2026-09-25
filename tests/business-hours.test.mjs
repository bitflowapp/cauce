import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHours, withinHours, nextOpening, describeHours, localClock, minutesOf, formatTime,
} from '../js/core/business-hours.js';

// Martes 24/09/2026 en Aluminé (UTC-3): 15:00 local = 18:00 UTC.
const at = (iso) => new Date(iso);
const TUE_15 = at('2026-09-22T18:00:00Z');
const hours = [
  { weekday: 2, opens: '09:00:00', closes: '13:00:00' },
  { weekday: 2, opens: '17:00:00', closes: '21:00:00' },
  { weekday: 5, opens: '20:00:00', closes: '02:00:00' },
];

test('lee la hora local de Aluminé, no la del dispositivo', () => {
  assert.deepEqual(localClock(TUE_15), { weekday: 2, minutes: 15 * 60 });
  assert.equal(minutesOf('07:05'), 425);
  assert.equal(formatTime(425), '07:05');
  assert.equal(minutesOf('25:00'), null);
});

test('abierto sólo dentro de los rangos del día', () => {
  assert.equal(withinHours(hours, at('2026-09-22T13:30:00Z')), true, 'martes 10:30');
  assert.equal(withinHours(hours, TUE_15), false, 'martes 15:00, entre turnos');
  assert.equal(withinHours(hours, at('2026-09-22T21:00:00Z')), true, 'martes 18:00');
  assert.equal(withinHours([], TUE_15), true, 'sin horarios manda el interruptor manual');
});

test('un rango que cruza la medianoche pertenece al día en que abre', () => {
  // Viernes 23:30 y sábado 01:30 locales: abierto. Sábado 02:30: cerrado.
  assert.equal(withinHours(hours, at('2026-09-26T02:30:00Z')), true);
  assert.equal(withinHours(hours, at('2026-09-26T04:30:00Z')), true);
  assert.equal(withinHours(hours, at('2026-09-26T05:30:00Z')), false);
});

test('informa la próxima apertura', () => {
  assert.equal(nextOpening(hours, TUE_15).label, 'Abre hoy a las 17:00');
  assert.equal(nextOpening(hours, at('2026-09-23T01:00:00Z')).label, 'Abre viernes a las 20:00');
  assert.equal(nextOpening([], TUE_15), null);
});

test('valida lo que carga el comercio', () => {
  assert.deepEqual(validateHours([{ weekday: 1, opens: '9:00', closes: '13:00' }].map(row => ({ ...row, opens: '09:00' }))),
    [{ weekday: 1, opens: '09:00', closes: '13:00' }]);
  assert.throws(() => validateHours([{ weekday: 1, opens: '10:00', closes: '10:00' }]), /misma hora/);
  assert.throws(() => validateHours([{ weekday: 9, opens: '10:00', closes: '11:00' }]), /Día inválido/);
  assert.throws(() => validateHours([{ weekday: 1, opens: 'diez', closes: '11:00' }]), /formato/);
  assert.throws(() => validateHours(Array.from({ length: 4 }, (_, i) => ({ weekday: 1, opens: `0${i}:00`, closes: `0${i}:30` }))),
    /hasta 3/);
});

test('resume días consecutivos con el mismo horario', () => {
  const weekdays = [1, 2, 3, 4, 5].map(weekday => ({ weekday, opens: '09:00', closes: '18:00' }));
  assert.deepEqual(describeHours([...weekdays, { weekday: 6, opens: '10:00', closes: '13:00' }]), [
    { days: 'Lun a Vie', hours: '09:00 a 18:00' },
    { days: 'Sábado', hours: '10:00 a 13:00' },
  ]);
});
