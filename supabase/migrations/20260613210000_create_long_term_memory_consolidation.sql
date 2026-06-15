-- =============================================================================
-- Personal Entity OS — Long-Term Memory Consolidation
-- Step 29: stable, evidence-bound consolidated memory layer
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.long_term_memories (
  id                                      uuid primary key default gen_random_uuid(),
  user_id                                 uuid not null,
  memory_type                             text not null default 'unknown' check (memory_type in ('core_identity','recurring_pattern','long_term_goal','communication_style','decision_pattern','relationship_context','project_context','risk_pattern','emotional_pattern','belief_or_value','conflict_context','boundary','technical_context','life_event_summary','unknown')),
  title                                   text not null,
  summary                                 text,
  canonical_statement                     text not null,
  evidence_refs                           jsonb not null default '[]'::jsonb,
  related_raw_entry_ids                   jsonb not null default '[]'::jsonb,
  related_agent_memory_ids                jsonb not null default '[]'::jsonb,
  related_identity_fact_ids               jsonb not null default '[]'::jsonb,
  related_communication_pattern_ids       jsonb not null default '[]'::jsonb,
  related_conflict_ids                    jsonb not null default '[]'::jsonb,
  related_reflection_log_ids              jsonb not null default '[]'::jsonb,
  importance_score                        numeric(5,4) not null default 0 check (importance_score >= 0 and importance_score <= 1),
  confidence_score                        numeric(5,4) not null default 0 check (confidence_score >= 0 and confidence_score <= 1),
  stability                               text not null default 'emerging' check (stability in ('temporary','emerging','recurring','stable','core')),
  recurrence                              text not null default 'one_time' check (recurrence in ('one_time','repeated','recurring','persistent')),
  freshness                               text not null default 'active' check (freshness in ('fresh','active','aging','stale','historical')),
  status                                  text not null default 'active' check (status in ('active','needs_review','archived','deprecated','contradicted','merged')),
  first_seen_at                           timestamptz,
  last_seen_at                            timestamptz,
  consolidated_at                         timestamptz not null default now(),
  metadata                                jsonb not null default '{}'::jsonb,
  created_at                              timestamptz not null default now(),
  updated_at                              timestamptz not null default now()
);

create table if not exists public.memory_consolidation_runs (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null,
  run_type                    text not null default 'manual' check (run_type in ('manual','daily','weekly','monthly','full','after_import','after_reflection')),
  status                      text not null default 'pending' check (status in ('pending','running','done','partial','failed')),
  period_start                timestamptz,
  period_end                  timestamptz,
  source_counts               jsonb not null default '{}'::jsonb,
  created_memory_count        integer not null default 0,
  updated_memory_count        integer not null default 0,
  duplicate_candidate_count   integer not null default 0,
  archive_candidate_count     integer not null default 0,
  stale_candidate_count       integer not null default 0,
  contradiction_link_count    integer not null default 0,
  review_suggestion_count     integer not null default 0,
  summary                     text,
  warnings                    jsonb not null default '[]'::jsonb,
  started_at                  timestamptz not null default now(),
  finished_at                 timestamptz,
  metadata                    jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create table if not exists public.memory_consolidation_items (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null,
  consolidation_run_id         uuid references public.memory_consolidation_runs(id) on delete cascade,
  source_type                 text not null check (source_type in ('raw_entry','agent_memory','brain_node','identity_fact','communication_pattern','brain_report','self_reflection_log','chat_message','owner_answer_example','identity_conflict','long_term_memory')),
  source_id                   uuid,
  target_long_term_memory_id   uuid references public.long_term_memories(id) on delete set null,
  action_type                 text not null check (action_type in ('create_long_term_memory','merge_into_existing','mark_duplicate_candidate','mark_archive_candidate','mark_stale_candidate','link_to_conflict','link_to_identity','link_to_communication','needs_review','no_action')),
  reason                      text,
  confidence_score            numeric(5,4) not null default 0 check (confidence_score >= 0 and confidence_score <= 1),
  risk_score                  numeric(5,4) not null default 0 check (risk_score >= 0 and risk_score <= 1),
  status                      text not null default 'proposed' check (status in ('proposed','applied','needs_review','ignored','rejected')),
  metadata                    jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create table if not exists public.memory_review_queue (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  review_type         text not null check (review_type in ('duplicate_memory','stale_memory','conflicting_memory','low_confidence_memory','archive_candidate','merge_candidate','core_memory_candidate','identity_update_candidate','communication_update_candidate','evidence_missing')),
  title               text not null,
  description         text,
  source_refs         jsonb not null default '[]'::jsonb,
  target_refs         jsonb not null default '[]'::jsonb,
  suggested_action    text not null check (suggested_action in ('merge','archive','keep_active','mark_needs_review','link_conflict','add_evidence','reject','ignore')),
  risk_score          numeric(5,4) not null default 0 check (risk_score >= 0 and risk_score <= 1),
  priority            text not null default 'medium' check (priority in ('low','medium','high','critical')),
  status              text not null default 'pending' check (status in ('pending','approved','rejected','ignored','applied')),
  owner_note          text,
  reviewed_at         timestamptz,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.memory_consolidation_snapshots (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null,
  snapshot_type             text not null default 'manual' check (snapshot_type in ('daily','weekly','monthly','manual','baseline')),
  title                     text not null,
  summary                   text,
  core_memories             jsonb not null default '[]'::jsonb,
  active_patterns           jsonb not null default '[]'::jsonb,
  long_term_goals           jsonb not null default '[]'::jsonb,
  active_projects           jsonb not null default '[]'::jsonb,
  communication_memory      jsonb not null default '[]'::jsonb,
  risk_memory               jsonb not null default '[]'::jsonb,
  conflict_memory           jsonb not null default '[]'::jsonb,
  archived_summary          jsonb not null default '{}'::jsonb,
  uncertainties             jsonb not null default '[]'::jsonb,
  memory_health             jsonb not null default '{}'::jsonb,
  status                    text not null default 'active' check (status in ('active','archived','needs_review','failed')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  metadata                  jsonb not null default '{}'::jsonb
);

create unique index if not exists uq_long_term_memories_user_type_title on public.long_term_memories(user_id, memory_type, lower(title));
create index if not exists idx_long_term_memories_user_id on public.long_term_memories(user_id);
create index if not exists idx_long_term_memories_memory_type on public.long_term_memories(memory_type);
create index if not exists idx_long_term_memories_status on public.long_term_memories(status);
create index if not exists idx_long_term_memories_stability on public.long_term_memories(stability);
create index if not exists idx_long_term_memories_freshness on public.long_term_memories(freshness);
create index if not exists idx_long_term_memories_importance on public.long_term_memories(importance_score);
create index if not exists idx_long_term_memories_confidence on public.long_term_memories(confidence_score);
create index if not exists idx_long_term_memories_created_at on public.long_term_memories(created_at);
create index if not exists idx_long_term_memories_updated_at on public.long_term_memories(updated_at);
create index if not exists idx_memory_consolidation_runs_user_id on public.memory_consolidation_runs(user_id);
create index if not exists idx_memory_consolidation_runs_run_type on public.memory_consolidation_runs(run_type);
create index if not exists idx_memory_consolidation_runs_status on public.memory_consolidation_runs(status);
create index if not exists idx_memory_consolidation_runs_created_at on public.memory_consolidation_runs(created_at);
create index if not exists idx_memory_consolidation_items_user_id on public.memory_consolidation_items(user_id);
create index if not exists idx_memory_consolidation_items_run_id on public.memory_consolidation_items(consolidation_run_id);
create index if not exists idx_memory_consolidation_items_source on public.memory_consolidation_items(source_type, source_id);
create index if not exists idx_memory_review_queue_user_id on public.memory_review_queue(user_id);
create index if not exists idx_memory_review_queue_review_type on public.memory_review_queue(review_type);
create index if not exists idx_memory_review_queue_priority on public.memory_review_queue(priority);
create index if not exists idx_memory_review_queue_status on public.memory_review_queue(status);
create index if not exists idx_memory_review_queue_created_at on public.memory_review_queue(created_at);
create index if not exists idx_memory_consolidation_snapshots_user_id on public.memory_consolidation_snapshots(user_id);
create index if not exists idx_memory_consolidation_snapshots_status on public.memory_consolidation_snapshots(status);
create index if not exists idx_memory_consolidation_snapshots_created_at on public.memory_consolidation_snapshots(created_at);

drop trigger if exists trg_long_term_memories_updated_at on public.long_term_memories;
create trigger trg_long_term_memories_updated_at before update on public.long_term_memories for each row execute function public.set_updated_at();
drop trigger if exists trg_memory_consolidation_runs_updated_at on public.memory_consolidation_runs;
create trigger trg_memory_consolidation_runs_updated_at before update on public.memory_consolidation_runs for each row execute function public.set_updated_at();
drop trigger if exists trg_memory_consolidation_items_updated_at on public.memory_consolidation_items;
create trigger trg_memory_consolidation_items_updated_at before update on public.memory_consolidation_items for each row execute function public.set_updated_at();
drop trigger if exists trg_memory_review_queue_updated_at on public.memory_review_queue;
create trigger trg_memory_review_queue_updated_at before update on public.memory_review_queue for each row execute function public.set_updated_at();
drop trigger if exists trg_memory_consolidation_snapshots_updated_at on public.memory_consolidation_snapshots;
create trigger trg_memory_consolidation_snapshots_updated_at before update on public.memory_consolidation_snapshots for each row execute function public.set_updated_at();

alter table public.long_term_memories enable row level security;
alter table public.memory_consolidation_runs enable row level security;
alter table public.memory_consolidation_items enable row level security;
alter table public.memory_review_queue enable row level security;
alter table public.memory_consolidation_snapshots enable row level security;

do $$
declare t text;
begin
  foreach t in array array['long_term_memories','memory_consolidation_runs','memory_consolidation_items','memory_review_queue','memory_consolidation_snapshots'] loop
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
