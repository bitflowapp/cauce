-- CAUCE only. Foundation for phase 1; no orders, payments or demo data.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.localities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  active boolean not null default true
);
insert into public.localities (slug, name) values ('alumine', 'Aluminé');

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 2 and 120),
  phone text not null default '' check (length(phone) <= 24),
  created_at timestamptz not null default now()
);

-- Only public business fields belong here. Contacts will have separate RLS.
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  locality_id uuid not null references public.localities(id),
  name text not null check (length(btrim(name)) between 2 and 120),
  slug text not null check (length(slug) <= 120 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'returned', 'active', 'paused')),
  created_at timestamptz not null default now(),
  unique (locality_id, slug)
);
create index businesses_visible on public.businesses(locality_id) where status = 'active';

create table public.business_memberships (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'staff')),
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index memberships_user on public.business_memberships(user_id, business_id);

-- Provisioned only by an operator, never by signup or user metadata.
create table private.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table private.platform_admins enable row level security;
revoke all on private.platform_admins from public, anon, authenticated;

-- Definer lookups avoid recursive membership policies. No caller-supplied user id.
create function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from private.platform_admins where user_id = (select auth.uid())
  );
$$;
create function private.is_business_member(business uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.business_memberships
    where business_id = business and user_id = (select auth.uid())
      and role = any(allowed_roles)
  );
$$;
revoke all on function private.is_admin() from public, anon, authenticated;
revoke all on function private.is_business_member(uuid, text[]) from public, anon, authenticated;
grant execute on function private.is_admin(), private.is_business_member(uuid, text[]) to authenticated;

alter table public.localities enable row level security;
alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_memberships enable row level security;

-- Remove platform default grants before adding the minimum explicit privileges.
revoke all on public.localities, public.profiles, public.businesses,
  public.business_memberships from public, anon, authenticated;
grant select on public.localities, public.businesses to anon, authenticated;
grant select on public.profiles, public.business_memberships to authenticated;
grant insert (user_id, display_name, phone), update (display_name, phone)
  on public.profiles to authenticated;
grant update (name, slug) on public.businesses to authenticated;

create policy localities_public on public.localities for select to anon, authenticated
using (active);
create policy profile_read_self on public.profiles for select to authenticated
using (user_id = (select auth.uid()));
create policy profile_insert_self on public.profiles for insert to authenticated
with check (user_id = (select auth.uid()));
create policy profile_update_self on public.profiles for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy business_public on public.businesses for select to anon, authenticated
using (status = 'active' and exists (
  select 1 from public.localities where id = locality_id and active
));
create policy business_member_read on public.businesses for select to authenticated
using (private.is_business_member(id, array['owner', 'manager', 'staff']));
create policy business_admin_review on public.businesses for select to authenticated
using ((select private.is_admin()));
create policy business_edit on public.businesses for update to authenticated
using (private.is_business_member(id, array['owner', 'manager']))
with check (private.is_business_member(id, array['owner', 'manager']));
create policy membership_read_self on public.business_memberships for select to authenticated
using (user_id = (select auth.uid()));

-- Necessary privilege boundary: atomically bootstrap a draft and its first owner.
-- Neither table has a general client INSERT grant. Failure rolls back both writes.
create function private.create_business(business_name text, business_slug text, locality_slug text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  locality uuid;
  business uuid;
begin
  if caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where user_id = caller) then
    raise exception 'Complete your profile first' using errcode = '23514';
  end if;
  select id into locality from public.localities where slug = locality_slug and active;
  if locality is null then
    raise exception 'Locality unavailable' using errcode = '23514';
  end if;
  insert into public.businesses (locality_id, name, slug)
    values (locality, btrim(business_name), business_slug) returning id into business;
  insert into public.business_memberships (business_id, user_id, role)
    values (business, caller, 'owner');
  return business;
end;
$$;
revoke all on function private.create_business(text, text, text) from public, anon, authenticated;
grant execute on function private.create_business(text, text, text) to authenticated;

-- Exposed wrapper stays SECURITY INVOKER; private is not an API schema.
create function public.create_business(business_name text, business_slug text, locality_slug text default 'alumine')
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_business(business_name, business_slug, locality_slug); $$;
revoke all on function public.create_business(text, text, text) from public, anon, authenticated;
grant execute on function public.create_business(text, text, text) to authenticated;

commit;
