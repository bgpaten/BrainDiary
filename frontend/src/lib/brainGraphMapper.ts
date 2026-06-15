import type { ElementDefinition } from 'cytoscape'
import type { BrainCluster, BrainEdge, BrainNode, NodeType } from '../types/brain'
import { getReviewStatus } from './brainQuality'

// ---------------------------------------------------------------------------
// Palet warna untuk color_key cluster (lihat brain_clusters.color_key).
// ---------------------------------------------------------------------------
const COLOR_KEY_PALETTE: Record<string, string> = {
  indigo: '#3730a3',
  emerald: '#047857',
  amber: '#92400e',
  rose: '#9f1239',
  sky: '#075985',
  violet: '#5b21b6',
  teal: '#0f766e',
  orange: '#9a3412',
}

// Warna fallback berdasarkan type node bila cluster tidak punya warna.
const TYPE_COLOR: Record<NodeType, string> = {
  person: '#1d4ed8',
  project: '#6d28d9',
  tool: '#047857',
  topic: '#0e7490',
  pattern: '#be123c',
  goal: '#854d0e',
  organization: '#9d174d',
  place: '#166534',
  event: '#a16207',
  decision: '#7e22ce',
  emotion: '#9f1239',
  document: '#334155',
}

const DEFAULT_COLOR = '#1e293b'

// ---------------------------------------------------------------------------
// Helper skala
// ---------------------------------------------------------------------------
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// Ukuran node berdasarkan frequency_score (node sering muncul → lebih besar).
function nodeSize(frequency: number | null): number {
  const f = frequency ?? 0
  // base 28px, +1.4px per poin frekuensi, dibatasi 28..110.
  return clamp(28 + f * 1.4, 28, 110)
}

// Border lebih tebal untuk node penting (importance_score tinggi → menonjol).
function nodeBorderWidth(importance: number | null): number {
  const i = importance ?? 0
  return clamp(1 + i / 25, 1, 6)
}

// Confidence rendah → node lebih redup (opacity turun).
function nodeOpacity(confidence: number | null): number {
  const c = confidence ?? 1
  // confidence 0..1 → opacity 0.35..1
  return clamp(0.35 + c * 0.65, 0.35, 1)
}

function edgeWidth(weight: number | null): number {
  const w = weight ?? 1
  return clamp(1 + w * 1.2, 1, 8)
}

function clusterColorMap(clusters: BrainCluster[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const c of clusters) {
    if (c.color_key && COLOR_KEY_PALETTE[c.color_key]) {
      map[c.id] = COLOR_KEY_PALETTE[c.color_key]
    }
  }
  return map
}

export interface GraphFilters {
  // Set kosong = semua type ditampilkan.
  types: Set<NodeType>
  // null = semua cluster.
  clusterId: string | null
}

// ---------------------------------------------------------------------------
// Bentuk elemen Cytoscape dari brain_nodes + brain_edges (+ cluster utk warna).
// Mengembalikan node yang lolos filter dan hanya edge yang KEDUA ujungnya lolos.
// ---------------------------------------------------------------------------
export function buildGraphElements(
  nodes: BrainNode[],
  edges: BrainEdge[],
  clusters: BrainCluster[],
  filters: GraphFilters,
): ElementDefinition[] {
  const colorByCluster = clusterColorMap(clusters)

  const filteredNodes = nodes.filter((n) => {
    const typeOk = filters.types.size === 0 || filters.types.has(n.type)
    const clusterOk = filters.clusterId === null || n.cluster_id === filters.clusterId
    return typeOk && clusterOk
  })

  const visibleIds = new Set(filteredNodes.map((n) => n.id))

  const nodeElements: ElementDefinition[] = filteredNodes.map((n) => {
    const color =
      (n.cluster_id && colorByCluster[n.cluster_id]) || TYPE_COLOR[n.type] || DEFAULT_COLOR
    const lowConfidence = (n.confidence_score ?? 1) < 0.7
    const pendingReview = getReviewStatus(n) === 'pending_review'
    return {
      data: {
        id: n.id,
        label: n.name,
        type: n.type,
        color,
        size: nodeSize(n.frequency_score),
        fontSize: clamp(9 + nodeSize(n.frequency_score) / 12, 9, 18),
        borderWidth: nodeBorderWidth(n.importance_score),
        opacity: nodeOpacity(n.confidence_score),
        // tanda khusus untuk confidence rendah (dipakai di stylesheet).
        lowConfidence: lowConfidence ? 1 : 0,
        pendingReview: pendingReview ? 1 : 0,
      },
    }
  })

  const edgeElements: ElementDefinition[] = edges
    .filter((e) => visibleIds.has(e.from_node_id) && visibleIds.has(e.to_node_id))
    .map((e) => ({
      data: {
        id: e.id,
        source: e.from_node_id,
        target: e.to_node_id,
        label: e.relation_type,
        width: edgeWidth(e.weight),
        // edge yang sudah invalid (invalid_at terisi) digambar putus-putus.
        invalid: e.invalid_at ? 1 : 0,
      },
    }))

  return [...nodeElements, ...edgeElements]
}

// Hitung relasi masuk/keluar untuk satu node (dipakai detail panel).
export function relationsForNode(nodeId: string, edges: BrainEdge[]) {
  const outgoing = edges.filter((e) => e.from_node_id === nodeId)
  const incoming = edges.filter((e) => e.to_node_id === nodeId)
  return { incoming, outgoing }
}
