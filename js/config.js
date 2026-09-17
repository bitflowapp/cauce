/**
 * Configuración comercial para contacto directo vía WhatsApp.
 * Para habilitar el contacto directo en producción, ingresar aquí el número telefónico
 * en formato internacional sin signos '+' ni guiones (ejemplo: '5492942123456').
 * Si permanece vacío (''), la plataforma deriva la acción al formulario nativo de adhesión comercial.
 */
export const CAUCE_CONTACT_WHATSAPP = '5492996209136';

export const CONFIG = Object.freeze({
  name: 'CAUCE',
  edition: 'Aluminé',
  mode: 'demo',
  liveOrders: false,
  livePayments: false,
  defaultLocality: 'alumine',
  currency: 'ARS',
  locale: 'es-AR',
  contactWhatsApp: CAUCE_CONTACT_WHATSAPP,
});

/**
 * Genera el enlace seguro de WhatsApp con mensaje precargado si el número está configurado.
 * Retorna null si no hay número, permitiendo el fallback a modal de adhesión.
 *
 * @param {string} [phone] - Número telefónico opcional (por defecto usa CAUCE_CONTACT_WHATSAPP)
 * @returns {string|null} - URL de WhatsApp o null
 */
export function buildMerchantWhatsAppUrl(phone = CAUCE_CONTACT_WHATSAPP) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (!digits || digits.length < 8) return null;
  const message = 'Hola, vi CAUCE · Aluminé y me interesa conocer cómo podría sumar mi comercio.';
  const scheme = 'https:';
  return `${scheme}//wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
