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

### Personaje genérico para todo lo público

Mientras no esté la autorización, cualquier build remoto usa un **personaje
genérico**: un jarrito de barro con cara (`js/ui/personaje-generico.js`), con
las mismas 9 escenas y animaciones. Ver la hoja en
[evidencia/personaje-generico.png](evidencia/personaje-generico.png).

| Build | Personaje |
| --- | --- |
| `npm run build:local`, `npm run demo` (sólo en la máquina) | Sofía |
| `npm run demo:generico` o `FERIAS_PERSONAJE=generico npm run build:local` | Genérico |
| `npm run build` (remoto, vista previa o producción) | **Genérico por defecto** |
| `FERIAS_PERSONAJE=sofia npm run build` | Sofía: sólo con la autorización archivada |

- El build **reemplaza el módulo**: en el build genérico los dibujos de Sofía
  ni siquiera viajan en el JavaScript, y el build falla si encuentra rastros
  de ella. La imagen para compartir también cambia (`og-generico.png`).
- El workflow «Publicar sitio» rechaza `sofia` salvo que la variable del
  repositorio `FERIAS_SOFIA_AUTORIZADA` valga `si`.
- Los recursos de Sofía siguen en el repositorio (privado) y en la evidencia
  interna; no se usan en material comercial hasta la autorización.

Si la autorización no llega, alcanza con dejar el genérico; si llega, se activa
con la variable y se vuelve a publicar.

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
`npm run personaje:hoja` → `docs/evidencia/sofia-escenas.png` y
`docs/evidencia/personaje-generico.png`.
