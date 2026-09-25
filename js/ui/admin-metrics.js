// Administración de la plataforma: el día del piloto en números, lo que
// necesita atención y el estado de cada comercio. HTML escapado a partir de lo
// que devolvió admin_pilot_metrics (sin datos de clientes).
import { esc, money, timeOnly, pluralize } from './format.js';
import { renderIcon } from './icons.js';
import { durationText } from '../core/pilot-metrics.js';

const tel = value => String(value || '').replace(/[^\d+]/g, '');
const tile = (label, value, detail = '') => `<div class="metric"><dt>${esc(label)}</dt><dd>${value}</dd>${detail
  ? `<p class="metric-detail">${detail}</p>` : ''}</div>`;

export function pilotToday(metrics) {
  const { businesses, today, errors } = metrics;
  return `<section class="panel-section admin-today" aria-labelledby="admin-today-title">
    <h2 class="checkout-section-title" id="admin-today-title">Hoy en CAUCE</h2>
    <dl class="metrics-grid">
      ${tile('Comercios activos', businesses.active, `${businesses.openNow} ${businesses.openNow === 1 ? 'abierto' : 'abiertos'} ahora`)}
      ${tile('Pedidos hoy', today.orders, `${today.pickup} retiro · ${today.delivery} envío`)}
      ${tile('Completados hoy', today.delivered, today.canceled ? `${pluralize(today.canceled, 'cancelado', 'cancelados')}` : '')}
      ${tile('Volumen bruto hoy', money(today.gross), today.delivered ? `ticket ${money(today.averageTicket)}` : '')}
      ${tile('En curso ahora', today.inProgress)}
      ${tile('Errores 24 h', errors.total, errors.critical ? `${errors.critical} críticos` : 'ninguno crítico')}
    </dl>
    <p class="microcopy">Hoy es desde las 00:00 en la hora de la localidad${metrics.timezone ? ` (${esc(metrics.timezone)})` : ''}.
      Volumen bruto: el total de lo entregado hoy, con envío incluido. Actualizado ${esc(timeOnly(metrics.generatedAt))}.</p>
  </section>`;
}

export function pilotIncidents(stuck = [], total = stuck.length) {
  const count = Math.max(total, stuck.length);
  return `<section class="panel-section admin-incidents" aria-labelledby="admin-incidents-title">
    <h2 class="checkout-section-title" id="admin-incidents-title">Necesitan atención (${count})</h2>
    ${count > stuck.length ? `<p class="microcopy">Se muestran los ${stuck.length} que más esperan.</p>` : ''}
    ${stuck.length ? `<ul class="plain-list admin-incident-list">${stuck.map(item => `
      <li>
        <span><strong>${esc(item.code)}</strong> · ${esc(item.business)}<br>
          <span class="quiet">${esc(item.reason)} · hace ${esc(durationText(item.minutes))}</span></span>
        ${tel(item.phone) ? `<a class="button secondary" href="tel:${esc(tel(item.phone))}">${renderIcon('phone', 14)} Llamar al comercio</a>` : ''}
      </li>`).join('')}</ul>`
      : '<p class="quiet">Ningún pedido lleva demasiado tiempo sin moverse.</p>'}
    <p class="microcopy">Sin respuesta hace 15 min, en preparación 60, listo 45 o en reparto 90. Sin datos del cliente:
      el comercio tiene el pedido completo.</p>
  </section>`;
}

// El estado de hoy de un comercio publicado, para la lista de administración.
export function businessTodayLine(stats) {
  if (!stats) return '';
  return `<span class="admin-business-today">${stats.openNow ? 'Abierto' : 'Cerrado'} · ${pluralize(stats.orders, 'pedido', 'pedidos')}
    hoy · ${stats.delivered} ${stats.delivered === 1 ? 'completado' : 'completados'} · ${money(stats.gross)}</span>`;
}
