-- =============================================================================
-- Personal Entity OS — Drift Control / Anti-Overclaim Guard
-- Migration: create_drift_control
-- Step 23: guard final answers against fidelity drift and overclaim
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.drift_guard_rules (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  rule_type          text not null check (rule_type in (
                       'overclaim','low_confidence_identity','unsupported_personal_fact',
                       'style_drift','too_ai','too_formal','too_long_for_intent',
                       'irrelevant_private_context','identity_contradiction',
                       'baseline_regression','source_leak','debug_leak',
                       'sensitive_overexposure'
                     )),
  rule_name          text not null,
  description        text not null,
  trigger_conditions jsonb not null default '{}'::jsonb,
  guard_action       text not null check (guard_action in (
                       'warn','lower_confidence','rewrite','block','fallback',
                       'hide_debug','hide_sources','require_evidence'
                     )),
  severity           text not null default 'medium' check (severity in ('low','medium','high','critical')),
  enabled            boolean not null default true,
  priority           integer not null default 100,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.drift_guard_logs (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null,
  question                 text not null,
  answer_before_guard      text not null,
  answer_after_guard       text not null,
  intent_type              text not null,
  inference_mode           text,
  triggered_rules          jsonb not null default '[]'::jsonb,
  guard_actions            jsonb not null default '[]'::jsonb,
  overclaim_score          numeric(5,4) not null default 0 check (overclaim_score >= 0 and overclaim_score <= 1),
  style_drift_score        numeric(5,4) not null default 0 check (style_drift_score >= 0 and style_drift_score <= 1),
  too_ai_score             numeric(5,4) not null default 0 check (too_ai_score >= 0 and too_ai_score <= 1),
  too_formal_score         numeric(5,4) not null default 0 check (too_formal_score >= 0 and too_formal_score <= 1),
  unsupported_claim_score  numeric(5,4) not null default 0 check (unsupported_claim_score >= 0 and unsupported_claim_score <= 1),
  irrelevant_context_score numeric(5,4) not null default 0 check (irrelevant_context_score >= 0 and irrelevant_context_score <= 1),
  debug_leak_score         numeric(5,4) not null default 0 check (debug_leak_score >= 0 and debug_leak_score <= 1),
  source_leak_score        numeric(5,4) not null default 0 check (source_leak_score >= 0 and source_leak_score <= 1),
  final_risk_score         numeric(5,4) not null default 0 check (final_risk_score >= 0 and final_risk_score <= 1),
  blocked                  boolean not null default false,
  fallback_used            boolean not null default false,
  warnings                 jsonb not null default '[]'::jsonb,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now()
);

create table if not exists public.drift_baseline_snapshots (
  id                           uuid primary key default gen_random_uuid(),
  user_id                      uuid not null,
  label                        text not null,
  identity_snapshot_id          uuid,
  similarity_baseline_id        uuid references public.similarity_baselines(id) on delete set null,
  communication_pattern_ids     jsonb not null default '[]'::jsonb,
  owner_calibration_hint_ids    jsonb not null default '[]'::jsonb,
  baseline_summary             text,
  baseline_style_profile       jsonb not null default '{}'::jsonb,
  baseline_identity_limits     jsonb not null default '{}'::jsonb,
  status                       text not null default 'candidate' check (status in ('active','candidate','archived','rejected')),
  metadata                     jsonb not null default '{}'::jsonb,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index if not exists idx_drift_guard_rules_user_id on public.drift_guard_rules(user_id);
create index if not exists idx_drift_guard_rules_rule_type on public.drift_guard_rules(rule_type);
create index if not exists idx_drift_guard_rules_enabled on public.drift_guard_rules(enabled);
create index if not exists idx_drift_guard_rules_severity on public.drift_guard_rules(severity);
create index if not exists idx_drift_guard_rules_created_at on public.drift_guard_rules(created_at);
create unique index if not exists uq_drift_guard_rules_user_rule_name on public.drift_guard_rules(user_id, rule_name);

create index if not exists idx_drift_guard_logs_user_id on public.drift_guard_logs(user_id);
create index if not exists idx_drift_guard_logs_intent_type on public.drift_guard_logs(intent_type);
create index if not exists idx_drift_guard_logs_final_risk_score on public.drift_guard_logs(final_risk_score);
create index if not exists idx_drift_guard_logs_blocked on public.drift_guard_logs(blocked);
create index if not exists idx_drift_guard_logs_created_at on public.drift_guard_logs(created_at);

create index if not exists idx_drift_baseline_snapshots_user_id on public.drift_baseline_snapshots(user_id);
create index if not exists idx_drift_baseline_snapshots_status on public.drift_baseline_snapshots(status);
create index if not exists idx_drift_baseline_snapshots_created_at on public.drift_baseline_snapshots(created_at);

drop trigger if exists trg_drift_guard_rules_updated_at on public.drift_guard_rules;
create trigger trg_drift_guard_rules_updated_at before update on public.drift_guard_rules
  for each row execute function public.set_updated_at();
drop trigger if exists trg_drift_baseline_snapshots_updated_at on public.drift_baseline_snapshots;
create trigger trg_drift_baseline_snapshots_updated_at before update on public.drift_baseline_snapshots
  for each row execute function public.set_updated_at();

alter table public.drift_guard_rules enable row level security;
alter table public.drift_guard_logs enable row level security;
alter table public.drift_baseline_snapshots enable row level security;

drop policy if exists "drift_guard_rules_select_own" on public.drift_guard_rules;
create policy "drift_guard_rules_select_own" on public.drift_guard_rules for select using (auth.uid() = user_id);
drop policy if exists "drift_guard_rules_insert_own" on public.drift_guard_rules;
create policy "drift_guard_rules_insert_own" on public.drift_guard_rules for insert with check (auth.uid() = user_id);
drop policy if exists "drift_guard_rules_update_own" on public.drift_guard_rules;
create policy "drift_guard_rules_update_own" on public.drift_guard_rules for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "drift_guard_rules_delete_own" on public.drift_guard_rules;
create policy "drift_guard_rules_delete_own" on public.drift_guard_rules for delete using (auth.uid() = user_id);

drop policy if exists "drift_guard_logs_select_own" on public.drift_guard_logs;
create policy "drift_guard_logs_select_own" on public.drift_guard_logs for select using (auth.uid() = user_id);
drop policy if exists "drift_guard_logs_insert_own" on public.drift_guard_logs;
create policy "drift_guard_logs_insert_own" on public.drift_guard_logs for insert with check (auth.uid() = user_id);

drop policy if exists "drift_baseline_snapshots_select_own" on public.drift_baseline_snapshots;
create policy "drift_baseline_snapshots_select_own" on public.drift_baseline_snapshots for select using (auth.uid() = user_id);
drop policy if exists "drift_baseline_snapshots_insert_own" on public.drift_baseline_snapshots;
create policy "drift_baseline_snapshots_insert_own" on public.drift_baseline_snapshots for insert with check (auth.uid() = user_id);
drop policy if exists "drift_baseline_snapshots_update_own" on public.drift_baseline_snapshots;
create policy "drift_baseline_snapshots_update_own" on public.drift_baseline_snapshots for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
