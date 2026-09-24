# CAUCE · Preparación para producción

Última revisión: 24 de septiembre de 2026 · rama `claude/cauce-production-hardening-km1t5s`.

## Estado

**NOT_READY para operar con comercios y clientes reales.** El código, el
esquema y las pruebas están listos y verificados contra un stack Supabase
completo; lo que falta está **fuera del repositorio** y requiere credenciales
que este trabajo no tuvo (ni debía tener):

| # | Bloqueante | Estado real verificado | Quién lo resuelve |
| --- | --- | --- | --- |
| B1 | La migración `20260924120000_production_hardening` no está aplicada en el proyecto real. | `app_status` no existe en `ygqbcvxdrewcnzedfcyo` (`npm run smoke:production`). | Operador con `SUPABASE_ACCESS_TOKEN` y la contraseña de la base (§3.1). |
| B2 | Auth del proyecto real: sin SMTP propio, compra sin cuenta (anonymous sign-ins) deshabilitada y `site_url` apuntando al preview local. | `/auth/v1/settings`: `anonymous_users: false`; sin SMTP. | Operador con cuenta SMTP y dominio verificado (§3.2). |
| B3 | La recuperación de contraseña no está verificada de punta a punta **en producción**. | Verificada con correo real (Mailpit) en el stack local y en la E2E, no con una casilla real. | Operador, después de B2 (§3.3). |
| B4 | El sitio publicado sigue siendo la demostración. | `https://bitflowapp.github.io/cauce/` sirve `connect-src 'none'`. | Operador: variable `CAUCE_DEPLOY_TARGET=production` (§3.6), sólo después de B1–B3. |
| B5 | No existe ninguna cuenta administradora real. | Las pruebas crean una sintética en el stack local. | Operador (§3.4). |
| B6 | Backups del proyecto real sin verificar y sin simulacro de restauración. | No hubo acceso al dashboard desde este trabajo. | Operador, antes del primer pedido real (§6). |

Integrar esta rama a `main` **no publica el build conectado**: el workflow de
Pages vuelve a publicar la demostración (con este código, sin red) hasta que la
variable del repositorio diga lo contrario, y aun así se niega a publicar si el
esquema remoto no es compatible. Pasar a producción es una decisión explícita,
después de cerrar B1–B6.

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

## 3. Pasos del operador para pasar a producción

Hacerlos en este orden. Ningún paso requiere guardar un secreto en el
repositorio: los tokens se exportan en la terminal y se descartan.

### 3.1 Aplicar la migración (B1)

```bash
export SUPABASE_ACCESS_TOKEN=...            # token personal; no se guarda
npx supabase link --project-ref ygqbcvxdrewcnzedfcyo   # pide la contraseña de la base
npx supabase migration list                 # 20260924120000 debe figurar sólo en "Local"
npx supabase db push --dry-run              # revisar que sea sólo esa migración
npx supabase db push
node tests/production-smoke.mjs --predeploy # "esquema remoto compatible" en verde
```

- `db push` aplica **sólo migraciones**; nunca ejecutar `supabase config push`
  desde la raíz (el `supabase/config.toml` es del stack local). Los ajustes
  intencionales del proyecto remoto están en `supabase/remote/supabase/config.toml`.
- La migración es aditiva: agrega columnas con valores por defecto, tablas y
  funciones; reemplaza `create_order` (el frontend conectado nunca se
  publicó, así que no hay clientes con la firma vieja). Está probada **sobre datos existentes** (`tests/db/upgrade.test.mjs`):
  comercio publicado, pedidos en todos los estados, historial y stock se
  conservan, y los pedidos en curso siguen su ciclo con las reglas nuevas.
- Antes de aplicarla, verificar que haya un backup reciente (§6).
- Si el proyecto tiene residuos de QA de corridas anteriores (cuentas
  `cauce-qa-…@example.com`), se limpian antes de abrir al público con
  `node scripts/clean-qa-residue.mjs` (sin `--apply` sólo lista; requiere la
  CLI autenticada y nunca toca cuentas que no sigan ese patrón).

### 3.2 Configurar Auth y correo (B2)

Hace falta un proveedor SMTP con **dominio propio verificado** (SPF y DKIM);
sin dominio, los proveedores sólo entregan a la casilla de la propia cuenta.
Ejemplo con Resend (cualquier SMTP sirve):

```bash
export SUPABASE_ACCESS_TOKEN=...
export CAUCE_SITE_URL=https://bitflowapp.github.io/cauce
export CAUCE_SMTP_HOST=smtp.resend.com CAUCE_SMTP_PORT=465 CAUCE_SMTP_USER=resend
export CAUCE_SMTP_PASS=...                  # API key del proveedor; no se guarda
export CAUCE_SMTP_SENDER="CAUCE Aluminé <hola@dominio-verificado>"
node scripts/configure-auth.mjs             # muestra qué cambiaría, sin aplicar
node scripts/configure-auth.mjs --apply     # aplica y muestra el estado real
```

Aplica: plantillas en castellano con `token_hash` (el enlace funciona aunque se
abra en otro dispositivo), `site_url` y URLs permitidas sin comodines, compra
sin cuenta (anonymous sign-ins) con tope por IP de 150/h, confirmación de
correo obligatoria y SMTP con tope de 30 correos/h. El script nunca imprime la
contraseña ni el token. Verificar después: `npm run smoke:production` debe
mostrar "compra sin cuenta habilitada" en verde.

Además, en el dashboard de Supabase (Authentication → Attack Protection):
habilitar CAPTCHA para registro y sesiones anónimas si aparece abuso (requiere
agregar el widget en la app; hoy no está).

### 3.3 Verificar la recuperación de contraseña real (B3)

Con una casilla real (no del equipo de Supabase), desde un teléfono:

1. Registrarse en el sitio → llega el correo de confirmación (revisar spam y
   remitente) → abrir el enlace **en el teléfono**, no en la computadora →
   la cuenta queda confirmada.
2. Cerrar sesión → "¿Olvidaste tu contraseña?" → llega el correo → el enlace
   abre `#recuperar` → nueva contraseña → ingresar con ella.
3. Abrir el mismo enlace otra vez → la app dice que venció o ya se usó.
4. Ingresar con la contraseña vieja → rechazado.

Hasta completar esto, `PASSWORD_RESET` no está verificado en producción.

### 3.4 Cuenta administradora (B5)

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

1. GitHub → Settings → Secrets and variables → Actions → **Variables**:
   `CAUCE_DEPLOY_TARGET = production` (y `CAUCE_SITE_URL` si cambia el dominio).
   No hace falta ningún secreto: el build sólo usa la publishable key.
2. Actions → "Deploy CAUCE a GitHub Pages" → Run workflow sobre `main`.
   El workflow corre las compuertas, exige esquema compatible
   (`--predeploy`), construye `dist-production/`, publica y corre el smoke
   contra el sitio publicado.
3. `npm run smoke:production` en una terminal: 5 de 5 en verde.

### 3.7 Rollback

- **Frontend:** revertir el commit en `main` (se republica solo) o volver la
  variable a `demo` y relanzar el workflow. El service worker versionado hace
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

## 6. Backups y restauración (estado real)

- **No verificado desde este trabajo** (no hubo acceso al dashboard). Según
  la documentación de Supabase, el plan Pro (el de la organización) incluye
  backups diarios con 7 días de retención; PITR es un complemento pago cuya
  activación no está confirmada.
- **Qué hacer antes de abrir:** en Database → Backups, confirmar que existan
  backups diarios recientes; hacer **un simulacro de restauración** a un
  proyecto nuevo y correr `node tests/production-smoke.mjs --predeploy`
  contra él (`CAUCE_SUPABASE_URL`, `CAUCE_SUPABASE_PUBLISHABLE_KEY`).
- **Copia lógica propia (recomendado semanal):**

  ```bash
  npx supabase db dump --linked -f cauce-schema.sql
  npx supabase db dump --linked --data-only -f cauce-data.sql
  ```

  Guardarla fuera del repositorio y cifrada: contiene datos personales.
- **Storage no entra en los backups de la base.** Las imágenes de
  `business-media` se pueden volver a subir desde el panel; si se quiere
  copia, descargarlas con la API de Storage.

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
