# CAUCE · Aluminé

Plataforma local de LUNA para comercio y movilidad en Aluminé (Neuquén).

Permite que un comercio se dé de alta y publique su catálogo, que una persona
compre con retiro o con envío del propio comercio, que el comercio gestione sus
pedidos y su reparto, que una persona solicite un taxi y un conductor lo acepte,
y que administración revise las altas y supervise la operación.

**Estado: versión demostrable, no operativa.** No hay pagos reales, ni prestadores
incorporados, ni convenio municipal. El detalle está en
[docs/ESTADO-PILOTO.md](docs/ESTADO-PILOTO.md).

---

## Dos entornos, una sola aplicación

Las reglas de negocio viven en `js/domain/` y `js/core/`, y son **las mismas** en
los dos entornos. Lo único que cambia es dónde se ejecutan y dónde se guardan los
datos. El entorno se resuelve en tiempo de compilación (`js/runtime-env.js`): no
hay detección automática ni degradación silenciosa de backend a simulación.

| | Demostración (la que se publica) | Entorno local de pruebas |
|---|---|---|
| Persistencia | Navegador de cada persona (`localStorage`) | SQLite compartida (`.local/cauce-dev.sqlite`) |
| Sesiones | Identidades de ejemplo, sin contraseña | Correo y contraseña, cookie `HttpOnly` |
| Validación | En el navegador | En el servidor, dentro de una transacción |
| Entre personas | No se comparte nada | Sí: varias sesiones sobre los mismos datos |
| Red | `connect-src 'none'`: no puede abrir conexiones | Sólo el mismo origen |

GitHub Pages **no aloja ningún backend**: sirve archivos estáticos. La operación
compartida sólo existe en el entorno local.

---

## Cómo ejecutar

Requiere Node.js 22 o posterior. No hace falta instalar dependencias.

### Demostración (lo que se publica)

```powershell
npm start
```

Abre <http://127.0.0.1:4173>. Todo queda en tu navegador.

### Entorno local de pruebas, con backend

```powershell
npm run dev:seed
```

Abre <http://127.0.0.1:4180>. La primera vez, `--seed` crea cuatro cuentas
sintéticas (clienta, comercio, administración, taxista) con contraseñas
generadas al azar y las escribe en `.local/dev-credentials.json`, que **no se
versiona**. Para volver a empezar de cero, borrá la carpeta `.local/`.

Después del primer arranque alcanza con `npm run dev`.

Para demostrar operaciones entre personas distintas, abrí cada rol en un
**navegador o perfil separado**: varias pestañas del mismo navegador comparten
la misma cookie de sesión y no demuestran aislamiento.

---

## Recorridos de la presentación

Los cuatro se ejecutan automáticamente con `npm run e2e`. A mano, en el entorno
local con backend:

**1. Alta y publicación de un comercio**
Ingresar → *Sumar mi comercio* → crear cuenta → crear el comercio (queda en
borrador) → completar datos y modalidades de entrega → *Catálogo* → cargar un
producto → *Datos* → **Solicitar publicación**. Con la cuenta de administración,
en otro navegador: *Administración* → devolver con observaciones o aprobar. Al
aprobar, el comercio aparece en el listado público.

**2. Compra con retiro y con envío**
*Comercios* → elegir uno → agregar productos → *Carrito* → elegir retiro o
envío → completar datos → confirmar. El comercio, en su sesión: *Aceptar* →
*Informar preparación* → *Listo* → (envío) *Asignar reparto* → *Marcar salida* →
*Marcar entregado*. El reparto se da de alta en la pestaña *Reparto*.

**3. Solicitud y aceptación de taxi**
Con una cuenta: *Registrarme como taxista* → completar el alta → administración
la aprueba → el taxista se marca **disponible**. Desde otra sesión: *Taxi* →
origen, destino, referencia y pasajeros → *Solicitar taxi*. El taxista ve la
solicitud sin nombre ni teléfono, la acepta, y recién ahí recibe el contacto.

**4. Revisión administrativa y supervisión**
*Administración*: cola de altas pendientes y totales agregados de lo que
efectivamente ocurrió en el entorno. Sin direcciones ni recorridos individuales.

---

## Qué usa persistencia remota y qué sigue siendo simulación

| Capacidad | Demostración publicada | Entorno local con backend |
|---|---|---|
| Alta de comercios con revisión | Local al navegador | **Compartida y autenticada** |
| Catálogo, carritos, pedidos | Local al navegador | **Compartida y autenticada** |
| Estados de pedido y reparto | Local al navegador | **Compartida y autenticada** |
| Taxis: alta, despacho, estados | Local al navegador | **Compartida y autenticada** |
| Autenticación con contraseña | No: identidades de ejemplo | **Sí** (scrypt + cookie HttpOnly) |
| Validación de importes y permisos | En el navegador | **En el servidor** |
| Pagos en línea | **Deshabilitados** | **Deshabilitados** |
| Ubicación GPS de móviles | **No existe** | **No existe** |
| Notificaciones a prestadores | **No existen** | **No existen** |
| Carga de fotos propias | **No implementada** | **No implementada** |

---

## Pruebas

```powershell
npm run verify       # sintaxis, imports, compuertas, 158 pruebas Node, builds
npm run verify:full  # lo anterior + recorridos de navegador + auditoría visual
```

Por separado:

| Comando | Qué hace |
|---|---|
| `npm test` | Pruebas de dominio, repositorio, backend y copy |
| `npm run e2e` | Los tres recorridos en navegadores separados, contra el backend |
| `npm run e2e:demo` | Recorrido sobre la demostración publicada |
| `npm run audit:visual` | 360, 390, 430 y escritorio: desbordes, área táctil, contraste |
| `npm run audit:visual:backend` | Lo mismo sobre el entorno con backend |

Las pruebas de navegador usan el Chrome o Edge ya instalado mediante el
protocolo DevTools (`tests/lib/cdp.mjs`): no descargan navegadores. Si hace
falta, se indica la ruta con `CAUCE_CHROME_PATH`.

**Son mediciones con emulación móvil en un navegador de escritorio, no pruebas
en un teléfono físico.**

Los resultados quedan en `evidence/`: `e2e-results.json`, `demo-results.json`,
`audit-results.json` y las capturas correspondientes.

---

## Estructura

```
js/core/         reglas puras (carrito, estados, validación, altas, despacho)
js/domain/       estado, comandos y consultas: el dominio compartido
js/repositories/ local (navegador) y http (backend), misma interfaz
js/ui/           formato e iconografía
js/app.js        shell: enrutador por hash, vistas y acciones
scripts/         servidor estático, backend local, build, íconos, comprobaciones
tests/           pruebas Node, recorridos de navegador y auditoría visual
docs/            arquitectura, procedencia, estado del piloto
```

## Seguridad y límites que no se apagan

- `mode: 'demo'` con `liveOrders` y `livePayments` en `false`: la fábrica de
  repositorios se niega a construir nada si eso cambia.
- El documento publicado bloquea toda conexión saliente (`connect-src 'none'`).
- El actor de cada operación se deriva de la sesión, nunca de lo que envía el
  navegador; los importes se recalculan contra el catálogo guardado.
- Sin acceso administrativo por parámetro de URL.
- Sin credenciales en el repositorio, en el frontend ni en las capturas.

Más detalle en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/ESTADO-PILOTO.md](docs/ESTADO-PILOTO.md) y
[docs/PROVENANCE.md](docs/PROVENANCE.md).
