# Informe de entrega · CAUCE · Ferias Neuquén

Etapa 1 (11/10/2026): rama `claude/cauce-ferias-neuquen` de `bitflowapp/cauce`,
carpeta `ferias/` (PR #11, sin fusionar). Etapa 2 (11/10/2026): repositorio
independiente y preparación del piloto, ver la sección siguiente.

## Etapa 2 · Repositorio independiente y preparación del piloto

| Pedido | Estado | Evidencia |
| --- | --- | --- |
| Separar el repositorio conservando el historial | **Listo localmente** | `git subtree split --prefix=ferias`: los 7 commits de `ferias/` con sus migraciones, pruebas, docs y evidencia, más el CI en la raíz |
| Crear `bitflowapp/cauce-ferias` | **Bloqueado** | La integración de GitHub de esta sesión no puede crear repositorios (403). Hace falta crearlo vacío y dar acceso a la app de Claude |
| CI independiente | **Verde** | Corrida 38175319784 en una rama temporal de `bitflowapp/cauce` que contiene sólo el historial del repo nuevo: verificación, integración, E2E Chromium + WebKit y auditoría visual en 11 min |
| Preparar Supabase independiente sin crear nada | **Listo** | `operacion` (estado, migrar con ensayo, auth, admin, respaldo con restauración) probado contra el stack local; [DESPLIEGUE.md](DESPLIEGUE.md), [OPERACION.md](OPERACION.md) |
| Costos verificables | **Listo, con salvedad** | [COSTOS.md](COSTOS.md): fuentes secundarias recientes; las páginas oficiales no abren desde este entorno |
| Demo completa sin gastos | **Listo** | `npm run demo` (y `demo:generico`) |
| Personaje: no publicar a Sofía sin autorización | **Listo** | Builds remotos con personaje genérico por defecto; el build falla si encuentra a Sofía; «Publicar sitio» exige `FERIAS_SOFIA_AUTORIZADA=si` |
| Piloto: encuestas y Comunidad Fundadora | **Listo** | Encuesta breve opcional, resumen, filtro y CSV en Administración (SQL + E2E) |
| Checklist del piloto | **Listo** | [PILOTO.md](PILOTO.md) |

Defecto encontrado y corregido en esta etapa: la sesión anónima que abre la
preinscripción volvía a dibujar la página y borraba el «¡Gracias por sumarte!»
(la persona veía el formulario de nuevo). Lo detectó el recorrido E2E nuevo.

Faltan, por decisión o autorización: política de privacidad y términos
revisados (hay un [borrador](legal/BORRADOR-PRIVACIDAD.md) sin publicar),
proyecto Supabase Pro, dominio, publicación y autorización de Sofía.

## Resumen

CAUCE · Ferias es una derivación independiente de CAUCE · Aluminé con la
identidad visual de la referencia (terracota, crema, rosa y naranja;
ilustración tipo sticker; Sofía) y un backend real en Supabase. Todo se
verificó contra un **stack Supabase local real** (Postgres 17, GoTrue con
correo vía Mailpit, PostgREST, Storage y Realtime). **No se creó ningún
proyecto remoto ni se publicó nada**: esas dos acciones requieren autorización.

## Aislamiento de CAUCE · Aluminé

- Ningún archivo de Aluminé cambió. Lo único fuera de `ferias/` es
  `.github/workflows/ferias-ci.yml`, que sólo corre ante cambios en `ferias/`.
- `project_id = "cauce-ferias"`, puertos 55420–55429, bucket `ferias-media`,
  preview en 4274: conviven con el stack local de Aluminé.
- El build de Ferias se niega a compilar contra el proyecto de Aluminé
  (`ygqbcvxdrewcnzedfcyo`) y la compuerta `npm run check` lo vigila.
- Con la rama, el lint, `check` y el escaneo de secretos de la raíz siguen en
  PASS (ESLint 10 aplica `ferias/eslint.config.mjs` a sus archivos).

## Criterios de entrega

| # | Pedido | Estado | Evidencia |
| --- | --- | --- | --- |
| 1 | Frontend implementado | **Listo** | 24 rutas; capturas en `docs/evidencia/` |
| 2 | Backend funcional en entorno independiente | **Listo (local)** | Stack `cauce-ferias`; remoto pendiente de autorización |
| 3 | Migraciones reproducibles | **Listo** | 6 migraciones; `db reset` desde cero; 54 pruebas en PGlite |
| 4 | Registro probado | **Listo** | Integración: registro, confirmación por correo en otro dispositivo, recuperación; E2E: alta completa por la interfaz |
| 5 | Alta y publicación de comercios | **Listo** | E2E «alta guiada» + aprobación por administración |
| 6 | Carga real de productos e imágenes | **Listo** | E2E sube foto por la interfaz a Storage; reglas de ruta, tipo y tamaño probadas |
| 7 | Catálogo público conectado | **Listo** | Inicio, explorar con filtros y paginación, tienda, producto, ferias |
| 8 | Flujo de pedidos completo | **Listo** | Compra sin cuenta → panel en vivo → preparar → entregar → registrar cobro → seguimiento |
| 9 | Retiro en ferias | **Listo** | Participación confirmada + plan; copia de feria y puesto en el pedido; cómo llegar |
| 10 | Panel operativo del comerciante | **Listo** | Inicio guiado, pedidos, productos, inventario, tienda, QR, ferias, estadísticas, plan, equipo |
| 11 | Panel administrativo | **Listo** | Resumen, revisión, suscripciones, organizadores, comunidad, auditoría, errores |
| 12 | Gestión inicial de suscripciones | **Listo (manual)** | Estados por fecha, gracia, vitrina sin cortar pedidos abiertos; sin cobro automático (a propósito) |
| 13 | Ilustraciones y animaciones | **Listo** | 9 escenas SVG; `prefers-reduced-motion` probado; ver `PERSONAJE.md` |
| 14 | Pruebas automatizadas ejecutadas | **Listo** | Ver tabla de resultados |
| 15 | Capturas reales | **Listo** | `docs/evidencia/` (comparativas con la referencia, 7 anchos, E2E) |
| 16 | Documentación de instalación | **Listo** | `INSTALACION.md` |
| 17 | Informe de listo y pendiente | **Este documento** | |
| 18 | Estimación de costos | **Listo, con salvedad** | `COSTOS.md` (cuotas a confirmar en supabase.com) |
| 19 | Rama y pull request | **Listo** | Rama `claude/cauce-ferias-neuquen` publicada; [PR #11](https://github.com/bitflowapp/cauce/pull/11) en borrador, marcado «no fusionar» |

## Resultados de las pruebas

En el entorno de desarrollo y en el CI de la rama (`ferias-ci.yml`, verde en el
último commit del PR; el CI de Aluminé también queda verde con la rama).

| Suite | Resultado |
| --- | --- |
| Lint (ESLint), tipos (TypeScript checkJs), compuertas estáticas | PASS |
| Unitarias | 15/15 |
| SQL embebido (migraciones, RLS, pedidos, ferias, planes, comunidad) | 54/54 (y una mutación deliberada se detecta) |
| Integración contra Supabase real | 11/11 |
| E2E Chromium | 6/6 en cuatro corridas seguidas (local) y en el CI |
| E2E WebKit | 6/6 en el CI (en este entorno no hay WebKit y no se descargan navegadores). En el CI, un navegador que no arranca hace fallar la suite: no se omite. |
| Auditoría visual (320/360/390/430/768/1280/1440 px, 35 pantallas) | Chromium local: 245 capturas · Chromium + WebKit en el CI: 490 capturas. En ambos: 0 desbordes, 0 errores de consola o 5xx, 0 controles táctiles chicos en móvil, 0 textos con contraste insuficiente |
| Lighthouse móvil (build local con compresión) | Inicio: rendimiento 90, accesibilidad 100, buenas prácticas 100 · Producto: 93/100/100 · Ferias: 97/100/100 · SEO 92 con build de producción (el local lleva `noindex` a propósito) |

## Defectos que encontraron las pruebas y se corrigieron

- Manejadores de eventos que se acumulaban entre vistas (un botón ejecutaba la
  acción dos veces). Ahora cada vista se monta en un contenedor nuevo.
- «Saltar al contenido» chocaba con el enrutador por hash.
- Acciones del comercio en «en camino» sin distinguir forma de entrega
  (detectado por la prueba de paridad con la tabla SQL).
- WhatsApp con «15» después de un código de área de 3 cifras (299).
- Desbordes en «Mi tienda» a 320–390 px, contraste de etiquetas verdes y
  áreas táctiles chicas.
- (CI) Con Realtime recién iniciado, un pedido creado en los segundos previos a
  que Realtime empiece a entregar cambios de Postgres no aparecía en vivo. Ahora
  el panel y «Mis pedidos» vuelven a consultar cuando Realtime confirma la
  suscripción (y tras cada reconexión). Reproducido reiniciando Realtime.

## Pendiente (no se declara terminado)

| Tema | Por qué | Qué hace falta |
| --- | --- | --- |
| Proyecto Supabase remoto y publicación | Requieren autorización y, para operar, un plan pago | Aprobación de LUNA; pasos en `INSTALACION.md §3` |
| Correo/WhatsApp automático al comercio por pedido nuevo | Necesita un proveedor (correo transaccional o API de WhatsApp) y credenciales | Hoy: aviso en vivo con sonido y vibración en el panel, y botón «Avisar por WhatsApp» para quien compra |
| Notificaciones push | Requiere servidor de push y claves VAPID | — |
| Cobro de suscripciones y pagos online | Pedido explícito: no antes de una integración segura | Ver `SUSCRIPCIONES.md` |
| Valoraciones de tiendas (la referencia muestra ★ 4.9) | No hay sistema de reseñas; no se muestran valoraciones inventadas | Diseñar reseñas verificadas por pedido entregado |
| Fotografía de Sofía y su autorización | No estuvo disponible; el personaje sale de la referencia | Autorización escrita (ver `PERSONAJE.md`) |
| Preinscripción «desarrollada anteriormente» | No estaba en el repositorio | Se construyó una nueva con consentimiento; si existe otra versión, se puede migrar |
| Moderación de contenido | Sólo revisión humana del alta y suspensión | Evaluar según volumen |
| Indexación por buscadores de cada producto | Enrutador por hash (sitio estático) | Prerenderizado o rutas reales si el SEO se vuelve prioridad |
| Respaldos automatizados propios | Se confía en las copias diarias de Supabase Pro | Portar los scripts de respaldo cifrado de Aluminé si se necesitan copias fuera de Supabase |

## Riesgos y notas

- Las sesiones anónimas de compra cuentan como usuarios activos mensuales en
  Supabase y tienen límite por IP en Auth; en producción conviene sumar un
  captcha si aparece abuso.
- Los precios de los planes son hipótesis; están en una tabla y se cambian sin código.
- El entorno de desarrollo no pudo bajar imágenes de `public.ecr.aws`; se
  usaron las mismas imágenes desde Docker Hub (documentado).
