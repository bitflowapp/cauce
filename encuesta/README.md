# CAUCE · Aluminé — encuesta

Encuesta web estática para GitHub Pages. Usa HTML, CSS y JavaScript sin dependencias, backend ni base de datos.

## Archivos

- `index.html`: contenido, SEO y estructura semántica.
- `styles.css`: diseño responsive, accesibilidad visual y movimiento reducido.
- `app.js`: preguntas, navegación, persistencia local, compartir y WhatsApp.
- `analytics.js`: integración opcional con Google Analytics 4.
- `assets/illustrations/alumine-landscape.svg`: ilustración vectorial del paisaje.
- `assets/icons/favicon.svg`: ícono del sitio.
- `assets/images/og-cauce.jpg`: tarjeta social 1200 × 630.

## Abrir localmente

Abrí `index.html` en un navegador moderno. También se puede servir esta carpeta con cualquier servidor estático, sin instalación ni compilación. Las rutas son relativas, así que el sitio funciona dentro de un subdirectorio como `/cauce-encuesta/`.

## Datos guardados

El avance se guarda bajo la clave `cauceEncuestaStateV1` en el `localStorage` de ese navegador y dispositivo. Se guardan respuestas, pregunta actual, estado iniciado y estado completado. No se envía ni sincroniza con un servidor. Si el navegador bloquea `localStorage`, la encuesta sigue funcionando en memoria durante esa sesión. Al finalizar, «Volver a empezar» borra y reinicia el estado local.

## Configuración

- GA4: en `analytics.js`, reemplazá `GA4_MEASUREMENT_ID = ""` por tu ID `G-...`. Vacío significa Analytics desactivado.
- WhatsApp: en `app.js`, `CONFIG.whatsappNumber` está configurado como `5492942597276` (2942597276 con prefijo móvil de Argentina). Usá formato internacional, solo dígitos y sin `+` ni espacios.
- Precios: editá `CONFIG.priceRanges` en `app.js`; cada opción lleva un `id` analítico estable y una etiqueta visible.
- Preguntas: editá el arreglo `QUESTIONS` en `app.js`. Usá IDs estables en inglés minúsculo para la pregunta y cada opción. Los tipos son `single`, `multiple` y `scale`.
- Pregunta de precio: se muestra para modalidades que contemplan cuota mensual (`free_plus_extras`, `fixed_monthly`, `low_fee_commission` y `try_first`). Se omite para comisión por venta, pago único y no pagar.
- Imágenes: colocá los archivos en `assets/images/` (o ilustraciones en `assets/illustrations/`) y actualizá sus rutas en `index.html`. La tarjeta social se sirve en `https://bitflowapp.github.io/cauce/encuesta/assets/images/og-cauce.jpg`.

## GitHub Pages

Esta encuesta se publica bajo `/encuesta/` en el sitio existente de CAUCE: <https://bitflowapp.github.io/cauce/encuesta/>. El workflow de Pages copia esta carpeta al build publicado después de compilar la plataforma. No requiere backend ni dependencias propias.

## Privacidad analítica

Analytics queda inactivo mientras el Measurement ID esté vacío. Cuando se configura, se registran `survey_view`, `survey_start`, `survey_question_view`, `survey_answer`, `survey_back`, `survey_complete`, `survey_share` y `pilot_whatsapp_click`. `survey_answer` envía exclusivamente `question_id`, `option_id` y `question_number`; no se envía texto libre ni información personal. En preguntas múltiples se emite un evento por opción al continuar.
