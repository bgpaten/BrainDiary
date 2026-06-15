-- =============================================================================
-- Personal Entity OS — Identity Fidelity Engine
-- Migration: create_identity_fidelity
-- Step 18: evidence-bound identity facts and snapshots
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.identity_facts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  fact_type          text not null
                       check (fact_type in (
                         'trait',
                         'belief',
                         'value',
                         'preference',
                         'goal',
                         'fear',
                         'ambition',
                         'decision_pattern',
                         'communication_pattern',
                         'emotional_pattern',
                         'risk_pattern',
                         'contradiction',
                         'boundary',
                         'identity_summary'
                       )),
  label              text not null,
  statement          text not null,
  evidence_refs      jsonb not null default '[]'::jsonb,
  source_table       text,
  source_ids         jsonb not null default '[]'::jsonb,
  confidence_score   numeric(5,4) not null default 0.45
                       check (confidence_score >= 0 and confidence_score <= 1),
  stability          text not null default 'temporary'
                       check (stability in ('temporary', 'recurring', 'stable', 'core')),
  strength           text not null default 'weak'
                       check (strength in ('weak', 'medium', 'strong', 'core')),
  polarity           text not null default 'neutral'
                       check (polarity in ('positive', 'negative', 'neutral', 'mixed')),
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  usage_scope        jsonb not null default '[]'::jsonb,
  status             text not null default 'active'
                       check (status in ('active', 'needs_review', 'contradicted', 'deprecated', 'rejected')),
  contradiction_refs jsonb not null default '[]'::jsonb,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.identity_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  snapshot_type      text not null default 'manual'
                       check (snapshot_type in ('daily', 'weekly', 'manual', 'baseline')),
  title              text not null,
  summary            text,
  identity_model     jsonb not null default '{}'::jsonb,
  confidence_summary jsonb not null default '{}'::jsonb,
  data_coverage      jsonb not null default '{}'::jsonb,
  warnings           jsonb not null default '[]'::jsonb,
  source_refs        jsonb not null default '[]'::jsonb,
  model_provider     text,
  model_name         text,
  status             text not null default 'draft'
                       check (status in ('draft', 'done', 'needs_review', 'failed')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_identity_facts_user_id          on public.identity_facts (user_id);
create index if not exists idx_identity_facts_fact_type        on public.identity_facts (fact_type);
create index if not exists idx_identity_facts_status           on public.identity_facts (status);
create index if not exists idx_identity_facts_confidence_score on public.identity_facts (confidence_score);
create index if not exists idx_identity_facts_stability        on public.identity_facts (stability);
create index if not exists idx_identity_facts_created_at       on public.identity_facts (created_at);
create index if not exists idx_identity_facts_last_seen_at     on public.identity_facts (last_seen_at);
create unique index if not exists uq_identity_facts_user_type_label_norm
  on public.identity_facts (user_id, fact_type, lower(regexp_replace(label, '\s+', ' ', 'g')));

create index if not exists idx_identity_snapshots_user_id    on public.identity_snapshots (user_id);
create index if not exists idx_identity_snapshots_status     on public.identity_snapshots (status);
create index if not exists idx_identity_snapshots_created_at on public.identity_snapshots (created_at);

drop trigger if exists trg_identity_facts_updated_at on public.identity_facts;
create trigger trg_identity_facts_updated_at
  before update on public.identity_facts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_identity_snapshots_updated_at on public.identity_snapshots;
create trigger trg_identity_snapshots_updated_at
  before update on public.identity_snapshots
  for each row execute function public.set_updated_at();

alter table public.identity_facts enable row level security;
alter table public.identity_snapshots enable row level security;

drop policy if exists "identity_facts_select_own" on public.identity_facts;
create policy "identity_facts_select_own" on public.identity_facts
  for select using (auth.uid() = user_id);

drop policy if exists "identity_facts_insert_own" on public.identity_facts;
create policy "identity_facts_insert_own" on public.identity_facts
  for insert with check (auth.uid() = user_id);

drop policy if exists "identity_facts_update_own" on public.identity_facts;
create policy "identity_facts_update_own" on public.identity_facts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "identity_facts_delete_own" on public.identity_facts;
create policy "identity_facts_delete_own" on public.identity_facts
  for delete using (auth.uid() = user_id);

drop policy if exists "identity_snapshots_select_own" on public.identity_snapshots;
create policy "identity_snapshots_select_own" on public.identity_snapshots
  for select using (auth.uid() = user_id);

drop policy if exists "identity_snapshots_insert_own" on public.identity_snapshots;
create policy "identity_snapshots_insert_own" on public.identity_snapshots
  for insert with check (auth.uid() = user_id);

drop policy if exists "identity_snapshots_update_own" on public.identity_snapshots;
create policy "identity_snapshots_update_own" on public.identity_snapshots
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "identity_snapshots_delete_own" on public.identity_snapshots;
create policy "identity_snapshots_delete_own" on public.identity_snapshots
  for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
