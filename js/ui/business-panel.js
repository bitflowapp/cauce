// Panel remoto del comercio: piezas de interfaz. Sólo arman HTML escapado a
// partir de datos ya leídos; qué se ofrece lo decide js/core/business-panel.js
// y qué se permite, la base.
import { esc, money, timeOnly, orderStatusLabel, orderStatusTone, paymentLabel } from './format.js';
import { renderIcon } from './icons.js';
import { whatsappNumber } from './merchant-tools.js';
import { formatArgentinePhone } from '../core/validators.js';
import { formatDeliveryCode } from '../core/delivery-code.js';
import {
  ORDER_GROUPS, DELIVERY_STAGES, groupOrders, merchantOrderActions, orderActionLabel, deliveryStage, isOpenOrder,
} from '../core/business-panel.js';

export function agoText(value, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - new Date(value).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'recién';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `hace ${hours} h` : `hace ${Math.floor(hours / 24)} d`;
}

const panelHref = (businessId, section = '') => `#panel/${esc(businessId)}${section ? `/${esc(section)}` : ''}`;

// ── navegación ──
export function panelNav(businessId, sections, current, { newCount = 0 } = {}) {
  return `<div class="tabs panel-nav" role="tablist" aria-label="Secciones del panel">
    ${sections.map(section => `
      <button class="tab ${current === section.key ? 'active' : ''}" type="button" role="tab"
        aria-selected="${current === section.key}" data-action="set-panel-tab" data-business="${esc(businessId)}"
        data-tab="${esc(section.key)}">${esc(section.label)}${section.key === 'pedidos' && newCount
          ? ` <span class="tab-badge" aria-label="${newCount} ${newCount === 1 ? 'nuevo' : 'nuevos'}">${newCount}</span>` : ''}</button>`).join('')}
  </div>`;
}

// ── abierto / cerrado ──
export function openBar(business, state, { canManage = false, online = true } = {}) {
  return `<div class="panel-openbar ${state.open ? 'is-open' : 'is-closed'}" role="status">
    <span class="panel-openbar-state">
      <strong class="open-flag">${esc(state.label)}</strong>
      <small>${esc(state.reason)}</small>
    </span>
    ${canManage && state.canToggle ? `<button class="button ${state.switchOn ? 'button-outline-danger' : ''}" type="button" data-action="toggle-open"
      data-business="${esc(business.id)}" data-open="${state.switchOn ? 'false' : 'true'}" ${online ? '' : 'disabled'}>
      ${state.switchOn ? 'Cerrar atención' : 'Abrir atención'}</button>` : ''}
  </div>`;
}

// ── conexión en vivo ──
export function syncBar({ liveHealthy = true, syncedAt = null, soundOn = false, muted = false } = {}) {
  return `<div class="panel-sync" role="status" aria-live="polite">
    <span class="panel-sync-dot ${liveHealthy ? 'ok' : 'warn'}" aria-hidden="true"></span>
    <span>${liveHealthy ? 'En vivo' : 'Reconectando: revisamos cada 30 segundos'}${syncedAt ? ` · actualizado ${esc(timeOnly(syncedAt))}` : ''}</span>
    <button class="link-button" type="button" data-action="refresh-panel">${renderIcon('refresh', 14)} Actualizar</button>
    ${soundOn ? `<button class="link-button panel-sound is-on" type="button" data-action="mute-sound"
        aria-label="Sonido de pedidos activado. Silenciar">${renderIcon('bell', 14)} Sonido activado · Silenciar</button>`
      : `<button class="link-button panel-sound" type="button" data-action="enable-sound">${renderIcon('bell-off', 14)}
        ${muted ? 'Sonido silenciado · Activar' : 'Activar sonido de pedidos'}</button>`}
  </div>`;
}

// Aviso en las secciones que no son de pedidos: un pedido nuevo no puede
// quedar escondido mientras se edita el catálogo o la configuración.
export function newOrdersBanner(businessId, count) {
  if (!count) return '';
  return `<a class="new-orders-banner" href="${panelHref(businessId, 'pedidos')}" role="status">
    ${renderIcon('bell', 16)}
    <span><strong>${count === 1 ? '1 pedido nuevo' : `${count} pedidos nuevos`}</strong> ${count === 1 ? 'espera' : 'esperan'} respuesta</span>
    <span class="new-orders-banner-cta">Ver pedidos</span>
  </a>`;
}

// ── tarjeta de pedido ──
function customerContact(order) {
  const phone = String(order.customer?.phone || '').replace(/[^\d+]/g, '');
  const wa = whatsappNumber(order.customer?.phone);
  return `<div class="order-card-customer">
    <span class="order-card-person">${renderIcon('user', 14)} ${esc(order.customer?.name || 'Sin nombre')}</span>
    ${phone ? `<a href="tel:${esc(phone)}">${renderIcon('phone', 14)} ${esc(formatArgentinePhone(order.customer.phone))}</a>` : ''}
    ${wa ? `<a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener noreferrer">${renderIcon('chat', 14)} WhatsApp</a>` : ''}
  </div>`;
}

function assignControl(order, riders, { canManage, online, riderChoice }) {
  const active = riders.filter(rider => rider.active !== false);
  const chosen = riderChoice?.get(order.id) || order.riderId;
  if (!active.length) {
    return canManage
      ? `<button class="button secondary" type="button" data-action="set-panel-tab" data-business="${esc(order.businessId)}"
          data-tab="reparto">Cargar quién reparte</button>`
      : '<p class="microcopy">Todavía no hay personas de reparto cargadas: pedíselo a quien administra el comercio.</p>';
  }
  return `<form class="inline-form" data-form="assign-rider" data-order="${esc(order.id)}" data-version="${order.version}">
    <label class="visually-hidden" for="rider-${esc(order.id)}">Quién reparte ${esc(order.code)}</label>
    <select id="rider-${esc(order.id)}" name="riderId" required>
      ${active.map(rider => `<option value="${esc(rider.id)}" ${rider.id === chosen ? 'selected' : ''}>${esc(rider.name)}</option>`).join('')}
    </select>
    <button class="button" type="submit" ${online ? '' : 'disabled'}>Asignar reparto</button>
  </form>`;
}

/**
 * @param {any} order
 * @param {{ businessId: string, localityId: string, connected: boolean, riders: any[], fresh?: string[],
 *   canManage?: boolean, online?: boolean, now?: number, riderChoice?: Map<string, string> }} context
 */
export function orderCard(order, context) {
  const { riders = [], fresh = [], canManage = false, online = true, now = Date.now() } = context;
  const { forward, cancel } = merchantOrderActions(order, context);
  const delivery = order.fulfillment === 'delivery';
  const open = isOpenOrder(order);
  const riderName = riders.find(rider => rider.id === order.riderId)?.name || '';
  const disabled = online ? '' : 'disabled';
  const lines = order.lines || [];
  return `
    <article class="order-panel-card ${order.status === 'submitted' ? 'is-new' : ''} ${fresh.includes(order.id) ? 'is-fresh' : ''} ${open ? '' : 'is-closed'}"
      aria-label="Pedido ${esc(order.code)}" data-status="${esc(order.status)}">
      <header class="order-panel-head">
        <div class="order-card-id">
          <strong>${esc(order.code)}</strong>
          <span class="quiet">${esc(timeOnly(order.createdAt))} · ${esc(agoText(order.createdAt, now))}</span>
        </div>
        <span class="status-chip ${orderStatusTone(order.status)}">${esc(orderStatusLabel(order))}</span>
      </header>
      <p class="order-card-meta">
        <span class="mode-chip ${delivery ? 'is-delivery' : 'is-pickup'}">${renderIcon(delivery ? 'delivery' : 'store', 13)} ${delivery ? 'Envío' : 'Retiro'}</span>
        <span>${esc(paymentLabel(order.paymentMethod))}</span>
      </p>
      <ul class="order-panel-lines" aria-label="Productos">
        ${lines.map(line => `<li><span class="order-line-qty">${Number(line.quantity) || 0} ×</span>
          <span class="order-line-name">${esc(line.name)}</span>
          <span class="order-line-total">${money(line.total)}</span></li>`).join('')}
      </ul>
      ${order.customer?.notes ? `<p class="order-panel-notes"><strong>Nota:</strong> ${esc(order.customer.notes)}</p>` : ''}
      ${customerContact(order)}
      ${delivery ? `<section class="order-card-delivery" aria-label="Entrega del pedido ${esc(order.code)}">
        <p class="order-card-address">${renderIcon('pin', 14)} ${esc(order.customer?.address || 'Sin dirección')}</p>
        <p class="order-card-stage">${esc(deliveryStage(order, riderName))}</p>
        ${order.deliveryCode && open ? `<p class="microcopy">Código de entrega: <strong>${esc(formatDeliveryCode(order.deliveryCode.code))}</strong> · pedíselo a la persona al entregar.</p>` : ''}
        ${forward.includes('assigned') ? assignControl(order, riders, { canManage, online, riderChoice: context.riderChoice }) : ''}
      </section>` : ''}
      <p class="order-panel-total"><span>Total</span> <strong>${money(order.total)}</strong>
        ${order.deliveryFee ? `<small>incluye envío ${money(order.deliveryFee)}</small>` : ''}</p>
      ${order.cancellation ? `<p class="microcopy order-card-reason">Motivo: ${esc(order.cancellation.reason || 'sin detalle')}</p>` : ''}
      ${forward.filter(action => action !== 'assigned').length || cancel ? `<div class="order-panel-actions">
        ${forward.filter(action => action !== 'assigned').map(action => `<button class="button" type="button" data-action="order-transition"
          data-order="${esc(order.id)}" data-version="${order.version}" data-next="${esc(action)}" ${disabled}>${esc(orderActionLabel(order, action))}</button>`).join('')}
        ${cancel ? `<button class="button button-outline-danger order-cancel" type="button"
          data-action="order-transition" data-order="${esc(order.id)}" data-version="${order.version}" data-next="canceled"
          data-reason="required" data-code="${esc(order.code)}" ${disabled}>${esc(orderActionLabel(order, 'canceled'))}</button>` : ''}
      </div>` : ''}
    </article>`;
}

// ── tablero por estado ──
export function orderFilters(groups, current) {
  const activeCount = ORDER_GROUPS.filter(group => group.active).reduce((sum, group) => sum + groups[group.key].length, 0);
  const chips = [{ key: 'activos', label: 'Activos', count: activeCount },
    ...ORDER_GROUPS.map(group => ({ key: group.key, label: group.label, count: groups[group.key].length }))];
  return `<div class="order-filters" role="group" aria-label="Filtrar pedidos por estado">
    ${chips.map(chip => `<button class="filter-chip ${chip.key === current ? 'is-active' : ''} ${chip.key === 'nuevos' && chip.count ? 'is-alert' : ''}"
      type="button" data-action="order-filter" data-filter="${esc(chip.key)}" aria-pressed="${chip.key === current}">
      ${esc(chip.label)} <span class="filter-chip-count">${chip.count}</span></button>`).join('')}
  </div>`;
}

export function ordersBoard(orders, context, { filter = 'activos', businessActive = true } = {}) {
  const groups = groupOrders(orders);
  const visible = ORDER_GROUPS.filter(group => (filter === 'activos' ? group.active : group.key === filter));
  const sections = visible.map(group => {
    const list = groups[group.key];
    // En "activos" un grupo vacío no ocupa lugar, salvo Nuevos: ahí se dice
    // explícitamente que no entró nada.
    if (!list.length && filter === 'activos' && group.key !== 'nuevos') return '';
    const empty = group.key === 'nuevos' && !businessActive ? 'El comercio todavía no está publicado: no recibe pedidos.' : group.empty;
    return `<section class="orders-group" aria-labelledby="grupo-${group.key}">
      <h2 class="orders-group-title" id="grupo-${group.key}">${esc(group.label)} <span class="orders-group-count">${list.length}</span></h2>
      ${list.length ? `<div class="orders-group-list">${list.map(order => orderCard(order, context)).join('')}</div>`
        : `<p class="quiet orders-empty">${esc(empty)}</p>`}
    </section>`;
  }).join('');
  return `${orderFilters(groups, filter)}<div class="orders-board ${filter === 'activos' ? '' : 'is-single'}">${sections}</div>`;
}

// ── reparto ──
// Tablero de despacho: las mismas tarjetas que Pedidos, sólo envíos, por
// etapa de la entrega; arriba, quién lleva qué ahora.
/**
 * @param {{ stages: Record<string, any[]>, preparing: number, deliveredToday: number,
 *   load: { rider: any, count: number }[] }} data  Lo que arma deliveryBoardData.
 * @param {Parameters<typeof orderCard>[1]} context
 * @param {{ deliveryEnabled?: boolean }} [options]
 */
export function deliveryBoard(data, context, { deliveryEnabled = true } = {}) {
  const id = context.businessId;
  const load = data.load.map(({ rider, count }) => {
    const phone = String(rider.phone || '').replace(/[^\d+]/g, '');
    return `<li class="${count ? 'is-busy' : ''}">
      <span><strong>${esc(rider.name)}</strong> · ${count ? `${count} ${count === 1 ? 'pedido' : 'pedidos'} en curso` : 'sin pedidos'}</span>
      ${phone ? `<a href="tel:${esc(phone)}">${renderIcon('phone', 14)} Llamar</a>` : ''}
    </li>`;
  }).join('');
  const stages = DELIVERY_STAGES.map(stage => {
    const list = data.stages[stage.key] || [];
    return `<section class="orders-group" aria-labelledby="reparto-${stage.key}">
      <h2 class="orders-group-title" id="reparto-${stage.key}">${esc(stage.label)} <span class="orders-group-count">${list.length}</span></h2>
      ${list.length ? `<div class="orders-group-list">${list.map(order => orderCard(order, context)).join('')}</div>`
        : `<p class="quiet orders-empty">${esc(stage.empty)}</p>`}
    </section>`;
  }).join('');
  return `
    <section class="panel-section" aria-labelledby="reparto-ahora">
      <h2 class="checkout-section-title" id="reparto-ahora">Envíos ahora</h2>
      ${deliveryEnabled ? '' : '<div class="notice">El comercio no ofrece envío en este momento: se activa en Configuración.</div>'}
      <p class="microcopy delivery-counts">
        ${data.preparing ? `<a href="${panelHref(id, 'pedidos')}">${data.preparing} ${data.preparing === 1 ? 'envío' : 'envíos'} en preparación</a>` : 'Ningún envío en preparación'}
        · ${data.deliveredToday} ${data.deliveredToday === 1 ? 'entregado' : 'entregados'} hoy
      </p>
      ${load ? `<ul class="plain-list rider-load" aria-label="Quién lleva qué">${load}</ul>` : ''}
    </section>
    <div class="orders-board delivery-board">${stages}</div>`;
}

// ── inicio ──
const metric = (label, value, { href = '', tone = '', hint = '' } = {}) => {
  const inner = `<span class="metric-label">${esc(label)}</span><strong class="metric-value">${value}</strong>${hint ? `<span class="metric-hint">${esc(hint)}</span>` : ''}`;
  return href ? `<a class="metric ${tone}" href="${href}">${inner}</a>` : `<div class="metric ${tone}">${inner}</div>`;
};

export function dashboard(business, summary, { newOrders = [], unavailable = [], context, canManage = false }) {
  const id = business.id;
  return `
    <section class="panel-section" aria-labelledby="panel-hoy">
      <h2 class="checkout-section-title" id="panel-hoy">Hoy</h2>
      <div class="metrics-grid panel-metrics">
        ${metric('Pedidos nuevos', String(summary.newOrders), { href: panelHref(id, 'pedidos'), tone: summary.newOrders ? 'is-alert' : '' })}
        ${metric('En curso', String(summary.activeOrders), { href: panelHref(id, 'pedidos') })}
        ${metric('Completados hoy', String(summary.completedToday))}
        ${metric('Vendido hoy', esc(money(summary.salesToday)), { hint: 'Suma de lo entregado hoy' })}
        ${metric('Retiro · Envío', `${summary.pickupToday} · ${summary.deliveryToday}`, { hint: 'Pedidos de hoy' })}
        ${metric('No disponibles', String(summary.unavailableProducts), { href: panelHref(id, 'catalogo'),
          tone: summary.unavailableProducts ? 'is-warn' : '', hint: `de ${summary.liveProducts} productos` })}
      </div>
    </section>
    <section class="panel-section" aria-labelledby="panel-atender">
      <h2 class="checkout-section-title" id="panel-atender">Esperan respuesta (${newOrders.length})</h2>
      ${newOrders.length ? `<div class="orders-group-list">${newOrders.map(order => orderCard(order, context)).join('')}</div>`
        : `<p class="quiet">${business.status === 'active' ? 'Todavía no tenés pedidos nuevos. Cuando entre uno aparece acá, en Pedidos, y suena un aviso.'
          : 'El comercio todavía no está publicado: completá la configuración y pedí la publicación.'}</p>`}
      <a class="button secondary full" href="${panelHref(id, 'pedidos')}">Ver todos los pedidos</a>
    </section>
    ${unavailable.length ? `<section class="panel-section" aria-labelledby="panel-agotados">
      <h2 class="checkout-section-title" id="panel-agotados">No disponibles (${unavailable.length})</h2>
      <ul class="plain-list unavailable-list">${unavailable.slice(0, 8).map(product => `<li>
        <span>${esc(product.name)}${product.trackStock && Number(product.stock) <= 0 ? ' <span class="quiet">· sin stock</span>' : ''}</span>
        ${product.available === false ? `<button class="link-button" type="button" data-action="product-toggle" data-business="${esc(id)}"
          data-product="${esc(product.id)}" data-field="available" data-value="true">Marcar disponible</button>`
          : `<a class="link-button" href="${panelHref(id, 'catalogo')}">Cargar stock</a>`}
      </li>`).join('')}</ul>
      ${unavailable.length > 8 ? `<a class="link-button" href="${panelHref(id, 'catalogo')}">Ver los ${unavailable.length} en el catálogo</a>` : ''}
    </section>` : ''}
    ${canManage && business.status !== 'active' ? `<section class="panel-section">
      <div class="notice"><strong>Para empezar a recibir pedidos:</strong> completá los datos, los horarios y el catálogo, y pedí la publicación desde Configuración.</div>
      <a class="button full" href="${panelHref(id, 'configuracion')}">Ir a Configuración</a>
    </section>` : ''}`;
}
