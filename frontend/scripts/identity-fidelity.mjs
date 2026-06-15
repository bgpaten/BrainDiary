import { createClient } from '@supabase/supabase-js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const AUTO_START = '<!-- IDENTITY_FIDELITY_AUTO_START -->'
const AUTO_END = '<!-- IDENTITY_FIDELITY_AUTO_END -->'
const FACT_TYPES = new Set(['trait', 'belief', 'value', 'preference', 'goal', 'fear', 'ambition', 'decision_pattern', 'communication_pattern', 'emotional_pattern', 'risk_pattern', 'contradiction', 'boundary', 'identity_summary'])
const STABILITY = ['temporary', 'recurring', 'stable', 'core']
const STRENGTH = ['weak', 'medium', 'strong', 'core']
const POLARITY = new Set(['positive', 'negative', 'neutral', 'mixed'])
const DEFAULT_SCOPE = ['chat', 'persona', 'strategic_mirror', 'response_inference']
const SYSTEM_PROMPT = `Kamu adalah Identity Fidelity Extractor untuk Personal Entity OS.

Tugasmu:
- Mengekstrak model identitas pemilik diary dari data yang tersedia.
- Jangan mengarang trait, belief, value, preference, atau pola yang tidak punya evidence.
- Jangan membuat pemilik diary terlihat lebih ideal dari data.
- Jangan membuat pemilik diary terlihat lebih buruk dari data.
- Bedakan fakta kuat, pola berulang, dan inferensi lemah.
- Semua identity fact harus punya evidence_refs.
- Confidence rendah jika evidence sedikit.
- Confidence tinggi hanya jika pola berulang atau sangat eksplisit.
- Jika data tidak cukup, buat warning, bukan klaim.
- Output hanya JSON valid.`

loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env.local'), { override: true })

const args = parseArgs(process.argv.slice(2))
const command = args.has('audit') ? 'audit' : args.has('snapshot') ? 'snapshot' : args.has('refresh') ? 'refresh' : 'build'
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const provider = (process.env.IDENTITY_PROVIDER || process.env.BRAIN_CHAT_PROVIDER || process.env.BRAIN_DIGEST_PROVIDER || process.env.LLM_PROVIDER || 'claude-code').toLowerCase()
const modelName = process.env.IDENTITY_MODEL || process.env.BRAIN_CHAT_MODEL || process.env.BRAIN_DIGEST_MODEL || process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || process.env.OLLAMA_MODEL || ''
const useLlm = readBoolEnv('IDENTITY_USE_LLM', true) && provider !== 'disabled'
const outputObsidian = readBoolEnv('IDENTITY_OUTPUT_OBSIDIAN', true)
const minConfidence = readNumberEnv('IDENTITY_MIN_CONFIDENCE', 0.45, 0, 1)
const coreConfidence = readNumberEnv('IDENTITY_CORE_CONFIDENCE', 0.85, 0, 1)
const limits = {
  rawEntries: readIntArg('limit', readIntEnv('IDENTITY_MAX_RAW_ENTRIES', 100, 1, 500), 1, 500),
  memories: readIntEnv('IDENTITY_MAX_MEMORIES', 100, 1, 500),
  reports: readIntEnv('IDENTITY_MAX_REPORTS', 20, 0, 100),
  nodes: readIntEnv('IDENTITY_MAX_NODES', 200, 1, 500),
}
const fromDate = readOptionalArg('from')
const toDate = readOptionalArg('to')
const supabase = await createSupabaseClient()
let userId = ''

try {
  userId = await resolveUserId()
  if (command === 'audit') {
    const audit = await auditIdentity()
    console.log(JSON.stringify(audit))
  } else if (command === 'snapshot') {
    const brain = await readBrain()
    const snapshot = await createSnapshot(brain, ['Manual identity snapshot.'])
    if (outputObsidian) writeIdentityMarkdown(await readIdentityFacts(), snapshot, brain)
    console.log(JSON.stringify({ ok: true, action: 'snapshot', snapshot_id: snapshot.id, status: snapshot.status }))
  } else {
    const brain = await readBrain()
    const extraction = await extractIdentity(brain)
    const upserted = await upsertIdentityFacts(extraction.identity_facts ?? [])
    const snapshot = (command === 'refresh' || args.has('snapshot') || readBoolArg('snapshot', true))
      ? await createSnapshot(brain, extraction.warnings ?? [])
      : null
    if (outputObsidian) writeIdentityMarkdown(await readIdentityFacts(), snapshot, brain, extraction.warnings ?? [])
    writeRunLog({ action: command, counts: countBrain(brain), facts_upserted: upserted.length, warnings: extraction.warnings ?? [] })
    console.log(JSON.stringify({ ok: true, action: command, facts_upserted: upserted.length, snapshot_id: snapshot?.id ?? null, warnings: extraction.warnings ?? [], counts: countBrain(brain) }))
  }
} catch (err) {
  const message = formatError(err)
  writeRunLog({ action: `${command}_failed`, error: message })
  console.error(`[identity-fidelity] failed ${message}`)
  process.exit(1)
}

async function readBrain() {
  const rawQuery = supabase
    .from('raw_entries')
    .select('id,title,content,source_origin,source_type,happened_at,created_at,processing_status')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limits.rawEntries)
  if (fromDate) rawQuery.gte('created_at', `${fromDate}T00:00:00.000Z`)
  if (toDate) rawQuery.lte('created_at', `${toDate}T23:59:59.999Z`)

  const [rawRes, memoriesRes, nodesRes, reportsRes, factsRes, snapshotsRes] = await Promise.all([
    rawQuery,
    supabase
      .from('agent_memories')
      .select('id,memory_type,content,importance_level,stability,sensitivity,source_entry_id,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limits.memories),
    supabase
      .from('brain_nodes')
      .select('id,type,name,canonical_name,summary,description,importance_score,frequency_score,confidence_score,first_seen_at,last_seen_at,source_entry_id,metadata')
      .eq('user_id', userId)
      .order('last_seen_at', { ascending: false, nullsFirst: false })
      .limit(limits.nodes),
    supabase
      .from('brain_reports')
      .select('id,report_type,title,summary,highlights,active_projects,repeated_patterns,decisions,risks,suggested_next_actions,source_refs,period_end,status,metadata')
      .eq('user_id', userId)
      .eq('status', 'done')
      .order('period_end', { ascending: false })
      .limit(limits.reports),
    supabase
      .from('identity_facts')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(300),
    supabase
      .from('identity_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10),
  ])
  const firstError = rawRes.error || memoriesRes.error || nodesRes.error || reportsRes.error || factsRes.error || snapshotsRes.error
  if (firstError) throw firstError
  return {
    rawEntries: rawRes.data ?? [],
    memories: memoriesRes.data ?? [],
    nodes: nodesRes.data ?? [],
    reports: reportsRes.data ?? [],
    existingFacts: factsRes.data ?? [],
    snapshots: snapshotsRes.data ?? [],
    personaProfile: loadPersonaProfile(),
  }
}

async function extractIdentity(brain) {
  if (useLlm) {
    try {
      const response = await callLLM(JSON.stringify(buildExtractorPack(brain), null, 2))
      const normalized = normalizeExtraction(response, 'llm')
      if (normalized.identity_facts.length) return normalized
      return { identity_facts: deterministicFacts(brain), warnings: ['LLM tidak menghasilkan identity_facts valid; memakai deterministic fallback.'] }
    } catch (err) {
      return {
        identity_facts: deterministicFacts(brain),
        warnings: [`LLM identity extraction gagal; memakai deterministic fallback: ${err instanceof Error ? err.message : String(err)}`],
      }
    }
  }
  return { identity_facts: deterministicFacts(brain), warnings: ['IDENTITY_USE_LLM=false; memakai deterministic fallback.'] }
}

function buildExtractorPack(brain) {
  return {
    task: 'Extract evidence-bound identity facts for Personal Entity OS.',
    rules: {
      every_fact_requires_evidence_refs: true,
      low_confidence_is_not_a_fact: true,
      do_not_overclaim: true,
      use_raw_entries_as_primary_evidence: true,
    },
    allowed_fact_types: [...FACT_TYPES],
    allowed_stability: STABILITY,
    allowed_strength: STRENGTH,
    allowed_polarity: [...POLARITY],
    identity_targets: ['traits', 'beliefs', 'values', 'preferences', 'goals', 'fears', 'ambitions', 'decision patterns', 'communication patterns', 'emotional patterns', 'risk patterns', 'contradictions', 'boundaries'],
    sources: {
      raw_entries: brain.rawEntries.map((entry) => ({ type: 'raw_entry', id: entry.id, label: entry.title || entry.happened_at || entry.created_at, date: entry.happened_at ?? entry.created_at, content: excerpt(entry.content, 2200) })),
      agent_memories: brain.memories.map((memory) => ({ type: 'agent_memory', id: memory.id, label: `${memory.memory_type} memory`, memory_type: memory.memory_type, importance_level: memory.importance_level, stability: memory.stability, content: excerpt(memory.content, 1000), source_entry_id: memory.source_entry_id })),
      brain_nodes: brain.nodes.map((node) => ({ type: 'brain_node', id: node.id, label: node.canonical_name || node.name, node_type: node.type, summary: node.summary, description: excerpt(node.description, 700), confidence_score: node.confidence_score, review_status: reviewStatus(node), source_entry_id: node.source_entry_id })),
      brain_reports: brain.reports.map((report) => ({ type: 'brain_report', id: report.id, label: report.title, summary: report.summary, repeated_patterns: report.repeated_patterns, active_projects: report.active_projects, decisions: report.decisions, risks: report.risks })),
      existing_identity_facts: brain.existingFacts.slice(0, 80).map((fact) => ({ id: fact.id, fact_type: fact.fact_type, label: fact.label, statement: fact.statement, confidence_score: fact.confidence_score, stability: fact.stability, status: fact.status })),
      persona_profile_context_only: brain.personaProfile ? excerpt(brain.personaProfile.raw, 2500) : null,
    },
    output_shape: {
      identity_facts: [{
        fact_type: 'trait',
        label: 'Suka membangun sistem bertahap',
        statement: 'Pemilik diary cenderung membangun sistem besar dengan pendekatan fase bertahap dan prompt implementasi.',
        confidence_score: 0.88,
        stability: 'recurring',
        strength: 'strong',
        polarity: 'neutral',
        usage_scope: DEFAULT_SCOPE,
        evidence_refs: [{ type: 'raw_entry', id: 'uuid', label: 'Diary 2026-06-12' }],
        reasoning: 'Pola ini berulang di beberapa fase implementasi.',
      }],
      warnings: ['Data gaya komunikasi spontan masih terbatas.'],
    },
  }
}

function deterministicFacts(brain) {
  const facts = []
  const add = (fact) => {
    const normalized = normalizeFact({ ...fact, metadata: { ...(fact.metadata ?? {}), generated_by: 'deterministic_fallback' } })
    if (normalized) facts.push(normalized)
  }
  const rawText = brain.rawEntries.map((entry) => entry.content).join('\n').toLowerCase()
  const evidenceRaw = brain.rawEntries.slice(0, 8).map((entry) => evidence('raw_entry', entry.id, entry.title || entry.happened_at || 'Raw entry'))
  const memories = brain.memories.filter((memory) => ['identity', 'preference', 'goal', 'pattern', 'decision', 'warning'].includes(memory.memory_type)).slice(0, 30)
  const nodesByType = (type) => brain.nodes.filter((node) => node.type === type && !['ignored', 'deleted', 'merged'].includes(reviewStatus(node))).slice(0, 20)
  const reports = brain.reports.slice(0, 8)

  if (/\b(fase|step|bertahap|blueprint|roadmap)\b/i.test(rawText) || nodesByType('project').length) {
    add({ fact_type: 'trait', label: 'Membangun sistem secara bertahap', statement: 'Pemilik diary terlihat sering membangun sistem besar melalui fase, step, atau blueprint bertahap.', confidence_score: evidenceRaw.length >= 3 ? 0.72 : 0.55, stability: 'recurring', strength: 'medium', polarity: 'neutral', evidence_refs: evidenceRaw })
  }
  if (/\b(otomatis|automation|worker|routine|sync)\b/i.test(rawText)) {
    add({ fact_type: 'belief', label: 'Sistem sebaiknya bisa berjalan otomatis', statement: 'Data menunjukkan kecenderungan mempercayai sistem yang punya otomasi, worker, routine, dan sinkronisasi.', confidence_score: 0.62, stability: 'recurring', strength: 'medium', polarity: 'positive', evidence_refs: evidenceRaw })
  }
  if (/\b(local|obsidian|vault|backup|data pribadi|service role)\b/i.test(rawText)) {
    add({ fact_type: 'value', label: 'Kontrol atas data pribadi', statement: 'Pemilik diary memberi nilai pada data pribadi yang bisa dikontrol, diaudit, dan disimpan dengan jelas.', confidence_score: 0.64, stability: 'recurring', strength: 'medium', polarity: 'positive', evidence_refs: evidenceRaw })
  }
  if (/\b(prompt siap paste|langsung|jangan|harus|acceptance criteria)\b/i.test(rawText)) {
    add({ fact_type: 'communication_pattern', label: 'Instruksi langsung dan implementatif', statement: 'Gaya komunikasi yang tercatat cenderung langsung, praktis, dan menuntut output yang bisa dieksekusi.', confidence_score: 0.66, stability: 'recurring', strength: 'medium', polarity: 'neutral', evidence_refs: evidenceRaw })
  }
  for (const memory of memories) {
    add(factFromMemory(memory))
  }
  for (const node of [...nodesByType('goal'), ...nodesByType('pattern'), ...nodesByType('decision'), ...nodesByType('emotion')]) {
    add(factFromNode(node))
  }
  for (const report of reports) {
    for (const item of asArray(report.repeated_patterns).slice(0, 6)) add(factFromReport(report, item, 'risk_pattern', 'name', 'Repeated pattern'))
    for (const item of asArray(report.decisions).slice(0, 6)) add(factFromReport(report, item, 'decision_pattern', 'decision', 'Decision pattern'))
    for (const item of asArray(report.risks).slice(0, 6)) add(factFromReport(report, item, 'risk_pattern', 'risk', 'Risk pattern'))
    for (const item of asArray(report.active_projects).slice(0, 4)) add(factFromReport(report, item, 'goal', 'name', 'Active project'))
  }
  add({ fact_type: 'boundary', label: 'Identity harus evidence-bound', statement: 'Agent tidak boleh mengarang fakta identitas dan harus mengaku jika data belum cukup.', confidence_score: 0.9, stability: 'core', strength: 'core', polarity: 'neutral', evidence_refs: evidenceRaw.length ? evidenceRaw : [{ type: 'system_instruction', id: 'step_18', label: 'Step 18 Identity Fidelity Engine' }], usage_scope: ['chat', 'persona', 'response_inference', 'drift_guard'] })
  return dedupeFacts(facts)
}

function factFromMemory(memory) {
  const map = { preference: 'preference', goal: 'goal', pattern: 'trait', decision: 'decision_pattern', warning: 'risk_pattern', identity: 'identity_summary' }
  return normalizeFact({
    fact_type: map[memory.memory_type] ?? 'trait',
    label: labelFromText(memory.content),
    statement: memory.content,
    confidence_score: memory.importance_level === 'core' ? 0.72 : 0.55,
    stability: memory.stability === 'core' ? 'core' : memory.stability === 'stable' ? 'stable' : 'recurring',
    strength: memory.importance_level === 'core' ? 'strong' : 'medium',
    polarity: 'neutral',
    source_table: 'agent_memories',
    source_ids: [memory.id],
    evidence_refs: [evidence('agent_memory', memory.id, `${memory.memory_type} memory`)],
    metadata: { generated_by: 'deterministic_fallback' },
  })
}

function factFromNode(node) {
  const map = { goal: 'goal', pattern: 'trait', decision: 'decision_pattern', emotion: 'emotional_pattern' }
  return normalizeFact({
    fact_type: map[node.type] ?? 'trait',
    label: node.canonical_name || node.name,
    statement: node.summary || node.description || `${node.type}: ${node.canonical_name || node.name}`,
    confidence_score: Math.max(minConfidence, Math.min(0.78, Number(node.confidence_score ?? 0.55))),
    stability: Number(node.frequency_score ?? 0) >= 3 ? 'recurring' : 'temporary',
    strength: Number(node.importance_score ?? 0) >= 80 ? 'strong' : 'medium',
    polarity: node.type === 'emotion' ? 'mixed' : 'neutral',
    source_table: 'brain_nodes',
    source_ids: [node.id],
    evidence_refs: [evidence('brain_node', node.id, node.canonical_name || node.name)],
    metadata: { generated_by: 'deterministic_fallback', review_status: reviewStatus(node) },
  })
}

function factFromReport(report, item, factType, key, prefix) {
  const label = String(item?.[key] || item?.name || item?.title || item?.summary || '').trim()
  if (!label) return null
  return normalizeFact({
    fact_type: factType,
    label,
    statement: String(item?.summary || item?.description || item?.mitigation || label),
    confidence_score: 0.5,
    stability: 'temporary',
    strength: 'weak',
    polarity: factType === 'risk_pattern' ? 'mixed' : 'neutral',
    source_table: 'brain_reports',
    source_ids: [report.id],
    evidence_refs: [evidence('brain_report', report.id, `${prefix}: ${report.title}`)],
    metadata: { generated_by: 'deterministic_fallback' },
  })
}

async function upsertIdentityFacts(facts) {
  const existing = await readIdentityFacts()
  const byKey = new Map(existing.map((fact) => [factKey(fact), fact]))
  const changed = []
  for (const incoming of dedupeFacts(facts).filter((fact) => fact.evidence_refs.length > 0)) {
    const current = byKey.get(factKey(incoming))
    const payload = current ? mergeFact(current, incoming) : { ...incoming, user_id: userId }
    const query = current
      ? supabase.from('identity_facts').update(payload).eq('id', current.id).select().single()
      : supabase.from('identity_facts').insert(payload).select().single()
    const { data, error } = await query
    if (error) throw error
    changed.push(data)
  }
  return changed
}

function mergeFact(current, incoming) {
  const currentConfidence = Number(current.confidence_score ?? minConfidence)
  const incomingConfidence = Number(incoming.confidence_score ?? minConfidence)
  const evidenceRefs = mergeEvidence(asArray(current.evidence_refs), incoming.evidence_refs)
  const sourceIds = mergeUnique([...(asArray(current.source_ids)), ...(incoming.source_ids ?? [])])
  const confidence = Math.min(1, ((currentConfidence * Math.max(1, asArray(current.evidence_refs).length)) + (incomingConfidence * Math.max(1, incoming.evidence_refs.length))) / (Math.max(1, asArray(current.evidence_refs).length) + Math.max(1, incoming.evidence_refs.length)))
  const contradictionRefs = mergeEvidence(asArray(current.contradiction_refs), incoming.contradiction_refs ?? [])
  return {
    statement: incoming.statement.length > String(current.statement ?? '').length ? incoming.statement : current.statement,
    evidence_refs: evidenceRefs,
    source_table: incoming.source_table || current.source_table,
    source_ids: sourceIds,
    confidence_score: Number(confidence.toFixed(4)),
    stability: maxRank(current.stability, incoming.stability, STABILITY),
    strength: maxRank(current.strength, incoming.strength, STRENGTH),
    polarity: incoming.polarity === 'mixed' ? 'mixed' : current.polarity,
    last_seen_at: new Date().toISOString(),
    usage_scope: mergeUnique([...(asArray(current.usage_scope)), ...(incoming.usage_scope ?? DEFAULT_SCOPE)]),
    status: contradictionRefs.length ? 'contradicted' : current.status === 'rejected' ? 'rejected' : 'active',
    contradiction_refs: contradictionRefs,
    metadata: { ...(current.metadata ?? {}), ...(incoming.metadata ?? {}), last_identity_refresh: new Date().toISOString() },
  }
}

async function createSnapshot(brain, warnings = []) {
  const facts = await readIdentityFacts()
  const active = facts.filter((fact) => fact.status === 'active' || fact.status === 'contradicted')
  const model = buildIdentityModel(active)
  const confidenceSummary = confidenceSummaryFor(active)
  const dataCoverage = { raw_entries: brain.rawEntries.length, agent_memories: brain.memories.length, brain_nodes: brain.nodes.length, brain_reports: brain.reports.length, identity_facts: active.length, latest_existing_snapshot: brain.snapshots[0]?.created_at ?? null }
  const snapshotWarnings = mergeUnique([
    ...warnings,
    ...(active.filter((fact) => fact.fact_type === 'communication_pattern').length ? [] : ['Communication style belum cukup untuk voice fidelity.']),
    ...(active.some((fact) => Number(fact.confidence_score) >= coreConfidence && asArray(fact.evidence_refs).length < 2) ? ['Ada high-confidence fact dengan evidence sedikit.'] : []),
  ])
  const payload = {
    user_id: userId,
    snapshot_type: args.has('baseline') ? 'baseline' : 'manual',
    title: `Identity Fidelity Snapshot ${new Date().toISOString().slice(0, 10)}`,
    summary: model.identity_summary,
    identity_model: model,
    confidence_summary: confidenceSummary,
    data_coverage: dataCoverage,
    warnings: snapshotWarnings,
    source_refs: active.flatMap((fact) => asArray(fact.evidence_refs)).slice(0, 80),
    model_provider: useLlm ? provider : 'deterministic',
    model_name: useLlm ? modelName : 'deterministic-fallback',
    status: 'done',
  }
  const { data, error } = await supabase.from('identity_snapshots').insert(payload).select().single()
  if (error) throw error
  return data
}

function buildIdentityModel(facts) {
  const grouped = Object.fromEntries([...FACT_TYPES].map((type) => [type, facts.filter((fact) => fact.fact_type === type).sort(sortFacts).slice(0, 20)]))
  return {
    identity_summary: grouped.identity_summary[0]?.statement || summarizeFacts(facts),
    core_traits: grouped.trait.filter(isStrongFact),
    core_values: grouped.value.filter(isStrongFact),
    beliefs: grouped.belief,
    preferences: grouped.preference,
    active_goals: grouped.goal,
    ambitions: grouped.ambition,
    fears: grouped.fear,
    decision_patterns: grouped.decision_pattern,
    communication_patterns: grouped.communication_pattern,
    emotional_patterns: grouped.emotional_pattern,
    risk_patterns: grouped.risk_pattern,
    contradictions: grouped.contradiction.concat(facts.filter((fact) => fact.status === 'contradicted')),
    boundaries: grouped.boundary,
  }
}

async function auditIdentity() {
  const [facts, snapshots] = await Promise.all([readIdentityFacts(), readIdentitySnapshots()])
  const active = facts.filter((fact) => fact.status === 'active' || fact.status === 'contradicted')
  const noEvidence = active.filter((fact) => asArray(fact.evidence_refs).length === 0)
  const weakHighConfidence = active.filter((fact) => Number(fact.confidence_score) >= coreConfidence && asArray(fact.evidence_refs).length < 2)
  const contradictions = active.filter((fact) => fact.status === 'contradicted' || fact.fact_type === 'contradiction')
  const communicationCount = active.filter((fact) => fact.fact_type === 'communication_pattern').length
  const latestSnapshot = snapshots[0]
  const snapshotAgeHours = latestSnapshot ? (Date.now() - new Date(latestSnapshot.created_at).getTime()) / 3600000 : Infinity
  const warnings = []
  if (active.length === 0) warnings.push('Belum ada identity_facts active.')
  if (noEvidence.length) warnings.push(`${noEvidence.length} facts tidak punya evidence_refs.`)
  if (weakHighConfidence.length) warnings.push(`${weakHighConfidence.length} high-confidence facts punya evidence kurang dari 2.`)
  if (communicationCount === 0) warnings.push('Belum ada communication_pattern untuk greeting/voice fidelity.')
  if (!latestSnapshot) warnings.push('Belum ada identity_snapshot.')
  else if (snapshotAgeHours > 72) warnings.push('Identity snapshot lebih lama dari 72 jam.')
  const score = Math.max(0, 100 - noEvidence.length * 15 - weakHighConfidence.length * 10 - (communicationCount ? 0 : 15) - (!latestSnapshot ? 20 : snapshotAgeHours > 72 ? 10 : 0) - (active.length ? 0 : 30))
  return {
    ok: true,
    status: score < 50 ? 'critical' : warnings.length ? 'warning' : 'healthy',
    score,
    counts: {
      identity_facts: facts.length,
      active_facts: active.length,
      core_or_stable_facts: active.filter((fact) => ['core', 'stable'].includes(fact.stability)).length,
      facts_without_evidence_refs: noEvidence.length,
      high_confidence_low_evidence: weakHighConfidence.length,
      active_contradictions: contradictions.length,
      communication_pattern_count: communicationCount,
      snapshots: snapshots.length,
    },
    low_confidence_warnings: active.filter((fact) => Number(fact.confidence_score) < minConfidence).slice(0, 10).map((fact) => `${fact.fact_type}: ${fact.label}`),
    snapshot_freshness: latestSnapshot ? { latest_snapshot_id: latestSnapshot.id, created_at: latestSnapshot.created_at, age_hours: Number(snapshotAgeHours.toFixed(1)) } : null,
    warnings,
    recommended_fixes: recommendedFixes(warnings),
  }
}

function writeIdentityMarkdown(facts, snapshot, brain, warnings = []) {
  const targetDir = resolve(vaultPath, '_system', 'identity')
  mkdirSync(targetDir, { recursive: true })
  const latest = snapshot ?? null
  const content = renderIdentityMarkdown(facts, latest, brain, warnings)
  writeMarkedFile(resolve(targetDir, 'Identity Fidelity Model.md'), content)
  writeMarkedFile(resolve(targetDir, 'Identity Snapshot Latest.md'), renderSnapshotMarkdown(latest, facts, brain, warnings))
}

function renderIdentityMarkdown(facts, snapshot, brain, warnings) {
  const active = facts.filter((fact) => fact.status === 'active' || fact.status === 'contradicted').sort(sortFacts)
  const model = buildIdentityModel(active)
  return [
    '---',
    'type: identity_fidelity_model',
    `last_updated: "${new Date().toISOString()}"`,
    `identity_facts: ${active.length}`,
    `snapshot_id: "${snapshot?.id ?? ''}"`,
    '---',
    '',
    '# Identity Fidelity Model',
    '',
    AUTO_START,
    '',
    '## Identity Summary',
    model.identity_summary,
    '',
    factSection('Core Traits', model.core_traits),
    factSection('Values', model.core_values),
    factSection('Beliefs', model.beliefs),
    factSection('Preferences', model.preferences),
    factSection('Goals', model.active_goals),
    factSection('Decision Patterns', model.decision_patterns),
    factSection('Communication Patterns', model.communication_patterns),
    factSection('Emotional Patterns', model.emotional_patterns),
    factSection('Risk Patterns', model.risk_patterns),
    factSection('Contradictions', model.contradictions),
    factSection('Boundaries', model.boundaries),
    listSection('Confidence Warnings', mergeUnique([...(snapshot?.warnings ?? []), ...warnings])),
    listSection('Evidence Highlights', active.flatMap((fact) => asArray(fact.evidence_refs).slice(0, 2).map((ref) => `${fact.label}: ${ref.type}:${ref.id} ${ref.label ?? ''}`)).slice(0, 20)),
    '## Data Coverage',
    `- Raw entries: ${brain.rawEntries.length}`,
    `- Agent memories: ${brain.memories.length}`,
    `- Brain nodes: ${brain.nodes.length}`,
    `- Brain reports: ${brain.reports.length}`,
    '',
    '## Last Updated',
    new Date().toISOString(),
    '',
    AUTO_END,
    '',
  ].join('\n')
}

function renderSnapshotMarkdown(snapshot, facts, brain, warnings) {
  const active = facts.filter((fact) => fact.status === 'active' || fact.status === 'contradicted').sort(sortFacts)
  const model = snapshot?.identity_model ?? buildIdentityModel(active)
  return [
    '---',
    'type: identity_snapshot_latest',
    `last_updated: "${new Date().toISOString()}"`,
    `snapshot_id: "${snapshot?.id ?? ''}"`,
    '---',
    '',
    '# Identity Snapshot Latest',
    '',
    AUTO_START,
    '',
    '## Identity Summary',
    snapshot?.summary || model.identity_summary || 'Belum cukup data untuk snapshot identity.',
    '',
    listSection('Core Traits', asStatements(model.core_traits)),
    listSection('Core Values', asStatements(model.core_values)),
    listSection('Active Goals', asStatements(model.active_goals)),
    listSection('Decision Patterns', asStatements(model.decision_patterns)),
    listSection('Communication Patterns', asStatements(model.communication_patterns)),
    listSection('Risk Patterns', asStatements(model.risk_patterns)),
    listSection('Contradictions', asStatements(model.contradictions)),
    listSection('Boundaries', asStatements(model.boundaries)),
    '## Confidence Summary',
    '```json',
    JSON.stringify(snapshot?.confidence_summary ?? confidenceSummaryFor(active), null, 2),
    '```',
    '',
    '## Data Coverage',
    '```json',
    JSON.stringify(snapshot?.data_coverage ?? countBrain(brain), null, 2),
    '```',
    '',
    listSection('Warnings', mergeUnique([...(snapshot?.warnings ?? []), ...warnings])),
    '## Last Updated',
    new Date().toISOString(),
    '',
    AUTO_END,
    '',
  ].join('\n')
}

async function callLLM(contextPackJson) {
  if (provider === 'claude-code') return parseJsonOrThrow(await callClaudeCode(contextPackJson), 'Claude Code')
  if (provider === 'anthropic') return parseJsonOrThrow(await callAnthropic(contextPackJson), 'Anthropic')
  if (provider === 'openai') return parseJsonOrThrow(await callOpenAICompatible(contextPackJson), 'OpenAI-compatible')
  if (provider === 'ollama') return parseJsonOrThrow(await callOllama(contextPackJson), 'Ollama')
  throw new Error(`IDENTITY_PROVIDER/LLM_PROVIDER tidak dikenal: ${provider}`)
}

async function callClaudeCode(contextPackJson) {
  const commandName = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
  const settingsArg = process.env.CLAUDE_CODE_API_KEY_HELPER === 'false'
    ? []
    : ['--settings', JSON.stringify({ apiKeyHelper: 'node -e "process.stdout.write(process.env.IDENTITY_API_KEY || process.env.BRAIN_CHAT_API_KEY || process.env.ANTHROPIC_API_KEY || \'\')"'} )]
  return await runCommand(commandName, [
    ...(process.env.CLAUDE_CODE_BARE === 'false' ? [] : ['--bare']),
    ...settingsArg,
    '--no-session-persistence',
    '--output-format',
    'text',
    '-p',
    `${SYSTEM_PROMPT}\n\nCONTEXT PACK:\n${contextPackJson}`,
  ], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
}

async function callAnthropic(contextPackJson) {
  const baseUrl = requiredEnv('IDENTITY_BASE_URL', process.env.BRAIN_CHAT_BASE_URL ?? process.env.BRAIN_DIGEST_BASE_URL ?? process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('IDENTITY_API_KEY', process.env.BRAIN_CHAT_API_KEY ?? process.env.BRAIN_DIGEST_API_KEY ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
  const model = requiredEnv('IDENTITY_MODEL', modelName)
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 5000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: `CONTEXT PACK:\n${contextPackJson}` }] }),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return Array.isArray(data.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
}

async function callOpenAICompatible(contextPackJson) {
  const baseUrl = requiredEnv('IDENTITY_BASE_URL', process.env.BRAIN_CHAT_BASE_URL ?? process.env.BRAIN_DIGEST_BASE_URL ?? process.env.LLM_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('IDENTITY_API_KEY', process.env.BRAIN_CHAT_API_KEY ?? process.env.BRAIN_DIGEST_API_KEY ?? process.env.LLM_API_KEY)
  const model = requiredEnv('IDENTITY_MODEL', modelName)
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `CONTEXT PACK:\n${contextPackJson}` }], response_format: { type: 'json_object' } }),
  })
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

async function callOllama(contextPackJson) {
  const baseUrl = (process.env.IDENTITY_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = requiredEnv('IDENTITY_MODEL', modelName)
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: `${SYSTEM_PROMPT}\n\nCONTEXT PACK:\n${contextPackJson}`, stream: false, format: 'json' }),
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data.response ?? ''
}

function normalizeExtraction(raw, generatedBy) {
  const warnings = arrayOfStrings(raw?.warnings)
  const facts = Array.isArray(raw?.identity_facts) ? raw.identity_facts.map((fact) => normalizeFact({ ...fact, metadata: { ...(fact.metadata ?? {}), generated_by: generatedBy, reasoning: fact.reasoning } })).filter(Boolean) : []
  return { identity_facts: facts, warnings }
}

function normalizeFact(fact) {
  const factType = String(fact?.fact_type ?? '').trim()
  const label = String(fact?.label ?? '').trim()
  const statement = String(fact?.statement ?? '').trim()
  const evidenceRefs = asArray(fact?.evidence_refs).filter((ref) => ref?.type && ref?.id).map((ref) => ({ type: String(ref.type), id: String(ref.id), label: String(ref.label ?? '') }))
  if (!FACT_TYPES.has(factType) || !label || !statement || evidenceRefs.length === 0) return null
  const confidence = readClampedNumber(fact.confidence_score, minConfidence, 0, 1)
  return {
    fact_type: factType,
    label: excerpt(label, 180),
    statement: excerpt(statement, 1200),
    evidence_refs: evidenceRefs,
    source_table: typeof fact.source_table === 'string' ? fact.source_table : evidenceRefs[0]?.type ?? null,
    source_ids: mergeUnique([...(asArray(fact.source_ids).map(String)), ...evidenceRefs.map((ref) => ref.id)]),
    confidence_score: Number(confidence.toFixed(4)),
    stability: STABILITY.includes(fact.stability) ? fact.stability : confidence >= coreConfidence ? 'stable' : confidence >= 0.65 ? 'recurring' : 'temporary',
    strength: STRENGTH.includes(fact.strength) ? fact.strength : confidence >= coreConfidence ? 'strong' : confidence >= 0.65 ? 'medium' : 'weak',
    polarity: POLARITY.has(fact.polarity) ? fact.polarity : 'neutral',
    first_seen_at: fact.first_seen_at || new Date().toISOString(),
    last_seen_at: fact.last_seen_at || new Date().toISOString(),
    usage_scope: asArray(fact.usage_scope).length ? asArray(fact.usage_scope).map(String) : DEFAULT_SCOPE,
    status: ['active', 'needs_review', 'contradicted', 'deprecated', 'rejected'].includes(fact.status) ? fact.status : confidence < minConfidence ? 'needs_review' : 'active',
    contradiction_refs: asArray(fact.contradiction_refs),
    metadata: typeof fact.metadata === 'object' && fact.metadata ? fact.metadata : {},
  }
}

async function readIdentityFacts() {
  const { data, error } = await supabase.from('identity_facts').select('*').eq('user_id', userId).order('confidence_score', { ascending: false }).order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

async function readIdentitySnapshots() {
  const { data, error } = await supabase.from('identity_snapshots').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(20)
  if (error) throw error
  return data ?? []
}

function writeMarkedFile(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) {
    writeFileSync(path, `${content}\n`, 'utf8')
    return
  }
  const existing = readFileSync(path, 'utf8')
  const auto = content.slice(content.indexOf(AUTO_START), content.indexOf(AUTO_END) + AUTO_END.length)
  const next = existing.includes(AUTO_START) && existing.includes(AUTO_END)
    ? `${existing.slice(0, existing.indexOf(AUTO_START))}${auto}${existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length)}`
    : `${existing.replace(/\s*$/, '\n\n')}${auto}\n`
  writeFileSync(path, next, 'utf8')
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}) })
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
  throw new Error('Tidak bisa menentukan user_id untuk identity-fidelity.')
}

function loadPersonaProfile() {
  const path = resolve(vaultPath, '_system', 'persona', 'Persona Profile.md')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const raw = text.includes('<!-- BRAIN_PERSONA_AUTO_START -->') && text.includes('<!-- BRAIN_PERSONA_AUTO_END -->')
    ? text.slice(text.indexOf('<!-- BRAIN_PERSONA_AUTO_START -->'), text.indexOf('<!-- BRAIN_PERSONA_AUTO_END -->'))
    : text
  return { raw }
}

function recommendedFixes(warnings) {
  if (!warnings.length) return []
  return mergeUnique(warnings.map((warning) => {
    if (warning.includes('communication_pattern')) return 'Tambahkan chat sample atau diary percakapan, lalu jalankan npm run identity:build.'
    if (warning.includes('evidence')) return 'Review facts tanpa evidence dan rebuild identity dari raw_entries utama.'
    if (warning.includes('snapshot')) return 'Jalankan npm run identity:snapshot atau npm run identity:refresh.'
    return 'Tambahkan diary/source yang lebih eksplisit dan jalankan identity audit ulang.'
  }))
}

function factSection(title, facts) {
  const lines = [`## ${title}`]
  if (!facts.length) lines.push('- Belum cukup data.')
  else lines.push(...facts.map((fact) => `- ${fact.statement} _(confidence ${Number(fact.confidence_score).toFixed(2)}, ${fact.stability}, evidence ${asArray(fact.evidence_refs).length})_`))
  lines.push('')
  return lines.join('\n')
}

function listSection(title, items) {
  const lines = [`## ${title}`]
  if (!items.length) lines.push('- Belum cukup data.')
  else lines.push(...items.map((item) => `- ${item}`))
  lines.push('')
  return lines.join('\n')
}

function asStatements(items) {
  return asArray(items).map((item) => typeof item === 'string' ? item : item?.statement).filter(Boolean).map(String)
}

function summarizeFacts(facts) {
  const top = facts.filter((fact) => Number(fact.confidence_score) >= 0.65).sort(sortFacts).slice(0, 5)
  return top.length ? top.map((fact) => fact.statement).join(' ') : 'Belum cukup identity_facts confidence tinggi untuk membuat ringkasan identitas.'
}

function confidenceSummaryFor(facts) {
  const scores = facts.map((fact) => Number(fact.confidence_score ?? 0)).filter(Number.isFinite)
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
  return {
    total: facts.length,
    average: Number(avg.toFixed(3)),
    high_confidence: facts.filter((fact) => Number(fact.confidence_score) >= coreConfidence).length,
    medium_confidence: facts.filter((fact) => Number(fact.confidence_score) >= minConfidence && Number(fact.confidence_score) < coreConfidence).length,
    low_confidence: facts.filter((fact) => Number(fact.confidence_score) < minConfidence).length,
    by_stability: Object.fromEntries(STABILITY.map((key) => [key, facts.filter((fact) => fact.stability === key).length])),
  }
}

function writeRunLog(payload) {
  try {
    const logDir = resolve(vaultPath, '_system', 'logs')
    mkdirSync(logDir, { recursive: true })
    const file = resolve(logDir, `identity-fidelity-${new Date().toISOString().slice(0, 10)}.md`)
    appendFileSync(file, `\n## ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`, 'utf8')
  } catch {
    // Logging should not fail the identity build.
  }
}

function countBrain(brain) {
  return { raw_entries: brain.rawEntries.length, agent_memories: brain.memories.length, brain_nodes: brain.nodes.length, brain_reports: brain.reports.length, existing_identity_facts: brain.existingFacts.length, existing_identity_snapshots: brain.snapshots.length }
}

function evidence(type, id, label) {
  return { type, id, label: String(label ?? '') }
}

function sortFacts(a, b) {
  return Number(b.confidence_score ?? 0) - Number(a.confidence_score ?? 0) || asArray(b.evidence_refs).length - asArray(a.evidence_refs).length
}

function isStrongFact(fact) {
  return Number(fact.confidence_score) >= 0.65 || ['stable', 'core'].includes(fact.stability)
}

function dedupeFacts(facts) {
  const map = new Map()
  for (const fact of facts.filter(Boolean)) {
    const key = factKey(fact)
    const existing = map.get(key)
    if (!existing || Number(fact.confidence_score) > Number(existing.confidence_score)) map.set(key, fact)
  }
  return [...map.values()]
}

function factKey(fact) {
  return `${fact.fact_type}:${normalizeLabel(fact.label)}`
}

function normalizeLabel(value) {
  return String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ')
}

function mergeEvidence(a, b) {
  const seen = new Set()
  return [...a, ...b].filter((ref) => {
    const key = `${ref?.type}:${ref?.id}`
    if (!ref?.type || !ref?.id || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function mergeUnique(items) {
  const seen = new Set()
  return items.map((item) => String(item ?? '').trim()).filter((item) => {
    const key = item.toLowerCase()
    if (!item || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function maxRank(a, b, values) {
  return values[Math.max(values.indexOf(a), values.indexOf(b), 0)]
}

function reviewStatus(item) {
  const status = item?.metadata?.review_status
  return ['pending_review', 'approved', 'ignored', 'merged', 'deleted'].includes(status) ? status : 'pending_review'
}

function labelFromText(value) {
  return excerpt(String(value ?? '').split(/[.!?\n]/).find(Boolean) ?? value, 90)
}

function excerpt(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function parseJsonOrThrow(text, label) {
  const raw = String(text ?? '').trim()
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`${label} tidak mengembalikan JSON.`)
    return JSON.parse(match[0])
  }
}

function runCommand(commandName, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, commandArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${commandName} timeout setelah ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${commandName} exited ${code}: ${output.slice(0, 1000)}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
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

function readOptionalArg(name) {
  const value = args.get(name)
  return value ? String(value) : ''
}

function readIntArg(name, fallback, min, max) {
  const value = Number(args.get(name) ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function readBoolArg(name, fallback) {
  const raw = args.get(name)
  if (raw === undefined) return fallback
  return raw === 'true'
}

function readIntEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function readNumberEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function readBoolEnv(key, fallback) {
  const value = process.env[key]
  if (value === undefined || value === '') return fallback
  return value === 'true'
}

function readClampedNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing env ${name}`)
  return value
}

function formatError(err) {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err)
    } catch {
      return Object.prototype.toString.call(err)
    }
  }
  return String(err)
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

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}
