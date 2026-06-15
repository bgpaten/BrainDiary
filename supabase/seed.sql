-- =============================================================================
-- Personal Brain OS — Seed Data (dummy minimal)
--
-- Tujuan: mengisi node, edge, dan cluster contoh agar Brain Visualizer bisa
--         langsung membaca data tanpa harus menjalankan Brain Engine.
--
-- PENTING — GANTI user_id:
--   Seed memakai PLACEHOLDER user_id: 00000000-0000-0000-0000-000000000001
--   Saat testing dengan akun Supabase asli, cari-ganti SEMUA kemunculan
--   placeholder ini dengan user id asli dari auth.users
--   (di SQL Editor: select auth.uid(); saat login, atau lihat Authentication > Users).
--
-- IDEMPOTENT / AMAN DIJALANKAN ULANG:
--   STEP 0 di bawah menghapus baris seed lama berdasarkan id tetap sebelum
--   meng-insert ulang. Menghapus brain_nodes otomatis menghapus brain_edges
--   terkait (ON DELETE CASCADE), jadi tidak akan ada error duplicate key —
--   termasuk kalau sebelumnya seed dijalankan dengan user_id yang berbeda.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 0 — Bersihkan baris seed lama (berdasarkan id tetap, lintas user).
--          Urutan: edges -> nodes -> clusters. (Hapus nodes sebenarnya sudah
--          meng-cascade edges; delete edges di sini hanya untuk kejelasan.)
-- ---------------------------------------------------------------------------
delete from public.brain_edges
where from_node_id in (
        'a0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000003',
        'a0000000-0000-0000-0000-000000000004',
        'a0000000-0000-0000-0000-000000000005',
        'a0000000-0000-0000-0000-000000000006',
        'a0000000-0000-0000-0000-000000000007',
        'a0000000-0000-0000-0000-000000000008',
        'a0000000-0000-0000-0000-000000000009'
      )
   or to_node_id in (
        'a0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000003',
        'a0000000-0000-0000-0000-000000000004',
        'a0000000-0000-0000-0000-000000000005',
        'a0000000-0000-0000-0000-000000000006',
        'a0000000-0000-0000-0000-000000000007',
        'a0000000-0000-0000-0000-000000000008',
        'a0000000-0000-0000-0000-000000000009'
      );

delete from public.brain_nodes
where id in (
        'a0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000003',
        'a0000000-0000-0000-0000-000000000004',
        'a0000000-0000-0000-0000-000000000005',
        'a0000000-0000-0000-0000-000000000006',
        'a0000000-0000-0000-0000-000000000007',
        'a0000000-0000-0000-0000-000000000008',
        'a0000000-0000-0000-0000-000000000009'
      );

delete from public.brain_clusters
where id in (
        'c0000000-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-000000000002',
        'c0000000-0000-0000-0000-000000000003'
      );

-- ---------------------------------------------------------------------------
-- STEP 1 — Clusters
-- ---------------------------------------------------------------------------
insert into public.brain_clusters (id, user_id, name, slug, description, color_key, priority)
values
  ('c0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
    'Personal Brain OS', 'personal-brain-os', 'Project utama membangun otak kedua.', 'indigo', 100),
  ('c0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
    'NusaOps', 'nusaops', 'Cluster terkait NusaOps.', 'emerald', 80),
  ('c0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
    'Career', 'career', 'Karier, pekerjaan, dan pengembangan profesional.', 'amber', 60);

-- ---------------------------------------------------------------------------
-- STEP 2 — Nodes
-- ---------------------------------------------------------------------------
insert into public.brain_nodes
  (id, user_id, type, name, canonical_name, aliases, summary, cluster_id, importance_score, frequency_score, confidence_score)
values
  -- person
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
    'person', 'Ahyar', 'ahyar', '{}', 'Pemilik brain ini.',
    'c0000000-0000-0000-0000-000000000001', 100, 40, 1),

  -- project: Personal Brain OS
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
    'project', 'Personal Brain OS', 'personalbrainos', '{"Brain OS","Personal Brain"}',
    'Sistem otak kedua berbasis diary.',
    'c0000000-0000-0000-0000-000000000001', 95, 30, 1),

  -- project: NusaOps
  ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
    'project', 'NusaOps', 'nusaops', '{"Nusa Ops","nusaops"}',
    'Project NusaOps.',
    'c0000000-0000-0000-0000-000000000002', 70, 18, 1),

  -- tool: Obsidian
  ('a0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
    'tool', 'Obsidian', 'obsidian', '{}', 'Raw brain vault (Markdown).',
    'c0000000-0000-0000-0000-000000000001', 60, 14, 1),

  -- tool: Supabase
  ('a0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001',
    'tool', 'Supabase', 'supabase', '{}', 'Structured brain database.',
    'c0000000-0000-0000-0000-000000000001', 60, 14, 1),

  -- tool/topic: Brain Engine
  ('a0000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001',
    'tool', 'Brain Engine', 'brainengine', '{}', 'Service ekstraksi diary -> node/edge.',
    'c0000000-0000-0000-0000-000000000001', 65, 10, 1),

  -- tool/topic: Brain Visualizer
  ('a0000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001',
    'tool', 'Brain Visualizer', 'brainvisualizer', '{}', 'Frontend peta otak (React).',
    'c0000000-0000-0000-0000-000000000001', 65, 10, 1),

  -- pattern: Terlalu Banyak Planning
  ('a0000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001',
    'pattern', 'Terlalu Banyak Planning', 'terlalubanyakplanning', '{}',
    'Kebiasaan over-planning, eksekusi minim.',
    'c0000000-0000-0000-0000-000000000001', 50, 8, 0.8),

  -- goal: Membuat MVP Personal Brain OS
  ('a0000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001',
    'goal', 'Membuat MVP Personal Brain OS', 'membuatmvppersonalbrainos', '{"MVP Personal Brain OS"}',
    'Target jangka pendek: MVP yang jalan.',
    'c0000000-0000-0000-0000-000000000001', 90, 20, 1);

-- ---------------------------------------------------------------------------
-- STEP 3 — Edges
-- ---------------------------------------------------------------------------
insert into public.brain_edges
  (user_id, from_node_id, to_node_id, relation_type, summary, weight, confidence_score)
values
  -- Ahyar works_on Personal Brain OS
  ('00000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
    'works_on', 'Ahyar mengerjakan Personal Brain OS.', 2, 1),

  -- Personal Brain OS uses Obsidian
  ('00000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000004',
    'uses', 'Memakai Obsidian sebagai raw vault.', 1, 1),

  -- Personal Brain OS uses Supabase
  ('00000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000005',
    'uses', 'Memakai Supabase sebagai structured brain.', 1, 1),

  -- Personal Brain OS related_to Brain Engine
  ('00000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000006',
    'related_to', 'Brain Engine bagian dari sistem.', 1, 1),

  -- Personal Brain OS related_to Brain Visualizer
  ('00000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000007',
    'related_to', 'Brain Visualizer bagian dari sistem.', 1, 1),

  -- Ahyar has_pattern Terlalu Banyak Planning
  ('00000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000008',
    'has_pattern', 'Ahyar punya pola over-planning.', 1, 1),

  -- Personal Brain OS wants_to_achieve Membuat MVP Personal Brain OS
  ('00000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000009',
    'wants_to_achieve', 'Target: membuat MVP.', 2, 1);

-- =============================================================================
-- End of seed
-- =============================================================================
