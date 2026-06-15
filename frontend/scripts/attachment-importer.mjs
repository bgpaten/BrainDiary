import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'

const SUPPORTED_EXT = new Set(['.md', '.txt', '.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const TEXT_EXT = new Set(['.md', '.txt'])
const DOCUMENT_EXT = new Set(['.pdf', '.docx', '.md', '.txt'])
const MAX_EXTRACTED_CHARS = 30000
const FAILED_COOLDOWN_MS = 5 * 60 * 1000

loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const args = new Set(process.argv.slice(2))
const watch = args.has('--watch')
const limit = readIntArg('--limit', Number(process.env.ATTACHMENT_IMPORT_LIMIT ?? 5))
const pollMs = readIntArg('--interval-ms', Number(process.env.ATTACHMENT_IMPORT_INTERVAL_MS ?? 30000))
const maxFileSizeMb = readIntArg('--max-file-size-mb', Number(process.env.ATTACHMENT_MAX_FILE_SIZE_MB ?? 20))
const pdfEnabled = envBool('ATTACHMENT_PDF_ENABLED', true)
const docxEnabled = envBool('ATTACHMENT_DOCX_ENABLED', true)
const imageEnabled = envBool('ATTACHMENT_IMAGE_ENABLED', true)
const visionEnabled = envBool('ATTACHMENT_VISION_ENABLED', false)

const vaultPath = resolvePath(process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const importDir = process.env.ATTACHMENT_IMPORT_DIR ?? '80_Attachments'
const importPath = resolve(vaultPath, importDir)
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const supabase = await createSupabaseClient()
const userId = await resolveUserId()

do {
  const summary = await runImport()
  console.log(`[attachment-importer] processed=${summary.processed} done=${summary.done} failed=${summary.failed} skipped=${summary.skipped}`)
  writeRunLog(summary)
  if (!watch) break
  await sleep(pollMs)
} while (true)

async function runImport() {
  const files = existsSync(importPath) ? scanFiles(importPath) : []
  const sorted = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const entries = []
  let skipped = 0
  let failed = 0
  let done = 0
  let processed = 0

  const candidates = []
  for (const file of sorted) {
    const relPath = toVaultRelative(file)
    const ext = extname(file).toLowerCase()
    const st = statSync(file)
    if (!SUPPORTED_EXT.has(ext)) {
      skipped += 1
      continue
    }
    if (st.size > maxFileSizeMb * 1024 * 1024) {
      skipped += 1
      entries.push({ path: relPath, status: 'skipped', reason: `file too large (${st.size} bytes)` })
      continue
    }
    candidates.push(file)
  }

  console.log(`[attachment-importer] found=${files.length} importable=${candidates.length} limit=${limit}`)

  for (const file of candidates) {
    if (processed >= limit) break
    const relPath = toVaultRelative(file)
    console.log(`[attachment-importer] importing ${relPath}`)
    try {
      const result = await importFile(file)
      if (result.status === 'skipped') {
        skipped += 1
        entries.push({ path: relPath, ...result })
        console.log(`[attachment-importer] skipped ${relPath}: ${result.reason}`)
        continue
      }
      processed += 1
      done += result.status === 'done' || result.status === 'needs_review' ? 1 : 0
      entries.push({ path: relPath, ...result })
      console.log(`[attachment-importer] extracted_chars=${result.extracted_chars ?? 0}`)
      if (result.raw_entry_id) console.log(`[attachment-importer] raw_entry_id=${result.raw_entry_id}`)
      console.log('[attachment-importer] done')
    } catch (err) {
      processed += 1
      failed += 1
      const message = messageOf(err).slice(0, 700)
      entries.push({ path: relPath, status: 'failed', error: message })
      console.error(`[attachment-importer] failed ${relPath}: ${message}`)
      await markBrainFileFailed(file, message).catch(() => undefined)
    }
  }

  return { found: files.length, importable: candidates.length, processed, done, failed, skipped, entries }
}

async function importFile(file) {
  const st = statSync(file)
  const ext = extname(file).toLowerCase()
  const relPath = toVaultRelative(file)
  const checksum = sha256(file)
  const existing = await findExistingBrainFile(relPath, basename(file), st.size, checksum)
  if (existing?.processing_status === 'done') return { status: 'skipped', reason: 'already imported', brain_file_id: existing.id, raw_entry_id: existing.raw_entry_id }
  if (existing?.processing_status === 'failed' && !failedCooldownElapsed(existing)) return { status: 'skipped', reason: 'failed cooldown', brain_file_id: existing.id }

  const extracted = await extractFile(file, ext)
  const now = new Date().toISOString()
  const brainFile = existing ?? await insertBrainFile(file, st, checksum, extracted, 'processing')
  if (existing) await updateBrainFile(brainFile.id, extracted, 'processing', { checksum, retried_at: now })

  const rawStatus = extracted.status === 'needs_review' ? 'needs_review' : 'pending'
  const rawEntryId = await ensureRawEntry(file, st, extracted, rawStatus, existing?.raw_entry_id)
  await updateBrainFile(brainFile.id, extracted, rawStatus === 'needs_review' ? 'needs_review' : 'processing', {
    checksum,
    raw_entry_id: rawEntryId,
    imported_at: now,
    parser: extracted.parser,
    parser_version: extracted.parser_version,
    extraction_preview: extracted.content.slice(0, 500),
  })

  if (rawStatus === 'needs_review') {
    await updateBrainFile(brainFile.id, extracted, 'needs_review', {
      checksum,
      raw_entry_id: rawEntryId,
      pending_reason: extracted.pending_reason,
      imported_at: now,
    })
    return { status: 'needs_review', brain_file_id: brainFile.id, raw_entry_id: rawEntryId, extracted_chars: extracted.content.length }
  }

  console.log('[attachment-importer] running brain-worker...')
  const worker = await runBrainWorker(rawEntryId)
  if (worker.code !== 0) {
    await updateBrainFile(brainFile.id, extracted, 'failed', { checksum, raw_entry_id: rawEntryId, failed_at: now, error: summarizeOutput(worker.output) ?? worker.output.slice(0, 500) })
    throw new Error(summarizeOutput(worker.output) ?? `brain-worker exit ${worker.code}`)
  }
  await updateBrainFile(brainFile.id, extracted, 'done', { checksum, raw_entry_id: rawEntryId, imported_at: now, worker: summarizeOutput(worker.output) })
  return { status: 'done', brain_file_id: brainFile.id, raw_entry_id: rawEntryId, extracted_chars: extracted.content.length, worker: summarizeOutput(worker.output) }
}

async function extractFile(file, ext) {
  if (TEXT_EXT.has(ext)) return extractTextFile(file, ext)
  if (ext === '.pdf') {
    if (!pdfEnabled) throw new Error('PDF import disabled by ATTACHMENT_PDF_ENABLED=false')
    return extractPdf(file)
  }
  if (ext === '.docx') {
    if (!docxEnabled) throw new Error('DOCX import disabled by ATTACHMENT_DOCX_ENABLED=false')
    return extractDocx(file)
  }
  if (IMAGE_EXT.has(ext)) {
    if (!imageEnabled) throw new Error('Image import disabled by ATTACHMENT_IMAGE_ENABLED=false')
    return extractImage(file)
  }
  throw new Error(`Unsupported extension: ${ext}`)
}

function extractTextFile(file, ext) {
  const raw = readFileSync(file, 'utf8')
  const content = ext === '.md' ? stripFrontmatter(raw) : raw
  return {
    status: 'pending',
    content: limitChars(content.trim(), MAX_EXTRACTED_CHARS),
    parser: ext === '.md' ? 'markdown-text' : 'plain-text',
    parser_version: '1',
  }
}

async function extractPdf(file) {
  const pdftotext = await runCommand('pdftotext', ['-layout', file, '-'], { allowMissing: true })
  if (pdftotext.code === 0 && pdftotext.output.trim()) {
    return { status: 'pending', content: limitChars(pdftotext.output.trim(), MAX_EXTRACTED_CHARS), parser: 'pdftotext', parser_version: 'local-command' }
  }
  const fallback = extractPdfNaive(file)
  if (!fallback.trim()) throw new Error('PDF text extraction failed. Install pdftotext or use a text-based PDF.')
  return { status: 'pending', content: limitChars(fallback.trim(), MAX_EXTRACTED_CHARS), parser: 'pdf-naive', parser_version: '1' }
}

async function extractDocx(file) {
  const xml = await runCommand('unzip', ['-p', file, 'word/document.xml'], { allowMissing: true })
  if (xml.code !== 0 || !xml.output.trim()) throw new Error('DOCX extraction failed. Install unzip or provide readable DOCX.')
  const text = xml.output
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) throw new Error('DOCX extraction produced empty text.')
  return { status: 'pending', content: limitChars(text, MAX_EXTRACTED_CHARS), parser: 'docx-unzip-xml', parser_version: '1' }
}

async function extractImage(file) {
  const relPath = toVaultRelative(file)
  if (!visionEnabled) {
    return {
      status: 'needs_review',
      content: [
        `Image attachment imported without vision analysis: ${relPath}.`,
        'ATTACHMENT_VISION_ENABLED=false, so no visual claims were generated.',
        'Review this image manually or enable a vision-capable provider before using it as memory.',
      ].join('\n'),
      parser: 'image-metadata-only',
      parser_version: '1',
      pending_reason: 'pending_vision',
    }
  }
  const description = await describeImage(file)
  return { status: 'pending', content: limitChars(description, MAX_EXTRACTED_CHARS), parser: 'vision-llm', parser_version: '1' }
}

async function describeImage(file) {
  const provider = (process.env.BRAIN_CHAT_PROVIDER ?? process.env.LLM_PROVIDER ?? 'claude-code').toLowerCase()
  const mime = mimeType(file)
  const base64 = readFileSync(file).toString('base64')
  const instruction = [
    'Describe this personal brain attachment for later memory extraction.',
    'Only describe visible content. Do not guess hidden context.',
    'Include main objects, readable text, people/place/context if clear, and a confidence score.',
    'Answer in Indonesian plain text.',
  ].join('\n')
  if (provider === 'openai') {
    const baseUrl = requiredEnv('BRAIN_CHAT_BASE_URL', process.env.LLM_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('BRAIN_CHAT_API_KEY', process.env.LLM_API_KEY)
    const model = requiredEnv('BRAIN_CHAT_MODEL', process.env.LLM_MODEL)
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }] }],
      }),
    })
    if (!res.ok) throw new Error(`Vision HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    return data?.choices?.[0]?.message?.content ?? ''
  }
  if (provider === 'anthropic') {
    const baseUrl = requiredEnv('BRAIN_CHAT_BASE_URL', process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    const apiKey = requiredEnv('BRAIN_CHAT_API_KEY', process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
    const model = requiredEnv('BRAIN_CHAT_MODEL', process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL)
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } }] }] }),
    })
    if (!res.ok) throw new Error(`Vision HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    return Array.isArray(data.content) ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
  }
  throw new Error(`Vision provider belum didukung untuk ATTACHMENT_VISION_ENABLED=true: ${provider}`)
}

async function findExistingBrainFile(obsidianPath, fileName, fileSize, checksum) {
  const { data, error } = await supabase
    .from('brain_files')
    .select('id,raw_entry_id,processing_status,metadata,file_size')
    .eq('user_id', userId)
    .eq('file_name', fileName)
    .eq('file_size', fileSize)
    .eq('obsidian_path', obsidianPath)
    .maybeSingle()
  if (error) throw error
  if (data) return data

  const byChecksum = await supabase
    .from('brain_files')
    .select('id,raw_entry_id,processing_status,metadata,file_size')
    .eq('user_id', userId)
    .contains('metadata', { checksum })
    .maybeSingle()
  if (byChecksum.error) throw byChecksum.error
  return byChecksum.data
}

async function insertBrainFile(file, st, checksum, extracted, status) {
  const payload = {
    user_id: userId,
    file_name: basename(file),
    file_path: file,
    storage_bucket: 'local_obsidian',
    mime_type: mimeType(file),
    file_size: st.size,
    source_origin: 'obsidian_attachment',
    obsidian_path: toVaultRelative(file),
    extracted_text: extracted.content,
    processing_status: status,
    metadata: {
      checksum,
      source_origin_detail: 'attachment',
      parser: extracted.parser,
      parser_version: extracted.parser_version,
      mtime: st.mtime.toISOString(),
    },
  }
  const { data, error } = await supabase
    .from('brain_files')
    .insert(payload)
    .select('id,raw_entry_id,processing_status,metadata')
    .single()
  if (error && isSourceOriginConstraint(error)) {
    const retry = await supabase
      .from('brain_files')
      .insert({ ...payload, source_origin: 'upload' })
      .select('id,raw_entry_id,processing_status,metadata')
      .single()
    if (retry.error) throw retry.error
    return retry.data
  }
  if (error) throw error
  return data
}

async function updateBrainFile(id, extracted, status, metadataPatch) {
  const { data: existing, error: findErr } = await supabase
    .from('brain_files')
    .select('metadata')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (findErr) throw findErr
  const { error } = await supabase
    .from('brain_files')
    .update({
      extracted_text: extracted.content,
      processing_status: status,
      metadata: { ...(existing?.metadata ?? {}), ...metadataPatch },
    })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

async function markBrainFileFailed(file, message) {
  const st = statSync(file)
  const checksum = sha256(file)
  const extracted = { content: '', parser: 'none', parser_version: '1' }
  const existing = await findExistingBrainFile(toVaultRelative(file), basename(file), st.size, checksum)
  if (existing) {
    await updateBrainFile(existing.id, extracted, 'failed', { checksum, failed_at: new Date().toISOString(), error: message })
    return
  }
  const brainFile = await insertBrainFile(file, st, checksum, extracted, 'failed')
  await updateBrainFile(brainFile.id, extracted, 'failed', { checksum, failed_at: new Date().toISOString(), error: message })
}

async function ensureRawEntry(file, st, extracted, rawStatus, existingRawEntryId) {
  if (existingRawEntryId) {
    const existing = await findRawEntryById(existingRawEntryId)
    if (existing) {
      if (existing.processing_status === 'done' && existing.processed) return existing.id
      await resetRawEntry(existing.id, file, st, extracted, rawStatus)
      return existing.id
    }
  }
  const byPath = await findRawEntryByPath(toVaultRelative(file))
  if (byPath) {
    if (byPath.processing_status === 'done' && byPath.processed) return byPath.id
    await resetRawEntry(byPath.id, file, st, extracted, rawStatus)
    return byPath.id
  }
  const payload = {
    user_id: userId,
    source_type: IMAGE_EXT.has(extname(file).toLowerCase()) ? 'image' : 'document',
    source_origin: 'attachment',
    title: basename(file),
    content: extracted.content,
    file_path: file,
    obsidian_path: toVaultRelative(file),
    happened_at: st.mtime.toISOString(),
    processed: false,
    processing_status: rawStatus,
  }
  const { data, error } = await supabase
    .from('raw_entries')
    .insert(payload)
    .select('id')
    .single()
  if (error && isSourceOriginConstraint(error)) {
    const retry = await supabase.from('raw_entries').insert({ ...payload, source_origin: 'upload' }).select('id').single()
    if (retry.error) throw retry.error
    return retry.data.id
  }
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
    .in('source_origin', ['attachment', 'upload'])
    .eq('obsidian_path', obsidianPath)
    .maybeSingle()
  if (error) throw error
  return data
}

async function resetRawEntry(id, file, st, extracted, rawStatus) {
  const { error } = await supabase
    .from('raw_entries')
    .update({
      title: basename(file),
      content: extracted.content,
      file_path: file,
      obsidian_path: toVaultRelative(file),
      happened_at: st.mtime.toISOString(),
      processed: false,
      processing_status: rawStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

async function runBrainWorker(rawEntryId) {
  return await runCommand('npm', ['run', 'brain:worker', '--', '--limit', '1', '--raw-entry-id', rawEntryId])
}

function scanFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...scanFiles(full))
    else if (st.isFile()) out.push(full)
  }
  return out
}

function extractPdfNaive(file) {
  const raw = readFileSync(file)
  const latin = raw.toString('latin1')
  const streams = [...latin.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => m[1])
  const chunks = []
  for (const stream of streams) {
    let text = stream
    try {
      const bytes = Buffer.from(stream, 'latin1')
      text = inflateSync(bytes).toString('latin1')
    } catch {
      // Some PDF streams are uncompressed; keep latin1 stream.
    }
    chunks.push(...extractPdfTextOperators(text))
  }
  return chunks.join('\n').replace(/\s{2,}/g, ' ').trim()
}

function extractPdfTextOperators(text) {
  const out = []
  for (const match of text.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g)) out.push(unescapePdfString(match[1]))
  for (const match of text.matchAll(/\[((?:.|\n)*?)\]\s*TJ/g)) {
    const parts = [...match[1].matchAll(/\(([^()]*(?:\\.[^()]*)*)\)/g)].map((m) => unescapePdfString(m[1]))
    if (parts.length) out.push(parts.join(''))
  }
  return out
}

function unescapePdfString(value) {
  return value.replace(/\\([nrtbf()\\])/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[ch] ?? ch))
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) {
    console.log('[attachment-importer] Supabase mode: service role local')
    return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  }
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY atau SUPABASE_USER_EMAIL/SUPABASE_USER_PASSWORD untuk attachment importer.')
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

async function resolveUserId() {
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  const { data } = await supabase.auth.getUser()
  if (data?.user?.id) return data.user.id
  const latest = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (latest.error) throw latest.error
  if (latest.data?.user_id) return latest.data.user_id
  throw new Error('Tidak bisa resolve user_id. Set OBSIDIAN_USER_ID untuk attachment importer.')
}

function failedCooldownElapsed(fileRow) {
  const failedAt = fileRow.metadata?.failed_at
  if (!failedAt) return true
  return Date.now() - new Date(failedAt).getTime() > FAILED_COOLDOWN_MS
}

function writeRunLog(summary) {
  const day = new Date().toISOString().slice(0, 10)
  const path = resolve(vaultPath, '_system', 'logs', `attachment-importer-${day}.md`)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, [
    `\n## ${new Date().toISOString()}`,
    '',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    '',
  ].join('\n'))
}

function runCommand(command, commandArgs, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => resolvePromise({ code, output }))
    child.on('error', (err) => {
      if (options.allowMissing) resolvePromise({ code: 127, output: err.message })
      else resolvePromise({ code: 1, output: err.message })
    })
  })
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function mimeType(file) {
  const ext = extname(file).toLowerCase()
  return {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[ext] ?? 'application/octet-stream'
}

function toVaultRelative(file) {
  return relative(vaultPath, file).split(sep).join('/')
}

function resolvePath(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

function limitChars(value, max) {
  return String(value ?? '').slice(0, max)
}

function summarizeOutput(output) {
  if (typeof output !== 'string' || !output.trim()) return undefined
  const lines = output.trim().split(/\r?\n/).filter(Boolean)
  return [...lines].reverse().find((line) => line.includes('[brain-worker] processed=')) ?? lines[lines.length - 1]
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function readIntArg(name, fallback) {
  const argv = process.argv.slice(2)
  const idx = argv.indexOf(name)
  if (idx === -1) return fallback
  const parsed = Number(argv[idx + 1])
  return Number.isFinite(parsed) ? parsed : fallback
}

function envBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === 'true'
}

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing env ${name}`)
  return value
}

function isSourceOriginConstraint(error) {
  const message = String(error?.message ?? '')
  return message.includes('source_origin') && message.includes('check constraint')
}

function loadEnv(path, options = {}) {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const key = match[1]
    if (!options.override && process.env[key]) continue
    process.env[key] = match[2].replace(/^['"]|['"]$/g, '')
  }
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}
