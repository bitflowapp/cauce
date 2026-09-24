# Auditoría de producción — CAUCE · Aluminé

Fecha: 24 de septiembre de 2026. Base auditada: `feat/cauce-production-foundation`
(`b0de664`), que contiene todo el trabajo conectado a Supabase y está 15 commits
por delante de `main` sin integrar. `main` (`ab57bdb`) y el sitio publicado
(`https://bitflowapp.github.io/cauce/`) siguen siendo la demostración con
`localStorage`.

Esta auditoría se hizo **antes** de modificar código. Cada hallazgo indica cómo
se verificó: lectura de código, consulta al proyecto real con la publishable
key, o ejecución contra un stack Supabase local completo (Postgres 17, GoTrue,
PostgREST, Storage, Realtime y Mailpit levantados con la CLI 2.117.0).

## Mapa del sistema

| Pieza | Estado real |
| --- | --- |
| Frontend | JS vanilla, enrutador por hash, `js/app.js` (2.657 líneas). Tres repositorios con la misma interfaz: `local` (demo, `localStorage`), `http` (backend SQLite de desarrollo) y `supabase`. |
| Build demo | `npm run build` → `dist/`, publicado en GitHub Pages desde `main`. `connect-src 'none'`. |
| Build conectado | `npm run build:supabase` → `.local/supabase-preview/`. Nunca se publicó. Proyecto fijado en código. Bundle de 1,07 MB sin minificar. |
| Supabase | Proyecto `ygqbcvxdrewcnzedfcyo` (sa-east-1). 8 migraciones aplicadas. 0 comercios publicados. `anonymous_users: false`, confirmación de correo obligatoria, sin SMTP propio. |
| Auth | Email + contraseña, PKCE, refresh rotativo, HIBP activo, mínimo 10 caracteres con letras y números. |
| Autorización | RLS en todas las tablas, grants por columna, escrituras críticas sólo por funciones `SECURITY DEFINER` en `private` con envoltorio `SECURITY INVOKER` en `public`. Admin en `private.platform_admins`. |
| Pedidos | `create_order` con precio de servidor, idempotencia durable `(customer, business, key)`, bloqueo de fila para stock, máquina de estados en `private.order_transitions`, control de versión. |
| Storage | Bucket público `business-media`, 5 MB, JPEG/PNG/WebP, escritura acotada a `businesses/{id}/…` por miembros owner/manager. |
| Realtime | `orders`, `order_events`, `trips`, `trip_events` en la publicación; la app vuelve a consultar por RLS en cada evento. |
| Service worker | Caché `cauce-shell-v3`, cache-first para estáticos, ignora otros orígenes y URLs con consulta. |
| CI | `ci.yml` en ramas (check, unit, SQL en PGlite, builds, E2E con Chrome del runner). `pages.yml` publica la demo desde `main`. Ninguna prueba corre contra Supabase real ni contra un stack Supabase completo. |
| Pruebas | 176 unitarias, 38 SQL en PGlite (pasan). Las suites "reales" requieren la CLI autenticada de una máquina puntual. |
| Secretos | Historial completo revisado: sólo la publishable key (pública por diseño). Ninguna secret/service key, token ni contraseña real versionada. |

## Hallazgos

P0 bloquea producción · P1 riesgo alto · P2 importante · P3 mejora.

### P0

| ID | Hallazgo | Verificación |
| --- | --- | --- |
| P0-01 | La versión conectada no está integrada ni desplegada. Lo publicado es la demo con datos ficticios. | `git`, sitio publicado |
| P0-02 | Sin SMTP propio: la confirmación de cuentas y la recuperación de contraseña no llegan a vecinos (el correo interno de Supabase sólo entrega al equipo, 2/h). | `/auth/v1/settings`, docs del proyecto |
| P0-03 | El checkout exige cuenta confirmada por correo. Con P0-02 ningún cliente real puede comprar. La interfaz además afirma que "comprar no requiere cuenta". | `cart.prepareRequest` → `requireUser`; `viewAccount` |
| P0-04 | El enlace de recuperación navega a `#recuperar`, ruta inexistente: la persona ve "Página no encontrada". | `VIEWS` no la declara |
| P0-05 | El redirect de Auth es `location.origin + '/index.html'`. En GitHub Pages la app vive en `/cauce/`, así que confirmación y recuperación vuelven a una URL que no existe. | `build-supabase.mjs` |
| P0-06 | El service worker sirve JS/CSS cache-first con un nombre de caché fijo: después de un deploy, quien ya visitó queda con el JS anterior sin límite de tiempo, desfasado del esquema. | `service-worker.js` |
| P0-07 | Las plantillas de correo usan `{{ .ConfirmationURL }}` con flujo PKCE: el enlace sólo funciona en el mismo navegador que lo pidió (abrirlo desde la app de correo falla). | `configure-auth.mjs`, `flowType: 'pkce'` |

### P1

| ID | Hallazgo |
| --- | --- |
| P1-01 | Precio modificado durante el checkout: el servidor recalcula (bien) pero no compara con el total que la persona vio. Se crea el pedido por otro importe sin aviso. |
| P1-02 | Cancelar pedido (cliente): tocar "Cancelar" en el `prompt` igual cancela el pedido (`prompt() ?? ''`). |
| P1-03 | Panel del comercio sin aviso de pedido nuevo (sonido/visual) y sin refresco de respaldo si Realtime se desconecta (teléfono bloqueado, red móvil). El panel puede quedar viejo sin que se note. |
| P1-04 | Stock obligatorio en todos los productos (default 0 en base). Para gastronomía no existe "sin control de stock": un producto sin stock cargado no se vende. |
| P1-05 | No hay gestión de equipo: owner no puede sumar manager/staff. "Varios usuarios por comercio" sólo con SQL manual. |
| P1-06 | La vertical taxi está expuesta en el build conectado (inicio, barra, pie, manifest) sin conductores, sin convenio y fuera del alcance de la primera etapa. Las RPC de taxi son invocables. |
| P1-07 | Copy de demostración en el build conectado: "contenido ficticio de demostración", "tus pedidos quedan asociados a este dispositivo", "comprar y pedir un taxi no requiere cuenta". |
| P1-08 | El bundle de producción incluye el repositorio de demo, el backend HTTP de desarrollo y los datos ficticios; pesa 1,07 MB sin minificar. |
| P1-09 | Errores técnicos crudos al usuario: `errorView`, `withBusy` y el arranque muestran `error.message` de excepciones no controladas. |
| P1-10 | Sin observabilidad: errores de frontend, de Supabase y pedidos fallidos no quedan registrados en ningún lado. |
| P1-11 | Un pedido con envío que falla después de "retirado" no se puede cerrar: la máquina de estados no permite cancelar desde `picked_up`, `on_the_way` ni `arrived`. |
| P1-12 | El historial de estados guarda `from_status = null` en todas las transiciones posteriores a la creación. |
| P1-13 | La cancelación por el comercio no exige motivo en el servidor (sólo en la interfaz). |
| P1-14 | `U0002` (mismo intento con otros datos) deja el carrito trabado: el identificador de intento nunca se renueva. |
| P1-15 | Staff ve formularios que el servidor le rechaza (catálogo, datos, abrir/cerrar): errores en plena operación. |
| P1-16 | No hay comprobación de compatibilidad frontend/esquema: publicar la app antes que las migraciones rompe de forma confusa. |
| P1-17 | Las pruebas de integración y seguridad dependen de una CLI autenticada en una máquina; CI no puede ejecutarlas y no hay stack Supabase completo en CI. |

### P2

| ID | Hallazgo |
| --- | --- |
| P2-01 | Búsqueda N+1: una consulta de productos por cada comercio al buscar. |
| P2-02 | El panel descarga el historial completo de pedidos en cada refresco. |
| P2-03 | Cada render de ruta protegida revalida sesión con ~5 requests (incluye `getUser` de red). |
| P2-04 | Horarios sólo como texto libre; abierto/cerrado manual sin horario estructurado. |
| P2-05 | Sin teléfono/WhatsApp público del comercio ni tiempos estimados. |
| P2-06 | Administración no puede suspender un comercio publicado. |
| P2-07 | GitHub Pages no permite `frame-ancestors`: panel expuesto a clickjacking sin defensa. |
| P2-08 | Metadatos: sin OpenGraph, canonical ni robots; la descripción promete taxis. |
| P2-09 | `prompt()`/`confirm()` nativos para motivos de rechazo/cancelación. |
| P2-10 | Sin límite de pedidos abiertos por cliente (abuso: bloquear stock con pedidos falsos). |
| P2-11 | Reconectar la red no refresca los datos en el entorno conectado. |
| P2-12 | Archivos huérfanos en Storage si un producto se borra físicamente. |
| P2-13 | Backups, restauración y retención no documentados. |

### P3

| ID | Hallazgo |
| --- | --- |
| P3-01 | "Tu cuenta" muestra roles internos (`customer, merchant`). |
| P3-02 | El HTML estático dice "Demostración" y "comercios ficticios" hasta que corre el JS. |
| P3-03 | Tras ingresar, un comercio va a "Mi actividad" en lugar de su panel. |

## Lo que está bien y se conserva

- Modelo de autorización: RLS en todas las tablas, grants por columna, funciones
  privilegiadas fuera del esquema expuesto, admin en tabla privada.
- Dinero en enteros, total = subtotal + envío por `check`, snapshot de líneas.
- Idempotencia durable y bloqueo de stock en la base.
- Aislamiento por comercio con claves compuestas `(id, business_id)`.
- Realtime que re-consulta por RLS en lugar de pintar la carga útil.
- El service worker no cachea nada con credenciales ni de otro origen.

## Decisiones que surgen de la auditoría

1. **Compra sin cuenta con sesión anónima de Supabase.** Resuelve P0-03 sin
   depender de SMTP: la persona compra con una sesión anónima real (JWT,
   `auth.uid()`, RLS intactos), limitada por la base a pedir, ver y cancelar sus
   propios pedidos. Las operaciones de comercio, perfil y equipo exigen una
   cuenta permanente, verificado en SQL con el claim `is_anonymous`.
2. **Taxi fuera de la primera etapa**, apagado en la base (feature flag) y en la
   interfaz, sin borrar el esquema: se habilita después sin romper el core.
3. **Stack Supabase local en pruebas y CI** para integración, seguridad y E2E
   sin mocks ni credenciales de producción.
4. **GitHub Pages se mantiene** (ver `PRODUCTION_READINESS.md`): sirve una SPA
   estática con hash routing sobre HTTPS; sus límites (sin cabeceras propias) se
   mitigan en el documento y no justifican migrar.

## Resolución (estado al cierre del hardening)

**Resuelto** = corregido en el código y cubierto por una prueba automática.
**Operación** = el código está listo, pero depende de un paso sobre el
proyecto real que requiere credenciales (ver `PRODUCTION_READINESS.md`).
**Mitigado** = el riesgo se redujo; queda un límite documentado.

### P0

| ID | Estado | Cómo / dónde se prueba |
| --- | --- | --- |
| P0-01 | **Operación** | PR contra `main`; el deploy de producción queda detrás de `CAUCE_DEPLOY_TARGET` y exige el esquema remoto. Falta aplicar la migración y publicar. |
| P0-02 | **Operación** | `scripts/configure-auth.mjs` aplica SMTP, plantillas y URLs; faltan una cuenta SMTP y un dominio verificado. |
| P0-03 | Resuelto en código · **Operación** para habilitarlo | Compra con sesión anónima real (`tests/integration/security.test.mjs`, E2E `flows`). En el proyecto real, anonymous sign-ins sigue deshabilitado hasta correr `configure-auth.mjs --apply`. |
| P0-04 | Resuelto | Vista `#recuperar`; E2E `auth` (recuperación con el enlace abierto en otro dispositivo, enlace reusado). |
| P0-05 | Resuelto | El redirect sale de `CAUCE_SITE_URL` (con `/cauce/`); `site_url` por defecto en `configure-auth.mjs` y `supabase/remote`. |
| P0-06 | Resuelto (build de producción) | Documento network-first, JS/CSS con nombre por contenido, caché con nombre por build, `skipWaiting` + `clients.claim` y borrado de cachés viejas. |
| P0-07 | Resuelto | Plantillas `token_hash`; confirmación y recuperación abiertas desde otro navegador en integración y E2E. |

### P1

| ID | Estado | Cómo / dónde se prueba |
| --- | --- | --- |
| P1-01 | Resuelto | `expected_total` → U0005 sin crear pedido; E2E `edge` muestra el total nuevo. |
| P1-02 | Resuelto | Diálogo accesible; "Volver" nunca cancela (E2E `edge`). |
| P1-03 | Resuelto | Sonido, vibración, título y distintivo de pedidos nuevos; sondeo de 30 s si Realtime cae; refresco al confirmarse la suscripción (ver N-01). |
| P1-04 | Resuelto | `products.track_stock` opcional; los productos existentes siguen controlando stock (`tests/db/upgrade.test.mjs`). |
| P1-05 | Resuelto | Equipo owner/manager/staff por la interfaz; quitar a alguien corta el acceso en el acto (integración). |
| P1-06 | Resuelto | Taxi apagado en la base (`Feature disabled`) y fuera del build. |
| P1-07 | Resuelto | Copy del build conectado sin textos de demostración (`npm run check`). |
| P1-08 | Resuelto | Bundle de producción sin demo ni backend de desarrollo, minificado: 465 KB (126 KB gzip), con presupuesto en el build. |
| P1-09 | Resuelto | Mensajes en castellano por código; el detalle técnico sólo va a la telemetría. |
| P1-10 | Resuelto | `private.client_events` sin datos personales, con tope y retención de 30 días; visible para administración. |
| P1-11 | Resuelto | Cancelación con motivo desde `picked_up`, `on_the_way` y `arrived` (integración, PGlite, actualización). |
| P1-12 | Resuelto | `from_status` en cada transición y reconstruido para el historial existente (`upgrade.test.mjs`). |
| P1-13 | Resuelto | `Reason required` en el servidor. |
| P1-14 | Resuelto | U0002 muestra el pedido existente o renueva el intento. |
| P1-15 | Resuelto | Panel según rol; E2E "staff no administra". |
| P1-16 | Resuelto | `app_status` + `REQUIRED_SCHEMA`: la app muestra mantenimiento y el deploy no publica sin esquema compatible. |
| P1-17 | Resuelto | Stack Supabase completo y efímero en CI; sin credenciales de producción. |

### P2 y P3

| ID | Estado |
| --- | --- |
| P2-01 | Resuelto: una sola consulta de búsqueda. |
| P2-02 | Resuelto: el panel trae pedidos abiertos y de las últimas 36 h (tope 150). |
| P2-03 | Resuelto: sesión en caché 15 s; verificación por red al arrancar y ante eventos de Auth. |
| P2-04 | Resuelto: horarios por día en la zona horaria de la localidad, incluso cruzando medianoche. |
| P2-05 | Resuelto: teléfono y WhatsApp públicos, tiempos de preparación y envío. |
| P2-06 | Resuelto: suspender/rehabilitar con motivo; el comercio no la levanta. |
| P2-07 | **Mitigado**: defensa anti-iframe en JS; Pages no permite `frame-ancestors`. |
| P2-08 | Resuelto: OpenGraph, canonical, `robots.txt`, `noindex` en rutas privadas. |
| P2-09 | Resuelto: diálogo propio para motivos y confirmaciones destructivas. |
| P2-10 | Resuelto: U0006 (pocos pedidos sin atender y ritmo humano por persona). |
| P2-11 | Resuelto: al volver la conexión o la pestaña, se vuelve a consultar. |
| P2-12 | **Mitigado**: los productos se archivan, no se borran; un reemplazo borra el archivo anterior y, si falla, queda registrado (`MEDIA_ORPHAN`). No hay limpieza periódica. |
| P2-13 | **Operación**: procedimiento documentado; backups del proyecto real no verificados desde este trabajo. |
| P3-01 | Resuelto: roles en castellano. |
| P3-02 | Resuelto: el HTML de producción no menciona la demostración. |
| P3-03 | Resuelto: al ingresar, comercio va al panel y administración a su pantalla. |

### Hallazgos nuevos durante el hardening

| ID | Nivel | Hallazgo | Estado |
| --- | --- | --- | --- |
| N-01 | P1 | Realtime confirma `SUBSCRIBED` antes de que fluyan los cambios de Postgres (~3 s, y otra vez tras cada reconexión): un pedido creado en ese hueco no aparecía hasta el sondeo. | Resuelto: se vuelve a consultar al confirmarse la suscripción (`tests/supabase-watch.test.mjs`, `tests/integration/realtime.test.mjs`). |
| N-02 | P1 | El panel en una pestaña en segundo plano no refrescaba: el aviso de pedido nuevo no sonaba. | Resuelto (E2E `flows`). |
| N-03 | P1 | Sin `CAUCE_SITE_URL`, `configure-auth.mjs` dejaba `site_url` en el preview local: los correos llevarían a una URL inexistente. | Resuelto: por defecto, la URL de producción. |
| N-04 | P2 | Al volver la conexión se reactivaban botones deshabilitados por otros motivos (confirmar con un producto agotado). | Resuelto (E2E `edge`). |
| N-05 | P2 | "En camino" no ofrecía "Marcar entregado" aunque la base lo permite. | Resuelto (E2E `flows`). |
| N-06 | P2 | `main` sin margen lateral en todos los anchos (regla de safe-area), pestañas del panel y campos de hora fuera de pantalla a 320–375 px, texto del inicio con contraste bajo. | Resuelto (E2E `audit`, 7 anchos). |
| N-07 | P2 | El interruptor de compra sin cuenta, apagado desde la base, mostraba un error genérico, y al ingresar la persona terminaba en *Mis pedidos* en vez de su carrito. | Resuelto: pide ingresar, conserva el carrito y vuelve a él (integración y E2E `edge`). |
| N-08 | P3 | El alta de taxi no recortaba origen, destino ni nota a su largo máximo. | Resuelto (prueba de regresión). |
| N-09 | P2 | `overflow-x: hidden` en body anulaba todo `sticky`: en el teléfono, "Ver carrito" quedaba bajo el borde de la pantalla (se llegaba sólo por la barra inferior). Venía de `main`. | Resuelto: `overflow-x: clip`; E2E mide la barra sobre la navegación. |
| N-10 | P2 | En escritorio el aviso inferior capturaba los clics durante 5 s. | Resuelto (E2E con `elementFromPoint`, verificada contra el código anterior). |
| N-11 | P2 | `report_client_event` (abierto a la clave pública) permitía hasta ~13 M filas por mes. | Resuelto: techos de 60/min y 5.000/día en la base (PGlite). |
| N-12 | P3 | "Horarios de atención" no mostraba que se despliega. | Resuelto: indicador visible; E2E lo despliega. |
| N-13 | — | La suite heredada del backend de desarrollo fallaba 2 de cada 21 corridas: el clic del paso siguiente caía durante el redibujo de la acción anterior. | Resuelto en el arnés (12/12 después). |
| N-14 | P2 | Un toque podía perderse si la vista se redibujaba justo en ese instante: los refrescos en segundo plano (Realtime, sondeo) no esperaban a que terminara el toque, y en rutas protegidas la vista no se marcaba ocupada mientras se revalidaba la sesión. Apareció como un fallo intermitente de la E2E en WebKit. | Resuelto: los refrescos esperan 600 ms después de un toque y `aria-busy` se marca al empezar cada redibujo (E2E completa 27/27 dos veces seguidas). |
| N-15 | P1 | Un usuario invitado confirmaba el enlace pero nunca elegía contraseña (no podía volver a entrar): bloqueaba crear la administración sin contraseñas temporales. | Resuelto: la invitación lleva a "Elegí tu contraseña" (E2E con correo real, Chromium y WebKit). |
| N-16 | P2 | En Postgres nuevos de Supabase la clave de servidor no tiene privilegios sobre las tablas (cambió el valor por defecto): la limpieza heredada de QA fallaría en producción. | Resuelto sin ampliar privilegios: la operación usa SQL del dueño para tablas y la clave de servidor sólo para Auth y Storage (`limpiar-qa`, smoke). |
| N-17 | P2 | El dump de esquema de la CLI no incluye las políticas de Storage: restaurar sólo desde ese archivo dejaría el bucket sin reglas. | Resuelto: la restauración es migraciones del repo + datos, y compara el esquema restaurado con el de origen. |
| N-18 | — | La integración de GitHub de esta sesión no puede disparar workflows (403). | Pedidos de operación por archivo versionado (`ops/solicitud.json`), auditados en git. |
| N-19 | P2 | Los recorridos heredados (`tests/lib/cdp.mjs`) sorteaban el puerto de depuración de cada Chrome sin comprobar que estuviera libre: dos roles podían caer en el mismo navegador (fallo intermitente "no aparece el formulario de alta") y, si el arranque fallaba, el Chrome quedaba vivo y retenía el job de CI hasta su tope de 30 minutos. | Resuelto: Chrome elige el puerto (`--remote-debugging-port=0` + `DevToolsActivePort`), el proceso se cierra siempre (también si falla el arranque), el canal CDP tiene tiempo límite y el paso de CI tiene tope de 10 minutos. 8 navegadores en paralelo con puertos distintos; binario que muere o se traba: error claro y el proceso termina. |
