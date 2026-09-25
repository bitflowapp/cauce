// Formato y etiquetas de la interfaz. Sin lógica de negocio.
import { CONFIG } from '../config.js';
import { STATUS_LABELS } from '../core/workflow-policy.js';
import { BUSINESS_STATUS_LABELS } from '../core/merchant-status.js';
import { TAXI_STATUS_LABELS } from '../core/taxi-workflow.js';
import { PAYMENT_METHOD_LABELS } from '../core/payment.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);

export const money = value => new Intl.NumberFormat(CONFIG.locale, {
  style: 'currency', currency: CONFIG.currency, maximumFractionDigits: 0,
}).format(Number(value) || 0);

export function shortDate(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(CONFIG.locale, {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
  } catch { return ''; }
}

export function timeOnly(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(CONFIG.locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  } catch { return ''; }
}

export function relativeMinutes(value, now = Date.now()) {
  if (!value) return '';
  const minutes = Math.round((new Date(value).getTime() - now) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes <= 0) return 'vencida';
  if (minutes === 1) return 'vence en 1 minuto';
  return `vence en ${minutes} minutos`;
}

// Nombres visibles para cada modalidad. El motor usa los estados heredados; la
// interfaz los nombra como los entiende quien compra.
const PICKUP_LABELS = Object.freeze({
  submitted: 'Recibido',
  accepted: 'Aceptado',
  preparing: 'En preparación',
  ready: 'Listo para retirar',
  delivered: 'Retirado',
  canceled: 'Cancelado',
});

const DELIVERY_LABELS = Object.freeze({
  submitted: 'Recibido',
  accepted: 'Aceptado',
  preparing: 'En preparación',
  ready: 'Listo',
  assigned: 'Asignado a reparto',
  picked_up: 'Retirado por el reparto',
  on_the_way: 'En camino',
  arrived: 'Llegó a destino',
  delivered: 'Entregado',
  canceled: 'Cancelado',
});

export function orderStatusLabel(order) {
  const map = order?.fulfillment === 'pickup' ? PICKUP_LABELS : DELIVERY_LABELS;
  if (order?.status === 'canceled' && order.cancellation?.kind === 'rejected') return 'Rechazado por el comercio';
  return map[order?.status] || STATUS_LABELS[order?.status] || order?.status || '';
}

export function orderStatusTone(status) {
  if (status === 'canceled') return 'cancelled';
  if (status === 'delivered') return 'done';
  if (['on_the_way', 'picked_up', 'arrived'].includes(status)) return 'way';
  if (['ready', 'assigned'].includes(status)) return 'ready';
  if (['accepted', 'preparing'].includes(status)) return 'preparing';
  return 'received';
}

// Pasos visibles de cada modalidad, para las líneas de tiempo.
export const PICKUP_STEPS = Object.freeze(['submitted', 'accepted', 'preparing', 'ready', 'delivered']);
export const DELIVERY_STEPS = Object.freeze(['submitted', 'accepted', 'preparing', 'ready', 'assigned', 'on_the_way', 'delivered']);

export function stepsFor(fulfillment) {
  return fulfillment === 'pickup' ? PICKUP_STEPS : DELIVERY_STEPS;
}

export function stepIndex(order) {
  const steps = stepsFor(order?.fulfillment);
  const direct = steps.indexOf(order?.status);
  if (direct >= 0) return direct;
  if (order?.status === 'picked_up') return steps.indexOf('on_the_way');
  if (order?.status === 'arrived') return steps.indexOf('on_the_way');
  return -1;
}

export const fulfillmentLabel = value => (value === 'pickup' ? 'Retiro en el comercio' : 'Envío del comercio');
export const paymentLabel = value => PAYMENT_METHOD_LABELS[value] || 'A coordinar (prueba)';
export const businessStatusLabel = value => BUSINESS_STATUS_LABELS[value] || value || '';
export const tripStatusLabel = value => TAXI_STATUS_LABELS[value] || value || '';

export function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function initialsOf(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('') || '?';
}
