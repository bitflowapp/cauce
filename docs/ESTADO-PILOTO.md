# Estado de CAUCE · Aluminé frente a un piloto real

Este documento separa lo que está hecho y verificado de lo que falta. Está
pensado para leerse antes de comprometer fechas con el municipio o con un
comercio.

Fecha de esta revisión: 21 de septiembre de 2026.

---

## 1. Qué está implementado y verificado

| Capacidad | Estado | Cómo se verificó |
|---|---|---|
| Alta de comercio: borrador, datos, catálogo, solicitud | Hecho | `tests/backend-journeys.test.mjs`, `npm run e2e` |
| Revisión administrativa con aprobación y devolución con motivo | Hecho | Ídem |
| Estados del comercio: borrador, pendiente, devuelto, activo, pausado | Hecho | `tests/backend-journeys.test.mjs` |
| Catálogo: alta, edición, agotado, baja | Hecho | `tests/local-repository.test.mjs`, `npm run e2e` |
| Variantes simples de producto, con diferencia de precio | Hecho | `tests/variants.test.mjs`, `npm run e2e` |
| Búsqueda por comercio, rubro y productos | Hecho | `npm run e2e:demo` |
| Exploración y carrito sin cuenta | Hecho | `npm run e2e`, `npm run e2e:demo` |
| Carritos separados por comercio, un pedido por comercio | Hecho | `tests/backend-journeys.test.mjs` |
| Confirmación con detalle, subtotal, envío, total y modalidad | Hecho | `npm run e2e` |
| Retiro: recibido → aceptado → en preparación → listo → retirado | Hecho | `tests/backend-journeys.test.mjs` |
| Envío: … → listo → asignado → en camino → llegó → entregado | Hecho | Ídem |
| Rechazo con motivo y cancelación, con reposición de stock | Hecho | Ídem |
| Idempotencia ante doble confirmación | Hecho | Prueba concurrente + doble clic real en `npm run e2e` |
| Aislamiento entre comercios | Hecho | Pruebas negativas con sesiones independientes |
| Reparto propio de cada comercio | Hecho | `npm run e2e` |
| Taxi: alta revisada, disponibilidad, solicitud, aceptación, estados | Hecho | `tests/backend-journeys.test.mjs`, `npm run e2e` |
| Aceptación atómica: dos conductores no toman el mismo viaje | Hecho | Prueba concurrente real contra SQLite |
| Vencimiento de solicitudes y ausencia de disponibilidad | Hecho | `tests/backend-journeys.test.mjs` |
| Datos del pasajero ocultos hasta la aceptación | Hecho | Prueba de dominio y comprobación en el navegador |
| Autenticación con contraseña y sesiones independientes | Hecho (entorno local) | `tests/backend-journeys.test.mjs` |
| Validación de importes y permisos en el servidor | Hecho (entorno local) | Ídem |
| Instalable como PWA | Hecho | Manifiesto, service worker e íconos verificados en Chrome |
| Comportamiento sin conexión | Hecho | `npm run e2e` |

---

## 2. Qué NO está hecho

- **No hay pagos.** Los cobros en línea están deshabilitados por diseño. Las
  formas de pago disponibles están rotuladas como prueba.
- **No hay GPS.** No se sigue la posición de ningún vehículo ni repartidor. No
  se muestran móviles moviéndose en un mapa.
- **No hay notificaciones.** Ni push, ni correo, ni mensajes. Un comercio se
  entera de un pedido porque tiene el panel abierto.
- **No hay carga de fotografías propias.** Las imágenes son las incluidas en el
  repositorio.
- **No hay verificación de identidad.** Que una cuenta diga ser un comercio de
  Aluminé no prueba que lo sea.
- **No hay backend gestionado.** El entorno compartido es un servidor de
  desarrollo en una máquina, con SQLite y sin copias de resguardo.
- **No hay convenio, adhesión ni aval municipal.** El acompañamiento es lo que
  se propone evaluar.
- **No hay comercios ni taxistas incorporados.** Los ejemplos son ficticios.

---

## 3. Por qué la demostración pública no comparte datos

La demostración se publica en GitHub Pages, que sirve archivos estáticos y **no
ejecuta ningún backend**. Cada persona que la abre trabaja contra el
almacenamiento de su propio navegador.

Para demostrar operación compartida hace falta un servidor. En esta entrega ese
servidor existe y funciona, pero corre localmente (`npm run dev`). Lo que impide
publicarlo hoy:

1. **No hay un proyecto de backend de CAUCE autorizado.** No se usó ningún
   servicio existente: dar por propio un proyecto ajeno sería incorrecto y
   arriesgado.
2. **No hay decisión de hosting ni de costos.** Publicar el backend implica
   contratar un servicio, y eso no estaba autorizado en esta entrega.
3. **Faltan requisitos previos al primer dato real**: política de datos
   personales, copias de resguardo, y responsables de operación.

El diseño ya está preparado: la aplicación habla con el backend a través de una
interfaz única (`js/repositories/`), y el cambio de entorno es un módulo
(`js/runtime-env.js`). Migrar a Postgres con políticas por fila es un cambio de
implementación del repositorio del servidor, no una reescritura de la aplicación.

---

## 4. Diferencia entre "listo para presentación" y "listo para operación real"

**Listo para presentación (hoy):** los cuatro recorridos se pueden mostrar de
punta a punta, con sesiones separadas y datos compartidos entre ellas, en una
máquina. Las reglas que se muestran son las reales, no una maqueta: los estados,
los permisos, la idempotencia y el aislamiento están implementados y probados.

**Listo para operación real (falta):**

1. Backend gestionado, con copias de resguardo, recuperación y monitoreo.
2. Persistencia normalizada con políticas de acceso por fila, y pruebas
   negativas contra esas políticas.
3. Verificación de identidad de comercios y de conductores.
4. Para taxis: habilitación municipal del servicio, seguros, cuadro tarifario y
   condiciones de operación. Nada de eso está validado.
5. Definición y prueba de pagos, si se decide incorporarlos.
6. Notificaciones a prestadores.
7. Carga de fotografías por parte de cada comercio, con moderación.
8. Acuerdo escrito de roles, datos personales, soporte y continuidad.
9. Pruebas en teléfonos físicos. Las auditorías de esta entrega usan emulación.

---

## 5. Propuesta de piloto de 90 días

- **Días 1 a 30.** Incorporación acompañada de un grupo reducido de comercios y
  conductores. Carga de catálogos. Ajustes sobre uso real.
- **Días 31 a 60.** Operación abierta al público de Aluminé, con revisión
  semanal de incidencias.
- **Días 61 a 90.** Evaluación y decisión sobre continuidad.

**Qué se mediría**, siempre sobre operaciones efectivamente registradas:
altas completadas y publicadas; pedidos confirmados, entregados, rechazados y
cancelados por modalidad; solicitudes de taxi aceptadas, vencidas y sin
disponibilidad; tiempo entre solicitud y respuesta del prestador; incidencias
reportadas.

No se proyectan ventas ni se estiman ahorros: no hay base para hacerlo.

---

## 6. Defectos encontrados al ejecutar la aplicación, y corregidos

Ninguno de estos salió de leer el código: aparecieron al abrir la aplicación en
un navegador real y recorrerla.

| Defecto | Consecuencia | Corrección |
|---|---|---|
| Atributos `style` en línea bloqueados por la CSP | Estilos que no se aplicaban y consola con errores en inicio, taxi y paneles | Se eliminaron los estilos en línea; todo pasó a la hoja de estilos |
| El service worker recibía la CSP del documento (`connect-src 'none'`) | El worker no podía hacer ningún `fetch`: caché vacía y **la segunda pestaña quedaba rota** con `ERR_FAILED` | CSP propia para el worker (`default-src 'self'`), y respuesta de cortesía cuando no hay red ni copia |
| `h1, h2, h3, h4 { color: var(--ink) }` ganaba al color heredado del hero | Titular de inicio azul oscuro sobre verde oscuro: contraste **1,1:1** | Color explícito en el titular del hero, más velo sobre la fotografía |
| Elegir "envío" no redibujaba el formulario | El campo de dirección **nunca aparecía**: no se podía pedir con envío | Se redibuja al cambiar de modalidad, conservando lo escrito |
| Quedarse sin conexión redibujaba la vista | La consulta fallaba y la pantalla se reemplazaba por un error, **perdiendo los datos cargados** | Se avisa en el lugar, se bloquea la confirmación y el formulario queda intacto |
| El contador del carrito se resolvía después de marcar la vista como lista | La barra inferior mostraba un estado desfasado | La vista se marca lista recién cuando contenido y barra coinciden |
| Idempotencia calculada a partir del carrito | Un reintento tras confirmar fallaba con "carrito vacío" en lugar de devolver el pedido | El intento se resuelve antes de mirar el carrito |
| Indicador de entorno con contraste 3,61:1 y texto recortado | Poco legible, justo el dato que no puede pasar desapercibido | Color más oscuro y etiqueta corta, con el detalle en el `title` |
| Enlaces y controles por debajo de 44 px | Difíciles de tocar en móvil | Altura mínima en enlaces de retroceso, pastillas de rubro, cuenta y marca |
| Un comercio nuevo no tenía a quién asignar el reparto | El circuito de envío se cortaba en "asignado" | Alta de personas de reparto en el panel del comercio |

## 7. Supuestos tomados en esta entrega

1. **El entorno compartido se implementó localmente** porque no había un backend
   de CAUCE autorizado. Ver sección 3.
2. **Los paneles exigen sesión en los dos entornos.** En la demostración pública
   no hay contraseñas: se elige una identidad de ejemplo, rotulada como tal. La
   autenticación real se demuestra en el entorno local.
3. **El reparto de un comercio no son cuentas separadas.** Las personas de
   reparto se cargan como datos del comercio, y quien opera es la persona
   responsable. Un acceso propio para repartidores queda pendiente.
4. **Se conservaron los siete comercios de ejemplo** con sus fotografías, por
   coherencia visual. Están declarados como ficticios en la aplicación.
5. **Los estados heredados del motor de pedidos se mantuvieron** (incluido el
   paso "llegó a destino" antes de "entregado"), y se les dio nombres visibles
   acordes a cada modalidad, en lugar de alterar un motor ya probado.
6. **Se quitó el alta por WhatsApp.** Un formulario que sólo abre WhatsApp no es
   autorregistro. El número de contacto que estaba configurado ya no se usa.
7. **El taxi mantiene los estados intermedios del conductor** (llegué al origen,
   pasajero a bordo) porque son útiles para operar, y se presentan agrupados en
   la línea de tiempo del pasajero.
