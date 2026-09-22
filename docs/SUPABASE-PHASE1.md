# CAUCE conectado — fase 1

> Histórico de la primera etapa conectada, con cuentas y comercios solamente.
> El estado vigente —catálogo, imágenes, pedidos, reparto, taxi y sincronización
> en vivo— está en [CAUCE-CONECTADO.md](CAUCE-CONECTADO.md). Lo que sigue
> describe cómo quedó esta base y qué límites tenía; la advertencia de
> contraseñas filtradas ya se resolvió y las plantillas de correo se
> reescribieron en castellano.

Proyecto exclusivo: `cauce-production` (`ygqbcvxdrewcnzedfcyo`), Luna Systems,
`sa-east-1`. URL: https://ygqbcvxdrewcnzedfcyo.supabase.co.
Rama: `feat/cauce-production-foundation`. No hubo merge ni deploy público.
No se creó infraestructura adicional ni se modificó ningún otro proyecto.

## Estado y bloqueo

**La fase 1 todavía no está verde.** El usuario confirmó que CAUCE no dispone
de SMTP propio. Faltan entrega real de confirmación/recuperación y el recorrido
de registro público con una casilla autorizada. No se desactivó la confirmación
ni se reemplazó por una simulación. No se avanzó a catálogo ni Storage.

Hay autenticación real, perfil y comercios compartidos en Supabase. El preview
es local; no equivale a un sitio publicado ni a una prueba en iPhone físico.
No hay pedidos, delivery, taxis ni Realtime productivos habilitados.

## Código y operación

- `js/repositories/supabase-repository.js` implementa Auth, lectura/edición de
  perfiles, localidades, alta/lectura/renombrado de comercios y lectura de permisos.
  Adapta los contratos del shell existente. No ejecuta el dominio con fixtures ni
  cambia a localStorage ante un error del backend.
- El SDK `@supabase/supabase-js` está fijado en 2.116.0. Maneja sesiones, rotación y
  persistencia bajo `cauce:production:auth`, separado del almacenamiento demo.
  Los tokens pertenecen a la sesión del navegador; no se escriben en logs, Git ni
  evidencia. No hay service/secret key en el frontend.
- El registro usa email/contraseña y exige confirmación. Login valida la cuenta
  mediante Auth; los permisos se leen de tablas. El perfil se crea de forma
  idempotente al entrar con una cuenta confirmada. La metadata se utiliza sólo
  para inicializar nombre/teléfono, nunca roles.
- Recuperación usa el SDK: solicitudes de correo y cambio seguro de contraseña.
  El callback soporta PKCE y enlaces con `token_hash`/`type`; elimina el token de
  la URL antes de verificarlo. El token real de recuperación se prueba sin SMTP
  generándolo con la API administrativa de test; esto no prueba entrega de email.
- El preview expone sólo capacidades de fase 1. Las demás rutas informan que no
  están habilitadas; no crean operaciones simuladas. La demo conserva sus rutas.
- Sin red se bloquean los formularios conectados y se conserva lo escrito al
  reconectar. Los errores de servidor no se presentan como confirmaciones.

Para abrir el preview:

```powershell
npm ci
npm run dev:supabase
```

Abrir `http://127.0.0.1:4174`. Sin SMTP, el usuario necesita una cuenta confirmada
para probar login. No se dejaron cuentas sintéticas ni contraseñas de prueba.

`build:supabase` genera `.local/supabase-preview` y no modifica `dist`. Inyecta la
publishable key y un destino CAUCE exacto, valida el build contra claves secretas,
agrega CSP acotada al proyecto y `no-referrer`. La aplicación permanece JS vanilla.
El service worker de demo no se registra en este preview separado; habilitar PWA
con cachés productivas segregadas queda para el hardening antes de publicar.

`npm run build` y `npm run build:offline` siguen generando exclusivamente demo,
con conexiones externas bloqueadas. La CI de rama comprueba también que el build
conectado se pueda generar, pero no ejecuta pruebas remotas con claves elevadas
ni publica ese artefacto automáticamente.

## Migraciones y configuración

Ambas migraciones se aplicaron con CLI, preservando versiones en el historial:

1. `20260922010136_identity_tenancy_foundation.sql`.
2. `20260922012118_authenticated_access_contract.sql`: RPC de lectura `my_access`
   SECURITY INVOKER y política explícita de denegación en `private.platform_admins`.

`supabase/database.types.ts` fue generado desde este proyecto real. El vínculo
local de CLI está en `.temp` ignorado; `supabase/project.json` versiona sólo el
destino y la publishable key pública. No se debe cambiar para apuntar a otro cliente.

`supabase/config.toml` sigue siendo la configuración local. Para el proyecto
remoto se utilizó únicamente `supabase/remote/supabase/config.toml`, que declara
los ajustes intencionales y deja los demás intactos:

- API expone sólo `public`.
- Contraseña de al menos 10 caracteres, letras y números.
- Confirmación de correo y cambios seguros de email/contraseña.
- Rotación de refresh tokens; login anónimo deshabilitado.
- Site URL de preview `http://127.0.0.1:4174` y callback exacto `/index.html`.

Antes de publicar, reemplazar/agregar las URLs reales verificadas y revisar la
allowlist. No usar callbacks con comodines amplios. Nunca empujar el template
local completo al remoto: contiene defaults que no son decisiones productivas.

## Autorización comprobada

RLS está activo en `profiles`, `localities`, `businesses`, `business_memberships`
y `private.platform_admins`. Grants de columnas impiden modificar identidades,
localidad, estado y timestamps desde la cuenta. UPDATE tiene USING/WITH CHECK.

- Perfil: lectura y escritura propias, tampoco accesible indiscriminadamente a admin.
- Negocio: borradores sólo para miembros/admin; lectura pública sólo cuando activo.
- Owner/manager: editan nombre; staff sólo lee. Ninguno cambia permisos o status.
- Membresías: lectura propia, sin escritura directa desde clientes.
- Admin: rol consultado en tabla privada, jamás derivado de user_metadata.
  La prueba provisiona un admin sintético por SQL y lo elimina al terminar.
  No se creó una cuenta administradora permanente ni se inventó su identidad.
- El alta comercial es atómica y establece al llamante autenticado como dueño.
- No hay SECURITY DEFINER en `public`; los helpers privilegiados quedan en
  `private`, con permisos restringidos, search_path vacío y validación de identidad.

La revisión administrativa en esta fase es de lectura. Aprobación requiere primero
el catálogo y los requisitos del workflow original; no se agregó un botón que
publique un negocio incompleto.

## Pruebas reproducibles y evidencia

Resultados comprobados en esta continuación:

| Suite | Resultado |
| --- | --- |
| `verify`: check, tests existentes, migraciones locales y builds demo | PASS; 172 tests + 14 pruebas SQL |
| API real Supabase | 12 comprobaciones aprobadas con ocho identidades |
| E2E real Supabase | 10 pasos aprobados en dos navegadores independientes |
| E2E SQLite existente | 37 pasos, cero fallos |
| E2E demo existente | 12 pasos, cero fallos |
| Auditorías visuales demo y SQLite | 64 pantallas, cero hallazgos |
| Preview conectado, 360/390/430/1440 px | 8 pantallas sin overflow, botones bajos ni enlaces ocultos visibles |

Una consulta posterior contra CAUCE confirmó cero usuarios, negocios y roles
administrativos sintéticos remanentes. La auditoría de seguridad no detectó
problemas SQL después de documentar la denegación explícita en la tabla privada;
sí conserva la advertencia de contraseñas filtradas descrita más abajo.

```powershell
npm run verify
npm run test:supabase
npm run e2e:supabase
```

Las pruebas remotas tienen el destino CAUCE fijado. Requieren CLI autenticada;
obtienen la clave de pruebas de servidor sólo en memoria, sin imprimirla. Crean
cuentas sintéticas, hacen requests con publishable key y JWT de cada identidad,
y eliminan sus negocios y usuarios al finalizar. No ejecutarlas en paralelo con
otras pruebas que usen el puerto fijo de preview 4174.

La suite API incluye ocho cuentas: clientes A/B, comercios A/B, taxista A, admin,
manager y staff. Comprueba login, perfiles, permisos administrativos reales,
persistencia entre sesiones, renovación revocada tras logout, cambio de contraseña,
token de recuperación de un uso, acceso anónimo, aislamiento comercial y rechazo
de autoaprobación/escalamiento por metadata o membresías.

El E2E usa dos perfiles de Chrome independientes (390 y 1440 px), registra un
comercio desde la UI, lo lee/modifica desde otra sesión, prueba acceso ajeno,
logout, recarga, callback de recuperación y desconexión. La sincronización en
esta fase se comprueba con recarga: **no se afirma Realtime**.

Resultados/capturas locales (sin contraseñas ni tokens):

- `evidence/supabase-phase1-api.json`.
- `evidence/supabase-phase1-browser.json`.
- `evidence/supabase/`.
- `evidence/supabase-visual.json` (ejecutar `node tests/visual-supabase.mjs` después del build conectado).
- `evidence/e2e-results.json`, `demo-results.json` y auditorías existentes.

El probe de signup con una dirección `example.com` fue rechazado con
`email_address_invalid`: **es inconcluso respecto de SMTP**. La ausencia de SMTP
propio fue confirmada expresamente por el usuario. No confundir cuentas creadas
por Admin API para pruebas con registro público validado de punta a punta.

## Pendientes antes de cerrar fase 1

1. Configurar SMTP exclusivo de CAUCE y remitente verificado, sin reutilizar
   secretos de otros proyectos ni contratar servicios sin autorización.
2. Autorizar una casilla real de QA; probar registro desde UI, llegada del correo,
   confirmación, login, recuperación desde UI, llegada del enlace, cambio de clave,
   rechazo de clave anterior y de reutilización del enlace.
3. Revisar la advertencia de Supabase Advisors sobre protección contra contraseñas
   filtradas desactivada. [Remediación oficial](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
   No se cambió de plan ni contrató ningún complemento para habilitarla.
4. Configurar URLs de hosting verificadas y elegir la cuenta administradora real
   antes de un piloto público. Revisar recuperación entre navegadores con PKCE.

Sólo después de cerrar esos recorridos continuar con catálogo y Storage. No hay
pruebas RLS de pedidos, taxis o imágenes en esta entrega porque esa infraestructura
todavía no se implementó.
