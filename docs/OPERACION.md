# Operación del proyecto remoto

Herramienta: `scripts/operacion.mjs` (con `scripts/lib/`), que se corre desde la
terminal (`npm run operacion -- <paso>`) o desde el workflow manual
**Operación de Ferias** (`.github/workflows/operacion.yml`). Sirve recién cuando
LUNA Proyectos autorice y cree el proyecto Supabase de Ferias. Hasta entonces
se ensaya entera contra el stack local con `--local`.

Reglas que valen en todos los pasos:

- **Sin `--aplicar` no se escribe nada**: el paso muestra qué haría.
- **Con `--aplicar` hay que repetir el ref**: `--confirmar <ref>` (en local, `--confirmar local`). Si no coincide, no se hace nada.
- **Nunca el proyecto de Aluminé** (`ygqbcvxdrewcnzedfcyo`): se rechaza antes de cualquier conexión, igual que en `scripts/build.mjs`.
- **Ningún secreto en pantalla**: de los secretos se muestran sólo los nombres (✔ cargado, ✘ falta). Tokens, claves y contraseñas se ocultan en toda salida.
- **Evidencia**: cada corrida deja `evidence/operacion-<paso>.json`, sin secretos (en local, `operacion-<paso>-local.json`).
- **Salida**: termina con código 1 si alguna comprobación queda en rojo.

## Secretos y variables

| Nombre | Lo usa | Notas |
| --- | --- | --- |
| `FERIAS_PROJECT_REF` | todos los pasos remotos | ref del proyecto de Ferias (20 letras). Conviene cargarlo como *variable* del entorno |
| `SUPABASE_ACCESS_TOKEN` | todos los pasos remotos | token personal (<https://supabase.com/dashboard/account/tokens>) de una cuenta con acceso al proyecto |
| `SUPABASE_DB_PASSWORD` | `migrar`, `respaldo` | opcional: sin ella la CLI usa un rol temporal de la API |
| `FERIAS_SITE_URL` | `auth` | dirección pública del sitio, https. Conviene cargarla como *variable* |
| `FERIAS_SMTP_HOST`, `FERIAS_SMTP_PORT`, `FERIAS_SMTP_USER`, `FERIAS_SMTP_PASS`, `FERIAS_SMTP_SENDER` | `auth` | SMTP propio: las cinco o ninguna. Remitente con la forma `CAUCE · Ferias <hola@dominio>` |
| `FERIAS_BACKUP_PASSPHRASE` | `respaldo` | 16+ caracteres. Sin ella no se arma la copia cifrada. Guardarla también fuera de GitHub: sin la frase la copia no se puede abrir |

En GitHub: Settings → Environments → `produccion` (conviene exigir revisores
del entorno). Si al workflow le falta un secreto que pide el paso, falla con el
nombre del que falta antes de instalar nada.

## Pasos

### `estado` (sólo lectura)

```bash
npm run operacion -- estado            # proyecto remoto
npm run operacion -- estado --local    # stack local (npm run operacion:local)
```

Verifica o informa:

- qué secretos están cargados (sólo los nombres);
- que el proyecto existe y está `ACTIVE_HEALTHY` (API de administración);
- las migraciones del repo contra `supabase_migrations.schema_migrations`: aplicadas, pendientes, ninguna desconocida para el repo y ninguna pendiente más vieja que la última aplicada;
- el contrato de esquema: `public.app_status()` por SQL y por la API pública, con `schema` ≥ `CONFIG.requiredSchema` (`js/config.js`);
- resumen de Auth (site URL, URLs de retorno, confirmación, anónimas, contraseña, SMTP, plantillas, tope de anónimas) y cuántas diferencias hay con lo que aplicaría `auth`;
- los backups automáticos de Supabase (cantidad, último, PITR).

### `migrar`

```bash
npm run operacion -- migrar                                   # dry-run
npm run operacion -- migrar --aplicar --confirmar <ref>
npm run operacion -- migrar --ensayo [--local]                # sólo el ensayo, sin aplicar
```

1. Vincula la CLI (`supabase link`) y muestra `migration list`.
2. Se detiene si el proyecto tiene migraciones que el repo no conoce o si alguna pendiente es más vieja que la última aplicada.
3. `db push --dry-run` tiene que listar exactamente las pendientes.
4. Con `--aplicar`, **antes de tocar el proyecto**, ensaya: dump de los datos reales → stack temporal (`cauce-ferias-ensayo`, puertos 56430–56439) con las migraciones ya aplicadas → carga de los datos → `db push` de las pendientes → verificación (abajo). Si el ensayo falla, no se aplica nada.
5. `db push`, y después: repo y proyecto sincronizados y contrato vigente.

### `auth`

```bash
FERIAS_SITE_URL=https://<sitio> npm run operacion -- auth     # plan de cambios
npm run operacion -- auth --aplicar --confirmar <ref>
```

Arma la configuración desde las mismas fuentes que el stack local y la manda
con `PATCH /v1/projects/<ref>/config/auth`:

- `site_url` = `FERIAS_SITE_URL`; URLs de retorno `<sitio>/index.html` y `<sitio>/` (sin comodines);
- confirmación de correo obligatoria, cambio de correo con doble confirmación, reautenticación para cambiar la contraseña, vencimiento y largo de los códigos (de `supabase/config.toml`);
- contraseña de 10+ caracteres con letras y números; rotación de refresh tokens;
- sesiones anónimas habilitadas (compra sin cuenta);
- topes por IP: 150 sesiones anónimas por hora; 30 ingresos o altas, 150 renovaciones y 30 verificaciones cada 5 minutos; con SMTP, 30 correos por hora y uno por minuto por casilla;
- SMTP desde `FERIAS_SMTP_*` y, sólo junto con el SMTP, las plantillas de `supabase/templates/` (tienen que usar `{{ .TokenHash }}`) con los asuntos de `config.toml`.

Muestra cada valor actual → nuevo (la contraseña SMTP como «oculta»). Con
`--aplicar` vuelve a leer la configuración y comprueba que todo quedó igual a lo
previsto y que la confirmación sigue obligatoria. No corre con `--local`: en
local rige `config.toml`.

### `admin`

```bash
npm run operacion -- admin --email persona@dominio
npm run operacion -- admin --email persona@dominio --aplicar --confirmar <ref>
```

La persona se registra antes en el sitio publicado. Comprueba que la cuenta
existe, confirmó el correo y no es anónima; con `--aplicar` inserta su `user_id`
en `private.platform_admins`, deja el hecho en `private.audit_log`
(`admin_granted`) y verifica que quedó. Informa cuántas cuentas de
administración hay y que la tabla no se expone por la API.

### `respaldo`

```bash
FERIAS_BACKUP_PASSPHRASE=… npm run operacion -- respaldo [--fotos]
FERIAS_BACKUP_PASSPHRASE=… npm run operacion -- respaldo --local [--fotos]
```

1. Informa los backups automáticos de Supabase (remoto).
2. Conteos de filas y dump lógico con la CLI: esquema y datos (`--data-only --use-copy`) **sin** sesiones, refresh tokens, códigos de un solo uso, registro de Auth ni tablas de MFA/SSO/OAuth.
3. Manifiesto de Storage de `ferias-media` (nombre, tamaño, tipo, etag, fecha). Con `--fotos` también baja cada archivo, comprueba su tamaño y anota su SHA-256.
4. Empaqueta (`tar.gz`) y cifra con `gpg --symmetric --cipher-algo AES256` con `FERIAS_BACKUP_PASSPHRASE` → `backup/cauce-ferias-<ref>-<fecha>.tar.gz.gpg` (carpeta ignorada por git). Después la descifra en memoria y comprueba que trae todo. Lo que no está cifrado vive en una carpeta temporal y se borra al terminar.
5. **Prueba de restauración**: stack temporal `cauce-ferias-restauracion` (puertos 56420–56429) con las migraciones del repo que tiene el origen → carga de los datos → conteos iguales a los del origen en todas las tablas → esquema restaurado igual al del origen (cualquier diferencia es un cambio hecho a mano) → verificación (abajo) → `RESTORE_TEST`.

En el workflow, la copia cifrada se sube como artefacto `ferias-respaldo-<run>`
con 30 días de retención.

Para abrir una copia:

```bash
gpg --decrypt cauce-ferias-<ref>-<fecha>.tar.gz.gpg | tar -xz
```

Restaurar en un proyecto nuevo: `supabase db push` con las migraciones del
repo y después `psql <url> -v ON_ERROR_STOP=1 -f data.sql` (como lo hace la
prueba). Las fotos, si se incluyeron, se vuelven a subir a `ferias-media` con
las mismas rutas.

### Verificación de una base restaurada o ensayada

- `app_status()` responde por SQL y por la API con el esquema que exige la interfaz;
- RLS activo en todas las tablas de `public` y `private`;
- políticas de Storage sobre `ferias-media` presentes y el bucket existe;
- una visita ve por la API exactamente las tiendas, productos y ferias que RLS le permite a `anon` en SQL;
- una visita no lee `orders`, `founding_applications` ni `platform_admins`.

## Stacks temporales

Usan `project_id` y puertos propios para no chocar con nada:

| Stack | project_id | Puertos |
| --- | --- | --- |
| Ferias local | `cauce-ferias` | 55420–55429 |
| Restauración | `cauce-ferias-restauracion` | 56420–56429 |
| Ensayo de migración | `cauce-ferias-ensayo` | 56430–56439 |
| Aluminé local / sus temporales | — | 5432x / 5532x |

Se apagan con `supabase stop --no-backup` al terminar, incluso si algo falla.
Necesitan Docker, la CLI de Supabase (dependencia del repo), `psql` y `gpg`
(presentes en `ubuntu-latest`).

## Ensayo local completo (sin proyecto remoto)

```bash
npm run db:start && npm run seed:demo
npm run operacion -- estado --local
FERIAS_BACKUP_PASSPHRASE=frase-de-prueba-larga npm run operacion -- respaldo --local --fotos
npm run operacion -- migrar --local --ensayo
npm run operacion -- admin --local --email demo.raices@ferias.test
```

## Workflow

**Actions → Operación de Ferias → Run workflow**. Entradas: `paso` (estado,
migrar, auth, admin, respaldo), `aplicar`, `confirmar` (el ref, para escribir),
`email` (paso admin) y `fotos` (paso respaldo). Corre en el entorno
`produccion`, con `contents: read`, y sólo a mano: no tiene ejecuciones
programadas.

Paso opcional para más adelante: un respaldo semanal se agrega con un
`schedule` (por ejemplo `cron: '17 6 * * 1'`) que fije `paso=respaldo`, una vez
que el proyecto exista y los secretos estén cargados.
