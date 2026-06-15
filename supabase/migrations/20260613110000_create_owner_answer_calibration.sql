-- =============================================================================
-- Personal Entity OS — Owner Answer Calibration
-- Migration: create_owner_answer_calibration
-- Step 21: compare inferred answers against owner ground truth
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.owner_answer_examples (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  prompt             text not null,
  normalized_prompt  text not null,
  owner_answer       text not null,
  example_hash       text not null,
  intent_type        text not null default 'unknown'
                       check (intent_type in (
                         'social_greeting',
                         'casual_reply',
                         'request_prompt',
                         'technical_instruction',
                         'strategy_question',
                         'correction',
                         'identity_question',
                         'contradiction_check',
                         'decision_help',
                         'personal_reflection',
                         'unknown'
                       )),
  answer_style       text not null default 'neutral'
                       check (answer_style in (
                         'short_direct',
                         'casual_direct',
                         'technical_step_by_step',
                         'prompt_ready',
                         'strategic_direct',
                         'reflective',
                         'corrective',
                         'neutral'
                       )),
  language           text not null default 'id',
  tone               text not null default 'neutral'
                       check (tone in ('direct', 'casual', 'firm', 'technical', 'reflective', 'neutral', 'mixed')),
  formality          text not null default 'neutral'
                       check (formality in ('very_casual', 'casual', 'neutral', 'formal')),
  length_class       text not null default 'medium'
                       check (length_class in ('very_short', 'short', 'medium', 'long')),
  context_note       text,
  source_type        text not null default 'manual'
                       check (source_type in ('manual', 'chat_sample', 'diary', 'imported_conversation', 'calibration_session')),
  source_ref         jsonb not null default '{}'::jsonb,
  quality_score      numeric(5,4) not null default 0.70
                       check (quality_score >= 0 and quality_score <= 1),
  status             text not null default 'active'
                       check (status in ('active', 'needs_review', 'deprecated', 'rejected')),
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.owner_calibration_runs (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null,
  title                       text not null,
  status                      text not null default 'pending'
                                check (status in ('pending', 'running', 'done', 'failed')),
  total_examples              integer not null default 0,
  average_similarity_score    numeric(5,4) not null default 0
                                check (average_similarity_score >= 0 and average_similarity_score <= 1),
  average_style_match_score   numeric(5,4) not null default 0
                                check (average_style_match_score >= 0 and average_style_match_score <= 1),
  average_intent_match_score  numeric(5,4) not null default 0
                                check (average_intent_match_score >= 0 and average_intent_match_score <= 1),
  average_length_match_score  numeric(5,4) not null default 0
                                check (average_length_match_score >= 0 and average_length_match_score <= 1),
  average_tone_match_score    numeric(5,4) not null default 0
                                check (average_tone_match_score >= 0 and average_tone_match_score <= 1),
  average_fidelity_score      numeric(5,4) not null default 0
                                check (average_fidelity_score >= 0 and average_fidelity_score <= 1),
  overclaim_count             integer not null default 0,
  underfit_count              integer not null default 0,
  too_ai_count                integer not null default 0,
  started_at                  timestamptz,
  finished_at                 timestamptz,
  metadata                    jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create table if not exists public.owner_calibration_results (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null,
  calibration_run_id       uuid not null references public.owner_calibration_runs(id) on delete cascade,
  owner_answer_example_id  uuid not null references public.owner_answer_examples(id) on delete cascade,
  prompt                   text not null,
  owner_answer             text not null,
  agent_answer             text not null,
  intent_type              text not null,
  actual_intent_type       text not null,
  similarity_score         numeric(5,4) not null default 0
                             check (similarity_score >= 0 and similarity_score <= 1),
  style_match_score        numeric(5,4) not null default 0
                             check (style_match_score >= 0 and style_match_score <= 1),
  intent_match_score       numeric(5,4) not null default 0
                             check (intent_match_score >= 0 and intent_match_score <= 1),
  length_match_score       numeric(5,4) not null default 0
                             check (length_match_score >= 0 and length_match_score <= 1),
  tone_match_score         numeric(5,4) not null default 0
                             check (tone_match_score >= 0 and tone_match_score <= 1),
  fidelity_score           numeric(5,4) not null default 0
                             check (fidelity_score >= 0 and fidelity_score <= 1),
  overclaim_risk           numeric(5,4) not null default 0
                             check (overclaim_risk >= 0 and overclaim_risk <= 1),
  underfit_risk            numeric(5,4) not null default 0
                             check (underfit_risk >= 0 and underfit_risk <= 1),
  too_ai_score             numeric(5,4) not null default 0
                             check (too_ai_score >= 0 and too_ai_score <= 1),
  missing_elements         jsonb not null default '[]'::jsonb,
  extra_elements           jsonb not null default '[]'::jsonb,
  calibration_hints        jsonb not null default '[]'::jsonb,
  judge_feedback           text,
  passed                   boolean not null default false,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now()
);

create table if not exists public.owner_calibration_hints (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  intent_type           text not null
                          check (intent_type in (
                            'social_greeting',
                            'casual_reply',
                            'request_prompt',
                            'technical_instruction',
                            'strategy_question',
                            'correction',
                            'identity_question',
                            'contradiction_check',
                            'decision_help',
                            'personal_reflection',
                            'unknown'
                          )),
  hint_type             text not null
                          check (hint_type in (
                            'greeting_reply',
                            'length_adjustment',
                            'tone_adjustment',
                            'format_adjustment',
                            'style_adjustment',
                            'phrase_preference',
                            'avoid_phrase',
                            'prompt_structure',
                            'strategic_response_shape'
                          )),
  label                 text not null,
  description           text not null,
  trigger_patterns      jsonb not null default '[]'::jsonb,
  preferred_response    jsonb not null default '[]'::jsonb,
  avoid_response        jsonb not null default '[]'::jsonb,
  response_shape_patch  jsonb not null default '{}'::jsonb,
  confidence_score      numeric(5,4) not null default 0.45
                          check (confidence_score >= 0 and confidence_score <= 1),
  evidence_example_ids  jsonb not null default '[]'::jsonb,
  status                text not null default 'active'
                          check (status in ('active', 'needs_review', 'deprecated', 'rejected')),
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_owner_answer_examples_user_id       on public.owner_answer_examples (user_id);
create index if not exists idx_owner_answer_examples_intent_type   on public.owner_answer_examples (intent_type);
create index if not exists idx_owner_answer_examples_status        on public.owner_answer_examples (status);
create index if not exists idx_owner_answer_examples_created_at    on public.owner_answer_examples (created_at);
create unique index if not exists uq_owner_answer_examples_user_prompt_answer
  on public.owner_answer_examples (user_id, example_hash);

create index if not exists idx_owner_calibration_runs_user_id      on public.owner_calibration_runs (user_id);
create index if not exists idx_owner_calibration_runs_status       on public.owner_calibration_runs (status);
create index if not exists idx_owner_calibration_runs_created_at   on public.owner_calibration_runs (created_at);

create index if not exists idx_owner_calibration_results_user_id                  on public.owner_calibration_results (user_id);
create index if not exists idx_owner_calibration_results_intent_type              on public.owner_calibration_results (intent_type);
create index if not exists idx_owner_calibration_results_created_at               on public.owner_calibration_results (created_at);
create index if not exists idx_owner_calibration_results_calibration_run_id       on public.owner_calibration_results (calibration_run_id);
create index if not exists idx_owner_calibration_results_owner_answer_example_id  on public.owner_calibration_results (owner_answer_example_id);

create index if not exists idx_owner_calibration_hints_user_id      on public.owner_calibration_hints (user_id);
create index if not exists idx_owner_calibration_hints_intent_type  on public.owner_calibration_hints (intent_type);
create index if not exists idx_owner_calibration_hints_status       on public.owner_calibration_hints (status);
create index if not exists idx_owner_calibration_hints_created_at   on public.owner_calibration_hints (created_at);
create unique index if not exists uq_owner_calibration_hints_user_intent_type_label
  on public.owner_calibration_hints (user_id, intent_type, hint_type, label);

drop trigger if exists trg_owner_answer_examples_updated_at on public.owner_answer_examples;
create trigger trg_owner_answer_examples_updated_at
  before update on public.owner_answer_examples
  for each row execute function public.set_updated_at();

drop trigger if exists trg_owner_calibration_runs_updated_at on public.owner_calibration_runs;
create trigger trg_owner_calibration_runs_updated_at
  before update on public.owner_calibration_runs
  for each row execute function public.set_updated_at();

drop trigger if exists trg_owner_calibration_hints_updated_at on public.owner_calibration_hints;
create trigger trg_owner_calibration_hints_updated_at
  before update on public.owner_calibration_hints
  for each row execute function public.set_updated_at();

alter table public.owner_answer_examples enable row level security;
alter table public.owner_calibration_runs enable row level security;
alter table public.owner_calibration_results enable row level security;
alter table public.owner_calibration_hints enable row level security;

drop policy if exists "owner_answer_examples_select_own" on public.owner_answer_examples;
create policy "owner_answer_examples_select_own" on public.owner_answer_examples
  for select using (auth.uid() = user_id);
drop policy if exists "owner_answer_examples_insert_own" on public.owner_answer_examples;
create policy "owner_answer_examples_insert_own" on public.owner_answer_examples
  for insert with check (auth.uid() = user_id);
drop policy if exists "owner_answer_examples_update_own" on public.owner_answer_examples;
create policy "owner_answer_examples_update_own" on public.owner_answer_examples
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "owner_answer_examples_delete_own" on public.owner_answer_examples;
create policy "owner_answer_examples_delete_own" on public.owner_answer_examples
  for delete using (auth.uid() = user_id);

drop policy if exists "owner_calibration_runs_select_own" on public.owner_calibration_runs;
create policy "owner_calibration_runs_select_own" on public.owner_calibration_runs
  for select using (auth.uid() = user_id);
drop policy if exists "owner_calibration_runs_insert_own" on public.owner_calibration_runs;
create policy "owner_calibration_runs_insert_own" on public.owner_calibration_runs
  for insert with check (auth.uid() = user_id);
drop policy if exists "owner_calibration_runs_update_own" on public.owner_calibration_runs;
create policy "owner_calibration_runs_update_own" on public.owner_calibration_runs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner_calibration_results_select_own" on public.owner_calibration_results;
create policy "owner_calibration_results_select_own" on public.owner_calibration_results
  for select using (auth.uid() = user_id);
drop policy if exists "owner_calibration_results_insert_own" on public.owner_calibration_results;
create policy "owner_calibration_results_insert_own" on public.owner_calibration_results
  for insert with check (auth.uid() = user_id);

drop policy if exists "owner_calibration_hints_select_own" on public.owner_calibration_hints;
create policy "owner_calibration_hints_select_own" on public.owner_calibration_hints
  for select using (auth.uid() = user_id);
drop policy if exists "owner_calibration_hints_insert_own" on public.owner_calibration_hints;
create policy "owner_calibration_hints_insert_own" on public.owner_calibration_hints
  for insert with check (auth.uid() = user_id);
drop policy if exists "owner_calibration_hints_update_own" on public.owner_calibration_hints;
create policy "owner_calibration_hints_update_own" on public.owner_calibration_hints
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "owner_calibration_hints_delete_own" on public.owner_calibration_hints;
create policy "owner_calibration_hints_delete_own" on public.owner_calibration_hints
  for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
