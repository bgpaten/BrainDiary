-- =============================================================================
-- Personal Entity OS — Identity Conflict & Contradiction Resolver
-- Step 26: store identity tensions without deleting either side
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.identity_conflicts (
  id                                  uuid primary key default gen_random_uuid(),
  user_id                             uuid not null,
  conflict_type                       text not null default 'unknown'
                                        check (conflict_type in (
                                          'goal_vs_behavior',
                                          'belief_vs_action',
                                          'value_vs_decision',
                                          'communication_mismatch',
                                          'identity_tension',
                                          'strategy_conflict',
                                          'emotional_conflict',
                                          'risk_pattern_conflict',
                                          'autonomy_vs_fidelity',
                                          'unknown'
                                        )),
  title                               text not null,
  normalized_title                    text not null,
  summary                             text not null,
  side_a_label                        text not null,
  side_a_statement                    text not null,
  side_a_evidence_refs                jsonb not null default '[]'::jsonb,
  side_a_confidence                   numeric(5,4) not null default 0.55
                                        check (side_a_confidence >= 0 and side_a_confidence <= 1),
  side_b_label                        text not null,
  side_b_statement                    text not null,
  side_b_evidence_refs                jsonb not null default '[]'::jsonb,
  side_b_confidence                   numeric(5,4) not null default 0.55
                                        check (side_b_confidence >= 0 and side_b_confidence <= 1),
  severity                            text not null default 'low'
                                        check (severity in ('low', 'medium', 'high', 'critical')),
  recurrence                          text not null default 'one_time'
                                        check (recurrence in ('one_time', 'repeated', 'recurring', 'core_tension')),
  resolution_status                   text not null default 'open'
                                        check (resolution_status in ('open', 'monitoring', 'partially_resolved', 'resolved', 'dismissed', 'needs_review')),
  impact_area                         text not null default 'unknown'
                                        check (impact_area in (
                                          'identity',
                                          'communication',
                                          'decision_making',
                                          'strategy',
                                          'emotion',
                                          'project_execution',
                                          'relationship',
                                          'career',
                                          'faith_or_values',
                                          'unknown'
                                        )),
  first_seen_at                       timestamptz not null default now(),
  last_seen_at                        timestamptz not null default now(),
  related_identity_fact_ids           jsonb not null default '[]'::jsonb,
  related_communication_pattern_ids   jsonb not null default '[]'::jsonb,
  related_reflection_log_ids          jsonb not null default '[]'::jsonb,
  related_drift_log_ids               jsonb not null default '[]'::jsonb,
  related_similarity_result_ids       jsonb not null default '[]'::jsonb,
  chat_guidance                       jsonb not null default '{}'::jsonb,
  metadata                            jsonb not null default '{}'::jsonb,
  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now()
);

create table if not exists public.identity_conflict_events (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  identity_conflict_id  uuid not null references public.identity_conflicts(id) on delete cascade,
  event_type            text not null
                          check (event_type in (
                            'new_evidence',
                            'strengthened_side_a',
                            'strengthened_side_b',
                            'weakened_side_a',
                            'weakened_side_b',
                            'resolution_signal',
                            'contradiction_signal',
                            'manual_review',
                            'status_change'
                          )),
  event_summary         text not null,
  evidence_refs         jsonb not null default '[]'::jsonb,
  side_supported        text not null default 'unclear'
                          check (side_supported in ('side_a', 'side_b', 'both', 'neither', 'unclear')),
  confidence_score      numeric(5,4) not null default 0.55
                          check (confidence_score >= 0 and confidence_score <= 1),
  occurred_at           timestamptz not null default now(),
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create table if not exists public.identity_conflict_reviews (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null,
  identity_conflict_id   uuid not null references public.identity_conflicts(id) on delete cascade,
  review_status          text not null default 'pending'
                           check (review_status in ('pending', 'reviewed', 'ignored', 'applied')),
  owner_note             text,
  decision               text not null
                           check (decision in ('keep_open', 'mark_monitoring', 'mark_resolved', 'dismiss', 'merge_with_other', 'needs_more_data')),
  new_resolution_status  text
                           check (new_resolution_status in ('open', 'monitoring', 'partially_resolved', 'resolved', 'dismissed', 'needs_review')),
  updated_chat_guidance  jsonb not null default '{}'::jsonb,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists uq_identity_conflicts_user_title_type_area
  on public.identity_conflicts (user_id, normalized_title, conflict_type, impact_area);

create index if not exists idx_identity_conflicts_user_id            on public.identity_conflicts (user_id);
create index if not exists idx_identity_conflicts_conflict_type      on public.identity_conflicts (conflict_type);
create index if not exists idx_identity_conflicts_severity           on public.identity_conflicts (severity);
create index if not exists idx_identity_conflicts_recurrence         on public.identity_conflicts (recurrence);
create index if not exists idx_identity_conflicts_resolution_status  on public.identity_conflicts (resolution_status);
create index if not exists idx_identity_conflicts_impact_area        on public.identity_conflicts (impact_area);
create index if not exists idx_identity_conflicts_created_at         on public.identity_conflicts (created_at);
create index if not exists idx_identity_conflicts_last_seen_at       on public.identity_conflicts (last_seen_at);

create index if not exists idx_identity_conflict_events_user_id               on public.identity_conflict_events (user_id);
create index if not exists idx_identity_conflict_events_identity_conflict_id  on public.identity_conflict_events (identity_conflict_id);
create index if not exists idx_identity_conflict_events_created_at            on public.identity_conflict_events (created_at);

create index if not exists idx_identity_conflict_reviews_user_id               on public.identity_conflict_reviews (user_id);
create index if not exists idx_identity_conflict_reviews_identity_conflict_id  on public.identity_conflict_reviews (identity_conflict_id);
create index if not exists idx_identity_conflict_reviews_created_at            on public.identity_conflict_reviews (created_at);

drop trigger if exists trg_identity_conflicts_updated_at on public.identity_conflicts;
create trigger trg_identity_conflicts_updated_at
  before update on public.identity_conflicts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_identity_conflict_reviews_updated_at on public.identity_conflict_reviews;
create trigger trg_identity_conflict_reviews_updated_at
  before update on public.identity_conflict_reviews
  for each row execute function public.set_updated_at();

alter table public.identity_conflicts enable row level security;
alter table public.identity_conflict_events enable row level security;
alter table public.identity_conflict_reviews enable row level security;

drop policy if exists "identity_conflicts_select_own" on public.identity_conflicts;
create policy "identity_conflicts_select_own" on public.identity_conflicts for select using (auth.uid() = user_id);
drop policy if exists "identity_conflicts_insert_own" on public.identity_conflicts;
create policy "identity_conflicts_insert_own" on public.identity_conflicts for insert with check (auth.uid() = user_id);
drop policy if exists "identity_conflicts_update_own" on public.identity_conflicts;
create policy "identity_conflicts_update_own" on public.identity_conflicts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "identity_conflicts_delete_own" on public.identity_conflicts;
create policy "identity_conflicts_delete_own" on public.identity_conflicts for delete using (auth.uid() = user_id);

drop policy if exists "identity_conflict_events_select_own" on public.identity_conflict_events;
create policy "identity_conflict_events_select_own" on public.identity_conflict_events for select using (auth.uid() = user_id);
drop policy if exists "identity_conflict_events_insert_own" on public.identity_conflict_events;
create policy "identity_conflict_events_insert_own" on public.identity_conflict_events for insert with check (auth.uid() = user_id);
drop policy if exists "identity_conflict_events_update_own" on public.identity_conflict_events;
create policy "identity_conflict_events_update_own" on public.identity_conflict_events for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "identity_conflict_events_delete_own" on public.identity_conflict_events;
create policy "identity_conflict_events_delete_own" on public.identity_conflict_events for delete using (auth.uid() = user_id);

drop policy if exists "identity_conflict_reviews_select_own" on public.identity_conflict_reviews;
create policy "identity_conflict_reviews_select_own" on public.identity_conflict_reviews for select using (auth.uid() = user_id);
drop policy if exists "identity_conflict_reviews_insert_own" on public.identity_conflict_reviews;
create policy "identity_conflict_reviews_insert_own" on public.identity_conflict_reviews for insert with check (auth.uid() = user_id);
drop policy if exists "identity_conflict_reviews_update_own" on public.identity_conflict_reviews;
create policy "identity_conflict_reviews_update_own" on public.identity_conflict_reviews for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "identity_conflict_reviews_delete_own" on public.identity_conflict_reviews;
create policy "identity_conflict_reviews_delete_own" on public.identity_conflict_reviews for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
