// MiFav · contratos del marketplace multirrubro.
//
// Cubre las piezas nuevas que no dependen del navegador: vocabulario de rubros
// y localidades, condición del artículo, foto de demostración, favoritos
// locales y publicación en el catálogo propio. El aislamiento entre vendedores
// se prueba acá a nivel de comandos y en tests/db/* sobre las políticas reales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_LOCALITY_ID, LOCALITIES, MARKETPLACE_CATEGORIES, MARKETPLACE_CATEGORY_NAMES,
  categoryForBusiness, conditionLabel, isProductCondition, localityFor, localityLabel,
  normalizeProductCondition, productCondition,
} from '../js/core/marketplace.js';
import {
  FAVORITES_KEY, MAX_FAVORITES, favoriteKey, hasFavorite, normalizeFavorites,
  parseFavoriteKey, readFavorites, toggleFavorite, writeFavorites,
} from '../js/core/favorites.js';
import {
  MAX_IMAGE_DATA_LENGTH, validateImageData, validateImageReference, validateProductInput,
} from '../js/core/catalog-rules.js';
import { initialState } from '../js/domain/state.js';
import { createLocalRepository } from '../js/repositories/local-repository.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lV0fWQAAAABJRU5ErkJggg==';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    dump: () => Object.fromEntries(values),
  };
}

function setupRepo() {
  const storage = memoryStorage();
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const repo = createLocalRepository({ storage, uuid, locks: null, seed: initialState, clock: () => new Date().toISOString() });
  return { repo, storage };
}

test('la localidad de lanzamiento es Neuquén Capital y el id histórico sigue funcionando', () => {
  assert.equal(DEFAULT_LOCALITY_ID, 'neuquen-capital');
  assert.equal(localityFor('alumine').id, 'neuquen-capital');
  assert.equal(localityLabel('alumine'), 'Neuquén Capital');
  assert.equal(localityLabel('neuquen-capital'), 'Neuquén Capital');
  assert.equal(localityFor('plottier').ready, false, 'Plottier queda preparada, no publicada');
  assert.equal(localityFor('centenario').ready, false, 'Centenario queda preparada, no publicado');
  assert.equal(localityFor('desconocida').id, 'neuquen-capital', 'Una localidad desconocida cae en la de lanzamiento');
  assert.equal(new Set(LOCALITIES.map(locality => locality.id)).size, LOCALITIES.length);
});

test('los rubros del marketplace son únicos y cubren los comercios históricos', () => {
  const ids = MARKETPLACE_CATEGORIES.map(category => category.id);
  const names = MARKETPLACE_CATEGORIES.map(category => category.name);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(MARKETPLACE_CATEGORY_NAMES, names);
  // Los comercios gastronómicos anteriores no tienen marketplaceCategory.
  assert.equal(categoryForBusiness({ category: 'Hamburguesas' }), 'Gastronomía');
  assert.equal(categoryForBusiness({ category: 'Panadería' }), 'Gastronomía');
  // El rubro explícito manda sobre la categoría histórica.
  assert.equal(categoryForBusiness({ category: 'Calzado', marketplaceCategory: 'Indumentaria' }), 'Indumentaria');
  assert.equal(categoryForBusiness({ category: 'Ferretería' }), 'Ferretería');
  assert.equal(categoryForBusiness(null), 'Otros');
});

test('la condición sólo acepta nuevo o usado y tiene etiqueta visible', () => {
  assert.equal(isProductCondition('new'), true);
  assert.equal(isProductCondition('used'), true);
  assert.equal(isProductCondition('Nuevo'), false, 'La etiqueta no se guarda como valor');
  assert.equal(normalizeProductCondition('used'), 'used');
  assert.equal(normalizeProductCondition('roto'), 'new');
  assert.equal(normalizeProductCondition(undefined), 'new');
  assert.equal(conditionLabel('used'), 'Usado');
  assert.equal(conditionLabel('new'), 'Nuevo');
});

test('los platos no se publican como nuevos ni entran en el filtro de condición', () => {
  const dish = { id: 'burger', name: 'La clásica', dishType: 'burger', condition: 'new' };
  const article = { id: 'lampara', name: 'Lámpara', dishType: '', condition: 'used' };
  assert.equal(productCondition(dish), '', 'Un plato preparado no es un artículo nuevo');
  assert.equal(productCondition(article), 'used');
  assert.equal(productCondition({ id: 'sin-condicion', dishType: '' }), 'new');
  assert.equal(productCondition(null), '');
});

test('la ficha de producto recibe tienda y producto desde la ruta', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /const \{ page, param, extra \} = route\(\)/,
    'El enrutador tiene que leer el tercer segmento de la URL');
  assert.match(app, /await view\(param, extra\)/,
    'La vista de producto necesita el id del producto además del id de la tienda');
  assert.match(app, /producto: viewProduct/, 'La ruta #producto/... tiene que estar conectada');
});

test('validar un producto exige condición, precio y categoría coherentes', () => {
  const valid = validateProductInput({
    name: 'Lámpara de mimbre', description: 'Pantalla tejida a mano.', category: 'Hogar',
    condition: 'used', price: 38000, stock: 2, available: true,
  }, { partial: false });
  assert.equal(valid.condition, 'used');
  assert.equal(valid.category, 'Hogar');
  assert.equal(valid.price, 38000);

  assert.throws(() => validateProductInput({
    name: 'Lámpara', category: 'Hogar', condition: 'roto', price: 1000, available: true,
  }, { partial: false }), /nuevo o usado/i);
  assert.throws(() => validateProductInput({
    name: 'Lámpara', category: 'Hogar', condition: 'new', price: 0, available: true,
  }, { partial: false }), /precio/i);
  assert.throws(() => validateProductInput({
    name: 'Lámpara', category: 'Hogar', condition: 'new', price: 1000, available: true,
    image: 'https://ejemplo.test/foto.jpg',
  }, { partial: false }), /imágenes incluidas/i);
  // Una ruta interna del proyecto sigue siendo válida para los catálogos heredados.
  assert.equal(validateImageReference('assets/images/dishes/burger-clasica.webp'),
    'assets/images/dishes/burger-clasica.webp');
});

test('la foto de demostración se limita a data URLs de imagen y a un tamaño razonable', () => {
  assert.equal(validateImageData(''), '');
  assert.equal(validateImageData(PNG), PNG);
  assert.throws(() => validateImageData('https://ejemplo.test/foto.png'), /JPEG, PNG o WebP/);
  assert.throws(() => validateImageData('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), /JPEG, PNG o WebP/);
  assert.throws(() => validateImageData('data:image/png;base64,@@@@'), /JPEG, PNG o WebP/);
  assert.throws(() => validateImageData(42), /formato válido/);
  const tooLarge = `data:image/png;base64,${'a'.repeat(MAX_IMAGE_DATA_LENGTH)}`;
  assert.throws(() => validateImageData(tooLarge), /muy pesada/);
});

test('los favoritos se guardan normalizados, sin duplicados y con tope', () => {
  assert.equal(favoriteKey('taller-malva', 'camisa-lino'), 'taller-malva/camisa-lino');
  assert.throws(() => favoriteKey('../otro', 'producto'), /Favorito inválido/);
  assert.throws(() => favoriteKey('taller-malva', 'a/b'), /Favorito inválido/);
  assert.deepEqual(parseFavoriteKey('taller-malva/camisa-lino'), { businessId: 'taller-malva', productId: 'camisa-lino' });
  assert.equal(parseFavoriteKey('taller-malva'), null);
  assert.equal(parseFavoriteKey('taller-malva/camisa/extras'), null);
  assert.equal(parseFavoriteKey('../x/producto'), null);

  assert.deepEqual(normalizeFavorites([
    'taller-malva/camisa-lino', 'taller-malva/camisa-lino', 'invalido', 42, 'tecno-pampa/teclado-mecanico',
  ]), ['taller-malva/camisa-lino', 'tecno-pampa/teclado-mecanico']);

  const many = Array.from({ length: MAX_FAVORITES + 20 }, (_, index) => `tienda-${index}/producto-${index}`);
  assert.equal(normalizeFavorites(many).length, MAX_FAVORITES, 'La lista local tiene un tope');
});

test('un favorito se agrega, se reconoce y se quita sin tocar el resto', () => {
  const storage = memoryStorage();
  assert.equal(hasFavorite(storage, 'taller-malva', 'camisa-lino'), false);
  const added = toggleFavorite(storage, 'taller-malva', 'camisa-lino');
  assert.equal(added.active, true);
  assert.equal(hasFavorite(storage, 'taller-malva', 'camisa-lino'), true);
  toggleFavorite(storage, 'tecno-pampa', 'teclado-mecanico');
  assert.deepEqual(readFavorites(storage), ['taller-malva/camisa-lino', 'tecno-pampa/teclado-mecanico']);
  const removed = toggleFavorite(storage, 'taller-malva', 'camisa-lino');
  assert.equal(removed.active, false);
  assert.deepEqual(removed.favorites, ['tecno-pampa/teclado-mecanico']);
});

test('un almacenamiento roto o ausente no rompe los favoritos', () => {
  assert.deepEqual(readFavorites(null), []);
  const broken = { getItem: () => '{no es json', setItem: () => { throw new Error('cuota'); } };
  assert.deepEqual(readFavorites(broken), []);
  assert.deepEqual(writeFavorites(broken, ['taller-malva/camisa-lino']), ['taller-malva/camisa-lino']);
  const hostile = { getItem: () => JSON.stringify(['taller-malva/camisa-lino', '../../etc/passwd']), setItem: () => {} };
  assert.deepEqual(readFavorites(hostile), ['taller-malva/camisa-lino']);
  assert.equal(FAVORITES_KEY, 'mifav:favorites:v1');
});

test('publicar guarda condición y foto, y queda fuera del alcance de otro vendedor', async () => {
  const { repo } = setupRepo();
  await repo.register({ email: 'vendedora@ejemplo.test', name: 'Vendedora Uno', phone: '2942000001' });
  const business = await repo.command('business.create', { name: 'Taller de Prueba', category: 'Hogar' });
  const product = await repo.command('product.create', {
    businessId: business.id,
    product: {
      name: 'Lámpara usada', description: 'Pantalla tejida, en buen estado.', category: 'Hogar',
      condition: 'used', price: 38000, stock: 1, trackStock: true, available: true,
    },
    image: PNG,
  });
  assert.equal(product.condition, 'used');
  assert.equal(product.image, PNG);
  const stored = await repo.query('products', { businessId: business.id });
  assert.equal(stored.find(item => item.id === product.id)?.condition, 'used');

  // Otro vendedor no puede cargar productos en el comercio ajeno.
  await repo.register({ email: 'vendedor-b@ejemplo.test', name: 'Vendedor Dos', phone: '2942000002' });
  await assert.rejects(repo.command('product.create', {
    businessId: business.id,
    product: {
      name: 'Producto ajeno', category: 'Hogar', condition: 'new', price: 1000, stock: 1, available: true,
    },
  }), /no puede|permiso|comercio/i);
  // Tampoco puede editar el producto ajeno.
  await assert.rejects(repo.command('product.update', {
    businessId: business.id, productId: product.id, patch: { price: 1000 },
  }), /no puede|permiso|comercio/i);
  // Y el catálogo del primero no cambió.
  const after = await repo.query('products', { businessId: business.id });
  assert.equal(after.find(item => item.id === product.id)?.price, 38000);
});

test('el comando de publicación rechaza una foto fuera de contrato', async () => {
  const { repo } = setupRepo();
  await repo.register({ email: 'foto@ejemplo.test', name: 'Vendedora Foto', phone: '2942000003' });
  const business = await repo.command('business.create', { name: 'Fotos de Prueba', category: 'Hogar' });
  await assert.rejects(repo.command('product.create', {
    businessId: business.id,
    product: { name: 'Producto', category: 'Hogar', condition: 'new', price: 1000, stock: 1, available: true },
    image: 'https://ejemplo.test/foto.png',
  }), /JPEG, PNG o WebP/);
});
