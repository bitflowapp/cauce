// Enlaces externos: indicaciones para llegar, WhatsApp y compartir. Sin mapas
// embebidos ni scripts de terceros (la CSP no los permite).
/** @typedef {{ latitude?: number|string|null, longitude?: number|string|null, address?: string, venue?: string, locality?: string }} Place */
/** @param {Place} [place] */
export function directionsUrl({ latitude, longitude, address = '', venue = '', locality = '' } = {}) {
  const destination = latitude != null && longitude != null && latitude !== '' && longitude !== ''
    ? `${Number(latitude)},${Number(longitude)}`
    : [venue, address, locality, 'Argentina'].filter(Boolean).join(', ');
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

/** @param {Place} [place] */
export function mapUrl({ latitude, longitude, address = '', venue = '', locality = '' } = {}) {
  if (latitude != null && longitude != null && latitude !== '' && longitude !== '') {
    const lat = Number(latitude); const lng = Number(longitude);
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  }
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent([venue, address, locality].filter(Boolean).join(', '))}`;
}

export const whatsappUrl = (number, text = '') => {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return '';
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
};

export const instagramUrl = handle => (handle ? `https://www.instagram.com/${encodeURIComponent(handle)}/` : '');
export const telUrl = phone => (phone ? `tel:${String(phone).replace(/[^0-9+]/g, '')}` : '');
