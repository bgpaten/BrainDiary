// =============================================================================
// Brain Engine — schema, prompt, dan validasi output LLM.
// =============================================================================

export const NODE_TYPES = [
  'person', 'place', 'event', 'project', 'decision', 'emotion',
  'goal', 'pattern', 'organization', 'topic', 'tool', 'document',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const RELATION_TYPES = [
  'works_on', 'related_to', 'met_with', 'mentioned', 'happened_at',
  'happened_in', 'decided', 'caused', 'feels_about', 'has_pattern',
  'wants_to_achieve', 'uses', 'belongs_to_cluster', 'blocked_by',
  'needs_validation',
] as const
export type RelationType = (typeof RELATION_TYPES)[number]

const MEMORY_TYPES = ['preference', 'identity', 'decision', 'lesson', 'warning', 'goal', 'pattern', 'context']
const IMPORTANCE_LEVELS = ['low', 'normal', 'important', 'core']
const STABILITY_LEVELS = ['temporary', 'normal', 'stable', 'core']
const SENSITIVITY_LEVELS = ['public', 'private', 'sensitive']

// ---------------------------------------------------------------------------
// Tool yang dipaksa dipanggil LLM (structured output via tool_choice).
// input_schema sengaja permisif; validasi ketat dilakukan di validateExtraction().
// ---------------------------------------------------------------------------
export const BRAIN_TOOL = {
  name: 'emit_brain_graph',
  description:
    'Mengembalikan node, edge, dan agent_memories hasil ekstraksi dari diary. ' +
    'WAJIB memanggil tool ini sekali dengan seluruh hasil ekstraksi.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            type: { type: 'string', enum: NODE_TYPES as unknown as string[] },
            name: { type: 'string' },
            canonical_name: { type: 'string' },
            aliases: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
            description: { type: 'string' },
            importance_score: { type: 'number' },
            confidence_score: { type: 'number' },
            cluster_slug: { type: 'string' },
            metadata: { type: 'object', additionalProperties: true },
          },
          required: ['type', 'name', 'canonical_name', 'confidence_score'],
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            from: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: NODE_TYPES as unknown as string[] },
                canonical_name: { type: 'string' },
              },
              required: ['type', 'canonical_name'],
            },
            to: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: NODE_TYPES as unknown as string[] },
                canonical_name: { type: 'string' },
              },
              required: ['type', 'canonical_name'],
            },
            relation_type: { type: 'string', enum: RELATION_TYPES as unknown as string[] },
            summary: { type: 'string' },
            weight: { type: 'number' },
            confidence_score: { type: 'number' },
            metadata: { type: 'object', additionalProperties: true },
          },
          required: ['from', 'to', 'relation_type', 'confidence_score'],
        },
      },
      agent_memories: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            memory_type: { type: 'string', enum: MEMORY_TYPES },
            content: { type: 'string' },
            importance_level: { type: 'string', enum: IMPORTANCE_LEVELS },
            stability: { type: 'string', enum: STABILITY_LEVELS },
            sensitivity: { type: 'string', enum: SENSITIVITY_LEVELS },
          },
          required: ['memory_type', 'content', 'importance_level'],
        },
      },
    },
    required: ['nodes', 'edges'],
  },
}

export const SYSTEM_PROMPT = `Kamu adalah Brain Engine untuk sistem "Personal Brain OS".
Tugasmu: membaca satu catatan diary mentah lalu mengekstrak NODE (entitas) dan EDGE (relasi) yang BENAR-BENAR ada di teks, dan memanggil tool emit_brain_graph dengan hasilnya.

ATURAN WAJIB:
- Jangan mengarang fakta. Jangan membuat node/edge tanpa bukti dari teks diary.
- Tipe node yang boleh: person, place, event, project, decision, emotion, goal, pattern, organization, topic, tool, document.
- Tipe relasi yang boleh: works_on, related_to, met_with, mentioned, happened_at, happened_in, decided, caused, feels_about, has_pattern, wants_to_achieve, uses, belongs_to_cluster, blocked_by, needs_validation.
- Bedakan dengan tegas:
  - event = sesuatu yang TERJADI.
  - decision = PILIHAN yang diambil.
  - goal = sesuatu yang INGIN dicapai di masa depan.
  - pattern = pola/kebiasaan/masalah yang BERULANG atau insight.
- canonical_name: bentuk kanonik & konsisten untuk mencegah duplikasi. Contoh: "NusaOps", "Nusa Ops", "nusaops" semuanya canonical_name "NusaOps". Gunakan ejaan yang rapi (boleh berspasi); sistem menormalkannya.
- SETIAP node & edge punya confidence_score (0..1). Jika nama/entitas tidak jelas, beri confidence rendah.
- SETIAP node punya importance_score (0..1) — seberapa penting entitas itu bagi pemilik diary.
- SETIAP edge punya weight (>= 0, biasanya 1).
- PENTING: setiap entitas yang dipakai sebagai from/to pada edge HARUS juga ada di array nodes (dengan type & canonical_name yang sama persis).
- cluster_slug opsional. Cluster yang sudah ada: "personal-brain-os", "nusaops", "career". Jika tidak yakin, kosongkan (jangan mengarang cluster baru).
- agent_memories opsional: ringkasan penting tentang pemilik (preferensi, identitas, keputusan, pelajaran, peringatan, goal, pola, konteks). Fokus pada yang importance_level "important" atau "core".
- Jika tidak ada yang bisa diekstrak, kembalikan nodes & edges array kosong. Jangan memaksakan data.
- Tulis summary/description ringkas dalam Bahasa Indonesia.

Panggil tool emit_brain_graph TEPAT SATU KALI.`

// ---------------------------------------------------------------------------
// Normalisasi & validasi
// ---------------------------------------------------------------------------
export function canonicalize(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
}

export function nodeKey(type: string, canonical: string): string {
  return `${type}::${canonicalize(canonical)}`
}

function clamp(n: number, min: number, max: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return min
  return Math.max(min, Math.min(max, n))
}

// importance: LLM kirim 0..1 -> simpan 0..100 (selaras seed & visualizer).
function scaleImportance(v: unknown): number {
  const n = typeof v === 'number' ? v : 0.5
  const scaled = n <= 1 ? n * 100 : n
  return Math.round(clamp(scaled, 0, 100) * 100) / 100
}
// confidence: simpan 0..1.
function scaleConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : 0.6
  const c = n > 1 ? n / 100 : n
  return Math.round(clamp(c, 0, 1) * 100) / 100
}
function scaleWeight(v: unknown): number {
  const n = typeof v === 'number' ? v : 1
  return Math.round(clamp(n, 0, 10) * 100) / 100
}

export interface CleanNode {
  type: NodeType
  name: string
  canonical_name: string
  aliases: string[]
  summary: string | null
  description: string | null
  importance_score: number
  confidence_score: number
  cluster_slug: string | null
  metadata: Record<string, unknown>
}
export interface CleanEdge {
  from: { type: string; canonical_name: string }
  to: { type: string; canonical_name: string }
  relation_type: string
  summary: string | null
  weight: number
  confidence_score: number
  metadata: Record<string, unknown>
}
export interface CleanMemory {
  memory_type: string
  content: string
  importance_level: string
  stability: string
  sensitivity: string
}
export interface CleanExtraction {
  nodes: CleanNode[]
  edges: CleanEdge[]
  agent_memories: CleanMemory[]
}

// Membersihkan & memvalidasi output LLM. Membuang item yang tidak valid,
// TIDAK menebak data. Throw hanya jika bentuk dasarnya bukan objek sama sekali.
export function validateExtraction(raw: unknown): CleanExtraction {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Output LLM bukan objek JSON yang valid.')
  }
  const obj = raw as Record<string, unknown>
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : []
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : []
  const rawMems = Array.isArray(obj.agent_memories) ? obj.agent_memories : []

  const nodes: CleanNode[] = []
  for (const item of rawNodes) {
    if (!item || typeof item !== 'object') continue
    const n = item as Record<string, unknown>
    const type = String(n.type ?? '')
    const name = String(n.name ?? '').trim()
    if (!NODE_TYPES.includes(type as NodeType)) continue
    if (!name) continue
    const canonical = String(n.canonical_name ?? name).trim() || name
    const aliases = Array.isArray(n.aliases)
      ? n.aliases.map((a) => String(a)).filter(Boolean)
      : []
    nodes.push({
      type: type as NodeType,
      name,
      canonical_name: canonical,
      aliases,
      summary: n.summary ? String(n.summary) : null,
      description: n.description ? String(n.description) : null,
      importance_score: scaleImportance(n.importance_score),
      confidence_score: scaleConfidence(n.confidence_score),
      cluster_slug: n.cluster_slug ? String(n.cluster_slug) : null,
      metadata: (n.metadata && typeof n.metadata === 'object') ? n.metadata as Record<string, unknown> : {},
    })
  }

  const nodeKeys = new Set(nodes.map((n) => nodeKey(n.type, n.canonical_name)))
  const edges: CleanEdge[] = []
  for (const item of rawEdges) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const from = e.from as Record<string, unknown> | undefined
    const to = e.to as Record<string, unknown> | undefined
    if (!from || !to) continue
    const fType = String(from.type ?? '')
    const tType = String(to.type ?? '')
    const fCanon = String(from.canonical_name ?? '').trim()
    const tCanon = String(to.canonical_name ?? '').trim()
    if (!NODE_TYPES.includes(fType as NodeType) || !NODE_TYPES.includes(tType as NodeType)) continue
    if (!fCanon || !tCanon) continue
    const rel = String(e.relation_type ?? '').trim() || 'related_to'
    if (!RELATION_TYPES.includes(rel as RelationType)) continue
    if (!nodeKeys.has(nodeKey(fType, fCanon)) || !nodeKeys.has(nodeKey(tType, tCanon))) continue
    edges.push({
      from: { type: fType, canonical_name: fCanon },
      to: { type: tType, canonical_name: tCanon },
      relation_type: rel,
      summary: e.summary ? String(e.summary) : null,
      weight: scaleWeight(e.weight),
      confidence_score: scaleConfidence(e.confidence_score),
      metadata: (e.metadata && typeof e.metadata === 'object') ? e.metadata as Record<string, unknown> : {},
    })
  }

  const agent_memories: CleanMemory[] = []
  for (const item of rawMems) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const content = String(m.content ?? '').trim()
    const mtype = String(m.memory_type ?? '')
    if (!content || !MEMORY_TYPES.includes(mtype)) continue
    const importance = IMPORTANCE_LEVELS.includes(String(m.importance_level)) ? String(m.importance_level) : 'normal'
    const stability = STABILITY_LEVELS.includes(String(m.stability)) ? String(m.stability) : 'normal'
    const sensitivity = SENSITIVITY_LEVELS.includes(String(m.sensitivity)) ? String(m.sensitivity) : 'private'
    agent_memories.push({ memory_type: mtype, content, importance_level: importance, stability, sensitivity })
  }

  return { nodes, edges, agent_memories }
}
