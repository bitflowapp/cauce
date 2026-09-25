-- Las líneas y los eventos de un pedido tienen dos claves hacia él: una que
-- amarra el comercio y otra la cuenta. Con nombres propios, la lectura embebida
-- dice cuál usa en vez de depender de nombres generados.
begin;

alter table public.order_items rename constraint order_items_order_id_business_id_fkey to order_items_business_scope;
alter table public.order_items rename constraint order_items_order_id_customer_id_fkey to order_items_customer_scope;
alter table public.order_events rename constraint order_events_order_id_business_id_fkey to order_events_business_scope;
alter table public.order_events rename constraint order_events_order_id_customer_id_fkey to order_events_customer_scope;

commit;
