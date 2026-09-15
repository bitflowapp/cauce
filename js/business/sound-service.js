// Servicio sonoro Web Audio API para aviso de nuevos pedidos en el comercio demo.
// Reciclado y adaptado de La Taba (business-sound-service.js).
// Cumple con CSP (sin red, sin archivos externos, sintetizador armónico nativo).

export function createBusinessSoundService({ audioContextFactory } = {}) {
  let muted = false;
  let context = null;

  return Object.freeze({
    get muted() {
      return muted;
    },
    setMuted(value) {
      muted = Boolean(value);
      return muted;
    },
    async playNewOrder() {
      if (muted) return false;
      try {
        const Factory = audioContextFactory || globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Factory) return false;
        context ||= new Factory();
        if (context.state === 'suspended') {
          await context.resume();
        }
        const start = context.currentTime;
        // Dos tonos armónicos patagónicos suaves (880Hz -> 1175Hz) con decaimiento natural
        for (const [index, frequency] of [880, 1175].entries()) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const at = start + index * 0.16;
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(at);
          oscillator.stop(at + 0.18);
        }
        return true;
      } catch (_) {
        return false;
      }
    },
  });
}
