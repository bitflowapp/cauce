# Instalación y operación

## 1. Entorno local (desarrollo y demostración)

Requisitos: Node.js 22 o posterior, Docker en marcha. Todo se corre desde la raíz del repositorio.

```bash
npm ci
npm run db:start          # Postgres 17, Auth, REST, Storage, Realtime y Mailpit, con supabase/migrations
npm run seed:demo         # opcional: datos de DEMOSTRACIÓN por la API real
npm run dev               # build contra el stack local + vista previa en http://127.0.0.1:4274/index.html
```

| Servicio local | Dirección |
| --- | --- |
| API Supabase | http://127.0.0.1:55421 |
| Postgres | `127.0.0.1:55422`, base `postgres`, usuario y contraseña `postgres` (valores por defecto del stack local) |
| Mailpit (correos de confirmación y recuperación) | http://127.0.0.1:55424 |
| Aplicación | http://127.0.0.1:4274/index.html |

Los puertos no chocan con el stack de CAUCE · Aluminé (5432x): se pueden tener
los dos levantados a la vez.

### Datos de demostración

`npm run seed:demo` crea 9 cuentas (administración, 7 tiendas, una
organización), 6 tiendas publicadas con 19 productos ilustrados, una tienda en
revisión, 2 ferias con puestos y avisos, y 3 pedidos. Todo pasa por las mismas
funciones y políticas que usa la aplicación. Marca la plataforma con
`demo_data = true`: la interfaz muestra la franja «Datos de demostración», y
cada tienda demo lo dice en su descripción. Las contraseñas quedan en
`.local/demo-credenciales.json` (no se versiona).

Para volver a empezar: `npm run db:reset && npm run seed:demo`.

### Crear una cuenta de administración local

Registrate desde la app, confirmá el correo en Mailpit y después:

```bash
docker exec supabase_db_cauce-ferias psql -U postgres -c \
  "insert into private.platform_admins (user_id) select id from auth.users where email = 'vos@ejemplo.com';"
```

### Si `supabase start` no puede bajar las imágenes

En algunos entornos el registro `public.ecr.aws` está bloqueado. Las mismas
imágenes están en Docker Hub; se bajan y se re-etiquetan con el nombre que
espera la CLI:

```bash
for img in postgres:17.6.1.167 gotrue:v2.196.0 realtime:v2.130.0 storage-api:v1.72.1; do
  docker pull supabase/$img && docker tag supabase/$img public.ecr.aws/supabase/$img; done
docker pull postgrest/postgrest:v16.2 && docker tag postgrest/postgrest:v16.2 public.ecr.aws/supabase/postgrest:v16.2
docker pull kong:2.8.1 && docker tag kong:2.8.1 public.ecr.aws/supabase/kong:2.8.1
docker pull axllent/mailpit:v1.30.2 && docker tag axllent/mailpit:v1.30.2 public.ecr.aws/supabase/mailpit:v1.30.2
```

(Las versiones corresponden a la CLI `supabase@2.117.0` fijada en `package.json`.)

## 2. Pruebas

```bash
npm run lint && npm run typecheck && npm run check && npm test && npm run test:db   # sin Docker
npm run test:integration                                                            # stack local levantado
npm run e2e                                                                         # build local + Chromium y WebKit
npm run seed:demo && npm run build:local && npm run audit:visual                    # capturas en evidence/visual
```

Las pruebas de integración y E2E se niegan a correr contra un host que no sea
local y borran lo que crean. Para correr E2E sólo en Chromium:
`FERIAS_E2E_BROWSERS=chromium npm run e2e`. WebKit necesita los navegadores de
Playwright (`npx playwright install --with-deps webkit`); el CI los instala.

## 3. Pasar a un proyecto remoto (requiere autorización)

Nada se hizo todavía. Pasos, secretos, publicación y recuperación:
[DESPLIEGUE.md](DESPLIEGUE.md); comandos de operación: [OPERACION.md](OPERACION.md).

## 4. Operación diaria del piloto

- **Altas:** Administración → Tiendas → «En revisión»: aprobar eligiendo plan y
  días de prueba, o devolver con una nota.
- **Suscripciones:** Administración → Tiendas → «Editar suscripción» (plan,
  estado, vencimiento, días de gracia y nota). No hay cobro automático.
- **Organizadores:** Administración → Ferias y organizadores → «Habilitar» con
  el correo de una cuenta existente, y activar su Plan Organizador.
- **Comunidad fundadora:** Administración → Comunidad (marcar contactada,
  sumada o borrar a pedido de la persona).
- **Errores:** Administración → Registro (sin datos personales; se guardan 30 días).
- **Respaldos:** en Pro, Supabase hace copias diarias. Además, antes de cada
  migración: `npx supabase db dump --linked -f backup.sql` (contiene datos
  personales: guardar cifrado y fuera del repositorio).
- **Interruptores** (SQL, en `private.platform_features`): `guest_checkout`
  (compra sin cuenta), `merchant_signup` (altas), `founding_community`
  (preinscripción). Apagarlos corta esa función en la base, no sólo en la interfaz.
