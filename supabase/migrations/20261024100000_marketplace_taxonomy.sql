-- CAUCE: marketplace multirrubro · fase 1. Taxonomía de rubros y capacidades
-- por comercio, como declaró docs/CAUCE-MARKETPLACE-MULTIRRUBRO-20261024.md.
--
-- Qué cambia y por qué:
--   ※ La taxonomía deja de ser una lista estática: cada rubro declara las
--     capacidades que puede habilitar un comercio (productos, comida
--     preparada, servicios y turnos) sin duplicar tablas por vertical.
--   ※ El comercio declara su rubro en el alta y qué capacidades ofrece; la
--     base valida que el conjunto sea un subconjunto de lo que su rubro
--     admite. Las reservas de mesa quedan fuera de esta etapa: sin módulo
--     específico no se prometen.
--   ※ Alta atómica de borrador con rubro (nueva sobrecarga de create_business)
--     y una regla anti-spam: hasta 3 comercios por cuenta.
--   ※ Administración gestiona la taxonomía por RPC, sin SQL manual.
-- Migración aditiva: no toca pedidos, pagos, storage ni horarios de los
-- comercios existentes; las columnas nuevas nacen vacías.
-- Dinero y datos existentes no cambian. Ninguna función SECURITY DEFINER en `public`.
begin;

-- ───────────────── vocabulario de capacidades ─────────────────
-- Códigos reservados por la plataforma. Un rubro declara cuáles habilita y el
-- comercio elige un subconjunto. Ampliar el vocabulario es una decisión de
-- producto, no de datos.
create function private.capabilities_valid(claimed text[], allowed text[] default null)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare
  vocab constant text[] := array['products', 'prepared_food', 'services'];
  cap_code text;
  cleaned text[] := '{}';
begin
  claimed := coalesce(claimed, '{}');
  if array_length(claimed, 1) > 8 then
    raise exception 'Se admiten hasta 8 capacidades por comercio' using errcode = '23514';
  end if;
  foreach cap_code in array claimed loop
    cap_code := lower(btrim(cap_code));
    if cap_code is null or cap_code = '' then
      raise exception 'Hay un valor de capacidad vacío' using errcode = '23514';
    end if;
    if not cap_code = any(vocab) then
      raise exception 'Capacidad no admitida: %', left(cap_code, 40) using errcode = '23514';
    end if;
    if not cap_code = any(cleaned) then
      cleaned := cleaned || cap_code;
    end if;
  end loop;
  if allowed is not null and exists (
    select 1 from unnest(cleaned) as candidate(candidate) where candidate not in (select unnest(allowed))) then
    raise exception 'Una capacidad no está disponible para este rubro' using errcode = '23514';
  end if;
  return cleaned;
end;
$$;
revoke all on function private.capabilities_valid(text[], text[]) from public, anon, authenticated;
-- Sin EXECUTE para clientes: sólo la llaman las funciones de esta plataforma y los disparadores.

-- El rubro sólo puede declarar capacidades del vocabulario.
create function private.enforce_category_capabilities() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.capabilities := private.capabilities_valid(new.capabilities);
  return new;
end;
$$;
revoke all on function private.enforce_category_capabilities() from public, anon, authenticated;

create trigger business_categories_capabilities before insert or update on public.business_categories
  for each row execute function private.enforce_category_capabilities();

-- ───────────────── taxonomía multirrubro ─────────────────
alter table public.business_categories
  add column capabilities text[] not null default '{}';
-- Único bloque con la taxonomía de lanzamiento; `tests/rubros.test.mjs` exige
-- la paridad entre este bloque y `js/core/rubros.js`.
insert into public.business_categories (slug, name, position, capabilities) values
  ('gastronomia', 'Gastronomía', 10, array['products', 'prepared_food']),
  ('panaderia', 'Panadería', 20, array['products', 'prepared_food']),
  ('almacen', 'Almacén', 30, array['products']),
  ('kiosco', 'Kiosco', 40, array['products']),
  ('verduleria', 'Verdulería', 50, array['products']),
  ('carniceria', 'Carnicería', 60, array['products']),
  ('farmacia', 'Farmacia', 70, array['products']),
  ('ferreteria', 'Ferretería', 80, array['products', 'services']),
  ('servicios', 'Servicios', 90, array['services']),
  ('otros', 'Otros', 99, array['products', 'services']),
  ('artesania', 'Artesanías', 110, array['products']),
  ('regaleria', 'Regalería', 120, array['products']),
  ('ropa-accesorios', 'Ropa y accesorios', 130, array['products']),
  ('tecnologia', 'Tecnología y reparaciones', 140, array['products', 'services']),
  ('libros-papeleria', 'Libros y papelería', 150, array['products']),
  ('mascotas', 'Mascotas', 160, array['products']),
  ('agro-vivero', 'Agro y vivero', 170, array['products']),
  ('talleres', 'Talleres y oficios', 180, array['services'])
on conflict (slug) do update set
  name = excluded.name, position = excluded.position, capabilities = excluded.capabilities;

-- ───────────────── capacidades por comercio ─────────────────
alter table public.businesses
  add column capabilities text[] not null default '{}';
create index businesses_capabilities on public.businesses using gin (capabilities);

-- El conjunto del comercio se valida contra lo que su rubro habilita. Cuando
-- todavía no eligió rubro, el borrador queda con conjuntos vacíos: sin rubro
-- no se puede solicitar publicación.
create function private.enforce_business_capabilities() returns trigger
language plpgsql security definer set search_path = '' as $$
declare allowed text[];
begin
  if new.category_id is not null then
    select capabilities into allowed from public.business_categories where id = new.category_id;
    if not found then
      raise exception 'Rubro desconocido' using errcode = '23514';
    end if;
  end if;
  new.capabilities := private.capabilities_valid(new.capabilities, allowed);
  return new;
end;
$$;
revoke all on function private.enforce_business_capabilities() from public, anon, authenticated;

create trigger businesses_capabilities before insert or update on public.businesses
  for each row execute function private.enforce_business_capabilities();

-- El titular elige qué ofrece. La política business_edit (dueño y gerencia)
-- sigue siendo la única vía con permisos para escribir esta fila.
grant update (capabilities) on public.businesses to authenticated;

-- ───────────────── alta atómica con rubro y anti-spam ─────────────────
-- Sustituye al alta de dos pasos: un borrador nace con su rubro y las
-- capacidades que ese rubro habilita, y una sola transacción crea el comercio
-- y su primer responsable. El límite por cuenta frena cuentas que cargan
-- comercios sin contenido.
create function private.create_business(business_name text, business_slug text, locality_slug text,
  category_slug text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  locality uuid;
  business uuid;
  category public.business_categories;
  max_businesses constant integer := 3;
begin
  if caller is null or not private.is_permanent_user() then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where user_id = caller) then
    raise exception 'Complete your profile first' using errcode = '23514';
  end if;
  if (select count(*) from public.business_memberships m
      where m.user_id = caller and m.role = 'owner') >= max_businesses then
    raise exception 'Ya administrás la cantidad máxima de comercios con esta cuenta'
      using errcode = '23514';
  end if;
  select id into locality from public.localities where slug = locality_slug and active;
  if locality is null then
    raise exception 'Locality unavailable' using errcode = '23514';
  end if;
  category := null;
  if btrim(coalesce(category_slug, '')) <> '' then
    select * into category from public.business_categories where slug = btrim(category_slug) and active;
    if category is null then
      raise exception 'Rubro no disponible' using errcode = '23514';
    end if;
  end if;
  insert into public.businesses (locality_id, name, slug, category_id, capabilities)
    values (locality, btrim(business_name), business_slug, category.id,
      coalesce(category.capabilities, '{}')) returning id into business;
  insert into public.business_memberships (business_id, user_id, role)
    values (business, caller, 'owner');
  return business;
end;
$$;
revoke all on function private.create_business(text, text, text, text) from public, anon, authenticated;
grant execute on function private.create_business(text, text, text, text) to authenticated;
-- La llamada de tres parámetros sigue firma y reglas: sin rubro, capacidades vacías.
create or replace function private.create_business(business_name text, business_slug text, locality_slug text)
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  return private.create_business(business_name, business_slug, locality_slug, null);
end;
$$;
revoke all on function private.create_business(text, text, text) from public, anon, authenticated;
grant execute on function private.create_business(text, text, text) to authenticated;
create function public.create_business(business_name text, business_slug text, locality_slug text,
  category_slug text)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_business(business_name, business_slug, locality_slug, category_slug); $$;
revoke all on function public.create_business(text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_business(text, text, text, text) to authenticated;

-- ───────────────── taxonomía administrable ─────────────────
-- Alta y ajuste de rubros: sólo administración. El slug ya está restringido por
-- la tabla (patrón y unicidad); el nombre y las capacidades por su CHECK/trigger.
create function private.admin_upsert_business_category(p_slug text, p_name text, p_position smallint,
  p_caps text[], p_active boolean default true)
returns public.business_categories
language plpgsql security definer set search_path = '' as $$
declare row public.business_categories;
begin
  if not private.is_admin() then
    raise exception 'Administration only' using errcode = '42501';
  end if;
  p_caps := private.capabilities_valid(p_caps);
  insert into public.business_categories (slug, name, position, capabilities, active)
    values (lower(btrim(coalesce(p_slug, ''))), btrim(p_name), coalesce(p_position, 999), p_caps, coalesce(p_active, true))
  on conflict (slug) do update set
    name = excluded.name, position = excluded.position,
    capabilities = excluded.capabilities, active = excluded.active
  returning * into row;
  return row;
end;
$$;
revoke all on function private.admin_upsert_business_category(text, text, smallint, text[], boolean)
  from public, anon, authenticated;
grant execute on function private.admin_upsert_business_category(text, text, smallint, text[], boolean)
  to authenticated;
create function public.admin_upsert_business_category(p_slug text, p_name text, p_position smallint default 999,
  p_caps text[] default '{}', p_active boolean default true)
returns public.business_categories
language sql security invoker set search_path = ''
as $$ select private.admin_upsert_business_category(p_slug, p_name, p_position, p_caps, p_active); $$;
revoke all on function public.admin_upsert_business_category(text, text, smallint, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.admin_upsert_business_category(text, text, smallint, text[], boolean)
  to authenticated;

-- Los comercios existentes cambian a capacidades controladas por el rubro que
-- ya declararon; sin rubro siguen con el conjunto vacío. Nada se bloquea:
-- el alta bajo revisión conserva sus datos.
update public.businesses b set capabilities = c.capabilities
  from public.business_categories c where b.category_id = c.id;

-- ───────────────── contrato con el frontend ─────────────────
create or replace function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schema', 20261024100000,
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
