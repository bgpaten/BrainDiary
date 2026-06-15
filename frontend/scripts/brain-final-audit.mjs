import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const MAIN_TABLES = [
  'raw_entries',
  'brain_nodes',
  'brain_edges',
  'brain_clusters',
  'brain_files',
  'extraction_jobs',
  'agent_memories',
  'brain_reports',
  'brain_eval_runs',
  'brain_routine_runs',
  'brain_health_checks',
]
const MODE_FILES = [
  'src/components/BrainVisualizer.tsx',
  'src/components/BrainQualityReview.tsx',
  'src/components/BrainChat.tsx',
  'src/components/BrainTimeline.tsx',
  'src/components/BrainDigest.tsx',
  'src/components/BrainEvaluation.tsx',
  'src/components/BrainRoutine.tsx',
  'src/components/BrainBackup.tsx',
]
const SCRIPT_CHECKS = [
  'brain-worker.mjs',
  'obsidian-importer.mjs',
  'attachment-importer.mjs',
  'brain-quality.mjs',
  'brain-chat.mjs',
  'brain-indexer.mjs',
  'obsidian-sync.mjs',
  'brain-digest.mjs',
  'brain-eval.mjs',
  'daily-brain-routine.mjs',
  'brain-backup.mjs',
  'brain-final-audit.mjs',
]
const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{20,}|sha256:[a-f0-9]{16,}|(?:SUPABASE_SERVICE_ROLE_KEY|EMBEDDING_API_KEY|BRAIN_CHAT_API_KEY|BRAIN_EVAL_API_KEY|ANTHROPIC_API_KEY|LLM_API_KEY)=\S+)/

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const argv = new Set(process.argv.slice(2))
const releaseCheck = argv.has('--release-check')
const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const backupDir = resolve(process.cwd(), process.env.BRAIN_BACKUP_DIR ?? '../backups')
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''

const result = await runAudit({ releaseCheck })
console.log(JSON.stringify(result))
if (result.status === 'blocked') process.exitCode = 2

async function runAudit({ releaseCheck }) {
  const blockers = []
  const warnings = []
  const recommended = []
  const metrics = {}

  auditEnvironment(blockers, warnings)
  auditObsidian(blockers, warnings)
  auditFrontendFiles(blockers, warnings)
  auditBackups(warnings, metrics)

  const supabase = await tryCreateSupabase(warnings)
  if (supabase) await auditSupabase(supabase, blockers, warnings, metrics)

  if (releaseCheck) {
    runSyntaxChecks(blockers)
    runBuildAndSecretScan(blockers, warnings)
  }

  if (warnings.some((item) => item.includes('eval'))) recommended.push('Buka Evaluation View dan cek failed cases sebelum memakai Brain Chat untuk keputusan penting.')
  if (warnings.some((item) => item.includes('routine'))) recommended.push('Jalankan Daily Routine ulang setelah migration dan recovery cleanup selesai.')
  if (warnings.some((item) => item.includes('backup'))) recommended.push('Buat backup terbaru sebelum penggunaan harian.')
  if (blockers.length) recommended.push('Selesaikan blockers sebelum menandai release ready.')
  if (!recommended.length) recommended.push('Sistem siap dipakai harian dengan backup rutin dan review berkala.')

  const score = Math.max(0, Math.min(100, 100 - blockers.length * 18 - warnings.length * 4))
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked' : warnings.length ? 'warning' : 'ready',
    score,
    blockers,
    warnings,
    metrics,
    recommended_next_steps: recommended,
    release_check: releaseCheck,
    created_at: new Date().toISOString(),
  }
}

function auditEnvironment(blockers, warnings) {
  if (!existsSync(resolve(process.cwd(), '.env.example'))) blockers.push('frontend/.env.example tidak ditemukan.')
  if (!existsSync(resolve(process.cwd(), 'scripts/brain-worker.env.example'))) blockers.push('brain-worker.env.example tidak ditemukan.')
  const envExample = readFileSafe(resolve(process.cwd(), '.env.example'))
  for (const key of ['VITE_BRAIN_ROUTINE_ENABLED', 'VITE_BRAIN_BACKUP_ENABLED', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
    if (!envExample.includes(key)) warnings.push(`.env.example belum memuat ${key}.`)
  }
  if (scanFiles([resolve(process.cwd(), 'src')], SECRET_RE).length) blockers.push('Secret-like pattern ditemukan di frontend/src.')
}

function auditObsidian(blockers, warnings) {
  if (!existsSync(vaultPath)) {
    blockers.push(`Obsidian vault tidak ditemukan: ${vaultPath}`)
    return
  }
  for (const dir of ['00_Diary', '80_Attachments', '_system']) {
    if (!existsSync(resolve(vaultPath, dir))) warnings.push(`Folder vault belum ada: ${dir}`)
  }
  if (!existsSync(resolve(vaultPath, '_system/backups/Latest Backup.md'))) warnings.push('Latest Backup.md belum ada.')
  if (!existsSync(resolve(vaultPath, '_system/routine/Daily Brain Routine Latest.md'))) warnings.push('Latest routine report belum ada.')
  if (!existsSync(resolve(vaultPath, '_system/evaluations/Latest Brain Evaluation.md'))) warnings.push('Latest evaluation report belum ada.')
  if (!existsSync(resolve(vaultPath, '_system/persona/Persona Profile.md'))) warnings.push('Persona profile belum ada.')
  if (!existsSync(resolve(vaultPath, '_system/reports'))) warnings.push('Reports folder belum ada.')
}

function auditFrontendFiles(blockers) {
  for (const file of MODE_FILES) {
    if (!existsSync(resolve(process.cwd(), file))) blockers.push(`Mode file hilang: ${file}`)
  }
}

function auditBackups(warnings, metrics) {
  const backups = listBackupManifests()
  metrics.latest_backup_id = backups[0]?.backup_id ?? null
  metrics.latest_backup_age_days = backups[0] ? Math.round((Date.now() - new Date(backups[0].created_at).getTime()) / 86400000) : null
  if (!backups.length) warnings.push('backup terbaru belum ada.')
  if (backups[0] && scanFiles([resolve(backupDir, backups[0].backup_id)], SECRET_RE).length) warnings.push('secret-like pattern ditemukan di backup terbaru; periksa config snapshot/log.')
}

async function auditSupabase(supabase, blockers, warnings, metrics) {
  const userId = await resolveUserId(supabase).catch((err) => {
    blockers.push(`Tidak bisa resolve user_id: ${err.message}`)
    return null
  })
  if (!userId) return
  for (const table of MAIN_TABLES) {
    const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId)
    if (error) {
      warnings.push(`Table ${table} missing/schema warning: ${error.message}`)
    } else {
      metrics[`${table}_count`] = count ?? 0
    }
  }
  metrics.failed_raw_entries = await countWhere(supabase, 'raw_entries', userId, (query) => query.eq('processing_status', 'failed'))
  metrics.low_confidence_nodes = await countWhere(supabase, 'brain_nodes', userId, (query) => query.lt('confidence_score', 0.7))
  metrics.low_confidence_edges = await countWhere(supabase, 'brain_edges', userId, (query) => query.lt('confidence_score', 0.7))
  const latestEval = await readLatest(supabase, 'brain_eval_runs', userId, 'average_score,hallucination_risk,status,created_at')
  const latestRoutine = await readLatest(supabase, 'brain_routine_runs', userId, 'status,created_at')
  metrics.latest_eval_score = latestEval?.average_score ?? null
  metrics.latest_hallucination_risk = latestEval?.hallucination_risk ?? null
  metrics.latest_routine_status = latestRoutine?.status ?? null
  if (Number(metrics.latest_eval_score ?? 1) < 0.7) warnings.push(`latest eval score rendah: ${metrics.latest_eval_score}`)
  if (latestRoutine && latestRoutine.status !== 'done') warnings.push(`latest routine status ${latestRoutine.status}.`)
}

function runSyntaxChecks(blockers) {
  for (const script of SCRIPT_CHECKS) {
    const result = spawnSync('node', ['--check', `scripts/${script}`], { cwd: process.cwd(), encoding: 'utf8' })
    if (result.status !== 0) blockers.push(`Syntax check gagal: ${script}\n${result.stderr || result.stdout}`)
  }
}

function runBuildAndSecretScan(blockers, warnings) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: process.cwd(), encoding: 'utf8' })
  if (build.status !== 0) blockers.push(`npm run build gagal:\n${build.stderr || build.stdout}`)
  if (existsSync(resolve(process.cwd(), 'dist')) && scanFiles([resolve(process.cwd(), 'dist')], SECRET_RE).length) blockers.push('Secret-like pattern ditemukan di dist bundle.')
  if (build.stdout.includes('Some chunks are larger')) warnings.push('Large chunk warning masih ada; Graph/Cytoscape sudah lazy-loaded dan chunk besar didokumentasikan.')
}

async function tryCreateSupabase(warnings) {
  try {
    if (!supabaseUrl) throw new Error('SUPABASE_URL missing')
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ACCESS_TOKEN || process.env.VITE_SUPABASE_ANON_KEY
    if (!key) throw new Error('Supabase credential missing')
    return createClient(supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } })
  } catch (err) {
    warnings.push(`Supabase audit skipped: ${err.message}`)
    return null
  }
}

async function resolveUserId(supabase) {
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  if (process.env.SUPABASE_USER_ID) return process.env.SUPABASE_USER_ID
  const { data } = await supabase.auth.getUser()
  if (data?.user?.id) return data.user.id
  const { data: row, error } = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  if (row?.user_id) return row.user_id
  throw new Error('user_id not found')
}

async function countWhere(supabase, table, userId, apply) {
  const { count, error } = await apply(supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId))
  return error ? null : count ?? 0
}

async function readLatest(supabase, table, userId, columns) {
  const { data, error } = await supabase.from(table).select(columns).eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return error ? null : data
}

function listBackupManifests() {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^brain-backup-/.test(item.name))
    .map((item) => readJsonSafe(resolve(backupDir, item.name, 'manifest.json')))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

function scanFiles(paths, pattern) {
  const hits = []
  for (const item of paths) {
    if (!existsSync(item)) continue
    const stat = statSync(item)
    if (stat.isDirectory()) {
      for (const child of readdirSync(item)) {
        if (['node_modules', '.git'].includes(child)) continue
        hits.push(...scanFiles([resolve(item, child)], pattern))
      }
    } else if (stat.isFile() && stat.size < 2_000_000 && pattern.test(readFileSafe(item))) {
      hits.push(item)
    }
  }
  return hits
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function loadEnv(file, options = {}) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (!options.override && process.env[key]) continue
    process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '')
  }
}
