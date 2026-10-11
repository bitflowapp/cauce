// Sofía, el personaje de CAUCE · Ferias, en SVG original.
//
// Dibujada a partir de la dirección de arte de la referencia de diseño (no de
// una fotografía): cabello largo oscuro con raya al medio, ojos cerrados que
// sonríen, mejillas rosadas, sonrisa amplia, buzo coral sobre remera rosa y un
// contorno blanco grueso tipo sticker. Todas las escenas comparten la misma
// cabeza, pelo y torso para que las proporciones no cambien entre poses.
// Su uso público o comercial requiere la autorización de Sofía (ver
// docs/PERSONAJE.md). Son recursos decorativos: el texto importante siempre
// está en HTML.

const INK = '#3b2218';
const SKIN = '#d4925f';
const SKIN_SHADE = '#b97447';
const CHEEK = '#ee7a69';
const HAIR = '#2f1a13';
const HAIR_LIGHT = '#5e3324';
const TOP = '#ec6a3d';
const TOP_SHADE = '#c9502c';
const INNER = '#f47a95';
const CREAM = '#fbeee0';
const KRAFT = '#e7c19a';
const KRAFT_SHADE = '#c99a6c';
const TERRA = '#b5432a';
const ORANGE = '#ee4a12';
const PINK = '#f2557e';
const OLIVE = '#6a5d24';

let counter = 0;
const line = (width = 2.4) => `stroke="${INK}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

// ── piezas compartidas (coordenadas de un busto de 200 × 200) ──
const hairBack = () => `
  <path class="s-hair-back" d="M100 16c-31 0-50 21-51 52-1 24-9 43-19 63-11 22-10 45 5 60 6 6 15 9 24 9h82c9 0 18-3 24-9 15-15 16-38 5-60-10-20-18-39-19-63-1-31-20-52-51-52Z" fill="${HAIR}" ${line(2.2)}/>
  <path d="M34 176c-8 6-10 16-6 24h14M166 176c8 6 10 16 6 24h-14" fill="${HAIR}" ${line(2.2)}/>
  <path d="M60 96c-4 22-14 38-20 58M140 96c4 22 14 38 20 58M68 124c-5 18-9 34-7 52M132 124c5 18 9 34 7 52M52 150c-4 10-5 20-3 30M148 150c4 10 5 20 3 30" stroke="${HAIR_LIGHT}" stroke-width="2" stroke-linecap="round" fill="none"/>`;

const torso = () => `
  <path d="M91 94v20c0 6 4 9 9 9s9-3 9-9V94Z" fill="${SKIN}" ${line(2.2)}/>
  <path d="M91 100c5 4 13 4 18 0" stroke="${SKIN_SHADE}" stroke-width="4" stroke-linecap="round" fill="none" opacity=".5"/>
  <path class="s-torso" d="M38 200c1-32 14-60 38-72 7-3 15-5 24-5s17 2 24 5c24 12 37 40 38 72Z" fill="${TOP}" ${line(2.4)}/>
  <path d="M84 125l16 25 16-25c-5-2-10-2-16-2s-11 0-16 2Z" fill="${INNER}" ${line(2.2)}/>
  <path d="M58 172c2-12 6-22 12-29M142 172c-2-12-6-22-12-29" stroke="${TOP_SHADE}" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;

// Mechones que caen por delante de los hombros.
const hairFront = () => `
  <path d="M64 72c-3 24-6 46-15 70-5 13-4 27 4 37 2-16 9-31 15-45 7-16 7-38 7-56Z" fill="${HAIR}" ${line(2.2)}/>
  <path d="M136 72c3 24 6 46 15 70 5 13 4 27-4 37-2-16-9-31-15-45-7-16-7-38-7-56Z" fill="${HAIR}" ${line(2.2)}/>
  <path d="M58 120c-3 12-6 24-6 36M142 120c3 12 6 24 6 36" stroke="${HAIR_LIGHT}" stroke-width="1.8" stroke-linecap="round" fill="none"/>`;

function face({ eyes = 'happy', mouth = 'grin' } = {}) {
  const eyesSvg = eyes === 'open'
    ? `<ellipse cx="85" cy="66" rx="3.2" ry="4.2" fill="${INK}"/><ellipse cx="115" cy="66" rx="3.2" ry="4.2" fill="${INK}"/>
       <circle cx="86" cy="64.5" r="1.1" fill="#fff"/><circle cx="116" cy="64.5" r="1.1" fill="#fff"/>`
    : `<path d="M78 67c3-6 11-6 14 0M108 67c3-6 11-6 14 0" ${line(2.6)} fill="none"/>
       <path d="M77 65l-3-2M123 65l3-2" ${line(1.8)} fill="none"/>`;
  const mouthSvg = mouth === 'smile'
    ? `<path d="M90 85c5 5 15 5 20 0" ${line(2.4)} fill="none"/>`
    : `<path d="M84 83c2 12 9 18 16 18s14-6 16-18Z" fill="#7d2b22" ${line(2.2)}/>
       <path d="M85.5 84.5h29c-1 3-2 5-3 6h-23c-1-1-2-3-3-6Z" fill="#fff"/>
       <path d="M93 96c4-3 10-3 14 0-2 3-5 4-7 4s-5-1-7-4Z" fill="#e8706a"/>`;
  return `
  <path class="s-face" d="M67 62c0-24 14-35 33-35s33 11 33 35c0 25-14 40-33 40S67 87 67 62Z" fill="${SKIN}" ${line(2.4)}/>
  <ellipse cx="79" cy="78" rx="7" ry="4.5" fill="${CHEEK}" opacity=".6"/>
  <ellipse cx="121" cy="78" rx="7" ry="4.5" fill="${CHEEK}" opacity=".6"/>
  <path d="M78 56c4-3 9-3 13-1M109 55c4-2 9-2 13 1" ${line(2.2)} fill="none"/>
  ${eyesSvg}
  <path d="M99 71c-1 3-2 6 1 7" ${line(2)} fill="none"/>
  ${mouthSvg}`;
}

// Capa de pelo de arriba: raya al medio y cortina hacia los costados.
const hairTop = () => `
  <path d="M100 23c-8 8-18 17-24 30-4 9-6 21-7 35-6-8-10-19-10-31 0-22 17-37 41-37Z" fill="${HAIR}" ${line(2.2)}/>
  <path d="M100 23c8 8 18 17 24 30 4 9 6 21 7 35 6-8 10-19 10-31 0-22-17-37-41-37Z" fill="${HAIR}" ${line(2.2)}/>
  <path d="M86 32c-7 7-11 15-13 26M114 32c7 7 11 15 13 26M78 30c-6 5-10 12-12 20" stroke="${HAIR_LIGHT}" stroke-width="1.8" stroke-linecap="round" fill="none"/>`;

const head = options => `<g class="s-head" transform="translate(100 66) scale(1.05) translate(-100 -66)">${face(options)}${hairTop()}</g>`;

const hand = (x, y, rotate = 0, open = true) => `
  <g transform="translate(${x} ${y}) rotate(${rotate})">
    ${open
    ? `<path d="M-9 6c-2-8-2-16 0-22 1-3 5-3 5 0v10c0-6 0-12 2-14 1-3 5-2 5 1v12c0-6 1-11 3-13 2-2 5-1 5 2v13c1-4 2-8 4-9 2-1 4 0 4 3-1 8-2 14-5 19-3 5-8 7-13 7s-9-3-10-9Z" fill="${SKIN}" ${line(2.1)}/>
       <path d="M-9 4c-3-2-6-6-6-9 0-2 3-3 5-1l3 4" fill="${SKIN}" ${line(2.1)}/>`
    : `<path d="M-10-6c0-5 4-8 10-8s11 3 11 9v8c0 6-5 10-11 10S-10 9-10 3Z" fill="${SKIN}" ${line(2.1)}/>
       <path d="M-4-7v6M2-8v6M7-6v5" ${line(1.6)} fill="none"/>`}
  </g>`;

const sleeve = d => `<path d="${d}" fill="${TOP}" ${line(2.4)}/>`;

const motion = (x, y, color = PINK, flip = false) => `
  <g class="s-motion" transform="translate(${x} ${y})${flip ? ' scale(-1 1)' : ''}">
    <path d="M0 0l8-6M3 10l10-2M-2-11l5-8" stroke="${color}" stroke-width="3.2" stroke-linecap="round"/>
  </g>`;

const sparkle = (x, y, color = ORANGE, size = 1) => `
  <path class="s-spark" transform="translate(${x} ${y}) scale(${size})" d="M0-9 2.4-2.4 9 0 2.4 2.4 0 9-2.4 2.4-9 0-2.4-2.4Z" fill="${color}"/>`;

const bust = (options, extraBack = '', extraFront = '') => `
  ${hairBack()}${extraBack}${torso()}${hairFront()}${head(options)}${extraFront}`;

// ── escenas ──
const SCENES = {
  // 1. Bienvenida: saluda con la mano.
  bienvenida: {
    viewBox: '20 0 200 200',
    label: 'Sofía saluda con la mano',
    body: () => bust({}, '', `
      <g class="s-wave">
        ${sleeve('M136 146c10-8 17-22 20-40l14 2c-2 22-9 38-22 50Z')}
        <path d="M152 108c4 1 9 2 14 2" stroke="${TOP_SHADE}" stroke-width="2.4" stroke-linecap="round"/>
        ${hand(163, 92, 8)}
      </g>
      ${motion(186, 70, PINK)}`),
  },
  // 2. Producto artesanal: modela una pieza de cerámica.
  creando: {
    viewBox: '0 0 220 200',
    label: 'Sofía modela una pieza de cerámica',
    body: () => bust({}, '', `
      <rect x="18" y="168" width="184" height="30" rx="8" fill="${KRAFT}" ${line(2.4)}/>
      <g class="s-pot">
        <ellipse cx="110" cy="168" rx="34" ry="7" fill="${KRAFT_SHADE}" ${line(2.2)}/>
        <path d="M84 166c-4-14 0-28 10-34h32c10 6 14 20 10 34Z" fill="#d8875a" ${line(2.4)}/>
        <path d="M94 132c4 3 28 3 32 0" ${line(2)} fill="none"/>
        <path d="M92 150c8 4 28 4 36 0" stroke="#f3c7a4" stroke-width="3" stroke-linecap="round" fill="none"/>
      </g>
      ${sleeve('M62 170c4-16 12-28 24-32l8 14c-8 4-14 12-16 22Z')}
      ${sleeve('M158 170c-4-16-12-28-24-32l-8 14c8 4 14 12 16 22Z')}
      ${hand(86, 150, -70, false)}${hand(134, 150, 70, false)}
      <rect x="28" y="152" width="22" height="16" rx="3" fill="${CREAM}" ${line(2.2)}/>
      <path d="M170 152h24l-3 16h-18Z" fill="${CREAM}" ${line(2.2)}/>
      <g class="s-spin"><path d="M60 122c-6 4-9 10-9 16M162 122c6 4 9 10 9 16" stroke="${ORANGE}" stroke-width="3" stroke-linecap="round" fill="none"/></g>
      ${sparkle(46, 104, PINK, .8)}`),
  },
  // 3. Ferias: recorre un puesto con su bolsa.
  explorando: {
    viewBox: '10 0 220 200',
    label: 'Sofía recorre la feria con su bolsa',
    body: () => bust({}, '', `
      <g class="s-bag">
        <path d="M44 128c0-12 6-20 14-20s14 8 14 20" ${line(3)} fill="none"/>
        <path d="M34 128h48l6 70H28Z" fill="${CREAM}" ${line(2.4)}/>
        <path d="M46 160c4-8 20-8 24 0-4 8-20 8-24 0Z" fill="none" stroke="${TERRA}" stroke-width="2.4"/>
        <path d="M52 158c2-5 10-5 12 0" stroke="${TERRA}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      </g>
      ${sleeve('M136 148c10-6 18-18 20-34l14 3c-2 20-10 34-24 42Z')}
      ${hand(162, 102, -6, false)}
      <g class="s-find">
        <path d="M170 86c0-8 10-12 15-5 5-7 15-3 15 5 0 9-15 17-15 17s-15-8-15-17Z" fill="${PINK}" ${line(2.2)}/>
      </g>
      ${sparkle(206, 70, ORANGE, .8)}`),
  },
  // 4. Pedido recibido: prepara un paquete.
  preparando: {
    viewBox: '10 0 220 200',
    label: 'Sofía prepara un paquete',
    body: () => bust({}, '', `
      <g class="s-box">
        <path d="M58 134h108l8 64H50Z" fill="${KRAFT}" ${line(2.4)}/>
        <path d="M50 134l12-18h100l12 18Z" fill="#f0d3b2" ${line(2.4)}/>
        <path d="M104 116v82" stroke="${PINK}" stroke-width="9"/>
        <path d="M104 116v82" stroke="${INK}" stroke-width="2" opacity=".0"/>
        <path d="M92 116c-6-14 8-20 12-6 4-14 18-8 12 6Z" fill="${PINK}" ${line(2.2)}/>
        <path d="M70 160h20M70 168h14" stroke="${KRAFT_SHADE}" stroke-width="3" stroke-linecap="round"/>
      </g>
      ${hand(58, 162, -90, false)}${hand(170, 162, 90, false)}
      ${sparkle(196, 112, ORANGE, .8)}${sparkle(30, 120, PINK, .7)}`),
  },
  // 5. Compra confirmada: celebra.
  celebrando: {
    viewBox: '0 0 220 200',
    label: 'Sofía celebra la compra confirmada',
    body: () => bust({}, '', `
      ${sleeve('M66 146c-10-8-16-24-16-42l-14 1c0 24 8 42 22 52Z')}
      ${sleeve('M154 146c10-8 16-24 16-42l14 1c0 24-8 42-22 52Z')}
      ${hand(42, 94, -14)}${hand(178, 94, 14)}
      <g class="s-confetti">
        ${sparkle(24, 60, ORANGE, 1.1)}${sparkle(196, 50, PINK, 1)}${sparkle(40, 24, PINK, .7)}${sparkle(176, 20, ORANGE, .7)}
        <circle cx="62" cy="36" r="4" fill="${OLIVE}"/><circle cx="150" cy="34" r="3.5" fill="${TERRA}"/>
        <rect x="190" y="84" width="9" height="5" rx="2" fill="${ORANGE}" transform="rotate(30 194 86)"/>
        <rect x="16" y="96" width="9" height="5" rx="2" fill="${PINK}" transform="rotate(-25 20 98)"/>
      </g>`),
  },
  // 6. Carrito vacío: la bolsa espera.
  'carrito-vacio': {
    viewBox: '0 0 200 200',
    label: 'Bolsa de compras vacía',
    body: () => `
      <g class="s-empty">
        <path d="M70 70c0-22 12-36 30-36s30 14 30 36" stroke="${TERRA}" stroke-width="7" stroke-linecap="round" fill="none"/>
        <path d="M70 70c0-22 12-36 30-36s30 14 30 36" ${line(2.2)} fill="none" opacity=".35"/>
        <path d="M46 70h108l10 112H36Z" fill="${CREAM}" ${line(2.6)}/>
        <path d="M46 70h108l3 30H43Z" fill="#f6d9c5"/>
        <path d="M46 70h108l10 112H36Z" fill="none" ${line(2.6)}/>
        <path d="M84 126c4-4 8-4 12 0M104 126c4-4 8-4 12 0" ${line(2.4)} fill="none"/>
        <path d="M92 146c5-4 11-4 16 0" ${line(2.4)} fill="none"/>
      </g>
      <path class="s-dash" d="M24 60l10 6M18 88h12M176 60l-10 6M182 88h-12" stroke="${ORANGE}" stroke-width="3.4" stroke-linecap="round"/>`,
  },
  // 7. Búsqueda sin resultados: mira con la lupa.
  buscando: {
    viewBox: '10 0 220 200',
    label: 'Sofía busca con una lupa',
    body: () => bust({ eyes: 'open', mouth: 'smile' }, '', `
      ${sleeve('M136 148c10-8 14-20 14-36l14 1c1 20-5 36-18 44Z')}
      <g class="s-lens">
        <path d="M150 106l-14-16" stroke="#7a4a2f" stroke-width="8" stroke-linecap="round"/>
        <path d="M150 106l-14-16" ${line(2)} fill="none" opacity=".6"/>
        <circle cx="128" cy="72" r="20" fill="#ffffff" fill-opacity=".45" stroke="${TERRA}" stroke-width="7"/>
        <circle cx="128" cy="72" r="20" fill="none" ${line(2)} opacity=".5"/>
        <path d="M119 63c3-3 7-4 11-3" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
      </g>
      ${hand(156, 112, 20, false)}`),
  },
  // 8. Comunidad fundadora: sostiene el cartel.
  comunidad: {
    viewBox: '0 0 220 200',
    label: 'Sofía sostiene un cartel que dice Sumate a CAUCE',
    body: () => bust({}, '', `
      <g class="s-sign">
        <rect x="20" y="118" width="120" height="70" rx="10" fill="${CREAM}" ${line(2.6)}/>
        <rect x="27" y="125" width="106" height="56" rx="7" fill="none" stroke="${TERRA}" stroke-width="2.4"/>
        <text x="80" y="149" text-anchor="middle" font-family="'Lilita One', system-ui, sans-serif" font-size="20" fill="${TERRA}">SUMATE</text>
        <text x="80" y="173" text-anchor="middle" font-family="'Lilita One', system-ui, sans-serif" font-size="20" fill="${TERRA}">A CAUCE</text>
        ${hand(24, 150, -96, false)}
      </g>
      ${sleeve('M152 146c8-6 12-18 12-30l14 2c0 16-6 30-18 38Z')}
      ${hand(170, 106, 0, false)}
      ${sparkle(196, 72, ORANGE, .9)}${motion(30, 98, PINK, true)}`),
  },
  // Con la taza: presentación ("¡Hola! Descubrí lo que se crea cerca tuyo").
  taza: {
    viewBox: '20 0 200 200',
    label: 'Sofía sonríe con una taza artesanal',
    body: () => bust({}, '', `
      ${sleeve('M70 196c-4-14-2-30 8-40l14 10c-6 8-8 18-6 30Z')}
      ${sleeve('M130 196c4-14 2-30-8-40l-14 10c6 8 8 18 6 30Z')}
      <g class="s-mug">
        <path class="s-steam" d="M100 128c-6-6 6-10 0-18" stroke="#fff" stroke-width="7" stroke-linecap="round" fill="none"/>
        <path class="s-steam" d="M100 128c-6-6 6-10 0-18" stroke="${ORANGE}" stroke-width="3" stroke-linecap="round" fill="none"/>
        <path d="M128 148c10 0 14 6 14 12s-4 12-14 12" ${line(2.4)} fill="none" stroke-width="5"/>
        <path d="M76 140h52l-4 46c-1 6-5 10-11 10H91c-6 0-10-4-11-10Z" fill="${CREAM}" ${line(2.4)}/>
        <path d="M90 158c0-5 8-5 8 0s-7 6-8 1M108 168c0-5 8-5 8 0s-7 6-8 1M92 178c2-3 6-3 8 0" stroke="${TERRA}" stroke-width="2.2" stroke-linecap="round" fill="none"/>
      </g>
      ${hand(80, 168, -80, false)}${hand(126, 166, 80, false)}`),
  },
};

export const SCENE_NAMES = Object.freeze(Object.keys(SCENES));

/**
 * SVG de una escena de Sofía, con contorno blanco tipo sticker.
 * @param {string} name
 * @param {{ size?: number, className?: string, title?: string, animated?: boolean }} [options]
 */
export function sofia(name, { size = 160, className = '', title = '', animated = true } = {}) {
  const scene = SCENES[name] || SCENES.bienvenida;
  counter += 1;
  const id = `sofia-sticker-${counter}`;
  const [, , w, h] = scene.viewBox.split(' ').map(Number);
  const height = Math.round(size * (h / w));
  const label = title || scene.label;
  const cls = ['sofia', `sofia-${name}`, animated ? 'is-animated' : '', className].filter(Boolean).join(' ');
  // El halo blanco se arma dilatando la silueta: un solo contorno para toda la figura.
  return `<svg class="${cls}" width="${size}" height="${height}" viewBox="${scene.viewBox}" role="img" aria-label="${label}" focusable="false">
    <defs><filter id="${id}" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">
      <feMorphology in="SourceAlpha" operator="dilate" radius="5.5" result="grow"/>
      <feGaussianBlur in="grow" stdDeviation="2.4" result="soft"/>
      <feOffset in="soft" dy="2.5" result="drop"/>
      <feFlood flood-color="#7a3b22" flood-opacity=".18"/><feComposite in2="drop" operator="in" result="shadow"/>
      <feFlood flood-color="#ffffff"/><feComposite in2="grow" operator="in" result="halo"/>
      <feMerge><feMergeNode in="shadow"/><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter></defs>
    <g filter="url(#${id})">${scene.body()}</g>
  </svg>`;
}
