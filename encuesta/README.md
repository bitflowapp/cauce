# CAUCE · Aluminé — encuesta

Encuesta estática para GitHub Pages con guardado anónimo en Google Sheets mediante Google Apps Script. Usa HTML, CSS y JavaScript vanilla; el frontend no incorpora dependencias ni servicios pagos.

## Estructura

- `index.html`, `styles.css`: interfaz, accesibilidad básica y diseño responsive.
- `app.js`: preguntas, validación visual, avance local, reintentos y estados de confirmación.
- `analytics.js`: GA4 opcional; permanece desactivado si el Measurement ID está vacío.
- `google-apps-script/Code.gs`: endpoint, validación, idempotencia, escritura, confirmación de lectura y panel.
- `google-apps-script/appsscript.json`: runtime y permisos solicitados.

## Cómo se confirma un envío

El navegador guarda el avance en `localStorage` y manda las respuestas con un formulario POST dirigido a un iframe oculto. Luego consulta un endpoint JSONP de solo lectura que busca el ID de respuesta, comprueba su estado y devuelve un recibo opaco. La página solo muestra «Respuestas recibidas» después de esa lectura. No se toma una respuesta CORS opaca como confirmación.

Apps Script Content Service redirige sus respuestas a una URL temporal `script.googleusercontent.com`; JSONP permite leer el resultado de la consulta desde el navegador sin una llamada `fetch` cross-origin. La ruta JSONP solo entrega el estado y un recibo, nunca las respuestas. Se restringe el nombre de callback a un patrón fijo y el ID es un UUID impredecible. El endpoint de escritura es público y no tiene autenticación por participante: validación e idempotencia reducen errores y duplicados, pero no impiden bots o abuso deliberado. Apps Script y Google pueden procesar metadatos técnicos de solicitudes; el código no lee ni guarda direcciones IP.

Las respuestas completadas y aún no confirmadas permanecen en el dispositivo y se reintentan al recuperar conexión, al recargar y cada 30 segundos mientras la página siga abierta. Un UUID y hash canónico hacen idempotentes los reintentos. Si `localStorage` está bloqueado, el avance solo vive en memoria y se pierde al cerrar la pestaña.

## Configuración de Google

Una persona con una cuenta Google debe crear y autorizar el proyecto y publicar el endpoint. No se guardan credenciales ni IDs en este repositorio.

1. Abrí [script.google.com](https://script.google.com/) con la cuenta propietaria y creá un proyecto independiente.
2. En **Project Settings**, activá la opción para mostrar el archivo de manifiesto `appsscript.json`. Reemplazá el manifiesto por `google-apps-script/appsscript.json` y pegá `Code.gs` en el editor.
3. Ejecutá `setupSurvey` desde el editor. Aceptá el permiso de lectura y escritura de Google Sheets que solicita el propietario. La función crea una hoja llamada **CAUCE Aluminé · Encuesta comercial** en el Drive privado de su propietario, las pestañas `Responses`, `Starts`, `Dashboard` y `Assumptions`, sus fórmulas y gráficos. Copiá la URL desde el registro de ejecución o ejecutá `getSurveySheetUrl`.
4. Ejecutá `runValidationTests` en el editor y comprobá que termine con `All Apps Script validation tests passed.` Estos son tests locales del código de validación; no prueban la disponibilidad del servicio de Google.
5. Elegí **Deploy → New deployment → Web app**. Configurá **Execute as: Me** y **Who has access: Anyone** para recibir envíos anónimos desde Pages. Publicar para acceso anónimo puede no estar permitido por políticas de una cuenta Google Workspace administrada; en ese caso hace falta una cuenta que permita el acceso público. Conservá el proyecto y la hoja bajo control de la cuenta propietaria.
6. Copiá la URL del web app terminada en `/exec`. En `app.js`, reemplazá `appsScriptUrl: ""` con esa URL. No uses la URL de prueba `/dev` ni publiques IDs, tokens de cuenta o secretos.
7. Actualizá la versión de encuesta en `app.js` y `Code.gs` solo en conjunto. Luego publicá Pages desde la rama aprobada.

Apps Script se ejecuta como el propietario para escribir en su hoja. Quienes responden no inician sesión ni obtienen acceso a la hoja. La hoja se crea con acceso privado y protecciones de pestañas; no la compartas públicamente.

## Prueba de integración real

Después de autorizar y desplegar el script y configurar el `/exec` en `app.js`:

1. Abrí la encuesta desde su URL de GitHub Pages en una ventana privada de teléfono o navegador.
2. Completá respuestas de prueba en varias rutas, incluyendo `fixed_monthly` (muestra monto mensual) y `commission_only` (omite esa pregunta).
3. Esperá a que aparezca «Respuestas recibidas y verificadas en el almacenamiento privado».
4. En la hoja privada, confirmá que hay una fila en `Responses` con igual ID, `send_status=received` y recibo, y una fila completada en `Starts`. Confirma la escritura y lectura de esa implementación en Google; no alcanza con ver el POST iniciar.
5. Vuelve a enviar el mismo ID durante pruebas controladas para comprobar que no aparece una segunda fila. No edites respuestas de participantes reales.
6. Verificá en un teléfono que las preguntas, el mensaje pendiente/error, reintento y confirmación se puedan operar sin zoom horizontal.

Antes del despliegue, el URL queda vacío intencionalmente. En ese estado no se confirma ninguna encuesta y la interfaz informa el envío pendiente/error; no muestra un éxito ficticio. Esta entrega no pudo ejecutar una escritura real porque la autorización de Google y la URL `/exec` pertenecen a la cuenta propietaria y no existen aún en el repositorio.

## Panel y lectura de resultados

- `Responses` conserva cada respuesta, fecha de recepción del servidor, versión, opciones, estado, recibo y hash interno de idempotencia.
- `Starts` registra inicios con un ID anónimo y estado `started`/`completed`. El panel cuenta como abandonos solo los inicios que siguen abiertos después de 24 horas. Las sesiones cortas abiertas aún no se consideran abandono.
- `Dashboard` resume completados, inicios, abandonos maduros, rubros, canales, dificultades, interés, modelos, rangos y funciones; incluye tablas temporales, gráficos y escenarios para 10, 20, 50 y 100 comercios.
- Los escenarios son extrapolaciones de intención declarada, no ventas ni ingresos reales. Los precios de suscripción se dejan vacíos en `Assumptions` para que el propietario ingrese hipótesis propias. El escenario de comisión muestra cuota cero; no estima comisiones porque la encuesta no pregunta volumen de ventas.
- Ejecutá `refreshDashboard` si alguien reemplaza fórmulas o gráficos manualmente. No edites ni borres las columnas de ID, hash y recibo de `Responses`.

## Copias de seguridad

En Google Sheets, usá **File → Make a copy** con una cuenta administradora y guardá una copia con fecha en Drive privado. Para exportar una instantánea, usá **File → Download → Microsoft Excel (.xlsx)** y guardala en un destino privado. No publiques ni envíes la hoja de respuestas.

## Cuotas y límites

Apps Script no tiene costo mensual separado dentro de las cuotas disponibles de la cuenta, pero está sujeto a límites de ejecución, lecturas/escrituras de Sheets y políticas de acceso público. Las cuotas pueden variar por tipo de cuenta y Google puede cambiarlas; solicitudes abusivas pueden agotar la cuota del propietario y detener recepciones. Consultá las [cuotas vigentes de Apps Script](https://developers.google.com/apps-script/guides/services/quotas), [web apps](https://developers.google.com/apps-script/guides/web), [Content Service y redirecciones](https://developers.google.com/apps-script/guides/content) y [LockService](https://developers.google.com/apps-script/reference/lock/lock-service).

## Desarrollo local

Abrí `index.html` directamente o serví esta carpeta con cualquier servidor estático. La encuesta funciona dentro del subdirectorio `/encuesta/`. El workflow de GitHub Pages del repositorio copia esta carpeta al sitio existente.

### Analítica opcional

Analytics queda apagado con el Measurement ID vacío. Al configurarlo, GA4 recibe vistas, inicios, preguntas, opciones seleccionadas, finalización, compartir y clics al piloto; no recibe texto libre, IDs de respuesta ni campos personales.
