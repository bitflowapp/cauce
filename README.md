# CAUCE · Aluminé — 0.1.0

**Primera implementación local ejecutable. NO lista para producción.**

Esta entrega reutiliza el workflow real de La Taba y comprobaciones comerciales,
y agrega una demostración de CAUCE con varios comercios. **No es el clon completo
solicitado**: no incluye la integración operativa de Supabase, Auth, RLS, Mercado
Pago, GPS ni el rider Android de La Taba. No publica nada ni modifica producción.

## Abrir

Con Node.js 22 o posterior, dentro de esta carpeta:

```powershell
npm start
```

Abrir `http://127.0.0.1:4173`. No es necesario instalar dependencias npm para
arrancar o ejecutar las pruebas Node. Detener con Ctrl+C.
En Windows también se puede ejecutar `INICIAR-CAUCE.cmd`.

`CAUCE-demo.html` es una compilación autónoma, sin recursos de red. Su apertura
como archivo depende de que el navegador permita almacenamiento local en archivos.
La vía reproducible del proyecto es `npm start`. La apertura directa de archivos
y la navegación HTTP del navegador no pudieron certificarse en este entorno.

## Qué se puede probar

Tres comercios y trece productos FICTICIOS, búsqueda, filtro de apertura, catálogo,
carritos separados por comercio, cantidades, límites de stock, retiro y delivery
de prueba, pedido mínimo, historial y estados del pedido. Panel demo para cambiar
precios/stock/disponibilidad, abrir o cerrar el comercio y gestionar sus pedidos.
Panel de reparto demo con asignación al repartidor del propio comercio.

Circuito sugerido: La Orilla → agregar producto → carrito → pedido de prueba →
panel demo del comercio → confirmar/preparar/listo → asignar repartidor → panel
de reparto → entrega. Para retiro, el comercio entrega desde el estado listo.

Los paneles son una simulación libre de roles, NO un sistema autenticado.
No ingresar información personal real ni usarlo para vender.

## Pruebas ejecutadas y límites

```powershell
npm run verify
```

- Verificación de sintaxis, imports, configuración demo y dos hashes heredados.
- 63 pruebas Node: 57 unitarias y 6 de HTTP local, todas aprobadas.
- Build estático y empaquetado offline realizados.
- 8 comprobaciones de DOM/visual offline en Chromium, con almacenamiento de prueba
  en memoria: aprobadas. Esto NO es un E2E HTTP ni prueba persistencia de navegador.
- E2E HTTP de navegador: **BLOQUEADO** por `ERR_BLOCKED_BY_ADMINISTRATOR` al navegar
  al servidor local. No se deshabilitaron políticas del navegador para evitarlo.
- Auth, RLS, Supabase, OAuth, webhooks, refunds, GPS y pruebas físicas: NO EJECUTADOS.

Las pruebas de navegador requieren Python, Playwright y un Chromium permitido.
Para ejecutar el E2E en otro entorno, iniciar el servidor y correr:

```powershell
python tests/browser_e2e.py
```

Este script no pasó en el entorno de entrega por el bloqueo de navegación; sus
pasos posteriores necesitan ejecutarse y verificarse, no se asumen aprobados.

El smoke DOM offline usado aquí se puede reproducir con:

```powershell
node scripts/offline-bundle.mjs
python tests/offline_dom.py
```

El script offline usa el Chromium de `/usr/bin/chromium` del entorno de revisión;
para otra máquina se debe configurar la ruta del navegador mediante la variable
`CAUCE_CHROMIUM_PATH` o usar el Chromium instalado por Playwright.

## Archivos relevantes

- `docs/PROVENANCE.md`: reutilización exacta, hashes y commit de origen.
- `docs/AUDIT.md`: inspección inicial y límites de lo efectivamente leído.
- `docs/ARCHITECTURE.md`: decisiones, límites de seguridad y migración pendiente.
- `STATUS.md`: estado técnico de esta entrega.
- `evidence/verification.log`: resultado real de las pruebas Node/build.
- `evidence/offline-dom-results.json`: comprobaciones offline.
- `evidence/browser-results.json`: bloqueo real del E2E HTTP.
- `evidence/*.png`: capturas obtenidas del render sin conexión.

## Git y datos

El repositorio remoto `bitflowapp/cauce` NO se creó. La rama y commits incluidos
son únicamente locales. No hay un remote apuntando al repositorio original.
No se ejecutaron scripts, migraciones o llamadas financieras de La Taba.

El estado local se guarda bajo `cauce:demo:database:v1`. El botón del pie de página
reinicia únicamente los datos de esta demostración, previa confirmación.
El contenido de localStorage permanece en el navegador; no existe sincronización
entre personas o dispositivos, ni backups de servidor.
