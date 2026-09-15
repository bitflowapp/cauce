# Inspección inicial de La Taba — alcance y hallazgos

Fecha de la inspección: 15 de septiembre de 2026.
NO es una auditoría exhaustiva. Los hallazgos siguientes se limitan al código
leído y no certifican producción, pagos, RLS ni el estado desplegado de La Taba.

## Archivos efectivamente revisados

En `main@a4d54dea45c8822a2c50956fad86ac90c1610292`:

- `package.json`: completo.
- `js/config.js`: completo.
- `js/repositories/repository_factory.js`: completo.
- `js/core/order-status.js`: completo.
- `js/core/order-workflow.js`: completo.
- `js/core/pricing.js`: completo.
- `tests/order-workflow.test.mjs`: completo.
- `js/app.js`: líneas 1–145 solamente.
- `js/orders.js`: líneas 1–130 solamente.
- `js/repositories/supabase_order_repository.js`: líneas 1–220 solamente.

Se consultaron listados de ramas y directorios raíz, `js` y `supabase`. Algunas
respuestas de directorios fueron truncadas; no constituyen un inventario completo.
Se verificaron metadatos de las ramas main, producción de bebidas y commerce-v3.

## Hallazgos para la migración

### 1. La aplicación no carece por completo de noción de comercio

`createSupabaseOrderRepository` recibe y valida un `businessId`. Las claves
`pendingStorageKey` y `lastAccessStorageKey` incorporan ese identificador.
Esto permite estudiar una adaptación multi-comercio sin sustituir a ciegas
el repositorio de pedidos. No demuestra que todas las tablas o RPC estén aisladas.

### 2. Hay estado de aplicación global que debe delimitarse

`repository_factory.js` guarda una única instancia de `orderRepository` en el
módulo. `config.js` define identidad, claves de localStorage y configuración
predeterminada para un comercio. `app.js` importa estado, carrito, configuración
y sincronización globales. Cambiar únicamente `businessId` sin cerrar listeners,
polling y canales anteriores podría mezclar vistas; esto es un riesgo de
migración, no una vulnerabilidad productiva demostrada.

La entrega CAUCE usa funciones que reciben un ámbito explícito de localidad y
comercio. Los tests verifican esas invariantes locales. No sustituyen RLS.

### 3. Hay dos representaciones del estado del pedido

`order-status.js` corresponde al flujo simplificado y contiene alias como
`received` y `cancelled`. `order-workflow.js` contiene el flujo canónico más rico,
con `submitted`, `accepted`, `assigned`, `picked_up`, `arrived` y `canceled`.
La nueva demostración usa el segundo módulo, conservado exactamente. Una capa
adicional exige estados canónicos y limita las acciones por rol simulado y tipo
de entrega. No se reemplazó la máquina original por estados arbitrarios.

### 4. El precio y el stock tienen estados comerciales explícitos

`pricing.js` diferencia precio pendiente de cero y stock desconocido de agotado.
La función de compra exige precio positivo, stock conocido y disponible. Se
extrajeron estas comprobaciones y se volvió explícita la tarifa del comercio.
Los importes de esta demo son pesos enteros y no se utilizan para cobrar.

### 5. Los scripts originales no son seguros como configuración predeterminada de CAUCE

`package.json` incluye comandos de release, alta de identidades, importación
comercial y cambios de configuración que apuntan a producción. La entrega NO
los copia ni los ejecuta. Su presencia no significa que se hayan activado pagos.
El PIN de `config.js` pertenece a configuración demo; no se afirma que sea una
credencial válida para autenticación productiva.

### 6. La Taba ya contempla protecciones que todavía no se migraron

El encabezado del repositorio Supabase explica idempotencia durable, seguimiento
por token, separación del GPS público y disponibilidad comercial. Son mecanismos
a preservar y revisar integralmente. No se certificó su implementación completa,
ni se portaron los endpoints financieros a CAUCE.

### 7. main no es la rama más reciente observada

`feat/taba-commerce-v3@6319e690472b1041edda90ea54832d09641b023e` tiene fecha
15/09/2026 y `main@a4d54dea45c8822a2c50956fad86ac90c1610292` fecha 09/09/2026.
Los blobs consultados de workflow y pricing coinciden. El rediseño completo y sus
cambios adicionales no fueron incorporados a este paquete. La siguiente etapa
necesita un snapshot íntegro de la rama elegida, no asumir que main contiene todo.

## No inspeccionado exhaustivamente

Esquema SQL acumulado, migraciones completas, RLS, funciones privilegiadas, Auth,
OAuth/PKCE de Mercado Pago, webhooks, reembolsos, workers, publicación Android,
Tauri, ARCA, service workers, CI y todos los tests originales. No se informó
PASS para estas áreas.

## Documentación oficial consultada

- Supabase Changelog: https://supabase.com/changelog
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security

No se ejecutó SQL contra ningún proyecto. No se creó una migración especulativa
ni se modificó una migración histórica. No se usaron datos productivos.
