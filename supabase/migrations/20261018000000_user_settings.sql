-- Supabase Auth owns accounts in auth.users. This table holds each account's app preferences.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  text_scale numeric not null default 1.0 check (text_scale in (1.0, 1.15, 1.3, 1.45)),
  color_theme text not null default 'light' check (color_theme in ('light', 'high-contrast', 'dark')),
  speech_rate numeric not null default 1.0 check (speech_rate in (0.75, 1.0, 1.25, 1.5)),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

revoke all on table public.user_settings from anon, authenticated;
grant select, insert, update, delete on table public.user_settings to authenticated;

drop policy if exists "Users can read their own settings" on public.user_settings;
create policy "Users can read their own settings"
  on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own settings" on public.user_settings;
create policy "Users can create their own settings"
  on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own settings" on public.user_settings;
create policy "Users can update their own settings"
  on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own settings" on public.user_settings;
create policy "Users can delete their own settings"
  on public.user_settings for delete to authenticated
  using ((select auth.uid()) = user_id);
