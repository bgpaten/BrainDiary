-- =============================================================================
-- Personal Entity OS — Chat Sample Importer
-- Step 25: imported chat messages as owner communication evidence
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists public.chat_imports (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  source_file         text not null,
  source_hash         text not null,
  source_format       text not null default 'unknown'
                        check (source_format in ('txt', 'md', 'json', 'csv', 'whatsapp_txt', 'unknown')),
  owner_aliases       jsonb not null default '[]'::jsonb,
  status              text not null default 'pending'
                        check (status in ('pending', 'done', 'failed', 'skipped', 'needs_review')),
  total_messages      integer not null default 0,
  owner_messages      integer not null default 0,
  other_messages      integer not null default 0,
  conversation_count  integer not null default 0,
  imported_at         timestamptz,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  chat_import_id      uuid not null references public.chat_imports(id) on delete cascade,
  conversation_key    text not null,
  message_index       integer not null,
  timestamp           timestamptz,
  speaker             text,
  speaker_role        text not null default 'unknown'
                        check (speaker_role in ('owner', 'other', 'system', 'unknown')),
  text                text not null,
  normalized_text     text not null,
  language            text not null default 'id',
  intent_type         text not null default 'unknown'
                        check (intent_type in (
                          'greeting',
                          'casual_reply',
                          'request_prompt',
                          'technical_instruction',
                          'strategy_question',
                          'correction',
                          'decision',
                          'reflection',
                          'complaint',
                          'follow_up',
                          'unknown'
                        )),
  tone                text not null default 'neutral'
                        check (tone in ('direct', 'casual', 'formal', 'firm', 'technical', 'reflective', 'neutral', 'mixed')),
  formality           text not null default 'neutral'
                        check (formality in ('very_casual', 'casual', 'neutral', 'formal')),
  length_class        text not null default 'short'
                        check (length_class in ('very_short', 'short', 'medium', 'long')),
  is_owner_message    boolean not null default false,
  reply_to_message_id uuid references public.chat_messages(id) on delete set null,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (chat_import_id, conversation_key, message_index)
);

create table if not exists public.chat_reply_pairs (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null,
  chat_import_id           uuid not null references public.chat_imports(id) on delete cascade,
  conversation_key         text not null,
  prompt_message_id        uuid not null references public.chat_messages(id) on delete cascade,
  owner_reply_message_id   uuid not null references public.chat_messages(id) on delete cascade,
  prompt_text              text not null,
  owner_reply_text         text not null,
  intent_type              text not null default 'unknown'
                             check (intent_type in (
                               'greeting',
                               'casual_reply',
                               'request_prompt',
                               'technical_instruction',
                               'strategy_question',
                               'correction',
                               'decision',
                               'reflection',
                               'complaint',
                               'follow_up',
                               'unknown'
                             )),
  answer_style             text not null default 'neutral'
                             check (answer_style in (
                               'short_direct',
                               'casual_direct',
                               'technical_step_by_step',
                               'prompt_ready',
                               'strategic_direct',
                               'reflective',
                               'corrective',
                               'neutral'
                             )),
  confidence_score         numeric(5,4) not null default 0.70
                             check (confidence_score >= 0 and confidence_score <= 1),
  used_for_calibration     boolean not null default false,
  owner_answer_example_id  uuid,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (prompt_message_id, owner_reply_message_id)
);

create table if not exists public.chat_import_reviews (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  chat_import_id  uuid references public.chat_imports(id) on delete cascade,
  review_type     text not null
                    check (review_type in (
                      'unknown_speaker',
                      'low_confidence_owner_detection',
                      'unsupported_format',
                      'possible_sensitive_content',
                      'duplicate_import',
                      'parse_error'
                    )),
  label           text not null,
  description     text not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending'
                    check (status in ('pending', 'resolved', 'ignored', 'failed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_chat_imports_user_id             on public.chat_imports (user_id);
create index if not exists idx_chat_imports_source_hash         on public.chat_imports (source_hash);
create index if not exists idx_chat_imports_created_at          on public.chat_imports (created_at);

create index if not exists idx_chat_messages_user_id            on public.chat_messages (user_id);
create index if not exists idx_chat_messages_chat_import_id     on public.chat_messages (chat_import_id);
create index if not exists idx_chat_messages_conversation_key   on public.chat_messages (conversation_key);
create index if not exists idx_chat_messages_speaker_role       on public.chat_messages (speaker_role);
create index if not exists idx_chat_messages_is_owner_message   on public.chat_messages (is_owner_message);
create index if not exists idx_chat_messages_intent_type        on public.chat_messages (intent_type);
create index if not exists idx_chat_messages_created_at         on public.chat_messages (created_at);

create index if not exists idx_chat_reply_pairs_user_id              on public.chat_reply_pairs (user_id);
create index if not exists idx_chat_reply_pairs_chat_import_id       on public.chat_reply_pairs (chat_import_id);
create index if not exists idx_chat_reply_pairs_conversation_key     on public.chat_reply_pairs (conversation_key);
create index if not exists idx_chat_reply_pairs_intent_type          on public.chat_reply_pairs (intent_type);
create index if not exists idx_chat_reply_pairs_used_for_calibration on public.chat_reply_pairs (used_for_calibration);
create index if not exists idx_chat_reply_pairs_created_at           on public.chat_reply_pairs (created_at);

create index if not exists idx_chat_import_reviews_user_id         on public.chat_import_reviews (user_id);
create index if not exists idx_chat_import_reviews_chat_import_id  on public.chat_import_reviews (chat_import_id);
create index if not exists idx_chat_import_reviews_created_at      on public.chat_import_reviews (created_at);

drop trigger if exists trg_chat_imports_updated_at on public.chat_imports;
create trigger trg_chat_imports_updated_at
  before update on public.chat_imports
  for each row execute function public.set_updated_at();

drop trigger if exists trg_chat_messages_updated_at on public.chat_messages;
create trigger trg_chat_messages_updated_at
  before update on public.chat_messages
  for each row execute function public.set_updated_at();

drop trigger if exists trg_chat_reply_pairs_updated_at on public.chat_reply_pairs;
create trigger trg_chat_reply_pairs_updated_at
  before update on public.chat_reply_pairs
  for each row execute function public.set_updated_at();

drop trigger if exists trg_chat_import_reviews_updated_at on public.chat_import_reviews;
create trigger trg_chat_import_reviews_updated_at
  before update on public.chat_import_reviews
  for each row execute function public.set_updated_at();

alter table public.chat_imports enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_reply_pairs enable row level security;
alter table public.chat_import_reviews enable row level security;

drop policy if exists "chat_imports_select_own" on public.chat_imports;
create policy "chat_imports_select_own" on public.chat_imports for select using (auth.uid() = user_id);
drop policy if exists "chat_imports_insert_own" on public.chat_imports;
create policy "chat_imports_insert_own" on public.chat_imports for insert with check (auth.uid() = user_id);
drop policy if exists "chat_imports_update_own" on public.chat_imports;
create policy "chat_imports_update_own" on public.chat_imports for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "chat_imports_delete_own" on public.chat_imports;
create policy "chat_imports_delete_own" on public.chat_imports for delete using (auth.uid() = user_id);

drop policy if exists "chat_messages_select_own" on public.chat_messages;
create policy "chat_messages_select_own" on public.chat_messages for select using (auth.uid() = user_id);
drop policy if exists "chat_messages_insert_own" on public.chat_messages;
create policy "chat_messages_insert_own" on public.chat_messages for insert with check (auth.uid() = user_id);
drop policy if exists "chat_messages_update_own" on public.chat_messages;
create policy "chat_messages_update_own" on public.chat_messages for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "chat_messages_delete_own" on public.chat_messages;
create policy "chat_messages_delete_own" on public.chat_messages for delete using (auth.uid() = user_id);

drop policy if exists "chat_reply_pairs_select_own" on public.chat_reply_pairs;
create policy "chat_reply_pairs_select_own" on public.chat_reply_pairs for select using (auth.uid() = user_id);
drop policy if exists "chat_reply_pairs_insert_own" on public.chat_reply_pairs;
create policy "chat_reply_pairs_insert_own" on public.chat_reply_pairs for insert with check (auth.uid() = user_id);
drop policy if exists "chat_reply_pairs_update_own" on public.chat_reply_pairs;
create policy "chat_reply_pairs_update_own" on public.chat_reply_pairs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "chat_reply_pairs_delete_own" on public.chat_reply_pairs;
create policy "chat_reply_pairs_delete_own" on public.chat_reply_pairs for delete using (auth.uid() = user_id);

drop policy if exists "chat_import_reviews_select_own" on public.chat_import_reviews;
create policy "chat_import_reviews_select_own" on public.chat_import_reviews for select using (auth.uid() = user_id);
drop policy if exists "chat_import_reviews_insert_own" on public.chat_import_reviews;
create policy "chat_import_reviews_insert_own" on public.chat_import_reviews for insert with check (auth.uid() = user_id);
drop policy if exists "chat_import_reviews_update_own" on public.chat_import_reviews;
create policy "chat_import_reviews_update_own" on public.chat_import_reviews for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "chat_import_reviews_delete_own" on public.chat_import_reviews;
create policy "chat_import_reviews_delete_own" on public.chat_import_reviews for delete using (auth.uid() = user_id);

-- =============================================================================
-- End of migration
-- =============================================================================
