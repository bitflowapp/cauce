# Administración del piloto

Qué ve y qué hace la administración de CAUCE durante el piloto (5 a 20
comercios en Aluminé), qué significa cada número y dónde mirar después de cada
publicación. Todo sale de la base: la administración no lee pedidos ni datos de
clientes; recibe agregados y códigos de pedido.

## Acceso

- `#admin`, con una cuenta que figure en `private.platform_admins`. Esa tabla
  sólo se escribe con SQL de operación (`scripts/operacion.mjs admin`): nunca
  por registro, metadata ni desde la aplicación.
- Una cuenta sin ese rol ve "Sección restringida" y la base le niega las
  funciones de administración (`42501 Administration only`).

## Qué hace

| Acción | Dónde | Regla en la base |
| --- | --- | --- |
| Aprobar o devolver con observaciones un comercio | Comercios pendientes | `review_business`: sólo solicitudes en revisión |
| Suspender un comercio (con motivo) | Comercios publicados | `admin_set_business_status`: desaparece de CAUCE y no recibe pedidos; el comercio ve el motivo |
| Rehabilitar | Suspendidos | Vuelve a publicado; el comercio no puede salir solo de una suspensión |
| Ver el estado de cada comercio | Comercios publicados | Abierto/cerrado ahora, pedidos, completados y vendido hoy |
| Atender incidencias | Necesitan atención | Pedidos quietos, con "Llamar al comercio" |
| Ver errores de dispositivos | Errores recientes | `admin_client_events`, sin datos personales |

## Hoy en CAUCE (`admin_pilot_metrics`)

"Hoy" es desde las 00:00 en la zona horaria de la localidad
(`America/Argentina/Buenos_Aires`), no el día UTC.

| Número | Qué cuenta |
| --- | --- |
| Comercios activos | Publicados (`active`); debajo, cuántos reciben pedidos **ahora** (abiertos y dentro de horario). |
| Pedidos hoy | Pedidos creados hoy, con el reparto retiro · envío. |
| Completados hoy | Pedidos entregados hoy (el evento de entrega es de hoy); debajo, los cancelados hoy. |
| Volumen bruto hoy | Suma del total de lo entregado hoy, **con envío incluido**, antes de cualquier costo. Debajo, el ticket promedio. |
| En curso ahora | Pedidos abiertos de cualquier día. |
| Errores 24 h | Eventos de error reportados por los dispositivos; críticos = `critical` y `order_failed`. |

Por comercio: abierto o cerrado ahora, pedidos, completados y vendido hoy.

## Necesitan atención

Pedidos que no se movieron hace más de:

| Estado | Minutos |
| --- | --- |
| Recibido, sin respuesta del comercio | 15 |
| Aceptado o en preparación | 60 |
| Listo, sin retirar ni asignar | 45 |
| En reparto (asignado, retirado, en camino, en el domicilio) | 90 |

Cada uno trae el código del pedido, el comercio y su teléfono público: la
administración llama al comercio, que tiene el pedido completo. **No** trae
nombre, teléfono ni dirección del cliente. Hasta 20, los más viejos primero.

## Observabilidad después de cada publicación

1. **Smoke del sitio publicado** (`paso: smoke-publicado`): Chromium y WebKit
   sobre el sitio real. Falla ante cualquier error de consola o respuesta 5xx
   del navegador. Incluye el circuito completo de un envío (cliente → comercio
   → reparto → cliente) y la administración.
2. **Residuo QA** (`paso: limpiar-qa`): cuentas, comercios, pedidos y archivos
   `CAUCE QA` en cero.
3. **Registros** (`paso: registros`, sólo lectura): últimas 24 h de la API
   (5xx falla el paso; 4xx por ruta), y errores por servicio: Auth, PostgREST,
   Postgres, Storage y Realtime.
4. **Errores de dispositivos**: la sección de administración y
   `admin_client_events` (sin correos, teléfonos ni tokens).

## Fuera de alcance

Reportes históricos, exportaciones, gráficos, liquidaciones y comisiones.
