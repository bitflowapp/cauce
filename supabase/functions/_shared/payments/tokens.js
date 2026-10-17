// Tokens del vendedor vigentes, renovados del lado del servidor. SÓLO SERVIDOR.
//
// Cada vez que una función va a hablar con el proveedor en nombre de un
// comercio pide el token acá:
//   · si falta mucho para que venza, se usa el guardado;
//   · si vence dentro de la ventana (o ya venció), se renueva con el
//     refresh_token: el token nuevo se cifra y se guarda junto con su
//     vencimiento (payment_account_rotate) antes de usarlo;
//   · si el proveedor rechaza la renovación, la cuenta pasa a
//     reconnect_required y el pago online deja de ofrecerse para ese
//     comercio (el efectivo sigue);
//   · si el proveedor no responde, se sigue con el token guardado mientras
//     no haya vencido.
// Ningún token sale de esta función salvo hacia la llamada que lo necesita, y
// ninguno se escribe en un registro.
import { refreshRequest, parseTokenResponse } from './oauth.js';
import { openToken, sealToken } from './vault.js';

export const REFRESH_WINDOW_DAYS = 30;
const DAY = 24 * 3600 * 1000;

export class ReconnectRequired extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ReconnectRequired';
  }
}

const expiryOf = credentials => {
  const value = Date.parse(String(credentials?.expires_at || ''));
  return Number.isFinite(value) ? value : null;
};

/** ¿Hay que renovar este token ahora? */
export function refreshDue(credentials, { now = Date.now(), windowDays = REFRESH_WINDOW_DAYS } = {}) {
  const expiry = expiryOf(credentials);
  return expiry != null && expiry - now <= windowDays * DAY;
}

/**
 * Renueva el token de una cuenta y lo guarda cifrado. Devuelve el token nuevo.
 * @param {{ account_id: string, refresh_token_ciphertext?: string }} credentials
 * @param {{ clientId: string, clientSecret: string, keys: Record<number, CryptoKey>, current: number,
 *   apiBase?: string, fetch: typeof fetch, rotate: Function, markReconnect: Function, now?: number,
 *   timeoutMs?: number }} deps
 */
export async function refreshAccount(credentials, deps) {
  const now = deps.now ?? Date.now();
  if (!credentials?.refresh_token_ciphertext) {
    await deps.markReconnect('La cuenta no tiene renovación: hay que volver a conectarla.');
    throw new ReconnectRequired('no_refresh_token');
  }
  const refreshToken = await openToken(credentials.refresh_token_ciphertext, deps.keys);
  const call = refreshRequest({ clientId: deps.clientId, clientSecret: deps.clientSecret, refreshToken,
    apiBase: deps.apiBase });
  let response;
  try {
    response = await deps.fetch(call.url, { method: call.method, headers: call.headers,
      body: JSON.stringify(call.body), signal: AbortSignal.timeout(deps.timeoutMs ?? 10000) });
  } catch {
    throw new Error('refresh_unavailable');
  }
  // 400/401: el proveedor ya no acepta esta renovación (revocada o vencida).
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    await deps.markReconnect('El proveedor rechazó la renovación: hay que volver a conectar la cuenta.');
    throw new ReconnectRequired('refresh_rejected');
  }
  if (!response.ok) throw new Error('refresh_unavailable');
  const tokens = parseTokenResponse(await response.json(), now);
  const key = deps.keys[deps.current];
  await deps.rotate(credentials.account_id,
    await sealToken(tokens.accessToken, key, deps.current),
    tokens.refreshToken ? await sealToken(tokens.refreshToken, key, deps.current) : '',
    deps.current, tokens.expiresAt);
  return tokens.accessToken;
}

/**
 * Token vigente para llamar al proveedor en nombre de la cuenta.
 * @param {{ account_id: string, access_token_ciphertext: string, refresh_token_ciphertext?: string,
 *   expires_at?: string|null }} credentials
 * @param {Parameters<typeof refreshAccount>[1] & { windowDays?: number }} deps
 */
export async function freshAccessToken(credentials, deps) {
  const now = deps.now ?? Date.now();
  if (!refreshDue(credentials, { now, windowDays: deps.windowDays })) {
    return openToken(credentials.access_token_ciphertext, deps.keys);
  }
  try {
    return await refreshAccount(credentials, deps);
  } catch (error) {
    if (error instanceof ReconnectRequired) throw error;
    // El proveedor no respondió: mientras el token guardado siga vigente, se usa.
    const expiry = expiryOf(credentials);
    if (expiry != null && expiry > now) return openToken(credentials.access_token_ciphertext, deps.keys);
    await deps.markReconnect('El token venció y no se pudo renovar: hay que volver a conectar la cuenta.');
    throw new ReconnectRequired('expired');
  }
}
