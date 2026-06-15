import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { runResponseInference } from './response-inference.mjs'

const RUN_TYPES = ['manual', 'daily', 'weekly', 'baseline', 'regression']
const INTENTS = ['social_greeting', 'casual_reply', 'request_prompt', 'technical_instruction', 'strategy_question', 'correction', 'identity_question', 'contradiction_check', 'decision_help', 'personal_reflection', 'unknown']
const LENGTH_CLASSES = ['very_short', 'short', 'medium', 'long']
const JUDGE_PROMPT = `Kamu adalah Similarity Evaluation Judge untuk Personal Entity OS.

Tugas:
Bandingkan jawaban agent dengan jawaban asli pemilik diary.

Nilai bukan berdasarkan seberapa pintar jawaban agent.
Nilai berdasarkan seberapa mirip jawaban agent dengan pemilik diary.

Periksa:
- kesamaan maksud
- gaya bahasa
- panjang jawaban
- tone
- struktur
- apakah terlalu AI
- apakah terlalu formal
- apakah terlalu banyak tambahan
- apakah kehilangan ciri khas owner
- apakah overclaim
- apakah underfit

Output harus JSON valid.`

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.has('baseline')) console.log(JSON.stringify(await handleBaseline(args), null, 2))
    else if (args.has('compare')) console.log(JSON.stringify(await compareLatest(args), null, 2))
    else if (args.has('latest')) console.log(JSON.stringify(await getLatestSimilarityEval(), null, 2))
    else if (args.has('audit')) console.log(JSON.stringify(await auditSimilarityEval(), null, 2))
    else console.log(JSON.stringify(await runSimilarityEval({
      limit: readIntArg(args, 'limit', Number(process.env.SIMILARITY_EVAL_MAX_CASES ?? 100), 1, 100),
      intentType: readOptionalArg(args, 'intent'),
      runType: readOptionalArg(args, 'run-type') || 'manual',
      useJudge: args.has('use-judge') ? true : undefined,
    }), null, 2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export async function runSimilarityEval(options = {}) {
  if (!readBoolEnv('SIMILARITY_EVAL_ENABLED', true)) throw new Error('SIMILARITY_EVAL_ENABLED=false.')
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk similarity eval.')
  const runType = RUN_TYPES.includes(options.runType) ? options.runType : 'manual'
  const intentType = INTENTS.includes(options.intentType) ? options.intentType : null
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? process.env.SIMILARITY_EVAL_MAX_CASES ?? 100)))
  const baseline = await getActiveBaseline(supabase, userId)
  const baselineResults = baseline ? await getBaselineResults(supabase, userId, baseline.similarity_eval_run_id) : []
  const baselineByExample = new Map(baselineResults.map((result) => [result.owner_answer_example_id, result]))

  let examplesQuery = supabase.from('owner_answer_examples').select('*').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: true }).limit(limit)
  if (intentType) examplesQuery = examplesQuery.eq('intent_type', intentType)
  const examplesRes = await examplesQuery
  if (examplesRes.error) throw examplesRes.error
  const examples = examplesRes.data ?? []
  if (!examples.length) throw new Error('Tidak ada owner_answer_examples active untuk similarity eval.')

  const runRes = await supabase.from('similarity_eval_runs').insert({
    user_id: userId,
    title: `Similarity Evaluation ${new Date().toISOString()}`,
    status: 'running',
    run_type: runType,
    baseline_run_id: baseline?.similarity_eval_run_id ?? null,
    total_cases: examples.length,
    started_at: new Date().toISOString(),
    metadata: { intent_type: intentType, baseline_id: baseline?.id ?? null, use_judge: useJudge(options) },
  }).select('*').single()
  if (runRes.error) throw runRes.error
  const run = runRes.data

  try {
    const rows = []
    for (const example of examples) {
      const agent = await runResponseInference({ question: example.prompt, options: { userId, source: 'similarity-eval', useLLM: true } })
      const deterministic = scoreCase(example, agent)
      const judged = useJudge(options) ? await judgeWithLLMSafe(example, agent, deterministic) : deterministic
      const final = mergeJudge(deterministic, judged)
      const baselineResult = baselineByExample.get(example.id) ?? null
      const regression = compareRegression(final, baselineResult)
      const row = {
        user_id: userId,
        similarity_eval_run_id: run.id,
        owner_answer_example_id: example.id,
        prompt: example.prompt,
        owner_answer: example.owner_answer,
        agent_answer: agent.answer,
        intent_type: example.intent_type,
        actual_intent_type: agent.intent_type ?? agent.debug?.intent_type ?? 'unknown',
        expected_answer_style: example.answer_style,
        actual_answer_style: inferAnswerStyle(agent.answer, agent.intent_type ?? agent.debug?.intent_type),
        similarity_score: final.similarity_score,
        fidelity_score: final.fidelity_score,
        style_match_score: final.style_match_score,
        intent_match_score: final.intent_match_score,
        tone_match_score: final.tone_match_score,
        length_match_score: final.length_match_score,
        too_ai_score: final.too_ai_score,
        overclaim_risk: final.overclaim_risk,
        underfit_risk: final.underfit_risk,
        regression_score: regression.regression_score,
        baseline_result_id: baselineResult?.id ?? null,
        passed: passCase(final),
        regressed: regression.regressed,
        improved: regression.improved,
        failure_reason: failureReason(final, regression),
        judge_feedback: final.judge_feedback,
        missing_elements: final.missing_elements,
        extra_elements: final.extra_elements,
        recommendations: recommendations(final, regression, example),
        metadata: {
          agent_inference_log_id: agent.response_inference_log_id,
          calibration_hints_used: agent.owner_calibration_hint_ids ?? [],
          identity_fact_ids: agent.debug?.identity_fact_ids ?? [],
          communication_pattern_ids: agent.communication_pattern_ids ?? [],
          deterministic_scoring: deterministic,
          baseline_score: baselineResult?.fidelity_score ?? null,
        },
      }
      const saved = await supabase.from('similarity_eval_results').insert(row).select('*').single()
      if (saved.error) throw saved.error
      rows.push(saved.data)
    }
    const summary = summarize(rows)
    const verdict = verdictFor(summary)
    const update = await supabase.from('similarity_eval_runs').update({
      ...summary,
      verdict,
      status: 'done',
      finished_at: new Date().toISOString(),
      metadata: { ...(run.metadata ?? {}), recommended_fixes: recommendedFixes(rows, verdict) },
    }).eq('id', run.id).select('*').single()
    if (update.error) throw update.error
    const latest = await getLatestSimilarityEval({ supabase, userId })
    if (readBoolEnv('SIMILARITY_EVAL_OUTPUT_OBSIDIAN', true)) writeSimilarityReports(latest)
    return { ok: true, run: update.data, results: rows, baseline }
  } catch (err) {
    await supabase.from('similarity_eval_runs').update({ status: 'failed', finished_at: new Date().toISOString(), metadata: { error: errorMessage(err) } }).eq('id', run.id)
    throw err
  }
}

export async function handleBaseline(argsOrOptions = {}) {
  const supabase = await createSupabaseClient()
  const userId = argsOrOptions.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk similarity baseline.')
  const list = argsOrOptions instanceof Map ? argsOrOptions.has('list') : argsOrOptions.list
  const create = argsOrOptions instanceof Map ? argsOrOptions.has('create') : argsOrOptions.create
  const activate = argsOrOptions instanceof Map ? argsOrOptions.has('activate') : argsOrOptions.activate
  if (list) {
    const { data, error } = await supabase.from('similarity_baselines').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    if (error) throw error
    return { ok: true, baselines: data ?? [] }
  }
  if (!create) throw new Error('Pakai --create atau --list untuk similarity:baseline.')
  const latestRes = await supabase.from('similarity_eval_runs').select('*').eq('user_id', userId).eq('status', 'done').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (latestRes.error) throw latestRes.error
  const run = latestRes.data
  if (!run) throw new Error('Belum ada similarity run done untuk baseline.')
  if (Number(run.overall_score ?? 0) < Number(process.env.SIMILARITY_EVAL_MIN_OVERALL_SCORE ?? 0.75)) throw new Error('Latest run belum cukup baik untuk baseline.')
  if (activate) await supabase.from('similarity_baselines').update({ status: 'archived' }).eq('user_id', userId).eq('status', 'active')
  const row = {
    user_id: userId,
    similarity_eval_run_id: run.id,
    label: `Similarity Baseline ${new Date().toISOString().slice(0, 10)}`,
    description: activate ? 'Active baseline created from latest similarity run.' : 'Candidate baseline created from latest similarity run.',
    overall_score: run.overall_score,
    average_similarity_score: run.average_similarity_score,
    average_fidelity_score: run.average_fidelity_score,
    average_style_match_score: run.average_style_match_score,
    average_too_ai_score: run.average_too_ai_score,
    average_overclaim_risk: run.average_overclaim_risk,
    average_underfit_risk: run.average_underfit_risk,
    case_count: run.total_cases,
    status: activate ? 'active' : 'candidate',
    metadata: { source_run_type: run.run_type },
  }
  const { data, error } = await supabase.from('similarity_baselines').insert(row).select('*').single()
  if (error) throw error
  const latest = await getLatestSimilarityEval({ supabase, userId })
  if (readBoolEnv('SIMILARITY_EVAL_OUTPUT_OBSIDIAN', true)) writeSimilarityReports(latest)
  return { ok: true, baseline: data }
}

export async function getLatestSimilarityEval(options = {}) {
  const supabase = options.supabase || await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk latest similarity eval.')
  const [runRes, baselineRes] = await Promise.all([
    supabase.from('similarity_eval_runs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('similarity_baselines').select('*').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  for (const res of [runRes, baselineRes]) if (res.error && res.error.code !== 'PGRST116') throw res.error
  let results = []
  if (runRes.data?.id) {
    const resultsRes = await supabase.from('similarity_eval_results').select('*').eq('user_id', userId).eq('similarity_eval_run_id', runRes.data.id).order('created_at', { ascending: true })
    if (resultsRes.error) throw resultsRes.error
    results = resultsRes.data ?? []
  }
  return {
    ok: true,
    run: runRes.data ?? null,
    results,
    baseline: baselineRes.data ?? null,
    regressions: results.filter((result) => result.regressed),
    failed_cases: results.filter((result) => !result.passed),
  }
}

export async function compareLatest(options = {}) {
  const latest = await getLatestSimilarityEval(options instanceof Map ? {} : options)
  if (!latest.run) return { ok: false, error: 'Belum ada similarity run.' }
  return {
    ok: true,
    baseline: latest.baseline,
    regression_count: latest.regressions.length,
    failed_cases: latest.failed_cases.length,
    results: latest.results.map((result) => ({
      prompt: result.prompt,
      fidelity_score: result.fidelity_score,
      baseline_result_id: result.baseline_result_id,
      regression_score: result.regression_score,
      regressed: result.regressed,
      improved: result.improved,
    })),
  }
}

export async function auditSimilarityEval(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk similarity audit.')
  const [examplesRes, latestRes, baselineRes, resultsRes] = await Promise.all([
    supabase.from('owner_answer_examples').select('id,intent_type,status').eq('user_id', userId),
    supabase.from('similarity_eval_runs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('similarity_baselines').select('*').eq('user_id', userId).eq('status', 'active').limit(1).maybeSingle(),
    supabase.from('similarity_eval_results').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
  ])
  for (const res of [examplesRes, latestRes, baselineRes, resultsRes]) if (res.error && res.error.code !== 'PGRST116') throw res.error
  const examples = examplesRes.data ?? []
  const active = examples.filter((item) => item.status === 'active')
  const latest = latestRes.data
  const results = latest?.id ? (resultsRes.data ?? []).filter((result) => result.similarity_eval_run_id === latest.id) : []
  const warnings = []
  if (!active.length) warnings.push('Belum ada active owner examples.')
  if (!new Set(active.map((item) => item.intent_type)).has('social_greeting')) warnings.push('Social greeting coverage belum ada.')
  if (!new Set(active.map((item) => item.intent_type)).has('request_prompt')) warnings.push('Request prompt coverage belum ada.')
  if (!latest) warnings.push('Similarity run belum pernah dijalankan.')
  if (!baselineRes.data) warnings.push('Active baseline belum tersedia.')
  if (latest?.verdict === 'bad' || latest?.verdict === 'blocked') warnings.push(`Latest verdict ${latest.verdict}.`)
  if (Number(latest?.regression_count ?? 0) > 0) warnings.push(`${latest.regression_count} regression terdeteksi.`)
  if (Number(latest?.average_too_ai_score ?? 0) > Number(process.env.SIMILARITY_EVAL_MAX_TOO_AI_SCORE ?? 0.25)) warnings.push('Average too AI score terlalu tinggi.')
  if (Number(latest?.average_overclaim_risk ?? 0) > Number(process.env.SIMILARITY_EVAL_MAX_OVERCLAIM_RISK ?? 0.3)) warnings.push('Average overclaim risk terlalu tinggi.')
  if (Number(latest?.average_underfit_risk ?? 0) > Number(process.env.SIMILARITY_EVAL_MAX_UNDERFIT_RISK ?? 0.35)) warnings.push('Average underfit risk terlalu tinggi.')
  let score = 100 - warnings.length * 10
  if (!latest) score -= 15
  if (!baselineRes.data) score -= 10
  score = Math.max(0, Math.min(100, score))
  return {
    ok: true,
    status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
    score,
    warnings,
    recommended_fixes: auditFixes(warnings),
    checks: {
      owner_examples_count: examples.length,
      active_examples_count: active.length,
      intent_coverage: [...new Set(active.map((item) => item.intent_type))],
      latest_similarity_run: latest ?? null,
      latest_verdict: latest?.verdict ?? null,
      active_baseline: baselineRes.data ?? null,
      regression_count: Number(latest?.regression_count ?? 0),
      too_ai_average: Number(latest?.average_too_ai_score ?? 0),
      overclaim_average: Number(latest?.average_overclaim_risk ?? 0),
      underfit_average: Number(latest?.average_underfit_risk ?? 0),
      social_greeting_score: avgIntent(results, 'social_greeting'),
      request_prompt_score: avgIntent(results, 'request_prompt'),
      strategy_score: avgIntent(results, 'strategy_question'),
      blocked_cases: results.filter((result) => !result.passed || result.regressed).slice(0, 10),
    },
  }
}

function scoreCase(example, agent) {
  const owner = example.owner_answer
  const answer = agent.answer ?? ''
  const similarity = strictSimilarity(owner, answer)
  const intentMatch = example.intent_type === (agent.intent_type ?? agent.debug?.intent_type ?? 'unknown') ? 1 : 0
  const lengthMatch = lengthScore(classifyLength(owner), classifyLength(answer))
  const toneMatch = toneScore(inferTone(owner, example.intent_type), inferTone(answer, agent.intent_type ?? agent.debug?.intent_type))
  const tooAi = tooAiScore(answer, example.intent_type)
  const overclaim = overclaimRisk(example, answer)
  const underfit = underfitRisk(example, answer, similarity, tooAi)
  const style = clamp(lengthMatch * 0.3 + toneMatch * 0.25 + formatScore(example, answer) * 0.25 + (1 - tooAi) * 0.2)
  const fidelity = clamp(similarity * 0.45 + style * 0.25 + intentMatch * 0.15 + (1 - overclaim) * 0.075 + (1 - underfit) * 0.075)
  return {
    similarity_score: round4(similarity),
    fidelity_score: round4(fidelity),
    style_match_score: round4(style),
    intent_match_score: round4(intentMatch),
    tone_match_score: round4(toneMatch),
    length_match_score: round4(lengthMatch),
    too_ai_score: round4(tooAi),
    overclaim_risk: round4(overclaim),
    underfit_risk: round4(underfit),
    passed: false,
    failure_reason: null,
    judge_feedback: 'Deterministic similarity evaluation.',
    missing_elements: missingElements(owner, answer, example.intent_type),
    extra_elements: extraElements(owner, answer, example.intent_type),
  }
}

async function judgeWithLLMSafe(example, agent, fallback) {
  try {
    return await judgeWithLLM(example, agent)
  } catch (err) {
    return { ...fallback, judge_feedback: `LLM judge fallback: ${errorMessage(err)}` }
  }
}

async function judgeWithLLM(example, agent) {
  const provider = resolvedProvider()
  const prompt = `${JUDGE_PROMPT}\n\n${JSON.stringify({ prompt: example.prompt, owner_answer: example.owner_answer, agent_answer: agent.answer, expected_intent: example.intent_type, actual_intent: agent.intent_type }, null, 2)}`
  if (provider === 'claude-code') {
    const output = await runCommand(process.env.CLAUDE_CODE_COMMAND ?? 'claude', ['--bare', '--no-session-persistence', '--output-format', 'text', '-p', prompt], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
    return normalizeJudge(parseJsonOrThrow(output, 'Claude Code judge'))
  }
  if (provider === 'anthropic') {
    const baseUrl = requiredEnv('SIMILARITY_EVAL_BASE_URL', process.env.OWNER_CALIBRATION_BASE_URL ?? process.env.RESPONSE_INFERENCE_BASE_URL ?? process.env.COMMUNICATION_BASE_URL ?? process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('SIMILARITY_EVAL_API_KEY', process.env.OWNER_CALIBRATION_API_KEY ?? process.env.RESPONSE_INFERENCE_API_KEY ?? process.env.COMMUNICATION_API_KEY ?? process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
    const model = requiredEnv('SIMILARITY_EVAL_MODEL', process.env.OWNER_CALIBRATION_MODEL ?? process.env.RESPONSE_INFERENCE_MODEL ?? process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL)
    const res = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 2500, system: JUDGE_PROMPT, messages: [{ role: 'user', content: prompt }] }) })
    if (!res.ok) throw new Error(`Anthropic judge HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    const text = Array.isArray(data.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
    return normalizeJudge(parseJsonOrThrow(text, 'Anthropic judge'))
  }
  if (provider === 'openai') {
    const baseUrl = requiredEnv('SIMILARITY_EVAL_BASE_URL', process.env.OWNER_CALIBRATION_BASE_URL ?? process.env.RESPONSE_INFERENCE_BASE_URL ?? process.env.COMMUNICATION_BASE_URL ?? process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('SIMILARITY_EVAL_API_KEY', process.env.OWNER_CALIBRATION_API_KEY ?? process.env.RESPONSE_INFERENCE_API_KEY ?? process.env.COMMUNICATION_API_KEY ?? process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY)
    const model = requiredEnv('SIMILARITY_EVAL_MODEL', process.env.OWNER_CALIBRATION_MODEL ?? process.env.RESPONSE_INFERENCE_MODEL ?? process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL)
    const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: JUDGE_PROMPT }, { role: 'user', content: prompt }] }) })
    if (!res.ok) throw new Error(`OpenAI judge HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    return normalizeJudge(parseJsonOrThrow(data?.choices?.[0]?.message?.content ?? '', 'OpenAI judge'))
  }
  throw new Error(`SIMILARITY_EVAL_PROVIDER belum didukung untuk judge ini: ${provider}`)
}

function normalizeJudge(raw) {
  return {
    similarity_score: round4(clampNumber(raw.similarity_score, 0, 1, 0)),
    fidelity_score: round4(clampNumber(raw.fidelity_score, 0, 1, 0)),
    style_match_score: round4(clampNumber(raw.style_match_score, 0, 1, 0)),
    intent_match_score: round4(clampNumber(raw.intent_match_score, 0, 1, 0)),
    tone_match_score: round4(clampNumber(raw.tone_match_score, 0, 1, 0)),
    length_match_score: round4(clampNumber(raw.length_match_score, 0, 1, 0)),
    too_ai_score: round4(clampNumber(raw.too_ai_score, 0, 1, 0)),
    overclaim_risk: round4(clampNumber(raw.overclaim_risk, 0, 1, 0)),
    underfit_risk: round4(clampNumber(raw.underfit_risk, 0, 1, 0)),
    passed: raw.passed === true,
    failure_reason: typeof raw.failure_reason === 'string' ? raw.failure_reason : null,
    judge_feedback: typeof raw.judge_feedback === 'string' ? raw.judge_feedback : '',
    missing_elements: asArray(raw.missing_elements),
    extra_elements: asArray(raw.extra_elements),
  }
}

function mergeJudge(a, b) {
  if (!b || b === a) return a
  return {
    similarity_score: avg(a.similarity_score, b.similarity_score),
    fidelity_score: avg(a.fidelity_score, b.fidelity_score),
    style_match_score: avg(a.style_match_score, b.style_match_score),
    intent_match_score: avg(a.intent_match_score, b.intent_match_score),
    tone_match_score: avg(a.tone_match_score, b.tone_match_score),
    length_match_score: avg(a.length_match_score, b.length_match_score),
    too_ai_score: avg(a.too_ai_score, b.too_ai_score),
    overclaim_risk: avg(a.overclaim_risk, b.overclaim_risk),
    underfit_risk: avg(a.underfit_risk, b.underfit_risk),
    passed: false,
    failure_reason: b.failure_reason ?? a.failure_reason,
    judge_feedback: b.judge_feedback || a.judge_feedback,
    missing_elements: unique([...a.missing_elements, ...asArray(b.missing_elements)]),
    extra_elements: unique([...a.extra_elements, ...asArray(b.extra_elements)]),
  }
}

function summarize(rows) {
  const total = rows.length || 1
  const avgKey = (key) => round4(rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0) / total)
  const average_similarity_score = avgKey('similarity_score')
  const average_fidelity_score = avgKey('fidelity_score')
  const average_style_match_score = avgKey('style_match_score')
  const average_intent_match_score = avgKey('intent_match_score')
  const average_tone_match_score = avgKey('tone_match_score')
  const average_length_match_score = avgKey('length_match_score')
  const average_too_ai_score = avgKey('too_ai_score')
  const average_overclaim_risk = avgKey('overclaim_risk')
  const average_underfit_risk = avgKey('underfit_risk')
  const rawOverall =
    0.25 * average_similarity_score +
    0.25 * average_fidelity_score +
    0.2 * average_style_match_score +
    0.1 * average_intent_match_score +
    0.1 * average_tone_match_score +
    0.1 * average_length_match_score -
    (average_too_ai_score * 0.12 + average_overclaim_risk * 0.1 + average_underfit_risk * 0.1)
  return {
    total_cases: rows.length,
    passed_cases: rows.filter((row) => row.passed).length,
    failed_cases: rows.filter((row) => !row.passed).length,
    regression_count: rows.filter((row) => row.regressed).length,
    improvement_count: rows.filter((row) => row.improved).length,
    average_similarity_score,
    average_fidelity_score,
    average_style_match_score,
    average_intent_match_score,
    average_tone_match_score,
    average_length_match_score,
    average_too_ai_score,
    average_overclaim_risk,
    average_underfit_risk,
    overall_score: round4(rawOverall),
  }
}

function verdictFor(summary) {
  if (summary.regression_count >= Math.max(3, Math.ceil(summary.total_cases * 0.35)) || summary.average_overclaim_risk > 0.45) return 'blocked'
  if (summary.overall_score >= 0.9 && summary.regression_count === 0) return 'excellent'
  if (summary.overall_score >= 0.8) return 'good'
  if (summary.overall_score >= 0.7 || summary.regression_count > 0) return 'warning'
  return 'bad'
}

function passCase(score) {
  return score.similarity_score >= Number(process.env.SIMILARITY_EVAL_MIN_PASS_SCORE ?? 0.75)
    && score.fidelity_score >= Number(process.env.SIMILARITY_EVAL_MIN_PASS_SCORE ?? 0.75)
    && score.too_ai_score <= Number(process.env.SIMILARITY_EVAL_MAX_TOO_AI_SCORE ?? 0.25)
    && score.overclaim_risk <= Number(process.env.SIMILARITY_EVAL_MAX_OVERCLAIM_RISK ?? 0.3)
    && score.underfit_risk <= Number(process.env.SIMILARITY_EVAL_MAX_UNDERFIT_RISK ?? 0.35)
}

function compareRegression(score, baselineResult) {
  if (!baselineResult) return { regression_score: 0, regressed: false, improved: false }
  const threshold = Number(process.env.SIMILARITY_EVAL_REGRESSION_THRESHOLD ?? 0.1)
  const current = score.fidelity_score
  const base = Number(baselineResult.fidelity_score ?? 0)
  const delta = current - base
  return { regression_score: round4(Math.max(0, -delta)), regressed: delta <= -threshold, improved: delta >= threshold }
}

function failureReason(score, regression) {
  if (regression.regressed) return 'Regression dibanding baseline.'
  if (score.too_ai_score > Number(process.env.SIMILARITY_EVAL_MAX_TOO_AI_SCORE ?? 0.25)) return 'Jawaban terlalu AI-like.'
  if (score.overclaim_risk > Number(process.env.SIMILARITY_EVAL_MAX_OVERCLAIM_RISK ?? 0.3)) return 'Overclaim risk tinggi.'
  if (score.underfit_risk > Number(process.env.SIMILARITY_EVAL_MAX_UNDERFIT_RISK ?? 0.35)) return 'Underfit risk tinggi.'
  if (score.similarity_score < Number(process.env.SIMILARITY_EVAL_MIN_PASS_SCORE ?? 0.75)) return 'Similarity di bawah threshold.'
  if (score.fidelity_score < Number(process.env.SIMILARITY_EVAL_MIN_PASS_SCORE ?? 0.75)) return 'Fidelity di bawah threshold.'
  return null
}

function recommendations(score, regression, example) {
  const items = []
  if (regression.regressed) items.push('Bandingkan dengan baseline dan restore calibration hint yang sebelumnya efektif.')
  if (score.too_ai_score > 0.25) items.push('Tambahkan/aktifkan avoid_phrase hint untuk intent ini.')
  if (score.overclaim_risk > 0.3) items.push('Kurangi klaim identitas/fakta untuk prompt ringan atau tanpa evidence.')
  if (score.underfit_risk > 0.35) items.push('Tambah owner example atau calibration hint agar gaya tidak terlalu umum.')
  if (example.intent_type === 'social_greeting' && !score.passed) items.push('Tambahkan greeting_reply hint dengan preferred response owner.')
  if (example.intent_type === 'request_prompt' && !score.passed) items.push('Tambahkan prompt_structure hint: writing block, acceptance criteria, batasan.')
  return items
}

function strictSimilarity(a, b) {
  const tokenScore = tokenOverlap(a, b)
  const phraseScore = phraseMatch(a, b)
  const editScore = normalizedEditScore(normalizeWords(a), normalizeWords(b))
  const lengthPenalty = Math.abs(tokens(a).length - tokens(b).length) / Math.max(1, Math.max(tokens(a).length, tokens(b).length))
  return clamp(tokenScore * 0.42 + phraseScore * 0.28 + editScore * 0.2 + (1 - lengthPenalty) * 0.1)
}

function tokenOverlap(a, b) {
  const aa = new Set(tokens(a))
  const bb = new Set(tokens(b))
  if (!aa.size && !bb.size) return 1
  if (!aa.size || !bb.size) return 0
  return [...aa].filter((token) => bb.has(token)).length / new Set([...aa, ...bb]).size
}

function phraseMatch(a, b) {
  const an = normalizeWords(a)
  const bn = normalizeWords(b)
  if (an === bn) return 1
  const phrases = keyPhrases(an)
  if (!phrases.length) return 0
  return phrases.filter((phrase) => bn.includes(phrase)).length / phrases.length
}

function normalizedEditScore(a, b) {
  if (!a && !b) return 1
  const max = Math.max(a.length, b.length, 1)
  const distance = levenshtein(a.slice(0, 500), b.slice(0, 500))
  return clamp(1 - distance / max)
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j - 1], dp[j]) + 1
      prev = tmp
    }
  }
  return dp[b.length]
}

function classifyLength(text) {
  const count = tokens(text).length
  if (count <= 4) return 'very_short'
  if (count <= 14) return 'short'
  if (count <= 60) return 'medium'
  return 'long'
}

function lengthScore(expected, actual) {
  const distance = Math.abs(LENGTH_CLASSES.indexOf(expected) - LENGTH_CLASSES.indexOf(actual))
  return distance === 0 ? 1 : distance === 1 ? 0.68 : distance === 2 ? 0.35 : 0.15
}

function inferTone(text, intent) {
  const normalized = normalizeWords(text)
  if (intent === 'technical_instruction' || /\b(command|file|script|kode|migration|step)\b/.test(normalized)) return 'technical'
  if (intent === 'strategy_question' || /\b(fokus|prioritas|harus|stop|lanjut|langsung)\b/.test(normalized)) return 'firm'
  if (/\b(menurut|rasanya|kemungkinan|refleksi|data belum cukup)\b/.test(normalized)) return 'reflective'
  if (/\b(bro|iya|kenapa|apa|halo|pagi|malam|wa alaikum)\b/.test(normalized)) return 'casual'
  return 'neutral'
}

function toneScore(a, b) {
  if (a === b) return 1
  if ([a, b].includes('neutral')) return 0.62
  if ([a, b].includes('casual') && [a, b].includes('firm')) return 0.72
  return 0.42
}

function inferAnswerStyle(answer, intent) {
  if (intent === 'request_prompt' || /```|acceptance|criteria|step|batasan/i.test(answer)) return 'prompt_ready'
  if (intent === 'technical_instruction' || /\b(command|file|script|kode|npm)\b/i.test(answer)) return 'technical_step_by_step'
  if (tokens(answer).length <= 8) return 'short_direct'
  if (intent === 'strategy_question') return 'strategic_direct'
  return 'neutral'
}

function formatScore(example, answer) {
  if (example.answer_style === 'prompt_ready') return /```|acceptance|criteria|step|batasan|tugas/i.test(answer) ? 1 : 0.25
  if (example.answer_style === 'technical_step_by_step') return /\n?1\.|```|npm|file|command/i.test(answer) ? 1 : 0.45
  if (example.answer_style === 'short_direct') return tokens(answer).length <= 8 ? 1 : 0.25
  return 0.72
}

function tooAiScore(text, intent) {
  const normalized = normalizeWords(text)
  const phrases = ['sebagai ai', 'berdasarkan data yang tersedia', 'memory yang tersedia', 'saya dapat membantu', 'apakah ada yang bisa saya bantu', 'berikut beberapa hal', 'semoga membantu', 'dari informasi yang diberikan']
  let score = phrases.reduce((sum, phrase) => sum + (normalized.includes(phrase) ? 0.18 : 0), 0)
  if (intent === 'social_greeting' && tokens(text).length > 8) score += 0.25
  if (intent === 'social_greeting' && /\banda|membantu|hari ini|informasi\b/i.test(text)) score += 0.25
  if (/^\s*(tentu|baik|berikut|saya bisa)/i.test(text)) score += 0.12
  return clamp(score)
}

function overclaimRisk(example, answer) {
  if (['social_greeting', 'casual_reply'].includes(example.intent_type) && /\bdiary|identitas|memory|data|project|goal|kamu biasanya|pemilik diary\b/i.test(answer)) return 0.55
  const owner = new Set(tokens(example.owner_answer))
  const risky = tokens(answer).filter((token) => ['selalu', 'pasti', 'tidak', 'pernah', 'identitas', 'sifat', 'pola', 'tujuan', 'project', 'orang'].includes(token) && !owner.has(token))
  return clamp(risky.length * 0.1)
}

function underfitRisk(example, answer, similarity, tooAi) {
  let risk = 0
  if (similarity < 0.5) risk += 0.22
  if (tooAi > 0.2) risk += 0.22
  if (/\bsecara umum|pada dasarnya|ada beberapa hal\b/i.test(answer)) risk += 0.2
  if (example.intent_type === 'request_prompt' && !/```|acceptance|criteria|step|batasan|tugas/i.test(answer)) risk += 0.28
  if (example.intent_type === 'social_greeting' && !/^(halo|hai|iya|wa|pagi|malam)/i.test(answer.trim())) risk += 0.22
  return clamp(risk)
}

function missingElements(owner, answer, intent) {
  const missing = []
  const an = normalizeWords(answer)
  for (const phrase of keyPhrases(normalizeWords(owner))) if (!an.includes(phrase)) missing.push(phrase)
  if (intent === 'request_prompt') for (const phrase of ['step', 'acceptance criteria', 'batasan']) if (normalizeWords(owner).includes(normalizeWords(phrase)) && !an.includes(normalizeWords(phrase))) missing.push(phrase)
  return unique(missing).slice(0, 8)
}

function extraElements(owner, answer, intent) {
  const extra = []
  const on = normalizeWords(owner)
  const an = normalizeWords(answer)
  for (const phrase of ['sebagai ai', 'berdasarkan data', 'memory yang tersedia', 'semoga membantu', 'ada yang bisa saya bantu', 'dari informasi yang diberikan']) if (an.includes(phrase) && !on.includes(phrase)) extra.push(phrase)
  if (['social_greeting', 'casual_reply'].includes(intent) && tokens(answer).length > tokens(owner).length + 8) extra.push('jawaban terlalu panjang untuk prompt ringan')
  return unique(extra).slice(0, 8)
}

async function getActiveBaseline(supabase, userId) {
  const { data, error } = await supabase.from('similarity_baselines').select('*').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

async function getBaselineResults(supabase, userId, runId) {
  const { data, error } = await supabase.from('similarity_eval_results').select('*').eq('user_id', userId).eq('similarity_eval_run_id', runId)
  if (error) throw error
  return data ?? []
}

function writeSimilarityReports(latest) {
  const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
  const dir = resolve(vaultPath, '_system', 'similarity')
  mkdirSync(dir, { recursive: true })
  const markerStart = '<!-- SIMILARITY_EVAL_AUTO_START -->'
  const markerEnd = '<!-- SIMILARITY_EVAL_AUTO_END -->'
  const run = latest.run
  const content = [
    '# Similarity Evaluation Latest',
    '',
    markerStart,
    `Generated: ${new Date().toISOString()}`,
    `Overall score: ${run?.overall_score ?? 0}`,
    `Verdict: ${run?.verdict ?? 'none'}`,
    `Passed/Failed: ${run?.passed_cases ?? 0}/${run?.failed_cases ?? 0}`,
    `Regressions: ${run?.regression_count ?? 0}`,
    `Improvements: ${run?.improvement_count ?? 0}`,
    '',
    '## Worst Cases',
    ...[...(latest.failed_cases ?? [])].sort((a, b) => Number(a.fidelity_score) - Number(b.fidelity_score)).slice(0, 10).map((r) => `- ${r.intent_type}: ${r.prompt} (${r.fidelity_score}) — ${r.failure_reason ?? 'failed'}`),
    '',
    '## Improved Cases',
    ...(latest.results ?? []).filter((r) => r.improved).map((r) => `- ${r.intent_type}: ${r.prompt} (+${r.regression_score})`),
    '',
    '## Recommended Fixes',
    ...recommendedFixes(latest.results ?? [], run?.verdict ?? 'warning').map((item) => `- ${item}`),
    markerEnd,
    '',
  ].join('\n')
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
  writeFileSync(resolve(dir, 'Similarity Evaluation Latest.md'), content, 'utf8')
  if (run) writeFileSync(resolve(dir, `Similarity Evaluation ${stamp}.md`), content, 'utf8')
  const baseline = latest.baseline
  writeFileSync(resolve(dir, 'Similarity Baseline.md'), [
    '# Similarity Baseline',
    '',
    markerStart,
    baseline ? `Active baseline: ${baseline.label}\nOverall: ${baseline.overall_score}\nCases: ${baseline.case_count}` : 'No active baseline.',
    markerEnd,
    '',
  ].join('\n'), 'utf8')
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
  for (const table of ['owner_answer_examples', 'raw_entries', 'identity_facts', 'communication_patterns', 'brain_nodes']) {
    const { data, error } = await supabase.from(table).select('user_id').limit(1).maybeSingle()
    if (!error && data?.user_id) return data.user_id
  }
  return null
}

function avgIntent(results, intent) {
  const rows = results.filter((result) => result.intent_type === intent)
  if (!rows.length) return null
  return round4(rows.reduce((sum, row) => sum + Number(row.fidelity_score ?? 0), 0) / rows.length)
}

function recommendedFixes(rows, verdict) {
  const fixes = []
  if (verdict === 'bad' || verdict === 'blocked') fixes.push('Review failed cases sebelum mempercayai self-clone chat.')
  if (rows.some((r) => r.regressed)) fixes.push('Bandingkan regressed cases dengan baseline dan calibration hints sebelumnya.')
  if (rows.some((r) => Number(r.too_ai_score) > 0.25)) fixes.push('Tambah avoid_phrase hints untuk frasa assistant umum.')
  if (rows.some((r) => Number(r.overclaim_risk) > 0.3)) fixes.push('Turunkan klaim identitas/fakta pada prompt ringan.')
  if (rows.some((r) => Number(r.underfit_risk) > 0.35)) fixes.push('Tambah owner examples dan response shape hints untuk intent terkait.')
  return fixes.length ? fixes : ['Tidak ada fix wajib.']
}

function auditFixes(warnings) {
  if (!warnings.length) return ['Tidak ada fix wajib. Jalankan similarity eval berkala setelah update besar.']
  return warnings.map((warning) => {
    if (warning.includes('owner examples')) return 'Jalankan npm run owner:examples -- --seed atau tambah examples manual.'
    if (warning.includes('coverage')) return 'Tambah owner examples untuk intent yang belum terwakili.'
    if (warning.includes('baseline')) return 'Jalankan npm run similarity:baseline -- --create --activate setelah run yang baik.'
    if (warning.includes('regression')) return 'Review regressed cases dan calibration hints yang berubah.'
    if (warning.includes('too AI')) return 'Tambah avoid_phrase hints.'
    return 'Review latest similarity report.'
  })
}

function keyPhrases(normalized) {
  const words = normalized.split(' ').filter((word) => word.length > 3)
  const phrases = []
  for (let i = 0; i < words.length - 1; i += 1) phrases.push(words.slice(i, i + 2).join(' '))
  return phrases.slice(0, 12)
}

function tokens(text) { return normalizeWords(text).split(' ').filter((token) => token.length > 1) }
function normalizeWords(value) { return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() }
function asArray(value) { return Array.isArray(value) ? value : [] }
function unique(value) { return [...new Set(value.filter(Boolean))] }
function avg(a, b) { return round4((Number(a ?? 0) + Number(b ?? 0)) / 2) }
function clamp(value) { const num = Number(value); return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0 }
function clampNumber(value, min, max, fallback) { const num = Number(value); return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback }
function round4(value) { return Number(clamp(value).toFixed(4)) }
function errorMessage(err) { return err instanceof Error ? err.message : String(err) }
function useJudge(options) { if (typeof options.useJudge === 'boolean') return options.useJudge; return readBoolEnv('SIMILARITY_EVAL_USE_LLM_JUDGE', false) }
function resolvedProvider() { return (process.env.SIMILARITY_EVAL_PROVIDER || process.env.OWNER_CALIBRATION_PROVIDER || process.env.RESPONSE_INFERENCE_PROVIDER || process.env.COMMUNICATION_PROVIDER || process.env.IDENTITY_PROVIDER || process.env.BRAIN_CHAT_PROVIDER || process.env.LLM_PROVIDER || 'claude-code').toLowerCase() }
function requiredEnv(name, fallback) { const value = process.env[name] || fallback; if (!value) throw new Error(`${name} belum diset.`); return value }
function readBoolEnv(name, fallback) { const value = process.env[name]; if (value === undefined || value === '') return fallback; return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) }
function parseJsonOrThrow(text, label) { const raw = String(text ?? '').trim(); try { return JSON.parse(raw) } catch { const match = raw.match(/\{[\s\S]*\}/); if (!match) throw new Error(`${label} tidak menghasilkan JSON valid.`); return JSON.parse(match[0]) } }
function runCommand(command, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timeout setelah ${timeoutMs}ms`)) }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolvePromise(output) : reject(new Error(`${command} exited ${code}: ${output.slice(0, 1000)}`)) })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}
function parseArgs(argv) { const args = new Map(); for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (!arg.startsWith('--')) continue; const key = arg.slice(2); const next = argv[i + 1]; if (next && !next.startsWith('--')) { args.set(key, next); i += 1 } else args.set(key, true) } return args }
function readOptionalArg(args, name) { const value = args.get(name); return typeof value === 'string' && value.trim() ? value.trim() : null }
function readIntArg(args, name, fallback, min, max) { const raw = args.get(name); const value = raw ? Number(raw) : fallback; return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback }
function loadEnv(path, options = {}) { if (!existsSync(path)) return; const raw = readFileSync(path, 'utf8'); for (const line of raw.split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue; const index = trimmed.indexOf('='); const key = trimmed.slice(0, index).trim(); let value = trimmed.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (options.override || process.env[key] === undefined) process.env[key] = value } }
