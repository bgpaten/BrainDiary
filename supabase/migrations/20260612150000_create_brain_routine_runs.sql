-- =============================================================================
-- Phase 15: Daily Brain Routine + Stabilization
-- =============================================================================

create table if not exists public.brain_routine_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  routine_type  text not null default 'daily'
                  check (routine_type in ('daily', 'manual', 'health_check')),
  status        text not null default 'pending'
                  check (status in ('pending', 'running', 'done', 'partial', 'failed')),
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   integer,
  summary       text,
  steps         jsonb not null default '[]'::jsonb,
  metrics       jsonb not null default '{}'::jsonb,
  warnings      jsonb not null default '[]'::jsonb,
  errors        jsonb not null default '[]'::jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_brain_routine_runs_user_id
  on public.brain_routine_runs (user_id);

create index if not exists idx_brain_routine_runs_status
  on public.brain_routine_runs (status);

create index if not exists idx_brain_routine_runs_routine_type
  on public.brain_routine_runs (routine_type);

create index if not exists idx_brain_routine_runs_created_at
  on public.brain_routine_runs (created_at desc);

create trigger trg_brain_routine_runs_updated_at
  before update on public.brain_routine_runs
  for each row execute function public.set_updated_at();

alter table public.brain_routine_runs enable row level security;

create policy "brain_routine_runs_select_own" on public.brain_routine_runs
  for select using (auth.uid() = user_id);
create policy "brain_routine_runs_insert_own" on public.brain_routine_runs
  for insert with check (auth.uid() = user_id);
create policy "brain_routine_runs_update_own" on public.brain_routine_runs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "brain_routine_runs_delete_own" on public.brain_routine_runs
  for delete using (auth.uid() = user_id);

create table if not exists public.brain_health_checks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  status      text not null check (status in ('healthy', 'warning', 'critical')),
  score       integer not null default 0 check (score >= 0 and score <= 100),
  checks      jsonb not null default '[]'::jsonb,
  warnings    jsonb not null default '[]'::jsonb,
  errors      jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_brain_health_checks_user_id
  on public.brain_health_checks (user_id);

create index if not exists idx_brain_health_checks_status
  on public.brain_health_checks (status);

create index if not exists idx_brain_health_checks_created_at
  on public.brain_health_checks (created_at desc);

alter table public.brain_health_checks enable row level security;

create policy "brain_health_checks_select_own" on public.brain_health_checks
  for select using (auth.uid() = user_id);
create policy "brain_health_checks_insert_own" on public.brain_health_checks
  for insert with check (auth.uid() = user_id);
create policy "brain_health_checks_delete_own" on public.brain_health_checks
  for delete using (auth.uid() = user_id);
