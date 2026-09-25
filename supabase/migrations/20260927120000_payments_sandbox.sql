-- CAUCE: pagos online a prueba en un comercio, sin encender el interruptor.
--
-- Qué cambia y por qué:
--   · Piloto por comercio. El pago online puede encenderse para un comercio
--     (el de QA) sin tocar `payments_online`, que sigue apagado para todos. Lo
--     enciende sólo la operación (rol de servicio o la base), nunca un cliente.
--     Un piloto en sandbox no puede conectar ni usar una cuenta real
--     (live_mode): la base lo rechaza aunque el servidor se equivoque.
--   · Renovación de los tokens del vendedor, del lado del servidor: el token
--     cifrado y su vencimiento se rotan juntos; si la renovación falla, la
--     cuenta pide reconectar.
--   · Un aprobado que llega tarde (sobre un intento rechazado, vencido o
--     cancelado) ya no se ignora en silencio: se aplica y queda para revisar.
--     Un segundo intento aprobado del mismo pedido también queda para revisar,
--     y un pago aprobado nunca se "desaprueba" por un intento posterior.
begin;

-- ───────────────── piloto por comercio ─────────────────
create table private.payment_pilot_businesses (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  -- En sandbox sólo valen cuentas de prueba del proveedor.
  sandbox boolean not null default true,
  reason text not null check (length(reason) between 3 and 200),
  created_at timestamptz not null default now()
);
alter table private.payment_pilot_businesses enable row level security;
revoke all on private.payment_pilot_businesses from public, anon, authenticated;
create policy payment_pilot_businesses_no_client_access on private.payment_pilot_businesses
for all to anon, authenticated using (false) with check (false);

-- ¿Cobra online este comercio? Con el interruptor encendido, todos; con el
-- interruptor apagado, sólo los comercios piloto.
create function private.payments_enabled(business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.feature_enabled('payments_online')
    or exists (select 1 from private.payment_pilot_businesses p where p.business_id = business);
$$;
revoke all on function private.payments_enabled(uuid) from public, anon, authenticated;

-- ¿Piloto en sandbox? Ahí la cuenta conectada tiene que ser de prueba.
create function private.payments_sandbox(business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.payment_pilot_businesses p where p.business_id = business and p.sandbox);
$$;
revoke all on function private.payments_sandbox(uuid) from public, anon, authenticated;

-- Para las Edge Functions: con todo apagado responden 503 sin anotar nada.
create function private.payments_accepting() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.feature_enabled('payments_online') or exists (select 1 from private.payment_pilot_businesses);
$$;

-- El panel muestra "Pagos" a titular y encargado/a de un comercio piloto.
-- Para cualquier otra persona es null: el piloto no se publica. La columna
-- calculada (public, sin privilegios) pregunta a la función privada.
create function private.payments_pilot(business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when private.is_business_member(business, array['owner', 'manager'])
    then exists (select 1 from private.payment_pilot_businesses p where p.business_id = business) end;
$$;
revoke all on function private.payments_pilot(uuid) from public, anon, authenticated;
grant execute on function private.payments_pilot(uuid) to authenticated;
create function public.payments_pilot(business public.businesses) returns boolean
language sql stable security invoker set search_path = ''
as $$ select private.payments_pilot(business.id); $$;
revoke all on function public.payments_pilot(public.businesses) from public, anon, authenticated;
grant execute on function public.payments_pilot(public.businesses) to authenticated;

-- ───────────────── disponibilidad ─────────────────
create or replace function private.online_payment_provider(business uuid) returns text
language sql stable security definer set search_path = '' as $$
  select a.provider from public.payment_provider_accounts a
  where private.payments_enabled(business)
    and a.business_id = business and a.status = 'connected'
    -- Un piloto en sandbox cobra sólo con una cuenta de prueba declarada.
    and not (private.payments_sandbox(business) and a.live_mode is distinct from false)
  order by a.connected_at desc nulls last, a.provider
  limit 1;
$$;

-- ───────────────── iniciar un pago ─────────────────
-- Igual que antes, más una regla: un intento pendiente que ya venció no se
-- reutiliza (su checkout no se puede pagar). Sin orden en el proveedor vence en
-- el acto; con orden, después de un margen por si el aviso del pago llega
-- tarde. Si el proveedor igual lo aprobara después, se refleja y queda para
-- revisar. Un intento `processing` nunca vence acá: el proveedor lo resuelve.
create or replace function private.start_payment(order_id uuid, flow text) returns jsonb
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
  if attempt.id is not null and attempt.status = 'pending' and attempt.expires_at is not null
      -- Entre paréntesis: PL/pgSQL corta la condición del IF en el primer THEN.
      and attempt.expires_at + (case when attempt.provider_order_id is null then interval '0 minutes'
        else interval '10 minutes' end) < now() then
    update public.payment_attempts a set status = 'expired', status_detail = 'local_expiry', updated_at = now()
      where a.id = attempt.id;
    attempt := null;
  end if;
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

-- ───────────────── pagos del comercio ─────────────────
create or replace function private.business_payment_overview(business uuid) returns jsonb
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
    'enabled', private.payments_enabled(business),
    'sandbox', private.payments_sandbox(business),
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
    -- Avisos del día que piden revisar a mano: importe distinto, pago repetido
    -- o un aprobado que llegó después de cerrar el intento.
    'to_review', (select count(*) from private.payment_events e join public.payment_attempts a on a.id = e.attempt_id
      where a.business_id = business and e.outcome = 'flagged' and e.received_at >= day_start),
    'last_synced_at', (select max(a.last_synced_at) from public.payment_provider_accounts a
      where a.business_id = business),
    'day_start', day_start);
end;
$$;

-- ───────────────── servidor: OAuth del comercio ─────────────────
create or replace function private.payment_oauth_begin(business uuid, provider text, requested_by uuid,
  state text, code_verifier text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.payments_enabled(business) then
    raise exception 'Payments disabled' using errcode = '42501';
  end if;
  if not exists (select 1 from private.payment_providers p where p.key = payment_oauth_begin.provider) then
    raise exception 'Unknown provider' using errcode = '23514';
  end if;
  if not exists (select 1 from public.business_memberships m
    where m.business_id = business and m.user_id = requested_by and m.role = 'owner') then
    raise exception 'Not allowed for this business' using errcode = '42501';
  end if;
  -- PKCE: el verificador tiene entre 43 y 128 caracteres (RFC 7636).
  if length(coalesce(code_verifier, '')) not between 43 and 128 or length(coalesce(state, '')) < 32 then
    raise exception 'Invalid PKCE parameters' using errcode = '23514';
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

-- La vuelta del proveedor: el comercio, el code_verifier y si es un piloto en
-- sandbox (el canje pide entonces credenciales de prueba).
create or replace function private.payment_oauth_lookup(state text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('business_id', s.business_id, 'provider', s.provider, 'code_verifier', s.code_verifier,
    'enabled', private.payments_enabled(s.business_id), 'sandbox', private.payments_sandbox(s.business_id))
  from private.payment_oauth_states s
  where s.state = payment_oauth_lookup.state and s.used_at is null and s.expires_at > now();
$$;

-- La vuelta con un `state` que no sirve (vencido, usado o cancelado) lo quema
-- igual: un `state` nunca se canjea dos veces ni después de un error.
create function private.payment_oauth_discard(state text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  pending private.payment_oauth_states;
begin
  update private.payment_oauth_states s set used_at = coalesce(s.used_at, now())
    where s.state = payment_oauth_discard.state returning * into pending;
  if pending.state is null then return null; end if;
  update public.payment_provider_accounts a set status = 'not_connected', updated_at = now()
    where a.business_id = pending.business_id and a.provider = pending.provider and a.status = 'connecting';
  return jsonb_build_object('business_id', pending.business_id, 'provider', pending.provider);
end;
$$;

create or replace function private.payment_oauth_complete(state text, provider_user_id text, scopes text[],
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
  if not private.payments_enabled(pending.business_id) then
    raise exception 'Payments disabled' using errcode = '42501';
  end if;
  -- Nunca una cuenta real en un piloto de prueba: ni se guarda.
  if private.payments_sandbox(pending.business_id) and live_mode is distinct from false then
    raise exception 'Live account not allowed in sandbox' using errcode = '42501';
  end if;
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

-- ───────────────── servidor: credenciales y renovación ─────────────────
create or replace function private.payment_account_credentials(business uuid, provider text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_id', a.id, 'business_id', a.business_id, 'status', a.status,
    'provider_user_id', a.provider_user_id, 'live_mode', a.live_mode, 'sandbox', private.payments_sandbox(a.business_id),
    'access_token_ciphertext', c.access_token_ciphertext, 'refresh_token_ciphertext', c.refresh_token_ciphertext,
    'key_version', c.key_version, 'expires_at', c.expires_at)
  from public.payment_provider_accounts a
  join private.payment_provider_credentials c on c.account_id = a.id
  where a.business_id = business and a.provider = payment_account_credentials.provider;
$$;

create or replace function private.payment_seller_credentials(provider text, seller_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_id', a.id, 'business_id', a.business_id, 'provider', a.provider,
    'provider_user_id', a.provider_user_id, 'live_mode', a.live_mode, 'sandbox', private.payments_sandbox(a.business_id),
    'access_token_ciphertext', c.access_token_ciphertext, 'refresh_token_ciphertext', c.refresh_token_ciphertext,
    'key_version', c.key_version, 'expires_at', c.expires_at)
  from public.payment_provider_accounts a
  join private.payment_provider_credentials c on c.account_id = a.id
  where a.provider = payment_seller_credentials.provider and a.provider_user_id = seller_id
    and a.status = 'connected'
  limit 1;
$$;

-- Guarda el token renovado (ya cifrado) y su vencimiento, juntos. Sólo para
-- una cuenta que sigue conectada: si el titular la desconectó, no revive.
create function private.payment_account_rotate(account uuid, access_ciphertext text, refresh_ciphertext text,
  new_key_version smallint, new_expires_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.payment_provider_accounts a where a.id = account and a.status = 'connected') then
    raise exception 'Account not connected' using errcode = '42501';
  end if;
  update private.payment_provider_credentials c set access_token_ciphertext = access_ciphertext,
    refresh_token_ciphertext = coalesce(nullif(refresh_ciphertext, ''), c.refresh_token_ciphertext),
    key_version = new_key_version, expires_at = new_expires_at, updated_at = now()
    where c.account_id = account;
  if not found then raise exception 'Account without credentials' using errcode = 'P0002'; end if;
  update public.payment_provider_accounts a set token_expires_at = new_expires_at, updated_at = now()
    where a.id = account;
end;
$$;

-- Cuentas conectadas cuyo token vence dentro de `within_days` días: las que
-- la renovación programada tiene que refrescar.
create function private.payment_accounts_expiring(within_days integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'business_id', a.business_id,
      'provider', a.provider, 'refresh_token_ciphertext', c.refresh_token_ciphertext, 'key_version', c.key_version,
      'expires_at', c.expires_at, 'sandbox', private.payments_sandbox(a.business_id)) order by c.expires_at), '[]'::jsonb)
  from public.payment_provider_accounts a
  join private.payment_provider_credentials c on c.account_id = a.id
  where a.status = 'connected' and c.expires_at is not null
    and c.expires_at < now() + make_interval(days => least(greatest(within_days, 1), 200));
$$;

-- ───────────────── servidor: aplicar lo leído del proveedor ─────────────────
-- Un aprobado que llega sobre un intento cerrado (rechazado, vencido o
-- cancelado) es plata cobrada: se refleja y queda para revisar.
insert into private.payment_status_transitions (from_status, to_status) values
  ('rejected', 'approved'),
  ('expired', 'approved'),
  ('cancelled', 'approved')
on conflict do nothing;

create or replace function private.payment_apply_update(provider text, seller_id text, attempt_reference uuid,
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
  -- Un intento tiene una sola orden del proveedor. Otra orden con nuestra
  -- referencia (la idempotencia falló) es plata real: se aplica igual y queda
  -- para revisar.
  if attempt.provider_order_id is not null and payment_apply_update.provider_order_id is not null
      and attempt.provider_order_id <> payment_apply_update.provider_order_id then
    v_outcome := 'flagged';
    v_detail := 'provider_order_mismatch';
  end if;
  if attempt.provider_order_id is null and payment_apply_update.provider_order_id is not null then
    update public.payment_attempts a set provider_order_id = payment_apply_update.provider_order_id
      where a.id = attempt.id returning * into attempt;
  end if;
  if next_status = 'approved' and (paid_amount is null or paid_amount <> attempt.amount_ars) then
    -- Nunca se aprueba por un importe distinto del pedido: queda para revisar.
    next_status := case when attempt.status in ('pending', 'processing') then 'processing' else attempt.status end;
    v_outcome := 'flagged';
    v_detail := 'amount_mismatch';
  elsif next_status = 'approved' and attempt.status in ('rejected', 'expired', 'cancelled') then
    v_outcome := 'flagged';
    v_detail := 'approved_after_close';
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
  -- veces) o dos intentos aprobados para un mismo pedido: el pedido sigue
  -- pagado una sola vez y el cobro de más queda para revisar y devolver desde
  -- la cuenta del comercio. Nunca se devuelve solo.
  if (select count(*) from public.payment_transactions t where t.attempt_id = attempt.id and t.kind = 'payment'
      and t.status in ('approved', 'partially_refunded')) > 1
    or (next_status = 'approved' and exists (select 1 from public.payment_attempts a
      where a.order_id = attempt.order_id and a.id <> attempt.id and a.status in ('approved', 'partially_refunded'))) then
    v_outcome := 'flagged';
    v_detail := 'duplicate_payment';
  end if;
  if next_status <> attempt.status or v_detail <> attempt.status_detail then
    update public.payment_attempts a set status = next_status, status_detail = v_detail, updated_at = now()
      where a.id = attempt.id returning * into attempt;
    update public.orders o set payment_status = attempt.status, updated_at = now()
      where o.id = attempt.order_id and o.payment_method = 'online'
        and case
          -- El pago de este intento (aprobado o devuelto) se refleja, salvo que
          -- otro intento ya haya pagado el pedido.
          when attempt.status in ('approved', 'partially_refunded', 'refunded') then
            not exists (select 1 from public.payment_attempts a where a.order_id = o.id and a.id <> attempt.id
              and a.status in ('approved', 'partially_refunded'))
          -- El resto, sólo el intento más reciente y sólo si nada pagó el pedido.
          else attempt.id = (select a.id from public.payment_attempts a where a.order_id = o.id
              order by a.created_at desc limit 1)
            and not exists (select 1 from public.payment_attempts a where a.order_id = o.id
              and a.status in ('approved', 'partially_refunded', 'refunded'))
        end;
  end if;
  update private.payment_events e set outcome = v_outcome, attempt_id = attempt.id,
    detail = case when v_outcome = 'flagged' then v_detail else '' end, processed_at = now()
    where e.id = event_id;
  update public.payment_provider_accounts p set last_synced_at = now()
    where p.business_id = attempt.business_id and p.provider = attempt.provider;
  return jsonb_build_object('outcome', v_outcome, 'attempt_id', attempt.id,
    'status', attempt.status, 'detail', case when v_outcome = 'flagged' then v_detail else '' end);
end;
$$;

-- ───────────────── permisos del servidor ─────────────────
-- Sólo service_role: ningún cliente (anon, authenticated) las ejecuta.
do $$
declare fn text;
begin
  foreach fn in array array[
    'private.payments_accepting()',
    'private.payment_oauth_discard(text)',
    'private.payment_account_rotate(uuid, text, text, smallint, timestamptz)',
    'private.payment_accounts_expiring(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

create function public.payments_accepting() returns boolean
language sql stable security invoker set search_path = ''
as $$ select private.payments_accepting(); $$;
create function public.payment_oauth_discard(state text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.payment_oauth_discard(state); $$;
create function public.payment_account_rotate(account uuid, access_ciphertext text, refresh_ciphertext text,
  new_key_version smallint, new_expires_at timestamptz) returns void
language sql security invoker set search_path = ''
as $$ select private.payment_account_rotate(account, access_ciphertext, refresh_ciphertext, new_key_version,
  new_expires_at); $$;
create function public.payment_accounts_expiring(within_days integer) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.payment_accounts_expiring(within_days); $$;
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.payments_accepting()',
    'public.payment_oauth_discard(text)',
    'public.payment_account_rotate(uuid, text, text, smallint, timestamptz)',
    'public.payment_accounts_expiring(integer)'
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
    'schema', 20260927120000,
    'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
    'localities', coalesce((select jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'timezone', timezone)
      order by name) from public.localities where active), '[]'::jsonb),
    'now', now());
$$;

commit;
