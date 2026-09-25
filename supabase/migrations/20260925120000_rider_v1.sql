-- CAUCE: reparto propio v1. La persona que reparte para un comercio entra con
-- su cuenta y opera sólo los pedidos que ese comercio le asignó.
--
-- Qué cambia y por qué (ver docs/CONTRATO-RIDER.md):
--   · business_riders.user_id: el comercio vincula a su persona de reparto con
--     una cuenta de CAUCE que ya existe (por correo, como el equipo). Sin cuenta
--     el reparto sigue igual que antes: el comercio marca cada paso.
--   · Rol `rider` en transition_order: retiré, en camino y llegué, sólo sobre
--     pedidos asignados a su fila activa. Nunca asignarse, cancelar, ver otros
--     pedidos ni tocar el catálogo.
--   · Entregar exige el código del cliente, verificado por la base, con límite
--     de intentos por pedido y cada intento registrado. El comercio puede cerrar
--     igual la entrega (sin batería, sin datos, código bloqueado).
--   · Lectura acotada por función: lo necesario para entregar. Sin el código,
--     sin la cuenta del cliente ni el enlace de seguimiento; los datos de
--     contacto sólo mientras la entrega está abierta.
--   · El código de entrega sale del generador fuerte de PostgreSQL.
-- Forward-only: no borra ni reescribe datos existentes.
begin;

-- ───────────────── reparto ↔ cuenta ─────────────────
-- La columna no se concede a ningún rol cliente: sólo la escriben las funciones
-- de vincular y desvincular.
alter table public.business_riders
  add column user_id uuid references auth.users(id) on delete set null;
create unique index business_riders_account on public.business_riders(business_id, user_id)
  where user_id is not null;
create index business_riders_user on public.business_riders(user_id) where user_id is not null;

-- Quien reparte ve sus propias filas (para saber para qué comercios reparte).
create policy riders_read_self on public.business_riders for select to authenticated
using (user_id = (select auth.uid()));

-- ¿La cuenta que llama es la persona de reparto activa de este pedido?
create function private.is_order_rider(rider uuid, business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and rider is not null and exists (
    select 1 from public.business_riders r
    where r.id = rider and r.business_id = business and r.active
      and r.user_id = (select auth.uid()));
$$;
revoke all on function private.is_order_rider(uuid, uuid) from public, anon, authenticated;

-- Titular o encargado/a vincula por correo una cuenta permanente que ya existe.
-- Una fila de otro comercio responde igual que una que no existe.
create function private.link_rider_account(rider uuid, account_email text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target uuid; row public.business_riders;
begin
  select * into row from public.business_riders where id = rider for update;
  if row.id is null or not private.is_permanent_user()
     or not private.is_business_member(row.business_id, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  select u.id into target from auth.users u
    where lower(u.email) = lower(btrim(coalesce(account_email, '')))
      and coalesce(u.is_anonymous, false) = false
      and u.deleted_at is null;
  if target is null then
    raise exception 'No account with that email' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.business_riders r
    where r.business_id = row.business_id and r.user_id = target and r.id <> row.id) then
    raise exception 'Account already linked to another rider' using errcode = '23505';
  end if;
  update public.business_riders set user_id = target where id = row.id;
  return true;
end;
$$;
revoke all on function private.link_rider_account(uuid, text) from public, anon, authenticated;
grant execute on function private.link_rider_account(uuid, text) to authenticated;
create function public.link_rider_account(rider uuid, account_email text)
returns boolean language sql security invoker set search_path = ''
as $$ select private.link_rider_account(rider, account_email); $$;
revoke all on function public.link_rider_account(uuid, text) from public, anon, authenticated;
grant execute on function public.link_rider_account(uuid, text) to authenticated;

-- Desvincula el comercio (titular o encargado/a) o la propia persona.
create function private.unlink_rider_account(rider uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.business_riders;
begin
  select * into row from public.business_riders where id = rider for update;
  if row.id is null or caller is null or not private.is_permanent_user()
     or not (row.user_id is not distinct from caller
       or private.is_business_member(row.business_id, array['owner', 'manager'])) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  update public.business_riders set user_id = null where id = row.id;
  return true;
end;
$$;
revoke all on function private.unlink_rider_account(uuid) from public, anon, authenticated;
grant execute on function private.unlink_rider_account(uuid) to authenticated;
create function public.unlink_rider_account(rider uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select private.unlink_rider_account(rider); $$;
revoke all on function public.unlink_rider_account(uuid) from public, anon, authenticated;
grant execute on function public.unlink_rider_account(uuid) to authenticated;

-- Qué cuenta tiene vinculada cada persona de reparto (titular y encargado/a).
create function private.business_rider_accounts(business uuid)
returns table (rider_id uuid, email text) language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  return query
    select r.id, coalesce(u.email, '')::text from public.business_riders r
    join auth.users u on u.id = r.user_id
    where r.business_id = business
    order by r.name;
end;
$$;
revoke all on function private.business_rider_accounts(uuid) from public, anon, authenticated;
grant execute on function private.business_rider_accounts(uuid) to authenticated;
create function public.business_rider_accounts(business uuid)
returns table (rider_id uuid, email text) language sql stable security invoker set search_path = ''
as $$ select * from private.business_rider_accounts(business); $$;
revoke all on function public.business_rider_accounts(uuid) from public, anon, authenticated;
grant execute on function public.business_rider_accounts(uuid) to authenticated;

-- ───────────────── máquina de estados ─────────────────
-- Quien reparte avanza su entrega; entregar pasa por confirm_delivery (código).
-- Las filas `merchant` no cambian: el comercio completa todo el recorrido aunque
-- la persona de reparto no use la aplicación.
insert into private.order_transitions (from_status, to_status, actor_role, fulfillment) values
  ('assigned', 'picked_up', 'rider', 'delivery'),
  ('picked_up', 'on_the_way', 'rider', 'delivery'),
  ('on_the_way', 'arrived', 'rider', 'delivery'),
  ('on_the_way', 'delivered', 'rider', 'delivery'),
  ('arrived', 'delivered', 'rider', 'delivery');

alter table public.order_events drop constraint order_events_actor_role_check;
alter table public.order_events add constraint order_events_actor_role_check
  check (actor_role in ('customer', 'merchant', 'rider', 'admin', 'system'));

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
  -- Quien integra el comercio actúa como comercio aunque también reparta: ya
  -- puede todo lo que puede la persona de reparto.
  if private.is_business_member(row.business_id, array['owner', 'manager', 'staff']) then
    role := 'merchant';
  elsif private.is_order_rider(row.rider_id, row.business_id) then
    role := 'rider';
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
  -- La persona de reparto entrega sólo con el código del cliente.
  if role = 'rider' and next_status = 'delivered' then
    raise exception 'Delivery code required' using errcode = '23514';
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

-- ───────────────── código de entrega ─────────────────
-- Cada intento queda registrado. Nadie lo lee desde el cliente.
create table private.delivery_code_attempts (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  rider_id uuid references public.business_riders(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index delivery_code_attempts_order on private.delivery_code_attempts(order_id);
alter table private.delivery_code_attempts enable row level security;
revoke all on private.delivery_code_attempts from public, anon, authenticated;
create policy delivery_code_attempts_no_client_access on private.delivery_code_attempts
for all to anon, authenticated using (false) with check (false);

-- 4 dígitos son 10.000 combinaciones: 5 intentos fallidos por pedido y se
-- bloquea (queda cerrar la entrega desde el comercio). Un intento fallido NO
-- lanza error: el registro tiene que sobrevivir a la transacción.
create function private.confirm_delivery(order_id uuid, expected_version integer, code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  row public.orders;
  attempt text := regexp_replace(coalesce(code, ''), '[^0-9]', '', 'g');
  failures integer;
  previous text;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into row from public.orders where id = order_id for update;
  if row.id is null then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if not private.is_order_rider(row.rider_id, row.business_id) then
    raise exception 'This order belongs to another account' using errcode = '42501';
  end if;
  if expected_version is not null and row.version <> expected_version then
    raise exception 'The order changed while you were looking at it' using errcode = 'U0001';
  end if;
  if not exists (select 1 from private.order_transitions t
    where t.from_status = row.status and t.to_status = 'delivered' and t.actor_role = 'rider'
      and (t.fulfillment is null or t.fulfillment = row.fulfillment)) then
    raise exception 'Transition not allowed' using errcode = '42501';
  end if;
  select count(*) into failures from private.delivery_code_attempts a
    where a.order_id = row.id and not a.success;
  if failures >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'remaining', 0);
  end if;
  if attempt !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'reason', 'format', 'remaining', 5 - failures);
  end if;
  if row.delivery_code is null or attempt <> row.delivery_code then
    insert into private.delivery_code_attempts (order_id, rider_id, actor_id, success)
      values (row.id, row.rider_id, caller, false);
    return jsonb_build_object('ok', false,
      'reason', case when failures + 1 >= 5 then 'locked' else 'wrong' end,
      'remaining', 5 - failures - 1);
  end if;
  insert into private.delivery_code_attempts (order_id, rider_id, actor_id, success)
    values (row.id, row.rider_id, caller, true);
  previous := row.status;
  update public.orders set status = 'delivered', version = version + 1, updated_at = now(),
    payment_status = 'settled'
    where id = row.id returning * into row;
  insert into public.order_events (order_id, business_id, customer_id, from_status, to_status,
    actor_id, actor_role, note)
    values (row.id, row.business_id, row.customer_id, previous, 'delivered', caller, 'rider',
      'Entregado con código');
  return jsonb_build_object('ok', true, 'status', row.status, 'version', row.version);
end;
$$;
revoke all on function private.confirm_delivery(uuid, integer, text) from public, anon, authenticated;
grant execute on function private.confirm_delivery(uuid, integer, text) to authenticated;
create function public.confirm_delivery(order_id uuid, expected_version integer, code text)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.confirm_delivery(order_id, expected_version, code); $$;
revoke all on function public.confirm_delivery(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.confirm_delivery(uuid, integer, text) to authenticated;

-- El código lo genera la base con gen_random_uuid() (generador fuerte), no con
-- random(). Muestreo por rechazo: los 10.000 códigos salen equiprobables. Los
-- pedidos existentes conservan el código que el cliente ya tiene.
create function private.secure_delivery_code() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare n bigint;
begin
  if new.fulfillment = 'delivery' then
    loop
      n := ('x' || lpad(substr(gen_random_uuid()::text, 1, 8), 16, '0'))::bit(64)::bigint;
      exit when n < 4294960000;
    end loop;
    new.delivery_code := lpad((n % 10000)::text, 4, '0');
  else
    new.delivery_code := null;
  end if;
  return new;
end;
$$;
revoke all on function private.secure_delivery_code() from public, anon, authenticated;
create trigger orders_secure_delivery_code before insert on public.orders
  for each row execute function private.secure_delivery_code();

-- ───────────────── lectura de quien reparte ─────────────────
-- Sin política nueva sobre `orders`: una política entregaría todas las columnas
-- (código de entrega, cuenta del cliente, enlace de seguimiento). Esta función
-- devuelve sólo lo necesario para entregar, de las filas activas vinculadas a la
-- cuenta. Cerrado el pedido, quedan el código, la hora y el importe.
create function private.rider_orders() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(item order by ongoing desc, moved desc), '[]'::jsonb)
  from (
    select o.status in ('assigned', 'picked_up', 'on_the_way', 'arrived') as ongoing, o.updated_at as moved,
      jsonb_build_object(
        'id', o.id, 'code', o.code, 'status', o.status, 'version', o.version,
        'business', jsonb_build_object('id', b.id, 'name', b.name, 'address', b.address,
          'phone', coalesce(nullif(b.public_phone, ''), b.whatsapp)),
        'locality', l.name,
        'rider', jsonb_build_object('id', r.id, 'name', r.name),
        'payment_method', o.payment_method, 'payment_status', o.payment_status,
        'subtotal_ars', o.subtotal_ars, 'delivery_fee_ars', o.delivery_fee_ars, 'total_ars', o.total_ars,
        'contact_name', o.contact_name,
        'contact_phone', case when o.status in ('delivered', 'canceled') then '' else o.contact_phone end,
        'address', case when o.status in ('delivered', 'canceled') then '' else o.address end,
        'notes', case when o.status in ('delivered', 'canceled') then '' else o.notes end,
        'cancel_reason', o.cancel_reason,
        'code_attempts_left', greatest(0, 5 - (select count(*) from private.delivery_code_attempts a
          where a.order_id = o.id and not a.success)),
        'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name,
            'variant', i.variant_name, 'quantity', i.quantity) order by i.position)
          from public.order_items i where i.order_id = o.id), '[]'::jsonb),
        'history', coalesce((select jsonb_agg(jsonb_build_object('status', e.to_status, 'at', e.created_at)
            order by e.created_at, e.id)
          from public.order_events e where e.order_id = o.id), '[]'::jsonb),
        'created_at', o.created_at, 'updated_at', o.updated_at) as item
    from public.business_riders r
    join public.orders o on o.rider_id = r.id and o.business_id = r.business_id
    join public.businesses b on b.id = o.business_id
    join public.localities l on l.id = o.locality_id
    where r.user_id = (select auth.uid()) and r.active and o.fulfillment = 'delivery'
      and (o.status in ('assigned', 'picked_up', 'on_the_way', 'arrived')
        or (o.status in ('delivered', 'canceled') and o.updated_at > now() - interval '7 days'))
    order by ongoing desc, o.updated_at desc
    limit 100
  ) mine;
$$;
revoke all on function private.rider_orders() from public, anon, authenticated;
grant execute on function private.rider_orders() to authenticated;
create function public.rider_orders() returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.rider_orders(); $$;
revoke all on function public.rider_orders() from public, anon, authenticated;
grant execute on function public.rider_orders() to authenticated;

-- ───────────────── contrato con el frontend ─────────────────
create or replace function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schema', 20260925120000,
    'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
    'localities', coalesce((select jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'timezone', timezone)
      order by name) from public.localities where active), '[]'::jsonb),
    'now', now());
$$;

commit;
