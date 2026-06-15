import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { runResponseInference } from './response-inference.mjs'

const JUDGE_SYSTEM_PROMPT = `Kamu adalah Owner Answer Calibration Judge untuk Personal Entity OS.

Tugas:
Bandingkan jawaban agent dengan jawaban asli pemilik diary.

Nilai:
- apakah maksudnya sama
- apakah gaya bahasanya mirip
- apakah panjangnya mirip
- apakah tone-nya mirip
- apakah terlalu AI
- apakah agent menambah hal yang tidak diminta
- apakah agent kehilangan elemen penting dari owner answer

Jangan menilai jawaban mana yang lebih pintar.
Nilai mana yang lebih mirip pemilik diary.
Output harus JSON valid.`

const INTENTS = ['social_greeting', 'casual_reply', 'request_prompt', 'technical_instruction', 'strategy_question', 'correction', 'identity_question', 'contradiction_check', 'decision_help', 'personal_reflection', 'unknown']
const ANSWER_STYLES = ['short_direct', 'casual_direct', 'technical_step_by_step', 'prompt_ready', 'strategic_direct', 'reflective', 'corrective', 'neutral']
const TONES = ['direct', 'casual', 'firm', 'technical', 'reflective', 'neutral', 'mixed']
const FORMALITIES = ['very_casual', 'casual', 'neutral', 'formal']
const LENGTH_CLASSES = ['very_short', 'short', 'medium', 'long']

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const command = detectCommand(args)
    if (command === 'examples') {
      if (args.has('seed')) console.log(JSON.stringify(await seedOwnerExamples({ force: args.get('force') === 'true' }), null, 2))
      else console.log(JSON.stringify(await listOwnerExamples(), null, 2))
    } else if (command === 'calibrate') {
      console.log(JSON.stringify(await runOwnerCalibration({
        limit: readIntArg(args, 'limit', Number(process.env.OWNER_CALIBRATION_MAX_EXAMPLES ?? 100), 1, 500),
        intentType: readOptionalArg(args, 'intent'),
        useJudge: args.has('use-judge') ? true : undefined,
      }), null, 2))
    } else if (command === 'latest') {
      console.log(JSON.stringify(await getLatestOwnerCalibration(), null, 2))
    } else if (command === 'hints') {
      console.log(JSON.stringify(await listOwnerHints(), null, 2))
    } else if (command === 'audit') {
      console.log(JSON.stringify(await auditOwnerCalibration(), null, 2))
    } else if (command === 'add-example') {
      console.log(JSON.stringify(await addOwnerExample({
        prompt: readRequiredArg(args, 'prompt'),
        ownerAnswer: readRequiredArg(args, 'owner-answer'),
        intentType: readOptionalArg(args, 'intent') || 'unknown',
        answerStyle: readOptionalArg(args, 'answer-style') || 'neutral',
        contextNote: readOptionalArg(args, 'context-note') || '',
      }), null, 2))
    } else {
      throw new Error('Command tidak dikenal. Pakai --examples, --calibrate, --latest, --hints, atau --audit.')
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export async function seedOwnerExamples(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk owner examples.')
  const rows = seedRows(userId).map(enrichExampleRow)
  const query = supabase.from('owner_answer_examples')
  const res = options.force
    ? await query.upsert(rows, { onConflict: 'user_id,example_hash', ignoreDuplicates: false }).select('*')
    : await query.upsert(rows, { onConflict: 'user_id,example_hash', ignoreDuplicates: true }).select('*')
  if (res.error) throw res.error
  return { ok: true, examples_seeded: res.data?.length ?? rows.length, examples: res.data ?? [] }
}

export async function listOwnerExamples(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk owner examples.')
  const { data, error } = await supabase
    .from('owner_answer_examples')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 100)
  if (error) throw error
  return { ok: true, examples: data ?? [] }
}

export async function addOwnerExample(input, options = {}) {
  validateExampleInput(input)
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk add owner example.')
  const row = enrichExampleRow({
    user_id: userId,
    prompt: input.prompt.trim(),
    owner_answer: input.ownerAnswer.trim(),
    intent_type: input.intentType,
    answer_style: input.answerStyle,
    context_note: input.contextNote || null,
    source_type: input.sourceType || 'manual',
    metadata: { added_by: 'owner-calibration' },
  })
  const { data, error } = await supabase.from('owner_answer_examples').insert(row).select('*').single()
  if (error) throw error
  return { ok: true, example: data }
}

export async function runOwnerCalibration(options = {}) {
  if (!readBoolEnv('OWNER_CALIBRATION_ENABLED', true)) throw new Error('OWNER_CALIBRATION_ENABLED=false.')
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk owner calibration.')
  const limit = Math.max(1, Math.min(500, Number(options.limit ?? process.env.OWNER_CALIBRATION_MAX_EXAMPLES ?? 100)))
  const intentType = options.intentType && INTENTS.includes(options.intentType) ? options.intentType : null
  let query = supabase
    .from('owner_answer_examples')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (intentType) query = query.eq('intent_type', intentType)
  const examplesRes = await query
  if (examplesRes.error) throw examplesRes.error
  const examples = examplesRes.data ?? []
  if (!examples.length) throw new Error('Tidak ada owner_answer_examples active untuk dikalibrasi.')

  const runInsert = await supabase
    .from('owner_calibration_runs')
    .insert({
      user_id: userId,
      title: `Owner Calibration ${new Date().toISOString()}`,
      status: 'running',
      total_examples: examples.length,
      started_at: new Date().toISOString(),
      metadata: { intent_type: intentType, use_judge: useJudge(options) },
    })
    .select('*')
    .single()
  if (runInsert.error) throw runInsert.error
  const run = runInsert.data

  try {
    const results = []
    for (const example of examples) {
      const agent = await runResponseInference({ question: example.prompt, options: { userId, source: 'owner-calibration', useLLM: true } })
      const deterministic = scoreCalibration(example, agent)
      const judged = useJudge(options) ? await judgeWithLLMSafe(example, agent, deterministic) : deterministic
      const final = mergeJudge(deterministic, judged)
      const hints = buildCalibrationHints(example, agent, final)
      final.calibration_hints = hints
      const row = {
        user_id: userId,
        calibration_run_id: run.id,
        owner_answer_example_id: example.id,
        prompt: example.prompt,
        owner_answer: example.owner_answer,
        agent_answer: agent.answer,
        intent_type: example.intent_type,
        actual_intent_type: agent.intent_type ?? agent.debug?.intent_type ?? 'unknown',
        similarity_score: final.similarity_score,
        style_match_score: final.style_match_score,
        intent_match_score: final.intent_match_score,
        length_match_score: final.length_match_score,
        tone_match_score: final.tone_match_score,
        fidelity_score: final.fidelity_score,
        overclaim_risk: final.overclaim_risk,
        underfit_risk: final.underfit_risk,
        too_ai_score: final.too_ai_score,
        missing_elements: final.missing_elements,
        extra_elements: final.extra_elements,
        calibration_hints: hints,
        judge_feedback: final.judge_feedback,
        passed: final.passed,
        metadata: {
          agent_inference_log_id: agent.response_inference_log_id,
          agent_scores: agent.inference_scores ?? null,
          deterministic_scoring: deterministic,
        },
      }
      const saved = await supabase.from('owner_calibration_results').insert(row).select('*').single()
      if (saved.error) throw saved.error
      results.push(saved.data)
      if (readBoolEnv('OWNER_CALIBRATION_APPLY_HINTS', true)) await upsertHints(supabase, userId, example, hints)
    }
    const summary = summarizeResults(results)
    const update = await supabase
      .from('owner_calibration_runs')
      .update({ ...summary, status: 'done', finished_at: new Date().toISOString() })
      .eq('id', run.id)
      .select('*')
      .single()
    if (update.error) throw update.error
    const latest = await getLatestOwnerCalibration({ userId, supabase })
    if (readBoolEnv('OWNER_CALIBRATION_OUTPUT_OBSIDIAN', true)) writeCalibrationReports(latest)
    return { ok: true, run: update.data, results, hints_created: results.reduce((sum, result) => sum + asArray(result.calibration_hints).length, 0) }
  } catch (err) {
    await supabase.from('owner_calibration_runs').update({ status: 'failed', finished_at: new Date().toISOString(), metadata: { error: err instanceof Error ? err.message : String(err) } }).eq('id', run.id)
    throw err
  }
}

export async function getLatestOwnerCalibration(options = {}) {
  const supabase = options.supabase || await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk latest owner calibration.')
  const [runRes, examplesRes, hintsRes] = await Promise.all([
    supabase.from('owner_calibration_runs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('owner_answer_examples').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    supabase.from('owner_calibration_hints').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
  ])
  for (const res of [runRes, examplesRes, hintsRes]) if (res.error && res.error.code !== 'PGRST116') throw res.error
  let results = []
  if (runRes.data?.id) {
    const resultsRes = await supabase
      .from('owner_calibration_results')
      .select('*')
      .eq('user_id', userId)
      .eq('calibration_run_id', runRes.data.id)
      .order('created_at', { ascending: true })
    if (resultsRes.error) throw resultsRes.error
    results = resultsRes.data ?? []
  }
  return { ok: true, run: runRes.data ?? null, results, examples: examplesRes.data ?? [], hints: hintsRes.data ?? [] }
}

export async function listOwnerHints(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk owner hints.')
  const { data, error } = await supabase
    .from('owner_calibration_hints')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 100)
  if (error) throw error
  return { ok: true, hints: data ?? [] }
}

export async function auditOwnerCalibration(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk owner calibration audit.')
  const [examplesRes, latestRes, hintsRes, needsReviewHintsRes] = await Promise.all([
    supabase.from('owner_answer_examples').select('id,intent_type,status').eq('user_id', userId),
    supabase.from('owner_calibration_runs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('owner_calibration_hints').select('id,intent_type,status').eq('user_id', userId).eq('status', 'active'),
    supabase.from('owner_calibration_hints').select('id,intent_type,status').eq('user_id', userId).eq('status', 'needs_review'),
  ])
  for (const res of [examplesRes, latestRes, hintsRes, needsReviewHintsRes]) if (res.error && res.error.code !== 'PGRST116') throw res.error
  const examples = examplesRes.data ?? []
  const activeExamples = examples.filter((item) => item.status === 'active')
  const coverage = [...new Set(activeExamples.map((item) => item.intent_type))]
  const warnings = []
  if (examples.length === 0) warnings.push('Belum ada owner answer examples.')
  if (activeExamples.length === 0) warnings.push('Belum ada active owner answer examples.')
  if (!coverage.includes('social_greeting')) warnings.push('Social greeting examples belum ada.')
  if (!coverage.includes('request_prompt')) warnings.push('Request prompt examples belum ada.')
  if (!latestRes.data) warnings.push('Calibration run belum pernah dijalankan.')
  if (latestRes.data && Number(latestRes.data.average_fidelity_score ?? 0) < Number(process.env.OWNER_CALIBRATION_MIN_PASS_SCORE ?? 0.75)) warnings.push('Average fidelity score masih di bawah threshold.')
  if (latestRes.data && Number(latestRes.data.too_ai_count ?? 0) > 0) warnings.push(`${latestRes.data.too_ai_count} result terdeteksi terlalu AI.`)
  if (latestRes.data && Number(latestRes.data.overclaim_count ?? 0) > 0) warnings.push(`${latestRes.data.overclaim_count} result punya overclaim risk tinggi.`)
  if (latestRes.data && Number(latestRes.data.underfit_count ?? 0) > 0) warnings.push(`${latestRes.data.underfit_count} result punya underfit risk tinggi.`)
  if ((hintsRes.data ?? []).length === 0) warnings.push('Belum ada active calibration hints.')
  let score = 100 - warnings.length * 10
  if (activeExamples.length < 4) score -= 10
  if (!latestRes.data) score -= 15
  score = Math.max(0, Math.min(100, score))
  return {
    ok: true,
    status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
    score,
    warnings,
    recommended_fixes: ownerRecommendedFixes(warnings),
    checks: {
      examples: examples.length,
      active_examples: activeExamples.length,
      intent_coverage: coverage,
      social_greeting_examples: activeExamples.filter((item) => item.intent_type === 'social_greeting').length,
      request_prompt_examples: activeExamples.filter((item) => item.intent_type === 'request_prompt').length,
      latest_calibration_run: latestRes.data ?? null,
      average_fidelity_score: Number(latestRes.data?.average_fidelity_score ?? 0),
      too_ai_count: Number(latestRes.data?.too_ai_count ?? 0),
      overclaim_count: Number(latestRes.data?.overclaim_count ?? 0),
      underfit_count: Number(latestRes.data?.underfit_count ?? 0),
      active_hints: (hintsRes.data ?? []).length,
      needs_review_hints: (needsReviewHintsRes.data ?? []).length,
    },
  }
}

function scoreCalibration(example, agent) {
  const owner = example.owner_answer
  const answer = agent.answer ?? ''
  const similarity = textSimilarity(owner, answer)
  const ownerLength = classifyLength(owner)
  const agentLength = classifyLength(answer)
  const lengthMatch = lengthScore(ownerLength, agentLength)
  const expectedTone = example.tone || inferTone(owner, example.intent_type)
  const actualTone = inferTone(answer, agent.intent_type ?? agent.debug?.intent_type)
  const toneMatch = expectedTone === actualTone ? 1 : (expectedTone === 'mixed' || actualTone === 'mixed' ? 0.75 : 0.45)
  const actualIntent = agent.intent_type ?? agent.debug?.intent_type ?? 'unknown'
  const intentMatch = example.intent_type === actualIntent ? 1 : 0
  const tooAi = tooAiScore(answer, example.intent_type)
  const overclaim = overclaimRisk(example, answer)
  const underfit = underfitRisk(example, answer, similarity, tooAi)
  const formatScore = formatMatchScore(example, answer)
  const style = clamp((lengthMatch * 0.35) + (toneMatch * 0.3) + (formatScore * 0.2) + ((1 - tooAi) * 0.15))
  const fidelity = clamp((similarity * 0.35) + (style * 0.25) + (intentMatch * 0.2) + ((1 - overclaim) * 0.1) + ((1 - underfit) * 0.1))
  const missing = missingElements(owner, answer, example.intent_type)
  const extra = extraElements(owner, answer, example.intent_type)
  const passed = fidelity >= Number(process.env.OWNER_CALIBRATION_MIN_PASS_SCORE ?? 0.75)
  return {
    similarity_score: round4(similarity),
    style_match_score: round4(style),
    intent_match_score: round4(intentMatch),
    length_match_score: round4(lengthMatch),
    tone_match_score: round4(toneMatch),
    fidelity_score: round4(fidelity),
    overclaim_risk: round4(overclaim),
    underfit_risk: round4(underfit),
    too_ai_score: round4(tooAi),
    missing_elements: missing,
    extra_elements: extra,
    calibration_hints: [],
    passed,
    judge_feedback: passed ? 'Deterministic scoring: jawaban cukup mirip owner answer.' : 'Deterministic scoring: jawaban belum cukup mirip owner answer.',
  }
}

function buildCalibrationHints(example, agent, score) {
  if (score.passed) return []
  const hints = []
  const prompt = example.prompt
  const ownerAnswer = example.owner_answer
  const agentAnswer = agent.answer ?? ''
  if (example.intent_type === 'social_greeting') {
    hints.push({
      intent_type: 'social_greeting',
      hint_type: 'greeting_reply',
      label: 'Greeting harus pendek dan tidak assistant-like',
      description: `Untuk sapaan pendek seperti "${prompt}", gunakan respons pendek seperti "${ownerAnswer}" dan hindari gaya assistant umum.`,
      trigger_patterns: [normalizeWords(prompt), prompt].filter(Boolean),
      preferred_response: [ownerAnswer],
      avoid_response: ['Ada yang bisa saya bantu', 'Sebagai AI', 'berdasarkan data', 'memory yang tersedia'],
      response_shape_patch: { max_sentences: 1, show_sources: false, show_missing_context: false, avoid_assistant_phrases: true },
      confidence_score: clamp(0.75 + score.too_ai_score * 0.15),
      evidence_example_ids: [example.id],
    })
  }
  if (example.intent_type === 'request_prompt') {
    hints.push({
      intent_type: 'request_prompt',
      hint_type: 'prompt_structure',
      label: 'Prompt request harus siap paste',
      description: 'Untuk request prompt, hasil harus lengkap, step-by-step, memakai writing block, acceptance criteria, dan batasan jelas.',
      trigger_patterns: ['buatkan prompt', 'prompt untuk', 'step berikutnya', normalizeWords(prompt)].filter(Boolean),
      preferred_response: ['prompt siap paste', 'step-by-step', 'acceptance criteria', 'batasan jelas'],
      avoid_response: ['penjelasan teori panjang', 'jawaban terlalu pendek'],
      response_shape_patch: { format: 'writing_block', structure: 'implementation_prompt', require_acceptance_criteria: true, require_boundaries: true },
      confidence_score: 0.82,
      evidence_example_ids: [example.id],
    })
  }
  if (score.too_ai_score >= 0.25) {
    hints.push({
      intent_type: example.intent_type,
      hint_type: 'avoid_phrase',
      label: 'Hindari frasa assistant umum',
      description: 'Jawaban agent terdeteksi terlalu AI dibanding owner answer.',
      trigger_patterns: [normalizeWords(prompt)].filter(Boolean),
      preferred_response: [],
      avoid_response: detectedAiPhrases(agentAnswer),
      response_shape_patch: { avoid_assistant_phrases: true },
      confidence_score: 0.7,
      evidence_example_ids: [example.id],
    })
  }
  if (score.length_match_score < 0.7) {
    hints.push({
      intent_type: example.intent_type,
      hint_type: 'length_adjustment',
      label: 'Sesuaikan panjang jawaban dengan owner answer',
      description: `Owner answer length class adalah ${classifyLength(ownerAnswer)}; agent answer length class adalah ${classifyLength(agentAnswer)}.`,
      trigger_patterns: [normalizeWords(prompt)].filter(Boolean),
      preferred_response: [],
      avoid_response: [],
      response_shape_patch: { target_length_class: classifyLength(ownerAnswer) },
      confidence_score: 0.68,
      evidence_example_ids: [example.id],
    })
  }
  return hints
}

async function upsertHints(supabase, userId, example, hints) {
  for (const hint of hints) {
    const row = {
      user_id: userId,
      intent_type: hint.intent_type,
      hint_type: hint.hint_type,
      label: hint.label,
      description: hint.description,
      trigger_patterns: hint.trigger_patterns ?? [],
      preferred_response: hint.preferred_response ?? [],
      avoid_response: hint.avoid_response ?? [],
      response_shape_patch: hint.response_shape_patch ?? {},
      confidence_score: hint.confidence_score ?? 0.45,
      evidence_example_ids: hint.evidence_example_ids ?? [example.id],
      status: hint.confidence_score >= 0.65 ? 'active' : 'needs_review',
      metadata: { generated_from: 'owner_calibration', prompt: example.prompt },
    }
    const { error } = await supabase
      .from('owner_calibration_hints')
      .upsert(row, { onConflict: 'user_id,intent_type,hint_type,label', ignoreDuplicates: false })
    if (error) throw error
  }
}

async function judgeWithLLMSafe(example, agent, fallback) {
  try {
    return await judgeWithLLM(example, agent)
  } catch (err) {
    return { ...fallback, judge_feedback: `LLM judge fallback: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function judgeWithLLM(example, agent) {
  const provider = resolvedProvider()
  const userPrompt = `OWNER EXAMPLE:
${JSON.stringify({ prompt: example.prompt, owner_answer: example.owner_answer, intent_type: example.intent_type, answer_style: example.answer_style }, null, 2)}

AGENT ANSWER:
${JSON.stringify({ answer: agent.answer, intent_type: agent.intent_type, scores: agent.inference_scores }, null, 2)}

Balas hanya JSON valid sesuai schema:
{
  "similarity_score": 0.82,
  "style_match_score": 0.9,
  "intent_match_score": 1,
  "length_match_score": 0.8,
  "tone_match_score": 0.85,
  "fidelity_score": 0.86,
  "overclaim_risk": 0.05,
  "underfit_risk": 0.1,
  "too_ai_score": 0.05,
  "missing_elements": [],
  "extra_elements": [],
  "calibration_hints": [],
  "passed": true,
  "judge_feedback": "ringkas"
}`
  if (provider === 'claude-code') {
    const output = await runCommand(process.env.CLAUDE_CODE_COMMAND ?? 'claude', ['--bare', '--no-session-persistence', '--output-format', 'text', '-p', `${JUDGE_SYSTEM_PROMPT}\n\n${userPrompt}`], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
    return normalizeJudge(parseJsonOrThrow(output, 'Claude Code judge'))
  }
  if (provider === 'anthropic') {
    const baseUrl = requiredEnv('OWNER_CALIBRATION_BASE_URL', process.env.RESPONSE_INFERENCE_BASE_URL ?? process.env.COMMUNICATION_BASE_URL ?? process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('OWNER_CALIBRATION_API_KEY', process.env.RESPONSE_INFERENCE_API_KEY ?? process.env.COMMUNICATION_API_KEY ?? process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
    const model = requiredEnv('OWNER_CALIBRATION_MODEL', process.env.RESPONSE_INFERENCE_MODEL ?? process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL)
    const res = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 2500, system: JUDGE_SYSTEM_PROMPT, messages: [{ role: 'user', content: userPrompt }] }) })
    if (!res.ok) throw new Error(`Anthropic judge HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    const text = Array.isArray(data.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
    return normalizeJudge(parseJsonOrThrow(text, 'Anthropic judge'))
  }
  if (provider === 'openai') {
    const baseUrl = requiredEnv('OWNER_CALIBRATION_BASE_URL', process.env.RESPONSE_INFERENCE_BASE_URL ?? process.env.COMMUNICATION_BASE_URL ?? process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('OWNER_CALIBRATION_API_KEY', process.env.RESPONSE_INFERENCE_API_KEY ?? process.env.COMMUNICATION_API_KEY ?? process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY)
    const model = requiredEnv('OWNER_CALIBRATION_MODEL', process.env.RESPONSE_INFERENCE_MODEL ?? process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL)
    const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: JUDGE_SYSTEM_PROMPT }, { role: 'user', content: userPrompt }] }) })
    if (!res.ok) throw new Error(`OpenAI judge HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    return normalizeJudge(parseJsonOrThrow(data?.choices?.[0]?.message?.content ?? '', 'OpenAI judge'))
  }
  throw new Error(`OWNER_CALIBRATION_PROVIDER tidak didukung: ${provider}`)
}

function normalizeJudge(raw) {
  return {
    similarity_score: round4(clampNumber(raw.similarity_score, 0, 1, 0)),
    style_match_score: round4(clampNumber(raw.style_match_score, 0, 1, 0)),
    intent_match_score: round4(clampNumber(raw.intent_match_score, 0, 1, 0)),
    length_match_score: round4(clampNumber(raw.length_match_score, 0, 1, 0)),
    tone_match_score: round4(clampNumber(raw.tone_match_score, 0, 1, 0)),
    fidelity_score: round4(clampNumber(raw.fidelity_score, 0, 1, 0)),
    overclaim_risk: round4(clampNumber(raw.overclaim_risk, 0, 1, 0)),
    underfit_risk: round4(clampNumber(raw.underfit_risk, 0, 1, 0)),
    too_ai_score: round4(clampNumber(raw.too_ai_score, 0, 1, 0)),
    missing_elements: asArray(raw.missing_elements),
    extra_elements: asArray(raw.extra_elements),
    calibration_hints: asArray(raw.calibration_hints),
    passed: raw.passed === true,
    judge_feedback: typeof raw.judge_feedback === 'string' ? raw.judge_feedback : '',
  }
}

function mergeJudge(deterministic, judged) {
  if (!judged || judged === deterministic) return deterministic
  return {
    similarity_score: avg(deterministic.similarity_score, judged.similarity_score),
    style_match_score: avg(deterministic.style_match_score, judged.style_match_score),
    intent_match_score: avg(deterministic.intent_match_score, judged.intent_match_score),
    length_match_score: avg(deterministic.length_match_score, judged.length_match_score),
    tone_match_score: avg(deterministic.tone_match_score, judged.tone_match_score),
    fidelity_score: avg(deterministic.fidelity_score, judged.fidelity_score),
    overclaim_risk: avg(deterministic.overclaim_risk, judged.overclaim_risk),
    underfit_risk: avg(deterministic.underfit_risk, judged.underfit_risk),
    too_ai_score: avg(deterministic.too_ai_score, judged.too_ai_score),
    missing_elements: unique([...deterministic.missing_elements, ...asArray(judged.missing_elements)]),
    extra_elements: unique([...deterministic.extra_elements, ...asArray(judged.extra_elements)]),
    calibration_hints: asArray(judged.calibration_hints),
    passed: avg(deterministic.fidelity_score, judged.fidelity_score) >= Number(process.env.OWNER_CALIBRATION_MIN_PASS_SCORE ?? 0.75),
    judge_feedback: judged.judge_feedback || deterministic.judge_feedback,
  }
}

function summarizeResults(results) {
  const count = results.length || 1
  return {
    total_examples: results.length,
    average_similarity_score: avgRows(results, 'similarity_score', count),
    average_style_match_score: avgRows(results, 'style_match_score', count),
    average_intent_match_score: avgRows(results, 'intent_match_score', count),
    average_length_match_score: avgRows(results, 'length_match_score', count),
    average_tone_match_score: avgRows(results, 'tone_match_score', count),
    average_fidelity_score: avgRows(results, 'fidelity_score', count),
    overclaim_count: results.filter((result) => Number(result.overclaim_risk ?? 0) >= 0.3).length,
    underfit_count: results.filter((result) => Number(result.underfit_risk ?? 0) >= 0.35).length,
    too_ai_count: results.filter((result) => Number(result.too_ai_score ?? 0) >= 0.3).length,
  }
}

function writeCalibrationReports(latest) {
  const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
  const dir = resolve(vaultPath, '_system', 'calibration')
  mkdirSync(dir, { recursive: true })
  const markerStart = '<!-- OWNER_CALIBRATION_AUTO_START -->'
  const markerEnd = '<!-- OWNER_CALIBRATION_AUTO_END -->'
  const failed = (latest.results ?? []).filter((result) => !result.passed)
  const run = latest.run
  writeFileSync(resolve(dir, 'Owner Answer Calibration Latest.md'), [
    '# Owner Answer Calibration Latest',
    '',
    markerStart,
    `Generated: ${new Date().toISOString()}`,
    `Status: ${run?.status ?? 'none'}`,
    `Average similarity: ${run?.average_similarity_score ?? 0}`,
    `Average fidelity: ${run?.average_fidelity_score ?? 0}`,
    `Too AI count: ${run?.too_ai_count ?? 0}`,
    `Overclaim count: ${run?.overclaim_count ?? 0}`,
    `Underfit count: ${run?.underfit_count ?? 0}`,
    '',
    '## Passed Examples',
    ...(latest.results ?? []).filter((result) => result.passed).map((result) => `- ${result.intent_type}: ${result.prompt} (${result.fidelity_score})`),
    '',
    '## Failed Examples',
    ...failed.map((result) => `- ${result.intent_type}: ${result.prompt} (${result.fidelity_score})`),
    '',
    '## Recommended Fixes',
    ...recommendedFixesFromResults(latest.results ?? []).map((item) => `- ${item}`),
    markerEnd,
    '',
  ].join('\n'), 'utf8')
  writeFileSync(resolve(dir, 'Owner Answer Examples.md'), [
    '# Owner Answer Examples',
    '',
    markerStart,
    ...(latest.examples ?? []).map((example) => `- ${example.intent_type}: "${example.prompt}" -> "${example.owner_answer}"`),
    markerEnd,
    '',
  ].join('\n'), 'utf8')
  writeFileSync(resolve(dir, 'Calibration Hints.md'), [
    '# Calibration Hints',
    '',
    markerStart,
    ...(latest.hints ?? []).map((hint) => `- ${hint.status} / ${hint.intent_type} / ${hint.hint_type}: ${hint.description}`),
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

function seedRows(userId) {
  return [
    { user_id: userId, prompt: 'hi', owner_answer: 'Halo, kenapa?', intent_type: 'social_greeting', answer_style: 'short_direct', source_type: 'manual', quality_score: 0.65, metadata: { seed: true, requires_user_approval: true } },
    { user_id: userId, prompt: 'p', owner_answer: 'Iya, kenapa?', intent_type: 'social_greeting', answer_style: 'short_direct', source_type: 'manual', quality_score: 0.65, metadata: { seed: true, requires_user_approval: true } },
    { user_id: userId, prompt: 'assalamu’alaikum', owner_answer: 'Wa’alaikumussalam, ada apa?', intent_type: 'social_greeting', answer_style: 'short_direct', source_type: 'manual', quality_score: 0.65, metadata: { seed: true, requires_user_approval: true } },
    { user_id: userId, prompt: 'buatkan saya prompt untuk step berikutnya', owner_answer: 'Prompt implementasi lengkap, siap paste, step-by-step, dengan acceptance criteria dan batasan jelas.', intent_type: 'request_prompt', answer_style: 'prompt_ready', source_type: 'manual', quality_score: 0.65, metadata: { seed: true, requires_user_approval: true } },
  ]
}

function enrichExampleRow(row) {
  const lengthClass = row.length_class || classifyLength(row.owner_answer)
  const tone = row.tone || inferTone(row.owner_answer, row.intent_type)
  const formality = row.formality || inferFormality(row.owner_answer)
  return {
    ...row,
    normalized_prompt: normalizeWords(row.prompt),
    example_hash: hashExample(row.prompt, row.owner_answer),
    language: row.language || 'id',
    tone,
    formality,
    length_class: lengthClass,
    source_ref: row.source_ref ?? {},
    status: row.status || 'active',
    metadata: row.metadata ?? {},
  }
}

function hashExample(prompt, ownerAnswer) {
  return createHash('sha256').update(`${normalizeWords(prompt)}\n${String(ownerAnswer ?? '').trim()}`).digest('hex')
}

function textSimilarity(a, b) {
  const at = tokens(a)
  const bt = tokens(b)
  if (!at.length && !bt.length) return 1
  if (!at.length || !bt.length) return 0
  const setA = new Set(at)
  const setB = new Set(bt)
  const overlap = [...setA].filter((token) => setB.has(token)).length
  const jaccard = overlap / new Set([...setA, ...setB]).size
  const phrase = sharedPhraseScore(a, b)
  const lengthPenalty = Math.abs(at.length - bt.length) / Math.max(at.length, bt.length, 1)
  return clamp(jaccard * 0.65 + phrase * 0.25 + (1 - lengthPenalty) * 0.1)
}

function sharedPhraseScore(a, b) {
  const an = normalizeWords(a)
  const bn = normalizeWords(b)
  if (!an || !bn) return 0
  if (an === bn) return 1
  const phrases = [an, ...an.split(' ').map((_, index, arr) => arr.slice(index, index + 3).join(' ')).filter((item) => item.split(' ').length === 3)]
  const hits = phrases.filter((phrase) => phrase.length > 4 && bn.includes(phrase)).length
  return Math.min(1, hits / Math.max(1, phrases.length * 0.35))
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
  return distance === 0 ? 1 : distance === 1 ? 0.72 : distance === 2 ? 0.42 : 0.2
}

function inferTone(text, intent) {
  const normalized = normalizeWords(text)
  if (intent === 'technical_instruction' || /\b(command|file|script|kode|migration|step)\b/.test(normalized)) return 'technical'
  if (intent === 'strategy_question' || /\b(fokus|prioritas|harus|stop|lanjut)\b/.test(normalized)) return 'firm'
  if (/\b(menurut|rasanya|kemungkinan|refleksi)\b/.test(normalized)) return 'reflective'
  if (/\b(bro|iya|kenapa|apa|halo|pagi|malam)\b/.test(normalized)) return 'casual'
  if (/\b(jangan|langsung|harus|cukup)\b/.test(normalized)) return 'direct'
  return 'neutral'
}

function inferFormality(text) {
  const normalized = normalizeWords(text)
  if (/\b(bro|p|iya|kenapa|nggak|gak|aja)\b/.test(normalized)) return 'casual'
  if (/\b(dengan hormat|mohon|terima kasih)\b/.test(normalized)) return 'formal'
  return 'neutral'
}

function tooAiScore(text, intent) {
  const normalized = normalizeWords(text)
  const phrases = ['sebagai ai', 'berdasarkan data yang tersedia', 'memory yang tersedia', 'saya dapat membantu', 'apakah ada yang bisa saya bantu', 'berikut beberapa hal', 'semoga membantu']
  let score = phrases.reduce((sum, phrase) => sum + (normalized.includes(phrase) ? 0.22 : 0), 0)
  if (intent === 'social_greeting' && tokens(text).length > 8) score += 0.25
  if (intent === 'social_greeting' && /\banda|membantu|hari ini\b/i.test(text)) score += 0.25
  return clamp(score)
}

function overclaimRisk(example, answer) {
  if (['social_greeting', 'casual_reply'].includes(example.intent_type) && /\bdiary|identitas|memory|data|saya adalah|kamu biasanya\b/i.test(answer)) return 0.55
  const ownerTokens = new Set(tokens(example.owner_answer))
  const identityWords = tokens(answer).filter((token) => ['selalu', 'pasti', 'tidak', 'pernah', 'identitas', 'sifat', 'pola', 'tujuan'].includes(token))
  const extras = identityWords.filter((token) => !ownerTokens.has(token)).length
  return clamp(extras * 0.12)
}

function underfitRisk(example, answer, similarity, tooAi) {
  let risk = 0
  if (similarity < 0.45) risk += 0.25
  if (tooAi > 0.2) risk += 0.25
  if (example.intent_type === 'request_prompt' && !/```|acceptance|criteria|step|batasan|tugas/i.test(answer)) risk += 0.3
  if (example.intent_type === 'social_greeting' && !/^(halo|hai|iya|wa|pagi|malam)/i.test(answer.trim())) risk += 0.2
  return clamp(risk)
}

function formatMatchScore(example, answer) {
  if (example.answer_style === 'prompt_ready') return /```|acceptance|criteria|step|batasan|tugas/i.test(answer) ? 1 : 0.35
  if (example.answer_style === 'technical_step_by_step') return /\n?1\.|```|npm|file|command/i.test(answer) ? 1 : 0.45
  if (example.answer_style === 'short_direct') return tokens(answer).length <= 8 ? 1 : 0.35
  return 0.75
}

function missingElements(owner, answer, intent) {
  const missing = []
  const ownerNorm = normalizeWords(owner)
  const answerNorm = normalizeWords(answer)
  for (const phrase of keyPhrases(ownerNorm)) if (!answerNorm.includes(phrase)) missing.push(phrase)
  if (intent === 'request_prompt') {
    for (const phrase of ['step', 'acceptance criteria', 'batasan']) {
      if (ownerNorm.includes(normalizeWords(phrase)) && !answerNorm.includes(normalizeWords(phrase))) missing.push(phrase)
    }
  }
  return unique(missing).slice(0, 8)
}

function extraElements(owner, answer, intent) {
  const extra = []
  const ownerNorm = normalizeWords(owner)
  const answerNorm = normalizeWords(answer)
  for (const phrase of ['sebagai ai', 'berdasarkan data', 'memory yang tersedia', 'semoga membantu', 'ada yang bisa saya bantu']) {
    if (answerNorm.includes(phrase) && !ownerNorm.includes(phrase)) extra.push(phrase)
  }
  if (['social_greeting', 'casual_reply'].includes(intent) && tokens(answer).length > tokens(owner).length + 8) extra.push('jawaban terlalu panjang untuk prompt ringan')
  return unique(extra).slice(0, 8)
}

function keyPhrases(normalized) {
  const words = normalized.split(' ').filter((word) => word.length > 3)
  const phrases = []
  for (let i = 0; i < words.length - 1; i += 1) phrases.push(words.slice(i, i + 2).join(' '))
  return phrases.slice(0, 10)
}

function detectedAiPhrases(text) {
  const normalized = normalizeWords(text)
  return ['Sebagai AI', 'Berdasarkan data yang tersedia', 'Memory yang tersedia', 'Saya dapat membantu', 'Apakah ada yang bisa saya bantu', 'Berikut beberapa hal', 'Semoga membantu']
    .filter((phrase) => normalized.includes(normalizeWords(phrase)))
}

function validateExampleInput(input) {
  if (!input.prompt || typeof input.prompt !== 'string' || input.prompt.length > 2000) throw new Error('prompt wajib string maksimal 2000 karakter.')
  if (!input.ownerAnswer || typeof input.ownerAnswer !== 'string' || input.ownerAnswer.length > 10000) throw new Error('ownerAnswer wajib string maksimal 10000 karakter.')
  if (!INTENTS.includes(input.intentType)) throw new Error(`intentType tidak valid: ${input.intentType}`)
  if (!ANSWER_STYLES.includes(input.answerStyle)) throw new Error(`answerStyle tidak valid: ${input.answerStyle}`)
}

function ownerRecommendedFixes(warnings) {
  if (!warnings.length) return ['Tidak ada fix wajib. Tambah contoh baru secara bertahap untuk coverage intent.']
  return warnings.map((warning) => {
    if (warning.includes('examples')) return 'Jalankan npm run owner:examples -- --seed lalu edit contoh sesuai jawaban asli.'
    if (warning.includes('Social greeting')) return 'Tambahkan contoh greeting seperti hi, p, halo, dan assalamu’alaikum.'
    if (warning.includes('Request prompt')) return 'Tambahkan contoh request prompt yang mewakili format siap paste.'
    if (warning.includes('Calibration run')) return 'Jalankan npm run owner:calibrate.'
    if (warning.includes('fidelity')) return 'Review failed examples dan hints; tambahkan owner answer yang lebih representatif.'
    if (warning.includes('terlalu AI')) return 'Aktifkan hints avoid_phrase dan tambah contoh jawaban owner yang natural.'
    return 'Review audit warning dan latest calibration results.'
  })
}

function recommendedFixesFromResults(results) {
  const fixes = []
  if (results.some((result) => Number(result.too_ai_score ?? 0) >= 0.3)) fixes.push('Kurangi frasa assistant umum di Response Inference.')
  if (results.some((result) => Number(result.underfit_risk ?? 0) >= 0.35)) fixes.push('Tambah calibration hint untuk response shape dan panjang jawaban.')
  if (results.some((result) => Number(result.overclaim_risk ?? 0) >= 0.3)) fixes.push('Turunkan klaim identitas untuk prompt ringan atau tanpa evidence.')
  if (results.some((result) => result.intent_type === 'social_greeting' && !result.passed)) fixes.push('Prioritaskan greeting_reply hint untuk sapaan pendek.')
  return fixes.length ? fixes : ['Tidak ada fix wajib.']
}

function detectCommand(args) {
  if (args.has('add-example')) return 'add-example'
  if (args.has('examples') || (!args.has('calibrate') && !args.has('latest') && !args.has('hints') && !args.has('audit') && !args.has('add-example'))) return 'examples'
  if (args.has('calibrate')) return 'calibrate'
  if (args.has('latest')) return 'latest'
  if (args.has('hints')) return 'hints'
  if (args.has('audit')) return 'audit'
  return 'examples'
}

function useJudge(options) {
  if (typeof options.useJudge === 'boolean') return options.useJudge
  return readBoolEnv('OWNER_CALIBRATION_USE_LLM_JUDGE', false)
}

function resolvedProvider() {
  return (process.env.OWNER_CALIBRATION_PROVIDER || process.env.RESPONSE_INFERENCE_PROVIDER || process.env.COMMUNICATION_PROVIDER || process.env.IDENTITY_PROVIDER || process.env.BRAIN_CHAT_PROVIDER || process.env.LLM_PROVIDER || 'claude-code').toLowerCase()
}

function parseJsonOrThrow(text, label) {
  const raw = String(text ?? '').trim()
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`${label} tidak menghasilkan JSON valid.`)
    return JSON.parse(match[0])
  }
}

function runCommand(command, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timeout setelah ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${command} exited ${code}: ${output.slice(0, 1000)}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function tokens(text) {
  return normalizeWords(text).split(' ').filter((token) => token.length > 1)
}

function normalizeWords(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function unique(value) {
  return [...new Set(value.filter(Boolean))]
}

function avg(a, b) {
  return round4((Number(a ?? 0) + Number(b ?? 0)) / 2)
}

function avgRows(rows, key, count) {
  return round4(rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0) / count)
}

function clamp(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(1, num))
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

function round4(value) {
  return Number(clamp(value).toFixed(4))
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

function readOptionalArg(args, name) {
  const value = args.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readRequiredArg(args, name) {
  const value = readOptionalArg(args, name)
  if (!value) throw new Error(`Missing required argument --${name}`)
  return value
}

function readIntArg(args, name, fallback, min, max) {
  const raw = args.get(name)
  const value = raw ? Number(raw) : fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function loadEnv(path, options = {}) {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const index = trimmed.indexOf('=')
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (options.override || process.env[key] === undefined) process.env[key] = value
  }
}
