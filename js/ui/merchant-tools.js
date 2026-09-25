// Piezas de interfaz del comercio conectado: contacto, horarios y equipo.
// Sólo arman HTML escapado; las reglas y los permisos los decide la base.
import { esc, shortDate } from './format.js';
import { WEEKDAYS, MAX_RANGES_PER_DAY, normalizeHours, formatTime, describeHours } from '../core/business-hours.js';
import { renderIcon } from './icons.js';

export const ROLE_NAMES = Object.freeze({ owner: 'Titular', manager: 'Encargado/a', staff: 'Equipo' });
export const ROLE_HINTS = Object.freeze({
  owner: 'Administra el comercio, el catálogo, el reparto y el equipo.',
  manager: 'Administra el comercio, el catálogo y el reparto. No cambia el equipo.',
  staff: 'Atiende pedidos y marca productos agotados.',
});

// Teléfono argentino en formato internacional para WhatsApp (549 + área + número).
export function whatsappNumber(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('549')) return digits;
  if (digits.startsWith('54')) return `549${digits.slice(2)}`;
  digits = digits.replace(/^0/, '');
  // "2942 15 123456" → sin el 15 de celular.
  digits = digits.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
  return digits.length >= 10 ? `549${digits}` : '';
}

export function contactButtons(business, { compact = false } = {}) {
  const phone = String(business?.publicPhone || '').replace(/[^\d+]/g, '');
  const wa = whatsappNumber(business?.whatsapp || business?.publicPhone);
  if (!phone && !wa) return '';
  return `<div class="contact-actions ${compact ? 'is-compact' : ''}">
    ${phone ? `<a class="button secondary" href="tel:${esc(phone)}">${renderIcon('phone', 16)} Llamar</a>` : ''}
    ${wa ? `<a class="button secondary" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener noreferrer">${renderIcon('chat', 16)} WhatsApp</a>` : ''}
  </div>`;
}

export function timesLine(business, fulfillment = null) {
  const parts = [];
  if (business?.prepMinutes) parts.push(`Preparación: ~${business.prepMinutes} min`);
  if (business?.deliveryMinutes && fulfillment !== 'pickup') parts.push(`Envío: ~${business.deliveryMinutes} min`);
  return parts.join(' · ');
}

export function hoursSummary(business) {
  const groups = describeHours(business?.hours);
  if (groups.length) {
    return `<ul class="hours-list">${groups.map(group =>
      `<li><span>${esc(group.days)}</span><strong>${esc(group.hours)}</strong></li>`).join('')}</ul>`;
  }
  return business?.hoursLabel ? `<p class="quiet">${esc(business.hoursLabel)}</p>` : '';
}

// Editor de la semana: por día, cerrado o hasta tres turnos (lo que admite
// la base). Se muestran dos turnos y el tercero sólo si algún día ya lo
// tenía cargado: guardar nunca borra un turno que la pantalla no mostraba.
/** @param {any} business @param {{ editable?: boolean, state?: any }} [options] */
export function hoursEditor(business, { editable = true } = {}) {
  const hours = normalizeHours(business?.hours);
  const disabled = editable ? '' : 'disabled';
  // Todos los días con la misma cantidad de turnos: así "repetir el lunes"
  // copia la semana completa.
  const slots = Math.min(MAX_RANGES_PER_DAY, Math.max(2,
    ...[0, 1, 2, 3, 4, 5, 6].map(day => hours.filter(range => range.weekday === day).length)));
  const rows = [1, 2, 3, 4, 5, 6, 0].map(day => {
    const ranges = hours.filter(range => range.weekday === day);
    // Con horarios cargados, un día sin turnos es un día cerrado.
    const closed = hours.length > 0 && ranges.length === 0;
    const slot = (index, field) => {
      const range = ranges[index];
      return range ? formatTime(field === 'opens' ? range.opens : range.closes) : '';
    };
    return `<fieldset class="hours-day ${closed ? 'is-closed' : ''}">
      <legend>${esc(WEEKDAYS[day])}</legend>
      <label class="check-label hours-closed"><input type="checkbox" name="d${day}-closed" ${closed ? 'checked' : ''} ${disabled}>
        <span>Cerrado</span></label>
      ${Array.from({ length: slots }, (_, index) => `<div class="hours-range">
        <label><span class="visually-hidden">${esc(WEEKDAYS[day])}, turno ${index + 1}, abre</span>
          <input type="time" name="d${day}-${index}-opens" value="${slot(index, 'opens')}" step="300" ${disabled}></label>
        <span aria-hidden="true">a</span>
        <label><span class="visually-hidden">${esc(WEEKDAYS[day])}, turno ${index + 1}, cierra</span>
          <input type="time" name="d${day}-${index}-closes" value="${slot(index, 'closes')}" step="300" ${disabled}></label>
      </div>`).join('')}
    </fieldset>`;
  }).join('');
  const summary = describeHours(business?.hours);
  return `<form class="checkout-form" data-form="business-hours" data-business="${esc(business.id)}">
    <h2 class="checkout-section-title">Horarios de atención</h2>
    ${summary.length ? `<div class="hours-preview"><p class="microcopy">Así lo ve el cliente:</p>
      <ul class="hours-list">${summary.map(group => `<li><span>${esc(group.days)}</span><strong>${esc(group.hours)}</strong></li>`).join('')}</ul></div>`
      : '<div class="notice">Todavía no cargaste horarios: CAUCE toma pedidos siempre que la atención esté abierta.</div>'}
    <p class="microcopy">Fuera de estos horarios CAUCE no toma pedidos, aunque te olvides de cerrar.
      Si un turno termina después de medianoche (por ejemplo 20:00 a 01:00), cargalo en el día en que abre.
      Un día marcado “Cerrado” no toma pedidos.</p>
    ${editable ? '<button class="button secondary" type="button" data-action="hours-copy-monday">Repetir el lunes en toda la semana</button>' : ''}
    <div class="hours-grid">${rows}</div>
    <button class="button full" type="submit" ${editable ? '' : 'disabled'}>Guardar horarios</button>
  </form>`;
}

// Lee la semana desde cualquier fuente con get(nombre): un día "Cerrado"
// no aporta turnos y un turno vacío no se guarda.
/** @param {(name: string) => any} get */
export function hoursFromEntries(get) {
  const hours = [];
  for (let day = 0; day < 7; day += 1) {
    if (get(`d${day}-closed`) === 'on') continue;
    for (let index = 0; index < MAX_RANGES_PER_DAY; index += 1) {
      const opens = String(get(`d${day}-${index}-opens`) || '').trim();
      const closes = String(get(`d${day}-${index}-closes`) || '').trim();
      if (!opens && !closes) continue;
      hours.push({ weekday: day, opens, closes });
    }
  }
  return hours;
}

export function readHoursForm(form) {
  const data = new FormData(form);
  return hoursFromEntries(name => data.get(name));
}

// Sin turnos la base no limita por horario: marcar los siete días "Cerrado"
// dejaría el comercio tomando pedidos siempre. Para cerrar está el interruptor.
/** @param {(name: string) => any} get */
export function allDaysClosed(get) {
  return [0, 1, 2, 3, 4, 5, 6].every(day => get(`d${day}-closed`) === 'on');
}

/** @param {any} business @param {any[]} team @param {{ isOwner: boolean, role?: string }} options */
export function teamTab(business, team, { isOwner, role = '' }) {
  const rows = team.map(member => `
    <li class="team-member">
      <span class="team-member-main">
        <strong>${esc(member.name || member.email)}</strong>${member.isSelf ? ' <span class="quiet">(vos)</span>' : ''}
        <span class="quiet">${esc(member.email)} · desde ${esc(shortDate(member.since))}</span>
      </span>
      <span class="status-chip ${member.role === 'owner' ? 'done' : member.role === 'manager' ? 'ready' : 'received'}">${esc(ROLE_NAMES[member.role] || member.role)}</span>
      ${isOwner && member.role !== 'owner' ? `<span class="team-member-actions">
        <button class="link-button" type="button" data-action="team-role" data-business="${esc(business.id)}"
          data-user="${esc(member.userId)}" data-role="${member.role === 'manager' ? 'staff' : 'manager'}">
          ${member.role === 'manager' ? 'Pasar a equipo' : 'Hacer encargado/a'}</button>
        <button class="link-button danger" type="button" data-action="team-remove" data-business="${esc(business.id)}"
          data-user="${esc(member.userId)}" data-name="${esc(member.name || member.email)}">Quitar</button>
      </span>` : ''}
    </li>`).join('');
  return `
    <section class="panel-section">
      <h2 class="checkout-section-title">Equipo del comercio</h2>
      ${role ? `<p class="microcopy panel-role">Tu rol: ${esc(ROLE_NAMES[role] || role)}. ${esc(ROLE_HINTS[role] || '')}</p>` : ''}
      <ul class="plain-list team-list">${rows}</ul>
      <dl class="role-legend">${['owner', 'manager', 'staff'].map(role =>
        `<div><dt>${ROLE_NAMES[role]}</dt><dd>${ROLE_HINTS[role]}</dd></div>`).join('')}</dl>
    </section>
    ${isOwner ? `<section class="panel-section">
      <form class="checkout-form" data-form="team-add" data-business="${esc(business.id)}">
        <h2 class="checkout-section-title">Sumar a alguien</h2>
        <p class="microcopy">La persona primero crea su cuenta en CAUCE con su correo. Después la sumás acá; puede empezar a usar el panel en el momento.</p>
        <div class="field">
          <label for="team-email">Correo de su cuenta</label>
          <input id="team-email" name="email" type="email" required autocomplete="off" inputmode="email">
        </div>
        <div class="field">
          <label for="team-role">Rol</label>
          <select id="team-role" name="role">
            <option value="staff">Equipo: atiende pedidos</option>
            <option value="manager">Encargado/a: administra el comercio</option>
          </select>
        </div>
        <button class="button full" type="submit">Sumar al equipo</button>
      </form>
    </section>` : `<p class="microcopy">Sólo la persona titular suma o quita integrantes del equipo.</p>`}`;
}
