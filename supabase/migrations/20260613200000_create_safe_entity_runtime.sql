-- =============================================================================
-- Personal Entity OS — Safe Entity Runtime / Read-Only Autonomy Boundary
-- Step 28: runtime safety policies, sessions, events, proposals, reports
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.entity_runtime_policies (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  policy_name        text not null,
  policy_type        text not null check (policy_type in ('read_boundary','write_boundary','external_action_boundary','identity_mutation_boundary','communication_mutation_boundary','privacy_boundary','fidelity_boundary','debug_boundary','runtime_mode_boundary','approval_boundary')),
  description        text,
  allowed_reads      jsonb not null default '[]'::jsonb,
  allowed_writes     jsonb not null default '[]'::jsonb,
  blocked_actions    jsonb not null default '[]'::jsonb,
  requires_approval  jsonb not null default '[]'::jsonb,
  runtime_modes      jsonb not null default '["read_only"]'::jsonb,
  severity           text not null default 'medium' check (severity in ('low','medium','high','critical')),
  enabled            boolean not null default true,
  priority           integer not null default 100,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.entity_runtime_sessions (
  id                                uuid primary key default gen_random_uuid(),
  user_id                           uuid not null,
  session_type                      text not null default 'manual' check (session_type in ('chat','reflection','evaluation','manual','daily_use','debug')),
  runtime_mode                      text not null default 'read_only' check (runtime_mode in ('read_only','proposal_only','supervised','debug','disabled')),
  title                             text,
  status                            text not null default 'active' check (status in ('active','paused','ended','blocked','failed')),
  started_at                        timestamptz not null default now(),
  ended_at                          timestamptz,
  readiness_level                   text,
  active_policy_ids                 jsonb not null default '[]'::jsonb,
  active_identity_snapshot_id        uuid,
  active_similarity_baseline_id      uuid,
  active_drift_baseline_id           uuid,
  active_self_clone_eval_run_id      uuid,
  runtime_context                   jsonb not null default '{}'::jsonb,
  warnings                          jsonb not null default '[]'::jsonb,
  metadata                          jsonb not null default '{}'::jsonb,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now()
);

create table if not exists public.entity_runtime_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  runtime_session_id  uuid references public.entity_runtime_sessions(id) on delete set null,
  event_type          text not null check (event_type in ('session_started','session_ended','chat_request','runtime_context_built','policy_check','boundary_block','boundary_warning','proposal_created','proposal_reviewed','safe_response_generated','fallback_used','error')),
  event_summary       text not null,
  input_payload       jsonb not null default '{}'::jsonb,
  output_payload      jsonb not null default '{}'::jsonb,
  policy_decision     jsonb not null default '{}'::jsonb,
  blocked             boolean not null default false,
  requires_approval   boolean not null default false,
  risk_score          numeric(5,4) not null default 0 check (risk_score >= 0 and risk_score <= 1),
  warnings            jsonb not null default '[]'::jsonb,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create table if not exists public.entity_action_proposals (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null,
  runtime_session_id        uuid references public.entity_runtime_sessions(id) on delete set null,
  proposal_type             text not null check (proposal_type in ('write_diary_suggestion','identity_review_suggestion','communication_review_suggestion','calibration_suggestion','task_suggestion','project_suggestion','message_draft','document_draft','code_prompt_suggestion','system_maintenance_suggestion','other')),
  title                     text not null,
  description               text,
  reason                    text,
  proposed_action           jsonb not null default '{}'::jsonb,
  target_system             text not null default 'none' check (target_system in ('none','obsidian','supabase','gmail','calendar','github','filesystem','telegram','external_api','unknown')),
  required_approval_level   text not null default 'user_review' check (required_approval_level in ('none','user_review','explicit_confirm','manual_only','blocked')),
  risk_score                numeric(5,4) not null default 0 check (risk_score >= 0 and risk_score <= 1),
  fidelity_reason           text,
  evidence_refs             jsonb not null default '[]'::jsonb,
  status                    text not null default 'proposed' check (status in ('proposed','approved','rejected','ignored','expired','blocked')),
  review_note               text,
  reviewed_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  metadata                  jsonb not null default '{}'::jsonb
);

create table if not exists public.entity_runtime_safety_reports (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null,
  title                    text not null,
  runtime_session_id        uuid references public.entity_runtime_sessions(id) on delete set null,
  summary                  text,
  runtime_mode             text,
  policy_status            jsonb not null default '{}'::jsonb,
  blocked_actions_count    integer not null default 0,
  proposal_count           integer not null default 0,
  high_risk_event_count    integer not null default 0,
  read_only_violations     integer not null default 0,
  privacy_warnings         jsonb not null default '[]'::jsonb,
  fidelity_warnings        jsonb not null default '[]'::jsonb,
  recommended_next_steps   jsonb not null default '[]'::jsonb,
  status                   text not null default 'healthy' check (status in ('healthy','warning','critical','failed')),
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index if not exists uq_entity_runtime_policies_user_name on public.entity_runtime_policies(user_id, policy_name);
create index if not exists idx_entity_runtime_policies_user_id on public.entity_runtime_policies(user_id);
create index if not exists idx_entity_runtime_policies_policy_type on public.entity_runtime_policies(policy_type);
create index if not exists idx_entity_runtime_policies_enabled on public.entity_runtime_policies(enabled);
create index if not exists idx_entity_runtime_policies_created_at on public.entity_runtime_policies(created_at);
create index if not exists idx_entity_runtime_sessions_user_id on public.entity_runtime_sessions(user_id);
create index if not exists idx_entity_runtime_sessions_runtime_mode on public.entity_runtime_sessions(runtime_mode);
create index if not exists idx_entity_runtime_sessions_status on public.entity_runtime_sessions(status);
create index if not exists idx_entity_runtime_sessions_created_at on public.entity_runtime_sessions(created_at);
create index if not exists idx_entity_runtime_events_user_id on public.entity_runtime_events(user_id);
create index if not exists idx_entity_runtime_events_runtime_session_id on public.entity_runtime_events(runtime_session_id);
create index if not exists idx_entity_runtime_events_event_type on public.entity_runtime_events(event_type);
create index if not exists idx_entity_runtime_events_risk_score on public.entity_runtime_events(risk_score);
create index if not exists idx_entity_runtime_events_created_at on public.entity_runtime_events(created_at);
create index if not exists idx_entity_action_proposals_user_id on public.entity_action_proposals(user_id);
create index if not exists idx_entity_action_proposals_runtime_session_id on public.entity_action_proposals(runtime_session_id);
create index if not exists idx_entity_action_proposals_proposal_type on public.entity_action_proposals(proposal_type);
create index if not exists idx_entity_action_proposals_target_system on public.entity_action_proposals(target_system);
create index if not exists idx_entity_action_proposals_status on public.entity_action_proposals(status);
create index if not exists idx_entity_action_proposals_risk_score on public.entity_action_proposals(risk_score);
create index if not exists idx_entity_action_proposals_created_at on public.entity_action_proposals(created_at);
create index if not exists idx_entity_runtime_safety_reports_user_id on public.entity_runtime_safety_reports(user_id);
create index if not exists idx_entity_runtime_safety_reports_runtime_session_id on public.entity_runtime_safety_reports(runtime_session_id);
create index if not exists idx_entity_runtime_safety_reports_status on public.entity_runtime_safety_reports(status);
create index if not exists idx_entity_runtime_safety_reports_created_at on public.entity_runtime_safety_reports(created_at);

drop trigger if exists trg_entity_runtime_policies_updated_at on public.entity_runtime_policies;
create trigger trg_entity_runtime_policies_updated_at before update on public.entity_runtime_policies for each row execute function public.set_updated_at();
drop trigger if exists trg_entity_runtime_sessions_updated_at on public.entity_runtime_sessions;
create trigger trg_entity_runtime_sessions_updated_at before update on public.entity_runtime_sessions for each row execute function public.set_updated_at();
drop trigger if exists trg_entity_action_proposals_updated_at on public.entity_action_proposals;
create trigger trg_entity_action_proposals_updated_at before update on public.entity_action_proposals for each row execute function public.set_updated_at();
drop trigger if exists trg_entity_runtime_safety_reports_updated_at on public.entity_runtime_safety_reports;
create trigger trg_entity_runtime_safety_reports_updated_at before update on public.entity_runtime_safety_reports for each row execute function public.set_updated_at();

alter table public.entity_runtime_policies enable row level security;
alter table public.entity_runtime_sessions enable row level security;
alter table public.entity_runtime_events enable row level security;
alter table public.entity_action_proposals enable row level security;
alter table public.entity_runtime_safety_reports enable row level security;

do $$
declare t text;
begin
  foreach t in array array['entity_runtime_policies','entity_runtime_sessions','entity_runtime_events','entity_action_proposals','entity_runtime_safety_reports'] loop
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
