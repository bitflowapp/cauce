# Panel remoto del comercio (v1)

El panel es la superficie 3 de CAUCE: la usa el titular o su equipo desde el
teléfono, una tablet o una computadora, en cualquier red. No es otra
aplicación: es la misma SPA, con la misma sesión de Supabase Auth, las mismas
tablas (`businesses`, `business_members`, `products`, `product_categories`,
`orders`, `business_riders`) y las mismas políticas RLS que el resto.

Pensado para el piloto de 5 a 20 comercios de Aluminé. **Sin migraciones
nuevas**: todo lo que hace ya lo permitía la base.

## Dónde está

| Pieza | Qué hace |
| --- | --- |
| `js/core/business-panel.js` | Reglas puras: secciones por rol, grupos de pedidos por estado, qué acción ofrece cada pedido, resumen del día, ABIERTO/CERRADO, tablero de reparto. |
| `js/ui/business-panel.js` | HTML escapado: navegación, tarjeta de pedido, tablero, inicio, reparto, barra de sincronización, avisos. |
| `js/ui/merchant-tools.js` | Horarios, equipo, contacto (compartido con la ficha pública). |
| `js/app.js` · `viewMerchantPanel` | Lee los datos de la sección y arma la vista; acciones y formularios. |

Ruta: `#panel/<id-del-comercio>/<sección>`. Sin sección abre **Inicio**. Una
sección que el rol no ve, o que no existe, también cae en Inicio. El enlace
viejo `#panel/<id>/datos` sigue llevando a Configuración.

## Secciones y roles

| Sección | Titular | Encargado/a | Equipo (staff) | Qué hay |
| --- | :-: | :-: | :-: | --- |
| Inicio | ✓ | ✓ | ✓ | Pedidos nuevos, en curso, completados hoy, vendido hoy (lo entregado hoy, hora de Aluminé), retiro · envío, productos no disponibles. Los pedidos que esperan respuesta, con Aceptar/Rechazar. |
| Pedidos | ✓ | ✓ | ✓ | Tablero por estado con filtros y contadores. |
| Catálogo | ✓ | ✓ | disponibilidad y stock | Crear y editar productos (precio, descripción, categoría, foto, variantes, stock opcional), desactivar y reactivar; categorías (crear, renombrar, ordenar, activar). |
| Horarios | ✓ | ✓ | — | Por día: cerrado o hasta 3 turnos (también después de medianoche); ABIERTO/CERRADO ahora. |
| Configuración | ✓ | ✓ | — | Nombre, rubro, descripción, logo, portada, teléfonos, WhatsApp, dirección, retiro, envío, costo de envío, pedido mínimo, tiempos estimados, publicación. |
| Reparto | ✓ | ✓ | ✓ (sin cargar personas) | Envíos por etapa, quién lleva qué, personas de reparto. |
| Equipo | ✓ (edita) | ✓ (ve) | — | Integrantes y roles. Sólo el titular suma, cambia o quita. |

Esto decide **qué se muestra**, nunca qué se permite. La autoridad es la base:
si una pantalla ofreciera algo de más, la escritura igual se rechaza. Staff no
tiene `UPDATE` sobre `products` (sólo `set_product_availability`) ni escritura
sobre `business_riders`, `product_categories`, horarios ni equipo.

## Pedidos

Grupos, siguiendo la máquina de estados real (`private.order_transitions`):

| Grupo | Estados |
| --- | --- |
| Nuevos | `submitted` |
| Aceptados | `accepted` |
| Preparando | `preparing` |
| Listos | `ready` |
| En reparto | `assigned`, `picked_up`, `on_the_way`, `arrived` |
| Completados | `delivered` |
| Cancelados | `canceled` (incluye rechazados) |

Lo abierto se atiende por orden de llegada (el más viejo primero); lo cerrado se
lee del más reciente al más viejo.

Cada tarjeta muestra código, hora y antigüedad, modalidad, forma de pago,
productos con cantidades, nota del cliente, nombre, teléfono (llamar y
WhatsApp), total (con el envío si corresponde) y estado; en los envíos,
dirección, etapa de la entrega, código de entrega y la asignación de reparto.
Todo lo escrito por el cliente se escapa.

Las acciones son **exactamente** las transiciones que la base permite al
comercio para ese estado y esa modalidad (`merchantOrderActions`). Una prueba
(`tests/business-panel.test.mjs`) lee las filas de `private.order_transitions`
de las migraciones y compara: si alguien cambia la tabla, la prueba falla hasta
que el panel acompañe. Cada acción viaja por `transition_order` con la versión
que se vio (`expected_version`): si otra persona ya movió el pedido, la base
responde `U0001` y el panel lo explica y se actualiza, sin aplicar dos veces.
Rechazar y cancelar piden motivo (la base también lo exige).

## Pedidos nuevos y tiempo real

- Canal Realtime sobre los pedidos del comercio y, además, consulta cada 30
  segundos. Un evento nunca se pinta directamente: vuelve a leer por la vía
  normal, con RLS.
- Pedido nuevo: la tarjeta se destaca, contador en la pestaña Pedidos, aviso en
  las demás secciones, número en el título de la pestaña del navegador,
  vibración y un sonido corto (una vez por pedido, no en bucle).
- Sonido opcional: el navegador lo habilita recién con un toque; "Silenciar" lo
  apaga en ese dispositivo y "Activar" lo vuelve a encender.
- Con un formulario a medio escribir no se redibuja nada (se marca
  `data-dirty`); un pedido nuevo igual se avisa con un cartel flotante.
- La barra de estado dice "En vivo" o "Reconectando: revisamos cada 30
  segundos", la hora de la última actualización y ofrece "Actualizar".

## Conectividad y sesión

- Cada consulta tiene un tiempo límite de 20 s (`NETWORK_TIMEOUT`): con una red
  lenta se dice "La conexión está lenta" con reintento, en vez de quedar
  colgado.
- Todo botón que escribe queda ocupado hasta la respuesta (sin doble envío); a
  los 350 ms aparece una barra de carga. Sin conexión, los botones de acción
  quedan deshabilitados y nada se envía.
- Volver a la pestaña o desbloquear el teléfono actualiza la vista.
- La sesión persiste entre visitas. Si vence o se cierra en otra pestaña, el
  panel lo dice y pide ingresar; después vuelve a la misma sección.
- No depende de la red local ni de `localhost`: usa la URL pública y el
  proyecto de Supabase configurado en el build.

## Aislamiento entre comercios

- El panel sólo abre comercios que devuelve `myBusinesses` (membresías de la
  cuenta). Un id ajeno en la URL muestra "Ese comercio no pertenece a tu
  cuenta." sin leer nada más.
- Aunque se forzara la llamada, RLS filtra pedidos, productos, categorías,
  reparto y equipo por membresía; las claves compuestas `(id, business_id)`
  impiden mover un producto o un pedido de comercio. Las pruebas de integración
  (`tests/integration/business-panel.test.mjs`) lo verifican contra la base.

## Límites conocidos

- Los números del día (completados, vendido, retiro y envío) se calculan con
  los pedidos que el panel tiene cargados: los abiertos y los cerrados en las
  últimas 36 horas, hasta 150. Alcanza de sobra para el piloto; con más volumen
  convendría un resumen calculado en la base.
- El navegador exige un toque en la página antes de permitir sonido: hasta
  entonces el aviso es visual (y en el título de la pestaña).
- "Cerrar atención" se aplica al instante, sin confirmación; el cartel queda
  en rojo y se vuelve a abrir con un toque.
- El texto libre "Horarios (texto que ve el cliente)" de Configuración convive
  con los horarios de la pestaña Horarios, que son los que deciden si se toman
  pedidos.

## Fuera de alcance en v1

Cobros en línea, liquidaciones, comisiones, reembolsos, gráficos o reportes, y
la aplicación propia de reparto. Para esta última, ver
[CONTRATO-RIDER.md](CONTRATO-RIDER.md).

## Cambios en piezas compartidas

Sin migraciones ni cambios en políticas o funciones de la base. En el cliente:

- `productColumns` pide también la posición de la categoría; la ficha pública
  ordena las categorías como las ordena el comercio.
- Repositorio Supabase: tiempo límite de 20 s por consulta y dos comandos
  nuevos, `productCategory.update` y `productCategory.reorder` (escrituras
  directas que RLS ya permitía a titular y encargado/a).
- Barra de carga global (`#main[aria-busy="true"]`) y protección de formularios
  sin guardar ante refrescos de fondo.
