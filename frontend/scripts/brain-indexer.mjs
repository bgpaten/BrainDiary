import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const TARGET_TABLES = ['brain_nodes', 'brain_edges', 'agent_memories', 'raw_entries']
const TYPE_BY_TABLE = {
  brain_nodes: 'brain_node',
  brain_edges: 'brain_edge',
  agent_memories: 'agent_memory',
  raw_entries: 'raw_entry',
}
const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const MAX_TEXT_CHARS = Number(process.env.EMBEDDING_MAX_TEXT_CHARS ?? 6000)

const argv = parseArgs(process.argv.slice(2))
const watch = argv.has('watch')
const searchQuery = argv.get('search-query') ?? ''
const limit = readIntArg('limit', Number(process.env.BRAIN_INDEX_LIMIT ?? 25), 1, 200)
const force = argv.has('force') || String(process.env.BRAIN_INDEX_FORCE ?? 'false') === 'true'
const onlyTable = argv.get('table') ?? ''
const allTables = argv.has('all')
const pollMs = readIntArg('interval-ms', Number(process.env.BRAIN_INDEX_INTERVAL_MS ?? 60000), 5000, 600000)
const provider = (process.env.EMBEDDING_PROVIDER ?? 'disabled').toLowerCase()
const model = process.env.EMBEDDING_MODEL ?? (provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small')
const dimensions = readIntArg('dimensions', Number(process.env.EMBEDDING_DIMENSIONS ?? 1536), 1, 8192)
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const supabase = await createSupabaseClient()
const userId = await resolveUserId()

if (searchQuery) {
  const result = await semanticSearch(searchQuery, {
    limit,
    tables: readTablesArg(argv.get('tables') ?? TARGET_TABLES.join(',')),
  })
  console.log(JSON.stringify(result))
} else {
  do {
    const summary = await runIndex()
    console.log(`[brain-indexer] processed=${summary.processed} done=${summary.done} failed=${summary.failed} skipped=${summary.skipped}`)
    writeRunLog(summary)
    if (!watch) break
    await sleep(pollMs)
  } while (true)
}

async function runIndex() {
  if (provider === 'disabled') {
    const summary = { provider, model, processed: 0, done: 0, failed: 0, skipped: 0, tables: [], errors: ['EMBEDDING_PROVIDER=disabled'] }
    return summary
  }

  const tables = allTables ? TARGET_TABLES : onlyTable ? [onlyTable] : TARGET_TABLES
  for (const table of tables) {
    if (!TARGET_TABLES.includes(table)) throw new Error(`Unsupported table: ${table}`)
  }

  let remaining = limit
  const summary = { provider, model, dimensions, force, processed: 0, done: 0, failed: 0, skipped: 0, tables: [], errors: [] }
  const nodeNameById = await readNodeNameMap()
  const clusterNameById = await readClusterNameMap()

  for (const table of tables) {
    if (remaining <= 0) break
    const rows = await readRowsForTable(table, remaining)
    const tableSummary = { table, found: rows.length, done: 0, failed: 0, skipped: 0 }
    for (const row of rows) {
      const text = embeddingText(table, row, { nodeNameById, clusterNameById })
      if (!text.trim()) {
        tableSummary.skipped += 1
        summary.skipped += 1
        continue
      }
      const hash = sha256Text(text)
      if (!force && row.embedding && row.embedding_text_hash === hash && row.embedding_model === model && row.embedding_provider === provider) {
        tableSummary.skipped += 1
        summary.skipped += 1
        continue
      }
      try {
        const embedding = await embedText(text)
        await saveEmbedding(table, row.id, embedding, hash)
        tableSummary.done += 1
        summary.done += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        tableSummary.failed += 1
        summary.failed += 1
        summary.errors.push({ table, id: row.id, error: message.slice(0, 500) })
      }
      tableSummary.found = rows.length
      summary.processed += 1
      remaining -= 1
      if (remaining <= 0) break
    }
    summary.tables.push(tableSummary)
  }
  return summary
}

async function semanticSearch(query, { limit: matchLimit, tables }) {
  if (provider === 'disabled') return { ok: false, results: [], error: 'EMBEDDING_PROVIDER=disabled' }
  const embedding = await embedText(query)
  const { data, error } = await supabase.rpc('match_semantic_memory', {
    match_user_id: userId,
    query_embedding: vectorLiteral(embedding),
    match_count: matchLimit,
    match_tables: tables,
  })
  if (error) throw error
  return {
    ok: true,
    results: (data ?? []).map((item) => ({
      type: item.item_type,
      id: item.item_id,
      label: item.label,
      score: Number(item.score ?? 0),
      summary: item.summary,
    })),
  }
}

async function readRowsForTable(table, rowLimit) {
  const common = 'id,embedding,embedding_text_hash,embedding_model,embedding_provider'
  let query
  if (table === 'brain_nodes') {
    query = supabase
      .from(table)
      .select(`${common},type,name,canonical_name,aliases,summary,description,importance_score,frequency_score,confidence_score,cluster_id,metadata,updated_at,last_seen_at`)
      .eq('user_id', userId)
  } else if (table === 'brain_edges') {
    query = supabase
      .from(table)
      .select(`${common},from_node_id,to_node_id,relation_type,summary,weight,confidence_score,metadata,updated_at`)
      .eq('user_id', userId)
  } else if (table === 'agent_memories') {
    query = supabase
      .from(table)
      .select(`${common},memory_type,content,importance_level,stability,sensitivity,updated_at,created_at`)
      .eq('user_id', userId)
  } else if (table === 'raw_entries') {
    query = supabase
      .from(table)
      .select(`${common},title,content,source_origin,source_type,happened_at,updated_at,created_at,processing_status`)
      .eq('user_id', userId)
  } else {
    throw new Error(`Unsupported table: ${table}`)
  }
  const { data, error } = await query
    .order('embedded_at', { ascending: true, nullsFirst: true })
    .order('updated_at', { ascending: false })
    .limit(rowLimit)
  if (error) throw error
  return data ?? []
}

function embeddingText(table, row, maps) {
  if (table === 'brain_nodes') {
    return compact([
      `type: ${row.type}`,
      `name: ${row.name}`,
      `canonical: ${row.canonical_name}`,
      `aliases: ${asArray(row.aliases).join(', ')}`,
      `summary: ${row.summary ?? ''}`,
      `description: ${row.description ?? ''}`,
      `cluster: ${maps.clusterNameById.get(row.cluster_id) ?? ''}`,
      `importance: ${row.importance_score ?? ''}`,
      `frequency: ${row.frequency_score ?? ''}`,
      `confidence: ${row.confidence_score ?? ''}`,
      `review_status: ${row.metadata?.review_status ?? ''}`,
    ])
  }
  if (table === 'brain_edges') {
    return compact([
      `relation: ${row.relation_type}`,
      `from: ${maps.nodeNameById.get(row.from_node_id) ?? row.from_node_id}`,
      `to: ${maps.nodeNameById.get(row.to_node_id) ?? row.to_node_id}`,
      `summary: ${row.summary ?? ''}`,
      `weight: ${row.weight ?? ''}`,
      `confidence: ${row.confidence_score ?? ''}`,
      `review_status: ${row.metadata?.review_status ?? ''}`,
    ])
  }
  if (table === 'agent_memories') {
    return compact([
      `memory_type: ${row.memory_type}`,
      `content: ${row.content}`,
      `importance: ${row.importance_level ?? ''}`,
      `stability: ${row.stability ?? ''}`,
      `sensitivity: ${row.sensitivity ?? ''}`,
    ])
  }
  if (table === 'raw_entries') {
    return compact([
      `title: ${row.title ?? ''}`,
      `content: ${String(row.content ?? '').slice(0, MAX_TEXT_CHARS)}`,
      `source_origin: ${row.source_origin ?? ''}`,
      `source_type: ${row.source_type ?? ''}`,
      `happened_at: ${row.happened_at ?? row.created_at ?? ''}`,
      `processing_status: ${row.processing_status ?? ''}`,
    ])
  }
  return ''
}

async function embedText(text) {
  if (provider === 'openai') return await embedOpenAICompatible(text)
  if (provider === 'ollama') return await embedOllama(text)
  throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}`)
}

async function embedOpenAICompatible(text) {
  const baseUrl = (process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')
  const apiKey = requiredEnv('EMBEDDING_API_KEY', process.env.LLM_API_KEY)
  const body = { model, input: text }
  if (dimensions) body.dimensions = dimensions
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Embedding HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  const embedding = data?.data?.[0]?.embedding
  if (!Array.isArray(embedding)) throw new Error('Embedding response missing data[0].embedding')
  return embedding.map(Number)
}

async function embedOllama(text) {
  const baseUrl = (process.env.EMBEDDING_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  })
  if (!res.ok) throw new Error(`Ollama embedding HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  const embedding = data?.embedding
  if (!Array.isArray(embedding)) throw new Error('Ollama response missing embedding')
  return embedding.map(Number)
}

async function saveEmbedding(table, id, embedding, hash) {
  const { error } = await supabase
    .from(table)
    .update({
      embedding: vectorLiteral(embedding),
      embedding_model: model,
      embedding_provider: provider,
      embedding_text_hash: hash,
      embedded_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

async function readNodeNameMap() {
  const { data, error } = await supabase.from('brain_nodes').select('id,name').eq('user_id', userId)
  if (error) throw error
  return new Map((data ?? []).map((node) => [node.id, node.name]))
}

async function readClusterNameMap() {
  const { data, error } = await supabase.from('brain_clusters').select('id,name').eq('user_id', userId)
  if (error) throw error
  return new Map((data ?? []).map((cluster) => [cluster.id, cluster.name]))
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) {
    console.log('[brain-indexer] Supabase mode: service role local')
    return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  }
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY atau SUPABASE_USER_EMAIL/SUPABASE_USER_PASSWORD untuk brain-indexer.')
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
  throw new Error('Tidak bisa resolve user_id. Set OBSIDIAN_USER_ID untuk brain-indexer.')
}

function writeRunLog(summary) {
  const vault = process.env.BRAIN_VAULT_PATH || resolve(rootDir, 'AhyarBrainVault')
  const day = new Date().toISOString().slice(0, 10)
  const path = resolve(vault, '_system', 'logs', `brain-indexer-${day}.md`)
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

function readTablesArg(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((table) => TARGET_TABLES.includes(table))
}

function compact(lines) {
  return lines.filter((line) => String(line).replace(/^[^:]+:\s*/, '').trim()).join('\n').slice(0, MAX_TEXT_CHARS)
}

function vectorLiteral(values) {
  if (values.length !== dimensions) {
    throw new Error(`Embedding dimension mismatch: got ${values.length}, expected ${dimensions}`)
  }
  return `[${values.map((value) => Number(value).toFixed(8)).join(',')}]`
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

function parseArgs(raw) {
  const parsed = new Map()
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    if (raw[i + 1] && !raw[i + 1].startsWith('--')) {
      parsed.set(key, raw[i + 1])
      i += 1
    } else {
      parsed.set(key, 'true')
    }
  }
  return parsed
}

function readIntArg(name, fallback, min = 1, max = 100000) {
  const raw = argv.get(name)
  const value = raw ? Number(raw) : fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing env ${name}`)
  return value
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

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
