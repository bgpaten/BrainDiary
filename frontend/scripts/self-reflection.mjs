import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

// =============================================================================
// Self-Reflection Memory Evolution (Step 24)
// Evidence-bound reflection layer: setelah data baru masuk, apa yang berubah
// dalam pemahaman tentang pemilik diary? Menghasilkan reflection logs,
// evolution suggestions (proposal, BUKAN auto-apply), dan entity snapshots.
// =============================================================================

const AUTO_START = '<!-- SELF_REFLECTION_AUTO_START -->'
const AUTO_END = '<!-- SELF_REFLECTION_AUTO_END -->'
const REFLECTION_TYPES = new Set(['daily', 'weekly', 'manual', 'after_import', 'after_digest', 'after_calibration', 'after_similarity_eval'])
const SNAPSHOT_TYPES = new Set(['daily', 'weekly', 'manual', 'baseline'])
const TARGET_TYPES = new Set(['identity_fact', 'communication_pattern', 'owner_calibration_hint', 'response_rule', 'new_identity_fact', 'new_communication_pattern', 'new_boundary'])
const SUGGESTION_TYPES = new Set(['increase_confidence', 'decrease_confidence', 'mark_core', 'mark_recurring', 'mark_needs_review', 'mark_contradicted', 'create_new', 'soften_claim', 'add_evidence', 'add_boundary', 'deprecate'])
const SUGGESTION_STATUSES = new Set(['proposed', 'approved', 'applied', 'rejected', 'ignored'])
const REVIEW_STATUSES = new Set(['approved', 'rejected', 'ignored'])

const SYSTEM_PROMPT = `Kamu adalah Self-Reflection Engine untuk Personal Entity OS.

Tugasmu:
- Membaca data baru dan state identity/communication yang sudah ada.
- Menyimpulkan apa yang berubah dalam pemahaman tentang pemilik diary.
- Jangan mengarang sifat, value, belief, atau pola tanpa evidence.
- Jangan membuat pemilik diary terlihat lebih ideal dari data.
- Jangan membuat pemilik diary terlihat lebih buruk dari data.
- Jangan membuat entitas berkembang liar di luar pemilik diary.
- Bedakan:
  1. observasi baru
  2. pola yang makin kuat
  3. pola yang melemah
  4. kontradiksi baru
  5. implikasi untuk identity
  6. implikasi untuk komunikasi
  7. risiko fidelity
  8. ketidakpastian
- Semua saran perubahan harus berupa proposal, bukan auto-apply.
- Output harus JSON valid.`

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env.local'), { override: true })

const args = parseArgs(process.argv.slice(2))
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const provider = (process.env.SELF_REFLECTION_PROVIDER || process.env.DRIFT_CONTROL_PROVIDER || process.env.SIMILARITY_EVAL_PROVIDER || process.env.OWNER_CALIBRATION_PROVIDER || process.env.RESPONSE_INFERENCE_PROVIDER || process.env.COMMUNICATION_PROVIDER || process.env.IDENTITY_PROVIDER || process.env.BRAIN_CHAT_PROVIDER || process.env.LLM_PROVIDER || 'claude-code').toLowerCase()
const modelName = process.env.SELF_REFLECTION_MODEL || process.env.DRIFT_CONTROL_MODEL || process.env.SIMILARITY_EVAL_MODEL || process.env.OWNER_CALIBRATION_MODEL || process.env.RESPONSE_INFERENCE_MODEL || process.env.COMMUNICATION_MODEL || process.env.IDENTITY_MODEL || process.env.BRAIN_CHAT_MODEL || process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || process.env.OLLAMA_MODEL || ''
const useLlm = readBoolEnv('SELF_REFLECTION_USE_LLM', true) && readBoolEnv('SELF_REFLECTION_ENABLED', true) && provider !== 'disabled'
const outputObsidian = readBoolEnv('SELF_REFLECTION_OUTPUT_OBSIDIAN', true)
const minEvidenceForSuggestion = readIntEnv('SELF_REFLECTION_MIN_EVIDENCE_FOR_SUGGESTION', 2, 1, 10)
const limits = {
  rawEntries: readIntEnv('SELF_REFLECTION_MAX_RAW_ENTRIES', 100, 1, 500),
  identityFacts: readIntEnv('SELF_REFLECTION_MAX_IDENTITY_FACTS', 200, 1, 500),
  communicationPatterns: readIntEnv('SELF_REFLECTION_MAX_COMMUNICATION_PATTERNS', 100, 1, 300),
  reports: readIntEnv('SELF_REFLECTION_MAX_REPORTS', 20, 0, 100),
  driftLogs: readIntEnv('SELF_REFLECTION_MAX_DRIFT_LOGS', 50, 0, 200),
  similarityResults: readIntEnv('SELF_REFLECTION_MAX_SIMILARITY_RESULTS', 50, 0, 200),
}

const command = args.has('audit') ? 'audit'
  : args.has('snapshot') ? 'snapshot'
  : args.has('latest') ? 'latest'
  : args.has('suggestions') ? 'suggestions'
  : 'run'

const supabase = await createSupabaseClient()
let userId = ''

try {
  userId = await resolveUserId()
  if (command === 'audit') {
    console.log(JSON.stringify(await auditReflection(), null, 2))
  } else if (command === 'snapshot') {
    const snapshot = await createEntitySnapshot({ type: resolveSnapshotType(readOptionalArg('type')) })
    if (outputObsidian) await writeReflectionReports(await getLatest())
    console.log(JSON.stringify({ ok: true, action: 'snapshot', snapshot_id: snapshot.id, status: snapshot.status }, null, 2))
  } else if (command === 'latest') {
    console.log(JSON.stringify(await getLatest(), null, 2))
  } else if (command === 'suggestions') {
    if (args.has('update')) {
      console.log(JSON.stringify(await updateSuggestionStatus(readRequiredArg('update'), readRequiredArg('status')), null, 2))
    } else if (args.has('apply-approved')) {
      console.log(JSON.stringify(await applyApprovedSuggestions(), null, 2))
    } else {
      console.log(JSON.stringify(await listSuggestions(readOptionalArg('status')), null, 2))
    }
  } else {
    const result = await runReflection({
      type: resolveReflectionType(readOptionalArg('type')),
      from: readOptionalArg('from'),
      to: readOptionalArg('to'),
      makeSnapshot: args.has('snapshot') || readBoolArg('snapshot', false),
    })
    console.log(JSON.stringify(result, null, 2))
  }
} catch (err) {
  console.error(`[self-reflection] failed ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Core: run a reflection
// ---------------------------------------------------------------------------

async function runReflection({ type, from, to, makeSnapshot }) {
  const period = resolvePeriod(type, from, to)
  const context = await readContext(period)
  const reflection = await buildReflection(context, type, period)
  const logRow = await insertReflectionLog(reflection, type, period)
  const suggestions = await buildAndInsertSuggestions(reflection, logRow.id, context)
  let snapshot = null
  if (makeSnapshot) snapshot = await createEntitySnapshot({ type: type === 'weekly' ? 'weekly' : type === 'daily' ? 'daily' : 'manual' })
  const latest = await getLatest()
  if (outputObsidian) await writeReflectionReports(latest)
  return {
    ok: true,
    action: 'reflection',
    reflection_type: type,
    reflection_log_id: logRow.id,
    status: logRow.status,
    generated_by: reflection.generated_by,
    suggestions_created: suggestions.length,
    high_risk_suggestions: suggestions.filter((item) => Number(item.risk_score) > 0.75).length,
    snapshot_id: snapshot?.id ?? null,
    warnings: reflection.warnings,
    counts: context.counts,
  }
}

async function buildReflection(context, type, period) {
  if (useLlm) {
    try {
      const raw = await callLLM(JSON.stringify(buildReflectionPack(context, type, period), null, 2))
      const normalized = normalizeReflection(raw, 'llm')
      if (hasReflectionContent(normalized)) return normalized
      return { ...deterministicReflection(context, type), warnings: ['LLM tidak menghasilkan reflection konten valid; memakai deterministic fallback.'], generated_by: 'deterministic_fallback' }
    } catch (err) {
      return { ...deterministicReflection(context, type), warnings: [`LLM reflection gagal; memakai deterministic fallback: ${err instanceof Error ? err.message : String(err)}`], generated_by: 'deterministic_fallback' }
    }
  }
  return { ...deterministicReflection(context, type), warnings: ['SELF_REFLECTION_USE_LLM=false atau disabled; memakai deterministic fallback.'], generated_by: 'deterministic_fallback' }
}

function buildReflectionPack(context, type, period) {
  return {
    task: 'Refleksikan apa arti data baru terhadap model diri pemilik diary. Evidence-bound, jangan overclaim.',
    reflection_type: type,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    evidence_priority: [
      'diary/raw_entries asli',
      'owner answer examples dan calibration results',
      'identity facts high confidence',
      'communication patterns high confidence',
      'similarity/drift logs',
      'brain reports sebagai pendukung',
      'agent memories sebagai konteks tambahan',
    ],
    rules: {
      every_change_is_a_proposal_not_auto_apply: true,
      do_not_invent_traits_without_evidence: true,
      do_not_make_owner_more_or_less_ideal: true,
      old_reflections_are_trend_context_only: true,
      low_evidence_means_uncertainty_not_fact: true,
      new_contradictions_should_reference_identity_conflicts_when_relevant: true,
    },
    new_data: {
      raw_entries: context.rawEntries.map((entry) => ({ type: 'raw_entry', id: entry.id, label: entry.title || entry.happened_at || entry.created_at, date: entry.happened_at ?? entry.created_at, content: excerpt(entry.content, 1800) })),
      agent_memories: context.memories.slice(0, 40).map((memory) => ({ type: 'agent_memory', id: memory.id, memory_type: memory.memory_type, content: excerpt(memory.content, 700) })),
      brain_nodes: context.nodes.slice(0, 40).map((node) => ({ type: 'brain_node', id: node.id, label: node.canonical_name || node.name, node_type: node.type, summary: excerpt(node.summary || node.description, 400) })),
      brain_reports: context.reports.slice(0, 10).map((report) => ({ type: 'brain_report', id: report.id, label: report.title, summary: excerpt(report.summary, 500), repeated_patterns: report.repeated_patterns, risks: report.risks })),
      owner_calibration_results: context.calibrationResults.slice(0, 20).map((row) => ({ type: 'owner_calibration_result', id: row.id, intent: row.intent_type, score: row.similarity_score ?? row.overall_score, verdict: row.verdict })),
    },
    current_state: {
      identity_facts: context.identityFacts.slice(0, 80).map((fact) => ({ id: fact.id, fact_type: fact.fact_type, label: fact.label, statement: excerpt(fact.statement, 280), confidence_score: fact.confidence_score, stability: fact.stability, status: fact.status })),
      communication_patterns: context.communicationPatterns.slice(0, 40).map((pattern) => ({ id: pattern.id, pattern_type: pattern.pattern_type, label: pattern.label, confidence_score: pattern.confidence_score, status: pattern.status })),
      owner_calibration_hints: context.calibrationHints.slice(0, 30).map((hint) => ({ id: hint.id, intent_type: hint.intent_type, hint_type: hint.hint_type, label: hint.label, confidence_score: hint.confidence_score })),
      latest_similarity: context.latestSimilarity ? { id: context.latestSimilarity.id, verdict: context.latestSimilarity.verdict, overall_score: context.latestSimilarity.overall_score } : null,
      latest_drift_high_risk: context.driftLogs.filter((log) => Number(log.final_risk_score ?? 0) >= 0.51).slice(0, 10).map((log) => ({ id: log.id, intent: log.intent_type, risk: log.final_risk_score })),
      active_identity_conflicts: context.identityConflicts.slice(0, 30).map((conflict) => ({ id: conflict.id, title: conflict.title, conflict_type: conflict.conflict_type, severity: conflict.severity, recurrence: conflict.recurrence, resolution_status: conflict.resolution_status, summary: conflict.summary })),
      long_term_memories_trend_context: context.longTermMemories.slice(0, 30).map((memory) => ({ id: memory.id, memory_type: memory.memory_type, title: memory.title, stability: memory.stability, freshness: memory.freshness, status: memory.status, confidence_score: memory.confidence_score })),
      previous_reflections_trend_only: context.previousReflections.slice(0, 5).map((row) => ({ id: row.id, type: row.reflection_type, title: row.title, created_at: row.created_at })),
    },
    output_shape: {
      title: 'Daily Self-Reflection 2026-06-12',
      summary: 'Ringkasan singkat apa arti data baru terhadap model diri pemilik diary.',
      new_observations: [{ label: '...', description: '...', evidence_refs: [{ type: 'raw_entry', id: 'uuid', label: '...' }], confidence_score: 0.8 }],
      strengthened_patterns: [{ target_type: 'identity_fact', target_label: '...', description: '...', suggestion: 'increase_confidence', confidence_score: 0.8, evidence_refs: [] }],
      weakened_patterns: [],
      new_contradictions: [{ label: '...', description: '...', risk_score: 0.6, evidence_refs: [] }],
      identity_implications: [{ suggestion_type: 'add_boundary', label: '...', description: '...', target_type: 'new_boundary', confidence_score: 0.8, risk_score: 0.3, evidence_refs: [] }],
      communication_implications: [],
      risk_implications: [{ label: '...', description: '...', risk_score: 0.7, evidence_refs: [] }],
      uncertainties: [{ label: '...', description: '...', needed_data: ['chat samples'], confidence_score: 0.9 }],
    },
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

function deterministicReflection(context, type) {
  const newObservations = []
  const strengthened = []
  const weakened = []
  const contradictions = []
  const identityImplications = []
  const communicationImplications = []
  const riskImplications = []
  const uncertainties = []

  const recentFactIds = new Set(context.identityFacts.filter((fact) => withinDays(fact.created_at ?? fact.first_seen_at, 7)).map((fact) => fact.id))
  // New identity facts -> new observations.
  for (const fact of context.identityFacts.filter((fact) => recentFactIds.has(fact.id)).slice(0, 8)) {
    newObservations.push({
      label: fact.label,
      description: excerpt(fact.statement, 280),
      evidence_refs: asArray(fact.evidence_refs).slice(0, 3),
      confidence_score: Math.min(0.7, Number(fact.confidence_score ?? 0.5)),
    })
  }
  // Repeated patterns in brain reports -> strengthened.
  const repeatCount = new Map()
  for (const report of context.reports) {
    for (const item of asArray(report.repeated_patterns).slice(0, 6)) {
      const label = String(item?.name || item?.title || item?.summary || '').trim()
      if (!label) continue
      const entry = repeatCount.get(label) ?? { count: 0, refs: [] }
      entry.count += 1
      entry.refs.push({ type: 'brain_report', id: report.id, label: report.title })
      repeatCount.set(label, entry)
    }
  }
  for (const [label, entry] of [...repeatCount.entries()].filter(([, value]) => value.count >= 2).slice(0, 6)) {
    strengthened.push({
      target_type: 'identity_fact',
      target_label: label,
      description: `Pola "${label}" muncul berulang di beberapa report dalam periode ini.`,
      suggestion: entry.refs.length >= minEvidenceForSuggestion ? 'increase_confidence' : 'add_evidence',
      confidence_score: 0.6,
      evidence_refs: entry.refs.slice(0, 4),
    })
  }
  // Similarity drop -> risk implication.
  if (context.latestSimilarity && ['bad', 'blocked'].includes(context.latestSimilarity.verdict)) {
    riskImplications.push({
      label: 'Similarity terbaru menurun',
      description: `Verdict similarity terbaru "${context.latestSimilarity.verdict}" menandakan jawaban agent mulai menjauh dari gaya owner.`,
      risk_score: 0.7,
      evidence_refs: [{ type: 'similarity_eval_run', id: context.latestSimilarity.id, label: 'Latest similarity run' }],
    })
  }
  // High-risk drift logs -> risk implication.
  const highDrift = context.driftLogs.filter((log) => Number(log.final_risk_score ?? 0) >= 0.51)
  if (highDrift.length) {
    riskImplications.push({
      label: 'Drift risk tinggi terdeteksi',
      description: `${highDrift.length} drift log dengan risk tinggi pada periode ini (overclaim/too-AI/leak).`,
      risk_score: Math.min(0.85, 0.5 + highDrift.length * 0.05),
      evidence_refs: highDrift.slice(0, 5).map((log) => ({ type: 'drift_guard_log', id: log.id, label: log.intent_type })),
    })
  }
  // New calibration hints -> communication implication.
  for (const hint of context.calibrationHints.filter((hint) => withinDays(hint.created_at, 7)).slice(0, 6)) {
    communicationImplications.push({
      suggestion_type: 'add_evidence',
      label: hint.label || `Hint ${hint.intent_type}`,
      description: `Calibration hint baru untuk intent ${hint.intent_type}; perkuat communication pattern terkait.`,
      target_type: 'owner_calibration_hint',
      target_label: hint.label,
      confidence_score: Math.min(0.7, Number(hint.confidence_score ?? 0.5)),
      risk_score: 0.2,
      evidence_refs: [{ type: 'owner_calibration_hint', id: hint.id, label: hint.label }],
    })
  }
  // Uncertainty: communication coverage.
  if (context.communicationPatterns.filter((pattern) => Number(pattern.confidence_score ?? 0) >= 0.65).length < 3) {
    uncertainties.push({
      label: 'Gaya komunikasi spontan masih kurang data',
      description: 'Perlu lebih banyak chat samples untuk greeting, bercanda, menolak, dan merespons konflik.',
      needed_data: ['chat samples', 'owner answer examples'],
      confidence_score: 0.9,
    })
  }
  if (context.rawEntries.length === 0) {
    uncertainties.push({
      label: 'Tidak ada data baru pada periode ini',
      description: 'Tidak ada raw_entries pada periode refleksi, jadi perubahan self-model tidak bisa disimpulkan.',
      needed_data: ['diary baru'],
      confidence_score: 0.95,
    })
  }

  const summary = newObservations.length || strengthened.length || riskImplications.length
    ? `Refleksi deterministic: ${newObservations.length} observasi baru, ${strengthened.length} pola menguat, ${riskImplications.length} risiko fidelity.`
    : 'Refleksi deterministic: belum ada perubahan signifikan terhadap self-model pada periode ini.'

  return {
    title: `${capitalize(type)} Self-Reflection ${new Date().toISOString().slice(0, 10)}`,
    summary,
    new_observations: newObservations,
    strengthened_patterns: strengthened,
    weakened_patterns: weakened,
    new_contradictions: contradictions,
    identity_implications: identityImplications,
    communication_implications: communicationImplications,
    risk_implications: riskImplications,
    uncertainties,
    generated_by: 'deterministic_fallback',
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// Normalize LLM reflection
// ---------------------------------------------------------------------------

function normalizeReflection(raw, generatedBy) {
  return {
    title: String(raw?.title ?? '').trim() || `Self-Reflection ${new Date().toISOString().slice(0, 10)}`,
    summary: excerpt(String(raw?.summary ?? '').trim(), 2000),
    new_observations: normalizeItems(raw?.new_observations, ['label', 'description']),
    strengthened_patterns: normalizeItems(raw?.strengthened_patterns, ['target_label', 'description']),
    weakened_patterns: normalizeItems(raw?.weakened_patterns, ['target_label', 'description']),
    new_contradictions: normalizeItems(raw?.new_contradictions, ['label', 'description']),
    identity_implications: normalizeItems(raw?.identity_implications, ['label', 'description']),
    communication_implications: normalizeItems(raw?.communication_implications, ['label', 'description']),
    risk_implications: normalizeItems(raw?.risk_implications, ['label', 'description']),
    uncertainties: normalizeItems(raw?.uncertainties, ['label', 'description']),
    generated_by: generatedBy,
    warnings: arrayOfStrings(raw?.warnings),
  }
}

function normalizeItems(value, requiredKeys) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object' && requiredKeys.some((key) => String(item[key] ?? '').trim()))
    .slice(0, 30)
    .map((item) => ({
      ...item,
      label: String(item.label ?? item.target_label ?? '').trim() || undefined,
      target_label: item.target_label ? String(item.target_label).trim() : undefined,
      description: excerpt(String(item.description ?? '').trim(), 800),
      evidence_refs: normalizeEvidence(item.evidence_refs),
      confidence_score: item.confidence_score === undefined ? undefined : clamp(item.confidence_score),
      risk_score: item.risk_score === undefined ? undefined : clamp(item.risk_score),
    }))
}

function normalizeEvidence(value) {
  return asArray(value).filter((ref) => ref?.type && ref?.id).map((ref) => ({ type: String(ref.type), id: String(ref.id), label: String(ref.label ?? '') })).slice(0, 8)
}

function hasReflectionContent(reflection) {
  return Boolean(reflection.summary) || reflection.new_observations.length || reflection.strengthened_patterns.length || reflection.risk_implications.length || reflection.identity_implications.length
}

// ---------------------------------------------------------------------------
// Persist reflection log
// ---------------------------------------------------------------------------

async function insertReflectionLog(reflection, type, period) {
  const allEvidence = dedupeEvidence([
    ...reflection.new_observations.flatMap((item) => item.evidence_refs ?? []),
    ...reflection.strengthened_patterns.flatMap((item) => item.evidence_refs ?? []),
    ...reflection.identity_implications.flatMap((item) => item.evidence_refs ?? []),
    ...reflection.risk_implications.flatMap((item) => item.evidence_refs ?? []),
  ])
  const confidences = reflection.new_observations.map((item) => Number(item.confidence_score ?? 0)).filter((value) => value > 0)
  const confidence = confidences.length ? round4(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0
  const highRisk = reflection.risk_implications.some((item) => Number(item.risk_score ?? 0) > 0.75)
  const status = highRisk || reflection.new_contradictions.length ? 'needs_review' : 'done'
  const payload = {
    user_id: userId,
    reflection_type: type,
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
    title: reflection.title,
    summary: reflection.summary,
    new_observations: reflection.new_observations,
    strengthened_patterns: reflection.strengthened_patterns,
    weakened_patterns: reflection.weakened_patterns,
    new_contradictions: reflection.new_contradictions,
    identity_implications: reflection.identity_implications,
    communication_implications: reflection.communication_implications,
    risk_implications: reflection.risk_implications,
    uncertainties: reflection.uncertainties,
    evidence_refs: allEvidence,
    confidence_score: confidence,
    status,
    model_provider: reflection.generated_by === 'llm' ? provider : 'deterministic',
    model_name: reflection.generated_by === 'llm' ? modelName : 'deterministic-fallback',
    metadata: { generated_by: reflection.generated_by, warnings: reflection.warnings },
  }
  const { data, error } = await supabase.from('self_reflection_logs').insert(payload).select('*').single()
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Evolution suggestions (proposals only — never auto-applied)
// ---------------------------------------------------------------------------

async function buildAndInsertSuggestions(reflection, reflectionLogId, context) {
  const candidates = []
  const factByLabel = indexByLabel(context.identityFacts)
  const patternByLabel = indexByLabel(context.communicationPatterns)
  const hintById = new Map(context.calibrationHints.map((hint) => [hint.id, hint]))

  // Strengthened patterns -> increase_confidence / add_evidence.
  for (const item of reflection.strengthened_patterns) {
    const evidence = asArray(item.evidence_refs)
    let suggestionType = SUGGESTION_TYPES.has(item.suggestion) ? item.suggestion : 'increase_confidence'
    // increase_confidence hanya boleh jika evidence >= minimum.
    if (suggestionType === 'increase_confidence' && evidence.length < minEvidenceForSuggestion) suggestionType = 'add_evidence'
    if (suggestionType === 'mark_core' && evidence.length < minEvidenceForSuggestion) suggestionType = 'mark_recurring'
    const targetType = TARGET_TYPES.has(item.target_type) ? item.target_type : 'identity_fact'
    const targetId = resolveTargetId(targetType, item.target_label, factByLabel, patternByLabel)
    candidates.push(makeSuggestion({
      reflectionLogId, targetType, targetId, suggestionType,
      label: item.target_label || item.label || 'Strengthened pattern',
      description: item.description,
      evidenceRefs: evidence,
      confidence: item.confidence_score, risk: item.risk_score ?? 0.2,
    }))
  }

  // Weakened patterns -> decrease_confidence / mark_needs_review.
  for (const item of reflection.weakened_patterns) {
    const targetType = TARGET_TYPES.has(item.target_type) ? item.target_type : 'identity_fact'
    const targetId = resolveTargetId(targetType, item.target_label, factByLabel, patternByLabel)
    candidates.push(makeSuggestion({
      reflectionLogId, targetType, targetId,
      suggestionType: asArray(item.evidence_refs).length ? 'decrease_confidence' : 'mark_needs_review',
      label: item.target_label || item.label || 'Weakened pattern',
      description: item.description,
      evidenceRefs: asArray(item.evidence_refs),
      confidence: item.confidence_score, risk: item.risk_score ?? 0.3,
    }))
  }

  // New contradictions -> mark_needs_review (mark_contradicted hanya jika evidence jelas).
  for (const item of reflection.new_contradictions) {
    const evidence = asArray(item.evidence_refs)
    const targetId = resolveTargetId('identity_fact', item.label, factByLabel, patternByLabel)
    candidates.push(makeSuggestion({
      reflectionLogId, targetType: 'identity_fact', targetId,
      suggestionType: evidence.length >= minEvidenceForSuggestion && targetId ? 'mark_contradicted' : 'mark_needs_review',
      label: item.label || 'New contradiction',
      description: item.description,
      evidenceRefs: evidence,
      confidence: item.confidence_score ?? 0.5, risk: item.risk_score ?? 0.6,
    }))
  }

  // Identity implications -> as given (add_boundary, soften_claim, create_new, dst).
  for (const item of reflection.identity_implications) {
    const targetType = TARGET_TYPES.has(item.target_type) ? item.target_type : 'new_boundary'
    const suggestionType = SUGGESTION_TYPES.has(item.suggestion_type) ? item.suggestion_type : 'add_boundary'
    const targetId = resolveTargetId(targetType, item.label || item.target_label, factByLabel, patternByLabel)
    candidates.push(makeSuggestion({
      reflectionLogId, targetType, targetId, suggestionType,
      label: item.label || 'Identity implication',
      description: item.description,
      evidenceRefs: asArray(item.evidence_refs),
      confidence: item.confidence_score, risk: item.risk_score ?? 0.3,
    }))
  }

  // Communication implications -> communication_pattern / owner_calibration_hint.
  for (const item of reflection.communication_implications) {
    const targetType = TARGET_TYPES.has(item.target_type) ? item.target_type : 'communication_pattern'
    const suggestionType = SUGGESTION_TYPES.has(item.suggestion_type) ? item.suggestion_type : 'add_evidence'
    let targetId = resolveTargetId(targetType, item.label || item.target_label, factByLabel, patternByLabel)
    if (!targetId && targetType === 'owner_calibration_hint') {
      const fromRef = asArray(item.evidence_refs).find((ref) => ref.type === 'owner_calibration_hint' && hintById.has(ref.id))
      if (fromRef) targetId = fromRef.id
    }
    candidates.push(makeSuggestion({
      reflectionLogId, targetType, targetId, suggestionType,
      label: item.label || 'Communication implication',
      description: item.description,
      evidenceRefs: asArray(item.evidence_refs),
      confidence: item.confidence_score, risk: item.risk_score ?? 0.2,
    }))
  }

  // New observations with evidence -> create_new (proposal untuk fact baru).
  for (const item of reflection.new_observations) {
    const evidence = asArray(item.evidence_refs)
    if (evidence.length === 0) continue
    candidates.push(makeSuggestion({
      reflectionLogId, targetType: 'new_identity_fact', targetId: null,
      suggestionType: 'create_new',
      label: item.label || 'New observation',
      description: item.description,
      evidenceRefs: evidence,
      confidence: item.confidence_score, risk: 0.25,
    }))
  }

  const rows = candidates.filter(Boolean).slice(0, 60)
  if (!rows.length) return []
  const { data, error } = await supabase.from('identity_evolution_suggestions').insert(rows).select('*')
  if (error) throw error
  return data ?? []
}

function makeSuggestion({ reflectionLogId, targetType, targetId, suggestionType, label, description, evidenceRefs, confidence, risk }) {
  if (!label) return null
  const evidence = dedupeEvidence(asArray(evidenceRefs))
  const riskScore = clamp(risk ?? 0.25)
  return {
    user_id: userId,
    reflection_log_id: reflectionLogId,
    target_type: targetType,
    target_id: targetId ?? null,
    suggestion_type: suggestionType,
    label: excerpt(label, 200),
    description: excerpt(description ?? '', 1200),
    before_state: targetId ? { target_id: targetId } : {},
    after_state: { suggestion_type: suggestionType, proposed_confidence: confidence === undefined ? null : clamp(confidence) },
    evidence_refs: evidence,
    confidence_score: confidence === undefined ? 0 : clamp(confidence),
    risk_score: riskScore,
    status: 'proposed',
    metadata: { generated_by: 'self-reflection.mjs', high_risk: riskScore > 0.75, evidence_count: evidence.length },
  }
}

async function listSuggestions(statusFilter) {
  let query = supabase.from('identity_evolution_suggestions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100)
  if (statusFilter && SUGGESTION_STATUSES.has(statusFilter)) query = query.eq('status', statusFilter)
  const { data, error } = await query
  if (error && error.code !== '42P01') throw error
  return { ok: true, suggestions: error?.code === '42P01' ? [] : data ?? [] }
}

async function updateSuggestionStatus(suggestionId, status) {
  if (!REVIEW_STATUSES.has(status)) throw new Error(`status hanya boleh approved/rejected/ignored, bukan: ${status}`)
  const nowIso = new Date().toISOString()
  const patch = { status, reviewed_at: nowIso }
  if (status === 'rejected') patch.rejected_at = nowIso
  // MVP: approve/reject/ignore HANYA mengubah status suggestion; tidak menyentuh identity_facts/communication_patterns.
  const { data, error } = await supabase.from('identity_evolution_suggestions').update(patch).eq('id', suggestionId).eq('user_id', userId).select('*').single()
  if (error) throw error
  return { ok: true, suggestion: data, note: 'Status suggestion diubah. Target identity/communication TIDAK diubah otomatis (MVP).' }
}

async function applyApprovedSuggestions() {
  // SELF_REFLECTION_AUTO_APPLY=false secara default. Auto-apply ke identity data tidak diimplementasikan di MVP.
  if (!readBoolEnv('SELF_REFLECTION_AUTO_APPLY', false)) {
    const { data } = await supabase.from('identity_evolution_suggestions').select('id,label,suggestion_type,status').eq('user_id', userId).eq('status', 'approved').limit(100)
    return {
      ok: true,
      applied: 0,
      approved_pending: data?.length ?? 0,
      note: 'SELF_REFLECTION_AUTO_APPLY=false. Auto-apply ke identity_facts/communication_patterns sengaja tidak dijalankan (lihat Step 25).',
    }
  }
  throw new Error('Auto-apply diaktifkan via env tetapi belum diimplementasikan; biarkan SELF_REFLECTION_AUTO_APPLY=false sampai Step 25.')
}

// ---------------------------------------------------------------------------
// Entity evolution snapshot
// ---------------------------------------------------------------------------

async function createEntitySnapshot({ type }) {
  const period = resolvePeriod(type === 'weekly' ? 'weekly' : 'daily', null, null)
  const context = await readContext(period)
  const activeFacts = context.identityFacts.filter((fact) => ['active', 'contradicted'].includes(fact.status))
  const coreFacts = activeFacts.filter((fact) => ['core', 'stable'].includes(fact.stability))
  const activePatterns = context.communicationPatterns.filter((pattern) => pattern.status === 'active')
  const proposedSuggestions = context.existingSuggestions.filter((item) => item.status === 'proposed')
  const highRiskSuggestions = proposedSuggestions.filter((item) => Number(item.risk_score ?? 0) > 0.75)
  const highDrift = context.driftLogs.filter((log) => Number(log.final_risk_score ?? 0) >= 0.51)
  const latestReflection = context.previousReflections[0] ?? null
  const openUncertainties = asArray(latestReflection?.uncertainties).slice(0, 20)
  const boundaries = activeFacts.filter((fact) => fact.fact_type === 'boundary').map((fact) => ({ id: fact.id, label: fact.label, statement: excerpt(fact.statement, 200) })).slice(0, 20)

  const stabilityScore = activeFacts.length ? round4(coreFacts.length / activeFacts.length) : 0
  const fidelityRisk = round4(Math.max(
    context.latestSimilarity && ['bad', 'blocked'].includes(context.latestSimilarity.verdict) ? 0.7 : 0,
    highDrift.length ? Math.min(0.85, 0.4 + highDrift.length * 0.05) : 0,
    highRiskSuggestions.length ? 0.6 : 0,
  ))
  const evolutionScore = round4(Math.min(1, (context.rawEntries.length / Math.max(1, limits.rawEntries)) * 0.4 + Math.min(1, proposedSuggestions.length / 20) * 0.3 + Math.min(1, openUncertainties.length / 10) * 0.3))

  if (type !== 'baseline') await supabase.from('entity_evolution_snapshots').update({ status: 'archived' }).eq('user_id', userId).eq('status', 'active')

  const payload = {
    user_id: userId,
    snapshot_type: type,
    title: `Entity Evolution Snapshot ${new Date().toISOString().slice(0, 10)}`,
    summary: `Snapshot evolusi entitas: ${activeFacts.length} identity facts aktif (${coreFacts.length} core/stable), ${activePatterns.length} communication patterns aktif, ${proposedSuggestions.length} evolution suggestions menunggu review.`,
    identity_state: { active_facts: activeFacts.length, core_or_stable: coreFacts.length, contradicted: activeFacts.filter((fact) => fact.status === 'contradicted').length, latest_snapshot_id: context.identitySnapshots[0]?.id ?? null },
    communication_state: { active_patterns: activePatterns.length, high_confidence: activePatterns.filter((pattern) => Number(pattern.confidence_score ?? 0) >= 0.65).length, calibration_hints: context.calibrationHints.length },
    reflection_state: { latest_reflection_id: latestReflection?.id ?? null, latest_reflection_type: latestReflection?.reflection_type ?? null, proposed_suggestions: proposedSuggestions.length, high_risk_suggestions: highRiskSuggestions.length },
    drift_state: { high_risk_logs: highDrift.length, latest_active_baseline: context.driftBaseline?.id ?? null },
    similarity_state: context.latestSimilarity ? { verdict: context.latestSimilarity.verdict, overall_score: context.latestSimilarity.overall_score } : {},
    open_uncertainties: openUncertainties,
    active_boundaries: boundaries,
    evolution_score: evolutionScore,
    stability_score: stabilityScore,
    fidelity_risk_score: fidelityRisk,
    status: fidelityRisk > 0.75 ? 'needs_review' : 'active',
    metadata: { generated_by: 'self-reflection.mjs' },
  }
  const { data, error } = await supabase.from('entity_evolution_snapshots').insert(payload).select('*').single()
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Latest + audit
// ---------------------------------------------------------------------------

async function getLatest() {
  const [reflectionRes, suggestionsRes, snapshotRes] = await Promise.all([
    supabase.from('self_reflection_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('identity_evolution_suggestions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(60),
    supabase.from('entity_evolution_snapshots').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  for (const res of [reflectionRes, suggestionsRes, snapshotRes]) if (res.error && res.error.code !== 'PGRST116' && res.error.code !== '42P01') throw res.error
  const suggestions = suggestionsRes.error?.code === '42P01' ? [] : suggestionsRes.data ?? []
  return {
    ok: true,
    reflection: reflectionRes.data ?? null,
    suggestions,
    snapshot: snapshotRes.data ?? null,
    suggestion_summary: summarizeSuggestions(suggestions),
  }
}

async function auditReflection() {
  const period = resolvePeriod('weekly', null, null)
  const context = await readContext(period)
  const latest = context.previousReflections[0] ?? null
  const suggestions = context.existingSuggestions
  const proposed = suggestions.filter((item) => item.status === 'proposed')
  const highRisk = proposed.filter((item) => Number(item.risk_score ?? 0) > 0.75)
  const noEvidence = proposed.filter((item) => asArray(item.evidence_refs).length === 0)
  const freshnessHours = latest ? (Date.now() - new Date(latest.created_at).getTime()) / 3600000 : Infinity
  const repeatedUncertainties = repeatedUncertaintyLabels(context.previousReflections.slice(0, 5))
  const basedOnNewData = latest ? hasNewDataSince(context, latest.period_start) : false

  const warnings = []
  if (!latest) warnings.push('Belum ada self_reflection_logs.')
  else if (freshnessHours > 72) warnings.push('Reflection terakhir lebih lama dari 72 jam.')
  if (highRisk.length) warnings.push(`${highRisk.length} high-risk suggestion menunggu review.`)
  if (noEvidence.length) warnings.push(`${noEvidence.length} proposed suggestion tanpa evidence.`)
  if (repeatedUncertainties.length) warnings.push(`Ada ${repeatedUncertainties.length} ketidakpastian yang berulang antar refleksi.`)
  if (latest && !basedOnNewData) warnings.push('Reflection terakhir tampaknya tidak didasarkan pada data baru (kemungkinan mengulang refleksi lama).')
  if (context.latestSimilarity && ['bad', 'blocked'].includes(context.latestSimilarity.verdict)) warnings.push(`Latest similarity verdict ${context.latestSimilarity.verdict}.`)
  if (context.driftLogs.filter((log) => Number(log.final_risk_score ?? 0) >= 0.51).length) warnings.push('Ada drift log risk tinggi pada periode terakhir.')

  let score = 100 - warnings.length * 10
  if (!latest) score -= 20
  score = Math.max(0, Math.min(100, score))
  return {
    ok: true,
    status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
    score,
    warnings,
    recommended_fixes: warnings.map((warning) =>
      warning.includes('Belum ada') || warning.includes('lebih lama') ? 'Jalankan npm run reflection:run -- --type manual.'
        : warning.includes('high-risk') || warning.includes('tanpa evidence') ? 'Review Reflection View dan approve/reject suggestions.'
          : warning.includes('similarity') ? 'Jalankan npm run similarity:run lalu refleksi ulang.'
            : warning.includes('drift') ? 'Jalankan npm run drift:audit dan review jawaban berisiko.'
              : 'Tambahkan diary/data baru sebelum refleksi berikutnya.'),
    checks: {
      latest_reflection_id: latest?.id ?? null,
      latest_reflection_age_hours: Number.isFinite(freshnessHours) ? Number(freshnessHours.toFixed(1)) : null,
      proposed_suggestions: proposed.length,
      high_risk_suggestions: highRisk.length,
      suggestions_without_evidence: noEvidence.length,
      repeated_uncertainties: repeatedUncertainties,
      last_similarity_verdict: context.latestSimilarity?.verdict ?? null,
      last_drift_high_risk: context.driftLogs.filter((log) => Number(log.final_risk_score ?? 0) >= 0.51).length,
      identity_facts_count: context.identityFacts.filter((fact) => ['active', 'contradicted'].includes(fact.status)).length,
      communication_patterns_count: context.communicationPatterns.filter((pattern) => pattern.status === 'active').length,
      reflection_based_on_new_data: basedOnNewData,
    },
  }
}

// ---------------------------------------------------------------------------
// Obsidian output
// ---------------------------------------------------------------------------

async function writeReflectionReports(latest) {
  const dir = resolve(vaultPath, '_system', 'reflections')
  mkdirSync(dir, { recursive: true })
  const reflection = latest.reflection
  const suggestions = latest.suggestions ?? []
  const snapshot = latest.snapshot
  const highRiskSuggestions = suggestions.filter((item) => Number(item.risk_score ?? 0) > 0.75)
  const proposed = suggestions.filter((item) => item.status === 'proposed')

  const reflectionBody = [
    AUTO_START,
    `Generated: ${new Date().toISOString()}`,
    reflection ? `Reflection: ${reflection.title} (${reflection.reflection_type}, ${reflection.status})` : 'Belum ada reflection.',
    '',
    '## Summary',
    reflection?.summary || 'Belum ada reflection.',
    '',
    itemSection('New Observations', reflection?.new_observations, (item) => `${item.label}: ${item.description}`),
    itemSection('Strengthened Patterns', reflection?.strengthened_patterns, (item) => `${item.target_label || item.label}: ${item.description} (${item.suggestion ?? 'increase_confidence'})`),
    itemSection('Weakened Patterns', reflection?.weakened_patterns, (item) => `${item.target_label || item.label}: ${item.description}`),
    itemSection('New Contradictions', reflection?.new_contradictions, (item) => `${item.label}: ${item.description} (risk ${num(item.risk_score)})`),
    itemSection('Identity Implications', reflection?.identity_implications, (item) => `${item.label}: ${item.description} (${item.suggestion_type ?? ''})`),
    itemSection('Communication Implications', reflection?.communication_implications, (item) => `${item.label}: ${item.description}`),
    itemSection('Risk Implications', reflection?.risk_implications, (item) => `${item.label}: ${item.description} (risk ${num(item.risk_score)})`),
    itemSection('Uncertainties', reflection?.uncertainties, (item) => `${item.label}: ${item.description}`),
    itemSection('Proposed Evolution Suggestions', proposed.slice(0, 30), (item) => `${item.suggestion_type} → ${item.target_type}: ${item.label} (conf ${num(item.confidence_score)}, risk ${num(item.risk_score)})`),
    itemSection('High-Risk Suggestions', highRiskSuggestions.slice(0, 20), (item) => `${item.suggestion_type} → ${item.label} (risk ${num(item.risk_score)})`),
    listSection('Evidence Highlights', asArray(reflection?.evidence_refs).slice(0, 20).map((ref) => `${ref.type}:${ref.id} ${ref.label ?? ''}`)),
    listSection('Next Data Needed', asArray(reflection?.uncertainties).flatMap((item) => asArray(item.needed_data)).slice(0, 12)),
    AUTO_END,
    '',
  ].join('\n')

  writeMarkedFile(resolve(dir, 'Self Reflection Latest.md'), markdownDoc('Self Reflection Latest', reflectionBody))
  if (reflection) {
    const stamp = new Date(reflection.created_at ?? Date.now()).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
    writeFileSync(resolve(dir, `Self Reflection ${stamp}.md`), markdownDoc(`Self Reflection ${stamp}`, reflectionBody), 'utf8')
  }
  writeMarkedFile(resolve(dir, 'Evolution Suggestions.md'), markdownDoc('Evolution Suggestions', [
    AUTO_START,
    `Generated: ${new Date().toISOString()}`,
    `Proposed: ${proposed.length} · High-risk: ${highRiskSuggestions.length}`,
    '',
    ...suggestions.slice(0, 60).map((item) => `- [${item.status}] ${item.suggestion_type} → ${item.target_type}: ${item.label} (conf ${num(item.confidence_score)}, risk ${num(item.risk_score)})`),
    AUTO_END,
    '',
  ].join('\n')))
  writeMarkedFile(resolve(dir, 'Entity Evolution Snapshot.md'), markdownDoc('Entity Evolution Snapshot', [
    AUTO_START,
    `Generated: ${new Date().toISOString()}`,
    snapshot ? snapshot.summary : 'Belum ada entity evolution snapshot.',
    '',
    snapshot ? `- Evolution score: ${num(snapshot.evolution_score)}` : '',
    snapshot ? `- Stability score: ${num(snapshot.stability_score)}` : '',
    snapshot ? `- Fidelity risk score: ${num(snapshot.fidelity_risk_score)}` : '',
    '',
    listSection('Open Uncertainties', asArray(snapshot?.open_uncertainties).map((item) => typeof item === 'string' ? item : `${item.label}: ${item.description ?? ''}`).slice(0, 15)),
    listSection('Active Boundaries', asArray(snapshot?.active_boundaries).map((item) => typeof item === 'string' ? item : `${item.label}: ${item.statement ?? ''}`).slice(0, 15)),
    AUTO_END,
    '',
  ].join('\n')))
}

// ---------------------------------------------------------------------------
// Read context
// ---------------------------------------------------------------------------

async function readContext(period) {
  const startIso = period.start.toISOString()
  const endIso = period.end.toISOString()
  const [
    rawRes, memoriesRes, nodesRes, reportsRes, factsRes, snapshotsRes, patternsRes, samplesRes,
    inferenceRes, calibResultsRes, calibHintsRes, simRunRes, simResultsRes, driftLogsRes, driftBaselineRes,
    prevReflectionsRes, existingSuggestionsRes, conflictsRes, longTermRes,
  ] = await Promise.all([
    supabase.from('raw_entries').select('id,title,content,happened_at,created_at,processing_status').eq('user_id', userId).gte('created_at', startIso).lte('created_at', endIso).order('created_at', { ascending: false }).limit(limits.rawEntries),
    supabase.from('agent_memories').select('id,memory_type,content,importance_level,stability,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(80),
    supabase.from('brain_nodes').select('id,type,name,canonical_name,summary,description,confidence_score,last_seen_at').eq('user_id', userId).order('last_seen_at', { ascending: false, nullsFirst: false }).limit(60),
    supabase.from('brain_reports').select('id,report_type,title,summary,repeated_patterns,risks,period_end,status').eq('user_id', userId).eq('status', 'done').order('period_end', { ascending: false }).limit(limits.reports),
    supabase.from('identity_facts').select('*').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(limits.identityFacts),
    supabase.from('identity_snapshots').select('id,title,summary,created_at,status').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    supabase.from('communication_patterns').select('id,pattern_type,label,confidence_score,stability,status,created_at,updated_at').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(limits.communicationPatterns),
    supabase.from('communication_samples').select('id,sample_type,intent_type,confidence_score,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(60),
    supabase.from('response_inference_logs').select('id,intent_type,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(40),
    supabase.from('owner_calibration_results').select('id,intent_type,similarity_score,overall_score,verdict,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(40),
    supabase.from('owner_calibration_hints').select('id,intent_type,hint_type,label,confidence_score,status,created_at').eq('user_id', userId).in('status', ['active', 'needs_review']).order('confidence_score', { ascending: false }).limit(40),
    supabase.from('similarity_eval_runs').select('id,verdict,overall_score,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('similarity_eval_results').select('id,verdict,overall_score,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(limits.similarityResults),
    supabase.from('drift_guard_logs').select('id,intent_type,final_risk_score,blocked,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(limits.driftLogs),
    supabase.from('drift_baseline_snapshots').select('id,label,status,created_at').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('self_reflection_logs').select('id,reflection_type,title,summary,uncertainties,period_start,period_end,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(8),
    supabase.from('identity_evolution_suggestions').select('id,target_type,suggestion_type,label,confidence_score,risk_score,status,evidence_refs,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    supabase.from('identity_conflicts').select('id,conflict_type,title,summary,severity,recurrence,resolution_status,impact_area,last_seen_at').eq('user_id', userId).in('resolution_status', ['open','monitoring','partially_resolved','needs_review']).order('last_seen_at', { ascending: false }).limit(80),
    supabase.from('long_term_memories').select('id,memory_type,title,canonical_statement,importance_score,confidence_score,stability,freshness,status,last_seen_at').eq('user_id', userId).in('status', ['active','needs_review','contradicted']).order('importance_score', { ascending: false }).limit(120),
  ])

  const safe = (res) => (res.error && res.error.code !== '42P01' && res.error.code !== 'PGRST116') ? throwError(res.error) : (res.error ? null : res.data)
  const list = (res) => { const value = safe(res); return Array.isArray(value) ? value : [] }

  const rawEntries = list(rawRes)
  const memories = list(memoriesRes)
  const nodes = list(nodesRes)
  const reports = list(reportsRes)
  const identityFacts = list(factsRes)
  const identitySnapshots = list(snapshotsRes)
  const communicationPatterns = list(patternsRes)
  const communicationSamples = list(samplesRes)
  const responseLogs = list(inferenceRes)
  const calibrationResults = list(calibResultsRes)
  const calibrationHints = list(calibHintsRes)
  const latestSimilarity = safe(simRunRes)
  const similarityResults = list(simResultsRes)
  const driftLogs = list(driftLogsRes)
  const driftBaseline = safe(driftBaselineRes)
  const previousReflections = list(prevReflectionsRes)
  const existingSuggestions = list(existingSuggestionsRes)
  const identityConflicts = list(conflictsRes)
  const longTermMemories = list(longTermRes)

  return {
    rawEntries, memories, nodes, reports, identityFacts, identitySnapshots,
    communicationPatterns, communicationSamples, responseLogs, calibrationResults,
    calibrationHints, latestSimilarity, similarityResults, driftLogs, driftBaseline,
    previousReflections, existingSuggestions, identityConflicts, longTermMemories,
    counts: {
      raw_entries: rawEntries.length,
      identity_facts: identityFacts.length,
      communication_patterns: communicationPatterns.length,
      drift_logs: driftLogs.length,
      calibration_results: calibrationResults.length,
      previous_reflections: previousReflections.length,
      identity_conflicts: identityConflicts.length,
      long_term_memories: longTermMemories.length,
    },
  }
}

function throwError(error) { throw error }

// ---------------------------------------------------------------------------
// LLM providers (provider-agnostic; fallback chain via env)
// ---------------------------------------------------------------------------

async function callLLM(contextPackJson) {
  if (provider === 'claude-code') return parseJsonOrThrow(await callClaudeCode(contextPackJson), 'Claude Code')
  if (provider === 'anthropic') return parseJsonOrThrow(await callAnthropic(contextPackJson), 'Anthropic')
  if (provider === 'openai') return parseJsonOrThrow(await callOpenAICompatible(contextPackJson), 'OpenAI-compatible')
  if (provider === 'ollama') return parseJsonOrThrow(await callOllama(contextPackJson), 'Ollama')
  throw new Error(`SELF_REFLECTION_PROVIDER/LLM_PROVIDER tidak dikenal: ${provider}`)
}

async function callClaudeCode(contextPackJson) {
  const commandName = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
  const settingsArg = process.env.CLAUDE_CODE_API_KEY_HELPER === 'false'
    ? []
    : ['--settings', JSON.stringify({ apiKeyHelper: 'node -e "process.stdout.write(process.env.SELF_REFLECTION_API_KEY || process.env.DRIFT_CONTROL_API_KEY || process.env.BRAIN_CHAT_API_KEY || process.env.ANTHROPIC_API_KEY || \'\')"' })]
  return await runCommand(commandName, [
    ...(process.env.CLAUDE_CODE_BARE === 'false' ? [] : ['--bare']),
    ...settingsArg,
    '--no-session-persistence',
    '--output-format', 'text',
    '-p', `${SYSTEM_PROMPT}\n\nCONTEXT PACK:\n${contextPackJson}`,
  ], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
}

async function callAnthropic(contextPackJson) {
  const baseUrl = requiredEnv('SELF_REFLECTION_BASE_URL', fallbackEnv(['DRIFT_CONTROL_BASE_URL', 'SIMILARITY_EVAL_BASE_URL', 'OWNER_CALIBRATION_BASE_URL', 'RESPONSE_INFERENCE_BASE_URL', 'COMMUNICATION_BASE_URL', 'IDENTITY_BASE_URL', 'BRAIN_CHAT_BASE_URL', 'LLM_BASE_URL', 'ANTHROPIC_BASE_URL'])).replace(/\/+$/, '')
  const apiKey = requiredEnv('SELF_REFLECTION_API_KEY', fallbackEnv(['DRIFT_CONTROL_API_KEY', 'SIMILARITY_EVAL_API_KEY', 'OWNER_CALIBRATION_API_KEY', 'RESPONSE_INFERENCE_API_KEY', 'COMMUNICATION_API_KEY', 'IDENTITY_API_KEY', 'BRAIN_CHAT_API_KEY', 'LLM_API_KEY', 'ANTHROPIC_API_KEY']))
  const model = requiredEnv('SELF_REFLECTION_MODEL', modelName)
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 5000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: `CONTEXT PACK:\n${contextPackJson}` }] }),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return Array.isArray(data.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
}

async function callOpenAICompatible(contextPackJson) {
  const baseUrl = requiredEnv('SELF_REFLECTION_BASE_URL', fallbackEnv(['DRIFT_CONTROL_BASE_URL', 'SIMILARITY_EVAL_BASE_URL', 'OWNER_CALIBRATION_BASE_URL', 'RESPONSE_INFERENCE_BASE_URL', 'COMMUNICATION_BASE_URL', 'IDENTITY_BASE_URL', 'BRAIN_CHAT_BASE_URL', 'LLM_BASE_URL'])).replace(/\/+$/, '')
  const apiKey = requiredEnv('SELF_REFLECTION_API_KEY', fallbackEnv(['DRIFT_CONTROL_API_KEY', 'SIMILARITY_EVAL_API_KEY', 'OWNER_CALIBRATION_API_KEY', 'RESPONSE_INFERENCE_API_KEY', 'COMMUNICATION_API_KEY', 'IDENTITY_API_KEY', 'BRAIN_CHAT_API_KEY', 'LLM_API_KEY']))
  const model = requiredEnv('SELF_REFLECTION_MODEL', modelName)
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `CONTEXT PACK:\n${contextPackJson}` }], response_format: { type: 'json_object' } }),
  })
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

async function callOllama(contextPackJson) {
  const baseUrl = (process.env.SELF_REFLECTION_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = requiredEnv('SELF_REFLECTION_MODEL', modelName)
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: `${SYSTEM_PROMPT}\n\nCONTEXT PACK:\n${contextPackJson}`, stream: false, format: 'json' }),
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data.response ?? ''
}

// ---------------------------------------------------------------------------
// Supabase + helpers
// ---------------------------------------------------------------------------

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}) })
  if (accessToken) return client
  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, atau SUPABASE_USER_EMAIL/SUPABASE_USER_PASSWORD.')
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

async function resolveUserId() {
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  if (process.env.SUPABASE_USER_ID) return process.env.SUPABASE_USER_ID
  const { data } = await supabase.auth.getUser()
  if (data?.user?.id) return data.user.id
  for (const table of ['self_reflection_logs', 'identity_facts', 'raw_entries', 'brain_nodes']) {
    const { data: row, error } = await supabase.from(table).select('user_id').limit(1).maybeSingle()
    if (!error && row?.user_id) return row.user_id
  }
  throw new Error('Tidak bisa menentukan user_id untuk self-reflection.')
}

function resolvePeriod(type, fromArg, toArg) {
  const end = toArg && isDateOnly(toArg) ? new Date(`${toArg}T23:59:59.999Z`) : new Date()
  const days = type === 'weekly' ? 7 : type === 'daily' ? 1 : 3
  const start = fromArg && isDateOnly(fromArg) ? new Date(`${fromArg}T00:00:00.000Z`) : new Date(end.getTime() - days * 86400000)
  return { start, end }
}

function resolveReflectionType(value) {
  return REFLECTION_TYPES.has(value) ? value : 'manual'
}

function resolveSnapshotType(value) {
  return SNAPSHOT_TYPES.has(value) ? value : 'manual'
}

function indexByLabel(rows) {
  const map = new Map()
  for (const row of rows) {
    const key = normalizeLabel(row.label)
    if (key && !map.has(key)) map.set(key, row.id)
  }
  return map
}

function resolveTargetId(targetType, label, factByLabel, patternByLabel) {
  if (targetType.startsWith('new_')) return null
  const key = normalizeLabel(label)
  if (!key) return null
  if (targetType === 'communication_pattern') return patternByLabel.get(key) ?? null
  if (targetType === 'identity_fact') return factByLabel.get(key) ?? null
  return null
}

function summarizeSuggestions(suggestions) {
  return {
    total: suggestions.length,
    proposed: suggestions.filter((item) => item.status === 'proposed').length,
    approved: suggestions.filter((item) => item.status === 'approved').length,
    rejected: suggestions.filter((item) => item.status === 'rejected').length,
    applied: suggestions.filter((item) => item.status === 'applied').length,
    ignored: suggestions.filter((item) => item.status === 'ignored').length,
    high_risk: suggestions.filter((item) => Number(item.risk_score ?? 0) > 0.75).length,
  }
}

function repeatedUncertaintyLabels(reflections) {
  const counts = new Map()
  for (const reflection of reflections) {
    for (const item of asArray(reflection.uncertainties)) {
      const key = normalizeLabel(item?.label)
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([label]) => label)
}

function hasNewDataSince(context, periodStart) {
  if (!periodStart) return context.rawEntries.length > 0
  const start = new Date(periodStart).getTime()
  return context.rawEntries.some((entry) => new Date(entry.created_at).getTime() > start)
    || context.calibrationResults.some((row) => new Date(row.created_at).getTime() > start)
    || context.driftLogs.some((log) => new Date(log.created_at).getTime() > start)
}

function withinDays(value, days) {
  if (!value) return false
  const age = Date.now() - new Date(value).getTime()
  return Number.isFinite(age) && age >= 0 && age <= days * 86400000
}

function dedupeEvidence(refs) {
  const seen = new Set()
  return asArray(refs).filter((ref) => {
    if (!ref?.type || !ref?.id) return false
    const key = `${ref.type}:${ref.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((ref) => ({ type: String(ref.type), id: String(ref.id), label: String(ref.label ?? '') }))
}

function markdownDoc(title, body) {
  return ['---', `type: self_reflection`, `last_updated: "${new Date().toISOString()}"`, '---', '', `# ${title}`, '', body].join('\n')
}

function itemSection(title, items, formatter) {
  const list = asArray(items)
  const lines = [`## ${title}`]
  if (!list.length) lines.push('- Belum cukup data.')
  else lines.push(...list.map((item) => `- ${formatter(item)}`))
  lines.push('')
  return lines.join('\n')
}

function listSection(title, items) {
  const list = asArray(items).filter(Boolean)
  const lines = [`## ${title}`]
  if (!list.length) lines.push('- Belum cukup data.')
  else lines.push(...list.map((item) => `- ${item}`))
  lines.push('')
  return lines.join('\n')
}

function writeMarkedFile(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) {
    writeFileSync(path, `${content}\n`, 'utf8')
    return
  }
  const existing = readFileSync(path, 'utf8')
  const auto = content.slice(content.indexOf(AUTO_START), content.indexOf(AUTO_END) + AUTO_END.length)
  const next = existing.includes(AUTO_START) && existing.includes(AUTO_END)
    ? `${existing.slice(0, existing.indexOf(AUTO_START))}${auto}${existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length)}`
    : `${existing.replace(/\s*$/, '\n\n')}${auto}\n`
  writeFileSync(path, next, 'utf8')
}

function capitalize(value) { return String(value ?? '').replace(/^[a-z]/, (char) => char.toUpperCase()).replace(/_/g, ' ') }
function num(value) { const n = Number(value ?? 0); return Number.isFinite(n) ? n.toFixed(2) : '-' }
function normalizeLabel(value) { return String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() }
function isDateOnly(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()) }
function excerpt(value, max) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}...` : text }
function clamp(value) { const num = Number(value); return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0 }
function round4(value) { return Number(clamp(value).toFixed(4)) }
function asArray(value) { return Array.isArray(value) ? value : [] }
function arrayOfStrings(value) { return Array.isArray(value) ? value.map(String).filter(Boolean) : [] }

function parseJsonOrThrow(text, label) {
  const raw = String(text ?? '').trim()
  try { return JSON.parse(raw) } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`${label} tidak mengembalikan JSON.`)
    return JSON.parse(match[0])
  }
}

function runCommand(commandName, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, commandArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${commandName} timeout setelah ${timeoutMs}ms`)) }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolvePromise(output); else reject(new Error(`${commandName} exited ${code}: ${output.slice(0, 1000)}`)) })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function parseArgs(items) {
  const map = new Map()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item.startsWith('--')) continue
    const next = items[index + 1]
    map.set(item.slice(2), next && !next.startsWith('--') ? next : 'true')
    if (next && !next.startsWith('--')) index += 1
  }
  return { get: (key) => map.get(key), has: (key) => map.has(key) }
}

function readOptionalArg(name) { const value = args.get(name); return value && value !== 'true' ? String(value).trim() : '' }
function readRequiredArg(name) { const value = readOptionalArg(name); if (!value) throw new Error(`Missing required argument --${name}`); return value }
function readBoolArg(name, fallback) { const raw = args.get(name); if (raw === undefined) return fallback; return raw === 'true' }
function readIntEnv(key, fallback, min, max) { const value = Number(process.env[key] ?? fallback); if (!Number.isFinite(value)) return fallback; return Math.max(min, Math.min(max, Math.floor(value))) }
function readBoolEnv(key, fallback) { const value = process.env[key]; if (value === undefined || value === '') return fallback; return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) }
function requiredEnv(name, fallback) { const value = process.env[name] || fallback; if (!value) throw new Error(`Missing env ${name}`); return value }
function fallbackEnv(names) { for (const name of names) if (process.env[name]) return process.env[name]; return '' }

function loadEnv(path, options = {}) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    if (!options.override && process.env[match[1]]) continue
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}
