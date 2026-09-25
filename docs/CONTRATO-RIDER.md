# Contrato del reparto propio (Rider v1)

El reparto es **de cada comercio**: CAUCE no opera una flota ni asigna repartos
entre comercios. Desde la versión de esquema `20260925120000`
(`supabase/migrations/20260925120000_rider_v1.sql`) la persona que reparte para
un comercio puede entrar con su cuenta y operar desde el teléfono **sólo** los
pedidos que ese comercio le asignó. Sin cuenta vinculada, todo sigue como antes:
el comercio marca cada paso desde su panel.

## Datos

- `public.business_riders (id, business_id, name, phone, active, user_id, created_at)`.
  - Es un **registro del comercio**. `user_id` (opcional) es la cuenta de CAUCE
    vinculada; único por `(business_id, user_id)`: la misma cuenta puede repartir
    para dos comercios, pero no ser dos personas del mismo comercio.
  - `user_id` **no se concede a ningún rol cliente**: sólo lo escriben
    `link_rider_account` y `unlink_rider_account`.
  - RLS: leen los integrantes del comercio (`riders_read`) y la propia persona sus
    filas (`riders_read_self`); insertar, editar y borrar, sólo titular y
    encargado/a.
- `public.orders.rider_id` con clave foránea compuesta
  `(rider_id, business_id) → business_riders(id, business_id)`: un pedido no
  puede quedar asignado a alguien de otro comercio.
- `public.orders.delivery_code`: 4 dígitos, sólo en envíos, generado por un
  disparador (`private.secure_delivery_code`) con `gen_random_uuid()` (generador
  fuerte de PostgreSQL) y muestreo por rechazo. Los pedidos anteriores conservan
  el código que el cliente ya tiene.
- `private.delivery_code_attempts`: cada intento de entrega con código (quién,
  cuándo, si acertó). Ningún rol cliente lo lee ni lo escribe.
- `public.order_events.actor_role in ('customer', 'merchant', 'rider', 'admin', 'system')`.

## Funciones

| Función | Quién | Qué hace |
| --- | --- | --- |
| `link_rider_account(rider, account_email)` | titular, encargado/a | Vincula una cuenta permanente que ya existe (correo sin distinguir mayúsculas). Una fila de otro comercio responde igual que una inexistente (`42501`). Sin cuenta: `P0002`. Cuenta ya vinculada a otra fila del comercio: `23505`. |
| `unlink_rider_account(rider)` | titular, encargado/a o la propia persona | Desvincula. Los pedidos asignados siguen en el panel. |
| `business_rider_accounts(business)` | titular, encargado/a | Correo de la cuenta vinculada a cada persona de reparto. |
| `rider_orders()` | la cuenta vinculada | Sus entregas: las abiertas (`assigned`, `picked_up`, `on_the_way`, `arrived`) y las cerradas en los últimos 7 días, hasta 100. |
| `transition_order(...)` | + rol `rider` | Retiré, salí, llegué (ver tabla). |
| `confirm_delivery(order_id, expected_version, code)` | la cuenta vinculada | Entrega con el código del cliente. |

`rider_orders()` devuelve sólo lo necesario para entregar: código de pedido,
estado, versión, comercio (nombre, dirección, teléfono), localidad, nombre y
teléfono de contacto, dirección, nota, productos y cantidades, importes, forma de
pago, intentos de código que quedan e historial de estados. **Nunca** devuelve el
código de entrega, la cuenta del cliente (`customer_id`), el enlace de
seguimiento ni la clave de idempotencia. Cerrado el pedido, teléfono, dirección y
nota vuelven vacíos: el historial conserva código, hora e importe.

No hay política nueva sobre `orders`: una política entregaría la fila completa
(con el código de entrega). Por eso quien reparte **no lee** `orders`,
`order_items` ni `order_events`, y Realtime no le manda cambios de pedidos.

## Roles en `transition_order`

La base resuelve el rol en este orden:

1. **`merchant`**: integra el comercio (owner, manager, staff). Si también
   reparte, actúa como comercio, que ya puede todo lo de la persona de reparto.
2. **`rider`**: `orders.rider_id` es una fila **activa** del mismo comercio con
   `user_id = auth.uid()`.
3. **`customer`**: es la cuenta que hizo el pedido.
4. Cualquier otra cuenta: `42501 This order belongs to another account`.

### Transiciones (`private.order_transitions`)

| Desde | Hacia | `merchant` | `rider` |
| --- | --- | :-: | :-: |
| `ready` | `assigned` | ✓ (exige persona activa del comercio) | — |
| `assigned` | `picked_up` | ✓ | ✓ |
| `picked_up` | `on_the_way` | ✓ | ✓ |
| `on_the_way` | `arrived` | ✓ | ✓ |
| `on_the_way` | `delivered` | ✓ | ✓ sólo con `confirm_delivery` |
| `arrived` | `delivered` | ✓ | ✓ sólo con `confirm_delivery` |
| abiertos | `canceled` | ✓ con motivo | — |

- Las filas `merchant` **no cambiaron**: el comercio completa todo el recorrido
  aunque la persona de reparto no use la aplicación (sin datos, sin batería, sin
  cuenta, código bloqueado).
- Quien reparte **no** se asigna pedidos, no cancela, no salta pasos y no mueve
  pedidos de otra persona o de otro comercio. Un problema en la entrega se
  resuelve llamando al comercio (el botón está en cada tarjeta).
- `transition_order` hacia `delivered` con rol `rider` responde
  `23514 Delivery code required`: entregar pasa siempre por `confirm_delivery`.

## Código de entrega

- El cliente lo ve en su pedido y en su enlace de seguimiento ("decíselo a quien
  te entrega el pedido"). Quien reparte nunca lo ve: lo pide al entregar.
- `confirm_delivery` valida en la base, con el pedido bloqueado (`for update`):
  que la cuenta sea la persona de reparto activa del pedido, la versión (`U0001`),
  el estado (`on_the_way` o `arrived`) y el código.
- **Límite: 5 intentos fallidos por pedido.** Un intento fallido **no** es un
  error de la base (el registro tiene que sobrevivir a la transacción): responde
  `{ ok: false, reason: 'wrong', remaining }`. Al quinto, `reason: 'locked'`, y
  desde ahí ni el código correcto entrega: el comercio cierra la entrega desde su
  panel después de confirmar con el cliente.
- Un texto que no son 4 dígitos responde `reason: 'format'` y no cuenta como
  intento. Acertar marca `delivered`, `payment_status = 'settled'` y registra el
  evento con `actor_role = 'rider'`.

## Aplicación de reparto

- Ruta `#entregas` (también `#rider`), en la misma SPA y con la misma sesión de
  Supabase Auth. Quien sólo reparte llega ahí al ingresar; el acceso "Mis
  entregas" aparece en el inicio y en la cuenta.
- Cada tarjeta: código, comercio, estado, **dirección grande con "Abrir en
  Maps"** (enlace universal de Google Maps con la dirección y la localidad; sin
  dirección no hay enlace), cliente con Llamar y WhatsApp, nota, productos,
  **importe a cobrar**, un solo botón con el paso siguiente y, desde "en camino",
  el campo del código (`inputmode="numeric"`, `autocomplete="one-time-code"`).
- Debajo, **Últimos 7 días**: entregas y cancelaciones, con lo cobrado.
- Se actualiza cada **15 s** y al volver a la pestaña (no hay canal en vivo, ver
  arriba), y en el acto después de cada paso.
- Sin cuenta vinculada o con la persona en pausa, la pantalla dice qué hacer.

## Panel del comercio · Reparto

- Titular y encargado/a ven en cada persona "Cuenta vinculada: correo" o "Sin
  cuenta vinculada", con **Vincular cuenta** (correo de su cuenta de CAUCE) y
  **Desvincular cuenta** (con confirmación). **Pausar** corta el acceso en el acto.
- El equipo no administra el reparto: no ve esa lista ni los correos (la base se
  los niega también por API).
- El tablero de envíos, la asignación y las acciones del pedido no cambiaron: el
  comercio sigue pudiendo marcar cada paso.

## Pruebas

- `tests/db/rider.test.mjs` (PostgreSQL embebido, 17): la migración sobre datos
  como los de producción (pedidos, códigos, historial y reparto intactos; un envío
  que ya había salido se completa con las reglas nuevas), desde cero, vincular,
  lectura acotada, transiciones válidas e inválidas, entre comercios, código con
  límite y registro, pausar y desvincular, integrante que reparte, privilegios.
- `tests/integration/rider.test.mjs` (Supabase local con GoTrue, PostgREST y
  Realtime, 7): el mismo repositorio que la aplicación; seguimiento del cliente;
  Realtime no entrega pedidos a quien reparte.
- `tests/rider-app.test.mjs` (9): los pasos de la aplicación comparados con las
  filas `rider` de las migraciones, orden, Maps, mensajes y escape de todo lo
  escrito por otros.
- `tests/e2e/rider.test.mjs` (Chromium y WebKit): el comercio vincula y asigna
  desde el panel, la persona retira, sale, llega y entrega con el código a 390 px,
  el cliente lo sigue por su enlace; panel y API con la sesión de quien reparte;
  320 a 1280 px.
- Smoke del sitio publicado (`tests/produccion/smoke.test.mjs`): el mismo pedido
  de punta a punta en el proyecto real, con la persona de reparto QA.

## Fuera de alcance (P2)

- **Tiempo real para quien reparte**: hoy consulta cada 15 s. Un canal
  `broadcast` privado por persona (políticas sobre `realtime.messages`) evitaría
  la espera sin exponer la fila completa.
- GPS o posición en vivo, rutas, liquidación del reparto, reparto compartido entre
  comercios y reportar un problema desde la aplicación (hoy: llamar al comercio).
- Reasignar un pedido ya asignado a otra persona (hoy: cancelar con motivo o
  completarlo desde el comercio).
