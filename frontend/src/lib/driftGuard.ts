export interface DriftGuardScores {
  overclaim_score: number
  style_drift_score: number
  too_ai_score: number
  too_formal_score: number
  unsupported_claim_score: number
  irrelevant_context_score: number
  debug_leak_score: number
  source_leak_score: number
  final_risk_score: number
}

export interface DriftGuardResult extends DriftGuardScores {
  risk_level: 'safe' | 'warning' | 'high' | 'critical'
  triggered_rules: string[]
  actions: string[]
  blocked: boolean
  fallback_used: boolean
  warnings: string[]
  answer_after_guard: string
}

interface IdentityFactLike {
  statement?: string
  confidence_score?: number | null
}

interface LongTermMemoryLike {
  title?: string
  freshness?: string
  status?: string
  related_conflict_ids?: string[] | null
}

export function detectAiLikePhrases(answer: string): string[] {
  const normalized = normalize(answer)
  return [
    'sebagai ai',
    'ada yang bisa saya bantu',
    'saya dapat membantu',
    'semoga membantu',
    'berdasarkan data yang tersedia',
    'memory yang tersedia',
    'dari informasi yang diberikan',
  ].filter((phrase) => normalized.includes(phrase))
}

export function detectUnsupportedIdentityClaims(answer: string, identityFacts: IdentityFactLike[] = []): string[] {
  const hasEvidence = identityFacts.some((fact) => Number(fact.confidence_score ?? 0) >= 0.7 && fact.statement && normalize(answer).includes(normalize(fact.statement).slice(0, 24)))
  if (hasEvidence) return []
  return /\b(kamu|saya)\s+(adalah|selalu|pasti|tidak pernah|orang yang|paling)\b/i.test(answer) ? ['strong_identity_claim_without_evidence'] : []
}

export function detectLowConfidenceIdentityUsage(answer: string, identityFacts: IdentityFactLike[] = []): string[] {
  const normalized = normalize(answer)
  return identityFacts
    .filter((fact) => Number(fact.confidence_score ?? 0) > 0 && Number(fact.confidence_score ?? 0) < 0.7)
    .filter((fact) => fact.statement && normalized.includes(normalize(fact.statement).slice(0, 24)))
    .map((fact) => fact.statement ?? 'low_confidence_identity')
}

export function detectTooLongForIntent(answer: string, responseShape: Record<string, unknown> = {}): boolean {
  const maxSentences = Number(responseShape.max_sentences ?? 0)
  if (maxSentences > 0 && sentenceCount(answer) > maxSentences) return true
  const maxSections = Number(responseShape.max_sections ?? 0)
  if (maxSections > 0 && answer.split(/\n\s*\n/).filter(Boolean).length > maxSections) return true
  return false
}

export function detectSourceLeak(intentType: string, sources: unknown[] = []): boolean {
  return intentType === 'social_greeting' && Array.isArray(sources) && sources.length > 0
}

export function detectDebugLeak(intentType: string, debug: unknown): boolean {
  return intentType === 'social_greeting' && Boolean(debug)
}

export function detectIrrelevantPrivateContext(question: string, answer: string, memoryRefs: Array<Record<string, unknown>> = []): string[] {
  const q = normalize(question)
  const risky = ['haryati', 'pasangan', 'utang', 'keluarga', 'project', 'goal', 'diary', 'identity']
  return risky.filter((word) => normalize(answer).includes(word) && !q.includes(word) && memoryRefs.length > 0)
}

export function detectRuntimeBoundaryViolation(question: string, answer: string): string[] {
  const q = normalize(question)
  const a = normalize(answer)
  const asksAction = ['kirim email', 'push ke github', 'jalankan command', 'hapus file', 'ubah identity', 'ubah database', 'kirim telegram', 'edit file']
    .some((phrase) => q.includes(phrase))
  if (!asksAction) return []
  const claimsExecution = ['sudah saya kirim', 'sudah dikirim', 'sudah saya jalankan', 'sudah saya ubah', 'sudah saya hapus', 'sudah saya commit', 'done saya eksekusi']
    .some((phrase) => a.includes(phrase))
  return claimsExecution ? ['runtime_boundary_execution_claim'] : []
}

export function detectLongTermMemoryMisuse(answer: string, memories: LongTermMemoryLike[] = []): string[] {
  const normalized = normalize(answer)
  const issues: string[] = []
  for (const memory of memories) {
    const title = normalize(memory.title ?? '')
    const mentioned = title && normalized.includes(title.slice(0, Math.min(24, title.length)))
    if (!mentioned && !['stale', 'needs_review'].includes(memory.freshness ?? memory.status ?? '')) continue
    if (memory.freshness === 'stale' && /\b(sekarang|masih|selalu|pasti|current)\b/i.test(answer)) issues.push('stale_long_term_memory_used_as_current_fact')
    if (memory.status === 'needs_review' && /\b(pasti|jelas|memang|adalah|selalu)\b/i.test(answer)) issues.push('needs_review_long_term_memory_used_as_strong_claim')
    if (Array.isArray(memory.related_conflict_ids) && memory.related_conflict_ids.length && !/\b(di satu sisi|di sisi lain|tension|konflik|nuansa)\b/i.test(answer)) issues.push('conflict_linked_memory_without_nuance')
  }
  return [...new Set(issues)]
}

export function calculateDriftRisk(scores: Omit<DriftGuardScores, 'final_risk_score'>): number {
  const criticalMax = Math.max(scores.overclaim_score, scores.unsupported_claim_score, scores.debug_leak_score, scores.source_leak_score)
  const other = [scores.style_drift_score, scores.too_ai_score, scores.too_formal_score, scores.irrelevant_context_score]
  const avg = other.reduce((sum, value) => sum + value, 0) / other.length
  return clamp(criticalMax * 0.5 + avg * 0.5)
}

export function applyGuardActions(answer: string, guardResult: DriftGuardResult): string {
  if (guardResult.blocked || guardResult.fallback_used) return guardResult.answer_after_guard
  let next = answer
  for (const phrase of detectAiLikePhrases(next)) next = next.replace(new RegExp(escapeRegExp(phrase), 'ig'), '').replace(/\s+/g, ' ').trim()
  return next || guardResult.answer_after_guard
}

export function buildSafeFallback(intentType: string, question: string, calibrationHints: Array<Record<string, unknown>> = [], _communicationPatterns: unknown[] = []): string {
  if (intentType === 'social_greeting') {
    const preferred = calibrationHints
      .filter((hint) => hint.hint_type === 'greeting_reply')
      .flatMap((hint) => Array.isArray(hint.preferred_response) ? hint.preferred_response : [])
      .find((item) => typeof item === 'string' && item.trim())
    if (preferred) return firstSentence(String(preferred))
    if (/assalamu/i.test(question)) return 'Wa’alaikumussalam, ada apa?'
    if (/^\s*p+\s*$/i.test(question)) return 'Iya, ada apa?'
    return 'Iya, ada apa?'
  }
  if (intentType === 'identity_question') return 'Data belum cukup untuk menyimpulkan itu dengan kuat. Yang baru terlihat, jawabannya harus tetap dibatasi ke evidence yang ada.'
  if (intentType === 'strategy_question') return 'Fokus ke 1-3 prioritas yang paling terbukti dari data. Jangan bikin klaim besar kalau evidence belum cukup.'
  if (intentType === 'request_prompt') return 'Saya buatkan prompt siap paste dengan batasan jelas dan acceptance criteria, tanpa klaim identitas tambahan.'
  return 'Data belum cukup untuk menjawab itu dengan aman tanpa overclaim.'
}

function sentenceCount(value: string): number {
  return value.split(/(?<=[.!?])\s+/).filter((item) => item.trim()).length
}

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s+/)[0]?.trim() ?? value.trim()
}

function normalize(value: string): string {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))))
}
