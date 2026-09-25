-- New orders start as 'new'; staff move them to 'cooking', then 'completed'.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (status in ('new', 'cooking', 'completed', 'cancelled'));
alter table public.orders alter column status set default 'new';

-- Gap-free order numbers (ORD-1001, ORD-1002, ...). A sequence can skip numbers
-- when an insert fails; this counter is updated in the same transaction as the
-- insert, so a failed insert rolls its number back. The row lock also means
-- two orders arriving together still get consecutive numbers.
create table if not exists private.counters (
  name text primary key,
  value bigint not null
);
revoke all on private.counters from public, anon, authenticated;

insert into private.counters (name, value)
select 'order', greatest(1000, coalesce(max(substring(id from '^ORD-(\d+)$')::bigint), 1000))
from public.orders
on conflict (name) do nothing;

create or replace function private.assign_order_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_value bigint;
begin
  update private.counters set value = value + 1 where name = 'order' returning value into next_value;
  new.id := 'ORD-' || next_value;
  return new;
end;
$$;
revoke all on function private.assign_order_id() from public, anon, authenticated;

drop trigger if exists assign_order_id on public.orders;
create trigger assign_order_id before insert on public.orders
  for each row execute function private.assign_order_id();

alter table public.orders alter column id drop default;
drop sequence if exists public.order_seq;

-- Dashboard KPIs for one day in the restaurant's time zone. Runs as the caller, so RLS applies.
create or replace function public.order_stats(p_date text, p_tz text)
returns json
language sql
stable
security invoker
set search_path = ''
as $$
  with day as (
    select status from public.orders where (created_at at time zone p_tz)::date::text = p_date
  )
  select json_build_object(
    'date', p_date,
    'orders', (select count(*) from day),
    'new', (select count(*) from day where status = 'new'),
    'cooking', (select count(*) from day where status = 'cooking'),
    'completed', (select count(*) from day where status = 'completed'),
    'cancelled', (select count(*) from day where status = 'cancelled'),
    'all_time_orders', (select count(*) from public.orders)
  );
$$;
revoke all on function public.order_stats(text, text) from public;
grant execute on function public.order_stats(text, text) to anon, authenticated;

drop function if exists public.dashboard_stats(text, text);
