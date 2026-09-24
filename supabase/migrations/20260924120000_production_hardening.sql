-- CAUCE: hardening para operar con comercios y pedidos reales.
--
-- Qué cambia y por qué (ver docs/AUDITORIA-PRODUCCION.md):
--   · Compra sin cuenta con sesión anónima de Supabase: la persona obtiene un
--     JWT real y la base sigue decidiendo con auth.uid() y RLS. Todo lo que no
--     sea pedir y seguir sus propios pedidos exige una cuenta permanente.
--   · Verticales con interruptor en la base (taxi apagado en esta etapa).
--   · Estado de la aplicación y versión de esquema consultables sin sesión, para
--     que un frontend nuevo nunca opere contra un esquema viejo.
--   · Horarios estructurados, contacto público, tiempos estimados, suspensión.
--   · Stock opcional por producto, total confirmado en el checkout, límites
--     contra abuso, historial de estados completo, cancelaciones con motivo.
--   · Gestión de equipo del comercio sin SQL manual.
--   · Seguimiento de pedido por enlace y registro mínimo de errores del cliente.
-- Dinero en ARS enteros. Ninguna función SECURITY DEFINER en `public`.
begin;

-- Nada nuevo en `private` o `public` queda ejecutable por PUBLIC por omisión:
-- cada función concede EXECUTE explícitamente.
-- Denegar por omisión: una tabla o función nueva no queda expuesta por olvidar
-- un `revoke`. Cada objeto concede lo mínimo de forma explícita.
alter default privileges in schema private revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- Las funciones que una visita sin sesión puede invocar (estado de la app,
-- seguimiento por enlace, reporte de errores) viven en `private`. `anon` recibe
-- USAGE sobre el esquema y EXECUTE sólo sobre esas funciones.
grant usage on schema private to anon;

-- ───────────────── identidad ─────────────────
-- Cuenta permanente: sesión con correo, no la sesión anónima de compra.
create function private.is_permanent_user() returns boolean
language sql stable security invoker set search_path = '' as $$
  select auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;
revoke all on function private.is_permanent_user() from public, anon, authenticated;
grant execute on function private.is_permanent_user() to authenticated;

-- Una sesión anónima no crea perfil: el perfil es de las cuentas.
drop policy profile_insert_self on public.profiles;
drop policy profile_update_self on public.profiles;
create policy profile_insert_self on public.profiles for insert to authenticated
with check (user_id = (select auth.uid()) and (select private.is_permanent_user()));
create policy profile_update_self on public.profiles for update to authenticated
using (user_id = (select auth.uid()) and (select private.is_permanent_user()))
with check (user_id = (select auth.uid()) and (select private.is_permanent_user()));

-- ───────────────── localidad: zona horaria propia ─────────────────
-- Los horarios se interpretan en la hora local de cada CAUCE · [localidad].
alter table public.localities
  add column timezone text not null default 'America/Argentina/Buenos_Aires'
    check (length(timezone) between 3 and 64);

-- ───────────────── verticales y estado de la aplicación ─────────────────
create table private.platform_features (
  key text primary key check (key ~ '^[a-z_]+$'),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table private.platform_features enable row level security;
revoke all on private.platform_features from public, anon, authenticated;
create policy platform_features_no_client_access on private.platform_features
for all to anon, authenticated using (false) with check (false);
-- La primera etapa es comercio local. Taxi queda construido y apagado.
insert into private.platform_features (key, enabled) values
  ('guest_checkout', true),
  ('taxi', false);

create function private.feature_enabled(feature text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from private.platform_features where key = feature), false);
$$;
revoke all on function private.feature_enabled(text) from public, anon, authenticated;
grant execute on function private.feature_enabled(text) to authenticated;

-- Contrato con el frontend. `schema` cambia cuando cambia el contrato: un
-- frontend que exige un esquema más nuevo se detiene y lo dice.
create function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schema', 20260924120000,
    'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
    'localities', coalesce((select jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'timezone', timezone)
      order by name) from public.localities where active), '[]'::jsonb),
    'now', now());
$$;

revoke all on function private.app_status() from public, anon, authenticated;
grant execute on function private.app_status() to anon, authenticated;
create function public.app_status() returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.app_status(); $$;
revoke all on function public.app_status() from public, anon, authenticated;
grant execute on function public.app_status() to anon, authenticated;

-- ───────────────── comercio: datos operativos ─────────────────
alter table public.businesses drop constraint businesses_status_check;
alter table public.businesses add constraint businesses_status_check
  check (status in ('draft', 'pending_review', 'returned', 'active', 'paused', 'suspended'));
alter table public.businesses
  add column public_phone text not null default '' check (length(public_phone) <= 24),
  add column whatsapp text not null default '' check (length(whatsapp) <= 24),
  add column prep_minutes smallint check (prep_minutes is null or prep_minutes between 5 and 240),
  add column delivery_minutes smallint check (delivery_minutes is null or delivery_minutes between 5 and 240);
grant update (public_phone, whatsapp, prep_minutes, delivery_minutes) on public.businesses to authenticated;

-- Horarios por día. Un rango que cierra antes de abrir cruza la medianoche
-- (por ejemplo 20:00 a 01:00). Hasta tres rangos por día.
create table public.business_hours (
  business_id uuid not null references public.businesses(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens time not null,
  closes time not null,
  primary key (business_id, weekday, opens),
  check (opens <> closes)
);
create function private.enforce_hours_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.business_hours
      where business_id = new.business_id and weekday = new.weekday) > 3 then
    raise exception 'Se admiten hasta 3 horarios por día' using errcode = '23514';
  end if;
  return null;
end;
$$;
revoke all on function private.enforce_hours_limit() from public, anon, authenticated;
create constraint trigger business_hours_limit after insert on public.business_hours
  deferrable initially immediate for each row execute function private.enforce_hours_limit();

alter table public.business_hours enable row level security;
revoke all on public.business_hours from public, anon, authenticated;
grant select on public.business_hours to anon, authenticated;
grant insert (business_id, weekday, opens, closes), update (opens, closes), delete
  on public.business_hours to authenticated;
create policy business_hours_read_anon on public.business_hours for select to anon
using (exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'));
create policy business_hours_read_auth on public.business_hours for select to authenticated
using (
  exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active')
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin())
);
create policy business_hours_insert on public.business_hours for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy business_hours_update on public.business_hours for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy business_hours_delete on public.business_hours for delete to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

-- Reemplazo atómico de la semana completa: o quedan los horarios nuevos o
-- quedan los anteriores, nunca una semana a medias.
create function private.set_business_hours(business uuid, hours jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare item jsonb; total integer := 0;
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  if hours is null or jsonb_typeof(hours) <> 'array' or jsonb_array_length(hours) > 21 then
    raise exception 'Invalid hours' using errcode = '23514';
  end if;
  delete from public.business_hours where business_id = business;
  for item in select * from jsonb_array_elements(hours) loop
    if jsonb_typeof(item) <> 'object'
       or coalesce(item ->> 'weekday', '') !~ '^[0-6]$'
       or coalesce(item ->> 'opens', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$'
       or coalesce(item ->> 'closes', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' then
      raise exception 'Invalid hours' using errcode = '23514';
    end if;
    insert into public.business_hours (business_id, weekday, opens, closes)
      values (business, (item ->> 'weekday')::smallint, (item ->> 'opens')::time, (item ->> 'closes')::time);
    total := total + 1;
  end loop;
  return total;
end;
$$;
revoke all on function private.set_business_hours(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.set_business_hours(uuid, jsonb) to authenticated;
create function public.set_business_hours(business uuid, hours jsonb) returns integer
language sql security invoker set search_path = ''
as $$ select private.set_business_hours(business, hours); $$;
revoke all on function public.set_business_hours(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_business_hours(uuid, jsonb) to authenticated;

-- ¿Está dentro de su horario en este momento? Sin horarios cargados, sí: manda
-- sólo el interruptor manual.
create function private.within_business_hours(business uuid, at_time timestamptz default now())
returns boolean language sql stable security definer set search_path = '' as $$
  with local_now as (
    select (at_time at time zone l.timezone) as ts
    from public.businesses b join public.localities l on l.id = b.locality_id
    where b.id = business
  ), parts as (
    select extract(dow from ts)::int as dow, ts::time as t from local_now
  )
  select case
    when not exists (select 1 from public.business_hours h where h.business_id = business) then true
    else exists (
      select 1 from public.business_hours h, parts p
      where h.business_id = business and (
        (h.closes > h.opens and h.weekday = p.dow and p.t >= h.opens and p.t < h.closes)
        or (h.closes < h.opens and h.weekday = p.dow and p.t >= h.opens)
        or (h.closes < h.opens and h.weekday = (p.dow + 6) % 7 and p.t < h.closes)
      ))
  end;
$$;
-- Sólo la usan funciones con privilegio: ningún rol cliente la invoca.
revoke all on function private.within_business_hours(uuid, timestamptz) from public, anon, authenticated;

-- Recibe pedidos ahora: publicado, abierto por el comercio y dentro de horario.
create function private.business_open_now(business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select b.status = 'active' and b.open from public.businesses b where b.id = business), false)
    and private.within_business_hours(business);
$$;
revoke all on function private.business_open_now(uuid) from public, anon, authenticated;
grant execute on function private.business_open_now(uuid) to anon, authenticated;

-- Columna calculada para PostgREST: `select=*,open_now`.
create function public.open_now(public.businesses) returns boolean
language sql stable security invoker set search_path = ''
as $$ select private.business_open_now($1.id); $$;
revoke all on function public.open_now(public.businesses) from public, anon, authenticated;
grant execute on function public.open_now(public.businesses) to anon, authenticated;

-- Requisitos de publicación: horarios (texto o estructurados) y un canal de
-- contacto para clientes.
create or replace function private.business_missing_requirements(business uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_remove(array[
    case when b.category_id is null then 'Rubro' end,
    case when length(btrim(b.address)) = 0 then 'Dirección' end,
    case when length(btrim(b.hours_label)) = 0
      and not exists (select 1 from public.business_hours h where h.business_id = b.id)
      then 'Horarios de atención' end,
    case when length(btrim(coalesce(c.owner_name, ''))) = 0 then 'Responsable' end,
    case when length(btrim(coalesce(c.phone, ''))) = 0 then 'Teléfono de contacto' end,
    case when length(btrim(b.public_phone)) = 0 and length(btrim(b.whatsapp)) = 0
      then 'Teléfono o WhatsApp para clientes' end,
    case when not b.pickup_enabled and not b.delivery_enabled then 'Al menos una modalidad de entrega' end,
    case when b.delivery_enabled and length(btrim(b.delivery_zone)) = 0 then 'Zona de envío' end,
    case when not exists (select 1 from public.products p where p.business_id = b.id and not p.archived)
      then 'Al menos un producto cargado' end
  ], null), array[]::text[])
  from public.businesses b left join public.business_contacts c on c.business_id = b.id
  where b.id = business;
$$;

-- Administración suspende un comercio publicado y lo levanta. El comercio no
-- puede salir de una suspensión por su cuenta (sólo alterna activo/pausado).
create function private.admin_set_business_status(business uuid, next_status text, note text)
returns text language plpgsql security definer set search_path = '' as $$
declare current text;
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  select status into current from public.businesses where id = business for update;
  if current is null then raise exception 'Business not found' using errcode = 'P0002'; end if;
  if not ((current in ('active', 'paused') and next_status = 'suspended')
       or (current = 'suspended' and next_status = 'active')) then
    raise exception 'Transition not allowed' using errcode = '23514';
  end if;
  if next_status = 'suspended' and length(btrim(coalesce(note, ''))) < 3 then
    raise exception 'Reason required' using errcode = '23514';
  end if;
  update public.businesses set status = next_status,
    open = case when next_status = 'suspended' then false else open end where id = business;
  insert into public.business_review_events (business_id, from_status, to_status, actor_id, actor_role, note)
    values (business, current, next_status, (select auth.uid()), 'admin', left(coalesce(note, ''), 400));
  return next_status;
end;
$$;
revoke all on function private.admin_set_business_status(uuid, text, text) from public, anon, authenticated;
grant execute on function private.admin_set_business_status(uuid, text, text) to authenticated;
create function public.admin_set_business_status(business uuid, next_status text, note text default '')
returns text language sql security invoker set search_path = ''
as $$ select private.admin_set_business_status(business, next_status, note); $$;
revoke all on function public.admin_set_business_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_business_status(uuid, text, text) to authenticated;

-- El alta de un comercio es de una cuenta permanente, nunca de una sesión de compra.
create or replace function private.create_business(business_name text, business_slug text, locality_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  locality uuid;
  business uuid;
begin
  if caller is null or not private.is_permanent_user() then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where user_id = caller) then
    raise exception 'Complete your profile first' using errcode = '23514';
  end if;
  select id into locality from public.localities where slug = locality_slug and active;
  if locality is null then
    raise exception 'Locality unavailable' using errcode = '23514';
  end if;
  insert into public.businesses (locality_id, name, slug)
    values (locality, btrim(business_name), business_slug) returning id into business;
  insert into public.business_memberships (business_id, user_id, role)
    values (business, caller, 'owner');
  return business;
end;
$$;

-- ───────────────── equipo del comercio ─────────────────
-- Owner suma, cambia o quita manager/staff. Manager ve el equipo. La persona
-- ya tiene que tener cuenta: CAUCE no crea cuentas en nombre de nadie.
create type public.team_member as (
  user_id uuid, display_name text, email text, role text, created_at timestamptz, is_self boolean
);

create function private.business_team(business uuid) returns setof public.team_member
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  return query
    select m.user_id, coalesce(p.display_name, ''), coalesce(u.email, '')::text, m.role, m.created_at,
      m.user_id = (select auth.uid())
    from public.business_memberships m
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.user_id = m.user_id
    where m.business_id = business
    order by case m.role when 'owner' then 0 when 'manager' then 1 else 2 end, m.created_at;
end;
$$;
revoke all on function private.business_team(uuid) from public, anon, authenticated;
grant execute on function private.business_team(uuid) to authenticated;
create function public.business_team(business uuid) returns setof public.team_member
language sql stable security invoker set search_path = ''
as $$ select * from private.business_team(business); $$;
revoke all on function public.business_team(uuid) from public, anon, authenticated;
grant execute on function public.business_team(uuid) to authenticated;

create function private.add_business_member(business uuid, member_email text, member_role text)
returns text language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if not private.is_permanent_user() or not private.is_business_member(business, array['owner']) then
    raise exception 'Only the owner manages the team' using errcode = '42501';
  end if;
  if member_role not in ('manager', 'staff') then
    raise exception 'Invalid role' using errcode = '23514';
  end if;
  select u.id into target from auth.users u
    where lower(u.email) = lower(btrim(coalesce(member_email, '')))
      and coalesce(u.is_anonymous, false) = false
      and u.deleted_at is null;
  if target is null then
    raise exception 'No account with that email' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.business_memberships where business_id = business and user_id = target) then
    raise exception 'Already a member' using errcode = '23505';
  end if;
  insert into public.business_memberships (business_id, user_id, role) values (business, target, member_role);
  return member_role;
end;
$$;
revoke all on function private.add_business_member(uuid, text, text) from public, anon, authenticated;
grant execute on function private.add_business_member(uuid, text, text) to authenticated;
create function public.add_business_member(business uuid, member_email text, member_role text default 'staff')
returns text language sql security invoker set search_path = ''
as $$ select private.add_business_member(business, member_email, member_role); $$;
revoke all on function public.add_business_member(uuid, text, text) from public, anon, authenticated;
grant execute on function public.add_business_member(uuid, text, text) to authenticated;

create function private.set_business_member_role(business uuid, member uuid, member_role text)
returns text language plpgsql security definer set search_path = '' as $$
declare current text;
begin
  if not private.is_permanent_user() or not private.is_business_member(business, array['owner']) then
    raise exception 'Only the owner manages the team' using errcode = '42501';
  end if;
  if member_role not in ('manager', 'staff') then
    raise exception 'Invalid role' using errcode = '23514';
  end if;
  select role into current from public.business_memberships
    where business_id = business and user_id = member for update;
  if current is null then raise exception 'Member not found' using errcode = 'P0002'; end if;
  if current = 'owner' then
    raise exception 'Ownership changes are administrative' using errcode = '42501';
  end if;
  update public.business_memberships set role = member_role where business_id = business and user_id = member;
  return member_role;
end;
$$;
revoke all on function private.set_business_member_role(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.set_business_member_role(uuid, uuid, text) to authenticated;
create function public.set_business_member_role(business uuid, member uuid, member_role text)
returns text language sql security invoker set search_path = ''
as $$ select private.set_business_member_role(business, member, member_role); $$;
revoke all on function public.set_business_member_role(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_business_member_role(uuid, uuid, text) to authenticated;

create function private.remove_business_member(business uuid, member uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current text; caller uuid := (select auth.uid());
begin
  if caller is null or not private.is_permanent_user() then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select role into current from public.business_memberships
    where business_id = business and user_id = member for update;
  if current is null then raise exception 'Member not found' using errcode = 'P0002'; end if;
  -- El owner quita a cualquiera menos a otro owner; cada persona puede irse sola.
  if member <> caller and not private.is_business_member(business, array['owner']) then
    raise exception 'Only the owner manages the team' using errcode = '42501';
  end if;
  if current = 'owner' then
    raise exception 'Ownership changes are administrative' using errcode = '42501';
  end if;
  delete from public.business_memberships where business_id = business and user_id = member;
  return true;
end;
$$;
revoke all on function private.remove_business_member(uuid, uuid) from public, anon, authenticated;
grant execute on function private.remove_business_member(uuid, uuid) to authenticated;
create function public.remove_business_member(business uuid, member uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select private.remove_business_member(business, member); $$;
revoke all on function public.remove_business_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_business_member(uuid, uuid) to authenticated;

-- ───────────────── catálogo: control de stock opcional ─────────────────
-- Gastronomía trabaja con "agotado"; un almacén puede llevar existencias. El
-- stock sólo se exige y se descuenta en los productos que lo controlan. Las
-- filas existentes conservan el comportamiento que tenían.
alter table public.products add column track_stock boolean not null default false;
update public.products set track_stock = true;
grant insert (track_stock), update (track_stock) on public.products to authenticated;

-- ───────────────── pedidos ─────────────────
create unique index orders_tracking_token on public.orders(tracking_token);
create index orders_business_active on public.orders(business_id, created_at desc)
  where status not in ('delivered', 'canceled');

-- Los códigos crecían con lpad(n, 4): desde el pedido 10.000 se truncaban y
-- chocaban con códigos existentes. Ahora el número nunca se corta.
create function private.next_code(prefix text, seq regclass) returns text
language sql volatile security definer set search_path = '' as $$
  select prefix || '-' || case when n < 10000 then lpad(n::text, 4, '0') else n::text end
  from (select nextval(seq) as n) s;
$$;
revoke all on function private.next_code(text, regclass) from public, anon, authenticated;

-- La máquina de estados permite cerrar un envío que no se pudo entregar.
insert into private.order_transitions (from_status, to_status, actor_role, fulfillment) values
  ('picked_up', 'canceled', 'merchant', 'delivery'),
  ('on_the_way', 'canceled', 'merchant', 'delivery'),
  ('arrived', 'canceled', 'merchant', 'delivery');

-- Historial: cada evento registra desde qué estado se salió.
update public.order_events e set from_status = prev.from_status
from (select id, lag(to_status) over (partition by order_id order by created_at, id) as from_status
      from public.order_events) prev
where prev.id = e.id and e.from_status is null and prev.from_status is not null;

drop function public.create_order(uuid, uuid, text, text, jsonb, jsonb);
drop function private.create_order(uuid, uuid, text, text, jsonb, jsonb);

-- `expected_total` es el total que la persona vio al confirmar. Si el catálogo
-- cambió en el medio, el pedido NO se crea y la persona ve el importe nuevo.
create function private.create_order(business uuid, idem uuid, fulfillment text,
  payment_method text, contact jsonb, items jsonb, expected_total bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  anonymous boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  fingerprint text;
  existing public.orders;
  shop public.businesses;
  item jsonb;
  product public.products;
  variant public.product_variants;
  unit bigint;
  line_total bigint;
  subtotal bigint := 0;
  fee bigint := 0;
  new_order uuid;
  contact_name text;
  contact_phone text;
  address text;
  notes text;
  quantity integer;
  position smallint := 0;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if anonymous and not private.feature_enabled('guest_checkout') then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if fulfillment not in ('pickup', 'delivery') then
    raise exception 'Invalid fulfillment' using errcode = '23514';
  end if;
  if payment_method is distinct from (case fulfillment when 'delivery' then 'cash_on_delivery' else 'cash_on_pickup' end) then
    raise exception 'Payment method not available' using errcode = '23514';
  end if;
  if contact is null or jsonb_typeof(contact) <> 'object' then
    raise exception 'Invalid contact name' using errcode = '23514';
  end if;
  contact_name := btrim(coalesce(contact ->> 'name', ''));
  contact_phone := btrim(coalesce(contact ->> 'phone', ''));
  address := btrim(coalesce(contact ->> 'address', ''));
  notes := left(btrim(coalesce(contact ->> 'notes', '')), 280);
  if fulfillment = 'pickup' then address := ''; end if;
  if length(contact_name) not between 2 and 80 then
    raise exception 'Invalid contact name' using errcode = '23514';
  end if;
  if length(contact_phone) not between 6 and 24 or contact_phone !~ '^[0-9 +()-]+$' then
    raise exception 'Invalid contact phone' using errcode = '23514';
  end if;
  if fulfillment = 'delivery' and length(address) not between 5 and 200 then
    raise exception 'Address required' using errcode = '23514';
  end if;

  -- El intento se resuelve antes de tocar el catálogo: repetirlo devuelve el
  -- mismo pedido en lugar de crear otro.
  fingerprint := md5(jsonb_build_object('fulfillment', fulfillment, 'payment_method', payment_method,
    'name', contact_name, 'phone', contact_phone, 'address', address, 'notes', notes,
    'items', items)::text);
  select * into existing from public.orders
    where customer_id = caller and business_id = business and idempotency_key = idem;
  if existing.id is not null then
    if existing.request_fingerprint <> fingerprint then
      raise exception 'Repeated attempt with different data' using errcode = 'U0002';
    end if;
    return existing.id;
  end if;

  -- Límites contra abuso: pocos pedidos sin atender y un ritmo humano.
  if (select count(*) from public.orders o where o.customer_id = caller and o.status = 'submitted') >= 3
     or (select count(*) from public.orders o where o.customer_id = caller
         and o.created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Too many pending orders' using errcode = 'U0006';
  end if;

  select * into shop from public.businesses where id = business;
  if shop.id is null or shop.status <> 'active' then
    raise exception 'Business not available' using errcode = '23514';
  end if;
  if not private.business_open_now(business) then
    raise exception 'Business closed' using errcode = '23514';
  end if;
  if fulfillment = 'pickup' and not shop.pickup_enabled then
    raise exception 'Pickup not available' using errcode = '23514';
  end if;
  if fulfillment = 'delivery' and not shop.delivery_enabled then
    raise exception 'Delivery not available' using errcode = '23514';
  end if;
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 100 then
    raise exception 'Empty cart' using errcode = '23514';
  end if;

  new_order := gen_random_uuid();
  insert into public.orders (id, code, business_id, locality_id, customer_id, idempotency_key,
    request_fingerprint, fulfillment, payment_method, contact_name, contact_phone, address, notes,
    subtotal_ars, delivery_fee_ars, total_ars, delivery_code)
  values (new_order, private.next_code('CA', 'private.order_code_seq'), business,
    shop.locality_id, caller, idem, fingerprint, fulfillment, payment_method, contact_name,
    contact_phone, address, notes, 1, 0, 1,
    case when fulfillment = 'delivery' then lpad((floor(random() * 10000))::int::text, 4, '0') end);

  for item in select * from jsonb_array_elements(items) loop
    if jsonb_typeof(item) <> 'object'
       or coalesce(item ->> 'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(item ->> 'quantity', '') !~ '^[0-9]{1,3}$'
       or (coalesce(item ->> 'variant_id', '') <> ''
           and (item ->> 'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'Invalid quantity' using errcode = '23514';
    end if;
    quantity := (item ->> 'quantity')::int;
    if quantity < 1 or quantity > 99 then
      raise exception 'Invalid quantity' using errcode = '23514';
    end if;
    -- El bloqueo de fila hace que dos pedidos simultáneos no vendan el mismo stock.
    select * into product from public.products
      where id = (item ->> 'product_id')::uuid and business_id = business for update;
    if product.id is null or product.archived or not product.available then
      raise exception 'Product not available' using errcode = '23514';
    end if;
    variant := null;
    if coalesce(item ->> 'variant_id', '') <> '' then
      select * into variant from public.product_variants
        where id = (item ->> 'variant_id')::uuid and product_id = product.id and active;
      if variant.id is null then raise exception 'Variant not available' using errcode = '23514'; end if;
    elsif exists (select 1 from public.product_variants where product_id = product.id and active) then
      raise exception 'Variant required' using errcode = '23514';
    end if;
    -- La fila se releyó bloqueada: su stock ya descuenta las líneas anteriores.
    if product.track_stock and product.stock < quantity then
      raise exception 'Not enough stock' using errcode = 'U0003';
    end if;
    unit := product.price_ars + coalesce(variant.price_delta_ars, 0);
    if unit <= 0 then raise exception 'Invalid price' using errcode = '23514'; end if;
    line_total := unit * quantity;
    subtotal := subtotal + line_total;
    position := position + 1;
    insert into public.order_items (order_id, business_id, customer_id, product_id, variant_id,
      product_name, variant_name, image_path, dish_type, unit_price_ars, quantity, total_ars, position)
    values (new_order, business, caller, product.id, variant.id, product.name,
      coalesce(variant.name, ''), product.image_path, product.dish_type, unit, quantity, line_total, position);
    if product.track_stock then
      update public.products set stock = stock - quantity where id = product.id;
    end if;
  end loop;

  if fulfillment = 'delivery' then
    fee := shop.delivery_fee_ars;
    if subtotal < shop.minimum_order_ars then
      raise exception 'Minimum order not reached' using errcode = '23514';
    end if;
  end if;
  if expected_total is not null and expected_total <> subtotal + fee then
    raise exception 'Prices changed' using errcode = 'U0005', detail = (subtotal + fee)::text;
  end if;
  update public.orders set subtotal_ars = subtotal, delivery_fee_ars = fee,
    total_ars = subtotal + fee where id = new_order;
  insert into public.order_events (order_id, business_id, customer_id, to_status, actor_id, actor_role)
    values (new_order, business, caller, 'submitted', caller, 'customer');
  return new_order;
exception when unique_violation then
  -- Carrera con un envío simultáneo del mismo intento: gana la primera fila.
  select * into existing from public.orders
    where customer_id = caller and business_id = business and idempotency_key = idem;
  if existing.id is null then raise; end if;
  if existing.request_fingerprint <> fingerprint then
    raise exception 'Repeated attempt with different data' using errcode = 'U0002';
  end if;
  return existing.id;
end;
$$;
revoke all on function private.create_order(uuid, uuid, text, text, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function private.create_order(uuid, uuid, text, text, jsonb, jsonb, bigint) to authenticated;
create function public.create_order(business uuid, idem uuid, fulfillment text,
  payment_method text, contact jsonb, items jsonb, expected_total bigint default null)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_order(business, idem, fulfillment, payment_method, contact, items, expected_total); $$;
revoke all on function public.create_order(uuid, uuid, text, text, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, text, text, jsonb, jsonb, bigint) to authenticated;

create or replace function private.transition_order(order_id uuid, expected_version integer,
  next_status text, rider uuid, reason text)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  row public.orders;
  previous text;
  role text;
  note text := left(btrim(coalesce(reason, '')), 200);
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into row from public.orders where id = order_id for update;
  if row.id is null then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if private.is_business_member(row.business_id, array['owner', 'manager', 'staff']) then
    role := 'merchant';
  elsif row.customer_id = caller then
    role := 'customer';
  else
    raise exception 'This order belongs to another account' using errcode = '42501';
  end if;
  if expected_version is not null and row.version <> expected_version then
    raise exception 'The order changed while you were looking at it' using errcode = 'U0001';
  end if;
  if not exists (select 1 from private.order_transitions t
    where t.from_status = row.status and t.to_status = next_status and t.actor_role = role
      and (t.fulfillment is null or t.fulfillment = row.fulfillment)) then
    raise exception 'Transition not allowed' using errcode = '42501';
  end if;
  -- Rechazar o cancelar un pedido ajeno a la persona se explica siempre.
  if next_status = 'canceled' and role = 'merchant' and length(note) < 3 then
    raise exception 'Reason required' using errcode = '23514';
  end if;
  if next_status = 'assigned' then
    if rider is null then raise exception 'Choose who delivers' using errcode = '23514'; end if;
    if not exists (select 1 from public.business_riders r
      where r.id = rider and r.business_id = row.business_id and r.active) then
      raise exception 'Rider not available' using errcode = '23514';
    end if;
  end if;
  if next_status = 'canceled' then
    -- Devolver el stock reservado sólo donde se controla stock.
    update public.products p set stock = least(p.stock + devuelto.total, 10000)
      from (select i.product_id, sum(i.quantity)::int as total from public.order_items i
        where i.order_id = row.id and i.product_id is not null group by i.product_id) devuelto
      where devuelto.product_id = p.id and p.track_stock;
  end if;
  previous := row.status;
  update public.orders set status = next_status, version = version + 1, updated_at = now(),
    rider_id = case when next_status = 'assigned' then rider else rider_id end,
    cancel_reason = case when next_status = 'canceled' then note else cancel_reason end,
    payment_status = case when next_status = 'delivered' then 'settled' else payment_status end
    where id = row.id returning * into row;
  insert into public.order_events (order_id, business_id, customer_id, from_status, to_status,
    actor_id, actor_role, note)
    values (row.id, row.business_id, row.customer_id, previous, next_status, caller, role, note);
  return row;
end;
$$;

-- Seguimiento por enlace: quien tiene el token del pedido (la persona que lo
-- hizo) ve su estado desde cualquier dispositivo. Sin teléfono ni nombre.
create function private.track_order(token uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; b public.businesses;
begin
  if token is null then return null; end if;
  select * into o from public.orders where tracking_token = token;
  if o.id is null then return null; end if;
  select * into b from public.businesses where id = o.business_id;
  return jsonb_build_object(
    'id', o.id, 'code', o.code, 'status', o.status, 'fulfillment', o.fulfillment,
    'payment_method', o.payment_method, 'address', o.address, 'delivery_code', o.delivery_code,
    'subtotal_ars', o.subtotal_ars, 'delivery_fee_ars', o.delivery_fee_ars, 'total_ars', o.total_ars,
    'cancel_reason', o.cancel_reason, 'created_at', o.created_at, 'updated_at', o.updated_at,
    'business', jsonb_build_object('id', b.id, 'name', b.name, 'address', b.address,
      'public_phone', b.public_phone, 'whatsapp', b.whatsapp,
      'prep_minutes', b.prep_minutes, 'delivery_minutes', b.delivery_minutes),
    'items', coalesce((select jsonb_agg(jsonb_build_object('product_name', i.product_name,
        'variant_name', i.variant_name, 'image_path', i.image_path, 'quantity', i.quantity,
        'unit_price_ars', i.unit_price_ars, 'total_ars', i.total_ars) order by i.position)
      from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('status', e.to_status, 'at', e.created_at)
        order by e.created_at, e.id)
      from public.order_events e where e.order_id = o.id), '[]'::jsonb));
end;
$$;
revoke all on function private.track_order(uuid) from public, anon, authenticated;
grant execute on function private.track_order(uuid) to anon, authenticated;
create function public.track_order(token uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.track_order(token); $$;
revoke all on function public.track_order(uuid) from public, anon, authenticated;
grant execute on function public.track_order(uuid) to anon, authenticated;

-- ───────────────── taxi: construido y apagado ─────────────────
-- Toda operación de taxi pasa por el interruptor de la vertical.
create function private.require_feature(feature text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.feature_enabled(feature) then
    raise exception 'Feature disabled' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_feature(text) from public, anon, authenticated;
grant execute on function private.require_feature(text) to authenticated;

create or replace function private.apply_as_driver(display_name text, mobile_number text, vehicle text,
  plate text, phone text) returns public.drivers
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.drivers; locality uuid;
begin
  perform private.require_feature('taxi');
  if caller is null or not private.is_permanent_user() then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select id into locality from public.localities where slug = 'alumine' and active;
  insert into public.drivers (user_id, locality_id, display_name, mobile_number, vehicle, plate, phone)
    values (caller, locality, btrim(display_name), btrim(coalesce(mobile_number, '')),
      btrim(coalesce(vehicle, '')), btrim(coalesce(plate, '')), btrim(coalesce(phone, '')))
  on conflict (user_id) do update set display_name = excluded.display_name,
    mobile_number = excluded.mobile_number, vehicle = excluded.vehicle, plate = excluded.plate,
    phone = excluded.phone,
    status = case when public.drivers.status = 'returned' then 'pending_review' else public.drivers.status end
  returning * into row;
  return row;
end;
$$;

create or replace function private.set_driver_availability(is_available boolean) returns public.drivers
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.drivers;
begin
  perform private.require_feature('taxi');
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into row from public.drivers where user_id = caller;
  if row.id is null then raise exception 'Driver application not found' using errcode = 'P0002'; end if;
  if row.status <> 'active' and is_available then
    raise exception 'Your driver application is not approved yet' using errcode = '42501';
  end if;
  update public.drivers set available = is_available where id = row.id returning * into row;
  return row;
end;
$$;

create or replace function private.request_trip(origin text, destination text, origin_note text,
  passengers integer, passenger_name text, passenger_phone text)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.trips; locality uuid;
begin
  perform private.require_feature('taxi');
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform private.expire_open_trips();
  select id into locality from public.localities where slug = 'alumine' and active;
  if locality is null then raise exception 'Locality unavailable' using errcode = '23514'; end if;
  insert into public.trips (code, locality_id, passenger_id, origin, destination, origin_note,
    passengers, passenger_name, passenger_phone, expires_at)
  values (private.next_code('VJ', 'private.trip_code_seq'), locality, caller,
    btrim(origin), btrim(destination), left(btrim(coalesce(origin_note, '')), 120),
    coalesce(passengers, 1), btrim(passenger_name), btrim(passenger_phone), now() + interval '10 minutes')
  returning * into row;
  insert into public.trip_events (trip_id, to_status, actor_id, actor_role)
    values (row.id, 'requested', caller, 'passenger');
  return row;
exception when unique_violation then
  raise exception 'You already have an open request' using errcode = '23514';
end;
$$;

create or replace function private.driver_offers() returns setof public.trip_offer
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); me public.drivers;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not private.feature_enabled('taxi') then return; end if;
  select * into me from public.drivers where user_id = caller;
  if me.id is null or me.status <> 'active' or not me.available then return; end if;
  if exists (select 1 from public.trips where driver_id = me.id
    and status in ('accepted', 'driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip')) then
    return;
  end if;
  perform private.expire_open_trips();
  return query select t.id, t.code, t.status, t.origin, t.origin_note, t.destination, t.passengers,
    upper(left(btrim(t.passenger_name), 1)), t.created_at, t.expires_at
    from public.trips t
    where t.status in ('requested', 'searching') and t.driver_id is null
      and t.locality_id = me.locality_id and t.expires_at > now()
    order by t.created_at;
end;
$$;

create or replace function private.accept_trip(trip uuid) returns public.trips
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); me public.drivers; row public.trips;
begin
  perform private.require_feature('taxi');
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into me from public.drivers where user_id = caller;
  if me.id is null or me.status <> 'active' then
    raise exception 'Your driver application is not approved yet' using errcode = '42501';
  end if;
  if not me.available then
    raise exception 'Mark yourself available before accepting' using errcode = '42501';
  end if;
  if exists (select 1 from public.trips where driver_id = me.id
    and status in ('accepted', 'driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip')) then
    raise exception 'You already have a trip in progress' using errcode = '42501';
  end if;
  update public.trips set driver_id = me.id, status = 'accepted', accepted_at = now()
    where id = trip and driver_id is null and status in ('requested', 'searching')
      and expires_at > now() and locality_id = me.locality_id
    returning * into row;
  if row.id is null then
    raise exception 'That request is no longer available' using errcode = 'U0004';
  end if;
  insert into public.trip_events (trip_id, from_status, to_status, actor_id, actor_role)
    values (row.id, 'requested', 'accepted', caller, 'driver');
  return row;
exception when unique_violation then
  raise exception 'That request is no longer available' using errcode = 'U0004';
end;
$$;

-- ───────────────── observabilidad mínima ─────────────────
-- Errores que nunca llegan al servidor (JavaScript, red, sesión) quedan acá,
-- sin contraseñas, tokens, correos ni teléfonos. Lectura sólo administrativa.
create table private.client_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('frontend_error', 'supabase_error', 'auth_error', 'order_failed', 'critical')),
  code text not null default '' check (length(code) <= 60),
  message text not null default '' check (length(message) <= 300),
  route text not null default '' check (length(route) <= 80),
  release text not null default '' check (length(release) <= 40),
  user_id uuid,
  context jsonb not null default '{}'::jsonb
);
create index client_events_recent on private.client_events(created_at desc);
alter table private.client_events enable row level security;
revoke all on private.client_events from public, anon, authenticated;
create policy client_events_no_client_access on private.client_events
for all to anon, authenticated using (false) with check (false);

create function private.scrub(value text) returns text
language sql immutable security invoker set search_path = '' as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(value, ''),
    '[^[:space:]@]+@[^[:space:]@]+', '[correo]', 'g'),
    'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(secret|publishable)_[A-Za-z0-9_-]+', '[token]', 'g'),
    '[0-9][0-9 ()-]{6,}[0-9]', '[número]', 'g');
$$;
revoke all on function private.scrub(text) from public, anon, authenticated;

create function private.report_client_event(kind text, code text, message text, route text,
  release text, context jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); safe_context jsonb;
begin
  if kind not in ('frontend_error', 'supabase_error', 'auth_error', 'order_failed', 'critical') then
    return false;
  end if;
  -- Techo global y por cuenta: un cliente roto o malicioso no llena la tabla.
  if (select count(*) from private.client_events where created_at > now() - interval '1 minute') >= 300 then
    return false;
  end if;
  if caller is not null and (select count(*) from private.client_events
      where user_id = caller and created_at > now() - interval '1 minute') >= 20 then
    return false;
  end if;
  safe_context := case when context is null or jsonb_typeof(context) <> 'object'
    or pg_column_size(context) > 2048 then '{}'::jsonb else context end;
  insert into private.client_events (kind, code, message, route, release, user_id, context)
  values (kind, left(private.scrub(code), 60), left(private.scrub(message), 300),
    left(regexp_replace(coalesce(route, ''), '[^a-z0-9#/_-]', '', 'gi'), 80),
    left(coalesce(release, ''), 40), caller,
    coalesce((select jsonb_object_agg(k, left(private.scrub(v), 120))
      from jsonb_each_text(safe_context) as e(k, v) where k ~ '^[a-zA-Z_]{1,40}$'), '{}'::jsonb));
  -- Retención de 30 días, sin tarea programada.
  if random() < 0.02 then
    delete from private.client_events where created_at < now() - interval '30 days';
  end if;
  return true;
end;
$$;
revoke all on function private.report_client_event(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.report_client_event(text, text, text, text, text, jsonb) to anon, authenticated;
create function public.report_client_event(kind text, code text default '', message text default '',
  route text default '', release text default '', context jsonb default '{}'::jsonb) returns boolean
language sql security invoker set search_path = ''
as $$ select private.report_client_event(kind, code, message, route, release, context); $$;
revoke all on function public.report_client_event(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.report_client_event(text, text, text, text, text, jsonb) to anon, authenticated;

create function private.admin_client_events(max_rows integer) returns setof private.client_events
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return query select * from private.client_events order by created_at desc
    limit least(greatest(coalesce(max_rows, 50), 1), 200);
end;
$$;
revoke all on function private.admin_client_events(integer) from public, anon, authenticated;
grant execute on function private.admin_client_events(integer) to authenticated;
create function public.admin_client_events(max_rows integer default 50)
returns table (created_at timestamptz, kind text, code text, message text, route text, release text)
language sql stable security invoker set search_path = ''
as $$ select e.created_at, e.kind, e.code, e.message, e.route, e.release from private.admin_client_events(max_rows) e; $$;
revoke all on function public.admin_client_events(integer) from public, anon, authenticated;
grant execute on function public.admin_client_events(integer) to authenticated;

commit;
