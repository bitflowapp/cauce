// Código QR en SVG, generado en el navegador (sin servicios externos).
import qrcode from 'qrcode-generator';

export function qrSvg(text, { label = 'Código QR' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) if (qr.isDark(y, x)) path += `M${x} ${y}h1v1h-1z`;
  }
  return `<svg viewBox="-2 -2 ${count + 4} ${count + 4}" role="img" aria-label="${label.replace(/"/g, '')}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${count + 4}" height="${count + 4}" fill="#fff"/><path d="${path}" fill="#3b2218"/></svg>`;
}
