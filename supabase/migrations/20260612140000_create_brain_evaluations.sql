-- =============================================================================
-- Personal Brain OS — Brain Evaluation / Memory Accuracy Test
-- Migration: create_brain_evaluations
-- Phase 14: local evaluation suite for grounded Brain Chat + Persona Layer
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.brain_eval_cases (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  case_type         text not null
                      check (case_type in (
                        'factual',
                        'persona_mode',
                        'source_grounding',
                        'insufficient_memory',
                        'contradiction',
                        'strategy',
                        'semantic_retrieval',
                        'timeline',
                        'digest'
                      )),
  question          text not null,
  expected_behavior text,
  expected_mode     text,
  expected_sources  jsonb not null default '[]'::jsonb,
  expected_keywords jsonb not null default '[]'::jsonb,
  should_answer     boolean not null default true,
  difficulty        text not null default 'medium'
                      check (difficulty in ('easy', 'medium', 'hard')),
  source_refs       jsonb not null default '[]'::jsonb,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint chk_brain_eval_cases_question_not_blank check (length(btrim(question)) > 0)
);

create table if not exists public.brain_eval_runs (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null,
  title                      text not null,
  status                     text not null default 'pending'
                               check (status in ('pending', 'running', 'done', 'failed')),
  total_cases                integer not null default 0,
  passed_cases               integer not null default 0,
  failed_cases               integer not null default 0,
  average_score              numeric(5,4) not null default 0,
  retrieval_accuracy         numeric(5,4) not null default 0,
  source_accuracy            numeric(5,4) not null default 0,
  groundedness_score         numeric(5,4) not null default 0,
  hallucination_risk         numeric(5,4) not null default 0,
  persona_mode_accuracy      numeric(5,4) not null default 0,
  insufficient_memory_score  numeric(5,4) not null default 0,
  answer_usefulness          numeric(5,4) not null default 0,
  started_at                 timestamptz,
  finished_at                timestamptz,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create table if not exists public.brain_eval_results (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  eval_run_id     uuid not null references public.brain_eval_runs(id) on delete cascade,
  eval_case_id    uuid references public.brain_eval_cases(id) on delete set null,
  question        text not null,
  answer          text,
  expected_mode   text,
  actual_mode     text,
  sources         jsonb not null default '[]'::jsonb,
  scores          jsonb not null default '{}'::jsonb,
  passed          boolean not null default false,
  failure_reason  text,
  judge_feedback  text,
  raw_response    jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_brain_eval_cases_user_id    on public.brain_eval_cases (user_id);
create index if not exists idx_brain_eval_cases_case_type  on public.brain_eval_cases (case_type);
create index if not exists idx_brain_eval_cases_created_at on public.brain_eval_cases (created_at);

create index if not exists idx_brain_eval_runs_user_id     on public.brain_eval_runs (user_id);
create index if not exists idx_brain_eval_runs_created_at  on public.brain_eval_runs (created_at);

create index if not exists idx_brain_eval_results_user_id     on public.brain_eval_results (user_id);
create index if not exists idx_brain_eval_results_eval_run_id on public.brain_eval_results (eval_run_id);
create index if not exists idx_brain_eval_results_passed      on public.brain_eval_results (passed);
create index if not exists idx_brain_eval_results_created_at  on public.brain_eval_results (created_at);

drop trigger if exists trg_brain_eval_cases_updated_at on public.brain_eval_cases;
create trigger trg_brain_eval_cases_updated_at
  before update on public.brain_eval_cases
  for each row execute function public.set_updated_at();

drop trigger if exists trg_brain_eval_runs_updated_at on public.brain_eval_runs;
create trigger trg_brain_eval_runs_updated_at
  before update on public.brain_eval_runs
  for each row execute function public.set_updated_at();

alter table public.brain_eval_cases enable row level security;
alter table public.brain_eval_runs enable row level security;
alter table public.brain_eval_results enable row level security;

drop policy if exists "brain_eval_cases_select_own" on public.brain_eval_cases;
create policy "brain_eval_cases_select_own" on public.brain_eval_cases
  for select using (auth.uid() = user_id);

drop policy if exists "brain_eval_cases_insert_own" on public.brain_eval_cases;
create policy "brain_eval_cases_insert_own" on public.brain_eval_cases
  for insert with check (auth.uid() = user_id);

drop policy if exists "brain_eval_cases_update_own" on public.brain_eval_cases;
create policy "brain_eval_cases_update_own" on public.brain_eval_cases
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "brain_eval_cases_delete_own" on public.brain_eval_cases;
create policy "brain_eval_cases_delete_own" on public.brain_eval_cases
  for delete using (auth.uid() = user_id);

drop policy if exists "brain_eval_runs_select_own" on public.brain_eval_runs;
create policy "brain_eval_runs_select_own" on public.brain_eval_runs
  for select using (auth.uid() = user_id);

drop policy if exists "brain_eval_runs_insert_own" on public.brain_eval_runs;
create policy "brain_eval_runs_insert_own" on public.brain_eval_runs
  for insert with check (auth.uid() = user_id);

drop policy if exists "brain_eval_runs_update_own" on public.brain_eval_runs;
create policy "brain_eval_runs_update_own" on public.brain_eval_runs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "brain_eval_runs_delete_own" on public.brain_eval_runs;
create policy "brain_eval_runs_delete_own" on public.brain_eval_runs
  for delete using (auth.uid() = user_id);

drop policy if exists "brain_eval_results_select_own" on public.brain_eval_results;
create policy "brain_eval_results_select_own" on public.brain_eval_results
  for select using (auth.uid() = user_id);

drop policy if exists "brain_eval_results_insert_own" on public.brain_eval_results;
create policy "brain_eval_results_insert_own" on public.brain_eval_results
  for insert with check (auth.uid() = user_id);

drop policy if exists "brain_eval_results_update_own" on public.brain_eval_results;
create policy "brain_eval_results_update_own" on public.brain_eval_results
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "brain_eval_results_delete_own" on public.brain_eval_results;
create policy "brain_eval_results_delete_own" on public.brain_eval_results
  for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
