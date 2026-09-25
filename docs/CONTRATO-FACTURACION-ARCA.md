# Contrato de facturación electrónica con ARCA

Para la rama `feat/cauce-facturacion-arca-v1`.

**Estado: contrato listo (CONTRACT_READY). No hay facturación en producción.**

- **Qué existe hoy**: este contrato y la lógica que **no es fiscal**, en
  `js/core/invoicing.js`, con sus pruebas (`tests/invoicing.test.mjs`):
  - CUIT (dígito verificador, formato, enmascarado);
  - tipo de comprobante por condición frente al IVA;
  - importes tomados del pedido (Factura C; A y B se rechazan hasta tener la alícuota por producto);
  - detalle impreso;
  - quién puede pedir la factura y cuándo;
  - máquina de estados, estados vivos y reintentos escalonados;
  - formato del número y textos de la tarjeta.

  Nada de eso habla con ARCA, conoce secretos, arma números de comprobante o CAE, ni se muestra en la aplicación.
- **Qué no existe**: botón, tablas, funciones de la base, servicio, certificados ni credenciales fiscales. Tampoco hay simulación de ARCA: un comprobante existe sólo si ARCA devolvió CAE.
- **Para facturar de verdad** hacen falta, del comercio:
  - su CUIT, condición frente al IVA y un punto de venta habilitado para web service;
  - el certificado que ARCA emite a partir del CSR que genera el servidor.

  Y en el proyecto, habilitar las funciones de borde (§2).
- Los nombres de servicios, métodos y campos de ARCA se tienen que **verificar contra la documentación vigente de ARCA** (manuales de WSAA y WSFEv1) antes de escribir código. Donde este documento dice "verificar", el dato puede haber cambiado por normativa.

## 1. Reglas que no se negocian

1. **Toda comunicación con ARCA ocurre en el servidor.** Eso incluye WSAA (autenticación) y WSFEv1 (autorización de comprobantes). El navegador nunca llama a ARCA.
2. **El frontend nunca ve ni guarda secretos fiscales.** Lo que no puede aparecer en `localStorage`, IndexedDB, Storage público, respuestas de la API, registros ni el bundle:
   - la clave privada;
   - el certificado con su clave;
   - el TRA firmado;
   - el `Token` y el `Sign` de WSAA.
3. **La clave privada nace y se queda en el servidor.**
   - El servidor genera el par de claves y entrega sólo el CSR (público).
   - El titular lo presenta en ARCA y devuelve el certificado `.crt`, que también es público.
   - Nadie sube ni descarga una clave privada.
4. **Un pedido se factura una sola vez.** Lo garantiza la base, no la interfaz (ver §6).
5. **No hay simulación de ARCA ni comprobantes inventados.** Un comprobante existe sólo si ARCA devolvió CAE. Las pruebas usan el entorno de homologación de ARCA, con un certificado de prueba, en un job opcional.
6. **La base es la autoridad de permisos**, como en el resto de CAUCE: RLS y funciones `security definer` que verifican la membresía. La interfaz sólo decide qué mostrar.

## 2. Piezas

| Pieza | Rol |
| --- | --- |
| Postgres (Supabase) | Perfil fiscal, comprobantes, auditoría y las funciones que abren una solicitud. |
| Servicio de facturación | Edge Function de Supabase (Deno) o un worker equivalente. Es lo único que habla con ARCA y lo único que lee secretos. Hoy el proyecto no tiene funciones de borde (el stack local se levanta con `-x edge-runtime`): la rama tiene que habilitarlas. |
| Supabase Vault | Clave privada y ticket de WSAA, cifrados. Sólo el servicio los descifra. |
| WSAA · `LoginCms` | Con un TRA firmado (CMS) para el servicio `wsfe` devuelve `Token` + `Sign`, válidos unas 12 horas. Hay que reutilizarlos: ARCA rechaza pedir otro mientras el vigente no vence. |
| WSFEv1 | `FEDummy` (estado del servicio), `FECompUltimoAutorizado`, `FECAESolicitar`, `FECompConsultar` y `FEParamGet*` (tipos y puntos de venta). |

Puntos de acceso (verificar):

| Servicio | Homologación | Producción |
| --- | --- | --- |
| WSAA | `https://wsaahomo.afip.gov.ar/ws/services/LoginCms` | `https://wsaa.afip.gov.ar/ws/services/LoginCms` |
| WSFEv1 | `https://wswhomo.afip.gov.ar/wsfev1/service.asmx` | `https://servicios1.afip.gov.ar/wsfev1/service.asmx` |

## 3. Comercio ↔ configuración fiscal

Relación **1 a 1**: `public.business_tax_profiles`, con `business_id` como clave primaria (referencia a `businesses`). Sin secretos:

| Campo | Tipo y reglas |
| --- | --- |
| `business_id` | `uuid` PK → `businesses(id)` |
| `cuit` | `text`, 11 dígitos con dígito verificador válido (`private.cuit_valido`) |
| `razon_social` | `text` |
| `condicion_iva` | `monotributo` · `responsable_inscripto` · `exento` |
| `punto_venta` | `integer` 1–99999. Tiene que estar dado de alta en ARCA para factura electrónica por web service. |
| `tipo_comprobante` | Por defecto: 11 = Factura C (monotributo); 6 = Factura B o 1 = Factura A (responsable inscripto). Verificar con `FEParamGetTiposCbte`. |
| `concepto` | 1 = productos (el caso de CAUCE); 2 y 3 exigen fechas de servicio. |
| `inicio_actividades`, `ingresos_brutos`, `domicilio_comercial` | Para la representación impresa. |
| `ambiente` | `homologacion` (por defecto) · `produccion` |
| `certificado_estado` | `sin_certificado` · `csr_generado` · `certificado_cargado` · `vencido` |
| `certificado_vence_at` | `timestamptz`, tomado del certificado (dato público) |
| `estado` | `borrador` · `lista` · `suspendida`. `lista` sólo después de un `FEDummy` y un `FECompUltimoAutorizado` exitosos en ese ambiente. |
| `updated_by`, `updated_at` | Auditoría básica |

- `unique (cuit, punto_venta, ambiente)`: cada comercio de CAUCE usa su propio punto de venta. Así la numeración de un comercio no se mezcla con la de otro.
- Los secretos van aparte, en `private.tax_credentials`. Esa tabla no tiene permisos para `anon` ni `authenticated`: sólo el rol de servicio la usa. Guarda:
  - el id del secreto de Vault con la clave privada;
  - el CSR y el certificado (públicos);
  - las fechas de rotación.
- El ticket de WSAA se cachea en Vault (o en una columna cifrada) con su vencimiento, compartido entre instancias del servicio. Nunca se expone.

## 4. Comprobante asociado al pedido

`public.invoices`, con `order_id` y `business_id` y la clave foránea compuesta `(order_id, business_id) → orders(id, business_id)`. No se puede facturar un pedido de otro comercio.

| Campo | Contenido |
| --- | --- |
| `idempotency_key` | `uuid` de la solicitud; `unique (business_id, idempotency_key)` |
| `cuit`, `punto_venta`, `cbte_tipo`, `concepto`, `ambiente` | Copia del perfil fiscal al momento de emitir |
| `cbte_numero` | `bigint`, se asigna al pedir la autorización (ver §5) |
| `cbte_fecha` | Fecha del comprobante en hora de Aluminé, dentro del rango que ARCA admite para el concepto (verificar) |
| `receptor_doc_tipo`, `receptor_doc_nro`, `receptor_nombre`, `receptor_condicion_iva` | Consumidor final sin identificar = tipo 99 y número 0. Hay que identificar al receptor cuando la normativa vigente lo exige (monto, condición frente al IVA). Verificar los campos obligatorios de `FECAESolicitar`. |
| `moneda`, `cotizacion` | `PES`, 1 |
| `importe_neto`, `importe_iva`, `importe_exento`, `importe_no_gravado`, `importe_tributos`, `importe_total` | `numeric(15,2)`. **Subtotal y total salen del pedido** (`orders.subtotal_ars`, `delivery_fee_ars`, `total_ars`), nunca del cliente. `importe_total = orders.total_ars`. |
| `detalle` | `jsonb` con los productos (nombre, variante, cantidad, precio, total) y el envío como renglón propio. Es para la representación impresa: WSFEv1 no recibe el detalle. |
| `estado` | `pendiente` · `enviando` · `autorizada` · `rechazada` · `error` · `incierta` |
| `cae`, `cae_vencimiento` | CAE (14 dígitos) y su fecha de vencimiento, tal como los devuelve ARCA |
| `resultado` | `A`, `R` o `P`, de ARCA |
| `observaciones`, `errores` | `jsonb` con los códigos y mensajes de ARCA |
| `intentos`, `proximo_intento_at`, `ultimo_error` | Reintentos (§5) |
| `solicitada_por`, `solicitada_at`, `autorizada_at`, `created_at`, `updated_at` | Quién y cuándo |

Restricciones:

- `unique (order_id) where estado in ('pendiente','enviando','autorizada','incierta')`: un solo comprobante vivo por pedido.
- `unique (cuit, punto_venta, cbte_tipo, cbte_numero, ambiente) where cbte_numero is not null`.
- `check (estado <> 'autorizada' or (cae is not null and cae_vencimiento is not null and cbte_numero is not null))`.
- Nada se borra. Anular una venta facturada requiere una nota de crédito asociada (ver §10).

Montos:

- **Monotributo, Factura C**: neto = total; sin IVA discriminado.
- **Responsable inscripto, Factura A o B**: IVA discriminado por alícuota. Hoy el catálogo **no tiene alícuota por producto** (§10).

## 5. Flujo "Emitir factura"

1. El titular o encargado/a toca **Emitir factura** en un pedido entregado y cobrado (`status = 'delivered'`, `payment_status = 'settled'`). La interfaz genera una `idempotency_key` para esa intención y la reusa si reintenta la misma.
2. La interfaz llama a la RPC `request_invoice(order_id uuid, idempotency_key uuid, receptor jsonb default null)`, que es `security definer`. La RPC:
   - Exige titular o encargado/a del comercio del pedido; el equipo y los demás reciben `42501`.
   - Exige el pedido entregado y cobrado, y el perfil fiscal en `lista`.
   - Devuelve el comprobante vivo si ya existe, o el de esa misma `idempotency_key`. Nunca crea un segundo comprobante.
   - Calcula los importes desde el pedido y deja el comprobante en `pendiente`, con su evento de auditoría.
3. **El servicio de facturación** toma los pendientes. Lo dispara la base (webhook o `pg_net`) y, de respaldo, un cron.
   1. Toma un lock por `(cuit, punto_venta, cbte_tipo, ambiente)` (`pg_advisory_xact_lock`): la numeración queda en serie.
   2. Obtiene el ticket de WSAA del cache, o lo renueva si vence en menos de 10 minutos.
   3. Pide `FECompUltimoAutorizado`; el número es el último + 1. Guarda `cbte_numero`, `estado = 'enviando'` e `intentos + 1` **antes** de llamar a ARCA.
   4. Llama a `FECAESolicitar` con un solo comprobante (`CantReg = 1`, `CbteDesde = CbteHasta = número`) e importes consistentes: `ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpIVA + ImpTrib`.
   5. Registra lo que devolvió ARCA:
      - `A` → `autorizada`, con `cae`, `cae_vencimiento` y observaciones.
      - `R` → `rechazada`, con errores y observaciones. El número no quedó usado; después de corregir se reintenta con número nuevo.
4. **Errores y reintentos**:
   - **Sin respuesta después de enviar** (timeout, corte): `incierta`. **Nunca se reenvía a ciegas.** Primero se consulta `FECompConsultar(tipo, punto de venta, número)`:
     - Si el comprobante existe con los mismos importes y fecha, queda `autorizada` con ese CAE.
     - Si no existe, vuelve a `pendiente`.
   - **ARCA caído antes de enviar** (`FEDummy` falla, conexión rechazada): `error`, con `proximo_intento_at` escalonado (1, 2, 5, 15 y 60 minutos) y un tope de intentos. Pasado el tope queda en `error` y pide acción humana ("Reintentar ahora").
   - **Rechazos de datos** (CUIT del receptor, fecha, importes) no se reintentan solos: se muestran y se corrigen.
5. El panel escucha `invoices` por Realtime, con RLS, y consulta de respaldo como con los pedidos. La tarjeta cambia de estado sin recargar.

## 6. Idempotencia: por qué no puede haber doble factura

| Riesgo | Defensa |
| --- | --- |
| Doble toque o dos pantallas | `withBusy` en la interfaz y la misma `idempotency_key`; la RPC devuelve la fila existente. |
| Dos personas facturan el mismo pedido | Índice único parcial por `order_id` sobre los estados vivos. |
| Dos comprobantes con el mismo número | Lock por `(cuit, punto_venta, cbte_tipo, ambiente)` y `unique` sobre el número. |
| Timeout: ¿se autorizó o no? | Estado `incierta` y `FECompConsultar` antes de cualquier reintento. |
| Pedido cancelado después de facturar | La cancelación se bloquea o avisa si hay factura autorizada; se anula con nota de crédito (§10). |

## 7. Permisos

| Acción | Titular | Encargado/a | Equipo | Cliente | Otro comercio / anónimo |
| --- | :-: | :-: | :-: | :-: | :-: |
| Cargar o editar el perfil fiscal, generar CSR, cargar certificado, probar la conexión | ✓ | ve el estado | — | — | — |
| Emitir factura y reintentar | ✓ | ✓ | — | — | — |
| Ver los comprobantes del comercio | ✓ | ✓ | — | — | — |
| Ver o descargar el comprobante de su pedido | — | — | — | propuesta v2 (función acotada) | — |

Todo se verifica en la base (RLS y `security definer`). Las pruebas negativas son obligatorias: equipo, otro comercio, anónimo y sesión de compra sin cuenta.

## 8. Auditoría

- `private.invoice_events`, sólo agregado (sin `update` ni `delete`, con trigger que lo impide). Cada fila guarda:
  - `invoice_id`, `business_id`;
  - `from_status` y `to_status`;
  - `actor_id` (`null` para el servicio) y `actor_role` (`owner`, `manager`, `system`);
  - `detalle` (número, resultado y códigos de ARCA, intento);
  - `created_at`.
- Se registra cada solicitud, cada intento, cada respuesta de ARCA y cada cambio del perfil fiscal: quién, cuándo y qué campo, sin el valor de secretos.
- **Nunca se registra**:
  - la clave;
  - el certificado con su clave;
  - el TRA firmado;
  - `Token` o `Sign`;
  - el XML firmado completo.
- Los comprobantes y su auditoría no se borran: se conservan según la normativa fiscal y contable vigente.

## 9. Interfaz requerida para "Emitir factura"

### Repositorio

| Nombre | Qué hace |
| --- | --- |
| consulta `invoiceProfile({ businessId })` | Estado del perfil fiscal: `estado`, CUIT enmascarado, punto de venta, tipo, ambiente, estado y vencimiento del certificado. |
| comando `invoice.request({ orderId, idempotencyKey })` | Llama a `request_invoice` y devuelve el comprobante con su estado. |
| comando `invoice.retry({ invoiceId })` | Sólo desde `rechazada` (con datos corregidos) o `error`. |
| lectura de pedidos | Embebe el comprobante vivo de cada pedido (`invoices(...)`), sujeto a RLS. |
| sólo titular: `invoiceProfile.save`, `.generateCsr`, `.uploadCertificate`, `.verify` | Todos ejecutados en el servidor. `generateCsr` devuelve sólo el CSR; `uploadCertificate` recibe sólo el `.crt` público; `verify` corre `FEDummy` y `FECompUltimoAutorizado`. |

### Tarjeta del pedido

El botón **Emitir factura** va en Completados y en Últimas ventas. Aparece para titular y encargado/a cuando:

- el pedido está entregado y cobrado;
- el perfil fiscal está en `lista`;
- no hay comprobante vivo.

| Estado | Lo que se ve |
| --- | --- |
| `pendiente`, `enviando` | "Emitiendo factura…" (deshabilitado) |
| `autorizada` | "Factura C 0003-00000123 · CAE … · vence dd/mm/aaaa" y "Ver comprobante" |
| `rechazada` | "ARCA rechazó la factura: …" y "Revisar y reintentar" |
| `incierta` | "Confirmando con ARCA…" (se resuelve sola) |
| `error` | "No pudimos conectar con ARCA. Reintentamos a las HH:MM." y "Reintentar ahora" |

- Sin conexión, el botón queda deshabilitado, como el resto del panel.
- Si el perfil fiscal no está listo, el titular ve "Configurá la facturación" en lugar del botón.

### Configuración › Facturación (titular)

CUIT, razón social, condición frente al IVA, punto de venta, tipo por defecto y ambiente, más estos pasos:

1. "Generar solicitud de certificado" descarga el CSR.
2. "Cargar certificado (.crt)".
3. "Probar conexión con ARCA".

Mientras no haya certificado vigente y prueba exitosa, no se puede facturar.

### Comprobante impreso o PDF

Con los datos del perfil y del comprobante, el CAE, su vencimiento y el **código QR que exige ARCA**: la URL de ARCA con los datos del comprobante en base64 (verificar el formato vigente). Se arma con datos ya autorizados; ninguno es secreto.

La interfaz **nunca**:

- arma números de comprobante ni CAE;
- muestra una "factura" sin CAE;
- guarda nada fiscal en el navegador.

## 10. Pendientes que la rama tiene que resolver antes de facturar en producción

1. **Responsable inscripto.** Hace falta la alícuota de IVA por producto (y del envío). El catálogo no la tiene; hasta sumarla, la v1 puede limitarse a Factura C (monotributo).
2. **Identificación del receptor.** El pedido tiene nombre, teléfono y dirección, no DNI ni CUIT. Hay que pedirlos, opcionales al comprar o al facturar, cuando la normativa lo exige.
3. **Notas de crédito** (tipos 3, 8 y 13 con `CbtesAsoc`) para anular o devolver una venta facturada. También bloquear o avisar al cancelar un pedido ya facturado.
4. **Más de un punto de venta por comercio**, y la contingencia (CAEA): fuera de la v1.
5. **Vencimiento del certificado.** Aviso al titular con anticipación y `estado = 'suspendida'` al vencer.

## 11. Pruebas mínimas de la rama

Ya cubierto por `tests/invoicing.test.mjs`: dígito verificador del CUIT, tipo por defecto, importes de Factura C y el rechazo de A/B sin alícuotas, consistencia de importes, detalle, permisos por rol y estado, máquina de estados (incierta no se reenvía, autorizada no cambia), escalonado con tope, número de comprobante y que el módulo no hace red ni toca secretos.

Falta, con la implementación:

- **Unitarias**: montos por tipo de comprobante, dígito verificador del CUIT, máquina de estados, escalonado de reintentos y armado del QR.
- **Integración** contra el stack local:
  - RLS y permisos (equipo, otro comercio, anónimo);
  - dos `request_invoice` en paralelo para el mismo pedido dejan un solo comprobante;
  - repetir la misma `idempotency_key` devuelve la misma fila;
  - `incierta` no reenvía sin consultar.
- **Contrato con ARCA en homologación**: job aparte, manual u opcional, con el certificado de prueba como secreto del repositorio. Nunca en el CI de cada PR ni contra producción.
- **E2E**: el titular emite y ve el CAE (homologación); el equipo no ve el botón; sin conexión el botón queda deshabilitado.
- **Seguridad**: un escaneo del bundle y de los registros confirma que no aparece ninguna clave, certificado privado, `Token` ni `Sign`.
