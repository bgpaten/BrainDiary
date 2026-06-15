/**
 * Google History Importer — Collector Mode
 *
 * Script ini HANYA berfungsi sebagai collector:
 * - Ambil data Google History (dari Google Drive / local file)
 * - Parse aktivitas harian
 * - Simpan ke Supabase (google_history_imports, google_history_items, raw_entries)
 * - Set status pending untuk local brain worker
 *
 * TIDAK BOLEH:
 * - Memanggil model/LLM
 * - Menjalankan brain-worker
 * - Menulis ke Obsidian (kecuali vault local tersedia dan bukan GitHub Actions)
 * - Menjalankan identity/communication/similarity/reflection/drift
 *
 * Usage:
 *   npm run google:history:collect                          # collect yesterday
 *   npm run google:history:collect:date -- --date 2026-06-14  # collect specific date
 *   npm run google:history:audit                            # audit stats
 */

import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// ENV loading
// ---------------------------------------------------------------------------
const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

// ---------------------------------------------------------------------------
// CLI args parsing
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2))
const mode = args.get('mode') ?? (args.has('audit') ? 'audit' : 'collect')
const targetDate = args.get('date') ?? null
const timezone = process.env.GOOGLE_HISTORY_TIMEZONE ?? 'Asia/Jakarta'
const importEnabled = process.env.GOOGLE_HISTORY_IMPORT_ENABLED !== 'false'
const importToRawEntries = process.env.GOOGLE_HISTORY_IMPORT_TO_RAW_ENTRIES !== 'false'
const createPendingQueue = process.env.GOOGLE_HISTORY_CREATE_PENDING_QUEUE !== 'false'
const runWorkerAfterImport = process.env.GOOGLE_HISTORY_RUN_WORKER_AFTER_IMPORT === 'true'
const historyMode = process.env.GOOGLE_HISTORY_MODE ?? 'takeout_json'
const isGitHubActions = Boolean(process.env.GITHUB_ACTIONS)

// Security: never run worker in GitHub Actions
if (runWorkerAfterImport && isGitHubActions) {
  console.error('[google-history] FATAL: GOOGLE_HISTORY_RUN_WORKER_AFTER_IMPORT=true is NOT allowed in GitHub Actions.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
if (!supabaseUrl) {
  console.error('[google-history] FATAL: SUPABASE_URL not set.')
  process.exit(1)
}

const supabase = await createSupabaseClient()

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (mode === 'audit') {
  await runAudit()
} else if (mode === 'collect') {
  if (!importEnabled) {
    console.log('[google-history] Import disabled (GOOGLE_HISTORY_IMPORT_ENABLED=false).')
    process.exit(0)
  }
  await runCollect()
} else {
  console.error(`[google-history] Unknown mode: ${mode}`)
  process.exit(1)
}

// ===========================================================================
// COLLECT MODE
// ===========================================================================
async function runCollect() {
  const date = resolveTargetDate(targetDate, timezone)
  console.log(`[google-history] Collecting for date: ${date}`)
  console.log(`[google-history] Mode: ${historyMode}, Timezone: ${timezone}`)
  console.log(`[google-history] Environment: ${isGitHubActions ? 'github_actions' : 'local'}`)

  const userId = await resolveUserId()

  // 1. Load raw Google History data
  const rawActivities = await loadGoogleHistoryForDate(date)
  console.log(`[google-history] Found ${rawActivities.length} activities for ${date}`)

  // 2. Upsert google_history_imports
  const importRow = await upsertImport(userId, date, 0) // item_count updated after merge
  console.log(`[google-history] Import row: ${importRow.id} (status: ${importRow.status})`)

  // 3. Merge items — only insert new activities (delta), skip duplicates
  let newCount = 0
  let totalCount = 0
  if (rawActivities.length > 0) {
    const mergeResult = await mergeItems(userId, importRow.id, rawActivities)
    newCount = mergeResult.inserted
    totalCount = mergeResult.total
    console.log(`[google-history] Merged: ${newCount} new, ${mergeResult.skipped} skipped (already in DB), ${totalCount} total`)
  } else {
    // Even if no new activities parsed, count what's already in DB
    const { count } = await supabase
      .from('google_history_items')
      .select('id', { count: 'exact', head: true })
      .eq('import_id', importRow.id)
    totalCount = count ?? 0
  }

  // Update import row with actual total item count
  await must(
    supabase
      .from('google_history_imports')
      .update({ item_count: totalCount })
      .eq('id', importRow.id),
  )

  // 4. Create raw_entries row (pending) for local brain worker
  let rawEntryId = null
  if (importToRawEntries) {
    // Rebuild content from ALL items in DB for this import (existing + newly inserted)
    const allItems = await fetchAllItems(importRow.id)
    rawEntryId = await upsertRawEntry(userId, date, importRow.id, allItems, totalCount)
    console.log(`[google-history] raw_entry: ${rawEntryId} (processing_status: pending, items: ${allItems.length})`)

    // Update import with raw_entry reference
    await must(
      supabase
        .from('google_history_imports')
        .update({ raw_entry_id: rawEntryId })
        .eq('id', importRow.id),
    )
  }

  // 5. Create extraction_jobs row (pending)
  if (createPendingQueue && rawEntryId) {
    const { data: job, error: jobErr } = await supabase
      .from('extraction_jobs')
      .insert({
        user_id: userId,
        raw_entry_id: rawEntryId,
        job_type: 'google_history_import',
        status: 'pending',
        input_snapshot: {
          import_date: date,
          google_history_import_id: importRow.id,
          collector: isGitHubActions ? 'github_actions' : 'local',
          needs_local_worker: true,
          item_count: totalCount,
          new_item_count: newCount,
        },
      })
      .select('id')
      .single()
    if (jobErr) console.error(`[google-history] extraction_jobs insert warning: ${jobErr.message}`)
    else console.log(`[google-history] extraction_job: ${job.id} (status: pending)`)
  }

  // 6. Mark import as done
  await must(
    supabase
      .from('google_history_imports')
      .update({ status: 'done' })
      .eq('id', importRow.id),
  )

  // Output summary
  const summary = {
    ok: true,
    mode: 'collect',
    date,
    import_id: importRow.id,
    item_count: totalCount,
    new_item_count: newCount,
    raw_entry_id: rawEntryId,
    collector: isGitHubActions ? 'github_actions' : 'local',
    processing_status: 'pending',
    needs_local_worker: true,
  }
  console.log(JSON.stringify(summary))
}

// ===========================================================================
// AUDIT MODE
// ===========================================================================
async function runAudit() {
  const userId = await resolveUserId()

  // Pending imports
  const { data: pending, error: pendingErr } = await supabase
    .from('google_history_imports')
    .select('id,import_date,status,item_count,created_at')
    .eq('user_id', userId)
    .eq('status', 'done')
    .order('import_date', { ascending: false })
    .limit(10)

  // Pending raw_entries for google_history
  const { count: pendingRawCount } = await supabase
    .from('raw_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('source_origin', 'google_history')
    .eq('processing_status', 'pending')

  const { count: failedRawCount } = await supabase
    .from('raw_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('source_origin', 'google_history')
    .eq('processing_status', 'failed')

  const { count: doneRawCount } = await supabase
    .from('raw_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('source_origin', 'google_history')
    .eq('processing_status', 'done')

  // Latest collected & processed
  const { data: latestCollected } = await supabase
    .from('raw_entries')
    .select('source_metadata,collected_at')
    .eq('user_id', userId)
    .eq('source_origin', 'google_history')
    .order('collected_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: latestProcessed } = await supabase
    .from('raw_entries')
    .select('source_metadata,processed_at')
    .eq('user_id', userId)
    .eq('source_origin', 'google_history')
    .eq('processing_status', 'done')
    .order('processed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const result = {
    ok: true,
    mode: 'audit',
    imports: pendingErr ? [] : (pending ?? []),
    raw_entries: {
      pending: pendingRawCount ?? 0,
      failed: failedRawCount ?? 0,
      done: doneRawCount ?? 0,
    },
    latest_collected_date: latestCollected?.source_metadata?.import_date ?? null,
    latest_processed_date: latestProcessed?.source_metadata?.import_date ?? null,
  }
  console.log(JSON.stringify(result))
}

// ===========================================================================
// Google History data loading
// ===========================================================================
async function loadGoogleHistoryForDate(date) {
  if (historyMode === 'drive') {
    return await loadFromGoogleDrive(date)
  }
  if (historyMode === 'takeout_json') {
    return await loadFromTakeoutJson(date)
  }
  if (historyMode === 'mock') {
    return generateMockActivities(date)
  }
  console.warn(`[google-history] Unknown GOOGLE_HISTORY_MODE: ${historyMode}, using empty activities`)
  return []
}

async function loadFromGoogleDrive(date) {
  const clientId = process.env.GOOGLE_HISTORY_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_HISTORY_OAUTH_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_HISTORY_OAUTH_REFRESH_TOKEN
  const folderId = process.env.GOOGLE_HISTORY_DRIVE_FOLDER_ID

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('[google-history] Google OAuth credentials missing, returning empty activities')
    return []
  }

  try {
    // Get access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!tokenRes.ok) {
      console.error(`[google-history] OAuth token refresh failed: ${tokenRes.status}`)
      return []
    }
    const tokenData = await tokenRes.json()
    const accessToken = tokenData.access_token

    // Search for file matching the date pattern
    const fileName = `MyActivity-${date}.json`
    const query = folderId
      ? `name='${fileName}' and '${folderId}' in parents and trashed=false`
      : `name='${fileName}' and trashed=false`
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!searchRes.ok) {
      console.error(`[google-history] Drive search failed: ${searchRes.status}`)
      return []
    }
    const searchData = await searchRes.json()
    if (!searchData.files?.length) {
      console.log(`[google-history] No file found in Drive for ${date}`)
      return []
    }

    // Download file content
    const fileId = searchData.files[0].id
    const downloadRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!downloadRes.ok) {
      console.error(`[google-history] Drive download failed: ${downloadRes.status}`)
      return []
    }
    const content = await downloadRes.text()
    return parseGoogleTakeoutJson(content, date)
  } catch (err) {
    console.error(`[google-history] Drive error: ${messageOf(err)}`)
    return []
  }
}

async function loadFromTakeoutJson(date) {
  // Look for local Takeout export files
  const possiblePaths = [
    resolve(rootDir, `google-history/MyActivity-${date}.json`),
    resolve(rootDir, `google-history/MyActivity.json`),
    resolve(process.cwd(), `google-history/MyActivity-${date}.json`),
    resolve(process.cwd(), `google-history/MyActivity.json`),
  ]

  for (const filePath of possiblePaths) {
    if (existsSync(filePath)) {
      console.log(`[google-history] Loading from: ${filePath}`)
      const content = readFileSync(filePath, 'utf8')
      return parseGoogleTakeoutJson(content, date)
    }
  }

  console.log(`[google-history] No local Takeout JSON found for ${date}`)
  return []
}

function parseGoogleTakeoutJson(content, date) {
  try {
    const data = JSON.parse(content)
    const activities = Array.isArray(data) ? data : (data.activity ?? data.items ?? [])
    const dayStart = new Date(`${date}T00:00:00`)
    const dayEnd = new Date(`${date}T23:59:59.999`)

    const filtered = activities
      .filter((item) => {
        if (!item) return false
        const ts = item.time ?? item.timestamp ?? item.visitedAt ?? item.date
        if (!ts) return true // include items without timestamps
        const d = new Date(ts)
        return d >= dayStart && d <= dayEnd
      })
      .map((item) => {
        const ts = item.time ?? item.timestamp ?? item.visitedAt ?? item.date
        return {
          activity_type: classifyActivityType(item),
          title: item.title ?? item.name ?? item.query ?? null,
          url: item.url ?? item.titleUrl ?? null,
          happened_at: ts ? new Date(ts).toISOString() : null,
          metadata: {
            products: item.products ?? [],
            ...(item.details ? { details: item.details } : {}),
          },
        }
      })

    return filtered
  } catch (err) {
    console.error(`[google-history] Failed to parse Takeout JSON: ${messageOf(err)}`)
    return []
  }
}

function classifyActivityType(item) {
  const products = (item.products ?? []).map((p) => String(p).toLowerCase())
  const title = String(item.title ?? '').toLowerCase()
  const url = String(item.url ?? item.titleUrl ?? '').toLowerCase()

  if (products.includes('search') || title.includes('searched for')) return 'search'
  if (products.includes('youtube') || url.includes('youtube.com')) return 'youtube'
  if (products.includes('maps') || url.includes('maps.google')) return 'maps'
  if (url.includes('http')) return 'web'
  return 'other'
}

function generateMockActivities(date) {
  return [
    { activity_type: 'search', title: `Mock search on ${date}`, url: null, happened_at: `${date}T10:00:00.000Z`, metadata: { mock: true } },
    { activity_type: 'web', title: 'Mock web visit', url: 'https://example.com', happened_at: `${date}T11:00:00.000Z`, metadata: { mock: true } },
    { activity_type: 'youtube', title: 'Mock YouTube watch', url: 'https://youtube.com/watch?v=mock', happened_at: `${date}T14:00:00.000Z`, metadata: { mock: true } },
  ]
}

// ===========================================================================
// Supabase operations
// ===========================================================================
async function upsertImport(userId, date, itemCount) {
  // Try to find existing import for this date
  const { data: existing } = await supabase
    .from('google_history_imports')
    .select('id,status')
    .eq('user_id', userId)
    .eq('import_date', date)
    .maybeSingle()

  if (existing) {
    // Update existing
    const { data, error } = await supabase
      .from('google_history_imports')
      .update({
        status: 'processing',
        collector: isGitHubActions ? 'github_actions' : 'local',
        item_count: itemCount,
        error_message: null,
      })
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) throw error
    return data
  }

  // Insert new
  const { data, error } = await supabase
    .from('google_history_imports')
    .insert({
      user_id: userId,
      import_date: date,
      status: 'processing',
      collector: isGitHubActions ? 'github_actions' : 'local',
      item_count: itemCount,
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

/**
 * Merge items — only insert activities not already in DB.
 * Dedup key: happened_at (rounded to second) + title (lowercased, trimmed).
 *
 * Scenario:
 *   Run 1 (manual 19:00) → 50 items inserted (00:00–19:00)
 *   Run 2 (cron 00:00)   → 60 items from source, 50 match existing, 10 new → only 10 inserted
 */
async function mergeItems(userId, importId, activities) {
  // 1. Fetch existing items for this import
  const { data: existingItems, error: fetchErr } = await supabase
    .from('google_history_items')
    .select('happened_at,title')
    .eq('import_id', importId)
  if (fetchErr) throw fetchErr

  // 2. Build fingerprint set from existing items
  const existingFingerprints = new Set(
    (existingItems ?? []).map((item) => itemFingerprint(item.happened_at, item.title)),
  )

  // 3. Filter to only new activities
  const newActivities = activities.filter(
    (a) => !existingFingerprints.has(itemFingerprint(a.happened_at, a.title)),
  )

  const skipped = activities.length - newActivities.length
  if (skipped > 0) {
    console.log(`[google-history] Dedup: ${skipped} items already in DB, skipping`)
  }

  // 4. Insert only new items in chunks of 100
  if (newActivities.length > 0) {
    const rows = newActivities.map((a) => ({
      user_id: userId,
      import_id: importId,
      activity_type: a.activity_type,
      title: a.title,
      url: a.url,
      happened_at: a.happened_at,
      metadata: a.metadata ?? {},
    }))

    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100)
      const { error } = await supabase.from('google_history_items').insert(chunk)
      if (error) throw error
    }
  }

  const total = (existingItems?.length ?? 0) + newActivities.length
  return { inserted: newActivities.length, skipped, total }
}

/**
 * Build a dedup fingerprint for an activity item.
 * Uses happened_at (rounded to nearest second) + lowercased title.
 */
function itemFingerprint(happenedAt, title) {
  const ts = happenedAt
    ? new Date(happenedAt).toISOString().slice(0, 19) // round to second: 2026-06-15T19:03:45
    : '__no_ts__'
  const t = (title ?? '').toLowerCase().trim().slice(0, 200)
  return `${ts}|${t}`
}

/**
 * Fetch all items from DB for a given import (used to rebuild raw_entries content).
 */
async function fetchAllItems(importId) {
  const { data, error } = await supabase
    .from('google_history_items')
    .select('activity_type,title,url,happened_at,metadata')
    .eq('import_id', importId)
    .order('happened_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

async function upsertRawEntry(userId, date, importId, allItems, totalCount) {
  const content = renderDailyContent(date, allItems)
  const sourceMetadata = {
    import_date: date,
    google_history_import_id: importId,
    collector: isGitHubActions ? 'github_actions' : 'local',
    needs_local_worker: true,
    item_count: totalCount,
  }

  // Check if raw_entry already exists for this date
  const sourceRef = `google_history:${date}`
  const { data: existing } = await supabase
    .from('raw_entries')
    .select('id')
    .eq('user_id', userId)
    .eq('source_origin', 'google_history')
    .eq('source_ref', sourceRef)
    .maybeSingle()

  if (existing) {
    // Update existing — reset to pending for re-processing
    await must(
      supabase
        .from('raw_entries')
        .update({
          title: `Google History ${date}`,
          content,
          processing_status: 'pending',
          processed: false,
          source_metadata: sourceMetadata,
          collected_at: new Date().toISOString(),
          processed_at: null,
        })
        .eq('id', existing.id),
    )
    return existing.id
  }

  // Insert new
  const { data, error } = await supabase
    .from('raw_entries')
    .insert({
      user_id: userId,
      source_type: 'text',
      source_origin: 'google_history',
      source_ref: sourceRef,
      title: `Google History ${date}`,
      content,
      processing_status: 'pending',
      processed: false,
      source_metadata: sourceMetadata,
      collected_at: new Date().toISOString(),
      happened_at: new Date(`${date}T00:00:00`).toISOString(),
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

function renderDailyContent(date, activities) {
  const grouped = { search: [], web: [], youtube: [], maps: [], other: [] }
  for (const a of activities) {
    const type = a.activity_type ?? 'other'
    if (!grouped[type]) grouped[type] = []
    grouped[type].push(a)
  }

  const sections = []
  sections.push(`# Google History ${date}`)
  sections.push('')
  sections.push('Data ini dikumpulkan otomatis dari Google History oleh ' + (isGitHubActions ? 'GitHub Actions' : 'local collector') + '.')
  sections.push('')
  sections.push('Status:')
  sections.push(`- collected_at: ${new Date().toISOString()}`)
  sections.push('- source: google_history')
  sections.push('- needs_local_worker: true')
  sections.push('')

  for (const [type, items] of Object.entries(grouped)) {
    if (items.length === 0) continue
    const label = {
      search: 'Search Activity',
      web: 'Web Activity',
      youtube: 'YouTube Activity',
      maps: 'Maps Activity',
      other: 'Other Activity',
    }[type] ?? 'Other Activity'

    sections.push(`## ${label}`)
    sections.push('')
    for (const item of items) {
      const time = item.happened_at ? new Date(item.happened_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : ''
      const title = item.title ?? '(tanpa judul)'
      const url = item.url ? ` — ${item.url}` : ''
      sections.push(`- ${time ? `[${time}] ` : ''}${title}${url}`)
    }
    sections.push('')
  }

  sections.push('## Processing Note')
  sections.push('Data ini belum diproses oleh local brain worker.')
  sections.push('Jalankan `npm run brain:process:pending-google` atau `npm run brain:routine:daily:google` untuk memproses.')

  return sections.join('\n')
}

// ===========================================================================
// Helpers
// ===========================================================================
function resolveTargetDate(dateArg, tz) {
  if (dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) return dateArg

  // Default: yesterday in the specified timezone
  const now = new Date()
  // Simple timezone offset for Asia/Jakarta (+7)
  const offset = tz === 'Asia/Jakarta' ? 7 : 0
  const local = new Date(now.getTime() + offset * 60 * 60 * 1000)
  local.setDate(local.getDate() - 1)
  return local.toISOString().slice(0, 10)
}

async function resolveUserId() {
  const envId = process.env.BRAIN_ROUTINE_USER_ID
    ?? process.env.OBSIDIAN_USER_ID
    ?? process.env.SUPABASE_USER_ID
  if (envId) return envId

  const { data: userData } = await supabase.auth.getUser()
  if (userData?.user?.id) return userData.user.id

  const { data, error } = await supabase
    .from('raw_entries')
    .select('user_id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  if (data?.user_id) return data.user_id

  throw new Error('Tidak bisa menentukan user_id. Set SUPABASE_USER_ID / OBSIDIAN_USER_ID env.')
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) {
    console.log('[google-history] Supabase mode: service_role')
    return createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  if (accessToken && anonKey) {
    console.log('[google-history] Supabase mode: access_token')
    return createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })
  }

  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (email && password && anonKey) {
    const client = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw error
    console.log('[google-history] Supabase mode: signed-in user')
    return client
  }

  throw new Error('Supabase credential tidak tersedia. Isi SUPABASE_SERVICE_ROLE_KEY atau SUPABASE_USER_EMAIL/PASSWORD.')
}

async function must(query) {
  const result = await query
  if (result.error) throw result.error
  return result
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}

function parseArgs(items) {
  const map = new Map()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = items[i + 1]
    if (next && !next.startsWith('--')) {
      map.set(key, next)
      i++
    } else {
      map.set(key, 'true')
    }
  }
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
  }
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (override || !(key in process.env)) process.env[key] = value
  }
}
