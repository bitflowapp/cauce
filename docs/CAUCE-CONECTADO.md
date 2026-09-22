# CAUCE conectado: catálogo, pedidos, reparto y taxi reales

Proyecto exclusivo: `cauce-production` (`ygqbcvxdrewcnzedfcyo`), organización
Luna Systems, región `sa-east-1`. Rama `feat/cauce-production-foundation`.
No hubo merge a `main` ni publicación. No se tocó ningún otro proyecto Supabase.

El estado anterior, con sólo cuentas y comercios, está en
[SUPABASE-PHASE1.md](SUPABASE-PHASE1.md).

## Qué funciona de verdad

Comprobado contra el proyecto real, no contra imitaciones:

- Alta de comercio desde la interfaz, con datos, rubro y contacto privado.
- Catálogo propio: categorías, productos, variantes, precio, stock y baja.
- Imágenes reales en Supabase Storage: logo, portada y foto de producto, con
  vista previa, reemplazo y borrado.
- Solicitud de publicación con requisitos verificados en el servidor y
  aprobación exclusiva de administración.
- Pedidos con precio, envío y total calculados por el servidor.
- Idempotencia durable: el mismo intento, incluso enviado dos veces en paralelo,
  devuelve el mismo pedido.
- Estados de pedido con reglas por rol y control de versión.
- Reparto propio de cada comercio: alta, asignación y avance hasta la entrega.
- Sincronización en vivo: el comercio ve entrar el pedido y la persona ve el
  cambio de estado sin recargar.
- Taxi multiusuario con aceptación atómica: dos conductores compitiendo, uno
  solo se queda con el viaje.
- Aislamiento entre cuentas, comercios y conductores, comprobado con pruebas
  negativas explícitas.

## Lo que todavía NO está cerrado

**Correo transaccional.** El proyecto no tiene SMTP propio (`smtp_host` vacío).
El correo interno de Supabase sólo entrega a integrantes del equipo de la
organización y admite 2 mensajes por hora: no sirve para abrir el registro a
vecinos. Sin eso no se puede demostrar
`registro → correo → confirmación → login` ni
`recuperación → correo → callback → nueva contraseña` con una casilla cualquiera.
Lo que sí está comprobado es el mecanismo: token real de un solo uso, callback
que limpia la URL antes de verificar, y cambio de contraseña efectivo.

No se creó ninguna cuenta externa ni se contrató nada. Ver
[Qué falta configurar](#qué-falta-configurar).

## Migraciones

Aplicadas con CLI sobre el proyecto real, en este orden:

| Versión | Contenido |
| --- | --- |
| `20260922010136` | Identidad, comercios, membresías y RLS de base |
| `20260922012118` | Contrato de acceso de lectura y denegación explícita |
| `20260922020819` | Catálogo, medios, ciclo de alta y bucket `business-media` |
| `20260922021709` | Pedidos, reparto, conductores, viajes y funciones de regla |
| `20260922022339` | Realtime y denegaciones explícitas en tablas de referencia |
| `20260922023914` | Nombres propios para las claves de ámbito de pedido |
| `20260922025918` | Corrección de contabilidad de stock con variantes |
| `20260922030252` | Revocación de EXECUTE en funciones de trigger |

`supabase/database.types.ts` se regeneró desde el proyecto real.

## Decisiones de seguridad

### Escritura

Pedidos y viajes **no admiten INSERT ni UPDATE directos de ningún cliente**.
No hay `grant` de escritura sobre `orders`, `order_items`, `order_events`,
`trips` ni `trip_events`. Toda escritura pasa por funciones `SECURITY DEFINER`
que viven en el esquema `private`, con `search_path` vacío, `EXECUTE` revocado
a `public`/`anon` y concedido sólo a `authenticated`. El esquema expuesto por la
API sigue siendo únicamente `public`, y ahí sólo hay envoltorios
`SECURITY INVOKER`.

Consecuencia comprobada: un cliente no puede cambiar el total de su pedido y un
comercio no puede marcarlo entregado escribiendo la tabla. Las dos cosas
devuelven error de permisos.

### Dinero

Todos los importes son `bigint` en pesos enteros (`price_ars`, `subtotal_ars`,
`delivery_fee_ars`, `total_ars`). No hay ningún importe en punto flotante. Una
restricción `check` obliga a que el total sea exactamente subtotal más envío, y
otra a que el total de cada línea sea precio unitario por cantidad. El navegador
nunca envía un precio: manda qué productos y qué cantidades, y el servidor
resuelve el resto contra el catálogo guardado.

### Ámbito

`businesses` tiene una clave única `(id, locality_id)` y otra `(id, business_id)`
en productos y categorías. Las filas hijas referencian esas claves compuestas,
así que **no existe una escritura que mueva un producto a otro comercio o a otra
localidad**: la base lo rechaza antes que cualquier política. La localidad del
producto la escribe un trigger a partir del comercio; el cliente no la declara.

### Roles

- `owner` y `manager`: editan el comercio, el catálogo, los medios y el reparto.
- `staff`: lee, y sólo puede marcar disponibilidad y stock a través de
  `set_product_availability`. No tiene `UPDATE` directo sobre productos ni puede
  subir imágenes.
- Administración: se resuelve en `private.platform_admins`, una tabla sin acceso
  de cliente y con política de denegación explícita. Nunca se deriva de
  `user_metadata`.

Publicar un comercio y aprobar un conductor son operaciones exclusivamente
administrativas. Pausar, reactivar y abrir o cerrar la atención son del comercio.

### Privacidad

- El contacto del comercio vive en `business_contacts`, aparte de la fila
  pública. La consulta pública ni siquiera lo pide.
- Antes de aceptar un viaje, el conductor recibe origen, destino, cantidad de
  pasajeros y la inicial del nombre. No recibe teléfono ni nombre completo: la
  oferta la sirve una función acotada, no una política sobre la tabla.
- Después de la asignación, el pasajero obtiene los datos del móvil por
  `trip_driver`, que sólo responde al pasajero de ese viaje.
- Los perfiles siguen siendo de lectura propia. Un comercio ve el nombre y el
  teléfono que la persona escribió **en ese pedido**, no su perfil.

### Carreras

Dos garantías están en la base, no en el código de la aplicación:

- `unique (customer_id, business_id, idempotency_key)` en pedidos. Dos envíos
  simultáneos del mismo intento terminan en un único pedido; el segundo
  encuentra el conflicto y devuelve el primero.
- Índices únicos parciales en viajes: uno por conductor con viaje en curso y uno
  por pasajero con solicitud abierta. La aceptación es una sola sentencia
  `update ... where driver_id is null and status in (...)`; quien no la gana
  recibe `U0004`.

Además, el stock se descuenta con la fila del producto bloqueada, así que dos
pedidos simultáneos no venden la misma unidad.

### Storage

Bucket `business-media`, público para lectura por URL, con límite de 5 MB y
tipos `image/jpeg`, `image/png`, `image/webp` declarados en el propio bucket.
Las políticas de escritura extraen el comercio de la ruta
`businesses/{business_id}/...` con una expresión que sólo acepta esa forma
exacta; cualquier otra ruta no resuelve a ningún comercio y queda denegada.
`SELECT` está acotado a miembros y administración, de modo que un comercio no
puede listar los archivos de otro.

Que el bucket sea público significa que **quien tenga la URL exacta de una foto
puede verla**. Es contenido que el comercio publica a propósito; permite servir
las imágenes por CDN y evita meter respuestas privadas en la caché del
navegador. Nada privado se guarda ahí.

## Sincronización en vivo

`orders`, `order_events`, `trips` y `trip_events` están en la publicación
`supabase_realtime`. Realtime entrega cada cambio pasando la fila por las mismas
políticas RLS, así que un comercio recibe sus pedidos y una persona los suyos.
No se creó nada dentro del esquema `realtime`, que está protegido.

La aplicación abre **una suscripción por vista**, acotada a lo que esa vista
muestra: el panel del comercio escucha `business_id=eq.<su comercio>`, la
pantalla de un pedido escucha ese pedido y la actividad de una persona escucha
sus pedidos y sus viajes. Al cambiar de pantalla el canal se cierra. Nunca se
escucha una tabla entera. Cuando llega un cambio, la aplicación **no pinta la
carga útil del evento**: vuelve a consultar por la vía normal, que aplica RLS
otra vez.

Hay una excepción deliberada: **las solicitudes de taxi todavía sin aceptar no
viajan por Realtime**. Una solicitud abierta no es legible por ningún conductor
—esa es justamente la regla de privacidad—, así que Realtime tampoco podría
entregarla sin romperla. El panel del conductor vuelve a pedir la lista anónima
por RPC cada quince segundos mientras está abierto. Una vez aceptado el viaje,
el conductor sí lo recibe en vivo, porque ya es suyo.

## Advisors

Ejecutados después de cada bloque de esquema.

- **Seguridad: 0 hallazgos.** La advertencia de políticas permisivas múltiples
  sobre `businesses` se resolvió unificando la lectura en una política por rol.
  `anon` quedó fuera de las funciones que no puede ejecutar.
- **Rendimiento: sólo avisos informativos.**
  - `unused_index`: son índices sin uso porque el proyecto no tiene tráfico
    todavía. No se borran: existen para las consultas que la aplicación ya hace.
  - `unindexed_foreign_keys` sobre claves compuestas de pedido: cada una tiene
    un índice cuyo prefijo es la columna que la restricción recorre
    (`order_items_order`, `order_events_order`, `orders_business_feed`,
    `orders_rider`). Agregar índices exactos duplicaría escritura sin cambiar el
    plan. **Excepción analizada y aceptada.**
  - `auth_db_connections_absolute`: el servidor de Auth usa hasta 10 conexiones.
    Es el valor por defecto del plan y no hay motivo para cambiarlo con este
    volumen.

## Contraseñas filtradas

La protección contra contraseñas filtradas **está habilitada** en el proyecto
(`password_hibp_enabled`). La organización ya está en plan Pro, así que no hubo
ningún costo adicional ni cambio de plan.

Comprobado en vivo contra la API pública: `password12345` se rechaza con
`weak_password`. Se mantienen además el mínimo de 10 caracteres y la exigencia
de letras y números. La interfaz muestra el motivo en castellano.

## Correo y URLs

- Plantillas de confirmación, recuperación, cambio de correo y enlace de acceso
  reescritas en castellano rioplatense, con la identidad de CAUCE. Se aplican con
  `node scripts/configure-auth.mjs --apply`.
- El token viaja sólo dentro del enlace. No se escribe en registros ni en la
  evidencia.
- `site_url` y la lista de URLs permitidas siguen apuntando al preview local
  `http://127.0.0.1:4174`. **Hay que reemplazarlas por la URL real antes de
  cualquier piloto público**, con el mismo script.
- La confirmación de correo sigue obligatoria (`mailer_autoconfirm = false`).

## Demostración y producción

Siguen siendo dos artefactos distintos y separados:

- `npm run build` y `npm run build:offline` generan **sólo la demostración**,
  sin red, con la compuerta `mode: 'demo'` cerrada.
- `npm run build:supabase` genera el entorno conectado en
  `.local/supabase-preview`, con `mode: 'production'` y `liveOrders: true`.
  `livePayments` sigue en `false`: no hay cobro en línea.

`createRepository` exige que la configuración coincida con el entorno; una
combinación que no corresponda falla al arrancar. **No hay ningún camino por el
cual un error de Supabase haga caer la aplicación a los datos de demostración.**
Si la sesión falla, la pantalla lo dice.

## Service worker

Sólo guarda la cáscara estática: documento, CSS, JavaScript propio, íconos y
fuentes del mismo origen. Ignora cualquier petición con `Authorization`,
`apikey`, `Range` o credenciales; ignora todo origen que no sea el propio, así
que Auth, REST, Storage y Realtime de Supabase nunca pasan por él; ignora
cualquier URL con parámetros de consulta, de modo que un enlace de recuperación
no puede quedar cacheado. La caché cambió de nombre (`cauce-shell-v3`) para que
las versiones anteriores se borren al activar.

## CSP

El entorno conectado permite exactamente el proyecto CAUCE:

```
connect-src 'self' https://ygqbcvxdrewcnzedfcyo.supabase.co wss://ygqbcvxdrewcnzedfcyo.supabase.co
img-src 'self' data: blob: https://ygqbcvxdrewcnzedfcyo.supabase.co
```

Sin comodines. Ningún endpoint de La Taba ni de BitFlow. La demostración
conserva `connect-src 'none'`.

## Pruebas

```powershell
npm run verify              # check, 172 pruebas, 32 pruebas SQL, builds demo
npm run test:supabase       # 12 comprobaciones de identidad contra CAUCE
npm run test:supabase:ops   # 11 comprobaciones de operación contra CAUCE
npm run e2e:supabase        # recorrido en tres navegadores independientes
```

| Suite | Resultado |
| --- | --- |
| Pruebas de dominio, interfaz y service worker | 176 aprobadas |
| Pruebas SQL sobre PostgreSQL embebido | 38 aprobadas |
| Identidad contra Supabase real | 12 comprobaciones |
| Operación contra Supabase real | 11 comprobaciones |
| Recorrido en tres navegadores contra Supabase real | 16 pasos |
| E2E SQLite y demo heredados | 37 y 12 pasos |
| Auditorías visuales heredadas | 64 pantallas |

Cuatro de las pruebas de dominio ejecutan el service worker de verdad, en un
entorno mínimo, para fijar qué puede quedar guardado en el dispositivo.

Las pruebas SQL levantan PostgreSQL embebido, reconstruyen las seis migraciones
desde cero y cambian de rol e identidad por transacción. **No prueban
concurrencia**: PGlite tiene una sola conexión. Las carreras reales —doble envío
del mismo pedido y dos conductores aceptando a la vez— se prueban contra el
proyecto, con peticiones simultáneas de verdad.

Las pruebas remotas tienen el destino CAUCE fijado en código y fallan si apunta
a otro proyecto. Obtienen la clave de servidor sólo en memoria desde la CLI
autenticada, nunca la imprimen, y borran al terminar cuentas, comercios,
pedidos, viajes y archivos subidos.

### Pruebas negativas

Identidades independientes: cliente A, cliente B, comercio A propietario,
comercio A equipo, comercio B propietario, taxista A, taxista B y administración.

Comprobado explícitamente que:

- A no ve los pedidos, el catálogo en borrador ni los archivos de B.
- B no modifica nada de A, ni por tabla ni por URL.
- El equipo no se vuelve encargado ni propietario.
- Un comercio no se aprueba a sí mismo ni se vuelve administración.
- `user_metadata` con `role: admin` no concede nada.
- El cliente no cambia el total ni pone el pedido en el estado que quiera.
- El comercio no salta pasos ni marca entregado un pedido en retiro sin pasar
  por «listo».
- Un conductor no acepta un viaje ya tomado y no ve los viajes ajenos.
- Un visitante sin cuenta no lee perfiles, pedidos, viajes, contactos ni
  borradores.

## Qué falta configurar

Estas tres cosas dependen de decisiones o cuentas que no me corresponde crear:

1. **SMTP propio de CAUCE.** Con Resend: crear la cuenta en resend.com (plan
   gratuito: 3.000 correos por mes, 100 por día), verificar un dominio propio y
   generar una API key. Después, en una terminal:

   ```powershell
   $env:SUPABASE_ACCESS_TOKEN = "<token personal de Supabase>"
   $env:CAUCE_SMTP_HOST = "smtp.resend.com"
   $env:CAUCE_SMTP_PORT = "465"
   $env:CAUCE_SMTP_USER = "resend"
   $env:CAUCE_SMTP_PASS = "<API key de Resend>"
   $env:CAUCE_SMTP_SENDER = "CAUCE Aluminé <hola@tu-dominio>"
   node scripts/configure-auth.mjs --apply
   ```

   Sin dominio propio, Resend sólo entrega a la casilla de la propia cuenta: sirve
   para probar, no para abrir el registro. Verificar un dominio suele implicar un
   costo si todavía no se tiene. **No se contrató ni se registró nada.**

2. **La URL definitiva del entorno conectado.** Mientras `site_url` apunte al
   preview local, los enlaces de confirmación y recuperación sólo funcionan en
   esta máquina. Definida la URL, se aplica con la misma herramienta:

   ```powershell
   $env:CAUCE_SITE_URL = "https://<destino real>"
   node scripts/configure-auth.mjs --apply
   ```

3. **La cuenta administradora real.** Hoy no existe ningún administrador
   permanente: las pruebas crean uno sintético y lo borran. Elegida la cuenta,
   se provisiona con una sentencia sobre el proyecto:

   ```sql
   insert into private.platform_admins (user_id)
   select id from auth.users where email = '<correo de la persona>';
   ```

## Lo que sigue sin existir

No hay Mercado Pago ni ningún cobro. No hay GPS continuo ni mapas: el
seguimiento visual sigue siendo estimado por estado, como estaba. No hay
notificaciones push, reseñas, promociones, cupones ni interfaz multilocalidad.
Nada de eso se agregó ni se simuló.
