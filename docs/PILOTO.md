# Piloto comercial · 10 a 20 artesanos y comerciantes

Objetivo: que entre 10 y 20 artesanos, feriantes y emprendedores reales de
Neuquén y alrededores abran su tienda, publiquen su catálogo, se inscriban en
ferias y reciban pedidos durante un período acotado, con acompañamiento
directo de LUNA Proyectos.

Referencias: ✅ listo y probado · ⬜ pendiente · 🔒 requiere autorización o
decisión de LUNA Proyectos.

## 1. Lo que la plataforma ya cubre

| Prioridad del piloto | Estado | Cómo se probó |
| --- | --- | --- |
| Registro de comerciantes | ✅ | Cuenta con confirmación por correo, recuperación de contraseña (integración y E2E) |
| Alta y gestión de tiendas | ✅ | Alta guiada con lista de requisitos, revisión y aprobación con plan y días de prueba, pausa/reanudación, equipo (E2E) |
| Catálogos | ✅ | Productos con fotos, variantes y stock, por encargo, inventario, límites por plan en la base (SQL + E2E) |
| Publicación de ferias y puestos | ✅ | Organización crea y publica la feria; las tiendas se inscriben; se asignan puestos; avisos (E2E) |
| Reservas y pedidos | ✅ | Compra sin cuenta, retiro en feria con puesto, retiro acordado o envío propio; pedido en vivo en el panel; seguimiento; registro del cobro; stock sin sobreventa (SQL, integración, E2E) |
| Administración | ✅ | Revisión de altas, suscripciones manuales, organizadores, comunidad, auditoría y errores (E2E) |
| Encuestas y Comunidad Fundadora | ✅ | Preinscripción con consentimiento + encuesta breve; resumen, filtro «quieren el piloto» y CSV en Administración (SQL + E2E) |
| Seguridad | ✅ | RLS en todas las tablas, precios y stock en el servidor, idempotencia, CSP, sin claves privilegiadas en el navegador (54+ pruebas SQL, integración) |
| Navegadores | ✅ | Chromium y WebKit (Safari) en el CI; 7 anchos de pantalla sin desbordes |

## 2. Antes de abrir el piloto

### Decisiones de LUNA Proyectos 🔒

- ⬜ Autorizar el proyecto Supabase **Pro** (≈ USD 25/mes) y su región (São Paulo).
- ⬜ Autorizar la publicación y elegir el **dominio**.
- ⬜ Definir cuánto dura la etapa fundadora «sin costo inicial» y qué plan
  recibe cada tienda del piloto (hoy: prueba de 1 a 90 días, 30 por defecto).
- ⬜ Confirmar o ajustar los precios de los planes (tabla `public.plans`; se
  cambian sin tocar código).
- ⬜ Elegir el proveedor de correo (Resend u otro) y la dirección remitente
  (por ejemplo `hola@<dominio>`).
- ⬜ Autorización escrita de Sofía, o confirmar que el piloto sale con el
  personaje genérico (ver [PERSONAJE.md](PERSONAJE.md)).

### Legal y datos personales ⬜

- ⬜ **Política de privacidad** y **términos de uso** revisados por asesoría
  legal. Hay un borrador a partir de lo que la app guarda de verdad en
  [legal/BORRADOR-PRIVACIDAD.md](legal/BORRADOR-PRIVACIDAD.md); **no está
  publicado ni enlazado** hasta que se revise.
- ⬜ Enlazar ambos textos desde el pie del sitio, el registro, el checkout y la
  Comunidad Fundadora (cambio chico, una vez aprobados).
- ⬜ Evaluar la inscripción de la base de datos ante la AAIP (Ley 25.326).
- ⬜ Acuerdo simple con cada tienda del piloto: qué incluye, plazo, que los
  cobros son directos entre tienda y cliente (CAUCE no cobra ni retiene dinero).

### Infraestructura (cuando se autorice) — ver [DESPLIEGUE.md](DESPLIEGUE.md)

- ⬜ Proyecto Supabase creado; secretos y variables en el entorno `produccion`
  de GitHub con aprobación obligatoria.
- ⬜ `operacion estado` en verde; `migrar` ensayado y aplicado; `auth` aplicado.
- ⬜ SMTP propio probado (registro y recuperación llegan y no caen en spam).
- ⬜ Primera cuenta de administración (`operacion admin`).
- ⬜ Sitio publicado con el personaje que corresponda y `noindex` hasta el
  lanzamiento.
- ⬜ **Ensayo de recuperación**: `respaldo` + restauración en un proyecto de
  prueba, cronometrado.
- ⬜ Prueba manual en teléfonos reales: Android con Chrome e iPhone con Safari
  (registro, alta, foto desde la cámara, compra, panel en vivo con sonido).

### Contenido y operación ⬜

- ⬜ Cargar las **localidades y rubros** definitivos (hoy: 10 localidades y 8
  rubros de ejemplo en las migraciones; se ajustan con una migración).
- ⬜ Dar de alta la **organización de ferias** real y sus primeras ferias
  (fechas, lugar, cupo de puestos).
- ⬜ Convocar desde la Comunidad Fundadora: Administración → Comunidad →
  «Quieren el piloto» → Descargar CSV → contactar.
- ⬜ Acompañar cada alta (30 minutos por tienda): foto de portada, 5 a 10
  productos con buena foto, formas de entrega.
- ⬜ Definir quién revisa altas y pedidos atrasados cada día (Administración →
  Resumen) y por qué canal se responde a las tiendas.
- ⬜ Mensaje para compradores en cada feria: cartel con el **QR** de la tienda
  (Panel → Mi tienda → Descargar QR).

## 3. Riesgos conocidos y mitigación

| Riesgo | Mitigación hoy | Si hace falta |
| --- | --- | --- |
| La tienda no ve un pedido porque no tiene el panel abierto | El panel avisa en vivo con sonido; quien compra puede avisar por WhatsApp con un botón | Aviso por correo de pedido nuevo (Edge Function + el mismo SMTP, sin costo extra) |
| Pagos: la plataforma no cobra | Efectivo o transferencia directa; la tienda registra el cobro | Integrar pagos recién con un proveedor y cuentas de cada vendedor |
| Abuso de altas o compras falsas | Revisión humana de cada tienda; límites por sesión; interruptores en la base | Captcha en Auth |
| Fotos pesadas o inapropiadas | Se achican a WebP antes de subir; tamaño y tipo validados; revisión del alta | Moderación manual con suspensión |
| Proyecto gratuito pausado | No usar Free con comercios reales | — |

## 4. Qué medir durante el piloto

- Tiendas que completan el alta y tiempo que tardan.
- Productos publicados por tienda; pedidos por semana; pedidos con retiro en
  feria.
- Pedidos cancelados y motivos (quedan en cada pedido).
- Respuestas de la encuesta (Administración → Comunidad) y una entrevista
  breve a cada tienda al cerrar el piloto.
