import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDemoState } from '../js/data/demo.js';
import { initialState } from '../js/domain/state.js';
import { createLocalRepository } from '../js/repositories/local-repository.js';
import { calculateBusinessMetrics } from '../js/core/business-metrics.js';
import { buildKitchenTicket } from '../js/core/kitchen-ticket.js';
import { createBusinessSoundService } from '../js/business/sound-service.js';
import { scopeOf } from '../js/core/scope.js';

function setupRepo() {
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const repo = createLocalRepository({ storage, uuid, locks: null, seed: initialState, clock: () => new Date().toISOString() });
  return { repo, storage, values };
}

test('catálogo comercial contiene 7 comercios patagónicos ficticios y plausibles', () => {
  const state = initialDemoState();
  assert.equal(state.businesses.length, 7);
  const ids = state.businesses.map(b => b.id);
  assert.deepEqual(ids, ['orilla', 'horno', 'pehuen', 'plaza', 'rioarriba', 'ronda', 'union']);
  for (const b of state.businesses) {
    assert.equal(b.localityId, 'alumine');
    assert.ok(b.name.length >= 4);
    assert.ok(b.description.length >= 10);
    assert.ok(b.address.length >= 5);
  }
});

test('catálogo cuenta con más de 50 productos con asignación de categoría y tipo visual', () => {
  const state = initialDemoState();
  assert.ok(state.products.length >= 50, `Se esperaban >= 50 productos, hay ${state.products.length}`);
  for (const p of state.products) {
    assert.ok(p.price > 0, `Precio inválido en ${p.id}`);
    assert.ok(['burger', 'fries', 'pizza', 'empanadas', 'milanesa', 'pasta', 'cafe', 'medialuna', 'sandwich', 'picada', 'torta', 'beer', 'lemonade'].includes(p.dishType));
  }
});

test('cálculo de métricas del comercio computa totales, ticket promedio y activos', () => {
  const orders = [
    {
      id: 'o1',
      total: 10000,
      fulfillment: 'delivery',
      status: 'preparing',
      lines: [{ name: 'La clásica', quantity: 1 }],
      history: [{ status: 'received', at: new Date().toISOString() }],
    },
    {
      id: 'o2',
      total: 20000,
      fulfillment: 'pickup',
      status: 'delivered',
      lines: [{ name: 'La clásica', quantity: 2 }, { name: 'Papas', quantity: 1 }],
      history: [{ status: 'received', at: new Date().toISOString() }],
    },
    {
      id: 'o3',
      total: 5000,
      fulfillment: 'pickup',
      status: 'canceled',
      lines: [{ name: 'Limonada', quantity: 1 }],
      history: [{ status: 'received', at: new Date().toISOString() }],
    },
  ];
  const products = [
    { id: 'p1', available: true, stock: 3 },
    { id: 'p2', available: true, stock: 20 },
  ];
  const metrics = calculateBusinessMetrics(orders, products);
  assert.equal(metrics.todayOrderCount, 2); // cancelado no suma a ventas
  assert.equal(metrics.todayRevenue, 30000);
  assert.equal(metrics.averageTicket, 15000);
  assert.equal(metrics.activeCount, 1); // solo preparing
  assert.equal(metrics.lowStockCount, 1); // stock <= 5
  assert.equal(metrics.topProducts[0].name, 'La clásica');
  assert.equal(metrics.topProducts[0].quantity, 3);
});

test('comanda de cocina genera formato legible con ítems y modalidad', () => {
  const sampleOrder = {
    code: 'CA-0042',
    fulfillment: 'delivery',
    total: 14500,
    customer: { name: 'Juan Carlos', phone: '2942-123456', address: 'Av. 4 de Febrero 250', notes: 'Sin hielo' },
    lines: [{ name: 'Doble de la casa', quantity: 2 }, { name: 'Papas rústicas', quantity: 1 }],
    history: [{ status: 'received', at: '2026-09-15T12:00:00Z' }],
  };
  const ticket = buildKitchenTicket(sampleOrder, 'La Orilla');
  assert.match(ticket, /LA ORILLA/);
  assert.match(ticket, /CA-0042/);
  assert.match(ticket, /DELIVERY A DOMICILIO/);
  assert.match(ticket, /2 x Doble de la casa/);
  assert.match(ticket, /Av\. 4 de Febrero 250/);
});

test('servicio sonoro Web Audio respeta silenciado y muting', async () => {
  const service = createBusinessSoundService();
  assert.equal(service.muted, false);
  service.setMuted(true);
  assert.equal(service.muted, true);
  const playedWhileMuted = await service.playNewOrder();
  assert.equal(playedWhileMuted, false);
});

test('el comercio actualiza su demora y su costo de envío desde su propia sesión', async () => {
  const { repo } = setupRepo();
  await repo.signInAsDemoIdentity('acc-orilla');
  await repo.command('business.update', {
    businessId: 'orilla', patch: { eta: '45–60 min', deliveryFee: 2000 },
  });
  const updated = await repo.query('business', { businessId: 'orilla' });
  assert.equal(updated.eta, '45–60 min');
  assert.equal(updated.deliveryFee, 2000);
});

test('el alta de un comercio queda registrada con estado, no como un interesado suelto', async () => {
  const { repo } = setupRepo();
  await repo.register({ email: 'nueva@ejemplo.test', name: 'Ana Rossi', phone: '2942889900' });
  const business = await repo.command('business.create', { name: 'Dulces del Río', category: 'Repostería' });
  assert.equal(business.status, 'draft');
  assert.equal(business.ownerName, 'Ana Rossi');
  const mine = await repo.query('myBusinesses');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, business.id);
});

test('un producto sin control de stock se vende mientras esté disponible', async () => {
  const { knownStock, isCommerciallyPurchasable, UNTRACKED_STOCK } = await import('../js/core/commercial.js');
  const product = { price: 1200, stock: 0, trackStock: false, available: true, archived: false };
  assert.equal(knownStock(product), UNTRACKED_STOCK);
  assert.equal(isCommerciallyPurchasable(product), true);
  assert.equal(isCommerciallyPurchasable({ ...product, available: false }), false);
  assert.equal(isCommerciallyPurchasable({ ...product, trackStock: true }), false, 'con control, cero es agotado');
});
