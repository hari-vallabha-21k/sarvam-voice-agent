-- Baileys login state for the WhatsApp service (wa-service/). One row per key,
-- so a redeploy reconnects without scanning the QR code again.

create table if not exists public.wa_auth (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.wa_auth enable row level security;
create policy app_all on public.wa_auth for all to anon, authenticated using ((select private.is_app())) with check ((select private.is_app()));
