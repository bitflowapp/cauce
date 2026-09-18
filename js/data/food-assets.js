// Ilustraciones visuales apetitosas y mapa temático de Aluminé.
// Creadas en SVG puro y autónomo: sin red, sin dependencias, 100% compatibles con CSP y bundle offline.

export function getProductSvg(dishType = 'burger') {
  switch (dishType) {
    case 'burger':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <radialGradient id="bunTop" cx="50%" cy="30%" r="60%"><stop offset="0%" stop-color="#f5c276"/><stop offset="100%" stop-color="#b86b24"/></radialGradient>
          <linearGradient id="patty" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5a2e1d"/><stop offset="100%" stop-color="#34190e"/></linearGradient>
          <linearGradient id="cheese" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffd53d"/><stop offset="100%" stop-color="#e69c10"/></linearGradient>
          <linearGradient id="lettuce" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6bb847"/><stop offset="100%" stop-color="#467e2a"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="106" rx="60" ry="10" fill="#2d3326" opacity="0.12"/>
        <path d="M30 52 C30 20, 130 20, 130 52 Z" fill="url(#bunTop)"/>
        <circle cx="56" cy="36" r="1.8" fill="#ffefa8"/><circle cx="74" cy="30" r="1.8" fill="#ffefa8"/><circle cx="92" cy="33" r="1.8" fill="#ffefa8"/><circle cx="106" cy="40" r="1.8" fill="#ffefa8"/><circle cx="65" cy="44" r="1.8" fill="#ffefa8"/><circle cx="85" cy="43" r="1.8" fill="#ffefa8"/>
        <path d="M26 50 Q40 58 55 52 Q70 60 85 51 Q100 59 115 52 Q125 58 134 50 Q125 45 26 50 Z" fill="url(#lettuce)"/>
        <path d="M34 56 C34 52, 126 52, 126 56 L124 64 C124 68, 36 68, 36 64 Z" fill="#d63428"/>
        <polygon points="32,62 128,62 120,73 95,81 80,67 52,80 40,68" fill="url(#cheese)"/>
        <rect x="28" y="66" width="104" height="20" rx="8" fill="url(#patty)"/>
        <path d="M36 86 C36 84, 124 84, 124 86 L120 102 C120 106, 40 106, 40 102 Z" fill="url(#bunTop)"/>
      </svg>`;

    case 'fries':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="fry" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#ffe678"/><stop offset="50%" stop-color="#f0b833"/><stop offset="100%" stop-color="#d48c17"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="106" rx="55" ry="9" fill="#2d3326" opacity="0.12"/>
        <path d="M48 45 L54 100 L106 100 L112 45 Z" fill="#b94a32"/>
        <path d="M44 45 L116 45 L110 52 L50 52 Z" fill="#d95d43"/>
        <rect x="52" y="15" width="8" height="42" rx="3" transform="rotate(-12 56 36)" fill="url(#fry)"/>
        <rect x="64" y="8" width="9" height="48" rx="3" transform="rotate(-5 68 32)" fill="url(#fry)"/>
        <rect x="76" y="6" width="9" height="50" rx="3" transform="rotate(3 80 31)" fill="url(#fry)"/>
        <rect x="88" y="10" width="8" height="46" rx="3" transform="rotate(9 92 33)" fill="url(#fry)"/>
        <rect x="99" y="18" width="8" height="38" rx="3" transform="rotate(18 103 37)" fill="url(#fry)"/>
        <circle cx="80" cy="74" r="16" fill="#fffaf2"/>
        <path d="M74 74 Q80 66 86 74 Q80 82 74 74" fill="#d95d43"/>
      </svg>`;

    case 'pizza':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <radialGradient id="crust" cx="50%" cy="50%" r="50%"><stop offset="60%" stop-color="#e29b47"/><stop offset="100%" stop-color="#a4551c"/></radialGradient>
          <radialGradient id="melt" cx="50%" cy="45%" r="45%"><stop offset="0%" stop-color="#fff1aa"/><stop offset="80%" stop-color="#ffce4a"/><stop offset="100%" stop-color="#df4324"/></radialGradient>
        </defs>
        <ellipse cx="80" cy="104" rx="66" ry="12" fill="#2d3326" opacity="0.12"/>
        <ellipse cx="80" cy="65" rx="68" ry="40" fill="url(#crust)"/>
        <ellipse cx="80" cy="65" rx="58" ry="32" fill="url(#melt)"/>
        <circle cx="60" cy="55" r="7" fill="#be281c"/><circle cx="95" cy="52" r="6.5" fill="#be281c"/><circle cx="78" cy="75" r="7.5" fill="#be281c"/><circle cx="108" cy="68" r="6" fill="#be281c"/><circle cx="50" cy="72" r="5.5" fill="#be281c"/>
        <ellipse cx="68" cy="60" rx="4" ry="2.5" fill="#2b2d24"/><ellipse cx="90" cy="68" rx="3.5" ry="2.5" fill="#2b2d24"/><ellipse cx="82" cy="48" rx="4" ry="2" fill="#2b2d24"/>
        <path d="M72 45 Q76 40 80 46 Q74 48 72 45" fill="#387a2a"/><path d="M88 78 Q93 72 98 77 Q92 80 88 78" fill="#387a2a"/><path d="M54 62 Q59 58 62 64 Q57 65 54 62" fill="#387a2a"/>
      </svg>`;

    case 'empanadas':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="empanada" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fadc8c"/><stop offset="60%" stop-color="#d9993d"/><stop offset="100%" stop-color="#9a5a17"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="104" rx="60" ry="10" fill="#2d3326" opacity="0.12"/>
        <path d="M25 80 C28 40, 115 35, 135 80 Q80 88 25 80 Z" fill="url(#empanada)"/>
        <path d="M26 80 Q32 68 38 74 Q44 63 52 70 Q60 59 69 67 Q78 57 88 65 Q98 56 108 65 Q118 58 126 69 Q132 65 135 80" fill="none" stroke="#7a3f0d" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="70" cy="58" rx="8" ry="4" fill="#b96d1d" opacity="0.4"/>
        <ellipse cx="95" cy="64" rx="7" ry="3.5" fill="#b96d1d" opacity="0.4"/>
      </svg>`;

    case 'milanesa':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <radialGradient id="mila" cx="45%" cy="45%" r="55%"><stop offset="0%" stop-color="#f0b65d"/><stop offset="70%" stop-color="#b87023"/><stop offset="100%" stop-color="#7a420b"/></radialGradient>
        </defs>
        <ellipse cx="80" cy="106" rx="65" ry="10" fill="#2d3326" opacity="0.12"/>
        <ellipse cx="78" cy="68" rx="60" ry="32" transform="rotate(-5 78 68)" fill="url(#mila)"/>
        <path d="M72 45 Q78 40 85 45 Q78 50 72 45" fill="#4b8332"/>
        <path d="M105 52 L125 45 L118 68 Z" fill="#ffe043"/><path d="M108 54 L121 49 L116 64 Z" fill="#fff7be"/>
        <ellipse cx="44" cy="76" rx="16" ry="12" fill="#fff4cf"/><ellipse cx="40" cy="74" rx="12" ry="9" fill="#ffec9e"/>
      </svg>`;

    case 'pasta':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="sauce" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#dc3e26"/><stop offset="100%" stop-color="#991f0d"/></linearGradient>
          <radialGradient id="pasta" cx="40%" cy="35%" r="60%"><stop offset="0%" stop-color="#fff0ad"/><stop offset="100%" stop-color="#e3b544"/></radialGradient>
        </defs>
        <ellipse cx="80" cy="106" rx="66" ry="11" fill="#2d3326" opacity="0.12"/>
        <ellipse cx="80" cy="70" rx="66" ry="34" fill="#faf6ed" stroke="#d5d0be" stroke-width="2"/>
        <ellipse cx="80" cy="70" rx="52" ry="24" fill="url(#sauce)"/>
        <ellipse cx="62" cy="66" rx="16" ry="11" fill="url(#pasta)"/>
        <ellipse cx="96" cy="66" rx="16" ry="11" fill="url(#pasta)"/>
        <ellipse cx="79" cy="74" rx="17" ry="12" fill="url(#pasta)"/>
        <path d="M76 60 Q80 54 86 60 Q80 64 76 60" fill="#327c26"/>
        <circle cx="68" cy="64" r="1.5" fill="#ffffff" opacity="0.8"/><circle cx="88" cy="72" r="1.5" fill="#ffffff" opacity="0.8"/><circle cx="94" cy="63" r="1.5" fill="#ffffff" opacity="0.8"/>
      </svg>`;

    case 'cafe':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="cup" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#e7ebe0"/><stop offset="50%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cfd5c5"/></linearGradient>
          <radialGradient id="crema" cx="45%" cy="40%" r="50%"><stop offset="0%" stop-color="#eed5ad"/><stop offset="60%" stop-color="#9f6633"/><stop offset="100%" stop-color="#4a2b11"/></radialGradient>
        </defs>
        <ellipse cx="80" cy="108" rx="55" ry="8" fill="#2d3326" opacity="0.12"/>
        <ellipse cx="80" cy="98" rx="46" ry="10" fill="#d9dfd0"/>
        <path d="M48 42 L56 90 C56 98, 104 98, 104 90 L112 42 Z" fill="url(#cup)"/>
        <ellipse cx="80" cy="42" rx="32" ry="11" fill="#e7ebe0"/>
        <ellipse cx="80" cy="42" rx="27" ry="8.5" fill="url(#crema)"/>
        <path d="M80 38 Q85 42 80 46 Q75 42 80 38 Z" fill="#fff7e6"/>
        <path d="M108 50 C122 50, 122 75, 105 76" fill="none" stroke="#cfd5c5" stroke-width="6" stroke-linecap="round"/>
        <path d="M72 26 Q76 18 70 12" fill="none" stroke="#c2cabb" stroke-width="2.5" stroke-linecap="round" opacity="0.6"/>
        <path d="M86 28 Q90 19 84 13" fill="none" stroke="#c2cabb" stroke-width="2.5" stroke-linecap="round" opacity="0.6"/>
      </svg>`;

    case 'medialuna':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="medialuna" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffe28a"/><stop offset="50%" stop-color="#e89d2c"/><stop offset="100%" stop-color="#9c5609"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="104" rx="58" ry="9" fill="#2d3326" opacity="0.12"/>
        <path d="M30 85 C36 45, 124 45, 130 85 C112 60, 48 60, 30 85 Z" fill="url(#medialuna)"/>
        <ellipse cx="80" cy="62" rx="16" ry="12" fill="#ffd469"/>
        <path d="M64 56 C68 49, 92 49, 96 56" fill="none" stroke="#8d4a04" stroke-width="2" opacity="0.5"/>
        <path d="M48 68 C54 58, 62 58, 66 68" fill="none" stroke="#8d4a04" stroke-width="2" opacity="0.5"/>
        <path d="M94 68 C98 58, 106 58, 112 68" fill="none" stroke="#8d4a04" stroke-width="2" opacity="0.5"/>
      </svg>`;

    case 'sandwich':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="bread" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#e8b269"/><stop offset="50%" stop-color="#f9d799"/><stop offset="100%" stop-color="#c98a3b"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="106" rx="62" ry="9" fill="#2d3326" opacity="0.12"/>
        <path d="M26 48 L134 48 L124 58 L36 58 Z" fill="url(#bread)"/>
        <rect x="30" y="58" width="100" height="6" fill="#69b846"/>
        <rect x="28" y="64" width="104" height="6" fill="#df4635"/>
        <rect x="26" y="70" width="108" height="6" fill="#ffcf3f"/>
        <rect x="30" y="76" width="100" height="7" fill="#be4d62"/>
        <path d="M34 83 L126 83 L134 94 L26 94 Z" fill="url(#bread)"/>
      </svg>`;

    case 'picada':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#b67f4c"/><stop offset="100%" stop-color="#69411d"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="106" rx="66" ry="10" fill="#2d3326" opacity="0.12"/>
        <rect x="22" y="44" width="116" height="52" rx="12" fill="url(#wood)"/>
        <rect x="134" y="62" width="14" height="14" rx="4" fill="url(#wood)"/>
        <circle cx="48" cy="62" r="14" fill="#f8cf52"/><rect x="42" y="56" width="12" height="12" fill="#e2ad1d"/>
        <ellipse cx="82" cy="60" rx="16" ry="10" fill="#bb3f38"/><ellipse cx="78" cy="58" rx="12" ry="7" fill="#d95e57"/>
        <ellipse cx="112" cy="66" rx="10" ry="7" fill="#f49b78"/><ellipse cx="110" cy="64" rx="8" ry="5" fill="#f7b79d"/>
        <circle cx="58" cy="80" r="5" fill="#46622b"/><circle cx="72" cy="80" r="5.5" fill="#2d3228"/><circle cx="95" cy="80" r="6" fill="#f0e2ba"/>
      </svg>`;

    case 'torta':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="choc" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#462211"/><stop offset="100%" stop-color="#2a1207"/></linearGradient>
          <linearGradient id="berry" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#dc2447"/><stop offset="100%" stop-color="#800e23"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="106" rx="55" ry="9" fill="#2d3326" opacity="0.12"/>
        <path d="M34 50 L110 32 L128 80 L52 98 Z" fill="url(#choc)"/>
        <path d="M34 50 L110 32 L88 24 L20 40 Z" fill="#673922"/>
        <path d="M20 40 L88 24 L128 80 L52 98 Z" fill="none" stroke="#d58f3b" stroke-width="4" stroke-dasharray="2 12"/>
        <circle cx="58" cy="34" r="7" fill="url(#berry)"/><circle cx="72" cy="31" r="6" fill="url(#berry)"/><circle cx="64" cy="26" r="5" fill="url(#berry)"/>
        <path d="M78 28 Q84 24 86 30" fill="none" stroke="#487834" stroke-width="2"/>
      </svg>`;

    case 'beer':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="beerGold" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#d47917"/><stop offset="50%" stop-color="#fdbb30"/><stop offset="100%" stop-color="#c16606"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="108" rx="46" ry="8" fill="#2d3326" opacity="0.12"/>
        <path d="M54 36 L60 98 C60 103, 100 103, 100 98 L106 36 Z" fill="url(#beerGold)"/>
        <path d="M50 32 C50 25, 110 25, 110 32 C114 36, 106 42, 100 40 C95 44, 88 40, 80 43 C72 40, 65 44, 60 40 C54 42, 46 36, 50 32 Z" fill="#fffef5"/>
        <path d="M103 48 C118 48, 118 78, 100 80" fill="none" stroke="#dfebdc" stroke-width="5" stroke-linecap="round"/>
        <circle cx="72" cy="62" r="1.8" fill="#ffffff" opacity="0.6"/><circle cx="84" cy="74" r="2.2" fill="#ffffff" opacity="0.6"/><circle cx="78" cy="88" r="1.5" fill="#ffffff" opacity="0.6"/>
      </svg>`;

    case 'lemonade':
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <defs>
          <linearGradient id="lemon" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#f6e865"/><stop offset="70%" stop-color="#fffb9e"/><stop offset="100%" stop-color="#e2cf38"/></linearGradient>
        </defs>
        <ellipse cx="80" cy="108" rx="42" ry="8" fill="#2d3326" opacity="0.12"/>
        <path d="M58 32 L64 98 C64 103, 96 103, 96 98 L102 32 Z" fill="url(#lemon)"/>
        <circle cx="80" cy="65" r="12" fill="#ffe135" stroke="#ffffff" stroke-width="2"/>
        <path d="M74 38 Q82 30 84 40" fill="#448d2d"/>
        <line x1="88" y1="12" x2="72" y2="94" stroke="#d6402d" stroke-width="4" stroke-linecap="round"/>
      </svg>`;

    default:
      return `<svg viewBox="0 0 160 120" class="food-svg" aria-hidden="true">
        <circle cx="80" cy="60" r="35" fill="#e8ede2"/>
        <text x="80" y="66" text-anchor="middle" font-family="Georgia,serif" font-size="28" fill="#253c34">c.</text>
      </svg>`;
  }
}

// Mapa temático estilizado de Aluminé para seguimiento del pedido
export function getAlumineMapSvg({ merchantName = 'Comercio', customerAddress = 'Destino', status = 'received', fulfillment = 'delivery' } = {}) {
  const isPickup = fulfillment === 'pickup';
  const isDelivered = status === 'delivered';
  const isOnTheWay = ['on_the_way', 'arrived'].includes(status);
  const isReady = ['ready', 'assigned', 'picked_up'].includes(status);

  // Posición del repartidor a lo largo de la ruta (0% al 100%)
  const riderProgress = status === 'arrived' ? 88 : status === 'on_the_way' ? 52 : status === 'picked_up' ? 20 : 5;

  return `<div class="alumine-tracking-map" role="img" aria-label="Mapa esquemático de seguimiento en Aluminé">
    <svg viewBox="0 0 600 280" class="map-canvas">
      <defs>
        <linearGradient id="riverGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#6ba396"/><stop offset="100%" stop-color="#467e72"/></linearGradient>
        <linearGradient id="routeGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#204940"/><stop offset="100%" stop-color="#a25238"/></linearGradient>
        <filter id="mapShadow" x="-10%" y="-10%" width="130%" height="130%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-opacity="0.15"/></filter>
      </defs>

      <!-- Fondo y manzanas de Aluminé -->
      <rect x="0" y="0" width="600" height="280" fill="#e9ecdf" rx="16"/>

      <!-- Río Aluminé curvado -->
      <path d="M -20 70 C 140 80, 220 180, 360 210 C 470 230, 540 200, 620 220 L 620 280 L -20 280 Z" fill="url(#riverGrad)" opacity="0.35"/>
      <path d="M -20 70 C 140 80, 220 180, 360 210 C 470 230, 540 200, 620 220" fill="none" stroke="#528a7e" stroke-width="28" stroke-linecap="round" opacity="0.75"/>
      <text x="310" y="246" font-size="11" font-weight="600" fill="#2d5950" letter-spacing="2">RÍO ALUMINÉ</text>

      <!-- Calles principales de Aluminé -->
      <!-- Av. 4 de Febrero -->
      <line x1="50" y1="40" x2="550" y2="100" stroke="#d5d8ca" stroke-width="14" stroke-linecap="round"/>
      <text x="70" y="32" font-size="9" fill="#758273" letter-spacing="1">AV. 4 DE FEBRERO</text>

      <!-- Ruta Provincial 23 -->
      <line x1="80" y1="180" x2="520" y2="60" stroke="#d5d8ca" stroke-width="12" stroke-linecap="round"/>
      <text x="440" y="52" font-size="9" fill="#758273" letter-spacing="1">RP 23</text>

      <!-- Calle Cristian Joubert / Plaza San Martín -->
      <rect x="250" y="70" width="70" height="45" rx="6" fill="#ccd6be" opacity="0.8"/>
      <text x="285" y="96" text-anchor="middle" font-size="8" font-weight="bold" fill="#4d6244">PLAZA</text>

      <!-- Manzanas urbanas sutiles -->
      <rect x="110" y="65" width="48" height="32" rx="4" fill="#dde1d3"/>
      <rect x="175" y="65" width="55" height="32" rx="4" fill="#dde1d3"/>
      <rect x="340" y="75" width="50" height="35" rx="4" fill="#dde1d3"/>
      <rect x="410" y="85" width="55" height="35" rx="4" fill="#dde1d3"/>

      <!-- Trazado de ruta del pedido -->
      <path id="orderRoute" d="M 120 135 Q 230 110, 310 85 T 480 120" fill="none" stroke="url(#routeGrad)" stroke-width="5" stroke-dasharray="${isDelivered ? 'none' : '7 5'}" stroke-linecap="round"/>

      <!-- Punto A: Comercio -->
      <g transform="translate(120, 135)" filter="url(#mapShadow)">
        <circle cx="0" cy="0" r="16" fill="#204940"/>
        <circle cx="0" cy="0" r="7" fill="#ffffff"/>
        <rect x="-55" y="22" width="110" height="22" rx="6" fill="#204940"/>
        <text x="0" y="36" text-anchor="middle" font-size="10" font-weight="bold" fill="#ffffff">${merchantName.slice(0, 15)}</text>
      </g>

      <!-- Punto B: Destino del Cliente (o punto de retiro) -->
      <g transform="translate(480, 120)" filter="url(#mapShadow)">
        <circle cx="0" cy="0" r="16" fill="${isDelivered ? '#204940' : '#a25238'}"/>
        <circle cx="0" cy="0" r="7" fill="#ffffff"/>
        <rect x="-65" y="22" width="130" height="22" rx="6" fill="#ffffff" stroke="#dedfd4"/>
        <text x="0" y="36" text-anchor="middle" font-size="9" font-weight="bold" fill="#253c34">${isPickup ? 'Retiro en local' : customerAddress.slice(0, 18)}</text>
      </g>

      ${!isPickup && !isDelivered ? `
      <!-- Repartidor en movimiento -->
      <g transform="translate(${120 + (480 - 120) * (riderProgress / 100)}, ${135 + (120 - 135) * (riderProgress / 100) - (isOnTheWay ? 18 : 0)})" filter="url(#mapShadow)">
        <circle cx="0" cy="0" r="18" fill="#ffffff" stroke="#a25238" stroke-width="3"/>
        <text x="0" y="5" text-anchor="middle" font-size="16">🛵</text>
        <rect x="-40" y="-30" width="80" height="18" rx="4" fill="#a25238"/>
        <text x="0" y="-18" text-anchor="middle" font-size="9" font-weight="bold" fill="#ffffff">${isOnTheWay ? 'EN CAMINO' : isReady ? 'POR RETIRAR' : 'REPARTIDOR'}</text>
      </g>
      ` : ''}
    </svg>
    <div class="map-legend">
      <span><strong class="dot origin"></strong> ${merchantName}</span>
      <span><strong class="dot ${isDelivered ? 'origin' : 'destination'}"></strong> ${isPickup ? 'Mostrador' : customerAddress}</span>
      <span class="quiet">${isPickup ? 'Modo retiro' : isOnTheWay ? 'Rider transitando por Aluminé' : isDelivered ? 'Entregado con éxito' : 'Esperando despacho'}</span>
    </div>
  </div>`;
}

export function getAlumineTaxiMapSvg({
  origin = 'Origen',
  destination = 'Destino',
  status = 'requested',
  driverName = 'Conductor demo',
  mobileNumber = 'Móvil DEMO',
} = {}) {
  const isCompleted = status === 'completed';
  const isCanceled = status === 'canceled';
  const isInTrip = status === 'in_trip';
  const isOnWay = status === 'driver_on_way';
  const isArrived = status === 'driver_arrived';
  const isBoarded = status === 'passenger_on_board';
  const isAccepted = status === 'accepted';

  // Progreso del taxi visualmente en el mapa
  let taxiProgress = 5;
  let taxiLabel = 'ASIGNADO';
  if (isOnWay) {
    taxiProgress = 35;
    taxiLabel = 'EN CAMINO';
  } else if (isArrived) {
    taxiProgress = 20;
    taxiLabel = 'EN ORIGEN';
  } else if (isBoarded) {
    taxiProgress = 25;
    taxiLabel = 'ABORDO';
  } else if (isInTrip) {
    taxiProgress = 70;
    taxiLabel = 'EN VIAJE';
  } else if (isCompleted) {
    taxiProgress = 100;
    taxiLabel = 'DESTINO';
  }

  return `<div class="alumine-tracking-map taxi-tracking-map" role="img" aria-label="Recorrido esquemático del viaje de taxi en Aluminé">
    <svg viewBox="0 0 600 280" class="map-canvas">
      <defs>
        <linearGradient id="riverGradTaxi" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#6ba396"/><stop offset="100%" stop-color="#467e72"/></linearGradient>
        <linearGradient id="routeGradTaxi" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#1d4e73"/><stop offset="100%" stop-color="#b85437"/></linearGradient>
        <filter id="taxiShadow" x="-10%" y="-10%" width="130%" height="130%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-opacity="0.18"/></filter>
      </defs>

      <!-- Fondo y territorio de Aluminé -->
      <rect x="0" y="0" width="600" height="280" fill="#e9ecdf" rx="16"/>

      <!-- Río Aluminé curvado -->
      <path d="M -20 70 C 140 80, 220 180, 360 210 C 470 230, 540 200, 620 220 L 620 280 L -20 280 Z" fill="url(#riverGradTaxi)" opacity="0.35"/>
      <path d="M -20 70 C 140 80, 220 180, 360 210 C 470 230, 540 200, 620 220" fill="none" stroke="#528a7e" stroke-width="28" stroke-linecap="round" opacity="0.75"/>
      <text x="310" y="246" font-size="11" font-weight="600" fill="#2d5950" letter-spacing="2">RÍO ALUMINÉ</text>

      <!-- Calles principales -->
      <line x1="50" y1="40" x2="550" y2="100" stroke="#d5d8ca" stroke-width="14" stroke-linecap="round"/>
      <text x="70" y="32" font-size="9" fill="#758273" letter-spacing="1">AV. 4 DE FEBRERO</text>

      <line x1="80" y1="180" x2="520" y2="60" stroke="#d5d8ca" stroke-width="12" stroke-linecap="round"/>
      <text x="440" y="52" font-size="9" fill="#758273" letter-spacing="1">RP 23</text>

      <!-- Manzanas y plazas de Aluminé -->
      <rect x="250" y="70" width="70" height="45" rx="6" fill="#ccd6be" opacity="0.8"/>
      <text x="285" y="96" text-anchor="middle" font-size="8" font-weight="bold" fill="#4d6244">PLAZA</text>
      <rect x="110" y="65" width="48" height="32" rx="4" fill="#dde1d3"/>
      <rect x="175" y="65" width="55" height="32" rx="4" fill="#dde1d3"/>
      <rect x="340" y="75" width="50" height="35" rx="4" fill="#dde1d3"/>
      <rect x="410" y="85" width="55" height="35" rx="4" fill="#dde1d3"/>

      <!-- Trazado de ruta de taxi -->
      <path id="taxiRoute" d="M 120 135 Q 240 100, 330 90 T 480 120" fill="none" stroke="url(#routeGradTaxi)" stroke-width="5" stroke-dasharray="${isCompleted ? 'none' : '8 5'}" stroke-linecap="round"/>

      <!-- Punto A: Origen del viaje -->
      <g transform="translate(120, 135)" filter="url(#taxiShadow)">
        <circle cx="0" cy="0" r="16" fill="#1d4e73"/>
        <circle cx="0" cy="0" r="7" fill="#ffffff"/>
        <rect x="-65" y="22" width="130" height="22" rx="6" fill="#1d4e73"/>
        <text x="0" y="36" text-anchor="middle" font-size="9" font-weight="bold" fill="#ffffff">${origin.slice(0, 18)}</text>
      </g>

      <!-- Punto B: Destino del viaje -->
      <g transform="translate(480, 120)" filter="url(#taxiShadow)">
        <circle cx="0" cy="0" r="16" fill="${isCompleted ? '#143d34' : '#b85437'}"/>
        <circle cx="0" cy="0" r="7" fill="#ffffff"/>
        <rect x="-65" y="22" width="130" height="22" rx="6" fill="#ffffff" stroke="#cbd5e1"/>
        <text x="0" y="36" text-anchor="middle" font-size="9" font-weight="bold" fill="#0f172a">${destination.slice(0, 18)}</text>
      </g>

      ${!isCompleted && !isCanceled ? `
      <!-- Taxi en movimiento -->
      <g transform="translate(${120 + (480 - 120) * (taxiProgress / 100)}, ${135 + (120 - 135) * (taxiProgress / 100) - (isInTrip || isOnWay ? 18 : 0)})" filter="url(#taxiShadow)">
        <circle cx="0" cy="0" r="19" fill="#ffffff" stroke="#1d4e73" stroke-width="3"/>
        <text x="0" y="6" text-anchor="middle" font-size="16">🚖</text>
        <rect x="-42" y="-32" width="84" height="20" rx="4" fill="#1d4e73"/>
        <text x="0" y="-18" text-anchor="middle" font-size="9" font-weight="bold" fill="#ffffff">${mobileNumber} · ${taxiLabel}</text>
      </g>
      ` : ''}
    </svg>
    <div class="map-legend">
      <span><strong class="dot origin" style="background:#1d4e73"></strong> Origen: ${origin}</span>
      <span><strong class="dot ${isCompleted ? 'origin' : 'destination'}"></strong> Destino: ${destination}</span>
      <span class="quiet">${isCompleted ? 'Viaje completado (Demostración)' : isCanceled ? 'Viaje cancelado' : `${mobileNumber} · ${driverName}`}</span>
    </div>
  </div>`;
}

