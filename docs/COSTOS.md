# Costos operativos

> **Cómo se verificó (11 de octubre de 2026).** Desde el entorno de desarrollo
> no se pueden abrir las páginas oficiales de precios (supabase.com,
> developers.cloudflare.com, docs.github.com no resuelven). Las cifras salen de
> fuentes secundarias de julio a octubre de 2026 que coinciden entre sí; una de
> ellas declara haberlas contrastado con la página de Supabase el 4/8/2026.
> **Antes de contratar, confirmar en las páginas oficiales** (lista al final).
> Ningún plan se da por suficiente sin esa confirmación.

## Lo que cuesta hoy: nada

| Uso | Costo | Por qué |
| --- | --- | --- |
| Demo completa con datos ficticios (`npm run demo`) | $ 0 | Corre en la máquina con Docker |
| Repositorio privado y CI | $ 0 mientras alcancen los minutos gratis | Ver «GitHub Actions» |

## Piloto con 10 a 20 comercios reales

| Servicio | Plan | Costo mensual | Notas |
| --- | --- | --- | --- |
| Supabase | **Pro** | ≈ USD 25 | Incluye ≈ USD 10 de cómputo (una instancia Micro, suficiente para este volumen) |
| Cloudflare Pages | Free | USD 0 | Sitio estático; 500 compilaciones/mes (acá compila GitHub Actions y se sube el resultado) |
| Correo transaccional (ej. Resend) | Free | USD 0 | 3.000 correos/mes, tope de 100 por día |
| Dominio | — | costo anual del registrador | `.com.ar` en NIC Argentina u otro registrador: confirmar precio vigente |
| GitHub | Free | USD 0 | Mientras el CI entre en 2.000 min/mes |
| **Total** | | **≈ USD 25/mes + dominio** | |

### Por qué no el plan gratuito de Supabase para el piloto

- **Se pausa** si no recibe consultas durante 7 días seguidos: con pocos
  comercios al principio, puede pasar.
- **Sin copias diarias** automáticas.
- Para la demo o pruebas internas alcanza: hasta 2 proyectos activos.

### Cuotas de referencia de Supabase

| | Free | Pro (incluido) | Excedente en Pro |
| --- | --- | --- | --- |
| Base de datos | 500 MB | 8 GB | USD 0,125/GB |
| Archivos (fotos) | 1 GB | 100 GB | ≈ USD 0,021/GB |
| Transferencia (egress) | 5 GB | 250 GB sin caché + 250 GB con caché | USD 0,09/GB · USD 0,03/GB |
| Usuarios activos por mes | 50.000 | 100.000 | — |
| Copias | — | Diarias, 7 días | PITR es un adicional pago |
| Pausa por inactividad | Sí (7 días) | No | — |

Las fuentes no coinciden en si el precio de Pro es por organización o por
proyecto: tener **un solo proyecto** de Ferias en la organización evita la duda.

### Consumo esperado del piloto (20 tiendas)

| Recurso | Estimación | Margen frente a Pro |
| --- | --- | --- |
| Base | < 100 MB aun con miles de pedidos | Muy holgado |
| Fotos | 20 tiendas × 60 productos × 3 fotos × 150 KB ≈ 0,5 GB | Muy holgado (cabe incluso en Free) |
| Egress | 2.000 visitas/mes × 1,5 MB ≈ 3 GB | Muy holgado |
| Usuarios activos | Cada compra sin cuenta crea una sesión anónima que **cuenta como usuario activo** | Holgado para el piloto |

### GitHub Actions (repositorio privado)

- Plan Free: **2.000 minutos/mes**; después, USD 0,006/min en Linux.
- Una corrida completa del CI de Ferias usa ≈ 15 minutos (verificación +
  stack Supabase + Chromium y WebKit + auditoría visual en 7 anchos): entran
  ≈ 130 corridas por mes. Si se queda corto, la auditoría visual puede pasar a
  correr sólo en `main` o a mano.

### Hosting: por qué Cloudflare Pages y no GitHub Pages

GitHub Pages **no publica desde repositorios privados en el plan gratuito**
(hace falta GitHub Pro, Team o Enterprise). Cloudflare Pages con subida directa
desde Actions es gratis con el repositorio privado. Netlify es una opción
equivalente.

## Ingresos frente a costos (hipótesis del piloto)

Con 10 tiendas en el Plan de entrada ($ 9.900/mes) la facturación supera el
costo de infraestructura. Los precios en pesos y el tipo de cambio hay que
revisarlos al lanzar. La Comunidad Fundadora promete «sin costo inicial durante
la etapa fundadora»: definir cuánto dura es una decisión comercial pendiente.

## Qué vigilar cada mes

- Supabase → Usage: **Storage**, **egress** y **MAU** (incluye sesiones
  anónimas de compra).
- GitHub → Settings → Billing: minutos de Actions consumidos.
- Proveedor de correo: envíos por día (el tope gratuito es 100).
- Administración → Registro: errores de la interfaz.

## Páginas oficiales para confirmar antes de contratar

- <https://supabase.com/pricing>
- <https://developers.cloudflare.com/pages/platform/limits/>
- <https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions>
- <https://resend.com/pricing>
- <https://nic.ar> (dominios `.ar`)

Fuentes secundarias consultadas:
[JetAdmin](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/),
[MakerKit](https://makerkit.dev/blog/saas/supabase-pricing),
[BricksTech](https://www.brickstech.io/post/supabase-pro-pricing-quotas-features-guide),
[Omid Saffari](https://omidsaffari.com/blog/supabase-pricing),
[Automation Atlas · Supabase Free](https://automationatlas.io/answers/supabase-free-tier-limits-2026/),
[CostBench](https://costbench.com/software/database-as-service/supabase/free-plan/),
[Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits),
[GitHub Community · Pages privado](https://github.com/orgs/community/discussions/22817),
[SSW · planes de GitHub](https://www.ssw.com.au/rules/which-github-plan),
[ThePricer · Actions](https://www.thepricer.org/how-much-does-github-actions-cost/),
[Heise · Actions](https://heise.de/-11118027),
[Automation Atlas · Resend](https://automationatlas.io/answers/resend-free-tier-explained-2026/),
[UseCarly · Resend](https://www.usecarly.com/blog/resend-pricing/).

> Aviso de Supabase (fuente secundaria): desde el 30/10/2026 los proyectos
> requieren permisos explícitos de Postgres para exponer tablas por la Data
> API. Las migraciones de Ferias ya otorgan todo explícitamente (y revocan lo
> que no corresponde), así que no deberían verse afectadas; confirmarlo con
> `estado` al crear el proyecto.
