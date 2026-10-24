// CAUCE · marketplace multirrubro, fase 1 (docs/CAUCE-MARKETPLACE-MULTIRRUBRO-20261024.md).
// Tabla de rubros de lanzamiento y sus búsquedas. Es dato de paridad y de
// administración: la interfaz conectada lee la taxonomía vigente desde la base
// (`business_categories`), acá viven la lista y las reglas puras que describen
// el estado esperado (tests/rubros.test.mjs y tests/db/marketplace.test.mjs
// exigen la paridad entre esta tabla y la migración SQL).
import { sanitizeCapabilities } from './rubros.js';

/**
 * @typedef {object} BusinessCategory
 * @property {string} slug
 * @property {string} name
 * @property {number} position
 * @property {readonly string[]} capabilities
 */

// Rubros de lanzamiento del marketplace multirrubro. Orden `position` creciente.
// Tuplas: slug, nombre, posición y capacidades separadas por espacio.
/** @type {Array<[string, string, number, string]>} */
const CATEGORY_ROWS = [
  ['gastronomia', 'Gastronomía', 10, 'products prepared_food'],
  ['panaderia', 'Panadería', 20, 'products prepared_food'],
  ['almacen', 'Almacén', 30, 'products'],
  ['kiosco', 'Kiosco', 40, 'products'],
  ['verduleria', 'Verdulería', 50, 'products'],
  ['carniceria', 'Carnicería', 60, 'products'],
  ['farmacia', 'Farmacia', 70, 'products'],
  ['ferreteria', 'Ferretería', 80, 'products services'],
  ['servicios', 'Servicios', 90, 'services'],
  ['otros', 'Otros', 99, 'products services'],
  ['artesania', 'Artesanías', 110, 'products'],
  ['regaleria', 'Regalería', 120, 'products'],
  ['ropa-accesorios', 'Ropa y accesorios', 130, 'products'],
  ['tecnologia', 'Tecnología y reparaciones', 140, 'products services'],
  ['libros-papeleria', 'Libros y papelería', 150, 'products'],
  ['mascotas', 'Mascotas', 160, 'products'],
  ['agro-vivero', 'Agro y vivero', 170, 'products'],
  ['talleres', 'Talleres y oficios', 180, 'services'],
];

export const BUSINESS_CATEGORIES = Object.freeze(CATEGORY_ROWS.map(
  ([slug, name, position, capabilities]) => Object.freeze({
    slug, name, position, capabilities: Object.freeze(capabilities.split(' ')),
  })));

export function businessCategoryBySlug(slug) {
  return BUSINESS_CATEGORIES.find(category => category.slug === slug) || null;
}

export function capabilitiesForBusinessCategory(slug) {
  return businessCategoryBySlug(slug)?.capabilities || [];
}

// Filtra un conjunto ya validado a lo que el rubro del comercio habilita.
// La base es la última autoridad: esto sólo guía la vista y los envíos correctos.
export function fitCapabilitiesToCategory(values, categorySlug) {
  const allowed = capabilitiesForBusinessCategory(categorySlug);
  return sanitizeCapabilities(values).filter(code => allowed.includes(code));
}
