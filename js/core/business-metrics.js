// Métricas comerciales adaptadas de La Taba para el panel del comercio en CAUCE.

const TERMINAL_STATUSES = new Set(['delivered', 'canceled']);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function getActiveOrders(orders = []) {
  if (!Array.isArray(orders)) return [];
  return orders.filter(order => order && !isTerminalStatus(order.status));
}

export function calculateBusinessMetrics(orders = [], products = []) {
  const activeOrders = getActiveOrders(orders);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  let todayRevenue = 0;
  let todayOrderCount = 0;
  let activeCount = activeOrders.length;
  let deliveryCount = 0;
  let pickupCount = 0;
  const productTally = new Map();

  for (const order of orders) {
    if (!order || order.status === 'canceled') continue;
    const createdAt = order.history?.[0]?.at ? new Date(order.history[0].at).getTime() : 0;
    // Si el pedido es de hoy o es un pedido demo activo
    const isToday = createdAt >= startOfToday || activeOrders.includes(order);

    if (isToday) {
      todayOrderCount += 1;
      todayRevenue += Number(order.total) || 0;
      if (order.fulfillment === 'pickup') pickupCount += 1;
      else deliveryCount += 1;
    }

    if (Array.isArray(order.lines)) {
      for (const line of order.lines) {
        if (!line) continue;
        const current = productTally.get(line.name) || { name: line.name, quantity: 0 };
        current.quantity += Number(line.quantity) || 1;
        productTally.set(line.name, current);
      }
    }
  }

  const averageTicket = todayOrderCount > 0 ? Math.round(todayRevenue / todayOrderCount) : 0;
  const topProducts = [...productTally.values()]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);

  const lowStockProducts = (Array.isArray(products) ? products : []).filter(
    p => p && p.available && Number(p.stock) > 0 && Number(p.stock) <= 5
  );

  return {
    todayRevenue,
    todayOrderCount,
    averageTicket,
    activeCount,
    deliveryCount,
    pickupCount,
    topProducts,
    lowStockCount: lowStockProducts.length,
  };
}
