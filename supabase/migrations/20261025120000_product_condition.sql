-- MiFav: condición del artículo (nuevo / usado).
--
-- Qué cambia y por qué:
--   ※ El marketplace multirrubro necesita distinguir artículos nuevos de usados
--     en la ficha, la vidriera y los filtros. Se agrega una columna acotada,
--     con valor por defecto 'new', para que los catálogos ya cargados sigan
--     funcionando sin reescribir datos.
--   ※ La base es la última autoridad: el check rechaza cualquier otro valor,
--     aunque la interfaz ya lo valide.
-- Migración aditiva: no toca pedidos, pagos, storage, stock ni precios.
-- El contrato del frontend sube a 20261025120000.
begin;

alter table public.products
  add column if not exists condition text not null default 'new';

alter table public.products
  drop constraint if exists products_condition_check;

alter table public.products
  add constraint products_condition_check check (condition in ('new', 'used'));

-- La vidriera filtra por condición junto con el comercio y la disponibilidad.
create index if not exists products_condition_business
  on public.products(condition, business_id, archived);

create or replace function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schema', 20261025120000,
    'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
    'localities', coalesce((select jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'timezone', timezone)
      order by name) from public.localities where active), '[]'::jsonb),
    'now', now());
$$;
revoke all on function private.app_status() from public, anon, authenticated;
grant execute on function private.app_status() to anon, authenticated;
create or replace function public.app_status() returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.app_status(); $$;
revoke all on function public.app_status() from public, anon, authenticated;
grant execute on function public.app_status() to anon, authenticated;

commit;
