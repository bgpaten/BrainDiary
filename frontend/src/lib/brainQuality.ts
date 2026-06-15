import type { BrainEdge, BrainNode } from '../types/brain'

export type ReviewStatus = 'pending_review' | 'approved' | 'ignored' | 'merged' | 'deleted'

export interface PossibleDuplicateNode {
  a: BrainNode
  b: BrainNode
  score: number
  reasons: string[]
}

export const LOW_CONFIDENCE_THRESHOLD = 0.7

export function normalizeNodeName(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

function tokenSet(value: string | null | undefined): Set<string> {
  const tokens = String(value ?? '')
    .toLowerCase()
    .trim()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return new Set(tokens)
}

function aliases(node: BrainNode): string[] {
  return Array.isArray(node.aliases) ? node.aliases.filter((v) => typeof v === 'string') : []
}

function namesFor(node: BrainNode): string[] {
  return [node.name, node.canonical_name, ...aliases(node)].filter(Boolean)
}

export function calculateSimilarityScore(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizeNodeName(left)
  const b = normalizeNodeName(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length)

  const leftTokens = tokenSet(left)
  const rightTokens = tokenSet(right)
  const union = new Set([...leftTokens, ...rightTokens])
  if (union.size === 0) return 0
  let overlap = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1
  }
  const tokenScore = overlap / union.size
  const charScore = 1 - levenshtein(a, b) / Math.max(a.length, b.length)
  return Math.max(tokenScore, charScore)
}

export function findPossibleDuplicateNodes(nodes: BrainNode[]): PossibleDuplicateNode[] {
  const results: PossibleDuplicateNode[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      if (a.type !== b.type) continue
      if (getReviewStatus(a) === 'ignored' || getReviewStatus(b) === 'ignored') continue
      if (getReviewStatus(a) === 'deleted' || getReviewStatus(b) === 'deleted') continue

      let best = 0
      const reasons = ['type sama']
      for (const left of namesFor(a)) {
        for (const right of namesFor(b)) {
          const score = calculateSimilarityScore(left, right)
          if (score > best) best = score
          if (normalizeNodeName(left) && normalizeNodeName(left) === normalizeNodeName(right)) {
            reasons.push('normalized name sama')
          }
        }
      }
      if (aliases(a).some((alias) => namesFor(b).some((name) => normalizeNodeName(alias) === normalizeNodeName(name)))) {
        reasons.push('alias cocok')
      }
      if (best >= 0.76) {
        results.push({ a, b, score: Number(best.toFixed(2)), reasons: [...new Set(reasons)] })
      }
    }
  }
  return results.sort((x, y) => y.score - x.score)
}

export function getLowConfidenceNodes(nodes: BrainNode[]): BrainNode[] {
  return nodes
    .filter((node) => (node.confidence_score ?? 1) < LOW_CONFIDENCE_THRESHOLD)
    .filter((node) => !['approved', 'ignored', 'deleted', 'merged'].includes(getReviewStatus(node)))
    .sort((a, b) => (a.confidence_score ?? 0) - (b.confidence_score ?? 0))
}

export function getLowConfidenceEdges(edges: BrainEdge[]): BrainEdge[] {
  return edges
    .filter((edge) => (edge.confidence_score ?? 1) < LOW_CONFIDENCE_THRESHOLD)
    .filter((edge) => !['approved', 'ignored', 'deleted'].includes(getReviewStatus(edge)))
    .sort((a, b) => (a.confidence_score ?? 0) - (b.confidence_score ?? 0))
}

export function getReviewStatus(item: { metadata: Record<string, unknown> | null }): ReviewStatus {
  const raw = item.metadata?.review_status
  return raw === 'approved' || raw === 'ignored' || raw === 'merged' || raw === 'deleted'
    ? raw
    : 'pending_review'
}

export function withReviewStatus(
  metadata: Record<string, unknown> | null,
  status: ReviewStatus,
  note?: string,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    review_status: status,
    reviewed_at: new Date().toISOString(),
    ...(note ? { review_note: note } : {}),
  }
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i += 1) dp[i][0] = i
  for (let j = 0; j < cols; j += 1) dp[0][j] = j
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[a.length][b.length]
}
