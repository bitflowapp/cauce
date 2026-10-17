# Sofía, el personaje de CAUCE · Ferias

## Origen

Sofía está dibujada en SVG a mano, en `js/ui/sofia.js`, a partir de la
**dirección de arte de la imagen de referencia del diseño** (personaje
femenino con cabello largo oscuro, ojos cerrados que sonríen, mejillas
rosadas, sonrisa amplia, ropa coral y rosa, contorno blanco tipo sticker).

La fotografía de Sofía mencionada en el pedido **no estaba disponible** en
este trabajo: no se analizó ninguna foto. Si se quiere acercar los rasgos a la
persona real, hay que revisar el dibujo con la fotografía y con ella.

## Autorización

El personaje está inspirado en una persona real. **Su uso público o comercial
requiere la autorización expresa de Sofía** (idealmente por escrito, indicando
alcance: sitio, redes, material impreso, plazos). Hasta tenerla, el personaje
se usa sólo en entornos de desarrollo y demostración privada.

Si la autorización no llega, se puede reemplazar por un personaje genérico
cambiando sólo `js/ui/sofia.js` (todas las pantallas usan la función `sofia()`).

## Escenas

| Escena | Dónde aparece | Animación (sólo si no se pidió movimiento reducido) |
| --- | --- | --- |
| `bienvenida` | Inicio (hero), imagen para compartir | Saluda con la mano |
| `creando` | Alta de tienda, lista de pasos del panel, tienda sin productos | Mueve la pieza de cerámica |
| `explorando` | Ferias sin resultados, favoritos vacíos | La bolsa se balancea, late el corazón |
| `preparando` | Confirmación de correo, pedidos vacíos del panel | El paquete salta |
| `celebrando` | Pedido enviado, preinscripción recibida | Confeti |
| `carrito-vacio` | Carrito vacío, sin pedidos | La bolsa se balancea |
| `buscando` | Búsqueda sin resultados, errores | La lupa recorre |
| `comunidad` | Comunidad fundadora, crear cuenta | El cartel se inclina |
| `taza` | «Qué es CAUCE» | Sale vapor de la taza |

Las animaciones son CSS sobre grupos del SVG (`transform`/`opacity`), no
afectan el rendimiento y se desactivan con `prefers-reduced-motion: reduce`
(probado en E2E). La hoja con todas las escenas se regenera con
`node scripts/sofia-sheet.mjs` → `docs/evidencia/sofia-escenas.png`.
