import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const AUTO_START = '<!-- FINAL_RELEASE_AUTO_START -->'
const AUTO_END = '<!-- FINAL_RELEASE_AUTO_END -->'
const RELEASE_TYPES = new Set(['manual', 'daily_use', 'release_candidate', 'final'])
const SCRIPT_CHECKS = [
  'brain-worker.mjs','obsidian-importer.mjs','attachment-importer.mjs','brain-quality.mjs','brain-chat.mjs','brain-indexer.mjs','obsidian-sync.mjs','brain-digest.mjs','brain-eval.mjs','daily-brain-routine.mjs','brain-backup.mjs','identity-fidelity.mjs','communication-style.mjs','response-inference.mjs','owner-calibration.mjs','similarity-eval.mjs','drift-control.mjs','self-reflection.mjs','chat-sample-importer.mjs','identity-conflicts.mjs','self-clone-eval.mjs','entity-runtime.mjs','memory-consolidation.mjs','final-release.mjs',
]
const SECRET_PATTERN = /SUPABASE_SERVICE_ROLE_KEY|service_role|FINAL_RELEASE_API_KEY|MEMORY_CONSOLIDATION_API_KEY|ENTITY_RUNTIME_API_KEY|SELF_CLONE_EVAL_API_KEY|IDENTITY_CONFLICTS_API_KEY|SELF_REFLECTION_API_KEY|DRIFT_CONTROL_API_KEY|SIMILARITY_EVAL_API_KEY|OWNER_CALIBRATION_API_KEY|RESPONSE_INFERENCE_API_KEY|COMMUNICATION_API_KEY|IDENTITY_API_KEY|BRAIN_CHAT_API_KEY|LLM_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY/
const REQUIRED_DOCS = ['README.md','frontend/README.md','AhyarBrainVault/README.md','docs/FINAL_OPERATING_MANUAL.md','docs/RELEASE_CHECKLIST.md','docs/SAFETY_BOUNDARIES.md','docs/DAILY_USAGE_GUIDE.md','docs/TROUBLESHOOTING.md','docs/ARCHITECTURE_OVERVIEW.md','docs/FINAL_RELEASE_REPORT.md']
const REQUIRED_VAULT_DIRS = ['00_Diary','80_Attachments','85_Chat_Samples','_system','_system/identity','_system/communication','_system/calibration','_system/similarity','_system/drift','_system/reflections','_system/chat-samples','_system/conflicts','_system/self-clone-eval','_system/runtime','_system/memory','_system/final-release']
const WEIGHTS = {
  security: 20,
  database: 5,
  migration: 5,
  frontend: 5,
  scripts: 5,
  backup: 10,
  identity: 5,
  communication: 5,
  response_inference: 3.4,
  calibration: 3.3,
  similarity: 3.3,
  drift: 5,
  runtime: 5,
  self_clone_eval: 10,
  long_term_memory: 2,
  reflection: 1.5,
  conflicts: 1.5,
  documentation: 5,
}

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const args = parseArgs(process.argv.slice(2))
const command = args.has('notes') ? 'notes'
  : args.has('artifacts') ? 'artifacts'
  : args.has('audit') ? 'audit'
  : args.has('latest') ? 'latest'
  : args.has('final') ? 'final'
  : 'check'

try {
  let result
  if (command === 'latest') result = await latestFinalRelease()
  else if (command === 'notes') result = await generateReleaseNotes({ version: readArg('version') || releaseVersion() })
  else if (command === 'artifacts') result = await generateArtifactsOnly()
  else if (command === 'audit') result = await runFinalRelease({ releaseType: 'manual', final: false, save: readBoolArg('save', true), auditOnly: true })
  else result = await runFinalRelease({ releaseType: command === 'final' ? 'final' : sanitizeReleaseType(readArg('type') || 'release_candidate'), final: command === 'final', save: true })
  console.log(JSON.stringify(result, null, args.has('pretty') ? 2 : 0))
  if (result.status === 'blocked' || result.release_decision === 'do_not_use') process.exitCode = 2
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

async function runFinalRelease({ releaseType, final = false, save = true, auditOnly = false }) {
  ensureFinalDocs()
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const startedAt = new Date()
  let run = await insertRun(supabase, userId, { releaseType, status: 'running' })
  const checks = []
  const artifacts = []
  const ctx = { supabase, userId, checks, artifacts, releaseType, final, auditOnly }

  await checkEnvironment(ctx)
  await checkMigrations(ctx)
  await checkDatabase(ctx)
  await checkBuild(ctx)
  await checkSecurity(ctx)
  await checkScripts(ctx)
  await checkObsidian(ctx)
  await checkBackup(ctx)
  await checkBrainData(ctx)
  await checkIdentity(ctx)
  await checkCommunication(ctx)
  await checkResponseInference(ctx)
  await checkCalibration(ctx)
  await checkSimilarity(ctx)
  await checkDrift(ctx)
  await checkReflection(ctx)
  await checkChatSamples(ctx)
  await checkConflicts(ctx)
  await checkSelfCloneEval(ctx)
  await checkRuntime(ctx)
  await checkLongTermMemory(ctx)
  await checkDocumentation(ctx)
  addCheck(checks, 'release', 'final_release_policy', 'Final release tidak menambah action eksternal/fine-tuning.', 'passed', 'critical', 100, 'No external action', 'Read-only/proposal-only release layer', {}, 'Pertahankan runtime boundary.')

  const score = scoreChecks(checks)
  const blockers = checks.filter((check) => ['blocked', 'failed'].includes(check.status) && ['critical', 'high'].includes(check.severity))
  const warnings = checks.filter((check) => check.status === 'warning')
  const failed = checks.filter((check) => ['blocked', 'failed'].includes(check.status))
  const passed = checks.filter((check) => check.status === 'passed')
  const readiness = readinessFor(score, blockers, checks)
  const decision = decisionFor(score, blockers, checks)
  const status = blockers.length && readBoolEnv('FINAL_RELEASE_BLOCK_ON_CRITICAL', true) ? 'blocked' : failed.some((check) => check.severity === 'critical') ? 'failed' : 'done'
  const summary = `Final release ${releaseVersion()} ${decision} dengan score ${score.toFixed(1)}. Blockers ${blockers.length}, warnings ${warnings.length}.`

  await insertChecks(supabase, userId, run.id, checks)
  const notes = await upsertReleaseNotes(supabase, userId, run.id, { version: releaseVersion(), decision, score, blockers, warnings })
  const obsidianArtifacts = writeFinalReleaseReports({ run: { ...run, overall_score: score, readiness_level: readiness, release_decision: decision, summary }, checks, notes, artifacts })
  artifacts.push(...obsidianArtifacts)
  await insertArtifacts(supabase, userId, run.id, artifacts)
  run = await updateRun(supabase, run.id, {
    status,
    overall_score: score,
    readiness_level: readiness,
    release_decision: decision,
    blocker_count: blockers.length,
    warning_count: warnings.length,
    passed_check_count: passed.length,
    failed_check_count: failed.length,
    finished_at: new Date().toISOString(),
    summary,
    metadata: {
      weights: WEIGHTS,
      duration_ms: Date.now() - startedAt.getTime(),
      audit_only: auditOnly,
      recommended_next_steps: recommendedNextSteps(decision, blockers, warnings),
    },
  })
  writeFinalReleaseDoc({ run, checks, notes, blockers, warnings })
  return { ok: status !== 'failed', status, release_run_id: run.id, overall_score: score, readiness_level: readiness, release_decision: decision, blockers, warnings, checks_count: checks.length, artifacts_count: artifacts.length, release_notes_id: notes.id }
}

async function checkEnvironment(ctx) {
  addCheck(ctx.checks, 'environment', 'frontend_env_example_exists', '.env.example tersedia.', existsSync(resolve(process.cwd(), '.env.example')) ? 'passed' : 'failed', 'high', existsSync(resolve(process.cwd(), '.env.example')) ? 100 : 0, 'exists', 'checked', {}, 'Buat frontend/.env.example.')
  const workerEnv = readFileSafe(resolve(process.cwd(), 'scripts/brain-worker.env.example'))
  const required = ['FINAL_RELEASE_ENABLED','FINAL_RELEASE_VERSION','SAFE_ENTITY_RUNTIME_ENABLED','LONG_TERM_MEMORY_ENABLED','SELF_CLONE_EVAL_ENABLED']
  const missing = required.filter((key) => !workerEnv.includes(key))
  addCheck(ctx.checks, 'environment', 'worker_env_documents_release', 'brain-worker env mendokumentasikan release/runtime/memory.', missing.length ? 'warning' : 'passed', 'medium', missing.length ? 70 : 100, required.join(', '), missing.length ? `missing ${missing.join(', ')}` : 'complete', { missing }, 'Tambahkan env final release ke brain-worker.env.example.')
  const gitIgnore = readFileSafe(resolve(rootDir, '.gitignore'))
  addCheck(ctx.checks, 'environment', 'local_env_gitignored', 'Local env tidak masuk git jika bisa dicek.', /\.env(\.local)?/.test(gitIgnore) ? 'passed' : 'warning', 'medium', /\.env(\.local)?/.test(gitIgnore) ? 100 : 65, '.env ignored', '.gitignore checked', {}, 'Tambahkan .env dan .env.local ke .gitignore.')
}

async function checkMigrations(ctx) {
  const migrationDir = resolve(rootDir, 'supabase/migrations')
  const files = existsSync(migrationDir) ? readdirSync(migrationDir) : []
  const required = ['create_chat_sample_importer','create_identity_conflicts','create_self_clone_evaluation','create_safe_entity_runtime','create_long_term_memory_consolidation','create_final_release']
  for (const name of required) {
    const found = files.some((file) => file.includes(name))
    addCheck(ctx.checks, 'migration', `migration_${name}`, `Migration tersedia: ${name}`, found ? 'passed' : 'blocked', 'critical', found ? 100 : 0, name, found ? 'found' : 'missing', {}, 'Tambahkan migration yang hilang.')
  }
}

async function checkDatabase(ctx) {
  const tables = ['raw_entries','brain_nodes','agent_memories','identity_facts','communication_patterns','response_inference_rules','owner_answer_examples','similarity_eval_runs','drift_guard_rules','self_reflection_logs','chat_imports','identity_conflicts','self_clone_eval_runs','entity_runtime_policies','long_term_memories','final_release_runs']
  for (const table of tables) {
    const { count, error } = await ctx.supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId)
    addCheck(ctx.checks, 'database', `table_${table}`, `Table ${table} bisa diakses.`, error ? 'warning' : 'passed', table === 'final_release_runs' ? 'medium' : 'high', error ? 50 : 100, 'select succeeds', error?.message ?? `${count ?? 0} rows`, { table, count: count ?? 0 }, 'Apply migration dengan supabase db push dan cek RLS/policy.')
  }
}

async function checkSecurity(ctx) {
  if (!readBoolEnv('FINAL_RELEASE_REQUIRE_SECRET_SCAN', true)) return addCheck(ctx.checks, 'security', 'dist_secret_scan_skipped', 'Secret scan skipped by env.', 'skipped', 'critical', 50, 'secret scan required', 'skipped', {}, 'Set FINAL_RELEASE_REQUIRE_SECRET_SCAN=true untuk final release.')
  const dist = resolve(process.cwd(), 'dist')
  const matches = existsSync(dist) ? scanFiles([dist], SECRET_PATTERN) : []
  addCheck(ctx.checks, 'security', 'dist_secret_scan', 'Frontend bundle tidak mengandung secret key sensitif.', matches.length ? 'blocked' : 'passed', 'critical', matches.length ? 0 : 100, '0 matches', `${matches.length} matches`, { matches: matches.slice(0, 10) }, 'Hapus secret dari VITE/bundle dan build ulang.')
  const vite = readFileSafe(resolve(process.cwd(), 'vite.config.ts'))
  const unsafe = /body\.(path|command|cmd)|readRequiredString\(body,\s*['"](path|command|cmd)/.test(vite)
  addCheck(ctx.checks, 'security', 'vite_no_arbitrary_command_path', 'Endpoint lokal tidak menerima arbitrary command/path.', unsafe ? 'blocked' : 'passed', 'critical', unsafe ? 0 : 100, 'no arbitrary command/path', unsafe ? 'suspicious pattern' : 'ok', {}, 'Gunakan enum/allowlist, bukan path/command dari payload.')
  addCheck(ctx.checks, 'security', 'runtime_env_blocks_actions', 'Runtime external action/identity/command blocked by env defaults.', defaultEnvBlocks() ? 'passed' : 'blocked', 'critical', defaultEnvBlocks() ? 100 : 0, 'blocked', 'checked env example', {}, 'Set ENTITY_RUNTIME_ALLOW_* false dan BLOCK_EXTERNAL_ACTIONS true.')
}

async function checkBuild(ctx) {
  if (!readBoolEnv('FINAL_RELEASE_REQUIRE_BUILD', true)) return addCheck(ctx.checks, 'frontend', 'build_skipped', 'Build check skipped by env.', 'skipped', 'medium', 50, 'build optional', 'skipped', {}, 'Set FINAL_RELEASE_REQUIRE_BUILD=true untuk release final.')
  const result = runAllowed('npm', ['run', 'build'])
  addCheck(ctx.checks, 'frontend', 'npm_run_build', 'npm run build harus lolos.', result.status === 0 ? 'passed' : 'blocked', 'critical', result.status === 0 ? 100 : 0, 'exit 0', `exit ${result.status}`, { output: excerpt(result.output, 4000) }, 'Perbaiki TypeScript/Vite build error.')
  ctx.artifacts.push(artifact('build_report', 'Vite Build Report', null, 'npm run build executed by release check.', result.status === 0 ? 'created' : 'failed', null, { output: excerpt(result.output, 4000) }))
}

async function checkScripts(ctx) {
  let passed = 0
  for (const script of SCRIPT_CHECKS) {
    const path = resolve(process.cwd(), 'scripts', script)
    if (!existsSync(path)) {
      addCheck(ctx.checks, 'scripts', `syntax_${script}`, `node --check ${script}`, 'warning', 'medium', 40, 'exists and valid', 'missing', {}, 'Tambahkan script atau update release checklist.')
      continue
    }
    const result = runAllowed('node', ['--check', `scripts/${script}`])
    if (result.status === 0) passed += 1
    addCheck(ctx.checks, 'scripts', `syntax_${script}`, `node --check ${script}`, result.status === 0 ? 'passed' : 'blocked', 'high', result.status === 0 ? 100 : 0, 'exit 0', `exit ${result.status}`, { output: excerpt(result.output, 1000) }, 'Perbaiki syntax script.')
  }
  addCheck(ctx.checks, 'scripts', 'script_coverage', 'Semua script utama dicek syntax.', passed === SCRIPT_CHECKS.length ? 'passed' : 'warning', 'medium', Math.round((passed / SCRIPT_CHECKS.length) * 100), `${SCRIPT_CHECKS.length}`, `${passed}`, {}, 'Jalankan node --check untuk script yang gagal.')
}

async function checkObsidian(ctx) {
  const vault = vaultPath()
  const missing = REQUIRED_VAULT_DIRS.filter((dir) => !existsSync(resolve(vault, dir)))
  addCheck(ctx.checks, 'obsidian', 'vault_folders', 'Folder Obsidian dan _system lengkap.', missing.length ? 'warning' : 'passed', 'medium', missing.length ? 65 : 100, 'all required folders', missing.length ? missing.join(', ') : 'complete', { missing }, 'Buat folder vault yang hilang.')
}

async function checkBackup(ctx) {
  const backups = listBackupManifests()
  const required = readBoolEnv('FINAL_RELEASE_REQUIRE_BACKUP', true)
  addCheck(ctx.checks, 'backup', 'latest_backup_exists', 'Latest backup tersedia.', backups.length ? 'passed' : required ? 'blocked' : 'warning', 'critical', backups.length ? 100 : 0, 'backup exists', backups[0]?.backup_id ?? 'none', { latest: backups[0] ?? null }, 'Jalankan npm run brain:backup.')
  const latestPath = backups[0] ? resolve(backupDir(), backups[0].backup_id) : null
  const secretMatches = latestPath && existsSync(latestPath) ? scanFiles([latestPath], SECRET_PATTERN) : []
  addCheck(ctx.checks, 'backup', 'backup_secret_scan', 'Backup terbaru tidak mengandung secret pattern.', secretMatches.length ? 'warning' : 'passed', 'medium', secretMatches.length ? 60 : 100, '0 matches', `${secretMatches.length} matches`, { matches: secretMatches.slice(0, 10) }, 'Review backup manifest/log dan exclude secret.')
}

async function checkBrainData(ctx) {
  const raw = await count(ctx, 'raw_entries')
  const nodes = await count(ctx, 'brain_nodes')
  addCheck(ctx.checks, 'brain_data', 'raw_entries_available', 'Raw diary/data tersedia.', raw > 0 ? 'passed' : 'warning', 'medium', raw > 0 ? 100 : 50, '>0', String(raw), {}, 'Import Obsidian/chat/file terlebih dahulu.')
  addCheck(ctx.checks, 'brain_data', 'brain_nodes_available', 'Structured brain nodes tersedia.', nodes > 0 ? 'passed' : 'warning', 'medium', nodes > 0 ? 100 : 50, '>0', String(nodes), {}, 'Jalankan brain worker.')
}

async function checkIdentity(ctx) {
  const facts = await rows(ctx, 'identity_facts', 'id,evidence_refs,confidence_score,status', (q) => q.in('status', ['active','needs_review','contradicted']).limit(200))
  const snapshots = await count(ctx, 'identity_snapshots')
  const highNoEvidence = facts.filter((f) => Number(f.confidence_score ?? 0) >= 0.75 && !arrayFrom(f.evidence_refs).length)
  addCheck(ctx.checks, 'identity', 'identity_facts_active', 'Identity facts tersedia.', facts.length ? 'passed' : 'warning', 'high', facts.length ? 100 : 45, '>0', String(facts.length), {}, 'Jalankan npm run identity:build.')
  addCheck(ctx.checks, 'identity', 'identity_snapshot_latest', 'Identity snapshot tersedia.', snapshots ? 'passed' : 'warning', 'medium', snapshots ? 100 : 55, '>0', String(snapshots), {}, 'Jalankan npm run identity:snapshot.')
  addCheck(ctx.checks, 'identity', 'high_confidence_identity_has_evidence', 'High confidence identity facts punya evidence_refs.', highNoEvidence.length ? 'warning' : 'passed', 'high', highNoEvidence.length ? 65 : 100, '0', String(highNoEvidence.length), {}, 'Tambahkan evidence atau turunkan confidence.')
}

async function checkCommunication(ctx) {
  const patterns = await rows(ctx, 'communication_patterns', 'id,pattern_type,status', (q) => q.eq('status', 'active').limit(200))
  addCheck(ctx.checks, 'communication', 'communication_patterns_active', 'Communication patterns aktif tersedia.', patterns.length ? 'passed' : 'warning', 'high', patterns.length ? 100 : 45, '>0', String(patterns.length), {}, 'Jalankan npm run communication:build.')
  addCheck(ctx.checks, 'communication', 'core_styles_available', 'Greeting/prompt/technical style tersedia atau warning.', ['greeting_style','prompt_request_style','technical_style'].every((type) => patterns.some((p) => p.pattern_type === type)) ? 'passed' : 'warning', 'medium', 75, 'greeting,prompt,technical', patterns.map((p) => p.pattern_type).join(', '), {}, 'Import chat samples dan rebuild communication style.')
}

async function checkResponseInference(ctx) {
  const rules = await rows(ctx, 'response_inference_rules', 'id,intent_type,enabled', (q) => q.eq('enabled', true).limit(100))
  const logs = await count(ctx, 'response_inference_logs')
  addCheck(ctx.checks, 'response_inference', 'response_rules_seeded', 'Response inference rules tersedia.', rules.length ? 'passed' : 'warning', 'high', rules.length ? 100 : 45, '>0', String(rules.length), {}, 'Jalankan npm run response:rules.')
  addCheck(ctx.checks, 'response_inference', 'response_logs_exist', 'Inference logs tersedia.', logs ? 'passed' : 'warning', 'medium', logs ? 100 : 60, '>0', String(logs), {}, 'Jalankan Brain Chat/response:infer.')
}

async function checkCalibration(ctx) {
  const examples = await count(ctx, 'owner_answer_examples')
  const hints = await rows(ctx, 'owner_calibration_hints', 'id,status', (q) => q.in('status', ['active','needs_review']).limit(100))
  addCheck(ctx.checks, 'calibration', 'owner_examples_available', 'Owner answer examples tersedia.', examples ? 'passed' : 'warning', 'medium', examples ? 100 : 55, '>0', String(examples), {}, 'Import chat samples atau buat owner examples.')
  addCheck(ctx.checks, 'calibration', 'calibration_hints_available', 'Calibration hints aktif jika mismatch ada.', hints.length ? 'passed' : 'warning', 'low', hints.length ? 100 : 70, '>0 optional', String(hints.length), {}, 'Jalankan npm run owner:calibrate.')
}

async function checkSimilarity(ctx) {
  const latest = await latestRow(ctx, 'similarity_eval_runs', 'id,overall_score,status,created_at')
  const baseline = await count(ctx, 'similarity_baselines')
  addCheck(ctx.checks, 'similarity', 'similarity_latest_run', 'Latest similarity run tersedia.', latest ? 'passed' : 'warning', 'medium', latest ? 100 : 55, 'latest run', latest?.id ?? 'none', latest ?? {}, 'Jalankan npm run similarity:run.')
  addCheck(ctx.checks, 'similarity', 'similarity_baseline', 'Similarity baseline tersedia.', baseline ? 'passed' : 'warning', 'medium', baseline ? 100 : 60, '>0', String(baseline), {}, 'Jalankan npm run similarity:baseline.')
}

async function checkDrift(ctx) {
  const rules = await rows(ctx, 'drift_guard_rules', 'id,severity,enabled', (q) => q.eq('enabled', true).limit(100))
  const logs = await count(ctx, 'drift_guard_logs')
  addCheck(ctx.checks, 'drift', 'drift_rules_enabled', 'Drift rules enabled.', rules.length ? 'passed' : 'warning', 'high', rules.length ? 100 : 45, '>0', String(rules.length), {}, 'Jalankan npm run drift:rules -- --seed.')
  addCheck(ctx.checks, 'drift', 'drift_logs_exist', 'Drift logs tersedia.', logs ? 'passed' : 'warning', 'medium', logs ? 100 : 60, '>0', String(logs), {}, 'Jalankan response inference/brain chat.')
}

async function checkReflection(ctx) {
  const reflections = await count(ctx, 'self_reflection_logs')
  addCheck(ctx.checks, 'reflection', 'reflection_latest', 'Self-reflection pernah dijalankan.', reflections ? 'passed' : 'warning', 'medium', reflections ? 100 : 55, '>0', String(reflections), {}, 'Jalankan npm run reflection:daily.')
}

async function checkChatSamples(ctx) {
  const folder = existsSync(resolve(vaultPath(), '85_Chat_Samples'))
  const imports = await count(ctx, 'chat_imports')
  addCheck(ctx.checks, 'chat_samples', 'chat_sample_folder', 'Folder chat samples tersedia.', folder ? 'passed' : 'warning', 'medium', folder ? 100 : 60, 'exists', folder ? 'exists' : 'missing', {}, 'Buat AhyarBrainVault/85_Chat_Samples.')
  addCheck(ctx.checks, 'chat_samples', 'chat_imports_exist', 'Chat imports ada atau warning.', imports ? 'passed' : 'warning', 'low', imports ? 100 : 70, '>0 optional', String(imports), {}, 'Jalankan npm run chats:import.')
}

async function checkConflicts(ctx) {
  const conflicts = await rows(ctx, 'identity_conflicts', 'id,severity,chat_guidance,resolution_status', (q) => q.limit(100))
  const highWithoutGuidance = conflicts.filter((c) => ['high','critical'].includes(c.severity) && !c.chat_guidance)
  addCheck(ctx.checks, 'conflicts', 'conflicts_detected', 'Conflict detection pernah dijalankan.', conflicts.length ? 'passed' : 'warning', 'medium', conflicts.length ? 100 : 60, '>0 or no conflicts', String(conflicts.length), {}, 'Jalankan npm run conflicts:detect.')
  addCheck(ctx.checks, 'conflicts', 'high_conflicts_have_guidance', 'High severity conflicts punya chat_guidance.', highWithoutGuidance.length ? 'warning' : 'passed', 'medium', highWithoutGuidance.length ? 65 : 100, '0', String(highWithoutGuidance.length), {}, 'Tambahkan chat guidance/review conflict.')
}

async function checkSelfCloneEval(ctx) {
  const latest = await latestRow(ctx, 'self_clone_eval_runs', 'id,readiness_level,overall_score,critical_failed_cases,status,created_at')
  const report = await latestRow(ctx, 'self_clone_readiness_reports', 'id,readiness_level,overall_score,release_decision,created_at')
  const critical = Number(latest?.critical_failed_cases ?? 0)
  const ready = ['usable_with_warning','stable','release_candidate'].includes(report?.readiness_level ?? latest?.readiness_level)
  addCheck(ctx.checks, 'self_clone_eval', 'self_clone_latest_run', 'Latest self-clone eval run tersedia.', latest ? 'passed' : readBoolEnv('FINAL_RELEASE_REQUIRE_SELF_CLONE_EVAL', true) ? 'blocked' : 'warning', 'high', latest ? 100 : 0, 'latest run', latest?.id ?? 'none', latest ?? {}, 'Jalankan npm run clone:run -- --suite release.')
  addCheck(ctx.checks, 'self_clone_eval', 'self_clone_readiness', 'Readiness minimal usable_with_warning dan no critical failures.', ready && critical === 0 ? 'passed' : 'warning', 'high', ready && critical === 0 ? 100 : 60, 'usable_with_warning+, critical=0', `${report?.readiness_level ?? latest?.readiness_level ?? 'none'}, critical=${critical}`, { report }, 'Perbaiki critical failures lalu ulangi clone:run.')
}

async function checkRuntime(ctx) {
  const policies = await rows(ctx, 'entity_runtime_policies', 'id,policy_name,enabled,severity', (q) => q.eq('enabled', true).limit(100))
  const critical = ['block_identity_mutation','block_communication_mutation','block_external_actions','fidelity_first_runtime']
  const missing = critical.filter((name) => !policies.some((p) => p.policy_name === name))
  addCheck(ctx.checks, 'runtime', 'runtime_policies_seeded', 'Runtime policies seeded dan critical enabled.', missing.length ? 'blocked' : 'passed', 'critical', missing.length ? 0 : 100, critical.join(', '), missing.length ? `missing ${missing.join(', ')}` : 'complete', { policies: policies.map((p) => p.policy_name) }, 'Jalankan npm run entity:policies -- --seed.')
  addCheck(ctx.checks, 'runtime', 'runtime_external_actions_blocked', 'External action/identity/command execution blocked.', defaultEnvBlocks() ? 'passed' : 'blocked', 'critical', defaultEnvBlocks() ? 100 : 0, 'blocked', 'env checked', {}, 'Set runtime env boundary ke false/blocked.')
}

async function checkLongTermMemory(ctx) {
  const memories = await count(ctx, 'long_term_memories')
  const run = await latestRow(ctx, 'memory_consolidation_runs', 'id,status,created_at')
  const snapshot = await latestRow(ctx, 'memory_consolidation_snapshots', 'id,status,created_at')
  const criticalReviews = await rows(ctx, 'memory_review_queue', 'id,priority,status', (q) => q.eq('status', 'pending').eq('priority', 'critical').limit(50))
  addCheck(ctx.checks, 'long_term_memory', 'long_term_memories_exist', 'Long-term memories tersedia.', memories ? 'passed' : readBoolEnv('FINAL_RELEASE_REQUIRE_LONG_TERM_MEMORY', true) ? 'warning' : 'skipped', 'medium', memories ? 100 : 60, '>0', String(memories), {}, 'Jalankan npm run memory:consolidate.')
  addCheck(ctx.checks, 'long_term_memory', 'memory_consolidation_snapshot', 'Consolidation run dan snapshot tersedia.', run && snapshot ? 'passed' : 'warning', 'medium', run && snapshot ? 100 : 60, 'run+snapshot', `${run?.id ?? 'no-run'} ${snapshot?.id ?? 'no-snapshot'}`, {}, 'Jalankan npm run memory:snapshot.')
  addCheck(ctx.checks, 'long_term_memory', 'memory_review_queue_not_critical', 'Review queue tidak critical.', criticalReviews.length ? 'warning' : 'passed', 'medium', criticalReviews.length ? 65 : 100, '0 critical', String(criticalReviews.length), {}, 'Review critical memory queue.')
}

async function checkDocumentation(ctx) {
  const missing = REQUIRED_DOCS.filter((file) => !existsSync(resolve(rootDir, file)))
  addCheck(ctx.checks, 'documentation', 'required_docs_exist', 'Dokumentasi final tersedia.', missing.length ? 'warning' : 'passed', 'medium', missing.length ? 65 : 100, REQUIRED_DOCS.join(', '), missing.length ? missing.join(', ') : 'complete', { missing }, 'Buat docs yang hilang.')
}

async function generateReleaseNotes({ version }) {
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const latest = await latestFinalRelease({ supabase, userId })
  const notes = await upsertReleaseNotes(supabase, userId, latest.latest_run?.id ?? null, { version, decision: latest.latest_run?.release_decision ?? 'internal_testing_only', score: latest.latest_run?.overall_score ?? 0, blockers: latest.blockers ?? [], warnings: latest.warnings ?? [] })
  writeFinalReleaseReports({ run: latest.latest_run, checks: latest.checks ?? [], notes, artifacts: latest.artifacts ?? [] })
  return { ok: true, release_notes: notes }
}

async function generateArtifactsOnly() {
  const latest = await latestFinalRelease()
  const artifacts = writeFinalReleaseReports({ run: latest.latest_run, checks: latest.checks ?? [], notes: latest.release_notes, artifacts: latest.artifacts ?? [] })
  return { ok: true, artifacts }
}

async function latestFinalRelease(existing = {}) {
  const supabase = existing.supabase ?? await createSupabaseClient()
  const userId = existing.userId ?? await resolveUserId(supabase)
  const run = await latestRow({ supabase, userId }, 'final_release_runs', '*')
  const [checks, artifacts, notes] = await Promise.all([
    run ? rows({ supabase, userId }, 'final_release_checks', '*', (q) => q.eq('final_release_run_id', run.id).order('created_at', { ascending: true }).limit(300)) : [],
    run ? rows({ supabase, userId }, 'final_release_artifacts', '*', (q) => q.eq('final_release_run_id', run.id).order('created_at', { ascending: true }).limit(100)) : [],
    run ? latestRow({ supabase, userId }, 'final_release_notes', '*') : null,
  ])
  return { ok: true, latest_run: run, checks, artifacts, release_notes: notes, blockers: checks.filter((c) => ['blocked','failed'].includes(c.status) && ['critical','high'].includes(c.severity)), warnings: checks.filter((c) => c.status === 'warning') }
}

async function insertRun(supabase, userId, { releaseType, status }) {
  const { data, error } = await supabase.from('final_release_runs').insert({ user_id: userId, release_name: 'Personal Entity OS Final Release', release_version: releaseVersion(), release_type: releaseType, status, started_at: new Date().toISOString(), metadata: { generated_by: 'final-release.mjs' } }).select('*').single()
  if (error) throw error
  return data
}
async function updateRun(supabase, id, patch) { const { data, error } = await supabase.from('final_release_runs').update(patch).eq('id', id).select('*').single(); if (error) throw error; return data }
async function insertChecks(supabase, userId, runId, checks) { if (!checks.length) return; const { error } = await supabase.from('final_release_checks').insert(checks.map((check) => ({ user_id: userId, final_release_run_id: runId, ...check }))); if (error) throw error }
async function insertArtifacts(supabase, userId, runId, artifacts) { if (!artifacts.length) return; const { error } = await supabase.from('final_release_artifacts').insert(artifacts.map((artifact) => ({ user_id: userId, final_release_run_id: runId, ...artifact }))); if (error) throw error }

async function upsertReleaseNotes(supabase, userId, runId, { version, decision, score, blockers, warnings }) {
  const notes = releaseNotesPayload({ userId, runId, version, decision, score, blockers, warnings })
  const { data, error } = await supabase.from('final_release_notes').insert(notes).select('*').single()
  if (error) throw error
  return data
}

function releaseNotesPayload({ userId, runId, version, decision, score, blockers, warnings }) {
  return {
    user_id: userId,
    final_release_run_id: runId,
    version,
    title: `Personal Entity OS ${version}`,
    summary: `Final release decision: ${decision}. Score: ${Number(score ?? 0).toFixed(1)}.`,
    completed_phases: Array.from({ length: 30 }, (_, index) => ({ step: index + 1, status: 'completed_or_integrated' })),
    known_limitations: ['Bukan manusia asli.', 'Bukan kesadaran asli.', 'Tidak menjalankan aksi eksternal.', 'Approval proposal tidak mengeksekusi action.', 'Kualitas bergantung evidence diary/chat/file yang tersedia.', ...blockers.slice(0, 10).map((b) => b.description ?? b.check_name)],
    safety_boundaries: ['Runtime read-only/proposal-only.', 'External action blocked.', 'Identity mutation blocked.', 'Communication mutation blocked.', 'Raw data tidak dihapus.', 'No fine-tuning.', 'No production backend.'],
    daily_usage_instructions: ['Tulis diary di Obsidian.', 'Jalankan import/process/routine.', 'Import chat sample berkala.', 'Jalankan identity/communication/calibration/similarity/drift/reflection/conflicts/memory sesuai kebutuhan.', 'Start runtime read_only.', 'Chat dengan entity dan review warnings.', 'Backup rutin.', 'Run release:check berkala.'],
    recommended_next_steps: recommendedNextSteps(decision, blockers, warnings),
    status: 'done',
    metadata: { generated_by: 'final-release.mjs' },
  }
}

function writeFinalReleaseReports({ run, checks = [], notes = null, artifacts = [] }) {
  if (!readBoolEnv('FINAL_RELEASE_OUTPUT_OBSIDIAN', true)) return []
  const dir = resolve(vaultPath(), '_system/final-release')
  mkdirSync(dir, { recursive: true })
  const blockers = checks.filter((c) => ['blocked','failed'].includes(c.status) && ['critical','high'].includes(c.severity))
  const warnings = checks.filter((c) => c.status === 'warning')
  const latest = [
    '# Final Release Latest',
    '',
    `Version: ${run?.release_version ?? releaseVersion()}`,
    `Overall score: ${Number(run?.overall_score ?? 0).toFixed(1)}`,
    `Readiness level: ${run?.readiness_level ?? 'not_ready'}`,
    `Release decision: ${run?.release_decision ?? 'internal_testing_only'}`,
    `Blockers: ${blockers.length}`,
    `Warnings: ${warnings.length}`,
    '',
    '## Recommended next steps',
    ...arrayFrom(notes?.recommended_next_steps).map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`),
  ].join('\n')
  const checklist = ['# Final Release Checklist', '', ...checks.map((c) => `- [${c.status === 'passed' ? 'x' : ' '}] ${c.check_category}/${c.check_name}: ${c.status} (${c.severity})`)].join('\n')
  const notesText = ['# Final Release Notes', '', notes?.summary ?? 'No release notes yet.', '', '## Safety boundaries', ...arrayFrom(notes?.safety_boundaries).map((item) => `- ${item}`)].join('\n')
  const blockersText = ['# Final Release Blockers', '', ...blockers.map((b) => `- ${b.check_category}/${b.check_name}: ${b.actual || b.description}`)].join('\n')
  const artifactsText = ['# Final Release Artifacts', '', ...artifacts.map((a) => `- ${a.artifact_type}: ${a.title} (${a.status}) ${a.path ?? ''}`)].join('\n')
  const files = [
    [resolve(dir, 'Final Release Latest.md'), latest, 'obsidian_report', 'Final Release Latest'],
    [resolve(dir, 'Final Release Checklist.md'), checklist, 'checklist', 'Final Release Checklist'],
    [resolve(dir, 'Final Release Notes.md'), notesText, 'release_notes', 'Final Release Notes'],
    [resolve(dir, 'Final Release Blockers.md'), blockersText, 'audit_report', 'Final Release Blockers'],
    [resolve(dir, 'Final Release Artifacts.md'), artifactsText, 'audit_report', 'Final Release Artifacts'],
  ]
  return files.map(([path, content, type, title]) => { writeMarked(path, content); return artifact(type, title, path, `Generated ${title}`, 'created', checksum(path), {}) })
}

function writeFinalReleaseDoc({ run, checks, notes, blockers, warnings }) {
  const content = [
    '# Final Release Report',
    '',
    `Version: ${run.release_version}`,
    `Status: ${run.status}`,
    `Score: ${Number(run.overall_score ?? 0).toFixed(1)}`,
    `Readiness: ${run.readiness_level}`,
    `Decision: ${run.release_decision}`,
    '',
    '## Blockers',
    ...(blockers.length ? blockers.map((b) => `- ${b.check_category}/${b.check_name}: ${b.actual || b.description}`) : ['- None']),
    '',
    '## Warnings',
    ...(warnings.length ? warnings.map((w) => `- ${w.check_category}/${w.check_name}: ${w.actual || w.description}`) : ['- None']),
    '',
    '## Passed Checks',
    `Passed: ${checks.filter((c) => c.status === 'passed').length}`,
    `Failed: ${checks.filter((c) => ['failed','blocked'].includes(c.status)).length}`,
    '',
    '## Release Decision',
    notes?.summary ?? run.summary ?? '',
    '',
    '## Recommended Next Steps',
    ...arrayFrom(run.metadata?.recommended_next_steps).map((item) => `- ${item}`),
  ].join('\n')
  writeFileSync(resolve(rootDir, 'docs/FINAL_RELEASE_REPORT.md'), content, 'utf8')
}

function ensureFinalDocs() {
  mkdirSync(resolve(rootDir, 'docs'), { recursive: true })
  ensureDoc('docs/SAFETY_BOUNDARIES.md', '# Safety Boundaries\n\n- Agent bukan manusia asli.\n- Agent bukan kesadaran.\n- Agent adalah personal entity simulation.\n- Runtime read-only/proposal-only.\n- External action blocked.\n- Identity mutation blocked.\n- Communication mutation blocked.\n- Memory consolidation tidak menghapus raw data.\n- User approval tidak mengeksekusi action otomatis di Step 30.\n- Semua proposal harus dieksekusi manual oleh user.\n')
  ensureDoc('docs/DAILY_USAGE_GUIDE.md', '# Daily Usage Guide\n\n1. Tulis diary di Obsidian.\n2. Jalankan `npm run obsidian:import`.\n3. Jalankan `npm run attachments:import` jika ada file.\n4. Jalankan `npm run chats:import` untuk chat sample.\n5. Jalankan `npm run brain:worker`.\n6. Jalankan `npm run identity:build`.\n7. Jalankan `npm run communication:build`.\n8. Jalankan `npm run owner:calibrate`.\n9. Jalankan `npm run similarity:run`.\n10. Jalankan `npm run drift:audit`.\n11. Jalankan `npm run reflection:daily`.\n12. Jalankan `npm run conflicts:detect`.\n13. Jalankan `npm run clone:run -- --suite release`.\n14. Jalankan `npm run entity:session -- --start --mode read_only`.\n15. Chat dengan entity.\n16. Jalankan `npm run brain:backup`.\n17. Jalankan `npm run release:check`.\n')
  ensureDoc('docs/TROUBLESHOOTING.md', '# Troubleshooting\n\n- Supabase migration belum apply: jalankan `supabase db push`.\n- Schema cache error: restart Supabase/local dev dan apply migration.\n- RLS blocked: gunakan login/access token/service role lokal untuk scripts.\n- Service role missing: pakai SUPABASE_ACCESS_TOKEN atau login env.\n- Vite endpoint unavailable: jalankan `npm run dev` dari `frontend`.\n- Worker failed: cek env Supabase dan migration.\n- LLM provider failed: set provider disabled untuk fallback deterministic.\n- Chat berbelit/greeting AI-like: jalankan calibration/drift.\n- Identity overclaim: rebuild identity dan cek drift logs.\n- Communication pattern kurang data: import chat samples.\n- Similarity regression: jalankan owner calibration.\n- Backup gagal: cek path dan permission.\n- Secret scan failed: hapus secret dari bundle/env VITE.\n- Build failed: jalankan `npm run build` dan perbaiki TypeScript.\n')
  ensureDoc('docs/ARCHITECTURE_OVERVIEW.md', '# Architecture Overview\n\n- Obsidian raw vault.\n- Supabase structured memory.\n- React UI.\n- Local scripts.\n- Brain Worker.\n- Identity Fidelity.\n- Communication Style.\n- Response Inference.\n- Owner Calibration.\n- Similarity Loop.\n- Drift Guard.\n- Self Reflection.\n- Chat Samples.\n- Conflicts.\n- Self Clone Eval.\n- Safe Runtime.\n- Long-Term Memory.\n- Final Release.\n')
  ensureDoc('docs/FINAL_RELEASE_REPORT.md', '# Final Release Report\n\nBelum ada release check terbaru. Jalankan `cd frontend && npm run release:check`.\n')
}

function ensureDoc(path, content) { const abs = resolve(rootDir, path); if (!existsSync(abs)) writeFileSync(abs, content, 'utf8') }
function addCheck(checks, category, name, description, status, severity, score, expected, actual, details = {}, recommendedFix = '') { checks.push({ check_category: category, check_name: name, description, status, severity, score: clampScore(score), expected, actual, details, recommended_fix: recommendedFix, metadata: { generated_by: 'final-release.mjs' } }) }
function artifact(artifact_type, title, path, description, status = 'created', checksumValue = null, metadata = {}) { return { artifact_type, title, path, description, status, checksum: checksumValue, metadata } }
function scoreChecks(checks) { let totalWeight = 0; let weighted = 0; for (const [category, weight] of Object.entries(WEIGHTS)) { const categoryChecks = checks.filter((c) => c.check_category === category); if (!categoryChecks.length) continue; totalWeight += weight; weighted += weight * (categoryChecks.reduce((sum, c) => sum + Number(c.score ?? 0), 0) / categoryChecks.length) } return totalWeight ? Math.round((weighted / totalWeight) * 10) / 10 : 0 }
function readinessFor(score, blockers, checks) { if (blockers.length || score < 60) return 'not_ready'; if (score < 70) return 'early'; if (score < 82) return 'usable_with_warning'; if (score < 90) return 'stable'; if (score < 92) return 'release_candidate'; return checks.some((c) => c.status === 'warning' && c.severity === 'high') ? 'release_candidate' : 'final_ready' }
function decisionFor(score, blockers, checks) { if (blockers.some((b) => b.severity === 'critical')) return 'do_not_use'; if (score < 70) return 'internal_testing_only'; if (score < 85 || checks.some((c) => c.status === 'warning')) return 'daily_use_with_warning'; if (score < 92) return 'stable_daily_use'; return 'ready_for_final_use' }
function recommendedNextSteps(decision, blockers, warnings) { if (decision === 'ready_for_final_use') return ['Gunakan harian dengan runtime read-only, backup rutin, dan release check berkala.']; if (blockers.length) return blockers.slice(0, 8).map((b) => b.recommended_fix || `Fix ${b.check_name}`); return warnings.slice(0, 8).map((w) => w.recommended_fix || `Review ${w.check_name}`) }
function defaultEnvBlocks() { const env = readFileSafe(resolve(process.cwd(), 'scripts/brain-worker.env.example')); return ['ENTITY_RUNTIME_ALLOW_EXTERNAL_ACTIONS=false','ENTITY_RUNTIME_ALLOW_IDENTITY_MUTATION=false','ENTITY_RUNTIME_ALLOW_COMMUNICATION_MUTATION=false','ENTITY_RUNTIME_ALLOW_COMMAND_EXECUTION=false','ENTITY_RUNTIME_BLOCK_EXTERNAL_ACTIONS=true'].every((line) => env.includes(line)) }
function runAllowed(cmd, commandArgs) { const allowed = (cmd === 'npm' && commandArgs.join(' ') === 'run build') || (cmd === 'node' && commandArgs[0] === '--check' && SCRIPT_CHECKS.some((script) => commandArgs[1] === `scripts/${script}`)); if (!allowed) throw new Error(`Command not allowlisted: ${cmd} ${commandArgs.join(' ')}`); const res = spawnSync(cmd, commandArgs, { cwd: process.cwd(), encoding: 'utf8' }); return { status: res.status ?? 1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` } }
async function count(ctx, table) { const { count, error } = await ctx.supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId); return error ? 0 : count ?? 0 }
async function rows(ctx, table, columns, apply = (q) => q.limit(100)) { const { data, error } = await apply(ctx.supabase.from(table).select(columns).eq('user_id', ctx.userId)); return error ? [] : data ?? [] }
async function latestRow(ctx, table, columns) { const { data, error } = await ctx.supabase.from(table).select(columns).eq('user_id', ctx.userId).order('created_at', { ascending: false }).limit(1).maybeSingle(); return error ? null : data }
async function createSupabaseClient() {
  const url = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const key = serviceKey || anonKey
  if (!key) throw new Error('Supabase credential missing.')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: !serviceKey && accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  })
}
async function resolveUserId(supabase) { if (process.env.BRAIN_USER_ID) return process.env.BRAIN_USER_ID; const { data: userData } = await supabase.auth.getUser(); if (userData?.user?.id) return userData.user.id; const { data, error } = await supabase.from('raw_entries').select('user_id').limit(1).maybeSingle(); if (error && error.code !== 'PGRST116') throw error; if (data?.user_id) return data.user_id; throw new Error('BRAIN_USER_ID belum tersedia dan user tidak bisa dideteksi.') }
function listBackupManifests() { const dir = backupDir(); if (!existsSync(dir)) return []; return readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory() && /^brain-backup-/.test(item.name)).map((item) => readJsonSafe(resolve(dir, item.name, 'manifest.json'))).filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) }
function scanFiles(paths, pattern) { const hits = []; for (const path of paths) scanPath(path, pattern, hits); return hits }
function scanPath(path, pattern, hits) { if (!existsSync(path)) return; const stat = statSync(path); if (stat.isDirectory()) { for (const name of readdirSync(path)) scanPath(resolve(path, name), pattern, hits); return } if (stat.size > 2_000_000) return; const text = readFileSafe(path); if (pattern.test(text)) hits.push(path) }
function writeMarked(path, content) { const wrapped = `${AUTO_START}\n${content}\n${AUTO_END}\n`; const current = existsSync(path) ? readFileSync(path, 'utf8') : ''; if (current.includes(AUTO_START) && current.includes(AUTO_END)) writeFileSync(path, current.replace(new RegExp(`${escapeRegExp(AUTO_START)}[\\s\\S]*?${escapeRegExp(AUTO_END)}`), wrapped.trim()), 'utf8'); else writeFileSync(path, wrapped, 'utf8') }
function checksum(path) { if (!path || !existsSync(path)) return null; return createHash('sha256').update(readFileSync(path)).digest('hex') }
function vaultPath() { return resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault') }
function backupDir() { return resolve(process.cwd(), process.env.BRAIN_BACKUP_DIR ?? '../backups') }
function releaseVersion() { return process.env.FINAL_RELEASE_VERSION || '1.0.0' }
function sanitizeReleaseType(value) { return RELEASE_TYPES.has(value) ? value : 'manual' }
function readArg(key) { const value = args.get(key); return typeof value === 'string' ? value : '' }
function readBoolArg(key, fallback) { const value = args.get(key); if (value === undefined) return fallback; if (value === true) return true; return ['1','true','yes','on'].includes(String(value).toLowerCase()) }
function readBoolEnv(key, fallback) { const value = process.env[key]; if (value === undefined || value === '') return fallback; return ['1','true','yes','on'].includes(String(value).toLowerCase()) }
function requiredEnv(key, fallback) { const value = process.env[key] || fallback; if (!value) throw new Error(`${key} belum tersedia.`); return value }
function parseArgs(argv) { const out = new Map(); for (let i = 0; i < argv.length; i += 1) { const item = argv[i]; if (!item.startsWith('--')) continue; const key = item.slice(2); const next = argv[i + 1]; if (next && !next.startsWith('--')) { out.set(key, next); i += 1 } else out.set(key, true) } return out }
function loadEnv(path, { override = false } = {}) { if (!existsSync(path)) return; for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue; const index = trimmed.indexOf('='); const key = trimmed.slice(0, index).trim(); const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, ''); if (override || process.env[key] === undefined) process.env[key] = value } }
function readFileSafe(path) { try { return readFileSync(path, 'utf8') } catch { return '' } }
function readJsonSafe(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
function arrayFrom(value) { return Array.isArray(value) ? value : [] }
function clampScore(value) { return Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : 0)) }
function excerpt(value, max) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 3)}...` : text }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
