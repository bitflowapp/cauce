# Arquitectura de la primera entrega

## Alcance implementado

Frontend web mobile-first sin dependencias npm de ejecución. Datos exclusivamente
ficticios guardados en el navegador. El servidor Node sirve una lista limitada de
archivos por loopback, nunca credenciales, tests, documentación ni scripts.

`config` → `repository-factory` → repositorio demo → núcleo de comercio/pedido.

La interfaz no realiza solicitudes de datos a servicios externos. La política
CSP bloquea conexiones; `createRepository` rechaza cualquier configuración que
pretenda habilitar producción. No hay un adaptador Supabase incompleto escondido
tras una función vacía ni fallback silencioso de producción a demo.

## Reutilización y responsabilidades

`order-workflow.js`: máquina de estados y compatibilidad heredadas, sin cambios.
`commercial.js`: comprobaciones comerciales extraídas del código real.
`workflow-policy.js`: permisos funcionales del simulador, estados estrictos,
entrega contra retiro y asignación de repartidor del comercio.
`scope.js`: identidad explícita `localityId` + `businessId`.
`cart.js`: cantidades, productos propios, cotización y pedido mínimo.
`demo-repository.js`: persistencia de fixtures, idempotencia y operaciones demo.
`app.js`: pantallas y eventos de interfaz; no contiene claves ni llamadas remotas.

## Decisiones acotadas

Primera localidad: Aluminé. El modelo contiene una colección de localidades y
las claves incluyen localidad; no hay gestión de localidades en la interfaz.
Cada carrito y pedido pertenece a un único comercio. Cambiar de comercio conserva
un carrito distinto; no existe checkout mezclado ni un cobro repartido.
Delivery: repartidor del comercio. No se implementó una flota municipal ni un
mercado global de repartidores. Se conserva únicamente la secuencia de estados.
Los comercios y las categorías son fixtures: no hay alta de comercios ni CRUD
completo de productos. El panel permite precio, stock, disponibilidad y apertura
manual. Los horarios y tiempos mostrados son ejemplos, no promesas operativas.

## Seguridad: frontera explícita

El repositorio demo NO es una frontera de autorización. El usuario puede abrir
cualquier panel demo y examinar localStorage. Las comprobaciones por ámbito son
invariantes funcionales para detectar mezclas accidentales, no autenticación ni
RLS. Nunca usar este repositorio con datos personales, comercios reales o dinero.

En producción, pedidos, precios, stock, membresías, asignaciones e idempotencia
deberán ser autorizados y confirmados por el backend. El frontend solo podrá
anticipar errores de UX. Las políticas de lectura y escritura, RPC privilegiadas
y canales de realtime necesitan pruebas negativas con identidades separadas.

## Persistencia y concurrencia del simulador

Cada operación lee el documento, valida y lo guarda completo. Cuando el navegador
dispone de Web Locks, se usa un lock por origen. Si no, se serializan las
operaciones de esa instancia; NO se garantiza atomicidad entre pestañas sin Web
Locks. Esa limitación no debe trasladarse al backend.

Los pedidos usan requestId durable y rechazan reutilizarlo con otro payload.
Una respuesta repetida devuelve el pedido existente sin descontar stock de nuevo.
Se controlan versiones al cambiar estados. La cancelación terminal no repone dos
veces el stock. Son propiedades locales del simulador, no garantías financieras.

## Migración que sigue pendiente

1. Obtener una copia íntegra y verificable del código y migraciones de la rama
   elegida de La Taba; comparar con la rama commerce-v3 observada.
2. Inventariar tablas, RPC, políticas, roles, Auth y canales reales. Mantener el
   motor operativo que sea reutilizable, en vez de reemplazarlo por esta demo.
3. Crear un proyecto Supabase NUEVO para CAUCE, sin restaurar datos de clientes ni
   secretos de La Taba. Provisionarlo requiere autorización independiente.
4. Añadir localidades y membresías solo donde el esquema real lo necesite;
   generar migraciones con la CLI y ensayarlas en una base aislada.
5. Adaptar repositorios, carrito, catálogo, panel y delivery a ámbitos reales;
   cerrar el ciclo de vida anterior al cambiar de comercio.
6. Portar pagos con seller por comercio, manteniendo toda operación monetaria
   deshabilitada hasta probar propiedad, idempotencia, webhooks y reembolsos.
7. Ejecutar la batería original completa, nuevos tests de RLS y E2E reales.

Esta lista no representa funcionalidades terminadas. Los archivos de código son
la primera entrega ejecutable para continuar esa migración, no su sustituto.
