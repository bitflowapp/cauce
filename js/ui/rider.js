// Aplicación de reparto: piezas de interfaz. Arman HTML escapado con lo que
// devolvió rider_orders; qué se ofrece lo decide js/core/rider-app.js y qué se
// permite, la base. Pensada para el teléfono: una mano, botones grandes.
import { esc, money, timeOnly, paymentLabel, pluralize } from './format.js';
import { renderIcon } from './icons.js';
import { whatsappNumber } from './merchant-tools.js';
import { formatArgentinePhone } from '../core/validators.js';
import {
  RIDER_STATUS_LABELS, CODE_STATUSES, DELIVERY_CODE_ATTEMPTS, riderStep, canConfirmDelivery, splitRiderOrders, mapsUrl,
} from '../core/rider-app.js';

const telHref = value => String(value || '').replace(/[^\d+]/g, '');
const TONES = Object.freeze({ assigned: 'ready', picked_up: 'way', on_the_way: 'way', arrived: 'way',
  delivered: 'done', canceled: 'cancelled' });

function codeForm(order, disabled) {
  const left = Number(order.codeAttemptsLeft ?? DELIVERY_CODE_ATTEMPTS);
  const id = esc(order.id);
  return `<form class="rider-code" data-form="rider-deliver" data-order="${id}" data-version="${order.version}">
    <label for="rider-code-${id}">${renderIcon('key', 16)} Código del cliente</label>
    <div class="rider-code-row">
      <input id="rider-code-${id}" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
        pattern="[0-9]{2} ?[0-9]{2}" maxlength="5" required placeholder="0000" aria-describedby="rider-code-help-${id}">
      <button class="button" type="submit" ${disabled}>Entregar</button>
    </div>
    <p class="microcopy" id="rider-code-help-${id}">Pedíselo al cliente al entregar: son 4 dígitos.${left < DELIVERY_CODE_ATTEMPTS
      ? ` ${left === 1 ? 'Queda 1 intento' : `Quedan ${left} intentos`}.` : ''}</p>
  </form>`;
}

export function riderCard(order, { online = true, feedback = null } = {}) {
  const step = riderStep(order);
  const disabled = online ? '' : 'disabled';
  const customer = order.customer || {};
  const phone = telHref(customer.phone);
  const wa = whatsappNumber(customer.phone);
  const maps = mapsUrl(customer.address, order.locality);
  const shopPhone = telHref(order.business?.phone);
  const locked = CODE_STATUSES.includes(order.status) && !canConfirmDelivery(order);
  return `<article class="rider-card" data-status="${esc(order.status)}" aria-label="Entrega ${esc(order.code)}">
    <header class="rider-card-head">
      <div class="order-card-id"><strong>${esc(order.code)}</strong>
        <span class="quiet">${esc(order.business?.name || '')} · ${esc(timeOnly(order.createdAt))}</span></div>
      <span class="status-chip ${TONES[order.status] || 'received'}">${esc(RIDER_STATUS_LABELS[order.status] || order.status)}</span>
    </header>
    <section class="rider-destination" aria-label="Destino">
      <p class="rider-address">${renderIcon('pin', 18)} <strong>${esc(customer.address || 'Sin dirección')}</strong></p>
      ${maps ? `<a class="button secondary rider-maps" href="${esc(maps)}" target="_blank" rel="noopener noreferrer">${renderIcon('pin', 16)} Abrir en Maps</a>` : ''}
    </section>
    <div class="rider-contact">
      <span class="order-card-person">${renderIcon('user', 14)} ${esc(customer.name || 'Sin nombre')}${phone
        ? ` · ${esc(formatArgentinePhone(customer.phone))}` : ''}</span>
      <div class="rider-contact-actions">
        ${phone ? `<a class="button secondary" href="tel:${esc(phone)}">${renderIcon('phone', 16)} Llamar</a>` : ''}
        ${wa ? `<a class="button secondary" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener noreferrer">${renderIcon('chat', 16)} WhatsApp</a>` : ''}
      </div>
    </div>
    ${customer.notes ? `<p class="order-panel-notes"><strong>Nota:</strong> ${esc(customer.notes)}</p>` : ''}
    <ul class="order-panel-lines" aria-label="Productos">
      ${(order.lines || []).map(line => `<li><span class="order-line-qty">${Number(line.quantity) || 0} ×</span>
        <span class="order-line-name">${esc(line.name)}</span></li>`).join('')}
    </ul>
    <p class="rider-charge"><span>A cobrar · ${esc(paymentLabel(order.paymentMethod))}</span> <strong>${money(order.total)}</strong></p>
    ${step ? `<button class="button rider-step" type="button" data-action="rider-step" data-order="${esc(order.id)}"
      data-version="${order.version}" data-next="${esc(step.status)}" ${disabled}>${esc(step.label)}</button>` : ''}
    ${feedback?.orderId === order.id ? `<p class="notice error rider-feedback" role="alert">${esc(feedback.message)}</p>` : ''}
    ${canConfirmDelivery(order) ? codeForm(order, disabled) : ''}
    ${locked ? '<p class="microcopy rider-locked">Se agotaron los intentos con código. Llamá al comercio: puede cerrar la entrega desde su panel.</p>' : ''}
    ${shopPhone ? `<a class="link-button rider-shop-call" href="tel:${esc(shopPhone)}">${renderIcon('store', 14)} Llamar al comercio</a>` : ''}
  </article>`;
}

function historyItem(order) {
  return `<li class="rider-history-item" data-status="${esc(order.status)}">
    <span><strong>${esc(order.code)}</strong> <span class="quiet">${esc(order.business?.name || '')}</span></span>
    <span>${esc(RIDER_STATUS_LABELS[order.status] || order.status)} · ${esc(timeOnly(order.updatedAt))}</span>
    <strong>${money(order.total)}</strong>
  </li>`;
}

// Pantalla completa de quien reparte: entregas en curso arriba, historial abajo.
export function riderHome({ orders = [], riders = [], online = true, updatedAt = '', feedback = null } = {}) {
  const { active, history } = splitRiderOrders(orders);
  const shops = [...new Set(riders.filter(rider => rider.active !== false).map(rider => rider.businessName).filter(Boolean))];
  const collected = history.filter(order => order.status === 'delivered').reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  return `<section class="rider-app" aria-labelledby="rider-title">
    <header class="rider-app-head">
      <div>
        <p class="eyebrow">${renderIcon('delivery', 14)} Reparto</p>
        <h1 id="rider-title">Tus entregas</h1>
        ${shops.length ? `<p class="quiet">Para ${esc(shops.join(' · '))}</p>` : ''}
      </div>
      <button class="button secondary rider-refresh" type="button" data-action="rider-refresh" ${online ? '' : 'disabled'}>
        ${renderIcon('refresh', 16)} Actualizar</button>
    </header>
    ${updatedAt ? `<p class="microcopy rider-updated">Actualizado ${esc(timeOnly(updatedAt))} · se actualiza solo cada 15 segundos.</p>` : ''}
    ${active.length ? `<div class="rider-deliveries" aria-label="Entregas en curso">${active.map(order => riderCard(order, { online, feedback })).join('')}</div>`
      : `<div class="empty-state rider-empty"><h2>No tenés entregas asignadas</h2>
        <p class="quiet">Cuando el comercio te asigne un pedido, aparece acá con la dirección, el contacto y el importe a cobrar.</p></div>`}
    ${history.length ? `<section class="rider-history" aria-labelledby="rider-history-title">
      <h2 id="rider-history-title">Últimos 7 días</h2>
      <p class="quiet">${pluralize(history.filter(order => order.status === 'delivered').length, 'entrega', 'entregas')} · ${money(collected)} cobrados</p>
      <ul class="plain-list">${history.map(historyItem).join('')}</ul>
    </section>` : ''}
  </section>`;
}

// Cuenta sin vínculo: qué hacer, sin exponer nada.
export function riderUnlinked(email = '', { paused = false } = {}) {
  return `<section class="rider-app" aria-labelledby="rider-title">
    <p class="eyebrow">${renderIcon('delivery', 14)} Reparto</p>
    <h1 id="rider-title">Tus entregas</h1>
    <div class="empty-state">
      ${paused ? `<h2>Tu reparto está en pausa</h2>
        <p class="quiet">El comercio pausó tu reparto. Cuando lo reactive, vas a ver tus entregas acá.</p>`
        : `<h2>Tu cuenta todavía no reparte para ningún comercio</h2>
        <p class="quiet">Pedile al comercio que te vincule desde su panel (Reparto → Vincular cuenta) con tu correo${email
          ? `: <strong>${esc(email)}</strong>` : ''}.</p>`}
    </div>
  </section>`;
}
