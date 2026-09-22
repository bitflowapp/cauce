-- CAUCE: sincronización en vivo de pedidos y viajes, y denegaciones explícitas.
begin;

-- Las tablas de referencia de transiciones sólo las leen las funciones con
-- privilegio (que corren como dueño). La denegación queda escrita, no supuesta.
create policy transitions_no_client_access on private.order_transitions
for all to anon, authenticated using (false) with check (false);
create policy trip_transitions_no_client_access on private.trip_transitions
for all to anon, authenticated using (false) with check (false);

-- Realtime entrega cada cambio pasando la fila por las políticas de la tabla:
-- un comercio recibe sus pedidos y un cliente los suyos, nadie recibe ajenos.
-- No se crean objetos en el esquema `realtime`, que está protegido.
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_events;
alter publication supabase_realtime add table public.trips;
alter publication supabase_realtime add table public.trip_events;

commit;
