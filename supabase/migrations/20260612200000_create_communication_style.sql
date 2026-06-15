-- =============================================================================
-- Personal Entity OS — Communication Style Model
-- Migration: create_communication_style
-- Step 19: evidence-bound communication samples and patterns
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.communication_samples (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  sample_type      text not null
                     check (sample_type in (
                       'diary_sentence',
                       'chat_message',
                       'instruction',
                       'reply',
                       'reflection',
                       'question',
                       'decision_note',
                       'manual_example'
                     )),
  source_type      text not null
                     check (source_type in ('raw_entry', 'agent_memory', 'manual', 'imported_chat', 'brain_report')),
  source_id        uuid,
  text             text not null,
  normalized_text  text not null,
  language         text not null default 'id',
  tone             text not null default 'neutral'
                     check (tone in ('direct', 'casual', 'formal', 'firm', 'reflective', 'technical', 'emotional', 'neutral', 'mixed')),
  formality        text not null default 'neutral'
                     check (formality in ('very_casual', 'casual', 'neutral', 'formal')),
  length_class     text not null default 'medium'
                     check (length_class in ('short', 'medium', 'long')),
  intent_type      text not null default 'unknown'
                     check (intent_type in (
                       'greeting',
                       'request_prompt',
                       'technical_instruction',
                       'strategy_question',
                       'reflection',
                       'correction',
                       'complaint',
                       'decision',
                       'follow_up',
                       'casual_reply',
                       'unknown'
                     )),
  context_label    text,
  confidence_score numeric(5,4) not null default 0.45
                     check (confidence_score >= 0 and confidence_score <= 1),
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.communication_patterns (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null,
  pattern_type             text not null
                             check (pattern_type in (
                               'greeting_style',
                               'instruction_style',
                               'question_style',
                               'correction_style',
                               'decision_style',
                               'technical_style',
                               'reflection_style',
                               'casual_style',
                               'rejection_style',
                               'follow_up_style',
                               'prompt_request_style',
                               'general_voice'
                             )),
  label                    text not null,
  description              text not null,
  examples                 jsonb not null default '[]'::jsonb,
  anti_examples            jsonb not null default '[]'::jsonb,
  preferred_response_shape jsonb not null default '{}'::jsonb,
  trigger_intents          jsonb not null default '[]'::jsonb,
  confidence_score         numeric(5,4) not null default 0.45
                             check (confidence_score >= 0 and confidence_score <= 1),
  stability                text not null default 'temporary'
                             check (stability in ('temporary', 'recurring', 'stable', 'core')),
  evidence_refs            jsonb not null default '[]'::jsonb,
  usage_rules              jsonb not null default '[]'::jsonb,
  status                   text not null default 'active'
                             check (status in ('active', 'needs_review', 'deprecated', 'rejected')),
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_communication_samples_user_id          on public.communication_samples (user_id);
create index if not exists idx_communication_samples_sample_type      on public.communication_samples (sample_type);
create index if not exists idx_communication_samples_intent_type      on public.communication_samples (intent_type);
create index if not exists idx_communication_samples_confidence_score on public.communication_samples (confidence_score);
create index if not exists idx_communication_samples_created_at       on public.communication_samples (created_at);
create unique index if not exists uq_communication_samples_user_source_text
  on public.communication_samples (user_id, source_type, coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid), md5(normalized_text));

create index if not exists idx_communication_patterns_user_id          on public.communication_patterns (user_id);
create index if not exists idx_communication_patterns_pattern_type     on public.communication_patterns (pattern_type);
create index if not exists idx_communication_patterns_confidence_score on public.communication_patterns (confidence_score);
create index if not exists idx_communication_patterns_status           on public.communication_patterns (status);
create index if not exists idx_communication_patterns_created_at       on public.communication_patterns (created_at);
create unique index if not exists uq_communication_patterns_user_type_label
  on public.communication_patterns (user_id, pattern_type, lower(regexp_replace(label, '\s+', ' ', 'g')));

drop trigger if exists trg_communication_samples_updated_at on public.communication_samples;
create trigger trg_communication_samples_updated_at
  before update on public.communication_samples
  for each row execute function public.set_updated_at();

drop trigger if exists trg_communication_patterns_updated_at on public.communication_patterns;
create trigger trg_communication_patterns_updated_at
  before update on public.communication_patterns
  for each row execute function public.set_updated_at();

alter table public.communication_samples enable row level security;
alter table public.communication_patterns enable row level security;

drop policy if exists "communication_samples_select_own" on public.communication_samples;
create policy "communication_samples_select_own" on public.communication_samples
  for select using (auth.uid() = user_id);

drop policy if exists "communication_samples_insert_own" on public.communication_samples;
create policy "communication_samples_insert_own" on public.communication_samples
  for insert with check (auth.uid() = user_id);

drop policy if exists "communication_samples_update_own" on public.communication_samples;
create policy "communication_samples_update_own" on public.communication_samples
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "communication_samples_delete_own" on public.communication_samples;
create policy "communication_samples_delete_own" on public.communication_samples
  for delete using (auth.uid() = user_id);

drop policy if exists "communication_patterns_select_own" on public.communication_patterns;
create policy "communication_patterns_select_own" on public.communication_patterns
  for select using (auth.uid() = user_id);

drop policy if exists "communication_patterns_insert_own" on public.communication_patterns;
create policy "communication_patterns_insert_own" on public.communication_patterns
  for insert with check (auth.uid() = user_id);

drop policy if exists "communication_patterns_update_own" on public.communication_patterns;
create policy "communication_patterns_update_own" on public.communication_patterns
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "communication_patterns_delete_own" on public.communication_patterns;
create policy "communication_patterns_delete_own" on public.communication_patterns
  for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
