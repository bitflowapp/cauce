// Facturación electrónica (docs/CONTRATO-FACTURACION-ARCA.md): SÓLO la lógica
// que no es fiscal. Acá no hay comunicación con ARCA, ni certificados, ni
// claves, ni números de comprobante o CAE: eso vive en el servidor y un
// comprobante existe sólo si ARCA devolvió CAE. Estas reglas puras son las que
// la rama de facturación reutiliza en la interfaz y en el servicio.

// ── CUIT ──
// Prefijos de CUIT/CUIL vigentes y dígito verificador módulo 11.
const CUIT_PREFIXES = Object.freeze(['20', '23', '24', '25', '26', '27', '30', '33', '34']);
const CUIT_WEIGHTS = Object.freeze([5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);

export function normalizeCuit(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 11 ? digits : '';
}

export function cuitCheckDigit(first10) {
  const digits = String(first10 ?? '');
  if (!/^\d{10}$/.test(digits)) return null;
  const sum = CUIT_WEIGHTS.reduce((total, weight, index) => total + weight * Number(digits[index]), 0);
  const digit = 11 - (sum % 11);
  if (digit === 11) return 0;
  if (digit === 10) return null;
  return digit;
}

export function isValidCuit(value) {
  const cuit = normalizeCuit(value);
  if (!cuit || !CUIT_PREFIXES.includes(cuit.slice(0, 2))) return false;
  const digit = cuitCheckDigit(cuit.slice(0, 10));
  return digit !== null && digit === Number(cuit[10]);
}

export function formatCuit(value) {
  const cuit = normalizeCuit(value);
  return cuit ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit[10]}` : '';
}

// Para mostrar el perfil fiscal sin exponer el documento completo.
export function maskCuit(value) {
  const cuit = normalizeCuit(value);
  return cuit ? `${cuit.slice(0, 2)}-•••••${cuit.slice(7, 10)}-${cuit[10]}` : '';
}

// ── tipo de comprobante ──
// Códigos de ARCA (verificar con FEParamGetTiposCbte antes de producción).
export const VOUCHER_TYPES = Object.freeze({ 1: 'Factura A', 6: 'Factura B', 11: 'Factura C' });
export const TAX_CONDITIONS = Object.freeze(['monotributo', 'responsable_inscripto', 'exento']);

// Qué emite por defecto cada condición frente al IVA, para un consumidor final.
export function defaultVoucherType(condition) {
  if (condition === 'responsable_inscripto') return 6;
  if (condition === 'monotributo' || condition === 'exento') return 11;
  return null;
}

export const voucherLabel = type => VOUCHER_TYPES[Number(type)] || '';

// ── importes ──
// Salen SIEMPRE del pedido guardado (orders.total_ars), nunca del cliente. Con
// Factura C el total es neto, sin IVA discriminado. Factura A y B necesitan la
// alícuota de IVA de cada producto, que el catálogo todavía no tiene (§10.1):
// hasta entonces se rechaza en lugar de inventar un desglose.
export function invoiceAmounts(order, voucherType) {
  const total = Number(order?.total);
  if (!Number.isSafeInteger(total) || total <= 0) return { ok: false, reason: 'invalid_total' };
  if (Number(voucherType) !== 11) return { ok: false, reason: 'vat_rates_required' };
  return {
    ok: true,
    amounts: { neto: total, iva: 0, exento: 0, noGravado: 0, tributos: 0, total },
  };
}

// ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpIVA + ImpTrib, al centavo.
export function amountsConsistent(amounts) {
  if (!amounts) return false;
  const parts = ['neto', 'iva', 'exento', 'noGravado', 'tributos'].map(key => Math.round(Number(amounts[key]) * 100));
  return parts.every(Number.isFinite) && parts.reduce((sum, part) => sum + part, 0) === Math.round(Number(amounts.total) * 100);
}

// Renglones para la representación impresa (WSFEv1 no recibe el detalle).
export function invoiceDetail(order) {
  const lines = (order?.lines || []).map(line => ({ description: String(line.name || ''), quantity: Number(line.quantity) || 0,
    unitPrice: Number(line.unitPrice ?? (line.quantity ? line.total / line.quantity : 0)), total: Number(line.total) || 0 }));
  if (Number(order?.deliveryFee) > 0) {
    lines.push({ description: 'Envío', quantity: 1, unitPrice: Number(order.deliveryFee), total: Number(order.deliveryFee) });
  }
  return lines;
}

// ── quién y cuándo ──
/** @param {{ order?: any, profile?: any, role?: string, liveInvoice?: any }} [input] */
export function canRequestInvoice({ order, profile, role, liveInvoice = null } = {}) {
  if (!['owner', 'manager'].includes(role)) return { ok: false, reason: 'role' };
  if (order?.status !== 'delivered') return { ok: false, reason: 'not_delivered' };
  if (order?.paymentStatus !== 'settled') return { ok: false, reason: 'not_settled' };
  if (profile?.estado !== 'lista') return { ok: false, reason: 'profile_not_ready' };
  if (liveInvoice) return { ok: false, reason: 'already_invoiced' };
  return { ok: true };
}

// ── estados y reintentos ──
export const INVOICE_STATES = Object.freeze(['pendiente', 'enviando', 'autorizada', 'rechazada', 'error', 'incierta']);
// Estados "vivos": como mucho uno por pedido (índice único parcial en la base).
export const LIVE_STATES = Object.freeze(['pendiente', 'enviando', 'autorizada', 'incierta']);
const TRANSITIONS = Object.freeze({
  pendiente: ['enviando', 'error'],
  // Lo que devolvió ARCA, o sin respuesta después de enviar (incierta).
  enviando: ['autorizada', 'rechazada', 'incierta', 'error'],
  // Nunca se reenvía a ciegas: FECompConsultar decide.
  incierta: ['autorizada', 'pendiente'],
  error: ['pendiente'],
  rechazada: ['pendiente'],
  autorizada: [],
});

export function canTransitionInvoice(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export const isLiveInvoice = invoice => LIVE_STATES.includes(invoice?.estado);

// Escalonado ante ARCA caído antes de enviar; pasado el tope, acción humana.
export const RETRY_SCHEDULE_MINUTES = Object.freeze([1, 2, 5, 15, 60]);

export function nextRetryAt(attempt, now = Date.now()) {
  const minutes = RETRY_SCHEDULE_MINUTES[Number(attempt) - 1];
  return minutes ? new Date(now + minutes * 60000).toISOString() : null;
}

// ── lo que se muestra ──
export function formatVoucherNumber(pointOfSale, number) {
  const pos = Number(pointOfSale);
  const num = Number(number);
  if (!Number.isInteger(pos) || pos < 1 || pos > 99999 || !Number.isInteger(num) || num < 1 || num > 99999999) return '';
  return `${String(pos).padStart(4, '0')}-${String(num).padStart(8, '0')}`;
}

// Texto de la tarjeta según el estado. Una factura "autorizada" sin CAE,
// número o vencimiento no se muestra como factura: es un dato inconsistente.
export function invoiceStatusText(invoice, { timeText = value => String(value || '') } = {}) {
  switch (invoice?.estado) {
    case 'pendiente':
    case 'enviando':
      return { tone: 'busy', text: 'Emitiendo factura…' };
    case 'incierta':
      return { tone: 'busy', text: 'Confirmando con ARCA…' };
    case 'rechazada':
      return { tone: 'error', text: `ARCA rechazó la factura${invoice.ultimoError ? `: ${invoice.ultimoError}` : ''}.` };
    case 'error':
      return { tone: 'error', text: invoice.proximoIntentoAt
        ? `No pudimos conectar con ARCA. Reintentamos a las ${timeText(invoice.proximoIntentoAt)}.`
        : 'No pudimos conectar con ARCA. Reintentá cuando vuelva el servicio.' };
    case 'autorizada': {
      const number = formatVoucherNumber(invoice.puntoVenta, invoice.numero);
      if (!invoice.cae || !invoice.caeVencimiento || !number) return { tone: 'error', text: 'Comprobante incompleto: revisalo con soporte.' };
      return { tone: 'done', text: `${voucherLabel(invoice.tipo) || 'Comprobante'} ${number} · CAE ${invoice.cae}` };
    }
    default:
      return { tone: 'none', text: '' };
  }
}
