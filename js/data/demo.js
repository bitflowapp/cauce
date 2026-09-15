// Todos los nombres, importes, productos y comercios son ficticios.
const businesses = [
  { id: 'orilla', localityId: 'alumine', name: 'La Orilla', category: 'Hamburguesas', initials: 'LO', theme: 'sage', description: 'Hamburguesas caseras, papas y algo rico para compartir.', hoursLabel: 'Horario de ejemplo · 19 a 23 h', eta: '30–45 min', active: true, open: true, deliveryEnabled: true, pickupEnabled: true, deliveryFee: 1500, minimumOrder: 8000 },
  { id: 'horno', localityId: 'alumine', name: 'Horno del Sur', category: 'Pizzas', initials: 'HS', theme: 'clay', description: 'Pizza de masa lenta y empanadas recién hechas.', hoursLabel: 'Horario de ejemplo · 12 a 15 / 19 a 23 h', eta: '25–40 min', active: true, open: true, deliveryEnabled: true, pickupEnabled: true, deliveryFee: 1200, minimumOrder: 6000 },
  { id: 'ronda', localityId: 'alumine', name: 'Ronda Cocina', category: 'Comida casera', initials: 'RC', theme: 'sand', description: 'Platos de todos los días, con ingredientes simples.', hoursLabel: 'Horario de ejemplo · 12 a 15 h', eta: '20–30 min', active: true, open: false, deliveryEnabled: false, pickupEnabled: true, deliveryFee: 0, minimumOrder: 0 },
];
const products = [
  ['orilla', 'burger-clasica', 'La clásica', 'Carne, queso, lechuga y tomate. Con papas.', 'Hamburguesas', 10500],
  ['orilla', 'burger-doble', 'Doble de la casa', 'Dos medallones, cheddar y cebolla. Con papas.', 'Hamburguesas', 13500],
  ['orilla', 'burger-veggie', 'La de vegetales', 'Medallón de lentejas, hojas y salsa de la casa.', 'Hamburguesas', 10000],
  ['orilla', 'papas', 'Papas para compartir', 'Papas rústicas y dos salsas.', 'Para compartir', 5500],
  ['orilla', 'limonada', 'Limonada', 'Limón, menta y jengibre. 500 ml.', 'Bebidas', 2500],
  ['horno', 'pizza-muzza', 'Muzzarella', 'Salsa de tomate, muzzarella y aceitunas. 8 porciones.', 'Pizzas', 12000],
  ['horno', 'pizza-napo', 'Napolitana', 'Muzzarella, tomate y ajo. 8 porciones.', 'Pizzas', 14500],
  ['horno', 'empanadas', 'Media docena', 'Seis empanadas de carne cortada a cuchillo.', 'Empanadas', 8500],
  ['horno', 'pizza-fugazza', 'Fugazzeta', 'Muzzarella, cebolla y orégano. 8 porciones.', 'Pizzas', 14000],
  ['horno', 'agua', 'Agua sin gas', 'Botella de 500 ml.', 'Bebidas', 1800],
  ['ronda', 'tarta', 'Tarta de verduras', 'Porción con ensalada de estación.', 'Platos', 7500],
  ['ronda', 'milanesa', 'Milanesa con puré', 'Milanesa al horno y puré de papas.', 'Platos', 9500],
  ['ronda', 'ensalada', 'Ensalada completa', 'Hojas, legumbres, vegetales asados y semillas.', 'Platos', 8000],
].map(([businessId, id, name, description, category, price]) => ({ id, businessId, localityId: 'alumine', name, description, category, price, priceStatus: 'confirmed', available: true, archived: false, stock: 30 }));
export function initialDemoState() {
  return structuredClone({ schemaVersion: 1, localities: [{ id: 'alumine', name: 'Aluminé', province: 'Neuquén', timezone: 'America/Argentina/Salta' }], businesses, products,
    riders: businesses.filter(b => b.deliveryEnabled).map(b => ({ id: `rider-${b.id}`, businessId: b.id, localityId: b.localityId, name: `Repartidor demo · ${b.name}` })),
    orders: [], carts: {}, requests: {}, sequence: 0 });
}
