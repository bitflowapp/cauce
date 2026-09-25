-- CAUCE: catálogo real y medios por comercio. Sin pedidos ni datos sintéticos.
-- Dinero en ARS enteros (bigint), nunca punto flotante.
begin;

-- ───────────────── utilidades internas ─────────────────
create function private.touch_updated_at() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;

-- El ámbito del producto se deriva del comercio: el cliente nunca lo declara.
create function private.set_product_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select locality_id into new.locality_id from public.businesses where id = new.business_id;
  if new.locality_id is null then
    raise exception 'Unknown business' using errcode = '23503';
  end if;
  return new;
end;
$$;

-- ───────────────── rubros comerciales ─────────────────
create table public.business_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(btrim(name)) between 2 and 60),
  position smallint not null default 0,
  active boolean not null default true
);
insert into public.business_categories (slug, name, position) values
  ('gastronomia', 'Gastronomía', 10),
  ('panaderia', 'Panadería', 20),
  ('almacen', 'Almacén', 30),
  ('kiosco', 'Kiosco', 40),
  ('verduleria', 'Verdulería', 50),
  ('carniceria', 'Carnicería', 60),
  ('farmacia', 'Farmacia', 70),
  ('ferreteria', 'Ferretería', 80),
  ('servicios', 'Servicios', 90),
  ('otros', 'Otros', 99);

-- ───────────────── identidad comercial pública ─────────────────
alter table public.businesses
  add column category_id uuid references public.business_categories(id),
  add column description text not null default '' check (length(description) <= 280),
  add column address text not null default '' check (length(address) <= 200),
  add column hours_label text not null default '' check (length(hours_label) <= 120),
  add column delivery_zone text not null default '' check (length(delivery_zone) <= 160),
  add column delivery_fee_ars bigint not null default 0 check (delivery_fee_ars between 0 and 10000000),
  add column minimum_order_ars bigint not null default 0 check (minimum_order_ars between 0 and 10000000),
  add column pickup_enabled boolean not null default true,
  add column delivery_enabled boolean not null default false,
  add column open boolean not null default false,
  add column logo_path text check (logo_path is null or logo_path like 'businesses/' || id::text || '/logo/%'),
  add column cover_path text check (cover_path is null or cover_path like 'businesses/' || id::text || '/cover/%'),
  add column updated_at timestamptz not null default now();
-- Clave compuesta: hace imposible que una fila hija cambie de localidad.
alter table public.businesses add constraint businesses_scope unique (id, locality_id);
create trigger businesses_touch before update on public.businesses
  for each row execute function private.touch_updated_at();

-- ───────────────── contacto privado del comercio ─────────────────
-- Nunca se publica: sólo miembros y administración.
create table public.business_contacts (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  owner_name text not null default '' check (length(owner_name) <= 120),
  phone text not null default '' check (length(phone) <= 24),
  email text not null default '' check (length(email) <= 120),
  reference text not null default '' check (length(reference) <= 200),
  updated_at timestamptz not null default now()
);
create trigger business_contacts_touch before update on public.business_contacts
  for each row execute function private.touch_updated_at();

-- ───────────────── historial de revisión ─────────────────
create table public.business_review_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text not null check (actor_role in ('merchant', 'admin')),
  note text not null default '' check (length(note) <= 400),
  created_at timestamptz not null default now()
);
create index business_review_events_business on public.business_review_events(business_id, created_at desc);

-- ───────────────── categorías del catálogo por comercio ─────────────────
create table public.product_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 40),
  position smallint not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (business_id, name),
  unique (id, business_id)
);

-- ───────────────── productos ─────────────────
create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  locality_id uuid not null,
  category_id uuid,
  name text not null check (length(btrim(name)) between 2 and 80),
  description text not null default '' check (length(description) <= 280),
  price_ars bigint not null check (price_ars > 0 and price_ars <= 10000000),
  stock integer not null default 0 check (stock between 0 and 10000),
  available boolean not null default true,
  archived boolean not null default false,
  image_path text check (image_path is null or image_path like 'businesses/' || business_id::text || '/products/%'),
  dish_type text not null default '' check (length(dish_type) <= 24),
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, locality_id) references public.businesses(id, locality_id) on delete cascade,
  foreign key (category_id, business_id) references public.product_categories(id, business_id) on delete set null (category_id),
  unique (id, business_id)
);
create index products_business on public.products(business_id, archived, position);
create trigger products_scope before insert on public.products
  for each row execute function private.set_product_scope();
create trigger products_touch before update on public.products
  for each row execute function private.touch_updated_at();

-- ───────────────── variantes ─────────────────
create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  business_id uuid not null,
  name text not null check (length(btrim(name)) between 2 and 40),
  price_delta_ars bigint not null default 0 check (abs(price_delta_ars) <= 10000000),
  position smallint not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (product_id, business_id) references public.products(id, business_id) on delete cascade,
  unique (product_id, name),
  unique (id, product_id)
);
create index product_variants_product on public.product_variants(product_id, position);

create function private.enforce_variant_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.product_variants where product_id = new.product_id) > 6 then
    raise exception 'Se admiten hasta 6 variantes por producto' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger product_variants_limit after insert on public.product_variants
  deferrable initially immediate for each row execute function private.enforce_variant_limit();

-- ───────────────── privilegios explícitos ─────────────────
-- Los privilegios por defecto del proyecto conceden todo sobre cada tabla nueva
-- de `public`: revocarlos es obligatorio antes de conceder lo mínimo.
revoke all on public.business_categories, public.business_contacts, public.business_review_events,
  public.product_categories, public.products, public.product_variants from public, anon, authenticated;

grant select on public.business_categories to anon, authenticated;
grant select on public.products, public.product_variants, public.product_categories to anon, authenticated;
grant select on public.business_contacts, public.business_review_events to authenticated;

grant insert (business_id, owner_name, phone, email, reference),
      update (owner_name, phone, email, reference) on public.business_contacts to authenticated;
grant insert (business_id, name, position, active),
      update (name, position, active), delete on public.product_categories to authenticated;
grant insert (business_id, category_id, name, description, price_ars, stock, available, image_path, dish_type, position),
      update (category_id, name, description, price_ars, stock, available, archived, image_path, dish_type, position),
      delete on public.products to authenticated;
grant insert (product_id, business_id, name, price_delta_ars, position, active),
      update (name, price_delta_ars, position, active), delete on public.product_variants to authenticated;

-- `status`, `locality_id`, `created_at` y `updated_at` siguen fuera del alcance del cliente.
grant update (name, slug, category_id, description, address, hours_label, delivery_zone,
  delivery_fee_ars, minimum_order_ars, pickup_enabled, delivery_enabled, open, logo_path, cover_path)
  on public.businesses to authenticated;

alter table public.business_categories enable row level security;
alter table public.business_contacts enable row level security;
alter table public.business_review_events enable row level security;
alter table public.product_categories enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;

-- ───────────────── políticas ─────────────────
create policy business_categories_public on public.business_categories for select to anon, authenticated
using (active);

-- Una sola política de lectura por rol: evita permisivas múltiples y mantiene
-- a `anon` fuera de funciones que no puede ejecutar.
drop policy business_public on public.businesses;
drop policy business_member_read on public.businesses;
drop policy business_admin_review on public.businesses;
create policy business_read_anon on public.businesses for select to anon
using (status = 'active' and exists (select 1 from public.localities l where l.id = locality_id and l.active));
create policy business_read_auth on public.businesses for select to authenticated
using (
  (status = 'active' and exists (select 1 from public.localities l where l.id = locality_id and l.active))
  or private.is_business_member(id, array['owner', 'manager', 'staff'])
  or (select private.is_admin())
);

create policy contacts_read on public.business_contacts for select to authenticated
using (private.is_business_member(business_id, array['owner', 'manager', 'staff']) or (select private.is_admin()));
create policy contacts_insert on public.business_contacts for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy contacts_update on public.business_contacts for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));

-- Historial de revisión: lectura para el comercio y la administración, escritura sólo por RPC.
create policy review_events_read on public.business_review_events for select to authenticated
using (private.is_business_member(business_id, array['owner', 'manager', 'staff']) or (select private.is_admin()));

create policy product_categories_read_anon on public.product_categories for select to anon
using (active and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'));
create policy product_categories_read_auth on public.product_categories for select to authenticated
using (
  (active and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'))
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin())
);
create policy product_categories_write on public.product_categories for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy product_categories_update on public.product_categories for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy product_categories_delete on public.product_categories for delete to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

create policy products_read_anon on public.products for select to anon
using (not archived and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'));
create policy products_read_auth on public.products for select to authenticated
using (
  (not archived and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'))
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin())
);
create policy products_insert on public.products for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy products_update on public.products for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy products_delete on public.products for delete to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

create policy product_variants_read_anon on public.product_variants for select to anon
using (exists (select 1 from public.products p join public.businesses b on b.id = p.business_id
  where p.id = product_id and not p.archived and b.status = 'active'));
create policy product_variants_read_auth on public.product_variants for select to authenticated
using (
  exists (select 1 from public.products p join public.businesses b on b.id = p.business_id
    where p.id = product_id and not p.archived and b.status = 'active')
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin())
);
create policy product_variants_insert on public.product_variants for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy product_variants_update on public.product_variants for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy product_variants_delete on public.product_variants for delete to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']));

-- ───────────────── disponibilidad operada por staff ─────────────────
-- Staff no recibe UPDATE directo: sólo puede marcar disponibilidad y stock.
create function private.set_product_availability(product uuid, is_available boolean, next_stock integer)
returns public.products language plpgsql security definer set search_path = '' as $$
declare row public.products;
begin
  select * into row from public.products where id = product;
  if row.id is null then raise exception 'Product not found' using errcode = 'P0002'; end if;
  if not private.is_business_member(row.business_id, array['owner', 'manager', 'staff']) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  if is_available is null then raise exception 'Availability required' using errcode = '23514'; end if;
  update public.products set available = is_available,
    stock = coalesce(next_stock, stock) where id = product returning * into row;
  return row;
end;
$$;
revoke all on function private.set_product_availability(uuid, boolean, integer) from public, anon, authenticated;
grant execute on function private.set_product_availability(uuid, boolean, integer) to authenticated;
create function public.set_product_availability(product uuid, is_available boolean, next_stock integer default null)
returns public.products language sql security invoker set search_path = ''
as $$ select private.set_product_availability(product, is_available, next_stock); $$;
revoke all on function public.set_product_availability(uuid, boolean, integer) from public, anon, authenticated;
grant execute on function public.set_product_availability(uuid, boolean, integer) to authenticated;

-- ───────────────── ciclo de vida del alta comercial ─────────────────
create function private.business_missing_requirements(business uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_remove(array[
    case when b.category_id is null then 'Rubro' end,
    case when length(btrim(b.address)) = 0 then 'Dirección' end,
    case when length(btrim(b.hours_label)) = 0 then 'Horarios de atención' end,
    case when length(btrim(coalesce(c.owner_name, ''))) = 0 then 'Responsable' end,
    case when length(btrim(coalesce(c.phone, ''))) = 0 then 'Teléfono de contacto' end,
    case when not b.pickup_enabled and not b.delivery_enabled then 'Al menos una modalidad de entrega' end,
    case when b.delivery_enabled and length(btrim(b.delivery_zone)) = 0 then 'Zona de envío' end,
    case when not exists (select 1 from public.products p where p.business_id = b.id and not p.archived)
      then 'Al menos un producto cargado' end
  ], null), array[]::text[])
  from public.businesses b left join public.business_contacts c on c.business_id = b.id
  where b.id = business;
$$;
revoke all on function private.business_missing_requirements(uuid) from public, anon, authenticated;
grant execute on function private.business_missing_requirements(uuid) to authenticated;
create function public.business_missing_requirements(business uuid) returns text[]
language sql stable security invoker set search_path = ''
as $$ select private.business_missing_requirements(business); $$;
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

-- Aprobar o devolver es exclusivo de administración: nunca del propio comercio.
create function private.review_business(business uuid, decision text, note text) returns text
language plpgsql security definer set search_path = '' as $$
declare current text;
begin
  if not private.is_admin() then
    raise exception 'Administration only' using errcode = '42501';
  end if;
  if decision not in ('active', 'returned') then
    raise exception 'Invalid decision' using errcode = '23514';
  end if;
  select status into current from public.businesses where id = business for update;
  if current is null then raise exception 'Business not found' using errcode = 'P0002'; end if;
  if current <> 'pending_review' then
    raise exception 'Only applications under review can be resolved' using errcode = '23514';
  end if;
  update public.businesses set status = decision where id = business;
  insert into public.business_review_events (business_id, from_status, to_status, actor_id, actor_role, note)
    values (business, current, decision, (select auth.uid()), 'admin', coalesce(left(note, 400), ''));
  return decision;
end;
$$;
revoke all on function private.review_business(uuid, text, text) from public, anon, authenticated;
grant execute on function private.review_business(uuid, text, text) to authenticated;
create function public.review_business(business uuid, decision text, note text default '') returns text
language sql security invoker set search_path = ''
as $$ select private.review_business(business, decision, note); $$;
revoke all on function public.review_business(uuid, text, text) from public, anon, authenticated;
grant execute on function public.review_business(uuid, text, text) to authenticated;

-- Pausar y reanudar son decisiones del comercio; publicar nunca lo es.
create function private.set_business_presence(business uuid, next_status text, is_open boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare current text;
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  select status into current from public.businesses where id = business for update;
  if current is null then raise exception 'Business not found' using errcode = 'P0002'; end if;
  if next_status is not null then
    if not ((current = 'active' and next_status = 'paused') or (current = 'paused' and next_status = 'active')) then
      raise exception 'Transition not allowed' using errcode = '23514';
    end if;
    update public.businesses set status = next_status,
      open = case when next_status = 'paused' then false else open end where id = business;
    insert into public.business_review_events (business_id, from_status, to_status, actor_id, actor_role)
      values (business, current, next_status, (select auth.uid()), 'merchant');
    current := next_status;
  end if;
  if is_open is not null then
    if current <> 'active' and is_open then
      raise exception 'Only a published business can open' using errcode = '23514';
    end if;
    update public.businesses set open = is_open where id = business;
  end if;
  return current;
end;
$$;
revoke all on function private.set_business_presence(uuid, text, boolean) from public, anon, authenticated;
grant execute on function private.set_business_presence(uuid, text, boolean) to authenticated;
create function public.set_business_presence(business uuid, next_status text default null, is_open boolean default null)
returns text language sql security invoker set search_path = ''
as $$ select private.set_business_presence(business, next_status, is_open); $$;
revoke all on function public.set_business_presence(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.set_business_presence(uuid, text, boolean) to authenticated;

-- ───────────────── medios por comercio ─────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('business-media', 'business-media', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Extrae el comercio dueño del archivo sólo si la ruta es exactamente la esperada.
create function private.media_business(path text) returns uuid
language sql immutable security invoker set search_path = '' as $$
  select case when path ~ '^businesses/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(logo|cover|products)/[^/].*$'
    then (split_part(path, '/', 2))::uuid end;
$$;
revoke all on function private.media_business(text) from public, anon, authenticated;
grant execute on function private.media_business(text) to authenticated;

-- Escritura acotada al propio comercio; `upsert` necesita INSERT, SELECT y UPDATE.
create policy business_media_read on storage.objects for select to authenticated
using (bucket_id = 'business-media'
  and (private.is_business_member(private.media_business(name), array['owner', 'manager', 'staff'])
    or (select private.is_admin())));
create policy business_media_insert on storage.objects for insert to authenticated
with check (bucket_id = 'business-media'
  and private.is_business_member(private.media_business(name), array['owner', 'manager']));
create policy business_media_update on storage.objects for update to authenticated
using (bucket_id = 'business-media'
  and private.is_business_member(private.media_business(name), array['owner', 'manager']))
with check (bucket_id = 'business-media'
  and private.is_business_member(private.media_business(name), array['owner', 'manager']));
create policy business_media_delete on storage.objects for delete to authenticated
using (bucket_id = 'business-media'
  and private.is_business_member(private.media_business(name), array['owner', 'manager']));

commit;
