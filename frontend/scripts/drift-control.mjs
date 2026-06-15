import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const INTENTS = ['social_greeting','casual_reply','request_prompt','technical_instruction','strategy_question','correction','identity_question','contradiction_check','decision_help','personal_reflection','unknown']
const AUTO_START = '<!-- DRIFT_CONTROL_AUTO_START -->'
const AUTO_END = '<!-- DRIFT_CONTROL_AUTO_END -->'

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.has('rules')) console.log(JSON.stringify(args.has('seed') ? await seedDriftRules({ force: args.get('force') === 'true' }) : await listDriftRules(), null, 2))
    else if (args.has('baseline')) console.log(JSON.stringify(await createDriftBaseline({ activate: args.has('activate') || args.has('create') }), null, 2))
    else if (args.has('audit')) console.log(JSON.stringify(await auditDriftControl(), null, 2))
    else if (args.has('latest')) console.log(JSON.stringify(await getLatestDriftControl(), null, 2))
    else console.log(JSON.stringify(await checkDrift({
      question: readRequiredArg(args, 'question'),
      answer: readRequiredArg(args, 'answer'),
      intentType: readOptionalArg(args, 'intent-type') || readOptionalArg(args, 'intent') || 'unknown',
      inferenceMode: readOptionalArg(args, 'inference-mode') || null,
      responseShape: {},
      sources: [],
      debug: null,
    }), null, 2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export async function guardResponse(input, options = {}) {
  if (!readBoolEnv('DRIFT_CONTROL_ENABLED', true)) return passthrough(input)
  return await checkDrift(input, options)
}

export async function checkDrift(input, options = {}) {
  validateCheckInput(input)
  const supabase = options.supabase || await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk drift control.')
  const [rules, facts, latestSimilarity, conflicts] = await Promise.all([
    readRules(supabase, userId),
    readIdentityFacts(supabase, userId),
    readLatestSimilarity(supabase, userId),
    readIdentityConflicts(supabase, userId),
  ])
  const relevantConflicts = selectRelevantConflicts(input, input.identityConflicts?.length ? input.identityConflicts : conflicts)
  const result = evaluateDraft({ ...input, identityConflicts: relevantConflicts }, rules, facts, latestSimilarity)
  const log = {
    user_id: userId,
    question: input.question,
    answer_before_guard: input.answer,
    answer_after_guard: result.answer_after_guard,
    intent_type: input.intentType || 'unknown',
    inference_mode: input.inferenceMode,
    triggered_rules: result.triggered_rules,
    guard_actions: result.actions,
    overclaim_score: result.overclaim_score,
    style_drift_score: result.style_drift_score,
    too_ai_score: result.too_ai_score,
    too_formal_score: result.too_formal_score,
    unsupported_claim_score: result.unsupported_claim_score,
    irrelevant_context_score: result.irrelevant_context_score,
    debug_leak_score: result.debug_leak_score,
    source_leak_score: result.source_leak_score,
    final_risk_score: result.final_risk_score,
    blocked: result.blocked,
    fallback_used: result.fallback_used,
    warnings: result.warnings,
    metadata: {
      response_shape: input.responseShape ?? {},
      source_count: Array.isArray(input.sources) ? input.sources.length : 0,
      identity_fact_ids: (input.identityFacts ?? []).map((fact) => fact.id).filter(Boolean),
      identity_conflict_ids: relevantConflicts.map((conflict) => conflict.id).filter(Boolean),
      calibration_hint_ids: (input.calibrationHints ?? []).map((hint) => hint.id).filter(Boolean),
    },
  }
  const { data, error } = await supabase.from('drift_guard_logs').insert(log).select('id').single()
  if (error && error.code !== '42P01') throw error
  const output = { ok: true, log_id: data?.id ?? null, ...result }
  if (readBoolEnv('DRIFT_CONTROL_OUTPUT_OBSIDIAN', true)) {
    const latest = await getLatestDriftControl({ supabase, userId }).catch(() => null)
    if (latest) writeDriftReports(latest)
  }
  return output
}

export async function seedDriftRules(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk drift rules.')
  const rows = defaultRules(userId)
  const { data, error } = await supabase.from('drift_guard_rules').upsert(rows, { onConflict: 'user_id,rule_name', ignoreDuplicates: !options.force }).select('*')
  if (error) throw error
  return { ok: true, rules_seeded: data?.length ?? rows.length, rules: data ?? [] }
}

export async function listDriftRules(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk drift rules.')
  const { data, error } = await supabase.from('drift_guard_rules').select('*').eq('user_id', userId).order('priority', { ascending: true })
  if (error) throw error
  return { ok: true, rules: data ?? [] }
}

export async function createDriftBaseline(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk drift baseline.')
  const [identityRes, simRes, commRes, hintRes] = await Promise.all([
    supabase.from('identity_snapshots').select('id,title,summary,confidence_summary,data_coverage,status,created_at').eq('user_id', userId).in('status', ['done','needs_review']).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('similarity_baselines').select('*').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('communication_patterns').select('id,pattern_type,label,preferred_response_shape,confidence_score').eq('user_id', userId).eq('status', 'active').order('confidence_score', { ascending: false }).limit(30),
    supabase.from('owner_calibration_hints').select('id,intent_type,hint_type,label,confidence_score').eq('user_id', userId).in('status', ['active','needs_review']).order('confidence_score', { ascending: false }).limit(30),
  ])
  for (const res of [identityRes, simRes, commRes, hintRes]) if (res.error && res.error.code !== 'PGRST116' && res.error.code !== '42P01') throw res.error
  if (options.activate) await supabase.from('drift_baseline_snapshots').update({ status: 'archived' }).eq('user_id', userId).eq('status', 'active')
  const row = {
    user_id: userId,
    label: `Drift Baseline ${new Date().toISOString().slice(0, 10)}`,
    identity_snapshot_id: identityRes.data?.id ?? null,
    similarity_baseline_id: simRes.data?.id ?? null,
    communication_pattern_ids: (commRes.data ?? []).map((item) => item.id),
    owner_calibration_hint_ids: (hintRes.data ?? []).map((item) => item.id),
    baseline_summary: identityRes.data?.summary ?? 'Baseline dibuat dari data aktif yang tersedia.',
    baseline_style_profile: { communication_patterns: commRes.data ?? [], calibration_hints: hintRes.data ?? [] },
    baseline_identity_limits: { confidence_summary: identityRes.data?.confidence_summary ?? {}, data_coverage: identityRes.data?.data_coverage ?? {}, low_confidence_must_be_softened: true },
    status: options.activate ? 'active' : 'candidate',
    metadata: { created_by: 'drift-control.mjs' },
  }
  const { data, error } = await supabase.from('drift_baseline_snapshots').insert(row).select('*').single()
  if (error) throw error
  return { ok: true, baseline: data }
}

export async function getLatestDriftControl(options = {}) {
  const supabase = options.supabase || await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk drift latest.')
  const [logsRes, rulesRes, baselineRes] = await Promise.all([
    supabase.from('drift_guard_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(30),
    supabase.from('drift_guard_rules').select('*').eq('user_id', userId).eq('enabled', true).order('priority', { ascending: true }).limit(50),
    supabase.from('drift_baseline_snapshots').select('*').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  for (const res of [logsRes, rulesRes, baselineRes]) if (res.error && res.error.code !== 'PGRST116' && res.error.code !== '42P01') throw res.error
  const logs = logsRes.error?.code === '42P01' ? [] : logsRes.data ?? []
  const summary = summarizeLogs(logs)
  return { ok: true, logs, risk_summary: summary, active_rules: rulesRes.error?.code === '42P01' ? [] : rulesRes.data ?? [], active_baseline: baselineRes.data ?? null }
}

export async function auditDriftControl(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk drift audit.')
  const [rulesRes, logsRes, baselineRes, simRes, hintsRes] = await Promise.all([
    supabase.from('drift_guard_rules').select('id,rule_type,severity,enabled').eq('user_id', userId),
    supabase.from('drift_guard_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    supabase.from('drift_baseline_snapshots').select('id,status').eq('user_id', userId).eq('status', 'active').limit(1).maybeSingle(),
    supabase.from('similarity_eval_runs').select('id,verdict,overall_score').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('owner_calibration_hints').select('id,status').eq('user_id', userId).in('status', ['active','needs_review']).limit(1),
  ])
  for (const res of [rulesRes, logsRes, baselineRes, simRes, hintsRes]) if (res.error && res.error.code !== 'PGRST116' && res.error.code !== '42P01') throw res.error
  const rules = rulesRes.data ?? []
  const logs = logsRes.data ?? []
  const enabledHigh = rules.filter((rule) => rule.enabled && ['high','critical'].includes(rule.severity)).length
  const highRisk = logs.filter((log) => Number(log.final_risk_score ?? 0) >= 0.51)
  const warnings = []
  if (!rules.some((rule) => rule.enabled)) warnings.push('Belum ada drift guard rules aktif.')
  if (enabledHigh < 4) warnings.push('High severity rules aktif masih kurang.')
  if (highRisk.length > 0) warnings.push(`${highRisk.length} high risk drift logs terdeteksi.`)
  if (logs.some((log) => log.blocked)) warnings.push('Ada jawaban yang diblokir/fallback oleh guard.')
  if (!baselineRes.data) warnings.push('Active drift baseline belum tersedia.')
  if (!hintsRes.data?.length) warnings.push('Calibration hints belum tersedia untuk fallback gaya owner.')
  if (simRes.data?.verdict && ['bad','blocked'].includes(simRes.data.verdict)) warnings.push(`Latest similarity verdict ${simRes.data.verdict}.`)
  const avg = summarizeLogs(logs)
  if (avg.too_ai_average > Number(process.env.DRIFT_CONTROL_MAX_TOO_AI_SCORE ?? 0.25)) warnings.push('Average too AI drift tinggi.')
  if (avg.unsupported_claim_average > Number(process.env.DRIFT_CONTROL_MAX_UNSUPPORTED_CLAIM_SCORE ?? 0.3)) warnings.push('Average unsupported claim tinggi.')
  let score = 100 - warnings.length * 10
  if (!rules.length) score -= 20
  score = Math.max(0, Math.min(100, score))
  return {
    ok: true,
    status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
    score,
    warnings,
    recommended_fixes: warnings.map((warning) => warning.includes('rules') ? 'Jalankan npm run drift:rules -- --seed.' : warning.includes('baseline') ? 'Jalankan npm run drift:baseline -- --activate.' : 'Review Drift View dan latest guard logs.'),
    checks: {
      active_rules_count: rules.filter((rule) => rule.enabled).length,
      high_severity_rules_enabled: enabledHigh,
      latest_logs: logs.slice(0, 10),
      high_risk_logs_count: highRisk.length,
      blocked_count: logs.filter((log) => log.blocked).length,
      too_ai_average: avg.too_ai_average,
      unsupported_claim_average: avg.unsupported_claim_average,
      source_debug_leak_count: logs.filter((log) => Number(log.source_leak_score ?? 0) > 0 || Number(log.debug_leak_score ?? 0) > 0).length,
      active_baseline_exists: Boolean(baselineRes.data),
      similarity_latest_verdict: simRes.data?.verdict ?? null,
      calibration_hints_available: Boolean(hintsRes.data?.length),
    },
  }
}

function evaluateDraft(input, rules, identityFacts, latestSimilarity) {
  const answer = input.answer ?? ''
  const intent = input.intentType || 'unknown'
  const aiPhrases = detectAiLikePhrases(answer)
  const unsupported = detectUnsupportedIdentityClaims(answer, [...identityFacts, ...(input.identityFacts ?? [])])
  const lowConfidence = detectLowConfidenceIdentityUsage(answer, [...identityFacts, ...(input.identityFacts ?? [])])
  const tooLong = detectTooLongForIntent(answer, input.responseShape ?? {})
  const sourceLeak = intent === 'social_greeting' && Array.isArray(input.sources) && input.sources.length > 0
  const debugLeak = intent === 'social_greeting' && Boolean(input.debug)
  const irrelevant = detectIrrelevantPrivateContext(input.question, answer, input.memoryRefs ?? [])
  const tooFormal = intent === 'social_greeting' && /\banda|mohon|terima kasih|hari ini\b/i.test(answer)
  const idealOverclaim = /\b(paling disiplin|selalu menyelesaikan|sangat bijak|paling kuat|selalu konsisten|tidak pernah gagal)\b/i.test(answer)
  const worseOverclaim = /\b(selalu gagal|tidak pernah mampu|paling buruk|tidak punya kemampuan)\b/i.test(answer)
  const baselineBad = latestSimilarity && ['bad','blocked'].includes(latestSimilarity.verdict)
  const conflictRisk = detectConflictRisk(input.question, answer, input.identityConflicts ?? [])
  const memoryRisk = detectLongTermMemoryRisk(answer, input.longTermMemories ?? [])

  const scores = {
    overclaim_score: clamp((idealOverclaim || worseOverclaim ? 0.65 : 0) + (unsupported.length ? 0.25 : 0) + conflictRisk.overclaim + memoryRisk.overclaim),
    style_drift_score: clamp((tooFormal ? 0.35 : 0) + (tooLong ? 0.25 : 0) + (baselineBad ? 0.2 : 0) + conflictRisk.style + memoryRisk.style),
    too_ai_score: clamp(aiPhrases.length * 0.25 + (tooFormal ? 0.15 : 0)),
    too_formal_score: tooFormal ? 0.55 : 0,
    unsupported_claim_score: clamp(unsupported.length * 0.55 + lowConfidence.length * 0.35),
    irrelevant_context_score: clamp(irrelevant.length * 0.25),
    debug_leak_score: debugLeak ? 0.8 : 0,
    source_leak_score: sourceLeak ? 0.75 : 0,
  }
  let finalRisk = calculateDriftRisk(scores)
  const triggered = []
  const actions = []
  const warnings = [...conflictRisk.warnings, ...memoryRisk.warnings]
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.rule_name === 'no_ai_assistant_phrases_for_greeting' && intent === 'social_greeting' && aiPhrases.length) triggered.push(rule)
    if (rule.rule_name === 'no_sources_for_social_greeting' && sourceLeak) triggered.push(rule)
    if (rule.rule_name === 'no_debug_for_social_greeting' && debugLeak) triggered.push(rule)
    if (rule.rule_name === 'no_identity_overclaim_without_evidence' && unsupported.length) triggered.push(rule)
    if (rule.rule_name === 'low_confidence_identity_must_be_softened' && lowConfidence.length) triggered.push(rule)
    if (rule.rule_name === 'do_not_make_owner_more_ideal' && idealOverclaim) triggered.push(rule)
    if (rule.rule_name === 'do_not_make_owner_worse_without_evidence' && worseOverclaim) triggered.push(rule)
    if (rule.rule_name === 'respect_response_shape' && tooLong) triggered.push(rule)
    if (rule.rule_name === 'avoid_irrelevant_private_context' && irrelevant.length) triggered.push(rule)
    if (rule.rule_name === 'similarity_baseline_regression_warning' && baselineBad) triggered.push(rule)
  }
  for (const rule of triggered) {
    actions.push(rule.guard_action)
    warnings.push(rule.description)
    if (rule.severity === 'critical') finalRisk = Math.max(finalRisk, 0.85)
    if (rule.severity === 'high') finalRisk = Math.max(finalRisk, 0.55)
  }
  const riskLevel = finalRisk <= 0.25 ? 'safe' : finalRisk <= 0.5 ? 'warning' : finalRisk <= 0.75 ? 'high' : 'critical'
  const shouldFallback = actions.includes('fallback') || finalRisk >= 0.76 || (intent === 'social_greeting' && (aiPhrases.length || tooFormal || tooLong))
  const shouldBlock = readBoolEnv('DRIFT_CONTROL_BLOCK_CRITICAL', true) && riskLevel === 'critical' && actions.includes('block')
  const fallback = buildSafeFallback(intent, input.question, input.calibrationHints ?? [], input.communicationPatterns ?? [])
  const rewritten = shouldFallback || shouldBlock ? fallback : rewriteAnswer(answer, input, { aiPhrases, tooLong, unsupported, lowConfidence })
  return {
    enabled: true,
    risk_level: riskLevel,
    ...scores,
    final_risk_score: round4(finalRisk),
    triggered_rules: [...new Set(triggered.map((rule) => rule.rule_name))],
    actions: [...new Set(actions)],
    blocked: shouldBlock,
    fallback_used: shouldFallback || shouldBlock,
    warnings: [...new Set(warnings)],
    answer_after_guard: rewritten,
  }
}

function rewriteAnswer(answer, input, flags) {
  let next = answer
  for (const phrase of flags.aiPhrases) next = next.replace(new RegExp(escapeRegExp(phrase), 'ig'), '').replace(/\s+/g, ' ').trim()
  if (input.intentType === 'social_greeting') return firstSentence(next) || buildSafeFallback(input.intentType, input.question, input.calibrationHints ?? [])
  if (flags.unsupported.length || flags.lowConfidence.length) return 'Data belum cukup untuk menyimpulkan itu dengan kuat. Yang bisa disebut hanya yang punya evidence cukup.'
  if (flags.tooLong && input.responseShape?.max_sentences) return next.split(/(?<=[.!?])\s+/).slice(0, Number(input.responseShape.max_sentences)).join(' ')
  return next || buildSafeFallback(input.intentType || 'unknown', input.question, input.calibrationHints ?? [])
}

function passthrough(input) {
  return {
    ok: true,
    log_id: null,
    enabled: false,
    risk_level: 'safe',
    final_risk_score: 0,
    triggered_rules: [],
    actions: [],
    blocked: false,
    fallback_used: false,
    warnings: [],
    answer_after_guard: input.answer,
  }
}

function defaultRules(userId) {
  const common = { user_id: userId, enabled: true, metadata: { seeded_by: 'drift-control.mjs' } }
  return [
    rule(common, 'too_ai', 'no_ai_assistant_phrases_for_greeting', 'Greeting tidak boleh memakai frasa assistant umum.', { intent_type: 'social_greeting', phrases: ['Ada yang bisa saya bantu','Sebagai AI','Saya dapat membantu','Semoga membantu'] }, 'fallback', 'high', 10),
    rule(common, 'source_leak', 'no_sources_for_social_greeting', 'Social greeting tidak boleh menampilkan sources.', { intent_type: 'social_greeting' }, 'hide_sources', 'medium', 20),
    rule(common, 'debug_leak', 'no_debug_for_social_greeting', 'Social greeting tidak boleh leak debug.', { intent_type: 'social_greeting' }, 'hide_debug', 'medium', 21),
    rule(common, 'unsupported_personal_fact', 'no_identity_overclaim_without_evidence', 'Klaim identitas harus punya evidence.', { identity_claim_without_evidence: true }, 'require_evidence', 'high', 30),
    rule(common, 'low_confidence_identity', 'low_confidence_identity_must_be_softened', 'Identity facts confidence < 0.70 harus dilunakkan.', { confidence_lt: 0.7 }, 'lower_confidence', 'high', 31),
    rule(common, 'overclaim', 'do_not_make_owner_more_ideal', 'Jangan membuat owner lebih disiplin/bijak/sukses dari evidence.', { idealization_terms: true }, 'rewrite', 'high', 40),
    rule(common, 'overclaim', 'do_not_make_owner_worse_without_evidence', 'Jangan membuat owner lebih buruk dari evidence.', { negative_overclaim_terms: true }, 'rewrite', 'high', 41),
    rule(common, 'too_long_for_intent', 'respect_response_shape', 'Jawaban harus mengikuti response_shape intent.', { max_sentences_or_sections: true }, 'rewrite', 'medium', 50),
    rule(common, 'irrelevant_private_context', 'avoid_irrelevant_private_context', 'Jangan menyebut goals/person/projects privat yang tidak diminta.', { private_context_not_requested: true }, 'rewrite', 'high', 60),
    rule(common, 'baseline_regression', 'similarity_baseline_regression_warning', 'Warning jika latest similarity baseline buruk/regression.', { similarity_verdict_bad: true }, 'warn', 'medium', 70),
  ]
}

function rule(common, rule_type, rule_name, description, trigger_conditions, guard_action, severity, priority) {
  return { ...common, rule_type, rule_name, description, trigger_conditions, guard_action, severity, priority }
}

async function readRules(supabase, userId) {
  const { data, error } = await supabase.from('drift_guard_rules').select('*').eq('user_id', userId).eq('enabled', true).order('priority', { ascending: true })
  if (error && error.code !== '42P01') throw error
  return error?.code === '42P01' ? [] : data ?? []
}

async function readIdentityFacts(supabase, userId) {
  const { data, error } = await supabase.from('identity_facts').select('id,statement,confidence_score,status').eq('user_id', userId).in('status', ['active','needs_review','contradicted']).limit(120)
  if (error && error.code !== '42P01') throw error
  return error?.code === '42P01' ? [] : data ?? []
}

async function readLatestSimilarity(supabase, userId) {
  const { data, error } = await supabase.from('similarity_eval_runs').select('id,verdict,overall_score').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error && error.code !== 'PGRST116' && error.code !== '42P01') throw error
  return data ?? null
}

async function readIdentityConflicts(supabase, userId) {
  const { data, error } = await supabase
    .from('identity_conflicts')
    .select('id,title,summary,side_a_label,side_a_statement,side_b_label,side_b_statement,severity,recurrence,resolution_status,impact_area,chat_guidance')
    .eq('user_id', userId)
    .in('resolution_status', ['open','monitoring','partially_resolved','needs_review'])
    .order('last_seen_at', { ascending: false })
    .limit(50)
  if (error && error.code !== '42P01') throw error
  return error?.code === '42P01' ? [] : data ?? []
}

function selectRelevantConflicts(input, conflicts) {
  if (input.intentType === 'social_greeting') return []
  const q = normalize(input.question)
  return (conflicts ?? [])
    .map((conflict) => {
      const text = normalize([conflict.title, conflict.summary, conflict.side_a_statement, conflict.side_b_statement, conflict.impact_area].join(' '))
      let score = 0
      for (const token of q.split(' ').filter((item) => item.length > 3)) if (text.includes(token)) score += 1
      if (/\b(fitur|scope|fokus|lanjut|roadmap|mvp|validasi)\b/.test(q) && /fitur|scope|fokus|roadmap|mvp|validasi/.test(text)) score += 8
      if (/\b(kontradiksi|tension|konsisten|berlawanan)\b/.test(q)) score += 8
      if (['high','critical'].includes(conflict.severity)) score += 2
      if (conflict.recurrence === 'core_tension') score += 2
      return { conflict, score }
    })
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ conflict }) => conflict)
}

function detectConflictRisk(question, answer, conflicts) {
  if (!conflicts.length) return { overclaim: 0, style: 0, warnings: [] }
  const normalized = normalize(answer)
  const warnings = []
  let overclaim = 0
  let style = 0
  for (const conflict of conflicts) {
    const mentionsTension = /\b(di satu sisi|di sisi lain|tension|konflik|trade.?off|tetapi|tapi|namun)\b/i.test(answer)
    const tooConsistent = /\b(selalu konsisten|jelas satu arah|tidak ada konflik|tidak kontradiktif)\b/i.test(answer)
    const sideA = normalize(conflict.side_a_label || conflict.side_a_statement).split(' ').filter((token) => token.length > 4).slice(0, 5)
    const sideB = normalize(conflict.side_b_label || conflict.side_b_statement).split(' ').filter((token) => token.length > 4).slice(0, 5)
    const usesA = sideA.some((token) => normalized.includes(token))
    const usesB = sideB.some((token) => normalized.includes(token))
    if (['high','critical'].includes(conflict.severity) || conflict.recurrence === 'core_tension') {
      if (!mentionsTension && !(usesA && usesB)) {
        overclaim += 0.2
        style += 0.15
        warnings.push(`Jawaban mungkin mengabaikan active identity conflict: ${conflict.title}.`)
      }
      if (tooConsistent || (usesA !== usesB && !mentionsTension)) {
        overclaim += 0.18
        warnings.push(`Jawaban memilih satu sisi conflict tanpa nuansa: ${conflict.title}.`)
      }
    }
  }
  return { overclaim: clamp(overclaim), style: clamp(style), warnings: [...new Set(warnings)] }
}

function detectLongTermMemoryRisk(answer, memories = []) {
  let overclaim = 0
  let style = 0
  const warnings = []
  for (const memory of memories) {
    if (memory.freshness === 'stale' && /\b(sekarang|masih|selalu|pasti|current|saat ini)\b/i.test(answer)) {
      overclaim = Math.max(overclaim, 0.24)
      warnings.push(`Stale long-term memory "${memory.title}" dipakai seperti fakta current.`)
    }
    if (memory.status === 'needs_review' && /\b(pasti|jelas|memang|adalah|selalu)\b/i.test(answer)) {
      overclaim = Math.max(overclaim, 0.28)
      warnings.push(`Needs-review long-term memory "${memory.title}" dipakai sebagai klaim tegas.`)
    }
    if (Array.isArray(memory.related_conflict_ids) && memory.related_conflict_ids.length && !/\b(di satu sisi|di sisi lain|tension|konflik|nuansa|tetapi|tapi|namun)\b/i.test(answer)) {
      style = Math.max(style, 0.2)
      warnings.push(`Conflict-linked long-term memory "${memory.title}" tidak dijawab dengan cukup nuansa.`)
    }
  }
  return { overclaim: clamp(overclaim), style: clamp(style), warnings: [...new Set(warnings)] }
}

function detectAiLikePhrases(answer) {
  const normalized = normalize(answer)
  return ['sebagai ai','ada yang bisa saya bantu','saya dapat membantu','semoga membantu','berdasarkan data yang tersedia','memory yang tersedia','dari informasi yang diberikan'].filter((phrase) => normalized.includes(phrase))
}

function detectUnsupportedIdentityClaims(answer, identityFacts = []) {
  const hasEvidence = identityFacts.some((fact) => Number(fact.confidence_score ?? 0) >= 0.7 && fact.statement && normalize(answer).includes(normalize(fact.statement).slice(0, 24)))
  if (hasEvidence) return []
  return /\b(kamu|saya)\s+(adalah|selalu|pasti|tidak pernah|orang yang|paling)\b/i.test(answer) ? ['strong_identity_claim_without_evidence'] : []
}

function detectLowConfidenceIdentityUsage(answer, identityFacts = []) {
  const normalized = normalize(answer)
  return identityFacts.filter((fact) => Number(fact.confidence_score ?? 0) > 0 && Number(fact.confidence_score ?? 0) < 0.7 && fact.statement && normalized.includes(normalize(fact.statement).slice(0, 24))).map((fact) => fact.id ?? fact.statement)
}

function detectTooLongForIntent(answer, responseShape = {}) {
  const maxSentences = Number(responseShape.max_sentences ?? 0)
  if (maxSentences > 0 && answer.split(/(?<=[.!?])\s+/).filter(Boolean).length > maxSentences) return true
  const maxSections = Number(responseShape.max_sections ?? 0)
  return maxSections > 0 && answer.split(/\n\s*\n/).filter(Boolean).length > maxSections
}

function detectIrrelevantPrivateContext(question, answer, memoryRefs = []) {
  const q = normalize(question)
  return ['haryati','pasangan','utang','keluarga','project','goal','diary','identity'].filter((word) => normalize(answer).includes(word) && !q.includes(word) && memoryRefs.length > 0)
}

function calculateDriftRisk(scores) {
  const critical = Math.max(scores.overclaim_score, scores.unsupported_claim_score, scores.debug_leak_score, scores.source_leak_score)
  const other = [scores.style_drift_score, scores.too_ai_score, scores.too_formal_score, scores.irrelevant_context_score]
  return clamp(critical * 0.5 + (other.reduce((a, b) => a + b, 0) / other.length) * 0.5)
}

function buildSafeFallback(intentType, question, calibrationHints = []) {
  if (intentType === 'social_greeting') {
    const preferred = calibrationHints.flatMap((hint) => Array.isArray(hint.preferred_response) ? hint.preferred_response : []).find((item) => typeof item === 'string' && item.trim())
    if (preferred) return firstSentence(preferred)
    if (/assalamu/i.test(question)) return 'Wa’alaikumussalam, ada apa?'
    return 'Iya, ada apa?'
  }
  if (intentType === 'identity_question') return 'Data belum cukup untuk menyimpulkan itu dengan kuat. Yang baru terlihat harus tetap dibatasi ke evidence yang ada.'
  if (intentType === 'request_prompt') return 'Saya buatkan prompt siap paste dengan batasan jelas dan acceptance criteria, tanpa klaim identitas tambahan.'
  return 'Data belum cukup untuk menjawab itu dengan aman tanpa overclaim.'
}

function summarizeLogs(logs) {
  const count = logs.length || 1
  const avg = (key) => round4(logs.reduce((sum, log) => sum + Number(log[key] ?? 0), 0) / count)
  return {
    overclaim_average: avg('overclaim_score'),
    too_ai_average: avg('too_ai_score'),
    style_drift_average: avg('style_drift_score'),
    unsupported_claim_average: avg('unsupported_claim_score'),
    irrelevant_context_average: avg('irrelevant_context_score'),
    high_risk_count: logs.filter((log) => Number(log.final_risk_score ?? 0) >= 0.51).length,
    blocked_count: logs.filter((log) => log.blocked).length,
    fallback_count: logs.filter((log) => log.fallback_used).length,
  }
}

function writeDriftReports(latest) {
  const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
  const dir = resolve(vaultPath, '_system', 'drift')
  mkdirSync(dir, { recursive: true })
  const high = (latest.logs ?? []).filter((log) => Number(log.final_risk_score ?? 0) >= 0.51)
  const content = [
    '# Drift Control Latest',
    '',
    AUTO_START,
    `Generated: ${new Date().toISOString()}`,
    `High risk logs: ${high.length}`,
    `Blocked logs: ${(latest.logs ?? []).filter((log) => log.blocked).length}`,
    '',
    '## Risk Summary',
    JSON.stringify(latest.risk_summary ?? {}, null, 2),
    '',
    '## Active Rules',
    ...(latest.active_rules ?? []).map((rule) => `- ${rule.severity} / ${rule.rule_type}: ${rule.rule_name}`),
    '',
    '## Recommended Fixes',
    ...(high.length ? ['Review high risk logs in Drift View.', 'Seed/update calibration hints for repeated failures.'] : ['Tidak ada fix wajib.']).map((item) => `- ${item}`),
    AUTO_END,
    '',
  ].join('\n')
  writeFileSync(resolve(dir, 'Drift Control Latest.md'), content, 'utf8')
  writeFileSync(resolve(dir, 'Drift Guard Rules.md'), ['# Drift Guard Rules','',AUTO_START,...(latest.active_rules ?? []).map((rule) => `- ${rule.rule_name}: ${rule.description}`),AUTO_END,''].join('\n'), 'utf8')
  writeFileSync(resolve(dir, 'High Risk Drift Logs.md'), ['# High Risk Drift Logs','',AUTO_START,...high.map((log) => `- ${log.created_at}: ${log.intent_type} risk=${log.final_risk_score} blocked=${log.blocked}`),AUTO_END,''].join('\n'), 'utf8')
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
  for (const table of ['drift_guard_rules','owner_answer_examples','raw_entries','identity_facts','brain_nodes']) {
    const { data, error } = await supabase.from(table).select('user_id').limit(1).maybeSingle()
    if (!error && data?.user_id) return data.user_id
  }
  return null
}

function validateCheckInput(input) {
  if (!input.question || typeof input.question !== 'string' || input.question.length > 2000) throw new Error('question wajib string maksimal 2000 karakter.')
  if (!input.answer || typeof input.answer !== 'string' || input.answer.length > 20000) throw new Error('answer wajib string maksimal 20000 karakter.')
  if (input.intentType && !INTENTS.includes(input.intentType)) throw new Error(`intentType tidak valid: ${input.intentType}`)
}

function normalize(value) { return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() }
function firstSentence(value) { return String(value ?? '').split(/(?<=[.!?])\s+/)[0]?.trim() ?? '' }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function clamp(value) { const num = Number(value); return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0 }
function round4(value) { return Number(clamp(value).toFixed(4)) }
function readBoolEnv(name, fallback) { const value = process.env[name]; if (value === undefined || value === '') return fallback; return ['1','true','yes','on'].includes(value.toLowerCase()) }
function requiredEnv(name, fallback) { const value = process.env[name] || fallback; if (!value) throw new Error(`${name} belum diset.`); return value }
function parseArgs(argv) { const args = new Map(); for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (!arg.startsWith('--')) continue; const key = arg.slice(2); const next = argv[i + 1]; if (next && !next.startsWith('--')) { args.set(key, next); i += 1 } else args.set(key, true) } return args }
function readOptionalArg(args, name) { const value = args.get(name); return typeof value === 'string' && value.trim() ? value.trim() : null }
function readRequiredArg(args, name) { const value = readOptionalArg(args, name); if (!value) throw new Error(`Missing required argument --${name}`); return value }
function loadEnv(path, options = {}) { if (!existsSync(path)) return; const raw = readFileSync(path, 'utf8'); for (const line of raw.split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue; const index = trimmed.indexOf('='); const key = trimmed.slice(0, index).trim(); let value = trimmed.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (options.override || process.env[key] === undefined) process.env[key] = value } }
