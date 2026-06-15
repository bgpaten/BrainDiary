-- =============================================================================
-- Personal Entity OS — Final Release
-- Step 30: final release checks, artifacts, and release notes
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.final_release_runs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  release_name        text not null default 'Personal Entity OS Final Release',
  release_version     text not null default '1.0.0',
  status              text not null default 'pending' check (status in ('pending','running','done','failed','blocked')),
  release_type        text not null default 'manual' check (release_type in ('manual','daily_use','release_candidate','final')),
  overall_score       numeric(6,3) not null default 0 check (overall_score >= 0 and overall_score <= 100),
  readiness_level     text not null default 'not_ready' check (readiness_level in ('not_ready','early','usable_with_warning','stable','release_candidate','final_ready')),
  release_decision    text not null default 'do_not_use' check (release_decision in ('do_not_use','internal_testing_only','daily_use_with_warning','stable_daily_use','ready_for_final_use')),
  blocker_count       integer not null default 0,
  warning_count       integer not null default 0,
  passed_check_count  integer not null default 0,
  failed_check_count  integer not null default 0,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  summary             text,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.final_release_checks (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  final_release_run_id   uuid references public.final_release_runs(id) on delete cascade,
  check_category        text not null check (check_category in ('environment','database','migration','security','frontend','scripts','obsidian','backup','brain_data','identity','communication','response_inference','calibration','similarity','drift','reflection','chat_samples','conflicts','self_clone_eval','runtime','long_term_memory','documentation','release')),
  check_name            text not null,
  description           text,
  status                text not null default 'skipped' check (status in ('passed','warning','failed','blocked','skipped')),
  severity              text not null default 'medium' check (severity in ('low','medium','high','critical')),
  score                 numeric(6,3) not null default 0 check (score >= 0 and score <= 100),
  expected              text,
  actual                text,
  details               jsonb not null default '{}'::jsonb,
  recommended_fix       text,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.final_release_artifacts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  final_release_run_id   uuid references public.final_release_runs(id) on delete cascade,
  artifact_type         text not null check (artifact_type in ('obsidian_report','backup','manual','checklist','readiness_report','audit_report','release_notes','migration_summary','security_report','build_report')),
  title                 text not null,
  path                  text,
  description           text,
  status                text not null default 'created' check (status in ('created','missing','failed','skipped')),
  checksum              text,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.final_release_notes (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null,
  final_release_run_id       uuid references public.final_release_runs(id) on delete set null,
  version                   text not null,
  title                     text not null,
  summary                   text,
  completed_phases          jsonb not null default '[]'::jsonb,
  known_limitations         jsonb not null default '[]'::jsonb,
  safety_boundaries         jsonb not null default '[]'::jsonb,
  daily_usage_instructions  jsonb not null default '[]'::jsonb,
  recommended_next_steps    jsonb not null default '[]'::jsonb,
  status                    text not null default 'draft' check (status in ('draft','done','archived')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  metadata                  jsonb not null default '{}'::jsonb
);

create index if not exists idx_final_release_runs_user_id on public.final_release_runs(user_id);
create index if not exists idx_final_release_runs_status on public.final_release_runs(status);
create index if not exists idx_final_release_runs_release_type on public.final_release_runs(release_type);
create index if not exists idx_final_release_runs_readiness on public.final_release_runs(readiness_level);
create index if not exists idx_final_release_runs_decision on public.final_release_runs(release_decision);
create index if not exists idx_final_release_runs_created_at on public.final_release_runs(created_at);
create index if not exists idx_final_release_checks_user_id on public.final_release_checks(user_id);
create index if not exists idx_final_release_checks_run_id on public.final_release_checks(final_release_run_id);
create index if not exists idx_final_release_checks_category on public.final_release_checks(check_category);
create index if not exists idx_final_release_checks_severity on public.final_release_checks(severity);
create index if not exists idx_final_release_checks_created_at on public.final_release_checks(created_at);
create index if not exists idx_final_release_artifacts_user_id on public.final_release_artifacts(user_id);
create index if not exists idx_final_release_artifacts_run_id on public.final_release_artifacts(final_release_run_id);
create index if not exists idx_final_release_artifacts_status on public.final_release_artifacts(status);
create index if not exists idx_final_release_artifacts_created_at on public.final_release_artifacts(created_at);
create index if not exists idx_final_release_notes_user_id on public.final_release_notes(user_id);
create index if not exists idx_final_release_notes_run_id on public.final_release_notes(final_release_run_id);
create index if not exists idx_final_release_notes_status on public.final_release_notes(status);
create index if not exists idx_final_release_notes_created_at on public.final_release_notes(created_at);

drop trigger if exists trg_final_release_runs_updated_at on public.final_release_runs;
create trigger trg_final_release_runs_updated_at before update on public.final_release_runs for each row execute function public.set_updated_at();
drop trigger if exists trg_final_release_checks_updated_at on public.final_release_checks;
create trigger trg_final_release_checks_updated_at before update on public.final_release_checks for each row execute function public.set_updated_at();
drop trigger if exists trg_final_release_artifacts_updated_at on public.final_release_artifacts;
create trigger trg_final_release_artifacts_updated_at before update on public.final_release_artifacts for each row execute function public.set_updated_at();
drop trigger if exists trg_final_release_notes_updated_at on public.final_release_notes;
create trigger trg_final_release_notes_updated_at before update on public.final_release_notes for each row execute function public.set_updated_at();

alter table public.final_release_runs enable row level security;
alter table public.final_release_checks enable row level security;
alter table public.final_release_artifacts enable row level security;
alter table public.final_release_notes enable row level security;

do $$
declare t text;
begin
  foreach t in array array['final_release_runs','final_release_checks','final_release_artifacts','final_release_notes'] loop
    execute format('drop policy if exists "%1$s_select_own" on public.%1$I', t);
    execute format('create policy "%1$s_select_own" on public.%1$I for select using (auth.uid() = user_id)', t);
    execute format('drop policy if exists "%1$s_insert_own" on public.%1$I', t);
    execute format('create policy "%1$s_insert_own" on public.%1$I for insert with check (auth.uid() = user_id)', t);
    execute format('drop policy if exists "%1$s_update_own" on public.%1$I', t);
    execute format('create policy "%1$s_update_own" on public.%1$I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('drop policy if exists "%1$s_delete_own" on public.%1$I', t);
    execute format('create policy "%1$s_delete_own" on public.%1$I for delete using (auth.uid() = user_id)', t);
  end loop;
end $$;

-- =============================================================================
-- End of migration
-- =============================================================================
