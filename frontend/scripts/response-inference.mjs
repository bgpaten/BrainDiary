import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardResponse } from './drift-control.mjs'
import { finalizeEntityRuntime, prepareEntityRuntime } from './entity-runtime.mjs'

const RESPONSE_SYSTEM_PROMPT = `Kamu adalah Response Inference Engine untuk Personal Entity OS.

Tugasmu bukan memberi jawaban AI terbaik.
Tugasmu adalah memprediksi jawaban yang kemungkinan besar akan diberikan oleh pemilik diary jika menerima prompt user.

Gunakan:
- identity facts
- communication patterns
- memory context
- response shape
- intent type

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
- Jika identity_conflicts relevan tersedia, sebut tension dengan nuansa.
- Jangan memilih salah satu sisi konflik identitas tanpa evidence kuat.
- Jangan membawa konflik ke sapaan ringan.
- Output harus JSON valid.`

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.has('rules')) {
      console.log(JSON.stringify(await initializeResponseRules(), null, 2))
    } else if (args.has('audit')) {
      console.log(JSON.stringify(await auditResponseInference(), null, 2))
    } else {
      const question = readArg(args, 'question')
      if (!question.trim()) throw new Error('Question kosong.')
      if (question.length > 2000) throw new Error('Question terlalu panjang. Maksimum 2000 karakter.')
      const result = await runResponseInference({ question, options: cliOptions(args) })
      console.log(JSON.stringify(result, null, args.has('pretty') ? 2 : 0))
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export async function runResponseInference({ question, options = {} }) {
  if (question.length > 2000) throw new Error('Question terlalu panjang. Maksimum 2000 karakter.')
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk Response Inference.')

  const runtime = await prepareEntityRuntime({ supabase, userId, question, source: options.source ?? 'response_inference' }).catch((err) => ({
    enabled: true,
    blocked: false,
    entity_runtime: {
      enabled: true,
      runtime_mode: process.env.ENTITY_RUNTIME_MODE ?? 'read_only',
      runtime_session_id: null,
      boundary_checked: false,
      action_detected: false,
      action_blocked: false,
      proposal_created: false,
      proposal_id: null,
      policy_warnings: [`Runtime fallback: ${err instanceof Error ? err.message : String(err)}`],
      runtime_risk_score: 0.25,
    },
  }))
  if (runtime.blocked) {
    return {
      ok: true,
      answer: runtime.answer,
      confidence: 0.82,
      persona_mode: 'planning_guard',
      persona_reason: 'Safe Entity Runtime blocked a mutating or external action.',
      persona_confidence: 0.9,
      basis: [],
      sources: [],
      missing_context: [],
      suggested_next_actions: ['Review proposal secara manual.'],
      style_warnings: runtime.entity_runtime.policy_warnings ?? [],
      warnings: runtime.entity_runtime.policy_warnings ?? [],
      intent_type: 'runtime_action_request',
      inference_mode: 'runtime_boundary',
      response_shape: { format: 'plain_text', show_sources: false, show_debug: false },
      inference_scores: {
        fidelity_score: 0.9,
        groundedness_score: 0.8,
        style_match_score: 0.7,
        overclaim_risk: 0.04,
        underfit_risk: 0.12,
      },
      response_inference_log_id: null,
      drift_guard: {
        enabled: true,
        risk_level: 'safe',
        final_risk_score: runtime.entity_runtime.runtime_risk_score ?? 0.3,
        triggered_rules: ['safe_entity_runtime'],
        actions: ['block_action', 'create_proposal'],
        blocked: false,
        fallback_used: false,
        warnings: runtime.entity_runtime.policy_warnings ?? [],
      },
      entity_runtime: runtime.entity_runtime,
      debug: {
        retrieved_nodes: 0,
        retrieved_edges: 0,
        retrieved_memories: 0,
        retrieved_raw_entries: 0,
        intent_type: 'runtime_action_request',
        inference_mode: 'runtime_boundary',
        is_social_greeting: false,
        entity_runtime: runtime.entity_runtime,
      },
    }
  }

  const intent = detectIntent(question)
  const inferenceMode = inferenceModeForIntent(intent)
  const useRetrieval = shouldUseRetrieval(intent)
  const brain = await readInferenceBrain(supabase, userId, { useRetrieval, query: question })
  const calibrationHints = selectCalibrationHints(intent, question, brain.ownerCalibrationHints)
  const communicationPatterns = selectCommunicationPatterns(intent, brain.communicationPatterns)
  const identityFacts = selectIdentityFacts(intent, brain.identityFacts)
  const identityConflicts = selectIdentityConflicts(intent, question, brain.identityConflicts)
  const longTermMemories = selectLongTermMemories(intent, question, brain.longTermMemories)
  const memoryFreshnessWarnings = freshnessWarnings(longTermMemories)
  const responseShape = applyCalibrationShape(buildResponseShape(intent, communicationPatterns), calibrationHints)
  const memoryRefs = useRetrieval ? buildMemoryRefs(question, brain, intent) : []
  const retrievalSummary = {
    used: useRetrieval,
    memory_ref_count: memoryRefs.length,
    identity_fact_count: identityFacts.length,
    identity_conflict_count: identityConflicts.length,
    long_term_memory_count: longTermMemories.length,
    communication_pattern_count: communicationPatterns.length,
  }
  const context = buildInferenceContext({
    question,
    intent,
    inferenceMode,
    responseShape,
    identityFacts,
    communicationPatterns,
    identityConflicts,
    longTermMemories,
    memoryConsolidationSnapshot: brain.memoryConsolidationSnapshots[0] ?? null,
    calibrationHints,
    identitySnapshots: brain.identitySnapshots,
    memoryRefs,
    retrievalSummary,
  })

  const raw = await answerWithInference(context, options)
  const guarded = applyPostProcessing(raw, context)
  const driftGuard = await guardResponse({
    question,
    answer: guarded.answer,
    intentType: intent,
    inferenceMode,
    responseShape,
    sources: responseShape.show_sources ? buildSources(identityFacts, memoryRefs) : [],
    debug: intent === 'social_greeting' ? null : { inference_trace: guarded.inference_trace },
    memoryRefs,
    identityFacts,
    calibrationHints,
    communicationPatterns,
    identityConflicts,
    longTermMemories,
  }, { supabase, userId }).catch((err) => ({
    enabled: true,
    risk_level: 'warning',
    final_risk_score: 0.35,
    triggered_rules: [],
    actions: ['warn'],
    blocked: false,
    fallback_used: false,
    warnings: [`Drift guard fallback: ${err instanceof Error ? err.message : String(err)}`],
    answer_after_guard: guarded.answer,
  }))
  guarded.answer = driftGuard.answer_after_guard ?? guarded.answer
  const scores = calculateInferenceRisk({
    intent,
    answer: guarded.answer,
    identityFactsUsed: identityFacts.length,
    communicationPatternsUsed: communicationPatterns.length,
    memoryRefsUsed: memoryRefs.length,
    rawScores: guarded,
  })
  const warnings = intent === 'social_greeting' ? [] : uniqueStrings([...(guarded.warnings ?? []), ...riskWarnings(scores), ...memoryFreshnessWarnings])
  const missingContext = intent === 'social_greeting' ? [] : arrayOfStrings(guarded.missing_context)
  const logPayload = {
    user_id: userId,
    question,
    normalized_question: normalizeWords(question),
    intent_type: intent,
    inference_mode: inferenceMode,
    response_shape: responseShape,
    identity_fact_ids: identityFacts.map((fact) => fact.id),
    communication_pattern_ids: communicationPatterns.map((pattern) => pattern.id),
    memory_refs: memoryRefs,
    retrieval_summary: retrievalSummary,
    inference_trace: guarded.inference_trace ?? {
      intent_type: intent,
      reasoning_summary: traceSummary(intent),
      identity_used: identityFacts.map((fact) => fact.id),
      communication_patterns_used: communicationPatterns.map((pattern) => pattern.id),
      calibration_hints_used: calibrationHints.map((hint) => hint.id),
      drift_guard: {
        enabled: driftGuard.enabled !== false,
        risk_level: driftGuard.risk_level,
        final_risk_score: driftGuard.final_risk_score,
        triggered_rules: driftGuard.triggered_rules,
        actions: driftGuard.actions,
        blocked: driftGuard.blocked,
        fallback_used: driftGuard.fallback_used,
        warnings: driftGuard.warnings,
      },
    },
    answer: guarded.answer,
    confidence_score: scores.confidence_score,
    fidelity_score: scores.fidelity_score,
    groundedness_score: scores.groundedness_score,
    style_match_score: scores.style_match_score,
    overclaim_risk: scores.overclaim_risk,
    underfit_risk: scores.underfit_risk,
    missing_context: missingContext,
    warnings,
    metadata: {
      provider: resolvedProvider(),
      use_llm: shouldUseLLM(options),
      source: options.source ?? 'cli',
      calibration_hints_used: calibrationHints.map((hint) => hint.id),
      identity_conflict_ids: identityConflicts.map((conflict) => conflict.id),
      long_term_memory_ids: longTermMemories.map((memory) => memory.id),
    },
  }

  const logId = await insertInferenceLog(supabase, logPayload)
  const entityRuntime = await finalizeEntityRuntime({ supabase, userId, runtime, answer: guarded.answer }).catch((err) => ({
    ...(runtime.entity_runtime ?? { enabled: true }),
    policy_warnings: [...(runtime.entity_runtime?.policy_warnings ?? []), `Runtime finalize fallback: ${err instanceof Error ? err.message : String(err)}`],
  }))
  return {
    ok: true,
    answer: guarded.answer,
    confidence: scores.confidence_score,
    persona_mode: mapPersonaMode(inferenceMode),
    persona_reason: traceSummary(intent),
    persona_confidence: scores.fidelity_score,
    basis: responseShape.show_basis ? buildBasis(identityFacts, memoryRefs, longTermMemories) : [],
    sources: responseShape.show_sources ? buildSources(identityFacts, memoryRefs, longTermMemories) : [],
    missing_context: responseShape.show_missing_context ? missingContext : [],
    suggested_next_actions: responseShape.show_next_actions === false ? [] : [],
    style_warnings: warnings,
    warnings,
    intent_type: intent,
    inference_mode: inferenceMode,
    response_shape: responseShape,
    inference_scores: {
      fidelity_score: scores.fidelity_score,
      groundedness_score: scores.groundedness_score,
      style_match_score: scores.style_match_score,
      overclaim_risk: scores.overclaim_risk,
      underfit_risk: scores.underfit_risk,
    },
    response_inference_log_id: logId,
    drift_guard: {
      enabled: driftGuard.enabled !== false,
      risk_level: driftGuard.risk_level,
      final_risk_score: driftGuard.final_risk_score,
      triggered_rules: driftGuard.triggered_rules ?? [],
      actions: driftGuard.actions ?? [],
      blocked: driftGuard.blocked === true,
      fallback_used: driftGuard.fallback_used === true,
      warnings: driftGuard.warnings ?? [],
    },
    owner_calibration_used: calibrationHints.length > 0,
    owner_calibration_hint_ids: calibrationHints.map((hint) => hint.id),
    owner_similarity_baseline: null,
    communication_style_used: communicationPatterns.length > 0,
    communication_pattern_ids: communicationPatterns.map((pattern) => pattern.id),
    communication_intent: intent,
    identity_conflicts_used: identityConflicts.length > 0,
    identity_conflict_ids: identityConflicts.map((conflict) => conflict.id),
    conflict_guidance_used: identityConflicts.map((conflict) => conflict.chat_guidance).filter(Boolean),
    conflict_warnings: conflictWarnings(identityConflicts),
    long_term_memory_used: longTermMemories.length > 0,
    long_term_memory_ids: longTermMemories.map((memory) => memory.id),
    memory_freshness_warnings: memoryFreshnessWarnings,
    memory_consolidation_snapshot_id: brain.memoryConsolidationSnapshots[0]?.id ?? null,
    entity_runtime: entityRuntime,
    debug: {
      intent_type: intent,
      inference_mode: inferenceMode,
      is_social_greeting: intent === 'social_greeting',
      response_shape: responseShape,
      inference_scores: scores,
      response_inference_log_id: logId,
      owner_calibration_used: calibrationHints.length > 0,
      owner_calibration_hint_ids: calibrationHints.map((hint) => hint.id),
      owner_similarity_baseline: null,
      identity_fact_ids: identityFacts.map((fact) => fact.id),
      communication_pattern_ids: communicationPatterns.map((pattern) => pattern.id),
      memory_refs: memoryRefs,
      retrieval_summary: retrievalSummary,
      inference_trace: logPayload.inference_trace,
      owner_calibration_hints: calibrationHints,
      drift_guard: driftGuard,
      retrieved_nodes: memoryRefs.filter((ref) => ref.type === 'brain_node').length,
      retrieved_edges: memoryRefs.filter((ref) => ref.type === 'brain_edge').length,
      retrieved_memories: memoryRefs.filter((ref) => ref.type === 'agent_memory').length,
      retrieved_raw_entries: memoryRefs.filter((ref) => ref.type === 'raw_entry').length,
      retrieval_methods: useRetrieval ? ['keyword', 'identity', 'communication'] : ['direct'],
      semantic_enabled: false,
      semantic_hits: 0,
      keyword_hits: memoryRefs.length,
      provider: resolvedProvider(),
      persona_profile_used: false,
      identity_facts_used: identityFacts.length,
      identity_snapshot_used: brain.identitySnapshots[0]?.id ?? null,
      identity_confidence_warnings: identityFacts.filter((fact) => Number(fact.confidence_score ?? 0) < 0.65).map((fact) => `${fact.label ?? fact.id} masih medium/low confidence.`),
      communication_style_used: communicationPatterns.length > 0,
      communication_intent: intent,
      identity_conflicts_used: identityConflicts.length > 0,
      identity_conflicts: identityConflicts,
      identity_conflict_ids: identityConflicts.map((conflict) => conflict.id),
      conflict_guidance_used: identityConflicts.map((conflict) => conflict.chat_guidance).filter(Boolean),
      conflict_warnings: conflictWarnings(identityConflicts),
      long_term_memory_used: longTermMemories.length > 0,
      long_term_memories: longTermMemories,
      long_term_memory_ids: longTermMemories.map((memory) => memory.id),
      memory_freshness_warnings: memoryFreshnessWarnings,
      memory_consolidation_snapshot_id: brain.memoryConsolidationSnapshots[0]?.id ?? null,
      entity_runtime: entityRuntime,
      warnings_hidden_from_user: intent === 'social_greeting' ? warnings : [],
    },
  }
}

export async function initializeResponseRules(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk init response rules.')
  const rows = defaultRules(userId)
  const { data, error } = await supabase
    .from('response_inference_rules')
    .upsert(rows, { onConflict: 'user_id,intent_type,rule_name', ignoreDuplicates: false })
    .select('id,intent_type,rule_name,enabled')
  if (error) throw error
  return { ok: true, rules_upserted: data?.length ?? rows.length, rules: data ?? [] }
}

export async function auditResponseInference(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk response audit.')
  const warnings = []
  const [rulesRes, patternsRes, factsRes, logsRes, scoreRes, overclaimRes, underfitRes] = await Promise.all([
    supabase.from('response_inference_rules').select('id,intent_type,rule_name,enabled').eq('user_id', userId),
    supabase.from('communication_patterns').select('id').eq('user_id', userId).eq('status', 'active').limit(1),
    supabase.from('identity_facts').select('id').eq('user_id', userId).in('status', ['active', 'contradicted', 'needs_review']).limit(1),
    supabase.from('response_inference_logs').select('id,intent_type,inference_mode,response_shape,missing_context,sources:memory_refs,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('response_inference_logs').select('fidelity_score').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
    supabase.from('response_inference_logs').select('id,question,overclaim_risk,created_at').eq('user_id', userId).gte('overclaim_risk', 0.3).order('created_at', { ascending: false }).limit(10),
    supabase.from('response_inference_logs').select('id,question,underfit_risk,created_at').eq('user_id', userId).gte('underfit_risk', 0.35).order('created_at', { ascending: false }).limit(10),
  ])
  for (const res of [rulesRes, patternsRes, factsRes, logsRes, scoreRes, overclaimRes, underfitRes]) {
    if (res.error && res.error.code !== '42P01') throw res.error
  }
  const rules = rulesRes.data ?? []
  const required = ['social_greeting', 'request_prompt', 'technical_instruction', 'strategy_question', 'correction', 'identity_question', 'unknown']
  for (const intent of required) {
    if (!rules.some((rule) => rule.intent_type === intent && rule.enabled)) warnings.push(`Rule aktif belum tersedia untuk ${intent}.`)
  }
  if ((patternsRes.data ?? []).length === 0) warnings.push('communication_patterns belum tersedia atau belum aktif.')
  if ((factsRes.data ?? []).length === 0) warnings.push('identity_facts belum tersedia.')
  const latestGreeting = (logsRes.data ?? []).find((log) => log.intent_type === 'social_greeting')
  if (latestGreeting && Array.isArray(latestGreeting.missing_context) && latestGreeting.missing_context.length > 0) {
    warnings.push('Social greeting terakhir masih membawa missing_context.')
  }
  const fidelityScores = (scoreRes.data ?? []).map((row) => Number(row.fidelity_score ?? 0)).filter(Number.isFinite)
  const averageFidelity = fidelityScores.length ? fidelityScores.reduce((sum, value) => sum + value, 0) / fidelityScores.length : 0
  if (averageFidelity > 0 && averageFidelity < 0.55) warnings.push('Average fidelity score di bawah 0.55.')
  const highOverclaim = overclaimRes.data ?? []
  const highUnderfit = underfitRes.data ?? []
  if (highOverclaim.length) warnings.push(`${highOverclaim.length} log punya overclaim risk tinggi.`)
  if (highUnderfit.length) warnings.push(`${highUnderfit.length} log punya underfit risk tinggi.`)
  let score = 100
  score -= warnings.length * 10
  if (!fidelityScores.length) score -= 15
  score = Math.max(0, Math.min(100, score))
  const result = {
    ok: true,
    status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
    score,
    warnings,
    recommended_fixes: recommendedFixes(warnings),
    checks: {
      rules_available: rules.length,
      greeting_rule_active: rules.some((rule) => rule.intent_type === 'social_greeting' && rule.enabled),
      request_prompt_rule_active: rules.some((rule) => rule.intent_type === 'request_prompt' && rule.enabled),
      communication_patterns_available: (patternsRes.data ?? []).length > 0,
      identity_facts_available: (factsRes.data ?? []).length > 0,
      latest_logs: logsRes.data ?? [],
      average_fidelity_score: Number(averageFidelity.toFixed(4)),
      high_overclaim_risk_logs: highOverclaim,
      high_underfit_risk_logs: highUnderfit,
    },
  }
  if (readBoolEnv('RESPONSE_INFERENCE_OUTPUT_OBSIDIAN', false)) writeObsidianReport(result)
  return result
}

async function readInferenceBrain(supabase, userId, { useRetrieval, query }) {
  const baseReads = [
    supabase.from('identity_facts').select('id,fact_type,label,statement,evidence_refs,confidence_score,stability,strength,polarity,usage_scope,status,contradiction_refs,last_seen_at,metadata').eq('user_id', userId).in('status', ['active', 'contradicted', 'needs_review']).order('confidence_score', { ascending: false }).limit(120),
    supabase.from('identity_snapshots').select('id,snapshot_type,title,summary,identity_model,confidence_summary,data_coverage,warnings,source_refs,status,created_at').eq('user_id', userId).in('status', ['done', 'needs_review']).order('created_at', { ascending: false }).limit(3),
    supabase.from('communication_patterns').select('id,pattern_type,label,description,examples,anti_examples,preferred_response_shape,trigger_intents,confidence_score,stability,evidence_refs,usage_rules,status,metadata,updated_at').eq('user_id', userId).eq('status', 'active').order('confidence_score', { ascending: false }).limit(100),
    supabase.from('owner_calibration_hints').select('id,intent_type,hint_type,label,description,trigger_patterns,preferred_response,avoid_response,response_shape_patch,confidence_score,evidence_example_ids,status,metadata,updated_at').eq('user_id', userId).in('status', ['active', 'needs_review']).order('confidence_score', { ascending: false }).limit(100),
    supabase.from('identity_conflicts').select('id,conflict_type,title,summary,side_a_label,side_a_statement,side_a_confidence,side_b_label,side_b_statement,side_b_confidence,severity,recurrence,resolution_status,impact_area,chat_guidance,last_seen_at').eq('user_id', userId).in('resolution_status', ['open', 'monitoring', 'partially_resolved', 'needs_review']).order('last_seen_at', { ascending: false }).limit(80),
    supabase.from('long_term_memories').select('id,memory_type,title,summary,canonical_statement,evidence_refs,related_identity_fact_ids,related_communication_pattern_ids,related_conflict_ids,importance_score,confidence_score,stability,recurrence,freshness,status,last_seen_at,metadata').eq('user_id', userId).in('status', ['active', 'needs_review', 'contradicted']).order('importance_score', { ascending: false }).limit(120),
    supabase.from('memory_consolidation_snapshots').select('id,snapshot_type,title,summary,memory_health,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1),
  ]
  if (useRetrieval) {
    baseReads.push(
      supabase.from('brain_nodes').select('id,type,name,canonical_name,summary,description,importance_score,confidence_score,last_seen_at,metadata').eq('user_id', userId).limit(300),
      supabase.from('brain_edges').select('id,from_node_id,to_node_id,relation_type,summary,weight,confidence_score,metadata').eq('user_id', userId).limit(300),
      supabase.from('agent_memories').select('id,memory_type,content,importance_level,stability,sensitivity,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(150),
      supabase.from('raw_entries').select('id,title,content,happened_at,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(80),
    )
  }
  const [factsRes, snapshotsRes, patternsRes, hintsRes, conflictsRes, longTermRes, memorySnapshotsRes, nodesRes = {}, edgesRes = {}, memoriesRes = {}, rawRes = {}] = await Promise.all(baseReads)
  for (const res of [factsRes, snapshotsRes, patternsRes, hintsRes, conflictsRes, longTermRes, memorySnapshotsRes, nodesRes, edgesRes, memoriesRes, rawRes]) {
    if (res.error && res.error.code !== '42P01') throw res.error
  }
  return {
    identityFacts: factsRes.error?.code === '42P01' ? [] : factsRes.data ?? [],
    identitySnapshots: snapshotsRes.error?.code === '42P01' ? [] : snapshotsRes.data ?? [],
    communicationPatterns: patternsRes.error?.code === '42P01' ? [] : patternsRes.data ?? [],
    ownerCalibrationHints: hintsRes.error?.code === '42P01' ? [] : hintsRes.data ?? [],
    identityConflicts: conflictsRes.error?.code === '42P01' ? [] : conflictsRes.data ?? [],
    longTermMemories: longTermRes.error?.code === '42P01' ? [] : longTermRes.data ?? [],
    memoryConsolidationSnapshots: memorySnapshotsRes.error?.code === '42P01' ? [] : memorySnapshotsRes.data ?? [],
    nodes: nodesRes.error?.code === '42P01' ? [] : nodesRes.data ?? [],
    edges: edgesRes.error?.code === '42P01' ? [] : edgesRes.data ?? [],
    memories: memoriesRes.error?.code === '42P01' ? [] : memoriesRes.data ?? [],
    rawEntries: rawRes.error?.code === '42P01' ? [] : rawRes.data ?? [],
    query,
  }
}

function buildMemoryRefs(question, brain, intent) {
  const tokens = tokenize(question)
  const nodeById = new Map((brain.nodes ?? []).map((node) => [node.id, node]))
  const refs = [
    ...(brain.memories ?? []).map((item) => ({ type: 'agent_memory', id: item.id, label: item.memory_type, excerpt: excerpt(item.content, 260), score: scoreText([item.content, item.memory_type, item.importance_level], tokens) + importanceScore(item.importance_level) })),
    ...(brain.longTermMemories ?? []).map((item) => ({ type: 'long_term_memory', id: item.id, label: item.title, excerpt: excerpt(item.canonical_statement ?? item.summary, 260), freshness: item.freshness, status: item.status, score: scoreText([item.title, item.canonical_statement, item.summary, item.memory_type], tokens) + Number(item.importance_score ?? 0) * 25 + Number(item.confidence_score ?? 0) * 15 })),
    ...(brain.nodes ?? []).map((item) => ({ type: 'brain_node', id: item.id, label: item.name, excerpt: excerpt(item.summary ?? item.description, 260), score: scoreText([item.name, item.canonical_name, item.summary, item.description], tokens) + Number(item.confidence_score ?? 0) * 10 })),
    ...(brain.edges ?? []).map((item) => ({ type: 'brain_edge', id: item.id, label: `${nodeById.get(item.from_node_id)?.name ?? item.from_node_id} -> ${item.relation_type} -> ${nodeById.get(item.to_node_id)?.name ?? item.to_node_id}`, excerpt: excerpt(item.summary, 260), score: scoreText([item.relation_type, item.summary], tokens) + Number(item.confidence_score ?? 0) * 10 })),
    ...(brain.rawEntries ?? []).map((item) => ({ type: 'raw_entry', id: item.id, label: item.title || item.happened_at || item.created_at || 'Raw entry', excerpt: excerpt(item.content, 260), score: scoreText([item.title, item.content], tokens) })),
  ]
  const bonus = ['strategy_question', 'identity_question', 'contradiction_check'].includes(intent) ? 5 : 0
  return refs
    .map((ref) => ({ ...ref, score: ref.score + bonus }))
    .filter((ref) => ref.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, intent === 'request_prompt' ? 8 : 14)
    .map(({ score, ...ref }) => ({ ...ref, relevance_score: Number(Math.min(1, score / 100).toFixed(4)) }))
}

function selectLongTermMemories(intent, question, memories = []) {
  if (['social_greeting', 'casual_reply', 'correction'].includes(intent)) return []
  const normalized = normalizeWords(question)
  return memories
    .filter((memory) => !['archived', 'deprecated', 'merged'].includes(memory.status ?? 'active'))
    .map((memory) => {
      const haystack = normalizeWords([memory.title, memory.canonical_statement, memory.summary, memory.memory_type].join(' '))
      let score = Number(memory.importance_score ?? 0.4) * 40 + Number(memory.confidence_score ?? 0.4) * 25
      if (['identity_question', 'strategy_question', 'contradiction_check'].includes(intent) && ['core_identity', 'recurring_pattern', 'long_term_goal', 'decision_pattern', 'risk_pattern', 'conflict_context'].includes(memory.memory_type)) score += 25
      for (const token of normalized.split(' ').filter((item) => item.length > 3)) if (haystack.includes(token)) score += 7
      if (memory.status === 'needs_review') score -= 18
      if (memory.freshness === 'stale') score -= 12
      if (memory.stability === 'core') score += 14
      return { memory, score }
    })
    .filter(({ score }) => score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ memory }) => memory)
}

function freshnessWarnings(memories = []) {
  const warnings = []
  for (const memory of memories) {
    if (memory.freshness === 'stale') warnings.push(`Long-term memory "${memory.title}" stale; gunakan sebagai konteks historis, bukan fakta current.`)
    if (memory.status === 'needs_review') warnings.push(`Long-term memory "${memory.title}" masih needs_review; jangan jadikan klaim tegas.`)
    if (Array.isArray(memory.related_conflict_ids) && memory.related_conflict_ids.length) warnings.push(`Long-term memory "${memory.title}" terkait identity conflict; jawab dengan nuansa.`)
  }
  return uniqueStrings(warnings)
}

async function answerWithInference(context, options) {
  if (context.intent_type === 'social_greeting') return deterministicAnswer(context)
  if (!shouldUseLLM(options)) return deterministicAnswer(context)
  try {
    return await callLLM(context)
  } catch (err) {
    const fallback = deterministicAnswer(context)
    fallback.warnings = [...(fallback.warnings ?? []), `LLM fallback: ${err instanceof Error ? err.message : String(err)}`]
    return fallback
  }
}

async function callLLM(context) {
  const provider = resolvedProvider()
  const prompt = buildInferencePrompt(context)
  if (provider === 'claude-code') {
    const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
    const output = await runCommand(command, [
      ...(process.env.CLAUDE_CODE_BARE === 'false' ? [] : ['--bare']),
      '--no-session-persistence',
      '--output-format',
      'text',
      '-p',
      prompt,
    ], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
    return parseJsonOrThrow(output, 'Claude Code')
  }
  if (provider === 'anthropic') {
    const baseUrl = requiredEnv('RESPONSE_INFERENCE_BASE_URL', process.env.COMMUNICATION_BASE_URL ?? process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('RESPONSE_INFERENCE_API_KEY', process.env.COMMUNICATION_API_KEY ?? process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
    const model = requiredEnv('RESPONSE_INFERENCE_MODEL', process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL)
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 3500, system: RESPONSE_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildInferenceUserPrompt(context) }] }),
    })
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    const text = Array.isArray(data.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
    return parseJsonOrThrow(text, 'Anthropic')
  }
  if (provider === 'openai') {
    const baseUrl = requiredEnv('RESPONSE_INFERENCE_BASE_URL', process.env.COMMUNICATION_BASE_URL ?? process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('RESPONSE_INFERENCE_API_KEY', process.env.COMMUNICATION_API_KEY ?? process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY)
    const model = requiredEnv('RESPONSE_INFERENCE_MODEL', process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL)
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: RESPONSE_SYSTEM_PROMPT }, { role: 'user', content: buildInferenceUserPrompt(context) }] }),
    })
    if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    return parseJsonOrThrow(data?.choices?.[0]?.message?.content ?? '', 'OpenAI-compatible')
  }
  if (provider === 'ollama') {
    const baseUrl = (process.env.RESPONSE_INFERENCE_BASE_URL || process.env.COMMUNICATION_BASE_URL || process.env.IDENTITY_BASE_URL || process.env.BRAIN_CHAT_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
    const model = requiredEnv('RESPONSE_INFERENCE_MODEL', process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.OLLAMA_MODEL)
    const res = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt, stream: false, format: 'json' }) })
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    return parseJsonOrThrow(data.response ?? '', 'Ollama')
  }
  throw new Error(`Unsupported RESPONSE_INFERENCE_PROVIDER: ${provider}`)
}

function deterministicAnswer(context) {
  const intent = context.intent_type
  if (intent === 'social_greeting') {
    const hinted = preferredGreetingFromHints(context)
    return {
      answer: hinted || greetingFallback(context.question),
      confidence_score: 0.72,
      fidelity_score: 0.68,
      groundedness_score: 0.75,
      style_match_score: 0.7,
      overclaim_risk: 0.05,
      underfit_risk: 0.2,
      missing_context: [],
      warnings: [],
      inference_trace: { intent_type: intent, reasoning_summary: traceSummary(intent), identity_used: [], communication_patterns_used: context.communication_patterns.map((p) => p.id) },
    }
  }
  if (intent === 'request_prompt') {
    return { answer: promptTemplate(context.question, context.owner_calibration_hints), confidence_score: 0.62, fidelity_score: 0.62, groundedness_score: 0.55, style_match_score: 0.66, overclaim_risk: 0.12, underfit_risk: 0.18, missing_context: [], warnings: [], inference_trace: baseTrace(context) }
  }
  if (intent === 'correction') {
    return { answer: 'Oke, saya revisi langsung. Bagian yang harus dibenerin: bikin lebih sesuai arah kamu, kurangi penjelasan yang tidak perlu, dan hasil akhirnya harus lebih siap dipakai.', confidence_score: 0.58, fidelity_score: 0.6, groundedness_score: 0.5, style_match_score: 0.64, overclaim_risk: 0.1, underfit_risk: 0.18, missing_context: [], warnings: [], inference_trace: baseTrace(context) }
  }
  if (intent === 'strategy_question') {
    const facts = context.identity_facts.slice(0, 5).map((fact) => fact.statement).filter(Boolean)
    const longTerm = context.long_term_memories.slice(0, 4).map((memory) => memory.canonical_statement).filter(Boolean)
    const conflictNote = conflictAnswerPrefix(context.identity_conflicts)
    const basis = [...facts, ...longTerm].length ? [...facts, ...longTerm].join(' ') : 'Data identitas belum cukup kuat, jadi jawaban dibuat konservatif.'
    return { answer: `${conflictNote}Fokus ke 1 hal dulu: bikin sistem yang sudah ada benar-benar dipakai harian. Jangan tambah scope besar dulu. Dari data yang ada, arah paling masuk akal adalah rapikan loop diary -> memory -> chat -> evaluasi, lalu ukur apakah itu membantu keputusan nyata.\n\nBasis singkat: ${basis}`, confidence_score: facts.length || longTerm.length ? 0.64 : 0.48, fidelity_score: facts.length || longTerm.length ? 0.66 : 0.5, groundedness_score: facts.length || longTerm.length ? 0.65 : 0.42, style_match_score: 0.63, overclaim_risk: facts.length ? 0.2 : 0.3, underfit_risk: 0.2, missing_context: facts.length || longTerm.length ? [] : ['Identity facts/long-term memory strategi belum cukup kuat.'], warnings: [], inference_trace: baseTrace(context) }
  }
  if (intent === 'identity_question' || intent === 'contradiction_check') {
    const high = context.identity_facts.filter((fact) => Number(fact.confidence_score ?? 0) >= 0.7).slice(0, 5)
    const medium = context.identity_facts.filter((fact) => Number(fact.confidence_score ?? 0) < 0.7).slice(0, 5)
    const coreMemories = context.long_term_memories.filter((memory) => memory.stability === 'core' && memory.status === 'active').slice(0, 4)
    const coreLine = coreMemories.length ? `\n\nLong-term memory yang stabil: ${coreMemories.map((memory) => memory.canonical_statement).join(' ')}` : ''
    return { answer: `${conflictAnswerPrefix(context.identity_conflicts)}${identityAnswer(high, medium)}${coreLine}`, confidence_score: high.length || coreMemories.length ? 0.66 : 0.42, fidelity_score: high.length || coreMemories.length ? 0.68 : 0.45, groundedness_score: high.length || coreMemories.length ? 0.7 : 0.4, style_match_score: 0.6, overclaim_risk: high.length ? 0.16 : 0.28, underfit_risk: 0.22, missing_context: high.length || coreMemories.length ? [] : ['Identity facts/long-term memory high-confidence belum cukup.'], warnings: [], inference_trace: baseTrace(context) }
  }
  if (intent === 'technical_instruction') {
    return { answer: technicalFallback(context), confidence_score: 0.55, fidelity_score: 0.56, groundedness_score: context.memory_refs.length ? 0.58 : 0.38, style_match_score: 0.6, overclaim_risk: 0.18, underfit_risk: 0.22, missing_context: context.memory_refs.length ? [] : ['Memory teknis spesifik belum cukup.'], warnings: [], inference_trace: baseTrace(context) }
  }
  return { answer: unknownFallback(context), confidence_score: context.memory_refs.length ? 0.5 : 0.35, fidelity_score: 0.48, groundedness_score: context.memory_refs.length ? 0.55 : 0.3, style_match_score: 0.5, overclaim_risk: context.memory_refs.length ? 0.18 : 0.3, underfit_risk: 0.28, missing_context: context.memory_refs.length ? [] : ['Memory yang terambil belum cukup untuk menjawab dengan kuat.'], warnings: [], inference_trace: baseTrace(context) }
}

function applyPostProcessing(raw, context) {
  let answer = typeof raw?.answer === 'string' ? raw.answer.trim() : deterministicAnswer(context).answer
  if (context.intent_type === 'social_greeting') {
    answer = answer
      .replace(/berdasarkan diary/gi, '')
      .replace(/memory yang tersedia/gi, '')
      .replace(/identity facts/gi, '')
      .replace(/sources/gi, '')
      .replace(/context/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    answer = firstSentence(answer) || greetingFallback(context.question)
  }
  if (['social_greeting', 'casual_reply'].includes(context.intent_type)) answer = firstSentence(answer)
  if (hasUnsupportedIdentityClaim(answer, context)) {
    return { ...raw, answer: 'Data belum cukup untuk ngomong itu sebagai fakta.', warnings: [...arrayOfStrings(raw?.warnings), 'Potential unsupported identity claim downgraded.'] }
  }
  return { ...raw, answer }
}

function calculateInferenceRisk({ intent, answer, identityFactsUsed, communicationPatternsUsed, memoryRefsUsed, rawScores }) {
  const identityClaim = /\bsaya\s+(adalah|orang|selalu|tidak pernah|pasti|suka|benci|ingin|takut)\b/i.test(answer)
  const rawOverclaim = clampNumber(rawScores?.overclaim_risk, 0, 1, null)
  const rawUnderfit = clampNumber(rawScores?.underfit_risk, 0, 1, null)
  const overclaim = rawOverclaim ?? (identityClaim && identityFactsUsed === 0 ? 0.55 : intent === 'social_greeting' ? 0.05 : 0.18)
  const underfit = rawUnderfit ?? (/\bberdasarkan|sebagai ai|saya sarankan|berikut adalah\b/i.test(answer) ? 0.42 : communicationPatternsUsed ? 0.15 : 0.24)
  const groundedness = clampNumber(rawScores?.groundedness_score, 0, 1, intent === 'social_greeting' ? 0.75 : Math.min(0.9, 0.42 + memoryRefsUsed * 0.04 + identityFactsUsed * 0.03))
  const confidence = clampNumber(rawScores?.confidence_score, 0, 1, 0.74 - overclaim * 0.35 - underfit * 0.2)
  return {
    confidence_score: round4(confidence),
    fidelity_score: round4(clampNumber(rawScores?.fidelity_score, 0, 1, 0.72 - overclaim * 0.3 - underfit * 0.25)),
    groundedness_score: round4(groundedness),
    style_match_score: round4(clampNumber(rawScores?.style_match_score, 0, 1, 0.74 - underfit * 0.35)),
    overclaim_risk: round4(overclaim),
    underfit_risk: round4(underfit),
  }
}

function detectIntent(question) {
  const normalized = normalizeWords(question)
  if ([/^hi+$/, /^halo+$/, /^hai+$/, /^p+$/, /^bro+$/, /^ping$/, /^assalamu\s?alaikum/, /^assalamualaikum/, /^selamat pagi$/, /^selamat malam$/].some((pattern) => pattern.test(normalized))) return 'social_greeting'
  if (containsAny(normalized, ['buatkan prompt', 'prompt untuk', 'siap paste', 'buat prompt', 'revisi prompt'])) return 'request_prompt'
  if (containsAny(normalized, ['cara', 'error', 'command', 'file', 'implementasi', 'bug', 'script', 'kode', 'migration', 'supabase', 'frontend', 'backend'])) return 'technical_instruction'
  if (containsAny(normalized, ['menurutmu', 'fokus apa', 'langkah terbaik', 'lanjut apa', 'stop atau lanjut', 'prioritas', 'strategi'])) return 'strategy_question'
  if (containsAny(normalized, ['kurang', 'revisi', 'belum sesuai', 'ubah', 'salah', 'jangan begitu'])) return 'correction'
  if (containsAny(normalized, ['saya orang seperti apa', 'pola saya', 'gaya saya', 'sifat saya', 'tentang saya'])) return 'identity_question'
  if (containsAny(normalized, ['kontradiksi', 'saya bilang tapi tidak saya lakukan', 'pola buruk', 'yang saya romantisasi'])) return 'contradiction_check'
  return 'unknown'
}

function buildResponseShape(intent, communicationPatterns = []) {
  const defaults = {
    social_greeting: { intent_type: 'social_greeting', max_sentences: 1, show_sources: false, show_basis: false, show_missing_context: false, show_next_actions: false, tone: 'short_casual_direct', format: 'plain_text' },
    casual_reply: { intent_type: 'casual_reply', max_sentences: 1, show_sources: false, show_basis: false, show_missing_context: false, show_next_actions: false, tone: 'short_casual_direct', format: 'plain_text' },
    request_prompt: { intent_type: 'request_prompt', max_sentences_before_artifact: 2, show_sources: false, show_basis: false, show_missing_context: false, tone: 'direct_structured', format: 'writing_block', structure: 'implementation_prompt' },
    technical_instruction: { intent_type: 'technical_instruction', max_sections: 5, show_sources: true, show_basis: true, show_missing_context: true, tone: 'direct_technical', format: 'structured_answer' },
    strategy_question: { intent_type: 'strategy_question', max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'direct_strategic', format: 'structured_answer' },
    correction: { intent_type: 'correction', max_sections: 3, show_sources: false, show_basis: false, show_missing_context: false, tone: 'direct_revision', format: 'plain_text' },
    identity_question: { intent_type: 'identity_question', max_sections: 3, show_sources: true, show_basis: true, show_missing_context: true, tone: 'careful_identity', format: 'structured_answer' },
    contradiction_check: { intent_type: 'contradiction_check', max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'evidence_based_direct', format: 'structured_answer' },
    unknown: { intent_type: 'unknown', max_sections: 4, show_sources: true, show_basis: true, show_missing_context: true, tone: 'normal_brain_chat', format: 'structured_answer' },
  }
  const base = defaults[intent] ?? defaults.unknown
  return communicationPatterns.reduce((shape, pattern) => ({ ...shape, ...(isPlainObject(pattern.preferred_response_shape) ? pattern.preferred_response_shape : {}) }), base)
}

function selectIdentityFacts(intent, facts) {
  const wanted = {
    social_greeting: ['communication_pattern'],
    request_prompt: ['communication_pattern', 'preference', 'decision_pattern'],
    technical_instruction: ['communication_pattern', 'preference', 'decision_pattern'],
    strategy_question: ['goal', 'risk_pattern', 'decision_pattern', 'contradiction', 'ambition', 'value'],
    correction: ['communication_pattern', 'preference'],
    identity_question: ['trait', 'belief', 'value', 'preference', 'goal', 'fear', 'ambition', 'decision_pattern', 'communication_pattern', 'emotional_pattern', 'risk_pattern', 'contradiction', 'boundary', 'identity_summary'],
    contradiction_check: ['contradiction', 'risk_pattern', 'decision_pattern'],
    unknown: ['identity_summary', 'preference', 'goal'],
  }[intent] ?? ['identity_summary']
  return (facts ?? [])
    .map((fact) => ({ fact, score: (wanted.includes(fact.fact_type) ? 60 : 0) + Number(fact.confidence_score ?? 0.45) * 40 }))
    .filter(({ score }) => score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, intent === 'social_greeting' ? 3 : 14)
    .map(({ fact }) => fact)
}

function selectCommunicationPatterns(intent, patterns) {
  return (patterns ?? [])
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

function selectCalibrationHints(intent, question, hints) {
  const normalized = normalizeWords(question)
  return (hints ?? [])
    .filter((hint) => hint.intent_type === intent || hint.intent_type === 'unknown')
    .filter((hint) => !['rejected', 'deprecated'].includes(hint.status))
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

function applyCalibrationShape(shape, hints) {
  return (hints ?? []).reduce((next, hint) => ({
    ...next,
    ...(isPlainObject(hint.response_shape_patch) ? hint.response_shape_patch : {}),
  }), shape)
}

function selectIdentityConflicts(intent, question, conflicts) {
  if (['social_greeting', 'casual_reply', 'correction'].includes(intent)) return []
  const normalized = normalizeWords(question)
  const topicBoost = ['strategy_question', 'identity_question', 'contradiction_check'].includes(intent) ? 25 : 0
  return (conflicts ?? [])
    .filter((conflict) => !['resolved', 'dismissed'].includes(conflict.resolution_status))
    .map((conflict) => {
      const haystack = normalizeWords([conflict.title, conflict.summary, conflict.side_a_statement, conflict.side_b_statement, conflict.impact_area, conflict.conflict_type].join(' '))
      let score = topicBoost + Number(conflict.side_a_confidence ?? 0.5) * 15 + Number(conflict.side_b_confidence ?? 0.5) * 15
      if (conflict.severity === 'critical') score += 35
      if (conflict.severity === 'high') score += 25
      if (conflict.recurrence === 'core_tension') score += 20
      for (const token of tokenize(normalized)) if (token.length > 3 && haystack.includes(token)) score += 8
      if (/\b(tambah fitur|fitur|scope|fokus|lanjut|roadmap|mvp|validasi)\b/.test(normalized) && /fokus|fitur|scope|mvp|blueprint|roadmap/.test(haystack)) score += 50
      if (/\b(kontradiksi|tension|berlawanan|tidak konsisten)\b/.test(normalized)) score += 45
      return { conflict, score }
    })
    .filter(({ score }) => score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ conflict }) => conflict)
}

function shouldUseRetrieval(intent) {
  return !['social_greeting', 'casual_reply', 'correction'].includes(intent)
}

function buildInferenceContext(input) {
  return {
    question: input.question,
    normalized_question: normalizeWords(input.question),
    intent_type: input.intent,
    inference_mode: input.inferenceMode,
    response_shape: input.responseShape,
    identity_facts: input.identityFacts ?? [],
    identity_conflicts: input.identityConflicts ?? [],
    long_term_memories: input.longTermMemories ?? [],
    memory_consolidation_snapshot: input.memoryConsolidationSnapshot ?? null,
    identity_snapshots: input.identitySnapshots ?? [],
    communication_patterns: input.communicationPatterns ?? [],
    owner_calibration_hints: input.calibrationHints ?? [],
    memory_refs: input.memoryRefs ?? [],
    retrieval_summary: input.retrievalSummary ?? {},
  }
}

function buildInferencePrompt(context) {
  return `${RESPONSE_SYSTEM_PROMPT}

${buildInferenceUserPrompt(context)}`
}

function buildInferenceUserPrompt(context) {
  return `INFERENCE CONTEXT:
${JSON.stringify(context, null, 2)}

Balas hanya JSON valid dengan bentuk:
{
  "answer": "jawaban akhir",
  "confidence_score": 0.72,
  "fidelity_score": 0.68,
  "groundedness_score": 0.75,
  "style_match_score": 0.7,
  "overclaim_risk": 0.05,
  "underfit_risk": 0.2,
  "missing_context": [],
  "warnings": [],
  "inference_trace": {
    "intent_type": "${context.intent_type}",
    "reasoning_summary": "ringkasan singkat",
    "identity_used": [],
    "communication_patterns_used": []
  }
}`
}

function inferenceModeForIntent(intent) {
  if (intent === 'social_greeting' || intent === 'casual_reply') return 'direct_social_response'
  if (intent === 'request_prompt') return 'prompt_generation_answer'
  if (intent === 'strategy_question' || intent === 'decision_help') return 'strategic_mirror_answer'
  if (intent === 'identity_question' || intent === 'personal_reflection' || intent === 'contradiction_check') return 'identity_based_answer'
  if (intent === 'correction') return 'correction_response'
  if (intent === 'technical_instruction') return 'communication_style_answer'
  return 'factual_brain_answer'
}

function defaultRules(userId) {
  const common = { user_id: userId, enabled: true, metadata: { initialized_by: 'response-inference.mjs' } }
  return [
    { ...common, intent_type: 'social_greeting', rule_name: 'social greeting', description: 'Sapaan ringan dijawab pendek natural tanpa retrieval, sources, atau missing context.', trigger_patterns: ['hi', 'halo', 'hai', 'p', 'bro', 'assalamu’alaikum', 'selamat pagi', 'selamat malam', 'ping'], required_context: ['communication_patterns_optional'], response_shape: buildResponseShape('social_greeting'), priority: 10 },
    { ...common, intent_type: 'request_prompt', rule_name: 'request prompt', description: 'Request prompt langsung menghasilkan prompt siap paste, lengkap, step-by-step, dan minim teori.', trigger_patterns: ['buatkan prompt', 'prompt untuk', 'siap paste', 'buat prompt', 'revisi prompt'], required_context: ['communication_patterns', 'identity_facts_optional'], response_shape: buildResponseShape('request_prompt'), priority: 20 },
    { ...common, intent_type: 'technical_instruction', rule_name: 'technical instruction', description: 'Instruksi teknis dijawab step-by-step dengan command/file bila perlu.', trigger_patterns: ['cara', 'error', 'command', 'file', 'implementasi', 'bug', 'script', 'kode', 'migration', 'supabase', 'frontend', 'backend'], required_context: ['memory_refs_optional', 'communication_patterns'], response_shape: buildResponseShape('technical_instruction'), priority: 30 },
    { ...common, intent_type: 'strategy_question', rule_name: 'strategy question', description: 'Pertanyaan strategi memakai goals, risk patterns, decision patterns, dan contradictions.', trigger_patterns: ['menurutmu', 'fokus apa', 'langkah terbaik', 'lanjut apa', 'stop atau lanjut', 'prioritas', 'strategi'], required_context: ['identity_facts', 'memory_refs_optional'], response_shape: buildResponseShape('strategy_question'), priority: 30 },
    { ...common, intent_type: 'correction', rule_name: 'correction', description: 'Koreksi dijawab tidak defensif dan langsung revisi.', trigger_patterns: ['kurang', 'revisi', 'belum sesuai', 'ubah', 'salah', 'jangan begitu'], required_context: ['conversation_context_optional'], response_shape: buildResponseShape('correction'), priority: 15 },
    { ...common, intent_type: 'identity_question', rule_name: 'identity question', description: 'Pertanyaan identitas memakai identity facts dan memisahkan high, medium, dan belum cukup data.', trigger_patterns: ['saya orang seperti apa', 'pola saya', 'gaya saya', 'sifat saya', 'tentang saya'], required_context: ['identity_facts', 'identity_snapshots_optional'], response_shape: buildResponseShape('identity_question'), priority: 35 },
    { ...common, intent_type: 'unknown', rule_name: 'insufficient memory', description: 'Intent unknown memakai normal brain retrieval dan jujur jika data kurang.', trigger_patterns: [], required_context: ['memory_refs_optional'], response_shape: buildResponseShape('unknown'), priority: 100 },
  ]
}

function greetingFallback(question) {
  const normalized = normalizeWords(question)
  if (/^assalamu\s?alaikum/.test(normalized) || normalized === 'assalamualaikum') return 'Wa’alaikumussalam, ada apa?'
  if (/^p+$/.test(normalized) || normalized === 'ping') return 'Iya, kenapa?'
  if (/^bro+$/.test(normalized)) return 'Iya bro, kenapa?'
  if (normalized === 'selamat pagi') return 'Pagi, ada apa?'
  if (normalized === 'selamat malam') return 'Malam, ada apa?'
  return 'Halo, kenapa?'
}

function preferredGreetingFromHints(context) {
  const normalized = normalizeWords(context.question)
  const hint = (context.owner_calibration_hints ?? []).find((item) => {
    if (item.hint_type !== 'greeting_reply' || Number(item.confidence_score ?? 0) < 0.6) return false
    const triggers = Array.isArray(item.trigger_patterns) ? item.trigger_patterns : []
    return triggers.length === 0 || triggers.some((trigger) => normalized.includes(normalizeWords(trigger)) || normalizeWords(trigger).includes(normalized))
  })
  const preferred = Array.isArray(hint?.preferred_response) ? hint.preferred_response : []
  const answer = preferred.find((item) => typeof item === 'string' && item.trim())
  return answer ? firstSentence(answer.trim()) : null
}

function promptTemplate(question, hints = []) {
  const promptStructureHint = hints.find((hint) => hint.hint_type === 'prompt_structure' && Number(hint.confidence_score ?? 0) >= 0.6)
  const criteriaLine = promptStructureHint ? '- Ikuti calibration hint: prompt harus siap paste, step-by-step, punya acceptance criteria, dan batasan jelas.' : '- Output harus siap dieksekusi oleh coding agent.'
  return `Pakai prompt ini:

\`\`\`text
Tugas:
Buatkan step berikutnya untuk project yang sedang saya kerjakan.

Konteks:
- Saya sedang membangun Personal Entity OS / Personal Brain OS.
${criteriaLine}
- Jangan terlalu banyak teori.
- Jangan membuat scope melebar tanpa alasan.

Instruksi:
1. Baca konteks project yang tersedia.
2. Tentukan tujuan step berikutnya secara spesifik.
3. Buat perubahan yang diperlukan di file/migration/script/UI jika relevan.
4. Pastikan perubahan tetap read-only terhadap brain utama kecuali memang diminta.
5. Tambahkan validasi, audit, dan dokumentasi singkat.
6. Jalankan test/build yang relevan.

Acceptance criteria:
- Fitur berjalan dari CLI atau UI sesuai kebutuhan.
- Tidak ada secret masuk bundle.
- Tidak ada perubahan destruktif ke data utama.
- Dokumentasi diperbarui.
- Build lolos.

Prompt asal user:
${question}
\`\`\``
}

function identityAnswer(high, medium) {
  const lines = []
  lines.push('Yang high confidence:')
  lines.push(...(high.length ? high.map((fact) => `- ${fact.statement}`) : ['- Belum cukup data high-confidence.']))
  lines.push('')
  lines.push('Yang masih medium:')
  lines.push(...(medium.length ? medium.map((fact) => `- ${fact.statement}`) : ['- Belum ada sinyal medium yang relevan.']))
  lines.push('')
  lines.push('Yang belum cukup data: bagian yang belum punya evidence konsisten jangan dianggap sebagai identitas tetap.')
  return lines.join('\n')
}

function conflictAnswerPrefix(conflicts) {
  const active = (conflicts ?? []).filter(Boolean)
  if (!active.length) return ''
  const conflict = active[0]
  return `Ada tension yang perlu dijaga: ${conflict.side_a_label} vs ${conflict.side_b_label}. Di satu sisi, ${conflict.side_a_statement} Di sisi lain, ${conflict.side_b_statement}\n\n`
}

function technicalFallback(context) {
  const refs = context.memory_refs.slice(0, 5).map((ref) => `- ${ref.label}: ${ref.excerpt}`).join('\n')
  return `Langsung kerjakan begini:

1. Identifikasi file atau modul yang paling dekat dengan masalah.
2. Baca pola existing dulu.
3. Buat perubahan kecil yang menyelesaikan masalah utama.
4. Jalankan command validasi yang relevan.
5. Baru rapikan dokumentasi kalau behavior sudah aman.

${refs ? `Context relevan:\n${refs}` : 'Context spesifik belum cukup, jadi jangan klaim detail yang tidak ada di data.'}`
}

function unknownFallback(context) {
  if (!context.memory_refs.length) return 'Memory yang tersedia belum cukup untuk menjawab ini dengan gaya pemilik diary. Kalau harus jawab sekarang, jawaban paling aman: data belum cukup.'
  return `Dari memory yang ketarik, jawaban paling aman: ${context.memory_refs.slice(0, 4).map((ref) => ref.excerpt).filter(Boolean).join(' ')}`
}

function buildBasis(identityFacts, memoryRefs, longTermMemories = []) {
  return [
    ...identityFacts.slice(0, 4).map((fact) => `Identity fact: ${fact.statement}`),
    ...longTermMemories.slice(0, 4).map((memory) => `Long-term memory (${memory.freshness}): ${memory.canonical_statement}`),
    ...memoryRefs.slice(0, 4).map((ref) => `${ref.type}: ${ref.excerpt}`),
  ].filter(Boolean)
}

function buildSources(identityFacts, memoryRefs, longTermMemories = []) {
  return [
    ...identityFacts.slice(0, 6).map((fact) => ({ type: 'identity_fact', id: fact.id, label: `${fact.fact_type}: ${fact.label}`, excerpt: excerpt(fact.statement, 180) })),
    ...longTermMemories.slice(0, 6).map((memory) => ({ type: 'long_term_memory', id: memory.id, label: `${memory.memory_type}: ${memory.title}`, excerpt: excerpt(memory.canonical_statement, 180) })),
    ...memoryRefs.slice(0, 8).map((ref) => ({ type: ref.type, id: ref.id, label: ref.label, excerpt: excerpt(ref.excerpt, 180) })),
  ]
}

async function insertInferenceLog(supabase, payload) {
  if (!readBoolEnv('RESPONSE_INFERENCE_LOGS_ENABLED', true)) return null
  const { data, error } = await supabase.from('response_inference_logs').insert(payload).select('id').single()
  if (error) {
    if (error.code === '42P01') return null
    throw error
  }
  return data?.id ?? null
}

async function createSupabaseClient() {
  const url = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceKey) return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined })
  if (!accessToken && process.env.SUPABASE_USER_EMAIL && process.env.SUPABASE_USER_PASSWORD) {
    const { error } = await client.auth.signInWithPassword({ email: process.env.SUPABASE_USER_EMAIL, password: process.env.SUPABASE_USER_PASSWORD })
    if (error) throw error
  }
  return client
}

async function resolveUserId(supabase) {
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  const authUser = await supabase.auth.getUser().catch(() => null)
  if (authUser?.data?.user?.id) return authUser.data.user.id
  for (const table of ['raw_entries', 'identity_facts', 'communication_patterns', 'brain_nodes']) {
    const { data, error } = await supabase.from(table).select('user_id').limit(1).maybeSingle()
    if (!error && data?.user_id) return data.user_id
  }
  return null
}

function writeObsidianReport(report) {
  const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
  const path = resolve(vaultPath, '_system', 'response-inference', 'Response Inference Report.md')
  mkdirSync(dirname(path), { recursive: true })
  const body = [
    '# Response Inference Report',
    '',
    '<!-- RESPONSE_INFERENCE_AUTO_START -->',
    `Generated: ${new Date().toISOString()}`,
    `Status: ${report.status}`,
    `Score: ${report.score}`,
    '',
    '## Rule Summary',
    `Rules available: ${report.checks.rules_available}`,
    `Greeting active: ${report.checks.greeting_rule_active ? 'yes' : 'no'}`,
    `Request prompt active: ${report.checks.request_prompt_rule_active ? 'yes' : 'no'}`,
    '',
    '## Latest Inference Logs',
    ...(report.checks.latest_logs ?? []).map((log) => `- ${log.created_at}: ${log.intent_type} / ${log.inference_mode}`),
    '',
    '## High Overclaim Risks',
    ...(report.checks.high_overclaim_risk_logs ?? []).map((log) => `- ${log.created_at}: ${log.overclaim_risk} — ${log.question}`),
    '',
    '## High Underfit Risks',
    ...(report.checks.high_underfit_risk_logs ?? []).map((log) => `- ${log.created_at}: ${log.underfit_risk} — ${log.question}`),
    '',
    '## Recommendations',
    ...(report.recommended_fixes ?? []).map((item) => `- ${item}`),
    '<!-- RESPONSE_INFERENCE_AUTO_END -->',
    '',
  ].join('\n')
  writeFileSync(path, body, 'utf8')
}

function mapPersonaMode(mode) {
  if (mode === 'direct_social_response') return 'social_response'
  if (mode === 'strategic_mirror_answer') return 'strategic_mirror'
  if (mode === 'identity_based_answer') return 'self_clone_reflection'
  if (mode === 'insufficient_memory_response') return 'unknown_or_insufficient_memory'
  return 'factual_brain_reader'
}

function baseTrace(context) {
  return { intent_type: context.intent_type, reasoning_summary: traceSummary(context.intent_type), identity_used: context.identity_facts.map((fact) => fact.id), identity_conflicts_used: (context.identity_conflicts ?? []).map((conflict) => conflict.id), communication_patterns_used: context.communication_patterns.map((pattern) => pattern.id), calibration_hints_used: (context.owner_calibration_hints ?? []).map((hint) => hint.id) }
}

function traceSummary(intent) {
  const summaries = {
    social_greeting: 'Prompt adalah sapaan ringan, jadi jawaban dibuat satu kalimat tanpa retrieval berat.',
    request_prompt: 'Prompt meminta artifact siap paste, jadi jawaban utama berbentuk writing block.',
    technical_instruction: 'Prompt teknis membutuhkan instruksi langsung dan validasi.',
    strategy_question: 'Prompt strategi memakai identity facts untuk prioritas tajam dan tidak melebar.',
    correction: 'Prompt koreksi harus dijawab tidak defensif dan langsung revisi.',
    identity_question: 'Prompt identitas harus evidence-based dan memisahkan confidence.',
    contradiction_check: 'Prompt kontradiksi harus fokus ke pola perilaku berbasis evidence.',
    unknown: 'Intent tidak spesifik, jadi engine memakai retrieval normal dan guard insufficient memory.',
  }
  return summaries[intent] ?? summaries.unknown
}

function hasUnsupportedIdentityClaim(answer, context) {
  if (context.intent_type === 'social_greeting') return false
  if ((context.identity_facts?.length ?? 0) > 0) return false
  return /\bsaya\s+(adalah|selalu|tidak pernah|pasti|orang yang)\b/i.test(answer)
}

function riskWarnings(scores) {
  const warnings = []
  if (scores.overclaim_risk > Number(process.env.RESPONSE_INFERENCE_MAX_OVERCLAIM_RISK ?? 0.3)) warnings.push('Overclaim risk tinggi; jawaban perlu dibaca sebagai kemungkinan, bukan fakta keras.')
  if (scores.confidence_score < Number(process.env.RESPONSE_INFERENCE_MIN_CONFIDENCE ?? 0.55)) warnings.push('Confidence response inference di bawah threshold.')
  if (scores.underfit_risk > 0.35) warnings.push('Underfit risk tinggi; jawaban mungkin masih terlalu assistant-like.')
  return warnings
}

function conflictWarnings(conflicts) {
  return (conflicts ?? [])
    .filter((conflict) => ['high', 'critical'].includes(conflict.severity) || conflict.recurrence === 'core_tension')
    .map((conflict) => `Active identity conflict: ${conflict.title}. Jangan memilih satu sisi tanpa evidence kuat.`)
}

function recommendedFixes(warnings) {
  if (!warnings.length) return ['Tidak ada fix wajib. Lanjutkan kalibrasi dari log inference baru.']
  return warnings.map((warning) => {
    if (warning.includes('Rule')) return 'Jalankan npm run response:rules untuk mengisi default deterministic rules.'
    if (warning.includes('communication_patterns')) return 'Jalankan npm run communication:build agar style matching lebih kuat.'
    if (warning.includes('identity_facts')) return 'Jalankan npm run identity:build agar jawaban strategi dan identitas lebih grounded.'
    if (warning.includes('overclaim')) return 'Review log overclaim dan tambah identity evidence atau turunkan klaim.'
    if (warning.includes('underfit')) return 'Tambah communication samples untuk intent yang masih terasa seperti assistant umum.'
    return 'Review warning dan log terbaru.'
  })
}

function resolvedProvider() {
  return (process.env.RESPONSE_INFERENCE_PROVIDER || process.env.COMMUNICATION_PROVIDER || process.env.IDENTITY_PROVIDER || process.env.BRAIN_CHAT_PROVIDER || process.env.LLM_PROVIDER || 'claude-code').toLowerCase()
}

function shouldUseLLM(options) {
  if (options.useLLM === false) return false
  return readBoolEnv('RESPONSE_INFERENCE_USE_LLM', true) && resolvedProvider() !== 'disabled'
}

function cliOptions(args) {
  return { userId: readOptionalArg(args, 'user-id'), useLLM: args.has('no-llm') ? false : undefined, source: 'cli' }
}

function parseOutput(output) {
  return parseJsonOrThrow(output, 'worker')
}

function parseJsonOrThrow(text, label) {
  const trimmed = String(text ?? '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error(`${label} tidak menghasilkan JSON valid: ${trimmed.slice(0, 500)}`)
  }
}

function runCommand(command, args, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timeout setelah ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${command} exit ${code}: ${output.slice(0, 1000)}`))
    })
  })
}

function scoreText(values, tokens) {
  if (!tokens.length) return 0
  const text = normalizeWords(values.filter(Boolean).join(' '))
  let hits = 0
  for (const token of tokens) if (text.includes(token)) hits += 1
  return (hits / tokens.length) * 80
}

function importanceScore(value) {
  if (value === 'core') return 20
  if (value === 'important') return 14
  return 5
}

function tokenize(value) {
  return normalizeWords(value).split(' ').filter((token) => token.length > 2)
}

function containsAny(value, needles) {
  return needles.some((needle) => value.includes(normalizeWords(needle)))
}

function normalizeWords(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function firstSentence(value) {
  return String(value ?? '').split(/(?<=[.!?])\s+/)[0]?.trim() ?? ''
}

function excerpt(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []
}

function uniqueStrings(value) {
  return [...new Set(arrayOfStrings(value))]
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

function round4(value) {
  return Number(clampNumber(value, 0, 1, 0).toFixed(4))
}

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`${name} belum diset.`)
  return value
}

function readBoolEnv(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args.set(key, next)
      i += 1
    } else {
      args.set(key, true)
    }
  }
  return args
}

function readArg(args, name) {
  const value = args.get(name)
  return typeof value === 'string' ? value : ''
}

function readOptionalArg(args, name) {
  const value = args.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function loadEnv(path, options = {}) {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const index = trimmed.indexOf('=')
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (options.override || process.env[key] === undefined) process.env[key] = value
  }
}
