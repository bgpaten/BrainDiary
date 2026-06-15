import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const AUTO_START = '<!-- BRAIN_ROUTINE_AUTO_START -->'
const AUTO_END = '<!-- BRAIN_ROUTINE_AUTO_END -->'
const ROUTINE_TYPES = new Set(['daily', 'manual', 'health_check'])
// Profile presets: hanya mengatur baseline default tiap step (bukan command bebas).
// daily = ringan; three-day = medium (calibration/similarity/conflict/drift); weekly = berat.
const PROFILE_PRESETS = {
  daily: {
    attachments: true, sync: true, entityAudit: true,
    eval: true, similarity: true, driftAudit: true, reflection: true,
    chatImport: false, conflicts: false, calibration: false,
    memoryConsolidation: false, memorySnapshot: false,
    selfCloneEval: false, releaseAudit: false, releaseCheck: false,
  },
  'three-day': {
    attachments: true, sync: true, entityAudit: true,
    eval: false, similarity: true, driftAudit: true, reflection: true,
    chatImport: false, conflicts: true, calibration: true,
    memoryConsolidation: false, memorySnapshot: false,
    selfCloneEval: false, releaseAudit: false, releaseCheck: false,
  },
  weekly: {
    attachments: true, sync: true, entityAudit: true,
    eval: false, similarity: true, driftAudit: true, reflection: false,
    chatImport: true, conflicts: true, calibration: true,
    memoryConsolidation: true, memorySnapshot: true,
    selfCloneEval: true, releaseAudit: true, releaseCheck: true,
  },
}
const PROFILE_TYPES = new Set(Object.keys(PROFILE_PRESETS))
const STATUSES = new Set(['pending', 'running', 'done', 'partial', 'failed'])
const HEALTH_STATUSES = new Set(['healthy', 'warning', 'critical'])
const MAIN_TABLES = [
  'raw_entries',
  'brain_nodes',
  'brain_edges',
  'agent_memories',
  'brain_reports',
  'brain_eval_runs',
  'brain_routine_runs',
  'brain_health_checks',
]

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const argv = parseArgs(process.argv.slice(2))
const action = argv.has('health') ? 'health' : 'routine'
const watch = argv.has('watch')
const dryRun = argv.has('dry-run')
const healthSave = readBoolArg('save', true)
const intervalMs = readIntArg('interval-ms', readIntEnv('BRAIN_ROUTINE_WATCH_INTERVAL_MS', 21600000, 300000, 86400000), 300000, 86400000)
const limit = readIntArg('limit', readIntEnv('BRAIN_ROUTINE_DEFAULT_LIMIT', 5, 1, 50), 1, 50)
const routineType = sanitizeRoutineType(argv.get('type') ?? 'daily')
// Profile presets pemakaian: daily (ringan), three-day (medium), weekly (berat).
// Profile hanya mengubah baseline default tiap step; env var & flag --skip-* tetap menang.
const profile = sanitizeProfile(argv.get('profile'))
const profileDefaults = PROFILE_PRESETS[profile]
const includeEval = !argv.has('skip-eval') && readBoolEnv('BRAIN_ROUTINE_RUN_EVAL', profileDefaults.eval)
const includeAttachments = !argv.has('skip-attachments') && readBoolEnv('BRAIN_ROUTINE_RUN_ATTACHMENTS', profileDefaults.attachments)
const includeSync = !argv.has('skip-sync') && readBoolEnv('BRAIN_ROUTINE_RUN_SYNC', profileDefaults.sync)
const includeChatImport = !argv.has('skip-chat-import') && readBoolEnv('BRAIN_ROUTINE_RUN_CHAT_IMPORT', profileDefaults.chatImport)
const includeConflicts = !argv.has('skip-conflicts') && readBoolEnv('BRAIN_ROUTINE_RUN_CONFLICTS', profileDefaults.conflicts)
const includeSelfCloneEval = !argv.has('skip-self-clone-eval') && readBoolEnv('BRAIN_ROUTINE_RUN_SELF_CLONE_EVAL', profileDefaults.selfCloneEval)
const includeEntityAudit = !argv.has('skip-entity-audit') && readBoolEnv('BRAIN_ROUTINE_RUN_ENTITY_AUDIT', profileDefaults.entityAudit)
const includeMemoryConsolidation = !argv.has('skip-memory-consolidation') && readBoolEnv('BRAIN_ROUTINE_RUN_MEMORY_CONSOLIDATION', profileDefaults.memoryConsolidation)
const includeReleaseAudit = !argv.has('skip-release-audit') && readBoolEnv('BRAIN_ROUTINE_RUN_RELEASE_AUDIT', profileDefaults.releaseAudit)
const includeSimilarity = !argv.has('skip-similarity') && readBoolEnv('BRAIN_ROUTINE_RUN_SIMILARITY', profileDefaults.similarity)
const includeDriftAudit = !argv.has('skip-drift-audit') && readBoolEnv('BRAIN_ROUTINE_RUN_DRIFT_AUDIT', profileDefaults.driftAudit)
const includeReflection = !argv.has('skip-reflection') && readBoolEnv('BRAIN_ROUTINE_RUN_REFLECTION', profileDefaults.reflection)
const includeCalibration = !argv.has('skip-calibration') && readBoolEnv('BRAIN_ROUTINE_RUN_CALIBRATION', profileDefaults.calibration)
const includeReleaseCheck = !argv.has('skip-release-check') && readBoolEnv('BRAIN_ROUTINE_RUN_RELEASE_CHECK', profileDefaults.releaseCheck)
const includeMemorySnapshot = !argv.has('skip-memory-snapshot') && readBoolEnv('BRAIN_ROUTINE_RUN_MEMORY_SNAPSHOT', profileDefaults.memorySnapshot)
const includeGoogleHistory = argv.has('include-google-history') || readBoolEnv('BRAIN_ROUTINE_INCLUDE_GOOGLE_HISTORY', false)
const outputObsidian = readBoolEnv('BRAIN_ROUTINE_OUTPUT_OBSIDIAN', true)
const evalMinScore = readFloatEnv('BRAIN_ROUTINE_EVAL_MIN_SCORE', 0.7, 0, 1)
const maxHallucinationRisk = readFloatEnv('BRAIN_ROUTINE_MAX_HALLUCINATION_RISK', 0.3, 0, 1)
const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''

do {
  const result = action === 'health'
    ? await runHealthCheck({ save: healthSave && !dryRun })
    : await runRoutine()
  console.log(JSON.stringify(result))
  if (!watch) break
  console.log(`[brain-routine] watch sleeping ${Math.round(intervalMs / 60000)}m`)
  await sleep(intervalMs)
} while (true)

async function runRoutine() {
  const startedAt = new Date()
  const steps = buildSteps()
  if (dryRun) {
    const summary = `Daily Brain Routine dry-run: ${steps.filter((step) => step.status !== 'skipped').length} step akan dijalankan.`
    return {
      ok: true,
      status: 'dry_run',
      dry_run: true,
      summary,
      steps,
      warnings: ['Dry-run tidak menjalankan command, tidak menulis Supabase, dan tidak menulis Obsidian.'],
    }
  }

  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const beforeMetrics = await collectMetrics(supabase, userId)
  let runRow = await insertRoutineRun(supabase, {
    user_id: userId,
    routine_type: routineType,
    status: 'running',
    started_at: startedAt.toISOString(),
    steps,
    metrics: { before: beforeMetrics },
    warnings: [],
    errors: [],
    metadata: {
      limit,
      include_eval: includeEval,
      include_attachments: includeAttachments,
      include_sync: includeSync,
      include_similarity: includeSimilarity,
      include_drift_audit: includeDriftAudit,
      include_reflection: includeReflection,
      include_entity_audit: includeEntityAudit,
      include_memory_consolidation: includeMemoryConsolidation,
      include_release_audit: includeReleaseAudit,
      eval_min_score: evalMinScore,
      max_hallucination_risk: maxHallucinationRisk,
    },
  })

  const warnings = []
  const errors = []
  for (const step of steps) {
    if (step.status === 'skipped') continue
    await runStep(step)
    if (step.status === 'failed') errors.push(`${step.label}: ${step.error}`)
    const patchMetrics = runRow ? { before: beforeMetrics, latest: collectStepMetrics(steps) } : {}
    if (runRow) {
      runRow = await updateRoutineRun(supabase, runRow.id, {
        steps,
        metrics: patchMetrics,
        warnings,
        errors,
      }) ?? runRow
    }
  }

  const afterMetrics = await collectMetrics(supabase, userId)
  const metrics = {
    before: beforeMetrics,
    after: afterMetrics,
    delta: metricDelta(beforeMetrics, afterMetrics),
    commands: collectStepMetrics(steps),
  }
  addMetricWarnings(metrics, warnings)
  applyEvalGate(afterMetrics.latest_eval, warnings)

  const failedSteps = steps.filter((step) => step.status === 'failed')
  const status = failedSteps.length || warnings.length ? 'partial' : 'done'
  const finishedAt = new Date()
  const summary = renderSummary(status, steps, warnings, errors, metrics)
  const finalPatch = {
    status: sanitizeStatus(status),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    summary,
    steps,
    metrics,
    warnings,
    errors,
    metadata: {
      ...(runRow?.metadata ?? {}),
      recommended_fixes: recommendedFixes(status, warnings, errors, metrics),
      next_manual_checks: nextManualChecks(warnings, errors, metrics),
    },
  }
  if (runRow) runRow = await updateRoutineRun(supabase, runRow.id, finalPatch) ?? runRow
  const output = { ok: status !== 'failed', run_id: runRow?.id ?? null, ...finalPatch }
  if (outputObsidian) writeRoutineOutputs(output)
  return output
}

function buildSteps() {
  return [
    step('obsidian_import', 'Import Obsidian Diary', ['run', 'obsidian:import', '--', '--limit', String(limit)]),
    includeAttachments
      ? step('attachment_import', 'Import Attachments', ['run', 'attachments:import', '--', '--limit', String(limit)])
      : skippedStep('attachment_import', 'Import Attachments', 'skip-attachments'),
    includeGoogleHistory
      ? step('google_history_process', 'Process Pending Google History', ['run', 'brain:process:pending-google'])
      : skippedStep('google_history_process', 'Process Pending Google History', 'skip-google-history'),
    step('brain_worker', 'Process Pending/Failed Raw Entries', ['run', 'brain:worker', '--', '--limit', String(limit)]),
    step('semantic_reindex', 'Reindex Semantic Memory', ['run', 'brain:index', '--', '--limit', String(Math.max(limit, 25))]),
    step('persona_refresh', 'Refresh Persona Profile', ['run', 'brain:persona']),
    step('identity_build', 'Build Identity Fidelity Model', ['run', 'identity:build', '--', '--limit', '100']),
    includeChatImport
      ? step('chat_sample_import', 'Import Chat Samples', ['run', 'chats:import', '--', '--limit', String(limit)])
      : skippedStep('chat_sample_import', 'Import Chat Samples', 'skip-chat-import'),
    includeCalibration
      ? step('owner_calibration', 'Run Owner Calibration', ['run', 'owner:calibrate'])
      : skippedStep('owner_calibration', 'Run Owner Calibration', 'skip-calibration'),
    includeConflicts
      ? step('identity_conflicts', 'Detect Identity Conflicts', ['run', 'conflicts:detect', '--', '--limit', '100'])
      : skippedStep('identity_conflicts', 'Detect Identity Conflicts', 'skip-conflicts'),
    step('communication_build', 'Build Communication Style Model', ['run', 'communication:build', '--', '--limit', '100']),
    includeSync
      ? step('obsidian_sync', 'Sync Knowledge Back to Obsidian', ['run', 'obsidian:sync', '--', '--limit', '100'])
      : skippedStep('obsidian_sync', 'Sync Knowledge Back to Obsidian', 'skip-sync'),
    step('daily_digest', 'Generate Daily Digest', ['run', 'brain:digest:today']),
    includeEval
      ? step('brain_eval', 'Run Lightweight Brain Evaluation', ['run', 'brain:eval', '--', '--limit', String(limit), '--use-judge', 'false'])
      : skippedStep('brain_eval', 'Run Lightweight Brain Evaluation', 'skip-eval'),
    includeSimilarity
      ? step('similarity_eval', 'Run Similarity Evaluation Loop', ['run', 'similarity:run', '--', '--limit', '25', '--run-type', 'daily'])
      : skippedStep('similarity_eval', 'Run Similarity Evaluation Loop', 'skip-similarity'),
    includeSelfCloneEval
      ? step('self_clone_eval', 'Run Final Self-Clone Evaluation', ['run', 'clone:run', '--', '--suite', 'daily'])
      : skippedStep('self_clone_eval', 'Run Final Self-Clone Evaluation', 'skip-self-clone-eval'),
    includeDriftAudit
      ? step('drift_audit', 'Run Drift Guard Audit', ['run', 'drift:audit'])
      : skippedStep('drift_audit', 'Run Drift Guard Audit', 'skip-drift-audit'),
    includeReflection
      ? step('self_reflection', 'Run Self-Reflection Memory Evolution', ['run', 'reflection:daily'])
      : skippedStep('self_reflection', 'Run Self-Reflection Memory Evolution', 'skip-reflection'),
    includeMemoryConsolidation
      ? step('memory_consolidation', 'Run Long-Term Memory Consolidation', ['run', 'memory:consolidate', '--', '--run-type', routineType === 'daily' ? 'daily' : 'weekly', '--snapshot', 'true'])
      : skippedStep('memory_consolidation', 'Run Long-Term Memory Consolidation', 'skip-memory-consolidation'),
    includeMemorySnapshot
      ? step('memory_snapshot', 'Capture Long-Term Memory Snapshot', ['run', 'memory:snapshot'])
      : skippedStep('memory_snapshot', 'Capture Long-Term Memory Snapshot', 'skip-memory-snapshot'),
    includeEntityAudit
      ? step('entity_runtime_audit', 'Audit Safe Entity Runtime', ['run', 'entity:audit'])
      : skippedStep('entity_runtime_audit', 'Audit Safe Entity Runtime', 'skip-entity-audit'),
    includeReleaseAudit
      ? step('final_release_audit', 'Audit Final Release Readiness', ['run', 'release:audit'])
      : skippedStep('final_release_audit', 'Audit Final Release Readiness', 'skip-release-audit'),
    includeReleaseCheck
      ? step('final_release_check', 'Run Final Release Check', ['run', 'release:check'])
      : skippedStep('final_release_check', 'Run Final Release Check', 'skip-release-check'),
    step('routine_summary', 'Produce Daily Routine Summary', null),
  ]
}

function step(name, label, commandArgs) {
  return { name, label, status: 'pending', started_at: null, finished_at: null, duration_ms: null, stdout_excerpt: '', error: null, command_args: commandArgs }
}

function skippedStep(name, label, reason) {
  return { name, label, status: 'skipped', started_at: null, finished_at: null, duration_ms: null, stdout_excerpt: `Skipped by --${reason}.`, error: null }
}

async function runStep(item) {
  item.started_at = new Date().toISOString()
  item.status = 'running'
  if (!item.command_args) {
    item.status = 'done'
    item.finished_at = new Date().toISOString()
    item.duration_ms = Date.parse(item.finished_at) - Date.parse(item.started_at)
    item.stdout_excerpt = 'Summary compiled from routine step results.'
    return item
  }
  const started = Date.now()
  console.log(`[brain-routine] step=${item.name} start`)
  const result = await runCommand('npm', item.command_args, {
    timeoutMs: Number(process.env.BRAIN_ROUTINE_STEP_TIMEOUT_MS ?? 600000),
  })
  item.finished_at = new Date().toISOString()
  item.duration_ms = Date.now() - started
  item.stdout_excerpt = excerpt(result.output)
  item.status = result.code === 0 ? 'done' : 'failed'
  item.error = result.code === 0 ? null : excerpt(result.output, 1200)
  console.log(`[brain-routine] step=${item.name} status=${item.status} duration_ms=${item.duration_ms}`)
  return item
}

async function runHealthCheck({ save }) {
  const checks = []
  const warnings = []
  const errors = []
  const recommended_fixes = []
  let supabase = null
  let userId = null

  addCheck(checks, 'supabase_env', Boolean(supabaseUrl && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ACCESS_TOKEN || process.env.VITE_SUPABASE_ANON_KEY)), 'Env Supabase tersedia.')
  if (!supabaseUrl) errors.push('SUPABASE_URL atau VITE_SUPABASE_URL belum tersedia.')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) warnings.push('SUPABASE_SERVICE_ROLE_KEY tidak tersedia; script akan bergantung pada credential alternatif/RLS.')

  const vaultOk = existsSync(vaultPath)
  addCheck(checks, 'obsidian_vault_path', vaultOk, `Obsidian vault path: ${vaultPath}`)
  if (!vaultOk) errors.push(`Obsidian vault path tidak ditemukan: ${vaultPath}`)
  const diaryDir = resolve(vaultPath, process.env.OBSIDIAN_DIARY_DIR ?? '00_Diary')
  const attachmentDir = resolve(vaultPath, process.env.ATTACHMENT_IMPORT_DIR ?? '80_Attachments')
  const diaryOk = existsSync(diaryDir)
  const attachmentOk = existsSync(attachmentDir)
  addCheck(checks, 'diary_folder', diaryOk, `Diary folder: ${diaryDir}`)
  addCheck(checks, 'attachments_folder', attachmentOk, `Attachments folder: ${attachmentDir}`)
  if (!diaryOk) warnings.push('Folder Diary tidak ditemukan di vault.')
  if (!attachmentOk) warnings.push('Folder Attachments tidak ditemukan di vault.')

  const frontendSecretKeys = Object.keys(process.env).filter((key) => key.startsWith('VITE_') && /SERVICE_ROLE|API_KEY|SECRET/i.test(key) && process.env[key])
  const frontendSecretOk = frontendSecretKeys.length === 0
  addCheck(checks, 'frontend_env_no_service_role', frontendSecretOk, 'Frontend env tidak membawa service role/API key sensitif.')
  if (!frontendSecretOk) errors.push(`Frontend env mengandung secret-like key: ${frontendSecretKeys.join(', ')}`)

  const embeddingProvider = process.env.EMBEDDING_PROVIDER ?? 'disabled'
  addCheck(checks, 'embedding_provider', Boolean(embeddingProvider), `Embedding provider: ${embeddingProvider}`)
  if (embeddingProvider === 'disabled') warnings.push('Embedding provider disabled; semantic retrieval berjalan terbatas/explicit.')

  const chatProvider = process.env.BRAIN_CHAT_PROVIDER ?? process.env.LLM_PROVIDER ?? process.env.ANTHROPIC_PROVIDER ?? 'disabled'
  const chatConfigured = chatProvider !== 'disabled' || Boolean(process.env.BRAIN_CHAT_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY)
  addCheck(checks, 'brain_chat_config', chatConfigured, `Brain Chat provider: ${chatProvider}`)
  if (!chatConfigured) warnings.push('Brain Chat config belum jelas atau provider disabled.')

  try {
    supabase = await createSupabaseClient()
    userId = await resolveUserId(supabase)
    addCheck(checks, 'supabase_access', true, 'Supabase bisa diakses.')
    addCheck(checks, 'resolved_user_id', true, `user_id: ${userId}`)
  } catch (err) {
    addCheck(checks, 'supabase_access', false, errorMessage(err))
    errors.push(`Supabase tidak bisa diakses: ${errorMessage(err)}`)
  }

  let metrics = {}
  if (supabase && userId) {
    for (const table of MAIN_TABLES) {
      const { error } = await supabase.from(table).select('id', { count: 'exact', head: true }).limit(1)
      addCheck(checks, `table_${table}`, !error, error ? `${table}: ${error.message}` : `${table}: tersedia`)
      if (error) errors.push(`Table ${table} tidak tersedia atau tidak bisa dibaca: ${error.message}`)
    }
    metrics = await collectMetrics(supabase, userId)
    addHealthMetricWarnings(metrics, warnings)
  }

  if (errors.length) recommended_fixes.push('Perbaiki error critical sebelum menjalankan routine penuh.')
  if (warnings.some((item) => item.includes('low confidence'))) recommended_fixes.push('Buka Review View dan periksa node/edge low confidence.')
  if (warnings.some((item) => item.includes('failed raw'))) recommended_fixes.push('Buka Review View dan retry failed raw entries.')
  if (warnings.some((item) => item.includes('Evaluation'))) recommended_fixes.push('Buka Evaluation View dan cek failed cases sebelum mempercayai jawaban Brain Chat.')
  if (!recommended_fixes.length) recommended_fixes.push('Tidak ada fix wajib. Jalankan routine harian secara manual saat diperlukan.')

  const score = healthScore(checks, warnings, errors)
  const status = errors.length ? 'critical' : warnings.length ? 'warning' : 'healthy'
  const result = {
    ok: status !== 'critical',
    status: sanitizeHealthStatus(status),
    score,
    checks,
    metrics,
    warnings,
    errors,
    recommended_fixes,
    created_at: new Date().toISOString(),
  }

  if (save && supabase && userId) {
    const { error: healthInsertError } = await supabase.from('brain_health_checks').insert({
      user_id: userId,
      status: result.status,
      score: result.score,
      checks: result.checks,
      warnings: result.warnings,
      errors: result.errors,
    })
    if (healthInsertError) result.warnings.push(`brain_health_checks belum bisa ditulis: ${healthInsertError.message}`)
    const { error: routineInsertError } = await supabase.from('brain_routine_runs').insert({
      user_id: userId,
      routine_type: 'health_check',
      status: result.status === 'critical' ? 'failed' : result.status === 'warning' ? 'partial' : 'done',
      started_at: result.created_at,
      finished_at: result.created_at,
      duration_ms: 0,
      summary: `Brain health check ${result.status} (${result.score}/100).`,
      steps: result.checks,
      metrics: result.metrics,
      warnings: result.warnings,
      errors: result.errors,
      metadata: { recommended_fixes: result.recommended_fixes },
    })
    if (routineInsertError) result.warnings.push(`brain_routine_runs belum bisa ditulis: ${routineInsertError.message}`)
  }
  return result
}

async function collectMetrics(supabase, userId) {
  const [
    pendingRaw,
    failedRaw,
    nodes,
    edges,
    lowNodes,
    lowEdges,
    reports,
    latestEval,
  ] = await Promise.all([
    countRows(supabase, 'raw_entries', userId, (query) => query.eq('processing_status', 'pending')),
    countRows(supabase, 'raw_entries', userId, (query) => query.eq('processing_status', 'failed')),
    countRows(supabase, 'brain_nodes', userId),
    countRows(supabase, 'brain_edges', userId),
    countRows(supabase, 'brain_nodes', userId, (query) => query.lt('confidence_score', 0.7)),
    countRows(supabase, 'brain_edges', userId, (query) => query.lt('confidence_score', 0.7)),
    countRows(supabase, 'brain_reports', userId, (query) => query.eq('report_type', 'daily')),
    readLatestEval(supabase, userId),
  ])
  const duplicateCandidateCount = await estimateDuplicateCandidates(supabase, userId)
  return {
    raw_entries_pending: pendingRaw,
    raw_entries_failed: failedRaw,
    node_count: nodes,
    edge_count: edges,
    low_confidence_node_count: lowNodes,
    low_confidence_edge_count: lowEdges,
    duplicate_candidate_count: duplicateCandidateCount,
    daily_report_count: reports,
    latest_eval: latestEval,
  }
}

async function countRows(supabase, table, userId, apply = (query) => query) {
  const query = apply(supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId))
  const { count, error } = await query
  if (error) return null
  return count ?? 0
}

async function readLatestEval(supabase, userId) {
  const { data, error } = await supabase
    .from('brain_eval_runs')
    .select('id,status,average_score,hallucination_risk,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error && error.code !== 'PGRST116') return null
  return data ?? null
}

async function estimateDuplicateCandidates(supabase, userId) {
  const { data, error } = await supabase
    .from('brain_nodes')
    .select('id,type,name,canonical_name,aliases,metadata')
    .eq('user_id', userId)
    .limit(500)
  if (error || !data) return null
  let count = 0
  for (let i = 0; i < data.length; i += 1) {
    for (let j = i + 1; j < data.length; j += 1) {
      const a = data[i]
      const b = data[j]
      if (a.type !== b.type) continue
      if (normalizeName(a.name || a.canonical_name) && normalizeName(a.name || a.canonical_name) === normalizeName(b.name || b.canonical_name)) count += 1
    }
  }
  return count
}

function collectStepMetrics(steps) {
  const byName = Object.fromEntries(steps.map((item) => [item.name, {
    status: item.status,
    duration_ms: item.duration_ms,
    processed_count: parseProcessedCount(item.stdout_excerpt),
    file_count: parseFileCount(item.stdout_excerpt),
  }]))
  return {
    indexer_processed_count: byName.semantic_reindex?.processed_count ?? null,
    obsidian_sync_file_count: byName.obsidian_sync?.file_count ?? null,
    persona_profile_updated: byName.persona_refresh?.status === 'done',
    reports_generated: byName.daily_digest?.status === 'done' ? 1 : 0,
    steps: byName,
  }
}

function metricDelta(before, after) {
  return {
    raw_entries_pending: diff(before.raw_entries_pending, after.raw_entries_pending),
    raw_entries_failed: diff(before.raw_entries_failed, after.raw_entries_failed),
    node_count: diff(before.node_count, after.node_count),
    edge_count: diff(before.edge_count, after.edge_count),
    daily_report_count: diff(before.daily_report_count, after.daily_report_count),
  }
}

function addMetricWarnings(metrics, warnings) {
  const after = metrics.after ?? {}
  if (Number(after.raw_entries_failed ?? 0) > 0) warnings.push(`${after.raw_entries_failed} failed raw entry perlu review.`)
  if (Number(after.low_confidence_node_count ?? 0) > 0) warnings.push(`${after.low_confidence_node_count} low confidence nodes perlu review.`)
  if (Number(after.low_confidence_edge_count ?? 0) > 0) warnings.push(`${after.low_confidence_edge_count} low confidence edges perlu review.`)
  if (Number(after.duplicate_candidate_count ?? 0) > 0) warnings.push(`${after.duplicate_candidate_count} duplicate candidate perlu dicek.`)
}

function addHealthMetricWarnings(metrics, warnings) {
  if (Number(metrics.raw_entries_pending ?? 0) > 0) warnings.push(`${metrics.raw_entries_pending} pending raw entries menunggu worker.`)
  if (Number(metrics.raw_entries_failed ?? 0) > 0) warnings.push(`${metrics.raw_entries_failed} failed raw entries perlu review.`)
  if (Number(metrics.low_confidence_node_count ?? 0) > 0) warnings.push(`${metrics.low_confidence_node_count} low confidence nodes perlu review.`)
  if (Number(metrics.low_confidence_edge_count ?? 0) > 0) warnings.push(`${metrics.low_confidence_edge_count} low confidence edges perlu review.`)
  if (Number(metrics.duplicate_candidate_count ?? 0) > 0) warnings.push(`${metrics.duplicate_candidate_count} duplicate candidates mungkin perlu merge/ignore.`)
  const score = Number(metrics.latest_eval?.average_score ?? NaN)
  if (Number.isFinite(score) && score < evalMinScore) warnings.push(`Evaluation score ${score.toFixed(2)} di bawah batas ${evalMinScore.toFixed(2)}.`)
}

function applyEvalGate(latestEval, warnings) {
  if (!latestEval) {
    warnings.push('Belum ada latest evaluation run untuk eval gate.')
    return
  }
  const score = Number(latestEval.average_score ?? 0)
  const hallucination = Number(latestEval.hallucination_risk ?? 0)
  if (score < evalMinScore) warnings.push(`Brain belum cukup akurat untuk dipercaya penuh. Evaluation score ${score.toFixed(2)} di bawah batas ${evalMinScore.toFixed(2)}.`)
  if (hallucination > maxHallucinationRisk) warnings.push(`Hallucination risk ${hallucination.toFixed(2)} di atas batas ${maxHallucinationRisk.toFixed(2)}.`)
}

function renderSummary(status, steps, warnings, errors, metrics) {
  const done = steps.filter((item) => item.status === 'done').map((item) => item.label)
  const skipped = steps.filter((item) => item.status === 'skipped').map((item) => item.label)
  return [
    `Daily Brain Routine selesai dengan status ${status}.`,
    '',
    'Done:',
    ...(done.length ? done.map((item) => `- ${item}`) : ['- Tidak ada step selesai.']),
    ...(skipped.length ? ['', 'Skipped:', ...skipped.map((item) => `- ${item}`)] : []),
    ...(warnings.length ? ['', 'Warnings:', ...warnings.map((item) => `- ${item}`)] : []),
    ...(errors.length ? ['', 'Errors:', ...errors.map((item) => `- ${item}`)] : []),
    '',
    'Next manual checks:',
    ...nextManualChecks(warnings, errors, metrics).map((item, index) => `${index + 1}. ${item}`),
  ].join('\n')
}

function nextManualChecks(warnings, errors, metrics) {
  const checks = []
  if (warnings.some((item) => item.includes('low confidence') || item.includes('duplicate'))) checks.push('Buka Review View dan periksa low confidence serta duplicate candidates.')
  if (warnings.some((item) => item.includes('Evaluation') || item.includes('Hallucination') || item.includes('akurat'))) checks.push('Buka Evaluation View dan cek failed cases.')
  if (errors.length || Number(metrics?.after?.raw_entries_failed ?? 0) > 0) checks.push('Buka Review View dan retry failed raw entries.')
  if (!checks.length) checks.push('Buka Brain Chat dan uji satu pertanyaan penting setelah routine.')
  return checks
}

function recommendedFixes(status, warnings, errors, metrics) {
  const fixes = []
  if (status === 'failed' || errors.length) fixes.push('Baca error step routine dan jalankan command step terkait secara manual.')
  if (Number(metrics?.after?.raw_entries_failed ?? 0) > 0) fixes.push('Retry failed raw entries dari Review View.')
  if (warnings.some((item) => item.includes('akurat'))) fixes.push('Perbaiki source/retrieval sebelum memakai jawaban Brain Chat untuk keputusan penting.')
  if (!fixes.length) fixes.push('Tidak ada fix wajib dari routine ini.')
  return fixes
}

function writeRoutineOutputs(run) {
  const finished = new Date(run.finished_at ?? Date.now())
  const timestamp = formatReportDate(finished)
  const routineDir = resolve(vaultPath, '_system', 'routine')
  const logsDir = resolve(vaultPath, '_system', 'logs')
  mkdirSync(routineDir, { recursive: true })
  mkdirSync(logsDir, { recursive: true })
  const content = renderMarkdownRoutine(run)
  writeFileSync(resolve(routineDir, `Daily Brain Routine ${timestamp}.md`), content, 'utf8')
  writeFileSync(resolve(routineDir, 'Daily Brain Routine Latest.md'), content, 'utf8')
  const day = timestamp.slice(0, 10)
  writeFileSync(resolve(logsDir, `brain-routine-${day}.md`), content, 'utf8')
}

function renderMarkdownRoutine(run) {
  const metadata = run.metadata ?? {}
  return `---
title: Daily Brain Routine
status: ${run.status}
run_id: ${run.run_id ?? ''}
generated_at: ${new Date().toISOString()}
---

${AUTO_START}
# Daily Brain Routine

## Summary

${run.summary}

## Step Status

${(run.steps ?? []).map((step) => `- ${step.label}: ${step.status}${step.duration_ms ? ` (${step.duration_ms}ms)` : ''}${step.error ? `\n  - error: ${step.error}` : ''}`).join('\n')}

## Metrics

\`\`\`json
${JSON.stringify(run.metrics ?? {}, null, 2)}
\`\`\`

## Warnings

${(run.warnings ?? []).length ? run.warnings.map((item) => `- ${item}`).join('\n') : '- Tidak ada warning.'}

## Errors

${(run.errors ?? []).length ? run.errors.map((item) => `- ${item}`).join('\n') : '- Tidak ada error.'}

## Recommended Fixes

${(metadata.recommended_fixes ?? []).map((item) => `- ${item}`).join('\n')}

## Next Manual Checks

${(metadata.next_manual_checks ?? []).map((item, index) => `${index + 1}. ${item}`).join('\n')}

${AUTO_END}
`
}

async function insertRoutineRun(supabase, row) {
  let { data, error } = await supabase.from('brain_routine_runs').insert(row).select('*').single()
  if (error && /schema cache/i.test(error.message ?? '')) {
    await sleep(1500)
    const retry = await supabase.from('brain_routine_runs').insert(row).select('*').single()
    data = retry.data
    error = retry.error
  }
  if (error) {
    console.error(`[brain-routine] failed insert run: ${error.message}`)
    return null
  }
  return data
}

async function updateRoutineRun(supabase, id, patch) {
  const { data, error } = await supabase.from('brain_routine_runs').update(patch).eq('id', id).select('*').single()
  if (error) {
    console.error(`[brain-routine] failed update run: ${error.message}`)
    return null
  }
  return data
}

async function createSupabaseClient() {
  if (!supabaseUrl) throw new Error('Missing env: SUPABASE_URL atau VITE_SUPABASE_URL')
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

async function resolveUserId(supabase) {
  if (process.env.BRAIN_ROUTINE_USER_ID) return process.env.BRAIN_ROUTINE_USER_ID
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  if (process.env.SUPABASE_USER_ID) return process.env.SUPABASE_USER_ID
  const { data: userData } = await supabase.auth.getUser()
  if (userData?.user?.id) return userData.user.id
  const { data, error } = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  if (data?.user_id) return data.user_id
  throw new Error('Tidak bisa menentukan user_id untuk daily brain routine.')
}

function runCommand(command, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      output += `\n[brain-routine] ${command} timeout setelah ${timeoutMs}ms`
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, output })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ code: 1, output: err.message })
    })
  })
}

function addCheck(checks, name, ok, message) {
  checks.push({ name, status: ok ? 'done' : 'failed', message })
}

function healthScore(checks, warnings, errors) {
  const total = Math.max(checks.length, 1)
  const failed = checks.filter((item) => item.status !== 'done').length
  return Math.max(0, Math.min(100, Math.round(100 - (failed / total) * 65 - warnings.length * 3 - errors.length * 12)))
}

function parseProcessedCount(text) {
  const raw = String(text ?? '')
  const match = raw.match(/(?:processed|indexed|updated|generated|imported)[^0-9]{0,20}(\d+)/i)
  return match ? Number(match[1]) : null
}

function parseFileCount(text) {
  const raw = String(text ?? '')
  const match = raw.match(/(?:files?|written|synced)[^0-9]{0,20}(\d+)/i)
  return match ? Number(match[1]) : null
}

function excerpt(value, max = 1600) {
  const clean = redactSecrets(String(value ?? '').trim().replace(/\r/g, ''))
  if (clean.length <= max) return clean
  return `${clean.slice(0, max)}\n...`
}

function redactSecrets(value) {
  return String(value ?? '')
    .replace(/([A-Z0-9_]*(?:API_KEY|SERVICE_ROLE_KEY|TOKEN|SECRET)[A-Z0-9_]*=)([^\s,\n]+)/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/sha256:[a-f0-9]{8,}/gi, 'sha256:[redacted]')
    .replace(/service_role/gi, '[redacted-role]')
}

function errorMessage(err) {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const record = err
    return String(record.message ?? record.error_description ?? record.details ?? JSON.stringify(record))
  }
  return String(err)
}

function diff(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null
  return Number(b) - Number(a)
}

function normalizeName(value) {
  return String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '')
}

function sanitizeRoutineType(value) {
  return ROUTINE_TYPES.has(value) && value !== 'health_check' ? value : 'daily'
}

function sanitizeProfile(value) {
  return typeof value === 'string' && PROFILE_TYPES.has(value) ? value : 'daily'
}

function sanitizeStatus(value) {
  return STATUSES.has(value) ? value : 'failed'
}

function sanitizeHealthStatus(value) {
  return HEALTH_STATUSES.has(value) ? value : 'critical'
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
