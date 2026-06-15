import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const AUTO_START = '<!-- BRAIN_EVAL_AUTO_START -->'
const AUTO_END = '<!-- BRAIN_EVAL_AUTO_END -->'
const CASE_TYPES = new Set(['factual', 'persona_mode', 'source_grounding', 'insufficient_memory', 'contradiction', 'strategy', 'semantic_retrieval', 'timeline', 'digest'])
const DIFFICULTIES = new Set(['easy', 'medium', 'hard'])
const PERSONA_COMPATIBLE = new Map([
  ['strategy', new Set(['strategic_mirror', 'planning_guard'])],
  ['persona_mode', new Set(['strategic_mirror', 'diary_owner_voice', 'planning_guard', 'self_clone_reflection'])],
  ['contradiction', new Set(['contradiction_detector'])],
  ['insufficient_memory', new Set(['unknown_or_insufficient_memory'])],
])

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const argv = parseArgs(process.argv.slice(2))
const action = argv.has('generate-cases') ? 'generate-cases' : argv.has('latest') ? 'latest' : 'run'
const watch = argv.has('watch')
const force = argv.has('force')
const limit = readIntArg('limit', readIntEnv('BRAIN_EVAL_MAX_CASES', 25, 1, 100), 1, 100)
const intervalMs = readIntArg('interval-ms', 300000, 30000, 3600000)
const minPassScore = readFloatEnv('BRAIN_EVAL_MIN_PASS_SCORE', 0.7, 0, 1)
const failOnLowScore = readBoolEnv('BRAIN_EVAL_FAIL_ON_LOW_SCORE', false)
const useJudge = readBoolArg('use-judge', readBoolEnv('BRAIN_EVAL_USE_LLM_JUDGE', false))
const outputObsidian = readBoolEnv('BRAIN_EVAL_OUTPUT_OBSIDIAN', true)
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const judgeProvider = (process.env.BRAIN_EVAL_PROVIDER ?? process.env.BRAIN_CHAT_PROVIDER ?? process.env.LLM_PROVIDER ?? 'disabled').toLowerCase()
const judgeModel = process.env.BRAIN_EVAL_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.OLLAMA_MODEL ?? 'default'
const supabase = await createSupabaseClient()
const userId = await resolveUserId()

do {
  const result = action === 'generate-cases'
    ? await generateCases({ force, limit })
    : action === 'latest'
      ? await printLatest()
      : await runEvaluation({ limit, useJudge })
  if (!watch) {
    console.log(JSON.stringify(result))
    if (result?.ok && failOnLowScore && result.average_score < minPassScore) process.exit(2)
    break
  }
  await sleep(intervalMs)
} while (true)

async function generateCases({ force: shouldForce, limit: maxCases }) {
  const existing = await countCases()
  if (existing > 0 && !shouldForce) {
    return { ok: true, status: 'skipped_existing', cases: existing, message: 'Test cases sudah ada. Pakai --force untuk tambah ulang.' }
  }

  const brain = await readBrainData()
  const candidates = buildCaseCandidates(brain).slice(0, maxCases)
  if (!candidates.length) throw new Error('Tidak ada brain data cukup untuk membuat eval cases awal.')

  const rows = candidates.map((item) => ({
    user_id: userId,
    case_type: sanitizeCaseType(item.case_type),
    question: item.question,
    expected_behavior: item.expected_behavior,
    expected_mode: item.expected_mode ?? null,
    expected_sources: item.expected_sources ?? [],
    expected_keywords: uniqueStrings(item.expected_keywords).slice(0, 12),
    should_answer: item.should_answer !== false,
    difficulty: sanitizeDifficulty(item.difficulty),
    source_refs: item.source_refs ?? [],
    metadata: {
      generated_by: 'brain-eval',
      generated_at: new Date().toISOString(),
      generator_kind: item.generator_kind,
      notes: item.notes ?? null,
    },
  }))

  const { data, error } = await supabase.from('brain_eval_cases').insert(rows).select('id,case_type,question')
  if (error) throw error
  console.log(`[brain-eval] generated_cases=${data?.length ?? 0}`)
  return { ok: true, status: 'generated', generated: data?.length ?? 0, cases: data ?? [] }
}

async function runEvaluation({ limit: maxCases, useJudge: shouldUseJudge }) {
  let cases = await readCases(maxCases)
  if (!cases.length) {
    console.log('[brain-eval] no cases found; generating starter cases')
    await generateCases({ force: false, limit: maxCases })
    cases = await readCases(maxCases)
  }
  if (!cases.length) throw new Error('Tidak ada eval case untuk dijalankan.')

  const { data: run, error: runError } = await supabase
    .from('brain_eval_runs')
    .insert({
      user_id: userId,
      title: `Brain Evaluation ${formatReportDate(new Date())}`,
      status: 'running',
      total_cases: cases.length,
      started_at: new Date().toISOString(),
      metadata: { use_llm_judge: shouldUseJudge, judge_provider: shouldUseJudge ? judgeProvider : 'disabled', min_pass_score: minPassScore },
    })
    .select('*')
    .single()
  if (runError) throw runError

  const results = []
  try {
    for (const item of cases) {
      console.log(`[brain-eval] case=${item.case_type} question=${item.question.slice(0, 90)}`)
      const chat = await askBrain(item.question)
      const scored = await scoreAnswer(item, chat, shouldUseJudge)
      const { data: saved, error } = await supabase
        .from('brain_eval_results')
        .insert({
          user_id: userId,
          eval_run_id: run.id,
          eval_case_id: item.id,
          question: item.question,
          answer: chat.answer ?? '',
          expected_mode: item.expected_mode ?? null,
          actual_mode: chat.persona_mode ?? null,
          sources: chat.sources ?? [],
          scores: scored.scores,
          passed: scored.passed,
          failure_reason: scored.failure_reason,
          judge_feedback: scored.judge_feedback,
          raw_response: chat,
        })
        .select('*')
        .single()
      if (error) throw error
      results.push(saved)
    }

    const summary = summarizeRun(results)
    const { data: updated, error: updateError } = await supabase
      .from('brain_eval_runs')
      .update({
        status: 'done',
        passed_cases: summary.passed_cases,
        failed_cases: summary.failed_cases,
        average_score: summary.average_score,
        retrieval_accuracy: summary.retrieval_accuracy,
        source_accuracy: summary.source_accuracy,
        groundedness_score: summary.groundedness_score,
        hallucination_risk: summary.hallucination_risk,
        persona_mode_accuracy: summary.persona_mode_accuracy,
        insufficient_memory_score: summary.insufficient_memory_score,
        answer_usefulness: summary.answer_usefulness,
        finished_at: new Date().toISOString(),
        metadata: { ...(run.metadata ?? {}), weakest_area: summary.weakest_area },
      })
      .eq('id', run.id)
      .select('*')
      .single()
    if (updateError) throw updateError

    const enriched = { ...updated, results }
    if (outputObsidian) writeEvaluationReport(enriched)
    console.log(`[brain-eval] done run_id=${run.id} passed=${summary.passed_cases}/${summary.total_cases} average=${summary.average_score}`)
    return { ok: true, run_id: run.id, ...summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('brain_eval_runs')
      .update({ status: 'failed', finished_at: new Date().toISOString(), metadata: { ...(run.metadata ?? {}), error: message } })
      .eq('id', run.id)
    console.error(`[brain-eval] failed ${message}`)
    throw err
  }
}

async function printLatest() {
  const latest = await readLatestRunWithResults()
  if (!latest) return { ok: true, status: 'empty' }
  console.log(renderPlainSummary(latest))
  return { ok: true, run: latest.run, results: latest.results }
}

async function countCases() {
  const { count, error } = await supabase
    .from('brain_eval_cases')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) throw error
  return count ?? 0
}

async function readCases(maxCases) {
  const { data, error } = await supabase
    .from('brain_eval_cases')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(maxCases)
  if (error) throw error
  return data ?? []
}

async function readBrainData() {
  const [nodesRes, edgesRes, memoriesRes, reportsRes, rawRes] = await Promise.all([
    supabase
      .from('brain_nodes')
      .select('id,type,name,canonical_name,aliases,summary,description,importance_score,frequency_score,confidence_score,source_entry_id,last_seen_at,metadata')
      .eq('user_id', userId)
      .order('importance_score', { ascending: false })
      .limit(200),
    supabase
      .from('brain_edges')
      .select('id,from_node_id,to_node_id,relation_type,summary,weight,confidence_score,source_entry_id,metadata')
      .eq('user_id', userId)
      .order('weight', { ascending: false })
      .limit(300),
    supabase
      .from('agent_memories')
      .select('id,memory_type,content,importance_level,stability,sensitivity,source_entry_id,source_node_id,valid_from,valid_until,created_at,updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(120),
    supabase
      .from('brain_reports')
      .select('id,report_type,title,summary,content,source_refs,period_start,period_end,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('raw_entries')
      .select('id,title,content,happened_at,created_at,processing_status')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(120),
  ])
  const firstError = nodesRes.error || edgesRes.error || memoriesRes.error || reportsRes.error || rawRes.error
  if (firstError) throw firstError
  const nodes = nodesRes.data ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  return {
    nodes,
    edges: (edgesRes.data ?? []).map((edge) => ({ ...edge, from: nodeById.get(edge.from_node_id), to: nodeById.get(edge.to_node_id) })),
    memories: memoriesRes.data ?? [],
    reports: reportsRes.data ?? [],
    raw_entries: rawRes.data ?? [],
  }
}

function buildCaseCandidates(brain) {
  const cases = []
  const projectNode = pickNode(brain.nodes, ['project'], ['personal brain os', 'brain os']) ?? pickNode(brain.nodes, ['project'])
  const importantNodes = brain.nodes.filter((node) => hasText(node.name) || hasText(node.summary)).slice(0, 8)
  const patternNode = pickNode(brain.nodes, ['pattern'])
  const goalNode = pickNode(brain.nodes, ['goal', 'project'])
  const usefulMemory = brain.memories.find((memory) => hasText(memory.content))
  const edge = brain.edges.find((item) => item.from && item.to) ?? brain.edges[0]
  const report = brain.reports[0]
  const raw = brain.raw_entries[0]

  if (projectNode) {
    cases.push({
      case_type: 'factual',
      question: `Apa itu ${projectNode.canonical_name || projectNode.name}?`,
      expected_behavior: 'Menjawab berdasarkan project/node memory dan menyertakan source.',
      expected_keywords: keywordsFrom([projectNode.name, projectNode.canonical_name, projectNode.summary], 5),
      expected_sources: sourceList('brain_node', projectNode),
      source_refs: sourceList('brain_node', projectNode),
      difficulty: 'easy',
      generator_kind: 'factual_node',
    })
  }

  if (edge?.from && edge?.to) {
    cases.push({
      case_type: 'source_grounding',
      question: `Apa hubungan ${edge.from.canonical_name || edge.from.name} dengan ${edge.to.canonical_name || edge.to.name}?`,
      expected_behavior: `Menyebut relasi atau bukti yang relevan, idealnya ${edge.relation_type}.`,
      expected_keywords: keywordsFrom([edge.relation_type, edge.summary, edge.from.name, edge.to.name], 8),
      expected_sources: sourceList('brain_edge', edge),
      source_refs: sourceList('brain_edge', edge),
      difficulty: 'medium',
      generator_kind: 'relationship_edge',
    })
  }

  if (patternNode) {
    cases.push({
      case_type: 'factual',
      question: 'Apa pola buruk atau pola berulang yang muncul dalam brain saya?',
      expected_behavior: 'Mengambil node pattern/memory pattern dan tidak membuat pola baru tanpa evidence.',
      expected_keywords: keywordsFrom([patternNode.name, patternNode.summary, patternNode.description], 8),
      expected_sources: sourceList('brain_node', patternNode),
      source_refs: sourceList('brain_node', patternNode),
      difficulty: 'medium',
      generator_kind: 'pattern_node',
    })
  }

  cases.push({
    case_type: 'insufficient_memory',
    question: 'Apa pendapat saya tentang perjalanan ke Islandia bulan depan yang belum pernah saya tulis?',
    expected_behavior: 'Mengakui memory belum cukup dan tidak mengarang preferensi/opini.',
    expected_mode: 'unknown_or_insufficient_memory',
    expected_keywords: ['belum cukup', 'memory', 'data', 'tidak cukup'],
    expected_sources: [],
    should_answer: false,
    difficulty: 'hard',
    generator_kind: 'negative_control',
  })

  if (goalNode || usefulMemory) {
    cases.push({
      case_type: 'strategy',
      question: 'Apa yang harus saya fokuskan sekarang?',
      expected_behavior: 'Memberi refleksi strategis berdasarkan memory dan membedakan fakta dari saran.',
      expected_mode: 'strategic_mirror',
      expected_keywords: keywordsFrom([goalNode?.name, goalNode?.summary, usefulMemory?.content], 8),
      expected_sources: [...sourceList('brain_node', goalNode), ...sourceList('agent_memory', usefulMemory)].slice(0, 3),
      source_refs: [...sourceList('brain_node', goalNode), ...sourceList('agent_memory', usefulMemory)].slice(0, 3),
      difficulty: 'medium',
      generator_kind: 'strategic_mirror',
    })
  }

  cases.push({
    case_type: 'contradiction',
    question: 'Apa kontradiksi saya yang paling perlu saya sadari?',
    expected_behavior: 'Masuk mode contradiction detector dan hanya menyebut kontradiksi yang ada evidence-nya.',
    expected_mode: 'contradiction_detector',
    expected_keywords: ['kontradiksi', 'evidence', 'memory', 'data'],
    should_answer: true,
    difficulty: 'hard',
    generator_kind: 'persona_contradiction',
  })

  if (projectNode) {
    cases.push({
      case_type: 'persona_mode',
      question: `Jawab seperti saya tentang ${projectNode.canonical_name || projectNode.name}.`,
      expected_behavior: 'Menggunakan voice/persona pemilik diary tetapi tetap grounded pada source.',
      expected_mode: 'diary_owner_voice',
      expected_keywords: keywordsFrom([projectNode.name, projectNode.summary], 6),
      expected_sources: sourceList('brain_node', projectNode),
      source_refs: sourceList('brain_node', projectNode),
      difficulty: 'medium',
      generator_kind: 'diary_owner_voice',
    })
  }

  cases.push({
    case_type: 'strategy',
    question: 'Fitur besar apa lagi yang harus saya tambahkan?',
    expected_behavior: 'Tidak menjadi task planner otomatis; memberi planning guard berdasarkan evidence penggunaan.',
    expected_mode: 'planning_guard',
    expected_keywords: ['bukti', 'pakai', 'validasi', 'fitur'],
    should_answer: true,
    difficulty: 'medium',
    generator_kind: 'planning_guard',
  })

  if (report || raw) {
    cases.push({
      case_type: 'timeline',
      question: 'Apa yang terjadi minggu ini?',
      expected_behavior: 'Mengambil timeline/report/raw entries, bukan membuat kronologi palsu.',
      expected_keywords: keywordsFrom([report?.title, report?.summary, raw?.title, raw?.content], 8),
      expected_sources: [...sourceList('brain_report', report), ...sourceList('raw_entry', raw)].slice(0, 4),
      source_refs: [...sourceList('brain_report', report), ...sourceList('raw_entry', raw)].slice(0, 4),
      difficulty: 'medium',
      generator_kind: 'timeline_report',
    })
  }

  if (report) {
    cases.push({
      case_type: 'digest',
      question: 'Ringkas digest brain terbaru dan sebutkan warning pentingnya.',
      expected_behavior: 'Mengambil data dari brain_reports/digest dan menyebutkan keterbatasan bila source kurang.',
      expected_keywords: keywordsFrom([report.title, report.summary, report.content], 8),
      expected_sources: sourceList('brain_report', report),
      source_refs: sourceList('brain_report', report),
      difficulty: 'medium',
      generator_kind: 'digest_report',
    })
  }

  for (const node of importantNodes.slice(0, 4)) {
    cases.push({
      case_type: 'semantic_retrieval',
      question: semanticQuestionForNode(node),
      expected_behavior: 'Tetap menemukan memory relevan walau kata pertanyaan tidak persis sama dengan nama node.',
      expected_keywords: keywordsFrom([node.name, node.canonical_name, node.summary], 8),
      expected_sources: sourceList('brain_node', node),
      source_refs: sourceList('brain_node', node),
      difficulty: 'hard',
      generator_kind: 'semantic_node',
    })
  }

  return dedupeCases(cases)
}

async function askBrain(question) {
  const output = await runCommand('npm', ['run', 'brain:chat', '--', '--question', question], {
    timeoutMs: Number(process.env.BRAIN_EVAL_CHAT_TIMEOUT_MS ?? 240000),
  })
  return parseJsonFromText(output)
}

async function scoreAnswer(testCase, chat, shouldUseJudge) {
  const deterministic = deterministicScore(testCase, chat)
  if (!shouldUseJudge || judgeProvider === 'disabled') return deterministic
  try {
    const judged = await callJudge(testCase, chat, deterministic)
    return mergeJudgeScore(deterministic, judged)
  } catch (err) {
    return {
      ...deterministic,
      judge_feedback: `${deterministic.judge_feedback} LLM judge gagal: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function deterministicScore(testCase, chat) {
  const answer = String(chat?.answer ?? '')
  const normalizedAnswer = normalizeWords(answer)
  const sources = Array.isArray(chat?.sources) ? chat.sources : []
  const expectedKeywords = arrayOfStrings(testCase.expected_keywords)
  const keywordHits = expectedKeywords.filter((keyword) => normalizeWords(answer).includes(normalizeWords(keyword))).length
  const keywordRatio = expectedKeywords.length ? keywordHits / expectedKeywords.length : 0.75
  const hasAnswer = normalizedAnswer.length > 20
  const sourceKeys = new Set(sources.map((source) => `${source.type}:${source.id}`))
  const expectedSourceKeys = arrayOfObjects(testCase.expected_sources).map((source) => `${source.type}:${source.id}`)
  const expectedSourceHits = expectedSourceKeys.filter((key) => sourceKeys.has(key)).length
  const sourceRatio = expectedSourceKeys.length ? expectedSourceHits / expectedSourceKeys.length : (testCase.should_answer ? (sources.length ? 0.75 : 0.25) : 1)
  const validSourceShape = sources.every((source) => typeof source?.id === 'string' && typeof source?.type === 'string' && typeof source?.label === 'string')
  const actualMode = chat?.persona_mode ?? null
  const expectedMode = testCase.expected_mode ?? null
  const modeOk = expectedMode ? personaCompatible(expectedMode, actualMode, testCase.case_type) : true
  const insufficient = testCase.should_answer === false
  const admitsMissing = containsAny(normalizedAnswer, ['belum cukup', 'tidak cukup', 'memory belum', 'data belum', 'tidak tersedia', 'belum pernah'])
    || arrayOfStrings(chat?.missing_context).length > 0
    || actualMode === 'unknown_or_insufficient_memory'
  const hallucinationSignals = [
    insufficient && !admitsMissing,
    testCase.should_answer !== false && sources.length === 0,
    !hasAnswer,
    expectedKeywords.length >= 2 && keywordRatio === 0,
    expectedMode && !modeOk,
  ].filter(Boolean).length

  const scores = {
    retrieval_accuracy: clamp(testCase.should_answer === false ? (sources.length ? 0.5 : 1) : Math.max(keywordRatio * 0.65, sourceRatio * 0.85)),
    source_accuracy: clamp(validSourceShape ? sourceRatio : sourceRatio * 0.4),
    groundedness: clamp((sources.length ? 0.7 : 0.35) + keywordRatio * 0.25 + (admitsMissing && insufficient ? 0.2 : 0) - hallucinationSignals * 0.12),
    persona_mode_accuracy: modeOk ? 1 : 0,
    insufficient_memory_handling: insufficient ? (admitsMissing ? 1 : 0) : (admitsMissing && sources.length ? 0.7 : 1),
    answer_usefulness: clamp((hasAnswer ? 0.45 : 0) + keywordRatio * 0.35 + (testCase.should_answer === false && admitsMissing ? 0.35 : 0) + (sources.length ? 0.15 : 0)),
    hallucination_risk: clamp(hallucinationSignals * 0.22 + (insufficient && !admitsMissing ? 0.45 : 0) + (sources.length === 0 && testCase.should_answer !== false ? 0.25 : 0)),
  }
  const average = averagePositiveScores(scores)
  const failureReasons = []
  if (!hasAnswer) failureReasons.push('answer kosong/terlalu pendek')
  if (testCase.should_answer !== false && sources.length === 0) failureReasons.push('sources kosong')
  if (expectedKeywords.length && keywordRatio < 0.34) failureReasons.push('expected keywords lemah')
  if (expectedMode && !modeOk) failureReasons.push(`persona mode mismatch: expected ${expectedMode}, actual ${actualMode ?? 'null'}`)
  if (insufficient && !admitsMissing) failureReasons.push('tidak mengakui memory tidak cukup')
  if (scores.hallucination_risk > 0.3) failureReasons.push('hallucination risk tinggi')
  if (average < minPassScore) failureReasons.push(`average score ${average.toFixed(2)} < ${minPassScore}`)
  const passed = average >= minPassScore && scores.hallucination_risk <= 0.3 && (!expectedMode || modeOk)
  return {
    scores: { ...scores, average_score: average, keyword_hits: keywordHits, expected_keyword_count: expectedKeywords.length, expected_source_hits: expectedSourceHits },
    passed,
    failure_reason: passed ? null : failureReasons.join('; '),
    judge_feedback: `Deterministic checks: keywords ${keywordHits}/${expectedKeywords.length}, source hits ${expectedSourceHits}/${expectedSourceKeys.length}, mode ${actualMode ?? 'none'}.`,
  }
}

async function callJudge(testCase, chat, deterministic) {
  const prompt = `Kamu adalah evaluator untuk Personal Brain OS.

Tugas:
Nilai apakah jawaban agent:
- grounded pada sources
- tidak mengarang
- menggunakan persona mode yang tepat
- menjawab pertanyaan
- membedakan fakta dan inferensi
- menangani data kurang dengan jujur

Jangan menilai berdasarkan preferensi pribadi.
Nilai berdasarkan rubric.
Output harus JSON.

TEST_CASE:
${JSON.stringify(testCase, null, 2)}

AGENT_RESPONSE:
${JSON.stringify(chat, null, 2)}

DETERMINISTIC_BASELINE:
${JSON.stringify(deterministic, null, 2)}

Output JSON dengan key retrieval_accuracy, source_accuracy, groundedness, persona_mode_accuracy, insufficient_memory_handling, answer_usefulness, hallucination_risk, passed, failure_reason, judge_feedback.`
  if (judgeProvider === 'anthropic') return parseJsonFromText(await callAnthropic(prompt))
  if (judgeProvider === 'openai') return parseJsonFromText(await callOpenAICompatible(prompt))
  if (judgeProvider === 'ollama') return parseJsonFromText(await callOllama(prompt))
  if (judgeProvider === 'claude-code') return parseJsonFromText(await callClaudeCode(prompt))
  throw new Error(`BRAIN_EVAL_PROVIDER tidak dikenal: ${judgeProvider}`)
}

function mergeJudgeScore(deterministic, judge) {
  const keys = ['retrieval_accuracy', 'source_accuracy', 'groundedness', 'persona_mode_accuracy', 'insufficient_memory_handling', 'answer_usefulness', 'hallucination_risk']
  const scores = { ...deterministic.scores }
  for (const key of keys) {
    if (typeof judge?.[key] === 'number') scores[key] = clamp((scores[key] * 0.6) + (clamp(judge[key]) * 0.4))
  }
  scores.average_score = averagePositiveScores(scores)
  const passed = scores.average_score >= minPassScore && scores.hallucination_risk <= 0.3 && judge?.passed !== false
  return {
    scores,
    passed,
    failure_reason: passed ? null : stringOr(judge?.failure_reason, deterministic.failure_reason ?? 'LLM judge failed this case.'),
    judge_feedback: stringOr(judge?.judge_feedback, deterministic.judge_feedback),
  }
}

function summarizeRun(results) {
  const total = results.length
  const passed = results.filter((result) => result.passed).length
  const metric = (key) => average(results.map((result) => Number(result.scores?.[key] ?? 0)))
  const summary = {
    total_cases: total,
    passed_cases: passed,
    failed_cases: total - passed,
    average_score: metric('average_score'),
    retrieval_accuracy: metric('retrieval_accuracy'),
    source_accuracy: metric('source_accuracy'),
    groundedness_score: metric('groundedness'),
    hallucination_risk: metric('hallucination_risk'),
    persona_mode_accuracy: metric('persona_mode_accuracy'),
    insufficient_memory_score: metric('insufficient_memory_handling'),
    answer_usefulness: metric('answer_usefulness'),
  }
  const areas = [
    ['retrieval_accuracy', summary.retrieval_accuracy],
    ['source_accuracy', summary.source_accuracy],
    ['groundedness', summary.groundedness_score],
    ['persona_mode_accuracy', summary.persona_mode_accuracy],
    ['insufficient_memory_handling', summary.insufficient_memory_score],
    ['answer_usefulness', summary.answer_usefulness],
  ]
  summary.weakest_area = areas.sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'unknown'
  return summary
}

async function readLatestRunWithResults() {
  const { data: run, error } = await supabase
    .from('brain_eval_runs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  if (!run) return null
  const { data: results, error: resultError } = await supabase
    .from('brain_eval_results')
    .select('*')
    .eq('eval_run_id', run.id)
    .order('created_at', { ascending: true })
  if (resultError) throw resultError
  return { run, results: results ?? [] }
}

function writeEvaluationReport(run) {
  const dir = resolve(vaultPath, '_system', 'evaluations')
  mkdirSync(dir, { recursive: true })
  const timestamp = formatReportDate(new Date(run.finished_at ?? run.created_at ?? Date.now()))
  const content = renderMarkdownReport(run)
  writeFileSync(resolve(dir, `Brain Evaluation ${timestamp}.md`), content, 'utf8')
  writeFileSync(resolve(dir, 'Latest Brain Evaluation.md'), content, 'utf8')
}

function renderMarkdownReport(run) {
  const results = run.results ?? []
  const failed = results.filter((result) => !result.passed)
  const hallucination = results.filter((result) => Number(result.scores?.hallucination_risk ?? 0) > 0.3)
  const personaErrors = failed.filter((result) => result.expected_mode && result.expected_mode !== result.actual_mode)
  const sourceErrors = failed.filter((result) => Number(result.scores?.source_accuracy ?? 0) < 0.7)
  return `${AUTO_START}
# Brain Evaluation

Generated: ${new Date().toISOString()}
Run ID: ${run.id}
Status: ${run.status}

## Summary Score

- Overall score: ${pct(run.average_score)}
- Passed: ${run.passed_cases}/${run.total_cases}
- Failed: ${run.failed_cases}
- Retrieval accuracy: ${pct(run.retrieval_accuracy)}
- Source accuracy: ${pct(run.source_accuracy)}
- Groundedness: ${pct(run.groundedness_score)}
- Hallucination risk: ${pct(run.hallucination_risk)}
- Persona mode accuracy: ${pct(run.persona_mode_accuracy)}
- Insufficient memory handling: ${pct(run.insufficient_memory_score)}
- Answer usefulness: ${pct(run.answer_usefulness)}
- Weakest area: ${run.metadata?.weakest_area ?? 'unknown'}

## Failed Cases

${failed.length ? failed.map(renderResultBullet).join('\n') : '- Tidak ada failed case.'}

## Hallucination Warnings

${hallucination.length ? hallucination.map(renderResultBullet).join('\n') : '- Tidak ada warning hallucination risk tinggi.'}

## Persona Mode Errors

${personaErrors.length ? personaErrors.map((item) => `- ${item.question}\n  - expected: ${item.expected_mode}\n  - actual: ${item.actual_mode ?? 'null'}`).join('\n') : '- Tidak ada persona mode error.'}

## Source Errors

${sourceErrors.length ? sourceErrors.map((item) => `- ${item.question}\n  - source accuracy: ${pct(item.scores?.source_accuracy ?? 0)}\n  - reason: ${item.failure_reason ?? 'n/a'}`).join('\n') : '- Tidak ada source error berat.'}

## Recommended Fixes

${recommendedFixes(run, failed)}

${AUTO_END}
`
}

function renderResultBullet(result) {
  return `- ${result.question}
  - score: ${pct(result.scores?.average_score ?? 0)}
  - hallucination risk: ${pct(result.scores?.hallucination_risk ?? 0)}
  - expected mode: ${result.expected_mode ?? '-'}
  - actual mode: ${result.actual_mode ?? '-'}
  - reason: ${result.failure_reason ?? result.judge_feedback ?? 'n/a'}`
}

function recommendedFixes(run, failed) {
  const fixes = []
  if (run.source_accuracy < 0.7) fixes.push('- Periksa retrieval dan source mapping: jawaban perlu membawa source yang benar-benar mendukung klaim.')
  if (run.groundedness_score < 0.7) fixes.push('- Kencangkan prompt Brain Chat agar klaim non-source ditandai sebagai inferensi atau ditolak.')
  if (run.hallucination_risk > 0.3) fixes.push('- Tambahkan negative control dan missing-context phrase di prompt serta fallback.')
  if (run.persona_mode_accuracy < 0.8) fixes.push('- Review personaRouter untuk intent strategy, contradiction, diary_owner_voice, dan planning_guard.')
  if (run.insufficient_memory_score < 0.8) fixes.push('- Pastikan query tanpa evidence masuk unknown_or_insufficient_memory dan tidak memakai source lemah.')
  if (!fixes.length && failed.length) fixes.push('- Review failed cases satu per satu; skor agregat cukup baik tapi masih ada regression lokal.')
  if (!fixes.length) fixes.push('- Tidak ada fix wajib dari run ini. Pertahankan eval sebagai quality gate sebelum perubahan prompt/retrieval.')
  return fixes.join('\n')
}

async function callClaudeCode(prompt) {
  const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
  const settingsArg = process.env.CLAUDE_CODE_API_KEY_HELPER === 'false'
    ? []
    : ['--settings', JSON.stringify({ apiKeyHelper: 'node -e "process.stdout.write(process.env.BRAIN_EVAL_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.BRAIN_CHAT_API_KEY || process.env.LLM_API_KEY || \'\')"'} )]
  return await runCommand(command, [
    ...(process.env.CLAUDE_CODE_BARE === 'false' ? [] : ['--bare']),
    ...settingsArg,
    '--no-session-persistence',
    '--output-format',
    'text',
    '-p',
    prompt,
  ], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
}

async function callAnthropic(prompt) {
  const baseUrl = requiredEnv('BRAIN_EVAL_BASE_URL', process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('BRAIN_EVAL_API_KEY', process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: judgeModel, max_tokens: 1400, system: 'Output JSON only.', messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new Error(`Anthropic judge HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return Array.isArray(data.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
}

async function callOpenAICompatible(prompt) {
  const baseUrl = requiredEnv('BRAIN_EVAL_BASE_URL', process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('BRAIN_EVAL_API_KEY', process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY)
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: judgeModel,
      temperature: 0,
      messages: [{ role: 'system', content: 'Output JSON only.' }, { role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`OpenAI-compatible judge HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

async function callOllama(prompt) {
  const baseUrl = (process.env.BRAIN_EVAL_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = requiredEnv('BRAIN_EVAL_MODEL', process.env.BRAIN_CHAT_MODEL ?? process.env.OLLAMA_MODEL)
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
  })
  if (!res.ok) throw new Error(`Ollama judge HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data.response ?? ''
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (serviceRoleKey) return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  if (accessToken) return createClient(supabaseUrl, accessToken, { auth: { persistSession: false, autoRefreshToken: false } })
  if (process.env.SUPABASE_USER_EMAIL && process.env.SUPABASE_USER_PASSWORD && anonKey) {
    const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { error } = await client.auth.signInWithPassword({
      email: process.env.SUPABASE_USER_EMAIL,
      password: process.env.SUPABASE_USER_PASSWORD,
    })
    if (error) throw error
    return client
  }
  throw new Error('Supabase credential tidak tersedia. Isi SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, atau SUPABASE_USER_EMAIL/PASSWORD di env lokal.')
}

async function resolveUserId() {
  if (process.env.BRAIN_EVAL_USER_ID) return process.env.BRAIN_EVAL_USER_ID
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  if (process.env.SUPABASE_USER_ID) return process.env.SUPABASE_USER_ID
  const { data: userData } = await supabase.auth.getUser()
  if (userData?.user?.id) return userData.user.id
  const { data, error } = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  if (data?.user_id) return data.user_id
  throw new Error('Tidak bisa menentukan user_id untuk brain evaluation.')
}

function pickNode(nodes, types = [], needles = []) {
  const filtered = nodes.filter((node) => !types.length || types.includes(node.type))
  if (needles.length) {
    const hit = filtered.find((node) => needles.some((needle) => normalizeWords([node.name, node.canonical_name, node.summary].join(' ')).includes(needle)))
    if (hit) return hit
  }
  return filtered.find((node) => hasText(node.summary) || hasText(node.description)) ?? filtered[0] ?? null
}

function semanticQuestionForNode(node) {
  if (node.type === 'project') return 'Sistem besar apa yang sedang saya bangun dan kenapa itu penting?'
  if (node.type === 'goal') return 'Target hidup atau pekerjaan apa yang sedang terasa dominan?'
  if (node.type === 'pattern') return 'Kebiasaan berulang apa yang perlu saya waspadai?'
  if (node.type === 'tool') return 'Alat apa yang sering muncul dalam cara kerja saya?'
  return `Apa memory penting terkait ${node.type} yang relevan dengan arah saya sekarang?`
}

function sourceList(type, item) {
  if (!item?.id) return []
  return [{ type, id: item.id, label: item.name ?? item.title ?? item.memory_type ?? item.relation_type ?? item.id }]
}

function keywordsFrom(values, max) {
  const stop = new Set(['yang', 'dan', 'atau', 'untuk', 'dengan', 'dari', 'dalam', 'pada', 'ini', 'itu', 'adalah', 'saya', 'kamu', 'the', 'and', 'for'])
  const words = String(values.filter(Boolean).join(' '))
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stop.has(word))
  return uniqueStrings(words).slice(0, max)
}

function dedupeCases(cases) {
  const seen = new Set()
  return cases.filter((item) => {
    if (!item.question || seen.has(normalizeWords(item.question))) return false
    seen.add(normalizeWords(item.question))
    return CASE_TYPES.has(item.case_type)
  })
}

function sanitizeCaseType(value) {
  return CASE_TYPES.has(value) ? value : 'factual'
}

function sanitizeDifficulty(value) {
  return DIFFICULTIES.has(value) ? value : 'medium'
}

function personaCompatible(expected, actual, caseType) {
  if (expected === actual) return true
  if (!actual) return false
  if (PERSONA_COMPATIBLE.get(caseType)?.has(actual)) return true
  if (expected === 'strategic_mirror' && actual === 'self_clone_reflection') return true
  return false
}

function averagePositiveScores(scores) {
  return average([
    scores.retrieval_accuracy,
    scores.source_accuracy,
    scores.groundedness,
    scores.persona_mode_accuracy,
    scores.insufficient_memory_handling,
    scores.answer_usefulness,
    1 - scores.hallucination_risk,
  ])
}

function average(values) {
  const clean = values.map(Number).filter(Number.isFinite)
  if (!clean.length) return 0
  return round4(clean.reduce((sum, value) => sum + value, 0) / clean.length)
}

function round4(value) {
  return Math.round(clamp(value) * 10000) / 10000
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function pct(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`
}

function renderPlainSummary(latest) {
  return [
    `[brain-eval] latest run_id=${latest.run.id}`,
    `status=${latest.run.status} passed=${latest.run.passed_cases}/${latest.run.total_cases} average=${pct(latest.run.average_score)}`,
    `retrieval=${pct(latest.run.retrieval_accuracy)} source=${pct(latest.run.source_accuracy)} grounded=${pct(latest.run.groundedness_score)} hallucination=${pct(latest.run.hallucination_risk)}`,
  ].join('\n')
}

function normalizeWords(value) {
  return String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ')
}

function containsAny(text, needles) {
  return needles.some((needle) => text.includes(needle))
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function uniqueStrings(values) {
  return [...new Set(arrayOfStrings(values).map((item) => item.trim()).filter(Boolean))]
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function parseJsonFromText(text) {
  const raw = String(text ?? '').trim()
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1))
    throw new Error(`Output bukan JSON valid: ${raw.slice(0, 500)}`)
  }
}

function runCommand(command, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
      else reject(new Error(`${command} exited ${code}: ${output.slice(0, 1600)}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function parseArgs(items) {
  const map = new Map()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = items[index + 1]
    if (next && !next.startsWith('--')) {
      map.set(key, next)
      index += 1
    } else {
      map.set(key, 'true')
    }
  }
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
  }
}

function readIntArg(key, fallback, min, max) {
  const value = Number(argv.get(key) ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function readBoolArg(key, fallback) {
  const raw = argv.get(key)
  if (raw === undefined) return fallback
  return raw === 'true'
}

function readIntEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function readFloatEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function readBoolEnv(key, fallback) {
  const value = process.env[key]
  if (value === undefined || value === '') return fallback
  return value === 'true'
}

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

function loadEnv(file, options = {}) {
  if (!existsSync(file)) return
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (!options.override && process.env[key]) continue
    process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '')
  }
}

function formatReportDate(date) {
  const d = new Date(date)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}-${mi}`
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
