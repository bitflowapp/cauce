# Costos operativos estimados

> Las cuotas y precios de Supabase **no se pudieron leer en supabase.com desde
> el entorno de desarrollo** (acceso bloqueado). Las cifras de abajo salen de
> varias fuentes secundarias que coinciden entre sí (octubre de 2026) y deben
> confirmarse en <https://supabase.com/pricing> antes de contratar. No se afirma
> que un plan alcance sin esa verificación.

## Supuestos del piloto

- 10 a 30 tiendas al inicio, hasta 50; hasta 100 productos por tienda (según
  plan) con 1 a 3 fotos de ~100–200 KB (se achican a WebP antes de subir).
- Un número moderado de pedidos por día; pocos organizadores; una administración.
- Sitio estático (HTML/JS/CSS ~500 KB sin comprimir, ~120 KB con brotli).

## Qué consume cada parte

| Recurso | Estimación con 50 tiendas | Referencia de cuota (a verificar) |
| --- | --- | --- |
| Base de datos | Muy chica: < 100 MB incluso con miles de pedidos | Free 500 MB · Pro 8 GB incluidos |
| Storage (fotos) | 50 × 100 × 2 × 150 KB ≈ **1,5 GB** en el máximo | Free ~1 GB · Pro 100 GB |
| Egress (fotos y API) | 2.000 visitas/mes × ~1,5 MB ≈ **3 GB/mes**; crece con el tráfico | Free 5 GB · Pro 250 GB (excedente ≈ USD 0,09/GB) |
| Usuarios activos (MAU) | **Cada compra sin cuenta crea una sesión anónima que cuenta como MAU** | Free 50.000 · Pro 100.000 |
| Realtime | Sólo paneles abiertos de comercios y compradores con sesión | Bajo para el piloto |
| Correo de Auth | Confirmaciones y recuperaciones | El SMTP incluido es para pruebas: usar SMTP propio |

## Recomendación

1. **Mientras no haya comercios reales:** plan gratuito para una demo
   privada. Ojo: los proyectos gratuitos se pausan tras una semana sin uso y
   no tienen las copias diarias del plan pago.
2. **Piloto con comercios reales:** plan **Pro (≈ USD 25/mes por
   organización)**, que incluye un crédito de cómputo de ≈ USD 10 por proyecto
   (instancia micro, suficiente para este volumen), copias diarias, sin pausa y
   cuotas holgadas para fotos y tráfico.
3. **Hosting del sitio:** GitHub Pages o Cloudflare Pages, sin costo, con HTTPS
   y compresión.
4. **Correo transaccional:** un proveedor SMTP con dominio propio (CAUCE ·
   Aluminé usa Resend); los planes gratuitos suelen cubrir algunos miles de
   correos por mes, más que suficiente para confirmaciones y recuperaciones.
5. **Dominio:** costo anual del registrador elegido.

**Total previsto para el piloto:** ≈ USD 25–35 por mes (Supabase Pro +
dominio prorrateado), más el SMTP si se supera su capa gratuita. Con 30
tiendas en el Plan de entrada, la suscripción mensual de las tiendas cubre ese
costo con margen; el precio en pesos conviene revisarlo con el tipo de cambio
del momento.

## Qué vigilar cada mes (Dashboard → Usage)

- **Storage** (fotos) y **egress**: lo primero que crece. Si sube, servir
  imágenes más chicas o con un CDN delante.
- **MAU**: incluye las sesiones anónimas de compra.
- **Tamaño de la base** y **conexiones**: holgado para este volumen.
- **Errores** en Administración → Registro y respuestas 5xx en los logs.
- **Copias**: confirmar que existen las diarias y probar una restauración al
  menos una vez antes de abrir el piloto.

Fuentes consultadas (secundarias): [JetAdmin, guía 2026](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/),
[MakerKit](https://makerkit.dev/blog/saas/supabase-pricing), [Activepieces](https://www.activepieces.com/blog/supabase-pricing-free-tier-limits-pro-costs-egress.md),
[SwyftStack](https://swyftstack.com/blog/supabase-pricing-explained).
