-- CAUCE · Ferias — pedidos a un solo vendedor, con retiro en feria, retiro
-- acordado o envío propio. Reutiliza el modelo de CAUCE · Aluminé: el servidor
-- resuelve precios, stock, envío y total; idempotencia durable; total
-- confirmado; máquina de estados por rol; historial. Pagos en efectivo o
-- transferencia coordinada con el vendedor: nunca se confirman solos.
begin;

-- Códigos propios: U0001 versión vencida, U0002 intento repetido con otros
-- datos, U0003 sin stock, U0005 precios cambiados, U0006 demasiados pedidos
-- pendientes, U0010 límite del plan.

create sequence private.order_code_seq;
create function private.next_code(prefix text, seq regclass) returns text
language sql security definer set search_path = '' as $$
  select prefix || '-' || case when n < 10000 then lpad(n::text, 4, '0') else n::text end
  from (select nextval(seq) as n) s;
$$;
revoke all on function private.next_code(text, regclass) from public, anon, authenticated;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  business_id uuid not null references public.businesses(id) on delete restrict,
  customer_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  fulfillment text not null check (fulfillment in ('fair_pickup', 'pickup', 'delivery')),
  fair_id uuid references public.fairs(id) on delete restrict,
  -- Copia de lo que vio quien compró: la feria puede editarse después.
  pickup_fair_name text not null default '' check (length(pickup_fair_name) <= 100),
  pickup_venue text not null default '' check (length(pickup_venue) <= 120),
  pickup_stall text not null default '' check (length(pickup_stall) <= 12),
  pickup_starts_at timestamptz,
  payment_method text not null check (payment_method in ('cash', 'transfer')),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid')),
  paid_at timestamptz,
  status text not null default 'submitted' check (status in
    ('submitted', 'accepted', 'preparing', 'ready', 'on_the_way', 'delivered', 'canceled')),
  contact_name text not null check (length(btrim(contact_name)) between 2 and 80),
  contact_phone text not null check (length(btrim(contact_phone)) between 6 and 24),
  contact_email text not null default '' check (length(contact_email) <= 120),
  address text not null default '' check (length(address) <= 200),
  notes text not null default '' check (length(notes) <= 280),
  subtotal_ars bigint not null check (subtotal_ars > 0),
  delivery_fee_ars bigint not null default 0 check (delivery_fee_ars >= 0),
  delivery_fee_pending boolean not null default false,
  total_ars bigint not null check (total_ars > 0),
  currency text not null default 'ARS' check (currency = 'ARS'),
  tracking_token uuid not null default gen_random_uuid(),
  version integer not null default 1 check (version > 0),
  cancel_reason text not null default '' check (length(cancel_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_total_matches check (total_ars = subtotal_ars + delivery_fee_ars),
  constraint orders_delivery_needs_address check (fulfillment <> 'delivery' or length(btrim(address)) >= 5),
  constraint orders_fee_only_for_delivery check (fulfillment = 'delivery' or (delivery_fee_ars = 0 and not delivery_fee_pending)),
  constraint orders_fair_pickup_has_fair check ((fulfillment = 'fair_pickup') = (fair_id is not null)),
  constraint orders_paid_has_date check ((payment_status = 'paid') = (paid_at is not null)),
  unique (customer_id, business_id, idempotency_key),
  unique (id, business_id),
  unique (id, customer_id)
);
create unique index orders_tracking_token on public.orders(tracking_token);
create index orders_business_feed on public.orders(business_id, created_at desc);
create index orders_business_active on public.orders(business_id, created_at desc)
  where status not in ('delivered', 'canceled');
create index orders_customer_feed on public.orders(customer_id, created_at desc);
create index orders_fair on public.orders(fair_id, business_id) where fair_id is not null;

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
  made_to_order boolean not null default false,
  unit_price_ars bigint not null check (unit_price_ars > 0),
  quantity integer not null check (quantity between 1 and 99),
  total_ars bigint not null check (total_ars > 0),
  position smallint not null default 0,
  constraint order_items_total_matches check (total_ars = unit_price_ars * quantity),
  constraint order_items_business_scope foreign key (order_id, business_id)
    references public.orders(id, business_id) on delete cascade,
  constraint order_items_customer_scope foreign key (order_id, customer_id)
    references public.orders(id, customer_id) on delete cascade
);
create index order_items_order on public.order_items(order_id, position);
create index order_items_product on public.order_items(product_id) where product_id is not null;

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
  constraint order_events_business_scope foreign key (order_id, business_id)
    references public.orders(id, business_id) on delete cascade,
  constraint order_events_customer_scope foreign key (order_id, customer_id)
    references public.orders(id, customer_id) on delete cascade
);
create index order_events_order on public.order_events(order_id, created_at);

-- Tabla de transiciones: refleja js/core/order-status.js.
create table private.order_transitions (
  from_status text not null,
  to_status text not null,
  actor_role text not null,
  fulfillment text,
  primary key (from_status, to_status, actor_role, fulfillment)
);
insert into private.order_transitions (from_status, to_status, actor_role, fulfillment) values
  ('submitted', 'canceled', 'customer', 'fair_pickup'),
  ('submitted', 'canceled', 'customer', 'pickup'),
  ('submitted', 'canceled', 'customer', 'delivery'),
  ('submitted', 'accepted', 'merchant', 'fair_pickup'),
  ('submitted', 'accepted', 'merchant', 'pickup'),
  ('submitted', 'accepted', 'merchant', 'delivery'),
  ('accepted', 'preparing', 'merchant', 'fair_pickup'),
  ('accepted', 'preparing', 'merchant', 'pickup'),
  ('accepted', 'preparing', 'merchant', 'delivery'),
  ('accepted', 'ready', 'merchant', 'fair_pickup'),
  ('accepted', 'ready', 'merchant', 'pickup'),
  ('accepted', 'ready', 'merchant', 'delivery'),
  ('preparing', 'ready', 'merchant', 'fair_pickup'),
  ('preparing', 'ready', 'merchant', 'pickup'),
  ('preparing', 'ready', 'merchant', 'delivery'),
  ('ready', 'delivered', 'merchant', 'fair_pickup'),
  ('ready', 'delivered', 'merchant', 'pickup'),
  ('ready', 'on_the_way', 'merchant', 'delivery'),
  ('on_the_way', 'delivered', 'merchant', 'delivery'),
  ('submitted', 'canceled', 'merchant', 'fair_pickup'),
  ('submitted', 'canceled', 'merchant', 'pickup'),
  ('submitted', 'canceled', 'merchant', 'delivery'),
  ('accepted', 'canceled', 'merchant', 'fair_pickup'),
  ('accepted', 'canceled', 'merchant', 'pickup'),
  ('accepted', 'canceled', 'merchant', 'delivery'),
  ('preparing', 'canceled', 'merchant', 'fair_pickup'),
  ('preparing', 'canceled', 'merchant', 'pickup'),
  ('preparing', 'canceled', 'merchant', 'delivery'),
  ('ready', 'canceled', 'merchant', 'fair_pickup'),
  ('ready', 'canceled', 'merchant', 'pickup'),
  ('ready', 'canceled', 'merchant', 'delivery'),
  ('on_the_way', 'canceled', 'merchant', 'delivery');
alter table private.order_transitions enable row level security;
revoke all on private.order_transitions from public, anon, authenticated;
create policy order_transitions_no_client on private.order_transitions for all to anon, authenticated
using (false) with check (false);

-- ───────────────── privilegios ─────────────────
-- Pedidos sin escritura directa: lectura acotada y RPC.
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;
revoke all on public.orders, public.order_items, public.order_events from public, anon, authenticated;
grant select on public.orders, public.order_items, public.order_events to authenticated;

create policy orders_read on public.orders for select to authenticated
using (customer_id = (select auth.uid())
  or private.is_business_member(business_id, array['owner', 'manager', 'staff']));
create policy order_items_read on public.order_items for select to authenticated
using (customer_id = (select auth.uid())
  or private.is_business_member(business_id, array['owner', 'manager', 'staff']));
create policy order_events_read on public.order_events for select to authenticated
using (customer_id = (select auth.uid())
  or private.is_business_member(business_id, array['owner', 'manager', 'staff']));

-- ───────────────── creación ─────────────────
create function private.create_order(business uuid, idem uuid, fulfillment text, payment_method text,
  fair uuid, contact jsonb, items jsonb, expected_total bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  anonymous boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  fingerprint text;
  existing public.orders;
  shop public.businesses;
  rights jsonb;
  chosen_fair public.fairs;
  participation public.fair_participations;
  item jsonb;
  product public.products;
  variant public.product_variants;
  unit bigint;
  line_total bigint;
  subtotal bigint := 0;
  fee bigint := 0;
  fee_pending boolean := false;
  new_order uuid;
  contact_name text;
  contact_phone text;
  contact_email text;
  address text;
  notes text;
  quantity integer;
  cover text;
  position smallint := 0;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if anonymous and not private.feature_enabled('guest_checkout') then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if fulfillment is null or fulfillment not in ('fair_pickup', 'pickup', 'delivery') then
    raise exception 'Invalid fulfillment' using errcode = '23514';
  end if;
  if payment_method is null or payment_method not in ('cash', 'transfer') then
    raise exception 'Payment method not available' using errcode = '23514';
  end if;
  if contact is null or jsonb_typeof(contact) <> 'object' then
    raise exception 'Invalid contact name' using errcode = '23514';
  end if;
  contact_name := btrim(coalesce(contact ->> 'name', ''));
  contact_phone := btrim(coalesce(contact ->> 'phone', ''));
  contact_email := lower(btrim(coalesce(contact ->> 'email', '')));
  address := btrim(coalesce(contact ->> 'address', ''));
  notes := left(btrim(coalesce(contact ->> 'notes', '')), 280);
  if fulfillment <> 'delivery' then address := ''; end if;
  if fulfillment <> 'fair_pickup' then fair := null; end if;
  if length(contact_name) not between 2 and 80 then
    raise exception 'Invalid contact name' using errcode = '23514';
  end if;
  if length(contact_phone) not between 6 and 24 or contact_phone !~ '^[0-9 +()-]+$' then
    raise exception 'Invalid contact phone' using errcode = '23514';
  end if;
  if contact_email <> '' and (length(contact_email) > 120 or contact_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'Invalid contact email' using errcode = '23514';
  end if;
  if fulfillment = 'delivery' and length(address) not between 5 and 200 then
    raise exception 'Address required' using errcode = '23514';
  end if;
  if fulfillment = 'fair_pickup' and fair is null then
    raise exception 'Choose a fair' using errcode = '23514';
  end if;

  -- Repetir el mismo intento devuelve el mismo pedido.
  fingerprint := md5(jsonb_build_object('fulfillment', fulfillment, 'payment_method', payment_method,
    'fair', fair, 'name', contact_name, 'phone', contact_phone, 'email', contact_email,
    'address', address, 'notes', notes, 'items', items)::text);
  select * into existing from public.orders o
    where o.customer_id = caller and o.business_id = business and o.idempotency_key = idem;
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

  select * into shop from public.businesses b where b.id = business;
  if shop.id is null or shop.status <> 'active' then
    raise exception 'Business not available' using errcode = '23514';
  end if;
  if not private.business_can_sell(business) then
    raise exception 'Business not taking orders' using errcode = '23514';
  end if;
  rights := private.business_entitlements(business);
  if fulfillment = 'pickup' and not shop.pickup_enabled then
    raise exception 'Pickup not available' using errcode = '23514';
  end if;
  if fulfillment = 'delivery' and not shop.delivery_enabled then
    raise exception 'Delivery not available' using errcode = '23514';
  end if;
  if fulfillment = 'fair_pickup' then
    if not shop.fair_pickup_enabled or not coalesce((rights ->> 'fair_pickup')::boolean, false) then
      raise exception 'Fair pickup not available' using errcode = '23514';
    end if;
    select * into chosen_fair from public.fairs f where f.id = fair;
    select * into participation from public.fair_participations p
      where p.fair_id = fair and p.business_id = business and p.status = 'confirmed';
    if chosen_fair.id is null or chosen_fair.status <> 'published' or chosen_fair.ends_at <= now()
       or participation.id is null then
      raise exception 'Fair pickup not available' using errcode = '23514';
    end if;
  end if;
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0
     or jsonb_array_length(items) > 50 then
    raise exception 'Empty cart' using errcode = '23514';
  end if;

  new_order := gen_random_uuid();
  insert into public.orders (id, code, business_id, customer_id, idempotency_key, request_fingerprint,
    fulfillment, fair_id, pickup_fair_name, pickup_venue, pickup_stall, pickup_starts_at, payment_method,
    contact_name, contact_phone, contact_email, address, notes, subtotal_ars, delivery_fee_ars, total_ars)
  values (new_order, private.next_code('FN', 'private.order_code_seq'), business, caller, idem, fingerprint,
    fulfillment, fair, coalesce(chosen_fair.name, ''), coalesce(chosen_fair.venue, ''),
    coalesce(participation.stall_code, ''), chosen_fair.starts_at, payment_method,
    contact_name, contact_phone, contact_email, address, notes, 1, 0, 1);

  for item in select * from jsonb_array_elements(items) loop
    if jsonb_typeof(item) <> 'object'
       or coalesce(item ->> 'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(item ->> 'quantity', '') !~ '^[0-9]{1,3}$'
       or (coalesce(item ->> 'variant_id', '') <> ''
           and (item ->> 'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'Invalid quantity' using errcode = '23514';
    end if;
    quantity := (item ->> 'quantity')::int;
    if quantity < 1 or quantity > 99 then raise exception 'Invalid quantity' using errcode = '23514'; end if;
    -- El bloqueo de fila hace que dos pedidos simultáneos no vendan la misma unidad.
    select * into product from public.products p
      where p.id = (item ->> 'product_id')::uuid and p.business_id = business for update;
    if product.id is null or product.archived or not product.available then
      raise exception 'Product not available' using errcode = '23514';
    end if;
    variant := null;
    if coalesce(item ->> 'variant_id', '') <> '' then
      select * into variant from public.product_variants v
        where v.id = (item ->> 'variant_id')::uuid and v.product_id = product.id and v.active for update;
      if variant.id is null then raise exception 'Variant not available' using errcode = '23514'; end if;
    elsif exists (select 1 from public.product_variants v where v.product_id = product.id and v.active) then
      raise exception 'Variant required' using errcode = '23514';
    end if;
    -- Las filas se releen bloqueadas: el stock ya descuenta las líneas anteriores.
    if product.track_stock then
      if variant.id is not null then
        if variant.stock < quantity then raise exception 'Not enough stock' using errcode = 'U0003'; end if;
        update public.product_variants set stock = stock - quantity where id = variant.id;
      else
        if product.stock < quantity then raise exception 'Not enough stock' using errcode = 'U0003'; end if;
        update public.products set stock = stock - quantity where id = product.id;
      end if;
    end if;
    unit := product.price_ars + coalesce(variant.price_delta_ars, 0);
    if unit <= 0 then raise exception 'Invalid price' using errcode = '23514'; end if;
    line_total := unit * quantity;
    subtotal := subtotal + line_total;
    position := position + 1;
    select i.path into cover from public.product_images i where i.product_id = product.id
      order by i.position, i.created_at limit 1;
    insert into public.order_items (order_id, business_id, customer_id, product_id, variant_id, product_name,
      variant_name, image_path, made_to_order, unit_price_ars, quantity, total_ars, position)
    values (new_order, business, caller, product.id, variant.id, product.name, coalesce(variant.name, ''),
      cover, product.made_to_order, unit, quantity, line_total, position);
  end loop;

  if fulfillment = 'delivery' then
    if subtotal < shop.minimum_order_ars then
      raise exception 'Minimum order not reached' using errcode = '23514';
    end if;
    if shop.delivery_fee_ars is null then fee_pending := true; else fee := shop.delivery_fee_ars; end if;
  end if;
  if expected_total is not null and expected_total <> subtotal + fee then
    raise exception 'Prices changed' using errcode = 'U0005', detail = (subtotal + fee)::text;
  end if;
  update public.orders set subtotal_ars = subtotal, delivery_fee_ars = fee, delivery_fee_pending = fee_pending,
    total_ars = subtotal + fee where id = new_order;
  insert into public.order_events (order_id, business_id, customer_id, to_status, actor_id, actor_role)
    values (new_order, business, caller, 'submitted', caller, 'customer');
  return new_order;
exception when unique_violation then
  -- Carrera con un envío simultáneo del mismo intento: gana la primera fila.
  select * into existing from public.orders o
    where o.customer_id = caller and o.business_id = business and o.idempotency_key = idem;
  if existing.id is null then raise; end if;
  if existing.request_fingerprint <> fingerprint then
    raise exception 'Repeated attempt with different data' using errcode = 'U0002';
  end if;
  return existing.id;
end;
$$;
revoke all on function private.create_order(uuid, uuid, text, text, uuid, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function private.create_order(uuid, uuid, text, text, uuid, jsonb, jsonb, bigint) to authenticated;
create function public.create_order(business uuid, idem uuid, fulfillment text, payment_method text,
  fair uuid default null, contact jsonb default '{}'::jsonb, items jsonb default '[]'::jsonb,
  expected_total bigint default null) returns uuid
language sql security invoker set search_path = ''
as $$ select private.create_order(business, idem, fulfillment, payment_method, fair, contact, items, expected_total); $$;
revoke all on function public.create_order(uuid, uuid, text, text, uuid, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, text, text, uuid, jsonb, jsonb, bigint) to authenticated;

-- ───────────────── transiciones ─────────────────
create function private.transition_order(order_id uuid, expected_version integer, next_status text, reason text)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  row public.orders;
  previous text;
  role text;
  note text := left(btrim(coalesce(reason, '')), 200);
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into row from public.orders o where o.id = order_id for update;
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
      and t.fulfillment = row.fulfillment) then
    raise exception 'Transition not allowed' using errcode = '42501';
  end if;
  if next_status = 'canceled' and role = 'merchant' and length(note) < 3 then
    raise exception 'Reason required' using errcode = '23514';
  end if;
  if next_status = 'canceled' then
    -- Devuelve las unidades reservadas, donde se controla stock.
    update public.product_variants v set stock = least(v.stock + back.total, 10000)
      from (select i.variant_id, sum(i.quantity)::int as total from public.order_items i
        where i.order_id = row.id and i.variant_id is not null group by i.variant_id) back
      where back.variant_id = v.id
        and exists (select 1 from public.products p where p.id = v.product_id and p.track_stock);
    update public.products p set stock = least(p.stock + back.total, 10000)
      from (select i.product_id, sum(i.quantity)::int as total from public.order_items i
        where i.order_id = row.id and i.product_id is not null and i.variant_id is null group by i.product_id) back
      where back.product_id = p.id and p.track_stock;
  end if;
  previous := row.status;
  update public.orders set status = next_status, version = version + 1, updated_at = now(),
    cancel_reason = case when next_status = 'canceled' then note else cancel_reason end
    where id = row.id returning * into row;
  insert into public.order_events (order_id, business_id, customer_id, from_status, to_status, actor_id, actor_role, note)
    values (row.id, row.business_id, row.customer_id, previous, next_status, caller, role, note);
  return row;
end;
$$;
revoke all on function private.transition_order(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function private.transition_order(uuid, integer, text, text) to authenticated;
create function public.transition_order(order_id uuid, expected_version integer, next_status text,
  reason text default '') returns public.orders
language sql security invoker set search_path = ''
as $$ select * from private.transition_order(order_id, expected_version, next_status, reason); $$;
revoke all on function public.transition_order(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.transition_order(uuid, integer, text, text) to authenticated;

-- El cobro lo registra el comercio a mano: efectivo recibido o transferencia
-- verificada en su cuenta. Se puede corregir si se marcó por error.
create function private.set_order_payment(order_id uuid, expected_version integer, paid boolean)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare row public.orders; caller uuid := (select auth.uid());
begin
  select * into row from public.orders o where o.id = order_id for update;
  if row.id is null then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if not private.is_business_member(row.business_id, array['owner', 'manager', 'staff']) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  if expected_version is not null and row.version <> expected_version then
    raise exception 'The order changed while you were looking at it' using errcode = 'U0001';
  end if;
  if row.status = 'canceled' and paid then raise exception 'Order canceled' using errcode = '23514'; end if;
  if paid is null or (paid and row.payment_status = 'paid') or (not paid and row.payment_status = 'pending') then
    return row;
  end if;
  update public.orders set payment_status = case when paid then 'paid' else 'pending' end,
    paid_at = case when paid then now() end, version = version + 1, updated_at = now()
    where id = row.id returning * into row;
  insert into public.order_events (order_id, business_id, customer_id, from_status, to_status, actor_id, actor_role, note)
    values (row.id, row.business_id, row.customer_id, row.status, row.status, caller, 'merchant',
      case when paid then 'Pago registrado por el comercio' else 'Pago marcado como pendiente' end);
  return row;
end;
$$;
revoke all on function private.set_order_payment(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function private.set_order_payment(uuid, integer, boolean) to authenticated;
create function public.set_order_payment(order_id uuid, expected_version integer, paid boolean)
returns public.orders language sql security invoker set search_path = ''
as $$ select * from private.set_order_payment(order_id, expected_version, paid); $$;
revoke all on function public.set_order_payment(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.set_order_payment(uuid, integer, boolean) to authenticated;

-- ───────────────── seguimiento por enlace ─────────────────
-- Quien tiene el enlace (token secreto) ve el estado; nunca el teléfono ni el
-- correo de quien compró.
create function private.track_order(token uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; b public.businesses; f public.fairs;
begin
  if token is null then return null; end if;
  select * into o from public.orders where tracking_token = token;
  if o.id is null then return null; end if;
  select * into b from public.businesses where id = o.business_id;
  if o.fair_id is not null then select * into f from public.fairs where id = o.fair_id; end if;
  return jsonb_build_object(
    'id', o.id, 'code', o.code, 'status', o.status, 'fulfillment', o.fulfillment,
    'payment_method', o.payment_method, 'payment_status', o.payment_status,
    'address', o.address, 'contact_name', o.contact_name,
    'subtotal_ars', o.subtotal_ars, 'delivery_fee_ars', o.delivery_fee_ars,
    'delivery_fee_pending', o.delivery_fee_pending, 'total_ars', o.total_ars,
    'cancel_reason', o.cancel_reason, 'created_at', o.created_at, 'updated_at', o.updated_at,
    'pickup', case when o.fulfillment = 'fair_pickup' then jsonb_build_object('fair_name', o.pickup_fair_name,
      'venue', o.pickup_venue, 'stall', coalesce((select p.stall_code from public.fair_participations p
        where p.fair_id = o.fair_id and p.business_id = o.business_id and p.status = 'confirmed'), o.pickup_stall),
      'starts_at', coalesce(f.starts_at, o.pickup_starts_at), 'ends_at', f.ends_at, 'address', f.address,
      'latitude', f.latitude, 'longitude', f.longitude, 'slug', f.slug, 'fair_status', f.status)
      when o.fulfillment = 'pickup' then jsonb_build_object('area', b.pickup_area) end,
    'business', jsonb_build_object('id', b.id, 'name', b.name, 'slug', b.slug, 'logo_path', b.logo_path,
      'public_phone', b.public_phone, 'whatsapp', b.whatsapp),
    'items', coalesce((select jsonb_agg(jsonb_build_object('product_name', i.product_name,
        'variant_name', i.variant_name, 'image_path', i.image_path, 'quantity', i.quantity,
        'made_to_order', i.made_to_order, 'unit_price_ars', i.unit_price_ars, 'total_ars', i.total_ars)
        order by i.position) from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('status', e.to_status, 'at', e.created_at, 'note',
        case when e.from_status = e.to_status then e.note else '' end) order by e.created_at, e.id)
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

-- ───────────────── estadísticas del comercio ─────────────────
-- Básicas para todos los planes; ampliadas (más vendidos, por feria) en Pro.
create function private.business_stats(business uuid, days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  since timestamptz := now() - make_interval(days => least(greatest(coalesce(days, 30), 1), 365));
  advanced boolean;
  result jsonb;
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  advanced := coalesce((private.business_entitlements(business) ->> 'advanced_stats')::boolean, false);
  select jsonb_build_object(
    'days', least(greatest(coalesce(days, 30), 1), 365),
    'orders', count(*),
    'delivered', count(*) filter (where status = 'delivered'),
    'canceled', count(*) filter (where status = 'canceled'),
    'open', count(*) filter (where status not in ('delivered', 'canceled')),
    'sales_ars', coalesce(sum(total_ars) filter (where status = 'delivered'), 0),
    'paid_ars', coalesce(sum(total_ars) filter (where payment_status = 'paid'), 0),
    'pending_payment_ars', coalesce(sum(total_ars) filter (where payment_status = 'pending' and status <> 'canceled'), 0),
    'average_ars', coalesce(round(avg(total_ars) filter (where status = 'delivered')), 0),
    'by_fulfillment', jsonb_build_object(
      'fair_pickup', count(*) filter (where fulfillment = 'fair_pickup' and status <> 'canceled'),
      'pickup', count(*) filter (where fulfillment = 'pickup' and status <> 'canceled'),
      'delivery', count(*) filter (where fulfillment = 'delivery' and status <> 'canceled')),
    'advanced', advanced)
  into result
  from public.orders where business_id = business and created_at >= since;
  result := result || jsonb_build_object('daily', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'orders', d.n,
      'sales_ars', d.sales) order by d.day) from (
        select (o.created_at at time zone 'America/Argentina/Salta')::date as day, count(*) as n,
          coalesce(sum(o.total_ars) filter (where o.status = 'delivered'), 0) as sales
        from public.orders o where o.business_id = business and o.created_at >= since and o.status <> 'canceled'
        group by 1) d), '[]'::jsonb));
  if advanced then
    result := result || jsonb_build_object(
      'top_products', coalesce((select jsonb_agg(t order by t.units desc, t.name) from (
        select i.product_name as name, sum(i.quantity)::int as units, sum(i.total_ars) as sales_ars
        from public.order_items i join public.orders o on o.id = i.order_id
        where o.business_id = business and o.created_at >= since and o.status <> 'canceled'
        group by i.product_name order by units desc limit 5) t), '[]'::jsonb),
      'by_fair', coalesce((select jsonb_agg(t order by t.orders desc) from (
        select o.pickup_fair_name as fair, count(*)::int as orders, sum(o.total_ars) as total_ars
        from public.orders o where o.business_id = business and o.created_at >= since
          and o.fulfillment = 'fair_pickup' and o.status <> 'canceled'
        group by o.pickup_fair_name limit 10) t), '[]'::jsonb));
  end if;
  return result;
end;
$$;
revoke all on function private.business_stats(uuid, integer) from public, anon, authenticated;
grant execute on function private.business_stats(uuid, integer) to authenticated;
create function public.business_stats(business uuid, days integer default 30) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.business_stats(business, days); $$;
revoke all on function public.business_stats(uuid, integer) from public, anon, authenticated;
grant execute on function public.business_stats(uuid, integer) to authenticated;

-- Métricas de la feria para quien la organiza: sin importes de cada comercio.
create function private.fair_stats(fair uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f public.fairs;
begin
  if not private.is_fair_organizer(fair) and not private.is_admin() then
    raise exception 'Not allowed for this organizer' using errcode = '42501';
  end if;
  select * into f from public.fairs where id = fair;
  return jsonb_build_object(
    'requested', (select count(*) from public.fair_participations p where p.fair_id = fair and p.status = 'requested'),
    'confirmed', (select count(*) from public.fair_participations p where p.fair_id = fair and p.status = 'confirmed'),
    'rejected', (select count(*) from public.fair_participations p where p.fair_id = fair and p.status = 'rejected'),
    'withdrawn', (select count(*) from public.fair_participations p where p.fair_id = fair and p.status = 'withdrawn'),
    'stalls_assigned', (select count(*) from public.fair_participations p where p.fair_id = fair
      and p.status = 'confirmed' and p.stall_code is not null),
    'capacity', f.stall_capacity,
    'pickup_orders', (select count(*) from public.orders o where o.fair_id = fair and o.status <> 'canceled'),
    'announcements', (select count(*) from public.fair_announcements a where a.fair_id = fair));
end;
$$;
revoke all on function private.fair_stats(uuid) from public, anon, authenticated;
grant execute on function private.fair_stats(uuid) to authenticated;
create function public.fair_stats(fair uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.fair_stats(fair); $$;
revoke all on function public.fair_stats(uuid) from public, anon, authenticated;
grant execute on function public.fair_stats(uuid) to authenticated;

-- Realtime: el panel del comercio y quien compró reciben los cambios que RLS
-- les deja leer.
alter publication supabase_realtime add table public.orders;

commit;
