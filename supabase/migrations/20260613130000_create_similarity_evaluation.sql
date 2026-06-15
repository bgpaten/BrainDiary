-- =============================================================================
-- Personal Entity OS — Similarity Evaluation Loop
-- Migration: create_similarity_evaluation
-- Step 22: recurring owner-answer similarity and regression tracking
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.similarity_eval_runs (
  id                           uuid primary key default gen_random_uuid(),
  user_id                      uuid not null,
  title                        text not null,
  status                       text not null default 'pending'
                                 check (status in ('pending', 'running', 'done', 'failed')),
  run_type                     text not null default 'manual'
                                 check (run_type in ('manual', 'daily', 'weekly', 'baseline', 'regression')),
  baseline_run_id              uuid references public.similarity_eval_runs(id) on delete set null,
  total_cases                  integer not null default 0,
  passed_cases                 integer not null default 0,
  failed_cases                 integer not null default 0,
  regression_count             integer not null default 0,
  improvement_count            integer not null default 0,
  average_similarity_score     numeric(5,4) not null default 0 check (average_similarity_score >= 0 and average_similarity_score <= 1),
  average_fidelity_score       numeric(5,4) not null default 0 check (average_fidelity_score >= 0 and average_fidelity_score <= 1),
  average_style_match_score    numeric(5,4) not null default 0 check (average_style_match_score >= 0 and average_style_match_score <= 1),
  average_intent_match_score   numeric(5,4) not null default 0 check (average_intent_match_score >= 0 and average_intent_match_score <= 1),
  average_tone_match_score     numeric(5,4) not null default 0 check (average_tone_match_score >= 0 and average_tone_match_score <= 1),
  average_length_match_score   numeric(5,4) not null default 0 check (average_length_match_score >= 0 and average_length_match_score <= 1),
  average_too_ai_score         numeric(5,4) not null default 0 check (average_too_ai_score >= 0 and average_too_ai_score <= 1),
  average_overclaim_risk       numeric(5,4) not null default 0 check (average_overclaim_risk >= 0 and average_overclaim_risk <= 1),
  average_underfit_risk        numeric(5,4) not null default 0 check (average_underfit_risk >= 0 and average_underfit_risk <= 1),
  overall_score                numeric(5,4) not null default 0 check (overall_score >= 0 and overall_score <= 1),
  verdict                      text not null default 'warning'
                                 check (verdict in ('excellent', 'good', 'warning', 'bad', 'blocked')),
  started_at                   timestamptz,
  finished_at                  timestamptz,
  metadata                     jsonb not null default '{}'::jsonb,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create table if not exists public.similarity_eval_results (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null,
  similarity_eval_run_id     uuid not null references public.similarity_eval_runs(id) on delete cascade,
  owner_answer_example_id    uuid not null references public.owner_answer_examples(id) on delete cascade,
  prompt                     text not null,
  owner_answer               text not null,
  agent_answer               text not null,
  intent_type                text not null,
  actual_intent_type         text not null,
  expected_answer_style      text,
  actual_answer_style        text,
  similarity_score           numeric(5,4) not null default 0 check (similarity_score >= 0 and similarity_score <= 1),
  fidelity_score             numeric(5,4) not null default 0 check (fidelity_score >= 0 and fidelity_score <= 1),
  style_match_score          numeric(5,4) not null default 0 check (style_match_score >= 0 and style_match_score <= 1),
  intent_match_score         numeric(5,4) not null default 0 check (intent_match_score >= 0 and intent_match_score <= 1),
  tone_match_score           numeric(5,4) not null default 0 check (tone_match_score >= 0 and tone_match_score <= 1),
  length_match_score         numeric(5,4) not null default 0 check (length_match_score >= 0 and length_match_score <= 1),
  too_ai_score               numeric(5,4) not null default 0 check (too_ai_score >= 0 and too_ai_score <= 1),
  overclaim_risk             numeric(5,4) not null default 0 check (overclaim_risk >= 0 and overclaim_risk <= 1),
  underfit_risk              numeric(5,4) not null default 0 check (underfit_risk >= 0 and underfit_risk <= 1),
  regression_score           numeric(5,4) not null default 0 check (regression_score >= 0 and regression_score <= 1),
  baseline_result_id         uuid references public.similarity_eval_results(id) on delete set null,
  passed                     boolean not null default false,
  regressed                  boolean not null default false,
  improved                   boolean not null default false,
  failure_reason             text,
  judge_feedback             text,
  missing_elements           jsonb not null default '[]'::jsonb,
  extra_elements             jsonb not null default '[]'::jsonb,
  recommendations            jsonb not null default '[]'::jsonb,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);

create table if not exists public.similarity_baselines (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null,
  similarity_eval_run_id     uuid not null references public.similarity_eval_runs(id) on delete cascade,
  label                      text not null,
  description                text,
  overall_score              numeric(5,4) not null default 0 check (overall_score >= 0 and overall_score <= 1),
  average_similarity_score   numeric(5,4) not null default 0 check (average_similarity_score >= 0 and average_similarity_score <= 1),
  average_fidelity_score     numeric(5,4) not null default 0 check (average_fidelity_score >= 0 and average_fidelity_score <= 1),
  average_style_match_score  numeric(5,4) not null default 0 check (average_style_match_score >= 0 and average_style_match_score <= 1),
  average_too_ai_score       numeric(5,4) not null default 0 check (average_too_ai_score >= 0 and average_too_ai_score <= 1),
  average_overclaim_risk     numeric(5,4) not null default 0 check (average_overclaim_risk >= 0 and average_overclaim_risk <= 1),
  average_underfit_risk      numeric(5,4) not null default 0 check (average_underfit_risk >= 0 and average_underfit_risk <= 1),
  case_count                 integer not null default 0,
  status                     text not null default 'candidate'
                               check (status in ('active', 'archived', 'candidate', 'rejected')),
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create index if not exists idx_similarity_eval_runs_user_id         on public.similarity_eval_runs (user_id);
create index if not exists idx_similarity_eval_runs_run_type        on public.similarity_eval_runs (run_type);
create index if not exists idx_similarity_eval_runs_status          on public.similarity_eval_runs (status);
create index if not exists idx_similarity_eval_runs_verdict         on public.similarity_eval_runs (verdict);
create index if not exists idx_similarity_eval_runs_created_at      on public.similarity_eval_runs (created_at);
create index if not exists idx_similarity_eval_runs_baseline_run_id on public.similarity_eval_runs (baseline_run_id);

create index if not exists idx_similarity_eval_results_user_id                 on public.similarity_eval_results (user_id);
create index if not exists idx_similarity_eval_results_run_id                  on public.similarity_eval_results (similarity_eval_run_id);
create index if not exists idx_similarity_eval_results_owner_answer_example_id on public.similarity_eval_results (owner_answer_example_id);
create index if not exists idx_similarity_eval_results_created_at              on public.similarity_eval_results (created_at);

create index if not exists idx_similarity_baselines_user_id      on public.similarity_baselines (user_id);
create index if not exists idx_similarity_baselines_run_id       on public.similarity_baselines (similarity_eval_run_id);
create index if not exists idx_similarity_baselines_status       on public.similarity_baselines (status);
create index if not exists idx_similarity_baselines_created_at   on public.similarity_baselines (created_at);

drop trigger if exists trg_similarity_eval_runs_updated_at on public.similarity_eval_runs;
create trigger trg_similarity_eval_runs_updated_at
  before update on public.similarity_eval_runs
  for each row execute function public.set_updated_at();

drop trigger if exists trg_similarity_baselines_updated_at on public.similarity_baselines;
create trigger trg_similarity_baselines_updated_at
  before update on public.similarity_baselines
  for each row execute function public.set_updated_at();

alter table public.similarity_eval_runs enable row level security;
alter table public.similarity_eval_results enable row level security;
alter table public.similarity_baselines enable row level security;

drop policy if exists "similarity_eval_runs_select_own" on public.similarity_eval_runs;
create policy "similarity_eval_runs_select_own" on public.similarity_eval_runs for select using (auth.uid() = user_id);
drop policy if exists "similarity_eval_runs_insert_own" on public.similarity_eval_runs;
create policy "similarity_eval_runs_insert_own" on public.similarity_eval_runs for insert with check (auth.uid() = user_id);
drop policy if exists "similarity_eval_runs_update_own" on public.similarity_eval_runs;
create policy "similarity_eval_runs_update_own" on public.similarity_eval_runs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "similarity_eval_results_select_own" on public.similarity_eval_results;
create policy "similarity_eval_results_select_own" on public.similarity_eval_results for select using (auth.uid() = user_id);
drop policy if exists "similarity_eval_results_insert_own" on public.similarity_eval_results;
create policy "similarity_eval_results_insert_own" on public.similarity_eval_results for insert with check (auth.uid() = user_id);

drop policy if exists "similarity_baselines_select_own" on public.similarity_baselines;
create policy "similarity_baselines_select_own" on public.similarity_baselines for select using (auth.uid() = user_id);
drop policy if exists "similarity_baselines_insert_own" on public.similarity_baselines;
create policy "similarity_baselines_insert_own" on public.similarity_baselines for insert with check (auth.uid() = user_id);
drop policy if exists "similarity_baselines_update_own" on public.similarity_baselines;
create policy "similarity_baselines_update_own" on public.similarity_baselines for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
