-- Corrige la contabilidad de stock, encontrada al auditar el esquema.
--
-- 1. Dos líneas del mismo producto (dos variantes) rechazaban el pedido aunque
--    hubiera existencias: la comprobación sumaba dos veces lo ya descontado.
-- 2. Al cancelar, `update ... from` sólo aplica una fila de origen por fila de
--    destino, así que de dos líneas del mismo producto se devolvía una sola.
begin;

create or replace function private.create_order(business uuid, idem uuid, fulfillment text,
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
    -- La fila se releyó bloqueada: su stock ya descuenta las líneas anteriores
    -- de este mismo pedido. Sumarlas otra vez rechazaba ventas posibles.
    if product.stock < quantity then
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

create or replace function private.transition_order(order_id uuid, expected_version integer,
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
    update public.products p set stock = least(p.stock + devuelto.total, 10000)
      from (select i.product_id, sum(i.quantity)::int as total from public.order_items i
        where i.order_id = row.id and i.product_id is not null group by i.product_id) devuelto
      where devuelto.product_id = p.id;
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

commit;
