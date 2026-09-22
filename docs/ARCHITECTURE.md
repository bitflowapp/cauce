# Arquitectura de CAUCE · Aluminé

## Idea central: una aplicación, entornos explícitos

Además de demo y SQLite, la rama productiva incorpora el repositorio Supabase
para cuentas y tenancy. El dominio existente permanece intacto. El build
`build:supabase` genera un artefacto separado, con su cliente SDK y configuración
explícita, sin alterar la demo de `dist`. Las capacidades todavía no implementadas
no se simulan. Ver [estado de fase 1](SUPABASE-PHASE1.md), incluyendo el bloqueo SMTP.

El riesgo obvio de tener una demostración pública y un entorno con backend es
terminar con **dos aplicaciones distintas** que se parecen. Para evitarlo, las
reglas de negocio están separadas del transporte y del almacenamiento:

```
js/core/       reglas puras (carrito, estados, validación, altas, despacho)
js/domain/     estado + comandos + consultas sobre ese estado
js/repositories/
   local-repository.js   ejecuta los comandos en el navegador (demostración)
   http-repository.js    los envía al backend local (entorno de pruebas)
   repository-factory.js elige según el entorno declarado
scripts/dev-server.mjs   ejecuta los MISMOS comandos, en una transacción
js/app.js                interfaz: no contiene reglas de negocio
```

Un comando es una función pura `(state, context, payload) → resultado`. No sabe
si corre en el navegador o en el servidor. El `context` trae el actor, el reloj y
el generador de identificadores.

Consecuencia práctica: una regla nueva o una corrección se escribe una sola vez y
vale para los dos entornos. Y lo que prueban `tests/local-repository.test.mjs` y
`tests/backend-journeys.test.mjs` es el mismo dominio por dos caminos.

## Selección de entorno: explícita, sin degradación silenciosa

`js/runtime-env.js`, tal como está versionado, declara el entorno de
demostración. El servidor de desarrollo sirve una versión generada del mismo
módulo que declara `local-backend`.

No hay detección automática. Si el entorno dice `local-backend` y el servidor no
responde, `http-repository` lanza `NETWORK_UNAVAILABLE` y la interfaz lo muestra.
**Nunca** cae de vuelta a datos locales: eso convertiría una falla en una
simulación silenciosa, que es justo lo que no puede pasar.

`createRepository` además rechaza cualquier configuración que pretenda habilitar
pedidos o pagos reales, en cualquier entorno.

## Autorización: el actor se deriva, no se declara

El navegador nunca envía quién es. El servidor lee la cookie de sesión, busca la
cuenta y construye el actor con `actorFor(state, accountId)`. Lo mismo hace el
repositorio local con su sesión guardada.

De ahí se desprende todo lo demás:

- Un comercio sólo ve y opera lo suyo: `requireBusinessOwnership` compara contra
  `business.ownerId`, no contra un identificador que venga en el pedido.
- La cola de revisión y las métricas exigen el rol `admin`.
- Las ofertas de viaje se filtran por `offeredTo` y recortan los datos del
  pasajero hasta que hay aceptación (`offerView`).
- Los importes se recalculan siempre con `quoteCart` contra el catálogo
  guardado. Un total enviado por el cliente se ignora, y hay una prueba que lo
  verifica.

## Concurrencia

**Backend local.** Cada mutación corre dentro de `BEGIN IMMEDIATE` … `COMMIT`
sobre SQLite. Dos conductores que aceptan el mismo viaje se serializan: el
primero gana y el segundo recibe `TRIP_ALREADY_TAKEN`. Hay una prueba que lanza
las dos aceptaciones en paralelo.

**Demostración.** Se usa Web Locks cuando el navegador lo ofrece; si no, las
operaciones de esa instancia se encolan. Entre pestañas sin Web Locks **no hay
atomicidad garantizada**. Esa limitación es del navegador y no se traslada al
backend.

**Pedidos.** `requestId` durable por carrito: un reintento idéntico devuelve el
mismo pedido sin descontar stock otra vez, y reutilizarlo con otros datos es un
conflicto explícito. Los cambios de estado exigen la versión esperada del pedido.

## Persistencia del backend local: qué es y qué no

El estado se guarda como un documento JSON en una tabla de SQLite, y cada
operación lo lee, aplica el comando y lo vuelve a escribir dentro de una
transacción.

**Por qué así.** Permite ejecutar exactamente el mismo dominio en los dos
entornos, sin una capa de mapeo que pueda divergir de las reglas.

**Qué no es.** No es un esquema normalizado ni tiene políticas de acceso por fila
a nivel de base. La autorización la aplica el servidor en el comando, no el
motor. Para un piloto real hace falta una base normalizada con políticas propias
y pruebas negativas contra esas políticas. El cambio queda contenido: hay que
reimplementar el almacenamiento del servidor, no la aplicación.

**Escala.** Reescribir el documento completo en cada operación no escala. Es
adecuado para un entorno de pruebas; no para producción.

## Contenido y red

El documento publicado declara `connect-src 'none'`: no puede abrir ninguna
conexión. El servidor de desarrollo sirve el mismo documento con `connect-src
'self'` para que hable con su propia API, y nada más.

El service worker recibe una CSP **propia** (`default-src 'self'`), porque la
política del documento no se le aplica: hereda la de su propia respuesta. Servirle
la del documento lo dejaba sin poder hacer ningún `fetch`, con la caché vacía y
la aplicación rota al abrir una segunda pestaña.

El service worker **no difiere operaciones**. Guardar una confirmación para
enviarla más tarde daría por recibido un pedido que ningún comercio vio. Sin
conexión, la aplicación lo dice y bloquea la confirmación; `scripts/check.mjs`
verifica que no aparezcan APIs de sincronización en segundo plano.

`scripts/check.mjs` también limita el acceso a red: sólo
`js/repositories/http-repository.js` puede usar `fetch`. En cualquier otro
archivo del runtime es un error de compilación.

## Reutilización de La Taba

`js/core/order-workflow.js` y su prueba se conservan **byte a byte**, con hash
verificado en cada `npm run check`. `commercial.js` es un subconjunto adaptado.
El origen y los hashes están en `docs/PROVENANCE.md`.

Sobre ese motor se construyó lo nuevo sin alterarlo. Por ejemplo, el rechazo de
un pedido no agregó un estado: se registra como cancelación con
`cancellation.kind = 'rejected'` y su motivo, de modo que la máquina de estados
heredada sigue intacta y la interfaz igual distingue un rechazo de una
cancelación.

## Decisiones acotadas

- **Una localidad: Aluminé.** El modelo incluye `localityId` en claves y ámbitos,
  pero no hay gestión de localidades en la interfaz.
- **Un pedido por comercio.** Cambiar de comercio conserva un carrito separado.
  No hay checkout mezclado ni cobro repartido.
- **El reparto es del comercio.** Se cargan como datos del comercio y opera la
  persona responsable. No hay flota ni mercado de repartidores, ni acceso propio
  para repartidores.
- **Despacho de taxis simple y explícito** (`DISPATCH_POLICY`): la solicitud se
  ofrece a todos los conductores aprobados y disponibles, y la toma el primero
  que responde; vence a los 10 minutos; un conductor con viaje en curso no puede
  tomar otro; una persona no acumula solicitudes abiertas. Es configurable en un
  solo lugar, y deliberadamente no intenta optimizar asignaciones que no podemos
  validar.
- **Sin tarifas ni tiempos estimados.** No hay cuadro tarifario validado en
  Aluminé ni datos de operación. Se dice que se coordinan con el conductor.
- **Sin mapas de seguimiento.** No hay GPS; no se dibujan móviles en movimiento.

## Frontera de seguridad, dicha sin vueltas

En la **demostración publicada**, el repositorio local **no es una frontera de
autorización**: cualquiera puede abrir las herramientas del navegador y editar
`localStorage`. Las comprobaciones de ámbito ahí son invariantes funcionales, no
seguridad. Por eso la demostración usa exclusivamente datos ficticios.

En el **entorno local con backend**, la autorización sí ocurre del lado del
servidor, con sesión real. Sigue siendo un entorno de desarrollo: escucha sólo en
loopback, no tiene copias de resguardo y no debe recibir datos personales reales.
