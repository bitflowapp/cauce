# CAUCE · Aluminé

Plataforma local de LUNA para que los comercios de Aluminé (Neuquén) vendan con
retiro o con envío propio, y los vecinos compren sin intermediarios de pago.

- Un comercio se da de alta, carga su catálogo, sus horarios y su contacto, y
  pide la publicación; administración la revisa.
- Una persona compra **sin crear cuenta** (sesión anónima real), sigue su
  pedido en vivo o por un enlace, y paga en efectivo al retirar o al recibir.
- El comercio atiende desde su panel, también desde el teléfono: ventas del
  día en vivo, tablero de pedidos por estado, catálogo, horarios,
  configuración, reparto propio y equipo con roles.
- La persona que reparte para un comercio entra con su cuenta a **Mis
  entregas** (`#entregas`): retira, sale, llega y entrega con el código del
  cliente, sólo en los pedidos que su comercio le asignó.
- La administración revisa altas, suspende y rehabilita, y ve el día del
  piloto: pedidos, completados, volumen bruto y lo que necesita atención.

**Estado: plataforma piloto publicada** en https://bitflowapp.github.io/cauce/,
conectada al proyecto Supabase `ygqbcvxdrewcnzedfcyo`, para 5 a 20 comercios de
Aluminé. Cómo se verificó, qué falta (una acción humana: que la cuenta de
administración elija su contraseña) y cómo se opera:
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

---

## Entornos

La misma aplicación (`js/`) corre sobre tres repositorios con la misma
interfaz. Cuál se usa se decide **al compilar** (`js/runtime-env.js` se
reemplaza en el build): no hay detección automática ni caída silenciosa de un
backend a datos de demostración.

| | Producción (Supabase) | Demostración | Backend de desarrollo |
| --- | --- | --- | --- |
| Build | `npm run build:production` → `dist-production/` | `npm run build` → `dist/` | `npm run dev` |
| Datos | Supabase: Postgres con RLS, Auth, Storage, Realtime | `localStorage` del navegador | SQLite local (`.local/`) |
| Identidad | Correo + contraseña; sesión anónima para comprar | Identidades de ejemplo | Correo + contraseña, cookie HttpOnly |
| Autoridad | Funciones SQL del servidor | El navegador | El servidor local |
| Red | Sólo el proyecto Supabase (CSP) | `connect-src 'none'` | Mismo origen |

GitHub Pages publica el build de producción: `.github/deploy-target` vale
`production` (o la variable del repositorio `CAUCE_DEPLOY_TARGET`). Para volver
a la demostración sin tocar código, ver
[PRODUCTION_READINESS.md §3.7](PRODUCTION_READINESS.md#37-rollback).

---

## Desarrollo

### Requisitos

- Node.js 22 o posterior.
- Docker, para el stack Supabase local (Postgres, Auth, REST, Storage,
  Realtime y Mailpit). La CLI de Supabase viene como dependencia.

### Instalación

```bash
npm ci
```

### Variables de entorno

Ninguna es obligatoria para desarrollar. Están documentadas en
[`.env.example`](.env.example) (sin secretos). Los scripts leen el entorno del
proceso; `.env` no se carga solo y nunca se versiona.

### Stack Supabase local

```bash
npm run db:start      # levanta el stack y aplica supabase/migrations (sin datos de ejemplo)
npm run db:reset      # vuelve a crear la base desde las migraciones
npm run db:stop
```

Los correos (confirmación, recuperación) llegan a Mailpit:
<http://127.0.0.1:54324>. Las claves que muestra `npx supabase status` son
las de demostración del stack local.

### Correr la app conectada, en local

```bash
npm run dev:supabase  # build de producción contra el stack local + http://127.0.0.1:4174
```

Para crear un administrador local, después de registrarte y confirmar el
correo en Mailpit:

```bash
docker exec supabase_db_cauce psql -U postgres -c \
  "insert into private.platform_admins (user_id) select id from auth.users where email = 'vos@ejemplo.com';"
```

### Demostración y backend de desarrollo

```bash
npm start             # demostración: http://127.0.0.1:4173 (todo en tu navegador)
npm run dev:seed      # backend SQLite: http://127.0.0.1:4180, cuentas sintéticas en .local/
```

---

## Pruebas

| Comando | Qué prueba | Necesita |
| --- | --- | --- |
| `npm run lint` | ESLint sobre todo el repositorio | — |
| `npm run typecheck` | TypeScript `checkJs` sobre `js/` | — |
| `npm run check` | Sintaxis, imports, copy, orígenes y CSP | — |
| `npm test` | Unitarias: dominio, horarios, telemetría, repositorio, service worker | — |
| `npm run test:db` | Migraciones y RLS en Postgres embebido (PGlite), incluida la actualización con datos legados | — |
| `npm run test:integration` | Seguridad multi-comercio, pedidos, auth con correo real, storage y realtime | `npm run db:start` |
| `npm run e2e:local` | Recorridos en Chromium y WebKit sobre el build de producción | stack local + navegadores de Playwright |
| `npm run smoke:production` | Sólo lectura contra el proyecto y el sitio reales | red |
| `npm run verify` | lint + tipos + check + unitarias + SQL + los tres builds | — |

Las pruebas de integración y E2E **se niegan a correr contra un host que no sea
local**. La E2E usa los navegadores de Playwright (`npx playwright install
chromium webkit`); las suites heredadas de la demostración (`npm run e2e`,
`e2e:demo`, `audit:visual`) usan Chrome vía DevTools (`CAUCE_CHROME_PATH`).

CI (`.github/workflows/ci.yml`) corre todo esto en cada push y pull request,
con un stack Supabase efímero en el runner y sin secretos.

---

## Producción

- **Build:** `npm run build:production` valida la URL (https,
  `<ref>.supabase.co`) y la clave (rechaza secret/service_role), minifica,
  nombra los archivos por contenido, genera la CSP, el service worker
  versionado, OpenGraph, canonical, `robots.txt` y `404.html`, y falla si el
  bundle trae credenciales o código de la demostración.
- **Migraciones:** `supabase/migrations/`, hacia adelante, aplicadas con
  `npx supabase db push`. La app exige una versión mínima de esquema
  (`js/core/contract.js`) y el deploy se niega a publicar si el proyecto no la
  tiene.
- **Deploy:** `.github/workflows/pages.yml`, con el destino de
  `.github/deploy-target` (o la variable `CAUCE_DEPLOY_TARGET`); verifica el
  esquema antes y el sitio después. El smoke de sólo lectura corre además
  todos los días (`.github/workflows/smoke.yml`).
- **Rollback, backups, secretos, primer comercio y límites conocidos:**
  [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

---

## Arquitectura

```
js/core/          reglas puras: carrito, estados, horarios, validación, telemetría
js/domain/        comandos y consultas del dominio (demo y backend de desarrollo)
js/repositories/  local (demo), http (desarrollo) y supabase (producción)
js/ui/            formato, íconos, diálogos, avisos de pedido, herramientas del panel
js/app.js         shell: enrutador por hash, vistas, acciones y arranque
supabase/         migraciones, plantillas de correo, config local y remota, tipos
scripts/          builds, servidores, configuración de Auth, comprobaciones
tests/            unitarias, db (PGlite), integration y e2e (Supabase local)
```

- **Frontend.** SPA estática en JS sin framework, enrutador por hash (sirve
  en GitHub Pages bajo `/cauce/`). Cada vista vuelve a consultar por la vía
  normal; los eventos de Realtime sólo disparan esa consulta, nunca se pintan
  directamente. Si Realtime se corta, el panel consulta cada 30 s.
- **Auth.** Supabase Auth con correo y contraseña (mínimo 10 caracteres,
  letras y números; en el proyecto real, además, se rechazan contraseñas
  filtradas), confirmación
  obligatoria, enlaces `token_hash` que funcionan en otro dispositivo, refresh
  rotativo. Para comprar sin cuenta, una sesión anónima real: RLS la limita a
  pedir, ver y cancelar sus propios pedidos; todo lo demás exige cuenta
  permanente (claim `is_anonymous` verificado en SQL).
- **Base de datos.** Dinero en enteros (pesos), total = subtotal + envío por
  `check`, snapshot de cada línea, claves compuestas que impiden mover un
  producto a otro comercio, horarios por día en la zona horaria de la
  localidad.
- **RLS y permisos.** RLS en todas las tablas; grants por columna; ninguna
  escritura directa sobre pedidos: todo pasa por funciones `SECURITY DEFINER`
  en el esquema `private` con envoltorios `SECURITY INVOKER` en `public`.
  Roles por comercio: owner, manager, staff. Administración en
  `private.platform_admins`, nunca en `user_metadata`.
- **Pedidos.** `create_order` resuelve precios, envío, total y stock en el
  servidor, con idempotencia durable, total confirmado (si el precio cambió,
  no crea el pedido) y límites contra abuso. `transition_order` aplica la
  máquina de estados de `private.order_transitions` por rol y modalidad, con
  control de versión, motivo obligatorio al rechazar o cancelar e historial.
- **Observabilidad.** Errores de interfaz, de Supabase, de sesión y pedidos
  fallidos van a `private.client_events` sin datos personales, con tope por
  minuto; administración los ve en su pantalla.

Más detalle: [docs/AUDITORIA-PRODUCCION.md](docs/AUDITORIA-PRODUCCION.md)
(hallazgos y su resolución), [docs/CAUCE-CONECTADO.md](docs/CAUCE-CONECTADO.md)
(decisiones de seguridad del modelo), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
(demostración y backend de desarrollo).
