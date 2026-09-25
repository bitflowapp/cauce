// Receptor de webhooks de pagos. SÓLO SERVIDOR.
//
// Reglas:
//   · HTTPS y POST; sin firma válida, 401 y no se anota nada (un webhook falso
//     no deja rastro ni cambia estados);
//   · rápido: se anota la notificación y se responde 200 enseguida; la lectura
//     del recurso y la reconciliación corren después (`after`);
//   · idempotente: la misma notificación dos veces se anota una sola vez y la
//     segunda no hace nada;
//   · la verdad sale de leer el recurso en la API del proveedor con la cuenta
//     del vendedor que avisa, nunca del cuerpo del webhook ni de la URL de
//     retorno del navegador;
//   · tolerante a reintentos: cualquier error al reconciliar deja la
//     notificación anotada como fallida y el proveedor puede volver a avisar.
//
// Todo lo externo llega inyectado (deps), para poder probarlo sin red.
import { verifySignature } from './signature.js';
import { resourceRequest, PROVIDER } from './mercadopago.js';

const MAX_BODY = 64 * 1024;
const HANDLED = new Set(['order', 'payment']);

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Clave estable de una notificación: el id que asigna el proveedor si viene;
// si no, el recurso, la acción y el id del envío.
export async function eventKey({ type, notificationId, dataId, action, requestId }) {
  const base = notificationId
    ? `${PROVIDER}|${type}|${notificationId}`
    : `${PROVIDER}|${type}|${dataId}|${action}|${requestId}`;
  return sha256Hex(base);
}

const reply = (status, body) => ({ status, body });

/**
 * @param {{ method: string, url: string, headers: { get(name: string): string|null }, text(): Promise<string> }} request
 * @param {{ secret: string, recordEvent: Function, credentialsForSeller: Function, fetchJson: Function,
 *   applyUpdate: Function, markEvent: Function, toleranceSeconds?: number|null, now?: () => number }} deps
 */
export async function handleWebhook(request, deps) {
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return reply(400, { error: 'https_required' });
  }
  if (!deps.secret) return reply(503, { error: 'not_configured' });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply(413, { error: 'too_large' });
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { error: 'invalid_json' }); }
  const dataId = url.searchParams.get('data.id') || (body?.data?.id != null ? String(body.data.id) : '');
  const type = String(url.searchParams.get('type') || url.searchParams.get('topic') || body?.type || '');
  const requestId = request.headers.get('x-request-id') || '';
  const check = await verifySignature({ signature: request.headers.get('x-signature'), requestId, dataId,
    secret: deps.secret, now: deps.now ? deps.now() : Date.now(), toleranceSeconds: deps.toleranceSeconds ?? null });
  if (!check.valid) return reply(401, { error: 'invalid_signature' });
  // Temas que CAUCE no usa: se reconocen para que el proveedor no reintente.
  if (!HANDLED.has(type) || !dataId) return reply(200, { received: true, ignored: true });

  const action = String(body?.action || '');
  const key = await eventKey({ type, notificationId: body?.id != null ? String(body.id) : '', dataId, action, requestId });
  const event = await deps.recordEvent({ provider: PROVIDER, key, type, resourceId: dataId, action,
    liveMode: typeof body?.live_mode === 'boolean' ? body.live_mode : null });
  if (event.duplicate) return reply(200, { received: true, duplicate: true });

  const sellerId = body?.user_id != null ? String(body.user_id) : '';
  const after = async () => {
    try {
      const credentials = sellerId ? await deps.credentialsForSeller(sellerId) : null;
      if (!credentials) {
        await deps.markEvent(event.eventId, 'ignored', 'Vendedor sin cuenta conectada');
        return { outcome: 'ignored' };
      }
      const target = resourceRequest(type, dataId, credentials.accessToken);
      const resource = await deps.fetchJson(target.url, target.accessToken);
      const read = target.read(resource);
      if (!read.status) {
        await deps.markEvent(event.eventId, 'ignored', `Estado sin traducir: ${String(resource?.status || '').slice(0, 40)}`);
        return { outcome: 'ignored' };
      }
      if (!read.attemptReference && !read.providerOrderId) {
        await deps.markEvent(event.eventId, 'ignored', 'Sin referencia de CAUCE');
        return { outcome: 'ignored' };
      }
      return await deps.applyUpdate({ provider: PROVIDER, sellerId, attemptReference: read.attemptReference,
        providerOrderId: read.providerOrderId, status: read.status, statusDetail: read.statusDetail,
        paidAmount: read.paidAmount, transactions: read.transactions, eventId: event.eventId });
    } catch (error) {
      await deps.markEvent(event.eventId, 'failed', String(error?.message || 'Error al reconciliar').slice(0, 200));
      return { outcome: 'failed' };
    }
  };
  return { status: 200, body: { received: true }, after };
}
