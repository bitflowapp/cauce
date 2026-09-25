# Base productiva: entrega parcial y verificable

> Histórico de la preparación inicial. El estado posterior a conectar el proyecto
> real está en [SUPABASE-PHASE1.md](SUPABASE-PHASE1.md). El proyecto ya existe;
> el bloqueo de creación/costo descrito abajo quedó resuelto por el usuario.

Fecha: 21 de septiembre de 2026 (Argentina).
Rama: `feat/cauce-production-foundation`, desde `ab57bdb`.

## Estado real

La aplicación sigue siendo la demo y el backend SQLite de desarrollo. **No está
conectada a Supabase y no está lista para un piloto con usuarios reales.** No se
habilitaron pedidos, viajes ni pagos productivos. No hubo deploy, merge ni
modificaciones a infraestructura externa.

Supabase MCP permitió listar la organización Luna Systems y sus proyectos.
`cauce-production` no existe. `get_cost` cotizó **USD 10 por mes** para crear un
proyecto en esa organización. La creación está pendiente de autorización. Esa
cotización no garantiza que la factura total (consumo, servicios adicionales,
impuestos) sea USD 10. Región prevista: `sa-east-1`.

No se consultaron tablas, claves, archivos ni configuración de otros proyectos.
Este repositorio no está enlazado a un proyecto remoto.

## Qué se implementó

La migración `20260922010136_identity_tenancy_foundation.sql`, creada con Supabase
CLI 2.117.0, agrega:

- `localities`, con Aluminé como dato de referencia.
- `profiles`, con lectura, inserción y edición propias. Ni administración puede
  leer indiscriminadamente los perfiles. No almacena contraseñas.
- `businesses`, con identidad pública mínima y estados compatibles con el dominio.
  Contactos privados, catálogo y configuración comercial pertenecen a la siguiente
  entrega vertical; no se almacenan en una fila de lectura pública.
- `business_memberships`: `owner`, `manager`, `staff`. Cada cuenta lee sólo sus
  membresías; no puede crearlas, cambiarlas ni eliminarlas directamente.
- `private.platform_admins`, sin acceso de tabla desde clientes; no hay admin
  inicial ni mecanismo de autoasignación.
- RPC `create_business`, que crea un borrador y su dueño en una transacción.
  Requiere perfil propio, localidad activa y sesión. No recibe owner ni status.

Todas las tablas tienen RLS. Se revocan grants predeterminados y se conceden
operaciones/columnas explícitas. UPDATE usa USING y WITH CHECK. El cliente no
puede modificar estado, identidad ni localidad del comercio. Owner y manager
pueden editar nombre/slug; staff sólo leer. El administrador sólo puede revisar
las filas comerciales en esta etapa: la aprobación aún no tiene API.

Las tres funciones SECURITY DEFINER están en `private`, fuera de los esquemas
expuestos, con search_path vacío, EXECUTE restringido y validación de auth.uid().
Dos hacen consultas de permisos sin recursión RLS y una crea negocio/membresía
atómicamente. El wrapper público es SECURITY INVOKER. No se usa user_metadata
para autorización. El rol administrativo sólo se provisionará por un operador
identificado, una vez elegido el proyecto CAUCE.

`supabase/config.toml` es **configuración local**, no configuración aplicada a un
proyecto remoto. Expone sólo `public`, desactiva grants automáticos, exige
confirmación de correo, contraseña de 10 caracteres con letras y números,
rotación de refresh tokens y cambio seguro de contraseña. La URL local 3000 es
preparatoria: aún no hay frontend Auth conectado allí.

## Verificación y sus límites

Antes de modificar archivos se ejecutó `npm run verify:full` sobre main actualizado:

| Comprobación | Resultado |
| --- | --- |
| Check, hashes heredados, build y bundle offline | PASS |
| Tests existentes | 172 aprobados |
| Browser E2E SQLite, sesiones independientes | 37 pasos, cero fallos |
| Browser E2E demo | 12 pasos, cero fallos |
| Auditoría visual demo | 32 pantallas, cero hallazgos |
| Auditoría visual SQLite | 32 pantallas, cero hallazgos |

Las capturas y JSON están en `evidence/` (ignorados por Git). La auditoría usa
Chrome con emulación móvil, no un iPhone físico.

`npm run test:db` reconstruye la migración desde cero y ejecuta 14 pruebas sobre
PostgreSQL embebido con PGlite 0.5.8, dependencia exclusiva de desarrollo. Cambia
de rol SQL y de identidad por transacción. No sustituye las políticas por mocks.
La tabla de usuarios y auth.uid() del servicio se representan mediante fixtures
de prueba: **esto no prueba autenticación JWT ni Supabase Auth**.

Identidades sintéticas: clientes A/B, comercios A/B, taxista A, admin, manager y
staff. Se probaron accesos propios y denegaciones: perfil ajeno, modificación de
comercio ajeno, autoaprobación, escalamiento por metadata, autoasignación de roles,
cambio de localidad/owner, eliminación de membresías y acceso anónimo. También
se verificaron rollback de altas fallidas y RLS en todas las tablas.

Después del cambio, `npm run verify` terminó con código 0: check, los 172 tests
existentes, las 14 pruebas SQL, build y bundle offline. No se repitieron los E2E
porque no cambió ningún archivo de runtime, dominio, UI, servidor o service worker.

No hay Docker ni psql disponibles en esta máquina. `supabase status` confirmó
`linked_project: null` y falló porque no encuentra Docker ni Podman; no se intentó
enlazar ni iniciar una base de otro proyecto. Falta reproducir la migración
y las pruebas con el stack Supabase completo, ejecutar advisors y verificar
PostgREST. PGlite tiene una sola conexión; estos tests **no prueban carreras**.
No se probaron RLS de pedidos/taxis/Storage porque esas tablas y políticas todavía
no están implementadas. No hay E2E Supabase ni sincronización entre dispositivos
por internet.

La CI de ramas ahora instala el lockfile, ejecuta estas pruebas y considera
obligatorios los E2E y ambas auditorías. La configuración de CI no se ejecutó en
GitHub en esta entrega.

## Continuación sin cambiar el dominio

Cerrar primero la fase 1 con Supabase Auth real y su integración en la interfaz:
registro, confirmación, login, logout, recuperación, actualización segura y
persistencia de sesión. El repositorio Supabase deberá adaptar los contratos
existentes; no copiar todo `domain_state` a una columna JSON ni reemplazar el
motor probado. No hay repositorio Supabase agregado todavía.

Mantener carritos en el cliente hasta checkout, separados por cuenta, localidad
y comercio. Cotización y checkout deberán resolver catálogo/stock/precios en el
backend dentro de la transacción. Pedidos necesitan snapshot e idempotencia
durable; taxi necesita aceptación atómica. Las reglas compartidas seguirán en
`js/core/` y `js/domain/`, con pruebas de paridad cuando Postgres imponga una
restricción equivalente. No ampliar fases hasta verificar la anterior.

Luego: comercios/catálogo/Storage; pickup; delivery/repartidores; Realtime pedidos;
taxi atómico; Realtime taxi; hardening y pruebas negativas integrales. El rider
actual es un registro operado por el comercio, no una cuenta independiente: ese
acceso debe implementarse y probarse para cumplir el recorrido pedido.

Preservar demo como artefacto sin red. Producción requerirá un build explícito
con URL y publishable key exclusivamente de CAUCE, CSP acotada, caché separada y
errores visibles; nunca fallback al repositorio local. Los tokens y respuestas
privadas no deben entrar en el service worker. La compuerta actual continúa cerrada.

## Requisitos externos pendientes

1. Autorizar creación de `cauce-production` por el costo cotizado, o habilitar un
   stack Supabase local con Docker para cerrar la fase 1 sin infraestructura paga.
2. Configurar SMTP propio de CAUCE y un remitente verificado para confirmaciones
   y recuperación. El SMTP predeterminado sólo permite destinatarios del equipo;
   no sirve para abrir el registro a vecinos. No se eligió proveedor ni contrató
   servicio, ni se reutilizaron credenciales de otros sistemas.
3. Definir la cuenta inicial administradora y URLs definitivas al habilitar el
   proyecto. No inventar identidad admin, dominio ni allowlist de callbacks.

## Documentación vigente revisada

- [Changelog](https://supabase.com/changelog.md).
- [Auth con contraseña](https://supabase.com/docs/guides/auth/passwords).
- [SMTP para producción](https://supabase.com/docs/guides/auth/auth-smtp).
- [RLS y grants](https://supabase.com/docs/guides/database/postgres/row-level-security).
- [Publishable y secret keys](https://supabase.com/docs/guides/api/api-keys).
- [Storage y upsert](https://supabase.com/docs/guides/storage/security/access-control).
- [Realtime privado](https://supabase.com/docs/guides/realtime/authorization).
- [Cambio de julio: schema realtime protegido](https://supabase.com/changelog/realtime-schema-locked-down-against-modification).
- [PGlite, alcance del motor embebido](https://pglite.dev/docs/).

Para Realtime sólo se podrán administrar políticas sobre realtime.messages; no
crear objetos en ese esquema. Storage upsert necesita INSERT, SELECT y UPDATE.
Las publishable keys son públicas, las secret keys nunca van al frontend.
