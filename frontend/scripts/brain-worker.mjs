import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NODE_TYPES = [
  'person', 'place', 'event', 'project', 'decision', 'emotion',
  'goal', 'pattern', 'organization', 'topic', 'tool', 'document',
]

const RELATION_TYPES = [
  'works_on', 'related_to', 'met_with', 'mentioned', 'happened_at',
  'happened_in', 'decided', 'caused', 'feels_about', 'has_pattern',
  'wants_to_achieve', 'uses', 'belongs_to_cluster', 'blocked_by',
  'needs_validation',
]

const MEMORY_TYPES = ['preference', 'identity', 'decision', 'lesson', 'warning', 'goal', 'pattern', 'context']
const IMPORTANCE_LEVELS = ['low', 'normal', 'important', 'core']
const STABILITY_LEVELS = ['temporary', 'normal', 'stable', 'core']
const SENSITIVITY_LEVELS = ['public', 'private', 'sensitive']

const SYSTEM_PROMPT = `Kamu adalah Brain Engine untuk sistem "Personal Brain OS".
Tugasmu: membaca satu catatan diary mentah lalu mengekstrak NODE (entitas) dan EDGE (relasi) yang BENAR-BENAR ada di teks.

ATURAN WAJIB:
- Jangan mengarang fakta. Jangan membuat node/edge tanpa bukti dari teks diary.
- Tipe node yang boleh: ${NODE_TYPES.join(', ')}.
- Tipe relasi yang boleh: ${RELATION_TYPES.join(', ')}.
- Bedakan event, decision, goal, dan pattern secara ketat.
- canonical_name harus rapi dan konsisten; sistem akan menormalkannya untuk anti-duplikasi.
- Setiap node dan edge punya confidence_score 0..1.
- Setiap node punya importance_score 0..1.
- Setiap edge punya weight >= 0.
- Setiap endpoint edge wajib ada juga di array nodes dengan type dan canonical_name yang sama.
- cluster_slug opsional. Cluster yang sudah ada: "personal-brain-os", "nusaops", "career".
- agent_memories opsional; fokus importance_level "important" atau "core".
- Jika tidak ada yang bisa diekstrak, kembalikan nodes dan edges array kosong.

Balas HANYA JSON valid, tanpa markdown, tanpa komentar, dengan bentuk:
{
  "nodes": [
    {
      "type": "project",
      "name": "Personal Brain OS",
      "canonical_name": "Personal Brain OS",
      "aliases": [],
      "summary": "Ringkas dalam Bahasa Indonesia",
      "description": "Opsional",
      "importance_score": 0.8,
      "confidence_score": 0.9,
      "cluster_slug": "personal-brain-os",
      "metadata": {}
    }
  ],
  "edges": [
    {
      "from": { "type": "project", "canonical_name": "Personal Brain OS" },
      "to": { "type": "tool", "canonical_name": "Supabase" },
      "relation_type": "uses",
      "summary": "Ringkas dalam Bahasa Indonesia",
      "weight": 1,
      "confidence_score": 0.9,
      "metadata": {}
    }
  ],
  "agent_memories": []
}`

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
// Worker env adalah konfigurasi paling spesifik dan harus menang dari shell/env lain.
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const args = new Set(process.argv.slice(2))
const limit = readIntArg('--limit', Number(process.env.BRAIN_WORKER_LIMIT ?? 5))
const rawEntryId = readStringArg('--raw-entry-id', process.env.BRAIN_WORKER_RAW_ENTRY_ID ?? '')
const sourceOrigin = readStringArg('--source-origin', '')
const statusFilter = readStringArg('--status', '')
const watch = args.has('--watch')
const intervalMs = readIntArg('--interval-ms', Number(process.env.BRAIN_WORKER_INTERVAL_MS ?? 15000))

const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const provider = (process.env.LLM_PROVIDER ?? 'claude-code').toLowerCase()

const supabase = await createSupabaseClient()
console.log(`[brain-worker] LLM provider: ${provider}`)
console.log(`[brain-worker] Claude env: ANTHROPIC_API_KEY=${fingerprint(process.env.ANTHROPIC_API_KEY)}, ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL ?? 'unset'}`)

while (true) {
  const result = await processBatch(limit, rawEntryId)
  console.log(`[brain-worker] processed=${result.processed} done=${result.done} failed=${result.failed}`)
  if (!watch) break
  await sleep(intervalMs)
}

async function processBatch(batchLimit, onlyRawEntryId) {
  const statusList = statusFilter
    ? statusFilter.split(',').map((s) => s.trim()).filter(Boolean)
    : ['pending', 'failed']
  let query = supabase
    .from('raw_entries')
    .select('*')
    .eq('source_type', 'text')
    .in('processing_status', statusList)
    .order('created_at', { ascending: true })
    .limit(batchLimit)
  if (onlyRawEntryId) query = query.eq('id', onlyRawEntryId)
  if (sourceOrigin) query = query.eq('source_origin', sourceOrigin)

  const { data: entries, error } = await query

  if (error) throw error
  if (!entries?.length) return { processed: 0, done: 0, failed: 0 }

  let done = 0
  let failed = 0
  for (const entry of entries) {
    try {
      await processEntry(entry)
      done += 1
      console.log(`[brain-worker] done raw_entry=${entry.id}`)
    } catch (err) {
      failed += 1
      console.error(`[brain-worker] failed raw_entry=${entry.id}: ${messageOf(err)}`)
    }
  }
  return { processed: entries.length, done, failed }
}

async function processEntry(entry) {
  if (!entry.user_id) throw new Error('raw_entries.user_id kosong')
  if (!entry.content || !String(entry.content).trim()) throw new Error('raw_entries.content kosong')

  const { data: job, error: jobErr } = await supabase
    .from('extraction_jobs')
    .insert({
      user_id: entry.user_id,
      raw_entry_id: entry.id,
      job_type: 'diary_extract',
      status: 'processing',
      started_at: new Date().toISOString(),
      input_snapshot: { title: entry.title, content_length: String(entry.content).length, worker: 'local' },
    })
    .select('id')
    .single()
  if (jobErr) throw jobErr

  await must(
    supabase
      .from('raw_entries')
      .update({ processing_status: 'processing' })
      .eq('id', entry.id),
  )

  try {
    const rawExtraction = await callLLM(String(entry.content))
    const clean = validateExtraction(rawExtraction)

    const idByKey = new Map()
    for (const node of clean.nodes) {
      const clusterId = node.cluster_slug ? await resolveCluster(entry.user_id, node.cluster_slug) : null
      const id = await upsertNode(entry.user_id, entry.id, node, clusterId)
      idByKey.set(nodeKey(node.type, node.canonical_name), id)
    }

    let edgeCount = 0
    for (const edge of clean.edges) {
      const fromId =
        idByKey.get(nodeKey(edge.from.type, edge.from.canonical_name)) ??
        (await findNodeId(entry.user_id, edge.from.type, edge.from.canonical_name))
      const toId =
        idByKey.get(nodeKey(edge.to.type, edge.to.canonical_name)) ??
        (await findNodeId(entry.user_id, edge.to.type, edge.to.canonical_name))
      if (!fromId || !toId || fromId === toId) continue
      await upsertEdge(entry.user_id, entry.id, fromId, toId, edge)
      edgeCount += 1
    }

    let memoryCount = 0
    for (const memory of clean.agent_memories) {
      if (!['important', 'core'].includes(memory.importance_level)) continue
      await must(supabase.from('agent_memories').insert({
        user_id: entry.user_id,
        memory_type: memory.memory_type,
        content: memory.content,
        importance_level: memory.importance_level,
        stability: memory.stability,
        sensitivity: memory.sensitivity,
        source_entry_id: entry.id,
      }))
      memoryCount += 1
    }

    const now = new Date().toISOString()
    await must(
      supabase
        .from('raw_entries')
        .update({ processed: true, processing_status: 'done', processed_at: now, updated_at: now })
        .eq('id', entry.id),
    )
    await must(
      supabase
        .from('extraction_jobs')
        .update({
          status: 'done',
          finished_at: now,
          output_snapshot: { ...rawExtraction, worker_stats: { nodes: clean.nodes.length, edges: edgeCount, agent_memories: memoryCount } },
        })
        .eq('id', job.id),
    )
  } catch (err) {
    const msg = messageOf(err)
    await markFailed(entry.id, job.id, msg)
    throw err
  }
}

async function callLLM(content) {
  if (provider === 'claude-code') return await callClaudeCode(content)
  if (provider === 'anthropic') return await callAnthropic(content)
  if (provider === 'openai') return await callOpenAICompatible(content)
  if (provider === 'ollama') return await callOllama(content)
  throw new Error(`LLM_PROVIDER tidak dikenal: ${provider}`)
}

async function callClaudeCode(content) {
  const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
  const prompt = buildPrompt(content)
  const settingsArg = process.env.CLAUDE_CODE_API_KEY_HELPER === 'false'
    ? []
    : [
        '--settings',
        JSON.stringify({
          apiKeyHelper: 'node -e "process.stdout.write(process.env.ANTHROPIC_API_KEY || \'\')"',
        }),
      ]
  const commandArgs = [
    ...(process.env.CLAUDE_CODE_BARE === 'false' ? [] : ['--bare']),
    ...settingsArg,
    '--no-session-persistence',
    '--output-format',
    'text',
    '-p',
    prompt,
  ]
  const output = await runCommand(command, commandArgs, {
    timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000),
  })
  return parseJsonOrThrow(output, 'Claude Code')
}

async function callAnthropic(content) {
  const baseUrl = requiredEnv('LLM_BASE_URL', process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('LLM_API_KEY', process.env.ANTHROPIC_API_KEY)
  const model = requiredEnv('LLM_MODEL', process.env.ANTHROPIC_MODEL)
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    : ''
  return parseJsonOrThrow(text, 'Anthropic')
}

async function callOpenAICompatible(content) {
  const baseUrl = requiredEnv('LLM_BASE_URL').replace(/\/+$/, '')
  const apiKey = requiredEnv('LLM_API_KEY')
  const model = requiredEnv('LLM_MODEL')
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return parseJsonOrThrow(data?.choices?.[0]?.message?.content ?? '', 'OpenAI-compatible')
}

async function callOllama(content) {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = requiredEnv('OLLAMA_MODEL')
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: buildPrompt(content),
      stream: false,
      format: 'json',
    }),
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return parseJsonOrThrow(data.response ?? '', 'Ollama')
}

function buildPrompt(content) {
  return `${SYSTEM_PROMPT}\n\nDIARY MENTAH:\n${content}\n\nBalas hanya JSON valid.`
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) {
    console.log('[brain-worker] Supabase mode: service_role local')
    return createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  })

  if (accessToken) {
    console.log('[brain-worker] Supabase mode: user access token')
    return client
  }

  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) {
    throw new Error(
      'Set SUPABASE_SERVICE_ROLE_KEY, atau pakai auth user dengan SUPABASE_USER_EMAIL dan SUPABASE_USER_PASSWORD.',
    )
  }

  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  console.log(`[brain-worker] Supabase mode: signed-in user ${data.user?.email ?? data.user?.id}`)
  return client
}

async function resolveCluster(userId, slug) {
  const { data, error } = await supabase
    .from('brain_clusters')
    .select('id')
    .eq('user_id', userId)
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

async function findNodeId(userId, type, canonicalRaw) {
  const { data, error } = await supabase
    .from('brain_nodes')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type)
    .eq('canonical_name', canonicalize(canonicalRaw))
    .maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

async function upsertNode(userId, entryId, node, clusterId) {
  const now = new Date().toISOString()
  const canon = canonicalize(node.canonical_name)
  const { data: existing, error: findErr } = await supabase
    .from('brain_nodes')
    .select('id, summary, description, frequency_score, importance_score, aliases, cluster_id')
    .eq('user_id', userId)
    .eq('type', node.type)
    .eq('canonical_name', canon)
    .maybeSingle()
  if (findErr) throw findErr

  if (existing) {
    const mergedAliases = [...new Set([...(existing.aliases ?? []), ...node.aliases, node.name])].filter(Boolean)
    const betterDesc =
      node.description && (!existing.description || node.description.length > existing.description.length)
        ? node.description
        : existing.description
    await must(
      supabase
        .from('brain_nodes')
        .update({
          name: node.name,
          summary: node.summary ?? existing.summary,
          description: betterDesc,
          frequency_score: Number(existing.frequency_score ?? 0) + 1,
          importance_score: Math.max(Number(existing.importance_score ?? 0), node.importance_score),
          confidence_score: node.confidence_score,
          last_seen_at: now,
          aliases: mergedAliases,
          updated_at: now,
          ...(clusterId && !existing.cluster_id ? { cluster_id: clusterId } : {}),
        })
        .eq('id', existing.id),
    )
    return existing.id
  }

  const { data: inserted, error } = await supabase
    .from('brain_nodes')
    .insert({
      user_id: userId,
      type: node.type,
      name: node.name,
      canonical_name: canon,
      aliases: [...new Set([...node.aliases, node.name])].filter(Boolean),
      summary: node.summary,
      description: node.description,
      importance_score: node.importance_score,
      frequency_score: 1,
      confidence_score: node.confidence_score,
      cluster_id: clusterId,
      first_seen_at: now,
      last_seen_at: now,
      source_entry_id: entryId,
      metadata: node.metadata,
    })
    .select('id')
    .single()
  if (error) throw error
  return inserted.id
}

async function upsertEdge(userId, entryId, fromId, toId, edge) {
  const now = new Date().toISOString()
  const { data: existing, error: findErr } = await supabase
    .from('brain_edges')
    .select('id, weight')
    .eq('user_id', userId)
    .eq('from_node_id', fromId)
    .eq('to_node_id', toId)
    .eq('relation_type', edge.relation_type)
    .maybeSingle()
  if (findErr) throw findErr

  if (existing) {
    await must(
      supabase
        .from('brain_edges')
        .update({
          weight: Number(existing.weight ?? 1) + 1,
          summary: edge.summary,
          confidence_score: edge.confidence_score,
          updated_at: now,
        })
        .eq('id', existing.id),
    )
    return
  }

  await must(supabase.from('brain_edges').insert({
    user_id: userId,
    from_node_id: fromId,
    to_node_id: toId,
    relation_type: edge.relation_type,
    summary: edge.summary,
    weight: edge.weight,
    confidence_score: edge.confidence_score,
    source_entry_id: entryId,
    metadata: edge.metadata,
  }))
}

async function markFailed(entryId, jobId, message) {
  const rawResult = await supabase
    .from('raw_entries')
    .update({ processing_status: 'failed' })
    .eq('id', entryId)

  const jobResult = await supabase
    .from('extraction_jobs')
    .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message })
    .eq('id', jobId)

  if (rawResult.error || jobResult.error) {
    throw new Error([
      message,
      rawResult.error ? `raw_entries update failed: ${rawResult.error.message}` : null,
      jobResult.error ? `extraction_jobs update failed: ${jobResult.error.message}` : null,
    ].filter(Boolean).join(' | '))
  }
}

function validateExtraction(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Output LLM bukan objek JSON valid.')
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : []
  const rawMems = Array.isArray(raw.agent_memories) ? raw.agent_memories : []

  const nodes = []
  for (const item of rawNodes) {
    if (!item || typeof item !== 'object') continue
    const type = String(item.type ?? '')
    const name = String(item.name ?? '').trim()
    if (!NODE_TYPES.includes(type) || !name) continue
    const canonical = String(item.canonical_name ?? name).trim() || name
    nodes.push({
      type,
      name,
      canonical_name: canonical,
      aliases: Array.isArray(item.aliases) ? item.aliases.map(String).filter(Boolean) : [],
      summary: item.summary ? String(item.summary) : null,
      description: item.description ? String(item.description) : null,
      importance_score: scaleImportance(item.importance_score),
      confidence_score: scaleConfidence(item.confidence_score),
      cluster_slug: item.cluster_slug ? String(item.cluster_slug) : null,
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    })
  }

  const nodeKeys = new Set(nodes.map((n) => nodeKey(n.type, n.canonical_name)))
  const edges = []
  for (const item of rawEdges) {
    if (!item || typeof item !== 'object') continue
    const from = item.from
    const to = item.to
    if (!from || !to) continue
    const fType = String(from.type ?? '')
    const tType = String(to.type ?? '')
    const fCanon = String(from.canonical_name ?? '').trim()
    const tCanon = String(to.canonical_name ?? '').trim()
    const rel = String(item.relation_type ?? '').trim()
    if (!NODE_TYPES.includes(fType) || !NODE_TYPES.includes(tType)) continue
    if (!fCanon || !tCanon || !RELATION_TYPES.includes(rel)) continue
    if (!nodeKeys.has(nodeKey(fType, fCanon)) || !nodeKeys.has(nodeKey(tType, tCanon))) continue
    edges.push({
      from: { type: fType, canonical_name: fCanon },
      to: { type: tType, canonical_name: tCanon },
      relation_type: rel,
      summary: item.summary ? String(item.summary) : null,
      weight: scaleWeight(item.weight),
      confidence_score: scaleConfidence(item.confidence_score),
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    })
  }

  const agent_memories = []
  for (const item of rawMems) {
    if (!item || typeof item !== 'object') continue
    const content = String(item.content ?? '').trim()
    const memory_type = String(item.memory_type ?? '')
    if (!content || !MEMORY_TYPES.includes(memory_type)) continue
    agent_memories.push({
      memory_type,
      content,
      importance_level: IMPORTANCE_LEVELS.includes(String(item.importance_level)) ? String(item.importance_level) : 'normal',
      stability: STABILITY_LEVELS.includes(String(item.stability)) ? String(item.stability) : 'normal',
      sensitivity: SENSITIVITY_LEVELS.includes(String(item.sensitivity)) ? String(item.sensitivity) : 'private',
    })
  }

  return { nodes, edges, agent_memories }
}

function canonicalize(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '')
}

function nodeKey(type, canonical) {
  return `${type}::${canonicalize(canonical)}`
}

function scaleImportance(value) {
  const n = typeof value === 'number' ? value : 0.5
  const scaled = n <= 1 ? n * 100 : n
  return round(clamp(scaled, 0, 100))
}

function scaleConfidence(value) {
  const n = typeof value === 'number' ? value : 0.6
  return round(clamp(n > 1 ? n / 100 : n, 0, 1))
}

function scaleWeight(value) {
  const n = typeof value === 'number' ? value : 1
  return round(clamp(n, 0, 10))
}

function clamp(n, min, max) {
  if (Number.isNaN(n)) return min
  return Math.max(min, Math.min(max, n))
}

function round(n) {
  return Math.round(n * 100) / 100
}

async function must(query) {
  const result = await query
  if (result.error) throw result.error
  return result
}

function parseJsonOrThrow(text, source) {
  const parsed = parseJsonObject(String(text ?? ''))
  if (!parsed) throw new Error(`${source} tidak mengembalikan JSON valid. Output: ${String(text ?? '').slice(0, 500)}`)
  return parsed
}

function parseJsonObject(text) {
  const candidates = [text.trim(), stripJsonFence(text), extractJsonObject(text)].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Try next candidate.
    }
  }
  return null
}

function stripJsonFence(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return match?.[1]?.trim() ?? null
}

function extractJsonObject(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

function runCommand(command, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timeout setelah ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} exit ${code}: ${stderr || stdout}`))
    })
  })
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

function readStringArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] || fallback
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}

function present(value) {
  return value ? 'set' : 'unset'
}

function fingerprint(value) {
  if (!value) return 'unset'
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}
