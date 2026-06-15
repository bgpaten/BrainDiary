export type ResponseIntentType =
  | 'social_greeting'
  | 'casual_reply'
  | 'factual_question'
  | 'personal_reflection'
  | 'strategy_question'
  | 'request_prompt'
  | 'technical_instruction'
  | 'correction'
  | 'contradiction_check'
  | 'decision_help'
  | 'identity_question'
  | 'style_request'
  | 'unknown'

export type InferenceMode =
  | 'direct_social_response'
  | 'factual_brain_answer'
  | 'identity_based_answer'
  | 'communication_style_answer'
  | 'strategic_mirror_answer'
  | 'prompt_generation_answer'
  | 'correction_response'
  | 'insufficient_memory_response'

export interface ResponseShape {
  intent_type: ResponseIntentType
  max_sentences?: number
  max_sentences_before_artifact?: number
  max_sections?: number
  show_sources: boolean
  show_basis: boolean
  show_missing_context: boolean
  show_next_actions?: boolean
  tone: string
  format: 'plain_text' | 'writing_block' | 'structured_answer'
  structure?: string
}

interface IdentityFactLike {
  id: string
  fact_type?: string
  label?: string
  statement?: string
  confidence_score?: number | null
  status?: string
}

interface CommunicationPatternLike {
  id: string
  pattern_type?: string
  label?: string
  description?: string
  preferred_response_shape?: Record<string, unknown> | null
  trigger_intents?: string[] | null
  confidence_score?: number | null
}

interface OwnerCalibrationHintLike {
  id: string
  intent_type?: ResponseIntentType
  hint_type?: string
  trigger_patterns?: string[] | null
  preferred_response?: string[] | null
  avoid_response?: string[] | null
  response_shape_patch?: Partial<ResponseShape> | Record<string, unknown> | null
  confidence_score?: number | null
  status?: string
}

interface IdentityConflictLike {
  id: string
  title?: string
  summary?: string
  side_a_label?: string
  side_a_statement?: string
  side_b_label?: string
  side_b_statement?: string
  severity?: string
  recurrence?: string
  resolution_status?: string
  impact_area?: string
  chat_guidance?: Record<string, unknown> | null
}

interface LongTermMemoryLike {
  id: string
  memory_type?: string
  title?: string
  canonical_statement?: string
  summary?: string
  importance_score?: number | null
  confidence_score?: number | null
  stability?: string
  freshness?: string
  status?: string
  related_conflict_ids?: string[] | null
}

export function detectIntent(question: string): ResponseIntentType {
  const normalized = normalizeWords(question)
  if ([
    /^hi+$/,
    /^halo+$/,
    /^hai+$/,
    /^p+$/,
    /^bro+$/,
    /^ping$/,
    /^assalamu\s?alaikum/,
    /^assalamualaikum/,
    /^selamat pagi$/,
    /^selamat malam$/,
  ].some((pattern) => pattern.test(normalized))) return 'social_greeting'
  if (containsAny(normalized, ['buatkan prompt', 'prompt untuk', 'siap paste', 'buat prompt', 'revisi prompt'])) return 'request_prompt'
  if (containsAny(normalized, ['cara', 'error', 'command', 'file', 'implementasi', 'bug', 'script', 'kode', 'migration', 'supabase', 'frontend', 'backend'])) return 'technical_instruction'
  if (containsAny(normalized, ['menurutmu', 'fokus apa', 'langkah terbaik', 'lanjut apa', 'stop atau lanjut', 'prioritas', 'strategi'])) return 'strategy_question'
  if (containsAny(normalized, ['kurang', 'revisi', 'belum sesuai', 'ubah', 'salah', 'jangan begitu'])) return 'correction'
  if (containsAny(normalized, ['saya orang seperti apa', 'pola saya', 'gaya saya', 'sifat saya', 'tentang saya'])) return 'identity_question'
  if (containsAny(normalized, ['kontradiksi', 'saya bilang tapi tidak saya lakukan', 'pola buruk', 'yang saya romantisasi'])) return 'contradiction_check'
  return 'unknown'
}

export function buildResponseShape(intent: ResponseIntentType, communicationPatterns: CommunicationPatternLike[] = []): ResponseShape {
  const base = defaultResponseShape(intent)
  return communicationPatterns.reduce<ResponseShape>((shape, pattern) => {
    const preferred = pattern.preferred_response_shape
    return preferred && typeof preferred === 'object' ? { ...shape, ...preferred } : shape
  }, base)
}

export function applyCalibrationHints(shape: ResponseShape, hints: OwnerCalibrationHintLike[] = []): ResponseShape {
  return hints
    .filter((hint) => !['rejected', 'deprecated'].includes(hint.status ?? 'active'))
    .reduce<ResponseShape>((next, hint) => {
      const patch = hint.response_shape_patch
      return patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...next, ...patch } : next
    }, shape)
}

export function selectIdentityFacts(intent: ResponseIntentType, identityFacts: IdentityFactLike[] = []): IdentityFactLike[] {
  const wantedByIntent: Record<ResponseIntentType, string[]> = {
    social_greeting: ['communication_pattern'],
    casual_reply: ['communication_pattern', 'preference'],
    factual_question: ['identity_summary', 'goal', 'preference'],
    personal_reflection: ['trait', 'belief', 'value', 'emotional_pattern', 'risk_pattern', 'identity_summary'],
    strategy_question: ['goal', 'risk_pattern', 'decision_pattern', 'contradiction', 'ambition', 'value'],
    request_prompt: ['communication_pattern', 'preference', 'decision_pattern'],
    technical_instruction: ['communication_pattern', 'preference', 'decision_pattern'],
    correction: ['communication_pattern', 'preference'],
    contradiction_check: ['contradiction', 'risk_pattern', 'decision_pattern'],
    decision_help: ['goal', 'decision_pattern', 'risk_pattern', 'value'],
    identity_question: ['trait', 'belief', 'value', 'preference', 'goal', 'fear', 'ambition', 'decision_pattern', 'communication_pattern', 'emotional_pattern', 'risk_pattern', 'contradiction', 'boundary', 'identity_summary'],
    style_request: ['communication_pattern'],
    unknown: ['identity_summary', 'preference', 'goal'],
  }
  const wanted = wantedByIntent[intent] ?? wantedByIntent.unknown
  return identityFacts
    .filter((fact) => !fact.status || ['active', 'contradicted', 'needs_review'].includes(fact.status))
    .map((fact) => ({ fact, score: (wanted.includes(fact.fact_type ?? '') ? 50 : 0) + Number(fact.confidence_score ?? 0.45) * 40 }))
    .filter(({ score }) => score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, intent === 'social_greeting' ? 3 : 12)
    .map(({ fact }) => fact)
}

export function selectCommunicationPatterns(intent: ResponseIntentType, communicationPatterns: CommunicationPatternLike[] = []): CommunicationPatternLike[] {
  return communicationPatterns
    .map((pattern) => {
      const triggers = Array.isArray(pattern.trigger_intents) ? pattern.trigger_intents : []
      let score = Number(pattern.confidence_score ?? 0.45) * 40
      if (triggers.includes(intent)) score += 50
      if (intent === 'social_greeting' && pattern.pattern_type === 'greeting_style') score += 80
      if (intent === 'request_prompt' && pattern.pattern_type === 'prompt_request_style') score += 80
      if (intent === 'technical_instruction' && pattern.pattern_type === 'technical_style') score += 70
      if (intent === 'strategy_question' && pattern.pattern_type === 'decision_style') score += 60
      if (intent === 'correction' && pattern.pattern_type === 'correction_style') score += 70
      return { pattern, score }
    })
    .filter(({ score }) => score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, intent === 'social_greeting' ? 2 : 8)
    .map(({ pattern }) => pattern)
}

export function selectCalibrationHints(intent: ResponseIntentType, question: string, hints: OwnerCalibrationHintLike[] = []): OwnerCalibrationHintLike[] {
  const normalized = normalizeWords(question)
  return hints
    .filter((hint) => (hint.intent_type === intent || hint.intent_type === 'unknown') && !['rejected', 'deprecated'].includes(hint.status ?? 'active'))
    .map((hint) => {
      const triggers = Array.isArray(hint.trigger_patterns) ? hint.trigger_patterns : []
      let score = Number(hint.confidence_score ?? 0.45) * 60
      if (hint.intent_type === intent) score += 30
      if (triggers.some((trigger) => normalized.includes(normalizeWords(trigger)) || normalizeWords(trigger).includes(normalized))) score += 60
      if (intent === 'social_greeting' && hint.hint_type === 'greeting_reply') score += 40
      if (intent === 'request_prompt' && hint.hint_type === 'prompt_structure') score += 40
      return { hint, score }
    })
    .filter(({ score }) => score >= 45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ hint }) => hint)
}

export function selectIdentityConflicts(intent: ResponseIntentType, question: string, conflicts: IdentityConflictLike[] = []): IdentityConflictLike[] {
  if (['social_greeting', 'casual_reply', 'correction'].includes(intent)) return []
  const normalized = normalizeWords(question)
  return conflicts
    .filter((conflict) => !['resolved', 'dismissed'].includes(conflict.resolution_status ?? 'open'))
    .map((conflict) => {
      const haystack = normalizeWords([conflict.title, conflict.summary, conflict.side_a_statement, conflict.side_b_statement, conflict.impact_area].join(' '))
      let score = ['strategy_question', 'identity_question', 'contradiction_check'].includes(intent) ? 25 : 0
      for (const token of normalized.split(' ').filter((item) => item.length > 3)) if (haystack.includes(token)) score += 8
      if (/\b(fitur|scope|fokus|lanjut|roadmap|mvp|validasi)\b/.test(normalized) && /fitur|scope|fokus|roadmap|mvp|validasi|blueprint/.test(haystack)) score += 45
      if (/\b(kontradiksi|tension|konsisten|berlawanan)\b/.test(normalized)) score += 35
      if (conflict.severity === 'high' || conflict.severity === 'critical') score += 15
      if (conflict.recurrence === 'core_tension') score += 15
      return { conflict, score }
    })
    .filter(({ score }) => score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ conflict }) => conflict)
}

export function selectLongTermMemories(intent: ResponseIntentType, question: string, memories: LongTermMemoryLike[] = []): LongTermMemoryLike[] {
  if (['social_greeting', 'casual_reply', 'correction'].includes(intent)) return []
  const normalized = normalizeWords(question)
  return memories
    .filter((memory) => !['archived', 'deprecated', 'merged'].includes(memory.status ?? 'active'))
    .map((memory) => {
      const haystack = normalizeWords([memory.title, memory.canonical_statement, memory.summary, memory.memory_type].join(' '))
      let score = Number(memory.importance_score ?? 0.4) * 40 + Number(memory.confidence_score ?? 0.4) * 25
      if (memory.stability === 'core') score += 14
      if (memory.status === 'needs_review') score -= 18
      if (memory.freshness === 'stale') score -= 12
      for (const token of normalized.split(' ').filter((item) => item.length > 3)) if (haystack.includes(token)) score += 7
      return { memory, score }
    })
    .filter(({ score }) => score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ memory }) => memory)
}

export function shouldUseRetrieval(intent: ResponseIntentType): boolean {
  return !['social_greeting', 'casual_reply', 'correction'].includes(intent)
}

export function shouldUseRuntimeBoundary(question: string): boolean {
  const normalized = normalizeWords(question)
  return containsAny(normalized, [
    'kirim email',
    'buat event calendar',
    'push ke github',
    'jalankan command',
    'hapus file',
    'ubah identity',
    'ubah identitas',
    'ubah database',
    'update memory',
    'kirim telegram',
    'kirim whatsapp',
    'buat issue',
    'commit',
    'deploy',
    'edit file',
  ])
}

export function buildInferenceContext(input: {
  question: string
  intent: ResponseIntentType
  responseShape: ResponseShape
  identityFacts?: IdentityFactLike[]
  identityConflicts?: IdentityConflictLike[]
  communicationPatterns?: CommunicationPatternLike[]
  calibrationHints?: OwnerCalibrationHintLike[]
  memoryRefs?: unknown[]
  retrievalSummary?: Record<string, unknown>
}) {
  return {
    question: input.question,
    normalized_question: normalizeWords(input.question),
    intent_type: input.intent,
    inference_mode: inferMode(input.intent, input.memoryRefs?.length ?? 0),
    response_shape: input.responseShape,
    identity_facts: input.identityFacts ?? [],
    identity_conflicts: input.identityConflicts ?? [],
    communication_patterns: input.communicationPatterns ?? [],
    owner_calibration_hints: input.calibrationHints ?? [],
    memory_refs: input.memoryRefs ?? [],
    retrieval_summary: input.retrievalSummary ?? {},
  }
}

export function buildInferencePrompt(context: ReturnType<typeof buildInferenceContext>): string {
  return `Kamu adalah Response Inference Engine untuk Personal Entity OS.

Tugasmu bukan memberi jawaban AI terbaik.
Tugasmu adalah memprediksi jawaban yang kemungkinan besar akan diberikan oleh pemilik diary jika menerima prompt user.

Gunakan identity facts, communication patterns, memory context, response shape, dan intent type.

Aturan:
- Jangan mengarang fakta.
- Jangan membuat pemilik diary lebih hebat dari evidence.
- Jangan membuat pemilik diary lebih lemah dari evidence.
- Jangan menjawab terlalu formal jika gaya pemilik diary casual.
- Jangan menjawab terlalu panjang jika prompt ringan.
- Jangan menjawab terlalu umum seperti assistant biasa.
- Jika data kurang, gunakan fallback yang paling aman.
- Untuk sapaan ringan, jawab pendek natural.
- Untuk request prompt, buat prompt siap paste.
- Untuk strategi, jawab tajam dan praktis.
- Output harus JSON valid.

INFERENCE CONTEXT:
${JSON.stringify(context, null, 2)}`
}

export function postProcessAnswer(answer: string, intent: ResponseIntentType, responseShape: ResponseShape): string {
  let cleaned = answer.trim()
  if (intent === 'social_greeting') {
    cleaned = cleaned
      .replace(/berdasarkan diary/gi, '')
      .replace(/memory yang tersedia/gi, '')
      .replace(/identity facts/gi, '')
      .replace(/sources/gi, '')
      .replace(/context/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    return firstSentence(cleaned) || 'Halo, kenapa?'
  }
  if (responseShape.max_sentences && responseShape.max_sentences <= 2) {
    return cleaned.split(/(?<=[.!?])\s+/).slice(0, responseShape.max_sentences).join(' ')
  }
  return cleaned
}

export function calculateInferenceRisk(input: {
  intent: ResponseIntentType
  answer: string
  identityFactsUsed?: number
  communicationPatternsUsed?: number
  memoryRefsUsed?: number
}) {
  const identityClaim = /\bsaya\s+(adalah|orang|selalu|tidak pernah|pasti|suka|benci|ingin|takut)\b/i.test(input.answer)
  const overclaim = identityClaim && (input.identityFactsUsed ?? 0) === 0 ? 0.55 : input.intent === 'social_greeting' ? 0.05 : 0.18
  const underfit = /\bberdasarkan|sebagai ai|saya sarankan|langkah-langkah berikut\b/i.test(input.answer) ? 0.45 : input.communicationPatternsUsed ? 0.15 : 0.25
  const groundedness = input.intent === 'social_greeting' ? 0.75 : Math.min(0.9, 0.45 + (input.memoryRefsUsed ?? 0) * 0.04 + (input.identityFactsUsed ?? 0) * 0.03)
  return {
    confidence_score: clamp(0.75 - overclaim * 0.35 - underfit * 0.2),
    fidelity_score: clamp(0.7 - overclaim * 0.3 - underfit * 0.25),
    groundedness_score: clamp(groundedness),
    style_match_score: clamp(0.75 - underfit * 0.4),
    overclaim_risk: clamp(overclaim),
    underfit_risk: clamp(underfit),
  }
}

function defaultResponseShape(intent: ResponseIntentType): ResponseShape {
  const shapes: Record<ResponseIntentType, ResponseShape> = {
    social_greeting: { intent_type: intent, max_sentences: 1, show_sources: false, show_basis: false, show_missing_context: false, show_next_actions: false, tone: 'short_casual_direct', format: 'plain_text' },
    casual_reply: { intent_type: intent, max_sentences: 1, show_sources: false, show_basis: false, show_missing_context: false, show_next_actions: false, tone: 'short_casual_direct', format: 'plain_text' },
    request_prompt: { intent_type: intent, max_sentences_before_artifact: 2, show_sources: false, show_basis: false, show_missing_context: false, tone: 'direct_structured', format: 'writing_block', structure: 'implementation_prompt' },
    technical_instruction: { intent_type: intent, max_sections: 5, show_sources: true, show_basis: true, show_missing_context: true, tone: 'direct_technical', format: 'structured_answer' },
    strategy_question: { intent_type: intent, max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'direct_strategic', format: 'structured_answer' },
    correction: { intent_type: intent, max_sections: 3, show_sources: false, show_basis: false, show_missing_context: false, tone: 'direct_revision', format: 'plain_text' },
    identity_question: { intent_type: intent, max_sections: 3, show_sources: true, show_basis: true, show_missing_context: true, tone: 'careful_identity', format: 'structured_answer' },
    contradiction_check: { intent_type: intent, max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'evidence_based_direct', format: 'structured_answer' },
    factual_question: { intent_type: intent, max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'direct_factual', format: 'structured_answer' },
    personal_reflection: { intent_type: intent, max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'reflective_direct', format: 'structured_answer' },
    decision_help: { intent_type: intent, max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'direct_decision', format: 'structured_answer' },
    style_request: { intent_type: intent, max_sections: 3, show_sources: false, show_basis: true, show_missing_context: true, tone: 'owner_voice', format: 'plain_text' },
    unknown: { intent_type: intent, max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'normal_brain_chat', format: 'structured_answer' },
  }
  return shapes[intent]
}

function inferMode(intent: ResponseIntentType, memoryCount: number): InferenceMode {
  if (intent === 'social_greeting' || intent === 'casual_reply') return 'direct_social_response'
  if (intent === 'request_prompt') return 'prompt_generation_answer'
  if (intent === 'strategy_question' || intent === 'decision_help') return 'strategic_mirror_answer'
  if (intent === 'identity_question' || intent === 'personal_reflection' || intent === 'contradiction_check') return 'identity_based_answer'
  if (intent === 'correction') return 'correction_response'
  if (memoryCount === 0 && intent === 'unknown') return 'insufficient_memory_response'
  if (intent === 'technical_instruction') return 'communication_style_answer'
  return 'factual_brain_answer'
}

function normalizeWords(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(normalizeWords(needle)))
}

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s+/)[0]?.trim() ?? ''
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))))
}
