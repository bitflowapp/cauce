// Personajes vectoriales de CAUCE · Aluminé.
// El lenguaje toma del material de marca el trazo negro redondeado, las
// proporciones compactas, el halo blanco y los pequeños gestos de movimiento.
// Son recursos decorativos: la información operativa siempre permanece en HTML.

const OUTLINE = '#111817';
const FOREST = '#143d34';
const BLUE = '#1d4e73';
const SAND = '#f3eadb';

function svgShell(name, size, className, body, viewBox = '0 0 180 150') {
  const cls = className ? `brand-character brand-character-${name} ${className}` : `brand-character brand-character-${name}`;
  return `<svg class="${cls}" width="${size}" height="${Math.round(size * 0.83)}" viewBox="${viewBox}" fill="none" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function renderCharacter(name, size = 120, className = '') {
  switch (name) {
    case 'shopper':
      return svgShell(name, size, className, `
        <path d="M24 112c10-12 19-18 31-19 6-24 20-39 42-45 10-20 31-25 46-12 11 10 9 27-1 37 11 10 16 24 15 40-1 19-15 27-34 22l-28-7-21 13c-20 11-41-8-29-25-9 5-17 3-21-4Z" fill="#fff" stroke="#fff" stroke-width="13" stroke-linejoin="round"/>
        <path d="M111 35c8-8 22-7 29 2 6 9 4 21-5 27-9 6-21 4-27-5-5-8-4-17 3-24Z" fill="#fff" stroke="${OUTLINE}" stroke-width="6"/>
        <path d="M108 40c6-15 29-17 38-4l-8 8c-8-5-18-4-28 2Z" fill="${OUTLINE}" stroke="${OUTLINE}" stroke-width="5" stroke-linejoin="round"/>
        <circle cx="128" cy="49" r="2.5" fill="${OUTLINE}"/><path d="M128 57c4 3 8 2 10-1" stroke="${OUTLINE}" stroke-width="3" stroke-linecap="round"/>
        <path d="M103 67c10-5 25 1 29 11l7 21-34 10-14-29c-3-6 5-10 12-13Z" fill="${FOREST}" stroke="${OUTLINE}" stroke-width="6" stroke-linejoin="round"/>
        <path d="M95 74 77 88 61 82" stroke="${OUTLINE}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M126 78 142 87 151 75" stroke="${OUTLINE}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M145 73h22l-3 31h-24l5-31Z" fill="#fff" stroke="${OUTLINE}" stroke-width="5" stroke-linejoin="round"/><path d="M149 73c0-8 4-12 9-12s8 4 8 12" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round"/>
        <path d="m107 106-22 17-25-2M122 107l12 22 27 5" stroke="${OUTLINE}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M47 122h17M157 135h14" stroke="${OUTLINE}" stroke-width="8" stroke-linecap="round"/>
        <path d="M28 81h20M20 92h18M36 68l13 5" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round"/>
      `);
    case 'courier':
      return svgShell(name, size, className, `
        <path d="M17 112c0-19 15-35 34-35h14l16-19c7-9 18-14 29-13 13-20 44-12 45 12 14 8 17 30 5 42 13 25-18 43-37 27H52c-20 12-40-1-40-18 0-7 2-12 5-16Z" fill="#fff" stroke="#fff" stroke-width="13" stroke-linejoin="round"/>
        <circle class="brand-wheel brand-wheel-back" cx="42" cy="113" r="17" fill="#fff" stroke="${OUTLINE}" stroke-width="6"/><circle cx="42" cy="113" r="6" fill="${FOREST}"/>
        <circle class="brand-wheel brand-wheel-front" cx="143" cy="113" r="17" fill="#fff" stroke="${OUTLINE}" stroke-width="6"/><circle cx="143" cy="113" r="6" fill="${FOREST}"/>
        <path d="M42 113h42l18-25h28l13 25M105 88l7-35h-16" stroke="${OUTLINE}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M70 93h36l-11 22H71c-9 0-14-11-8-18l7-4Z" fill="${FOREST}" stroke="${OUTLINE}" stroke-width="6" stroke-linejoin="round"/>
        <rect x="20" y="63" width="42" height="37" rx="7" fill="${SAND}" stroke="${OUTLINE}" stroke-width="6"/><path d="M20 76h42M35 69h12" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round"/>
        <circle cx="101" cy="38" r="15" fill="#fff" stroke="${OUTLINE}" stroke-width="6"/><path d="M87 35c3-16 21-23 33-10l-4 11c-8-5-18-6-29-1Z" fill="${OUTLINE}"/>
        <circle cx="107" cy="41" r="2.3" fill="${OUTLINE}"/><path d="M106 48c4 3 8 2 10-1" stroke="${OUTLINE}" stroke-width="3" stroke-linecap="round"/>
        <path d="M89 54c10-5 22 0 26 10l8 23-27 6-18-24c-5-7 3-12 11-15Z" fill="${BLUE}" stroke="${OUTLINE}" stroke-width="6" stroke-linejoin="round"/>
        <path d="m111 62 16 13 16-3" stroke="${OUTLINE}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M5 72h13M2 83h12M8 94h10" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round"/>
      `);
    case 'taxi-driver':
      return svgShell(name, size, className, `
        <path d="M16 105c2-18 14-29 32-34l18-27c7-11 18-16 31-16h28c13 0 22 7 29 19l13 24c10 5 15 14 15 27v13c0 13-10 23-23 23H39c-17 0-29-13-27-29Z" fill="#fff" stroke="#fff" stroke-width="13" stroke-linejoin="round"/>
        <path d="M29 76h121c13 0 23 10 23 23v17H18V96c0-11 5-17 11-20Z" fill="#fff" stroke="${OUTLINE}" stroke-width="6" stroke-linejoin="round"/>
        <path d="m51 76 20-31c5-7 12-11 21-11h29c8 0 14 4 18 11l18 31H51Z" fill="${BLUE}" stroke="${OUTLINE}" stroke-width="6" stroke-linejoin="round"/>
        <path d="M101 35v41" stroke="${OUTLINE}" stroke-width="5"/><path d="M61 69h36l-2-28c-10 0-16 3-21 10L61 69Z" fill="#edf5fa"/>
        <circle cx="119" cy="53" r="10" fill="#fff" stroke="${OUTLINE}" stroke-width="4"/><path d="M109 51c2-9 12-14 20-7l-2 8c-7-4-12-4-18-1Z" fill="${OUTLINE}"/><circle cx="122" cy="54" r="1.7" fill="${OUTLINE}"/>
        <rect x="91" y="18" width="34" height="16" rx="6" fill="${FOREST}" stroke="${OUTLINE}" stroke-width="5"/><path d="M100 26h16" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
        <circle class="brand-wheel brand-wheel-back" cx="49" cy="116" r="17" fill="${OUTLINE}"/><circle cx="49" cy="116" r="6" fill="#fff"/>
        <circle class="brand-wheel brand-wheel-front" cx="146" cy="116" r="17" fill="${OUTLINE}"/><circle cx="146" cy="116" r="6" fill="#fff"/>
        <path d="M27 92h22M151 92h16" stroke="${FOREST}" stroke-width="7" stroke-linecap="round"/><path d="M72 91h47" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round"/>
        <path d="M3 69h17M8 58h18" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round"/>
      `);
    case 'merchant':
      return svgShell(name, size, className, `
        <path d="M42 128c-16-18-7-42 8-53-5-18 6-35 24-39 6-25 43-30 56-7 20 6 29 28 19 45 13 17 4 46-18 52-23 6-67 17-89 2Z" fill="#fff" stroke="#fff" stroke-width="13" stroke-linejoin="round"/>
        <circle cx="94" cy="38" r="18" fill="#fff" stroke="${OUTLINE}" stroke-width="6"/><path d="M77 36c2-20 25-28 40-13l-4 13c-13-7-23-7-36 0Z" fill="${OUTLINE}"/><circle cx="101" cy="41" r="2.4" fill="${OUTLINE}"/><path d="M97 48c5 3 9 2 12-2" stroke="${OUTLINE}" stroke-width="3" stroke-linecap="round"/>
        <path d="M66 61c14-8 39-8 54 1l9 65H58l8-66Z" fill="${FOREST}" stroke="${OUTLINE}" stroke-width="6" stroke-linejoin="round"/>
        <path d="M73 62v55M113 62v55" stroke="#fff" stroke-width="4"/><rect x="76" y="82" width="34" height="24" rx="5" fill="#fff" stroke="${OUTLINE}" stroke-width="5"/>
        <path d="M64 72 42 85M121 73l21 11" stroke="${OUTLINE}" stroke-width="7" stroke-linecap="round"/>
        <path d="M38 82h28v24H38z" fill="${SAND}" stroke="${OUTLINE}" stroke-width="5" stroke-linejoin="round"/><path d="M49 82v24M38 91h28" stroke="${OUTLINE}" stroke-width="3"/>
        <path d="M139 82h25v21h-25z" fill="#fff" stroke="${OUTLINE}" stroke-width="5" stroke-linejoin="round"/><path d="M144 82c0-7 3-11 8-11s8 4 8 11" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round"/>
      `);
    case 'search':
      return svgShell(name, size, className, `
        <path d="M38 126c-16-14-10-38 5-50-7-20 4-38 23-44 10-25 44-27 58-7 21 4 32 24 24 43 20 13 17 45-4 57-22 12-86 15-106 1Z" fill="#fff" stroke="#fff" stroke-width="13" stroke-linejoin="round"/>
        <circle cx="89" cy="38" r="18" fill="#fff" stroke="${OUTLINE}" stroke-width="6"/><path d="M72 35c5-20 29-26 42-10l-6 12c-13-8-23-8-36-2Z" fill="${OUTLINE}"/><circle cx="97" cy="41" r="2.5" fill="${OUTLINE}"/><path d="M93 48c5 3 9 1 11-2" stroke="${OUTLINE}" stroke-width="3" stroke-linecap="round"/>
        <path d="M64 61c12-7 32-7 43 1l11 62H55l9-63Z" fill="${BLUE}" stroke="${OUTLINE}" stroke-width="6" stroke-linejoin="round"/>
        <path d="M65 70 43 91M107 70l18 12" stroke="${OUTLINE}" stroke-width="7" stroke-linecap="round"/>
        <rect x="117" y="72" width="25" height="38" rx="5" fill="#fff" stroke="${OUTLINE}" stroke-width="5"/><path d="M125 79h9" stroke="${FOREST}" stroke-width="3" stroke-linecap="round"/>
        <circle cx="44" cy="92" r="16" fill="#fff" stroke="${OUTLINE}" stroke-width="6"/><path d="m55 104 15 15" stroke="${OUTLINE}" stroke-width="7" stroke-linecap="round"/>
        <path d="M29 57h17M25 68h12" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round"/>
      `);
    case 'celebrate':
      return svgShell(name, size, className, `
        <path d="M40 127c-15-17-8-42 7-53-4-20 10-38 30-41 9-24 44-25 56-3 18 6 26 25 18 42 18 15 12 44-9 55-20 10-83 15-102 0Z" fill="#fff" stroke="#fff" stroke-width="13" stroke-linejoin="round"/>
        <circle cx="91" cy="40" r="18" fill="#fff" stroke="${OUTLINE}" stroke-width="6"/><path d="M74 38c3-20 28-28 43-12l-5 13c-13-8-25-8-38-1Z" fill="${OUTLINE}"/><path d="M83 41c2 2 4 2 6 0M99 41c2 2 4 2 6 0M89 49c6 6 13 5 17-1" stroke="${OUTLINE}" stroke-width="3" stroke-linecap="round"/>
        <path d="M64 65c14-8 38-8 53 1l9 61H55l9-62Z" fill="${FOREST}" stroke="${OUTLINE}" stroke-width="6" stroke-linejoin="round"/>
        <path d="M66 73 45 51M115 73l23-23" stroke="${OUTLINE}" stroke-width="7" stroke-linecap="round"/>
        <path d="M31 28h30v29H31z" fill="${SAND}" stroke="${OUTLINE}" stroke-width="5" stroke-linejoin="round"/><path d="M42 28v29M31 38h30" stroke="${OUTLINE}" stroke-width="3"/>
        <path d="m138 37 4-9 4 9 10 4-10 4-4 10-4-10-9-4 9-4ZM34 75l3-7 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" fill="${BLUE}"/>
      `);
    default:
      return '';
  }
}
