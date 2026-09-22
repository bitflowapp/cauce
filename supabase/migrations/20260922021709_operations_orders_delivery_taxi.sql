-- CAUCE: pedidos, reparto propio del comercio y viajes de taxi.
-- El cliente nunca es autoridad financiera ni de estado: todo importe y toda
-- transición se resuelven en el servidor. Dinero en ARS enteros (bigint).
begin;

-- Códigos propios devueltos a la aplicación (clases reservadas por PostgreSQL
-- no se reutilizan): U0001 versión vencida, U0002 intento repetido con otros
-- datos, U0003 sin stock, U0004 viaje ya tomado.

create sequence private.order_code_seq;
create sequence private.trip_code_seq;

-- ───────────────── reparto propio de cada comercio ─────────────────
-- Es un registro operado por el comercio, no una cuenta independiente.
create table public.business_riders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 80),
  phone text not null default '' check (length(phone) <= 24),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (business_id, name),
  unique (id, business_id)
);

-- ───────────────── pedidos ─────────────────
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  business_id uuid not null,
  locality_id uuid not null,
  customer_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  fulfillment text not null check (fulfillment in ('pickup', 'delivery')),
  payment_method text not null check (payment_method in ('cash_on_delivery', 'cash_on_pickup')),
  payment_status text not null default 'pending_on_delivery'
    check (payment_status in ('pending_on_delivery', 'settled')),
  status text not null default 'submitted' check (status in
    ('submitted', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up',
     'on_the_way', 'arrived', 'delivered', 'canceled')),
  contact_name text not null check (length(btrim(contact_name)) between 2 and 80),
  contact_phone text not null check (length(btrim(contact_phone)) between 6 and 24),
  address text not null default '' check (length(address) <= 200),
  notes text not null default '' check (length(notes) <= 280),
  subtotal_ars bigint not null check (subtotal_ars > 0),
  delivery_fee_ars bigint not null default 0 check (delivery_fee_ars >= 0),
  total_ars bigint not null check (total_ars > 0),
  currency text not null default 'ARS' check (currency = 'ARS'),
  rider_id uuid,
  delivery_code text check (delivery_code is null or delivery_code ~ '^[0-9]{4}$'),
  tracking_token uuid not null default gen_random_uuid(),
  version integer not null default 1 check (version > 0),
  cancel_reason text not null default '' check (length(cancel_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, locality_id) references public.businesses(id, locality_id),
  foreign key (rider_id, business_id) references public.business_riders(id, business_id),
  constraint orders_total_matches check (total_ars = subtotal_ars + delivery_fee_ars),
  constraint orders_delivery_needs_address check (fulfillment <> 'delivery' or length(btrim(address)) >= 5),
  constraint orders_pickup_has_no_fee check (fulfillment <> 'pickup' or delivery_fee_ars = 0),
  unique (customer_id, business_id, idempotency_key),
  unique (id, business_id),
  unique (id, customer_id)
);
create index orders_business_feed on public.orders(business_id, created_at desc);
create index orders_customer_feed on public.orders(customer_id, created_at desc);
create index orders_rider on public.orders(rider_id) where rider_id is not null;

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  business_id uuid not null,
  customer_id uuid not null,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name text not null,
  variant_name text not null default '',
  image_path text,
  dish_type text not null default '',
  unit_price_ars bigint not null check (unit_price_ars > 0),
  quantity integer not null check (quantity between 1 and 99),
  total_ars bigint not null check (total_ars > 0),
  position smallint not null default 0,
  constraint order_items_total_matches check (total_ars = unit_price_ars * quantity),
  foreign key (order_id, business_id) references public.orders(id, business_id) on delete cascade,
  foreign key (order_id, customer_id) references public.orders(id, customer_id) on delete cascade
);
create index order_items_order on public.order_items(order_id, position);

create table public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  business_id uuid not null,
  customer_id uuid not null,
  from_status text,
  to_status text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text not null check (actor_role in ('customer', 'merchant', 'admin', 'system')),
  note text not null default '' check (length(note) <= 200),
  created_at timestamptz not null default now(),
  foreign key (order_id, business_id) references public.orders(id, business_id) on delete cascade,
  foreign key (order_id, customer_id) references public.orders(id, customer_id) on delete cascade
);
create index order_events_order on public.order_events(order_id, created_at);

-- Tabla de transiciones: refleja las mismas reglas que js/core/workflow-policy.js.
create table private.order_transitions (
  from_status text not null,
  to_status text not null,
  actor_role text not null,
  fulfillment text,
  primary key (from_status, to_status, actor_role)
);
insert into private.order_transitions (from_status, to_status, actor_role, fulfillment) values
  ('submitted', 'canceled', 'customer', null),
  ('submitted', 'accepted', 'merchant', null),
  ('accepted', 'preparing', 'merchant', null),
  ('preparing', 'ready', 'merchant', null),
  ('ready', 'assigned', 'merchant', 'delivery'),
  ('ready', 'delivered', 'merchant', 'pickup'),
  ('assigned', 'picked_up', 'merchant', 'delivery'),
  ('picked_up', 'on_the_way', 'merchant', 'delivery'),
  ('on_the_way', 'arrived', 'merchant', 'delivery'),
  ('on_the_way', 'delivered', 'merchant', 'delivery'),
  ('arrived', 'delivered', 'merchant', 'delivery'),
  ('submitted', 'canceled', 'merchant', null),
  ('accepted', 'canceled', 'merchant', null),
  ('preparing', 'canceled', 'merchant', null),
  ('ready', 'canceled', 'merchant', null),
  ('assigned', 'canceled', 'merchant', null);
alter table private.order_transitions enable row level security;
revoke all on private.order_transitions from public, anon, authenticated;

-- ───────────────── taxis ─────────────────
create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  locality_id uuid not null references public.localities(id),
  display_name text not null check (length(btrim(display_name)) between 2 and 80),
  mobile_number text not null default '' check (length(mobile_number) <= 40),
  vehicle text not null default '' check (length(vehicle) <= 80),
  plate text not null default '' check (length(plate) <= 16),
  phone text not null default '' check (length(phone) <= 24),
  status text not null default 'pending_review'
    check (status in ('pending_review', 'returned', 'active', 'paused')),
  available boolean not null default false,
  review_note text not null default '' check (length(review_note) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index drivers_dispatch on public.drivers(locality_id) where status = 'active' and available;
create trigger drivers_touch before update on public.drivers
  for each row execute function private.touch_updated_at();

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  locality_id uuid not null references public.localities(id),
  passenger_id uuid not null references auth.users(id) on delete restrict,
  driver_id uuid references public.drivers(id) on delete set null,
  status text not null default 'requested' check (status in
    ('requested', 'searching', 'accepted', 'driver_on_way', 'driver_arrived',
     'passenger_on_board', 'in_trip', 'completed', 'canceled', 'expired', 'no_availability')),
  origin text not null check (length(btrim(origin)) between 3 and 120),
  origin_note text not null default '' check (length(origin_note) <= 120),
  destination text not null check (length(btrim(destination)) between 3 and 120),
  passengers smallint not null default 1 check (passengers between 1 and 4),
  passenger_name text not null check (length(btrim(passenger_name)) between 2 and 80),
  passenger_phone text not null check (length(btrim(passenger_phone)) between 6 and 24),
  cancel_reason text not null default '' check (length(cancel_reason) <= 200),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_driver_when_assigned check (
    (status in ('requested', 'searching', 'expired', 'no_availability') and driver_id is null)
    or status in ('canceled', 'completed') or driver_id is not null)
);
-- Un pasajero con una solicitud abierta y un conductor con un viaje en curso:
-- la exclusión la garantiza el índice, no una comprobación del cliente.
create unique index trips_one_open_per_passenger on public.trips(passenger_id)
  where status in ('requested', 'searching', 'accepted', 'driver_on_way',
    'driver_arrived', 'passenger_on_board', 'in_trip');
create unique index trips_one_active_per_driver on public.trips(driver_id)
  where status in ('accepted', 'driver_on_way', 'driver_arrived', 'passenger_on_board', 'in_trip');
create index trips_open_offers on public.trips(locality_id, created_at)
  where status in ('requested', 'searching');
create index trips_passenger_feed on public.trips(passenger_id, created_at desc);
create trigger trips_touch before update on public.trips
  for each row execute function private.touch_updated_at();

create table public.trip_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text not null check (actor_role in ('passenger', 'driver', 'admin', 'system')),
  note text not null default '' check (length(note) <= 200),
  created_at timestamptz not null default now()
);
create index trip_events_trip on public.trip_events(trip_id, created_at);

create table private.trip_transitions (
  from_status text not null,
  to_status text not null,
  actor_role text not null,
  primary key (from_status, to_status, actor_role)
);
insert into private.trip_transitions (from_status, to_status, actor_role) values
  ('accepted', 'driver_on_way', 'driver'),
  ('driver_on_way', 'driver_arrived', 'driver'),
  ('driver_arrived', 'passenger_on_board', 'driver'),
  ('passenger_on_board', 'in_trip', 'driver'),
  ('in_trip', 'completed', 'driver'),
  ('requested', 'canceled', 'passenger'),
  ('searching', 'canceled', 'passenger'),
  ('accepted', 'canceled', 'passenger'),
  ('driver_on_way', 'canceled', 'passenger'),
  ('driver_arrived', 'canceled', 'passenger'),
  ('accepted', 'canceled', 'driver'),
  ('driver_on_way', 'canceled', 'driver'),
  ('driver_arrived', 'canceled', 'driver');
alter table private.trip_transitions enable row level security;
revoke all on private.trip_transitions from public, anon, authenticated;

-- ───────────────── privilegios ─────────────────
-- Pedidos y viajes no admiten escritura directa: sólo lectura acotada y RPC.
revoke all on public.business_riders, public.orders, public.order_items, public.order_events,
  public.drivers, public.trips, public.trip_events from public, anon, authenticated;
grant select on public.orders, public.order_items, public.order_events to authenticated;
grant select on public.trips, public.trip_events, public.drivers to authenticated;
grant select on public.business_riders to authenticated;
grant insert (business_id, name, phone), update (name, phone, active), delete
  on public.business_riders to authenticated;

alter table public.business_riders enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;
alter table public.drivers enable row level security;
alter table public.trips enable row level security;
alter table public.trip_events enable row level security;

-- ───────────────── políticas ─────────────────
create policy riders_read on public.business_riders for select to authenticated
using (private.is_business_member(business_id, array['owner', 'manager', 'staff']));
create policy riders_insert on public.business_riders for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy riders_update on public.business_riders for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy riders_delete on public.business_riders for delete to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

-- El cliente ve sus pedidos; el comercio ve los suyos. Nadie más, ni anónimos.
create policy orders_read on public.orders for select to authenticated
using (customer_id = (select auth.uid())
  or private.is_business_member(business_id, array['owner', 'manager', 'staff']));
create policy order_items_read on public.order_items for select to authenticated
using (customer_id = (select auth.uid())
  or private.is_business_member(business_id, array['owner', 'manager', 'staff']));
create policy order_events_read on public.order_events for select to authenticated
using (customer_id = (select auth.uid())
  or private.is_business_member(business_id, array['owner', 'manager', 'staff']));

-- El alta de conductor la lee su titular y la administración. Los datos del
-- conductor asignado los entrega una función acotada, no esta política.
create policy drivers_read_self on public.drivers for select to authenticated
using (user_id = (select auth.uid()) or (select private.is_admin()));

-- Antes de aceptar, una solicitud abierta no es legible por ningún conductor:
-- la oferta sin identidad se sirve por RPC.
create policy trips_read on public.trips for select to authenticated
using (passenger_id = (select auth.uid())
  or (driver_id is not null and driver_id = (select id from public.drivers where user_id = (select auth.uid())))
  or (select private.is_admin()));
create policy trip_events_read on public.trip_events for select to authenticated
using (exists (select 1 from public.trips t where t.id = trip_id
  and (t.passenger_id = (select auth.uid())
    or (t.driver_id is not null and t.driver_id = (select id from public.drivers where user_id = (select auth.uid())))
    or (select private.is_admin()))));

-- ───────────────── creación de pedidos ─────────────────
-- Precios, disponibilidad, envío y total salen del catálogo guardado.
create function private.create_order(business uuid, idem uuid, fulfillment text,
  payment_method text, contact jsonb, items jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
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
  used integer;
  position smallint := 0;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if fulfillment not in ('pickup', 'delivery') then
    raise exception 'Invalid fulfillment' using errcode = '23514';
  end if;
  if payment_method not in ('cash_on_delivery', 'cash_on_pickup') then
    raise exception 'Payment method not available' using errcode = '23514';
  end if;
  contact_name := btrim(coalesce(contact ->> 'name', ''));
  contact_phone := btrim(coalesce(contact ->> 'phone', ''));
  address := btrim(coalesce(contact ->> 'address', ''));
  notes := left(btrim(coalesce(contact ->> 'notes', '')), 280);
  if fulfillment = 'pickup' then address := ''; end if;

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

  select * into shop from public.businesses where id = business;
  if shop.id is null or shop.status <> 'active' then
    raise exception 'Business not available' using errcode = '23514';
  end if;
  if not shop.open then raise exception 'Business closed' using errcode = '23514'; end if;
  if fulfillment = 'pickup' and not shop.pickup_enabled then
    raise exception 'Pickup not available' using errcode = '23514';
  end if;
  if fulfillment = 'delivery' and not shop.delivery_enabled then
    raise exception 'Delivery not available' using errcode = '23514';
  end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 100 then
    raise exception 'Empty cart' using errcode = '23514';
  end if;

  new_order := gen_random_uuid();
  insert into public.orders (id, code, business_id, locality_id, customer_id, idempotency_key,
    request_fingerprint, fulfillment, payment_method, contact_name, contact_phone, address, notes,
    subtotal_ars, delivery_fee_ars, total_ars, delivery_code)
  values (new_order, 'CA-' || lpad(nextval('private.order_code_seq')::text, 4, '0'), business,
    shop.locality_id, caller, idem, fingerprint, fulfillment, payment_method, contact_name,
    contact_phone, address, notes, 1, 0, 1,
    case when fulfillment = 'delivery' then lpad((floor(random() * 10000))::int::text, 4, '0') end);

  for item in select * from jsonb_array_elements(items) loop
    quantity := (item ->> 'quantity')::int;
    if quantity is null or quantity < 1 or quantity > 99 then
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
    select coalesce(sum(oi.quantity), 0) into used from public.order_items oi
      where oi.order_id = new_order and oi.product_id = product.id;
    if product.stock < used + quantity then
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
    update public.products set stock = stock - quantity where id = product.id;
  end loop;

  if fulfillment = 'delivery' then
    fee := shop.delivery_fee_ars;
    if subtotal < shop.minimum_order_ars then
      raise exception 'Minimum order not reached' using errcode = '23514';
    end if;
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
revoke all on function private.create_order(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function private.create_order(uuid, uuid, text, text, jsonb, jsonb) to authenticated;
create function public.create_order(business uuid, idem uuid, fulfillment text,
  payment_method text, contact jsonb, items jsonb)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_order(business, idem, fulfillment, payment_method, contact, items); $$;
revoke all on function public.create_order(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, text, text, jsonb, jsonb) to authenticated;

-- ───────────────── transiciones de pedido ─────────────────
create function private.transition_order(order_id uuid, expected_version integer,
  next_status text, rider uuid, reason text)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  row public.orders;
  role text;
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
  if next_status = 'assigned' then
    if rider is null then raise exception 'Choose who delivers' using errcode = '23514'; end if;
    if not exists (select 1 from public.business_riders r
      where r.id = rider and r.business_id = row.business_id and r.active) then
      raise exception 'Rider not available' using errcode = '23514';
    end if;
  end if;
  if next_status = 'canceled' then
    -- Devolver el stock reservado mantiene el catálogo consistente.
    update public.products p set stock = p.stock + i.quantity
      from public.order_items i where i.order_id = row.id and i.product_id = p.id;
  end if;
  update public.orders set status = next_status, version = version + 1, updated_at = now(),
    rider_id = case when next_status = 'assigned' then rider else rider_id end,
    cancel_reason = case when next_status = 'canceled' then left(coalesce(reason, ''), 200) else cancel_reason end,
    payment_status = case when next_status = 'delivered' then 'settled' else payment_status end
    where id = row.id returning * into row;
  insert into public.order_events (order_id, business_id, customer_id, from_status, to_status,
    actor_id, actor_role, note)
    values (row.id, row.business_id, row.customer_id, null, next_status, caller, role,
      left(coalesce(reason, ''), 200));
  return row;
end;
$$;
revoke all on function private.transition_order(uuid, integer, text, uuid, text) from public, anon, authenticated;
grant execute on function private.transition_order(uuid, integer, text, uuid, text) to authenticated;
create function public.transition_order(order_id uuid, expected_version integer default null,
  next_status text default null, rider uuid default null, reason text default '')
returns public.orders language sql security invoker set search_path = ''
as $$ select private.transition_order(order_id, expected_version, next_status, rider, reason); $$;
revoke all on function public.transition_order(uuid, integer, text, uuid, text) from public, anon, authenticated;
grant execute on function public.transition_order(uuid, integer, text, uuid, text) to authenticated;

-- ───────────────── alta y revisión de conductores ─────────────────
create function private.apply_as_driver(display_name text, mobile_number text, vehicle text,
  plate text, phone text) returns public.drivers
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.drivers; locality uuid;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
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
revoke all on function private.apply_as_driver(text, text, text, text, text) from public, anon, authenticated;
grant execute on function private.apply_as_driver(text, text, text, text, text) to authenticated;
create function public.apply_as_driver(display_name text, mobile_number text default '',
  vehicle text default '', plate text default '', phone text default '')
returns public.drivers language sql security invoker set search_path = ''
as $$ select private.apply_as_driver(display_name, mobile_number, vehicle, plate, phone); $$;
revoke all on function public.apply_as_driver(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_as_driver(text, text, text, text, text) to authenticated;

create function private.review_driver(driver uuid, decision text, note text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  if decision not in ('active', 'returned', 'paused') then
    raise exception 'Invalid decision' using errcode = '23514';
  end if;
  update public.drivers set status = decision, review_note = left(coalesce(note, ''), 400),
    available = case when decision = 'active' then available else false end
    where id = driver;
  if not found then raise exception 'Driver not found' using errcode = 'P0002'; end if;
  return decision;
end;
$$;
revoke all on function private.review_driver(uuid, text, text) from public, anon, authenticated;
grant execute on function private.review_driver(uuid, text, text) to authenticated;
create function public.review_driver(driver uuid, decision text, note text default '') returns text
language sql security invoker set search_path = ''
as $$ select private.review_driver(driver, decision, note); $$;
revoke all on function public.review_driver(uuid, text, text) from public, anon, authenticated;
grant execute on function public.review_driver(uuid, text, text) to authenticated;

create function private.set_driver_availability(is_available boolean) returns public.drivers
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.drivers;
begin
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
revoke all on function private.set_driver_availability(boolean) from public, anon, authenticated;
grant execute on function private.set_driver_availability(boolean) to authenticated;
create function public.set_driver_availability(is_available boolean) returns public.drivers
language sql security invoker set search_path = ''
as $$ select private.set_driver_availability(is_available); $$;
revoke all on function public.set_driver_availability(boolean) from public, anon, authenticated;
grant execute on function public.set_driver_availability(boolean) to authenticated;

-- ───────────────── viajes ─────────────────
create function private.expire_open_trips() returns void
language sql security definer set search_path = '' as $$
  update public.trips set status = 'expired'
    where status in ('requested', 'searching') and expires_at <= now();
$$;
revoke all on function private.expire_open_trips() from public, anon, authenticated;
grant execute on function private.expire_open_trips() to authenticated;

create function private.request_trip(origin text, destination text, origin_note text,
  passengers integer, passenger_name text, passenger_phone text)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.trips; locality uuid;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform private.expire_open_trips();
  select id into locality from public.localities where slug = 'alumine' and active;
  if locality is null then raise exception 'Locality unavailable' using errcode = '23514'; end if;
  insert into public.trips (code, locality_id, passenger_id, origin, destination, origin_note,
    passengers, passenger_name, passenger_phone, expires_at)
  values ('VJ-' || lpad(nextval('private.trip_code_seq')::text, 4, '0'), locality, caller,
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
revoke all on function private.request_trip(text, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function private.request_trip(text, text, text, integer, text, text) to authenticated;
create function public.request_trip(origin text, destination text, origin_note text default '',
  passengers integer default 1, passenger_name text default '', passenger_phone text default '')
returns public.trips language sql security invoker set search_path = ''
as $$ select private.request_trip(origin, destination, origin_note, passengers, passenger_name, passenger_phone); $$;
revoke all on function public.request_trip(text, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.request_trip(text, text, text, integer, text, text) to authenticated;

-- Oferta sin identidad: el conductor no recibe nombre ni teléfono hasta aceptar.
create type public.trip_offer as (
  id uuid, code text, status text, origin text, origin_note text, destination text,
  passengers smallint, passenger_initial text, created_at timestamptz, expires_at timestamptz
);
create function private.driver_offers() returns setof public.trip_offer
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); me public.drivers;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
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
revoke all on function private.driver_offers() from public, anon, authenticated;
grant execute on function private.driver_offers() to authenticated;
create function public.driver_offers() returns setof public.trip_offer
language sql security invoker set search_path = ''
as $$ select * from private.driver_offers(); $$;
revoke all on function public.driver_offers() from public, anon, authenticated;
grant execute on function public.driver_offers() to authenticated;

-- Aceptación atómica: una sola sentencia decide, sin lectura previa desde el cliente.
create function private.accept_trip(trip uuid) returns public.trips
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); me public.drivers; row public.trips;
begin
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
revoke all on function private.accept_trip(uuid) from public, anon, authenticated;
grant execute on function private.accept_trip(uuid) to authenticated;
create function public.accept_trip(trip uuid) returns public.trips
language sql security invoker set search_path = ''
as $$ select private.accept_trip(trip); $$;
revoke all on function public.accept_trip(uuid) from public, anon, authenticated;
grant execute on function public.accept_trip(uuid) to authenticated;

create function private.transition_trip(trip uuid, next_status text, reason text)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.trips; role text; me uuid;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select id into me from public.drivers where user_id = caller;
  select * into row from public.trips where id = trip for update;
  if row.id is null then raise exception 'Trip not found' using errcode = 'P0002'; end if;
  if row.passenger_id = caller then role := 'passenger';
  elsif me is not null and row.driver_id = me then role := 'driver';
  else raise exception 'That trip belongs to another account' using errcode = '42501';
  end if;
  if not exists (select 1 from private.trip_transitions t
    where t.from_status = row.status and t.to_status = next_status and t.actor_role = role) then
    raise exception 'Transition not allowed' using errcode = '42501';
  end if;
  update public.trips set status = next_status,
    cancel_reason = case when next_status = 'canceled' then left(coalesce(reason, ''), 200) else cancel_reason end
    where id = row.id returning * into row;
  insert into public.trip_events (trip_id, from_status, to_status, actor_id, actor_role, note)
    values (row.id, null, next_status, caller, role, left(coalesce(reason, ''), 200));
  return row;
end;
$$;
revoke all on function private.transition_trip(uuid, text, text) from public, anon, authenticated;
grant execute on function private.transition_trip(uuid, text, text) to authenticated;
create function public.transition_trip(trip uuid, next_status text, reason text default '')
returns public.trips language sql security invoker set search_path = ''
as $$ select private.transition_trip(trip, next_status, reason); $$;
revoke all on function public.transition_trip(uuid, text, text) from public, anon, authenticated;
grant execute on function public.transition_trip(uuid, text, text) to authenticated;

-- Datos del móvil asignado que sí necesita el pasajero, sin exponer la tabla.
create type public.assigned_driver as (
  id uuid, display_name text, mobile_number text, vehicle text, plate text, phone text
);
create function private.trip_driver(trip uuid) returns public.assigned_driver
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); row public.assigned_driver;
begin
  select d.id, d.display_name, d.mobile_number, d.vehicle, d.plate, d.phone into row
    from public.trips t join public.drivers d on d.id = t.driver_id
    where t.id = trip and t.passenger_id = caller;
  return row;
end;
$$;
revoke all on function private.trip_driver(uuid) from public, anon, authenticated;
grant execute on function private.trip_driver(uuid) to authenticated;
create function public.trip_driver(trip uuid) returns public.assigned_driver
language sql security invoker set search_path = ''
as $$ select private.trip_driver(trip); $$;
revoke all on function public.trip_driver(uuid) from public, anon, authenticated;
grant execute on function public.trip_driver(uuid) to authenticated;

-- ───────────────── revisión administrativa ─────────────────
create type public.admin_overview as (generated_at timestamptz, businesses jsonb, drivers jsonb, orders jsonb, trips jsonb);
create function private.admin_snapshot() returns public.admin_overview
language plpgsql security definer set search_path = '' as $$
declare row public.admin_overview;
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  select now(),
    (select coalesce(jsonb_object_agg(status, total), '{}'::jsonb) from
      (select status, count(*) as total from public.businesses group by status) s),
    (select coalesce(jsonb_object_agg(status, total), '{}'::jsonb) from
      (select status, count(*) as total from public.drivers group by status) s),
    (select jsonb_build_object('total', count(*), 'byStatus',
        coalesce(jsonb_object_agg(status, total) filter (where status is not null), '{}'::jsonb))
      from (select status, count(*) as total from public.orders group by status) s),
    (select jsonb_build_object('total', count(*), 'byStatus',
        coalesce(jsonb_object_agg(status, total) filter (where status is not null), '{}'::jsonb))
      from (select status, count(*) as total from public.trips group by status) s)
  into row;
  return row;
end;
$$;
revoke all on function private.admin_snapshot() from public, anon, authenticated;
grant execute on function private.admin_snapshot() to authenticated;
create function public.admin_snapshot() returns public.admin_overview
language sql security invoker set search_path = ''
as $$ select private.admin_snapshot(); $$;
revoke all on function public.admin_snapshot() from public, anon, authenticated;
grant execute on function public.admin_snapshot() to authenticated;

-- Cola administrativa de conductores: la tabla sólo la lee su titular.
create function private.admin_drivers() returns setof public.drivers
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return query select * from public.drivers order by created_at;
end;
$$;
revoke all on function private.admin_drivers() from public, anon, authenticated;
grant execute on function private.admin_drivers() to authenticated;
create function public.admin_drivers() returns setof public.drivers
language sql security invoker set search_path = ''
as $$ select * from private.admin_drivers(); $$;
revoke all on function public.admin_drivers() from public, anon, authenticated;
grant execute on function public.admin_drivers() to authenticated;

-- ───────────────── índices que faltaban para claves foráneas ─────────────────
create index business_review_events_actor on public.business_review_events(actor_id);
create index businesses_category on public.businesses(category_id);
create index products_category on public.products(category_id, business_id);
create index products_scope on public.products(business_id, locality_id);
create index product_variants_scope on public.product_variants(product_id, business_id);
create index order_items_product on public.order_items(product_id);
create index order_items_variant on public.order_items(variant_id);
create index order_events_actor on public.order_events(actor_id);
create index trip_events_actor on public.trip_events(actor_id);

commit;
