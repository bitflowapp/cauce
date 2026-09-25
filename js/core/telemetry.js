// Observabilidad mínima: distingue errores de interfaz, de Supabase, de sesión,
// pedidos fallidos y operaciones críticas. Nunca registra contraseñas, tokens,
// correos ni teléfonos: todo texto pasa por `scrub` antes de salir.
export const EVENT_KINDS = Object.freeze(['frontend_error', 'supabase_error', 'auth_error', 'order_failed', 'critical']);

/** @type {Array<[RegExp, string]>} */
const PATTERNS = [
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]'],
  [/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[token]'],
  [/(access_token|refresh_token|token_hash|code|apikey|password)=([^&\s#]+)/gi, '$1=[oculto]'],
  [/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[correo]'],
  [/\+?\d[\d\s()-]{6,}\d/g, '[número]'],
];

export function scrub(value, max = 300) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text.slice(0, max);
}

// Sólo la ruta, sin identificadores largos ni parámetros.
export function scrubRoute(hash = '') {
  return String(hash).split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').slice(0, 80);
}

export function classify(error, fallback = 'frontend_error') {
  const code = String(error?.code || '');
  if (/^(invalid_credentials|email_not_confirmed|session_|refresh_token|otp_|user_banned|weak_password|SESSION_)/i.test(code)
    || error?.name === 'AuthApiError' || error?.name === 'AuthRetryableFetchError') return 'auth_error';
  if (/^(PGRST|[0-9]{5}$|U000)/.test(code) || code === 'SUPABASE_UNAVAILABLE') return 'supabase_error';
  return EVENT_KINDS.includes(fallback) ? fallback : 'frontend_error';
}

/**
 * @param {{ send?: (event: object) => Promise<unknown>, release?: string, route?: () => string,
 *   now?: () => number, console?: Console, limit?: number }} options
 */
export function createTelemetry({ send = null, release = '', route = () => '', now = () => Date.now(),
  console: sink = globalThis.console, limit = 20 } = {}) {
  const recent = new Map();
  const sent = [];
  const events = [];

  function record(kind, error, context = {}) {
    const event = {
      kind: EVENT_KINDS.includes(kind) ? kind : 'frontend_error',
      code: scrub(error?.code || error?.name || 'ERROR', 60),
      message: scrub(error?.message || error, 300),
      route: scrubRoute(route()),
      release: String(release || '').slice(0, 40),
      context: Object.fromEntries(Object.entries(context || {})
        .filter(([key]) => /^[a-zA-Z_]{1,40}$/.test(key))
        .slice(0, 10)
        .map(([key, value]) => [key, scrub(value, 120)])),
    };
    events.push(event);
    if (events.length > 50) events.shift();
    // Consola siempre, para quien depura; al servidor, con techo y sin repetir.
    sink?.warn?.(`[CAUCE:${event.kind}] ${event.code} ${event.message}`);
    const key = `${event.kind}|${event.code}|${event.message}`;
    const at = now();
    if (recent.has(key) && at - recent.get(key) < 60000) return event;
    recent.set(key, at);
    while (sent.length && at - sent[0] > 60000) sent.shift();
    if (!send || sent.length >= limit) return event;
    sent.push(at);
    Promise.resolve().then(() => send(event)).catch(() => { /* reportar nunca rompe la app */ });
    return event;
  }

  return Object.freeze({
    record,
    error: (error, context) => record(classify(error), error, context),
    orderFailed: (error, context) => record('order_failed', error, context),
    critical: (error, context) => record('critical', error, context),
    events: () => events.slice(),
  });
}
