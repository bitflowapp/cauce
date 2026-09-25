begin;
-- Read only access contract. Resolves administrator status from the private table.
create function public.my_access() returns boolean
language sql stable security invoker set search_path = ''
as $$ select private.is_admin(); $$;
revoke all on function public.my_access() from public, anon, authenticated;
grant execute on function public.my_access() to authenticated;
-- Explicit deny documents intentional operator-only provisioning.
create policy admin_no_client_access on private.platform_admins
for all to anon, authenticated using (false) with check (false);
commit;
