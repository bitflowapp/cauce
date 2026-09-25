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
| Inicio | ✓ | ✓ | ✓ | Vendido hoy en vivo (lo entregado hoy, hora de Aluminé, y lo que está en curso), pedidos nuevos, activos, completados hoy, ticket promedio, retiro · envío y productos sin disponibilidad. Con pedidos esperando, primero se atienden (Aceptar/Rechazar); después los números. Más vendidos hoy y últimas ventas. |
| Pedidos | ✓ | ✓ | ✓ | Tablero por estado con filtros y contadores. |
| Catálogo | ✓ | ✓ | disponibilidad y stock | Precio y stock al toque en cada producto; crear y editar (descripción, categoría, foto, variantes, stock opcional), desactivar y reactivar; categorías (crear, renombrar, ordenar, activar). |
| Reparto | ✓ | ✓ | ✓ (sin cargar personas) | Envíos por etapa, quién lleva qué, personas de reparto. |
| Horarios | ✓ | ✓ | — | Por día: cerrado o hasta 3 turnos (también después de medianoche); ABIERTO/CERRADO ahora. |
| Configuración | ✓ | ✓ | — | Arriba, envío, pedido mínimo y tiempos estimados, con su propio botón (en un comercio que ya opera). Después nombre, rubro, descripción, teléfonos, WhatsApp y dirección; logo, portada y publicación. |
| Equipo | ✓ (edita) | ✓ (ve) | — | Integrantes y roles. Sólo el titular suma, cambia o quita. |

Esto decide **qué se muestra**, nunca qué se permite. La autoridad es la base:
si una pantalla ofreciera algo de más, la escritura igual se rechaza. Staff no
tiene `UPDATE` sobre `products` (sólo `set_product_availability`) ni escritura
sobre `business_riders`, `product_categories`, horarios ni equipo.

## En el teléfono: el control remoto del comercio

A 390 px el panel está pensado para operar con una mano:

- las secciones van en dos filas: arriba lo de todos los días (Inicio, Pedidos, Catálogo, Reparto); abajo la administración (Horarios, Configuración, Equipo);
- el cartel ABIERTO/CERRADO está siempre arriba, con "Cerrar atención" / "Abrir atención" y "Pausar el comercio" / "Reactivar el comercio";
  - pausar saca el comercio de CAUCE y se confirma antes;
  - al reactivarlo, la atención queda cerrada hasta abrirla;
- las acciones de cada pedido ocupan todo el ancho, al pie de la tarjeta;
- el precio y el stock se cambian en la fila del producto, sin abrir el formulario completo.

Las acciones son las que la base ya permitía: `set_business_presence` (abrir, cerrar, pausar y reactivar; titular y encargado/a), `products` (precio y stock; titular y encargado/a), `set_product_availability` (también el equipo) y `transition_order`.

Administrar el equipo (sumar, cambiar rol, quitar) sigue siendo sólo del titular, como lo decide la base (`add_business_member` y siguientes). El panel no lo habilita a nadie más.

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

- Los números del día (vendido, en curso, completados, ticket promedio,
  retiro y envío, más vendidos y últimas ventas) se calculan con los pedidos
  que el panel tiene cargados: los abiertos y los cerrados en las
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

La facturación electrónica tampoco está en v1: en el panel no hay botón,
datos ni credenciales fiscales. El contrato para la rama que la implementa
(emitir factura desde un pedido, todo del lado del servidor) está en
[CONTRATO-FACTURACION-ARCA.md](CONTRATO-FACTURACION-ARCA.md).

## Cambios en piezas compartidas

Sin migraciones ni cambios en políticas o funciones de la base. En el cliente:

- `productColumns` pide también la posición de la categoría; la ficha pública
  ordena las categorías como las ordena el comercio.
- Repositorio Supabase: tiempo límite de 20 s por consulta y dos comandos
  nuevos, `productCategory.update` y `productCategory.reorder` (escrituras
  directas que RLS ya permitía a titular y encargado/a).
- Barra de carga global (`#main[aria-busy="true"]`) y protección de formularios
  sin guardar ante refrescos de fondo.
