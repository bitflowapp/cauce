-- La columna `condition` se agregó después del contrato de privilegios del
-- catálogo. Sin estos grants por columna, PostgREST rechaza el alta de un
-- producto con la condición por defecto (`new`) aunque el resto de la fila
-- esté permitido. El propietario/encargado sigue limitado por RLS: sólo puede
-- escribir filas de un comercio que administra.
grant insert (condition), update (condition) on public.products to authenticated;
