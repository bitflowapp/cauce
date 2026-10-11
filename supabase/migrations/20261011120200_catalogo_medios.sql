-- CAUCE · Ferias — catálogo (productos, variantes con stock propio, fotos),
-- medios en Storage y ciclo de publicación del comercio.
begin;

-- ───────────────── productos ─────────────────
create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  category_id uuid references public.categories(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  description text not null default '' check (length(description) <= 1000),
  materials text not null default '' check (length(materials) <= 160),
  price_ars bigint not null check (price_ars > 0 and price_ars <= 10000000),
  -- Con stock: se descuenta al pedir. Bajo pedido: se elabora después del pedido.
  track_stock boolean not null default true,
  stock integer not null default 0 check (stock between 0 and 10000),
  made_to_order boolean not null default false,
  production_days_min smallint check (production_days_min is null or production_days_min between 1 and 120),
  production_days_max smallint check (production_days_max is null or production_days_max between 1 and 120),
  handmade boolean not null default true,
  available boolean not null default true,
  archived boolean not null default false,
  featured boolean not null default false,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_made_to_order_untracked check (not (made_to_order and track_stock)),
  constraint products_production_range check (production_days_min is null or production_days_max is null
    or production_days_max >= production_days_min),
  unique (id, business_id)
);
create index products_business on public.products(business_id, archived, position);
create index products_catalog on public.products(created_at desc) where not archived;
create index products_category on public.products(category_id) where not archived;
create index products_featured on public.products(updated_at desc) where featured and not archived;
create trigger products_touch before update on public.products
  for each row execute function private.touch_updated_at();

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  business_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 40),
  price_delta_ars bigint not null default 0 check (abs(price_delta_ars) <= 10000000),
  stock integer not null default 0 check (stock between 0 and 10000),
  position smallint not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (product_id, business_id) references public.products(id, business_id) on delete cascade,
  unique (product_id, name),
  unique (id, product_id)
);
create index product_variants_product on public.product_variants(product_id, position);

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  business_id uuid not null,
  path text not null unique check (path like 'businesses/' || business_id::text || '/products/%'),
  alt text not null default '' check (length(alt) <= 140),
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  foreign key (product_id, business_id) references public.products(id, business_id) on delete cascade
);
create index product_images_product on public.product_images(product_id, position);

-- ───────────────── límites del plan (en la base) ─────────────────
create function private.enforce_product_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare allowed integer;
begin
  if tg_op = 'UPDATE' and not (old.archived and not new.archived) then return new; end if;
  if new.archived then return new; end if;
  -- Serializa las altas del mismo comercio: dos pestañas no superan el tope.
  perform pg_advisory_xact_lock(hashtextextended('products:' || new.business_id::text, 0));
  allowed := (private.business_entitlements(new.business_id) ->> 'max_products')::int;
  if (select count(*) from public.products p
      where p.business_id = new.business_id and not p.archived and p.id <> new.id) >= allowed then
    raise exception 'Plan limit: products' using errcode = 'U0010', detail = allowed::text;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_product_limit() from public, anon, authenticated;
create trigger products_plan_limit before insert or update of archived on public.products
  for each row execute function private.enforce_product_limit();

create function private.enforce_image_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare allowed integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('images:' || new.product_id::text, 0));
  allowed := (private.business_entitlements(new.business_id) ->> 'max_images')::int;
  if (select count(*) from public.product_images i where i.product_id = new.product_id) >= allowed then
    raise exception 'Plan limit: images' using errcode = 'U0010', detail = allowed::text;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_image_limit() from public, anon, authenticated;
create trigger product_images_plan_limit before insert on public.product_images
  for each row execute function private.enforce_image_limit();

create function private.enforce_variant_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.product_variants where product_id = new.product_id) >= 12 then
    raise exception 'Up to 12 variants per product' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_variant_limit() from public, anon, authenticated;
create trigger product_variants_limit before insert on public.product_variants
  for each row execute function private.enforce_variant_limit();

-- Con variantes, el stock del producto es la suma de sus variantes activas:
-- así se filtra "con stock" y se muestra el disponible sin recorrer variantes.
create function private.sync_variant_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare target uuid := coalesce(new.product_id, old.product_id);
begin
  if exists (select 1 from public.product_variants v where v.product_id = target and v.active) then
    update public.products p set stock = least((select coalesce(sum(v.stock), 0) from public.product_variants v
      where v.product_id = target and v.active), 10000)
      where p.id = target and p.stock is distinct from least((select coalesce(sum(v.stock), 0)
        from public.product_variants v where v.product_id = target and v.active), 10000);
  end if;
  return null;
end;
$$;
revoke all on function private.sync_variant_stock() from public, anon, authenticated;
create trigger product_variants_stock after insert or update of stock, active or delete on public.product_variants
  for each row execute function private.sync_variant_stock();

-- ───────────────── privilegios ─────────────────
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_images enable row level security;
revoke all on public.products, public.product_variants, public.product_images from public, anon, authenticated;

grant select on public.products, public.product_variants, public.product_images to anon, authenticated;
grant insert (business_id, category_id, name, description, materials, price_ars, track_stock, stock, made_to_order,
  production_days_min, production_days_max, handmade, available, featured, position),
  update (category_id, name, description, materials, price_ars, track_stock, stock, made_to_order,
  production_days_min, production_days_max, handmade, available, archived, featured, position),
  delete on public.products to authenticated;
grant insert (product_id, business_id, name, price_delta_ars, stock, position, active),
  update (name, price_delta_ars, stock, position, active), delete on public.product_variants to authenticated;
grant insert (product_id, business_id, path, alt, position), update (alt, position), delete
  on public.product_images to authenticated;

-- Lectura pública: productos no archivados de comercios publicados.
create policy products_read_anon on public.products for select to anon
using (not archived and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'));
create policy products_read_auth on public.products for select to authenticated
using ((not archived and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'))
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin()));
create policy products_insert on public.products for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy products_update on public.products for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy products_delete on public.products for delete to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

create policy variants_read_anon on public.product_variants for select to anon
using (exists (select 1 from public.products p join public.businesses b on b.id = p.business_id
  where p.id = product_id and not p.archived and b.status = 'active'));
create policy variants_read_auth on public.product_variants for select to authenticated
using (exists (select 1 from public.products p join public.businesses b on b.id = p.business_id
    where p.id = product_id and not p.archived and b.status = 'active')
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin()));
create policy variants_insert on public.product_variants for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy variants_update on public.product_variants for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy variants_delete on public.product_variants for delete to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

create policy images_read_anon on public.product_images for select to anon
using (exists (select 1 from public.products p join public.businesses b on b.id = p.business_id
  where p.id = product_id and not p.archived and b.status = 'active'));
create policy images_read_auth on public.product_images for select to authenticated
using (exists (select 1 from public.products p join public.businesses b on b.id = p.business_id
    where p.id = product_id and not p.archived and b.status = 'active')
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin()));
create policy images_insert on public.product_images for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy images_update on public.product_images for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy images_delete on public.product_images for delete to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

-- ───────────────── stock y disponibilidad (también para ayudantes) ─────────────────
-- El personal no edita el catálogo: sólo ajusta stock y disponibilidad.
create function private.set_stock(product uuid, variant uuid, next_stock integer, is_available boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row public.products;
begin
  select * into row from public.products where id = product for update;
  if row.id is null then raise exception 'Product not found' using errcode = 'P0002'; end if;
  if not private.is_business_member(row.business_id, array['owner', 'manager', 'staff']) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  if next_stock is not null and (next_stock < 0 or next_stock > 10000) then
    raise exception 'Invalid stock' using errcode = '23514';
  end if;
  if variant is not null then
    update public.product_variants set stock = coalesce(next_stock, stock)
      where id = variant and product_id = product;
    if not found then raise exception 'Variant not available' using errcode = '23514'; end if;
  elsif next_stock is not null then
    if exists (select 1 from public.product_variants v where v.product_id = product and v.active) then
      raise exception 'Stock is per variant' using errcode = '23514';
    end if;
    update public.products set stock = next_stock where id = product;
  end if;
  if is_available is not null then
    update public.products set available = is_available where id = product;
  end if;
  return jsonb_build_object('product', product, 'variant', variant);
end;
$$;
revoke all on function private.set_stock(uuid, uuid, integer, boolean) from public, anon, authenticated;
grant execute on function private.set_stock(uuid, uuid, integer, boolean) to authenticated;
create function public.set_stock(product uuid, variant uuid default null, next_stock integer default null,
  is_available boolean default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.set_stock(product, variant, next_stock, is_available); $$;
revoke all on function public.set_stock(uuid, uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.set_stock(uuid, uuid, integer, boolean) to authenticated;

-- ───────────────── derechos del plan para el panel ─────────────────
create function public.my_entitlements(business uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.my_entitlements(business); $$;
revoke all on function public.my_entitlements(uuid) from public, anon, authenticated;
grant execute on function private.my_entitlements(uuid) to authenticated;
grant execute on function public.my_entitlements(uuid) to authenticated;

-- ───────────────── ciclo de publicación ─────────────────
create function private.business_missing_requirements(business uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_remove(array[
    case when b.category_id is null then 'Rubro' end,
    case when length(btrim(coalesce(c.owner_name, ''))) < 2 then 'Nombre de quien atiende' end,
    case when length(btrim(coalesce(c.phone, ''))) < 6 and length(b.whatsapp) = 0
      then 'Teléfono o WhatsApp de contacto' end,
    case when not b.pickup_enabled and not b.delivery_enabled and not b.fair_pickup_enabled
      then 'Al menos una forma de entrega' end,
    case when b.delivery_enabled and length(btrim(b.delivery_zone)) = 0 then 'Zona de envío' end,
    case when not exists (select 1 from public.products p
        where p.business_id = b.id and not p.archived
          and exists (select 1 from public.product_images i where i.product_id = p.id))
      then 'Al menos un producto con foto' end
  ], null), array[]::text[])
  from public.businesses b left join public.business_contacts c on c.business_id = b.id
  where b.id = business;
$$;
revoke all on function private.business_missing_requirements(uuid) from public, anon, authenticated;

create function private.my_missing_requirements(business uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_business_member(business, array['owner', 'manager', 'staff']) and not private.is_admin() then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  return private.business_missing_requirements(business);
end;
$$;
revoke all on function private.my_missing_requirements(uuid) from public, anon, authenticated;
grant execute on function private.my_missing_requirements(uuid) to authenticated;
create function public.business_missing_requirements(business uuid) returns text[]
language sql stable security invoker set search_path = ''
as $$ select private.my_missing_requirements(business); $$;
revoke all on function public.business_missing_requirements(uuid) from public, anon, authenticated;
grant execute on function public.business_missing_requirements(uuid) to authenticated;

create function private.submit_business_for_review(business uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare current text; missing text[];
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  select status into current from public.businesses where id = business for update;
  if current not in ('draft', 'returned') then
    raise exception 'Only a draft or returned application can be submitted' using errcode = '23514';
  end if;
  missing := private.business_missing_requirements(business);
  if array_length(missing, 1) > 0 then
    raise exception 'Faltan datos: %', array_to_string(missing, ', ') using errcode = '23514';
  end if;
  update public.businesses set status = 'pending_review' where id = business;
  insert into public.business_review_events (business_id, from_status, to_status, actor_id, actor_role)
    values (business, current, 'pending_review', (select auth.uid()), 'merchant');
  perform private.audit('merchant', 'business.submitted', 'business', business, '{}'::jsonb);
  return 'pending_review';
end;
$$;
revoke all on function private.submit_business_for_review(uuid) from public, anon, authenticated;
grant execute on function private.submit_business_for_review(uuid) to authenticated;
create function public.submit_business_for_review(business uuid) returns text
language sql security invoker set search_path = ''
as $$ select private.submit_business_for_review(business); $$;
revoke all on function public.submit_business_for_review(uuid) from public, anon, authenticated;
grant execute on function public.submit_business_for_review(uuid) to authenticated;

-- Aprobar es exclusivo de administración. Al aprobar un comercio sin plan, se
-- le abre un período de prueba del plan elegido.
create function private.review_business(business uuid, decision text, note text, plan text, trial_days integer)
returns text language plpgsql security definer set search_path = '' as $$
declare current text;
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  if decision not in ('active', 'returned') then raise exception 'Invalid decision' using errcode = '23514'; end if;
  select status into current from public.businesses where id = business for update;
  if current is null then raise exception 'Business not found' using errcode = 'P0002'; end if;
  if current <> 'pending_review' then
    raise exception 'Only applications under review can be resolved' using errcode = '23514';
  end if;
  if decision = 'returned' and length(btrim(coalesce(note, ''))) < 3 then
    raise exception 'Reason required' using errcode = '23514';
  end if;
  if decision = 'active' and not exists (select 1 from public.subscriptions where business_id = business) then
    if not exists (select 1 from public.plans where code = coalesce(plan, 'entrada') and audience = 'business') then
      raise exception 'Invalid plan' using errcode = '23514';
    end if;
    insert into public.subscriptions (business_id, plan_code, status, period_end, note, updated_by)
      values (business, coalesce(plan, 'entrada'), 'trial',
        private.today_ar() + least(greatest(coalesce(trial_days, 30), 1), 90), 'Prueba al aprobar el alta',
        (select auth.uid()));
    perform private.audit('admin', 'subscription.trial_started', 'subscription', business,
      jsonb_build_object('plan', coalesce(plan, 'entrada'), 'days', coalesce(trial_days, 30)));
  end if;
  update public.businesses set status = decision where id = business;
  insert into public.business_review_events (business_id, from_status, to_status, actor_id, actor_role, note)
    values (business, current, decision, (select auth.uid()), 'admin', left(coalesce(note, ''), 400));
  perform private.audit('admin', 'business.reviewed', 'business', business,
    jsonb_build_object('decision', decision));
  return decision;
end;
$$;
revoke all on function private.review_business(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function private.review_business(uuid, text, text, text, integer) to authenticated;
create function public.review_business(business uuid, decision text, note text default '',
  plan text default 'entrada', trial_days integer default 30) returns text
language sql security invoker set search_path = ''
as $$ select private.review_business(business, decision, note, plan, trial_days); $$;
revoke all on function public.review_business(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.review_business(uuid, text, text, text, integer) to authenticated;

-- Pausar y reanudar la tienda es decisión del comercio; publicar nunca lo es.
create function private.set_business_presence(business uuid, next_status text) returns text
language plpgsql security definer set search_path = '' as $$
declare current text;
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  select status into current from public.businesses where id = business for update;
  if current is null then raise exception 'Business not found' using errcode = 'P0002'; end if;
  if not ((current = 'active' and next_status = 'paused') or (current = 'paused' and next_status = 'active')) then
    raise exception 'Transition not allowed' using errcode = '23514';
  end if;
  update public.businesses set status = next_status where id = business;
  insert into public.business_review_events (business_id, from_status, to_status, actor_id, actor_role)
    values (business, current, next_status, (select auth.uid()), 'merchant');
  perform private.audit('merchant', 'business.' || next_status, 'business', business, '{}'::jsonb);
  return next_status;
end;
$$;
revoke all on function private.set_business_presence(uuid, text) from public, anon, authenticated;
grant execute on function private.set_business_presence(uuid, text) to authenticated;
create function public.set_business_presence(business uuid, next_status text) returns text
language sql security invoker set search_path = ''
as $$ select private.set_business_presence(business, next_status); $$;
revoke all on function public.set_business_presence(uuid, text) from public, anon, authenticated;
grant execute on function public.set_business_presence(uuid, text) to authenticated;

-- ───────────────── medios ─────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ferias-media', 'ferias-media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- El dueño del archivo sale de la ruta, sólo si tiene exactamente la forma esperada.
create function private.media_business(path text) returns uuid
language sql immutable set search_path = '' as $$
  select case when path ~ '^businesses/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(logo|cover|products)/[0-9a-f-]{36}\.(jpg|png|webp)$'
    then (split_part(path, '/', 2))::uuid end;
$$;
revoke all on function private.media_business(text) from public, anon, authenticated;
grant execute on function private.media_business(text) to authenticated;

-- Tope de archivos por comercio: fotos del plan más logo, portada y margen.
create function private.media_quota_ok(path text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare business uuid := private.media_business(path); rights jsonb; quota integer;
begin
  if business is null then return false; end if;
  rights := private.business_entitlements(business);
  quota := (rights ->> 'max_products')::int * (rights ->> 'max_images')::int + 20;
  return (select count(*) from storage.objects o
    where o.bucket_id = 'ferias-media' and o.name like 'businesses/' || business::text || '/%') < quota;
end;
$$;
revoke all on function private.media_quota_ok(text) from public, anon, authenticated;
grant execute on function private.media_quota_ok(text) to authenticated;

create policy business_media_read on storage.objects for select to authenticated
using (bucket_id = 'ferias-media'
  and (private.is_business_member(private.media_business(name), array['owner', 'manager', 'staff'])
    or (select private.is_admin())));
create policy business_media_insert on storage.objects for insert to authenticated
with check (bucket_id = 'ferias-media'
  and private.is_business_member(private.media_business(name), array['owner', 'manager'])
  and private.media_quota_ok(name));
create policy business_media_update on storage.objects for update to authenticated
using (bucket_id = 'ferias-media'
  and private.is_business_member(private.media_business(name), array['owner', 'manager']))
with check (bucket_id = 'ferias-media'
  and private.is_business_member(private.media_business(name), array['owner', 'manager']));
create policy business_media_delete on storage.objects for delete to authenticated
using (bucket_id = 'ferias-media'
  and private.is_business_member(private.media_business(name), array['owner', 'manager']));

commit;
