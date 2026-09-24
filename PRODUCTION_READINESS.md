# CAUCE · Preparación para producción

Última revisión: 24 de septiembre de 2026 · rama `claude/cauce-production-hardening-km1t5s`.

## Estado

**NOT_READY.** El código, el esquema y las pruebas están listos (CI verde en
el PR #3). Cada paso sobre el proyecto real quedó **automatizado y ensayado**
contra Supabase local; lo único que falta para ejecutarlos es que existan los
secretos, que este entorno no tiene ni puede crear:

| # | Gate | Qué ejecuta la operación | Ensayo | Falta |
| --- | --- | --- | --- | --- |
| B1 | Migración `20260924120000` en el proyecto real | `migrar`: historial, dry-run (sólo esa migración o STOP), **ensayo sobre una copia de los datos reales**, push, sincronización y smoke | `scripts/ensayo-migracion.mjs` sobre un Supabase con sólo las 8 migraciones de producción y datos de esa versión: PASS | `SUPABASE_ACCESS_TOKEN` |
| B2 | Auth real | `auth`: `site_url`/retornos del sitio real sin localhost, compra sin cuenta, confirmación obligatoria, SMTP, plantillas, verificación | — (configura el proyecto real) | `SUPABASE_ACCESS_TOKEN` + SMTP |
| B3 | SMTP, confirmación y recuperación reales | `correo`: alta → correo real → enlace en otro dispositivo → ingreso; recuperación → correo real → contraseña nueva → la vieja rechazada → enlace no reutilizable; borra la cuenta | Stack local con Mailpit: 15/15 | SMTP con dominio verificado |
| B4 | Deploy de producción | commit de `.github/deploy-target` = `production` + integrar el PR; Pages exige el esquema antes de publicar | — | B1–B3 |
| B5 | Administración real | `admin`: invitación por correo (la persona elige su contraseña; sin contraseñas temporales) y privilegio en `private.platform_admins` | local: existente, invitación y correo malicioso rechazado | correo de la persona + B3 |
| B6 | Backup y restauración | `backup`: backups de Supabase (API), dump sin sesiones ni tokens, restauración en un stack nuevo con las migraciones, conteos, RLS, contrato, API, desvío de esquema, copia cifrada AES-256; semanal | local: 12/12 | `SUPABASE_ACCESS_TOKEN` + `CAUCE_BACKUP_PASSPHRASE` |
| — | Smoke post-deploy | `smoke-publicado`: comercios CAUCE QA, compra sin cuenta y con cuenta, retiro y envío, titular/encargado/equipo, seguridad, 320–1440 px, Chromium y WebKit; borra los datos QA | local: ver §1 | B4 |

Estado real del proyecto (24/09/2026, smoke de sólo lectura y workflow de
operación): sin `app_status` (migración pendiente), compra sin cuenta
deshabilitada, sitio publicado = demostración, y **ningún secreto cargado en
GitHub** (`✘` en los cinco).

Integrar esta rama a `main` **no publica el build conectado** mientras
`.github/deploy-target` diga `demo`: Pages vuelve a publicar la demostración
(con este código, sin red). Y aun con `production`, se niega a publicar si el
esquema remoto no es compatible.

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
| Unitarias | `npm test` | dominio, horarios, telemetría, repositorio, service worker | 190/190 |
| SQL embebido | `npm run test:db` | migraciones desde cero + actualización con datos legados, RLS por rol, techos del registro de errores | 52/52 |
| Integración y seguridad | `npm run test:integration` | Postgres + GoTrue + PostgREST + Storage + Realtime + Mailpit reales | 45/45 |
| E2E Chromium y WebKit | `npm run e2e:local` | recorridos en navegadores reales contra el build de producción | 27/27 |
| Builds | `npm run build`, `build:offline`, `build:production` | demo, demo sin red, producción con chequeo de bundle | PASS |
| Smoke de producción | `npm run smoke:production` | sólo lectura contra el proyecto y el sitio reales | 2/5 (B1, B2, B4) |

`npm run verify` agrupa lint, tipos, compuertas, unitarias, SQL y builds.

Ensayos de la operación del proyecto real (no corren en CI: levantan stacks
Supabase temporales y tardan varios minutos):

| Ensayo | Comando | Resultado |
| --- | --- | --- |
| B1 de punta a punta sobre Supabase real con sólo las 8 migraciones de producción y datos de esa versión | `node scripts/ensayo-migracion.mjs` | PASS: migró con el mismo comando que en producción, filas intactas, contrato publicado por la API, pedidos en curso operables |
| Paso `migrar`: al día, pendiente exacta y divergencia simulada | `node scripts/operacion.mjs migrar --local` | PASS · PASS · STOP como corresponde |
| Paso `correo` (confirmación y recuperación) | `node scripts/operacion.mjs correo --local` | 15/15 |
| Paso `admin` (existente, invitación, correo malicioso) | `node scripts/operacion.mjs admin --local …` | PASS · PASS · rechazado |
| Paso `backup` con restauración | `CAUCE_BACKUP_PASSPHRASE=… node scripts/operacion.mjs backup --local` | 12/12, esquema idéntico a las migraciones |
| Smoke post-deploy | `CAUCE_SMOKE_LOCAL=1 npm run smoke:publicado` | ver abajo |

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
  catálogo y datos · staff: pedidos y disponibilidad · administración (tabla
  `private.platform_admins`): revisión de altas, suspensión, errores.
- **Service worker** versionado por build: después de un deploy, quien vuelve
  recibe la versión nueva; nunca cachea respuestas de Supabase ni URLs con
  parámetros (los enlaces de recuperación no quedan guardados).

## 3. Cómo se pasa a producción

### 3.1 Secretos (lo único manual)

GitHub → repositorio `bitflowapp/cauce` → **Settings → Secrets and variables →
Actions → New repository secret**. Nunca se pegan en un chat, un issue ni un
archivo del repositorio.

| Secreto | Dónde se obtiene | Para |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | supabase.com → avatar → **Account preferences → Access Tokens → Generate new token** (nombre: `cauce-operacion`). Se muestra una sola vez. | B1, B2, B5, B6 y el smoke |
| `SUPABASE_DB_PASSWORD` (recomendado) | Dashboard del proyecto `ygqbcvxdrewcnzedfcyo` → **Project Settings → Database → Database password** (si no se conoce: *Reset database password*; la app no la usa). Sin ella la CLI pide una credencial temporal a la API. | B1, B6 |
| `CAUCE_SMTP_PASS` | resend.com → **Domains → Add domain** (un dominio propio; cargar en el DNS los registros SPF, DKIM y MX que muestra y esperar *Verified*) → **API Keys → Create API key** (permiso *Sending access*, ese dominio). Empieza con `re_`. | B2, B3 |
| `CAUCE_SMTP_SENDER` | Remitente del dominio verificado, por ejemplo `CAUCE Aluminé <hola@el-dominio>` | B2, B3 |
| `CAUCE_BACKUP_PASSPHRASE` | Frase larga (16+ caracteres) generada por quien opera y guardada también **fuera** de GitHub: sin ella no se pueden abrir las copias cifradas. | B6 |

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
   + copia cifrada (B6).
3. `migrar` — dry-run; después `aplicar` (ensaya sobre una copia de los datos y
   recién ahí migra) (B1).
4. `auth` con `aplicar` — URLs del sitio real, compra sin cuenta, SMTP (B2).
5. `correo` — confirmación y recuperación con entrega real (B3).
6. `admin` con `email`, `invitar` y `aplicar` — la persona acepta la invitación
   y elige su contraseña; después `admin` con `aplicar` otorga el privilegio (B5).
7. Commit `.github/deploy-target` → `production`, CI verde, integrar el PR:
   Pages exige el esquema y publica el build conectado (B4).
8. `smoke-publicado` — smoke obligatorio sobre el sitio publicado.

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
- Residuos de QA de corridas anteriores (cuentas `cauce-qa-…@example.com`):
  `node scripts/clean-qa-residue.mjs` (sin `--apply` sólo lista).

### 3.4 Cuenta administradora a mano (alternativa a `admin`)

La persona crea su cuenta desde el sitio y confirma el correo. Después, en el
SQL editor del proyecto:

```sql
insert into private.platform_admins (user_id)
select id from auth.users where email = '<correo de la persona>' and email_confirmed_at is not null;
```

Nunca se concede administración por `user_metadata` ni desde la app.

### 3.5 Protección de `main`

En GitHub → Settings → Branches: exigir pull request y los tres checks de CI
("Lint, tipos, unitarias, SQL y builds", "Integración, seguridad y E2E contra
Supabase" y "Demostración y backend de desarrollo") antes de integrar.

### 3.6 Publicar (B4)

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
8. **Prueba de punta a punta** con una persona real del comercio: un pedido
   de retiro desde otro teléfono, sin cuenta; el panel suena y marca el
   título; aceptar → preparar → listo → entregado; un segundo pedido
   rechazado con motivo. El cliente ve cada cambio y el enlace de
   seguimiento.
9. **Operación diaria.** El panel abierto en un teléfono o computadora con
   sonido habilitado (tocar *Activar sonido de pedidos* una vez), sin modo
   ahorro de batería agresivo. Si Realtime se corta, el panel vuelve a
   consultar cada 30 segundos y lo indica. *Abrir atención* / *Cerrar
   atención* para dejar de recibir pedidos ante un imprevisto; fuera del
   horario cargado la app ya no deja confirmar.

## 5. Operación y monitoreo

- **Pantalla de administración:** altas pendientes, suspender/rehabilitar con
  motivo, totales y los últimos errores reportados por la app.
- **Errores de la app:** `private.client_events` guarda errores de interfaz,
  de Supabase, de sesión y pedidos fallidos, **sin** correos, teléfonos,
  tokens ni contraseñas (se limpian en el cliente y otra vez en la base).
  Como cualquiera con la clave pública puede reportar, la base pone techos:
  20 por minuto por sesión, 60 por minuto y 5.000 por día en total, con 30
  días de retención (la tabla no pasa de ~150.000 filas).
- **Supabase dashboard:** logs de Auth, API y Postgres; Advisors de seguridad
  y rendimiento después de cada migración.
- **Smoke diario:** `.github/workflows/smoke.yml` corre el smoke de sólo
  lectura todos los días cuando `CAUCE_DEPLOY_TARGET=production`; un fallo
  queda en rojo en Actions.

## 6. Backups y restauración

- **Lo que ofrece Supabase no está verificado todavía**: el paso `backup`
  lo consulta por la API (backups completos, último, PITR y plan) y lo
  informa como `BACKUP_AVAILABLE`, `BACKUP_FREQUENCY` y `BACKUP_RETENTION`.
  Según la documentación de Supabase, el plan Pro incluye backups diarios con
  7 días de retención; PITR es un complemento pago.
- **Backup propio, semanal y automático** (workflow "Operación de
  producción", lunes 03:30 en Aluminé, una vez cargados los secretos): dump
  de esquema y datos **sin sesiones ni tokens**, restauración de prueba en un
  stack nuevo construido con las migraciones del repo (así vuelven también
  las políticas de Storage, que el dump de esquema no incluye), verificación
  de conteos, RLS, contrato, API y desvío de esquema, y copia cifrada con
  AES-256 (`CAUCE_BACKUP_PASSPHRASE`) guardada 30 días como artefacto.
- **Restaurar de verdad** (desastre): descargar el artefacto, descifrar con
  `gpg --decrypt`, crear un proyecto nuevo, `supabase db push` con las
  migraciones del repo y cargar `data.sql` como `supabase_admin`
  (`psql -v ON_ERROR_STOP=1 -f data.sql`), igual que hace la prueba.
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
- **Sin GPS ni mapas; sin notificaciones push.** El comercio necesita el panel
  abierto para enterarse al instante (sonido, título y respaldo cada 30 s).
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
