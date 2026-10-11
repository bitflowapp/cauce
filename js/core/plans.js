// Estados de la suscripción como los calcula la base (por fecha, sin tareas programadas).
export const SUBSCRIPTION_STATE = Object.freeze({
  trial: { label: 'Prueba', tone: 'info' },
  active: { label: 'Vigente', tone: 'ok' },
  grace: { label: 'En período de gracia', tone: 'warn' },
  expired: { label: 'Vencida', tone: 'error' },
  canceled: { label: 'Cancelada', tone: 'error' },
  none: { label: 'Sin plan todavía', tone: 'neutral' },
});

export const stateInfo = state => SUBSCRIPTION_STATE[state] || SUBSCRIPTION_STATE.none;

/** Qué incluye un plan, en palabras. */
export function planFeatures(plan) {
  if (plan.audience === 'organizer') {
    return [`Hasta ${plan.max_active_fairs} ferias publicadas a la vez`, 'Inscripciones y asignación de puestos',
      'Avisos a participantes', 'Métricas de cada feria', 'Enlace para compartir'];
  }
  return [
    `Hasta ${plan.max_products} productos y ${plan.max_images_per_product} fotos por producto`,
    'Tienda con enlace y QR para compartir', 'Pedidos con retiro acordado y envío propio',
    plan.fair_pickup ? 'Retiro en tu puesto de feria' : 'Inscripción a ferias',
    plan.staff_seats ? `${plan.staff_seats === 1 ? 'Una persona' : `${plan.staff_seats} personas`} de ayuda en el panel` : 'Panel para vos',
    plan.advanced_stats ? 'Estadísticas ampliadas (más vendidos, por feria)' : 'Estadísticas básicas',
    ...(plan.featured ? ['Tienda recomendada en el inicio'] : []),
  ];
}
