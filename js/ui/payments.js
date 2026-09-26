// Pagos en la interfaz: el selector de forma de pago del checkout, la insignia
// del estado del pago, la pantalla de vuelta del proveedor y la sección Pagos
// del panel. Sólo arman HTML escapado con lo que respondió la base: ninguna
// pieza decide que algo se pagó ni ofrece una forma que la base no ofreció.
import { esc, money, shortDate } from './format.js';
import { renderIcon } from './icons.js';
import { orderPayment, paymentReturnState } from '../core/payment.js';

// Formas de pago de la demostración: no cobran nada y lo dicen.
export const DEMO_PAYMENT_METHODS = Object.freeze([
  Object.freeze({ id: 'cash_demo', kind: 'cash', label: 'Efectivo al recibir', detail: 'Prueba · no se cobra nada' }),
  Object.freeze({ id: 'transfer_demo', kind: 'cash', label: 'Transferencia al comercio', detail: 'Prueba · no se cobra nada' }),
]);

/**
 * Selector de forma de pago. `methods` ya viene filtrado (checkoutPaymentMethods
 * o DEMO_PAYMENT_METHODS): acá sólo se dibuja lo que hay.
 * @param {ReadonlyArray<{ id: string, kind: string, label: string, detail?: string, provider?: string }>} methods
 * @param {string} selected
 * @param {{ note?: string }} [options]
 */
export function paymentMethodSelector(methods, selected, { note = '' } = {}) {
  const list = Array.isArray(methods) ? methods : [];
  const chosen = list.some(method => method.id === selected) ? selected : list[0]?.id;
  return `<fieldset class="pay-methods" ${note ? 'aria-describedby="pay-note"' : ''}>
    <legend class="visually-hidden">Forma de pago</legend>
    ${list.map(method => `
      <label class="choice pay-method ${method.id === chosen ? 'active' : ''}" data-kind="${esc(method.kind)}">
        <input type="radio" name="paymentMethod" value="${esc(method.id)}" ${method.id === chosen ? 'checked' : ''}>
        <span class="pay-method-icon" aria-hidden="true">${renderIcon(method.kind === 'online' ? 'shield-check' : 'cash', 18)}</span>
        <span class="choice-body"><strong>${esc(method.label)}</strong>${method.detail
          ? `<span class="quiet">${esc(method.detail)}</span>` : ''}</span>
      </label>`).join('')}
  </fieldset>
  ${note ? `<p class="microcopy pay-note" id="pay-note">${esc(note)}</p>` : ''}`;
}

// Insignia del pago de un pedido, en términos neutrales.
export function paymentBadge(order, { compact = false } = {}) {
  const payment = orderPayment(order);
  return `<span class="pay-badge is-${esc(payment.tone)}" data-payment="${esc(payment.kind)}:${esc(payment.state)}">${
    compact && payment.kind === 'cash' ? esc(payment.collected ? 'Cobrado' : payment.method) : esc(payment.label)}</span>`;
}

/**
 * Vuelta desde el proveedor (#pago/exito|pendiente|error). Lo que se muestra
 * sale del estado leído en la base; la ruta sólo elige el primer mensaje.
 * @param {string} outcome
 * @param {{ paymentMethod: string, paymentStatus: string, orderId?: string, code?: string } | null} payment
 */
export function paymentReturnView(outcome, payment) {
  const state = paymentReturnState(outcome, payment);
  const icon = state.tone === 'success' ? 'check' : state.tone === 'error' ? 'bell' : 'clock';
  return `<section class="pay-return is-${esc(state.tone)}" aria-labelledby="pay-return-title">
    <span class="pay-return-icon" aria-hidden="true">${renderIcon(icon, 26)}</span>
    <h1 class="page-title" id="pay-return-title">${esc(state.title)}</h1>
    <p>${esc(state.message)}</p>
    ${payment?.code ? `<p class="quiet">Pedido ${esc(payment.code)}</p>` : ''}
    <div class="pay-return-actions">
      ${payment?.orderId ? `<a class="button full" href="#pedido/${esc(payment.orderId)}">Ver mi pedido</a>` : ''}
      <a class="button secondary full" href="#actividad">Mis pedidos</a>
    </div>
    ${state.final ? '' : '<p class="microcopy">Esta pantalla consulta el estado del pago cada pocos segundos.</p>'}
  </section>`;
}

// Estado de la cuenta del comercio en un proveedor. El nombre del proveedor
// sale del registro de la base (payment_providers): acá no hay ninguno fijo.
const ACCOUNT_STATES = Object.freeze({
  not_connected: { label: 'No conectado', tone: 'neutral',
    hint: provider => `Conectá la cuenta de ${provider} del comercio para cobrar pedidos online. El dinero va directo a esa cuenta.` },
  connecting: { label: 'Conectando', tone: 'pending',
    hint: provider => `Falta terminar la autorización en ${provider}. Si cerraste la ventana, volvé a conectar.` },
  connected: { label: 'Conectado', tone: 'success',
    hint: () => 'Los pedidos online se cobran en la cuenta del comercio. CAUCE no toca ese dinero.' },
  reconnect_required: { label: 'Requiere reconexión', tone: 'error',
    hint: provider => `${provider} dejó de autorizar a CAUCE. Mientras tanto el checkout ofrece sólo efectivo.` },
});

const CONNECTION_NOTICES = Object.freeze({
  ok: ['success', 'Cuenta conectada. Ya se pueden cobrar pedidos online.'],
  cancelada: ['neutral', 'La conexión se canceló en el proveedor. No cambió nada.'],
  vencida: ['error', 'El enlace de conexión venció. Volvé a conectar la cuenta.'],
  // El proveedor dice si la cuenta es de prueba: nunca se mezclan los modos.
  cuenta_real: ['error', 'En modo de prueba sólo se conectan cuentas de prueba del proveedor. No se guardó nada.'],
  cuenta_prueba: ['error', 'Esa es una cuenta de prueba: para cobrar de verdad conectá la cuenta real del comercio. No se guardó nada.'],
  error: ['error', 'No se pudo completar la conexión. Probá de nuevo en unos minutos.'],
});

function providerCard(provider, account, { businessId, isOwner, online }) {
  const status = account?.status && ACCOUNT_STATES[account.status] ? account.status : 'not_connected';
  const view = ACCOUNT_STATES[status];
  const label = String(provider.label || provider.provider);
  const data = `data-business="${esc(businessId)}" data-provider="${esc(provider.provider)}"`;
  const disabled = online ? '' : 'disabled';
  return `<div class="pay-account is-${esc(view.tone)}">
      <span class="pay-account-brand" aria-hidden="true">${renderIcon('shield-check', 20)}</span>
      <span class="pay-account-body">
        <strong>${esc(label)}</strong>
        <span class="pay-badge is-${esc(view.tone)}">${esc(view.label)}</span>
        <span class="quiet">${esc(view.hint(label))}</span>
        ${account?.provider_user_id && status === 'connected' ? `<span class="microcopy">Cuenta vendedora ${esc(account.provider_user_id)}${
          account.live_mode === false ? ' · modo de prueba' : ''}</span>` : ''}
        ${account?.status_reason && status !== 'connected' ? `<span class="microcopy">${esc(account.status_reason)}</span>` : ''}
      </span>
    </div>
    ${isOwner ? `<div class="pay-account-actions">
      ${status === 'connected'
        ? `<button class="button button-outline-danger" type="button" data-action="payment-disconnect" ${data} data-label="${esc(label)}" ${disabled}>Desconectar</button>`
        : `<button class="button" type="button" data-action="payment-connect" ${data} ${disabled}>${
          status === 'not_connected' ? `Conectar ${esc(label)}` : 'Volver a conectar'}</button>`}
    </div>` : ''}`;
}

/**
 * Sección Pagos del panel. Sin cuenta conectada no hay números que mostrar:
 * se muestra el estado real, nunca cifras de ejemplo.
 * @param {any} overview  Lo que devolvió business_payment_overview.
 * @param {{ businessId: string, isOwner: boolean, online?: boolean, connection?: string }} options
 */
export function paymentsSection(overview, { businessId, isOwner, online = true, connection = '' }) {
  const providers = Array.isArray(overview?.providers) ? overview.providers : [];
  const accounts = Array.isArray(overview?.accounts) ? overview.accounts : [];
  const connected = accounts.some(account => account.status === 'connected');
  const notice = CONNECTION_NOTICES[connection];
  const today = overview?.today || {};
  const review = Number(overview?.to_review) || 0;
  const tile = (label, value, hint = '') => `<div class="metric"><span class="metric-label">${esc(label)}</span>
    <strong class="metric-value">${value}</strong>${hint ? `<span class="metric-hint">${esc(hint)}</span>` : ''}</div>`;
  return `<section class="panel-section pay-panel" aria-labelledby="pagos-title">
    <h2 class="checkout-section-title" id="pagos-title">Pagos online</h2>
    ${overview?.sandbox ? `<div class="notice" role="status"><strong>Modo de prueba.</strong> Este comercio es el piloto
      de pagos online: sólo acepta cuentas y pagos de prueba del proveedor. Nada se cobra de verdad.</div>` : ''}
    ${notice ? `<div class="notice ${notice[0] === 'error' ? 'error' : ''}" role="status">${esc(notice[1])}</div>` : ''}
    ${providers.length ? providers.map(provider => providerCard(provider,
      accounts.find(account => account.provider === provider.provider) || null, { businessId, isOwner, online })).join('')
      : '<p class="quiet">No hay proveedores de pago habilitados en CAUCE.</p>'}
    ${isOwner ? '' : '<p class="microcopy">Conectar o desconectar la cuenta lo hace la persona titular del comercio.</p>'}
    ${review ? `<div class="notice error" role="status"><strong>${review} ${review === 1 ? 'pago para revisar' : 'pagos para revisar'}.</strong>
      El proveedor informó un importe distinto del pedido, un pago repetido o un pago que llegó después de cerrar el intento.
      Revisalo en la cuenta del comercio y devolvé lo que corresponda: CAUCE nunca devuelve solo.</div>` : ''}
    <h3 class="checkout-section-title">Hoy</h3>
    ${connected || Number(today.approved) || Number(today.pending) ? `<div class="metrics-grid panel-metrics pay-metrics">
      ${tile('Pagos aprobados', String(Number(today.approved) || 0), money(Number(today.approved_ars) || 0))}
      ${tile('Pendientes', String(Number(today.pending) || 0), 'Esperan confirmación')}
      ${tile('Rechazados', String(Number(today.rejected) || 0))}
      ${tile('Devoluciones', String(Number(today.refunded) || 0), Number(today.to_refund) ? `${Number(today.to_refund)} por devolver` : '')}
    </div>` : '<p class="quiet">Todavía no hay pagos online: aparecen acá cuando la cuenta esté conectada y entren pedidos pagados.</p>'}
    <p class="microcopy">${overview?.last_synced_at ? `Última novedad del proveedor: ${esc(shortDate(overview.last_synced_at))}.`
      : 'Sin novedades del proveedor todavía.'} Los estados llegan del proveedor; la pantalla no los inventa.</p>
  </section>`;
}

// Aviso del pedido online para quien compra, con la acción de pagar si falta.
export function orderPaymentNotice(order, { canPay = false, online = true } = {}) {
  const payment = orderPayment(order);
  if (payment.kind !== 'online') return '';
  const waiting = payment.state === 'pending' || payment.state === 'processing';
  // Se puede pagar si todavía no se pagó (pendiente) o si el intento anterior
  // no prosperó; nunca mientras el proveedor está procesando uno.
  const retry = ['rejected', 'expired', 'cancelled'].includes(payment.state);
  return `<section class="pay-order is-${esc(payment.tone)}" aria-label="Pago del pedido">
    <p><strong>${esc(payment.label)}</strong> · ${esc(money(order.total))}</p>
    <p class="quiet">${waiting ? 'El comercio empieza a preparar el pedido cuando se confirma el pago.'
      : payment.collected ? 'El proveedor de pagos confirmó el pago.' : 'El pago no se completó.'}</p>
    ${canPay && (payment.state === 'pending' || retry) ? `<button class="button full" type="button" data-action="payment-start" data-order="${esc(order.id)}"
      ${online ? '' : 'disabled'}>${retry ? 'Intentar el pago de nuevo' : 'Pagar ahora'}</button>` : ''}
  </section>`;
}
