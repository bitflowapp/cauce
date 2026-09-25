// Aviso de pedido nuevo para el panel del comercio: sonido corto, vibración y
// título de la pestaña. Sin archivos de audio ni dependencias: WebAudio.
// El navegador sólo permite sonido después de una interacción: el panel lo
// habilita con el primer toque y lo dice si todavía no pudo.
let context = null;
let baseTitle = typeof document === 'undefined' ? 'CAUCE' : document.title;

export function unlockSound() {
  try {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) return false;
    context ||= new Context();
    if (context.state === 'suspended') context.resume();
    return true;
  } catch { return false; }
}

export const soundReady = () => Boolean(context && context.state === 'running');

function chime() {
  if (!soundReady()) return false;
  const start = context.currentTime;
  for (const [offset, frequency] of [[0, 880], [0.18, 1175], [0.36, 1568]]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.18);
  }
  return true;
}

export function announceNewOrders(count) {
  if (!count) return;
  chime();
  try { globalThis.navigator?.vibrate?.([180, 80, 180]); } catch { /* sin vibración */ }
  if (typeof document !== 'undefined') {
    document.title = `(${count}) Pedido nuevo · ${baseTitle.replace(/^\(\d+\)\s*Pedido nuevo · /, '')}`;
  }
}

export function clearOrderAlert() {
  if (typeof document !== 'undefined' && /^\(\d+\) Pedido nuevo · /.test(document.title)) {
    document.title = document.title.replace(/^\(\d+\) Pedido nuevo · /, '');
  }
}

export function setBaseTitle(title) { baseTitle = title; }
