// Seguimiento del pedido para quien compra: el estado actual bien grande, el
// código de entrega a mano, la línea de tiempo y el detalle plegado. Sólo
// arma HTML escapado con lo que devolvió la base; ninguna posición en vivo.
import { esc, money, timeOnly, orderStatusLabel, stepsFor, stepIndex, paymentLabel, pluralize } from './format.js';
import { renderIcon } from './icons.js';
import { renderCharacter } from './brand-characters.js';
import { formatDeliveryCode } from '../core/delivery-code.js';
import { orderPayment } from '../core/payment.js';
import { productThumb } from './storefront.js';

// Qué pasa ahora y qué sigue, en palabras de quien compra.
const MOMENTS = Object.freeze({
  submitted: ['merchant', 'received', 'El comercio lo recibió y en breve confirma si lo toma.'],
  accepted: ['merchant', 'preparing', 'El comercio confirmó que puede prepararlo.'],
  preparing: ['merchant', 'preparing', 'El comercio está preparando tus productos.'],
  ready: ['shopper', 'ready', ''],
  assigned: ['courier', 'ready', 'Ya tiene quien lo lleva. Sale en breve.'],
  picked_up: ['courier', 'way', 'El reparto ya lo retiró del comercio.'],
  on_the_way: ['courier', 'way', 'Va en camino. Tené a mano el código de entrega.'],
  arrived: ['courier', 'way', 'El reparto informó que llegó. Decile el código de entrega.'],
  delivered: ['celebrate', 'done', ''],
});

/**
 * @param {any} order
 * @param {{ times?: string, place?: string, courier?: string }} [options]  Tiempos declarados por el
 *   comercio, dónde se entrega o se retira, y quién lo lleva.
 */
export function orderStatusHero(order, { times = '', place = '', courier = '' } = {}) {
  const moment = MOMENTS[order.status];
  if (!moment) return '';
  const pickup = order.fulfillment === 'pickup';
  const message = order.status === 'ready'
    ? (pickup ? 'Ya podés retirarlo por el comercio.' : 'Está listo. En breve sale con el reparto del comercio.')
    : order.status === 'delivered' ? (pickup ? 'Retiraste tu pedido. ¡Gracias por comprar en Aluminé!' : 'Pedido entregado. ¡Gracias por comprar en Aluminé!')
      : moment[2];
  const open = order.status !== 'delivered';
  return `<section class="order-hero is-${esc(moment[1])}" aria-labelledby="order-hero-title">
    <div class="order-hero-copy">
      <span class="order-hero-kicker">Estado de tu pedido</span>
      <h2 id="order-hero-title">${esc(orderStatusLabel(order))}</h2>
      <p>${esc(message)}</p>
      ${open && place ? `<p class="order-hero-eta">${renderIcon(pickup ? 'store' : 'pin', 14)} ${pickup ? 'Retirás en' : 'Entrega en'}: ${esc(place)}</p>` : ''}
      ${open && !pickup && courier && ['assigned', 'picked_up', 'on_the_way', 'arrived'].includes(order.status)
        ? `<p class="order-hero-eta">${renderIcon('delivery', 14)} ${esc(courier)}</p>` : ''}
      ${open && times ? `<p class="order-hero-eta">${renderIcon('clock', 14)} Tiempo declarado por el comercio: ${esc(times)}</p>` : ''}
      ${open && !pickup && ['assigned', 'picked_up', 'on_the_way', 'arrived'].includes(order.status)
        ? '<p class="order-hero-note">Estado informado por el reparto en cada paso: no es una ubicación en vivo ni una posición GPS.</p>' : ''}
    </div>
    <div class="order-hero-art" aria-hidden="true">${renderCharacter(moment[0], 88)}</div>
  </section>`;
}

// El código que se dicta al recibir. Sólo mientras el envío no se entregó.
export function deliveryCodeCard(order) {
  if (!order.deliveryCode?.code || order.fulfillment !== 'delivery' || ['delivered', 'canceled'].includes(order.status)) return '';
  return `<section class="delivery-code-card" aria-labelledby="delivery-code-title">
    <span class="delivery-code-label" id="delivery-code-title">${renderIcon('key', 16)} Código de entrega</span>
    <strong class="delivery-code-value" data-delivery-code>${esc(formatDeliveryCode(order.deliveryCode.code))}</strong>
    <span class="quiet">Decíselo a quien te entrega el pedido, recién cuando lo tengas en la mano.</span>
  </section>`;
}

export function orderTimeline(order) {
  const steps = stepsFor(order.fulfillment);
  const current = stepIndex(order);
  const reached = new Map((order.history || []).map(step => [step.status, step.at]));
  return `<ol class="timeline" aria-label="Pasos del pedido">
    ${steps.map((step, index) => `
      <li class="timeline-step ${index < current ? 'done' : index === current ? 'current' : ''}"
        ${index === current ? 'aria-current="step"' : ''}>
        <span class="timeline-dot" aria-hidden="true"></span>
        <span>${esc(orderStatusLabel({ ...order, status: step }))}${reached.get(step) ? ` <span class="quiet">· ${esc(timeOnly(reached.get(step)))}</span>` : ''}</span>
      </li>`).join('')}
  </ol>`;
}

export function cancellationNotice(order) {
  return `<div class="notice ${order.cancellation?.kind === 'rejected' ? 'error' : ''}" role="status">
    <strong>${order.cancellation?.kind === 'rejected' ? 'El comercio no pudo tomar el pedido.' : 'Pedido cancelado.'}</strong>
    ${order.cancellation?.reason ? `Motivo: ${esc(order.cancellation.reason)}` : ''}
  </div>`;
}

// Detalle plegado: lo secundario queda a un toque, sin empujar el estado.
export function orderDetails(order, { open = false } = {}) {
  const units = (order.lines || []).reduce((total, line) => total + (Number(line.quantity) || 0), 0);
  const payment = orderPayment(order);
  const paymentText = payment.kind === 'online' ? `${payment.method} · ${payment.label}`
    : `${paymentLabel(order.paymentMethod)}${order.status === 'delivered' || order.status === 'canceled' ? '' : ' · se paga al comercio'}`;
  return `<details class="order-details" ${open ? 'open' : ''}>
    <summary><span>Detalle del pedido · ${pluralize(units, 'producto', 'productos')}</span> <strong>${money(order.total)}</strong></summary>
    <ul class="cart-lines-list">
      ${(order.lines || []).map(line => `
        <li class="cart-line">
          <div class="cart-line-product">
            ${productThumb(line, line.name)}
            <div class="cart-line-info">
              <span class="cart-line-title">${esc(line.name)}</span>
              <span class="cart-line-unit-price">${Number(line.quantity) || 0} × ${money(line.unitPrice)}</span>
            </div>
          </div>
          <span class="cart-line-total">${money(line.total)}</span>
        </li>`).join('')}
    </ul>
    <dl class="totals">
      <div><dt>Subtotal</dt><dd>${money(order.subtotal)}</dd></div>
      <div><dt>Envío</dt><dd>${order.deliveryFee > 0 ? money(order.deliveryFee) : 'Sin costo'}</dd></div>
      <div class="totals-final"><dt>Total</dt><dd>${money(order.total)}</dd></div>
    </dl>
    <p class="microcopy">Pago: ${esc(paymentText)}.</p>
    ${order.customer?.address ? `<p class="microcopy">Dirección: ${esc(order.customer.address)}</p>` : ''}
  </details>`;
}
