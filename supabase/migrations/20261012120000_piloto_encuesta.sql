-- Piloto comercial: encuesta breve y opcional en la preinscripción de la
-- Comunidad Fundadora, resumen para la administración y versión de esquema.
-- Las respuestas son códigos cerrados (js/core/survey.js): no hay texto libre
-- nuevo que moderar. Quien no responde, deja la encuesta vacía.

alter table private.founding_applications
  add column survey jsonb not null default '{}'::jsonb check (jsonb_typeof(survey) = 'object');

-- Normaliza la encuesta: descarta claves o valores desconocidos en lugar de
-- fallar, para que una pregunta vieja en caché nunca bloquee la preinscripción.
create function private.clean_survey(raw jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'channels', (select jsonb_agg(distinct v order by v) from jsonb_array_elements_text(
        case when jsonb_typeof(raw -> 'channels') = 'array' then raw -> 'channels' else '[]'::jsonb end) v
      where v in ('ferias', 'redes', 'whatsapp', 'local', 'otro')),
    'fairs_per_month', case when raw ->> 'fairs_per_month' in ('0', '1', '2-3', '4+') then raw ->> 'fairs_per_month' end,
    'main_need', case when raw ->> 'main_need' in ('ventas', 'pedidos', 'online', 'visibilidad', 'ferias', 'otro') then raw ->> 'main_need' end,
    'price', case when raw ->> 'price' in ('accesible', 'razonable', 'caro') then raw ->> 'price' end,
    'pilot', case when jsonb_typeof(raw -> 'pilot') = 'boolean' then raw -> 'pilot' end));
$$;
revoke all on function private.clean_survey(jsonb) from public, anon, authenticated;

create or replace function private.apply_founding(payload jsonb) returns boolean
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
    sells_at_fairs, message, consent_version, survey)
  values (caller, name, left(btrim(coalesce(payload ->> 'business_name', '')), 80),
    (select id from public.localities where slug = payload ->> 'locality'),
    (select id from public.categories where slug = payload ->> 'category'),
    contact, coalesce((payload ->> 'sells_at_fairs')::boolean, false),
    left(btrim(coalesce(payload ->> 'message', '')), 400), left(coalesce(payload ->> 'consent_version', 'v1'), 20),
    private.clean_survey(coalesce(payload -> 'survey', '{}'::jsonb)));
  return true;
end;
$$;

create or replace function private.admin_founding_applications() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'created_at', a.created_at, 'name', a.name,
      'business_name', a.business_name, 'locality', l.name, 'category', c.name, 'contact', a.contact,
      'sells_at_fairs', a.sells_at_fairs, 'message', a.message, 'status', a.status, 'survey', a.survey,
      'consent_version', a.consent_version, 'consented_at', a.consented_at) order by a.created_at desc)
    from private.founding_applications a
    left join public.localities l on l.id = a.locality_id
    left join public.categories c on c.id = a.category_id), '[]'::jsonb);
end;
$$;

-- Conteo de respuestas por pregunta y opción (sólo administración).
create function private.admin_survey_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Administration only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'applications', (select count(*) from private.founding_applications),
    'answered', (select count(*) from private.founding_applications where survey <> '{}'::jsonb),
    'answers', coalesce((select jsonb_object_agg(question, options) from (
      select question, jsonb_object_agg(answer, total) as options from (
        select 'channels' as question, v as answer, count(*) as total
          from private.founding_applications a, jsonb_array_elements_text(coalesce(a.survey -> 'channels', '[]'::jsonb)) v group by v
        union all
        select k, a.survey ->> k, count(*) from private.founding_applications a,
          unnest(array['fairs_per_month', 'main_need', 'price', 'pilot']) k
          where a.survey ? k group by k, a.survey ->> k
      ) counts group by question) grouped), '{}'::jsonb));
end;
$$;
revoke all on function private.admin_survey_summary() from public, anon, authenticated;
grant execute on function private.admin_survey_summary() to authenticated;
create function public.admin_survey_summary() returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.admin_survey_summary(); $$;
revoke all on function public.admin_survey_summary() from public, anon, authenticated;
grant execute on function public.admin_survey_summary() to authenticated;

create or replace function private.app_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schema', 20261012120000,
    'features', coalesce((select jsonb_object_agg(key, enabled) from private.platform_features), '{}'::jsonb),
    'now', now(),
    'today', private.today_ar());
$$;
