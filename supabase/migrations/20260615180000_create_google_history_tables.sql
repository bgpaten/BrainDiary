-- =============================================================================
-- Google History Daily Importer — Schema Migration
--
-- Tables baru:
--   google_history_imports  — satu row per tanggal import
--   google_history_items    — item aktivitas Google History per import
--
-- Perubahan constraint:
--   raw_entries.source_origin       — tambah 'google_history'
--   raw_entries.processing_status   — tambah 'skipped'
--   extraction_jobs.job_type        — tambah 'google_history_import'
--
-- Kolom baru di raw_entries:
--   source_ref, source_metadata, collected_at, processed_at
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Update raw_entries constraints & columns
-- ---------------------------------------------------------------------------

-- Tambah 'google_history' ke source_origin
ALTER TABLE public.raw_entries
  DROP CONSTRAINT IF EXISTS raw_entries_source_origin_check;

ALTER TABLE public.raw_entries
  ADD CONSTRAINT raw_entries_source_origin_check
  CHECK (source_origin IN (
    'obsidian', 'react_input', 'upload', 'api', 'attachment', 'google_history'
  ));

-- Tambah 'skipped' ke processing_status
ALTER TABLE public.raw_entries
  DROP CONSTRAINT IF EXISTS raw_entries_processing_status_check;

ALTER TABLE public.raw_entries
  ADD CONSTRAINT raw_entries_processing_status_check
  CHECK (processing_status IN (
    'pending', 'processing', 'done', 'failed', 'needs_review', 'skipped'
  ));

-- Kolom tambahan untuk collector pipeline
ALTER TABLE public.raw_entries ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE public.raw_entries ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.raw_entries ADD COLUMN IF NOT EXISTS collected_at timestamptz;
ALTER TABLE public.raw_entries ADD COLUMN IF NOT EXISTS processed_at timestamptz;


-- ---------------------------------------------------------------------------
-- 2. Update extraction_jobs constraint
-- ---------------------------------------------------------------------------

ALTER TABLE public.extraction_jobs
  DROP CONSTRAINT IF EXISTS extraction_jobs_job_type_check;

ALTER TABLE public.extraction_jobs
  ADD CONSTRAINT extraction_jobs_job_type_check
  CHECK (job_type IN (
    'diary_extract', 'file_extract', 'node_merge',
    'cluster_update', 'agent_memory_build', 'google_history_import'
  ));


-- ---------------------------------------------------------------------------
-- 3. google_history_imports
--    Satu row per tanggal import. Dibuat oleh collector (GitHub Actions / local).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.google_history_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  import_date    date NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  collector      text NOT NULL DEFAULT 'local'
                   CHECK (collector IN ('local', 'github_actions')),
  item_count     integer NOT NULL DEFAULT 0,
  raw_entry_id   uuid REFERENCES public.raw_entries(id) ON DELETE SET NULL,
  error_message  text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Satu import per user per tanggal
  CONSTRAINT uq_google_history_imports_user_date UNIQUE (user_id, import_date)
);

CREATE INDEX IF NOT EXISTS idx_google_history_imports_user_id
  ON public.google_history_imports (user_id);

CREATE INDEX IF NOT EXISTS idx_google_history_imports_status
  ON public.google_history_imports (status);

CREATE INDEX IF NOT EXISTS idx_google_history_imports_import_date
  ON public.google_history_imports (import_date DESC);

CREATE TRIGGER trg_google_history_imports_updated_at
  BEFORE UPDATE ON public.google_history_imports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 4. google_history_items
--    Item aktivitas Google History per import.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.google_history_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  import_id       uuid NOT NULL REFERENCES public.google_history_imports(id) ON DELETE CASCADE,
  activity_type   text NOT NULL DEFAULT 'other'
                    CHECK (activity_type IN ('search', 'web', 'youtube', 'maps', 'other')),
  title           text,
  url             text,
  happened_at     timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_history_items_user_id
  ON public.google_history_items (user_id);

CREATE INDEX IF NOT EXISTS idx_google_history_items_import_id
  ON public.google_history_items (import_id);

CREATE INDEX IF NOT EXISTS idx_google_history_items_activity_type
  ON public.google_history_items (activity_type);


-- ---------------------------------------------------------------------------
-- 5. Row Level Security — google_history_imports
-- ---------------------------------------------------------------------------

ALTER TABLE public.google_history_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "google_history_imports_select_own" ON public.google_history_imports
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "google_history_imports_insert_own" ON public.google_history_imports
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "google_history_imports_update_own" ON public.google_history_imports
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "google_history_imports_delete_own" ON public.google_history_imports
  FOR DELETE USING (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 6. Row Level Security — google_history_items
-- ---------------------------------------------------------------------------

ALTER TABLE public.google_history_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "google_history_items_select_own" ON public.google_history_items
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "google_history_items_insert_own" ON public.google_history_items
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "google_history_items_update_own" ON public.google_history_items
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "google_history_items_delete_own" ON public.google_history_items
  FOR DELETE USING (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
