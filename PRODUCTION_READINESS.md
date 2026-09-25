# CAUCE · Preparación para producción

Última revisión: 25 de septiembre de 2026, sobre `main` 7e328a6 (la aplicación publicada; la entrega E no la cambia).

## Estado

**READY_FOR_PILOT · plataforma piloto publicada** (`main` 7e328a6, build
conectado a `ygqbcvxdrewcnzedfcyo` en https://bitflowapp.github.io/cauce/),
para 5 a 20 comercios de Aluminé. Verificado sobre el sitio publicado, en
Chromium y WebKit:

- **el mismo pedido de punta a punta**:
  1. el cliente compra con envío;
  2. el encargado lo acepta, prepara y asigna desde el panel;
  3. la persona de reparto, desde su teléfono, lo retira, sale y llega;
  4. entrega con el código que le dicta el cliente;
  5. el cliente lo ve entregado y el comercio lo suma a sus ventas del día;
- compra sin cuenta con retiro y seguimiento por enlace;
- administración con el día del piloto;
- seguridad sobre la API publicada: comercio ajeno, reparto ajeno, precio y estado manipulados;
- anchos de 320 a 1440 px;
- residuo QA en 0;
- registros sin respuestas 5xx.

Queda **una sola acción humana**: que la persona de `CAUCE_ADMIN_EMAIL`
(invitada el 25/09, `m***@gmail.com`) entre a
https://bitflowapp.github.io/cauce/#cuenta y use "¿Olvidaste tu contraseña?"
con ese correo, porque el enlace de la invitación ya venció. Después se corre
`admin --aplicar` (pedido de operación `paso: admin`, `aplicar: true`), que le
otorga la administración. Recién ahí se puede aprobar un comercio real.

Todo lo demás del primer comercio ya funciona: se registra, arma su borrador,
catálogo, horarios y reparto, y pide la publicación (§4).

### Core publicado (fase A, `main` 2695953)

| # | Gate | Resultado en el proyecto real | Evidencia |
| --- | --- | --- | --- |
| B5 | Backup y restauración | **PASS.** 4 backups diarios de Supabase (último 24/09 07:54 UTC), retención 7 días (plan Pro). Copia cifrada AES-256 (artefacto de 30 días). Restauración en la versión del origen (8 migraciones): 24 tablas con los mismos conteos, esquema idéntico salvo privilegios que fija la plataforma (N-21), y la migración pendiente aplicada sobre la copia con todas las verificaciones. | run 36078082544 · 14/14 |
| B1 | Migración `20260924120000` | **PASS.** Historial 8/8 igual al repo; el dry-run listó únicamente `20260924120000`; ensayo sobre una copia de los datos reales; aplicada el 25/09 a las 00:46 UTC; 9/9 sincronizadas; smoke público 20/20. | runs 36078604627 y 36078756560 |
| B2 | Auth real | **PASS.** `site_url` `https://bitflowapp.github.io/cauce`, retornos sólo de ese sitio, confirmación obligatoria, compra sin cuenta (150 sesiones por hora e IP), contraseña de 10+ con letras y números, rotación de tokens, enlaces de 1 h, SMTP propio y plantillas de CAUCE. | runs 36079258576 y 36101124472 · 13/13 |
| P5 | Comercio y cliente de punta a punta, con el build de producción contra el proyecto real (`smoke-previo`) | **PASS 7/7.** Alta por el procedimiento normal (datos, horarios, retiro y envío, categoría, productos, aprobación); compra sin cuenta con retiro, el comercio acepta → prepara → listo → retirado y el cliente lo ve en vivo; enlace de seguimiento sin datos personales; compra con cuenta y envío con encargado y repartidor (total 5.900 con 900 de envío, calculado por el servidor); 320, 390, 430, 768, 1280 y 1440 px en Chromium y WebKit; seguridad (panel sin sesión, comercio ajeno, staff, administración, precio cambiado, total escrito a mano, autoaceptación, saltos de estado, visita sin pedidos). | runs 36081431076 y 36086705024 (código final) |
| P13 | Residuo QA | **PASS.** QA_USERS 0 · QA_BUSINESSES 0 · QA_ORDERS 0 · QA_STORAGE 0. | runs 36081816451 y 36087093631 (después del último smoke) |
| P14 | Registros (24 h) | **PASS.** Ninguna respuesta 5xx, y cada 4xx y error tiene origen conocido: llamadas anteriores a la migración (`app_status`, `open_now`; la última a las 00:40), las pruebas de seguridad de los smokes (rechazadas como corresponde) y el sondeo de sólo lectura de la auditoría (24/09 16:35–16:42 UTC, rechazado entero). El único defecto real, un canal en vivo abierto sin sesión, se corrigió (N-23) y no volvió a aparecer en el smoke sobre el código final. Un corte de replicación de Realtime (25/09 00:05) se recuperó solo. | runs 36083254425 y 36087184244 |
| B3 | SMTP, confirmación y recuperación reales | **PASS.** Los nueve secretos cargados (sólo se verifican los nombres). Con entrega real a una casilla externa: alta sin confirmar no entra; la confirmación llega, vuelve al sitio real y confirma desde otro dispositivo; la recuperación llega, fija la contraseña nueva, la anterior deja de valer y el enlace no se reutiliza; la invitación llega y la persona elige su contraseña. Cuentas de prueba borradas. | runs 36101016643 (secretos), 36101193671 · 22/22 |
| B4 | Administración real | **Invitación enviada** a la cuenta de `CAUCE_ADMIN_EMAIL` (no existía). Falta que la persona la acepte en el sitio publicado y elija su contraseña; después `admin --aplicar` otorga el privilegio. Si el enlace venció (1 h), sirve "¿Olvidaste tu contraseña?" con ese correo. | runs 36101307803 y 36102590496 |
| B6 | Deploy de producción | **PASS.** Integrado #3 (`main` 2695953); Pages corrió las compuertas, exigió el esquema remoto, publicó el build conectado y lo verificó. | run 36102110690 |
| P15 | Smoke sobre el sitio publicado | **PASS 7/7** en Chromium y WebKit. Cubre:<br>• compra sin cuenta con retiro y seguimiento;<br>• cliente con cuenta, envío y reparto a cargo del encargado;<br>• 320–1440 px;<br>• seguridad sobre la API publicada.<br>Limpió 5 pedidos, 2 comercios y 8 cuentas QA. | run 36102265827 |
| P16 | Residuo QA y registros después del deploy | **PASS.** QA_USERS, QA_BUSINESSES, QA_ORDERS y QA_STORAGE en 0. Ningún 5xx en 24 h; los 4xx y errores son las pruebas de seguridad de los smokes, llamadas previas a la migración y la reconexión de Realtime de las 00:05, que se recuperó sola. | runs 36102522235 y 36102676129 |

### Plataforma piloto (fases B a E)

Sobre el core publicado (§Estado) se integraron, cada una con su rama, su PR y
CI verde. Las que cambian la aplicación (B a D) pasaron además el smoke previo
de su build contra el proyecto real y el smoke sobre el sitio publicado; las
migraciones, backup con restauración, dry-run exacto y ensayo sobre una copia
de los datos antes de aplicarse:

| # | Entrega | Resultado en el proyecto real | Evidencia |
| --- | --- | --- | --- |
| B | Panel remoto del comercio (#4) | **PASS.** Integrado en `main` 10276df y publicado. Smoke previo 7/7 con el build de la rama; smoke publicado 7/7 en Chromium y WebKit; residuo QA en 0; registros sin 5xx. | runs 36102981993, 36103743387 (deploy), 36103961675, 36104432381 y 36104613689 |
| C1 | Migración del reparto `20260925120000` | **PASS.** Backup cifrado con restauración y la migración ensayada sobre la copia restaurada (14/14); dry-run exacto (sólo esa migración); aplicada el 25/09 a las 07:31 UTC después de otro ensayo sobre una copia de los datos (21/21, 10/10 sincronizadas, smoke público). | runs 36106405329, 36106832164 y 36107763938 |
| C2 | Reparto propio v1 (#5) | **PASS.** CI verde. Smoke previo del build de la rama contra el proyecto migrado: 7/7. Integrado en `main` 49da21c y publicado. Smoke publicado 7/7 en Chromium y WebKit, con **el mismo pedido de punta a punta**: cliente → encargado → persona de reparto desde su teléfono → código dictado por el cliente → entregado. Residuo QA en 0; registros sin 5xx en 24 h. | runs 36108156382, 36109115540 (deploy), 36109397909, 36109792860 y 36110105220 |
| D1 | Migración de métricas del piloto `20260925150000` (sólo agrega funciones) | **PASS.** Backup cifrado con restauración y la migración aplicada sobre la copia restaurada (14/14); dry-run exacto (sólo esa migración); aplicada el 25/09 a las 08:08 UTC después de otro ensayo sobre una copia de los datos (21/21, 11/11 sincronizadas, smoke público). | runs 36109420436, 36110107933 y 36111033957 |
| D2 | Administración: el día del piloto (#6) | **PASS.** CI verde. Smoke previo del build de la rama contra el proyecto migrado: 7/7. Integrado en `main` 7e328a6 y publicado. Smoke publicado 7/7 en Chromium y WebKit: el mismo pedido de punta a punta con reparto y la administración con "Hoy en CAUCE", el pedido del día, el comercio QA en la lista y "Necesitan atención". Residuo QA en 0; registros sin 5xx en 24 h. | runs 36111220093, 36112229997 (deploy), 36112454465, 36112502956 y 36112842130 |
| E | Contrato de facturación ARCA, escaneo de secretos y smoke diario (#7) | **PASS.** CI verde, con el escaneo de secretos sobre todos los archivos versionados (0 hallazgos) y la lógica no fiscal de la facturación (10 pruebas). Facturación `CONTRACT_READY`: no se emite ni se simula ningún comprobante. No cambia la aplicación publicada ni la base; el smoke diario de sólo lectura ahora corre cuando Pages publica producción. | CI de #7 |

Con `.github/deploy-target` en `production`, integrar a `main` publica el
build conectado; Pages igual se niega a publicar si el esquema remoto no es
compatible. Para volver a la demostración sin tocar código: §3.7.

## 1. Compuertas y cómo se verifican

Todas corren en CI (`.github/workflows/ci.yml`) en cada push y pull request,
sin secretos de producción: la integración y la E2E levantan un stack Supabase
local efímero dentro del runner.

| Compuerta | Comando | Qué prueba | Resultado |
| --- | --- | --- | --- |
| Instalación limpia | `npm ci` | lockfile reproducible | PASS |
| Lint | `npm run lint` | ESLint (flat config) sobre todo el repo | PASS |
| Tipos | `npm run typecheck` | TypeScript `checkJs` sobre `js/` con JSDoc | PASS |
| Compuertas estáticas | `npm run check` | sintaxis, imports, copy, orígenes permitidos, CSP | PASS |
| Unitarias | `npm test` | dominio, horarios, telemetría, repositorio, service worker, panel, reparto, métricas del piloto y la lógica no fiscal de facturación | 252/252 |
| SQL embebido | `npm run test:db` | migraciones desde cero + actualización con datos legados, RLS por rol, techos del registro de errores, reparto (transiciones, código de entrega, entre comercios) y métricas del piloto | 75/75 |
| Integración y seguridad | `npm run test:integration` | Postgres + GoTrue + PostgREST + Storage + Realtime + Mailpit reales, con el repositorio de la aplicación | 61/61 |
| E2E Chromium y WebKit | `npm run e2e:local` | recorridos en navegadores reales contra el build de producción: compra, panel, reparto a 390 px, administración, anchos de 320 a 1280 px (incluye invitación con correo real) | 57/57 |
| Recorridos heredados y auditoría visual | `npm run e2e`, `e2e:demo`, `audit:visual`, `audit:visual:backend` | un Chrome por rol contra el backend de desarrollo y la demo; 32 pantallas sin desbordes ni errores | 37 · 12 · 32 · 32, seis vueltas seguidas sin fallos tras N-19 |
| Builds | `npm run build`, `build:offline`, `build:production` | demo, demo sin red, producción con chequeo de bundle | PASS |
| Escaneo de secretos | `npm run scan:secrets` | todos los archivos versionados: claves de Supabase, tokens, claves privadas, contraseñas y SMTP; muestra archivo y regla, nunca el valor | PASS |
| Smoke de producción | `npm run smoke:production` | sólo lectura contra el proyecto y el sitio reales; también todos los días a las 08:00 (`smoke.yml`) | 5/5 el 25/09 después de publicar `main` 7e328a6 (`js/app.CLP2K3QL.js`) |

`npm run verify` agrupa lint, tipos, compuertas, escaneo de secretos, unitarias, SQL y builds.

Ensayos de la operación del proyecto real (no corren en CI: levantan stacks
Supabase temporales y tardan varios minutos):

| Ensayo | Comando | Resultado |
| --- | --- | --- |
| B1 de punta a punta sobre Supabase real con sólo las 8 migraciones de producción y datos de esa versión | `node scripts/ensayo-migracion.mjs` | PASS: migró con el mismo comando que en producción, filas intactas, contrato publicado por la API, pedidos en curso operables |
| Paso `migrar`: al día, pendiente exacta y divergencia simulada | `node scripts/operacion.mjs migrar --local` | PASS · PASS · STOP como corresponde |
| Paso `correo` (confirmación, recuperación con el enlace anterior invalidado e invitación) | `node scripts/operacion.mjs correo --local` | 22/22 |
| Paso `admin` (existente, invitación, correo malicioso) | `node scripts/operacion.mjs admin --local …` | PASS · PASS · rechazado |
| Paso `backup` con restauración | `CAUCE_BACKUP_PASSPHRASE=… node scripts/operacion.mjs backup --local` | 12/12, esquema idéntico a las migraciones |
| Smoke post-deploy (comercios CAUCE QA, Chromium y WebKit) | `CAUCE_SMOKE_LOCAL=1 npm run smoke:publicado` | 7/7 en 31 s, sin residuo |
| El mismo smoke con el build de producción contra el proyecto real, antes de publicar | paso `smoke-previo` | 7/7 (run 36081431076) |
| Limpieza de residuo QA (corrida interrumpida simulada) | `node scripts/operacion.mjs limpiar-qa --local --aplicar` | borró 2 cuentas y 1 comercio QA; 172 cuentas reales intactas |

### Qué cubren las pruebas de seguridad (contra el stack real)

Identidades independientes: visita sin sesión, sesión anónima de compra,
cliente A y B, owner/manager/staff del comercio A, owner del comercio B,
cuenta sin rol y administración.

- Una visita no lee pedidos, perfiles, contactos, membresías, borradores ni
  eventos; no escribe ni invoca nada salvo el contrato público.
- Cliente A no ve ni toca pedidos, ítems, eventos ni perfil de B; nadie cambia
  el total ni el estado de un pedido escribiendo la tabla.
- Comercio A no lee, edita, borra ni lista nada privado de B (pedidos,
  contactos, reparto, equipo, archivos de Storage).
- Staff opera pedidos pero no edita catálogo, datos ni equipo; manager no
  gestiona equipo; nadie se autoaprueba ni se vuelve administración
  (`user_metadata` con `role: admin` no concede nada).
- Quitar a alguien del equipo le corta el acceso en el acto.
- Precio cambiado durante el checkout: el pedido **no** se crea (U0005).
- Mismo intento enviado seis veces en paralelo: un solo pedido. Última unidad
  en stock: la gana un solo pedido.
- Taxi apagado en la base, no sólo escondido en la interfaz.
- Compra sin cuenta apagable desde la base sin afectar a quien tiene cuenta.
- Realtime entrega a cada suscriptor sólo lo que RLS le deja leer.
- Reparto: la persona vinculada sólo ve y avanza los envíos que su comercio
  le asignó (`rider_orders`, `transition_order`); no lee la tabla de pedidos
  ni recibe sus cambios por Realtime; no marca "entregado" sin el código del
  cliente, que valida la base con 5 intentos por pedido; pausarla o
  desvincularla le corta el acceso en el acto; otro comercio no la puede
  vincular ni leer.
- Métricas del piloto: sólo administración (`42501` para el resto, también
  por la API); nunca incluyen nombre, teléfono, dirección ni nota del cliente.

### Auth verificado (stack local con SMTP real a Mailpit)

Registro con confirmación abierta en otro dispositivo, ingreso, clave
incorrecta, usuario inexistente (mismo mensaje), sesión que persiste al
recargar, refresco de token, cierre de sesión que se propaga a otras pestañas,
recuperación de contraseña con el enlace abierto en otro dispositivo, enlace
vencido y enlace ya usado, cambio de clave exigiendo la actual, usuario
suspendido (`banned`) que no puede ingresar, reenvío de confirmación.

## 2. Arquitectura de producción

```
Navegador (SPA estática, GitHub Pages, HTTPS)
  │  publishable key + JWT de la sesión (anónima o permanente)
  ▼
Supabase ygqbcvxdrewcnzedfcyo (sa-east-1)
  ├─ Auth (GoTrue): correo+contraseña con confirmación; sesiones anónimas para comprar
  ├─ PostgREST: sólo esquema public; lecturas por RLS; escrituras críticas por RPC
  ├─ Postgres: RLS en todas las tablas, funciones SECURITY DEFINER en `private`
  ├─ Realtime: pedidos del comercio / de la persona, filtrados por RLS
  └─ Storage: bucket business-media (5 MB, JPEG/PNG/WebP, escritura por comercio)
```

- **Configuración en tiempo de build.** `scripts/build-production.mjs` valida
  URL (https, `<ref>.supabase.co`) y clave (rechaza secret/service_role), y
  falla si el bundle contiene una credencial, código de la demostración o
  supera el presupuesto de tamaño. No hay variables que falten en tiempo de
  ejecución: si la configuración compilada no es la de producción, la app no
  arranca (`INVALID_PRODUCTION_CONFIG`).
- **Contrato de esquema.** Al arrancar, la app consulta `app_status`. Si el
  esquema remoto es anterior a `REQUIRED_SCHEMA` (`js/core/contract.js`),
  muestra "mantenimiento" en vez de fallar a medias. El deploy exige lo mismo
  antes de publicar.
- **Autoridad del servidor.** El navegador manda qué productos y cuántos; el
  servidor resuelve comercio, precios, envío, total, estado inicial y stock
  (`create_order`), con idempotencia durable y total confirmado. Los estados
  sólo cambian por `transition_order` según `private.order_transitions`, con
  control de versión, motivo obligatorio al rechazar/cancelar y historial con
  estado anterior.
- **Permisos.** owner: todo el comercio y el equipo · manager: operación,
  catálogo y datos · staff: pedidos y disponibilidad · reparto (cuenta vinculada por el comercio):
  sus envíos asignados · administración (tabla `private.platform_admins`):
  revisión de altas, suspensión, métricas del piloto y errores.
- **Service worker** versionado por build: después de un deploy, quien vuelve
  recibe la versión nueva; nunca cachea respuestas de Supabase ni URLs con
  parámetros (los enlaces de recuperación no quedan guardados).

## 3. Cómo se pasa a producción

### 3.1 Secretos (lo único manual)

GitHub → repositorio `bitflowapp/cauce` → **Settings → Secrets and variables →
Actions → New repository secret**. Nunca se pegan en un chat, un issue ni un
archivo del repositorio.

Cargados (cada run de operación verifica su presencia, nunca su valor; última
vez el 25/09): `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
`CAUCE_SMTP_HOST`, `CAUCE_SMTP_PORT`, `CAUCE_SMTP_USER`, `CAUCE_SMTP_PASS`,
`CAUCE_SMTP_SENDER`, `CAUCE_BACKUP_PASSPHRASE` y `CAUCE_ADMIN_EMAIL`.

| Secreto | Dónde se obtiene | Para |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | supabase.com → avatar → **Account preferences → Access Tokens → Generate new token** (nombre: `cauce-operacion`). Se muestra una sola vez. | B1, B2, B4, B5 y el smoke |
| `SUPABASE_DB_PASSWORD` (recomendado) | Dashboard del proyecto `ygqbcvxdrewcnzedfcyo` → **Project Settings → Database → Database password** (si no se conoce: *Reset database password*; la app no la usa). Sin ella la CLI pide una credencial temporal a la API. | B1, B5 |
| `CAUCE_SMTP_PASS` | resend.com → **Domains → Add domain** (un dominio propio; cargar en el DNS los registros SPF, DKIM y MX que muestra y esperar *Verified*) → **API Keys → Create API key** (permiso *Sending access*, ese dominio). Empieza con `re_`. | B2, B3 |
| `CAUCE_SMTP_SENDER` | Remitente del dominio verificado, por ejemplo `CAUCE Aluminé <hola@el-dominio>` | B2, B3 |
| `CAUCE_BACKUP_PASSPHRASE` | Frase larga (16+ caracteres) generada por quien opera y guardada también **fuera** de GitHub: sin ella no se pueden abrir las copias cifradas. | B5 |
| `CAUCE_ADMIN_EMAIL` | El correo de la persona que va a administrar CAUCE. Como secreto no queda en el repositorio; el paso `admin` lo usa si el pedido no trae `email`. | B4 |

Con otro proveedor SMTP se cargan además `CAUCE_SMTP_HOST`, `CAUCE_SMTP_PORT`
y `CAUCE_SMTP_USER`. Si se usa el ambiente `produccion` de GitHub con
revisores obligatorios, cada paso espera esa aprobación.

### 3.2 Pedidos de operación, en orden

Cada paso se pide con un commit que cambia `ops/solicitud.json` (ver
`ops/README.md`) o a mano desde **Actions → Operación de producción → Run
workflow**. Sin `"aplicar": true` y `"confirmar": "ygqbcvxdrewcnzedfcyo"`,
ningún paso escribe. La evidencia (sin secretos) queda como artefacto del run.

1. `estado` — qué hay hoy: proyecto, plan, migraciones, Auth, backups, smoke público.
2. `backup` — **antes de migrar**: backups de Supabase + restauración de prueba
   + copia cifrada (B5).
3. `migrar` — dry-run; después `aplicar` (ensaya sobre una copia de los datos y
   recién ahí migra) (B1).
4. `smoke-previo` con `aplicar` — el recorrido completo con el build de
   producción servido en el runner contra el proyecto real, antes de publicar.
5. `auth` con `aplicar` — URLs del sitio real, compra sin cuenta, SMTP (B2).
6. `correo` — confirmación, recuperación (el enlace anterior deja de valer) e
   invitación, con entrega real a un buzón externo (B3).
7. Commit `.github/deploy-target` → `production`, CI verde, integrar el PR:
   Pages exige el esquema y publica el build conectado (B6).
8. `admin` con `invitar` y `aplicar` (correo del secreto `CAUCE_ADMIN_EMAIL`)
   — la persona acepta la invitación en el sitio ya publicado y elige su
   contraseña; después `admin` con `aplicar` otorga el privilegio (B4). Si el
   enlace de la invitación venció, la persona usa "¿Olvidaste tu contraseña?"
   en `#cuenta` con ese correo: el enlace de recuperación confirma la cuenta y
   le deja elegir la contraseña.
9. `smoke-publicado` con `aplicar` — smoke obligatorio sobre el sitio publicado.
10. `limpiar-qa` con `aplicar` — confirma QA_USERS, QA_BUSINESSES, QA_ORDERS y
    QA_STORAGE en 0 (nunca toca otras cuentas).
11. `registros` — 5xx (falla el paso) y errores de cada servicio en las
    últimas 24 h.

Los smokes crean comercios y cuentas `CAUCE QA` en el proyecto real (y los
borran al terminar): por eso también exigen `aplicar` y `confirmar`.

Lo mismo desde una terminal: `SUPABASE_ACCESS_TOKEN=… node scripts/operacion.mjs <paso> [--aplicar]`
y `npm run smoke:publicado`.

### 3.3 Notas de la migración (B1)

- `db push` aplica **sólo migraciones**; nunca ejecutar `supabase config push`
  desde la raíz (el `supabase/config.toml` es del stack local). Los ajustes
  intencionales del proyecto remoto están en `supabase/remote/supabase/config.toml`.
- La migración es aditiva: agrega columnas con valores por defecto, tablas y
  funciones; reemplaza `create_order` (el frontend conectado nunca se
  publicó, así que no hay clientes con la firma vieja). Está probada sobre
  datos existentes en PGlite (`tests/db/upgrade.test.mjs`) y en Supabase real
  (`scripts/ensayo-migracion.mjs`), y el paso `migrar` la ensaya además sobre
  una copia de los datos de producción antes de aplicarla.
- Residuos de QA de corridas anteriores (cuentas `cauce-qa-<8 hex>-<rol>@example.com`):
  paso `limpiar-qa` (sin `aplicar` sólo lista; nunca toca otras cuentas).

### 3.4 Cuenta administradora a mano (alternativa a `admin`)

La persona crea su cuenta desde el sitio y confirma el correo. Después, en el
SQL editor del proyecto:

```sql
insert into private.platform_admins (user_id)
select id from auth.users where email = '<correo de la persona>' and email_confirmed_at is not null;
```

Nunca se concede administración por `user_metadata` ni desde la app.

### 3.5 Protección de `main`

Activa (verificado el 25/09). En GitHub → Settings → Branches: exigir pull
request y los tres checks de CI ("Lint, tipos, unitarias, SQL y builds",
"Integración, seguridad y E2E contra Supabase" y "Demostración y backend de
desarrollo") antes de integrar.

### 3.6 Publicar (B6)

Pasar a producción es un commit: `.github/deploy-target` con `production`.
La variable del repositorio `CAUCE_DEPLOY_TARGET`, si existe, tiene prioridad
(sirve para volver a `demo` sin commit). Al integrar a `main`, "Deploy CAUCE a
GitHub Pages" corre las compuertas, exige el esquema (`--predeploy`), construye
`dist-production/`, publica y verifica el sitio. Después, el paso
`smoke-publicado` hace el recorrido completo con navegadores reales.

### 3.7 Rollback

- **Frontend:** revertir el commit en `main` (se republica solo), o
  `.github/deploy-target` → `demo` (o la variable del repositorio
  `CAUCE_DEPLOY_TARGET=demo` y relanzar el workflow). El service worker versionado hace
  que las visitas tomen la versión publicada en la siguiente carga.
- **Base de datos:** las migraciones son hacia adelante. Si una migración
  futura sale mal, se corrige con otra migración. Restaurar un backup (§6)
  **pierde los pedidos creados después**: es el último recurso.
- **Interruptores sin deploy** (efecto inmediato):
  - Suspender un comercio: pantalla de administración → *Suspender*, con
    motivo (queda en el historial y el comercio no puede levantarla).
  - Cortar la compra sin cuenta, desde el SQL editor (quien tiene cuenta
    sigue comprando; a quien no, la app le pide ingresar y conserva el
    carrito). Probado en `tests/integration/security.test.mjs`:

    ```sql
    update private.platform_features set enabled = false where key = 'guest_checkout';
    ```

## 4. Primer comercio real

No se cargan comercios inventados en producción. El alta la hace el propio
comercio, con su cuenta, y la aprueba administración.

**Qué tiene que tener a mano el comercio:** nombre como lo conocen los
vecinos, dirección, rubro, teléfono o WhatsApp para clientes, responsable y
teléfono de contacto (privado, sólo lo ve administración), horarios por día,
si hace retiro y/o envío (zona, costo y pedido mínimo), tiempos estimados,
logo y portada (JPEG/PNG/WebP hasta 5 MB), y la lista de productos con precio
final en pesos, foto si tiene, y si controla stock o sólo marca "agotado".

1. **Cuenta.** La persona responsable se registra en el sitio y confirma el
   correo (requiere §3.2).
2. **Alta.** *Sumar mi comercio* → nombre comercial y rubro → *Crear
   borrador*. Queda en **borrador**, invisible al público.
3. **Datos.** Panel → *Datos*: dirección, contacto privado y para clientes
   (teléfono o WhatsApp), retiro/envío, zona, costo, mínimo, tiempos, logo y
   portada. Panel → *Horarios*: hasta dos rangos por día; un rango puede
   cruzar la medianoche (se interpreta en la hora de Aluminé).
4. **Catálogo.** Panel → *Catálogo*: categorías, productos, precios, variantes,
   fotos. "Controlar stock" sólo para lo que tiene existencias contables.
5. **Solicitar publicación.** El servidor verifica los requisitos y lista lo
   que falte.
6. **Revisión.** *Administración* → *Comercios pendientes*: aprobar o
   devolver con observaciones. Al aprobar aparece en el listado público.
7. **Equipo (opcional).** Panel → *Equipo*: sumar por correo a personas que ya
   tengan cuenta, como encargado (manager) o equipo (staff).
8. **Reparto (si hace envíos).** Panel → *Reparto*: sumar a cada persona que
   reparte (nombre y teléfono). Para que use la aplicación, la persona crea
   su cuenta en el sitio y confirma el correo; después el titular o el
   encargado toca *Vincular cuenta* con ese correo. Al ingresar, la persona
   va directo a *Mis entregas* (`#entregas`). Sin cuenta vinculada, el
   comercio marca cada paso del envío desde el panel, como siempre.
9. **Prueba de punta a punta** con personas reales del comercio: un pedido
   de retiro desde otro teléfono, sin cuenta; el panel suena y marca el
   título; aceptar → preparar → listo → entregado; un segundo pedido
   rechazado con motivo; un tercero con envío, asignado a la persona de
   reparto, que desde su teléfono lo retira, sale, llega y lo entrega con el
   código que le dicta el cliente. El cliente ve cada cambio y el enlace de
   seguimiento; el panel suma la venta al día.
10. **Operación diaria.** El panel abierto en un teléfono o computadora con
   sonido habilitado (tocar *Activar sonido de pedidos* una vez), sin modo
   ahorro de batería agresivo. Si Realtime se corta, el panel vuelve a
   consultar cada 30 segundos y lo indica. *Abrir atención* / *Cerrar
   atención* para dejar de recibir pedidos ante un imprevisto; fuera del
   horario cargado la app ya no deja confirmar.

## 5. Operación y monitoreo

- **Pantalla de administración** (`#admin`, detalle en
  [docs/ADMINISTRACION-PILOTO.md](docs/ADMINISTRACION-PILOTO.md)):
  - altas pendientes: aprobar o devolver con observaciones;
  - **Hoy en CAUCE**: comercios activos y abiertos ahora, pedidos de hoy
    (retiro · envío), completados, volumen bruto con el ticket promedio, en
    curso y errores de 24 h;
  - **Necesitan atención**: pedidos quietos demasiado tiempo, con "Llamar al
    comercio" y sin datos del cliente;
  - el día de cada comercio, con suspender y rehabilitar con motivo;
  - los últimos errores reportados por la app.
- **Errores de la app:** `private.client_events` guarda errores de interfaz,
  de Supabase, de sesión y pedidos fallidos, **sin** correos, teléfonos,
  tokens ni contraseñas (se limpian en el cliente y otra vez en la base).
  Como cualquiera con la clave pública puede reportar, la base pone techos:
  20 por minuto por sesión, 60 por minuto y 5.000 por día en total, con 30
  días de retención (la tabla no pasa de ~150.000 filas).
- **Registros:** paso `registros` (sólo lectura, sin correos ni IP en la
  salida): respuestas 5xx de la API, 4xx por ruta y errores de Postgres, Auth,
  Realtime y Storage de las últimas 24 h, con la última vez que se vio cada
  uno. Los rechazos de permisos y de transiciones son esperables (pruebas de
  seguridad, intentos ajenos); un 5xx hace fallar el paso.
- **Supabase dashboard:** logs de Auth, API y Postgres; Advisors de seguridad
  y rendimiento después de cada migración.
- **Smoke diario:** `.github/workflows/smoke.yml` corre el smoke de sólo
  lectura todos los días a las 08:00 de Aluminé cuando Pages publica
  producción (`.github/deploy-target` o la variable `CAUCE_DEPLOY_TARGET`);
  un fallo queda en rojo en Actions.
- **Después de cada publicación:** `smoke-publicado`, `limpiar-qa` y
  `registros`, en ese orden (§3.2).

## 6. Backups y restauración

- **Lo que ofrece Supabase, verificado por la API** (run 36078082544, 25/09):
  `BACKUP_AVAILABLE` PASS (4 backups completos, el último del 24/09 a las
  07:54 UTC), `BACKUP_FREQUENCY` diaria, `BACKUP_RETENTION` 7 días (plan
  Pro), sin PITR (es un complemento pago).
- **`RESTORE_TEST` PASS** sobre los datos reales (mismo run, 14/14): dump,
  copia cifrada, restauración en un stack nuevo con las migraciones que tenía
  el proyecto, conteos, esquema, migración pendiente aplicada sobre la copia
  y verificaciones de contrato, API, RLS y Storage.
- **Backup propio, semanal y automático** (workflow "Operación de
  producción", lunes 03:30 en Aluminé, una vez cargados los secretos): dump
  de esquema y datos **sin sesiones ni tokens**, restauración de prueba en un
  stack nuevo construido con las migraciones del repo (así vuelven también
  las políticas de Storage, que el dump de esquema no incluye), verificación
  de conteos, RLS, contrato, API y desvío de esquema, y copia cifrada con
  AES-256 (`CAUCE_BACKUP_PASSPHRASE`) guardada 30 días como artefacto.
- **Restaurar de verdad** (desastre): primero, el backup diario de Supabase
  (Dashboard → Database → Backups → Restore). Si no alcanza: descargar el
  artefacto `cauce-backup-<run>`, descifrar con `gpg --decrypt`, crear un
  proyecto nuevo, `supabase db push` con las migraciones del repo y cargar
  `data.sql` como `supabase_admin` (`psql -v ON_ERROR_STOP=1 -f data.sql`),
  igual que hace la prueba. El volcado no incluye MFA, SSO, OAuth, SCIM ni
  WebAuthn, que CAUCE no usa (si se habilitan, hay que sumarlos).
- **Storage no entra en los backups de la base.** Las imágenes de
  `business-media` se vuelven a subir desde el panel; si se quiere copia,
  descargarlas con la API de Storage.

## 7. Secretos

- En el repositorio sólo está la publishable key (`supabase/project.json`),
  pública por diseño: la seguridad la ponen RLS y las funciones del servidor.
- Revisión del historial completo (todas las ramas): ninguna secret key,
  service_role, token personal, contraseña ni clave SMTP versionada.
- CI no usa ningún secreto; el deploy tampoco.
- Secretos de operación (token de Supabase, contraseña de la base, API key
  SMTP): sólo en la terminal de quien opera, nunca en archivos del repo,
  issues ni capturas. Si alguno se expone: revocarlo en su proveedor y
  generar otro.
- Las claves que muestra `npx supabase status` son las de demostración del
  stack local, públicas y sin valor fuera de esa máquina.

## 8. Límites conocidos

- **Sin pagos en línea:** efectivo al retirar o al recibir.
- **Sin GPS ni mapa embebido; sin notificaciones push.** La dirección de un
  envío abre Google Maps con un enlace. El comercio necesita el panel abierto
  para enterarse al instante (sonido, título y respaldo cada 30 s).
- **Reparto propio de cada comercio:** quien reparte ve sus envíos
  consultando cada 15 s (no por Realtime); un pedido ya asignado no se
  reasigna a otra persona; después de 5 códigos incorrectos, el comercio
  cierra la entrega desde el panel; para un problema, la aplicación ofrece
  "Llamar al comercio". No hay reparto centralizado.
- **Administración:** los números son del día; no hay reportes históricos,
  exportaciones ni gráficos.
- **Facturación electrónica (ARCA): no implementada.** El contrato está listo
  ([docs/CONTRATO-FACTURACION-ARCA.md](docs/CONTRATO-FACTURACION-ARCA.md)) y
  la lógica no fiscal, probada; no se emite ni se simula ningún comprobante.
- **Una sola localidad (Aluminé).** La zona de envío es texto, no un polígono.
- **Taxi apagado** (esquema conservado, habilitable por feature flag).
- **Sesiones:** un JWT emitido sigue valiendo hasta una hora aunque se
  suspenda al usuario; las funciones que dan acceso a un comercio verifican la
  membresía en cada llamada, así que quitar a alguien del equipo corta su
  acceso en el acto. GoTrue tolera reusar el token de refresco padre
  inmediato y rechaza el abuelo (`refresh_token_already_used`) sin revocar la
  sesión activa.
- **Pedidos falsos:** la compra sin cuenta permite que alguien con mala fe
  mande pedidos que nunca retira. La base limita a 3 pedidos sin atender y 5
  cada 10 minutos por sesión, y 150 sesiones nuevas por hora por IP; no hay
  CAPTCHA. El comercio los rechaza con motivo y, si hay un ataque, la compra
  sin cuenta se apaga desde la base en el acto (§3.7).
- **Compra sin cuenta:** los pedidos quedan asociados a la sesión anónima del
  navegador; si la persona borra los datos del sitio, los sigue por el enlace
  de seguimiento (`#seguimiento/<token>`), que la app ofrece copiar y
  compartir. Tope de 150 sesiones anónimas por hora y por IP (redes móviles
  con IP compartida podrían acercarse en horas pico: ajustable con
  `CAUCE_ANONYMOUS_RATE_LIMIT`).
- **Realtime:** los cambios empiezan a llegar unos segundos después de abrir
  el panel; la app vuelve a consultar al confirmarse la suscripción para no
  perder nada de ese hueco.
- **GitHub Pages no permite cabeceras propias:** CSP va en `<meta>` y
  `frame-ancestors` no se puede declarar; hay una defensa anti-iframe en JS.
- **WebKit de Playwright no es Safari de un iPhone físico:** no hubo pruebas
  en dispositivos reales.
- **Imágenes:** el bucket es público por URL (contenido que el comercio
  publica); un reemplazo que no pudo borrar el archivo anterior deja un
  huérfano y se registra como `MEDIA_ORPHAN`.
- **Entregabilidad de correo:** depende del proveedor SMTP y del dominio
  (SPF/DKIM/DMARC). Verificar que no caiga en spam en Gmail y Outlook.
