# Despliegue de CAUCE · Ferias Neuquén

> **Estado:** preparado, **no ejecutado**. LUNA Proyectos todavía no autorizó
> crear el proyecto Supabase remoto ni publicar el sitio. Nada de este
> documento se hizo; cada paso con costo o visibilidad pública está marcado 🔒.

## 1. Arquitectura

| Pieza | Qué es | Dónde |
| --- | --- | --- |
| Sitio | HTML/JS/CSS estático, sin servidor propio | Cloudflare Pages (subida directa desde GitHub Actions) |
| Backend | Supabase: Postgres con RLS, Auth, Storage (`ferias-media`), Realtime | Proyecto Supabase **propio de Ferias** |
| Correo | Confirmación de cuenta y recuperación de contraseña (Auth) | SMTP de un proveedor transaccional con dominio propio |
| CI | Pruebas en cada push (stack Supabase efímero dentro del runner) | GitHub Actions del repositorio `cauce-ferias` |

Ferias **nunca** usa el proyecto de CAUCE · Aluminé: el build, el script de
operación y la compuerta `npm run check` rechazan su referencia.

## 2. Demo sin costo (hoy)

Todo corre en la máquina, con Docker: no crea cuentas en servicios externos.

```bash
npm ci
npm run demo            # stack local + datos ficticios + build + vista previa
# → http://127.0.0.1:4274/index.html  · correos en http://127.0.0.1:55424 (Mailpit)
```

- Las cuentas de demostración (administración, 7 tiendas, organización) y sus
  contraseñas quedan en `.local/demo-credenciales.json`.
- La franja «Datos de demostración» aparece en todas las pantallas y cada
  tienda lo aclara en su descripción.
- `npm run demo:generico` hace lo mismo con el personaje genérico, para mostrar
  la demo a terceros sin usar la imagen de Sofía.
- Para mostrarla a alguien sin publicar nada: compartir la pantalla, o
  correrla en una notebook en la feria. Una demo accesible por internet sería
  una publicación 🔒.

## 3. Cuentas y secretos

Ninguno se versiona. Los secretos van en **GitHub → Settings → Environments →
`produccion`** (con «Required reviewers» activado, así cada ejecución espera la
aprobación de una persona de LUNA).

| Nombre | Tipo | Para qué | Dónde se obtiene |
| --- | --- | --- | --- |
| `FERIAS_SUPABASE_URL` | variable | URL del proyecto (`https://<ref>.supabase.co`) | Supabase → Project Settings → API |
| `FERIAS_SUPABASE_PUBLISHABLE_KEY` | variable | Clave **publicable** (va al navegador; el build rechaza claves secretas) | Supabase → API Keys |
| `FERIAS_SITE_URL` | variable | Dirección pública del sitio (sin `/` final) | El dominio elegido |
| `FERIAS_CF_PROJECT` | variable | Nombre del proyecto en Cloudflare Pages | Cloudflare → Workers & Pages |
| `FERIAS_SOFIA_AUTORIZADA` | variable | `si` sólo con la autorización escrita de Sofía | — |
| `FERIAS_PROJECT_REF` | variable | Referencia de 20 letras del proyecto (operación) | Supabase → Project Settings |
| `CLOUDFLARE_API_TOKEN` | secreto | Publicar en Pages (permiso «Cloudflare Pages: Edit», nada más) | Cloudflare → My Profile → API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | secreto | Cuenta de Cloudflare | Cloudflare → panel lateral |
| `SUPABASE_ACCESS_TOKEN` | secreto | Migraciones, Auth y consulta de backups por la API de gestión | Supabase → Account → Access Tokens |
| `SUPABASE_DB_PASSWORD` | secreto | Volcado y migraciones de la base | Elegida al crear el proyecto |
| `FERIAS_SMTP_HOST` · `_PORT` · `_USER` · `_PASS` · `_SENDER` | secretos | Correo de Auth | Proveedor SMTP |
| `FERIAS_BACKUP_PASSPHRASE` | secreto | Cifrar los respaldos (AES-256) | Generarla (32+ caracteres) y guardarla también **fuera** de GitHub |

Reglas: la `service_role`/secret key de Supabase **no se usa en ningún lado**
del sitio ni de los workflows de publicación; los tokens se rotan si alguien
deja el equipo; ningún secreto se pega en issues, PR ni chats.

## 4. Puesta en marcha (cuando se autorice)

1. 🔒 **Crear el proyecto Supabase** en la organización de LUNA Proyectos,
   región São Paulo (`sa-east-1`). Plan según §6.
2. **Cargar variables y secretos** de §3 en el entorno `produccion`.
3. **Migraciones:** Actions → «Operación de Ferias» → `estado` (sólo lectura), después
   `migrar` sin aplicar (muestra el plan y ensaya sobre una copia) y por último
   `migrar` con *aplicar* y *confirmar* = ref del proyecto. Detalle en
   [OPERACION.md](OPERACION.md).
4. **Auth:** `auth` (en seco, después aplicando). Deja: Site URL y Redirect
   URLs del sitio, confirmación de correo obligatoria, contraseñas de 10+,
   sesiones anónimas (compra sin cuenta) con límite por IP, SMTP propio y las
   plantillas de `supabase/templates/`.
5. **Primera administración:** la persona se registra en el sitio y se ejecuta
   `admin` con su correo.
6. 🔒 **Publicar:** Actions → «Publicar sitio» → *confirmar* = `FERIAS_SITE_URL`,
   personaje `generico` (o `sofia` con autorización), *indexar* apagado
   mientras sea vista previa. El build:
   - valida que la clave sea publicable y que el proyecto no sea el de Aluminé;
   - genera la CSP con el dominio de Supabase y `_headers` (no embebible en
     marcos, HSTS, `nosniff`, caché larga para archivos con hash);
   - deja `noindex` salvo que se pida indexar.
7. **Dominio** 🔒: registrar el dominio y apuntarlo a Cloudflare Pages
   (Custom domains). Actualizar `FERIAS_SITE_URL` y volver a correr `auth`.
8. **Verificación manual** con una cuenta de prueba: registro y correo,
   alta de tienda, producto con foto, aprobación, compra con retiro en feria,
   panel en vivo, seguimiento. Después borrar esa tienda de prueba.

## 5. Recuperación

| Situación | Qué hacer |
| --- | --- |
| Error de la interfaz tras publicar | Cloudflare Pages → Deployments → «Rollback» al despliegue anterior (inmediato). O volver a correr «Publicar sitio» desde un commit anterior. |
| Migración con problemas | Antes de aplicar, `migrar` ensaya sobre una copia de los datos reales; si falla, no toca nada. Si ya se aplicó: escribir una migración correctiva (nunca editar una ya aplicada) y, si hace falta, restaurar el respaldo. |
| Datos borrados o dañados | Plan Pro: Supabase → Database → Backups → restaurar el diario (retención de 7 días). Siempre: el respaldo cifrado de `respaldo` (ver [OPERACION.md](OPERACION.md)) se restaura en un proyecto nuevo con las migraciones del repo + datos. |
| Fotos | `respaldo --fotos` incluye los archivos de `ferias-media` en el archivo cifrado; se vuelven a subir con la misma ruta. |
| Credencial filtrada | Rotarla en el proveedor (Supabase/Cloudflare/SMTP), actualizar el secreto en GitHub, revisar Administración → Registro y los logs de Supabase. |
| Proyecto gratuito pausado | Supabase → Restore project (los datos se conservan). Por eso el piloto con comercios reales necesita Pro. |
| Abuso (altas o compras falsas) | Interruptores en `private.platform_features`: `merchant_signup`, `guest_checkout`, `founding_community`. Apagan la función en la base, no sólo en la interfaz. |

**Ensayo antes del piloto:** hacer una vez el ciclo completo — `respaldo` →
restaurar en un proyecto de prueba → verificar que el sitio funcione contra
él — y anotar cuánto tardó.

## 6. Costos

Ver [COSTOS.md](COSTOS.md). Resumen: la demo local cuesta $ 0; el piloto con
comercios reales, del orden de USD 25 por mes (Supabase Pro) más el dominio.
