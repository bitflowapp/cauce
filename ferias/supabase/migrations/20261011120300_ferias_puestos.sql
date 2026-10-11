-- CAUCE · Ferias — ferias, inscripciones, puestos y avisos del organizador.
-- Un organizador sólo administra las ferias de su organización; un comercio
-- sólo maneja sus propias inscripciones. Todo cambio de estado pasa por RPC.
begin;

create table public.fairs (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.organizers(id) on delete restrict,
  locality_id uuid not null references public.localities(id),
  name text not null check (length(btrim(name)) between 3 and 100),
  slug text not null unique check (length(slug) between 3 and 90 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null default '' check (length(description) <= 1200),
  venue text not null check (length(btrim(venue)) between 2 and 120),
  address text not null default '' check (length(address) <= 200),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'canceled')),
  applications_open boolean not null default true,
  stall_capacity smallint check (stall_capacity is null or stall_capacity between 1 and 2000),
  cover_path text check (cover_path is null or cover_path like 'fairs/' || id::text || '/cover/%'),
  cancel_reason text not null default '' check (length(cancel_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fairs_dates check (ends_at > starts_at and ends_at <= starts_at + interval '14 days'),
  constraint fairs_coordinates check ((latitude is null) = (longitude is null))
);
create index fairs_calendar on public.fairs(starts_at) where status in ('published', 'canceled');
create index fairs_organizer on public.fairs(organizer_id, starts_at desc);
create index fairs_locality on public.fairs(locality_id, starts_at) where status = 'published';
create trigger fairs_touch before update on public.fairs
  for each row execute function private.touch_updated_at();

create table public.fair_participations (
  id uuid primary key default gen_random_uuid(),
  fair_id uuid not null references public.fairs(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'rejected', 'withdrawn')),
  stall_code text check (stall_code is null or stall_code ~ '^[A-Za-z0-9-]{1,12}$'),
  decision_note text not null default '' check (length(decision_note) <= 200),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (fair_id, business_id)
);
-- Un puesto confirmado por persona: dos comercios no comparten el mismo código.
create unique index fair_participations_stall on public.fair_participations(fair_id, upper(stall_code))
  where status = 'confirmed' and stall_code is not null;
create index fair_participations_business on public.fair_participations(business_id, status);
create index fair_participations_fair on public.fair_participations(fair_id, status);
create trigger fair_participations_touch before update on public.fair_participations
  for each row execute function private.touch_updated_at();

create table public.fair_announcements (
  id uuid primary key default gen_random_uuid(),
  fair_id uuid not null references public.fairs(id) on delete cascade,
  body text not null check (length(btrim(body)) between 3 and 600),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index fair_announcements_fair on public.fair_announcements(fair_id, created_at desc);

create function private.fair_organizer(fair uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select organizer_id from public.fairs where id = fair;
$$;
revoke all on function private.fair_organizer(uuid) from public, anon, authenticated;
grant execute on function private.fair_organizer(uuid) to anon, authenticated;

create function private.is_fair_organizer(fair uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_organizer_member(private.fair_organizer(fair), array['owner', 'editor']);
$$;
revoke all on function private.is_fair_organizer(uuid) from public, anon, authenticated;
grant execute on function private.is_fair_organizer(uuid) to anon, authenticated;

-- Participa confirmado en la feria (para leer avisos internos).
create function private.is_fair_participant(fair uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_permanent_user() and exists (
    select 1 from public.fair_participations p
    join public.business_memberships m on m.business_id = p.business_id
    where p.fair_id = fair and p.status = 'confirmed' and m.user_id = (select auth.uid()));
$$;
revoke all on function private.is_fair_participant(uuid) from public, anon, authenticated;
grant execute on function private.is_fair_participant(uuid) to authenticated;

-- ───────────────── privilegios ─────────────────
alter table public.fairs enable row level security;
alter table public.fair_participations enable row level security;
alter table public.fair_announcements enable row level security;
revoke all on public.fairs, public.fair_participations, public.fair_announcements from public, anon, authenticated;

grant select on public.fairs, public.fair_participations to anon, authenticated;
grant select on public.fair_announcements to authenticated;
-- `status`, `organizer_id` y `slug` sólo cambian por funciones.
grant update (locality_id, name, description, venue, address, latitude, longitude, starts_at, ends_at,
  applications_open, stall_capacity, cover_path) on public.fairs to authenticated;
grant insert (fair_id, body), delete on public.fair_announcements to authenticated;

create policy fairs_read_anon on public.fairs for select to anon
using (status in ('published', 'canceled')
  and exists (select 1 from public.organizers o where o.id = organizer_id and o.status = 'active'));
create policy fairs_read_auth on public.fairs for select to authenticated
using ((status in ('published', 'canceled')
    and exists (select 1 from public.organizers o where o.id = organizer_id and o.status = 'active'))
  or private.is_organizer_member(organizer_id, array['owner', 'editor'])
  or (select private.is_admin()));
create policy fairs_update on public.fairs for update to authenticated
using (private.is_organizer_member(organizer_id, array['owner', 'editor']))
with check (private.is_organizer_member(organizer_id, array['owner', 'editor']));

-- Público: quién expone y en qué puesto. Las solicitudes y rechazos, no.
create policy participations_read_anon on public.fair_participations for select to anon
using (status = 'confirmed'
  and exists (select 1 from public.fairs f where f.id = fair_id and f.status in ('published', 'canceled'))
  and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'));
create policy participations_read_auth on public.fair_participations for select to authenticated
using ((status = 'confirmed'
    and exists (select 1 from public.fairs f where f.id = fair_id and f.status in ('published', 'canceled'))
    and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'))
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or private.is_fair_organizer(fair_id)
  or (select private.is_admin()));

create policy announcements_read on public.fair_announcements for select to authenticated
using (private.is_fair_organizer(fair_id) or private.is_fair_participant(fair_id) or (select private.is_admin()));
create policy announcements_insert on public.fair_announcements for insert to authenticated
with check (private.is_fair_organizer(fair_id));
create policy announcements_delete on public.fair_announcements for delete to authenticated
using (private.is_fair_organizer(fair_id));

-- Quien publica un aviso queda registrado por la base, no por el cliente.
create function private.stamp_announcement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin new.created_by := (select auth.uid()); return new; end;
$$;
revoke all on function private.stamp_announcement() from public, anon, authenticated;
create trigger fair_announcements_stamp before insert on public.fair_announcements
  for each row execute function private.stamp_announcement();

-- ───────────────── medios de ferias ─────────────────
create function private.media_fair(path text) returns uuid
language sql immutable set search_path = '' as $$
  select case when path ~ '^fairs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/cover/[0-9a-f-]{36}\.(jpg|png|webp)$'
    then (split_part(path, '/', 2))::uuid end;
$$;
revoke all on function private.media_fair(text) from public, anon, authenticated;
grant execute on function private.media_fair(text) to authenticated;

create function private.fair_media_quota_ok(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from storage.objects o where o.bucket_id = 'ferias-media'
    and o.name like 'fairs/' || private.media_fair(path)::text || '/%') < 10;
$$;
revoke all on function private.fair_media_quota_ok(text) from public, anon, authenticated;
grant execute on function private.fair_media_quota_ok(text) to authenticated;

create policy fair_media_read on storage.objects for select to authenticated
using (bucket_id = 'ferias-media' and private.media_fair(name) is not null
  and (private.is_fair_organizer(private.media_fair(name)) or (select private.is_admin())));
create policy fair_media_insert on storage.objects for insert to authenticated
with check (bucket_id = 'ferias-media' and private.media_fair(name) is not null
  and private.is_fair_organizer(private.media_fair(name)) and private.fair_media_quota_ok(name));
create policy fair_media_delete on storage.objects for delete to authenticated
using (bucket_id = 'ferias-media' and private.media_fair(name) is not null
  and private.is_fair_organizer(private.media_fair(name)));

-- ───────────────── ferias: alta y estado ─────────────────
create function private.slug_from(value text, fallback text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(left(btrim(regexp_replace(lower(translate(coalesce(value, ''),
    'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '[^a-z0-9]+', '-', 'g'), '-'), 70), '-'), ''), fallback);
$$;
revoke all on function private.slug_from(text, text) from public, anon, authenticated;

create function private.create_fair(organizer uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  locality uuid;
  starts timestamptz;
  ends timestamptz;
  base text;
  candidate text;
  n integer := 1;
  fair uuid;
begin
  if not private.is_organizer_member(organizer, array['owner', 'editor']) then
    raise exception 'Not allowed for this organizer' using errcode = '42501';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'Invalid fair' using errcode = '23514';
  end if;
  if (select count(*) from public.fairs f where f.organizer_id = organizer and f.status = 'draft') >= 20 then
    raise exception 'Too many drafts' using errcode = '23514';
  end if;
  select id into locality from public.localities where slug = payload ->> 'locality' and active;
  if locality is null then raise exception 'Locality unavailable' using errcode = '23514'; end if;
  begin
    starts := (payload ->> 'starts_at')::timestamptz;
    ends := (payload ->> 'ends_at')::timestamptz;
  exception when others then
    raise exception 'Invalid dates' using errcode = '23514';
  end;
  if starts is null or ends is null or ends <= starts then
    raise exception 'Invalid dates' using errcode = '23514';
  end if;
  base := private.slug_from((payload ->> 'name') || ' ' || to_char(starts at time zone 'America/Argentina/Salta', 'YYYY-MM-DD'),
    'feria');
  candidate := base;
  while exists (select 1 from public.fairs where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  insert into public.fairs (organizer_id, locality_id, name, slug, description, venue, address, latitude, longitude,
    starts_at, ends_at, applications_open, stall_capacity)
  values (organizer, locality, btrim(coalesce(payload ->> 'name', '')), candidate,
    btrim(coalesce(payload ->> 'description', '')), btrim(coalesce(payload ->> 'venue', '')),
    btrim(coalesce(payload ->> 'address', '')),
    nullif(payload ->> 'latitude', '')::numeric, nullif(payload ->> 'longitude', '')::numeric,
    starts, ends, coalesce((payload ->> 'applications_open')::boolean, true),
    nullif(payload ->> 'stall_capacity', '')::smallint)
  returning id into fair;
  perform private.audit('organizer', 'fair.created', 'fair', fair, jsonb_build_object('organizer', organizer));
  return jsonb_build_object('id', fair, 'slug', candidate);
end;
$$;
revoke all on function private.create_fair(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.create_fair(uuid, jsonb) to authenticated;
create function public.create_fair(organizer uuid, payload jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.create_fair(organizer, payload); $$;
revoke all on function public.create_fair(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_fair(uuid, jsonb) to authenticated;

-- Publicar exige plan vigente y respeta el tope de ferias activas.
create function private.set_fair_status(fair uuid, next_status text, reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare row public.fairs; rights jsonb; note text := left(btrim(coalesce(reason, '')), 200);
begin
  select * into row from public.fairs where id = fair for update;
  if row.id is null then raise exception 'Fair not found' using errcode = 'P0002'; end if;
  if not private.is_organizer_member(row.organizer_id, array['owner', 'editor']) then
    raise exception 'Not allowed for this organizer' using errcode = '42501';
  end if;
  if not ((row.status = 'draft' and next_status = 'published')
       or (row.status = 'published' and next_status in ('canceled', 'draft'))
       or (row.status = 'canceled' and next_status = 'published')) then
    raise exception 'Transition not allowed' using errcode = '23514';
  end if;
  if next_status = 'published' then
    rights := private.organizer_entitlements(row.organizer_id);
    if not coalesce((rights ->> 'can_publish')::boolean, false) then
      raise exception 'Organizer plan required' using errcode = 'U0010';
    end if;
    if row.ends_at <= now() then raise exception 'Fair already finished' using errcode = '23514'; end if;
    if (select count(*) from public.fairs f where f.organizer_id = row.organizer_id
        and f.status = 'published' and f.ends_at > now()) >= (rights ->> 'max_active_fairs')::int then
      raise exception 'Plan limit: fairs' using errcode = 'U0010';
    end if;
  end if;
  -- Volver a borrador sólo si nadie se inscribió todavía.
  if next_status = 'draft' and exists (select 1 from public.fair_participations p
      where p.fair_id = fair and p.status in ('requested', 'confirmed')) then
    raise exception 'Fair has participants' using errcode = '23514';
  end if;
  if next_status = 'canceled' and length(note) < 3 then
    raise exception 'Reason required' using errcode = '23514';
  end if;
  update public.fairs set status = next_status,
    cancel_reason = case when next_status = 'canceled' then note else '' end where id = fair;
  perform private.audit('organizer', 'fair.' || next_status, 'fair', fair, jsonb_build_object('reason', note));
  return next_status;
end;
$$;
revoke all on function private.set_fair_status(uuid, text, text) from public, anon, authenticated;
grant execute on function private.set_fair_status(uuid, text, text) to authenticated;
create function public.set_fair_status(fair uuid, next_status text, reason text default '') returns text
language sql security invoker set search_path = ''
as $$ select private.set_fair_status(fair, next_status, reason); $$;
revoke all on function public.set_fair_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_fair_status(uuid, text, text) to authenticated;

-- ───────────────── inscripciones ─────────────────
create function private.apply_to_fair(fair uuid, business uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare f public.fairs; existing public.fair_participations; id uuid;
begin
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  if not exists (select 1 from public.businesses b where b.id = business and b.status = 'active') then
    raise exception 'Business must be published' using errcode = '23514';
  end if;
  select * into f from public.fairs where fairs.id = fair;
  if f.id is null or f.status <> 'published' then raise exception 'Fair not found' using errcode = 'P0002'; end if;
  if not f.applications_open then raise exception 'Applications closed' using errcode = '23514'; end if;
  if f.ends_at <= now() then raise exception 'Fair already finished' using errcode = '23514'; end if;
  select * into existing from public.fair_participations p where p.fair_id = fair and p.business_id = business
    for update;
  if existing.id is not null then
    if existing.status in ('requested', 'confirmed') then return existing.id; end if;
    if existing.status = 'rejected' then raise exception 'Application rejected' using errcode = '23514'; end if;
    update public.fair_participations set status = 'requested', requested_at = now(), decided_at = null,
      stall_code = null, decision_note = '' where fair_participations.id = existing.id;
    id := existing.id;
  else
    insert into public.fair_participations (fair_id, business_id) values (fair, business) returning fair_participations.id into id;
  end if;
  perform private.audit('merchant', 'participation.requested', 'participation', id,
    jsonb_build_object('fair', fair, 'business', business));
  return id;
end;
$$;
revoke all on function private.apply_to_fair(uuid, uuid) from public, anon, authenticated;
grant execute on function private.apply_to_fair(uuid, uuid) to authenticated;
create function public.apply_to_fair(fair uuid, business uuid) returns uuid
language sql security invoker set search_path = ''
as $$ select private.apply_to_fair(fair, business); $$;
revoke all on function public.apply_to_fair(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_to_fair(uuid, uuid) to authenticated;

-- Retirarse antes de que empiece. Los pedidos con retiro en esa feria ya
-- confirmados siguen siendo del comercio: no se cancelan solos.
create function private.withdraw_participation(participation uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare p public.fair_participations; f public.fairs;
begin
  select * into p from public.fair_participations where id = participation for update;
  if p.id is null then raise exception 'Participation not found' using errcode = 'P0002'; end if;
  if not private.is_business_member(p.business_id, array['owner', 'manager']) then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  select * into f from public.fairs where id = p.fair_id;
  if p.status not in ('requested', 'confirmed') then raise exception 'Transition not allowed' using errcode = '23514'; end if;
  if f.starts_at <= now() then raise exception 'Fair already started' using errcode = '23514'; end if;
  if exists (select 1 from public.orders o where o.fair_id = p.fair_id and o.business_id = p.business_id
      and o.status not in ('delivered', 'canceled')) then
    raise exception 'Pending fair pickups' using errcode = '23514';
  end if;
  update public.fair_participations set status = 'withdrawn', stall_code = null, decided_at = now()
    where id = participation;
  perform private.audit('merchant', 'participation.withdrawn', 'participation', participation, '{}'::jsonb);
  return 'withdrawn';
end;
$$;
revoke all on function private.withdraw_participation(uuid) from public, anon, authenticated;
grant execute on function private.withdraw_participation(uuid) to authenticated;
create function public.withdraw_participation(participation uuid) returns text
language sql security invoker set search_path = ''
as $$ select private.withdraw_participation(participation); $$;
revoke all on function public.withdraw_participation(uuid) from public, anon, authenticated;
grant execute on function public.withdraw_participation(uuid) to authenticated;

-- Confirmar, rechazar o reasignar el puesto: sólo quien organiza esa feria.
create function private.decide_participation(participation uuid, decision text, stall text, note text)
returns text language plpgsql security definer set search_path = '' as $$
declare p public.fair_participations; f public.fairs; clean_stall text := nullif(upper(btrim(coalesce(stall, ''))), '');
begin
  select * into p from public.fair_participations where id = participation for update;
  if p.id is null then raise exception 'Participation not found' using errcode = 'P0002'; end if;
  if not private.is_fair_organizer(p.fair_id) then
    raise exception 'Not allowed for this organizer' using errcode = '42501';
  end if;
  if decision not in ('confirmed', 'rejected') then raise exception 'Invalid decision' using errcode = '23514'; end if;
  if clean_stall is not null and clean_stall !~ '^[A-Z0-9-]{1,12}$' then
    raise exception 'Invalid stall' using errcode = '23514';
  end if;
  select * into f from public.fairs where id = p.fair_id for update;
  if decision = 'confirmed' then
    if p.status not in ('requested', 'confirmed') then raise exception 'Transition not allowed' using errcode = '23514'; end if;
    if p.status = 'requested' and f.stall_capacity is not null and (select count(*) from public.fair_participations x
        where x.fair_id = f.id and x.status = 'confirmed') >= f.stall_capacity then
      raise exception 'Fair is full' using errcode = '23514';
    end if;
    update public.fair_participations set status = 'confirmed', stall_code = clean_stall, decision_note = '',
      decided_at = now() where id = participation;
  else
    if p.status <> 'requested' then raise exception 'Transition not allowed' using errcode = '23514'; end if;
    update public.fair_participations set status = 'rejected', stall_code = null,
      decision_note = left(btrim(coalesce(note, '')), 200), decided_at = now() where id = participation;
  end if;
  perform private.audit('organizer', 'participation.' || decision, 'participation', participation,
    jsonb_build_object('fair', p.fair_id, 'stall', clean_stall));
  return decision;
exception when unique_violation then
  raise exception 'Stall already assigned' using errcode = '23505';
end;
$$;
revoke all on function private.decide_participation(uuid, text, text, text) from public, anon, authenticated;
grant execute on function private.decide_participation(uuid, text, text, text) to authenticated;
create function public.decide_participation(participation uuid, decision text, stall text default null,
  note text default '') returns text
language sql security invoker set search_path = ''
as $$ select private.decide_participation(participation, decision, stall, note); $$;
revoke all on function public.decide_participation(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_participation(uuid, text, text, text) to authenticated;

-- El organizador suma directamente un comercio publicado (por su enlace).
create function private.add_fair_participant(fair uuid, business_slug text, stall text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare business uuid; id uuid; f public.fairs;
begin
  if not private.is_fair_organizer(fair) then raise exception 'Not allowed for this organizer' using errcode = '42501'; end if;
  select * into f from public.fairs where fairs.id = fair for update;
  if f.status = 'canceled' then raise exception 'Transition not allowed' using errcode = '23514'; end if;
  select b.id into business from public.businesses b where b.slug = lower(btrim(coalesce(business_slug, '')))
    and b.status = 'active';
  if business is null then raise exception 'Business not found' using errcode = 'P0002'; end if;
  if f.stall_capacity is not null and (select count(*) from public.fair_participations x
      where x.fair_id = fair and x.status = 'confirmed' and x.business_id <> business) >= f.stall_capacity then
    raise exception 'Fair is full' using errcode = '23514';
  end if;
  insert into public.fair_participations (fair_id, business_id, status, stall_code, decided_at)
    values (fair, business, 'confirmed', nullif(upper(btrim(coalesce(stall, ''))), ''), now())
  on conflict (fair_id, business_id) do update set status = 'confirmed', stall_code = excluded.stall_code,
    decision_note = '', decided_at = now()
  returning fair_participations.id into id;
  perform private.audit('organizer', 'participation.added', 'participation', id,
    jsonb_build_object('fair', fair, 'business', business));
  return id;
exception when unique_violation then
  raise exception 'Stall already assigned' using errcode = '23505';
end;
$$;
revoke all on function private.add_fair_participant(uuid, text, text) from public, anon, authenticated;
grant execute on function private.add_fair_participant(uuid, text, text) to authenticated;
create function public.add_fair_participant(fair uuid, business_slug text, stall text default null) returns uuid
language sql security invoker set search_path = ''
as $$ select private.add_fair_participant(fair, business_slug, stall); $$;
revoke all on function public.add_fair_participant(uuid, text, text) from public, anon, authenticated;
grant execute on function public.add_fair_participant(uuid, text, text) to authenticated;

-- Lista de inscripciones para el organizador (con datos públicos del comercio).
create function private.fair_applications(fair uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_fair_organizer(fair) and not private.is_admin() then
    raise exception 'Not allowed for this organizer' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'status', p.status, 'stall_code', p.stall_code, 'decision_note', p.decision_note,
      'requested_at', p.requested_at, 'decided_at', p.decided_at,
      'business', jsonb_build_object('id', b.id, 'name', b.name, 'slug', b.slug, 'logo_path', b.logo_path,
        'tagline', b.tagline, 'whatsapp', b.whatsapp, 'public_phone', b.public_phone, 'instagram', b.instagram,
        'category', c.name, 'locality', l.name))
      order by case p.status when 'requested' then 0 when 'confirmed' then 1 else 2 end, p.requested_at)
    from public.fair_participations p
    join public.businesses b on b.id = p.business_id
    join public.localities l on l.id = b.locality_id
    left join public.categories c on c.id = b.category_id
    where p.fair_id = fair), '[]'::jsonb);
end;
$$;
revoke all on function private.fair_applications(uuid) from public, anon, authenticated;
grant execute on function private.fair_applications(uuid) to authenticated;
create function public.fair_applications(fair uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.fair_applications(fair); $$;
revoke all on function public.fair_applications(uuid) from public, anon, authenticated;
grant execute on function public.fair_applications(uuid) to authenticated;

create function public.organizer_overview(organizer uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.organizer_overview(organizer); $$;
revoke all on function public.organizer_overview(uuid) from public, anon, authenticated;
grant execute on function private.organizer_overview(uuid) to authenticated;
grant execute on function public.organizer_overview(uuid) to authenticated;

commit;
