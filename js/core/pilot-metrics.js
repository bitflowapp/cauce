// Métricas del piloto para la administración de la plataforma: lo que devuelve
// admin_pilot_metrics, normalizado para la interfaz. Nunca trae datos de
// clientes: sólo comercios, códigos de pedido e importes agregados.

// Por qué un pedido figura en "necesitan atención" (umbrales en la migración
// 20260925150000: 15 min sin respuesta, 60 en preparación, 45 listo, 90 en reparto).
export const STUCK_REASONS = Object.freeze({
  submitted: 'Sin respuesta del comercio',
  accepted: 'Aceptado y sin empezar',
  preparing: 'En preparación hace mucho',
  ready: 'Listo y sin retirar ni asignar',
  assigned: 'Asignado y sin salir',
  picked_up: 'Retirado y sin llegar',
  on_the_way: 'En camino hace mucho',
  arrived: 'En el domicilio sin cerrar',
});

const count = value => Math.max(0, Number(value) || 0);

export function durationText(minutes) {
  const total = count(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  if (hours < 24) return total % 60 ? `${hours} h ${total % 60} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function mapPilotMetrics(row = {}) {
  const businesses = row.businesses || {};
  const today = row.today || {};
  return {
    generatedAt: row.generated_at || '',
    dayStart: row.day_start || '',
    timezone: row.timezone || '',
    businesses: {
      active: count(businesses.active), paused: count(businesses.paused), suspended: count(businesses.suspended),
      pendingReview: count(businesses.pending_review), openNow: count(businesses.open_now),
    },
    today: {
      orders: count(today.orders), pickup: count(today.pickup), delivery: count(today.delivery),
      inProgress: count(today.in_progress), delivered: count(today.delivered), canceled: count(today.canceled),
      gross: count(today.gross_ars), averageTicket: count(today.average_ticket_ars),
    },
    perBusiness: (Array.isArray(row.per_business) ? row.per_business : []).map(item => ({
      id: item.id, name: item.name || '', status: item.status || '', openNow: item.open_now === true,
      orders: count(item.orders), delivered: count(item.delivered), gross: count(item.gross_ars),
    })),
    stuckTotal: count(row.stuck_total ?? (Array.isArray(row.stuck) ? row.stuck.length : 0)),
    stuck: (Array.isArray(row.stuck) ? row.stuck : []).map(item => ({
      id: item.id, code: item.code || '', status: item.status || '', fulfillment: item.fulfillment || '',
      businessId: item.business_id, business: item.business || '', phone: item.phone || '',
      minutes: count(item.minutes), reason: STUCK_REASONS[item.status] || 'Sin movimiento',
    })),
    errors: { total: count(row.errors_24h?.total), critical: count(row.errors_24h?.critical) },
  };
}
