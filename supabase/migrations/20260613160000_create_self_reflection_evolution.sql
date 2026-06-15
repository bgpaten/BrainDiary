-- =============================================================================
-- Personal Entity OS — Self-Reflection Memory Evolution
-- Migration: create_self_reflection_evolution
-- Step 24: evidence-bound reflection logs, evolution suggestions, entity snapshots
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.self_reflection_logs (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null,
  reflection_type           text not null check (reflection_type in (
                              'daily','weekly','manual','after_import',
                              'after_digest','after_calibration','after_similarity_eval'
                            )),
  period_start              timestamptz,
  period_end                timestamptz,
  title                     text not null,
  summary                   text not null default '',
  new_observations          jsonb not null default '[]'::jsonb,
  strengthened_patterns     jsonb not null default '[]'::jsonb,
  weakened_patterns         jsonb not null default '[]'::jsonb,
  new_contradictions        jsonb not null default '[]'::jsonb,
  identity_implications      jsonb not null default '[]'::jsonb,
  communication_implications jsonb not null default '[]'::jsonb,
  risk_implications         jsonb not null default '[]'::jsonb,
  uncertainties             jsonb not null default '[]'::jsonb,
  evidence_refs             jsonb not null default '[]'::jsonb,
  confidence_score          numeric(5,4) not null default 0 check (confidence_score >= 0 and confidence_score <= 1),
  status                    text not null default 'draft' check (status in ('draft','done','needs_review','failed')),
  model_provider            text,
  model_name                text,
  metadata                  jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create table if not exists public.identity_evolution_suggestions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  reflection_log_id  uuid references public.self_reflection_logs(id) on delete set null,
  target_type        text not null check (target_type in (
                       'identity_fact','communication_pattern','owner_calibration_hint',
                       'response_rule','new_identity_fact','new_communication_pattern','new_boundary'
                     )),
  target_id          uuid,
  suggestion_type    text not null check (suggestion_type in (
                       'increase_confidence','decrease_confidence','mark_core','mark_recurring',
                       'mark_needs_review','mark_contradicted','create_new','soften_claim',
                       'add_evidence','add_boundary','deprecate'
                     )),
  label              text not null,
  description        text not null default '',
  before_state       jsonb not null default '{}'::jsonb,
  after_state        jsonb not null default '{}'::jsonb,
  evidence_refs      jsonb not null default '[]'::jsonb,
  confidence_score   numeric(5,4) not null default 0 check (confidence_score >= 0 and confidence_score <= 1),
  risk_score         numeric(5,4) not null default 0 check (risk_score >= 0 and risk_score <= 1),
  status             text not null default 'proposed' check (status in ('proposed','approved','applied','rejected','ignored')),
  reviewed_at        timestamptz,
  applied_at         timestamptz,
  rejected_at        timestamptz,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.entity_evolution_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  snapshot_type       text not null check (snapshot_type in ('daily','weekly','manual','baseline')),
  title               text not null,
  summary             text not null default '',
  identity_state      jsonb not null default '{}'::jsonb,
  communication_state jsonb not null default '{}'::jsonb,
  reflection_state    jsonb not null default '{}'::jsonb,
  drift_state         jsonb not null default '{}'::jsonb,
  similarity_state    jsonb not null default '{}'::jsonb,
  open_uncertainties  jsonb not null default '[]'::jsonb,
  active_boundaries   jsonb not null default '[]'::jsonb,
  evolution_score     numeric(5,4) not null default 0 check (evolution_score >= 0 and evolution_score <= 1),
  stability_score     numeric(5,4) not null default 0 check (stability_score >= 0 and stability_score <= 1),
  fidelity_risk_score numeric(5,4) not null default 0 check (fidelity_risk_score >= 0 and fidelity_risk_score <= 1),
  status              text not null default 'active' check (status in ('active','archived','needs_review','failed')),
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_self_reflection_logs_user_id on public.self_reflection_logs(user_id);
create index if not exists idx_self_reflection_logs_reflection_type on public.self_reflection_logs(reflection_type);
create index if not exists idx_self_reflection_logs_status on public.self_reflection_logs(status);
create index if not exists idx_self_reflection_logs_created_at on public.self_reflection_logs(created_at);
create index if not exists idx_self_reflection_logs_period_start on public.self_reflection_logs(period_start);
create index if not exists idx_self_reflection_logs_period_end on public.self_reflection_logs(period_end);

create index if not exists idx_identity_evolution_suggestions_user_id on public.identity_evolution_suggestions(user_id);
create index if not exists idx_identity_evolution_suggestions_reflection_log_id on public.identity_evolution_suggestions(reflection_log_id);
create index if not exists idx_identity_evolution_suggestions_target_type on public.identity_evolution_suggestions(target_type);
create index if not exists idx_identity_evolution_suggestions_suggestion_type on public.identity_evolution_suggestions(suggestion_type);
create index if not exists idx_identity_evolution_suggestions_status on public.identity_evolution_suggestions(status);
create index if not exists idx_identity_evolution_suggestions_risk_score on public.identity_evolution_suggestions(risk_score);
create index if not exists idx_identity_evolution_suggestions_created_at on public.identity_evolution_suggestions(created_at);

create index if not exists idx_entity_evolution_snapshots_user_id on public.entity_evolution_snapshots(user_id);
create index if not exists idx_entity_evolution_snapshots_snapshot_type on public.entity_evolution_snapshots(snapshot_type);
create index if not exists idx_entity_evolution_snapshots_status on public.entity_evolution_snapshots(status);
create index if not exists idx_entity_evolution_snapshots_created_at on public.entity_evolution_snapshots(created_at);

drop trigger if exists trg_self_reflection_logs_updated_at on public.self_reflection_logs;
create trigger trg_self_reflection_logs_updated_at before update on public.self_reflection_logs
  for each row execute function public.set_updated_at();
drop trigger if exists trg_identity_evolution_suggestions_updated_at on public.identity_evolution_suggestions;
create trigger trg_identity_evolution_suggestions_updated_at before update on public.identity_evolution_suggestions
  for each row execute function public.set_updated_at();
drop trigger if exists trg_entity_evolution_snapshots_updated_at on public.entity_evolution_snapshots;
create trigger trg_entity_evolution_snapshots_updated_at before update on public.entity_evolution_snapshots
  for each row execute function public.set_updated_at();

alter table public.self_reflection_logs enable row level security;
alter table public.identity_evolution_suggestions enable row level security;
alter table public.entity_evolution_snapshots enable row level security;

drop policy if exists "self_reflection_logs_select_own" on public.self_reflection_logs;
create policy "self_reflection_logs_select_own" on public.self_reflection_logs for select using (auth.uid() = user_id);
drop policy if exists "self_reflection_logs_insert_own" on public.self_reflection_logs;
create policy "self_reflection_logs_insert_own" on public.self_reflection_logs for insert with check (auth.uid() = user_id);
drop policy if exists "self_reflection_logs_update_own" on public.self_reflection_logs;
create policy "self_reflection_logs_update_own" on public.self_reflection_logs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "self_reflection_logs_delete_own" on public.self_reflection_logs;
create policy "self_reflection_logs_delete_own" on public.self_reflection_logs for delete using (auth.uid() = user_id);

drop policy if exists "identity_evolution_suggestions_select_own" on public.identity_evolution_suggestions;
create policy "identity_evolution_suggestions_select_own" on public.identity_evolution_suggestions for select using (auth.uid() = user_id);
drop policy if exists "identity_evolution_suggestions_insert_own" on public.identity_evolution_suggestions;
create policy "identity_evolution_suggestions_insert_own" on public.identity_evolution_suggestions for insert with check (auth.uid() = user_id);
drop policy if exists "identity_evolution_suggestions_update_own" on public.identity_evolution_suggestions;
create policy "identity_evolution_suggestions_update_own" on public.identity_evolution_suggestions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "identity_evolution_suggestions_delete_own" on public.identity_evolution_suggestions;
create policy "identity_evolution_suggestions_delete_own" on public.identity_evolution_suggestions for delete using (auth.uid() = user_id);

drop policy if exists "entity_evolution_snapshots_select_own" on public.entity_evolution_snapshots;
create policy "entity_evolution_snapshots_select_own" on public.entity_evolution_snapshots for select using (auth.uid() = user_id);
drop policy if exists "entity_evolution_snapshots_insert_own" on public.entity_evolution_snapshots;
create policy "entity_evolution_snapshots_insert_own" on public.entity_evolution_snapshots for insert with check (auth.uid() = user_id);
drop policy if exists "entity_evolution_snapshots_update_own" on public.entity_evolution_snapshots;
create policy "entity_evolution_snapshots_update_own" on public.entity_evolution_snapshots for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
