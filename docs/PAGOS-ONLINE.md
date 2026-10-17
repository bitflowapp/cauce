# Pagos online en CAUCE

Rama `feat/cauce-mercadopago-sandbox`.

**Estado: apagado para todos; piloto de prueba por comercio.** CAUCE no procesa ningún pago real.

- El interruptor global `payments_online` está en `false`. Ninguna migración lo enciende y el sandbox no lo toca.
- Un comercio puede cobrar online **como piloto** (`private.payment_pilot_businesses`) sin tocar el interruptor. Lo enciende sólo la operación (rol de servicio o la base), nunca un cliente. Un piloto en sandbox sólo acepta cuentas y pagos **de prueba** de Mercado Pago.
- En el proyecto real están aplicadas la migración del piloto (`20260927120000`) y las tres Edge Functions desplegadas. Sin los secretos de Mercado Pago responden `503` y no hacen nada.
- Validación contra Mercado Pago real (cuentas de prueba, tarjetas de prueba): [PAGOS-SANDBOX-RESULTS.md](PAGOS-SANDBOX-RESULTS.md).

Este documento cubre la arquitectura y la operación. Las funciones, los parámetros y las respuestas exactas están en [CONTRATO-PAGOS.md](CONTRATO-PAGOS.md).

> **Verificado contra la documentación oficial de Mercado Pago (septiembre de 2026)**: Checkout Pro vía API de Orders (crear y leer orden, URLs de retorno, estados, errores), OAuth (autorización, canje, renovación, PKCE), notificaciones (tema "Order (Mercado Pago)", firma `x-signature`, reintentos) y cuentas y tarjetas de prueba. Las referencias están en la §13. Mercado Pago cambia sus APIs: ante una diferencia, manda su documentación vigente y el sandbox real.

## 1. Reglas que no se negocian

1. **Cada comercio cobra en su propia cuenta.**
   - El comercio conecta su cuenta de Mercado Pago por OAuth, y el dinero del pedido va directo a esa cuenta.
   - CAUCE no tiene una cuenta recaudadora, no toca saldos, no cobra comisión (`marketplace_fee`) y no hace transferencias.
2. **Los tokens del comercio se guardan sólo en el servidor, y cifrados.**
   - Van en `private.payment_provider_credentials`, con AES‑256‑GCM y una clave que vive en los secretos de las Edge Functions (`PAYMENTS_TOKEN_KEYS`).
   - Nunca llegan al navegador, a `localStorage`, al bundle, a una URL ni a los registros. Tampoco el refresh token.
3. **La verdad del pago la dice el proveedor, leída desde el servidor.**
   - Un pago se da por aprobado sólo cuando el servidor lee la orden en la API de Orders (`GET /v1/orders/{id}`) con el token del vendedor que corresponde.
   - Nunca se da por aprobado por la URL de vuelta (`#/pago/exito`), por el cuerpo de un webhook ni por lo que diga el navegador.
4. **El importe sale del pedido en la base.** El navegador nunca manda un importe: el intento de pago copia `total_ars` del pedido.
5. **Un pedido tiene como mucho un intento de pago vivo**, con una clave de idempotencia estable:
   - un doble toque o un reintento devuelven el mismo intento;
   - el mismo intento arma byte a byte el mismo pedido al proveedor, con `X-Idempotency-Key`: un reintento no crea una segunda orden.
6. **La interfaz no nombra a ningún proveedor.**
   - El nombre sale del registro `private.payment_providers` (`label`) y la interfaz habla en estados neutrales (hay una prueba que lo exige).
   - Lo específico de Mercado Pago vive sólo en el servidor (`supabase/functions/_shared/payments/`).
7. **Apagado quiere decir apagado.** Sin interruptor y sin piloto:
   - `payment_methods` ofrece sólo efectivo;
   - `create_order` rechaza `online`;
   - `start_payment` y el inicio del OAuth fallan;
   - las tres Edge Functions responden `503`.
8. **Nunca se mezclan los modos.** Un piloto en sandbox sólo guarda cuentas que Mercado Pago marca como de prueba y sólo redirige a órdenes de prueba (`ORDTST…`). Un comercio que cobra de verdad nunca guarda una cuenta de prueba.

## 2. Piezas

| Pieza | Dónde | Rol |
| --- | --- | --- |
| Dominio neutral | `supabase/migrations/20260926120000_payments_ready.sql` | Cuentas por comercio, intentos, transacciones, eventos de webhook, estados y transiciones, interruptor. |
| Piloto, renovación y aprobados tardíos | `supabase/migrations/20260927120000_payments_sandbox.sql` | Piloto por comercio (sandbox o real), freno a cuentas reales en sandbox, rotación de tokens, vencimiento local de intentos, aprobados que llegan tarde o repetidos. |
| Vocabulario de la interfaz | `js/core/payment.js` | Estados neutrales, formas de pago ofrecidas, lectura del retorno. Sin proveedor adentro. |
| Interfaz | `js/ui/payments.js`, checkout (`js/app.js`), panel | Selector de forma de pago, insignias, sección Pagos (con aviso de modo de prueba), vuelta del proveedor. |
| Adaptador | `supabase/functions/_shared/payments/mercadopago.js` | Arma el pedido de la orden y traduce estados. |
| OAuth | `supabase/functions/_shared/payments/oauth.js` + `payments-oauth/` | PKCE S256, `state` de un solo uso, canje, identidad de la cuenta, guardado cifrado, renovación programada. |
| Renovación | `supabase/functions/_shared/payments/tokens.js` | Token vigente o renovado del lado del servidor; si el proveedor la rechaza, reconectar. |
| Firma de webhooks | `supabase/functions/_shared/payments/signature.js` | `x-signature` (HMAC‑SHA256, comparación en tiempo constante). |
| Receptor de webhooks | `supabase/functions/_shared/payments/webhook.js` + `payments-webhook/` | Anota la notificación, responde rápido y reconcilia después leyendo la API. |
| Iniciar el pago | `payments-checkout/` | Crea (o devuelve) el intento y la orden de Checkout Pro. |
| Cifrado | `supabase/functions/_shared/payments/vault.js` | AES‑256‑GCM con versión de clave (`v<n>.<iv>.<cifrado>`). |
| Configuración | `supabase/functions/_shared/payments/config.js` | Secretos (sólo nombres si faltan), CORS, API del doble sólo en el stack local. |

Las tres Edge Functions:

- `payments-webhook`, con `verify_jwt = false`: Mercado Pago no manda JWT; la firma es la autenticación.
- `payments-oauth`, con `verify_jwt = false`: la vuelta del proveedor no trae JWT. El `POST` de inicio verifica la sesión y la base, que sea titular. La renovación programada exige la clave de servicio.
- `payments-checkout`, con `verify_jwt = true`: la llama quien compra, con su sesión.

`payments-checkout` y `payments-oauth` responden el preflight `OPTIONS` y mandan `Access-Control-Allow-Origin: *` en cada respuesta: el sitio las llama desde el navegador (`functions.invoke`). No hay cookies; la autorización es el JWT de la sesión, igual que en la API REST del proyecto.

## 3. Modelo de datos

- **`orders`**: `payment_method = 'online'` y estados de pago neutrales, con una regla que ata método y estado (el efectivo sólo usa `pending_on_delivery`/`settled`). El efectivo no cambió en nada y la facturación ARCA sigue dependiendo de `settled`.
- **`payment_provider_accounts`**: la cuenta de cada comercio en cada proveedor. Estado (`not_connected`, `connecting`, `connected`, `reconnect_required`), `provider_user_id` (vendedor), scopes, `live_mode` y vencimiento del token. No guarda secretos; la leen titular y encargado/a.
  - `live_mode` en CAUCE quiere decir **"la cuenta mueve dinero real"**: es `false` sólo para una cuenta que Mercado Pago marca como de prueba (§6). No es el `live_mode` del token, que con credenciales productivas de una cuenta de prueba viene en `true`.
- **`private.payment_provider_credentials`**: tokens cifrados, versión de clave y vencimiento. Ningún rol de cliente la lee.
- **`private.payment_oauth_states`**: `state` y `code_verifier` de cada conexión. Vence en 10 minutos y se usa una sola vez.
- **`private.payment_pilot_businesses`**: comercios piloto (`sandbox` sí/no, motivo). RLS cerrado; sólo la operación escribe.
- **`payment_attempts`**: un intento por pedido y vez. `flow`, estado neutral, importe, `idempotency_key` (UUID estable), orden del proveedor, URL del checkout, `cancel_requested_at`, vencimiento (30 minutos) y creación. Un índice único parcial permite un solo intento vivo (`pending`/`processing`) por pedido.
- **`payment_transactions`**: movimientos que informa el proveedor (pagos y devoluciones), únicos por proveedor e id.
- **`private.payment_events`**: cada notificación recibida, única por clave de evento (la deduplicación queda en la base), con su resultado (`received`, `applied`, `ignored`, `flagged`, `failed`) y el `live_mode` que informó el proveedor.
- **`private.payment_providers`** y **`private.payment_status_transitions`**: registro de proveedores y máquina de estados (espejada en `js/core/payment.js`, probada en ambos lados).

## 4. Estados

Estados neutrales: `pending`, `processing`, `approved`, `rejected`, `cancelled`, `refunded`, `partially_refunded`, `expired`. (`not_required` es sólo la vista del efectivo en la interfaz.)

Transiciones admitidas (repetir el estado actual no es un salto):

```
pending            → processing | approved | rejected | cancelled | expired
processing         → approved | rejected | cancelled | expired
approved           → refunded | partially_refunded
partially_refunded → refunded
rejected | expired | cancelled → approved   (dinero que llegó tarde: se aplica y queda para revisar)
```

Un aprobado sobre un intento cerrado no se ignora: es plata del comprador. Se aplica y la notificación queda `flagged` (`approved_after_close`). Un pago aprobado nunca se "desaprueba" por un intento posterior.

Traducción desde la API de Orders (verificada con la referencia oficial):

| Estado de la orden | CAUCE |
| --- | --- |
| `created`, `action_required` | `pending` |
| `processing` | `processing` |
| `processed` | `approved` (con detalle `partially_refunded`: `partially_refunded`) |
| `refunded` | `refunded` |
| `canceled` | `cancelled` |
| `failed` | `rejected` |
| `expired` | `expired` |
| `charged_back` | `refunded` |

Un estado que no está en la tabla no se aplica: la notificación queda `ignored` con el estado crudo en el detalle.

**Pedido y pago son estados separados.** Un pedido online nace `submitted` con el pago `pending`. El comercio **no puede aceptarlo** hasta que el pago esté `approved` (`transition_order` responde `U0007` y la interfaz lo explica). El estado de pago del pedido sale del intento aprobado si hay uno; si no, del último intento.

## 5. Checkout Pro vía API de Orders

CAUCE usa **Checkout Pro con la API de Orders** (la recomendada por Mercado Pago para integraciones nuevas; las preferencias quedan como alternativa sin uso):

- los datos de la tarjeta se cargan en Mercado Pago; CAUCE nunca los ve (superficie PCI mínima);
- no toca la CSP de CAUCE ni agrega scripts de terceros;
- cubre todos los medios que el vendedor tenga habilitados.

El camino de Checkout API (pago dentro de CAUCE, `processing_mode: automatic`) está armado y probado sin red, pero sin formulario de tarjeta en la interfaz.

## 6. Conexión del comercio (OAuth)

1. En el panel, **Pagos → Conectar &lt;proveedor&gt;** (con el interruptor encendido o si el comercio es piloto; sólo la persona titular conecta o desconecta).
2. La interfaz llama a `payments-oauth` (`POST {business, provider}`) con la sesión. La función verifica la sesión, genera `state` (32 bytes aleatorios) y el par PKCE S256 (`code_verifier` de 64 caracteres), y llama a `payment_oauth_begin` como `service_role`: la base vuelve a exigir titular y comercio habilitado, valida el largo (verifier 43–128, state ≥ 32), deja la cuenta en `connecting` y guarda `state` + `code_verifier` (10 minutos, un solo uso).
3. Devuelve la URL de autorización: `https://auth.mercadopago.com.ar/authorization?client_id&response_type=code&platform_id=mp&state&redirect_uri&code_challenge&code_challenge_method=S256`. (El dominio global `auth.mercadopago.com` primero pide elegir el país y después redirige a este.)
4. La **URL de retorno es fija**, del lado del servidor y nunca cambia entre intentos: `https://ygqbcvxdrewcnzedfcyo.supabase.co/functions/v1/payments-oauth`. Es la que se carga en la aplicación de Mercado Pago.
5. Mercado Pago vuelve con `?code&state`. La función:
   - busca el `state` vigente; si no sirve (vencido, usado, inventado) lo quema y redirige con `conexion=vencida`, sin canjear nada; si el vendedor canceló (`error=…`), `conexion=cancelada`;
   - canjea el código en `POST https://api.mercadopago.com/oauth/token` con `client_id`, `client_secret`, `code`, `redirect_uri` idéntica y `code_verifier`. **Sin `test_token`**: esas credenciales (`TEST-…`) la API de Orders las rechaza (`401 invalid_credentials`). El sandbox de Orders son **cuentas de prueba con credenciales productivas**;
   - pregunta a Mercado Pago quién es la cuenta (`GET /users/me`): una cuenta de prueba tiene la etiqueta `test_user` y correo `@testuser.com`. Un piloto en sandbox que recibe una cuenta real (o un comercio real que recibe una de prueba) descarta los tokens y vuelve con `conexion=cuenta_real` (o `cuenta_prueba`);
   - cifra `access_token` y `refresh_token` y llama a `payment_oauth_complete`, que marca el `state` como usado y deja la cuenta `connected` (la base vuelve a rechazar una cuenta real en un piloto de prueba).
6. Redirige a `#panel/<id>/pagos?conexion=ok|cancelada|vencida|cuenta_real|cuenta_prueba|error`. Ningún token pasa por la URL final.
7. **Desconectar** (`disconnect_payment_account`, sólo titular) borra las credenciales en el acto y deja la cuenta `not_connected`: el checkout vuelve a ofrecer sólo efectivo.
8. **Renovación del token** (180 días de vida), siempre del lado del servidor:
   - al usarlo, si vence dentro de 30 días se renueva (`grant_type=refresh_token`): el token nuevo y el refresh token nuevo se cifran y se guardan con su vencimiento (`payment_account_rotate`) antes de usarse;
   - si el proveedor rechaza la renovación, la cuenta pasa a `reconnect_required`, el online desaparece del checkout y el efectivo sigue; si el proveedor no responde, se sigue con el token guardado mientras no haya vencido;
   - barrido programado: `POST payments-oauth {action: 'refresh_due', within_days}` con la clave de servicio renueva las cuentas que vencen pronto.

## 7. Pago de un pedido (Checkout Pro)

1. **Checkout.** La interfaz pide `payment_methods(business)`: la opción online aparece sólo si el comercio está habilitado (interruptor o piloto) **y** su cuenta está `connected` (de prueba, si es un piloto en sandbox). Si la consulta falla, se ofrece sólo efectivo.
2. **Crear el pedido.** `create_order` con `payment_method = 'online'` vuelve a verificar las condiciones. El pedido nace con el pago `pending`.
3. **Iniciar el pago.** La interfaz llama a `payments-checkout` (`POST {order_id, flow: 'checkout_pro'}`) con la sesión de quien compra. La función:
   - llama a `start_payment` **como esa persona** (la base verifica que el pedido sea suyo y crea o devuelve el intento vivo, con el importe del pedido; un intento pendiente vencido se cierra como `expired`/`local_expiry` y se crea otro);
   - si el intento ya tiene checkout, lo devuelve sin llamar de nuevo al proveedor;
   - obtiene el token vigente del comercio (renovándolo si hace falta) y crea la orden: `POST https://api.mercadopago.com/v1/orders` con `X-Idempotency-Key = idempotency_key` y

     ```json
     {
       "type": "online",
       "processing_mode": "manual",
       "external_reference": "<attempt_id>",
       "total_amount": "3000.00",
       "description": "Pedido CA-1234 · Nombre del comercio",
       "expiration_time": "PT30M",
       "payer": { "email": "test@testuser.com" },
       "items": [{ "external_code": "CA-1234", "title": "Pedido CA-1234 · Nombre del comercio", "quantity": 1, "unit_price": "3000.00" }],
       "config": { "online": { "success_url": ".../index.html#/pago/exito?intento=<id>", "pending_url": "…#/pago/pendiente?…",
         "failure_url": "…#/pago/error?…", "auto_return": "approved" } }
     }
     ```
     - una sola línea con el total del pedido (`external_code` hasta 30 caracteres);
     - `expiration_time` es la vida completa del intento, medida con sus propias fechas: el mismo intento manda siempre el mismo cuerpo (el proveedor responde `409 idempotency_key_already_used` a una clave repetida con otro contenido);
     - `payer.email`: en sandbox, el pagador de prueba que exige el proveedor (`400 invalid_email_for_sandbox` si no termina en `@testuser.com`); con una cuenta real, el correo de la cuenta de quien compra (una sesión anónima no manda pagador);
     - sin `marketplace_fee`.
   - exige `id` y `checkout_url` https; en un piloto en sandbox, además, que la orden sea de prueba (`ORDTST…`), si no `409 live_order_refused`;
   - guarda la orden y la URL (`payment_attempt_set_checkout`) y devuelve `checkout_url`.
4. **Fallas del proveedor** (sin guardar nada; el reintento usa la misma clave): sin respuesta en 10 s → `504 provider_timeout`; `401` → la cuenta pasa a `reconnect_required` y `409 account_reconnect_required`; `429`/`409` → `503 provider_busy` con `Retry-After`; otro error o sin `checkout_url` → `502 provider_error`.
5. **Pagar.** El navegador va a `checkout_url`. Si no se puede abrir, el pedido queda con el pago pendiente y se paga desde el pedido ("Pagar ahora").
6. **Volver.** `#/pago/*` **no aprueba nada**: consulta `payment_status(reference)` (sólo quien compró o el comercio), muestra el estado real ("Estamos confirmando tu pago" aunque la URL diga éxito) y vuelve a consultar cada 5 segundos mientras siga pendiente.
7. **La verdad llega por el webhook** (§8). El pedido pasa a `approved` y el comercio puede aceptarlo.

## 8. Webhooks

Receptor: `payments-webhook`, configurado en la aplicación de Mercado Pago (modo de prueba y productivo) con el evento **Order (Mercado Pago)**: `https://ygqbcvxdrewcnzedfcyo.supabase.co/functions/v1/payments-webhook`.

1. **Validaciones iniciales.** `POST` y HTTPS; cuerpo de más de 64 KB → `413`; JSON inválido → `400`; sin secreto → `503`.
2. **Firma.** `x-signature: ts=<ms>,v1=<hmac>`. HMAC‑SHA256 con `MP_WEBHOOK_SECRET` sobre `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (`data.id` de la URL, en minúsculas si es alfanumérico; se omiten las partes que no vienen). Comparación en tiempo constante. **Firma inválida o ausente → `401` y no se anota nada.**
3. **Temas.** Se procesan `order` (y `payment`, por compatibilidad). Cualquier otro recibe `200` para que no se reintente.
4. **Idempotencia.** La notificación se anota con una clave estable (SHA‑256 del id de la notificación o del recurso + acción + `x-request-id`). Si ya estaba, `200 {duplicate: true}` y nada más.
5. **Rápido.** Responde `200` enseguida (Mercado Pago espera hasta 22 s y si no, reintenta: 15 min, 30 min, 6 h, 48 h, 96 h…). La reconciliación corre después (`EdgeRuntime.waitUntil`):
   - credenciales del **vendedor que avisa** (`user_id`), con renovación si hace falta;
   - `GET /v1/orders/{id}` con ese token: la verdad sale de la API, no del cuerpo;
   - `payment_apply_update`.
6. **`payment_apply_update`** (sólo `service_role`):
   - encuentra el intento por `external_reference` (o por la orden guardada);
   - el vendedor tiene que ser la cuenta conectada **del comercio del pedido** (si no, `seller_mismatch` y nada cambia);
   - aprobado con otro importe → no se aprueba, `flagged` `amount_mismatch`;
   - aprobado sobre un intento cerrado → se aplica, `flagged` `approved_after_close`;
   - aprobado de otro intento del mismo pedido ya pagado → el pedido sigue pagado una vez, `flagged` `duplicate_payment`. **Nunca se devuelve dinero en automático**: lo revisa el comercio;
   - otra orden para el mismo intento → se aplica y queda `flagged` `provider_order_mismatch`;
   - aplica sólo transiciones admitidas, guarda los movimientos y marca la notificación.
7. **Reintentos.** Un error al reconciliar deja la notificación `failed` y el proveedor reintenta: el reintento la reprocesa (vuelve a `received`, suma `retries`). Lo `applied`, `ignored` o `flagged` sigue siendo duplicado.

## 9. Cancelaciones y devoluciones

- Si el comercio cancela un pedido online **pagado**, el intento queda con `cancel_requested_at`. La devolución se hace en Mercado Pago, desde la cuenta del comercio; cuando el proveedor la informa (`transactions.refunds`), el webhook la aplica: `refunded` o `partially_refunded`.
- La sección Pagos muestra las devoluciones pendientes (`to_refund`) y lo que quedó para revisar (`to_review`: importe distinto, pago repetido, aprobado tardío).
- **CAUCE no ejecuta devoluciones.** Un contracargo (`charged_back`) se ve como `refunded`.

## 10. Seguridad

Cubierto por pruebas (§12) y, contra Mercado Pago real, por `pagos-sandbox`:

- El comercio B no ve la cuenta, los intentos, el resumen ni el estado de pago del comercio A, ni lo desconecta. Un aviso de otro vendedor no toca pedidos ajenos.
- Ningún cliente ejecuta las funciones del servidor (webhook, OAuth, credenciales, contexto de checkout, piloto, rotación). Nadie lee `private`.
- El cliente no puede escribir en tablas de pagos, aprobar su intento ni cambiar el `payment_status`.
- Webhook falso o sin firma → `401` sin anotarse; repetido → una sola vez; la URL de vuelta no aprueba; el doble toque devuelve el mismo intento; el importe viene del pedido.
- Tokens con AES‑256‑GCM y datos adicionales ligados a la versión de clave; la rotación agrega una versión nueva a `PAYMENTS_TOKEN_KEYS` y las viejas se siguen abriendo.
- Los registros guardan sólo nombres de secretos faltantes, nunca valores; ninguna función escribe tokens ni datos de tarjeta en un registro (`pagos-sandbox` lo verifica en los registros del proyecto).

## 11. Interruptor, piloto, secretos y operación

**Interruptor global:** `private.platform_features.payments_online` (`false`). Se ve en `app_status().features.payments_online`.

**Piloto por comercio:**

```sql
-- encender (sandbox): sólo la operación
insert into private.payment_pilot_businesses (business_id, sandbox, reason) values ('<id>', true, 'CAUCE QA · Mercado Pago');
-- apagar
delete from private.payment_pilot_businesses where business_id = '<id>';
```

**Secretos de las Edge Functions** (Supabase → Edge Functions → Secrets; sólo nombres, nunca en el repositorio):

- `MP_CLIENT_ID`, `MP_CLIENT_SECRET`: de la aplicación de Mercado Pago (para el sandbox, la aplicación "CAUCE Sandbox" de la cuenta de prueba integradora, credenciales productivas);
- `MP_WEBHOOK_SECRET`: clave secreta de webhooks de esa aplicación;
- `PAYMENTS_TOKEN_KEYS`: `{"1":"<32 bytes en base64>"}`; la crea `pagos-funciones` si falta y nunca la reemplaza;
- opcional: `CAUCE_SITE_URL` (por defecto `https://bitflowapp.github.io/cauce`).

**Aplicación de Mercado Pago:** Checkout Pro, API de Orders; URL de redireccionamiento `https://ygqbcvxdrewcnzedfcyo.supabase.co/functions/v1/payments-oauth` (fija); PKCE habilitado; webhooks (modo de prueba y productivo) a `https://ygqbcvxdrewcnzedfcyo.supabase.co/functions/v1/payments-webhook` con el evento "Order (Mercado Pago)".

**Pasos del workflow "Operación de producción"** (`ops/solicitud.json`; los que escriben piden `aplicar` y `confirmar` con el ref del proyecto):

| Paso | Qué hace |
| --- | --- |
| `backup` → `migrar` (dry-run) → `migrar` aplicar | copia cifrada, restauración de prueba, ensayo sobre la copia y recién ahí la migración |
| `pagos-funciones` | despliega las tres funciones sólo con los pagos globales apagados y el código sin credenciales; crea `PAYMENTS_TOKEN_KEYS`; verifica que cierran sin secretos y el preflight CORS |
| `pagos-estado` | funciones, secretos (nombres), interruptor, pilotos, cuentas y notificaciones; ninguna orden real |
| `pagos-sandbox` | Mercado Pago real en modo de prueba de punta a punta (ver [PAGOS-SANDBOX-RESULTS.md](PAGOS-SANDBOX-RESULTS.md)); `modo`: `automatico`, `asistido` o `mixto` |
| `pagos-limpiar` | saca pilotos, credenciales y comercios QA de pagos |

**Encendido real** (fuera de este alcance): con el sandbox en verde, una aplicación productiva propia de CAUCE, un comercio piloto real (`sandbox = false`) y recién después, si se decide, el interruptor global. Para apagar todo en cualquier momento: borrar los pilotos y dejar `payments_online` en `false`; los pedidos online ya creados conservan su estado.

## 12. Pruebas

| Qué | Dónde |
| --- | --- |
| Estados, transiciones (espejo de la base), formas ofrecidas y retorno | `tests/payments-core.test.mjs` |
| Selector, insignias, sección Pagos, vuelta y "ningún proveedor escrito en las pantallas" | `tests/payments-ui.test.mjs` |
| Adaptador según la referencia de Orders (cuerpo, pagador de prueba, `external_code`, cuerpo idéntico al reintentar, devoluciones), firma, webhook, cifrado, OAuth (sin `test_token`, identidad de la cuenta), renovación | `tests/payments-server.test.mjs` |
| Migraciones sobre datos existentes, piloto, freno a cuentas reales, renovación, vencimiento local, aprobados tardíos y repetidos | `tests/db/payments*.test.mjs` |
| PostgREST y RLS reales | `tests/integration/payments.test.mjs` |
| Las funciones corriendo de verdad (Deno y Supabase Edge Runtime) contra el stack y un doble del proveedor con sus errores documentados: OAuth, CORS, checkout, idempotencia, fallas (timeout, 429, 500, sin `checkout_url`, 401, orden real), webhook, aislamiento, reconexión, renovación | `tests/edge/functions.test.mjs` (`npm run test:edge`) |
| La UI de pagos en Chromium y WebKit (conectar desde el panel, pagar, volver antes del webhook, aceptar, rechazo y reintento) | `tests/edge/browser.test.mjs` (`run-local.mjs --runtime edge --browser`) |
| Mercado Pago real en modo de prueba | `pagos-sandbox` (workflow de operación) |

El doble del proveedor (`tests/edge/fake-mercadopago.mjs`) sirve para lo que el sandbox no deja provocar (demoras, 429, 500, tokens revocados); no reemplaza la validación contra Mercado Pago.

## 13. Referencias de Mercado Pago

- Checkout Pro vía Orders: <https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-orders/overview>, crear orden <https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-orders/create-order>, URLs de retorno <https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-orders/web-integration/configure-back-urls>
- Referencia: crear orden <https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro/create-order/post>, obtener orden <https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro/get-order/get>
- Notificaciones: <https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-orders/notifications>
- OAuth: <https://www.mercadopago.com.ar/developers/es/docs/security/oauth/creation>, renovación <https://www.mercadopago.com.ar/developers/es/docs/security/oauth/renewal>, token <https://www.mercadopago.com.ar/developers/es/reference/authentication/oauth/_oauth_token/post>
- Cuentas y tarjetas de prueba: <https://www.mercadopago.com.ar/developers/es/docs/your-integrations/test/accounts>, <https://www.mercadopago.com.ar/developers/es/docs/checkout-api-orders/integration-test/cards>
