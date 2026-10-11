// Ilustraciones originales para los datos de DEMOSTRACIÓN (no son fotos de
// productos reales): cada pieza se dibuja en SVG con la paleta de CAUCE y se
// convierte a JPG al sembrar. Sirven para mostrar la interfaz completa sin
// usar imágenes de terceros.
const table = (tone = '#9c6b4a') => `
  <rect y="430" width="600" height="170" fill="${tone}"/>
  <path d="M0 470c120-8 240 6 360-2s180 4 240 0M0 530c140 6 260-6 380 2s160-4 220 0" stroke="#000" stroke-opacity=".08" stroke-width="6" fill="none"/>`;
const shadow = (cx = 300, w = 170) => `<ellipse cx="${cx}" cy="452" rx="${w}" ry="22" fill="#3b2218" opacity=".18"/>`;
const backdrop = (a, b) => `<defs><radialGradient id="bg" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient></defs><rect width="600" height="600" fill="url(#bg)"/>`;
const speckles = (x, y, w, h, color = '#7a4a2f', n = 40, seed = 7) => {
  let s = seed; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  return Array.from({ length: n }, () => `<circle cx="${(x + rnd() * w).toFixed(1)}" cy="${(y + rnd() * h).toFixed(1)}" r="${(1 + rnd() * 2).toFixed(1)}" fill="${color}" opacity=".35"/>`).join('');
};
const mountains = (x, y, s = 1, color = '#b5432a') => `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
  <path d="M0 60 40 8l22 26 18-18 40 44"/><path d="M28 24l10 10 6-8M78 24l8 10"/></g>`;
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">${body}</svg>`;

export const PRODUCT_ART = {
  taza: () => svg(`${backdrop('#f6e2cf', '#d9a27c')}${table()}
    <rect x="70" y="400" width="460" height="56" rx="10" fill="#e9c9a6"/><path d="M80 420h440M80 440h440" stroke="#c99a6c" stroke-width="3" stroke-dasharray="10 8"/>
    ${shadow()}<path d="M395 270c60 0 70 40 70 60s-14 66-74 62" fill="none" stroke="#efe3d3" stroke-width="30"/>
    <path d="M190 200h220v190c0 40-30 62-62 62h-96c-32 0-62-22-62-62z" fill="#f3e7d8"/>
    <path d="M190 360h220v30c0 40-30 62-62 62h-96c-32 0-62-22-62-62z" fill="#b5532f"/>
    ${speckles(195, 205, 210, 150)}${mountains(215, 250, 1.4)}
    <ellipse cx="300" cy="200" rx="110" ry="18" fill="#e7d6c2"/>`),
  cuenco: () => svg(`${backdrop('#f4dccb', '#cf9a77')}${table('#8f5f42')}${shadow(300, 190)}
    <path d="M110 250h380c0 120-80 205-190 205S110 370 110 250z" fill="#f2e6d6"/>
    <path d="M130 345c40 70 100 110 170 110s130-40 170-110z" fill="#c25a2e"/>
    ${speckles(130, 255, 340, 90)}${mountains(170, 268, 1.2)}${mountains(310, 272, 1.1)}
    <ellipse cx="300" cy="250" rx="190" ry="34" fill="#e3d0bb"/><ellipse cx="300" cy="254" rx="160" ry="22" fill="#d5bea6"/>`),
  'set-tazas': () => svg(`${backdrop('#f5dfce', '#d4a07e')}${table()}
    ${[[170, 260, 1], [330, 230, 1.1], [420, 300, .9]].map(([x, y, s]) => `<g transform="translate(${x} ${y}) scale(${s})">${shadow(0, 70)}
      <path d="M-60 0h120v110c0 26-20 40-42 40h-36c-22 0-42-14-42-40z" fill="#f1e5d5"/><path d="M-60 80h120v30c0 26-20 40-42 40h-36c-22 0-42-14-42-40z" fill="#bb5a33"/>
      ${speckles(-55, 5, 110, 70)}${mountains(-44, 20, .75)}<ellipse cx="0" cy="0" rx="60" ry="12" fill="#e2d1bc"/></g>`).join('')}`),
  plato: () => svg(`${backdrop('#f6e4d4', '#d6a585')}${table('#946447')}${shadow(300, 220)}
    <ellipse cx="300" cy="330" rx="230" ry="120" fill="#f3e8da"/><ellipse cx="300" cy="320" rx="170" ry="84" fill="#eadbc8"/>
    <ellipse cx="300" cy="320" rx="150" ry="70" fill="none" stroke="#b5432a" stroke-width="6" stroke-dasharray="4 14"/>
    <path d="M220 320c30-30 50-30 80 0s50 30 80 0" fill="none" stroke="#ee4a12" stroke-width="6" stroke-linecap="round"/>`),
  maceta: () => svg(`${backdrop('#eef0dc', '#b8b38a')}${table('#8a6a4b')}${shadow(300, 140)}
    <path d="M300 250c-40-90-120-110-150-90 30 10 70 40 110 100M300 250c30-100 110-130 150-110-36 10-80 50-120 110M300 250c0-80 20-140 60-160-10 40-30 100-50 170" fill="#6a7d3a" stroke="#4f5f28" stroke-width="4"/>
    <path d="M200 250h200l-26 200H226z" fill="#2f7d86"/><rect x="190" y="240" width="220" height="34" rx="8" fill="#3b95a0"/>
    ${speckles(205, 280, 190, 160, '#ffffff', 40, 3)}`),
  macrame: () => svg(`${backdrop('#f3eadf', '#cdb79c')}
    <path d="M300 30v110" stroke="#c9a77f" stroke-width="8"/><circle cx="300" cy="30" r="16" fill="none" stroke="#a37b52" stroke-width="7"/>
    ${[-50, -18, 18, 50].map((dx, i) => `<path d="M300 140c${dx} 40 ${dx * 2.2} 120 ${dx * 2.6} 230" stroke="#e8d5b9" stroke-width="9" fill="none"/>
      <circle cx="${300 + dx * 1.2}" cy="${210 + (i % 2) * 20}" r="10" fill="#d9c09d"/>`).join('')}
    <path d="M190 360h220l-24 150H214z" fill="#c85f36"/><rect x="180" y="350" width="240" height="30" rx="8" fill="#d97a4a"/>
    <path d="M300 352c-30-50-80-60-100-50 30 0 60 20 90 50M300 352c30-60 90-70 110-56-30 2-70 24-100 56" fill="#6a7d3a"/>`),
  mate: () => svg(`${backdrop('#f1dcc6', '#c79466')}${table('#7e5236')}${shadow(300, 130)}
    <path d="M365 90l-50 170" stroke="#c9ccd1" stroke-width="12" stroke-linecap="round"/><path d="M365 90l-50 170" stroke="#9aa0a6" stroke-width="4"/>
    <path d="M300 200c90 0 130 70 130 140s-50 110-130 110-130-40-130-110 40-140 130-140z" fill="#8b4f2c"/>
    <ellipse cx="300" cy="205" rx="80" ry="22" fill="#5b3420"/><path d="M230 210c20 10 120 10 140 0" stroke="#c99a6c" stroke-width="6" fill="none"/>
    <g fill="none" stroke="#d9a37a" stroke-width="5" stroke-linecap="round"><circle cx="300" cy="330" r="16"/><circle cx="300" cy="330" r="36"/><circle cx="300" cy="330" r="58"/>
    <path d="M200 300c20-10 30 10 44 0M356 300c20-10 30 10 44 0M210 380c16 8 28-8 40 0M350 380c16 8 28-8 40 0"/></g>`),
  aros: () => svg(`${backdrop('#f4e6d6', '#d7b391')}
    <rect y="420" width="600" height="180" fill="#c9a07a"/>${speckles(0, 420, 600, 180, '#7a4a2f', 60, 11)}
    ${[210, 390].map((x, i) => `<g transform="translate(${x} ${i ? 120 : 110})"><path d="M0 0c-30 0-30 60 0 60" fill="none" stroke="#a8a8a8" stroke-width="5"/>
      <g transform="translate(0 150)">${[0, 72, 144, 216, 288].map(a => `<ellipse rx="34" ry="52" transform="rotate(${a}) translate(0 -48)" fill="#fbf6ee" stroke="#e7dccd" stroke-width="3"/>`).join('')}
      <circle r="24" fill="#ee8a2a"/><circle r="24" fill="none" stroke="#c96a12" stroke-width="3"/></g><path d="M0 60v40" stroke="#a8a8a8" stroke-width="4"/></g>`).join('')}`),
  collar: () => svg(`${backdrop('#f1e2d2', '#cfa98a')}<rect y="430" width="600" height="170" fill="#b98a66"/>
    <path d="M120 140c40 260 320 260 360 0" fill="none" stroke="#7a4a2f" stroke-width="4"/>
    ${Array.from({ length: 13 }, (_, i) => { const t = i / 12; const x = 120 + 360 * t; const y = 140 + 4 * 200 * t * (1 - t) * 1.1; return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${i === 6 ? 26 : 14}" fill="${['#b5432a', '#6a5d24', '#f2557e', '#e9c9a6'][i % 4]}"/>`; }).join('')}`),
  pulsera: () => svg(`${backdrop('#f3e5d7', '#d3ad8e')}${table('#a37552')}${shadow(300, 150)}
    <ellipse cx="300" cy="330" rx="150" ry="70" fill="none" stroke="#ee4a12" stroke-width="30"/>
    <ellipse cx="300" cy="330" rx="150" ry="70" fill="none" stroke="#f2557e" stroke-width="30" stroke-dasharray="20 22"/>
    <ellipse cx="300" cy="330" rx="150" ry="70" fill="none" stroke="#fff" stroke-width="4" stroke-dasharray="6 10" opacity=".7"/>`),
  bolso: () => svg(`${backdrop('#efe2d2', '#c6a07c')}
    <path d="M210 230c0-90 40-130 90-130s90 40 90 130" fill="none" stroke="#a87c4f" stroke-width="18"/>
    <path d="M150 230h300l26 300H124z" fill="#d9b88a"/>
    ${Array.from({ length: 14 }, (_, i) => `<path d="M${140 + i * 2} ${250 + i * 20}h${320 - i * 4}" stroke="${i > 7 && i < 11 ? '#6b3e22' : i === 11 ? '#c08a3e' : '#c7a273'}" stroke-width="${i > 7 && i < 12 ? 16 : 8}" stroke-dasharray="6 5"/>`).join('')}`),
  posavasos: () => svg(`${backdrop('#f4e7d8', '#cfae8f')}${table('#8f6243')}
    ${[[200, 330, -8, '#b5432a'], [300, 300, 6, '#ee4a12'], [400, 340, -4, '#6a5d24'], [300, 380, 2, '#f2557e']].map(([x, y, r, c]) => `<g transform="translate(${x} ${y}) rotate(${r})">
      <rect x="-80" y="-80" width="160" height="160" rx="10" fill="${c}"/>${Array.from({ length: 7 }, (_, i) => `<path d="M-70 ${-60 + i * 20}h140" stroke="#fff" stroke-opacity=".35" stroke-width="5" stroke-dasharray="8 6"/>`).join('')}</g>`).join('')}`),
  manta: () => svg(`${backdrop('#f2e4d4', '#c9a481')}
    <path d="M80 160h440v320H80z" fill="#e9d2b0"/>
    ${Array.from({ length: 8 }, (_, i) => `<rect x="80" y="${170 + i * 38}" width="440" height="${i % 3 === 1 ? 22 : 10}" fill="${['#b5432a', '#6a5d24', '#ee4a12', '#3b2218'][i % 4]}" opacity=".85"/>`).join('')}
    ${Array.from({ length: 22 }, (_, i) => `<path d="M${90 + i * 20} 480v30" stroke="#d9bf98" stroke-width="5"/>`).join('')}`),
  vela: () => svg(`${backdrop('#f3e3d1', '#c99a72')}${table('#9a6a49')}${shadow(300, 120)}
    <path d="M300 120c-26 40-14 70 0 76 14-6 26-36 0-76z" fill="#ffb347"/><path d="M300 150c-10 18-6 34 0 38 6-4 10-20 0-38z" fill="#fff3c4"/>
    <path d="M300 196v26" stroke="#3b2218" stroke-width="4"/>
    <rect x="200" y="220" width="200" height="230" rx="26" fill="#f6efe2" opacity=".95"/><rect x="200" y="220" width="200" height="40" rx="20" fill="#efe1c9"/>
    <rect x="222" y="300" width="156" height="90" rx="10" fill="#fffaf2" stroke="#d6c3a5" stroke-width="3"/>
    <text x="300" y="352" text-anchor="middle" font-family="Georgia, serif" font-size="26" fill="#6a5d24">soja</text>`),
  difusor: () => svg(`${backdrop('#eef0e2', '#b9b08d')}${table('#87684b')}${shadow(300, 90)}
    <path d="M300 120l-20 160M300 120l20 160M300 120l-50 150M300 120l50 150" stroke="#5a3c2e" stroke-width="5"/>
    <path d="M240 290h120l14 160H226z" fill="#a8c3b0" opacity=".9"/><rect x="262" y="250" width="76" height="44" rx="8" fill="#3b2218"/>`),
  billetera: () => svg(`${backdrop('#f1ddc9', '#c08f66')}${table('#7a4e33')}${shadow(300, 170)}
    <rect x="140" y="210" width="320" height="220" rx="22" fill="#8a4b28"/><rect x="140" y="210" width="320" height="220" rx="22" fill="none" stroke="#e7c9a2" stroke-width="4" stroke-dasharray="10 9" transform="translate(0 0)"/>
    <path d="M140 300h320" stroke="#6e3a1e" stroke-width="6"/><circle cx="300" cy="300" r="14" fill="#d6a85f"/>`),
  dulce: () => svg(`${backdrop('#f7e2d6', '#d49a86')}${table('#8f5f42')}${shadow(300, 120)}
    <rect x="210" y="210" width="180" height="240" rx="26" fill="#b02a3a"/><rect x="210" y="210" width="180" height="240" rx="26" fill="url(#bg)" opacity=".15"/>
    <path d="M196 190h208l-14 40H210z" fill="#f3e4cf"/><path d="M196 190h208" stroke="#b5432a" stroke-width="6" stroke-dasharray="10 8"/>
    <rect x="230" y="290" width="140" height="80" rx="10" fill="#fffaf2"/><text x="300" y="338" text-anchor="middle" font-family="Georgia, serif" font-size="22" fill="#6a5d24">mosqueta</text>
    ${[[150, 430], [450, 440], [420, 410]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="18" ry="22" fill="#d9442e"/>`).join('')}`),
  cuadro: () => svg(`${backdrop('#f2e7da', '#cdb89e')}
    <rect x="110" y="110" width="380" height="380" fill="#6e4a33"/><rect x="134" y="134" width="332" height="332" fill="#fdf5ea"/>
    <rect x="150" y="150" width="300" height="300" fill="#f7c9a3"/><circle cx="380" cy="220" r="34" fill="#ee4a12"/>
    <path d="M150 380l70-120 50 70 40-50 90 100v70H150z" fill="#6a5d24"/><path d="M150 410c60-20 120 10 180-6s90 8 120 0v46H150z" fill="#2f7d86"/>`),
};

export function logoArt(initial, color, accent, motif = 'leaf') {
  const motifs = {
    leaf: `<path d="M150 230c-40-60-30-120 10-150 10 50 40 90 30 150" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round"/>
      <path d="M150 230c30-40 70-50 90-40-10 30-50 50-90 40zM150 180c-30-30-70-30-86-16 14 26 54 34 86 16z" fill="${accent}"/>`,
    pot: `<path d="M95 140h110l-14 90h-82z" fill="${accent}"/><rect x="88" y="128" width="124" height="22" rx="8" fill="${accent}"/><path d="M120 165h60" stroke="#fff" stroke-width="6" opacity=".6"/>`,
    flower: [0, 72, 144, 216, 288].map(a => `<ellipse cx="150" cy="150" rx="22" ry="40" transform="rotate(${a} 150 150) translate(0 -40)" fill="${accent}"/>`).join('') + `<circle cx="150" cy="150" r="22" fill="#fff"/>`,
    loom: Array.from({ length: 6 }, (_, i) => `<path d="M90 ${100 + i * 20}h120" stroke="${i % 2 ? '#fff' : accent}" stroke-width="12" stroke-linecap="round"/>`).join(''),
    gourd: `<path d="M150 90c50 0 70 50 70 90s-30 60-70 60-70-20-70-60 20-90 70-90z" fill="${accent}"/><path d="M175 60l-20 60" stroke="#fff" stroke-width="8" stroke-linecap="round"/>`,
    flame: `<path d="M150 80c-50 70-30 140 0 150 30-10 50-80 0-150z" fill="${accent}"/><path d="M150 140c-16 30-8 60 0 64 8-4 16-34 0-64z" fill="#fff6d8"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"><rect width="300" height="300" fill="${color}"/>
    <circle cx="150" cy="150" r="118" fill="#fffaf2" opacity=".18"/>${motifs[motif] || motifs.leaf}
    <text x="150" y="282" text-anchor="middle" font-family="Georgia, serif" font-size="34" fill="#fffaf2" opacity=".9">${initial}</text></svg>`;
}

export function coverArt(product, colorA, colorB) {
  const inner = (PRODUCT_ART[product] || PRODUCT_ART.taza)().replace(/^<svg[^>]*>|<\/svg>$/g, '').replace('id="bg"', 'id="bg2"').replace('url(#bg)', 'url(#bg2)');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400" width="1200" height="400">
    <rect width="1200" height="400" fill="${colorA}"/>
    ${Array.from({ length: 12 }, (_, i) => `<rect x="${i * 100}" width="50" height="400" fill="${colorB}" opacity=".35"/>`).join('')}
    <g transform="translate(330 -60) scale(.9)">${inner}</g>
    <g transform="translate(-40 40) scale(.55)" opacity=".9">${inner}</g>
    <g transform="translate(880 60) scale(.55)" opacity=".9">${inner}</g></svg>`;
}

export function fairCoverArt(hue = 0) {
  const palettes = [['#f7ddc4', '#b5432a', '#f2557e', '#6a5d24'], ['#e7efe9', '#2f7d86', '#ee4a12', '#b5432a']];
  const [sky, a, b, c] = palettes[hue % palettes.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 600" width="1200" height="600">
    <rect width="1200" height="600" fill="${sky}"/><circle cx="1000" cy="110" r="60" fill="#ee4a12" opacity=".8"/>
    <path d="M0 360c200-40 400-30 600 0s400 20 600-10v250H0z" fill="#d9b48c"/>
    ${[60, 330, 600, 870].map((x, i) => `<g transform="translate(${x} ${210 + (i % 2) * 24})">
      <path d="M0 80 135 20l135 60z" fill="${[a, b, c, a][i]}"/><path d="M0 80h270v26c-22 18-45 18-67 0-22 18-45 18-67 0-22 18-45 18-68 0-22 18-45 18-68 0z" fill="${[b, '#fbe5da', b, c][i]}"/>
      <rect x="16" y="106" width="10" height="150" fill="#5a3c2e"/><rect x="244" y="106" width="10" height="150" fill="#5a3c2e"/>
      <rect x="28" y="190" width="214" height="56" rx="8" fill="#fffbf6"/>
      <circle cx="70" cy="180" r="18" fill="${a}"/><rect x="110" y="160" width="36" height="34" rx="6" fill="${c}"/><circle cx="196" cy="176" r="22" fill="${b}"/></g>`).join('')}
    ${Array.from({ length: 9 }, (_, i) => `<g transform="translate(${80 + i * 130} ${470 + (i % 3) * 18})"><circle r="16" fill="#5a3c2e"/><rect x="-18" y="16" width="36" height="58" rx="14" fill="${[a, b, c][i % 3]}"/></g>`).join('')}
  </svg>`;
}
