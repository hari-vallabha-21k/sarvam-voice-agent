-- Schema for the SpiceGarden dashboard (src/supabase-store.js).
--
-- The server talks to PostgREST with the project's publishable key. That key is
-- public by design, so every table is locked with RLS and the only policy lets a
-- request through when it carries the "x-app-secret" header matching the value
-- in private.app_config. Set it once after running this migration:
--
--   insert into private.app_config (app_secret) values ('<same value as SUPABASE_APP_SECRET>');

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create table if not exists private.app_config (
  id boolean primary key default true check (id),
  app_secret text not null check (length(app_secret) >= 32)
);
revoke all on private.app_config from public, anon, authenticated;

create or replace function private.is_app()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (current_setting('request.headers', true)::json ->> 'x-app-secret')
      = (select app_secret from private.app_config where id),
    false
  );
$$;
revoke all on function private.is_app() from public;
grant execute on function private.is_app() to anon, authenticated;

create sequence if not exists public.order_seq start with 1001;
create sequence if not exists public.booking_seq start with 501;

create table if not exists public.orders (
  id text primary key default ('ORD-' || nextval('public.order_seq')),
  call_id text,
  status text not null default 'cooking' check (status in ('cooking', 'completed', 'cancelled')),
  customer_name text,
  customer_phone text,
  order_type text,
  delivery_address text,
  items jsonb not null default '[]'::jsonb,
  subtotal integer not null default 0,
  tax integer not null default 0,
  total integer not null default 0,
  notes text,
  call_summary text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists orders_call_id_idx on public.orders (call_id);
create index if not exists orders_created_at_idx on public.orders (created_at desc);

create table if not exists public.bookings (
  id text primary key default ('BKG-' || nextval('public.booking_seq')),
  call_id text,
  status text not null default 'confirmed' check (status in ('confirmed', 'seated', 'cancelled', 'no_show')),
  customer_name text,
  customer_phone text,
  booking_date text not null,
  booking_time text not null,
  party_size integer,
  notes text,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists bookings_call_id_idx on public.bookings (call_id);
create index if not exists bookings_date_idx on public.bookings (booking_date, booking_time);

create table if not exists public.calls (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  call_id text,
  customer_name text,
  customer_phone text,
  disposition text,
  call_summary text,
  order_id text,
  booking_id text,
  payload jsonb
);
create index if not exists calls_received_at_idx on public.calls (received_at desc);

create table if not exists public.sms (
  id bigint generated always as identity primary key,
  sent_at timestamptz not null default now(),
  to_phone text,
  text text,
  provider text,
  status text,
  call_id text
);

alter table public.orders enable row level security;
alter table public.bookings enable row level security;
alter table public.calls enable row level security;
alter table public.sms enable row level security;

create policy app_all on public.orders for all to anon, authenticated using ((select private.is_app())) with check ((select private.is_app()));
create policy app_all on public.bookings for all to anon, authenticated using ((select private.is_app())) with check ((select private.is_app()));
create policy app_all on public.calls for all to anon, authenticated using ((select private.is_app())) with check ((select private.is_app()));
create policy app_all on public.sms for all to anon, authenticated using ((select private.is_app())) with check ((select private.is_app()));

grant usage on sequence public.order_seq, public.booking_seq to anon, authenticated;

-- Dashboard KPIs in one round trip. Runs as the caller, so RLS still applies.
create or replace function public.dashboard_stats(p_today text, p_tz text)
returns json
language sql
stable
security invoker
set search_path = ''
as $$
  select json_build_object(
    'total_orders', (select count(*) from public.orders),
    'cooking', (select count(*) from public.orders where status = 'cooking'),
    'completed', (select count(*) from public.orders where status = 'completed'),
    'cancelled', (select count(*) from public.orders where status = 'cancelled'),
    'orders_today', (select count(*) from public.orders where (created_at at time zone p_tz)::date::text = p_today),
    'bookings_today', (select count(*) from public.bookings where booking_date = p_today and status <> 'cancelled'),
    'upcoming_bookings', (select count(*) from public.bookings where booking_date >= p_today and status in ('confirmed', 'seated')),
    'total_bookings', (select count(*) from public.bookings),
    'calls_received', (select count(*) from public.calls)
  );
$$;
revoke all on function public.dashboard_stats(text, text) from public;
grant execute on function public.dashboard_stats(text, text) to anon, authenticated;
