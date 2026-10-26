// MiFav — vocabulario comercial del marketplace multirrubro.
//
// Estas listas son decisiones de producto, no datos de la base. Se usan para
// ordenar la vidriera, el buscador y el formulario de publicación. Ampliar un
// rubro implica sumarlo acá y, cuando corresponda, a la migración; nunca sólo
// a los datos de demostración.
//
// La localidad de lanzamiento es Neuquén capital. El identificador histórico
// `alumine` se conserva en la base y en los enlaces existentes para no romper
// pedidos, carritos ni sesiones ya guardadas: la etiqueta visible es la que
// cambia. Plottier y Centenario quedan preparadas como próximas localidades.

export const DEFAULT_LOCALITY_ID = 'neuquen-capital';

export const LOCALITIES = Object.freeze([
  Object.freeze({ id: 'neuquen-capital', name: 'Neuquén Capital', province: 'Neuquén', ready: true }),
  Object.freeze({ id: 'plottier', name: 'Plottier', province: 'Neuquén', ready: false }),
  Object.freeze({ id: 'centenario', name: 'Centenario', province: 'Neuquén', ready: false }),
]);

export const LEGACY_LOCALITY_IDS = Object.freeze({
  alumine: 'neuquen-capital',
  'neuquen-capital': 'neuquen-capital',
});

export function localityFor(id) {
  const normalized = LEGACY_LOCALITY_IDS[id] || id;
  return LOCALITIES.find(locality => locality.id === normalized) || LOCALITIES[0];
}

export function localityLabel(id) {
  return localityFor(id).name;
}

// Rubros de lanzamiento. `icon` es el nombre que entiende renderIcon; si no
// existe todavía, la tarjeta cae a un monograma.
export const MARKETPLACE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'indumentaria', name: 'Indumentaria', icon: 'tag', hint: 'Ropa y calzado' }),
  Object.freeze({ id: 'tecnologia', name: 'Tecnología', icon: 'device', hint: 'Nuevos y usados' }),
  Object.freeze({ id: 'hogar', name: 'Hogar', icon: 'home', hint: 'Deco y muebles' }),
  Object.freeze({ id: 'belleza', name: 'Belleza', icon: 'sparkles', hint: 'Cuidado personal' }),
  Object.freeze({ id: 'artesanias', name: 'Artesanías', icon: 'heart', hint: 'Hecho a mano' }),
  Object.freeze({ id: 'gastronomia', name: 'Gastronomía', icon: 'bag', hint: 'Comida y bebida' }),
  Object.freeze({ id: 'deportes', name: 'Deportes', icon: 'activity', hint: 'Aire libre' }),
  Object.freeze({ id: 'mascotas', name: 'Mascotas', icon: 'paw', hint: 'Para tu compañero' }),
  Object.freeze({ id: 'otros', name: 'Otros', icon: 'grid', hint: 'Más hallazgos' }),
]);

export const MARKETPLACE_CATEGORY_NAMES = Object.freeze(MARKETPLACE_CATEGORIES.map(category => category.name));

// Condición del artículo. Los valores viajan a la base y no se traducen en el
// almacenamiento: la etiqueta visible sí.
export const PRODUCT_CONDITIONS = Object.freeze({
  new: 'Nuevo',
  used: 'Usado',
});

export const PRODUCT_CONDITION_CODES = Object.freeze(Object.keys(PRODUCT_CONDITIONS));

export function isProductCondition(value) {
  return PRODUCT_CONDITION_CODES.includes(value);
}

export function normalizeProductCondition(value, fallback = 'new') {
  return isProductCondition(value) ? value : fallback;
}

export function conditionLabel(value) {
  return PRODUCT_CONDITIONS[normalizeProductCondition(value)] || PRODUCT_CONDITIONS.new;
}

// La condición nuevo/usado es propia de los artículos del marketplace. Los
// platos de los comercios gastronómicos no se publican como "nuevos": se
// preparan. Esta función devuelve '' para esos productos y evita que el filtro
// de estado los mezcle con artículos nuevos.
export function productCondition(product) {
  if (!product || product.dishType) return '';
  return isProductCondition(product.condition) ? product.condition : 'new';
}

// Los comercios históricos de gastronomía no tienen un rubro de marketplace
// propio. Se clasifican acá para que los filtros no dependan de que cada
// comercio se vuelva a cargar.
const FOOD_CATEGORIES = new Set([
  'hamburguesas', 'pizzas', 'rotisería', 'cafetería', 'cervecería', 'comida casera',
  'panadería', 'gastronomía', 'restaurante', 'bar', 'heladería', 'pastelería',
]);

export function categoryForBusiness(business) {
  const explicit = String(business?.marketplaceCategory || '').trim();
  if (explicit) return explicit;
  const category = String(business?.category || '').trim().toLowerCase();
  if (FOOD_CATEGORIES.has(category)) return 'Gastronomía';
  return business?.category || 'Otros';
}

export function categoryIdForName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  const found = MARKETPLACE_CATEGORIES.find(category => category.name.toLowerCase() === normalized
    || category.id === normalized);
  return found?.id || '';
}

export function isMarketplaceCategory(name) {
  return Boolean(categoryIdForName(name));
}
