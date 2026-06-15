-- Fase 9: Attachment & File Ingestion MVP
-- Izinkan raw_entries.source_origin = 'attachment' dan
-- brain_files.source_origin = 'obsidian_attachment' untuk import lokal dari vault.

alter table public.raw_entries
  drop constraint if exists raw_entries_source_origin_check;

alter table public.raw_entries
  add constraint raw_entries_source_origin_check
  check (source_origin in ('obsidian', 'react_input', 'upload', 'api', 'attachment'));

alter table public.brain_files
  drop constraint if exists brain_files_source_origin_check;

alter table public.brain_files
  add constraint brain_files_source_origin_check
  check (source_origin in ('obsidian', 'react_input', 'upload', 'api', 'obsidian_attachment'));
