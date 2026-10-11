// Personaje genérico de CAUCE · Ferias: un jarrito de barro con cara.
//
// Reemplaza a Sofía en los builds públicos mientras no exista su autorización
// escrita (docs/PERSONAJE.md). El build lo enchufa en lugar de js/ui/sofia.js
// cuando FERIAS_PERSONAJE=generico, así los dibujos de Sofía ni siquiera viajan
// en el bundle. Misma API y mismas escenas: ninguna pantalla cambia.

const INK = '#3b2218';
const CLAY = '#c8693f';
const CLAY_SHADE = '#a8512c';
const CHEEK = '#ee7a69';
const CREAM = '#fbeee0';
const KRAFT = '#e7c19a';
const KRAFT_SHADE = '#c99a6c';
const TERRA = '#b5432a';
const ORANGE = '#ee4a12';
const PINK = '#f2557e';
const OLIVE = '#6a5d24';

let counter = 0;
const line = (width = 2.4) => `stroke="${INK}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

function face({ eyes = 'happy', mouth = 'grin' } = {}) {
  const eyesSvg = eyes === 'open'
    ? `<ellipse cx="86" cy="106" rx="3.4" ry="4.4" fill="${INK}"/><ellipse cx="114" cy="106" rx="3.4" ry="4.4" fill="${INK}"/>`
    : `<path d="M79 107c3-6 11-6 14 0M107 107c3-6 11-6 14 0" ${line(2.6)} fill="none"/>`;
  const mouthSvg = mouth === 'smile'
    ? `<path d="M91 122c5 5 13 5 18 0" ${line(2.4)} fill="none"/>`
    : `<path d="M88 119c2 9 7 13 12 13s10-4 12-13Z" fill="#7d2b22" ${line(2.2)}/>`;
  return `<ellipse cx="78" cy="118" rx="7" ry="4.5" fill="${CHEEK}" opacity=".6"/>
    <ellipse cx="122" cy="118" rx="7" ry="4.5" fill="${CHEEK}" opacity=".6"/>${eyesSvg}${mouthSvg}`;
}

// Cuerpo del jarrito (busto de 200 × 200), con su asa a la derecha.
const pot = options => `
  <path d="M146 96c18 0 24 14 24 26s-8 26-26 26" fill="none" stroke="${CLAY_SHADE}" stroke-width="9" stroke-linecap="round"/>
  <path d="M146 96c18 0 24 14 24 26s-8 26-26 26" fill="none" ${line(2)} opacity=".5"/>
  <path class="s-torso" d="M60 70h80c4 0 7 3 6 7l-6 104c-1 9-8 15-17 15H77c-9 0-16-6-17-15L54 77c-1-4 2-7 6-7Z" fill="${CLAY}" ${line(2.6)}/>
  <path d="M52 62h96c5 0 8 4 8 8s-3 8-8 8H52c-5 0-8-4-8-8s3-8 8-8Z" fill="${CLAY_SHADE}" ${line(2.4)}/>
  <path d="M58 150h84l-1 14H59Z" fill="${CREAM}" opacity=".85"/>
  <path d="M68 157c4-4 8-4 12 0s8 4 12 0 8-4 12 0 8 4 12 0 8-4 12 0" stroke="${TERRA}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
  ${face(options)}`;

const arm = (x, y, rotate = 0) => `<g transform="translate(${x} ${y}) rotate(${rotate})">
  <path d="M0 0c6-2 14-2 20 0" stroke="${CLAY}" stroke-width="9" stroke-linecap="round"/>
  <circle cx="23" cy="0" r="7" fill="${CLAY}" ${line(2)}/></g>`;

const sparkle = (x, y, color = ORANGE, size = 1) => `
  <path class="s-spark" transform="translate(${x} ${y}) scale(${size})" d="M0-9 2.4-2.4 9 0 2.4 2.4 0 9-2.4 2.4-9 0-2.4-2.4Z" fill="${color}"/>`;

const SCENES = {
  bienvenida: {
    viewBox: '20 0 200 200', label: 'El jarrito de CAUCE saluda',
    body: () => `${pot()}<g class="s-wave">${arm(58, 104, 225)}</g>${sparkle(30, 50, PINK, .9)}`,
  },
  creando: {
    viewBox: '0 0 220 200', label: 'El jarrito de CAUCE modela una pieza de cerámica',
    body: () => `${pot()}<rect x="12" y="176" width="196" height="22" rx="8" fill="${KRAFT}" ${line(2.4)}/>
      <g class="s-pot"><path d="M160 174c-3-10 0-20 7-24h22c7 4 10 14 7 24Z" fill="#d8875a" ${line(2.2)}/></g>
      ${arm(146, 150, 20)}${sparkle(36, 120, PINK, .8)}`,
  },
  explorando: {
    viewBox: '10 0 220 200', label: 'El jarrito de CAUCE recorre la feria con su bolsa',
    body: () => `<g class="s-bag"><path d="M26 118c0-10 5-16 12-16s12 6 12 16" ${line(3)} fill="none"/>
      <path d="M18 118h40l5 58H13Z" fill="${CREAM}" ${line(2.4)}/></g>${pot()}${arm(54, 118, 200)}
      <g class="s-find"><path d="M176 70c0-8 10-12 15-5 5-7 15-3 15 5 0 9-15 17-15 17s-15-8-15-17Z" fill="${PINK}" ${line(2.2)}/></g>`,
  },
  preparando: {
    viewBox: '10 0 220 200', label: 'El jarrito de CAUCE prepara un paquete',
    body: () => `${pot()}<g class="s-box"><path d="M150 140h60l5 52h-70Z" fill="${KRAFT}" ${line(2.4)}/>
      <path d="M180 140v52" stroke="${PINK}" stroke-width="7"/><path d="M160 166h12" stroke="${KRAFT_SHADE}" stroke-width="3" stroke-linecap="round"/></g>
      ${arm(142, 150, 10)}${sparkle(40, 60, ORANGE, .8)}`,
  },
  celebrando: {
    viewBox: '0 0 220 200', label: 'El jarrito de CAUCE celebra la compra confirmada',
    body: () => `${pot()}${arm(58, 92, 220)}${arm(150, 92, -40)}
      <g class="s-confetti">${sparkle(24, 60, ORANGE, 1.1)}${sparkle(196, 46, PINK, 1)}${sparkle(48, 22, PINK, .7)}
        <circle cx="160" cy="28" r="4" fill="${OLIVE}"/><circle cx="70" cy="40" r="3.5" fill="${TERRA}"/></g>`,
  },
  'carrito-vacio': {
    viewBox: '0 0 200 200', label: 'Bolsa de compras vacía',
    body: () => `<g class="s-empty"><path d="M70 70c0-22 12-36 30-36s30 14 30 36" stroke="${TERRA}" stroke-width="7" stroke-linecap="round" fill="none"/>
      <path d="M46 70h108l10 112H36Z" fill="${CREAM}" ${line(2.6)}/>
      <path d="M84 126c4-4 8-4 12 0M104 126c4-4 8-4 12 0" ${line(2.4)} fill="none"/><path d="M92 146c5-4 11-4 16 0" ${line(2.4)} fill="none"/></g>
      <path class="s-dash" d="M24 60l10 6M18 88h12M176 60l-10 6M182 88h-12" stroke="${ORANGE}" stroke-width="3.4" stroke-linecap="round"/>`,
  },
  buscando: {
    viewBox: '10 0 220 200', label: 'El jarrito de CAUCE busca con una lupa',
    body: () => `${pot({ eyes: 'open', mouth: 'smile' })}${arm(144, 120, -30)}
      <g class="s-lens"><path d="M166 106l10-14" stroke="#7a4a2f" stroke-width="8" stroke-linecap="round"/>
        <circle cx="186" cy="76" r="16" fill="#ffffff" fill-opacity=".45" stroke="${TERRA}" stroke-width="6"/></g>`,
  },
  comunidad: {
    viewBox: '0 0 220 200', label: 'El jarrito de CAUCE sostiene un cartel que dice Sumate a CAUCE',
    body: () => `${pot()}<g class="s-sign"><rect x="140" y="20" width="76" height="52" rx="8" fill="${CREAM}" ${line(2.4)}/>
        <text x="178" y="42" text-anchor="middle" font-family="'Lilita One', system-ui, sans-serif" font-size="14" fill="${TERRA}">SUMATE</text>
        <text x="178" y="61" text-anchor="middle" font-family="'Lilita One', system-ui, sans-serif" font-size="14" fill="${TERRA}">A CAUCE</text>
        <path d="M168 72v26" ${line(3)}/></g>${arm(140, 104, -20)}${sparkle(30, 60, ORANGE, .9)}`,
  },
  taza: {
    viewBox: '20 0 200 200', label: 'El jarrito de CAUCE echa vapor',
    body: () => `${pot()}<path class="s-steam" d="M92 52c-6-6 6-10 0-18M110 50c-6-6 6-10 0-18" stroke="${ORANGE}" stroke-width="3" stroke-linecap="round" fill="none"/>`,
  },
};

export const SCENE_NAMES = Object.freeze(Object.keys(SCENES));

/**
 * SVG de una escena del personaje genérico (misma firma que el de Sofía).
 * @param {string} name
 * @param {{ size?: number, className?: string, title?: string, animated?: boolean }} [options]
 */
export function sofia(name, { size = 160, className = '', title = '', animated = true } = {}) {
  const scene = SCENES[name] || SCENES.bienvenida;
  counter += 1;
  const id = `personaje-sticker-${counter}`;
  const [, , w, h] = scene.viewBox.split(' ').map(Number);
  const height = Math.round(size * (h / w));
  const label = title || scene.label;
  const cls = ['sofia', 'personaje-generico', `sofia-${name}`, animated ? 'is-animated' : '', className].filter(Boolean).join(' ');
  return `<svg class="${cls}" width="${size}" height="${height}" viewBox="${scene.viewBox}" role="img" aria-label="${label}" focusable="false">
    <defs><filter id="${id}" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">
      <feMorphology in="SourceAlpha" operator="dilate" radius="5.5" result="grow"/>
      <feFlood flood-color="#ffffff"/><feComposite in2="grow" operator="in" result="halo"/>
      <feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter></defs>
    <g filter="url(#${id})">${scene.body()}</g>
  </svg>`;
}
