# Procedencia del código

## Lo reutilizado realmente

Se leyó código mediante la conexión GitHub de `bitflowapp/la-taba-pages-preview`.
El repositorio completo no se descargó ni se clonó en este entorno: los intentos de
archivo comprimido fallaron y el terminal no dispone de salida de red.
Esta entrega es una extracción inicial con código nuevo de CAUCE; no es el clon
completo solicitado ni contiene el backend, el panel completo o el rider Android.
No existe un porcentaje de reutilización calculado.

Referencia de lectura completa: `main`, commit
`a4d54dea45c8822a2c50956fad86ac90c1610292` (9 de septiembre de 2026).
También se observó la rama `feat/taba-commerce-v3`, commit
`6319e690472b1041edda90ea54832d09641b023e` (15 de septiembre de 2026).
Se comprobó por los hashes de GitHub que los módulos de workflow y pricing
coinciden entre esos dos commits. Esto NO certifica el resto de esa rama.

| Archivo de esta entrega | Origen | Tratamiento |
|---|---|---|
| `js/core/order-workflow.js` | misma ruta de La Taba | Copia exacta, sin cambios |
| `tests/order-workflow.test.mjs` | misma ruta de La Taba en main | Copia exacta: conserva sus dos pruebas |
| `js/core/commercial.js` | funciones de `js/core/pricing.js` | Extracción y desacoplamiento de configuración global; comentarios y forma de algunas expresiones adaptados |
| Resto de archivos | Implementación CAUCE de esta sesión | Nuevos; no presentados como código heredado |

Hashes Git blob comprobados con `git hash-object` y con el verificador Node:

- `js/core/order-workflow.js`: `da853c6a66cdd293372a42f5a80081c3119afc7e`.
- `tests/order-workflow.test.mjs`: `b2576b6bfb919d3d16be83011d853f565e084f85`.
- Origen de pricing: `0bd75dfe0b9e92f34e4b5f4c7f1fbaacb0f3af11`.
  El archivo adaptado NO tiene ese hash; no se afirma que sea una copia idéntica.

Las funciones comerciales extraídas comprueban precio pendiente, precio
confirmado, stock conocido y posibilidad de compra. Se evitó importar los
singletons `business-config-store`, `app-mode` y `commerce-availability-store`
para que la cotización nueva reciba el comercio explícitamente.

## Consulta de las fuentes

Repositorio: https://github.com/bitflowapp/la-taba-pages-preview

Los enlaces de código pueden reconstruirse con `blob/<commit>/<ruta>`.
No se han retirado ni reemplazado los archivos originales del repositorio.
No se copiaron usuarios, pedidos, comercios operativos, tokens ni configuración
productiva. Los fixtures se escribieron desde cero y se etiquetan como ficticios.
