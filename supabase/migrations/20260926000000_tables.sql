-- Restaurant tables, and bookings assigned to them. Mirrors DEFAULT_TABLES in src/tables.js.

create table if not exists public.tables (
  id text primary key,
  size text not null check (size in ('small', 'medium', 'large')),
  seats integer not null check (seats > 0),
  area text not null,
  sort integer not null default 0,
  active boolean not null default true
);
alter table public.tables enable row level security;
create policy app_all on public.tables for all to anon, authenticated using ((select private.is_app())) with check ((select private.is_app()));

insert into public.tables (id, size, seats, area, sort) values
  ('T-01', 'small', 4, 'Main Hall', 1),
  ('T-02', 'small', 4, 'Main Hall', 2),
  ('T-03', 'small', 4, 'Main Hall', 3),
  ('T-04', 'medium', 6, 'Main Hall', 4),
  ('T-05', 'medium', 6, 'Main Hall', 5),
  ('T-06', 'large', 8, 'Main Hall', 6),
  ('T-07', 'small', 4, 'Patio', 7),
  ('T-08', 'small', 4, 'Patio', 8),
  ('T-09', 'medium', 6, 'Patio', 9),
  ('T-10', 'medium', 6, 'Family Room', 10),
  ('T-11', 'large', 8, 'Family Room', 11),
  ('T-12', 'large', 8, 'Family Room', 12)
on conflict (id) do nothing;

alter table public.bookings add column if not exists table_id text references public.tables (id);
alter table public.bookings add column if not exists updated_at timestamptz;
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('confirmed', 'seated', 'completed', 'cancelled', 'no_show'));
create index if not exists bookings_table_date_idx on public.bookings (table_id, booking_date);

-- One sitting length, shared with the app's BOOKING_DURATION_MIN (keep both at the same value).
alter table private.app_config add column if not exists booking_duration_min integer not null default 90;

-- "19:30" -> 1170; anything that is not HH:MM gives null, so it never matches.
create or replace function private.minutes(t text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when t ~ '^\d{1,2}:\d{2}$' then split_part(t, ':', 1)::int * 60 + split_part(t, ':', 2)::int end;
$$;
revoke all on function private.minutes(text) from public, anon, authenticated;

-- A table holds one active booking per sitting. The row lock on the table makes
-- two bookings racing for it take turns, so the second one sees the first.
create or replace function private.check_table_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  duration integer;
begin
  if new.table_id is null or new.status not in ('confirmed', 'seated') then
    return new;
  end if;
  perform 1 from public.tables where id = new.table_id for update;
  select booking_duration_min into duration from private.app_config where id;
  if exists (
    select 1 from public.bookings b
    where b.table_id = new.table_id
      and b.booking_date = new.booking_date
      and b.status in ('confirmed', 'seated')
      and b.id is distinct from new.id
      and abs(private.minutes(b.booking_time) - private.minutes(new.booking_time)) < coalesce(duration, 90)
  ) then
    raise exception 'Table % is already booked around %', new.table_id, new.booking_time
      using errcode = 'exclusion_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.check_table_booking() from public, anon, authenticated;

drop trigger if exists check_table_booking on public.bookings;
create trigger check_table_booking before insert or update of table_id, status, booking_date, booking_time on public.bookings
  for each row execute function private.check_table_booking();
