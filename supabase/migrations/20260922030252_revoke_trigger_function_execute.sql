-- Las funciones de trigger heredaban EXECUTE para PUBLIC. No son alcanzables
-- (viven en `private`, esquema que `anon` no puede usar, y una función de
-- trigger no se puede invocar suelta), pero la auditoría las marca y cerrarlas
-- no cuesta nada.
begin;
revoke all on function private.touch_updated_at() from public, anon, authenticated;
revoke all on function private.set_product_scope() from public, anon, authenticated;
revoke all on function private.enforce_variant_limit() from public, anon, authenticated;
commit;
