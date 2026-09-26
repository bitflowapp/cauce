# Sandbox de Mercado Pago: resultados

Rama `feat/cauce-mercadopago-sandbox`. Sin secretos: sólo ids no sensibles, estados y números de corrida.

**Estado: la corrida contra Mercado Pago real está PENDIENTE.** Depende de un paso humano: crear las cuentas de prueba y la aplicación "CAUCE Sandbox" en Mercado Pago y cargar sus secretos (§5). Hasta entonces, ningún resultado de esta página dice que Mercado Pago respondió algo que no respondió.

Nunca hubo dinero real: el interruptor global `payments_online` sigue en `false`, no hay pilotos encendidos y no hay credenciales de Mercado Pago cargadas en el proyecto.

## 1. Lo que ya está hecho en el proyecto real

| Qué | Resultado | Evidencia |
| --- | --- | --- |
| Backup cifrado + restauración de prueba + migración `20260927120000` sobre la copia | PASS (14/14) | run `36200528198` |
| Dry-run exacto (sólo `20260927120000`) | PASS | run `36200839816` |
| Primer intento de aplicar | FRENADO por el ensayo, **sin tocar el proyecto**: las 3 transiciones nuevas (datos de referencia) contaban como filas cambiadas. Corregido: los datos de referencia pueden crecer, nunca achicarse | run `36201081856` |
| Migración aplicada, ensayo previo sobre la copia de los datos, smoke público | PASS (21/21) · esquema `20260927120000` · `payments_online: false` | run `36201501098` |
| Edge Functions desplegadas: `payments-oauth` (verify_jwt false), `payments-checkout` (true), `payments-webhook` (false), v1 ACTIVE | PASS (14/14) | run `36201814141` |
| `PAYMENTS_TOKEN_KEYS` creada (valor nunca mostrado) | PASS | run `36201814141` |
| Sin secretos de Mercado Pago cierran: webhook `503 not_configured`, OAuth `503`, checkout sin sesión `401` | PASS | run `36201814141` |
| El navegador del sitio puede llamarlas: preflight CORS por el gateway real (`204`, `allow-origin *`), también con verify_jwt | PASS | run `36201814141` |
| Pagos globales apagados antes y después | PASS | runs anteriores |
| Estado después de migrar y desplegar: funciones activas, `PAYMENTS_TOKEN_KEYS` presente, faltan los secretos de Mercado Pago y de las cuentas de prueba, sin pilotos, sin cuentas, sin avisos, ninguna orden real | PASS (5/5) | run `36203009248` |

## 2. Lo verificado contra la documentación oficial de Mercado Pago

La revisión de la referencia (septiembre de 2026) cambió cuatro supuestos del código anterior. Están corregidos y cubiertos por pruebas:

1. **El sandbox de la API de Orders son cuentas de prueba con credenciales productivas.** Las credenciales `TEST-` (`test_token=true` en el canje) la API de Orders las rechaza: `401 invalid_credentials` ("There is no support for test credentials. Use test users with production credentials for the sandbox environment"). El canje ya no pide `test_token`, y si la cuenta es de prueba lo dice Mercado Pago (`GET /users/me`: etiqueta `test_user`, correo `@testuser.com`), no el `live_mode` del token.
2. **En sandbox `payer.email` tiene que terminar en `@testuser.com`** (`400 invalid_email_for_sandbox`): se manda `test@testuser.com`, el de la documentación.
3. **Una clave de idempotencia repetida con otro cuerpo da `409 idempotency_key_already_used`.** La duración de la orden salía de la hora del envío, así que un reintento tras un corte cambiaba el cuerpo y quedaba trabado. Ahora el mismo intento arma byte a byte el mismo pedido.
4. **Autorización de Argentina en `auth.mercadopago.com.ar`**: el dominio global primero pide elegir el país (verificado con un navegador).

También: `items[].external_code` de hasta 30 caracteres, devoluciones en `transactions.refunds`, estados de la orden (`created`, `processed`, `action_required`, `processing`, `failed`, `refunded`, `canceled`, `expired`, `charged_back`) y manifiesto de la firma (`id:<data.id en minúsculas>;request-id:<x-request-id>;ts:<ts ms>;`).

Y un error que ninguna prueba en Node veía: **el sitio no podía llamar a las funciones desde el navegador (CORS)**. `payments-checkout` respondía `405` al preflight. Corregido y probado a través del gateway real (local y proyecto).

## 3. Lo probado sin Mercado Pago (doble del proveedor)

El doble (`tests/edge/fake-mercadopago.mjs`) reproduce las respuestas documentadas, incluidos los errores de arriba. No cuenta como validación de punta a punta; sirve para lo que el sandbox no deja provocar a pedido.

| Suite | Resultado |
| --- | --- |
| Unitarias (`npm test`) | 320/320 |
| SQL en PostgreSQL embebido (`npm run test:db`) | 110/110 |
| Integración de pagos contra el stack local | 7/7 |
| Funciones en **Deno** contra el stack (`npm run test:edge`) | 18/18 |
| Funciones en **Supabase Edge Runtime** detrás del gateway (Kong) | 18/18 |
| UI de pagos en el navegador (Edge Runtime + build local) | Chromium 3/3 local |
| Conductor de las páginas de Mercado Pago contra páginas simuladas (`tests/e2e/mp-navegador.test.mjs`) | 5/5 |
| CI en `e805804` (run `36203009210`) | integración 68/68 · Deno 18/18 · E2E Chromium y WebKit 62/62 (incluye el conductor) · Edge Runtime + UI de pagos en Chromium y WebKit 24/24 |

Cubren: OAuth con PKCE (state incorrecto, vencido, reutilizado, cancelado; cuenta real en sandbox y cuenta de prueba en un comercio real), CORS, checkout (importe del pedido, pagador de prueba, clave de idempotencia, doble toque, reintento tras un corte con el mismo cuerpo, reenvío verificado), fallas del proveedor (timeout, 429, 500, sin `checkout_url`, 401, orden real), webhook (firmado, falso, sin firma, repetido, fuera de orden, vendedor ajeno, intento desconocido, importe distinto, doble pago, rechazado, pendiente), reconexión, renovación de tokens (en uso y programada), aislamiento y efectivo como respaldo. En el navegador: el retorno a `#/pago/exito` antes del webhook muestra "Estamos confirmando tu pago" y recién el webhook firmado lo pasa a "Pago aprobado".

## 4. La corrida real: `pagos-sandbox`

Paso del workflow "Operación de producción" (`scripts/lib/pagos-sandbox.mjs`). Contra el proyecto real, con el build de esta rama servido en `127.0.0.1:4174` y Mercado Pago real en modo de prueba:

1. Precondiciones (si falta algo, no crea nada): `payments_online = false`, esquema del piloto, funciones activas, los 4 secretos de las funciones, las 9 credenciales de cuentas de prueba, ningún piloto encendido.
2. Arma "CAUCE QA · Mercado Pago A" y "… B" (`cauce-qa-mp-…`) y los enciende como piloto en sandbox. Verifica que el interruptor global sigue apagado.
3. **OAuth por la interfaz**: titular → Panel → Pagos → Conectar → Mercado Pago con la cuenta de prueba Vendedor A (y B) → vuelve con `conexion=ok`. Verifica cuenta de prueba (`live_mode = false`), tokens cifrados, ninguna credencial en la URL final, vuelta repetida / state incorrecto / vencido / cancelado sin efecto, `redirect_uri` exacta y PKCE S256, panel con "Conectado · modo de prueba".
4. **Aprobado** (titular `APRO`): pedido desde la interfaz con pago online → Checkout Pro → tarjeta de prueba → webhook firmado → la función lee la orden en la API → la base aprobada (orden `ORDTST…`, importe del pedido, movimiento del proveedor) → el comercio acepta desde el panel → el panel muestra el cobro.
5. **Idempotencia**: doble toque concurrente (un intento, una orden) y reenvío idéntico al proveedor real (`replay_order`): ninguna orden nueva.
6. **Rechazado** (`OTHE`): pago rechazado, pedido sin aceptar, el comercio no puede aceptarlo; reintentar crea otro intento, con otra clave y otra orden.
7. **Pendiente** (`CONT`): pago en proceso, el comercio no puede aceptar.
8. **Importe distinto** (sólo automático): el intento dice otra cosa que lo cobrado → `amount_mismatch`, nunca aprobado.
9. Webhooks con firma falsa o sin firma → `401` y cero anotaciones.
10. Aislamiento A/B, visita y persona ajena; nadie lee credenciales.
11. Renovación de tokens contra el proveedor real (barrido con la clave de servicio): token nuevo cifrado y vencimiento actualizado.
12. Desconexión de B: sin online, con efectivo; el panel pide conectar.
13. Nunca dinero real: todas las órdenes `ORDTST…`, ninguna cuenta real, `payments_online = false`. Registros de las funciones sin tokens ni tarjetas.
14. Limpieza: pilotos apagados, credenciales y cuentas del proveedor borradas, comercios, pedidos y cuentas QA borrados.

Modos (`"modo"` en `ops/solicitud.json`):

- `automatico`: Playwright recorre también las páginas de Mercado Pago. Nunca registra valores; las capturas tapan campos y usuario.
- `asistido`: las páginas de Mercado Pago las completa una persona. El paso imprime en el registro la dirección (sandbox, de un solo uso, vence) y espera lo que registra la base.
- `mixto` (por defecto): automático y, si Mercado Pago frena al navegador (IP de servidor o captcha), asistido para ese paso. Desde el contenedor de desarrollo, el ingreso de Mercado Libre respondió "Hubo un error accediendo a esta página" (bloqueo de IP de centro de datos): puede pasar lo mismo desde GitHub Actions.

Pedido:

```json
{ "paso": "pagos-sandbox", "aplicar": true, "confirmar": "ygqbcvxdrewcnzedfcyo", "modo": "mixto",
  "email": "", "invitar": false, "motivo": "…" }
```

Evidencia: artefacto `operacion-pagos-sandbox-<run>` con `evidence/operacion-pagos-sandbox.json` y `evidence/pagos-sandbox/` (resultado y capturas sin datos).

## 5. Paso humano pendiente

En Mercado Pago (cuenta real de CAUCE, sólo para crear cuentas de prueba; nunca se paga con ella):

1. Cuentas de prueba de Argentina: "CAUCE QA Integrador" (Integrador), "CAUCE QA Vendedor A" y "… B" (Vendedor), "CAUCE QA Comprador" (Comprador, con saldo ficticio).
2. Con la cuenta de prueba integradora: aplicación **"CAUCE Sandbox"** (Checkout Pro, API de Orders), URL de redireccionamiento `https://ygqbcvxdrewcnzedfcyo.supabase.co/functions/v1/payments-oauth`, PKCE habilitado, webhooks (prueba y productivo) a `https://ygqbcvxdrewcnzedfcyo.supabase.co/functions/v1/payments-webhook` con "Order (Mercado Pago)".
3. Secretos de las Edge Functions: `MP_CLIENT_ID`, `MP_CLIENT_SECRET` (credenciales productivas de "CAUCE Sandbox") y `MP_WEBHOOK_SECRET`.
4. Secretos del entorno `produccion` de GitHub: `MP_TEST_SELLER_A_USER/PASSWORD/CODE`, `MP_TEST_SELLER_B_USER/PASSWORD/CODE`, `MP_TEST_BUYER_USER/PASSWORD/CODE`.

## 6. Resultados de la corrida real

_Se completa con la evidencia de `pagos-sandbox`. Mientras tanto, cada punto figura PENDIENTE._

| Punto | Resultado |
| --- | --- |
| Aplicación de Mercado Pago | PENDIENTE (paso humano) |
| Vendedor de prueba A / B (ids) | PENDIENTE |
| Comprador de prueba | PENDIENTE |
| OAuth marketplace + PKCE | PENDIENTE |
| Checkout Pro por Orders (orden `ORDTST…`) | PENDIENTE |
| Idempotencia contra el proveedor | PENDIENTE |
| Aprobado / rechazado / pendiente | PENDIENTE |
| Webhook firmado real | PENDIENTE |
| Renovación de tokens real | PENDIENTE |
| `live_mode` informado por Mercado Pago en avisos y tokens | PENDIENTE (se registra tal cual) |

## 7. Límites conocidos

- Las cuentas de prueba de Mercado Pago no se pueden borrar: quedan en la cuenta de CAUCE, igual que sus órdenes de prueba.
- `private.payment_events` conserva los avisos del sandbox (ids `ORDTST…` y resultado, sin datos personales).
- El historial de notificaciones de la aplicación lo muestra el panel de Mercado Pago; se revisa a mano.
- CAUCE no ejecuta devoluciones: las hace el comercio en Mercado Pago y el webhook las aplica.
- Con una cuenta real, una compra sin cuenta (sesión anónima) no manda pagador: Mercado Pago lo pide en su página. Para el encendido real conviene revisar si exige `payer.email` en todas las órdenes.
