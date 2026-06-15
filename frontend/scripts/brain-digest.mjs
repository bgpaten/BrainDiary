import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const AUTO_START = '<!-- BRAIN_DIGEST_AUTO_START -->'
const AUTO_END = '<!-- BRAIN_DIGEST_AUTO_END -->'
const REPORT_TYPES = new Set(['daily', 'weekly', 'monthly', 'custom'])

const SYSTEM_PROMPT = `Kamu adalah Brain Digest Analyst untuk Personal Brain OS.

Tugasmu:
- Menganalisis memory user berdasarkan context periode tertentu.
- Jangan mengarang fakta di luar context.
- Bedakan fakta, inferensi, dan rekomendasi.
- Beri insight yang tajam, bukan motivasi kosong.
- Fokus pada perubahan, pola berulang, keputusan, risiko, dan next action.
- Jika data kurang, tulis bahwa data belum cukup.
- Jangan menyarankan aksi besar berdasarkan data lemah.
- Prioritaskan memory dengan confidence tinggi dan review_status approved.
- Jika ada data low confidence, beri warning.

Balas hanya JSON valid dengan bentuk:
{
  "title": "Weekly Brain Digest 2026-06-06 - 2026-06-12",
  "summary": "Ringkasan utama periode ini.",
  "highlights": [{"title":"...","description":"...","source_refs":[]}],
  "active_projects": [{"name":"...","status":"active","evidence":"...","risk":"..."}],
  "repeated_patterns": [{"name":"...","severity":"medium","evidence":"...","recommendation":"..."}],
  "decisions": [{"decision":"...","status":"active","impact":"..."}],
  "risks": [{"risk":"...","severity":"medium","mitigation":"..."}],
  "suggested_next_actions": ["..."],
  "memory_quality": {"low_confidence_nodes":0,"low_confidence_edges":0,"failed_entries":0,"warnings":[]},
  "source_refs": [{"type":"raw_entry","id":"uuid","label":"Diary 2026-06-12"}]
}`

loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const argv = parseArgs(process.argv.slice(2))
const watch = argv.has('watch')
const force = argv.has('force')
const requestedType = argv.get('type') ?? 'daily'
if (!REPORT_TYPES.has(requestedType)) throw new Error(`Invalid digest type: ${requestedType}`)

const pollMs = readIntArg('interval-ms', 60000, 10000, 600000)
const limits = {
  raw_entries: readIntEnv('BRAIN_DIGEST_LIMIT_RAW_ENTRIES', 50, 1, 300),
  nodes: readIntEnv('BRAIN_DIGEST_LIMIT_NODES', 50, 1, 300),
  edges: readIntEnv('BRAIN_DIGEST_LIMIT_EDGES', 100, 1, 600),
  memories: readIntEnv('BRAIN_DIGEST_LIMIT_MEMORIES', 50, 1, 300),
}

const vaultPath = resolvePath(process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const outputObsidian = process.env.BRAIN_DIGEST_OUTPUT_OBSIDIAN !== 'false'
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const provider = (process.env.BRAIN_DIGEST_PROVIDER ?? process.env.BRAIN_CHAT_PROVIDER ?? process.env.LLM_PROVIDER ?? 'claude-code').toLowerCase()
const modelName = process.env.BRAIN_DIGEST_MODEL ?? process.env.BRAIN_CHAT_MODEL ?? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.OLLAMA_MODEL ?? 'default'
const supabase = await createSupabaseClient()
const userId = await resolveUserId()

do {
  const result = await runDigest()
  if (!watch) {
    console.log(JSON.stringify(result))
    break
  }
  await sleep(pollMs)
} while (true)

async function runDigest() {
  const period = resolvePeriod(requestedType, argv.get('from'), argv.get('to'))
  console.log(`[brain-digest] type=${period.type} period=${period.start}..${period.end}`)

  try {
    const existing = await findExistingReport(period)
    if (existing && !force) {
      console.log(`[brain-digest] existing report_id=${existing.id}; use --force to regenerate`)
      return {
        ok: true,
        status: 'skipped_existing',
        report_id: existing.id,
        title: existing.title,
        summary: existing.summary,
      }
    }

    const context = await readDigestContext(period)
    const generated = await generateReport(context, period)
    const saved = await saveReport(period, generated, context, existing?.id)
    if (outputObsidian) writeReportMarkdown(period, saved, generated)
    writeRunLog({ period, report_id: saved.id, title: saved.title, context_summary: summarizeContext(context), provider, model: modelName })
    console.log(`[brain-digest] report_id=${saved.id}`)
    console.log(`[brain-digest] done title=${saved.title}`)
    return {
      ok: true,
      report_id: saved.id,
      title: saved.title,
      summary: saved.summary,
      status: saved.status,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    writeRunLog({ period, status: 'failed', error: message })
    console.error(`[brain-digest] failed ${message}`)
    throw err
  }
}

async function findExistingReport(period) {
  const { data, error } = await supabase
    .from('brain_reports')
    .select('id,title,summary,status,created_at')
    .eq('user_id', userId)
    .eq('report_type', period.type)
    .eq('period_start', period.start)
    .eq('period_end', period.end)
    .maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

async function readDigestContext(period) {
  const [rawRes, nodesRes, edgesRes, memoriesRes, jobsRes, clustersRes] = await Promise.all([
    supabase
      .from('raw_entries')
      .select('id,title,content,source_origin,source_type,happened_at,processing_status,obsidian_path,created_at,updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limits.raw_entries * 4),
    supabase
      .from('brain_nodes')
      .select('id,type,name,canonical_name,aliases,summary,description,importance_score,frequency_score,confidence_score,cluster_id,first_seen_at,last_seen_at,source_entry_id,metadata,created_at,updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(limits.nodes * 4),
    supabase
      .from('brain_edges')
      .select('id,from_node_id,to_node_id,relation_type,summary,weight,confidence_score,source_entry_id,metadata,created_at,updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(limits.edges * 3),
    supabase
      .from('agent_memories')
      .select('id,memory_type,content,importance_level,stability,sensitivity,source_entry_id,source_node_id,valid_from,valid_until,created_at,updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limits.memories * 4),
    supabase
      .from('extraction_jobs')
      .select('id,raw_entry_id,job_type,status,error_message,created_at,finished_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('brain_clusters')
      .select('id,name,slug,description,priority')
      .eq('user_id', userId),
  ])
  const firstError = rawRes.error || nodesRes.error || edgesRes.error || memoriesRes.error || jobsRes.error || clustersRes.error
  if (firstError) throw firstError

  const rawEntries = (rawRes.data ?? []).filter((entry) => inPeriod(entry.happened_at ?? entry.created_at, period)).slice(0, limits.raw_entries)
  const nodes = (nodesRes.data ?? [])
    .filter((node) => inPeriod(node.last_seen_at ?? node.first_seen_at ?? node.updated_at ?? node.created_at, period))
    .slice(0, limits.nodes)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const sourceEntryIds = new Set(rawEntries.map((entry) => entry.id))
  const edges = (edgesRes.data ?? [])
    .filter((edge) => nodeIds.has(edge.from_node_id) || nodeIds.has(edge.to_node_id) || sourceEntryIds.has(edge.source_entry_id))
    .slice(0, limits.edges)
  const memories = (memoriesRes.data ?? [])
    .filter((memory) => inPeriod(memory.valid_from ?? memory.created_at, period) || sourceEntryIds.has(memory.source_entry_id) || nodeIds.has(memory.source_node_id))
    .slice(0, limits.memories)
  const jobs = (jobsRes.data ?? []).filter((job) => inPeriod(job.created_at ?? job.finished_at, period))
  const clusters = clustersRes.data ?? []
  const nodeById = new Map((nodesRes.data ?? []).map((node) => [node.id, node]))
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]))

  return {
    period,
    limits,
    raw_entries: rawEntries.map(formatRawEntry),
    brain_nodes: nodes.map((node) => formatNode(node, clusterById)),
    brain_edges: edges.map((edge) => formatEdge(edge, nodeById)),
    agent_memories: memories.map(formatMemory),
    extraction_jobs: jobs.map(formatJob),
    brain_clusters: clusters,
    quality: buildQualityWarnings(rawEntries, nodes, edges, jobs),
  }
}

async function generateReport(context, period) {
  const fallback = buildFallbackReport(context, period)
  if (provider === 'disabled') return fallback

  try {
    const prompt = [
      SYSTEM_PROMPT,
      '',
      `Periode: ${period.type} ${period.start} sampai ${period.end}`,
      'Context digest JSON:',
      JSON.stringify(context, null, 2),
    ].join('\n')
    const text = await callLLM(prompt)
    return normalizeReport(parseJsonFromText(text), fallback, context)
  } catch (err) {
    return {
      ...fallback,
      memory_quality: {
        ...fallback.memory_quality,
        warnings: [...fallback.memory_quality.warnings, `LLM fallback dipakai: ${err instanceof Error ? err.message : String(err)}`],
      },
    }
  }
}

async function saveReport(period, generated, context, existingId) {
  const payload = {
    user_id: userId,
    report_type: period.type,
    period_start: period.start,
    period_end: period.end,
    title: generated.title,
    summary: generated.summary,
    content: renderContentText(generated),
    highlights: asArray(generated.highlights),
    active_projects: asArray(generated.active_projects),
    repeated_patterns: asArray(generated.repeated_patterns),
    decisions: asArray(generated.decisions),
    risks: asArray(generated.risks),
    suggested_next_actions: asArray(generated.suggested_next_actions),
    source_refs: asArray(generated.source_refs),
    model_provider: provider,
    model_name: modelName,
    status: 'done',
    metadata: {
      generated_at: new Date().toISOString(),
      memory_quality: generated.memory_quality,
      context_summary: summarizeContext(context),
    },
  }

  if (existingId) {
    const { data, error } = await supabase.from('brain_reports').update(payload).eq('id', existingId).select('*').single()
    if (error) throw error
    return data
  }

  const { data, error } = await supabase.from('brain_reports').insert(payload).select('*').single()
  if (error) throw error
  return data
}

function writeReportMarkdown(period, saved, generated) {
  const dir = resolve(vaultPath, '_system', 'reports', period.type === 'custom' ? 'custom' : `${period.type}${period.type.endsWith('ly') ? '' : 'ly'}`)
  const target = resolve(dir, reportFilename(period))
  const generatedContent = renderReportMarkdown(period, saved, generated)
  if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true })
  if (!existsSync(target)) {
    writeFileSync(target, `${generatedContent}\n`, 'utf8')
    return
  }
  const existing = readFileSync(target, 'utf8')
  const auto = generatedContent.slice(generatedContent.indexOf(AUTO_START), generatedContent.indexOf(AUTO_END) + AUTO_END.length)
  const next = existing.includes(AUTO_START) && existing.includes(AUTO_END)
    ? `${existing.slice(0, existing.indexOf(AUTO_START))}${auto}${existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length)}`
    : `${existing.replace(/\s*$/, '\n\n')}${auto}\n`
  writeFileSync(target, next, 'utf8')
}

function renderReportMarkdown(period, saved, report) {
  const lines = [
    '---',
    'type: brain_report',
    `report_type: ${period.type}`,
    `period_start: ${period.start}`,
    `period_end: ${period.end}`,
    `brain_report_id: "${saved.id}"`,
    `generated_at: "${new Date().toISOString()}"`,
    'status: done',
    '---',
    '',
    `# ${report.title}`,
    '',
    AUTO_START,
    '',
    '## Summary',
    report.summary || 'Data belum cukup untuk ringkasan kuat.',
    '',
    '## Highlights',
    ...renderObjectList(report.highlights, (item) => `- **${item.title ?? 'Highlight'}**: ${item.description ?? ''}`),
    '',
    '## Active Projects',
    ...renderObjectList(report.active_projects, (item) => `- **${item.name ?? 'Project'}** (${item.status ?? 'unknown'}): ${item.evidence ?? ''}${item.risk ? ` Risk: ${item.risk}` : ''}`),
    '',
    '## Repeated Patterns',
    ...renderObjectList(report.repeated_patterns, (item) => `- **${item.name ?? 'Pattern'}** [${item.severity ?? 'unknown'}]: ${item.evidence ?? ''}${item.recommendation ? ` Recommendation: ${item.recommendation}` : ''}`),
    '',
    '## Decisions',
    ...renderObjectList(report.decisions, (item) => `- **${item.decision ?? 'Decision'}** (${item.status ?? 'unknown'}): ${item.impact ?? ''}`),
    '',
    '## Risks',
    ...renderObjectList(report.risks, (item) => `- **${item.risk ?? 'Risk'}** [${item.severity ?? 'unknown'}]: ${item.mitigation ?? ''}`),
    '',
    '## Suggested Next Actions',
    ...renderStringList(report.suggested_next_actions),
    '',
    '## Memory Quality',
    `- Low confidence nodes: ${report.memory_quality?.low_confidence_nodes ?? 0}`,
    `- Low confidence edges: ${report.memory_quality?.low_confidence_edges ?? 0}`,
    `- Failed entries: ${report.memory_quality?.failed_entries ?? 0}`,
    ...renderStringList(report.memory_quality?.warnings ?? []),
    '',
    '## Sources',
    ...renderObjectList(report.source_refs, (source) => `- ${source.type ?? 'source'}: ${source.label ?? source.id ?? 'unknown'}`),
    '',
    AUTO_END,
    '',
  ]
  return lines.join('\n')
}

function buildFallbackReport(context, period) {
  const projects = context.brain_nodes
    .filter((node) => node.type === 'project')
    .sort((a, b) => Number(b.frequency_score ?? 0) - Number(a.frequency_score ?? 0))
    .slice(0, 5)
  const patterns = context.brain_nodes
    .filter((node) => node.type === 'pattern')
    .sort((a, b) => Number(b.frequency_score ?? 0) - Number(a.frequency_score ?? 0))
    .slice(0, 5)
  const decisions = context.brain_nodes.filter((node) => node.type === 'decision').slice(0, 5)
  const sourceRefs = [
    ...context.raw_entries.slice(0, 8).map((entry) => ({ type: 'raw_entry', id: entry.id, label: entry.title || entry.happened_at || 'Raw entry' })),
    ...context.brain_nodes.slice(0, 8).map((node) => ({ type: 'brain_node', id: node.id, label: node.canonical_name || node.name })),
  ]
  const title = `${capitalize(period.type)} Brain Digest ${period.start}${period.end !== period.start ? ` - ${period.end}` : ''}`
  const dataPoints = context.raw_entries.length + context.brain_nodes.length + context.agent_memories.length
  return {
    title,
    summary: dataPoints
      ? `Digest dibuat dari ${context.raw_entries.length} raw entries, ${context.brain_nodes.length} nodes, ${context.brain_edges.length} edges, dan ${context.agent_memories.length} memories pada periode ini.`
      : 'Memory yang tersedia belum cukup untuk membuat digest yang kuat.',
    highlights: context.raw_entries.slice(0, 5).map((entry) => ({
      title: entry.title || 'Raw entry',
      description: entry.excerpt || 'Entry muncul pada periode ini.',
      source_refs: [{ type: 'raw_entry', id: entry.id, label: entry.title || entry.id }],
    })),
    active_projects: projects.map((node) => ({
      name: node.canonical_name || node.name,
      status: 'active',
      evidence: node.summary || `Frequency ${node.frequency_score ?? 0}, importance ${node.importance_score ?? 0}.`,
      risk: Number(node.confidence_score ?? 1) < 0.7 ? 'Confidence rendah, review dulu sebelum dipakai untuk keputusan.' : '',
    })),
    repeated_patterns: patterns.map((node) => ({
      name: node.canonical_name || node.name,
      severity: Number(node.importance_score ?? 0) >= 0.8 ? 'high' : 'medium',
      evidence: node.summary || `Pattern muncul dengan frequency ${node.frequency_score ?? 0}.`,
      recommendation: 'Validasi pattern ini dengan diary berikutnya sebelum membuat aksi besar.',
    })),
    decisions: decisions.map((node) => ({
      decision: node.summary || node.canonical_name || node.name,
      status: 'active',
      impact: node.description || 'Decision node muncul pada periode ini.',
    })),
    risks: context.quality.warnings.map((warning) => ({ risk: warning, severity: 'medium', mitigation: 'Review item bermasalah sebelum memakai agent untuk keputusan penting.' })),
    suggested_next_actions: [
      'Review low-confidence node/edge yang muncul pada periode ini.',
      'Gunakan Brain Chat untuk menanyakan satu pola utama sebelum menambah fitur baru.',
      'Tulis diary berikutnya dengan keputusan dan blocker yang eksplisit.',
    ],
    memory_quality: {
      low_confidence_nodes: context.quality.low_confidence_nodes,
      low_confidence_edges: context.quality.low_confidence_edges,
      failed_entries: context.quality.failed_entries,
      warnings: context.quality.warnings,
    },
    source_refs: sourceRefs,
  }
}

function normalizeReport(candidate, fallback, context) {
  const report = typeof candidate === 'object' && candidate ? candidate : {}
  return {
    title: stringOr(report.title, fallback.title),
    summary: stringOr(report.summary, fallback.summary),
    highlights: asArray(report.highlights).length ? asArray(report.highlights) : fallback.highlights,
    active_projects: asArray(report.active_projects).length ? asArray(report.active_projects) : fallback.active_projects,
    repeated_patterns: asArray(report.repeated_patterns).length ? asArray(report.repeated_patterns) : fallback.repeated_patterns,
    decisions: asArray(report.decisions).length ? asArray(report.decisions) : fallback.decisions,
    risks: asArray(report.risks).length ? asArray(report.risks) : fallback.risks,
    suggested_next_actions: asArray(report.suggested_next_actions).length ? asArray(report.suggested_next_actions).map(String) : fallback.suggested_next_actions,
    memory_quality: {
      low_confidence_nodes: Number(report.memory_quality?.low_confidence_nodes ?? context.quality.low_confidence_nodes),
      low_confidence_edges: Number(report.memory_quality?.low_confidence_edges ?? context.quality.low_confidence_edges),
      failed_entries: Number(report.memory_quality?.failed_entries ?? context.quality.failed_entries),
      warnings: asArray(report.memory_quality?.warnings).map(String).concat(context.quality.warnings.filter((warning) => !asArray(report.memory_quality?.warnings).includes(warning))),
    },
    source_refs: asArray(report.source_refs).length ? asArray(report.source_refs) : fallback.source_refs,
  }
}

async function callLLM(prompt) {
  if (provider === 'claude-code') return await callClaudeCode(prompt)
  if (provider === 'anthropic') return await callAnthropic(prompt)
  if (provider === 'openai') return await callOpenAICompatible(prompt)
  if (provider === 'ollama') return await callOllama(prompt)
  throw new Error(`Unsupported BRAIN_DIGEST_PROVIDER: ${provider}`)
}

async function callClaudeCode(prompt) {
  const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
  const args = process.env.CLAUDE_CODE_BARE === 'false'
    ? ['--print', '--output-format', 'text']
    : ['--print']
  return await spawnWithInput(command, args, prompt, readIntEnv('CLAUDE_CODE_TIMEOUT_MS', 180000, 10000, 600000))
}

async function callAnthropic(prompt) {
  const baseUrl = (process.env.BRAIN_DIGEST_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')
  const apiKey = requiredEnv('BRAIN_DIGEST_API_KEY', process.env.ANTHROPIC_API_KEY)
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data?.content?.map((part) => part.text ?? '').join('\n') ?? ''
}

async function callOpenAICompatible(prompt) {
  const baseUrl = (process.env.BRAIN_DIGEST_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')
  const apiKey = requiredEnv('BRAIN_DIGEST_API_KEY', process.env.LLM_API_KEY)
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

async function callOllama(prompt) {
  const baseUrl = (process.env.BRAIN_DIGEST_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data?.message?.content ?? ''
}

function resolvePeriod(type, fromArg, toArg) {
  if (fromArg || toArg || type === 'custom') {
    const from = parseDateOnly(fromArg)
    const to = parseDateOnly(toArg)
    if (!from || !to) throw new Error('Custom digest membutuhkan --from YYYY-MM-DD dan --to YYYY-MM-DD.')
    if (from > to) throw new Error('--from tidak boleh setelah --to.')
    return { type, start: from, end: to }
  }
  const now = new Date()
  if (type === 'daily') {
    const today = dateOnly(now)
    return { type, start: today, end: today }
  }
  if (type === 'weekly') {
    const start = startOfIsoWeek(now)
    const end = addDays(start, 6)
    return { type, start: dateOnly(start), end: dateOnly(end) }
  }
  if (type === 'monthly') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    return { type, start: dateOnly(start), end: dateOnly(end) }
  }
  throw new Error(`Invalid digest type: ${type}`)
}

function formatRawEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    excerpt: excerpt(entry.content, 900),
    source_origin: entry.source_origin,
    source_type: entry.source_type,
    happened_at: entry.happened_at,
    processing_status: entry.processing_status,
    obsidian_path: entry.obsidian_path,
  }
}

function formatNode(node, clusterById) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    canonical_name: node.canonical_name,
    aliases: node.aliases ?? [],
    summary: node.summary,
    description: excerpt(node.description, 800),
    importance_score: node.importance_score,
    frequency_score: node.frequency_score,
    confidence_score: node.confidence_score,
    review_status: getReviewStatus(node),
    first_seen_at: node.first_seen_at,
    last_seen_at: node.last_seen_at,
    cluster: clusterById.get(node.cluster_id)?.slug ?? clusterById.get(node.cluster_id)?.name ?? null,
    source_entry_id: node.source_entry_id,
  }
}

function formatEdge(edge, nodeById) {
  const from = nodeById.get(edge.from_node_id)
  const to = nodeById.get(edge.to_node_id)
  return {
    id: edge.id,
    from_node_id: edge.from_node_id,
    from_node: from?.canonical_name ?? from?.name ?? edge.from_node_id,
    relation_type: edge.relation_type,
    to_node_id: edge.to_node_id,
    to_node: to?.canonical_name ?? to?.name ?? edge.to_node_id,
    summary: edge.summary,
    weight: edge.weight,
    confidence_score: edge.confidence_score,
    source_entry_id: edge.source_entry_id,
  }
}

function formatMemory(memory) {
  return {
    id: memory.id,
    memory_type: memory.memory_type,
    content: excerpt(memory.content, 900),
    importance_level: memory.importance_level,
    stability: memory.stability,
    sensitivity: memory.sensitivity,
    valid_from: memory.valid_from,
    valid_until: memory.valid_until,
    source_entry_id: memory.source_entry_id,
    source_node_id: memory.source_node_id,
  }
}

function formatJob(job) {
  return {
    id: job.id,
    raw_entry_id: job.raw_entry_id,
    job_type: job.job_type,
    status: job.status,
    error_message: job.error_message,
    created_at: job.created_at,
    finished_at: job.finished_at,
  }
}

function buildQualityWarnings(rawEntries, nodes, edges, jobs) {
  const lowNodes = nodes.filter((node) => Number(node.confidence_score ?? 1) < 0.7).length
  const lowEdges = edges.filter((edge) => Number(edge.confidence_score ?? 1) < 0.7).length
  const failedEntries = rawEntries.filter((entry) => ['failed', 'needs_review'].includes(entry.processing_status)).length
  const failedJobs = jobs.filter((job) => ['failed', 'needs_review'].includes(job.status)).length
  const duplicateCandidates = countDuplicateCandidates(nodes)
  const warnings = []
  if (lowNodes) warnings.push(`${lowNodes} node confidence rendah perlu review.`)
  if (lowEdges) warnings.push(`${lowEdges} edge confidence rendah perlu review.`)
  if (failedEntries) warnings.push(`${failedEntries} raw entry failed/needs_review.`)
  if (failedJobs) warnings.push(`${failedJobs} extraction job failed/needs_review.`)
  if (duplicateCandidates) warnings.push(`${duplicateCandidates} kandidat duplicate node terdeteksi secara sederhana.`)
  return { low_confidence_nodes: lowNodes, low_confidence_edges: lowEdges, failed_entries: failedEntries, failed_jobs: failedJobs, duplicate_candidates: duplicateCandidates, warnings }
}

function countDuplicateCandidates(nodes) {
  const seen = new Map()
  let count = 0
  for (const node of nodes) {
    const key = `${node.type}:${normalizeName(node.canonical_name || node.name)}`
    if (!key.endsWith(':')) {
      if (seen.has(key)) count += 1
      seen.set(key, true)
    }
  }
  return count
}

function renderContentText(report) {
  return [
    report.summary,
    ...asArray(report.highlights).map((item) => `${item.title ?? 'Highlight'}: ${item.description ?? ''}`),
    ...asArray(report.suggested_next_actions).map((item) => `Next: ${item}`),
  ].filter(Boolean).join('\n\n')
}

function reportFilename(period) {
  if (period.type === 'daily') return `${period.start} Daily Brain Digest.md`
  if (period.type === 'weekly') return `${isoWeekLabel(new Date(`${period.start}T00:00:00.000Z`))} Weekly Brain Digest.md`
  if (period.type === 'monthly') return `${period.start.slice(0, 7)} Monthly Brain Digest.md`
  return `${period.start} to ${period.end} Brain Digest.md`
}

function summarizeContext(context) {
  return {
    raw_entries: context.raw_entries.length,
    nodes: context.brain_nodes.length,
    edges: context.brain_edges.length,
    memories: context.agent_memories.length,
    extraction_jobs: context.extraction_jobs.length,
    quality: context.quality,
  }
}

function writeRunLog(payload) {
  const logDir = resolve(vaultPath, '_system', 'logs')
  mkdirSync(logDir, { recursive: true })
  const file = resolve(logDir, `brain-digest-${dateOnly(new Date())}.md`)
  appendFileSync(file, `\n## ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`, 'utf8')
}

async function createSupabaseClient() {
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
  throw new Error('Supabase credential tidak tersedia. Isi SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, atau SUPABASE_USER_EMAIL/PASSWORD di env lokal.')
}

async function resolveUserId() {
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  if (process.env.SUPABASE_USER_ID) return process.env.SUPABASE_USER_ID
  const { data: userData } = await supabase.auth.getUser()
  if (userData?.user?.id) return userData.user.id
  const { data, error } = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  if (data?.user_id) return data.user_id
  throw new Error('Tidak bisa menentukan user_id untuk digest.')
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

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

function readIntEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function readIntArg(key, fallback, min, max) {
  const value = Number(argv.get(key) ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function resolvePath(value) {
  return resolve(process.cwd(), value)
}

function inPeriod(value, period) {
  if (!value) return false
  const day = dateOnly(new Date(value))
  return day >= period.start && day <= period.end
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function parseDateOnly(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? '' : value
}

function startOfIsoWeek(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() - day + 1)
  return utc
}

function addDays(date, days) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function isoWeekLabel(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNr = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function excerpt(value, max = 600) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function getReviewStatus(item) {
  const status = item?.metadata?.review_status
  if (typeof status === 'string') return status
  return Number(item?.confidence_score ?? 1) < 0.7 ? 'pending_review' : 'unreviewed'
}

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
    throw new Error('LLM output bukan JSON valid.')
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function renderStringList(items) {
  const list = asArray(items).filter(Boolean)
  return list.length ? list.map((item) => `- ${String(item)}`) : ['- Tidak ada data kuat.']
}

function renderObjectList(items, render) {
  const list = asArray(items)
  return list.length ? list.map(render) : ['- Tidak ada data kuat.']
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function spawnWithInput(command, args, input, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout.trim())
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`))
    })
    child.stdin.end(input)
  })
}
