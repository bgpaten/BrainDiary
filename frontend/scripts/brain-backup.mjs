import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const AUTO_START = '<!-- BRAIN_BACKUP_AUTO_START -->'
const AUTO_END = '<!-- BRAIN_BACKUP_AUTO_END -->'
const BACKUP_VERSION = '1.0'
const APP_NAME = 'Personal Brain OS'
const BACKUP_ID_RE = /^brain-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/
const SUPABASE_TABLES = [
  'raw_entries',
  'brain_nodes',
  'brain_edges',
  'brain_clusters',
  'brain_files',
  'extraction_jobs',
  'agent_memories',
  'brain_reports',
  'brain_eval_cases',
  'brain_eval_runs',
  'brain_eval_results',
  'brain_routine_runs',
  'brain_health_checks',
]
const RESTORE_ORDER = [
  'brain_clusters',
  'raw_entries',
  'brain_nodes',
  'brain_edges',
  'brain_files',
  'extraction_jobs',
  'agent_memories',
  'brain_reports',
  'brain_eval_cases',
  'brain_eval_runs',
  'brain_eval_results',
  'brain_routine_runs',
  'brain_health_checks',
]
const SECRET_KEY_RE = /(?:KEY|SERVICE_ROLE|TOKEN|SECRET|PASSWORD|ANTHROPIC|OPENAI|GEMINI|LLM|SUPABASE_ACCESS)/i

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const argv = parseArgs(process.argv.slice(2))
const action = argv.has('list') ? 'list'
  : argv.has('restore') ? 'restore'
    : argv.has('restore-preview') ? 'restore-preview'
      : argv.has('recovery') ? 'recovery'
        : 'backup'
const selectedTables = readTablesArg(argv.get('tables'))
const includeVault = !argv.has('no-vault') && readBoolEnv('BRAIN_BACKUP_INCLUDE_VAULT', true)
const includeEnv = readBoolArg('include-env', readBoolEnv('BRAIN_BACKUP_INCLUDE_ENV', false))
const compress = readBoolArg('compress', readBoolEnv('BRAIN_BACKUP_COMPRESS', false))
const backupDir = resolve(process.cwd(), process.env.BRAIN_BACKUP_DIR ?? '../backups')
const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const restoreConfirm = argv.has('confirm')
const restoreMode = argv.get('mode') ?? 'upsert'
const recoveryFix = argv.has('fix')

const result = action === 'list'
  ? listBackups()
  : action === 'restore-preview'
    ? await previewRestore(readBackupPath())
    : action === 'restore'
      ? await restoreBackup(readBackupPath(), { confirm: restoreConfirm, mode: restoreMode })
      : action === 'recovery'
        ? await recoveryCheck({ fix: recoveryFix })
        : await createBackup()
console.log(JSON.stringify(result))

async function createBackup() {
  const started = Date.now()
  const backupId = `brain-backup-${formatBackupDate(new Date())}`
  const targetDir = safeBackupPath(backupId)
  const supabaseDir = resolve(targetDir, 'supabase')
  const vaultDir = resolve(targetDir, 'obsidian-vault')
  const configDir = resolve(targetDir, 'config')
  const logsDir = resolve(targetDir, 'logs')
  mkdirSync(supabaseDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(logsDir, { recursive: true })

  const warnings = []
  const errors = []
  if (compress) warnings.push('BRAIN_BACKUP_COMPRESS belum diimplementasikan; backup dibuat sebagai folder plain JSON.')

  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const tableRowCounts = {}
  const includedTables = []
  const missingTables = []

  for (const table of selectedTables) {
    try {
      const rows = await readAllRows(supabase, table, userId)
      writeJson(resolve(supabaseDir, `${table}.json`), rows)
      tableRowCounts[table] = rows.length
      includedTables.push(table)
      console.log(`[brain-backup] table=${table} rows=${rows.length}`)
    } catch (err) {
      const message = errorMessage(err)
      missingTables.push(table)
      warnings.push(`Table ${table} tidak dibackup: ${message}`)
      writeJson(resolve(supabaseDir, `${table}.json`), [])
    }
  }

  let obsidianFileCount = 0
  if (includeVault) {
    if (existsSync(vaultPath)) {
      obsidianFileCount = copyDirectory(vaultPath, resolve(vaultDir, basename(vaultPath)), {
        exclude: shouldExcludeVaultPath,
      })
    } else {
      warnings.push(`Obsidian vault tidak ditemukan: ${vaultPath}`)
    }
  }

  writeJson(resolve(configDir, 'env-example-snapshot.json'), buildEnvSnapshot())
  writeJson(resolve(configDir, 'package-scripts.json'), readPackageScripts())

  const manifestBase = {
    backup_id: backupId,
    created_at: new Date().toISOString(),
    app_name: APP_NAME,
    backup_version: BACKUP_VERSION,
    user_id: userId,
    included_tables: includedTables,
    table_row_counts: tableRowCounts,
    missing_tables: missingTables,
    obsidian_vault_included: includeVault && obsidianFileCount > 0,
    obsidian_file_count: obsidianFileCount,
    total_size_bytes: 0,
    checksum: null,
    warnings,
    errors,
    restore_notes: [
      'Restore MVP hanya upsert Supabase JSON dan tidak menghapus data existing.',
      'Restore Obsidian Vault belum otomatis destructive; lakukan manual dari folder obsidian-vault setelah membuat backup terbaru.',
      'Restore dari UI/endpoint membutuhkan confirm=true.',
    ],
    duration_ms: Date.now() - started,
  }
  writeJson(resolve(targetDir, 'manifest.json'), manifestBase)
  const totalSize = directorySize(targetDir)
  const checksum = checksumDirectory(targetDir, ['manifest.json'])
  const manifest = { ...manifestBase, total_size_bytes: totalSize, checksum }
  writeJson(resolve(targetDir, 'manifest.json'), manifest)
  const markdown = renderBackupLog(manifest)
  writeFileSync(resolve(logsDir, 'backup-log.md'), markdown, 'utf8')
  writeObsidianBackupSummary(manifest, markdown)
  enforceMaxHistory()
  return { ok: true, status: warnings.length ? 'warning' : 'done', backup_id: backupId, backup_path: targetDir, manifest }
}

function listBackups() {
  mkdirSync(backupDir, { recursive: true })
  const backups = readdirSync(backupDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && BACKUP_ID_RE.test(item.name))
    .map((item) => {
      const dir = resolve(backupDir, item.name)
      const manifest = readJsonSafe(resolve(dir, 'manifest.json'))
      if (!manifest) return null
      return {
        backup_id: item.name,
        path: dir,
        created_at: manifest?.created_at ?? null,
        table_row_counts: manifest?.table_row_counts ?? {},
        obsidian_file_count: manifest?.obsidian_file_count ?? 0,
        warnings: manifest?.warnings ?? [],
        errors: manifest?.errors ?? [],
        total_size_bytes: manifest?.total_size_bytes ?? directorySize(dir),
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created_at ?? b.backup_id).localeCompare(String(a.created_at ?? a.backup_id)))
  return { ok: true, backups }
}

async function previewRestore(backupPath) {
  const backup = readBackup(backupPath)
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const warnings = [...backup.manifest.warnings ?? []]
  const errors = []
  if (backup.manifest.backup_version !== BACKUP_VERSION) warnings.push(`Backup version ${backup.manifest.backup_version} berbeda dari script ${BACKUP_VERSION}.`)
  if (backup.manifest.user_id && backup.manifest.user_id !== userId) errors.push(`Backup user_id ${backup.manifest.user_id} berbeda dari active user ${userId}.`)
  const tables = {}
  for (const table of RESTORE_ORDER) {
    const rows = readJsonSafe(resolve(backup.path, 'supabase', `${table}.json`))
    if (!Array.isArray(rows)) continue
    const currentCount = await countRowsSafe(supabase, table, userId)
    tables[table] = {
      backup_rows: rows.length,
      current_rows: currentCount,
      action: currentCount === null ? 'skip_missing_table' : rows.length ? 'upsert' : 'skip_empty',
    }
  }
  return {
    ok: errors.length === 0,
    status: errors.length ? 'critical' : warnings.length ? 'warning' : 'ready',
    backup_id: backup.manifest.backup_id,
    backup_path: backup.path,
    manifest: backup.manifest,
    tables,
    warnings,
    errors,
    restore_notes: backup.manifest.restore_notes ?? [],
  }
}

async function restoreBackup(backupPath, { confirm, mode }) {
  if (!confirm) throw new Error('Restore ditolak. Jalankan dengan --confirm untuk restore.')
  if (mode !== 'upsert') throw new Error('Restore MVP hanya mendukung mode=upsert.')
  const preview = await previewRestore(backupPath)
  if (!preview.ok) throw new Error(`Restore preview critical: ${preview.errors.join('; ')}`)
  const supabase = await createSupabaseClient()
  const warnings = [...preview.warnings]
  const errors = []
  const restored = {}
  for (const table of RESTORE_ORDER) {
    const info = preview.tables[table]
    if (!info || info.action !== 'upsert') {
      if (info?.action === 'skip_missing_table') warnings.push(`Restore skip ${table}: table tidak tersedia.`)
      continue
    }
    const rows = readJsonSafe(resolve(preview.backup_path, 'supabase', `${table}.json`))
    if (!Array.isArray(rows) || rows.length === 0) continue
    try {
      const count = await upsertRows(supabase, table, rows)
      restored[table] = count
    } catch (err) {
      const message = errorMessage(err)
      errors.push(`${table}: ${message}`)
    }
  }
  const status = errors.length ? 'partial' : 'done'
  const result = {
    ok: errors.length === 0,
    status,
    backup_id: preview.backup_id,
    restored,
    warnings,
    errors,
    restore_notes: [
      'Restore Supabase memakai upsert dan tidak menghapus data existing.',
      'Restore Obsidian Vault tidak dilakukan otomatis di MVP.',
    ],
    restored_at: new Date().toISOString(),
  }
  writeRestoreLog(result)
  return result
}

async function recoveryCheck({ fix = false } = {}) {
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const issues = []
  const fixes = []
  const recommendedFixes = []
  const [nodes, edges, rawEntries, jobs, files, reports, latestEval, latestRoutine] = await Promise.all([
    readMaybeRows(supabase, 'brain_nodes', userId, 'id,name,canonical_name,type,aliases,metadata,embedding,updated_at', 1000),
    readMaybeRows(supabase, 'brain_edges', userId, 'id,from_node_id,to_node_id,relation_type,summary,embedding,updated_at', 1000),
    readMaybeRows(supabase, 'raw_entries', userId, 'id,title,processing_status,metadata,embedding,created_at', 1000),
    readMaybeRows(supabase, 'extraction_jobs', userId, 'id,status,error_message,raw_entry_id,created_at', 500),
    readMaybeRows(supabase, 'brain_files', userId, 'id,raw_entry_id,file_name,created_at', 500),
    readMaybeRows(supabase, 'brain_reports', userId, 'id,title,summary,content,report_type,created_at', 100),
    readLatest(supabase, 'brain_eval_runs', userId, 'id,status,average_score,hallucination_risk,created_at'),
    readLatest(supabase, 'brain_routine_runs', userId, 'id,status,created_at'),
  ])
  const nodeIds = new Set(nodes.rows.map((node) => node.id))
  const badCanonical = nodes.rows.filter((node) => !String(node.canonical_name ?? '').trim())
  if (badCanonical.length) issues.push(issue('warning', 'nodes_missing_canonical_name', `${badCanonical.length} nodes tanpa canonical_name.`, badCanonical.length))
  const danglingEdges = edges.rows.filter((edge) => !nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id))
  if (danglingEdges.length) issues.push(issue('critical', 'dangling_edges', `${danglingEdges.length} edges menunjuk node yang hilang.`, danglingEdges.length))
  const duplicates = estimateDuplicateNodes(nodes.rows)
  if (duplicates.length) issues.push(issue('warning', 'duplicate_node_candidates', `${duplicates.length} duplicate node candidates.`, duplicates.length))
  const failedRaw = rawEntries.rows.filter((row) => row.processing_status === 'failed')
  if (failedRaw.length) issues.push(issue('warning', 'failed_raw_entries', `${failedRaw.length} raw entries failed.`, failedRaw.length))
  const failedJobs = jobs.rows.filter((row) => row.status === 'failed')
  if (failedJobs.length) issues.push(issue('warning', 'failed_extraction_jobs', `${failedJobs.length} extraction jobs failed.`, failedJobs.length))
  const orphanFiles = files.rows.filter((file) => !file.raw_entry_id)
  if (orphanFiles.length) issues.push(issue('warning', 'brain_files_without_raw_entry', `${orphanFiles.length} brain files tanpa raw_entry_id.`, orphanFiles.length))
  const emptyReports = reports.rows.filter((report) => !String(report.summary ?? report.content ?? '').trim())
  if (emptyReports.length) issues.push(issue('warning', 'empty_reports', `${emptyReports.length} reports kosong.`, emptyReports.length))
  if (latestEval.row && Number(latestEval.row.average_score ?? 1) < 0.7) issues.push(issue('warning', 'latest_eval_low', `Latest eval score ${Number(latestEval.row.average_score).toFixed(2)} rendah.`, 1))
  if (latestRoutine.row && ['partial', 'failed'].includes(latestRoutine.row.status)) issues.push(issue('warning', 'latest_routine_not_done', `Latest routine status ${latestRoutine.row.status}.`, 1))
  const obsidianIssues = checkObsidianReferences(nodes.rows, nodeIds, new Set(rawEntries.rows.map((row) => row.id)), { fix, fixes })
  issues.push(...obsidianIssues)
  const missingEmbedding = [...nodes.rows, ...edges.rows, ...rawEntries.rows].filter((item) => item.embedding === null || item.embedding === undefined)
  if (missingEmbedding.length) issues.push(issue('warning', 'embedding_missing', `${missingEmbedding.length} important-ish items tanpa embedding.`, missingEmbedding.length))
  const personaStale = checkPersonaStale()
  if (personaStale) issues.push(issue('warning', 'persona_profile_stale', personaStale, 1))
  const digestToday = reports.rows.some((report) => report.report_type === 'daily' && isToday(report.created_at))
  if (!digestToday) issues.push(issue('warning', 'daily_digest_missing_today', 'Daily digest hari ini belum ada.', 1))
  const latestBackup = listBackups().backups[0]
  if (!latestBackup || backupAgeDays(latestBackup.created_at) > 7) issues.push(issue('warning', 'backup_stale', 'Backup terakhir belum ada atau lebih dari 7 hari.', 1))

  if (issues.some((item) => item.code.includes('duplicate') || item.code.includes('canonical') || item.code.includes('dangling'))) recommendedFixes.push('Buka Review View dan cek node/edge yang perlu diperbaiki.')
  if (issues.some((item) => item.code.includes('failed_raw') || item.code.includes('failed_extraction'))) recommendedFixes.push('Retry failed raw entries dari Review View atau jalankan brain worker.')
  if (issues.some((item) => item.code.includes('obsidian'))) recommendedFixes.push('Periksa frontmatter Obsidian yang diproses dan cocokkan brain_node_id/raw_entry_id dengan Supabase.')
  if (issues.some((item) => item.code.includes('eval'))) recommendedFixes.push('Buka Evaluation View dan cek failed cases.')
  if (issues.some((item) => item.code.includes('backup'))) recommendedFixes.push('Jalankan npm run brain:backup setelah data stabil.')
  if (!recommendedFixes.length) recommendedFixes.push('Tidak ada recovery action wajib.')

  const criticalCount = issues.filter((item) => item.severity === 'critical').length
  const score = Math.max(0, Math.min(100, Math.round(100 - criticalCount * 25 - (issues.length - criticalCount) * 4)))
  const status = criticalCount ? 'critical' : issues.length ? 'warning' : 'healthy'
  const result = { ok: status !== 'critical', status, score, issues, fixes, recommended_fixes: recommendedFixes, created_at: new Date().toISOString() }
  writeRecoveryLog(result)
  return result
}

async function readAllRows(supabase, table, userId) {
  const rows = []
  let from = 0
  const size = 1000
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('user_id', userId)
      .range(from, from + size - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < size) break
    from += size
  }
  return rows.map(sanitizeRowForBackup)
}

async function upsertRows(supabase, table, rows) {
  let count = 0
  const chunkSize = 250
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize).map(sanitizeRowForRestore)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'id' })
    if (error) throw error
    count += chunk.length
  }
  return count
}

async function readMaybeRows(supabase, table, userId, columns, limit) {
  const { data, error } = await supabase.from(table).select(columns).eq('user_id', userId).limit(limit)
  return { rows: error ? [] : data ?? [], error: error ? error.message : null }
}

async function readLatest(supabase, table, userId, columns) {
  const { data, error } = await supabase.from(table).select(columns).eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return { row: error ? null : data ?? null, error: error && error.code !== 'PGRST116' ? error.message : null }
}

async function countRowsSafe(supabase, table, userId) {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId)
  if (error) return null
  return count ?? 0
}

function readBackup(backupPath) {
  const path = resolveBackupPath(backupPath)
  const manifest = readJsonSafe(resolve(path, 'manifest.json'))
  if (!manifest) throw new Error(`manifest.json tidak ditemukan di ${path}`)
  if (!String(manifest.backup_id ?? '').startsWith('brain-backup-')) throw new Error('Backup manifest tidak valid.')
  return { path, manifest }
}

function readBackupPath() {
  const raw = argv.get('backup')
  if (!raw) throw new Error('Missing --backup.')
  return raw
}

function resolveBackupPath(value) {
  const raw = String(value)
  const backupId = BACKUP_ID_RE.test(raw) ? raw : basename(raw)
  if (!BACKUP_ID_RE.test(backupId)) throw new Error('Backup id/path tidak valid.')
  const full = resolve(backupDir, backupId)
  const rel = relative(backupDir, full)
  if (rel.startsWith('..') || rel.includes('..')) throw new Error('Path traversal ditolak.')
  return full
}

function safeBackupPath(backupId) {
  if (!BACKUP_ID_RE.test(backupId)) throw new Error('backup_id tidak valid.')
  const full = resolve(backupDir, backupId)
  const rel = relative(backupDir, full)
  if (rel.startsWith('..') || rel.includes('..')) throw new Error('Path traversal ditolak.')
  mkdirSync(full, { recursive: true })
  return full
}

function copyDirectory(source, target, { exclude }) {
  let count = 0
  mkdirSync(target, { recursive: true })
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const src = resolve(source, item.name)
    const rel = relative(vaultPath, src)
    if (exclude(src, rel, item)) continue
    const dest = resolve(target, item.name)
    if (item.isDirectory()) {
      count += copyDirectory(src, dest, { exclude })
    } else if (item.isFile()) {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      count += 1
    }
  }
  return count
}

function shouldExcludeVaultPath(_full, rel, item) {
  const parts = rel.split(/[\\/]/)
  if (parts.some((part) => ['.git', '.obsidian-cache', '.trash', 'node_modules', 'dist', '.DS_Store'].includes(part))) return true
  if (item.isFile() && /\.(tmp|cache|log)$/i.test(item.name)) return true
  return false
}

function buildEnvSnapshot() {
  const files = [
    resolve(process.cwd(), '.env.example'),
    resolve(process.cwd(), 'scripts/brain-worker.env.example'),
    ...(includeEnv ? [resolve(process.cwd(), '.env'), resolve(process.cwd(), 'scripts/brain-worker.env')] : []),
  ]
  return Object.fromEntries(files.filter(existsSync).map((file) => [relative(rootDir, file), parseEnvFile(file, !file.endsWith('.env.example') && !file.endsWith('brain-worker.env.example'))]))
}

function parseEnvFile(file, redact) {
  const rows = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    const value = rest.join('=').replace(/^['"]|['"]$/g, '')
    if (SECRET_KEY_RE.test(key)) continue
    rows[key] = redact ? redactValue(key, value) : redactText(value)
  }
  return rows
}

function readPackageScripts() {
  const pkg = readJsonSafe(resolve(process.cwd(), 'package.json'))
  return pkg?.scripts ?? {}
}

function sanitizeRowForBackup(row) {
  return sanitizeBackupValue(row)
}

function sanitizeRowForRestore(row) {
  return { ...row }
}

function sanitizeBackupValue(value) {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(sanitizeBackupValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SECRET_KEY_RE.test(key))
      .map(([key, item]) => [key, sanitizeBackupValue(item)]))
  }
  return value
}

function writeObsidianBackupSummary(manifest, markdown) {
  const backupSystemDir = resolve(vaultPath, '_system', 'backups')
  const logsDir = resolve(vaultPath, '_system', 'logs')
  mkdirSync(backupSystemDir, { recursive: true })
  mkdirSync(logsDir, { recursive: true })
  writeFileSync(resolve(backupSystemDir, 'Latest Backup.md'), markdown, 'utf8')
  writeFileSync(resolve(logsDir, `brain-backup-${manifest.created_at.slice(0, 10)}.md`), markdown, 'utf8')
}

function writeRestoreLog(result) {
  const logsDir = resolve(vaultPath, '_system', 'logs')
  mkdirSync(logsDir, { recursive: true })
  const content = `${AUTO_START}
# Brain Restore

- Backup: ${result.backup_id}
- Status: ${result.status}
- Restored at: ${result.restored_at}

## Restored

\`\`\`json
${JSON.stringify(result.restored, null, 2)}
\`\`\`

## Warnings

${result.warnings.length ? result.warnings.map((item) => `- ${item}`).join('\n') : '- Tidak ada warning.'}

## Errors

${result.errors.length ? result.errors.map((item) => `- ${item}`).join('\n') : '- Tidak ada error.'}

${AUTO_END}
`
  writeFileSync(resolve(logsDir, `brain-restore-${result.restored_at.slice(0, 10)}.md`), content, 'utf8')
}

function writeRecoveryLog(result) {
  const logsDir = resolve(vaultPath, '_system', 'logs')
  mkdirSync(logsDir, { recursive: true })
  const content = `${AUTO_START}
# Brain Recovery Check

- Status: ${result.status}
- Score: ${result.score}/100
- Created: ${result.created_at}

## Issues

${result.issues.length ? result.issues.map((item) => `- ${item.severity}: ${item.message}`).join('\n') : '- Tidak ada issue.'}

## Fixes Applied

${result.fixes?.length ? result.fixes.map((item) => `- ${item}`).join('\n') : '- Tidak ada fix diterapkan.'}

## Recommended Fixes

${result.recommended_fixes.map((item) => `- ${item}`).join('\n')}

${AUTO_END}
`
  writeFileSync(resolve(logsDir, `brain-recovery-${result.created_at.slice(0, 10)}.md`), content, 'utf8')
}

function renderBackupLog(manifest) {
  return `---
title: Brain Backup
backup_id: ${manifest.backup_id}
created_at: ${manifest.created_at}
---

${AUTO_START}
# Brain Backup

## Summary

- Backup ID: ${manifest.backup_id}
- Version: ${manifest.backup_version}
- User ID: ${manifest.user_id}
- Tables: ${manifest.included_tables.length}
- Vault included: ${manifest.obsidian_vault_included}
- Vault files: ${manifest.obsidian_file_count}
- Total size: ${manifest.total_size_bytes} bytes
- Checksum: ${manifest.checksum}

## Table Counts

${Object.entries(manifest.table_row_counts).map(([table, count]) => `- ${table}: ${count}`).join('\n')}

## Missing Tables

${manifest.missing_tables.length ? manifest.missing_tables.map((table) => `- ${table}`).join('\n') : '- Tidak ada.'}

## Warnings

${manifest.warnings.length ? manifest.warnings.map((item) => `- ${item}`).join('\n') : '- Tidak ada warning.'}

## Errors

${manifest.errors.length ? manifest.errors.map((item) => `- ${item}`).join('\n') : '- Tidak ada error.'}

## Restore Notes

${manifest.restore_notes.map((item) => `- ${item}`).join('\n')}

${AUTO_END}
`
}

function checkObsidianReferences(nodes, nodeIds, rawIds, { fix, fixes }) {
  const issues = []
  if (!existsSync(vaultPath)) return issues
  const nodeBySlug = new Map()
  for (const node of nodes) {
    for (const value of [node.name, node.canonical_name]) {
      const slug = normalizeName(value)
      if (!slug) continue
      const current = nodeBySlug.get(slug)
      nodeBySlug.set(slug, current ? null : node)
    }
  }
  let nodeFilesMissingId = 0
  let processedDiaryMissingRaw = 0
  for (const file of walkFiles(vaultPath, shouldExcludeVaultPath)) {
    if (!file.endsWith('.md')) continue
    const text = readFileSync(file, 'utf8')
    const rel = relative(vaultPath, file)
    const isKnowledge = /^(10_People|20_Projects|30_Events|40_Places|50_Decisions|60_Patterns|70_Goals|90_Knowledge)/.test(rel)
    if (isKnowledge && !/brain_node_id:\s*["']?[0-9a-f-]{20,}/i.test(text)) {
      const match = nodeBySlug.get(normalizeName(basename(file, '.md')))
      if (fix && match?.id) {
        writeFileSync(file, setFrontmatterField(text, 'brain_node_id', match.id), 'utf8')
        fixes.push(`Added brain_node_id to ${rel}`)
      } else {
        nodeFilesMissingId += 1
      }
    }
    const rawMatch = text.match(/raw_entry_id:\s*["']?([0-9a-f-]{20,})/i)
    if (/processed:\s*true/i.test(text) && rawMatch && !rawIds.has(rawMatch[1])) {
      if (fix && /^00_Diary\//.test(rel)) {
        const repaired = setFrontmatterFields(text, {
          processed: 'false',
          processing_status: 'needs_reimport',
          recovery_note: 'raw_entry_id not found',
        })
        writeFileSync(file, repaired, 'utf8')
        fixes.push(`Marked diary for reimport: ${rel}`)
      } else {
        processedDiaryMissingRaw += 1
      }
    }
  }
  if (nodeFilesMissingId) issues.push(issue('warning', 'obsidian_nodes_without_brain_node_id', `${nodeFilesMissingId} Obsidian knowledge files tanpa brain_node_id.`, nodeFilesMissingId))
  if (processedDiaryMissingRaw) issues.push(issue('critical', 'obsidian_diary_raw_entry_missing', `${processedDiaryMissingRaw} processed diary raw_entry_id tidak ditemukan.`, processedDiaryMissingRaw))
  return issues
}

function setFrontmatterFields(text, fields) {
  return Object.entries(fields).reduce((next, [key, value]) => setFrontmatterField(next, key, value), text)
}

function setFrontmatterField(text, key, value) {
  const raw = String(text ?? '')
  const safeValue = String(value).includes(':') ? JSON.stringify(String(value)) : String(value)
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---', 4)
    if (end > 0) {
      const frontmatter = raw.slice(4, end)
      const body = raw.slice(end)
      const line = `${key}: ${safeValue}`
      const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:.*$`, 'm')
      const nextFrontmatter = pattern.test(frontmatter)
        ? frontmatter.replace(pattern, line)
        : `${frontmatter.replace(/\s*$/, '')}\n${line}`
      return `---\n${nextFrontmatter}${body}`
    }
  }
  return `---\n${key}: ${safeValue}\n---\n\n${raw}`
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function checkPersonaStale() {
  const profile = resolve(vaultPath, '_system', 'persona', 'Persona Profile.md')
  if (!existsSync(profile)) return 'Persona profile belum ada.'
  const ageDays = (Date.now() - statSync(profile).mtimeMs) / 86400000
  if (ageDays > 7) return `Persona profile stale (${Math.floor(ageDays)} hari).`
  return null
}

function estimateDuplicateNodes(nodes) {
  const result = []
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      if (a.type !== b.type) continue
      if (normalizeName(a.name || a.canonical_name) && normalizeName(a.name || a.canonical_name) === normalizeName(b.name || b.canonical_name)) result.push([a.id, b.id])
    }
  }
  return result
}

function walkFiles(dir, exclude) {
  const files = []
  if (!existsSync(dir)) return files
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, item.name)
    const rel = relative(vaultPath, full)
    if (exclude(full, rel, item)) continue
    if (item.isDirectory()) files.push(...walkFiles(full, exclude))
    else if (item.isFile()) files.push(full)
  }
  return files
}

function enforceMaxHistory() {
  const maxHistory = readIntEnv('BRAIN_BACKUP_MAX_HISTORY', 20, 1, 200)
  const list = listBackups().backups
  if (list.length > maxHistory) {
    // MVP tidak menghapus backup otomatis. Destructive pruning butuh konfirmasi eksplisit.
  }
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
  throw new Error('Supabase credential tidak tersedia.')
}

async function resolveUserId(supabase) {
  if (process.env.BRAIN_BACKUP_USER_ID) return process.env.BRAIN_BACKUP_USER_ID
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  if (process.env.SUPABASE_USER_ID) return process.env.SUPABASE_USER_ID
  const { data: userData } = await supabase.auth.getUser()
  if (userData?.user?.id) return userData.user.id
  const { data, error } = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  if (data?.user_id) return data.user_id
  throw new Error('Tidak bisa menentukan user_id untuk brain backup.')
}

function issue(severity, code, message, count) {
  return { severity, code, message, count }
}

function directorySize(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, item.name)
    if (item.isDirectory()) total += directorySize(full)
    else if (item.isFile()) total += statSync(full).size
  }
  return total
}

function checksumDirectory(dir, excludeNames = []) {
  const hash = createHash('sha256')
  for (const file of walkAnyFiles(dir).filter((item) => !excludeNames.includes(basename(item))).sort()) {
    hash.update(relative(dir, file))
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

function walkAnyFiles(dir) {
  const files = []
  if (!existsSync(dir)) return files
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, item.name)
    if (item.isDirectory()) files.push(...walkAnyFiles(full))
    else if (item.isFile()) files.push(full)
  }
  return files
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readTablesArg(value) {
  if (!value) return SUPABASE_TABLES
  const requested = String(value).split(',').map((item) => item.trim()).filter(Boolean)
  return requested.filter((table) => SUPABASE_TABLES.includes(table))
}

function redactValue(key, value) {
  if (!value) return ''
  if (SECRET_KEY_RE.test(key)) return '[redacted]'
  return redactText(value)
}

function redactText(value) {
  return String(value ?? '')
    .replace(/[A-Z0-9_]*(?:KEY|SERVICE_ROLE|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=[^\s,\n]+/gi, 'SECRET=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sha256:[a-f0-9]{8,}/gi, 'sha256:[redacted]')
    .replace(/service_role/gi, '[redacted-role]')
}

function normalizeName(value) {
  return String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '')
}

function isToday(value) {
  if (!value) return false
  const d = new Date(value)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

function backupAgeDays(value) {
  if (!value) return Infinity
  return (Date.now() - new Date(value).getTime()) / 86400000
}

function errorMessage(err) {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') return String(err.message ?? err.details ?? JSON.stringify(err))
  return String(err)
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

function formatBackupDate(date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}-${hh}-${mi}-${ss}`
}
