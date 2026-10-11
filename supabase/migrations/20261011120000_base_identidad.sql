-- CAUCE · Ferias Neuquén — base: identidad, administración, registro de errores y auditoría.
-- Derivado del modelo de CAUCE · Aluminé (mismas reglas de seguridad), en un proyecto
-- Supabase independiente. Sin datos de personas: sólo datos de referencia.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
-- El esquema privado no se expone por la API (no está en `api.schemas`). El uso
-- se concede para que las funciones públicas puedan delegar en él; cada función
-- se habilita una por una.
grant usage on schema private to anon, authenticated;

-- ───────────────── utilidades ─────────────────
create function private.touch_updated_at() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;
revoke all on function private.touch_updated_at() from public, anon, authenticated;

-- Quita datos personales de un texto libre antes de guardarlo en registros.
create function private.scrub(value text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(value, ''),
    '[^[:space:]@]+@[^[:space:]@]+', '[correo]', 'g'),
    'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(secret|publishable)_[A-Za-z0-9_-]+', '[token]', 'g'),
    '[0-9][0-9 ()-]{6,}[0-9]', '[número]', 'g');
$$;
revoke all on function private.scrub(text) from public, anon, authenticated;

create function private.is_permanent_user() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;
revoke all on function private.is_permanent_user() from public, anon, authenticated;
grant execute on function private.is_permanent_user() to anon, authenticated;

-- Fecha de hoy en la zona horaria de Neuquén (vencimientos y calendario).
create function private.today_ar() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Argentina/Salta')::date;
$$;
revoke all on function private.today_ar() from public, anon, authenticated;
grant execute on function private.today_ar() to anon, authenticated;

-- ───────────────── localidades ─────────────────
create table public.localities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  province text not null default 'Neuquén' check (length(btrim(province)) between 2 and 60),
  position smallint not null default 0,
  active boolean not null default true,
  timezone text not null default 'America/Argentina/Salta' check (length(timezone) between 3 and 64)
);
insert into public.localities (slug, name, province, position) values
  ('neuquen', 'Neuquén capital', 'Neuquén', 10),
  ('plottier', 'Plottier', 'Neuquén', 20),
  ('centenario', 'Centenario', 'Neuquén', 30),
  ('cipolletti', 'Cipolletti', 'Río Negro', 40),
  ('senillosa', 'Senillosa', 'Neuquén', 50),
  ('cutral-co', 'Cutral Có', 'Neuquén', 60),
  ('zapala', 'Zapala', 'Neuquén', 70),
  ('junin-de-los-andes', 'Junín de los Andes', 'Neuquén', 80),
  ('san-martin-de-los-andes', 'San Martín de los Andes', 'Neuquén', 90),
  ('villa-la-angostura', 'Villa La Angostura', 'Neuquén', 100);

-- ───────────────── perfiles ─────────────────
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 2 and 80),
  phone text not null default '' check (length(phone) <= 24),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

-- ───────────────── administración de la plataforma ─────────────────
-- La provee sólo quien opera la base: nunca el registro ni user_metadata.
create table private.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_permanent_user() and exists (
    select 1 from private.platform_admins where user_id = (select auth.uid()));
$$;
revoke all on function private.is_admin() from public, anon, authenticated;
grant execute on function private.is_admin() to anon, authenticated;

-- Interruptores operativos (compra sin cuenta, altas abiertas, comunidad fundadora).
create table private.platform_features (
  key text primary key check (key ~ '^[a-z_]+$'),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into private.platform_features (key, enabled) values
  ('guest_checkout', true),
  ('merchant_signup', true),
  ('founding_community', true);

create function private.feature_enabled(feature text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from private.platform_features where key = feature), false);
$$;
revoke all on function private.feature_enabled(text) from public, anon, authenticated;
grant execute on function private.feature_enabled(text) to anon, authenticated;

-- ───────────────── registro de errores del cliente ─────────────────
-- Sin datos personales; techo de volumen porque la clave pública lo permite.
create table private.client_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('frontend_error', 'supabase_error', 'auth_error', 'order_failed', 'critical')),
  code text not null default '' check (length(code) <= 60),
  message text not null default '' check (length(message) <= 300),
  route text not null default '' check (length(route) <= 80),
  release text not null default '' check (length(release) <= 40),
  user_id uuid,
  context jsonb not null default '{}'::jsonb
);
create index client_events_recent on private.client_events(created_at desc);

create function private.report_client_event(kind text, code text, message text, route text,
  release text, context jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); safe_context jsonb;
begin
  if kind not in ('frontend_error', 'supabase_error', 'auth_error', 'order_failed', 'critical') then
    return false;
  end if;
  if (select count(*) from private.client_events where created_at > now() - interval '1 minute') >= 60
     or (select count(*) from private.client_events where created_at > now() - interval '1 day') >= 5000 then
    return false;
  end if;
  if caller is not null and (select count(*) from private.client_events
      where user_id = caller and created_at > now() - interval '1 minute') >= 20 then
    return false;
  end if;
  safe_context := case when context is null or jsonb_typeof(context) <> 'object'
    or pg_column_size(context) > 2048 then '{}'::jsonb else context end;
  insert into private.client_events (kind, code, message, route, release, user_id, context)
  values (kind, left(private.scrub(code), 60), left(private.scrub(message), 300),
    left(regexp_replace(coalesce(route, ''), '[^a-z0-9#/_-]', '', 'gi'), 80),
    left(coalesce(release, ''), 40), caller,
    coalesce((select jsonb_object_agg(k, left(private.scrub(v), 120))
      from jsonb_each_text(safe_context) as e(k, v) where k ~ '^[a-zA-Z_]{1,40}$'), '{}'::jsonb));
  if random() < 0.02 then
    delete from private.client_events where created_at < now() - interval '30 days';
  end if;
  return true;
end;
$$;
revoke all on function private.report_client_event(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.report_client_event(text, text, text, text, text, jsonb) to anon, authenticated;
create function public.report_client_event(kind text, code text default '', message text default '',
  route text default '', release text default '', context jsonb default '{}'::jsonb) returns boolean
language sql security invoker set search_path = ''
as $$ select private.report_client_event(kind, code, message, route, release, context); $$;
revoke all on function public.report_client_event(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.report_client_event(text, text, text, text, text, jsonb) to anon, authenticated;

-- ───────────────── auditoría mínima ─────────────────
-- Toda acción administrativa, de suscripción, de organización y de estado del
-- comercio deja una fila. Nunca guarda contraseñas, teléfonos ni direcciones.
create table private.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_role text not null check (actor_role in ('admin', 'merchant', 'organizer', 'system')),
  action text not null check (length(action) between 3 and 60),
  entity text not null check (entity in ('business', 'subscription', 'organizer', 'fair', 'participation',
    'founding', 'platform')),
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) <= 4096)
);
create index audit_log_recent on private.audit_log(at desc);
create index audit_log_entity on private.audit_log(entity, entity_id, at desc);

create function private.audit(actor_role text, action text, entity text, entity_id uuid,
  detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into private.audit_log (actor_id, actor_role, action, entity, entity_id, detail)
  values ((select auth.uid()), actor_role, action, entity, entity_id, coalesce(detail, '{}'::jsonb));
$$;
revoke all on function private.audit(text, text, text, uuid, jsonb) from public, anon, authenticated;

-- ───────────────── privilegios y RLS ─────────────────
alter table public.localities enable row level security;
alter table public.profiles enable row level security;
alter table private.platform_admins enable row level security;
alter table private.platform_features enable row level security;
alter table private.client_events enable row level security;
alter table private.audit_log enable row level security;

-- Los privilegios por defecto del proyecto conceden todo: se revocan antes de
-- conceder lo mínimo.
revoke all on public.localities, public.profiles from public, anon, authenticated;
revoke all on private.platform_admins, private.platform_features, private.client_events, private.audit_log
  from public, anon, authenticated;

grant select on public.localities to anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (user_id, display_name, phone), update (display_name, phone) on public.profiles to authenticated;

create policy localities_public on public.localities for select to anon, authenticated using (active);
create policy profile_read_self on public.profiles for select to authenticated
using (user_id = (select auth.uid()));
create policy profile_insert_self on public.profiles for insert to authenticated
with check (user_id = (select auth.uid()) and private.is_permanent_user());
create policy profile_update_self on public.profiles for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Denegación explícita: las tablas privadas sólo se tocan por funciones.
create policy platform_admins_no_client on private.platform_admins for all to anon, authenticated
using (false) with check (false);
create policy platform_features_no_client on private.platform_features for all to anon, authenticated
using (false) with check (false);
create policy client_events_no_client on private.client_events for all to anon, authenticated
using (false) with check (false);
create policy audit_log_no_client on private.audit_log for all to anon, authenticated
using (false) with check (false);

create function public.my_access() returns boolean
language sql stable security invoker set search_path = ''
as $$ select private.is_admin(); $$;
revoke all on function public.my_access() from public, anon, authenticated;
grant execute on function public.my_access() to authenticated;

commit;
