-- Moderación de publicaciones del marketplace.
--
-- Hasta ahora la revisión administrativa era sólo del alta del comercio. Un
-- comercio aprobado podía publicar cualquier producto sin revisión. Este
-- contrato agrega un estado por producto y un historial de decisiones:
--
--   pending   -> recién creado o reenviado por el comercio
--   approved  -> visible en la vidriera y comprable
--   rejected  -> revisado y devuelto con observaciones
--   suspended -> estaba aprobado y administración lo retiró
--
-- Sólo administración cambia el estado. El comercio puede reenviar un producto
-- rechazado o suspendido; nunca puede aprobarse a sí mismo.
begin;

alter table public.products
  add column status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected', 'suspended')),
  add column review_note text not null default '' check (length(review_note) <= 400),
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users(id) on delete set null;

-- Los productos que ya existían se conservan publicados: la moderación empieza
-- a regir para las altas nuevas. El default queda en `pending` desde acá.
alter table public.products alter column status set default 'pending';

create index products_moderation_queue on public.products(status, created_at)
  where archived = false;

create table public.product_review_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  from_status text not null check (from_status in ('pending', 'approved', 'rejected', 'suspended')),
  to_status text not null check (to_status in ('pending', 'approved', 'rejected', 'suspended')),
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text not null check (actor_role in ('merchant', 'admin')),
  note text not null default '' check (length(note) <= 400),
  created_at timestamptz not null default now()
);
create index product_review_events_product on public.product_review_events(product_id, created_at desc);
create index product_review_events_business on public.product_review_events(business_id, created_at desc);
create index product_review_events_actor on public.product_review_events(actor_id);

-- La tabla de historial no se escribe desde el cliente: sólo las funciones
-- `security definer` de abajo insertan eventos. Se lee desde el comercio y la
-- administración, nunca desde la calle.
revoke all on public.product_review_events from public, anon, authenticated;
grant select on public.product_review_events to authenticated;
alter table public.product_review_events enable row level security;

create policy product_review_events_read on public.product_review_events for select to authenticated
using (private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin()));

-- La vidriera pública sólo muestra productos aprobados y no archivados. El
-- comercio y la administración siguen viendo todas las filas por RLS.
drop policy products_read_anon on public.products;
drop policy products_read_auth on public.products;
create policy products_read_anon on public.products for select to anon
using (status = 'approved' and not archived
  and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'));
create policy products_read_auth on public.products for select to authenticated
using (
  (status = 'approved' and not archived
    and exists (select 1 from public.businesses b where b.id = business_id and b.status = 'active'))
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin())
);

drop policy product_variants_read_anon on public.product_variants;
drop policy product_variants_read_auth on public.product_variants;
create policy product_variants_read_anon on public.product_variants for select to anon
using (exists (select 1 from public.products p join public.businesses b on b.id = p.business_id
  where p.id = product_id and p.status = 'approved' and not p.archived and b.status = 'active'));
create policy product_variants_read_auth on public.product_variants for select to authenticated
using (
  exists (select 1 from public.products p join public.businesses b on b.id = p.business_id
    where p.id = product_id and p.status = 'approved' and not p.archived and b.status = 'active')
  or private.is_business_member(business_id, array['owner', 'manager', 'staff'])
  or (select private.is_admin())
);

-- Defensa en profundidad: aunque una función futura olvide mirar el estado,
-- un pedido nunca puede incluir un producto que no esté aprobado.
create function private.require_approved_order_product() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.products where id = new.product_id and status = 'approved') then
    raise exception 'Product not available' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.require_approved_order_product() from public, anon, authenticated;
create trigger order_items_product_approved before insert on public.order_items
for each row execute function private.require_approved_order_product();

-- Decisión administrativa. La máquina de estados es explícita: no se puede
-- saltar de pendiente a suspendido ni reabrir un producto aprobado sin pasar
-- por una suspensión.
create function private.review_product(product uuid, decision text, note text) returns text
language plpgsql security definer set search_path = '' as $$
declare current text;
begin
  if not private.is_admin() then
    raise exception 'Administration only' using errcode = '42501';
  end if;
  if decision not in ('approved', 'rejected', 'suspended') then
    raise exception 'Invalid decision' using errcode = '23514';
  end if;
  select status into current from public.products where id = product for update;
  if current is null then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if not (
    (current = 'pending' and decision in ('approved', 'rejected'))
    or (current = 'rejected' and decision = 'approved')
    or (current = 'approved' and decision = 'suspended')
    or (current = 'suspended' and decision = 'approved')
  ) then
    raise exception 'Transition not allowed' using errcode = '23514';
  end if;
  if decision in ('rejected', 'suspended') and length(btrim(coalesce(note, ''))) < 3 then
    raise exception 'Reason required' using errcode = '23514';
  end if;
  update public.products
    set status = decision, review_note = left(coalesce(note, ''), 400),
        reviewed_at = now(), reviewed_by = (select auth.uid())
    where id = product;
  insert into public.product_review_events (product_id, business_id, from_status, to_status,
    actor_id, actor_role, note)
  select product, business_id, current, decision, (select auth.uid()), 'admin', left(coalesce(note, ''), 400)
  from public.products where id = product;
  return decision;
end;
$$;
revoke all on function private.review_product(uuid, text, text) from public, anon, authenticated;
grant execute on function private.review_product(uuid, text, text) to authenticated;
create function public.review_product(product uuid, decision text, note text default '')
returns text language sql security invoker set search_path = ''
as $$ select private.review_product(product, decision, note); $$;
revoke all on function public.review_product(uuid, text, text) from public, anon, authenticated;
grant execute on function public.review_product(uuid, text, text) to authenticated;

-- Reenvío del comercio: sólo desde rechazado o suspendido, y nunca directo a
-- aprobado. Queda auditado como evento de comercio.
create function private.submit_product_for_review(product uuid, note text) returns text
language plpgsql security definer set search_path = '' as $$
declare current text;
declare business uuid;
begin
  select status, business_id into current, business from public.products
    where id = product for update;
  if current is null then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if not private.is_business_member(business, array['owner', 'manager']) then
    raise exception 'Not allowed for this product' using errcode = '42501';
  end if;
  if current = 'pending' then
    return 'pending';
  end if;
  if current not in ('rejected', 'suspended') then
    raise exception 'Only rejected or suspended products can be resubmitted' using errcode = '23514';
  end if;
  update public.products
    set status = 'pending', review_note = left(coalesce(note, ''), 400),
        reviewed_at = null, reviewed_by = null
    where id = product;
  insert into public.product_review_events (product_id, business_id, from_status, to_status,
    actor_id, actor_role, note)
  values (product, business, current, 'pending', (select auth.uid()), 'merchant',
    left(coalesce(note, ''), 400));
  return 'pending';
end;
$$;
revoke all on function private.submit_product_for_review(uuid, text) from public, anon, authenticated;
grant execute on function private.submit_product_for_review(uuid, text) to authenticated;
create function public.submit_product_for_review(product uuid, note text default '')
returns text language sql security invoker set search_path = ''
as $$ select private.submit_product_for_review(product, note); $$;
revoke all on function public.submit_product_for_review(uuid, text) from public, anon, authenticated;
grant execute on function public.submit_product_for_review(uuid, text) to authenticated;

create or replace function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'schema', 20261026130000,
  'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
  'localities', coalesce((select jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'timezone', timezone)
    order by name) from public.localities where active), '[]'::jsonb),
  'now', now());
$$;
revoke all on function private.app_status() from public, anon, authenticated;
grant execute on function private.app_status() to anon, authenticated;
create or replace function public.app_status() returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.app_status(); $$;
revoke all on function public.app_status() from public, anon, authenticated;
grant execute on function public.app_status() to anon, authenticated;

commit;
