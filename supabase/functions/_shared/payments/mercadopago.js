// Adaptador de Mercado Pago. SÓLO SERVIDOR (Edge Functions): nunca se importa
// desde el navegador y no conoce ningún token (se los pasan ya descifrados, en
// memoria, para una llamada).
//
// Traduce en los dos sentidos:
//   · de CAUCE al proveedor: el pedido de una orden (API de Orders, pago dentro
//     de CAUCE) o de una preferencia (Checkout Pro, redirección), siempre con
//     la clave de idempotencia del intento;
//   · del proveedor a CAUCE: el estado de una orden o de un pago, a los estados
//     neutrales. Un estado desconocido devuelve null: no se aplica, se anota.
//
// Sin dependencias: sólo APIs web estándar (fetch, URL, crypto.subtle).

export const PROVIDER = 'mercadopago';
export const API_BASE = 'https://api.mercadopago.com';
export const AUTH_BASE = 'https://auth.mercadopago.com/authorization';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── estados ──
// API de Orders: estado de la orden y detalle.
const ORDER_STATUS = Object.freeze({
  created: 'pending',
  action_required: 'pending',
  processing: 'processing',
  processed: 'approved',
  refunded: 'refunded',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  failed: 'rejected',
  expired: 'expired',
  charged_back: 'refunded',
});
// API de pagos (lo que informa Checkout Pro).
const PAYMENT_STATUS = Object.freeze({
  pending: 'pending',
  in_process: 'processing',
  authorized: 'processing',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  refunded: 'refunded',
  charged_back: 'refunded',
});

/** @param {unknown} status @param {unknown} [detail] @returns {string|null} */
export function mapOrderStatus(status, detail = '') {
  const key = String(status || '').toLowerCase();
  const note = String(detail || '').toLowerCase();
  if ((key === 'processed' || key === 'refunded') && note === 'partially_refunded') return 'partially_refunded';
  return Object.hasOwn(ORDER_STATUS, key) ? ORDER_STATUS[key] : null;
}

/** @param {unknown} status @param {unknown} [detail] @returns {string|null} */
export function mapPaymentStatus(status, detail = '') {
  const key = String(status || '').toLowerCase();
  const note = String(detail || '').toLowerCase();
  // Una disputa abierta no es un estado de CAUCE: se revisa a mano.
  if (key === 'in_mediation') return null;
  if (key === 'approved' && note === 'partially_refunded') return 'partially_refunded';
  return Object.hasOwn(PAYMENT_STATUS, key) ? PAYMENT_STATUS[key] : null;
}

// "1500.00" → 1500. CAUCE trabaja en pesos enteros: con centavos no es el
// importe del pedido y la base no lo aprueba.
/** @param {unknown} value @returns {number|null} */
export function toPesos(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isInteger(amount) ? amount : null;
}
const amountText = pesos => `${pesos}.00`;

// ── de CAUCE al proveedor ──
function checkContext(context) {
  if (!context || !UUID.test(String(context.attempt_id || ''))) throw new Error('Intento de pago inválido.');
  if (!UUID.test(String(context.idempotency_key || ''))) throw new Error('Falta la clave de idempotencia.');
  if (!Number.isInteger(context.amount) || context.amount <= 0) throw new Error('Importe inválido.');
  if (context.currency !== 'ARS') throw new Error('Moneda no admitida.');
  if (!['pending', 'processing'].includes(context.status)) throw new Error('El intento ya no está abierto.');
}

const headersFor = (accessToken, idempotencyKey) => ({
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  // Mismo intento, misma clave: un reintento o un doble toque no crea otro cobro.
  'X-Idempotency-Key': idempotencyKey,
});

// Pago dentro de CAUCE (Checkout API vía Orders). El token de la tarjeta lo
// genera el SDK del proveedor en el navegador; CAUCE nunca ve la tarjeta.
export function buildOrderRequest(context, { cardToken, paymentMethodId, paymentMethodType, installments = 1, payerEmail },
  accessToken) {
  checkContext(context);
  if (!cardToken || typeof cardToken !== 'string') throw new Error('Falta el token de la tarjeta.');
  if (!paymentMethodId || !paymentMethodType) throw new Error('Falta el medio de pago.');
  if (!EMAIL.test(String(payerEmail || ''))) throw new Error('Falta el correo del pagador.');
  if (!Number.isInteger(installments) || installments < 1 || installments > 24) throw new Error('Cuotas inválidas.');
  return {
    url: `${API_BASE}/v1/orders`,
    method: 'POST',
    headers: headersFor(accessToken, context.idempotency_key),
    body: {
      type: 'online',
      processing_mode: 'automatic',
      external_reference: context.attempt_id,
      total_amount: amountText(context.amount),
      payer: { email: payerEmail },
      transactions: {
        payments: [{
          amount: amountText(context.amount),
          payment_method: { id: paymentMethodId, type: paymentMethodType, token: cardToken, installments },
        }],
      },
    },
  };
}

// Redirección a Mercado Pago (Checkout Pro). Una sola línea con el total del
// pedido: el importe sale del intento, nunca se recalcula sumando líneas. Sin
// descriptor propio: el cobro es del comercio y el resumen de la tarjeta
// muestra el nombre de su cuenta.
export function buildPreferenceRequest(context, { siteUrl, notificationUrl, expiresAt = null }, accessToken) {
  checkContext(context);
  const site = new URL(siteUrl);
  if (site.protocol !== 'https:' && site.hostname !== '127.0.0.1' && site.hostname !== 'localhost') {
    throw new Error('El sitio de retorno tiene que ser https.');
  }
  if (new URL(notificationUrl).protocol !== 'https:') throw new Error('El webhook tiene que ser https.');
  const back = outcome => `${site.origin}${site.pathname.replace(/\/?$/, '/')}index.html#/pago/${outcome}?intento=${context.attempt_id}`;
  const title = `Pedido ${context.order?.code || ''} · ${context.business?.name || 'CAUCE'}`.slice(0, 120);
  return {
    url: `${API_BASE}/checkout/preferences`,
    method: 'POST',
    headers: headersFor(accessToken, context.idempotency_key),
    body: {
      items: [{ id: context.attempt_id, title, quantity: 1, currency_id: 'ARS', unit_price: context.amount }],
      external_reference: context.attempt_id,
      back_urls: { success: back('exito'), pending: back('pendiente'), failure: back('error') },
      auto_return: 'approved',
      notification_url: notificationUrl,
      ...(expiresAt ? { expires: true, expiration_date_to: expiresAt } : {}),
    },
  };
}

// ── del proveedor a CAUCE ──
// Lo que la base necesita de una orden (API de Orders).
export function readOrder(order) {
  const payments = order?.transactions?.payments || [];
  const refunds = payments.flatMap(payment => payment?.refunds || []);
  return {
    providerOrderId: String(order?.id || '') || null,
    attemptReference: UUID.test(String(order?.external_reference || '')) ? order.external_reference : null,
    status: mapOrderStatus(order?.status, order?.status_detail),
    statusDetail: String(order?.status_detail || '').slice(0, 80),
    paidAmount: toPesos(order?.total_paid_amount ?? order?.total_amount),
    transactions: [
      ...payments.map(payment => ({ kind: 'payment', id: String(payment.id || ''),
        status: mapOrderStatus(payment.status, payment.status_detail) || 'processing',
        status_detail: String(payment.status_detail || ''), amount: toPesos(payment.paid_amount ?? payment.amount) ?? 0,
        method_type: String(payment.payment_method?.type || '') })),
      ...refunds.map(refund => ({ kind: 'refund', id: String(refund.id || ''), status: 'refunded',
        status_detail: String(refund.status || ''), amount: toPesos(refund.amount) ?? 0, method_type: '' })),
    ].filter(movement => movement.id),
  };
}

// Lo que la base necesita de un pago (Checkout Pro).
export function readPayment(payment) {
  return {
    providerOrderId: payment?.order?.id ? String(payment.order.id) : null,
    attemptReference: UUID.test(String(payment?.external_reference || '')) ? payment.external_reference : null,
    status: mapPaymentStatus(payment?.status, payment?.status_detail),
    statusDetail: String(payment?.status_detail || '').slice(0, 80),
    paidAmount: toPesos(payment?.transaction_amount),
    transactions: payment?.id ? [{ kind: 'payment', id: String(payment.id),
      status: mapPaymentStatus(payment.status, payment.status_detail) || 'processing',
      status_detail: String(payment.status_detail || ''), amount: toPesos(payment.transaction_amount) ?? 0,
      method_type: String(payment.payment_type_id || '') }] : [],
  };
}

// Dónde leer el recurso que avisa un webhook. Sólo órdenes y pagos: el resto
// de los temas se reconoce (200) y no se procesa.
export function resourceRequest(type, id, accessToken) {
  const safe = encodeURIComponent(String(id || ''));
  if (!safe) return null;
  if (type === 'order') return { url: `${API_BASE}/v1/orders/${safe}`, read: readOrder, accessToken };
  if (type === 'payment') return { url: `${API_BASE}/v1/payments/${safe}`, read: readPayment, accessToken };
  return null;
}
