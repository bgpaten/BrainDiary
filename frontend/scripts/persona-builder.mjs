import { createClient } from '@supabase/supabase-js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const AUTO_START = '<!-- BRAIN_PERSONA_AUTO_START -->'
const AUTO_END = '<!-- BRAIN_PERSONA_AUTO_END -->'

loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const argv = parseArgs(process.argv.slice(2))
const force = argv.has('force')
const minEntries = readIntEnv('PERSONA_PROFILE_MIN_ENTRIES', 5, 1, 100)
const maxRawEntries = readIntEnv('PERSONA_PROFILE_MAX_RAW_ENTRIES', 50, 1, 200)
const maxMemories = readIntEnv('PERSONA_PROFILE_MAX_MEMORIES', 100, 1, 300)
const maxReports = readIntEnv('PERSONA_PROFILE_MAX_REPORTS', 10, 0, 50)
const outputObsidian = process.env.PERSONA_PROFILE_OUTPUT_OBSIDIAN !== 'false'
const writeMemory = process.env.PERSONA_PROFILE_WRITE_MEMORY === 'true'
const vaultPath = resolvePath(process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const supabase = await createSupabaseClient()
let userId = ''

try {
  userId = await resolveUserId()
  const brain = await readBrain()
  const profile = buildPersonaProfile(brain)
  if (outputObsidian) writePersonaMarkdown(profile, brain)
  if (writeMemory) await upsertPersonaMemory(profile)
  writeRunLog({ action: 'persona_refresh', force, profile, counts: countBrain(brain) })
  console.log(`[persona-builder] profile_updated=${profile.last_updated} memories=${brain.memories.length} nodes=${brain.nodes.length} raw_entries=${brain.rawEntries.length}`)
  console.log(JSON.stringify({ ok: true, profile_updated: profile.last_updated, counts: countBrain(brain), output_obsidian: outputObsidian }))
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  writeRunLog({ action: 'persona_refresh_failed', error: message })
  console.error(`[persona-builder] failed ${message}`)
  process.exit(1)
}

async function readBrain() {
  const [memoriesRes, nodesRes, rawRes, reportsRes] = await Promise.all([
    supabase
      .from('agent_memories')
      .select('id,memory_type,content,importance_level,stability,sensitivity,source_entry_id,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(maxMemories),
    supabase
      .from('brain_nodes')
      .select('id,type,name,canonical_name,summary,description,importance_score,frequency_score,confidence_score,last_seen_at,metadata')
      .eq('user_id', userId)
      .in('type', ['goal', 'pattern', 'decision', 'project', 'emotion'])
      .order('last_seen_at', { ascending: false, nullsFirst: false })
      .limit(200),
    supabase
      .from('raw_entries')
      .select('id,title,content,source_origin,source_type,happened_at,created_at,processing_status')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(maxRawEntries),
    supabase
      .from('brain_reports')
      .select('id,report_type,title,summary,active_projects,repeated_patterns,decisions,risks,suggested_next_actions,period_end,metadata')
      .eq('user_id', userId)
      .eq('status', 'done')
      .order('period_end', { ascending: false })
      .limit(maxReports),
  ])
  const reportError = reportsRes.error?.code === '42P01' ? null : reportsRes.error
  const firstError = memoriesRes.error || nodesRes.error || rawRes.error || reportError
  if (firstError) throw firstError
  return {
    memories: memoriesRes.data ?? [],
    nodes: nodesRes.data ?? [],
    rawEntries: rawRes.data ?? [],
    reports: reportsRes.error?.code === '42P01' ? [] : reportsRes.data ?? [],
  }
}

function buildPersonaProfile(brain) {
  const projects = topNodes(brain.nodes, 'project', 8).map(labelNode)
  const goals = topNodes(brain.nodes, 'goal', 8).map(labelNode)
  const decisions = topNodes(brain.nodes, 'decision', 8).map((node) => node.summary || labelNode(node))
  const patterns = topNodes(brain.nodes, 'pattern', 10).map((node) => node.summary || labelNode(node))
  const emotions = topNodes(brain.nodes, 'emotion', 8).map(labelNode)
  const coreMemories = brain.memories.filter((memory) => ['identity', 'preference', 'goal', 'pattern', 'decision', 'warning'].includes(memory.memory_type)).slice(0, 20)
  const reports = brain.reports.slice(0, 5)
  const style = inferCommunicationStyle(brain.rawEntries, brain.memories)
  const warnings = []
  if (brain.rawEntries.length < minEntries) warnings.push(`Raw entries hanya ${brain.rawEntries.length}; persona profile masih lemah.`)
  if (brain.memories.length < 5) warnings.push(`Agent memories hanya ${brain.memories.length}; style dan identity belum stabil.`)
  if (brain.nodes.some((node) => Number(node.confidence_score ?? 1) < 0.7)) warnings.push('Sebagian node persona source confidence rendah.')

  return {
    identity_summary: summarizeIdentity(coreMemories, projects, goals),
    active_projects: mergeUnique([
      ...projects,
      ...flatReportItems(reports, 'active_projects', 'name'),
    ]).slice(0, 10),
    goals: mergeUnique([
      ...goals,
      ...coreMemories.filter((memory) => memory.memory_type === 'goal').map((memory) => excerpt(memory.content, 180)),
    ]).slice(0, 10),
    decision_patterns: mergeUnique([
      ...decisions,
      ...coreMemories.filter((memory) => memory.memory_type === 'decision').map((memory) => excerpt(memory.content, 180)),
      ...flatReportItems(reports, 'decisions', 'decision'),
    ]).slice(0, 10),
    repeated_patterns: mergeUnique([
      ...patterns,
      ...coreMemories.filter((memory) => memory.memory_type === 'pattern').map((memory) => excerpt(memory.content, 180)),
      ...flatReportItems(reports, 'repeated_patterns', 'name'),
    ]).slice(0, 12),
    communication_style: style,
    risk_patterns: mergeUnique([
      ...coreMemories.filter((memory) => memory.memory_type === 'warning').map((memory) => excerpt(memory.content, 180)),
      ...flatReportItems(reports, 'risks', 'risk'),
    ]).slice(0, 10),
    ambition_signals: mergeUnique([...goals, ...projects].filter(Boolean)).slice(0, 10),
    values_principles_inferred: inferValues(brain.rawEntries, coreMemories).slice(0, 10),
    current_constraints: mergeUnique([
      ...emotions.map((emotion) => `Emotion signal: ${emotion}`),
      ...flatReportItems(reports, 'risks', 'mitigation'),
    ]).slice(0, 10),
    confidence_warnings: warnings,
    last_updated: new Date().toISOString(),
  }
}

function writePersonaMarkdown(profile, brain) {
  const target = resolve(vaultPath, '_system', 'persona', 'Persona Profile.md')
  const content = renderPersonaMarkdown(profile, brain)
  mkdirSync(dirname(target), { recursive: true })
  if (!existsSync(target)) {
    writeFileSync(target, `${content}\n`, 'utf8')
    return
  }
  const existing = readFileSync(target, 'utf8')
  const auto = content.slice(content.indexOf(AUTO_START), content.indexOf(AUTO_END) + AUTO_END.length)
  const next = existing.includes(AUTO_START) && existing.includes(AUTO_END)
    ? `${existing.slice(0, existing.indexOf(AUTO_START))}${auto}${existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length)}`
    : `${existing.replace(/\s*$/, '\n\n')}${auto}\n`
  writeFileSync(target, next, 'utf8')
}

function renderPersonaMarkdown(profile, brain) {
  return [
    '---',
    'type: persona_profile',
    `last_updated: "${profile.last_updated}"`,
    `raw_entries: ${brain.rawEntries.length}`,
    `agent_memories: ${brain.memories.length}`,
    `brain_nodes: ${brain.nodes.length}`,
    '---',
    '',
    '# Persona Profile',
    '',
    AUTO_START,
    '',
    '## Identity Summary',
    profile.identity_summary,
    '',
    section('Active Projects', profile.active_projects),
    section('Goals', profile.goals),
    section('Decision Patterns', profile.decision_patterns),
    section('Repeated Patterns', profile.repeated_patterns),
    section('Communication Style', profile.communication_style),
    section('Risk Patterns', profile.risk_patterns),
    section('Ambition Signals', profile.ambition_signals),
    section('Values / Principles Inferred', profile.values_principles_inferred),
    section('Current Constraints', profile.current_constraints),
    section('Confidence Warnings', profile.confidence_warnings),
    '## Last Updated',
    profile.last_updated,
    '',
    AUTO_END,
    '',
  ].join('\n')
}

async function upsertPersonaMemory(profile) {
  const content = [
    `Identity summary: ${profile.identity_summary}`,
    `Communication style: ${profile.communication_style.join('; ')}`,
    `Active projects: ${profile.active_projects.join(', ')}`,
    `Repeated patterns: ${profile.repeated_patterns.join('; ')}`,
  ].join('\n')
  const existing = await supabase
    .from('agent_memories')
    .select('id')
    .eq('user_id', userId)
    .eq('memory_type', 'identity')
    .contains('metadata', { persona_profile: true })
    .limit(1)
    .maybeSingle()
  if (existing.error && existing.error.code !== 'PGRST116') throw existing.error
  const payload = {
    user_id: userId,
    memory_type: 'identity',
    content,
    importance_level: 'core',
    stability: 'stable',
    sensitivity: 'private',
    metadata: { persona_profile: true, last_updated: profile.last_updated },
  }
  if (existing.data?.id) {
    const { error } = await supabase.from('agent_memories').update(payload).eq('id', existing.data.id)
    if (error) throw error
  } else {
    const { error } = await supabase.from('agent_memories').insert(payload)
    if (error) throw error
  }
}

function topNodes(nodes, type, limit) {
  return nodes
    .filter((node) => node.type === type && !['ignored', 'deleted', 'merged'].includes(node.metadata?.review_status))
    .sort((a, b) => Number(b.importance_score ?? 0) + Number(b.frequency_score ?? 0) - Number(a.importance_score ?? 0) - Number(a.frequency_score ?? 0))
    .slice(0, limit)
}

function labelNode(node) {
  return node.summary || node.canonical_name || node.name
}

function summarizeIdentity(memories, projects, goals) {
  const identity = memories.find((memory) => memory.memory_type === 'identity')?.content
  if (identity) return excerpt(identity, 500)
  const parts = []
  if (projects.length) parts.push(`Aktif membangun ${projects.slice(0, 3).join(', ')}.`)
  if (goals.length) parts.push(`Goal dominan: ${goals.slice(0, 3).join(', ')}.`)
  return parts.length ? parts.join(' ') : 'Persona belum cukup kuat; butuh lebih banyak diary, memory, dan report yang sudah direview.'
}

function inferCommunicationStyle(rawEntries, memories) {
  const text = [...rawEntries.slice(0, 20).map((entry) => entry.content), ...memories.slice(0, 20).map((memory) => memory.content)].join(' ').toLowerCase()
  const style = ['langsung dan praktis']
  if (text.includes('mvp') || text.includes('validasi')) style.push('sering berpikir dalam MVP, validasi, dan iterasi')
  if (text.includes('scope') || text.includes('planning') || text.includes('fase')) style.push('mudah masuk ke planning detail dan perlu scope guard')
  if (text.includes('target') || text.includes('fokus')) style.push('menyukai target eksplisit dan fokus eksekusi')
  if (text.includes('bingung') || text.includes('lelah')) style.push('perlu jawaban yang menurunkan noise dan memaksa prioritas')
  return mergeUnique(style).slice(0, 8)
}

function inferValues(rawEntries, memories) {
  const text = [...rawEntries.map((entry) => entry.content), ...memories.map((memory) => memory.content)].join(' ').toLowerCase()
  const values = []
  if (text.includes('local') || text.includes('obsidian')) values.push('local-first dan data tetap bisa dibaca manusia')
  if (text.includes('rapi') || text.includes('struktur')) values.push('struktur yang rapi dan bisa diaudit')
  if (text.includes('mvp') || text.includes('validasi')) values.push('validasi output kecil sebelum ekspansi')
  if (text.includes('keluarga') || text.includes('pasangan')) values.push('keputusan hidup dan relasi personal ikut memengaruhi prioritas')
  return values.length ? values : ['Belum cukup data untuk menyimpulkan values dengan confidence tinggi.']
}

function flatReportItems(reports, field, key) {
  return reports.flatMap((report) => Array.isArray(report[field]) ? report[field].map((item) => item?.[key]).filter(Boolean).map(String) : [])
}

function section(title, items) {
  const lines = [`## ${title}`]
  if (!items.length) lines.push('- Belum cukup data.')
  else lines.push(...items.map((item) => `- ${item}`))
  lines.push('')
  return lines.join('\n')
}

function mergeUnique(items) {
  const seen = new Set()
  return items.map((item) => String(item ?? '').trim()).filter((item) => {
    if (!item || seen.has(item.toLowerCase())) return false
    seen.add(item.toLowerCase())
    return true
  })
}

function countBrain(brain) {
  return { memories: brain.memories.length, nodes: brain.nodes.length, raw_entries: brain.rawEntries.length, reports: brain.reports.length }
}

function writeRunLog(payload) {
  const logDir = resolve(vaultPath, '_system', 'logs')
  mkdirSync(logDir, { recursive: true })
  const file = resolve(logDir, `persona-builder-${new Date().toISOString().slice(0, 10)}.md`)
  appendFileSync(file, `\n## ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`, 'utf8')
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  })
  if (accessToken) return client
  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, atau SUPABASE_USER_EMAIL/SUPABASE_USER_PASSWORD.')
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

async function resolveUserId() {
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  if (process.env.SUPABASE_USER_ID) return process.env.SUPABASE_USER_ID
  const { data } = await supabase.auth.getUser()
  if (data?.user?.id) return data.user.id
  const latest = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (latest.error) throw latest.error
  if (latest.data?.user_id) return latest.data.user_id
  throw new Error('Tidak bisa menentukan user_id untuk persona-builder.')
}

function excerpt(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function parseArgs(items) {
  const map = new Map()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item.startsWith('--')) continue
    const next = items[index + 1]
    map.set(item.slice(2), next && !next.startsWith('--') ? next : 'true')
    if (next && !next.startsWith('--')) index += 1
  }
  return { get: (key) => map.get(key), has: (key) => map.has(key) }
}

function readIntEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function resolvePath(value) {
  return resolve(process.cwd(), value)
}

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing env ${name}`)
  return value
}

function loadEnv(path, options = {}) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    if (!options.override && process.env[match[1]]) continue
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}
