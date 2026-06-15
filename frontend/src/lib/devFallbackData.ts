// =============================================================================
// DEV FALLBACK DATA — BUKAN sumber kebenaran.
//
// Data ini HANYA dipakai saat VITE_USE_DEV_FALLBACK=true, untuk mengembangkan
// tampilan graph ketika Supabase belum siap / belum login.
//
// Di mode normal, graph SELALU dibaca dari Supabase (brain_nodes/edges/clusters).
// Jangan jadikan ini default. Sengaja dipisah agar tidak tercampur data asli.
// =============================================================================
import type { BrainData } from '../types/brain'

export const DEV_FALLBACK_DATA: BrainData = {
  clusters: [
    {
      id: 'dev-cluster-1',
      name: 'Personal Brain OS',
      slug: 'personal-brain-os',
      description: 'Cluster dev fallback.',
      color_key: 'indigo',
      priority: 100,
    },
  ],
  nodes: [
    {
      id: 'dev-n1',
      type: 'person',
      name: 'Ahyar (dev)',
      canonical_name: 'ahyar',
      aliases: [],
      summary: 'Node fallback dev.',
      description: null,
      importance_score: 100,
      frequency_score: 40,
      confidence_score: 1,
      cluster_id: 'dev-cluster-1',
      first_seen_at: null,
      last_seen_at: null,
      metadata: null,
    },
    {
      id: 'dev-n2',
      type: 'project',
      name: 'Personal Brain OS (dev)',
      canonical_name: 'personalbrainos',
      aliases: [],
      summary: 'Node fallback dev.',
      description: null,
      importance_score: 95,
      frequency_score: 30,
      confidence_score: 1,
      cluster_id: 'dev-cluster-1',
      first_seen_at: null,
      last_seen_at: null,
      metadata: null,
    },
    {
      id: 'dev-n3',
      type: 'tool',
      name: 'Supabase (dev)',
      canonical_name: 'supabase',
      aliases: [],
      summary: 'Node fallback dev.',
      description: null,
      importance_score: 60,
      frequency_score: 12,
      confidence_score: 0.4,
      cluster_id: 'dev-cluster-1',
      first_seen_at: null,
      last_seen_at: null,
      metadata: null,
    },
  ],
  edges: [
    {
      id: 'dev-e1',
      from_node_id: 'dev-n1',
      to_node_id: 'dev-n2',
      relation_type: 'works_on',
      summary: null,
      weight: 2,
      confidence_score: 1,
      valid_at: null,
      invalid_at: null,
      metadata: null,
    },
    {
      id: 'dev-e2',
      from_node_id: 'dev-n2',
      to_node_id: 'dev-n3',
      relation_type: 'uses',
      summary: null,
      weight: 1,
      confidence_score: 1,
      valid_at: null,
      invalid_at: null,
      metadata: null,
    },
  ],
}

export const useDevFallback = import.meta.env.VITE_USE_DEV_FALLBACK === 'true'
