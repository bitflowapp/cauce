-- CAUCE: pagos online preparados, sin cobrar.
--
-- Qué cambia y por qué:
--   · Un modelo de pagos neutral, separado del pedido y de cualquier proveedor:
--       - la cuenta del proveedor de cada comercio (sin tokens);
--       - las credenciales, cifradas y sólo del lado del servidor;
--       - los intentos de pago, cada uno con su clave de idempotencia estable;
--       - los movimientos que informa el proveedor (pagos, devoluciones);
--       - una bandeja de eventos (webhooks) idempotente.
--   · Estados de pago internos y neutrales. El pedido conserva su estado y suma
--     el del pago; el efectivo no cambia (`pending_on_delivery` → `settled`).
--   · Interruptor `payments_online` APAGADO: ningún comercio ofrece pago online
--     y la base rechaza un pedido online aunque el cliente lo pida.
--   · Nada llama a Mercado Pago desde acá. Hablar con el proveedor (OAuth,
--     crear la orden, recibir webhooks) es trabajo de las Edge Functions, con
--     el rol de servicio, que ningún cliente tiene.
begin;

-- ───────────────── rol de servicio ─────────────────
-- Las Edge Functions usan service_role. Sólo ejecuta las funciones de pagos
-- que se le conceden abajo: no recibe permisos sobre las tablas privadas.
grant usage on schema private to service_role;

-- ───────────────── interruptor ─────────────────
insert into private.platform_features (key, enabled) values ('payments_online', false)
  on conflict (key) do nothing;

-- ───────────────── proveedores ─────────────────
-- Registro de proveedores: el resto del modelo no nombra a ninguno.
create table private.payment_providers (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  label text not null check (length(label) between 2 and 40),
  flows text[] not null default '{}'
    check (flows <@ array['checkout_pro', 'checkout_api']::text[])
);
alter table private.payment_providers enable row level security;
revoke all on private.payment_providers from public, anon, authenticated;
create policy payment_providers_no_client_access on private.payment_providers
for all to anon, authenticated using (false) with check (false);
insert into private.payment_providers (key, label, flows) values
  ('mercadopago', 'Mercado Pago', array['checkout_pro', 'checkout_api']);

-- ───────────────── estados de pago ─────────────────
-- Estados neutrales de un intento de pago. `not_required` no existe en la base:
-- es la vista neutral de un pedido en efectivo (no hay pago online que esperar).
create table private.payment_status_transitions (
  from_status text not null,
  to_status text not null,
  primary key (from_status, to_status)
);
alter table private.payment_status_transitions enable row level security;
revoke all on private.payment_status_transitions from public, anon, authenticated;
create policy payment_status_transitions_no_client_access on private.payment_status_transitions
for all to anon, authenticated using (false) with check (false);
insert into private.payment_status_transitions (from_status, to_status) values
  ('pending', 'processing'),
  ('pending', 'approved'),
  ('pending', 'rejected'),
  ('pending', 'cancelled'),
  ('pending', 'expired'),
  ('processing', 'approved'),
  ('processing', 'rejected'),
  ('processing', 'cancelled'),
  ('processing', 'expired'),
  ('approved', 'refunded'),
  ('approved', 'partially_refunded'),
  ('partially_refunded', 'refunded');

-- ───────────────── pedidos: forma y estado del pago ─────────────────
-- `online` es neutral: el proveedor queda en el intento de pago, no en el pedido.
alter table public.orders drop constraint orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method in ('cash_on_delivery', 'cash_on_pickup', 'online'));
alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('pending_on_delivery', 'settled', 'pending', 'processing', 'approved',
    'rejected', 'cancelled', 'refunded', 'partially_refunded', 'expired'));
-- El efectivo usa sus dos estados de siempre; el pago online, los neutrales.
alter table public.orders add constraint orders_payment_status_matches_method
  check ((payment_method = 'online') = (payment_status not in ('pending_on_delivery', 'settled')));

-- ───────────────── cuentas del proveedor por comercio ─────────────────
-- Metadatos de la conexión, sin ningún secreto. La leen titular y encargado/a;
-- nadie la escribe desde el cliente.
create table public.payment_provider_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null references private.payment_providers(key),
  status text not null default 'not_connected'
    check (status in ('not_connected', 'connecting', 'connected', 'reconnect_required')),
  provider_user_id text check (provider_user_id is null or length(provider_user_id) between 1 and 64),
  scopes text[] not null default '{}',
  live_mode boolean,
  status_reason text not null default '' check (length(status_reason) <= 200),
  connected_at timestamptz,
  token_expires_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_provider_accounts_business_provider unique (business_id, provider)
);
alter table public.payment_provider_accounts enable row level security;
revoke all on public.payment_provider_accounts from public, anon, authenticated;
grant select on public.payment_provider_accounts to authenticated;
create policy payment_provider_accounts_read on public.payment_provider_accounts for select to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

-- ───────────────── credenciales: sólo el servidor ─────────────────
-- Los tokens llegan cifrados por la Edge Function (AES-GCM, con una clave que
-- nunca entra a la base). Ningún rol cliente lee ni escribe esta tabla.
create table private.payment_provider_credentials (
  account_id uuid primary key references public.payment_provider_accounts(id) on delete cascade,
  access_token_ciphertext text not null check (length(access_token_ciphertext) between 16 and 8192),
  refresh_token_ciphertext text not null default '' check (length(refresh_token_ciphertext) <= 8192),
  key_version smallint not null check (key_version > 0),
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table private.payment_provider_credentials enable row level security;
revoke all on private.payment_provider_credentials from public, anon, authenticated;
create policy payment_provider_credentials_no_client_access on private.payment_provider_credentials
for all to anon, authenticated using (false) with check (false);

-- OAuth: una conexión en curso. El `state` es de un solo uso y vence en 10 min.
create table private.payment_oauth_states (
  state text primary key check (length(state) between 32 and 128),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null references private.payment_providers(key),
  requested_by uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null check (length(code_verifier) between 43 and 128),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz
);
create index payment_oauth_states_business on private.payment_oauth_states(business_id);
alter table private.payment_oauth_states enable row level security;
revoke all on private.payment_oauth_states from public, anon, authenticated;
create policy payment_oauth_states_no_client_access on private.payment_oauth_states
for all to anon, authenticated using (false) with check (false);

-- ───────────────── intentos de pago ─────────────────
-- Un pedido existe sin intento de pago (efectivo) y puede tener varios intentos
-- (uno rechazado y otro aprobado), pero nunca dos vivos a la vez.
create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid references auth.users(id) on delete set null,
  provider text not null references private.payment_providers(key),
  flow text not null check (flow in ('checkout_pro', 'checkout_api')),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'approved', 'rejected', 'cancelled', 'refunded',
      'partially_refunded', 'expired')),
  status_detail text not null default '' check (length(status_detail) <= 80),
  amount_ars bigint not null check (amount_ars > 0),
  currency text not null default 'ARS' check (currency = 'ARS'),
  -- X-Idempotency-Key del proveedor: estable para este intento y nunca reusada.
  idempotency_key uuid not null default gen_random_uuid() unique,
  provider_order_id text check (provider_order_id is null or length(provider_order_id) between 1 and 80),
  checkout_url text check (checkout_url is null or (checkout_url ~ '^https://' and length(checkout_url) <= 600)),
  cancel_requested_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_attempts_provider_order unique (provider, provider_order_id)
);
create unique index payment_attempts_one_live on public.payment_attempts(order_id)
  where status in ('pending', 'processing');
create index payment_attempts_business on public.payment_attempts(business_id, created_at desc);
alter table public.payment_attempts enable row level security;
revoke all on public.payment_attempts from public, anon, authenticated;
grant select on public.payment_attempts to authenticated;
create policy payment_attempts_read on public.payment_attempts for select to authenticated
using (customer_id = (select auth.uid())
  or private.is_business_member(business_id, array['owner', 'manager', 'staff']));

-- ───────────────── movimientos informados por el proveedor ─────────────────
create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.payment_attempts(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null references private.payment_providers(key),
  kind text not null check (kind in ('payment', 'refund', 'chargeback')),
  provider_transaction_id text not null check (length(provider_transaction_id) between 1 and 80),
  status text not null check (status in ('pending', 'processing', 'approved', 'rejected', 'cancelled',
    'refunded', 'partially_refunded', 'expired')),
  status_detail text not null default '' check (length(status_detail) <= 80),
  amount_ars bigint not null check (amount_ars >= 0),
  method_type text not null default '' check (length(method_type) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_transactions_provider_ref unique (provider, provider_transaction_id)
);
create index payment_transactions_attempt on public.payment_transactions(attempt_id);
alter table public.payment_transactions enable row level security;
revoke all on public.payment_transactions from public, anon, authenticated;
grant select on public.payment_transactions to authenticated;
create policy payment_transactions_read on public.payment_transactions for select to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

-- ───────────────── bandeja de eventos del proveedor ─────────────────
-- Cada notificación se guarda una vez (proveedor + clave). No se guarda el
-- cuerpo: sólo lo necesario para reconciliar, sin datos del pagador.
create table private.payment_events (
  id bigint generated always as identity primary key,
  provider text not null references private.payment_providers(key),
  event_key text not null check (length(event_key) between 8 and 200),
  resource_type text not null default '' check (length(resource_type) <= 40),
  resource_id text not null default '' check (length(resource_id) <= 80),
  action text not null default '' check (length(action) <= 60),
  live_mode boolean,
  outcome text not null default 'received'
    check (outcome in ('received', 'applied', 'ignored', 'flagged', 'failed')),
  detail text not null default '' check (length(detail) <= 200),
  attempt_id uuid references public.payment_attempts(id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  -- Veces que un reintento del proveedor volvió a procesar la notificación.
  retries integer not null default 0 check (retries >= 0),
  constraint payment_events_provider_key unique (provider, event_key)
);
alter table private.payment_events enable row level security;
revoke all on private.payment_events from public, anon, authenticated;
create policy payment_events_no_client_access on private.payment_events
for all to anon, authenticated using (false) with check (false);

-- ───────────────── disponibilidad ─────────────────
-- ¿Con qué proveedor cobra online este comercio ahora? Interruptor encendido y
-- cuenta conectada; si no, null (y el pago online no existe para nadie).
create function private.online_payment_provider(business uuid) returns text
language sql stable security definer set search_path = '' as $$
  select a.provider from public.payment_provider_accounts a
  where private.feature_enabled('payments_online')
    and a.business_id = business and a.status = 'connected'
  order by a.connected_at desc nulls last, a.provider
  limit 1;
$$;
revoke all on function private.online_payment_provider(uuid) from public, anon, authenticated;

-- Formas de pago que el checkout puede ofrecer para un comercio publicado.
create function private.payment_methods(business uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  shop public.businesses;
  provider_key text;
  methods jsonb := '[]'::jsonb;
begin
  select * into shop from public.businesses where id = business and status = 'active';
  if shop.id is null then return methods; end if;
  if shop.pickup_enabled then
    methods := methods || jsonb_build_array(jsonb_build_object('id', 'cash_on_pickup', 'kind', 'cash',
      'fulfillment', 'pickup'));
  end if;
  if shop.delivery_enabled then
    methods := methods || jsonb_build_array(jsonb_build_object('id', 'cash_on_delivery', 'kind', 'cash',
      'fulfillment', 'delivery'));
  end if;
  provider_key := private.online_payment_provider(business);
  if provider_key is not null then
    methods := methods || coalesce((select jsonb_build_array(jsonb_build_object('id', 'online', 'kind', 'online',
        'provider', p.key, 'label', p.label, 'flows', to_jsonb(p.flows)))
      from private.payment_providers p where p.key = provider_key), '[]'::jsonb);
  end if;
  return methods;
end;
$$;
revoke all on function private.payment_methods(uuid) from public, anon, authenticated;
grant execute on function private.payment_methods(uuid) to anon, authenticated;
create function public.payment_methods(business uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.payment_methods(business); $$;
revoke all on function public.payment_methods(uuid) from public, anon, authenticated;
grant execute on function public.payment_methods(uuid) to anon, authenticated;

-- ───────────────── crear pedido ─────────────────
-- Igual que antes, más `online`: sólo si el comercio cobra online ahora. Un
-- pedido online nace con el pago pendiente; el efectivo, como siempre.
create or replace function private.create_order(business uuid, idem uuid, fulfillment text,
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
  if payment_method = 'online' then
    if private.online_payment_provider(business) is null then
      raise exception 'Payment method not available' using errcode = '23514';
    end if;
  elsif payment_method is distinct from (case fulfillment when 'delivery' then 'cash_on_delivery' else 'cash_on_pickup' end) then
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
    request_fingerprint, fulfillment, payment_method, payment_status, contact_name, contact_phone, address, notes,
    subtotal_ars, delivery_fee_ars, total_ars, delivery_code)
  values (new_order, private.next_code('CA', 'private.order_code_seq'), business,
    shop.locality_id, caller, idem, fingerprint, fulfillment, payment_method,
    case when payment_method = 'online' then 'pending' else 'pending_on_delivery' end,
    contact_name, contact_phone, address, notes, 1, 0, 1,
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

-- ───────────────── transiciones del pedido ─────────────────
-- Igual que antes, más tres reglas de pago:
--   · un pedido online no se acepta hasta que el pago esté aprobado;
--   · entregar liquida sólo el efectivo (el online ya tiene su estado);
--   · cancelar un pedido online pide anular el pago en el proveedor; el estado
--     del pago cambia cuando el proveedor lo confirma, no antes.
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
  -- Un pedido pagado online se prepara recién con el pago aprobado.
  if next_status = 'accepted' and row.payment_method = 'online' and row.payment_status <> 'approved' then
    raise exception 'Payment not approved' using errcode = 'U0007';
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
    -- El pago online vivo se anula en el proveedor (lo hace el servidor); si ya
    -- estaba aprobado, queda para devolver. Nada se da por anulado acá.
    if row.payment_method = 'online' then
      update public.payment_attempts set cancel_requested_at = coalesce(cancel_requested_at, now()),
        updated_at = now()
        where payment_attempts.order_id = row.id
          and status in ('pending', 'processing', 'approved', 'partially_refunded');
    end if;
  end if;
  previous := row.status;
  update public.orders set status = next_status, version = version + 1, updated_at = now(),
    rider_id = case when next_status = 'assigned' then rider else rider_id end,
    cancel_reason = case when next_status = 'canceled' then note else cancel_reason end,
    payment_status = case when next_status = 'delivered' and payment_method <> 'online' then 'settled'
      else payment_status end
    where id = row.id returning * into row;
  insert into public.order_events (order_id, business_id, customer_id, from_status, to_status,
    actor_id, actor_role, note)
    values (row.id, row.business_id, row.customer_id, previous, next_status, caller, role, note);
  return row;
end;
$$;

-- Entregar con código: igual que antes; liquida sólo el efectivo.
create or replace function private.confirm_delivery(order_id uuid, expected_version integer, code text)
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
    payment_status = case when payment_method = 'online' then payment_status else 'settled' end
    where id = row.id returning * into row;
  insert into public.order_events (order_id, business_id, customer_id, from_status, to_status,
    actor_id, actor_role, note)
    values (row.id, row.business_id, row.customer_id, previous, 'delivered', caller, 'rider',
      'Entregado con código');
  return jsonb_build_object('ok', true, 'status', row.status, 'version', row.version);
end;
$$;

-- Seguimiento público: suma el estado del pago (nada del proveedor).
create or replace function private.track_order(token uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; b public.businesses;
begin
  if token is null then return null; end if;
  select * into o from public.orders where tracking_token = token;
  if o.id is null then return null; end if;
  select * into b from public.businesses where id = o.business_id;
  return jsonb_build_object(
    'id', o.id, 'code', o.code, 'status', o.status, 'fulfillment', o.fulfillment,
    'payment_method', o.payment_method, 'payment_status', o.payment_status,
    'address', o.address, 'delivery_code', o.delivery_code,
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

-- ───────────────── pago de un pedido (cliente) ─────────────────
-- Inicia o retoma el intento de pago de un pedido online. Doble toque o
-- reintento: el mismo intento vivo, con la misma clave de idempotencia. El
-- importe sale del pedido; el cliente no manda ninguno.
create function private.start_payment(order_id uuid, flow text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  row public.orders;
  provider_key text;
  attempt public.payment_attempts;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if flow is null or flow not in ('checkout_pro', 'checkout_api') then
    raise exception 'Invalid payment flow' using errcode = '23514';
  end if;
  select * into row from public.orders where id = order_id for update;
  if row.id is null or row.customer_id is distinct from caller then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if row.payment_method <> 'online' then
    raise exception 'Payment not required' using errcode = '23514';
  end if;
  if row.status = 'canceled' then raise exception 'Order canceled' using errcode = '23514'; end if;
  if row.payment_status in ('approved', 'partially_refunded', 'refunded') then
    raise exception 'Order already paid' using errcode = '23514';
  end if;
  provider_key := private.online_payment_provider(row.business_id);
  if provider_key is null then
    raise exception 'Payment method not available' using errcode = '23514';
  end if;
  select * into attempt from public.payment_attempts a
    where a.order_id = row.id and a.status in ('pending', 'processing')
    order by a.created_at desc limit 1;
  if attempt.id is null then
    insert into public.payment_attempts (order_id, business_id, customer_id, provider, flow, amount_ars,
      expires_at)
    values (row.id, row.business_id, row.customer_id, provider_key, flow, row.total_ars,
      now() + interval '30 minutes')
    returning * into attempt;
    update public.orders set payment_status = 'pending', updated_at = now()
      where id = row.id and payment_status <> 'pending';
  end if;
  return jsonb_build_object('attempt_id', attempt.id, 'status', attempt.status, 'flow', attempt.flow,
    'provider', attempt.provider, 'amount', attempt.amount_ars, 'currency', attempt.currency,
    'checkout_url', attempt.checkout_url);
end;
$$;
revoke all on function private.start_payment(uuid, text) from public, anon, authenticated;
grant execute on function private.start_payment(uuid, text) to authenticated;
create function public.start_payment(order_id uuid, flow text default 'checkout_pro') returns jsonb
language sql security invoker set search_path = ''
as $$ select private.start_payment(order_id, flow); $$;
revoke all on function public.start_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.start_payment(uuid, text) to authenticated;

-- Estado del pago de un pedido, por pedido o por intento. Lo usan las páginas
-- de retorno: nunca deciden por la URL, preguntan acá. Sólo el cliente del
-- pedido o su comercio; para el resto, null.
create function private.payment_status(reference uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('order_id', o.id, 'code', o.code, 'order_status', o.status,
    'business_id', o.business_id, 'payment_method', o.payment_method, 'payment_status', o.payment_status,
    'total', o.total_ars, 'tracking_token', o.tracking_token,
    'attempt', (select jsonb_build_object('id', a.id, 'status', a.status, 'flow', a.flow,
        'provider', a.provider, 'checkout_url', a.checkout_url, 'updated_at', a.updated_at)
      from public.payment_attempts a where a.order_id = o.id order by a.created_at desc limit 1))
  from public.orders o
  where (o.id = reference
      or o.id = (select a.order_id from public.payment_attempts a where a.id = reference))
    and (o.customer_id = (select auth.uid())
      or private.is_business_member(o.business_id, array['owner', 'manager', 'staff']));
$$;
revoke all on function private.payment_status(uuid) from public, anon, authenticated;
grant execute on function private.payment_status(uuid) to authenticated;
create function public.payment_status(reference uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.payment_status(reference); $$;
revoke all on function public.payment_status(uuid) from public, anon, authenticated;
grant execute on function public.payment_status(uuid) to authenticated;

-- ───────────────── pagos del comercio (titular y encargado/a) ─────────────────
-- Estado de la conexión y números reales del día; sin cuenta ni pagos, ceros.
create function private.business_payment_overview(business uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  day_start timestamptz;
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  select l.timezone into tz from public.businesses b join public.localities l on l.id = b.locality_id
    where b.id = business;
  tz := coalesce(tz, 'America/Argentina/Buenos_Aires');
  day_start := date_trunc('day', now() at time zone tz) at time zone tz;
  return jsonb_build_object(
    'enabled', private.feature_enabled('payments_online'),
    'providers', coalesce((select jsonb_agg(jsonb_build_object('provider', p.key, 'label', p.label)
        order by p.key) from private.payment_providers p), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('provider', a.provider, 'status', a.status,
        'status_reason', a.status_reason, 'provider_user_id', a.provider_user_id, 'live_mode', a.live_mode,
        'scopes', to_jsonb(a.scopes), 'connected_at', a.connected_at, 'token_expires_at', a.token_expires_at,
        'last_synced_at', a.last_synced_at) order by a.provider)
      from public.payment_provider_accounts a where a.business_id = business), '[]'::jsonb),
    'today', (select jsonb_build_object(
        'approved', count(*) filter (where a.status in ('approved', 'partially_refunded')),
        'approved_ars', coalesce(sum(a.amount_ars) filter (where a.status in ('approved', 'partially_refunded')), 0),
        'pending', count(*) filter (where a.status in ('pending', 'processing')),
        'rejected', count(*) filter (where a.status = 'rejected'),
        'refunded', count(*) filter (where a.status in ('refunded', 'partially_refunded')),
        'to_refund', count(*) filter (where a.cancel_requested_at is not null
          and a.status in ('approved', 'partially_refunded')))
      from public.payment_attempts a where a.business_id = business and a.created_at >= day_start),
    -- Avisos del día que piden revisar a mano: importe distinto o pago repetido.
    'to_review', (select count(*) from private.payment_events e join public.payment_attempts a on a.id = e.attempt_id
      where a.business_id = business and e.outcome = 'flagged' and e.received_at >= day_start),
    'last_synced_at', (select max(a.last_synced_at) from public.payment_provider_accounts a
      where a.business_id = business),
    'day_start', day_start);
end;
$$;
revoke all on function private.business_payment_overview(uuid) from public, anon, authenticated;
grant execute on function private.business_payment_overview(uuid) to authenticated;
create function public.business_payment_overview(business uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.business_payment_overview(business); $$;
revoke all on function public.business_payment_overview(uuid) from public, anon, authenticated;
grant execute on function public.business_payment_overview(uuid) to authenticated;

-- El titular desconecta la cuenta: se borran las credenciales en el acto.
create function private.disconnect_payment_account(business uuid, provider text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_business_member(business, array['owner']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  delete from private.payment_provider_credentials c using public.payment_provider_accounts a
    where c.account_id = a.id and a.business_id = business and a.provider = disconnect_payment_account.provider;
  update public.payment_provider_accounts a set status = 'not_connected', status_reason = 'Desconectada por el comercio',
    token_expires_at = null, updated_at = now()
    where a.business_id = business and a.provider = disconnect_payment_account.provider;
end;
$$;
revoke all on function private.disconnect_payment_account(uuid, text) from public, anon, authenticated;
grant execute on function private.disconnect_payment_account(uuid, text) to authenticated;
create function public.disconnect_payment_account(business uuid, provider text) returns void
language sql security invoker set search_path = ''
as $$ select private.disconnect_payment_account(business, provider); $$;
revoke all on function public.disconnect_payment_account(uuid, text) from public, anon, authenticated;
grant execute on function public.disconnect_payment_account(uuid, text) to authenticated;

-- ───────────────── servidor: OAuth del comercio ─────────────────
-- Las llama sólo la Edge Function (service_role), que antes verificó la sesión
-- de la persona. La base vuelve a comprobar que es titular.
create function private.payment_oauth_begin(business uuid, provider text, requested_by uuid,
  state text, code_verifier text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.feature_enabled('payments_online') then
    raise exception 'Payments disabled' using errcode = '42501';
  end if;
  if not exists (select 1 from private.payment_providers p where p.key = payment_oauth_begin.provider) then
    raise exception 'Unknown provider' using errcode = '23514';
  end if;
  if not exists (select 1 from public.business_memberships m
    where m.business_id = business and m.user_id = requested_by and m.role = 'owner') then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  delete from private.payment_oauth_states s where s.business_id = business and s.expires_at < now();
  insert into private.payment_oauth_states (state, business_id, provider, requested_by, code_verifier)
    values (payment_oauth_begin.state, business, payment_oauth_begin.provider, requested_by,
      payment_oauth_begin.code_verifier);
  insert into public.payment_provider_accounts (business_id, provider, status)
    values (business, payment_oauth_begin.provider, 'connecting')
  on conflict on constraint payment_provider_accounts_business_provider do update set
    status = case when payment_provider_accounts.status = 'connected' then 'connected' else 'connecting' end,
    updated_at = now();
end;
$$;

-- La vuelta del proveedor: el comercio y el code_verifier de un `state` vigente
-- y sin usar. Si no, null.
create function private.payment_oauth_lookup(state text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('business_id', s.business_id, 'provider', s.provider, 'code_verifier', s.code_verifier)
  from private.payment_oauth_states s
  where s.state = payment_oauth_lookup.state and s.used_at is null and s.expires_at > now();
$$;

-- Canjea el `state` (una sola vez, antes de vencer) y guarda la cuenta
-- conectada con sus credenciales ya cifradas. Devuelve el comercio.
create function private.payment_oauth_complete(state text, provider_user_id text, scopes text[],
  live_mode boolean, token_expires_at timestamptz, access_ciphertext text, refresh_ciphertext text,
  key_version smallint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  pending private.payment_oauth_states;
  account uuid;
begin
  select * into pending from private.payment_oauth_states s where s.state = payment_oauth_complete.state
    for update;
  if pending.state is null or pending.used_at is not null or pending.expires_at < now() then
    raise exception 'Invalid or expired state' using errcode = '42501';
  end if;
  update private.payment_oauth_states s set used_at = now() where s.state = pending.state;
  insert into public.payment_provider_accounts (business_id, provider, status, provider_user_id, scopes,
    live_mode, connected_at, token_expires_at, status_reason)
  values (pending.business_id, pending.provider, 'connected', provider_user_id, coalesce(scopes, '{}'),
    live_mode, now(), token_expires_at, '')
  on conflict on constraint payment_provider_accounts_business_provider do update set status = 'connected',
    provider_user_id = excluded.provider_user_id, scopes = excluded.scopes, live_mode = excluded.live_mode,
    connected_at = now(), token_expires_at = excluded.token_expires_at, status_reason = '', updated_at = now()
  returning id into account;
  insert into private.payment_provider_credentials (account_id, access_token_ciphertext,
    refresh_token_ciphertext, key_version, expires_at)
  values (account, access_ciphertext, coalesce(refresh_ciphertext, ''), key_version, token_expires_at)
  on conflict (account_id) do update set access_token_ciphertext = excluded.access_token_ciphertext,
    refresh_token_ciphertext = excluded.refresh_token_ciphertext, key_version = excluded.key_version,
    expires_at = excluded.expires_at, updated_at = now();
  return jsonb_build_object('business_id', pending.business_id, 'provider', pending.provider);
end;
$$;

-- La conexión falló o el token dejó de servir: se pide reconectar.
create function private.payment_account_mark(business uuid, provider text, status text, reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if status not in ('not_connected', 'reconnect_required') then
    raise exception 'Invalid account status' using errcode = '23514';
  end if;
  update public.payment_provider_accounts a set status = payment_account_mark.status,
    status_reason = left(coalesce(reason, ''), 200), updated_at = now()
    where a.business_id = business and a.provider = payment_account_mark.provider;
end;
$$;

-- Credenciales cifradas de una cuenta conectada, para que el servidor las
-- descifre en memoria y llame al proveedor. Nunca salen hacia un cliente.
create function private.payment_account_credentials(business uuid, provider text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_id', a.id, 'status', a.status, 'provider_user_id', a.provider_user_id,
    'live_mode', a.live_mode, 'access_token_ciphertext', c.access_token_ciphertext,
    'refresh_token_ciphertext', c.refresh_token_ciphertext, 'key_version', c.key_version,
    'expires_at', c.expires_at)
  from public.payment_provider_accounts a
  join private.payment_provider_credentials c on c.account_id = a.id
  where a.business_id = business and a.provider = payment_account_credentials.provider;
$$;

-- Credenciales de la cuenta conectada de un vendedor (el `user_id` que trae un
-- webhook). Sólo cuentas conectadas; si no, null.
create function private.payment_seller_credentials(provider text, seller_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_id', a.id, 'business_id', a.business_id, 'provider_user_id', a.provider_user_id,
    'access_token_ciphertext', c.access_token_ciphertext, 'key_version', c.key_version, 'expires_at', c.expires_at)
  from public.payment_provider_accounts a
  join private.payment_provider_credentials c on c.account_id = a.id
  where a.provider = payment_seller_credentials.provider and a.provider_user_id = seller_id
    and a.status = 'connected'
  limit 1;
$$;

-- ───────────────── servidor: checkout ─────────────────
-- Lo que necesita la Edge Function para pedir la orden al proveedor: el
-- importe y el detalle salen del pedido, nunca del navegador.
create function private.payment_checkout_context(attempt_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('attempt_id', a.id, 'status', a.status, 'flow', a.flow, 'provider', a.provider,
    'idempotency_key', a.idempotency_key, 'amount', a.amount_ars, 'currency', a.currency,
    'provider_order_id', a.provider_order_id, 'checkout_url', a.checkout_url, 'expires_at', a.expires_at,
    'order', jsonb_build_object('id', o.id, 'code', o.code, 'status', o.status, 'total', o.total_ars,
      'tracking_token', o.tracking_token),
    'business', jsonb_build_object('id', b.id, 'name', b.name),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', case when i.variant_name <> ''
        then i.product_name || ' · ' || i.variant_name else i.product_name end,
        'quantity', i.quantity, 'unit_price', i.unit_price_ars) order by i.position)
      from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'delivery_fee', o.delivery_fee_ars)
  from public.payment_attempts a
  join public.orders o on o.id = a.order_id
  join public.businesses b on b.id = a.business_id
  where a.id = attempt_id;
$$;

-- Guarda lo que devolvió el proveedor al crear la orden. Una sola vez: un
-- reintento con la misma clave de idempotencia devuelve la misma orden.
create function private.payment_attempt_set_checkout(attempt_id uuid, provider_order_id text,
  checkout_url text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.payment_attempts a set
    provider_order_id = coalesce(a.provider_order_id, payment_attempt_set_checkout.provider_order_id),
    checkout_url = coalesce(payment_attempt_set_checkout.checkout_url, a.checkout_url),
    updated_at = now()
  where a.id = attempt_id and a.status in ('pending', 'processing')
    and (a.provider_order_id is null or a.provider_order_id = payment_attempt_set_checkout.provider_order_id);
  if not found then
    raise exception 'Attempt not open or provider order mismatch' using errcode = '23514';
  end if;
end;
$$;

-- ───────────────── servidor: webhooks ─────────────────
-- Anota la notificación una sola vez. Repetida: `duplicate`, sin tocar nada.
create function private.payment_record_event(provider text, event_key text, resource_type text,
  resource_id text, action text, live_mode boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  event_id bigint;
begin
  insert into private.payment_events (provider, event_key, resource_type, resource_id, action, live_mode)
  values (provider, event_key, left(coalesce(resource_type, ''), 40), left(coalesce(resource_id, ''), 80),
    left(coalesce(action, ''), 60), live_mode)
  on conflict on constraint payment_events_provider_key do nothing
  returning id into event_id;
  if event_id is null then
    -- Ya estaba. Si la vez anterior la reconciliación falló (o quedó colgada
    -- más de 5 minutos), el reintento del proveedor la vuelve a procesar: es
    -- para eso que reintenta. Un solo reintento la toma (el update es atómico);
    -- lo aplicado, ignorado o marcado para revisar sigue siendo duplicado.
    update private.payment_events e set outcome = 'received', detail = '', processed_at = null,
      retries = e.retries + 1, received_at = now()
      where e.provider = payment_record_event.provider and e.event_key = payment_record_event.event_key
        and (e.outcome = 'failed' or (e.outcome = 'received' and e.received_at < now() - interval '5 minutes'))
      returning e.id into event_id;
    if event_id is not null then
      return jsonb_build_object('event_id', event_id, 'duplicate', false, 'retry', true);
    end if;
    select e.id into event_id from private.payment_events e
      where e.provider = payment_record_event.provider and e.event_key = payment_record_event.event_key;
    return jsonb_build_object('event_id', event_id, 'duplicate', true);
  end if;
  return jsonb_build_object('event_id', event_id, 'duplicate', false);
end;
$$;

-- Resultado de una notificación que no se pudo reconciliar (ignorada o fallida).
create function private.payment_mark_event(event_id bigint, outcome text, detail text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if outcome not in ('ignored', 'failed', 'flagged') then
    raise exception 'Invalid event outcome' using errcode = '23514';
  end if;
  update private.payment_events e set outcome = payment_mark_event.outcome,
    detail = left(coalesce(payment_mark_event.detail, ''), 200), processed_at = now()
    where e.id = event_id;
end;
$$;

-- Aplica el estado que el servidor LEYÓ del proveedor (no el del webhook ni el
-- de la URL de retorno). Idempotente: el mismo estado dos veces no cambia
-- nada; un salto que la máquina de estados no admite se ignora y se anota; un
-- aprobado por otro importe no se aprueba. El intento se busca por nuestra
-- referencia (external_reference) o por la orden del proveedor, y sólo si el
-- vendedor que avisa es la cuenta conectada de ESE comercio.
create function private.payment_apply_update(provider text, seller_id text, attempt_reference uuid,
  provider_order_id text, status text, status_detail text, paid_amount bigint, transactions jsonb,
  event_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  attempt public.payment_attempts;
  next_status text := status;
  v_outcome text := 'applied';
  v_detail text := left(coalesce(status_detail, ''), 80);
  movement jsonb;
begin
  if next_status not in ('pending', 'processing', 'approved', 'rejected', 'cancelled', 'refunded',
      'partially_refunded', 'expired') then
    raise exception 'Invalid payment status' using errcode = '23514';
  end if;
  select * into attempt from public.payment_attempts a
    where a.provider = payment_apply_update.provider
      and ((attempt_reference is not null and a.id = attempt_reference)
        or (attempt_reference is null and a.provider_order_id = payment_apply_update.provider_order_id))
    for update;
  if attempt.id is null then
    update private.payment_events e set outcome = 'ignored', detail = 'Intento de pago desconocido',
      processed_at = now() where e.id = event_id;
    return jsonb_build_object('outcome', 'ignored', 'reason', 'unknown_attempt');
  end if;
  if not exists (select 1 from public.payment_provider_accounts p
    where p.business_id = attempt.business_id and p.provider = attempt.provider
      and p.provider_user_id = seller_id) then
    update private.payment_events e set outcome = 'ignored', attempt_id = attempt.id,
      detail = 'El vendedor no es la cuenta de este comercio', processed_at = now() where e.id = event_id;
    return jsonb_build_object('outcome', 'ignored', 'reason', 'seller_mismatch', 'attempt_id', attempt.id);
  end if;
  if attempt.provider_order_id is null and payment_apply_update.provider_order_id is not null then
    update public.payment_attempts a set provider_order_id = payment_apply_update.provider_order_id
      where a.id = attempt.id returning * into attempt;
  end if;
  if next_status = 'approved' and (paid_amount is null or paid_amount <> attempt.amount_ars) then
    -- Nunca se aprueba por un importe distinto del pedido: queda para revisar.
    next_status := 'processing';
    v_outcome := 'flagged';
    v_detail := 'amount_mismatch';
  end if;
  if next_status <> attempt.status and not exists (select 1 from private.payment_status_transitions t
      where t.from_status = attempt.status and t.to_status = next_status) then
    update private.payment_events e set outcome = 'ignored', attempt_id = attempt.id,
      detail = left(format('Salto no admitido: %s → %s', attempt.status, next_status), 200),
      processed_at = now() where e.id = event_id;
    return jsonb_build_object('outcome', 'ignored', 'reason', 'transition', 'attempt_id', attempt.id,
      'status', attempt.status);
  end if;
  for movement in select * from jsonb_array_elements(coalesce(transactions, '[]'::jsonb)) loop
    insert into public.payment_transactions (attempt_id, business_id, provider, kind, provider_transaction_id,
      status, status_detail, amount_ars, method_type)
    values (attempt.id, attempt.business_id, attempt.provider, movement ->> 'kind', movement ->> 'id',
      movement ->> 'status', left(coalesce(movement ->> 'status_detail', ''), 80),
      coalesce((movement ->> 'amount')::bigint, 0), left(coalesce(movement ->> 'method_type', ''), 40))
    on conflict on constraint payment_transactions_provider_ref do update set status = excluded.status,
      status_detail = excluded.status_detail, amount_ars = excluded.amount_ars, updated_at = now();
  end loop;
  -- Dos pagos aprobados para un mismo intento (el mismo checkout pagado dos
  -- veces): el pedido sigue pagado, y el segundo cobro queda para revisar y
  -- devolver desde la cuenta del comercio.
  if (select count(*) from public.payment_transactions t where t.attempt_id = attempt.id and t.kind = 'payment'
      and t.status in ('approved', 'partially_refunded')) > 1 then
    v_outcome := 'flagged';
    v_detail := 'duplicate_payment';
  end if;
  if next_status <> attempt.status or v_detail <> attempt.status_detail then
    update public.payment_attempts a set status = next_status, status_detail = v_detail, updated_at = now()
      where a.id = attempt.id returning * into attempt;
    -- El pedido refleja su intento más reciente.
    update public.orders o set payment_status = attempt.status, updated_at = now()
      where o.id = attempt.order_id and o.payment_method = 'online'
        and attempt.id = (select a.id from public.payment_attempts a where a.order_id = o.id
          order by a.created_at desc limit 1);
  end if;
  update private.payment_events e set outcome = v_outcome, attempt_id = attempt.id,
    detail = case when v_outcome = 'flagged' then v_detail else '' end, processed_at = now()
    where e.id = event_id;
  update public.payment_provider_accounts p set last_synced_at = now()
    where p.business_id = attempt.business_id and p.provider = attempt.provider;
  return jsonb_build_object('outcome', v_outcome, 'attempt_id', attempt.id,
    'status', attempt.status);
end;
$$;

-- ───────────────── permisos del servidor ─────────────────
-- Sólo service_role: ningún cliente (anon, authenticated) las ejecuta.
do $$
declare fn text;
begin
  foreach fn in array array[
    'private.payment_oauth_begin(uuid, text, uuid, text, text)',
    'private.payment_oauth_lookup(text)',
    'private.payment_oauth_complete(text, text, text[], boolean, timestamptz, text, text, smallint)',
    'private.payment_account_mark(uuid, text, text, text)',
    'private.payment_account_credentials(uuid, text)',
    'private.payment_checkout_context(uuid)',
    'private.payment_attempt_set_checkout(uuid, text, text)',
    'private.payment_record_event(text, text, text, text, text, boolean)',
    'private.payment_mark_event(bigint, text, text)',
    'private.payment_seller_credentials(text, text)',
    'private.payment_apply_update(text, text, uuid, text, text, text, bigint, jsonb, bigint)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- Puertas públicas para PostgREST, también sólo para service_role.
create function public.payment_oauth_begin(business uuid, provider text, requested_by uuid, state text,
  code_verifier text) returns void language sql security invoker set search_path = ''
as $$ select private.payment_oauth_begin(business, provider, requested_by, state, code_verifier); $$;
create function public.payment_oauth_lookup(state text) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.payment_oauth_lookup(state); $$;
create function public.payment_oauth_complete(state text, provider_user_id text, scopes text[],
  live_mode boolean, token_expires_at timestamptz, access_ciphertext text, refresh_ciphertext text,
  key_version smallint) returns jsonb language sql security invoker set search_path = ''
as $$ select private.payment_oauth_complete(state, provider_user_id, scopes, live_mode, token_expires_at,
  access_ciphertext, refresh_ciphertext, key_version); $$;
create function public.payment_account_mark(business uuid, provider text, status text, reason text)
returns void language sql security invoker set search_path = ''
as $$ select private.payment_account_mark(business, provider, status, reason); $$;
create function public.payment_account_credentials(business uuid, provider text) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.payment_account_credentials(business, provider); $$;
create function public.payment_checkout_context(attempt_id uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.payment_checkout_context(attempt_id); $$;
create function public.payment_attempt_set_checkout(attempt_id uuid, provider_order_id text,
  checkout_url text) returns void language sql security invoker set search_path = ''
as $$ select private.payment_attempt_set_checkout(attempt_id, provider_order_id, checkout_url); $$;
create function public.payment_record_event(provider text, event_key text, resource_type text,
  resource_id text, action text, live_mode boolean) returns jsonb language sql security invoker set search_path = ''
as $$ select private.payment_record_event(provider, event_key, resource_type, resource_id, action, live_mode); $$;
create function public.payment_mark_event(event_id bigint, outcome text, detail text) returns void
language sql security invoker set search_path = ''
as $$ select private.payment_mark_event(event_id, outcome, detail); $$;
create function public.payment_seller_credentials(provider text, seller_id text) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.payment_seller_credentials(provider, seller_id); $$;
create function public.payment_apply_update(provider text, seller_id text, attempt_reference uuid,
  provider_order_id text, status text, status_detail text, paid_amount bigint, transactions jsonb,
  event_id bigint) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.payment_apply_update(provider, seller_id, attempt_reference, provider_order_id, status,
  status_detail, paid_amount, transactions, event_id); $$;
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.payment_oauth_begin(uuid, text, uuid, text, text)',
    'public.payment_oauth_lookup(text)',
    'public.payment_oauth_complete(text, text, text[], boolean, timestamptz, text, text, smallint)',
    'public.payment_account_mark(uuid, text, text, text)',
    'public.payment_account_credentials(uuid, text)',
    'public.payment_checkout_context(uuid)',
    'public.payment_attempt_set_checkout(uuid, text, text)',
    'public.payment_record_event(text, text, text, text, text, boolean)',
    'public.payment_mark_event(bigint, text, text)',
    'public.payment_seller_credentials(text, text)',
    'public.payment_apply_update(text, text, uuid, text, text, text, bigint, jsonb, bigint)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ───────────────── contrato con el frontend ─────────────────
create or replace function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schema', 20260926120000,
    'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
    'localities', coalesce((select jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'timezone', timezone)
      order by name) from public.localities where active), '[]'::jsonb),
    'now', now());
$$;

commit;
