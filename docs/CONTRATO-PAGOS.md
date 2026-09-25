# Contrato de pagos: interfaz ↔ base ↔ servidor

Complementa [PAGOS-ONLINE.md](PAGOS-ONLINE.md). Acá están las funciones, parámetros, respuestas y errores exactos que usan la interfaz, la base y las Edge Functions.

**Todo esto existe y está probado, con el interruptor `payments_online` apagado.**

Convenciones:

- **Importes** en pesos enteros (`bigint`, ARS). Nunca decimales.
- **Estados de pago**, en los términos neutrales de CAUCE:
  - efectivo: `pending_on_delivery`, `settled`;
  - online: `pending`, `processing`, `approved`, `rejected`, `cancelled`, `refunded`, `partially_refunded`, `expired`.
- **Errores** con el código de Postgres y un mensaje corto en inglés. La interfaz los traduce en `SERVER_MESSAGES` (`js/repositories/supabase-repository.js`) y nunca muestra el texto técnico.
- **Rol que ejecuta**:
  - `anon`: visita sin sesión.
  - `authenticated`: cualquier sesión, incluida la compra sin cuenta.
  - `service_role`: sólo las Edge Functions.

## 1. Lo que usa la interfaz

### `payment_methods(business uuid) → jsonb`

Rol: `anon`, `authenticated`. Devuelve las formas de pago que el checkout puede ofrecer ahora:

```json
[
  { "id": "cash_on_pickup",   "kind": "cash", "fulfillment": "pickup" },
  { "id": "cash_on_delivery", "kind": "cash", "fulfillment": "delivery" },
  { "id": "online", "kind": "online", "provider": "mercadopago", "label": "Mercado Pago",
    "flows": ["checkout_pro", "checkout_api"] }
]
```

- El efectivo aparece según las modalidades del comercio.
- `online` aparece sólo con `payments_online` encendido **y** la cuenta del comercio `connected`.
- Un comercio no publicado devuelve `[]`.

**Interfaz:** `checkoutPaymentMethods(methods, fulfillment)` (`js/core/payment.js`) se queda con el efectivo de la modalidad elegida y con `online` si vino con proveedor. Nunca agrega una forma que no vino. Si la consulta falla, la interfaz usa `cashOnlyMethods(fulfillment)`.

### `create_order(business, idem, fulfillment, payment_method, contact, items, expected_total) → uuid`

Rol: `authenticated`. Es la misma función de siempre, con una forma de pago más:

- `payment_method`: `cash_on_pickup` | `cash_on_delivery` | `online`.
- Con `online` sin proveedor disponible: `23514 Payment method not available`.
- Estado de pago inicial: efectivo `pending_on_delivery`; online `pending`.
- La base garantiza la coherencia con la restricción `orders_payment_status_matches_method`: el efectivo nunca usa estados online, y viceversa.

### `start_payment(order_id uuid, flow text default 'checkout_pro') → jsonb`

Rol: `authenticated`, **sólo quien compró el pedido**. Crea o devuelve el intento vivo:

```json
{ "attempt_id": "uuid", "status": "pending", "flow": "checkout_pro", "provider": "mercadopago",
  "amount": 7500, "currency": "ARS", "checkout_url": null }
```

- Un doble toque o un reintento devuelven el mismo `attempt_id` mientras siga `pending`/`processing`.
- El importe es `orders.total_ars`: el cliente no manda ningún importe.

| Error | Cuándo |
| --- | --- |
| `42501 Authentication required` | Sin sesión. |
| `23514 Invalid payment flow` | `flow` no es `checkout_pro` ni `checkout_api`. |
| `P0002 Order not found` | No existe o es de otra persona. |
| `23514 Payment not required` | Es efectivo. |
| `23514 Order canceled` | El pedido está cancelado. |
| `23514 Order already paid` | El pago ya está aprobado, devuelto o devuelto en parte. |
| `23514 Payment method not available` | Interruptor apagado o cuenta desconectada. |

### `payment_status(reference uuid) → jsonb | null`

Rol: `authenticated`. `reference` es el id del pedido **o** del intento. Responde sólo a quien compró o a un miembro del comercio; para cualquier otro, `null`.

```json
{ "order_id": "uuid", "code": "CA-0010", "order_status": "submitted", "business_id": "uuid",
  "payment_method": "online", "payment_status": "pending", "total": 7500, "tracking_token": "uuid",
  "attempt": { "id": "uuid", "status": "pending", "flow": "checkout_pro", "provider": "mercadopago",
               "checkout_url": "https://…", "updated_at": "…" } }
```

**Interfaz:** `#pago/{exito|pendiente|error}` lee la referencia con `paymentReturnReference(hash, search)`:

- primero `?intento=` o `?pedido=` en el hash;
- si no, `external_reference` en la búsqueda.

Sólo acepta un UUID. Muestra `paymentReturnState(outcome, payment)` y consulta cada 5 s mientras el pago esté `pending`/`processing`. **La ruta nunca aprueba.**

### `track_order(token uuid) → jsonb`

Suma `payment_status` a lo que ya devolvía, para el seguimiento sin sesión.

### `transition_order(…)`

Sin cambios para el efectivo. Para online:

- **Aceptar** un pedido online con el pago distinto de `approved` → `U0007 Payment not approved`.
- **Cancelar** un pedido online con un intento vivo o aprobado marca `cancel_requested_at` en el intento. La devolución la confirma el proveedor.
- **Entregar** un pedido online no cambia su pago. Sólo el efectivo pasa a `settled`.

### `business_payment_overview(business uuid) → jsonb`

Rol: titular y encargado/a del comercio (`42501` para cualquier otro).

```json
{ "enabled": false,
  "providers": [{ "provider": "mercadopago", "label": "Mercado Pago" }],
  "accounts": [{ "provider": "mercadopago", "status": "connected", "status_reason": "",
                 "provider_user_id": "123", "live_mode": false, "scopes": ["…"],
                 "connected_at": "…", "token_expires_at": "…", "last_synced_at": "…" }],
  "today": { "approved": 0, "approved_ars": 0, "pending": 0, "rejected": 0, "refunded": 0, "to_refund": 0 },
  "to_review": 0, "last_synced_at": null, "day_start": "…" }
```

- Nunca incluye tokens ni ningún secreto.
- "Hoy" se cuenta desde las 00:00 en la hora de la localidad.

### `disconnect_payment_account(business uuid, provider text) → void`

Rol: **sólo titular**. Borra las credenciales en el acto y deja la cuenta `not_connected`.

## 2. Edge Functions

Todas responden JSON con `Cache-Control: no-store`. Todas devuelven `503 {"error":"not_configured"}` si falta un secreto y `503 {"error":"payments_disabled"}` con el interruptor apagado.

### `POST /functions/v1/payments-checkout`

Con la sesión de quien compra (`Authorization: Bearer <jwt>`).

| Pedido | Respuesta |
| --- | --- |
| `{ "order_id": "uuid" }` (Checkout Pro) | `200 { "checkout_url": "https://…" }` |
| `{ "order_id", "flow": "checkout_api", "card_token", "payment_method_id", "payment_method_type", "installments", "payer_email" }` | `200 { "status": "<estado neutral>" }` |

Errores:

| Error | Cuándo |
| --- | --- |
| `400 invalid_order` | `order_id` no es un UUID. |
| `409 payment_not_available` | `start_payment` rechazó el pedido. |
| `409 account_not_connected` | La cuenta del comercio no está conectada. |
| `409 attempt_closed` | El intento ya no está abierto. |
| `502 provider_error` | El proveedor respondió con un error. |

**Interfaz:** comando `payment.start` del repositorio, que devuelve `{ checkoutUrl }` y lleva al navegador ahí. Si el pedido ya tenía checkout, vuelve la misma URL sin llamar otra vez al proveedor.

### `POST /functions/v1/payments-oauth`

Con la sesión de la persona titular.

| Pedido | Respuesta |
| --- | --- |
| `{ "business": "uuid", "provider": "mercadopago" }` | `200 { "authorization_url": "https://…" }` |

Errores:

| Error | Cuándo |
| --- | --- |
| `401 sign_in_required` | Sin sesión, o con una sesión de compra sin cuenta. |
| `400 invalid_business` | `business` no es un UUID. |
| `400 unsupported_provider` | El proveedor no es el del adaptador. |
| `403 not_allowed` | No es titular, o el interruptor está apagado. |

### `GET /functions/v1/payments-oauth?code&state`

Es la vuelta del proveedor. Redirige a `<sitio>/index.html#panel/<id>/pagos?conexion=…`:

| `conexion` | Significado |
| --- | --- |
| `ok` | Cuenta conectada. |
| `cancelada` | La persona canceló en el proveedor, o no vino `code`. |
| `vencida` | `state` desconocido, usado o vencido (10 minutos). |
| `error` | Falló el canje de código o el guardado. |

**Interfaz:** `connectionResult(hash)` acepta sólo esos cuatro valores.

### `POST /functions/v1/payments-webhook`

Sin JWT: la autenticación es `x-signature`.

| Respuesta | Cuándo |
| --- | --- |
| `405` | No es `POST`. |
| `400 https_required` | No es HTTPS (salvo `localhost`). |
| `413 too_large` | Más de 64 KB. |
| `400 invalid_json` | Cuerpo inválido. |
| `401 invalid_signature` | Firma inválida, o falta. **No se anota nada.** |
| `200 { received, ignored: true }` | Tema que CAUCE no usa, o sin `data.id`. |
| `200 { received, duplicate: true }` | Notificación ya procesada. |
| `200 { received: true }` | Anotada. La reconciliación sigue en segundo plano. |

## 3. Funciones del servidor

Rol: **sólo `service_role`**. Tienen revocado `execute` para `public`, `anon` y `authenticated`, y las pruebas lo verifican.

| Función | Para qué |
| --- | --- |
| `payment_oauth_begin(business, provider, requested_by, state, code_verifier)` | Abre una conexión. La base exige el interruptor encendido y que `requested_by` sea titular. Deja la cuenta `connecting`. |
| `payment_oauth_lookup(state) → jsonb` | `{business_id, provider, code_verifier}` de un `state` vigente y sin usar, o `null`. |
| `payment_oauth_complete(state, provider_user_id, scopes, live_mode, token_expires_at, access_ciphertext, refresh_ciphertext, key_version) → jsonb` | Canjea el `state` una sola vez y guarda la cuenta conectada con sus credenciales cifradas. |
| `payment_account_mark(business, provider, status, reason)` | Cambia el estado de la cuenta (por ejemplo, `reconnect_required`). |
| `payment_account_credentials(business, provider) → jsonb` | Credenciales cifradas de la cuenta de un comercio. |
| `payment_seller_credentials(provider, seller_id) → jsonb` | Credenciales cifradas del vendedor que avisa un webhook. |
| `payment_checkout_context(attempt_id) → jsonb` | Intento, pedido, comercio, ítems, importe, clave de idempotencia y vencimiento. |
| `payment_attempt_set_checkout(attempt_id, provider_order_id, checkout_url)` | Guarda lo que devolvió el proveedor. El intento tiene que estar abierto, y un id distinto del ya guardado se rechaza. |
| `payment_record_event(provider, event_key, resource_type, resource_id, action, live_mode) → jsonb` | Ver abajo. |
| `payment_mark_event(event_id, outcome, detail)` | `ignored`, `failed` o `flagged`, con motivo. |
| `payment_apply_update(provider, seller_id, attempt_reference, provider_order_id, status, status_detail, paid_amount, transactions, event_id) → jsonb` | Ver abajo. |

Respuestas de `payment_record_event`:

- `{event_id, duplicate: false}`: notificación nueva.
- `{event_id, duplicate: true}`: ya estaba procesada.
- `{event_id, duplicate: false, retry: true}`: la vez anterior falló o quedó colgada más de 5 minutos, y este reintento la vuelve a procesar.

Respuestas de `payment_apply_update`:

- `{outcome: 'applied', status}`
- `{outcome: 'flagged', status}`: importe distinto o pago repetido.
- `{outcome: 'ignored', reason}`, con `reason` = `unknown_attempt`, `seller_mismatch` o `transition`.

`transactions` es un arreglo de movimientos:

```json
{ "kind": "payment|refund", "id": "…", "status": "<neutral>", "status_detail": "…", "amount": 7500, "method_type": "…" }
```

## 4. Estados en la interfaz

`orderPayment(order)` (`js/core/payment.js`) es la única vista del pago en pantalla:

| Pedido | `kind` | `state` | Texto |
| --- | --- | --- | --- |
| Efectivo sin cobrar | `cash` | `not_required` | "Efectivo al recibir" / "Efectivo al retirar" |
| Efectivo cobrado | `cash` | `not_required` | "Cobrado en efectivo" |
| Online | `online` | estado neutral | "Pago pendiente", "Pago en revisión", "Pagado", "Pago rechazado", "Pago anulado", "Pago devuelto", "Devolución parcial", "Pago vencido" |

Un valor desconocido se muestra como `pending`: nunca como pagado.

Dónde se ve:

| Pantalla | Qué muestra |
| --- | --- |
| Checkout | `paymentMethodSelector`, con las formas que ofreció la base. |
| Pedido | `orderPaymentNotice`. Ofrece "Pagar ahora" con el pago pendiente y "Intentar el pago de nuevo" tras un rechazo o vencimiento; nunca mientras el proveedor procesa. |
| Panel | Insignia en cada tarjeta. "Aceptar" deshabilitado hasta `approved`, y sección Pagos con el interruptor encendido. |
| Reparto | "Pagado online · no cobrar", o "Pago online sin confirmar · consultá al comercio". Lo cobrado en mano sólo suma efectivo. |

## 5. Lo que no cambia

- El efectivo: `create_order`, `confirm_delivery` y `settled` funcionan igual, y la facturación ARCA (`canRequestInvoice`) sigue dependiendo de `settled`.
- La demostración: nunca ofrece pago online. `paymentsOnline()` exige el entorno conectado y el interruptor encendido.
