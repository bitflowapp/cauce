# Evidencia visual

Capturas tomadas de la aplicación en ejecución, con Chrome instalado en la
máquina y emulación móvil a través del protocolo DevTools. **No son maquetas ni
montajes: son la aplicación real.** Tampoco son pruebas en un teléfono físico.

Para regenerarlas: `npm run e2e`, `npm run e2e:demo` y `npm run audit:visual`.
Las corridas completas quedan en `evidence/` (no versionado).

## Antes y después · 390 px

| Archivo | Qué muestra |
|---|---|
| `antes-390-inicio.png` | Inicio anterior: hero, dos bloques institucionales, comercios, "cómo funciona", grilla de funcionalidades y panel comercial, todo antes de poder hacer algo. |
| `despues-390-inicio.png` | Inicio actual: las dos acciones principales entran en la primera pantalla, después comercios y recién al final los accesos secundarios. |
| `antes-390-taxi.png` | Taxi anterior: bloques de tarifa, distancia y tiempo "a confirmar" ocupando la pantalla. |
| `despues-390-taxi.png` | Taxi actual: el formulario de solicitud primero, con la aclaración de que tarifa y tiempos se coordinan con el conductor. |

## Recorridos de la presentación

Todas contra el backend local, cada rol en un navegador con perfil separado.

| Archivo | Paso |
|---|---|
| `recorrido-01-comercio-borrador.png` | El comercio recién creado, en estado borrador. |
| `recorrido-03-pendiente-revision.png` | Solicitud enviada: pendiente de revisión, sin poder editar. |
| `recorrido-04-admin-devuelve.png` | Administración devuelve el alta con observaciones. |
| `recorrido-06-variantes.png` | Catálogo con variantes simples: cada opción suma su diferencia y es una línea propia del carrito. |
| `recorrido-07-confirmacion.png` | Confirmación de pedido: detalle, subtotal, envío, total, modalidad, pago de prueba y el aviso previo. |
| `recorrido-09-panel-pedido.png` | El pedido en el panel del comercio, en otra sesión, con acciones de aceptar o rechazar. |
| `recorrido-13-taxista-solicitud.png` | Solicitud abierta vista por el conductor: sin nombre ni teléfono del pasajero. |
| `recorrido-14-taxi-confirmado.png` | Viaje confirmado: vehículo y patente asignados, sin mapa ni posición simulada. |
| `recorrido-15-sin-conexion.png` | Pérdida de conexión: se avisa, se bloquea la confirmación y no se pierde lo escrito. |

## Cómo leer las capturas de página completa

Las capturas toman la página entera, más alta que la pantalla. Los elementos
fijos —la barra inferior y el enlace "Saltar al contenido"— aparecen dibujados en
medio de la imagen: es un efecto de la captura, no lo que ve una persona. En uso
real la barra queda abajo y el enlace de salto permanece oculto hasta que alguien
navega con el teclado.

## Anchos auditados

| Archivo | Ancho |
|---|---|
| `ancho-360-comercios.png` | 360 px |
| `ancho-360-confirmacion.png` | 360 px · confirmación con la etiqueta de zona envolviendo completa |
| `despues-390-inicio.png` | 390 px |
| `ancho-430-comercio.png` | 430 px |
| `escritorio-1440-inicio.png` | 1440 px |

La auditoría completa cubre 8 rutas × 4 anchos en los dos entornos (64
pantallas) y mide desbordes horizontales, área táctil, contraste calculado,
superposición de la barra inferior e imágenes sin medidas declaradas.
