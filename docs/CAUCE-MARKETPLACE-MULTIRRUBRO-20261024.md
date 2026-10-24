# CAUCE · Marketplace multirrubro — plan de implementación

Fecha: 2026-10-24. Estado: planificación de implementación, NO lanzamiento productivo.

## Contexto verificado

- Repositorio base: `bitflowapp/cauce`.
- `main` conserva código de Supabase Auth, Postgres/RLS, catálogo, pedidos y panel, pero `.github/deploy-target` está en `demo` desde la reversión del 17/10/2026.
- El README y PRODUCTION_READINESS.md contienen información histórica de septiembre; no se deben interpretar como verificación vigente de producción.
- Conservar estable la demo publicada; no activar pagos, migrar datos, cambiar secretos ni desplegar producción sin pruebas y autorización.

## Propuesta de producto

CAUCE es una plataforma abierta para feriantes, emprendimientos, restaurantes, comercios y servicios. El alta es autogestionada, pero cada tienda pasa por validación y aprobación antes de publicarse. CAUCE provee software e intermediación tecnológica: el vendedor controla su inventario, precio, pedidos, cobro, retiro y reparto propio; CAUCE no custodia fondos.

### Lanzamiento prioritario: ventas reales simples

1. Registro por correo, confirmación, recuperación de contraseña y perfil de vendedor.
2. Alta de negocio: nombre, rubro, localidad, contacto, horario, modalidad de entrega y términos aceptados; estados borrador / pendiente / aprobado / suspendido. Validación de datos sensibles y reglas anti-spam.
3. Tienda pública única con URL compartible, fotos, categorías, precio y disponibilidad; edición exclusiva por propietario y roles autorizados.
4. Búsqueda por rubro/localidad, catálogo y carrito. Pedido con retiro o entrega propia, cálculo de total en servidor, confirmación, estados y notificaciones.
5. Restaurante: carta, disponibilidad y franjas horarias; no prometer reservas de mesa ni logística externa sin módulo específico.
6. Feria: perfil del feriante, feria y puesto, fecha/lugar, retiro en feria; conservar experiencia física como parte del producto.
7. Administración: moderación de altas, publicaciones denunciadas, suspensión, auditoría básica, gestión de incidencias.
8. Legal y confianza: datos del proveedor, información clara de compra, contacto, políticas, reclamos, cancelaciones y obligaciones aplicables en Argentina.

### Monetización gradual

- Entrada gratuita limitada para facilitar adquisición, sin imponer cobro previo a pilotos.
- Plan premium mensual por mayor catálogo, analítica y personalización de tienda.
- Promociones destacadas identificadas como publicidad.
- No cobrar comisiones automatizadas sin contratos, conciliación e infraestructura de pagos verificados.
- Caja Clara como integración optativa futura para vendedores, sin bloquear ventas.

## Entregas técnicas con condiciones de aceptación

### Fase 0 — recuperar base conectada sin publicar (P0)

- Auditar diferencias desde el último deploy conectado y la reversión a demo.
- Inventariar migraciones, tablas, roles, políticas RLS, Auth y funciones SQL; verificar compatibilidad de esquema con código.
- Reproducir `npm ci && npm run verify` y CI de integración/E2E con Supabase **local**. Corregir fallos antes de agregar funciones.
- Ejecutar pruebas de aislamiento: vendedor A jamás accede a pedidos/clientes/archivos de B.
- Entregar reporte PASS/FAIL con evidencia reproducible. Mantener `deploy-target=demo`.

### Fase 1 — onboarding multirrubro

- Construir flujo completo de alta, validaciones y aprobación; no altas simuladas cuando se use el backend real.
- Modelar taxonomía de rubros y capacidades por negocio (productos, comida preparada, reservas futuras) sin duplicar tablas por vertical.
- Ajustar pantallas de comprador, vendedor y administrador para móvil y desktop.
- Tests unitarios, RLS, integración y E2E: alta → aprobación → publicar producto → cliente pide → vendedor procesa.

### Fase 2 — ferias y restaurantes

- Feriantes: evento, organizador, puestos, agenda y modalidad de retiro por evento.
- Restaurantes: menú, disponibilidad, horarios, pedidos preparados, entrega propia y retiro.
- No mezclar inventario o pedidos entre inquilinos; compatibilidad con datos previos.

### Fase 3 — conversión y crecimiento

- Perfil público compartible, QR de tienda y difusión por WhatsApp.
- Métricas de conversión y pedidos para cada negocio; dashboard admin sin exponer información de otros vendedores.
- Suscripción premium manual/gestionada al principio; publicidad destacada moderada.
- Piloto con 5–10 comercios/feriantes activos; éxito: al menos 5 productos publicados y un pedido de prueba completado por comercio en siete días.

## Prohibiciones operativas

- No tocar producción, no conmutar a `production`, no aplicar migraciones remotas ni activar Mercado Pago por defecto.
- No usar datos reales para pruebas ni publicar secretos.
- No afirmar que está listo para el público hasta completar prueba end-to-end y revisión de obligaciones legales.
- No forzar el uso de Caja Clara ni crear un segundo marketplace independiente sin necesidad.

## Próximo cambio de código recomendado

Implementar y probar la taxonomía de rubros y las capacidades por comercio con una migración aditiva, más onboarding accesible y pruebas de aislamiento RLS en la misma rama; mantener el build de demostración publicado hasta que pasen todas las compuertas.
