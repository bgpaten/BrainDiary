-- =============================================================================
-- Personal Entity OS — Response Inference Engine
-- Migration: create_response_inference
-- Step 20: fidelity-first owner response inference
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.response_inference_logs (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null,
  question                   text not null,
  normalized_question        text not null,
  intent_type                text not null
                               check (intent_type in (
                                 'social_greeting',
                                 'casual_reply',
                                 'factual_question',
                                 'personal_reflection',
                                 'strategy_question',
                                 'request_prompt',
                                 'technical_instruction',
                                 'correction',
                                 'contradiction_check',
                                 'decision_help',
                                 'identity_question',
                                 'style_request',
                                 'unknown'
                               )),
  inference_mode             text not null
                               check (inference_mode in (
                                 'direct_social_response',
                                 'factual_brain_answer',
                                 'identity_based_answer',
                                 'communication_style_answer',
                                 'strategic_mirror_answer',
                                 'prompt_generation_answer',
                                 'correction_response',
                                 'insufficient_memory_response'
                               )),
  response_shape             jsonb not null default '{}'::jsonb,
  identity_fact_ids          jsonb not null default '[]'::jsonb,
  communication_pattern_ids  jsonb not null default '[]'::jsonb,
  memory_refs                jsonb not null default '[]'::jsonb,
  retrieval_summary          jsonb not null default '{}'::jsonb,
  inference_trace            jsonb not null default '{}'::jsonb,
  answer                     text not null,
  confidence_score           numeric(5,4) not null default 0.45
                               check (confidence_score >= 0 and confidence_score <= 1),
  fidelity_score             numeric(5,4) not null default 0.45
                               check (fidelity_score >= 0 and fidelity_score <= 1),
  groundedness_score         numeric(5,4) not null default 0.45
                               check (groundedness_score >= 0 and groundedness_score <= 1),
  style_match_score          numeric(5,4) not null default 0.45
                               check (style_match_score >= 0 and style_match_score <= 1),
  overclaim_risk             numeric(5,4) not null default 0.20
                               check (overclaim_risk >= 0 and overclaim_risk <= 1),
  underfit_risk              numeric(5,4) not null default 0.20
                               check (underfit_risk >= 0 and underfit_risk <= 1),
  missing_context            jsonb not null default '[]'::jsonb,
  warnings                   jsonb not null default '[]'::jsonb,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);

create table if not exists public.response_inference_rules (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  intent_type       text not null
                       check (intent_type in (
                         'social_greeting',
                         'casual_reply',
                         'factual_question',
                         'personal_reflection',
                         'strategy_question',
                         'request_prompt',
                         'technical_instruction',
                         'correction',
                         'contradiction_check',
                         'decision_help',
                         'identity_question',
                         'style_request',
                         'unknown'
                       )),
  rule_name         text not null,
  description       text not null,
  trigger_patterns  jsonb not null default '[]'::jsonb,
  required_context  jsonb not null default '[]'::jsonb,
  response_shape    jsonb not null default '{}'::jsonb,
  priority          integer not null default 100,
  enabled           boolean not null default true,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_response_inference_logs_user_id          on public.response_inference_logs (user_id);
create index if not exists idx_response_inference_logs_intent_type      on public.response_inference_logs (intent_type);
create index if not exists idx_response_inference_logs_inference_mode   on public.response_inference_logs (inference_mode);
create index if not exists idx_response_inference_logs_created_at       on public.response_inference_logs (created_at);
create index if not exists idx_response_inference_logs_confidence_score on public.response_inference_logs (confidence_score);
create index if not exists idx_response_inference_logs_fidelity_score   on public.response_inference_logs (fidelity_score);

create index if not exists idx_response_inference_rules_user_id        on public.response_inference_rules (user_id);
create index if not exists idx_response_inference_rules_intent_type    on public.response_inference_rules (intent_type);
create index if not exists idx_response_inference_rules_enabled        on public.response_inference_rules (enabled);
create index if not exists idx_response_inference_rules_priority       on public.response_inference_rules (priority);
create index if not exists idx_response_inference_rules_created_at     on public.response_inference_rules (created_at);
create unique index if not exists uq_response_inference_rules_user_intent_name
  on public.response_inference_rules (user_id, intent_type, rule_name);

drop trigger if exists trg_response_inference_rules_updated_at on public.response_inference_rules;
create trigger trg_response_inference_rules_updated_at
  before update on public.response_inference_rules
  for each row execute function public.set_updated_at();

alter table public.response_inference_logs enable row level security;
alter table public.response_inference_rules enable row level security;

drop policy if exists "response_inference_logs_select_own" on public.response_inference_logs;
create policy "response_inference_logs_select_own" on public.response_inference_logs
  for select using (auth.uid() = user_id);

drop policy if exists "response_inference_logs_insert_own" on public.response_inference_logs;
create policy "response_inference_logs_insert_own" on public.response_inference_logs
  for insert with check (auth.uid() = user_id);

drop policy if exists "response_inference_rules_select_own" on public.response_inference_rules;
create policy "response_inference_rules_select_own" on public.response_inference_rules
  for select using (auth.uid() = user_id);

drop policy if exists "response_inference_rules_insert_own" on public.response_inference_rules;
create policy "response_inference_rules_insert_own" on public.response_inference_rules
  for insert with check (auth.uid() = user_id);

drop policy if exists "response_inference_rules_update_own" on public.response_inference_rules;
create policy "response_inference_rules_update_own" on public.response_inference_rules
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "response_inference_rules_delete_own" on public.response_inference_rules;
create policy "response_inference_rules_delete_own" on public.response_inference_rules
  for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
