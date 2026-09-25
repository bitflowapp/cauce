# Contrato para la rama Rider

Qué existe hoy para el reparto propio de cada comercio, qué usa el panel del
comercio y qué tendría que agregar una aplicación de reparto sin romperlo.
**Nada de la parte "a agregar" está implementado**: es la propuesta de contrato
para esa rama.

## Lo que existe hoy

### Datos

- `public.business_riders (id, business_id, name, phone, active, created_at)`.
  Es un **registro del comercio**, no una cuenta: la persona que reparte no
  ingresa a CAUCE. Único por `(business_id, name)` y por `(id, business_id)`.
- RLS: lee cualquier integrante del comercio (owner, manager, staff); insertar,
  editar y borrar, sólo owner y manager.
- `public.orders.rider_id` con clave foránea compuesta
  `(rider_id, business_id) → business_riders(id, business_id)`: un pedido no
  puede quedar asignado a alguien de otro comercio.
- `public.orders.delivery_code`: 4 dígitos, sólo en envíos. Lo ven el cliente
  (sus pedidos y `track_order`) y el comercio. Hoy la verificación es humana:
  el panel dice "pedíselo a la persona al entregar". **La base no lo exige**.
- `public.order_events`: historial con `actor_id` y
  `actor_role in ('customer', 'merchant', 'admin', 'system')`.
- Realtime: `orders` y `order_events` están en la publicación
  `supabase_realtime`; los eventos respetan las políticas de lectura.

### Transiciones (`private.order_transitions`)

Todas las de la entrega las ejecuta hoy el **comercio** (`actor_role = 'merchant'`):

| Desde | Hacia | Modalidad | Notas |
| --- | --- | --- | --- |
| `ready` | `assigned` | envío | Exige `rider` activo del mismo comercio. |
| `assigned` | `picked_up` | envío | |
| `picked_up` | `on_the_way` | envío | |
| `on_the_way` | `arrived` | envío | |
| `on_the_way` | `delivered` | envío | Entrega directa. |
| `arrived` | `delivered` | envío | |
| `ready` | `delivered` | retiro | |
| cualquier estado abierto | `canceled` | — | Con motivo (mínimo 3 caracteres). Desde `picked_up`, `on_the_way` y `arrived`, sólo envíos. |

La única puerta es `public.transition_order(order_id, expected_version,
next_status, rider, reason)`: valida quién llama, la versión (`U0001` si otra
persona ya lo movió), la fila de la tabla de transiciones, el motivo y el
reparto; devuelve el stock al cancelar y marca `payment_status = 'settled'` al
entregar.

## Lo que usa el panel del comercio

Si la rama Rider cambia algo de esto, el panel tiene que acompañar:

- Grupo "En reparto" = `assigned`, `picked_up`, `on_the_way`, `arrived`
  (`ORDER_GROUPS` en `js/core/business-panel.js`).
- Tablero de Reparto: `order.riderId`, `rider.name`, `rider.phone`,
  `rider.active` (`deliveryBoardData`).
- Acciones del comercio = filas `merchant` de `private.order_transitions`
  (`merchantOrderActions`). `tests/business-panel.test.mjs` compara ambas
  leyendo las migraciones: **si la rama Rider quita filas `merchant`** (por
  ejemplo, para que sólo quien reparte marque "retirado"), esa prueba falla
  hasta que se actualice `merchantOrderActions`. Agregar filas de otro rol no
  la afecta.
- El comercio tiene que poder completar todo el recorrido aunque la persona de
  reparto no use la aplicación (sin datos, sin batería, sin cuenta). Se
  recomienda **no quitar** las filas `merchant` de la entrega.

## Lo que tendría que agregar la rama Rider (propuesta)

1. **Vincular reparto y cuenta.** `business_riders.user_id uuid null
   references auth.users(id)`, único por `(business_id, user_id)`. Se vincula
   con una función al estilo de `add_business_member`: sólo owner/manager, por
   correo de una cuenta permanente ya existente. Desvincular lo hace el
   comercio o la propia persona.
2. **Rol en `transition_order`.** Resolver `role := 'rider'` cuando
   `row.rider_id` pertenece a una fila activa con `user_id = auth.uid()`. Si la
   misma persona también integra el comercio, hoy ganaría `merchant`: decidir
   explícitamente (se sugiere que gane `merchant`, que ya puede todo).
3. **Transiciones de quien reparte** (`actor_role = 'rider'`, sólo envío):
   `assigned → picked_up → on_the_way → arrived → delivered` y
   `on_the_way → delivered`. Sin cancelar: quien reparte informa un problema y
   el comercio decide.
4. **Código de entrega verificado por la base** para `rider → delivered`:
   parámetro nuevo o función `confirm_delivery(order_id, expected_version,
   code)`. Con límite de intentos por pedido (4 dígitos son 10.000
   combinaciones) y el intento fallido registrado.
5. **Lectura acotada.** Una función `rider_orders()` (SECURITY DEFINER) con
   sólo lo necesario para entregar: código, estado, dirección, nombre y
   teléfono de contacto, nota, productos y total a cobrar. Sin `customer_id`,
   sin correo. Si se prefiere una política sobre `orders`, agregar a
   `orders_read` la condición del reparto vinculado y revisar que no exponga
   columnas de más.
6. **Tiempo real.** Filtro `rider_id=eq.<id>` sobre `orders`, que funciona
   sólo si la política de lectura del punto 5 lo permite; si no, un canal
   `broadcast` privado por persona de reparto.
7. **Historial.** Sumar `'rider'` al `check` de `order_events.actor_role`.
8. **Pruebas negativas** como las de `tests/integration/security.test.mjs`:
   quien reparte no ve ni mueve pedidos de otro comercio, ni pedidos no
   asignados a su persona, ni puede asignarse a sí misma.

## Piezas del cliente reutilizables

- `js/core/workflow-policy.js`: `allowedActions(order, { kind: 'rider', id })`
  ya modela las acciones de quien reparte (se usa en la demostración).
- `js/core/rider.js`: cola de reparto, prioridad y estados de acción.
- `js/core/delivery-code.js`: formato y normalización del código.
- `js/ui/business-panel.js` · `orderCard`: la tarjeta con dirección, contacto,
  etapa y código, reutilizable para una vista de reparto.
