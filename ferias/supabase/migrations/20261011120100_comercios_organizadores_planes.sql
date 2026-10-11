-- CAUCE · Ferias — comercios, organizadores, planes y suscripciones.
-- Los límites de cada plan se validan en la base (triggers y funciones), nunca
-- sólo ocultando botones. Dinero en ARS enteros (bigint).
begin;

-- ───────────────── rubros (categorías globales del catálogo) ─────────────────
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(btrim(name)) between 2 and 40),
  icon text not null default 'otros' check (icon ~ '^[a-z-]{2,24}$'),
  position smallint not null default 0,
  active boolean not null default true
);
insert into public.categories (slug, name, icon, position) values
  ('ceramica', 'Cerámica', 'ceramica', 10),
  ('textiles', 'Textiles', 'textiles', 20),
  ('joyeria', 'Joyería', 'joyeria', 30),
  ('decoracion', 'Decoración', 'decoracion', 40),
  ('cuero', 'Cuero', 'cuero', 50),
  ('arte', 'Arte', 'arte', 60),
  ('regionales', 'Productos regionales', 'regionales', 70),
  ('otros', 'Otros', 'otros', 99);

-- ───────────────── planes ─────────────────
-- Precios orientativos del piloto (hipótesis a validar con los feriantes).
create table public.plans (
  code text primary key check (code ~ '^[a-z_]{3,24}$'),
  name text not null check (length(btrim(name)) between 3 and 40),
  audience text not null check (audience in ('business', 'organizer')),
  monthly_price_ars bigint not null check (monthly_price_ars between 0 and 10000000),
  max_products integer not null default 0 check (max_products between 0 and 1000),
  max_images_per_product smallint not null default 1 check (max_images_per_product between 1 and 12),
  staff_seats smallint not null default 0 check (staff_seats between 0 and 10),
  fair_pickup boolean not null default false,
  advanced_stats boolean not null default false,
  featured boolean not null default false,
  max_active_fairs smallint not null default 0 check (max_active_fairs between 0 and 100),
  summary text not null default '' check (length(summary) <= 200),
  position smallint not null default 0,
  active boolean not null default true
);
insert into public.plans (code, name, audience, monthly_price_ars, max_products, max_images_per_product,
  staff_seats, fair_pickup, advanced_stats, featured, max_active_fairs, summary, position) values
  ('entrada', 'Plan de entrada', 'business', 9900, 20, 3, 0, false, false, false, 0,
    'Tu tienda online con enlace y QR, hasta 20 productos, retiro acordado y envío propio.', 10),
  ('feriante', 'Plan Feriante', 'business', 14900, 60, 5, 1, true, false, false, 0,
    'Todo lo anterior, retiro en tu puesto de feria, hasta 60 productos y una persona de ayuda.', 20),
  ('pro', 'Emprendedor Pro', 'business', 24900, 100, 8, 3, true, true, true, 0,
    'Hasta 100 productos, estadísticas ampliadas, tienda recomendada y equipo de 3 personas.', 30),
  ('organizador', 'Plan Organizador', 'organizer', 29900, 0, 1, 0, false, false, false, 10,
    'Publicá ferias, gestioná inscripciones, puestos y avisos a participantes.', 40);

-- ───────────────── comercios ─────────────────
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  locality_id uuid not null references public.localities(id),
  category_id uuid references public.categories(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  slug text not null unique check (length(slug) between 3 and 60 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'returned', 'active', 'paused', 'suspended')),
  tagline text not null default '' check (length(tagline) <= 140),
  description text not null default '' check (length(description) <= 1200),
  logo_path text check (logo_path is null or logo_path like 'businesses/' || id::text || '/logo/%'),
  cover_path text check (cover_path is null or cover_path like 'businesses/' || id::text || '/cover/%'),
  public_phone text not null default '' check (public_phone ~ '^[0-9 +()-]{0,24}$'),
  whatsapp text not null default '' check (whatsapp ~ '^([0-9]{8,15})?$'),
  instagram text not null default '' check (instagram ~ '^[A-Za-z0-9._]{0,30}$'),
  -- Formas de entrega: retiro acordado, retiro en el puesto de una feria y envío propio.
  pickup_enabled boolean not null default true,
  pickup_area text not null default '' check (length(pickup_area) <= 160),
  fair_pickup_enabled boolean not null default true,
  delivery_enabled boolean not null default false,
  delivery_zone text not null default '' check (length(delivery_zone) <= 160),
  -- null: el costo de envío se coordina con quien compra.
  delivery_fee_ars bigint check (delivery_fee_ars is null or delivery_fee_ars between 0 and 10000000),
  minimum_order_ars bigint not null default 0 check (minimum_order_ars between 0 and 10000000),
  accepting_orders boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index businesses_visible on public.businesses(locality_id, created_at desc) where status = 'active';
create index businesses_category on public.businesses(category_id);
create trigger businesses_touch before update on public.businesses
  for each row execute function private.touch_updated_at();

create table public.business_memberships (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'staff')),
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index memberships_user on public.business_memberships(user_id, business_id);

-- Contacto privado: sólo el comercio y la administración.
create table public.business_contacts (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  owner_name text not null default '' check (length(owner_name) <= 80),
  phone text not null default '' check (phone ~ '^[0-9 +()-]{0,24}$'),
  email text not null default '' check (length(email) <= 120),
  updated_at timestamptz not null default now()
);
create trigger business_contacts_touch before update on public.business_contacts
  for each row execute function private.touch_updated_at();

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

-- ───────────────── organizadores de ferias ─────────────────
-- Los da de alta la administración: un organizador sólo administra sus ferias.
create table public.organizers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 80),
  slug text not null unique check (length(slug) between 3 and 60 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null default '' check (length(description) <= 400),
  public_phone text not null default '' check (public_phone ~ '^[0-9 +()-]{0,24}$'),
  whatsapp text not null default '' check (whatsapp ~ '^([0-9]{8,15})?$'),
  instagram text not null default '' check (instagram ~ '^[A-Za-z0-9._]{0,30}$'),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizers_touch before update on public.organizers
  for each row execute function private.touch_updated_at();

create table public.organizer_members (
  organizer_id uuid not null references public.organizers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (organizer_id, user_id)
);
create index organizer_members_user on public.organizer_members(user_id, organizer_id);

-- ───────────────── suscripciones ─────────────────
-- Una fila por comercio u organizador. El estado efectivo (vigente, en gracia,
-- vencida) se calcula con la fecha: nada se corta por una tarea programada.
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid unique references public.businesses(id) on delete cascade,
  organizer_id uuid unique references public.organizers(id) on delete cascade,
  plan_code text not null references public.plans(code),
  status text not null check (status in ('trial', 'active', 'canceled')),
  period_end date not null,
  grace_days smallint not null default 10 check (grace_days between 0 and 60),
  note text not null default '' check (length(note) <= 300),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_one_subject check (num_nonnulls(business_id, organizer_id) = 1)
);
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function private.touch_updated_at();

-- Un plan de organizador no se asigna a un comercio, ni al revés.
create function private.check_subscription_audience() returns trigger
language plpgsql security definer set search_path = '' as $$
declare audience text;
begin
  select p.audience into audience from public.plans p where p.code = new.plan_code;
  if (new.business_id is not null and audience <> 'business')
     or (new.organizer_id is not null and audience <> 'organizer') then
    raise exception 'Plan does not match subject' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.check_subscription_audience() from public, anon, authenticated;
create trigger subscriptions_audience before insert or update on public.subscriptions
  for each row execute function private.check_subscription_audience();

-- ───────────────── permisos por rol ─────────────────
create function private.is_business_member(business uuid, allowed_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_permanent_user() and exists (
    select 1 from public.business_memberships
    where business_id = business and user_id = (select auth.uid()) and role = any(allowed_roles));
$$;
revoke all on function private.is_business_member(uuid, text[]) from public, anon, authenticated;
grant execute on function private.is_business_member(uuid, text[]) to anon, authenticated;

create function private.is_organizer_member(organizer uuid, allowed_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_permanent_user() and exists (
    select 1 from public.organizer_members m join public.organizers o on o.id = m.organizer_id
    where m.organizer_id = organizer and m.user_id = (select auth.uid()) and m.role = any(allowed_roles)
      and o.status = 'active');
$$;
revoke all on function private.is_organizer_member(uuid, text[]) from public, anon, authenticated;
grant execute on function private.is_organizer_member(uuid, text[]) to anon, authenticated;

-- ───────────────── estado efectivo y derechos del plan ─────────────────
create function private.subscription_state(plan_status text, period_end date, grace_days smallint)
returns text language sql stable set search_path = '' as $$
  select case
    when plan_status is null then 'none'
    when plan_status = 'canceled' then 'canceled'
    when private.today_ar() <= period_end then plan_status
    when private.today_ar() <= period_end + grace_days then 'grace'
    else 'expired' end;
$$;
revoke all on function private.subscription_state(text, date, smallint) from public, anon, authenticated;

-- Lo que el comercio puede hacer hoy. Sin plan vigente se arma la tienda con
-- los límites del plan de entrada, pero no se venden productos.
create function private.business_entitlements(business uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  sub public.subscriptions;
  plan public.plans;
  state text;
  current boolean;
begin
  select * into sub from public.subscriptions where business_id = business;
  state := private.subscription_state(sub.status, sub.period_end, sub.grace_days);
  current := state in ('trial', 'active', 'grace');
  if current then
    select * into plan from public.plans where code = sub.plan_code;
  else
    select * into plan from public.plans where code = 'entrada';
  end if;
  return jsonb_build_object(
    'plan', case when current then plan.code end,
    'plan_name', case when current then plan.name end,
    'subscribed_plan', sub.plan_code,
    'state', state,
    'period_end', sub.period_end,
    'grace_until', case when sub.id is not null then sub.period_end + sub.grace_days end,
    'max_products', plan.max_products,
    'max_images', plan.max_images_per_product,
    'staff_seats', plan.staff_seats,
    'fair_pickup', current and plan.fair_pickup,
    'advanced_stats', current and plan.advanced_stats,
    'featured', current and plan.featured,
    'can_sell', current);
end;
$$;
revoke all on function private.business_entitlements(uuid) from public, anon, authenticated;
grant execute on function private.business_entitlements(uuid) to anon, authenticated;

create function private.organizer_entitlements(organizer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare sub public.subscriptions; plan public.plans; state text; current boolean;
begin
  select * into sub from public.subscriptions where organizer_id = organizer;
  state := private.subscription_state(sub.status, sub.period_end, sub.grace_days);
  current := state in ('trial', 'active', 'grace');
  select * into plan from public.plans where code = coalesce(sub.plan_code, 'organizador');
  return jsonb_build_object('plan', case when current then plan.code end,
    'plan_name', case when current then plan.name end, 'state', state, 'period_end', sub.period_end,
    'grace_until', case when sub.id is not null then sub.period_end + sub.grace_days end,
    'max_active_fairs', case when current then plan.max_active_fairs else 0 end,
    'can_publish', current);
end;
$$;
revoke all on function private.organizer_entitlements(uuid) from public, anon, authenticated;
grant execute on function private.organizer_entitlements(uuid) to authenticated;

-- Recibe pedidos ahora: publicado, sin pausa del comercio y con plan vigente.
create function private.business_can_sell(business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select b.status = 'active' and b.accepting_orders from public.businesses b where b.id = business), false)
    and coalesce((private.business_entitlements(business) ->> 'can_sell')::boolean, false);
$$;
revoke all on function private.business_can_sell(uuid) from public, anon, authenticated;
grant execute on function private.business_can_sell(uuid) to anon, authenticated;

create function private.business_is_featured(business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((private.business_entitlements(business) ->> 'featured')::boolean, false);
$$;
revoke all on function private.business_is_featured(uuid) from public, anon, authenticated;
grant execute on function private.business_is_featured(uuid) to anon, authenticated;

-- Campos calculados para la API: `select=*,taking_orders,featured`.
create function public.taking_orders(public.businesses) returns boolean
language sql stable set search_path = '' as $$ select private.business_can_sell($1.id); $$;
create function public.featured(public.businesses) returns boolean
language sql stable set search_path = '' as $$ select private.business_is_featured($1.id); $$;
revoke all on function public.taking_orders(public.businesses), public.featured(public.businesses)
  from public, anon, authenticated;
grant execute on function public.taking_orders(public.businesses), public.featured(public.businesses)
  to anon, authenticated;

-- Ofrece retiro en el puesto: lo activó la tienda y su plan lo incluye.
create function private.business_offers_fair_pickup(business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select b.fair_pickup_enabled from public.businesses b where b.id = business), false)
    and coalesce((private.business_entitlements(business) ->> 'fair_pickup')::boolean, false);
$$;
revoke all on function private.business_offers_fair_pickup(uuid) from public, anon, authenticated;
grant execute on function private.business_offers_fair_pickup(uuid) to anon, authenticated;
create function public.offers_fair_pickup(public.businesses) returns boolean
language sql stable set search_path = '' as $$ select private.business_offers_fair_pickup($1.id); $$;
revoke all on function public.offers_fair_pickup(public.businesses) from public, anon, authenticated;
grant execute on function public.offers_fair_pickup(public.businesses) to anon, authenticated;

-- ───────────────── privilegios ─────────────────
alter table public.categories enable row level security;
alter table public.plans enable row level security;
alter table public.businesses enable row level security;
alter table public.business_memberships enable row level security;
alter table public.business_contacts enable row level security;
alter table public.business_review_events enable row level security;
alter table public.organizers enable row level security;
alter table public.organizer_members enable row level security;
alter table public.subscriptions enable row level security;

revoke all on public.categories, public.plans, public.businesses, public.business_memberships,
  public.business_contacts, public.business_review_events, public.organizers, public.organizer_members,
  public.subscriptions from public, anon, authenticated;

grant select on public.categories, public.plans, public.businesses, public.organizers to anon, authenticated;
grant select on public.business_memberships, public.business_contacts, public.business_review_events,
  public.organizer_members, public.subscriptions to authenticated;
-- `status`, `slug` y fechas quedan fuera del alcance del cliente.
grant update (locality_id, category_id, name, tagline, description, logo_path, cover_path, public_phone, whatsapp,
  instagram, pickup_enabled, pickup_area, fair_pickup_enabled, delivery_enabled, delivery_zone, delivery_fee_ars,
  minimum_order_ars, accepting_orders) on public.businesses to authenticated;
grant insert (business_id, owner_name, phone, email), update (owner_name, phone, email)
  on public.business_contacts to authenticated;
grant update (name, description, public_phone, whatsapp, instagram) on public.organizers to authenticated;

-- ───────────────── políticas ─────────────────
create policy categories_public on public.categories for select to anon, authenticated using (active);
create policy plans_public on public.plans for select to anon, authenticated using (active);

create policy business_read_anon on public.businesses for select to anon
using (status = 'active');
create policy business_read_auth on public.businesses for select to authenticated
using (status = 'active'
  or private.is_business_member(id, array['owner', 'manager', 'staff'])
  or (select private.is_admin()));
create policy business_edit on public.businesses for update to authenticated
using (private.is_business_member(id, array['owner', 'manager']))
with check (private.is_business_member(id, array['owner', 'manager']));

create policy membership_read on public.business_memberships for select to authenticated
using (user_id = (select auth.uid()) or (select private.is_admin()));

create policy contacts_read on public.business_contacts for select to authenticated
using (private.is_business_member(business_id, array['owner', 'manager', 'staff']) or (select private.is_admin()));
create policy contacts_insert on public.business_contacts for insert to authenticated
with check (private.is_business_member(business_id, array['owner', 'manager']));
create policy contacts_update on public.business_contacts for update to authenticated
using (private.is_business_member(business_id, array['owner', 'manager']))
with check (private.is_business_member(business_id, array['owner', 'manager']));

create policy review_events_read on public.business_review_events for select to authenticated
using (private.is_business_member(business_id, array['owner', 'manager', 'staff']) or (select private.is_admin()));

create policy organizers_read_anon on public.organizers for select to anon using (status = 'active');
create policy organizers_read_auth on public.organizers for select to authenticated
using (status = 'active' or private.is_organizer_member(id, array['owner', 'editor']) or (select private.is_admin()));
create policy organizers_edit on public.organizers for update to authenticated
using (private.is_organizer_member(id, array['owner']))
with check (private.is_organizer_member(id, array['owner']));
create policy organizer_members_read on public.organizer_members for select to authenticated
using (user_id = (select auth.uid()) or (select private.is_admin()));

create policy subscriptions_read on public.subscriptions for select to authenticated
using ((business_id is not null and private.is_business_member(business_id, array['owner', 'manager']))
  or (organizer_id is not null and private.is_organizer_member(organizer_id, array['owner']))
  or (select private.is_admin()));

-- ───────────────── alta del comercio ─────────────────
-- Crea el borrador y su titular de forma atómica. El slug se resuelve en el
-- servidor: si está tomado, se le agrega un sufijo.
create function private.create_business(business_name text, locality_slug text, category_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  locality uuid;
  category uuid;
  base text;
  candidate text;
  n integer := 1;
  business uuid;
  clean_name text := btrim(coalesce(business_name, ''));
begin
  if not private.is_permanent_user() then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not private.feature_enabled('merchant_signup') then
    raise exception 'Feature disabled' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where user_id = caller) then
    raise exception 'Complete your profile first' using errcode = '23514';
  end if;
  if length(clean_name) not between 2 and 80 then
    raise exception 'Invalid business name' using errcode = '23514';
  end if;
  if (select count(*) from public.business_memberships where user_id = caller and role = 'owner') >= 3 then
    raise exception 'Business limit reached' using errcode = '23514';
  end if;
  select id into locality from public.localities where slug = locality_slug and active;
  if locality is null then raise exception 'Locality unavailable' using errcode = '23514'; end if;
  if coalesce(category_slug, '') <> '' then
    select id into category from public.categories where slug = category_slug and active;
  end if;
  -- slug: minúsculas sin tildes ni signos.
  base := lower(translate(clean_name, 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'));
  base := btrim(regexp_replace(base, '[^a-z0-9]+', '-', 'g'), '-');
  base := left(case when length(base) < 3 then 'tienda-' || base else base end, 50);
  base := btrim(base, '-');
  candidate := base;
  while exists (select 1 from public.businesses where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  insert into public.businesses (locality_id, category_id, name, slug)
    values (locality, category, clean_name, candidate) returning id into business;
  insert into public.business_memberships (business_id, user_id, role) values (business, caller, 'owner');
  insert into public.business_contacts (business_id, owner_name, phone, email)
    select business, p.display_name, p.phone, coalesce((select u.email from auth.users u where u.id = caller), '')
    from public.profiles p where p.user_id = caller;
  return jsonb_build_object('id', business, 'slug', candidate);
end;
$$;
revoke all on function private.create_business(text, text, text) from public, anon, authenticated;
grant execute on function private.create_business(text, text, text) to authenticated;
create function public.create_business(business_name text, locality_slug text default 'neuquen',
  category_slug text default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.create_business(business_name, locality_slug, category_slug); $$;
revoke all on function public.create_business(text, text, text) from public, anon, authenticated;
grant execute on function public.create_business(text, text, text) to authenticated;

-- ───────────────── equipo del comercio ─────────────────
create type public.team_member as (
  user_id uuid, display_name text, email text, role text, created_at timestamptz, is_self boolean);

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

-- Las personas de ayuda que admite el plan se validan acá.
create function private.add_business_member(business uuid, member_email text, member_role text)
returns text language plpgsql security definer set search_path = '' as $$
declare target uuid; seats integer;
begin
  if not private.is_business_member(business, array['owner']) then
    raise exception 'Only the owner manages the team' using errcode = '42501';
  end if;
  if member_role not in ('manager', 'staff') then raise exception 'Invalid role' using errcode = '23514'; end if;
  seats := (private.business_entitlements(business) ->> 'staff_seats')::int;
  if (select count(*) from public.business_memberships where business_id = business and role <> 'owner') >= seats then
    raise exception 'Plan limit: team' using errcode = 'U0010';
  end if;
  select u.id into target from auth.users u
    where lower(u.email) = lower(btrim(coalesce(member_email, '')))
      and coalesce(u.is_anonymous, false) = false and u.deleted_at is null;
  if target is null then raise exception 'No account with that email' using errcode = 'P0002'; end if;
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

create function private.remove_business_member(business uuid, member uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare current text; caller uuid := (select auth.uid());
begin
  if not private.is_permanent_user() then raise exception 'Authentication required' using errcode = '42501'; end if;
  select role into current from public.business_memberships
    where business_id = business and user_id = member for update;
  if current is null then raise exception 'Member not found' using errcode = 'P0002'; end if;
  if member <> caller and not private.is_business_member(business, array['owner']) then
    raise exception 'Only the owner manages the team' using errcode = '42501';
  end if;
  if current = 'owner' then raise exception 'Ownership changes are administrative' using errcode = '42501'; end if;
  delete from public.business_memberships where business_id = business and user_id = member;
  return true;
end;
$$;
revoke all on function private.remove_business_member(uuid, uuid) from public, anon, authenticated;
grant execute on function private.remove_business_member(uuid, uuid) to authenticated;
create function public.remove_business_member(business uuid, member uuid) returns boolean
language sql security invoker set search_path = ''
as $$ select private.remove_business_member(business, member); $$;
revoke all on function public.remove_business_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_business_member(uuid, uuid) to authenticated;

-- ───────────────── equipo del organizador ─────────────────
create function private.add_organizer_member(organizer uuid, member_email text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if not private.is_organizer_member(organizer, array['owner']) then
    raise exception 'Only the organizer owner manages the team' using errcode = '42501';
  end if;
  if (select count(*) from public.organizer_members where organizer_id = organizer) >= 5 then
    raise exception 'Plan limit: team' using errcode = 'U0010';
  end if;
  select u.id into target from auth.users u
    where lower(u.email) = lower(btrim(coalesce(member_email, '')))
      and coalesce(u.is_anonymous, false) = false and u.deleted_at is null;
  if target is null then raise exception 'No account with that email' using errcode = 'P0002'; end if;
  if exists (select 1 from public.organizer_members where organizer_id = organizer and user_id = target) then
    raise exception 'Already a member' using errcode = '23505';
  end if;
  insert into public.organizer_members (organizer_id, user_id, role) values (organizer, target, 'editor');
  perform private.audit('organizer', 'organizer.member_added', 'organizer', organizer, '{}'::jsonb);
  return true;
end;
$$;
revoke all on function private.add_organizer_member(uuid, text) from public, anon, authenticated;
grant execute on function private.add_organizer_member(uuid, text) to authenticated;
create function public.add_organizer_member(organizer uuid, member_email text) returns boolean
language sql security invoker set search_path = ''
as $$ select private.add_organizer_member(organizer, member_email); $$;
revoke all on function public.add_organizer_member(uuid, text) from public, anon, authenticated;
grant execute on function public.add_organizer_member(uuid, text) to authenticated;

-- Derechos del plan para el panel (con el uso actual). Sólo miembros.
create function private.my_entitlements(business uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_business_member(business, array['owner', 'manager', 'staff']) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  return private.business_entitlements(business) || jsonb_build_object(
    'products_used', (select count(*) from public.products p where p.business_id = business and not p.archived),
    'team_used', (select count(*) from public.business_memberships m where m.business_id = business and m.role <> 'owner'),
    'can_sell_now', private.business_can_sell(business));
end;
$$;
revoke all on function private.my_entitlements(uuid) from public, anon, authenticated;

create function private.organizer_overview(organizer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_organizer_member(organizer, array['owner', 'editor']) then
    raise exception 'Not allowed for this organizer' using errcode = '42501';
  end if;
  return private.organizer_entitlements(organizer) || jsonb_build_object(
    'active_fairs', (select count(*) from public.fairs f where f.organizer_id = organizer
      and f.status = 'published' and f.ends_at > now()));
end;
$$;
revoke all on function private.organizer_overview(uuid) from public, anon, authenticated;

commit;
