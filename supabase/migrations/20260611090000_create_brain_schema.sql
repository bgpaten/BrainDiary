-- =============================================================================
-- Personal Brain OS — Structured Brain Schema
-- Migration: create_brain_schema
-- Phase 3: Supabase structured brain database
--
-- Tables:
--   raw_entries      — sumber mentah (diary, quick input, file)
--   brain_nodes      — entitas otak (person, project, place, ...)
--   brain_edges      — relasi antar node
--   brain_clusters   — pengelompokan node per tema besar
--   brain_files      — metadata file attachment (bukan binary)
--   extraction_jobs  — status proses Brain Engine
--   agent_memories   — memory ringkas untuk AI Agent
--
-- Catatan: semua table multi-tenant via user_id + Row Level Security.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
-- pgcrypto menyediakan gen_random_uuid() untuk primary key.
create extension if not exists pgcrypto;

-- vector (pgvector) disiapkan untuk embedding di fase berikutnya.
-- TIDAK diwajibkan dipakai sekarang. Aktifkan bila project mendukung.
-- create extension if not exists vector;


-- ---------------------------------------------------------------------------
-- Helper: trigger function untuk auto-update kolom updated_at
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =============================================================================
-- 1. raw_entries
--    Sumber mentah dari diary, quick input, foto, PDF, dokumen, voice note.
-- =============================================================================
create table if not exists public.raw_entries (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  source_type       text not null default 'text'
                      check (source_type in ('text', 'image', 'document', 'audio', 'mixed')),
  source_origin     text not null default 'obsidian'
                      check (source_origin in ('obsidian', 'react_input', 'upload', 'api')),
  title             text,
  content           text,
  file_path         text,
  obsidian_path     text,
  happened_at       timestamptz,
  processed         boolean not null default false,
  processing_status text not null default 'pending'
                      check (processing_status in ('pending', 'processing', 'done', 'failed', 'needs_review')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_raw_entries_user_id           on public.raw_entries (user_id);
create index if not exists idx_raw_entries_processing_status on public.raw_entries (processing_status);

create trigger trg_raw_entries_updated_at
  before update on public.raw_entries
  for each row execute function public.set_updated_at();


-- =============================================================================
-- 4. brain_clusters
--    Didefinisikan sebelum brain_nodes karena node mereferensikan cluster.
--    Mengelompokkan node berdasarkan tema besar.
-- =============================================================================
create table if not exists public.brain_clusters (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  name         text not null,
  slug         text not null,
  description  text,
  color_key    text,
  priority     int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- slug unik per user agar cluster tidak duplikat.
  constraint uq_brain_clusters_user_slug unique (user_id, slug)
);

create index if not exists idx_brain_clusters_user_id on public.brain_clusters (user_id);

create trigger trg_brain_clusters_updated_at
  before update on public.brain_clusters
  for each row execute function public.set_updated_at();


-- =============================================================================
-- 2. brain_nodes
--    Entitas otak: person, place, event, project, decision, goal, pattern, ...
-- =============================================================================
create table if not exists public.brain_nodes (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  type              text not null
                      check (type in (
                        'person', 'place', 'event', 'project', 'decision',
                        'emotion', 'goal', 'pattern', 'organization',
                        'topic', 'tool', 'document'
                      )),
  name              text not null,
  -- canonical_name dipakai untuk mencegah duplikasi (NusaOps / Nusa Ops / nusaops).
  -- Disarankan diisi versi ter-normalisasi (lowercase, tanpa spasi/symbol).
  canonical_name    text not null,
  aliases           text[] not null default '{}',
  summary           text,
  description       text,
  importance_score  numeric(5,2) not null default 0,
  frequency_score   numeric(5,2) not null default 0,
  confidence_score  numeric(5,2) not null default 1,
  cluster_id        uuid references public.brain_clusters (id) on delete set null,
  first_seen_at     timestamptz,
  last_seen_at      timestamptz,
  source_entry_id   uuid references public.raw_entries (id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Satu entitas kanonik per (user, type) agar node tidak mudah duplikat.
  constraint uq_brain_nodes_user_type_canonical unique (user_id, type, canonical_name)
);

create index if not exists idx_brain_nodes_user_id        on public.brain_nodes (user_id);
create index if not exists idx_brain_nodes_type           on public.brain_nodes (type);
create index if not exists idx_brain_nodes_canonical_name on public.brain_nodes (canonical_name);
create index if not exists idx_brain_nodes_cluster_id     on public.brain_nodes (cluster_id);

create trigger trg_brain_nodes_updated_at
  before update on public.brain_nodes
  for each row execute function public.set_updated_at();


-- =============================================================================
-- 3. brain_edges
--    Relasi antar node.
-- =============================================================================
create table if not exists public.brain_edges (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  from_node_id      uuid not null references public.brain_nodes (id) on delete cascade,
  to_node_id        uuid not null references public.brain_nodes (id) on delete cascade,
  -- relation_type bebas (tidak di-CHECK) agar Brain Engine fleksibel menambah
  -- relasi baru. Contoh nilai: works_on, related_to, met_with, mentioned,
  -- happened_at, happened_in, decided, caused, feels_about, has_pattern,
  -- wants_to_achieve, uses, belongs_to_cluster, blocked_by, needs_validation.
  relation_type     text not null,
  summary           text,
  weight            numeric(5,2) not null default 1,
  confidence_score  numeric(5,2) not null default 1,
  source_entry_id   uuid references public.raw_entries (id) on delete set null,
  valid_at          timestamptz,
  invalid_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Cegah duplikasi relasi yang sama persis antar dua node.
  constraint uq_brain_edges_unique_relation unique (user_id, from_node_id, to_node_id, relation_type),
  -- Hindari self-loop tak bermakna.
  constraint chk_brain_edges_no_self_loop check (from_node_id <> to_node_id)
);

create index if not exists idx_brain_edges_user_id       on public.brain_edges (user_id);
create index if not exists idx_brain_edges_from_node_id  on public.brain_edges (from_node_id);
create index if not exists idx_brain_edges_to_node_id    on public.brain_edges (to_node_id);
create index if not exists idx_brain_edges_relation_type on public.brain_edges (relation_type);

create trigger trg_brain_edges_updated_at
  before update on public.brain_edges
  for each row execute function public.set_updated_at();


-- =============================================================================
-- 5. brain_files
--    Metadata file attachment (binary disimpan di Storage/Obsidian, bukan di sini).
-- =============================================================================
create table if not exists public.brain_files (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  raw_entry_id      uuid references public.raw_entries (id) on delete cascade,
  file_name         text not null,
  file_path         text,
  storage_bucket    text,
  mime_type         text,
  file_size         bigint,
  source_origin     text not null default 'obsidian'
                      check (source_origin in ('obsidian', 'react_input', 'upload', 'api')),
  obsidian_path     text,
  extracted_text    text,
  processing_status text not null default 'pending'
                      check (processing_status in ('pending', 'processing', 'done', 'failed', 'needs_review')),
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_brain_files_user_id      on public.brain_files (user_id);
create index if not exists idx_brain_files_raw_entry_id on public.brain_files (raw_entry_id);

create trigger trg_brain_files_updated_at
  before update on public.brain_files
  for each row execute function public.set_updated_at();


-- =============================================================================
-- 6. extraction_jobs
--    Status proses Brain Engine.
-- =============================================================================
create table if not exists public.extraction_jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  raw_entry_id    uuid references public.raw_entries (id) on delete cascade,
  job_type        text not null
                    check (job_type in (
                      'diary_extract', 'file_extract', 'node_merge',
                      'cluster_update', 'agent_memory_build'
                    )),
  status          text not null default 'pending'
                    check (status in ('pending', 'processing', 'done', 'failed', 'needs_review')),
  started_at      timestamptz,
  finished_at     timestamptz,
  error_message   text,
  input_snapshot  jsonb,
  output_snapshot jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_extraction_jobs_user_id      on public.extraction_jobs (user_id);
create index if not exists idx_extraction_jobs_status       on public.extraction_jobs (status);
create index if not exists idx_extraction_jobs_raw_entry_id on public.extraction_jobs (raw_entry_id);

create trigger trg_extraction_jobs_updated_at
  before update on public.extraction_jobs
  for each row execute function public.set_updated_at();


-- =============================================================================
-- 7. agent_memories
--    Memory ringkas yang bisa dibaca AI Agent sebelum menjawab.
-- =============================================================================
create table if not exists public.agent_memories (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  memory_type      text not null
                     check (memory_type in (
                       'preference', 'identity', 'decision', 'lesson',
                       'warning', 'goal', 'pattern', 'context'
                     )),
  content          text not null,
  importance_level text not null default 'normal'
                     check (importance_level in ('low', 'normal', 'important', 'core')),
  stability        text not null default 'normal'
                     check (stability in ('temporary', 'normal', 'stable', 'core')),
  sensitivity      text not null default 'private'
                     check (sensitivity in ('public', 'private', 'sensitive')),
  source_entry_id  uuid references public.raw_entries (id) on delete set null,
  source_node_id   uuid references public.brain_nodes (id) on delete set null,
  valid_from       timestamptz,
  valid_until      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_agent_memories_user_id          on public.agent_memories (user_id);
create index if not exists idx_agent_memories_memory_type      on public.agent_memories (memory_type);
create index if not exists idx_agent_memories_importance_level on public.agent_memories (importance_level);

create trigger trg_agent_memories_updated_at
  before update on public.agent_memories
  for each row execute function public.set_updated_at();


-- =============================================================================
-- Row Level Security
--   Aktifkan RLS untuk semua table. Setiap user hanya boleh mengakses datanya
--   sendiri (auth.uid() = user_id). Policy dibuat untuk select/insert/update/delete.
-- =============================================================================
alter table public.raw_entries     enable row level security;
alter table public.brain_clusters  enable row level security;
alter table public.brain_nodes     enable row level security;
alter table public.brain_edges     enable row level security;
alter table public.brain_files     enable row level security;
alter table public.extraction_jobs enable row level security;
alter table public.agent_memories  enable row level security;

-- Helper note: policy WITH CHECK pada insert/update memastikan user_id baris = user login.

-- raw_entries
create policy "raw_entries_select_own" on public.raw_entries
  for select using (auth.uid() = user_id);
create policy "raw_entries_insert_own" on public.raw_entries
  for insert with check (auth.uid() = user_id);
create policy "raw_entries_update_own" on public.raw_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "raw_entries_delete_own" on public.raw_entries
  for delete using (auth.uid() = user_id);

-- brain_clusters
create policy "brain_clusters_select_own" on public.brain_clusters
  for select using (auth.uid() = user_id);
create policy "brain_clusters_insert_own" on public.brain_clusters
  for insert with check (auth.uid() = user_id);
create policy "brain_clusters_update_own" on public.brain_clusters
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "brain_clusters_delete_own" on public.brain_clusters
  for delete using (auth.uid() = user_id);

-- brain_nodes
create policy "brain_nodes_select_own" on public.brain_nodes
  for select using (auth.uid() = user_id);
create policy "brain_nodes_insert_own" on public.brain_nodes
  for insert with check (auth.uid() = user_id);
create policy "brain_nodes_update_own" on public.brain_nodes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "brain_nodes_delete_own" on public.brain_nodes
  for delete using (auth.uid() = user_id);

-- brain_edges
create policy "brain_edges_select_own" on public.brain_edges
  for select using (auth.uid() = user_id);
create policy "brain_edges_insert_own" on public.brain_edges
  for insert with check (auth.uid() = user_id);
create policy "brain_edges_update_own" on public.brain_edges
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "brain_edges_delete_own" on public.brain_edges
  for delete using (auth.uid() = user_id);

-- brain_files
create policy "brain_files_select_own" on public.brain_files
  for select using (auth.uid() = user_id);
create policy "brain_files_insert_own" on public.brain_files
  for insert with check (auth.uid() = user_id);
create policy "brain_files_update_own" on public.brain_files
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "brain_files_delete_own" on public.brain_files
  for delete using (auth.uid() = user_id);

-- extraction_jobs
create policy "extraction_jobs_select_own" on public.extraction_jobs
  for select using (auth.uid() = user_id);
create policy "extraction_jobs_insert_own" on public.extraction_jobs
  for insert with check (auth.uid() = user_id);
create policy "extraction_jobs_update_own" on public.extraction_jobs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "extraction_jobs_delete_own" on public.extraction_jobs
  for delete using (auth.uid() = user_id);

-- agent_memories
create policy "agent_memories_select_own" on public.agent_memories
  for select using (auth.uid() = user_id);
create policy "agent_memories_insert_own" on public.agent_memories
  for insert with check (auth.uid() = user_id);
create policy "agent_memories_update_own" on public.agent_memories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "agent_memories_delete_own" on public.agent_memories
  for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
