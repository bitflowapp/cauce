// Taxonomía de rubros y capacidades (fase 1 del marketplace multirrubro).
// Reglas puras: normalización, validación y paridad con la migración SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES, CAPABILITY_CODES, MAX_BUSINESSES_PER_ACCOUNT,
  sanitizeCapabilities, isCapability, capabilityLabel,
} from '../js/core/rubros.js';
import {
  BUSINESS_CATEGORIES, businessCategoryBySlug, capabilitiesForBusinessCategory,
  fitCapabilitiesToCategory,
} from '../js/core/rubro-catalogo.js';
import { readFile } from 'node:fs/promises';

test('el vocabulario de capacidades está cerrado y etiquetado', () => {
  assert.deepEqual(CAPABILITY_CODES, ['products', 'prepared_food', 'services']);
  for (const code of CAPABILITY_CODES) {
    assert.ok(CAPABILITIES[code].length >= 3, `etiqueta legible para ${code}`);
  }
  assert.equal(isCapability('products'), true);
  assert.equal(isCapability('PRODUCTS'), false); // el caso lo normaliza el llamador
  assert.equal(isCapability('reservas'), false); // sin módulo de reservas, no se promete
});

test('la lista de rubros de lanzamiento es consistente y única', () => {
  assert.ok(BUSINESS_CATEGORIES.length >= 10, 'cubrir varios rubros reales');
  const slugs = new Set(BUSINESS_CATEGORIES.map(category => category.slug));
  assert.equal(slugs.size, BUSINESS_CATEGORIES.length, 'sin slugs repetidos');
  assert.equal(new Set(BUSINESS_CATEGORIES.map(category => category.name)).size,
    BUSINESS_CATEGORIES.length, 'sin nombres repetidos');
  for (const category of BUSINESS_CATEGORIES) {
    assert.match(category.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `slug válido: ${category.slug}`);
    assert.ok(category.name.length >= 2 && category.name.length <= 60, `nombre acotado: ${category.name}`);
    assert.ok(Number.isSafeInteger(category.position), 'posición entera');
    assert.ok(category.capabilities.length > 0, `${category.slug} declara al menos una capacidad`);
    for (const code of category.capabilities) assert.equal(isCapability(code), true);
  }
  assert.equal(businessCategoryBySlug('gastronomia')?.name, 'Gastronomía');
  assert.equal(businessCategoryBySlug('nonexistent'), null);
  // Cada rubro de la demo conserva capacidades coherentes con su uso.
  assert.deepEqual(capabilitiesForBusinessCategory('panaderia'), ['products', 'prepared_food']);
  assert.deepEqual(capabilitiesForBusinessCategory('talleres'), ['services']);
  assert.equal(capabilityLabel('prepared_food'), 'Comida preparada');
});

test('sanitizeCapabilities normaliza entradas correctas y rechaza las inválidas', () => {
  assert.deepEqual(sanitizeCapabilities(['prepared_food', 'products', 'products']),
    ['products', 'prepared_food']); // únicos y en orden canónico
  assert.deepEqual(sanitizeCapabilities('products, services'), ['products', 'services']);
  assert.throws(() => sanitizeCapabilities(['menu']), /Capacidad no admitida: menu/);
  assert.throws(() => sanitizeCapabilities([42]), /Capacidad no admitida/);
  assert.throws(() => sanitizeCapabilities(['']), /Hay un valor de capacidad vacío/);
  assert.throws(() => sanitizeCapabilities(',,'), /Hay un valor de capacidad vacío/);
  assert.throws(() => sanitizeCapabilities(new Array(9).fill('products')), /hasta 8 capacidades/);
});

test('fitCapabilitiesToCategory limita el conjunto a lo que el rubro habilita', () => {
  assert.deepEqual(fitCapabilitiesToCategory(['products', 'prepared_food'], 'panaderia'),
    ['products', 'prepared_food']);
  // La base es la autoridad; la presentación no ofrece lo que el rubro no tiene.
  assert.deepEqual(fitCapabilitiesToCategory(['services'], 'panaderia'), []);
  assert.deepEqual(fitCapabilitiesToCategory(['products', 'services'], 'servicios'), ['services']);
  // Antes del alta con rubro la vista no sugiere nada.
  assert.deepEqual(fitCapabilitiesToCategory(['products'], ''), []);
});

test('la paridad con la migración SQL es exacta (lista, posiciones y capacidades)', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261024100000_marketplace_taxonomy.sql', import.meta.url),
    'utf8');
  const parse = capabilities =>
    capabilities.split(',').map(code => code.trim().replace(/^'|'$/g, ''));
  const seeded = [...sql.matchAll(/'([a-z0-9-]+)', '([^']+)', (\d+), array\[([a-z0-9', _]+)\]/g)]
    .map(match => ({
      slug: match[1], name: match[2], position: Number(match[3]),
      capabilities: parse(match[4]),
    }));
  assert.equal(seeded.length, BUSINESS_CATEGORIES.length, 'la migración declara los mismos rubros');
  assert.deepEqual(seeded, BUSINESS_CATEGORIES.map(category => (
    { slug: category.slug, name: category.name, position: category.position,
      capabilities: [...category.capabilities] })));
  assert.equal(MAX_BUSINESSES_PER_ACCOUNT, 3, 'el tope anti-spam coincide con la migración');
});

