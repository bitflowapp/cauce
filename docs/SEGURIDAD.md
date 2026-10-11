# Seguridad, roles y permisos

Las reglas viven en la base de datos. La interfaz oculta lo que una persona no
puede hacer, pero aunque alguien llame a la API a mano, PostgreSQL lo rechaza.

## Roles

| Rol | Cómo se obtiene | Qué puede |
| --- | --- | --- |
| Visita | Sin sesión | Leer catálogo publicado, ferias publicadas o canceladas, expositores confirmados, planes. Nada privado. |
| Compra sin cuenta | Sesión anónima real de Supabase (al confirmar el primer pedido o la preinscripción) | Crear pedidos, ver y cancelar (si todavía no los aceptaron) los suyos. Apagable con `guest_checkout`. |
| Cuenta | Registro con correo confirmado | Lo anterior con historial propio; crear hasta 3 tiendas. |
| Titular de tienda (`owner`) | Quien crea la tienda | Todo en su tienda, equipo incluido. |
| Encargado/a (`manager`) | Lo suma la titular | Catálogo, datos de la tienda, pedidos, ferias. No el equipo. |
| Ayudante (`staff`) | Lo suma la titular | Pedidos, cobro y stock/visibilidad (por `set_stock`). No edita catálogo ni tienda. |
| Organización (`owner`/`editor`) | La habilita la administración | Sólo las ferias de su organización: crear, editar, publicar, inscripciones, puestos, avisos. |
| Administración | Fila en `private.platform_admins` (sólo por SQL del operador) | Revisar altas, suspender, suscripciones, organizadores, comunidad, auditoría. Todo queda en `private.audit_log`. |

`user_metadata` (lo que una persona manda al registrarse) nunca concede roles:
está probado (`user_metadata.role = admin` no da acceso).

## Cómo se aplica

- **RLS en todas las tablas** de `public` y `private` (prueba automática).
- **Privilegios por defecto revocados** en cada tabla; luego se conceden
  columnas puntuales. Ejemplo: un comercio puede actualizar el nombre de su
  tienda, pero no `status`, `slug` ni fechas.
- **Escrituras críticas sólo por funciones** `SECURITY DEFINER` en el esquema
  `private` (no expuesto), con envoltorios `SECURITY INVOKER` en `public` y
  `search_path` vacío (pruebas automáticas para ambas cosas).
- **Pedidos:** no hay escritura directa sobre `orders`, `order_items` ni
  `order_events`. `create_order` resuelve precio, variante, stock (con bloqueo
  de fila), envío y total; exige que la tienda esté publicada, con plan
  vigente y aceptando pedidos; valida la feria y la participación confirmada
  para el retiro en feria; usa una clave de idempotencia con huella del
  contenido (`U0002` si se reutiliza con otros datos); rechaza si el total
  cambió (`U0005`); pone techos (3 pedidos sin atender y 5 cada 10 minutos por
  persona, `U0006`). `transition_order` aplica la tabla
  `private.order_transitions` por rol y forma de entrega, con control de
  versión (`U0001`), motivo obligatorio al rechazar y devolución de stock.
- **Pagos:** sólo efectivo o transferencia coordinada con la tienda. El cobro
  lo registra el comercio (`set_order_payment`); nunca se marca solo. CAUCE no
  recibe ni custodia dinero.
- **Seguimiento por enlace:** `track_order(token)` con un UUID secreto
  devuelve estado, ítems y lugar de retiro, nunca el teléfono ni el correo de
  quien compró.
- **Límites del plan en la base:** triggers de productos y fotos con bloqueo
  asesor (dos pestañas no superan el tope), lugares de equipo en
  `add_business_member`, retiro en feria en `create_order`, publicación de
  ferias y tope de ferias activas en `set_fair_status`.
- **Storage (`ferias-media`):** 5 MB, sólo JPEG/PNG/WebP. Rutas validadas por
  expresión regular (`businesses/<uuid>/(logo|cover|products)/<uuid>.<ext>` y
  `fairs/<uuid>/cover/…`); sólo titular o encargado/a escriben en su carpeta;
  tope de archivos por tienda según el plan. Las fotos se achican y pasan a
  WebP en el navegador antes de subir.
- **Realtime:** el panel sólo recibe los pedidos que RLS le deja leer (probado
  con dos comercios simultáneos).
- **Registro de errores:** `report_client_event` limpia correos, teléfonos y
  tokens antes de guardar, con techos por minuto, por día y por cuenta, y se
  depura a los 30 días. Sólo la administración lo lee.
- **Comunidad fundadora:** consentimiento explícito con versión registrada,
  techo de 3 por sesión y día, y borrado a pedido desde administración. Los
  datos sólo existen en el proyecto de Ferias.

## Navegador

- **CSP:** `default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data: blob: <supabase>; connect-src 'self' <supabase> (https/wss);
  font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`.
  Sin scripts, estilos ni manejadores en línea (compuerta `npm run check`).
- **Encabezados del hosting** (`_headers`, Cloudflare Pages): no embebible en
  marcos (`X-Frame-Options` y `frame-ancestors 'none'`), HSTS, `nosniff`,
  `Referrer-Policy` y `Permissions-Policy`; las vistas previas llevan
  `noindex` (sólo `FERIAS_INDEXAR=si` habilita la indexación).
- **CSV de administración:** las celdas que empiezan con `= + - @` se
  neutralizan para que nadie pueda inyectar fórmulas en una planilla.
- **XSS:** todo dato se inserta con la plantilla `html\`…\`` que escapa; sólo
  el markup propio (íconos, Sofía) entra con `raw()`. La compuerta exige que
  todo `innerHTML` reciba una plantilla escapada.
- **Credenciales:** el navegador sólo recibe la publishable key. El build
  falla si encuentra una secret key, un JWT que no sea `anon` o la referencia
  al proyecto de Aluminé.
- **Sesión:** PKCE, refresco automático, sesiones revocadas se descartan al
  arrancar; enlaces de correo de un solo uso con `token_hash` que funcionan en
  otro dispositivo.
- **Almacenamiento local:** sólo carritos (hasta confirmar), favoritos,
  localidad, la tienda elegida en el panel y la preferencia de sonido. Nada de
  esto es un dato de negocio; los pedidos viven en PostgreSQL.

## Pruebas que lo respaldan

`tests/db/seguridad.test.mjs`, `pedidos.test.mjs`, `ferias-planes.test.mjs`,
`comunidad-admin.test.mjs` (54 casos en PostgreSQL embebido) y
`tests/integration/integracion.test.mjs` (11 casos contra GoTrue, PostgREST,
Storage y Realtime reales). Los E2E repiten los controles de acceso desde la interfaz.
