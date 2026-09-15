// Formateador de comanda de cocina y mostrador adaptado de La Taba.
// Permite al comerciante ver o copiar el ticket de preparación sin dependencias externas.

export function buildKitchenTicket(order, businessName = 'Comercio') {
  if (!order) return '';
  const isPickup = order.fulfillment === 'pickup';
  const createdAt = order.history?.[0]?.at ? new Date(order.history[0].at).toLocaleString('es-AR') : new Date().toLocaleString('es-AR');
  const lines = [
    `================================`,
    `  ${String(businessName).toUpperCase()}`,
    `  COMANDA DE COCINA / MOSTRADOR`,
    `================================`,
    `Código: ${order.code}`,
    `Fecha:  ${createdAt}`,
    `Modo:   ${isPickup ? 'RETIRO EN EL LOCAL' : 'DELIVERY A DOMICILIO'}`,
    `Cliente: ${order.customer?.name || 'Cliente'}`,
    `Tel:     ${order.customer?.phone || '—'}`,
    ...(!isPickup && order.customer?.address ? [`Destino: ${order.customer.address}`] : []),
    ...(order.customer?.notes ? [`Notas:   ${order.customer.notes}`] : []),
    `--------------------------------`,
    `ITEMS:`,
    ...(Array.isArray(order.lines) ? order.lines.map(line => ` [ ] ${line.quantity} x ${line.name}`) : []),
    `--------------------------------`,
    `TOTAL:   $${Number(order.total || 0).toLocaleString('es-AR')}`,
    `PAGO:    ${order.customer?.paymentMethod === 'transfer' ? 'Transferencia' : order.customer?.paymentMethod === 'mercadopago' ? 'Mercado Pago (Demo)' : 'Efectivo contra entrega'}`,
    `================================`,
  ];
  return lines.join('\n');
}
