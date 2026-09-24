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
