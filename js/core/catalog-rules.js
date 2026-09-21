// Validación del catálogo propio de cada comercio.
import { requireValue } from './errors.js';
import { sanitizeText } from './validators.js';

export const PRODUCT_CATEGORIES_SUGGESTED = Object.freeze([
  'Platos', 'Panadería', 'Bebidas', 'Almacén', 'Postres', 'Para compartir', 'Otros',
]);

export const MAX_PRODUCT_PRICE = 10000000;
export const MAX_PRODUCT_VARIANTS = 6;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(value, fallback = 'item') {
  const base = sanitizeText(value, { fallback, maxLength: 60 })
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return SLUG.test(base) ? base : fallback;
}

// Las variantes simples son un nombre y una diferencia de precio sobre el precio base.
export function normalizeVariants(input) {
  if (input == null) return [];
  requireValue(Array.isArray(input), 'INVALID_VARIANTS', 'Las variantes deben ser una lista.');
  requireValue(input.length <= MAX_PRODUCT_VARIANTS, 'TOO_MANY_VARIANTS',
    `Se admiten hasta ${MAX_PRODUCT_VARIANTS} variantes por producto.`);
  const names = new Set();
  return input.map(variant => {
    const name = sanitizeText(variant?.name, { fallback: '', maxLength: 40 });
    requireValue(name.length >= 2, 'INVALID_VARIANT', 'Cada variante necesita un nombre de al menos 2 caracteres.');
    const key = name.toLowerCase();
    requireValue(!names.has(key), 'DUPLICATE_VARIANT', `La variante "${name}" está repetida.`);
    names.add(key);
    const priceDelta = Number(variant?.priceDelta ?? 0);
    requireValue(Number.isSafeInteger(priceDelta) && Math.abs(priceDelta) <= MAX_PRODUCT_PRICE,
      'INVALID_VARIANT_PRICE', 'La diferencia de precio de la variante debe ser un entero.');
    return { id: slugify(name, `var-${names.size}`), name, priceDelta };
  });
}

export function validateProductInput(input, { partial = false } = {}) {
  const output = {};
  const has = field => Object.hasOwn(input || {}, field);

  if (!partial || has('name')) {
    const name = sanitizeText(input?.name, { fallback: '', maxLength: 80 });
    requireValue(name.length >= 2, 'INVALID_PRODUCT_NAME', 'El nombre del producto necesita al menos 2 caracteres.');
    output.name = name;
  }
  if (!partial || has('description')) {
    output.description = sanitizeText(input?.description, { fallback: '', maxLength: 280 });
  }
  if (!partial || has('category')) {
    const category = sanitizeText(input?.category, { fallback: 'Otros', maxLength: 40 });
    requireValue(category.length >= 2, 'INVALID_CATEGORY', 'Elegí o escribí una categoría.');
    output.category = category;
  }
  if (!partial || has('price')) {
    const price = Number(input?.price);
    requireValue(Number.isSafeInteger(price) && price > 0 && price <= MAX_PRODUCT_PRICE,
      'INVALID_PRICE', 'El precio debe ser un número entero mayor a cero.');
    output.price = price;
  }
  if (!partial || has('stock')) {
    const stock = Number(input?.stock ?? 0);
    requireValue(Number.isSafeInteger(stock) && stock >= 0 && stock <= 10000, 'INVALID_STOCK',
      'El stock debe ser un entero entre 0 y 10000.');
    output.stock = stock;
  }
  if (!partial || has('available')) {
    requireValue(typeof input?.available === 'boolean', 'INVALID_VALUE', 'Disponibilidad inválida.');
    output.available = input.available;
  }
  if (has('archived')) {
    requireValue(typeof input.archived === 'boolean', 'INVALID_VALUE', 'Valor de baja inválido.');
    output.archived = input.archived;
  }
  if (has('variants')) {
    output.variants = normalizeVariants(input.variants);
  }
  if (has('image')) {
    output.image = validateImageReference(input.image);
  }
  if (has('dishType')) {
    output.dishType = sanitizeText(input.dishType, { fallback: 'burger', maxLength: 24 });
  }
  return output;
}

// Solo se aceptan rutas internas del propio repositorio: nada de URLs remotas ni data: arbitrarios.
export function validateImageReference(value) {
  const raw = sanitizeText(value, { fallback: '', maxLength: 160 });
  if (!raw) return '';
  requireValue(/^assets\/images\/[a-z0-9/_-]+\.(webp|png|jpg|jpeg|svg|avif)$/i.test(raw),
    'INVALID_IMAGE', 'Solo se admiten imágenes incluidas en el proyecto (assets/images/...).');
  return raw;
}
