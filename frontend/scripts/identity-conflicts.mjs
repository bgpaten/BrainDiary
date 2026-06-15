import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const AUTO_START = '<!-- IDENTITY_CONFLICTS_AUTO_START -->'
const AUTO_END = '<!-- IDENTITY_CONFLICTS_AUTO_END -->'
const SYSTEM_PROMPT = `Kamu adalah Identity Conflict Resolver untuk Personal Entity OS.

Tugasmu:
- Mendeteksi konflik, kontradiksi, dan tension dalam model identitas pemilik diary.
- Jangan menganggap kontradiksi sebagai kesalahan.
- Jangan menyalahkan pemilik diary.
- Jangan membuat kesimpulan moral.
- Simpan konflik sebagai tension berbasis evidence.
- Setiap konflik harus punya dua sisi yang jelas.
- Setiap sisi harus punya evidence.
- Jika evidence kurang, beri confidence rendah atau warning.
- Jangan menyelesaikan konflik tanpa bukti resolusi.
- Jangan menghapus identity facts.
- Jangan membuat pemilik diary terlihat lebih konsisten dari data.
- Jangan membuat pemilik diary terlihat lebih buruk dari data.
- Output harus JSON valid.`

const CONFLICT_TYPES = new Set(['goal_vs_behavior','belief_vs_action','value_vs_decision','communication_mismatch','identity_tension','strategy_conflict','emotional_conflict','risk_pattern_conflict','autonomy_vs_fidelity','unknown'])
const SEVERITIES = ['low', 'medium', 'high', 'critical']
const RECURRENCES = ['one_time', 'repeated', 'recurring', 'core_tension']
const RESOLUTION_STATUSES = new Set(['open','monitoring','partially_resolved','resolved','dismissed','needs_review'])
const IMPACT_AREAS = new Set(['identity','communication','decision_making','strategy','emotion','project_execution','relationship','career','faith_or_values','unknown'])
const DECISIONS = new Set(['keep_open','mark_monitoring','mark_resolved','dismiss','merge_with_other','needs_more_data'])

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env.local'), { override: true })

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const command = detectCommand(args)
    const result = command === 'audit'
      ? await auditIdentityConflicts({ save: args.get('save') !== 'false' })
      : command === 'latest'
        ? await getLatestIdentityConflicts()
        : command === 'review'
          ? (readOptionalArg(args, 'conflict-id') || readOptionalArg(args, 'id')
            ? await reviewConflict({
              conflictId: readOptionalArg(args, 'conflict-id') || readOptionalArg(args, 'id'),
              decision: readOptionalArg(args, 'decision') || 'needs_more_data',
              ownerNote: readOptionalArg(args, 'owner-note') || readOptionalArg(args, 'note') || '',
            })
            : await getLatestIdentityConflicts())
          : await detectIdentityConflicts({
            limit: readIntArg(args, 'limit', readIntEnv('IDENTITY_CONFLICTS_MAX_IDENTITY_FACTS', 200, 1, 500), 1, 500),
            from: readOptionalArg(args, 'from'),
            to: readOptionalArg(args, 'to'),
          })
    console.log(JSON.stringify(result, null, 2))
  } catch (err) {
    console.error(`[identity-conflicts] failed ${messageOf(err)}`)
    process.exit(1)
  }
}

export async function detectIdentityConflicts(options = {}) {
  if (!readBoolEnv('IDENTITY_CONFLICTS_ENABLED', true)) throw new Error('IDENTITY_CONFLICTS_ENABLED=false.')
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk identity conflicts.')
  const period = parsePeriod(options.from, options.to)
  const context = await readConflictContext(supabase, userId, { limit: options.limit ?? readIntEnv('IDENTITY_CONFLICTS_MAX_IDENTITY_FACTS', 200, 1, 500), period })
  const detected = await buildConflicts(context)
  const minConfidence = readNumberEnv('IDENTITY_CONFLICTS_MIN_CONFIDENCE', 0.55, 0, 1)
  const minSeverity = readOptionalEnv('IDENTITY_CONFLICTS_MIN_SEVERITY') || 'low'
  const candidates = detected.conflicts
    .map((item) => normalizeConflict(item))
    .filter(Boolean)
    .filter((item) => Math.min(item.side_a_confidence, item.side_b_confidence) >= minConfidence || item.severity === 'high' || item.severity === 'critical')
    .filter((item) => severityRank(item.severity) >= severityRank(minSeverity))

  const saved = []
  const events = []
  for (const conflict of candidates) {
    const result = await upsertConflict(supabase, userId, conflict)
    saved.push(result.conflict)
    events.push(...result.events)
  }
  const latest = await getLatestIdentityConflicts({ supabase, userId })
  if (readBoolEnv('IDENTITY_CONFLICTS_OUTPUT_OBSIDIAN', true)) writeConflictReports(latest)
  return {
    ok: true,
    conflicts_detected: candidates.length,
    conflicts_saved: saved.length,
    events_created: events.length,
    warnings: detected.warnings ?? [],
    generated_by: detected.generated_by,
    conflicts: saved,
    next_commands: ['npm run conflicts:audit', 'npm run conflicts:latest'],
  }
}

export async function reviewConflict(input, options = {}) {
  const conflictId = input.conflictId
  if (!isUuid(conflictId)) throw new Error('conflictId wajib UUID. Pakai --conflict-id atau endpoint UI.')
  if (!DECISIONS.has(input.decision)) throw new Error(`decision tidak valid: ${input.decision}`)
  if (String(input.ownerNote ?? '').length > 5000) throw new Error('ownerNote maksimal 5000 karakter.')
  const supabase = options.supabase || await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk review conflict.')
  const status = statusForDecision(input.decision)
  const review = {
    user_id: userId,
    identity_conflict_id: conflictId,
    review_status: 'reviewed',
    owner_note: input.ownerNote || null,
    decision: input.decision,
    new_resolution_status: status,
    updated_chat_guidance: input.updatedChatGuidance ?? {},
    metadata: { reviewed_by: 'identity-conflicts.mjs' },
  }
  const { data, error } = await supabase.from('identity_conflict_reviews').insert(review).select('*').single()
  if (error) throw error
  const patch = { resolution_status: status, updated_at: new Date().toISOString() }
  if (input.updatedChatGuidance && Object.keys(input.updatedChatGuidance).length) patch.chat_guidance = input.updatedChatGuidance
  const update = await supabase.from('identity_conflicts').update(patch).eq('id', conflictId).eq('user_id', userId).select('*').single()
  if (update.error) throw update.error
  await insertEvent(supabase, userId, conflictId, {
    event_type: 'manual_review',
    event_summary: input.ownerNote || `Manual review: ${input.decision}`,
    evidence_refs: [],
    side_supported: 'unclear',
    confidence_score: 0.8,
    metadata: { decision: input.decision, new_resolution_status: status, review_id: data.id },
  })
  await insertEvent(supabase, userId, conflictId, {
    event_type: 'status_change',
    event_summary: `Resolution status changed to ${status}.`,
    evidence_refs: [],
    side_supported: 'neither',
    confidence_score: 0.8,
    metadata: { decision: input.decision },
  })
  const latest = await getLatestIdentityConflicts({ supabase, userId })
  if (readBoolEnv('IDENTITY_CONFLICTS_OUTPUT_OBSIDIAN', true)) writeConflictReports(latest)
  return { ok: true, review: data, conflict: update.data }
}

export async function getLatestIdentityConflicts(options = {}) {
  const supabase = options.supabase || await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk latest identity conflicts.')
  const [conflictsRes, eventsRes, reviewsRes] = await Promise.all([
    supabase.from('identity_conflicts').select('*').eq('user_id', userId).order('last_seen_at', { ascending: false }).limit(100),
    supabase.from('identity_conflict_events').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    supabase.from('identity_conflict_reviews').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
  ])
  for (const res of [conflictsRes, eventsRes, reviewsRes]) if (res.error && res.error.code !== '42P01') throw res.error
  const conflicts = conflictsRes.error?.code === '42P01' ? [] : conflictsRes.data ?? []
  const events = eventsRes.error?.code === '42P01' ? [] : eventsRes.data ?? []
  const reviews = reviewsRes.error?.code === '42P01' ? [] : reviewsRes.data ?? []
  return {
    ok: true,
    conflicts,
    events,
    reviews,
    summary: {
      total: conflicts.length,
      open: conflicts.filter((item) => ['open','monitoring','needs_review','partially_resolved'].includes(item.resolution_status)).length,
      high_severity: conflicts.filter((item) => ['high','critical'].includes(item.severity)).length,
      core_tensions: conflicts.filter((item) => item.recurrence === 'core_tension').length,
      review_needed: conflicts.filter((item) => item.resolution_status === 'needs_review').length + reviews.filter((item) => item.review_status === 'pending').length,
      resolved_or_dismissed: conflicts.filter((item) => ['resolved','dismissed'].includes(item.resolution_status)).length,
    },
  }
}

export async function auditIdentityConflicts(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk audit conflicts.')
  const latest = await getLatestIdentityConflicts({ supabase, userId })
  const conflicts = latest.conflicts
  const open = conflicts.filter((item) => ['open','monitoring','needs_review','partially_resolved'].includes(item.resolution_status))
  const high = conflicts.filter((item) => ['high','critical'].includes(item.severity))
  const core = conflicts.filter((item) => item.recurrence === 'core_tension')
  const withoutEvidence = conflicts.filter((item) => !asArray(item.side_a_evidence_refs).length || !asArray(item.side_b_evidence_refs).length)
  const withoutGuidance = open.filter((item) => !item.chat_guidance || !Object.keys(item.chat_guidance).length)
  const stale = open.filter((item) => daysSince(item.last_seen_at) > 60)
  const unresolvedContradictions = await countReflectionContradictionsWithoutConflicts(supabase, userId)
  const contradictedFacts = await countRows(supabase, 'identity_facts', userId, (q) => q.eq('status', 'contradicted'))
  const warnings = []
  if (!conflicts.length) warnings.push('Belum ada identity_conflicts. Jalankan npm run conflicts:detect.')
  if (withoutEvidence.length) warnings.push(`${withoutEvidence.length} conflicts belum punya evidence di dua sisi.`)
  if (withoutGuidance.length) warnings.push(`${withoutGuidance.length} open conflicts belum punya chat_guidance.`)
  if (stale.length) warnings.push(`${stale.length} open conflicts stale > 60 hari.`)
  if (unresolvedContradictions > 0) warnings.push(`${unresolvedContradictions} reflection contradictions mungkin belum menjadi conflicts.`)
  if (contradictedFacts > 0 && !conflicts.length) warnings.push('Ada identity_facts contradicted tetapi belum ada identity_conflicts.')
  let score = 100 - warnings.length * 12 - (high.length > 0 ? 3 : 0)
  if (!conflicts.length) score -= 20
  score = Math.max(0, Math.min(100, score))
  const result = {
    ok: true,
    status: score >= 85 ? 'healthy' : score >= 60 ? 'warning' : 'critical',
    score,
    warnings,
    recommended_fixes: warnings.map((warning) => warning.includes('detect') ? 'Jalankan npm run conflicts:detect.' : warning.includes('chat_guidance') ? 'Review conflict dan tambahkan chat guidance.' : 'Review Conflicts View dan report Obsidian.'),
    checks: {
      open_conflict_count: open.length,
      high_severity_count: high.length,
      core_tension_count: core.length,
      conflicts_without_evidence: withoutEvidence.length,
      conflicts_without_chat_guidance: withoutGuidance.length,
      stale_conflicts: stale.length,
      resolved_conflicts_with_new_evidence: latest.events.filter((event) => event.event_type === 'contradiction_signal').length,
      contradiction_suggestions_not_converted: unresolvedContradictions,
      high_drift_logs_related_to_conflicts: await countRows(supabase, 'drift_guard_logs', userId, (q) => q.gte('final_risk_score', 0.51)),
      identity_facts_marked_contradicted: contradictedFacts,
    },
  }
  if (options.save !== false && readBoolEnv('IDENTITY_CONFLICTS_OUTPUT_OBSIDIAN', true)) writeConflictReports(latest, result)
  return result
}

async function buildConflicts(context) {
  const fallback = deterministicConflicts(context)
  if (!readBoolEnv('IDENTITY_CONFLICTS_USE_LLM', true) || resolvedProvider() === 'disabled') return { ...fallback, generated_by: 'deterministic_fallback', warnings: ['IDENTITY_CONFLICTS_USE_LLM=false atau provider disabled.'] }
  try {
    const raw = await callLLM(JSON.stringify(buildConflictPack(context), null, 2))
    const parsed = parseJsonOrThrow(raw, 'Identity conflicts LLM')
    const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : []
    if (conflicts.length) return { conflicts, warnings: parsed.warnings ?? [], generated_by: 'llm' }
    return { ...fallback, warnings: ['LLM tidak menghasilkan conflict valid; memakai deterministic fallback.'], generated_by: 'deterministic_fallback' }
  } catch (err) {
    return { ...fallback, warnings: [`LLM conflict detection gagal; memakai deterministic fallback: ${messageOf(err)}`], generated_by: 'deterministic_fallback' }
  }
}

function deterministicConflicts(context) {
  const conflicts = []
  const sources = [
    ...context.identityFacts.map((item) => sourceText('identity_fact', item.id, item.label, item.statement, item.confidence_score)),
    ...context.rawEntries.map((item) => sourceText('raw_entry', item.id, item.title || item.happened_at || item.created_at, item.content, 0.62)),
    ...context.brainReports.map((item) => sourceText('brain_report', item.id, item.title, `${item.summary ?? ''}\n${JSON.stringify(item.repeated_patterns ?? [])}\n${JSON.stringify(item.risks ?? [])}`, 0.62)),
    ...context.selfReflections.flatMap((item) => asArray(item.new_contradictions).map((c, index) => sourceText('self_reflection_log', item.id, c?.label || `Contradiction ${index + 1}`, `${c?.label ?? ''} ${c?.description ?? ''}`, Number(c?.confidence_score ?? 0.6)))),
  ]
  const addIf = (type, title, summary, aNeedles, bNeedles, severity, recurrence, impactArea, guidance) => {
    const sideA = matchSources(sources, aNeedles)
    const sideB = matchSources(sources, bNeedles)
    if (!sideA.length || !sideB.length) return
    conflicts.push({
      conflict_type: type,
      title,
      summary,
      side_a_label: guidance.side_a_label,
      side_a_statement: guidance.side_a_statement,
      side_a_evidence_refs: refs(sideA),
      side_a_confidence: confidenceFrom(sideA),
      side_b_label: guidance.side_b_label,
      side_b_statement: guidance.side_b_statement,
      side_b_evidence_refs: refs(sideB),
      side_b_confidence: confidenceFrom(sideB),
      severity,
      recurrence,
      impact_area: impactArea,
      chat_guidance: guidance.chat_guidance,
      metadata: { generated_by: 'deterministic_fallback' },
    })
  }
  addIf('goal_vs_behavior', 'Fokus MVP vs ekspansi blueprint', 'Ada tension antara keinginan fokus pada MVP dan pola menambah fitur/fase baru.', ['fokus','mvp','minimal','validasi'], ['tambah fitur','fase','step','blueprint','roadmap','scope'], 'high', 'recurring', 'project_execution', {
    side_a_label: 'Fokus MVP',
    side_a_statement: 'Owner ingin fokus pada MVP, validasi, atau pemakaian harian sebelum memperluas sistem.',
    side_b_label: 'Ekspansi blueprint',
    side_b_statement: 'Owner juga sering memperluas roadmap dengan step, fase, atau fitur baru.',
    chat_guidance: { how_to_answer: 'Saat membahas tambah fitur, akui tension fokus vs ekspansi lalu sarankan validasi kecil sebelum scope baru.', avoid: ['memilih tambah fitur tanpa batas', 'menghakimi owner tidak konsisten'] },
  })
  addIf('belief_vs_action', 'Local-first vs ketergantungan API eksternal', 'Ada tension antara prinsip local-first dan penggunaan provider/API eksternal untuk kapabilitas tertentu.', ['local first','local-first','lokal','offline'], ['api','provider','openai','anthropic','claude','llm eksternal'], 'medium', 'repeated', 'strategy', {
    side_a_label: 'Local-first',
    side_a_statement: 'Owner menginginkan sistem yang lokal, privat, dan tidak bergantung penuh pada backend produksi.',
    side_b_label: 'API eksternal',
    side_b_statement: 'Owner tetap memakai provider/API eksternal untuk inference, embedding, atau judge tertentu.',
    chat_guidance: { how_to_answer: 'Jawab bahwa local-first adalah arah privasi/arsitektur, sementara API eksternal boleh dipakai sebagai opsi lokal-dev yang terkontrol.', avoid: ['mengklaim sistem sepenuhnya offline jika tidak benar'] },
  })
  addIf('communication_mismatch', 'Jawaban singkat vs prompt sangat lengkap', 'Ada tension antara preferensi respons singkat untuk prompt ringan dan kebiasaan meminta prompt implementasi lengkap.', ['singkat','pendek','to the point','jawaban pendek'], ['prompt lengkap','siap paste','acceptance criteria','detail','panjang'], 'medium', 'recurring', 'communication', {
    side_a_label: 'Singkat untuk ringan',
    side_a_statement: 'Owner ingin jawaban pendek dan natural untuk prompt ringan.',
    side_b_label: 'Lengkap untuk implementasi',
    side_b_statement: 'Owner sering meminta prompt panjang, lengkap, dan siap paste untuk pekerjaan teknis.',
    chat_guidance: { how_to_answer: 'Sesuaikan panjang dengan intent: greeting pendek, request prompt lengkap dan terstruktur.', avoid: ['jawaban panjang untuk hi', 'prompt implementasi terlalu ringkas'] },
  })
  addIf('autonomy_vs_fidelity', 'Entitas mandiri vs fidelity ketat terhadap owner', 'Owner ingin entitas personal berkembang, tetapi tetap dibatasi agar tidak lebih atau kurang dari owner.', ['entitas','berdiri sendiri','evolusi','belajar'], ['mirip owner','fidelity','tidak lebih','tidak kurang','pemilik diary asli'], 'high', 'core_tension', 'identity', {
    side_a_label: 'Entitas berkembang',
    side_a_statement: 'Owner ingin AI personal belajar dan punya proses refleksi/evolusi berbasis data.',
    side_b_label: 'Fidelity ketat',
    side_b_statement: 'Owner menegaskan agent tidak boleh mengklaim lebih atau kurang dari pemilik diary.',
    chat_guidance: { how_to_answer: 'Saat membahas autonomy, jawab bahwa entitas boleh berefleksi dan menyarankan evolusi, tetapi tetap dibatasi evidence dan fidelity.', avoid: ['mengklaim entitas sadar/bebas', 'mengabaikan batas evidence'] },
  })
  for (const reflection of context.selfReflections) {
    for (const item of asArray(reflection.new_contradictions).slice(0, 6)) {
      if (!item?.label && !item?.description) continue
      conflicts.push({
        conflict_type: 'identity_tension',
        title: String(item.label || 'Contradiction from self-reflection').slice(0, 140),
        summary: String(item.description || item.label || 'Self-reflection found a contradiction.'),
        side_a_label: 'Sisi A belum eksplisit',
        side_a_statement: String(item.description || item.label || 'Evidence menunjukkan satu sisi tension.'),
        side_a_evidence_refs: asArray(item.evidence_refs).length ? item.evidence_refs : [{ type: 'self_reflection_log', id: reflection.id, label: reflection.title }],
        side_a_confidence: Number(item.confidence_score ?? 0.55),
        side_b_label: 'Sisi B perlu review',
        side_b_statement: 'Kontradiksi ini perlu review manual untuk memisahkan sisi A dan sisi B dengan lebih jelas.',
        side_b_evidence_refs: [{ type: 'self_reflection_log', id: reflection.id, label: reflection.title }],
        side_b_confidence: 0.45,
        severity: Number(item.risk_score ?? 0) >= 0.75 ? 'high' : 'medium',
        recurrence: 'repeated',
        resolution_status: 'needs_review',
        impact_area: 'identity',
        chat_guidance: { how_to_answer: 'Akui tension ini dengan hati-hati dan jangan simpulkan satu sisi sebagai fakta final.', avoid: ['menyelesaikan kontradiksi tanpa review'] },
        metadata: { generated_by: 'deterministic_fallback', source: 'self_reflection_new_contradictions' },
      })
    }
  }
  return { conflicts: dedupeBy(conflicts, (item) => `${item.conflict_type}:${normalizeWords(item.title)}`), warnings: [] }
}

async function readConflictContext(supabase, userId, { limit, period }) {
  const rawQuery = supabase.from('raw_entries').select('id,title,content,happened_at,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(readIntEnv('IDENTITY_CONFLICTS_MAX_RAW_ENTRIES', 100, 1, 500))
  if (period.from) rawQuery.gte('created_at', period.from)
  if (period.to) rawQuery.lte('created_at', period.to)
  const [factsRes, snapshotsRes, reflectionsRes, suggestionsRes, patternsRes, inferenceRes, calibrationRes, similarityRes, driftRes, reportsRes, rawRes, existingRes] = await Promise.all([
    supabase.from('identity_facts').select('*').eq('user_id', userId).in('status', ['active','contradicted','needs_review']).order('confidence_score', { ascending: false }).limit(limit),
    supabase.from('identity_snapshots').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    supabase.from('self_reflection_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(readIntEnv('IDENTITY_CONFLICTS_MAX_REFLECTIONS', 50, 1, 200)),
    supabase.from('identity_evolution_suggestions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    supabase.from('communication_patterns').select('*').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(100),
    supabase.from('response_inference_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(80),
    supabase.from('owner_calibration_results').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(80),
    supabase.from('similarity_eval_results').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(80),
    supabase.from('drift_guard_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(80),
    supabase.from('brain_reports').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(40),
    rawQuery,
    supabase.from('identity_conflicts').select('*').eq('user_id', userId).order('last_seen_at', { ascending: false }).limit(100),
  ])
  for (const res of [factsRes, snapshotsRes, reflectionsRes, suggestionsRes, patternsRes, inferenceRes, calibrationRes, similarityRes, driftRes, reportsRes, rawRes, existingRes]) {
    if (res.error && res.error.code !== '42P01') throw res.error
  }
  return {
    userId,
    identityFacts: list(factsRes),
    identitySnapshots: list(snapshotsRes),
    selfReflections: list(reflectionsRes),
    evolutionSuggestions: list(suggestionsRes),
    communicationPatterns: list(patternsRes),
    responseInferenceLogs: list(inferenceRes),
    calibrationResults: list(calibrationRes),
    similarityResults: list(similarityRes),
    driftLogs: list(driftRes),
    brainReports: list(reportsRes),
    rawEntries: list(rawRes),
    existingConflicts: list(existingRes),
  }
}

function buildConflictPack(context) {
  return {
    task: 'Detect identity conflicts/tensions without resolving them.',
    rules: {
      contradictions_are_not_bugs: true,
      do_not_delete_or_overwrite_identity_facts: true,
      every_conflict_needs_two_sides_and_evidence: true,
      unresolved_by_default: true,
    },
    target_conflicts: ['goal_vs_behavior','belief_vs_action','value_vs_decision','communication_mismatch','identity_tension','strategy_conflict','risk_pattern_conflict','emotional_conflict','autonomy_vs_fidelity'],
    current_state: {
      identity_facts: context.identityFacts.map((item) => ({ type: 'identity_fact', id: item.id, label: item.label, fact_type: item.fact_type, statement: excerpt(item.statement, 420), confidence_score: item.confidence_score, status: item.status })),
      identity_snapshots: context.identitySnapshots.map((item) => ({ type: 'identity_snapshot', id: item.id, title: item.title, summary: excerpt(item.summary, 700), warnings: item.warnings })),
      communication_patterns: context.communicationPatterns.map((item) => ({ type: 'communication_pattern', id: item.id, label: item.label, pattern_type: item.pattern_type, description: excerpt(item.description, 360), confidence_score: item.confidence_score })),
      self_reflections: context.selfReflections.map((item) => ({ type: 'self_reflection_log', id: item.id, title: item.title, summary: excerpt(item.summary, 700), new_contradictions: item.new_contradictions, uncertainties: item.uncertainties, risk_implications: item.risk_implications })),
      evolution_suggestions: context.evolutionSuggestions.slice(0, 60),
      high_drift_logs: context.driftLogs.filter((item) => Number(item.final_risk_score ?? 0) >= 0.51).slice(0, 30).map((item) => ({ type: 'drift_guard_log', id: item.id, question: item.question, risk: item.final_risk_score, warnings: item.warnings })),
      similarity_results: context.similarityResults.slice(0, 40).map((item) => ({ type: 'similarity_eval_result', id: item.id, prompt: item.prompt, owner_answer: item.owner_answer, agent_answer: item.agent_answer, verdict: item.verdict, score: item.overall_score ?? item.fidelity_score })),
      brain_reports: context.brainReports.slice(0, 20).map((item) => ({ type: 'brain_report', id: item.id, title: item.title, summary: excerpt(item.summary, 700), repeated_patterns: item.repeated_patterns, risks: item.risks })),
      raw_entries: context.rawEntries.slice(0, 80).map((item) => ({ type: 'raw_entry', id: item.id, label: item.title || item.happened_at || item.created_at, content: excerpt(item.content, 1200) })),
      existing_conflicts: context.existingConflicts.map((item) => ({ id: item.id, title: item.title, conflict_type: item.conflict_type, resolution_status: item.resolution_status, recurrence: item.recurrence })),
    },
    output_shape: {
      conflicts: [{
        conflict_type: 'autonomy_vs_fidelity',
        title: 'Entitas mandiri vs fidelity ketat terhadap owner',
        summary: 'Owner ingin menciptakan entitas yang berdiri dengan pikiran sendiri, tetapi juga menegaskan bahwa entitas tidak boleh lebih atau kurang dari pemilik diary.',
        side_a_label: 'Entitas berdiri sendiri',
        side_a_statement: 'Owner ingin AI menjadi entitas yang berdiri dengan pikiran sendiri dan belajar dari diary.',
        side_a_evidence_refs: [{ type: 'raw_entry', id: 'uuid', label: 'Catatan tujuan Personal Entity OS' }],
        side_a_confidence: 0.88,
        side_b_label: 'Fidelity ketat',
        side_b_statement: 'Owner ingin hasil akhirnya sama persis dengan pemilik diary, tidak lebih dan tidak kurang.',
        side_b_evidence_refs: [{ type: 'raw_entry', id: 'uuid', label: 'Catatan fidelity' }],
        side_b_confidence: 0.92,
        severity: 'high',
        recurrence: 'core_tension',
        impact_area: 'identity',
        chat_guidance: { how_to_answer: 'Saat user membahas autonomy, jawab bahwa entitas boleh punya proses refleksi internal, tetapi tetap dibatasi oleh fidelity dan evidence.', avoid: ['mengklaim entitas benar-benar bebas', 'mengklaim entitas sadar', 'mengabaikan batas evidence'] },
      }],
      warnings: [],
    },
  }
}

async function upsertConflict(supabase, userId, input) {
  const normalizedTitle = normalizeWords(input.title)
  const now = new Date().toISOString()
  const existingRes = await supabase.from('identity_conflicts').select('*').eq('user_id', userId).eq('normalized_title', normalizedTitle).eq('conflict_type', input.conflict_type).eq('impact_area', input.impact_area).maybeSingle()
  if (existingRes.error && existingRes.error.code !== 'PGRST116') throw existingRes.error
  const events = []
  if (!existingRes.data) {
    const row = { user_id: userId, normalized_title: normalizedTitle, resolution_status: input.resolution_status || 'open', first_seen_at: now, last_seen_at: now, ...input }
    const { data, error } = await supabase.from('identity_conflicts').insert(row).select('*').single()
    if (error) throw error
    events.push(await insertEvent(supabase, userId, data.id, { event_type: 'new_evidence', event_summary: `Conflict detected: ${data.title}`, evidence_refs: [...asArray(data.side_a_evidence_refs), ...asArray(data.side_b_evidence_refs)], side_supported: 'both', confidence_score: Math.min(Number(data.side_a_confidence), Number(data.side_b_confidence)), metadata: { generated_by: input.metadata?.generated_by ?? 'identity-conflicts.mjs' } }))
    return { conflict: data, events }
  }
  const existing = existingRes.data
  const hadNewA = hasNewEvidence(existing.side_a_evidence_refs, input.side_a_evidence_refs)
  const hadNewB = hasNewEvidence(existing.side_b_evidence_refs, input.side_b_evidence_refs)
  const oldStatus = existing.resolution_status
  let nextStatus = oldStatus
  if (['resolved','dismissed'].includes(oldStatus) && (hadNewA || hadNewB) && Math.max(Number(input.side_a_confidence), Number(input.side_b_confidence)) >= 0.75) nextStatus = 'monitoring'
  else if (!['resolved','dismissed'].includes(oldStatus)) nextStatus = input.resolution_status || oldStatus
  const patch = {
    summary: input.summary || existing.summary,
    side_a_evidence_refs: mergeRefs(existing.side_a_evidence_refs, input.side_a_evidence_refs),
    side_a_confidence: Math.max(Number(existing.side_a_confidence ?? 0), Number(input.side_a_confidence ?? 0)),
    side_b_evidence_refs: mergeRefs(existing.side_b_evidence_refs, input.side_b_evidence_refs),
    side_b_confidence: Math.max(Number(existing.side_b_confidence ?? 0), Number(input.side_b_confidence ?? 0)),
    severity: maxEnum(existing.severity, input.severity, SEVERITIES),
    recurrence: maxEnum(existing.recurrence, input.recurrence, RECURRENCES),
    resolution_status: nextStatus,
    last_seen_at: now,
    related_identity_fact_ids: mergeValues(existing.related_identity_fact_ids, input.related_identity_fact_ids),
    related_communication_pattern_ids: mergeValues(existing.related_communication_pattern_ids, input.related_communication_pattern_ids),
    related_reflection_log_ids: mergeValues(existing.related_reflection_log_ids, input.related_reflection_log_ids),
    related_drift_log_ids: mergeValues(existing.related_drift_log_ids, input.related_drift_log_ids),
    related_similarity_result_ids: mergeValues(existing.related_similarity_result_ids, input.related_similarity_result_ids),
    chat_guidance: Object.keys(input.chat_guidance ?? {}).length ? input.chat_guidance : existing.chat_guidance,
    metadata: { ...(existing.metadata ?? {}), ...(input.metadata ?? {}), last_detected_by: 'identity-conflicts.mjs' },
  }
  const { data, error } = await supabase.from('identity_conflicts').update(patch).eq('id', existing.id).select('*').single()
  if (error) throw error
  if (hadNewA) events.push(await insertEvent(supabase, userId, existing.id, { event_type: 'strengthened_side_a', event_summary: `New evidence for side A: ${input.side_a_label}`, evidence_refs: input.side_a_evidence_refs, side_supported: 'side_a', confidence_score: input.side_a_confidence, metadata: {} }))
  if (hadNewB) events.push(await insertEvent(supabase, userId, existing.id, { event_type: 'strengthened_side_b', event_summary: `New evidence for side B: ${input.side_b_label}`, evidence_refs: input.side_b_evidence_refs, side_supported: 'side_b', confidence_score: input.side_b_confidence, metadata: {} }))
  if (nextStatus !== oldStatus) events.push(await insertEvent(supabase, userId, existing.id, { event_type: nextStatus === 'monitoring' ? 'contradiction_signal' : 'status_change', event_summary: `Status changed from ${oldStatus} to ${nextStatus}.`, evidence_refs: [...asArray(input.side_a_evidence_refs), ...asArray(input.side_b_evidence_refs)], side_supported: 'both', confidence_score: 0.75, metadata: { previous_status: oldStatus, next_status: nextStatus } }))
  return { conflict: data, events }
}

async function insertEvent(supabase, userId, conflictId, event) {
  const { data, error } = await supabase.from('identity_conflict_events').insert({ user_id: userId, identity_conflict_id: conflictId, occurred_at: new Date().toISOString(), ...event }).select('*').single()
  if (error) throw error
  return data
}

function normalizeConflict(item) {
  if (!item || !item.title || !item.summary || !item.side_a_statement || !item.side_b_statement) return null
  const conflictType = CONFLICT_TYPES.has(item.conflict_type) ? item.conflict_type : 'unknown'
  const severity = SEVERITIES.includes(item.severity) ? item.severity : 'low'
  const recurrence = RECURRENCES.includes(item.recurrence) ? item.recurrence : 'one_time'
  const impactArea = IMPACT_AREAS.has(item.impact_area) ? item.impact_area : 'unknown'
  const related = relatedIdsFromEvidence([...asArray(item.side_a_evidence_refs), ...asArray(item.side_b_evidence_refs)])
  return {
    conflict_type: conflictType,
    title: String(item.title).slice(0, 180),
    summary: String(item.summary).slice(0, 2000),
    side_a_label: String(item.side_a_label || 'Side A').slice(0, 120),
    side_a_statement: String(item.side_a_statement).slice(0, 2000),
    side_a_evidence_refs: normalizeRefs(item.side_a_evidence_refs),
    side_a_confidence: round4(item.side_a_confidence ?? 0.55),
    side_b_label: String(item.side_b_label || 'Side B').slice(0, 120),
    side_b_statement: String(item.side_b_statement).slice(0, 2000),
    side_b_evidence_refs: normalizeRefs(item.side_b_evidence_refs),
    side_b_confidence: round4(item.side_b_confidence ?? 0.55),
    severity,
    recurrence,
    resolution_status: RESOLUTION_STATUSES.has(item.resolution_status) ? item.resolution_status : 'open',
    impact_area: impactArea,
    related_identity_fact_ids: related.identity_fact,
    related_communication_pattern_ids: related.communication_pattern,
    related_reflection_log_ids: related.self_reflection_log,
    related_drift_log_ids: related.drift_guard_log,
    related_similarity_result_ids: related.similarity_eval_result,
    chat_guidance: isPlainObject(item.chat_guidance) ? item.chat_guidance : {},
    metadata: { ...(isPlainObject(item.metadata) ? item.metadata : {}), generated_by: item.metadata?.generated_by ?? 'identity-conflicts.mjs' },
  }
}

async function callLLM(contextPackJson) {
  const provider = resolvedProvider()
  const userPrompt = `${SYSTEM_PROMPT}\n\nContext pack:\n${contextPackJson}`
  if (provider === 'claude-code') {
    const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
    return await runCommand(command, [...(process.env.CLAUDE_CODE_BARE === 'false' ? [] : ['--bare']), '--no-session-persistence', '--output-format', 'text', '-p', userPrompt], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
  }
  if (provider === 'anthropic') {
    const baseUrl = requiredEnv('IDENTITY_CONFLICTS_BASE_URL', process.env.SELF_REFLECTION_BASE_URL ?? process.env.DRIFT_CONTROL_BASE_URL ?? process.env.SIMILARITY_EVAL_BASE_URL ?? process.env.OWNER_CALIBRATION_BASE_URL ?? process.env.RESPONSE_INFERENCE_BASE_URL ?? process.env.COMMUNICATION_BASE_URL ?? process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('IDENTITY_CONFLICTS_API_KEY', process.env.SELF_REFLECTION_API_KEY ?? process.env.DRIFT_CONTROL_API_KEY ?? process.env.SIMILARITY_EVAL_API_KEY ?? process.env.OWNER_CALIBRATION_API_KEY ?? process.env.RESPONSE_INFERENCE_API_KEY ?? process.env.COMMUNICATION_API_KEY ?? process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
    const model = requiredEnv('IDENTITY_CONFLICTS_MODEL', process.env.SELF_REFLECTION_MODEL ?? process.env.DRIFT_CONTROL_MODEL ?? process.env.SIMILARITY_EVAL_MODEL ?? process.env.OWNER_CALIBRATION_MODEL ?? process.env.RESPONSE_INFERENCE_MODEL ?? process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL)
    const res = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 4500, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: contextPackJson }] }) })
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    return Array.isArray(data.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
  }
  if (provider === 'openai') {
    const baseUrl = requiredEnv('IDENTITY_CONFLICTS_BASE_URL', process.env.SELF_REFLECTION_BASE_URL ?? process.env.DRIFT_CONTROL_BASE_URL ?? process.env.SIMILARITY_EVAL_BASE_URL ?? process.env.OWNER_CALIBRATION_BASE_URL ?? process.env.RESPONSE_INFERENCE_BASE_URL ?? process.env.COMMUNICATION_BASE_URL ?? process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('IDENTITY_CONFLICTS_API_KEY', process.env.SELF_REFLECTION_API_KEY ?? process.env.DRIFT_CONTROL_API_KEY ?? process.env.SIMILARITY_EVAL_API_KEY ?? process.env.OWNER_CALIBRATION_API_KEY ?? process.env.RESPONSE_INFERENCE_API_KEY ?? process.env.COMMUNICATION_API_KEY ?? process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY)
    const model = requiredEnv('IDENTITY_CONFLICTS_MODEL', process.env.SELF_REFLECTION_MODEL ?? process.env.DRIFT_CONTROL_MODEL ?? process.env.SIMILARITY_EVAL_MODEL ?? process.env.OWNER_CALIBRATION_MODEL ?? process.env.RESPONSE_INFERENCE_MODEL ?? process.env.COMMUNICATION_MODEL ?? process.env.IDENTITY_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL)
    const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: contextPackJson }] }) })
    if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    return data?.choices?.[0]?.message?.content ?? ''
  }
  throw new Error(`Unsupported IDENTITY_CONFLICTS_PROVIDER: ${provider}`)
}

function writeConflictReports(latest, audit = null) {
  const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
  const dir = resolve(vaultPath, '_system', 'conflicts')
  mkdirSync(dir, { recursive: true })
  const conflicts = latest.conflicts ?? []
  const open = conflicts.filter((item) => ['open','monitoring','needs_review','partially_resolved'].includes(item.resolution_status))
  const high = open.filter((item) => ['high','critical'].includes(item.severity))
  const core = open.filter((item) => item.recurrence === 'core_tension')
  writeFileSync(resolve(dir, 'Identity Conflicts Latest.md'), [
    '# Identity Conflicts Latest',
    '',
    AUTO_START,
    `Generated: ${new Date().toISOString()}`,
    `Open conflicts: ${open.length}`,
    `High severity: ${high.length}`,
    `Core tensions: ${core.length}`,
    `Review needed: ${latest.summary?.review_needed ?? 0}`,
    '',
    '## High Severity Conflicts',
    ...(high.length ? high.map(renderConflictLine) : ['- Tidak ada high severity open conflict.']),
    '',
    '## Core Tensions',
    ...(core.length ? core.map(renderConflictLine) : ['- Tidak ada core tension open.']),
    '',
    '## Latest Events',
    ...((latest.events ?? []).slice(0, 12).map((event) => `- ${event.event_type}: ${event.event_summary}`)),
    '',
    audit ? `## Audit\n\n\`\`\`json\n${JSON.stringify(audit, null, 2)}\n\`\`\`` : '',
    AUTO_END,
    '',
  ].join('\n'), 'utf8')
  writeFileSync(resolve(dir, 'Open Identity Conflicts.md'), [
    '# Open Identity Conflicts',
    '',
    AUTO_START,
    ...open.map((conflict) => [
      `## ${conflict.title}`,
      `- Type: ${conflict.conflict_type}`,
      `- Severity: ${conflict.severity}`,
      `- Recurrence: ${conflict.recurrence}`,
      `- Status: ${conflict.resolution_status}`,
      `- Summary: ${conflict.summary}`,
      `- Side A: ${conflict.side_a_label} — ${conflict.side_a_statement}`,
      `- Side B: ${conflict.side_b_label} — ${conflict.side_b_statement}`,
      `- Chat guidance: ${JSON.stringify(conflict.chat_guidance ?? {})}`,
      '',
    ].join('\n')),
    AUTO_END,
    '',
  ].join('\n'), 'utf8')
  writeFileSync(resolve(dir, 'Conflict Review Queue.md'), [
    '# Conflict Review Queue',
    '',
    AUTO_START,
    ...conflicts.filter((item) => item.resolution_status === 'needs_review' || ['high','critical'].includes(item.severity)).map(renderConflictLine),
    AUTO_END,
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
  for (const table of ['identity_conflicts','identity_facts','raw_entries','brain_nodes']) {
    const { data, error } = await supabase.from(table).select('user_id').limit(1).maybeSingle()
    if (!error && data?.user_id) return data.user_id
  }
  return null
}

function resolvedProvider() {
  return (process.env.IDENTITY_CONFLICTS_PROVIDER || process.env.SELF_REFLECTION_PROVIDER || process.env.DRIFT_CONTROL_PROVIDER || process.env.SIMILARITY_EVAL_PROVIDER || process.env.OWNER_CALIBRATION_PROVIDER || process.env.RESPONSE_INFERENCE_PROVIDER || process.env.COMMUNICATION_PROVIDER || process.env.IDENTITY_PROVIDER || process.env.BRAIN_CHAT_PROVIDER || process.env.LLM_PROVIDER || 'claude-code').toLowerCase()
}

function parsePeriod(from, to) {
  if (from && !isDateOnly(from)) throw new Error('--from harus YYYY-MM-DD.')
  if (to && !isDateOnly(to)) throw new Error('--to harus YYYY-MM-DD.')
  return { from: from ? `${from}T00:00:00.000Z` : null, to: to ? `${to}T23:59:59.999Z` : null }
}

function statusForDecision(decision) {
  return { keep_open: 'open', mark_monitoring: 'monitoring', mark_resolved: 'resolved', dismiss: 'dismissed', merge_with_other: 'needs_review', needs_more_data: 'needs_review' }[decision] ?? 'needs_review'
}

function sourceText(type, id, label, text, confidence) { return { type, id, label: label || type, text: String(text ?? ''), confidence: Number(confidence ?? 0.55) } }
function matchSources(sources, needles) { const patterns = needles.map(normalizeWords); return sources.filter((source) => patterns.some((needle) => normalizeWords(source.text).includes(needle))).slice(0, 8) }
function refs(sources) { return sources.map((source) => ({ type: source.type, id: source.id, label: source.label })) }
function confidenceFrom(sources) { return round4(Math.min(0.9, sources.reduce((sum, item) => sum + Number(item.confidence ?? 0.55), 0) / Math.max(1, sources.length) + Math.min(0.12, sources.length * 0.02))) }
function normalizeRefs(value) { return asArray(value).map((ref) => ({ type: String(ref?.type ?? 'unknown'), id: String(ref?.id ?? ''), label: String(ref?.label ?? ref?.type ?? 'evidence') })).filter((ref) => ref.id).slice(0, 30) }
function relatedIdsFromEvidence(refs) { const out = { identity_fact: [], communication_pattern: [], self_reflection_log: [], drift_guard_log: [], similarity_eval_result: [] }; for (const ref of refs) if (out[ref?.type]) out[ref.type].push(ref.id); return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...new Set(v.filter(Boolean))]])) }
function hasNewEvidence(oldRefs, newRefs) { const oldSet = new Set(normalizeRefs(oldRefs).map((ref) => `${ref.type}:${ref.id}`)); return normalizeRefs(newRefs).some((ref) => !oldSet.has(`${ref.type}:${ref.id}`)) }
function mergeRefs(a, b) { return normalizeRefs([...asArray(a), ...asArray(b)]).filter((ref, index, arr) => arr.findIndex((x) => x.type === ref.type && x.id === ref.id) === index).slice(0, 50) }
function mergeValues(a, b) { return [...new Set([...asArray(a), ...asArray(b)].filter(Boolean))].slice(0, 80) }
function maxEnum(a, b, order) { return order.indexOf(b) > order.indexOf(a) ? b : a }
function severityRank(value) { return Math.max(0, SEVERITIES.indexOf(value)) }
function list(res) { return res.error?.code === '42P01' ? [] : res.data ?? [] }
function renderConflictLine(conflict) { return `- ${conflict.severity}/${conflict.recurrence}/${conflict.resolution_status}: ${conflict.title}` }
function daysSince(value) { const time = new Date(value ?? 0).getTime(); return Number.isFinite(time) ? (Date.now() - time) / 86400000 : 999 }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function isDateOnly(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()) }
function isPlainObject(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function asArray(value) { return Array.isArray(value) ? value : [] }
function dedupeBy(items, keyFn) { const seen = new Set(); return items.filter((item) => { const key = keyFn(item); if (seen.has(key)) return false; seen.add(key); return true }) }
function excerpt(value, max) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length <= max ? text : `${text.slice(0, max - 1)}...` }
function normalizeWords(value) { return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() }
function round4(value) { const num = Number(value); return Number((Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0).toFixed(4)) }
function parseJsonOrThrow(text, label) { const raw = String(text ?? '').trim(); try { return JSON.parse(raw) } catch { const match = raw.match(/\{[\s\S]*\}/); if (!match) throw new Error(`${label} tidak menghasilkan JSON valid.`); return JSON.parse(match[0]) } }
async function countRows(supabase, table, userId, decorate = null) { let query = supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId); if (decorate) query = decorate(query); const { count, error } = await query; if (error?.code === '42P01') return 0; if (error) throw error; return count ?? 0 }
async function countReflectionContradictionsWithoutConflicts(supabase, userId) { const { data, error } = await supabase.from('self_reflection_logs').select('new_contradictions').eq('user_id', userId).order('created_at', { ascending: false }).limit(20); if (error?.code === '42P01') return 0; if (error) throw error; return (data ?? []).reduce((sum, row) => sum + asArray(row.new_contradictions).length, 0) }
function detectCommand(args) { if (args.has('audit')) return 'audit'; if (args.has('latest')) return 'latest'; if (args.has('review')) return 'review'; return 'detect' }
function runCommand(command, commandArgs, { timeoutMs }) { return new Promise((resolvePromise, reject) => { const child = spawn(command, commandArgs, { env: process.env, stdio: ['ignore','pipe','pipe'] }); let output = ''; const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timeout setelah ${timeoutMs}ms`)) }, timeoutMs); child.stdout.on('data', (chunk) => { output += chunk.toString() }); child.stderr.on('data', (chunk) => { output += chunk.toString() }); child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolvePromise(output); else reject(new Error(`${command} exited ${code}: ${output.slice(0, 1000)}`)) }); child.on('error', (err) => { clearTimeout(timer); reject(err) }) }) }
function readOptionalEnv(name) { return process.env[name]?.trim() || null }
function readNumberEnv(name, fallback, min, max) { const value = Number(process.env[name] ?? fallback); return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback }
function readIntEnv(name, fallback, min, max) { const value = Number(process.env[name] ?? fallback); return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback }
function readBoolEnv(name, fallback) { const value = process.env[name]; if (value === undefined || value === '') return fallback; return ['1','true','yes','on'].includes(value.toLowerCase()) }
function requiredEnv(name, fallback) { const value = process.env[name] || fallback; if (!value) throw new Error(`${name} belum diset.`); return value }
function parseArgs(argv) { const args = new Map(); for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (!arg.startsWith('--')) continue; const key = arg.slice(2); const next = argv[i + 1]; if (next && !next.startsWith('--')) { args.set(key, next); i += 1 } else args.set(key, true) } return args }
function readOptionalArg(args, name) { const value = args.get(name); return typeof value === 'string' && value.trim() ? value.trim() : null }
function readIntArg(args, name, fallback, min, max) { const raw = args.get(name); const value = raw ? Number(raw) : fallback; return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback }
function loadEnv(path, options = {}) { if (!existsSync(path)) return; const raw = readFileSync(path, 'utf8'); for (const line of raw.split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue; const index = trimmed.indexOf('='); const key = trimmed.slice(0, index).trim(); let value = trimmed.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (options.override || process.env[key] === undefined) process.env[key] = value } }
function messageOf(err) { return err instanceof Error ? err.message : String(err) }
