# CAUCE · Ferias Neuquén

Marketplace para artesanos, feriantes y emprendedores de Neuquén: tiendas con
productos hechos a mano, calendario de ferias con puestos, pedidos con **retiro
en el puesto de la feria**, retiro acordado o envío propio, y paneles para
quien vende, quien organiza ferias y la administración. *Hecho cerca tuyo.*

Es una **derivación independiente** de CAUCE · Aluminé: carpeta propia,
proyecto Supabase propio (`project_id = "cauce-ferias"`, puertos 55420–55429),
bucket propio y migraciones propias. No modifica la aplicación publicada de
Aluminé, su base, sus usuarios ni su configuración. Ver
[docs/AUDITORIA-CAUCE.md](docs/AUDITORIA-CAUCE.md) para qué se reutilizó.

**Estado:** versión completa para piloto, verificada contra un Supabase local
real. No hay proyecto remoto ni despliegue público todavía (requieren
autorización). Qué está listo y qué falta: [docs/INFORME-ENTREGA.md](docs/INFORME-ENTREGA.md).

## Arranque rápido (local)

Requisitos: Node 22+, Docker.

```bash
cd ferias
npm ci
npm run db:start      # stack Supabase local de Ferias con las migraciones
npm run seed:demo     # opcional: tiendas, productos, ferias y pedidos de DEMOSTRACIÓN
npm run dev           # build conectado + http://127.0.0.1:4274/index.html
```

Las cuentas demo y sus contraseñas quedan en `.local/demo-credenciales.json`
(no se versiona). Los correos de confirmación y recuperación llegan a Mailpit:
<http://127.0.0.1:55424>. Detalle, problemas frecuentes y despliegue remoto:
[docs/INSTALACION.md](docs/INSTALACION.md).

## Qué incluye

| Para | Pantallas |
| --- | --- |
| Quien compra (sin cuenta) | Inicio con rubros, destacados, ferias cercanas, tiendas recomendadas y nuevos emprendimientos · Explorar con búsqueda y filtros (rubro, localidad, disponibilidad, precio, orden) · Tienda (productos, ferias, sobre mí, contacto, enlace y QR) · Producto (fotos, variantes, stock, elaboración, entregas, relacionados) · Ferias (calendario, filtros, cómo llegar, expositores y puestos) · Carrito y checkout (un pedido = una tienda; retiro en feria, retiro acordado o envío; efectivo o transferencia) · Seguimiento por enlace · Mis pedidos · Favoritos · Comunidad fundadora · Planes |
| Quien vende | Alta guiada · Panel con lista de pasos · Pedidos en vivo (aviso sonoro, cambio de estado, registro manual del cobro, WhatsApp) · Productos con fotos desde el teléfono y variantes con stock propio · Inventario rápido · Mi tienda (logo, portada, entregas, contacto, pausa) · QR y enlace · Mis ferias (inscripción, puesto, avisos) · Estadísticas · Mi plan · Equipo |
| Quien organiza | Mis ferias · Crear/editar (fecha, lugar, coordenadas, puestos) · Publicar/cancelar · Inscripciones (confirmar con puesto, rechazar) · Puestos · Avisos a participantes · Compartir (QR) · Métricas |
| Administración | El día de la plataforma y lo que necesita atención · Revisión de tiendas con período de prueba · Suscripciones manuales · Organizadores · Comunidad fundadora · Auditoría y errores |

Sofía, el personaje de la marca, está dibujada en SVG con 9 escenas animadas
(se respetan las preferencias de movimiento reducido). Ver [docs/PERSONAJE.md](docs/PERSONAJE.md).

## Arquitectura

```
js/core/      reglas puras: HTML escapado, dinero, fechas, carrito, estados, validaciones, enlaces, QR
js/repo/      repositorio Supabase (lecturas por RLS, operaciones críticas por RPC) y mensajes de error
js/ui/        íconos, Sofía, componentes y vistas (shop, buy, account; panel/organizer/admin se cargan aparte)
js/app.js     shell: enrutador por hash, encabezado, navegación, avisos, diálogos, telemetría
supabase/     config del stack local, plantillas de correo y 6 migraciones
scripts/      build, vista previa, sembrado demo, ilustraciones demo, íconos, compuertas
tests/        unit, db (PGlite), integration (Supabase real), e2e (Playwright), visual
```

- **Frontend:** SPA en JavaScript sin framework, sin dependencias de UI. Todo
  texto de datos pasa por una plantilla que escapa HTML (defensa contra XSS).
  CSP estricta (`script-src 'self'`, `style-src 'self'`, conexiones sólo al
  proyecto Supabase). Bundle inicial ~82 KB con brotli; paneles en partes
  diferidas.
- **Backend:** Supabase Auth (correo + contraseña con confirmación; sesión
  anónima real para comprar sin cuenta), PostgreSQL con RLS en todas las
  tablas, funciones `SECURITY DEFINER` en `private` con envoltorios invoker en
  `public`, Storage por comercio, Realtime para el panel.
- **Seguridad y permisos:** [docs/SEGURIDAD.md](docs/SEGURIDAD.md). **Planes:**
  [docs/SUSCRIPCIONES.md](docs/SUSCRIPCIONES.md). **Costos:** [docs/COSTOS.md](docs/COSTOS.md).

## Pruebas

| Comando | Qué prueba | Resultado en esta entrega |
| --- | --- | --- |
| `npm run lint` · `npm run typecheck` · `npm run check` | ESLint, TypeScript checkJs, compuertas (CSP sin código en línea, innerHTML escapado, sin credenciales privilegiadas, aislamiento) | PASS |
| `npm test` | Unitarias (núcleo, paridad de estados con SQL, todo error SQL traducido, componentes escapados, Sofía) | 15/15 |
| `npm run test:db` | Migraciones y RLS en PostgreSQL embebido: multi-vendedor, precios, stock, idempotencia, planes, ferias, comunidad, auditoría | 54/54 |
| `npm run test:integration` | GoTrue con correo real (Mailpit), recuperación, Storage, concurrencia, Realtime, ferias y el repositorio de la app | 11/11 |
| `npm run e2e` | Recorridos en navegador: compra con retiro en feria, alta guiada con foto y aprobación, pedido en vivo hasta el cobro, organizador, accesos, anchos y teclado | Chromium 6/6 (local, ×4, y CI) · WebKit 6/6 (CI) |
| `npm run audit:visual` | 7 anchos (320–1440): desborde, errores, objetivos táctiles, contraste | Chromium 245 capturas (local) · Chromium + WebKit 490 capturas (CI), sin hallazgos |

CI propio: [`.github/workflows/ferias-ci.yml`](../.github/workflows/ferias-ci.yml)
(sólo corre con cambios en `ferias/`; instala Chromium y WebKit).
