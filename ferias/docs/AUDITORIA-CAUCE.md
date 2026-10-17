# Fase 1 · Auditoría de CAUCE · Aluminé y plan de derivación

Revisado sobre `main` 7375d12 (CAUCE · Aluminé, plataforma piloto publicada).

## Qué es CAUCE · Aluminé

SPA en JavaScript sin framework (enrutador por hash) sobre Supabase: Postgres con
RLS en todas las tablas, Auth con correo y contraseña más sesiones anónimas para
comprar, Storage para fotos, Realtime para el panel. Todo lo crítico pasa por
funciones `SECURITY DEFINER` en un esquema `private` con envoltorios `SECURITY
INVOKER` en `public`. Pruebas de cuatro niveles: unitarias, SQL embebido (PGlite),
integración contra un stack Supabase local real y E2E en Chromium y WebKit.

## Qué se reutiliza en Ferias (sin reconstruir)

| Pieza de Aluminé | Cómo se reutiliza en Ferias |
| --- | --- |
| Patrón `private` definer + `public` invoker, revocación de grants por defecto, grants por columna | Igual, en todas las tablas nuevas. Prueba automática: ninguna función definer en `public`, todas con `search_path` vacío. |
| `create_order` (precios, stock con bloqueo de fila, idempotencia durable, huella del intento, total confirmado `U0005`, techo anti-abuso `U0006`) | Portado y extendido: retiro en feria con participación confirmada, variantes con stock propio, envío "a coordinar". |
| `transition_order` + `private.order_transitions` (máquina de estados por rol, versión `U0001`, motivo obligatorio, historial, devolución de stock) | Portado sin reparto: estados `submitted → accepted → preparing → ready → (on_the_way) → delivered`, cancelación. |
| `track_order` por token secreto | Portado; agrega feria, puesto y coordenadas; nunca devuelve teléfono ni correo. |
| Compra sin cuenta con sesión anónima real + interruptor `guest_checkout` | Igual. |
| Alta de comercio atómica, revisión por administración, pausar/reanudar, equipo owner/manager/staff | Igual, más slug resuelto en el servidor, período de prueba al aprobar y lugares de equipo según plan. |
| Storage por comercio con ruta validada por regex | Igual en el bucket `ferias-media`, más ruta de ferias y tope de archivos por plan. |
| `report_client_event` con `scrub` de datos personales y techos | Igual. |
| Mapeo de errores del servidor a mensajes en castellano, timeouts de red, carrito por identidad | Reescritos sobre la misma idea en `js/repo/`. |
| `image-prep` (achica y pasa a WebP antes de subir) | Copiado. |
| Build de producción (valida URL y clave pública, CSP generada, bundle con hash, service worker versionado, chequeo de credenciales) | Adaptado a `scripts/build.mjs`. |
| Harness de integración (cuentas reales de GoTrue, Mailpit, negativa a correr contra hosts no locales) | Adaptado a los puertos del stack de Ferias. |

## Qué se deja afuera (no aplica a un marketplace de artesanos)

Taxis, reparto con cuentas de repartidor y código de entrega, horarios de
atención por día, pagos online (Mercado Pago apagado en Aluminé), facturación
ARCA, demostración en `localStorage` y backend SQLite de desarrollo. Ferias no
tiene modo demo: siempre corre contra un Supabase real (local o, cuando se
autorice, uno remoto propio).

## Adaptaciones necesarias (implementadas)

1. **Rubros globales** (cerámica, textiles, joyería, decoración, cuero, arte,
   regionales, otros) para explorar todo el marketplace.
2. **Productos de artesanía**: bajo pedido con tiempo de elaboración, materiales,
   hecho a mano, varias fotos (`product_images`), variantes con stock propio.
3. **Ferias** (`fairs`), **organizadores** con su equipo, **inscripciones y
   puestos** (`fair_participations`, un código de puesto por feria), **avisos**
   a participantes confirmados.
4. **Retiro en feria** en el pedido, con copia de feria, lugar y puesto.
5. **Planes y suscripciones** con estado efectivo por fecha (prueba, vigente,
   gracia, vencida) y límites validados en triggers y funciones.
6. **Pagos**: efectivo o transferencia coordinada; el cobro sólo lo registra el
   comercio, nunca se confirma solo.
7. **Auditoría mínima** de acciones administrativas, de organización y de
   suscripción.
8. **Comunidad fundadora** con consentimiento explícito, techo por sesión y
   borrado a pedido.

## Riesgos detectados y cómo se tratan

| Riesgo | Tratamiento |
| --- | --- |
| La derivación tocara producción de Aluminé | Proyecto autocontenido en `ferias/`, `project_id` propio (`cauce-ferias`), puertos propios (55420–55429, preview 4274), bucket propio, sin referencias al proyecto `ygqbcvxdrewcnzedfcyo`. Ningún archivo de Aluminé cambia. |
| ESLint de la raíz analizando `ferias/` | ESLint 10 busca la configuración desde cada archivo: `ferias/eslint.config.mjs` aplica a sus archivos. |
| Registro de imágenes `public.ecr.aws` bloqueado en el entorno de desarrollo | Las imágenes del stack local se bajaron de Docker Hub y se re-etiquetaron (ver `docs/INSTALACION.md`). |
| Carreras en límites de plan | Bloqueo asesor por comercio en los triggers de productos y fotos. |
| Expiración de suscripción cortando pedidos | La tienda pasa a vitrina sin pedidos nuevos; los pedidos abiertos se completan (probado). |
