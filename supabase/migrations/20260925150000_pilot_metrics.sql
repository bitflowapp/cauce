-- CAUCE: métricas del piloto para la administración de la plataforma.
--
-- Qué cambia y por qué:
--   · La administración ve el día de la plataforma sin leer pedidos de nadie:
--     comercios activos y abiertos, pedidos de hoy, completados, cancelados,
--     volumen bruto, ticket promedio, retiro y envío, y errores de dispositivos.
--   · "Hoy" es el día local de la localidad del piloto, no el día UTC.
--   · Incidencias básicas: pedidos que esperan respuesta o reparto hace demasiado,
--     con el comercio y el código del pedido (nunca datos del cliente), para que
--     administración llame al comercio.
-- Sólo agrega funciones: no cambia tablas ni datos.
begin;

-- Pedidos que esperan hace demasiado, por estado (minutos sin moverse):
--   submitted 15 · accepted/preparing 60 · ready 45 · en reparto 90.

create function private.admin_pilot_metrics() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  day_start timestamptz;
  result jsonb;
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  select l.timezone into tz from public.localities l where l.active order by l.name limit 1;
  tz := coalesce(tz, 'America/Argentina/Buenos_Aires');
  day_start := date_trunc('day', now() at time zone tz) at time zone tz;

  with today as (
    select o.* from public.orders o where o.created_at >= day_start
  ), closed_today as (
    select distinct on (e.order_id) e.order_id, e.to_status, e.created_at
    from public.order_events e
    where e.created_at >= day_start and e.to_status in ('delivered', 'canceled')
    order by e.order_id, e.created_at desc
  ), sold as (
    select o.business_id, o.total_ars from closed_today c join public.orders o on o.id = c.order_id
    where c.to_status = 'delivered' and o.status = 'delivered'
  ), per_business as (
    select b.id, b.name, b.status, b.open, private.business_open_now(b.id) as open_now,
      (select count(*) from today t where t.business_id = b.id) as orders,
      (select count(*) from sold s where s.business_id = b.id) as delivered,
      (select coalesce(sum(s.total_ars), 0) from sold s where s.business_id = b.id) as gross
    from public.businesses b
    where b.status in ('active', 'paused')
  ), quiet as (
    select o.* from public.orders o
    where (o.status = 'submitted' and o.updated_at < now() - interval '15 minutes')
       or (o.status in ('accepted', 'preparing') and o.updated_at < now() - interval '60 minutes')
       or (o.status = 'ready' and o.updated_at < now() - interval '45 minutes')
       or (o.status in ('assigned', 'picked_up', 'on_the_way', 'arrived') and o.updated_at < now() - interval '90 minutes')
  ), stuck as (
    -- Los 20 que más esperan; el total va aparte.
    select o.id, o.code, o.status, o.fulfillment, b.id as business_id, b.name as business,
      coalesce(nullif(b.public_phone, ''), b.whatsapp) as phone,
      floor(extract(epoch from (now() - o.updated_at)) / 60)::int as minutes
    from quiet o join public.businesses b on b.id = o.business_id
    order by o.updated_at
    limit 20
  )
  select jsonb_build_object(
    'generated_at', now(),
    'day_start', day_start,
    'timezone', tz,
    'businesses', jsonb_build_object(
      'active', (select count(*) from public.businesses where status = 'active'),
      'paused', (select count(*) from public.businesses where status = 'paused'),
      'suspended', (select count(*) from public.businesses where status = 'suspended'),
      'pending_review', (select count(*) from public.businesses where status = 'pending_review'),
      'open_now', (select count(*) from per_business where open_now)),
    'today', jsonb_build_object(
      'orders', (select count(*) from today),
      'pickup', (select count(*) from today where fulfillment = 'pickup'),
      'delivery', (select count(*) from today where fulfillment = 'delivery'),
      'in_progress', (select count(*) from public.orders where status not in ('delivered', 'canceled')),
      'delivered', (select count(*) from sold),
      'canceled', (select count(*) from closed_today where to_status = 'canceled'),
      'gross_ars', (select coalesce(sum(total_ars), 0) from sold),
      'average_ticket_ars', (select coalesce(round(avg(total_ars))::bigint, 0) from sold)),
    'per_business', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status,
        'open_now', open_now, 'orders', orders, 'delivered', delivered, 'gross_ars', gross)
        order by gross desc, orders desc, name) from per_business), '[]'::jsonb),
    'stuck_total', (select count(*) from quiet),
    'stuck', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'status', status,
        'fulfillment', fulfillment, 'business_id', business_id, 'business', business, 'phone', phone,
        'minutes', minutes)
        order by minutes desc) from stuck), '[]'::jsonb),
    'errors_24h', jsonb_build_object(
      'total', (select count(*) from private.client_events where created_at > now() - interval '24 hours'),
      'critical', (select count(*) from private.client_events
        where created_at > now() - interval '24 hours' and kind in ('critical', 'order_failed')))
  ) into result;
  return result;
end;
$$;
revoke all on function private.admin_pilot_metrics() from public, anon, authenticated;
grant execute on function private.admin_pilot_metrics() to authenticated;
create function public.admin_pilot_metrics() returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.admin_pilot_metrics(); $$;
revoke all on function public.admin_pilot_metrics() from public, anon, authenticated;
grant execute on function public.admin_pilot_metrics() to authenticated;

-- ───────────────── contrato con el frontend ─────────────────
create or replace function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schema', 20260925150000,
    'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
    'localities', coalesce((select jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'timezone', timezone)
      order by name) from public.localities where active), '[]'::jsonb),
    'now', now());
$$;

commit;
