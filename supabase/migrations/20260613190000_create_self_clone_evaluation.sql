-- =============================================================================
-- Personal Entity OS — Final Self-Clone Evaluation Suite
-- Step 27: final readiness scoring for self-clone behavior
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.self_clone_eval_suites (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  suite_name        text not null,
  suite_type        text not null check (suite_type in ('baseline','daily','weekly','regression','release','manual')),
  description       text,
  status            text not null default 'draft' check (status in ('draft','active','archived','failed')),
  case_count        integer not null default 0,
  coverage_summary  jsonb not null default '{}'::jsonb,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.self_clone_eval_cases (
  id                                  uuid primary key default gen_random_uuid(),
  user_id                             uuid not null,
  suite_id                            uuid not null references public.self_clone_eval_suites(id) on delete cascade,
  case_type                           text not null check (case_type in (
                                        'social_greeting','casual_reply','owner_answer_similarity','prompt_request',
                                        'technical_instruction','strategy_question','identity_question',
                                        'contradiction_handling','insufficient_memory','drift_guard',
                                        'private_context_guard','style_regression','memory_grounding',
                                        'reflection_awareness','conflict_awareness','calibration_hint_usage',
                                        'general_response'
                                      )),
  intent_type                         text not null default 'unknown' check (intent_type in (
                                        'social_greeting','casual_reply','factual_question','personal_reflection',
                                        'strategy_question','request_prompt','technical_instruction','correction',
                                        'contradiction_check','decision_help','identity_question','style_request','unknown'
                                      )),
  prompt                              text not null,
  normalized_prompt                   text not null,
  expected_behavior                   text,
  owner_answer_example_id             uuid,
  expected_answer                     text,
  expected_response_shape             jsonb not null default '{}'::jsonb,
  required_identity_fact_ids          jsonb not null default '[]'::jsonb,
  required_communication_pattern_ids  jsonb not null default '[]'::jsonb,
  required_conflict_ids               jsonb not null default '[]'::jsonb,
  forbidden_phrases                   jsonb not null default '[]'::jsonb,
  forbidden_behaviors                 jsonb not null default '[]'::jsonb,
  scoring_weights                     jsonb not null default '{}'::jsonb,
  priority                            text not null default 'medium' check (priority in ('low','medium','high','critical')),
  status                              text not null default 'active' check (status in ('active','needs_review','disabled','archived')),
  metadata                            jsonb not null default '{}'::jsonb,
  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now()
);

create table if not exists public.self_clone_eval_runs (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null,
  suite_id                   uuid references public.self_clone_eval_suites(id) on delete set null,
  run_type                   text not null default 'manual' check (run_type in ('manual','daily','weekly','regression','release')),
  status                     text not null default 'pending' check (status in ('pending','running','done','failed')),
  total_cases                integer not null default 0,
  passed_cases               integer not null default 0,
  failed_cases               integer not null default 0,
  critical_failed_cases      integer not null default 0,
  overall_score              numeric(5,4) not null default 0 check (overall_score >= 0 and overall_score <= 1),
  readiness_level            text not null default 'not_ready' check (readiness_level in ('not_ready','early','usable_with_warning','stable','release_candidate')),
  identity_fidelity_score    numeric(5,4) not null default 0 check (identity_fidelity_score >= 0 and identity_fidelity_score <= 1),
  communication_style_score  numeric(5,4) not null default 0 check (communication_style_score >= 0 and communication_style_score <= 1),
  owner_similarity_score     numeric(5,4) not null default 0 check (owner_similarity_score >= 0 and owner_similarity_score <= 1),
  memory_grounding_score     numeric(5,4) not null default 0 check (memory_grounding_score >= 0 and memory_grounding_score <= 1),
  conflict_handling_score    numeric(5,4) not null default 0 check (conflict_handling_score >= 0 and conflict_handling_score <= 1),
  drift_safety_score         numeric(5,4) not null default 0 check (drift_safety_score >= 0 and drift_safety_score <= 1),
  calibration_score          numeric(5,4) not null default 0 check (calibration_score >= 0 and calibration_score <= 1),
  reflection_score           numeric(5,4) not null default 0 check (reflection_score >= 0 and reflection_score <= 1),
  too_ai_score               numeric(5,4) not null default 0 check (too_ai_score >= 0 and too_ai_score <= 1),
  overclaim_risk             numeric(5,4) not null default 0 check (overclaim_risk >= 0 and overclaim_risk <= 1),
  underfit_risk              numeric(5,4) not null default 0 check (underfit_risk >= 0 and underfit_risk <= 1),
  private_leak_risk          numeric(5,4) not null default 0 check (private_leak_risk >= 0 and private_leak_risk <= 1),
  started_at                 timestamptz,
  finished_at                timestamptz,
  summary                    text,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create table if not exists public.self_clone_eval_results (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null,
  eval_run_id                uuid not null references public.self_clone_eval_runs(id) on delete cascade,
  eval_case_id               uuid not null references public.self_clone_eval_cases(id) on delete cascade,
  case_type                  text not null,
  intent_type                text not null,
  prompt                     text not null,
  agent_answer               text not null,
  expected_answer            text,
  expected_behavior          text,
  actual_behavior            jsonb not null default '{}'::jsonb,
  passed                     boolean not null default false,
  score                      numeric(5,4) not null default 0 check (score >= 0 and score <= 1),
  identity_fidelity_score    numeric(5,4) not null default 0 check (identity_fidelity_score >= 0 and identity_fidelity_score <= 1),
  communication_style_score  numeric(5,4) not null default 0 check (communication_style_score >= 0 and communication_style_score <= 1),
  owner_similarity_score     numeric(5,4) not null default 0 check (owner_similarity_score >= 0 and owner_similarity_score <= 1),
  memory_grounding_score     numeric(5,4) not null default 0 check (memory_grounding_score >= 0 and memory_grounding_score <= 1),
  conflict_handling_score    numeric(5,4) not null default 0 check (conflict_handling_score >= 0 and conflict_handling_score <= 1),
  drift_safety_score         numeric(5,4) not null default 0 check (drift_safety_score >= 0 and drift_safety_score <= 1),
  calibration_score          numeric(5,4) not null default 0 check (calibration_score >= 0 and calibration_score <= 1),
  reflection_score           numeric(5,4) not null default 0 check (reflection_score >= 0 and reflection_score <= 1),
  too_ai_score               numeric(5,4) not null default 0 check (too_ai_score >= 0 and too_ai_score <= 1),
  overclaim_risk             numeric(5,4) not null default 0 check (overclaim_risk >= 0 and overclaim_risk <= 1),
  underfit_risk              numeric(5,4) not null default 0 check (underfit_risk >= 0 and underfit_risk <= 1),
  private_leak_risk          numeric(5,4) not null default 0 check (private_leak_risk >= 0 and private_leak_risk <= 1),
  failure_reason             text,
  warnings                   jsonb not null default '[]'::jsonb,
  recommendations            jsonb not null default '[]'::jsonb,
  debug_payload              jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);

create table if not exists public.self_clone_readiness_reports (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null,
  eval_run_id                uuid not null references public.self_clone_eval_runs(id) on delete cascade,
  title                      text not null,
  readiness_level            text not null check (readiness_level in ('not_ready','early','usable_with_warning','stable','release_candidate')),
  overall_score              numeric(5,4) not null default 0 check (overall_score >= 0 and overall_score <= 1),
  summary                    text not null,
  strengths                  jsonb not null default '[]'::jsonb,
  weaknesses                 jsonb not null default '[]'::jsonb,
  critical_blockers          jsonb not null default '[]'::jsonb,
  recommended_next_steps     jsonb not null default '[]'::jsonb,
  release_decision           text not null check (release_decision in ('do_not_use','internal_testing_only','daily_use_with_warning','stable_daily_use','ready_for_next_phase')),
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create index if not exists idx_self_clone_eval_suites_user_id on public.self_clone_eval_suites(user_id);
create index if not exists idx_self_clone_eval_suites_suite_type on public.self_clone_eval_suites(suite_type);
create index if not exists idx_self_clone_eval_suites_status on public.self_clone_eval_suites(status);
create index if not exists idx_self_clone_eval_suites_created_at on public.self_clone_eval_suites(created_at);
create unique index if not exists uq_self_clone_eval_suites_user_name on public.self_clone_eval_suites(user_id, suite_name);

create index if not exists idx_self_clone_eval_cases_user_id on public.self_clone_eval_cases(user_id);
create index if not exists idx_self_clone_eval_cases_suite_id on public.self_clone_eval_cases(suite_id);
create index if not exists idx_self_clone_eval_cases_case_type on public.self_clone_eval_cases(case_type);
create index if not exists idx_self_clone_eval_cases_intent_type on public.self_clone_eval_cases(intent_type);
create index if not exists idx_self_clone_eval_cases_status on public.self_clone_eval_cases(status);
create index if not exists idx_self_clone_eval_cases_created_at on public.self_clone_eval_cases(created_at);
create unique index if not exists uq_self_clone_eval_cases_suite_prompt_type on public.self_clone_eval_cases(suite_id, case_type, normalized_prompt);

create index if not exists idx_self_clone_eval_runs_user_id on public.self_clone_eval_runs(user_id);
create index if not exists idx_self_clone_eval_runs_suite_id on public.self_clone_eval_runs(suite_id);
create index if not exists idx_self_clone_eval_runs_run_type on public.self_clone_eval_runs(run_type);
create index if not exists idx_self_clone_eval_runs_status on public.self_clone_eval_runs(status);
create index if not exists idx_self_clone_eval_runs_readiness_level on public.self_clone_eval_runs(readiness_level);
create index if not exists idx_self_clone_eval_runs_overall_score on public.self_clone_eval_runs(overall_score);
create index if not exists idx_self_clone_eval_runs_created_at on public.self_clone_eval_runs(created_at);

create index if not exists idx_self_clone_eval_results_user_id on public.self_clone_eval_results(user_id);
create index if not exists idx_self_clone_eval_results_eval_run_id on public.self_clone_eval_results(eval_run_id);
create index if not exists idx_self_clone_eval_results_eval_case_id on public.self_clone_eval_results(eval_case_id);
create index if not exists idx_self_clone_eval_results_case_type on public.self_clone_eval_results(case_type);
create index if not exists idx_self_clone_eval_results_intent_type on public.self_clone_eval_results(intent_type);
create index if not exists idx_self_clone_eval_results_created_at on public.self_clone_eval_results(created_at);

create index if not exists idx_self_clone_readiness_reports_user_id on public.self_clone_readiness_reports(user_id);
create index if not exists idx_self_clone_readiness_reports_eval_run_id on public.self_clone_readiness_reports(eval_run_id);
create index if not exists idx_self_clone_readiness_reports_readiness_level on public.self_clone_readiness_reports(readiness_level);
create index if not exists idx_self_clone_readiness_reports_created_at on public.self_clone_readiness_reports(created_at);

drop trigger if exists trg_self_clone_eval_suites_updated_at on public.self_clone_eval_suites;
create trigger trg_self_clone_eval_suites_updated_at before update on public.self_clone_eval_suites for each row execute function public.set_updated_at();
drop trigger if exists trg_self_clone_eval_cases_updated_at on public.self_clone_eval_cases;
create trigger trg_self_clone_eval_cases_updated_at before update on public.self_clone_eval_cases for each row execute function public.set_updated_at();
drop trigger if exists trg_self_clone_eval_runs_updated_at on public.self_clone_eval_runs;
create trigger trg_self_clone_eval_runs_updated_at before update on public.self_clone_eval_runs for each row execute function public.set_updated_at();
drop trigger if exists trg_self_clone_readiness_reports_updated_at on public.self_clone_readiness_reports;
create trigger trg_self_clone_readiness_reports_updated_at before update on public.self_clone_readiness_reports for each row execute function public.set_updated_at();

alter table public.self_clone_eval_suites enable row level security;
alter table public.self_clone_eval_cases enable row level security;
alter table public.self_clone_eval_runs enable row level security;
alter table public.self_clone_eval_results enable row level security;
alter table public.self_clone_readiness_reports enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['self_clone_eval_suites','self_clone_eval_cases','self_clone_eval_runs','self_clone_eval_results','self_clone_readiness_reports'] loop
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
