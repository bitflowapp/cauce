# Planes y suscripciones

Los precios son **hipótesis del piloto** (se definen después de hablar con los
feriantes). Están en la tabla `public.plans` y se cambian con un `update`, sin
tocar código.

| Plan | Para | Precio orientativo / mes | Productos | Fotos por producto | Equipo | Retiro en feria | Estadísticas | Extra |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plan de entrada | Tiendas | $ 9.900 | 20 | 3 | — | No (sí puede exponer en ferias) | Básicas | Enlace y QR, retiro acordado y envío propio |
| Plan Feriante | Tiendas | $ 14.900 | 60 | 5 | 1 | Sí | Básicas | |
| Emprendedor Pro | Tiendas | $ 24.900 | 100 | 8 | 3 | Sí | Ampliadas (más vendidos, por feria) | Tienda recomendada en el inicio |
| Plan Organizador | Organizaciones | $ 29.900 | — | — | hasta 5 personas | — | Métricas por feria | Hasta 10 ferias publicadas a la vez |

## Estados (calculados por fecha, sin tareas programadas)

`private.subscription_state` compara la fecha de Neuquén con `period_end`:

| Estado | Cuándo | Efecto |
| --- | --- | --- |
| `none` | Tienda sin suscripción (borrador) | Arma la tienda con los límites del plan de entrada; no vende. |
| `trial` / `active` | Hoy ≤ vencimiento | Todo lo del plan. |
| `grace` | Vencida hace ≤ `grace_days` (10 por defecto) | Sigue vendiendo con su plan; el panel avisa la fecha límite. |
| `expired` / `canceled` | Pasada la gracia o cancelada | La tienda queda como **vitrina**: se ve, pero no recibe pedidos nuevos y vuelve a los límites del plan de entrada para cargar productos. **Los pedidos abiertos se terminan normalmente** (probado). |

Al aprobar un alta, la administración elige plan y días de prueba (1 a 90;
30 por defecto) y se crea la suscripción `trial`.

## Operación manual del piloto

No hay cobros automáticos. Cuando una tienda paga por fuera (transferencia a
LUNA Proyectos), la administración entra a **Administración → Tiendas →
Editar suscripción** y fija plan, estado `active`, vencimiento, gracia y una
nota interna. Cada cambio queda en la auditoría (`subscription.set`).

## Más adelante

- Cobro recurrente: recién con un proveedor integrado y probado (por ejemplo,
  suscripciones de Mercado Pago a nombre de LUNA Proyectos). La tabla
  `subscriptions` ya tiene lo necesario para que un webhook la actualice; el
  período de gracia sigue protegiendo los pedidos.
- Pagos de compradores online: requieren integrar cuentas de cada vendedor
  (OAuth) para no centralizar fondos de terceros. CAUCE · Aluminé tiene un
  adaptador apagado que puede servir de base.
