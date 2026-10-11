-- CAUCE · Ferias — administración (auditable), suscripciones manuales del
-- piloto, comunidad fundadora con consentimiento, contrato de esquema y
-- consultas públicas agregadas.
begin;

-- ───────────────── contrato de esquema ─────────────────
create function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schema', 20261011120500,
    'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
    'now', now(),
    'today', private.today_ar());
$$;
revoke all on function private.app_status() from public, anon, authenticated;
grant execute on function private.app_status() to anon, authenticated;
create function public.app_status() returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.app_status(); $$;
revoke all on function public.app_status() from public, anon, authenticated;
grant execute on function public.app_status() to anon, authenticated;

-- ───────────────── consultas públicas ─────────────────
-- Ferias visibles con cantidad de expositores y sus primeros logos. Sólo datos
-- públicos: corre con los permisos de quien consulta (RLS).
create function public.public_fairs(locality text default null, from_date date default null,
  to_date date default null, search text default null, max_rows integer default 60)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.starts_at), '[]'::jsonb) from (
    select f.id, f.slug, f.name, f.venue, f.address, f.latitude, f.longitude, f.starts_at, f.ends_at,
      f.status, f.cover_path, f.applications_open, f.stall_capacity, f.cancel_reason,
      l.slug as locality_slug, l.name as locality_name, o.name as organizer_name, o.slug as organizer_slug,
      (select count(*) from public.fair_participations p join public.businesses b on b.id = p.business_id
        where p.fair_id = f.id and p.status = 'confirmed' and b.status = 'active') as participants,
      (select coalesce(jsonb_agg(x.logo_path), '[]'::jsonb) from (
        select b.logo_path from public.fair_participations p join public.businesses b on b.id = p.business_id
        where p.fair_id = f.id and p.status = 'confirmed' and b.status = 'active' and b.logo_path is not null
        order by p.decided_at nulls last limit 4) x) as participant_logos
    from public.fairs f
    join public.localities l on l.id = f.locality_id
    join public.organizers o on o.id = f.organizer_id
    where f.status in ('published', 'canceled')
      and f.ends_at > coalesce(from_date::timestamptz, now())
      and (to_date is null or f.starts_at < (to_date + 1)::timestamptz)
      and (locality is null or l.slug = locality)
      and (search is null or length(btrim(search)) < 2
        or f.name ilike '%' || replace(replace(btrim(search), '%', ''), '_', '') || '%'
        or f.venue ilike '%' || replace(replace(btrim(search), '%', ''), '_', '') || '%')
    order by f.starts_at
    limit least(greatest(coalesce(max_rows, 60), 1), 200)) t;
$$;
revoke all on function public.public_fairs(text, date, date, text, integer) from public, anon, authenticated;
grant execute on function public.public_fairs(text, date, date, text, integer) to anon, authenticated;

-- Próximas ferias confirmadas de un comercio (para su tienda y el checkout).
create function public.business_fairs(business uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('fair_id', f.id, 'slug', f.slug, 'name', f.name, 'venue', f.venue,
      'address', f.address, 'starts_at', f.starts_at, 'ends_at', f.ends_at, 'stall_code', p.stall_code,
      'latitude', f.latitude, 'longitude', f.longitude, 'locality_name', l.name) order by f.starts_at), '[]'::jsonb)
  from public.fair_participations p
  join public.fairs f on f.id = p.fair_id
  join public.localities l on l.id = f.locality_id
  where p.business_id = business and p.status = 'confirmed' and f.status = 'published' and f.ends_at > now();
$$;
revoke all on function public.business_fairs(uuid) from public, anon, authenticated;
grant execute on function public.business_fairs(uuid) to anon, authenticated;

-- ───────────────── administración ─────────────────
create function private.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare today date := private.today_ar();
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'businesses', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*) as n from public.businesses group by status) s),
    'pending_review', (select count(*) from public.businesses where status = 'pending_review'),
    'subscriptions_expiring', (select count(*) from public.subscriptions s
      where s.status <> 'canceled' and s.period_end between today and today + 7),
    'subscriptions_in_grace', (select count(*) from public.subscriptions s
      where s.status <> 'canceled' and today > s.period_end and today <= s.period_end + s.grace_days),
    'subscriptions_expired', (select count(*) from public.subscriptions s
      where s.status = 'canceled' or today > s.period_end + s.grace_days),
    'orders_today', (select count(*) from public.orders o
      where (o.created_at at time zone 'America/Argentina/Salta')::date = today),
    'orders_week', (select count(*) from public.orders o where o.created_at > now() - interval '7 days'),
    'gross_week_ars', (select coalesce(sum(o.total_ars), 0) from public.orders o
      where o.created_at > now() - interval '7 days' and o.status = 'delivered'),
    'open_orders', (select count(*) from public.orders o where o.status not in ('delivered', 'canceled')),
    'stale_orders', (select count(*) from public.orders o where o.status = 'submitted'
      and o.created_at < now() - interval '24 hours'),
    'fairs_upcoming', (select count(*) from public.fairs f where f.status = 'published' and f.ends_at > now()),
    'organizers', (select count(*) from public.organizers),
    'founding_new', (select count(*) from private.founding_applications a where a.status = 'new'),
    'errors_day', (select count(*) from private.client_events e where e.created_at > now() - interval '1 day'));
end;
$$;

create function private.admin_businesses() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'slug', b.slug, 'status', b.status, 'created_at', b.created_at,
      'locality', l.name, 'category', c.name, 'logo_path', b.logo_path,
      'owner_email', (select u.email from public.business_memberships m join auth.users u on u.id = m.user_id
        where m.business_id = b.id and m.role = 'owner' limit 1),
      'contact', jsonb_build_object('name', ct.owner_name, 'phone', ct.phone),
      'products', (select count(*) from public.products p where p.business_id = b.id and not p.archived),
      'missing', private.business_missing_requirements(b.id),
      'entitlements', private.business_entitlements(b.id),
      'subscription', (select jsonb_build_object('plan', s.plan_code, 'status', s.status, 'period_end', s.period_end,
        'grace_days', s.grace_days, 'note', s.note) from public.subscriptions s where s.business_id = b.id),
      'last_review_note', (select e.note from public.business_review_events e where e.business_id = b.id
        order by e.created_at desc limit 1))
    order by case b.status when 'pending_review' then 0 when 'active' then 1 else 2 end, b.created_at desc)
    from public.businesses b
    join public.localities l on l.id = b.locality_id
    left join public.categories c on c.id = b.category_id
    left join public.business_contacts ct on ct.business_id = b.id), '[]'::jsonb);
end;
$$;

create function private.admin_organizers() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status,
      'members', (select coalesce(jsonb_agg(jsonb_build_object('email', u.email, 'role', m.role)), '[]'::jsonb)
        from public.organizer_members m join auth.users u on u.id = m.user_id where m.organizer_id = o.id),
      'fairs', (select count(*) from public.fairs f where f.organizer_id = o.id),
      'entitlements', private.organizer_entitlements(o.id),
      'subscription', (select jsonb_build_object('plan', s.plan_code, 'status', s.status, 'period_end', s.period_end,
        'grace_days', s.grace_days, 'note', s.note) from public.subscriptions s where s.organizer_id = o.id))
    order by o.created_at desc) from public.organizers o), '[]'::jsonb);
end;
$$;

-- Alta de organizador: sólo administración, con su titular por correo.
create function private.admin_create_organizer(organizer_name text, owner_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare target uuid; base text; candidate text; n integer := 1; organizer uuid;
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  if length(btrim(coalesce(organizer_name, ''))) not between 2 and 80 then
    raise exception 'Invalid organizer name' using errcode = '23514';
  end if;
  select u.id into target from auth.users u where lower(u.email) = lower(btrim(coalesce(owner_email, '')))
    and coalesce(u.is_anonymous, false) = false and u.deleted_at is null;
  if target is null then raise exception 'No account with that email' using errcode = 'P0002'; end if;
  base := private.slug_from(organizer_name, 'organizacion');
  candidate := base;
  while exists (select 1 from public.organizers where slug = candidate) loop
    n := n + 1; candidate := base || '-' || n;
  end loop;
  insert into public.organizers (name, slug) values (btrim(organizer_name), candidate) returning id into organizer;
  insert into public.organizer_members (organizer_id, user_id, role) values (organizer, target, 'owner');
  perform private.audit('admin', 'organizer.created', 'organizer', organizer, jsonb_build_object('name', organizer_name));
  return organizer;
end;
$$;

create function private.admin_set_organizer_status(organizer uuid, next_status text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  if next_status not in ('active', 'suspended') then raise exception 'Invalid decision' using errcode = '23514'; end if;
  update public.organizers set status = next_status where id = organizer;
  if not found then raise exception 'Organizer not found' using errcode = 'P0002'; end if;
  perform private.audit('admin', 'organizer.' || next_status, 'organizer', organizer, '{}'::jsonb);
  return next_status;
end;
$$;

-- Suspender o rehabilitar un comercio (con motivo y auditoría).
create function private.admin_set_business_status(business uuid, next_status text, note text) returns text
language plpgsql security definer set search_path = '' as $$
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
  update public.businesses set status = next_status where id = business;
  insert into public.business_review_events (business_id, from_status, to_status, actor_id, actor_role, note)
    values (business, current, next_status, (select auth.uid()), 'admin', left(coalesce(note, ''), 400));
  perform private.audit('admin', 'business.' || next_status, 'business', business,
    jsonb_build_object('note', left(coalesce(note, ''), 200)));
  return next_status;
end;
$$;

-- Suscripción manual del piloto (sin cobro automático). Cambiar de plan,
-- extender el período o cancelar nunca cancela pedidos en curso.
create function private.admin_set_subscription(business uuid, organizer uuid, plan text, plan_status text,
  period_end date, grace_days integer, note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare sub public.subscriptions;
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  if num_nonnulls(business, organizer) <> 1 then raise exception 'Choose one subject' using errcode = '23514'; end if;
  if plan_status not in ('trial', 'active', 'canceled') then raise exception 'Invalid status' using errcode = '23514'; end if;
  if period_end is null or period_end > private.today_ar() + 400 then
    raise exception 'Invalid period' using errcode = '23514';
  end if;
  if business is not null and not exists (select 1 from public.businesses where id = business) then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;
  if organizer is not null and not exists (select 1 from public.organizers where id = organizer) then
    raise exception 'Organizer not found' using errcode = 'P0002';
  end if;
  if business is not null then
    insert into public.subscriptions (business_id, plan_code, status, period_end, grace_days, note, updated_by)
    values (business, plan, plan_status, period_end, coalesce(grace_days, 10), left(coalesce(note, ''), 300), (select auth.uid()))
    on conflict (business_id) do update set plan_code = excluded.plan_code, status = excluded.status,
      period_end = excluded.period_end, grace_days = excluded.grace_days, note = excluded.note,
      updated_by = excluded.updated_by
    returning * into sub;
  else
    insert into public.subscriptions (organizer_id, plan_code, status, period_end, grace_days, note, updated_by)
    values (organizer, plan, plan_status, period_end, coalesce(grace_days, 10), left(coalesce(note, ''), 300), (select auth.uid()))
    on conflict (organizer_id) do update set plan_code = excluded.plan_code, status = excluded.status,
      period_end = excluded.period_end, grace_days = excluded.grace_days, note = excluded.note,
      updated_by = excluded.updated_by
    returning * into sub;
  end if;
  perform private.audit('admin', 'subscription.set', 'subscription', coalesce(business, organizer),
    jsonb_build_object('plan', plan, 'status', plan_status, 'period_end', period_end, 'grace_days', grace_days));
  return to_jsonb(sub);
end;
$$;

create function private.admin_audit_log(max_rows integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'actor_role', a.actor_role,
      'actor_email', u.email, 'action', a.action, 'entity', a.entity, 'entity_id', a.entity_id, 'detail', a.detail)
      order by a.at desc)
    from (select * from private.audit_log order by at desc limit least(greatest(coalesce(max_rows, 50), 1), 200)) a
    left join auth.users u on u.id = a.actor_id), '[]'::jsonb);
end;
$$;

create function private.admin_client_events(max_rows integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(e) - 'user_id' order by e.created_at desc)
    from (select * from private.client_events order by created_at desc
      limit least(greatest(coalesce(max_rows, 50), 1), 200)) e), '[]'::jsonb);
end;
$$;

-- ───────────────── comunidad fundadora ─────────────────
-- Preinscripción con consentimiento explícito, en este proyecto aislado. No se
-- mezcla con ninguna otra base. Se pide una sesión (anónima sirve) para poner
-- techo por persona; la administración puede borrar una solicitud a pedido.
create table private.founding_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_id uuid not null,
  name text not null check (length(btrim(name)) between 2 and 80),
  business_name text not null default '' check (length(business_name) <= 80),
  locality_id uuid references public.localities(id),
  category_id uuid references public.categories(id),
  contact text not null check (length(btrim(contact)) between 6 and 120),
  sells_at_fairs boolean not null default false,
  message text not null default '' check (length(message) <= 400),
  consent_version text not null check (length(consent_version) between 1 and 20),
  consented_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new', 'contacted', 'joined', 'declined'))
);
create index founding_applications_recent on private.founding_applications(created_at desc);
alter table private.founding_applications enable row level security;
revoke all on private.founding_applications from public, anon, authenticated;
create policy founding_no_client on private.founding_applications for all to anon, authenticated
using (false) with check (false);

create function private.apply_founding(payload jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); contact text; name text;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not private.feature_enabled('founding_community') then
    raise exception 'Feature disabled' using errcode = '42501';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' or coalesce((payload ->> 'consent')::boolean, false) is not true then
    raise exception 'Consent required' using errcode = '23514';
  end if;
  name := btrim(coalesce(payload ->> 'name', ''));
  contact := btrim(coalesce(payload ->> 'contact', ''));
  if length(name) not between 2 and 80 then raise exception 'Invalid contact name' using errcode = '23514'; end if;
  if length(contact) not between 6 and 120
     or not (contact ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or contact ~ '^[0-9 +()-]{6,24}$') then
    raise exception 'Invalid contact' using errcode = '23514';
  end if;
  if (select count(*) from private.founding_applications a where a.session_id = caller
      and a.created_at > now() - interval '1 day') >= 3
     or (select count(*) from private.founding_applications a where a.created_at > now() - interval '1 day') >= 300 then
    raise exception 'Too many requests' using errcode = 'U0006';
  end if;
  insert into private.founding_applications (session_id, name, business_name, locality_id, category_id, contact,
    sells_at_fairs, message, consent_version)
  values (caller, name, left(btrim(coalesce(payload ->> 'business_name', '')), 80),
    (select id from public.localities where slug = payload ->> 'locality'),
    (select id from public.categories where slug = payload ->> 'category'),
    contact, coalesce((payload ->> 'sells_at_fairs')::boolean, false),
    left(btrim(coalesce(payload ->> 'message', '')), 400), left(coalesce(payload ->> 'consent_version', 'v1'), 20));
  return true;
end;
$$;
revoke all on function private.apply_founding(jsonb) from public, anon, authenticated;
grant execute on function private.apply_founding(jsonb) to authenticated;
create function public.apply_founding(payload jsonb) returns boolean
language sql security invoker set search_path = ''
as $$ select private.apply_founding(payload); $$;
revoke all on function public.apply_founding(jsonb) from public, anon, authenticated;
grant execute on function public.apply_founding(jsonb) to authenticated;

create function private.admin_founding_applications() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'created_at', a.created_at, 'name', a.name,
      'business_name', a.business_name, 'locality', l.name, 'category', c.name, 'contact', a.contact,
      'sells_at_fairs', a.sells_at_fairs, 'message', a.message, 'status', a.status,
      'consent_version', a.consent_version, 'consented_at', a.consented_at) order by a.created_at desc)
    from private.founding_applications a
    left join public.localities l on l.id = a.locality_id
    left join public.categories c on c.id = a.category_id), '[]'::jsonb);
end;
$$;

create function private.admin_update_founding(application uuid, next_status text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  if next_status = 'deleted' then
    delete from private.founding_applications where id = application;
  elsif next_status in ('new', 'contacted', 'joined', 'declined') then
    update private.founding_applications set status = next_status where id = application;
  else
    raise exception 'Invalid status' using errcode = '23514';
  end if;
  if not found then raise exception 'Application not found' using errcode = 'P0002'; end if;
  perform private.audit('admin', 'founding.' || next_status, 'founding', application, '{}'::jsonb);
  return next_status;
end;
$$;

-- ───────────────── envoltorios públicos de administración ─────────────────
do $$
declare spec text[];
begin
  foreach spec slice 1 in array array[
    array['admin_overview', '', 'jsonb', 'stable'],
    array['admin_businesses', '', 'jsonb', 'stable'],
    array['admin_organizers', '', 'jsonb', 'stable'],
    array['admin_founding_applications', '', 'jsonb', 'stable']
  ] loop
    execute format('revoke all on function private.%I() from public, anon, authenticated', spec[1]);
    execute format('grant execute on function private.%I() to authenticated', spec[1]);
    execute format('create function public.%I() returns %s language sql %s security invoker set search_path = '''' as $f$ select private.%I(); $f$',
      spec[1], spec[3], spec[4], spec[1]);
    execute format('revoke all on function public.%I() from public, anon, authenticated', spec[1]);
    execute format('grant execute on function public.%I() to authenticated', spec[1]);
  end loop;
end;
$$;

revoke all on function private.admin_create_organizer(text, text) from public, anon, authenticated;
grant execute on function private.admin_create_organizer(text, text) to authenticated;
create function public.admin_create_organizer(organizer_name text, owner_email text) returns uuid
language sql security invoker set search_path = ''
as $$ select private.admin_create_organizer(organizer_name, owner_email); $$;
revoke all on function public.admin_create_organizer(text, text) from public, anon, authenticated;
grant execute on function public.admin_create_organizer(text, text) to authenticated;

revoke all on function private.admin_set_organizer_status(uuid, text) from public, anon, authenticated;
grant execute on function private.admin_set_organizer_status(uuid, text) to authenticated;
create function public.admin_set_organizer_status(organizer uuid, next_status text) returns text
language sql security invoker set search_path = ''
as $$ select private.admin_set_organizer_status(organizer, next_status); $$;
revoke all on function public.admin_set_organizer_status(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_organizer_status(uuid, text) to authenticated;

revoke all on function private.admin_set_business_status(uuid, text, text) from public, anon, authenticated;
grant execute on function private.admin_set_business_status(uuid, text, text) to authenticated;
create function public.admin_set_business_status(business uuid, next_status text, note text default '') returns text
language sql security invoker set search_path = ''
as $$ select private.admin_set_business_status(business, next_status, note); $$;
revoke all on function public.admin_set_business_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_business_status(uuid, text, text) to authenticated;

revoke all on function private.admin_set_subscription(uuid, uuid, text, text, date, integer, text) from public, anon, authenticated;
grant execute on function private.admin_set_subscription(uuid, uuid, text, text, date, integer, text) to authenticated;
create function public.admin_set_subscription(business uuid default null, organizer uuid default null,
  plan text default 'entrada', plan_status text default 'active', period_end date default null,
  grace_days integer default 10, note text default '') returns jsonb
language sql security invoker set search_path = ''
as $$ select private.admin_set_subscription(business, organizer, plan, plan_status, period_end, grace_days, note); $$;
revoke all on function public.admin_set_subscription(uuid, uuid, text, text, date, integer, text) from public, anon, authenticated;
grant execute on function public.admin_set_subscription(uuid, uuid, text, text, date, integer, text) to authenticated;

revoke all on function private.admin_audit_log(integer) from public, anon, authenticated;
grant execute on function private.admin_audit_log(integer) to authenticated;
create function public.admin_audit_log(max_rows integer default 50) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.admin_audit_log(max_rows); $$;
revoke all on function public.admin_audit_log(integer) from public, anon, authenticated;
grant execute on function public.admin_audit_log(integer) to authenticated;

revoke all on function private.admin_client_events(integer) from public, anon, authenticated;
grant execute on function private.admin_client_events(integer) to authenticated;
create function public.admin_client_events(max_rows integer default 50) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.admin_client_events(max_rows); $$;
revoke all on function public.admin_client_events(integer) from public, anon, authenticated;
grant execute on function public.admin_client_events(integer) to authenticated;

revoke all on function private.admin_update_founding(uuid, text) from public, anon, authenticated;
grant execute on function private.admin_update_founding(uuid, text) to authenticated;
create function public.admin_update_founding(application uuid, next_status text) returns text
language sql security invoker set search_path = ''
as $$ select private.admin_update_founding(application, next_status); $$;
revoke all on function public.admin_update_founding(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_update_founding(uuid, text) to authenticated;

commit;
