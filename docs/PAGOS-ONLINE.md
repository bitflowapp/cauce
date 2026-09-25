# Pagos online en CAUCE

Rama `feat/cauce-ux-payment-ready`.

**Estado: preparado y apagado.** CAUCE no procesa ningún pago online.

- El interruptor `payments_online` está en `false`, que es su valor por defecto; la migración nunca lo enciende.
- No hay credenciales de Mercado Pago cargadas en ningún entorno.
- El checkout ofrece sólo efectivo.
- La base, las funciones del servidor y la interfaz ya tienen todo lo necesario para encenderlo el día que se decida, sin rediseñar el checkout, los pedidos ni la base.

Este documento cubre la arquitectura y la operación. Las funciones, los parámetros y las respuestas exactas están en [CONTRATO-PAGOS.md](CONTRATO-PAGOS.md).

> Los nombres de endpoints, campos y estados de Mercado Pago que aparecen acá se tomaron de su documentación pública. **Antes de encender pagos reales, hay que verificarlos contra la documentación vigente de Mercado Pago** (Checkout Pro, API de Orders, OAuth y webhooks). Mercado Pago cambia sus APIs y sus estados. Donde dice "verificar", el dato puede haber cambiado.

## 1. Reglas que no se negocian

1. **Cada comercio cobra en su propia cuenta.**
   - El comercio conecta su cuenta de Mercado Pago por OAuth, y el dinero del pedido va directo a esa cuenta.
   - CAUCE no tiene una cuenta recaudadora, no toca saldos, no cobra comisión y no hace transferencias.
2. **Los tokens del comercio se guardan sólo en el servidor, y cifrados.**
   - Van en `private.payment_provider_credentials`, con AES‑256‑GCM y una clave que vive en los secretos de las Edge Functions.
   - Nunca llegan al navegador, a `localStorage`, al bundle ni a los registros.
3. **La verdad del pago la dice el proveedor, leída desde el servidor.**
   - Un pago se da por aprobado sólo cuando el servidor lee la orden o el pago en la API de Mercado Pago, con la cuenta del comercio que corresponde.
   - Nunca se da por aprobado por:
     - la URL de vuelta (`#/pago/exito`);
     - el cuerpo de un webhook;
     - lo que diga el navegador.
4. **El importe sale del pedido en la base.** El navegador nunca manda un importe: el intento de pago copia `total_ars` del pedido.
5. **Un pedido tiene como mucho un intento de pago vivo**, con una clave de idempotencia estable:
   - un doble toque o un reintento devuelven el mismo intento;
   - `X-Idempotency-Key` impide un segundo cobro en el proveedor.
6. **La interfaz no nombra a ningún proveedor.**
   - El nombre sale del registro `private.payment_providers` (`label`), y la interfaz habla en estados neutrales.
   - Lo específico de Mercado Pago vive sólo en el adaptador del servidor (`supabase/functions/_shared/payments/mercadopago.js`).
7. **Apagado quiere decir apagado.** Con el interruptor en `false`:
   - `payment_methods` ofrece sólo efectivo;
   - `create_order` rechaza `online`;
   - `start_payment` y el inicio del OAuth fallan;
   - las tres Edge Functions responden `503`.

## 2. Piezas

| Pieza | Dónde | Rol |
| --- | --- | --- |
| Dominio neutral | `supabase/migrations/20260926120000_payments_ready.sql` | Cuentas por comercio, intentos, transacciones, eventos de webhook, estados y sus transiciones, interruptor. |
| Vocabulario de la interfaz | `js/core/payment.js` | Estados neutrales, formas de pago ofrecidas, lectura del retorno. Sin proveedor adentro. |
| Interfaz | `js/ui/payments.js`, checkout (`js/app.js`), panel, reparto | Selector de forma de pago, insignias, sección Pagos, vuelta del proveedor. |
| Adaptador | `supabase/functions/_shared/payments/mercadopago.js` | Arma los pedidos al proveedor y traduce sus estados a los neutrales. |
| Firma de webhooks | `supabase/functions/_shared/payments/signature.js` | Verificación de `x-signature` (HMAC‑SHA256, comparación en tiempo constante). |
| Receptor de webhooks | `supabase/functions/_shared/payments/webhook.js` + `payments-webhook/` | Anota la notificación, responde rápido y reconcilia después. |
| OAuth del comercio | `supabase/functions/_shared/payments/oauth.js` + `payments-oauth/` | PKCE S256, `state` de un solo uso, canje de código y guardado cifrado. |
| Iniciar el pago | `payments-checkout/` | Crea (o devuelve) el intento y el checkout del proveedor. |
| Cifrado | `supabase/functions/_shared/payments/vault.js` | AES‑256‑GCM con versión de clave (`v<n>.<iv>.<cifrado>`). |

Las tres Edge Functions:

- `payments-webhook`, con `verify_jwt = false`: Mercado Pago no manda JWT, y la firma es la autenticación.
- `payments-oauth`, con `verify_jwt = false`: la vuelta del proveedor no trae JWT. El `POST` de inicio verifica la sesión de la persona, y la base verifica que sea titular.
- `payments-checkout`, con `verify_jwt = true`: la llama quien compra, con su sesión.

## 3. Modelo de datos

- **`orders`** agrega:
  - `payment_method = 'online'`;
  - estados de pago neutrales, con una regla que ata método y estado: el efectivo sólo usa `pending_on_delivery`/`settled`, y online sólo los neutrales.

  Un pedido existe sin ningún intento de pago. El efectivo no cambió en nada: sigue en `pending_on_delivery` → `settled`, y la facturación ARCA sigue dependiendo de `settled`.
- **`payment_provider_accounts`**: la cuenta de cada comercio en cada proveedor.
  - Guarda el estado (`not_connected`, `connecting`, `connected`, `reconnect_required`), el `provider_user_id` (vendedor), los scopes, el modo (prueba o real) y las fechas.
  - No guarda secretos. La leen titular y encargado/a.
- **`private.payment_provider_credentials`**: los tokens cifrados y su versión de clave. Ningún rol de cliente la lee.
- **`private.payment_oauth_states`**: `state` y `code_verifier` de cada conexión. Vence en 10 minutos y se usa una sola vez.
- **`payment_attempts`**: un intento por pedido y vez.
  - Guarda `flow` (`checkout_pro`/`checkout_api`), estado neutral, importe, `idempotency_key` (UUID estable), id de la orden del proveedor, URL del checkout, `cancel_requested_at` y vencimiento.
  - Un índice único parcial permite un solo intento vivo (`pending`/`processing`) por pedido.
- **`payment_transactions`**: los movimientos que informa el proveedor (pagos y devoluciones), únicos por proveedor e id.
- **`private.payment_events`**: cada notificación recibida.
  - Es única por clave de evento, y así la deduplicación queda en la base.
  - Guarda el resultado: `received`, `applied`, `ignored`, `flagged` o `failed`.
- **`private.payment_providers`**: el registro de proveedores (`mercadopago`, "Mercado Pago", flujos).
- **`private.payment_status_transitions`**: la máquina de estados, espejada en `js/core/payment.js` y probada en ambos lados.

## 4. Estados

Estados neutrales de CAUCE:

- `pending`
- `processing`
- `approved`
- `rejected`
- `cancelled`
- `refunded`
- `partially_refunded`
- `expired`

`not_required` es sólo la vista del efectivo en la interfaz; no se guarda.

Transiciones admitidas (repetir el estado actual no es un salto):

```
pending            → processing | approved | rejected | cancelled | expired
processing         → approved | rejected | cancelled | expired
approved           → refunded | partially_refunded
partially_refunded → refunded
```

Una noticia que pide un salto no admitido, como `approved → pending`, se anota como `ignored` y no cambia nada.

Traducción desde Mercado Pago (**verificar** contra la documentación vigente):

| API | Estado del proveedor | CAUCE |
| --- | --- | --- |
| Orders | `created`, `action_required` | `pending` |
| Orders | `processing` | `processing` |
| Orders | `processed` | `approved` (con detalle `partially_refunded`: `partially_refunded`) |
| Orders | `refunded` | `refunded` |
| Orders | `canceled` / `cancelled` | `cancelled` |
| Orders | `failed` | `rejected` |
| Orders | `expired` | `expired` |
| Orders | `charged_back` | `refunded` |
| Payments | `pending` | `pending` |
| Payments | `in_process`, `authorized` | `processing` |
| Payments | `approved` | `approved` (con detalle `partially_refunded`: `partially_refunded`) |
| Payments | `rejected` | `rejected` |
| Payments | `cancelled` | `cancelled` |
| Payments | `refunded`, `charged_back` | `refunded` |
| Payments | `in_mediation` | *(sin traducción: se anota y se revisa a mano)* |

Un estado que no está en la tabla devuelve `null`: la notificación queda `ignored` con el estado crudo en el detalle, nunca se aprueba nada.

**Pedido y pago son estados separados.**

- Un pedido online nace `submitted` con el pago `pending`.
- El comercio **no puede aceptarlo** hasta que el pago esté `approved`. Lo exige `transition_order` (error `U0007`), y la interfaz deshabilita "Aceptar" y lo explica.
- Si el comercio cancela un pedido pagado, el intento queda con `cancel_requested_at`. La devolución la confirma el proveedor (§9).

## 5. Checkout Pro o Checkout API

| | Checkout Pro (redirección) | Checkout API (API de Orders, pago dentro de CAUCE) |
| --- | --- | --- |
| Datos de tarjeta | Se cargan en Mercado Pago. CAUCE nunca los ve. | Los tokeniza el SDK de Mercado Pago en el navegador; CAUCE recibe sólo el token. |
| Superficie PCI | Mínima (SAQ A). | Mayor (SAQ A‑EP): la página de CAUCE aloja el formulario. |
| Cambios en CAUCE | Ninguno en la CSP ni scripts de terceros. | Cargar el SDK de Mercado Pago y abrir la CSP (`script-src`, `connect-src`, `frame-src`). |
| Medios de pago | Todos los que el vendedor tenga habilitados. | Los que CAUCE implemente en el formulario. |
| Experiencia | Sale de CAUCE y vuelve por `#/pago/*`. | No sale de CAUCE. |
| 3‑D Secure / desafíos | Los resuelve Mercado Pago. | Hay que manejar `action_required`. |
| Complejidad | Baja. | Media/alta. |

**Recomendación para el piloto: Checkout Pro.**

- Tiene la menor superficie PCI, no toca la CSP estricta de CAUCE y cubre todos los medios.
- La interfaz y la base ya soportan los dos flujos (`flow`), así que pasar a Checkout API más adelante no cambia el modelo.
- `payments-checkout` usa Checkout Pro por defecto. El camino de Checkout API (`POST /v1/orders`) está armado y probado sin red, pero sin formulario de tarjeta en la interfaz.

## 6. Conexión del comercio (OAuth)

1. En el panel, **Pagos → Conectar &lt;proveedor&gt;**. Sólo aparece con el interruptor encendido, y sólo la persona titular puede conectar o desconectar.
2. La interfaz llama a `payments-oauth` (`POST {business, provider}`) con la sesión de la persona. La función:
   - verifica la sesión;
   - genera `state` (32 bytes aleatorios) y el par PKCE S256;
   - llama a `payment_oauth_begin` como `service_role`. La base vuelve a exigir que quien lo pide sea titular y que el interruptor esté encendido, deja la cuenta en `connecting` y guarda `state` + `code_verifier` (10 minutos, un solo uso).
   - devuelve la URL de autorización (`https://auth.mercadopago.com/authorization`, **verificar**).
3. Mercado Pago vuelve a `payments-oauth` (`GET ?code&state`). La función:
   - busca el `state` vigente (`payment_oauth_lookup`);
   - canjea el código con `code_verifier` (`POST /oauth/token`, **verificar**);
   - cifra `access_token` y `refresh_token`;
   - llama a `payment_oauth_complete`, que marca el `state` como usado y deja la cuenta `connected`, con `provider_user_id`, scopes, modo y vencimiento.
4. La función redirige a `#panel/<id>/pagos?conexion=ok|cancelada|vencida|error`, y el panel muestra el resultado.
5. **Desconectar** (`disconnect_payment_account`, sólo titular) borra las credenciales en el acto y deja la cuenta `not_connected`. Desde ese momento el checkout vuelve a ofrecer sólo efectivo.
6. **Renovación.** El adaptador tiene `refreshRequest`. Si un canje o una lectura falla por token vencido o revocado, la cuenta pasa a `reconnect_required` (`payment_account_mark`) y el checkout deja de ofrecer online hasta reconectar. El refresco automático programado queda para el encendido.

## 7. Pago de un pedido (Checkout Pro)

1. **Checkout.** La interfaz pide `payment_methods(business)`.
   - La opción online aparece sólo si el interruptor está encendido **y** la cuenta del comercio está `connected`.
   - Si la consulta falla, se ofrece sólo efectivo.
2. **Crear el pedido.** `create_order` con `payment_method = 'online'` vuelve a verificar las dos condiciones. El pedido nace con el pago `pending`.
3. **Iniciar el pago.** La interfaz llama a `payments-checkout` (`POST {order_id}`) con la sesión de quien compra. La función:
   - llama a `start_payment` **como esa persona**: la base verifica que el pedido sea suyo y crea o devuelve el intento vivo, con el importe del pedido;
   - lee el contexto del intento como `service_role`. Si ya tiene checkout, lo devuelve sin llamar de nuevo al proveedor;
   - descifra el token del comercio y crea la preferencia (`POST /checkout/preferences`):
     - `external_reference = attempt_id`;
     - `X-Idempotency-Key = idempotency_key`;
     - una sola línea con el total;
     - `back_urls` a `#/pago/{exito|pendiente|error}?intento=<id>`;
     - `notification_url` al webhook.
   - guarda el id y la URL (`payment_attempt_set_checkout`) y devuelve `checkout_url`.
4. **Pagar.** El navegador va a `checkout_url`. Si no se puede abrir, el pedido queda con el pago pendiente y se puede pagar desde el pedido ("Pagar ahora").
5. **Volver.** `#/pago/*` **no aprueba nada**:
   - consulta `payment_status(reference)`, que sólo responde a quien compró o al comercio;
   - muestra el estado real;
   - consulta cada 5 segundos mientras el pago siga pendiente.
6. **La verdad llega por el webhook** (§8). El pedido pasa a `approved` y el comercio puede aceptarlo.

## 8. Webhooks

Receptor: `payments-webhook`.

1. **Validaciones iniciales.**
   - Exige `POST` y HTTPS (salvo `localhost`).
   - Un cuerpo de más de 64 KB → `413`.
   - JSON inválido → `400`.
   - Sin secreto configurado → `503`.
2. **Firma.** Se verifica `x-signature` (`ts=…,v1=…`).
   - Es un HMAC‑SHA256 con `MP_WEBHOOK_SECRET` sobre el manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
   - `data.id` va en minúsculas si es alfanumérico, y se omiten las partes que no vienen (**verificar** el formato vigente).
   - La comparación es en tiempo constante.
   - **Firma inválida → `401` y no se anota nada**: un webhook falso no deja rastro ni cambia estados.
3. **Temas.** Sólo se procesan `order` y `payment`. Cualquier otro tema recibe `200` para que el proveedor no reintente.
4. **Idempotencia.** La notificación se anota en `payment_record_event` con una clave estable: SHA‑256 del id de la notificación o, si no viene, del recurso + acción + `x-request-id`.
   - Si ya estaba, la respuesta es `200 {duplicate: true}` y no se hace nada más.
5. **Rápido.** Se responde `200` enseguida. La reconciliación corre después, con `EdgeRuntime.waitUntil`:
   - busca las credenciales del **vendedor que avisa** (`user_id` de la notificación, en `payment_seller_credentials`);
   - lee el recurso en la API con ese token;
   - lo traduce;
   - llama a `payment_apply_update`.
6. **`payment_apply_update`** (sólo `service_role`):
   - Encuentra el intento por `external_reference` (o por el id de la orden del proveedor).
   - Exige que el vendedor sea la cuenta conectada **del comercio del pedido**. Si no, la notificación queda `ignored` con el motivo `seller_mismatch` y no cambia nada: un vendedor no puede tocar pedidos de otro comercio.
   - Si el pago llega `approved` con un importe distinto del pedido, no se aprueba: queda `processing` y la notificación `flagged` con `amount_mismatch`, para revisar a mano.
   - Si llega un **segundo pago aprobado** para el mismo intento (el mismo checkout pagado dos veces), el pedido sigue pagado y la notificación queda `flagged` con `duplicate_payment`. Para achicar esa ventana, la preferencia de Checkout Pro vence junto con el intento (30 minutos).
   - Aplica sólo transiciones admitidas.
   - Guarda los movimientos, actualiza el intento y el `payment_status` del pedido, y marca la notificación (`applied`/`ignored`/`flagged`).
7. **Reintentos.** Cualquier error al reconciliar deja la notificación `failed` con el motivo, y el proveedor reintenta.
   - El reintento llega con la misma clave, y `payment_record_event` **lo toma para reprocesar**: vuelve a `received`, suma `retries` y responde `duplicate: false`.
   - Lo mismo pasa con una notificación que quedó colgada en `received` más de 5 minutos.
   - Si llegan dos reintentos a la vez, lo toma uno solo (el `update` es atómico).
   - Lo `applied`, `ignored` o `flagged` sigue siendo duplicado y no se toca.

## 9. Cancelaciones y devoluciones

- Si el comercio cancela o rechaza un pedido online **pagado**, el intento queda con `cancel_requested_at`.
- La devolución se hace en Mercado Pago, desde la cuenta del comercio. Cuando el proveedor la informa, el webhook la aplica: `refunded` o `partially_refunded`.
- La sección Pagos muestra cuántas devoluciones faltan (`to_refund`) y cuántos pagos del día quedaron para revisar (`to_review`: importe distinto o pago repetido).
- **Esta rama no ejecuta devoluciones desde CAUCE.** Hacerlo requiere el endpoint de reembolsos del proveedor con la cuenta del comercio, y se agrega con el encendido.
- Un contracargo (`charged_back`) se ve como `refunded`. La disputa abierta (`in_mediation`) no se traduce: queda anotada para revisar a mano.

## 10. Seguridad

Cubierto por pruebas (ver §12):

- El comercio B no ve la cuenta, los intentos, el resumen ni el estado de pago del comercio A, ni lo desconecta.
- Ningún cliente (anon, comprador, titular) ejecuta las funciones del servidor: webhook, OAuth, credenciales y contexto de checkout. Sólo `service_role` las ejecuta.
- El cliente no puede:
  - escribir en tablas de pagos;
  - aprobar su intento;
  - cambiar el `payment_status` del pedido;
  - leer el esquema `private`.
- Un webhook con firma falsa se rechaza (`401`) sin anotarse. Uno repetido no duplica nada.
- La URL de vuelta no aprueba el pago.
- El doble toque devuelve el mismo intento.
- El importe viene del pedido. Si el proveedor informa un importe distinto, el pago no se aprueba.
- Los tokens se cifran con AES‑256‑GCM, con datos adicionales ligados a la versión de clave. La rotación agrega una versión nueva a `PAYMENTS_TOKEN_KEYS`, y las credenciales viejas se siguen abriendo con su versión.
- Los registros guardan sólo nombres de secretos faltantes, nunca valores. La interfaz muestra mensajes humanos, sin errores técnicos crudos.

## 11. Interruptor, secretos y encendido

**Interruptor:** `private.platform_features.payments_online`, en `false` por defecto. Se ve en `app_status().features.payments_online`.

**Secretos de las Edge Functions.** Sólo los nombres; los valores nunca van al repositorio:

- `MP_CLIENT_ID`
- `MP_CLIENT_SECRET`
- `MP_WEBHOOK_SECRET`
- `PAYMENTS_TOKEN_KEYS`: JSON `{"1":"<32 bytes en base64>"}`
- opcional: `CAUCE_SITE_URL`

**Encendido.** Cada paso con backup previo, y primero en un proyecto de prueba:

1. Aplicar la migración `20260926120000_payments_ready` (backup, restore test y dry‑run, como cualquier migración remota). Con el interruptor apagado no cambia nada para nadie.
2. Crear la aplicación en Mercado Pago:
   - redirect URI = `<SUPABASE_URL>/functions/v1/payments-oauth`;
   - webhooks a `<SUPABASE_URL>/functions/v1/payments-webhook`, con los temas `order` y `payment`;
   - clave secreta de webhooks.
3. Cargar los secretos y desplegar las tres funciones (`supabase functions deploy`).
4. **Prueba con usuarios de prueba de Mercado Pago**, con el interruptor encendido sólo en el proyecto de prueba:
   - conectar un comercio;
   - pagar;
   - rechazar;
   - devolver;
   - repetir un webhook;
   - mandar uno con firma falsa.
5. Recién entonces encender `payments_online` en producción, con un comercio piloto. Para apagarlo en cualquier momento: `update private.platform_features set enabled = false where key = 'payments_online'`. Los pedidos online ya creados conservan su estado.

**Reprocesar a mano** una notificación marcada para revisar (sólo servidor): leer el recurso otra vez y llamar a `payment_apply_update` con el mismo `event_id`. La función es idempotente: aplicar dos veces el mismo estado no es un salto. Las `failed` se reprocesan solas con el reintento del proveedor (§8).

## 12. Pruebas

Ninguna prueba llama a Mercado Pago.

| Qué | Dónde |
| --- | --- |
| Estados, transiciones (espejo de la base), formas ofrecidas y retorno | `tests/payments-core.test.mjs` |
| Selector, insignias, sección Pagos, vuelta y "ningún proveedor escrito en las pantallas" | `tests/payments-ui.test.mjs` |
| Mapeo de estados, firma (válida, falsa, vieja), webhook (falso, repetido, tema ajeno, vendedor sin cuenta), idempotencia, cifrado y OAuth | `tests/payments-server.test.mjs` |
| Upgrade sobre datos existentes, interruptor, comercio sin cuenta, aislamiento, OAuth de un solo uso, importe distinto, `seller_mismatch`, aceptar sin pago (`U0007`), doble toque | `tests/db/payments.test.mjs` |
| Lo mismo contra PostgREST y RLS reales: el cliente no ejecuta funciones del servidor, `service_role` sí | `tests/integration/payments.test.mjs` |
