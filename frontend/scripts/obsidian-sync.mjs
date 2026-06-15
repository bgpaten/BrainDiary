import { createClient } from '@supabase/supabase-js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const AUTO_START = '<!-- BRAIN_OS_AUTO_START -->'
const AUTO_END = '<!-- BRAIN_OS_AUTO_END -->'
const NODE_TYPES = ['person', 'place', 'event', 'project', 'decision', 'emotion', 'goal', 'pattern', 'organization', 'topic', 'tool', 'document']
const FOLDER_BY_TYPE = {
  person: '10_People',
  project: '20_Projects',
  place: '30_Places',
  event: '40_Events',
  decision: '50_Decisions',
  pattern: '60_Patterns',
  goal: '70_Goals',
  organization: '90_Knowledge/Organizations',
  tool: '90_Knowledge/Tools',
  topic: '90_Knowledge/Topics',
  document: '90_Knowledge/Documents',
  emotion: '90_Knowledge/Emotions',
  unknown: '90_Knowledge/Misc',
}

loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const argv = parseArgs(process.argv.slice(2))
const watch = argv.has('watch')
const limit = readIntArg('limit', Number(process.env.OBSIDIAN_SYNC_LIMIT ?? 100), 1, 500)
const dryRun = argv.has('dry-run') || process.env.OBSIDIAN_SYNC_DRY_RUN === 'true'
const onlyType = argv.get('type') ?? ''
const onlyNodeId = argv.get('node-id') ?? ''
const indexesOnly = argv.has('indexes-only')
const force = argv.has('force')
const writeIndexes = process.env.OBSIDIAN_SYNC_WRITE_INDEXES !== 'false'
const includeLowConfidence = process.env.OBSIDIAN_SYNC_INCLUDE_LOW_CONFIDENCE !== 'false'
const pollMs = readIntArg('interval-ms', Number(process.env.OBSIDIAN_SYNC_INTERVAL_MS ?? 60000), 10000, 600000)

const vaultPath = resolvePath(process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const supabase = await createSupabaseClient()
const userId = await resolveUserId()

do {
  const summary = await runSync()
  console.log(`[obsidian-sync] nodes=${summary.nodes_read} created=${summary.created} updated=${summary.updated} skipped=${summary.skipped} indexes=${summary.indexes}`)
  if (!dryRun) writeRunLog(summary)
  if (!watch) break
  await sleep(pollMs)
} while (true)

async function runSync() {
  const startedAt = new Date().toISOString()
  const brain = await readBrain()
  const fileIndex = scanExistingNodeFiles(vaultPath)
  const pathByNodeId = new Map()
  const nodeById = new Map(brain.nodes.map((node) => [node.id, node]))
  const clusterById = new Map(brain.clusters.map((cluster) => [cluster.id, cluster]))
  const rawById = new Map(brain.rawEntries.map((entry) => [entry.id, entry]))
  const usedPaths = new Set(fileIndex.pathByNodeId.values())

  for (const node of brain.nodes) {
    const existing = fileIndex.pathByNodeId.get(node.id)
    const target = existing ?? uniqueNodePath(node, usedPaths)
    pathByNodeId.set(node.id, target)
    usedPaths.add(target)
  }

  const summary = {
    started_at: startedAt,
    dry_run: dryRun,
    indexes_only: indexesOnly,
    nodes_read: brain.nodes.length,
    created: 0,
    updated: 0,
    skipped: 0,
    indexes: 0,
    errors: [],
    entries: [],
  }

  if (!indexesOnly) {
    for (const node of brain.nodes) {
      try {
        if (!includeLowConfidence && Number(node.confidence_score ?? 1) < 0.7) {
          summary.skipped += 1
          summary.entries.push({ status: 'skipped', node: node.name, reason: 'low confidence' })
          continue
        }
        const target = pathByNodeId.get(node.id)
        const content = renderNodeFile(node, brain.edges, nodeById, clusterById, rawById, pathByNodeId)
        const result = writeNodeFile(target, node, content)
        summary[result] += 1
        summary.entries.push({ status: result, node: node.name, path: toVaultRelative(target) })
        console.log(`[obsidian-sync] ${result} ${toVaultRelative(target)}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        summary.errors.push({ node_id: node.id, error: message })
        console.error(`[obsidian-sync] failed ${node.name}: ${message}`)
      }
    }
  }

  if (writeIndexes) {
    const count = writeIndexPages(brain.nodes, pathByNodeId)
    summary.indexes = count
  }

  return summary
}

async function readBrain() {
  let nodeQuery = supabase
    .from('brain_nodes')
    .select('id,type,name,canonical_name,aliases,summary,description,importance_score,frequency_score,confidence_score,cluster_id,first_seen_at,last_seen_at,source_entry_id,metadata,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (onlyType) nodeQuery = nodeQuery.eq('type', onlyType)
  if (onlyNodeId) nodeQuery = nodeQuery.eq('id', onlyNodeId)

  const [nodesRes, edgesRes, clustersRes, rawRes] = await Promise.all([
    nodeQuery,
    supabase.from('brain_edges').select('id,from_node_id,to_node_id,relation_type,summary,weight,confidence_score,source_entry_id,metadata').eq('user_id', userId),
    supabase.from('brain_clusters').select('id,name,slug,description').eq('user_id', userId),
    supabase.from('raw_entries').select('id,title,obsidian_path,source_origin,happened_at,created_at').eq('user_id', userId).limit(1000),
  ])
  const firstError = nodesRes.error || edgesRes.error || clustersRes.error || rawRes.error
  if (firstError) throw firstError
  return {
    nodes: nodesRes.data ?? [],
    edges: edgesRes.data ?? [],
    clusters: clustersRes.data ?? [],
    rawEntries: rawRes.data ?? [],
  }
}

function renderNodeFile(node, edges, nodeById, clusterById, rawById, pathByNodeId) {
  const cluster = clusterById.get(node.cluster_id)
  const outgoing = edges.filter((edge) => edge.from_node_id === node.id)
  const incoming = edges.filter((edge) => edge.to_node_id === node.id)
  const reviewStatus = getReviewStatus(node)
  const fm = {
    type: node.type,
    brain_node_id: node.id,
    canonical_name: node.canonical_name,
    aliases: asArray(node.aliases),
    brain_type: node.type,
    cluster: cluster?.slug ?? cluster?.name ?? '',
    importance_score: node.importance_score,
    frequency_score: node.frequency_score,
    confidence_score: node.confidence_score,
    review_status: reviewStatus,
    first_seen_at: node.first_seen_at,
    last_seen_at: node.last_seen_at,
    updated_by_brain_sync: new Date().toISOString(),
  }
  const lines = [
    '---',
    stringifyFrontmatter(fm).trimEnd(),
    '---',
    '',
    `# ${node.name || node.canonical_name}`,
    '',
    AUTO_START,
    '',
    '## Ringkasan',
    node.summary || node.description || 'Belum ada ringkasan.',
    '',
  ]

  if (reviewStatus === 'merged') {
    const targetId = node.metadata?.merge_target_node_id ?? node.metadata?.merged_into_node_id
    const target = targetId ? nodeById.get(targetId) : null
    lines.push('## Status Merge', target ? `Node ini sudah digabung ke ${wikiLink(target, pathByNodeId)}.` : 'Node ini ditandai sudah digabung.')
    lines.push('')
  }

  lines.push('## Relasi Terkait', '', '### Keluar')
  if (outgoing.length) {
    for (const edge of outgoing) {
      const target = nodeById.get(edge.to_node_id)
      lines.push(`- ${edge.relation_type} → ${target ? wikiLink(target, pathByNodeId) : edge.to_node_id}${edge.summary ? ` — ${edge.summary}` : ''}`)
    }
  } else {
    lines.push('- Belum ada relasi keluar.')
  }

  lines.push('', '### Masuk')
  if (incoming.length) {
    for (const edge of incoming) {
      const source = nodeById.get(edge.from_node_id)
      lines.push(`- ${edge.relation_type} ← ${source ? wikiLink(source, pathByNodeId) : edge.from_node_id}${edge.summary ? ` — ${edge.summary}` : ''}`)
    }
  } else {
    lines.push('- Belum ada relasi masuk.')
  }

  lines.push('', '## Sumber')
  const sourceIds = new Set([node.source_entry_id, ...outgoing.map((edge) => edge.source_entry_id), ...incoming.map((edge) => edge.source_entry_id)].filter(Boolean))
  const sources = [...sourceIds].map((id) => rawById.get(id)).filter(Boolean)
  if (sources.length) {
    for (const source of sources.slice(0, 12)) lines.push(`- ${sourceLink(source)}`)
  } else {
    lines.push('- Belum ada sumber terhubung.')
  }

  lines.push(
    '',
    '## Metadata Brain',
    `- Type: ${node.type}`,
    `- Importance: ${node.importance_score ?? '—'}`,
    `- Frequency: ${node.frequency_score ?? '—'}`,
    `- Confidence: ${node.confidence_score ?? '—'}`,
    `- Review: ${reviewStatus}`,
    '',
    AUTO_END,
    '',
  )
  return lines.join('\n')
}

function writeNodeFile(target, node, generated) {
  if (!existsSync(dirname(target))) {
    if (!dryRun) mkdirSync(dirname(target), { recursive: true })
  }
  if (!existsSync(target)) {
    if (!dryRun) writeFileSync(target, `${generated}\n`, 'utf8')
    return 'created'
  }
  const existing = readFileSync(target, 'utf8')
  const withFrontmatter = replaceFrontmatter(existing, generated)
  const updated = replaceAutoSection(withFrontmatter, generated)
  if (updated === existing && !force) return 'skipped'
  if (!dryRun) writeFileSync(target, updated, 'utf8')
  return 'updated'
}

function replaceFrontmatter(existing, generated) {
  const generatedMatch = generated.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!generatedMatch) return existing
  const generatedFrontmatter = generatedMatch[0].replace(/\s*$/, '\n\n')
  if (existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)) {
    return existing.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, generatedFrontmatter)
  }
  return `${generatedFrontmatter}${existing.replace(/^\n+/, '')}`
}

function replaceAutoSection(existing, generated) {
  const generatedAuto = generated.slice(generated.indexOf(AUTO_START), generated.indexOf(AUTO_END) + AUTO_END.length)
  if (existing.includes(AUTO_START) && existing.includes(AUTO_END)) {
    const before = existing.slice(0, existing.indexOf(AUTO_START))
    const after = existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length)
    return `${before}${generatedAuto}${after}`
  }
  return `${existing.replace(/\s*$/, '\n\n')}${generatedAuto}\n`
}

function writeIndexPages(nodes, pathByNodeId) {
  const indexDir = join(vaultPath, '_system', 'indexes')
  const indexes = [
    { file: 'All Brain Nodes.md', title: 'All Brain Nodes', filter: () => true },
    { file: 'Projects.md', title: 'Projects', filter: (node) => node.type === 'project' },
    { file: 'People.md', title: 'People', filter: (node) => node.type === 'person' },
    { file: 'Patterns.md', title: 'Patterns', filter: (node) => node.type === 'pattern' },
    { file: 'Goals.md', title: 'Goals', filter: (node) => node.type === 'goal' },
    { file: 'Recent Changes.md', title: 'Recent Changes', filter: () => true, recent: true },
  ]
  let written = 0
  if (!dryRun) mkdirSync(indexDir, { recursive: true })
  for (const index of indexes) {
    const selected = nodes
      .filter(index.filter)
      .filter((node) => getReviewStatus(node) !== 'ignored')
      .sort((a, b) => index.recent
        ? new Date(b.last_seen_at ?? b.updated_at ?? 0).getTime() - new Date(a.last_seen_at ?? a.updated_at ?? 0).getTime()
        : String(a.name).localeCompare(String(b.name)))
      .slice(0, index.recent ? 50 : 500)
    const lines = [
      `# ${index.title}`,
      '',
      `Updated: ${new Date().toISOString()}`,
      '',
      '| Node | Type | Summary | Last seen | Frequency | Confidence | Review |',
      '|---|---|---|---|---:|---:|---|',
      ...selected.map((node) => `| ${wikiLink(node, pathByNodeId)} | ${node.type} | ${escapeTable(node.summary ?? '')} | ${node.last_seen_at ?? ''} | ${node.frequency_score ?? ''} | ${node.confidence_score ?? ''} | ${getReviewStatus(node)} |`),
      '',
    ]
    const path = join(indexDir, index.file)
    if (!dryRun) writeFileSync(path, lines.join('\n'), 'utf8')
    written += 1
  }
  return written
}

function scanExistingNodeFiles(dir) {
  const pathByNodeId = new Map()
  const files = scanMarkdownFiles(dir)
  for (const file of files) {
    if (relative(vaultPath, file).startsWith(`00_Diary${sep}`)) continue
    const parsed = parseMarkdown(readFileSync(file, 'utf8'))
    const id = parsed.frontmatter?.brain_node_id
    if (typeof id === 'string' && id) pathByNodeId.set(id, file)
  }
  return { pathByNodeId }
}

function uniqueNodePath(node, usedPaths) {
  const folder = FOLDER_BY_TYPE[node.type] ?? FOLDER_BY_TYPE.unknown
  const baseDir = join(vaultPath, folder)
  const baseName = sanitizeFilename(node.canonical_name || node.name || node.id)
  let candidate = join(baseDir, `${baseName}.md`)
  if (!usedPaths.has(candidate) && !existsSync(candidate)) return candidate
  candidate = join(baseDir, `${baseName}-${node.type}.md`)
  if (!usedPaths.has(candidate) && !existsSync(candidate)) return candidate
  return join(baseDir, `${baseName}-${String(node.id).slice(0, 8)}.md`)
}

function wikiLink(node, pathByNodeId) {
  const path = pathByNodeId.get(node.id)
  const filename = path ? basenameNoExt(path) : sanitizeFilename(node.canonical_name || node.name)
  const label = node.canonical_name || node.name
  return filename === label ? `[[${filename}]]` : `[[${filename}|${label}]]`
}

function sourceLink(source) {
  if (source.obsidian_path) return `[[${source.obsidian_path.replace(/\.md$/i, '')}|${source.title ?? source.obsidian_path}]]`
  return source.title ?? source.id
}

function getReviewStatus(node) {
  const explicit = node.metadata?.review_status
  if (['pending_review', 'approved', 'ignored', 'merged', 'deleted'].includes(explicit)) return explicit
  return Number(node.confidence_score ?? 1) < 0.7 ? 'pending_review' : 'unreviewed'
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY atau SUPABASE_USER_EMAIL/SUPABASE_USER_PASSWORD untuk obsidian sync.')
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

async function resolveUserId() {
  const explicit = process.env.OBSIDIAN_USER_ID ?? process.env.SUPABASE_USER_ID ?? process.env.BRAIN_USER_ID
  if (explicit) return explicit
  const { data } = await supabase.auth.getUser()
  if (data?.user?.id) return data.user.id
  const latest = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (latest.error) throw latest.error
  if (latest.data?.user_id) return latest.data.user_id
  throw new Error('OBSIDIAN_USER_ID wajib disetel saat memakai service role dan belum ada raw_entries.')
}

function parseMarkdown(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: null, body: text }
  return { frontmatter: parseFrontmatter(match[1]), body: match[2] ?? '' }
}

function parseFrontmatter(yamlText) {
  const fm = {}
  let currentKey = ''
  for (const line of yamlText.split(/\r?\n/)) {
    if (!line.trim()) continue
    const listMatch = line.match(/^\s+-\s+(.*)$/)
    if (listMatch && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = []
      fm[currentKey].push(parseYamlValue(listMatch[1]))
      continue
    }
    const idx = line.indexOf(':')
    if (idx === -1) continue
    currentKey = line.slice(0, idx).trim()
    const raw = line.slice(idx + 1).trim()
    fm[currentKey] = raw === '' ? '' : parseYamlValue(raw)
  }
  return fm
}

function stringifyFrontmatter(fm) {
  const preferred = ['type', 'brain_node_id', 'canonical_name', 'aliases', 'brain_type', 'cluster', 'importance_score', 'frequency_score', 'confidence_score', 'review_status', 'first_seen_at', 'last_seen_at', 'updated_by_brain_sync']
  const keys = [...preferred.filter((key) => key in fm), ...Object.keys(fm).filter((key) => !preferred.includes(key))]
  return keys.map((key) => `${key}: ${formatYamlValue(fm[key])}\n`).join('')
}

function formatYamlValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `\n${value.map((item) => `  - ${formatYamlScalar(item)}`).join('\n')}`
  }
  return formatYamlScalar(value)
}

function formatYamlScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (value === null || value === undefined || value === '') return ''
  const s = String(value)
  if (/[":#\n]|^\s|\s$/.test(s)) return JSON.stringify(s)
  return s
}

function parseYamlValue(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1)
  const n = Number(raw)
  if (Number.isFinite(n) && raw !== '') return n
  return raw
}

function writeRunLog(summary) {
  const day = new Date().toISOString().slice(0, 10)
  const logDir = join(vaultPath, '_system', 'logs')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, `obsidian-sync-${day}.md`)
  appendFileSync(logFile, [
    `\n## ${new Date().toISOString()}`,
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    '',
  ].join('\n'), 'utf8')
}

function scanMarkdownFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...scanMarkdownFiles(full))
    else if (st.isFile() && name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

function sanitizeFilename(value) {
  return String(value ?? 'Untitled')
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim() || 'Untitled'
}

function escapeTable(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 140)
}

function basenameNoExt(path) {
  return path.split(sep).pop()?.replace(/\.md$/i, '') ?? path
}

function toVaultRelative(file) {
  return relative(vaultPath, file).split(sep).join('/')
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : []
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

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
