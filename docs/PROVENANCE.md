# Procedencia del código y Reutilización de La Taba

## Principio Rector de Arquitectura
CAUCE toma formalmente a **La Taba** (`bitflowapp/la-taba-pages-preview`) como su base técnica, de dominio y de hardening histórico. Los módulos maduros fueron auditados e integrados desacoplando la lógica de negocio único a un modelo multi-comercio y multi-localidad (`localityId`, `businessId`).

---

## Tabla de Módulos Reutilizados y Adaptados

| Módulo CAUCE | Archivo Fuente en La Taba | Estado de Reutilización | Adaptaciones Realizadas |
|---|---|---|---|
| `js/core/order-workflow.js` | `js/core/order-workflow.js` | **Copia directa** | Idéntico: 11 estados canónicos, transiciones autorizadas, flujos delivery vs. pickup. |
| `js/core/order-status.js` | `js/core/order-status.js` | **Adaptado** | Catálogo de estados, etiquetas operativas y compatibilidad con workflow. |
| `js/core/order-timeline.js` | `js/core/order-timeline.js` | **Adaptado** | Componente visual unificado para etapas operativas (5 pasos) y públicas del cliente (4 pasos). |
| `js/core/commercial.js` | `js/core/pricing.js` | **Adaptado** | Precio pendiente, stock ausente vs. cero, compuerta comercial, cálculo de subtotales y totales. |
| `js/core/cart.js` | `js/cart.js` | **Adaptado** | Límites de cantidad, operaciones de carrito y `validateCartForCheckout` scoped por comercio. |
| `js/core/cart-storage.js` | `js/core/production-cart-storage.js` | **Adaptado** | Esquema v2, expiración 72h, sanitización, fusión multi-pestaña `mergeCartMutation` scoped por comercio. |
| `js/core/validators.js` | `js/core/validators.js` | **Adaptado** | Validaciones de teléfonos argentinos, nombres latinos, saneamiento contra caracteres de control. |
| `js/core/delivery-code.js` | `js/core/delivery-code.js` | **Adaptado** | Código de seguridad de 4 dígitos para entrega de pedidos a domicilio y verificación. |
| `js/core/rider.js` | `js/core/rider.js` | **Adaptado** | Cola de reparto, prioridad de asignación, estados de acción y minimización de datos en cocina. |
| `js/core/geo-point.js` | `js/core/geo-point.js` | **Copia directa** | Contrato estricto de coordenadas finitas (evita interpretar ausencia/null como 0,0). |
| `js/core/delivery-location.js` | `js/core/delivery-location.js` | **Adaptado** | Contrato de punto de entrega confirmado: coordenadas, origen declarado y fecha de confirmación. |
| `js/business/sound-service.js` | `js/business/business-sound-service.js` | **Adaptado** | Síntesis armónica Web Audio API de dos tonos para notificación de nuevos pedidos. |
| `js/core/business-metrics.js` | `js/core/business-metrics.js` | **Adaptado** | Cálculo de facturación diaria, ticket promedio, pedidos en cocina y alertas de stock bajo. |
| `js/core/kitchen-ticket.js` | `js/orders.js` (`buildKitchenTicket`) | **Adaptado** | Generación de comanda térmica de 32 columnas para cocina y mostrador. |

---

## Tabla de Tests Reutilizados y Adaptados

| Test CAUCE | Test Fuente en La Taba | Alcance y Cobertura |
|---|---|---|
| `tests/order-workflow.test.mjs` | `tests/order-workflow.test.mjs` | Mapeo bidireccional de estados y transiciones válidas. |
| `tests/order-timeline.test.mjs` | `tests/order-timeline.test.mjs` | Índices operacionales, vista pública y generación accesible. |
| `tests/validators.test.mjs` | `tests/validators.test.mjs` / `customer-profile-completion.test.mjs` | Teléfonos argentinos, formato, nombres, caracteres de control. |
| `tests/delivery-code.test.mjs` | `tests/delivery-code.test.mjs` | Formato 4 dígitos, confirmación de entrega y horas en ciclo 24h. |
| `tests/rider.test.mjs` | `tests/rider.test.mjs` | Asignación, prioridad de cola, protección de datos en cocina. |
| `tests/cart-storage.test.mjs` | `tests/production-cart-storage.test.mjs` | Particionado por ámbito, sanitización, expiración y fusión multi-pestaña. |
| `tests/delivery-location.test.mjs` | `tests/delivery-location-contract.test.mjs` | Coordenadas finitas, huella de dirección y obligatoriedad en delivery. |
| `tests/cauce.test.mjs` | Múltiples tests de La Taba adaptados | Idempotencia, stock rollback, límites comerciales, aislamiento multi-tenant. |
