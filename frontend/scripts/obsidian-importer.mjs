import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const args = new Set(process.argv.slice(2))
const watch = args.has('--watch')
const limit = readIntArg('--limit', Number(process.env.OBSIDIAN_IMPORT_LIMIT ?? 5))
const pollMs = readIntArg('--interval-ms', Number(process.env.OBSIDIAN_IMPORT_INTERVAL_MS ?? 30000))

const vaultPath = resolvePath(process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const diaryDir = process.env.OBSIDIAN_DIARY_DIR ?? '00_Diary'
const diaryPath = resolve(vaultPath, diaryDir)

const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const supabase = await createSupabaseClient()
const userId = await resolveUserId()

do {
  const summary = await runImport()
  console.log(`[obsidian-importer] processed=${summary.processed} done=${summary.done} failed=${summary.failed} skipped=${summary.skipped}`)
  writeRunLog(summary)
  if (!watch) break
  await sleep(pollMs)
} while (true)

async function runImport() {
  const files = scanMarkdownFiles(diaryPath)
  const candidates = []
  const warnings = []
  let skipped = 0

  for (const file of files) {
    const parsed = readMarkdown(file)
    const relPath = toVaultRelative(file)
    if (!parsed.frontmatter) {
      warnings.push(`${relPath}: skipped, frontmatter tidak ada`)
      skipped += 1
      continue
    }
    const fm = parsed.frontmatter
    if (String(fm.type ?? '').trim() !== 'diary') {
      skipped += 1
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(fm, 'processed')) {
      warnings.push(`${relPath}: processed tidak ada, dianggap false`)
    }
    if (String(fm.processing_status ?? '') === 'failed' && recentlyAttempted(fm.last_attempted_at)) {
      skipped += 1
      continue
    }
    if (toBoolean(fm.processed) === true) {
      skipped += 1
      continue
    }
    candidates.push({ file, relPath, parsed })
  }

  candidates.sort((a, b) => statSync(b.file).mtimeMs - statSync(a.file).mtimeMs)
  const pending = candidates.slice(0, limit)
  console.log(`[obsidian-importer] found=${files.length} pending=${candidates.length} limit=${limit}`)

  const entries = []
  let done = 0
  let failed = 0

  for (const item of pending) {
    console.log(`[obsidian-importer] importing ${item.relPath}`)
    try {
      const rawEntryId = await ensureRawEntry(item)
      console.log(`[obsidian-importer] raw_entry_id=${rawEntryId}`)
      console.log('[obsidian-importer] running brain-worker...')
      const worker = await runBrainWorker(rawEntryId)
      if (worker.code !== 0) throw new Error(summarizeOutput(worker.output) ?? `brain-worker exit ${worker.code}`)

      updateFrontmatter(item.file, item.parsed, {
        processed: true,
        processing_status: 'done',
        raw_entry_id: rawEntryId,
        processed_at: new Date().toISOString(),
        last_error: undefined,
        last_attempted_at: undefined,
      })
      done += 1
      entries.push({ path: item.relPath, raw_entry_id: rawEntryId, status: 'done', worker: summarizeOutput(worker.output) })
      console.log('[obsidian-importer] done')
    } catch (err) {
      if (err instanceof SkipDoneError) {
        skipped += 1
        entries.push({ path: item.relPath, status: 'skipped', error: err.message })
        console.log(`[obsidian-importer] skipped ${item.relPath}: ${err.message}`)
        continue
      }
      failed += 1
      const message = messageOf(err).slice(0, 500)
      updateFrontmatter(item.file, item.parsed, {
        processed: false,
        processing_status: 'failed',
        last_error: message,
        last_attempted_at: new Date().toISOString(),
      })
      entries.push({ path: item.relPath, status: 'failed', error: message })
      console.error(`[obsidian-importer] failed ${item.relPath}: ${message}`)
    }
  }

  return {
    found: files.length,
    pending: candidates.length,
    processed: pending.length,
    done,
    failed,
    skipped,
    warnings,
    entries,
  }
}

async function ensureRawEntry(item) {
  const fm = item.parsed.frontmatter
  const existingId = typeof fm.raw_entry_id === 'string' ? fm.raw_entry_id.trim() : ''
  if (existingId) {
    const existing = await findRawEntryById(existingId)
    if (existing) {
      if (existing.processing_status === 'done' && existing.processed) {
        updateFrontmatter(item.file, item.parsed, {
          processed: true,
          processing_status: 'done',
          raw_entry_id: existing.id,
          processed_at: fm.processed_at ?? new Date().toISOString(),
        })
        throw new SkipDoneError(`raw_entry_id ${existing.id} sudah done`)
      }
      await resetRawEntry(existing.id, item.parsed.body)
      return existing.id
    }
  }

  const byPath = await findRawEntryByPath(item.relPath)
  if (byPath) {
    if (byPath.processing_status === 'done' && byPath.processed) {
      updateFrontmatter(item.file, item.parsed, {
        processed: true,
        processing_status: 'done',
        raw_entry_id: byPath.id,
        processed_at: fm.processed_at ?? new Date().toISOString(),
      })
      throw new SkipDoneError(`obsidian_path ${item.relPath} sudah done`)
    }
    await resetRawEntry(byPath.id, item.parsed.body)
    return byPath.id
  }

  const { data, error } = await supabase
    .from('raw_entries')
    .insert({
      user_id: userId,
      source_type: 'text',
      source_origin: 'obsidian',
      title: titleFor(item),
      content: item.parsed.body.trim(),
      obsidian_path: item.relPath,
      happened_at: happenedAtFor(item),
      processed: false,
      processing_status: 'pending',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function findRawEntryById(id) {
  const { data, error } = await supabase
    .from('raw_entries')
    .select('id, processed, processing_status')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function findRawEntryByPath(obsidianPath) {
  const { data, error } = await supabase
    .from('raw_entries')
    .select('id, processed, processing_status')
    .eq('user_id', userId)
    .eq('source_origin', 'obsidian')
    .eq('obsidian_path', obsidianPath)
    .maybeSingle()
  if (error) throw error
  return data
}

async function resetRawEntry(id, content) {
  const { error } = await supabase
    .from('raw_entries')
    .update({ content: content.trim(), processed: false, processing_status: 'pending', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

async function runBrainWorker(rawEntryId) {
  return await runCommand('npm', ['run', 'brain:worker', '--', '--limit', '1', '--raw-entry-id', rawEntryId])
}

function scanMarkdownFiles(dir) {
  if (!existsSync(dir)) throw new Error(`Diary dir tidak ditemukan: ${dir}`)
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...scanMarkdownFiles(full))
    else if (st.isFile() && name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

function readMarkdown(file) {
  const text = readFileSync(file, 'utf8')
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { raw: text, frontmatter: null, body: text }
  return { raw: text, frontmatter: parseFrontmatter(match[1]), body: match[2] ?? '' }
}

function parseFrontmatter(yamlText) {
  const fm = {}
  for (const line of yamlText.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const raw = line.slice(idx + 1).trim()
    fm[key] = parseYamlValue(raw)
  }
  return fm
}

function parseYamlValue(raw) {
  if (raw === '') return ''
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === '[]') return []
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      return JSON.parse(raw.replace(/'/g, '"'))
    } catch {
      return raw
    }
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

function updateFrontmatter(file, parsed, updates) {
  const current = parsed.frontmatter ?? {}
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete current[key]
    else current[key] = value
  }
  const yaml = stringifyFrontmatter(current)
  writeFileSync(file, `---\n${yaml}---\n\n${parsed.body.replace(/^\n+/, '')}`, 'utf8')
}

function stringifyFrontmatter(fm) {
  const preferred = [
    'type', 'date', 'mood', 'energy', 'people', 'projects', 'places', 'events',
    'decisions', 'patterns', 'goals', 'attachments', 'processed',
    'processing_status', 'raw_entry_id', 'processed_at', 'last_error',
    'last_attempted_at', 'brain_importance', 'created_at', 'updated_at',
  ]
  const keys = [...preferred.filter((k) => Object.prototype.hasOwnProperty.call(fm, k)), ...Object.keys(fm).filter((k) => !preferred.includes(k))]
  return keys.map((key) => `${key}: ${formatYamlValue(fm[key])}\n`).join('')
}

function formatYamlValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === null || value === undefined || value === '') return ''
  const s = String(value)
  if (/[":#\n]|^\s|\s$/.test(s)) return JSON.stringify(s)
  return s
}

function titleFor(item) {
  const date = item.parsed.frontmatter?.date
  const heading = item.parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || (date ? `Diary ${date}` : `Diary ${item.relPath.split('/').pop()?.replace(/\.md$/i, '')}`)
}

function happenedAtFor(item) {
  const date = item.parsed.frontmatter?.date
  if (date) return new Date(`${date}T00:00:00`).toISOString()
  return statSync(item.file).mtime.toISOString()
}

function toVaultRelative(file) {
  return relative(vaultPath, file).split(sep).join('/')
}

function writeRunLog(summary) {
  const day = new Date().toISOString().slice(0, 10)
  const logDir = join(vaultPath, '_system', 'logs')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, `obsidian-importer-${day}.md`)
  const lines = [
    `\n## ${new Date().toISOString()}`,
    `- found: ${summary.found}`,
    `- pending: ${summary.pending}`,
    `- processed: ${summary.processed}`,
    `- done: ${summary.done}`,
    `- failed: ${summary.failed}`,
    `- skipped: ${summary.skipped}`,
  ]
  for (const warning of summary.warnings) lines.push(`- warning: ${warning}`)
  for (const entry of summary.entries) {
    lines.push(`- ${entry.status}: ${entry.path}${entry.raw_entry_id ? ` raw_entry_id=${entry.raw_entry_id}` : ''}${entry.error ? ` error=${entry.error}` : ''}`)
  }
  appendFileSync(logFile, `${lines.join('\n')}\n`, 'utf8')
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) {
    return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  }
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY atau SUPABASE_USER_EMAIL/SUPABASE_USER_PASSWORD.')
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

async function resolveUserId() {
  const explicit = process.env.OBSIDIAN_USER_ID ?? process.env.SUPABASE_USER_ID ?? process.env.BRAIN_USER_ID
  if (explicit) return explicit
  const { data } = await supabase.auth.getUser()
  if (data?.user?.id) return data.user.id
  const latest = await supabase
    .from('raw_entries')
    .select('user_id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latest.error) throw latest.error
  if (latest.data?.user_id) return latest.data.user_id
  throw new Error('OBSIDIAN_USER_ID wajib disetel saat memakai SUPABASE_SERVICE_ROLE_KEY dan raw_entries masih kosong.')
}

function runCommand(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => resolve({ code, output }))
    child.on('error', (err) => resolve({ code: 1, output: err.message }))
  })
}

function summarizeOutput(output) {
  const lines = String(output ?? '').trim().split(/\r?\n/).filter(Boolean)
  return [...lines].reverse().find((line) => line.includes('[brain-worker] processed=') || line.includes('[brain-worker] failed')) ?? lines.at(-1)
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function toBoolean(value) {
  if (value === true) return true
  if (value === false) return false
  return String(value ?? '').toLowerCase() === 'true'
}

function recentlyAttempted(value) {
  if (!value) return false
  const t = new Date(String(value)).getTime()
  if (!Number.isFinite(t)) return false
  return Date.now() - t < Number(process.env.OBSIDIAN_FAILED_RETRY_COOLDOWN_MS ?? 300000)
}

function loadEnv(path, { override = false } = {}) {
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (override || !(key in process.env)) process.env[key] = value
  }
}

function requiredEnv(key, fallback) {
  const value = process.env[key] || fallback
  if (!value) throw new Error(`${key} belum disetel.`)
  return value
}

function readIntArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) ? value : fallback
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}

class SkipDoneError extends Error {}
