// Fotos livianas: una foto de teléfono pesa varios MB y en CAUCE se muestra en
// una miniatura o, como mucho, en una portada. Antes de subirla se achica al
// tamaño en que se va a ver y se guarda como WebP. Si el navegador no puede
// (sin canvas, sin WebP, imagen rara), se sube el archivo original: nunca se
// bloquea la carga por esto.

// Lado mayor, en píxeles, según dónde se muestra.
export const IMAGE_SIDES = Object.freeze({ cover: 1600, logo: 512, product: 1024 });
const KEEP_BELOW = 300 * 1024;

/**
 * @param {Blob & { name?: string, type: string }} file
 * @param {{ maxSide?: number, quality?: number }} [options]
 * @returns {Promise<Blob & { name?: string, type: string }>}
 */
export async function optimizeImage(file, { maxSide = IMAGE_SIDES.product, quality = 0.82 } = {}) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined' || !file?.size) return file;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    // Chica y liviana: no hay nada que ganar.
    if (scale === 1 && file.size <= KEEP_BELOW) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
    // Sin WebP (algunos Safari devuelven PNG) o sin ahorro: el original.
    if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file;
    const name = `${String(file.name || 'imagen').replace(/\.[^.]+$/, '')}.webp`;
    return typeof File === 'function' ? new File([blob], name, { type: 'image/webp' }) : blob;
  } catch {
    return file;
  } finally {
    bitmap?.close?.();
  }
}
