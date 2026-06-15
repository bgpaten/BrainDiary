-- =============================================================================
-- Personal Brain OS — Timeline Intelligence + Brain Digest
-- Migration: create_brain_reports
-- Phase 12: periodic brain reports and digest history
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.brain_reports (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null,
  report_type            text not null
                           check (report_type in ('daily', 'weekly', 'monthly', 'custom')),
  period_start           date not null,
  period_end             date not null,
  title                  text not null,
  summary                text,
  content                text,
  highlights             jsonb not null default '[]'::jsonb,
  active_projects        jsonb not null default '[]'::jsonb,
  repeated_patterns      jsonb not null default '[]'::jsonb,
  decisions              jsonb not null default '[]'::jsonb,
  risks                  jsonb not null default '[]'::jsonb,
  suggested_next_actions jsonb not null default '[]'::jsonb,
  source_refs            jsonb not null default '[]'::jsonb,
  model_provider         text,
  model_name             text,
  status                 text not null default 'draft'
                           check (status in ('draft', 'done', 'failed')),
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint chk_brain_reports_period_order check (period_end >= period_start)
);

create index if not exists idx_brain_reports_user_id      on public.brain_reports (user_id);
create index if not exists idx_brain_reports_report_type  on public.brain_reports (report_type);
create index if not exists idx_brain_reports_period_start on public.brain_reports (period_start);
create index if not exists idx_brain_reports_period_end   on public.brain_reports (period_end);
create index if not exists idx_brain_reports_status       on public.brain_reports (status);
create unique index if not exists uq_brain_reports_user_type_period
  on public.brain_reports (user_id, report_type, period_start, period_end);

drop trigger if exists trg_brain_reports_updated_at on public.brain_reports;
create trigger trg_brain_reports_updated_at
  before update on public.brain_reports
  for each row execute function public.set_updated_at();

alter table public.brain_reports enable row level security;

drop policy if exists "brain_reports_select_own" on public.brain_reports;
create policy "brain_reports_select_own" on public.brain_reports
  for select using (auth.uid() = user_id);

drop policy if exists "brain_reports_insert_own" on public.brain_reports;
create policy "brain_reports_insert_own" on public.brain_reports
  for insert with check (auth.uid() = user_id);

drop policy if exists "brain_reports_update_own" on public.brain_reports;
create policy "brain_reports_update_own" on public.brain_reports
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "brain_reports_delete_own" on public.brain_reports;
create policy "brain_reports_delete_own" on public.brain_reports
  for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
