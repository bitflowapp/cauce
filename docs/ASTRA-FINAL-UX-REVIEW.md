# CAUCE — ASTRA FINAL UX REVIEW

## Auditoría BEFORE — 2026-09-17

Base: `39cdb2e7a3a53bbdcfbd2e40fe51fd545a3cb8e1`. Referencia: las seis páginas completas de `C:/Users/marco/CAUCE.pdf`, renderizadas y revisadas antes de modificar el producto. Rama: `feat/cauce-astra-final-ux`.

Recorrido real en Chrome de la versión publicada: home, búsqueda, comercio/catálogo, agregar, carrito, checkout delivery, pedido, cocina, asignación, rider, presentación y dos modales. Cinco viewports: 390×844, 393×852, 430×932, 768×1024, 1440×900. Evidencia: `evidence/astra/before/` (50 pantallas, captura completa y primer viewport). Sin overflow de documento ni errores de red. 1210 mensajes de consola, incluyendo avisos CSP y el registro de sus eventos: no son 1210 fallos distintos. El capturador antiguo no sirve para el checkout actual; se incorporó uno independiente sin cambiar las suites funcionales.

### ADN de las seis páginas

1. Pedir/recibir: blanco dominante, titular negro compacto, paisaje frío y tres dispositivos; verde en acciones.
2. Etapas: paisaje y números ordenan el recorrido; personajes en los extremos. Su copy histórico NO se adopta.
3. Diagnóstico: asimetría entre titular y escena; contraste tinta/blanco y territorio azul.
4. Marca: dispositivo como protagonista, sticker acompañante; fotografía conecta bloques amplios.
5. Impacto: tres columnas subordinadas al titular, río y dispositivo al cierre. No se adoptan claims.
6. Comercio: jerarquía titular/dispositivo/herramientas; información técnica secundaria.

Parentesco actual parcial: existen territorio, dispositivos y stickers, pero la fotografía principal no se ve; los títulos son azules/verdes, y la sucesión de paneles redondeados domina la composición.

### Problema → cambio propuesto → mejora verificable

| Pantalla | Problema observado | Intervención acotada | Resultado buscado |
| --- | --- | --- | --- |
| Global / CSP | Estilos inline rechazados por `style-src 'self'`, incluida la foto del hero | Extraer estilos a clases externas sin relajar CSP | Fotografía visible y cero violaciones en recorrido real |
| Home | Hero de 566 px en 390, búsqueda fuera del primer viewport; dos CTA verdes iguales | Compactar composición móvil, reservar mockup para anchos útiles, CTA secundario outline | Búsqueda y primera foto visibles antes de navegar |
| Home / marca | Titular azul, etiqueta turquesa clara; animación infinita de stickers | Tinta para display, azul montaña en etiquetas, stickers estáticos | Contraste y parentesco con PDF |
| Comercios | Badge promocional, subtítulo, descripción y cuatro metadatos compiten | Quitar badge y subtítulo repetido; usar cocina como descripción corta; conservar precios/mínimo en shop | Foto/nombre/cocina/estado/entrega en dos segundos |
| Shop | Card, sombra y línea punteada por plato; acción debajo de toda la fila | Filas con separador simple, foto mayor, acción junto al contenido | Menos ruido y asociación inequívoca precio/agregar |
| Carrito | Flujo y CTA ya claros | Conservar estructura, separar controles de información en checkout estrecho | Evitar comprimir nombre y precio unitario |
| Checkout | Stepper 30 px, safe-area contada dos veces; toast invade CTA | Targets 44 px, token compartido de bottom nav, notificación fuera del CTA | Operación táctil clara sin solapamiento |
| Tracking | Código arcilla grande y repetido compite con estado | Código sobrio, ocultar repetición sólo en tracking | Estado/timeline primero, código legible una vez |
| Business | Pedido extendido sobre 1192 px; cerrar comercio compite con preparar | Bandejas con columnas de ancho legible, cierre secundario | Más pedidos escaneables sin cambiar orden ni filtros |
| Rider | Avisos, timeline e información repetida desplazan misión/acción bajo el fold | Pasar avisos después de misiones, retirar timeline redundante de esta vista | Retiro/destino/acción visibles juntos |
| Institucional | Card dentro de card; etapas a 11 px; ausencia de territorio | Abrir secciones, usar separadores y fotografía existente, ampliar textos de etapas | Lectura por titulares y etapas; copy idéntico |

### Límites y decisiones antes de implementar

- Congelados `js/core`, repositorios, datos, configuración, precios, eventos de negocio y copy institucional.
- No agregar fuentes, dependencias, imágenes, secciones, funciones comerciales ni textos de marketing.
- No reemplazar la fotografía real por paisaje inventado ni redibujar stickers.
- No cambiar estados públicos/técnicos: se observa `Recibido` en el título y `Confirmado` en el primer paso público. Se documenta la discrepancia heredada.
- Modales heredados no cierran con Escape y no gestionan foco como un diálogo completo. Defecto de accesibilidad frontend a evaluar de forma localizada, sin tocar negocio.
- La aplicación sigue siendo una demostración local: no hay backend operativo, auth, pagos ni GPS real. La calidad visual no certifica operación productiva.
- El puerto 4173 estaba ocupado por otro proceso; revisión aislada en 4187, sin detenerlo.

## Resultado AFTER

Pendiente de implementación, comparación y verificación. No autorizado por evidencia todavía para merge.
