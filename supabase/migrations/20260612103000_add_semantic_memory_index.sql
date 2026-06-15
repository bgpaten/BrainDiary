-- Fase 10: Semantic Memory Index + Vector Search
-- Default embedding dimension: 1536 (text-embedding-3-small compatible).
-- Jika memakai dimensi lain, buat migration baru yang mengganti tipe vector.

create extension if not exists vector;

alter table public.brain_nodes
  add column if not exists embedding vector(1536),
  add column if not exists embedding_model text,
  add column if not exists embedding_provider text,
  add column if not exists embedded_at timestamptz,
  add column if not exists embedding_text_hash text;

alter table public.brain_edges
  add column if not exists embedding vector(1536),
  add column if not exists embedding_model text,
  add column if not exists embedding_provider text,
  add column if not exists embedded_at timestamptz,
  add column if not exists embedding_text_hash text;

alter table public.agent_memories
  add column if not exists embedding vector(1536),
  add column if not exists embedding_model text,
  add column if not exists embedding_provider text,
  add column if not exists embedded_at timestamptz,
  add column if not exists embedding_text_hash text;

alter table public.raw_entries
  add column if not exists embedding vector(1536),
  add column if not exists embedding_model text,
  add column if not exists embedding_provider text,
  add column if not exists embedded_at timestamptz,
  add column if not exists embedding_text_hash text;

create index if not exists idx_brain_nodes_embedding_cosine
  on public.brain_nodes using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

create index if not exists idx_brain_edges_embedding_cosine
  on public.brain_edges using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

create index if not exists idx_agent_memories_embedding_cosine
  on public.agent_memories using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

create index if not exists idx_raw_entries_embedding_cosine
  on public.raw_entries using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

create or replace function public.match_semantic_memory(
  match_user_id uuid,
  query_embedding vector(1536),
  match_count int default 10,
  match_tables text[] default array['brain_nodes', 'brain_edges', 'agent_memories', 'raw_entries']
)
returns table (
  item_type text,
  item_id uuid,
  label text,
  summary text,
  score double precision
)
language sql
stable
as $$
  select *
  from (
    select
      'brain_node'::text as item_type,
      n.id as item_id,
      n.name as label,
      coalesce(n.summary, n.description, n.canonical_name) as summary,
      (1 - (n.embedding <=> query_embedding))::double precision as score
    from public.brain_nodes n
    where n.user_id = match_user_id
      and n.embedding is not null
      and 'brain_nodes' = any(match_tables)

    union all

    select
      'brain_edge'::text as item_type,
      e.id as item_id,
      coalesce(fn.name, e.from_node_id::text) || ' -> ' || e.relation_type || ' -> ' || coalesce(tn.name, e.to_node_id::text) as label,
      e.summary,
      (1 - (e.embedding <=> query_embedding))::double precision as score
    from public.brain_edges e
    left join public.brain_nodes fn on fn.id = e.from_node_id
    left join public.brain_nodes tn on tn.id = e.to_node_id
    where e.user_id = match_user_id
      and e.embedding is not null
      and 'brain_edges' = any(match_tables)

    union all

    select
      'agent_memory'::text as item_type,
      m.id as item_id,
      m.memory_type || ' memory' as label,
      m.content as summary,
      (1 - (m.embedding <=> query_embedding))::double precision as score
    from public.agent_memories m
    where m.user_id = match_user_id
      and m.embedding is not null
      and 'agent_memories' = any(match_tables)

    union all

    select
      'raw_entry'::text as item_type,
      r.id as item_id,
      coalesce(r.title, r.obsidian_path, r.id::text) as label,
      left(coalesce(r.content, ''), 500) as summary,
      (1 - (r.embedding <=> query_embedding))::double precision as score
    from public.raw_entries r
    where r.user_id = match_user_id
      and r.embedding is not null
      and 'raw_entries' = any(match_tables)
  ) hits
  order by score desc
  limit greatest(1, least(match_count, 100));
$$;
