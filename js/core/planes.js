// Información orientativa: no aplica límites ni activa cobros.
// Los importes pueden sustituirse al integrar una fuente de configuración comercial.
export const PLANES_ORIENTATIVOS = Object.freeze([
  Object.freeze({ id: 'emprende', nombre: 'MiFav Emprende', altaArs: 49900, mensualArs: 19900, productosPrevistos: 30 }),
  Object.freeze({ id: 'crece', nombre: 'MiFav Crecé', altaArs: null, mensualArs: 39900, productosPrevistos: null }),
  Object.freeze({ id: 'medida', nombre: 'MiFav a Medida', altaArs: null, mensualArs: null, productosPrevistos: null }),
]);

export function validarPreciosPlanes(planes) {
  if (!Array.isArray(planes) || planes.length !== PLANES_ORIENTATIVOS.length) return false;
  const ids = new Set();
  for (const plan of planes) {
    if (!plan || !PLANES_ORIENTATIVOS.some(base => base.id === plan.id) || ids.has(plan.id)) return false;
    ids.add(plan.id);
    for (const precio of [plan.altaArs, plan.mensualArs]) {
      if (precio !== null && (!Number.isSafeInteger(precio) || precio < 0)) return false;
    }
  }
  return true;
}
