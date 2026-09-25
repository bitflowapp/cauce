// Un error de red se reconoce igual en los dos backends: el de desarrollo
// (NETWORK_UNAVAILABLE) y Supabase (NETWORK_ERROR). Ninguno envió nada.
export const NETWORK_CODES = Object.freeze(['NETWORK_UNAVAILABLE', 'NETWORK_ERROR']);

export function isNetworkError(error) {
  return NETWORK_CODES.includes(error?.code);
}
