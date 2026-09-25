// Adaptador de Mercado Pago. SÓLO SERVIDOR (Edge Functions): nunca se importa
// desde el navegador y no conoce ningún token (se los pasan ya descifrados, en
// memoria, para una llamada).
//
// Traduce en los dos sentidos:
//   · de CAUCE al proveedor: una orden de la API de Orders, sea Checkout Pro
//     (redirección a la página del proveedor, el flujo activo) o pago dentro de
//     CAUCE; la preferencia clásica queda como alternativa. Siempre con la
//     clave de idempotencia del intento;
//   · del proveedor a CAUCE: el estado de una orden o de un pago, a los estados
//     neutrales. Un estado desconocido devuelve null: no se aplica, se anota.
//
// Sin dependencias: sólo APIs web estándar (fetch, URL, crypto.subtle).

export const PROVIDER = 'mercadopago';
export const API_BASE = 'https://api.mercadopago.com';
export const AUTH_BASE = 'https://auth.mercadopago.com/authorization';

// Las órdenes de prueba del proveedor llevan este prefijo (ORDTST…). Un piloto
// en sandbox nunca redirige a una orden que no lo tenga.
export const isTestOrderId = id => /^ORDTST[0-9A-Z]{6,}$/.test(String(id || ''));
// En sandbox el proveedor exige un pagador @testuser.com (400
// invalid_email_for_sandbox): es el de su propia documentación, no una persona.
export const SANDBOX_PAYER_EMAIL = 'test@testuser.com';

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
export function buildOrderRequest(context, { cardToken, paymentMethodId, paymentMethodType, installments = 1, payerEmail,
  apiBase = API_BASE }, accessToken) {
  checkContext(context);
  if (!cardToken || typeof cardToken !== 'string') throw new Error('Falta el token de la tarjeta.');
  if (!paymentMethodId || !paymentMethodType) throw new Error('Falta el medio de pago.');
  if (!EMAIL.test(String(payerEmail || ''))) throw new Error('Falta el correo del pagador.');
  if (!Number.isInteger(installments) || installments < 1 || installments > 24) throw new Error('Cuotas inválidas.');
  return {
    url: `${apiBase}/v1/orders`,
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

// Las páginas de retorno de CAUCE (#/pago/*) con la referencia del intento.
// Nunca aprueban nada: consultan la base.
function returnUrls(context, siteUrl) {
  const site = new URL(siteUrl);
  if (site.protocol !== 'https:' && site.hostname !== '127.0.0.1' && site.hostname !== 'localhost') {
    throw new Error('El sitio de retorno tiene que ser https.');
  }
  const back = outcome => `${site.origin}${site.pathname.replace(/\/?$/, '/')}index.html#/pago/${outcome}?intento=${context.attempt_id}`;
  return { success: back('exito'), pending: back('pendiente'), failure: back('error') };
}
const orderTitle = context => `Pedido ${context.order?.code || ''} · ${context.business?.name || 'CAUCE'}`.slice(0, 120);

// Duración ISO 8601 de la orden del proveedor (PT30M): la vida completa del
// intento, medida con sus propias fechas y no con la hora actual. Así el mismo
// intento manda siempre el mismo cuerpo: el proveedor rechaza (409) una clave
// de idempotencia repetida con otro contenido, y un reintento tiene que ser
// idéntico al primer envío. Un intento vencido no crea nada.
export function expirationDuration({ expiresAt, createdAt, now = Date.now() }) {
  const until = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(until)) return null;
  if (until - now < 60000) throw new Error('El intento ya venció.');
  const since = Date.parse(String(createdAt || ''));
  // Sin la fecha de creación, el plazo por defecto del proveedor (también fijo).
  if (!Number.isFinite(since)) return null;
  const minutes = Math.round((until - since) / 60000);
  return `PT${Math.min(Math.max(minutes, 1), 24 * 60)}M`;
}

// Checkout Pro vía la API de Orders (el flujo activo): una orden `online` en
// modo manual que devuelve `checkout_url`, adonde va quien compra. Una sola
// línea con el total del pedido: el importe sale del intento, nunca se
// recalcula sumando líneas ni viene del navegador. Sin comisión de
// marketplace: CAUCE no cobra comisión. Las notificaciones llegan al webhook
// configurado en la aplicación (tema "Order"). Todo sale del intento: el mismo
// intento produce byte a byte el mismo pedido al proveedor.
export function buildCheckoutProOrderRequest(context, { siteUrl, payerEmail = '', now = Date.now(), apiBase = API_BASE },
  accessToken) {
  checkContext(context);
  const back = returnUrls(context, siteUrl);
  const amount = amountText(context.amount);
  const expiration = expirationDuration({ expiresAt: context.expires_at, createdAt: context.created_at, now });
  return {
    url: `${apiBase}/v1/orders`,
    method: 'POST',
    headers: headersFor(accessToken, context.idempotency_key),
    body: {
      type: 'online',
      processing_mode: 'manual',
      external_reference: context.attempt_id,
      total_amount: amount,
      description: orderTitle(context),
      ...(expiration ? { expiration_time: expiration } : {}),
      ...(EMAIL.test(String(payerEmail || '')) ? { payer: { email: payerEmail } } : {}),
      // El proveedor admite hasta 30 caracteres en el código del ítem.
      items: [{ external_code: String(context.order?.code || context.attempt_id).slice(0, 30), title: orderTitle(context),
        quantity: 1, unit_price: amount }],
      config: { online: { success_url: back.success, pending_url: back.pending, failure_url: back.failure,
        auto_return: 'approved' } },
    },
  };
}

// Checkout Pro clásico (preferencia): alternativa, hoy sin uso. Mismas reglas.
export function buildPreferenceRequest(context, { siteUrl, notificationUrl, expiresAt = null, apiBase = API_BASE },
  accessToken) {
  checkContext(context);
  const back = returnUrls(context, siteUrl);
  if (new URL(notificationUrl).protocol !== 'https:') throw new Error('El webhook tiene que ser https.');
  const title = orderTitle(context);
  return {
    url: `${apiBase}/checkout/preferences`,
    method: 'POST',
    headers: headersFor(accessToken, context.idempotency_key),
    body: {
      items: [{ id: context.attempt_id, title, quantity: 1, currency_id: 'ARS', unit_price: context.amount }],
      external_reference: context.attempt_id,
      back_urls: back,
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
  // Las devoluciones van en transactions.refunds (y, en respuestas viejas,
  // dentro de cada pago): se leen las dos, sin repetir.
  const seen = new Set();
  const refunds = [...(order?.transactions?.refunds || []), ...payments.flatMap(payment => payment?.refunds || [])]
    .filter(refund => refund?.id != null && !seen.has(String(refund.id)) && seen.add(String(refund.id)));
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
    // La orden de un pago (merchant order) no es la orden que guarda el
    // intento: el intento se encuentra por nuestra referencia.
    providerOrderId: null,
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
export function resourceRequest(type, id, accessToken, apiBase = API_BASE) {
  const safe = encodeURIComponent(String(id || ''));
  if (!safe) return null;
  if (type === 'order') return { url: `${apiBase}/v1/orders/${safe}`, read: readOrder, accessToken };
  if (type === 'payment') return { url: `${apiBase}/v1/payments/${safe}`, read: readPayment, accessToken };
  return null;
}
