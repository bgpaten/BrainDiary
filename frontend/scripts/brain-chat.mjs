import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runResponseInference } from './response-inference.mjs'

const SYSTEM_PROMPT = `Kamu adalah Brain Reader untuk Personal Brain OS milik user.

Tugasmu:
- Jawab pertanyaan user hanya berdasarkan context pack.
- Jangan mengarang fakta di luar memory.
- Jika context tidak cukup, katakan bahwa memory belum cukup.
- Bedakan fakta, inferensi, dan saran.
- Jika memberi saran, jelaskan dasar memory-nya.
- Jangan terlalu halus; berikan jawaban strategis dan tajam.
- Jangan menyebut bahwa kamu punya akses ke semua hidup user. Kamu hanya membaca data yang tersedia.
- Prioritaskan memory dengan confidence tinggi dan review_status approved.
- Hati-hati dengan memory sensitive/private.
- Jika ada konflik memory lama dan baru, jelaskan konflik tersebut.
- Jika identity_facts tersedia, pakai itu sebagai sumber utama untuk pertanyaan personal, strategi diri, gaya diri, sapaan, dan self-clone.
- Pakai high-confidence identity facts untuk klaim tegas. Low-confidence identity facts hanya boleh disebut sebagai kemungkinan.
- Jika identity evidence belum cukup, jawab bahwa data identitas belum cukup; jangan menutupinya dengan persona profile lama.

Balas hanya JSON valid dengan bentuk:
{
  "answer": "jawaban utama",
  "confidence": 0.82,
  "persona_mode": "strategic_mirror",
  "persona_reason": "Pertanyaan meminta evaluasi strategi dan fokus eksekusi.",
  "persona_confidence": 0.87,
  "basis": ["dasar dari context pack"],
  "sources": [{"type":"brain_node","id":"uuid","label":"Node name"}],
  "missing_context": [],
  "suggested_next_actions": [],
  "style_warnings": []
}`

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const args = parseArgs(process.argv.slice(2))
const question = readArg('question')
if (!question.trim()) throw new Error('Question kosong.')
if (question.length > 2000) throw new Error('Question terlalu panjang. Maksimum 2000 karakter.')

const limits = {
  nodes: readIntArg('max-nodes', Number(process.env.BRAIN_CHAT_MAX_CONTEXT_NODES ?? 12), 1, 50),
  edges: readIntArg('max-edges', Number(process.env.BRAIN_CHAT_MAX_CONTEXT_EDGES ?? 20), 1, 80),
  raw_entries: readIntArg('max-raw-entries', Number(process.env.BRAIN_CHAT_MAX_RAW_ENTRIES ?? 5), 0, 20),
  agent_memories: readIntArg('max-agent-memories', Number(process.env.BRAIN_CHAT_MAX_AGENT_MEMORIES ?? 10), 0, 50),
}
const includeRawEntries = readBoolArg('include-raw-entries', true)
const userId = readOptionalArg('user-id')
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const provider = (process.env.BRAIN_CHAT_PROVIDER ?? process.env.LLM_PROVIDER ?? 'claude-code').toLowerCase()
const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const embeddingProvider = (process.env.EMBEDDING_PROVIDER ?? 'disabled').toLowerCase()
const embeddingModel = process.env.EMBEDDING_MODEL ?? (embeddingProvider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small')
const embeddingDimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536)
let supabase = null

try {
  if (readBoolEnv('RESPONSE_INFERENCE_ENABLED', true)) {
    const response = await runResponseInference({ question, options: { userId, source: 'brain-chat' } })
    console.log(JSON.stringify(response))
    process.exit(0)
  }
  supabase = await createSupabaseClient()
  const activeUserId = userId || await resolveUserId()
  if (!activeUserId) throw new Error('user_id tidak tersedia untuk Brain Chat.')
  const brain = await readBrain(activeUserId)
  const semantic = isSocialGreeting(question) ? emptySemantic('Social greeting tidak membutuhkan deep retrieval.') : await semanticSearchSafe(question, activeUserId, 30)
  const contextPack = buildContextPack(question, brain, limits, includeRawEntries, semantic)
  contextPack.reflection_context = buildReflectionContext(brain)
  if (contextPack.reflection_context.warnings.length) contextPack.warnings = [...new Set([...(contextPack.warnings ?? []), ...contextPack.reflection_context.warnings])]
  const personaProfile = loadPersonaProfile()
  const personaRoute = detectPersonaMode(question, contextPack, personaProfile)
  attachPersonaContext(contextPack, personaProfile, personaRoute)
  const response = await answerWithFallback(question, contextPack, personaProfile, personaRoute)
  console.log(JSON.stringify(response))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

async function readBrain(activeUserId) {
  const [nodesRes, edgesRes, memoriesRes, rawEntriesRes, clustersRes, identityFactsRes, identitySnapshotsRes, communicationPatternsRes, communicationSamplesRes, reflectionLogsRes, evolutionSnapshotsRes, identityConflictsRes, longTermRes, memorySnapshotRes] = await Promise.all([
    supabase
      .from('brain_nodes')
      .select('id,type,name,canonical_name,aliases,summary,description,importance_score,frequency_score,confidence_score,cluster_id,first_seen_at,last_seen_at,source_entry_id,metadata')
      .eq('user_id', activeUserId),
    supabase
      .from('brain_edges')
      .select('id,from_node_id,to_node_id,relation_type,summary,weight,confidence_score,source_entry_id,valid_at,invalid_at,metadata')
      .eq('user_id', activeUserId),
    supabase
      .from('agent_memories')
      .select('id,memory_type,content,importance_level,stability,sensitivity,source_entry_id,created_at')
      .eq('user_id', activeUserId)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('raw_entries')
      .select('id,title,content,happened_at,created_at,processing_status')
      .eq('user_id', activeUserId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('brain_clusters')
      .select('id,name,slug,description,priority')
      .eq('user_id', activeUserId),
    supabase
      .from('identity_facts')
      .select('id,fact_type,label,statement,evidence_refs,confidence_score,stability,strength,polarity,usage_scope,status,contradiction_refs,last_seen_at,metadata')
      .eq('user_id', activeUserId)
      .in('status', ['active', 'contradicted', 'needs_review'])
      .order('confidence_score', { ascending: false })
      .limit(120),
    supabase
      .from('identity_snapshots')
      .select('id,snapshot_type,title,summary,identity_model,confidence_summary,data_coverage,warnings,source_refs,status,created_at')
      .eq('user_id', activeUserId)
      .in('status', ['done', 'needs_review'])
      .order('created_at', { ascending: false })
      .limit(3),
    supabase
      .from('communication_patterns')
      .select('id,pattern_type,label,description,examples,anti_examples,preferred_response_shape,trigger_intents,confidence_score,stability,evidence_refs,usage_rules,status,metadata,updated_at')
      .eq('user_id', activeUserId)
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(80),
    supabase
      .from('communication_samples')
      .select('id,sample_type,text,tone,formality,length_class,intent_type,context_label,confidence_score,created_at')
      .eq('user_id', activeUserId)
      .order('confidence_score', { ascending: false })
      .limit(120),
    supabase
      .from('self_reflection_logs')
      .select('id,reflection_type,title,summary,risk_implications,uncertainties,status,created_at')
      .eq('user_id', activeUserId)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('entity_evolution_snapshots')
      .select('id,snapshot_type,summary,fidelity_risk_score,open_uncertainties,active_boundaries,status,created_at')
      .eq('user_id', activeUserId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('identity_conflicts')
      .select('id,conflict_type,title,summary,side_a_label,side_a_statement,side_b_label,side_b_statement,severity,recurrence,resolution_status,impact_area,chat_guidance,last_seen_at')
      .eq('user_id', activeUserId)
      .in('resolution_status', ['open', 'monitoring', 'partially_resolved', 'needs_review'])
      .order('last_seen_at', { ascending: false })
      .limit(80),
    supabase
      .from('long_term_memories')
      .select('id,memory_type,title,summary,canonical_statement,evidence_refs,importance_score,confidence_score,stability,freshness,status,related_conflict_ids,last_seen_at')
      .eq('user_id', activeUserId)
      .in('status', ['active', 'needs_review', 'contradicted'])
      .order('importance_score', { ascending: false })
      .limit(120),
    supabase
      .from('memory_consolidation_snapshots')
      .select('id,snapshot_type,title,summary,memory_health,status,created_at')
      .eq('user_id', activeUserId)
      .order('created_at', { ascending: false })
      .limit(1),
  ])
  const identityFactsError = identityFactsRes.error?.code === '42P01' ? null : identityFactsRes.error
  const identitySnapshotsError = identitySnapshotsRes.error?.code === '42P01' ? null : identitySnapshotsRes.error
  const communicationPatternsError = communicationPatternsRes.error?.code === '42P01' ? null : communicationPatternsRes.error
  const communicationSamplesError = communicationSamplesRes.error?.code === '42P01' ? null : communicationSamplesRes.error
  const identityConflictsError = identityConflictsRes.error?.code === '42P01' ? null : identityConflictsRes.error
  const longTermError = longTermRes.error?.code === '42P01' ? null : longTermRes.error
  const firstError = nodesRes.error || edgesRes.error || memoriesRes.error || rawEntriesRes.error || clustersRes.error || identityFactsError || identitySnapshotsError || communicationPatternsError || communicationSamplesError || identityConflictsError || longTermError
  if (firstError) throw firstError
  return {
    nodes: nodesRes.data ?? [],
    edges: edgesRes.data ?? [],
    memories: memoriesRes.data ?? [],
    rawEntries: rawEntriesRes.data ?? [],
    clusters: clustersRes.data ?? [],
    identityFacts: identityFactsRes.error?.code === '42P01' ? [] : identityFactsRes.data ?? [],
    identitySnapshots: identitySnapshotsRes.error?.code === '42P01' ? [] : identitySnapshotsRes.data ?? [],
    communicationPatterns: communicationPatternsRes.error?.code === '42P01' ? [] : communicationPatternsRes.data ?? [],
    communicationSamples: communicationSamplesRes.error?.code === '42P01' ? [] : communicationSamplesRes.data ?? [],
    identityConflicts: identityConflictsRes.error?.code === '42P01' ? [] : identityConflictsRes.data ?? [],
    longTermMemories: longTermRes.error?.code === '42P01' ? [] : longTermRes.data ?? [],
    memoryConsolidationSnapshot: memorySnapshotRes.error?.code === '42P01' ? null : (memorySnapshotRes.data ?? [])[0] ?? null,
    reflectionLog: reflectionLogsRes.error?.code === '42P01' ? null : (reflectionLogsRes.data ?? [])[0] ?? null,
    evolutionSnapshot: evolutionSnapshotsRes.error?.code === '42P01' ? null : (evolutionSnapshotsRes.data ?? [])[0] ?? null,
  }
}

// Self-Reflection (Step 24) hanya konteks pendukung untuk Brain Chat.
// Identity facts tetap sumber utama klaim identitas. Jika reflection menyebut
// uncertainty / high-risk fidelity, Brain Chat harus lebih hati-hati.
function buildReflectionContext(brain) {
  const log = brain.reflectionLog ?? null
  const snapshot = brain.evolutionSnapshot ?? null
  if (!log && !snapshot) return { used: false, reflection_log_id: null, evolution_snapshot_id: null, warnings: [] }
  const warnings = []
  const fidelityRisk = Number(snapshot?.fidelity_risk_score ?? 0)
  if (fidelityRisk > 0.6) warnings.push('Entity evolution snapshot menandai fidelity risk tinggi; turunkan confidence dan hindari overclaim.')
  for (const item of asArray(log?.risk_implications)) {
    if (Number(item?.risk_score ?? 0) >= 0.6 && item?.label) warnings.push(`Reflection risk: ${item.label}.`)
  }
  for (const item of asArray(log?.uncertainties).slice(0, 3)) {
    if (item?.label) warnings.push(`Reflection uncertainty: ${item.label}. Jawab lebih hati-hati di area ini.`)
  }
  return {
    used: true,
    priority: 'supporting',
    reflection_log_id: log?.id ?? null,
    evolution_snapshot_id: snapshot?.id ?? null,
    latest_summary: log?.summary ?? snapshot?.summary ?? null,
    fidelity_risk_score: fidelityRisk,
    open_uncertainties: asArray(log?.uncertainties).map((item) => item?.label).filter(Boolean).slice(0, 5),
    usage_rules: [
      'Reflection context hanya pendukung; identity_facts tetap sumber utama untuk klaim identitas.',
      'Jika reflection menyebut uncertainty, jawab lebih hati-hati dan akui keterbatasan.',
      'Jika ada high-risk fidelity warning, turunkan confidence.',
      'Jangan menjawab hanya berdasarkan reflection tanpa evidence lain.',
    ],
    warnings: [...new Set(warnings)],
  }
}

function selectRelevantIdentityConflicts(query, intentType, conflicts) {
  if (isSocialGreeting(query)) return []
  const normalized = normalizeWords(query)
  return (conflicts ?? [])
    .map((conflict) => {
      const haystack = normalizeWords([conflict.title, conflict.summary, conflict.side_a_statement, conflict.side_b_statement, conflict.impact_area, conflict.conflict_type].join(' '))
      let score = ['strategy_question', 'identity_question', 'contradiction_check'].includes(intentType) ? 20 : 0
      for (const token of tokenize(query)) if (token.length > 3 && haystack.includes(token)) score += 8
      if (/\b(fitur|scope|fokus|lanjut|roadmap|mvp|validasi)\b/.test(normalized) && /fitur|scope|fokus|roadmap|mvp|validasi|blueprint/.test(haystack)) score += 45
      if (/\b(kontradiksi|tension|konsisten|berlawanan)\b/.test(normalized)) score += 35
      if (conflict.severity === 'high' || conflict.severity === 'critical') score += 15
      if (conflict.recurrence === 'core_tension') score += 15
      return { conflict, score }
    })
    .filter(({ score }) => score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ conflict }) => conflict)
}

async function semanticSearchSafe(query, activeUserId, matchLimit) {
  const base = { enabled: false, results: [], warnings: [] }
  if (embeddingProvider === 'disabled') {
    return { ...base, warnings: ['Semantic retrieval disabled: EMBEDDING_PROVIDER=disabled.'] }
  }
  try {
    const embedding = await embedQuery(query)
    const { data, error } = await supabase.rpc('match_semantic_memory', {
      match_user_id: activeUserId,
      query_embedding: vectorLiteral(embedding),
      match_count: matchLimit,
      match_tables: ['brain_nodes', 'brain_edges', 'agent_memories', 'raw_entries'],
    })
    if (error) throw error
    return {
      enabled: true,
      warnings: [],
      results: (data ?? []).map((item) => ({
        type: item.item_type,
        id: item.item_id,
        label: item.label,
        summary: item.summary,
        score: Number(item.score ?? 0),
      })),
    }
  } catch (err) {
    return {
      ...base,
      warnings: [`Semantic retrieval fallback: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

function emptySemantic(reason) {
  return { enabled: false, results: [], warnings: [reason] }
}

async function embedQuery(text) {
  if (embeddingProvider === 'openai') return await embedOpenAICompatible(text)
  if (embeddingProvider === 'ollama') return await embedOllama(text)
  throw new Error(`Unsupported EMBEDDING_PROVIDER: ${embeddingProvider}`)
}

async function embedOpenAICompatible(text) {
  const baseUrl = (process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')
  const apiKey = requiredEnv('EMBEDDING_API_KEY', process.env.LLM_API_KEY)
  const body = { model: embeddingModel, input: text }
  if (embeddingDimensions) body.dimensions = embeddingDimensions
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
    body: JSON.stringify({ model: embeddingModel, prompt: text }),
  })
  if (!res.ok) throw new Error(`Ollama embedding HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  if (!Array.isArray(data?.embedding)) throw new Error('Ollama response missing embedding')
  return data.embedding.map(Number)
}

function buildContextPack(query, brain, max, withRawEntries, semantic) {
  const tokens = tokenize(query)
  const greeting = isSocialGreeting(query)
  const communicationIntent = detectCommunicationIntent(query, greeting)
  const personalIdentity = isPersonalIdentityQuery(query) || greeting
  const communicationContext = buildCommunicationContext(query, brain.communicationPatterns ?? [], brain.communicationSamples ?? [], communicationIntent, greeting)
  const responsePolicy = buildResponsePolicy(greeting, communicationContext)
  const semanticByKey = new Map((semantic.results ?? []).map((hit) => [`${hit.type}:${hit.id}`, hit.score]))
  const semanticBonus = (type, id) => (semanticByKey.get(`${type}:${id}`) ?? 0) * 100
  const nodeScores = brain.nodes.map((node) => ({ item: node, score: scoreNode(node, tokens, query) + semanticBonus('brain_node', node.id) }))
  const memoryScores = brain.memories.map((memory) => ({ item: memory, score: scoreMemory(memory, tokens, query) + semanticBonus('agent_memory', memory.id) }))
  const longTermScores = (brain.longTermMemories ?? []).map((memory) => ({ item: memory, score: scoreLongTermMemory(memory, tokens, query) }))
  const edgeBaseScores = brain.edges.map((edge) => ({ item: edge, score: scoreEdge(edge, tokens, query) + semanticBonus('brain_edge', edge.id) }))
  const rawScores = brain.rawEntries.map((entry) => ({ item: entry, score: scoreRawEntry(entry, tokens, query) + semanticBonus('raw_entry', entry.id) }))

  const relevantNodes = greeting ? [] : topPositive(nodeScores, max.nodes)
  const topNodeIds = new Set(relevantNodes.map((node) => node.id))
  const connectedEdges = edgeBaseScores.map(({ item, score }) => ({
    item,
    score: score + (topNodeIds.has(item.from_node_id) ? 25 : 0) + (topNodeIds.has(item.to_node_id) ? 25 : 0),
  }))
  const relevantEdges = greeting ? [] : topPositive(connectedEdges, max.edges)
  const sourceEntryIds = new Set([
    ...relevantNodes.map((node) => node.source_entry_id).filter(Boolean),
    ...relevantEdges.map((edge) => edge.source_entry_id).filter(Boolean),
    ...topPositive(memoryScores, max.agent_memories).map((memory) => memory.source_entry_id).filter(Boolean),
  ])
  const relevantRawEntries = withRawEntries && !greeting
    ? topUnique([
        ...rawScores,
        ...brain.rawEntries
          .filter((entry) => sourceEntryIds.has(entry.id))
          .map((entry) => ({ item: entry, score: 80 + scoreRawEntry(entry, tokens, query) })),
      ], max.raw_entries)
    : []
  const relevantMemories = greeting ? [] : topPositive(memoryScores, max.agent_memories)
  const relevantLongTermMemories = greeting ? [] : topPositive(longTermScores, 8)
  const identityContext = buildIdentityContext(query, brain.identityFacts ?? [], brain.identitySnapshots ?? [], personalIdentity, greeting)
  const identityConflicts = greeting ? [] : selectRelevantIdentityConflicts(query, responsePolicy.intentType, brain.identityConflicts ?? [])
  const warnings = []
  if (relevantNodes.some((node) => (node.confidence_score ?? 1) < 0.7) || relevantEdges.some((edge) => (edge.confidence_score ?? 1) < 0.7)) {
    warnings.push('Jawaban ini lemah karena beberapa memory belum direview atau confidence rendah.')
  }
  if (!greeting && relevantNodes.length === 0 && relevantEdges.length === 0 && relevantMemories.length === 0 && relevantRawEntries.length === 0) {
    warnings.push('Memory yang tersedia belum cukup untuk menjawab ini.')
  }
  if (!greeting || responsePolicy.exposeWarningsToUser) warnings.push(...identityContext.warnings)
  for (const memory of relevantLongTermMemories) {
    if (memory.freshness === 'stale') warnings.push(`Long-term memory "${memory.title}" stale; gunakan sebagai konteks historis.`)
    if (memory.status === 'needs_review') warnings.push(`Long-term memory "${memory.title}" needs_review; jangan jadikan klaim tegas.`)
  }

  const nodeById = new Map(brain.nodes.map((node) => [node.id, node]))
  return {
    query,
    is_social_greeting: greeting,
    intent_type: responsePolicy.intentType,
    response_policy: responsePolicy,
    communication_context: communicationContext,
    relevant_memories: relevantMemories.map(formatMemory),
    relevant_long_term_memories: relevantLongTermMemories.map(formatLongTermMemory),
    relevant_nodes: relevantNodes.map(formatNode),
    relevant_edges: relevantEdges.map((edge) => formatEdge(edge, nodeById)),
    relevant_raw_entries: relevantRawEntries.map(formatRawEntry),
    identity_context: identityContext,
    identity_conflicts: identityConflicts,
    memory_consolidation_snapshot: brain.memoryConsolidationSnapshot,
    retrieval_methods: ['keyword', ...(semantic.enabled ? ['semantic'] : []), ...(relevantEdges.length > 0 ? ['graph'] : [])],
    semantic_enabled: semantic.enabled,
    semantic_warnings: semantic.warnings,
    semantic_hits: semantic.results?.length ?? 0,
    keyword_hits: [relevantNodes.length, relevantEdges.length, relevantMemories.length, relevantRawEntries.length].reduce((a, b) => a + b, 0),
    warnings,
    limits: max,
  }
}

async function answerWithFallback(query, contextPack, personaProfile, personaRoute) {
  const localSources = localSourcesFromContext(contextPack)
  const debug = {
    intent_type: contextPack.intent_type,
    is_social_greeting: contextPack.is_social_greeting,
    response_policy: contextPack.response_policy,
    retrieved_nodes: contextPack.relevant_nodes.length,
    retrieved_edges: contextPack.relevant_edges.length,
    retrieved_memories: contextPack.relevant_memories.length,
    retrieved_raw_entries: contextPack.relevant_raw_entries.length,
    retrieval_methods: contextPack.retrieval_methods,
    semantic_enabled: contextPack.semantic_enabled,
    semantic_hits: contextPack.semantic_hits,
    keyword_hits: contextPack.keyword_hits,
    semantic_warnings: contextPack.semantic_warnings,
    provider,
    persona_profile_used: Boolean(personaProfile),
    identity_facts_used: contextPack.identity_context?.facts?.length ?? 0,
    identity_snapshot_used: contextPack.identity_context?.snapshot?.id ?? null,
    identity_conflicts_used: (contextPack.identity_conflicts ?? []).length > 0,
    identity_conflict_ids: (contextPack.identity_conflicts ?? []).map((conflict) => conflict.id),
    conflict_guidance_used: (contextPack.identity_conflicts ?? []).map((conflict) => conflict.chat_guidance).filter(Boolean),
    conflict_warnings: (contextPack.identity_conflicts ?? []).map((conflict) => `Active conflict: ${conflict.title}`),
    identity_confidence_warnings: contextPack.identity_context?.warnings ?? [],
    communication_style_used: (contextPack.communication_context?.patterns?.length ?? 0) > 0,
    communication_pattern_ids: contextPack.communication_context?.patterns?.map((pattern) => pattern.id) ?? [],
    communication_intent: contextPack.communication_context?.intent ?? contextPack.intent_type,
    response_shape: contextPack.response_policy?.responseShape ?? null,
    warnings_hidden_from_user: contextPack.response_policy?.exposeWarningsToUser === false ? contextPack.identity_context?.warnings ?? [] : [],
    self_reflection_used: contextPack.reflection_context?.used ?? false,
    reflection_log_id: contextPack.reflection_context?.reflection_log_id ?? null,
    evolution_snapshot_id: contextPack.reflection_context?.evolution_snapshot_id ?? null,
    reflection_warnings: contextPack.reflection_context?.warnings ?? [],
  }

  if (contextPack.is_social_greeting) {
    return {
      ok: true,
      answer: generateGreetingAnswer({ identityFacts: contextPack.identity_context?.facts ?? [], personaProfile, question: query }),
      confidence: 0.65,
      persona_mode: 'social_response',
      persona_reason: 'Prompt adalah sapaan ringan, jadi agent menjawab pendek sesuai gaya komunikasi yang tersedia.',
      persona_confidence: 0.7,
      basis: [],
      sources: [],
      missing_context: [],
      suggested_next_actions: [],
      style_warnings: [],
      warnings: [],
      debug,
      communication_style_used: debug.communication_style_used,
      communication_pattern_ids: debug.communication_pattern_ids,
      communication_intent: debug.communication_intent,
      response_shape: debug.response_shape,
    }
  }

  if (localSources.length === 0) {
    const insufficientRoute = { mode: 'unknown_or_insufficient_memory', reason: 'Context retrieval tidak menemukan memory relevan.', confidence: 0.9 }
    return normalizeAnswer({
      answer: 'Memory yang tersedia belum cukup untuk menjawab ini. Tambahkan diary atau review graph terlebih dahulu.',
      confidence: 0.1,
      persona_mode: insufficientRoute.mode,
      persona_reason: insufficientRoute.reason,
      persona_confidence: insufficientRoute.confidence,
      basis: [],
      sources: [],
      missing_context: ['Tidak ada node, edge, raw entry, atau agent memory yang relevan dengan pertanyaan.'],
      suggested_next_actions: ['Tambahkan diary yang lebih spesifik.', 'Review graph sebelum memakai agent untuk keputusan besar.'],
      style_warnings: personaProfile ? [] : ['Persona profile belum tersedia. Jalankan npm run brain:persona.'],
      warnings: contextPack.warnings,
      debug,
    }, localSources, contextPack.warnings, debug, insufficientRoute, personaProfile)
  }

  try {
    const raw = await callLLM(JSON.stringify(contextPack, null, 2), buildPersonaSystemPrompt(personaRoute.mode, personaProfile))
    return normalizeAnswer(raw, localSources, contextPack.warnings, debug, personaRoute, personaProfile)
  } catch (err) {
    return normalizeAnswer({
      answer: fallbackAnswer(query, contextPack, personaRoute),
      confidence: 0.45,
      persona_mode: personaRoute.mode,
      persona_reason: personaRoute.reason,
      persona_confidence: personaRoute.confidence,
      basis: fallbackBasis(contextPack),
      sources: localSources.slice(0, 8),
      missing_context: [`LLM tidak menghasilkan JSON valid atau gagal dipanggil: ${err instanceof Error ? err.message : String(err)}`],
      suggested_next_actions: ['Cek konfigurasi BRAIN_CHAT_* atau LLM provider lokal.'],
      style_warnings: personaProfile ? [] : ['Persona profile belum tersedia. Jalankan npm run brain:persona.'],
      warnings: contextPack.warnings,
      debug,
    }, localSources, contextPack.warnings, debug, personaRoute, personaProfile)
  }
}

async function callLLM(contextPackJson, systemPrompt) {
  if (provider === 'claude-code') return await callClaudeCode(contextPackJson, systemPrompt)
  if (provider === 'anthropic') return await callAnthropic(contextPackJson, systemPrompt)
  if (provider === 'openai') return await callOpenAICompatible(contextPackJson, systemPrompt)
  if (provider === 'ollama') return await callOllama(contextPackJson, systemPrompt)
  throw new Error(`BRAIN_CHAT_PROVIDER/LLM_PROVIDER tidak dikenal: ${provider}`)
}

async function callClaudeCode(contextPackJson, systemPrompt) {
  const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
  const prompt = buildPrompt(contextPackJson, systemPrompt)
  const settingsArg = process.env.CLAUDE_CODE_API_KEY_HELPER === 'false'
    ? []
    : ['--settings', JSON.stringify({ apiKeyHelper: 'node -e "process.stdout.write(process.env.ANTHROPIC_API_KEY || process.env.BRAIN_CHAT_API_KEY || \'\')"'} )]
  const output = await runCommand(command, [
    ...(process.env.CLAUDE_CODE_BARE === 'false' ? [] : ['--bare']),
    ...settingsArg,
    '--no-session-persistence',
    '--output-format',
    'text',
    '-p',
    prompt,
  ], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
  return parseJsonOrThrow(output, 'Claude Code')
}

async function callAnthropic(contextPackJson, systemPrompt) {
  const baseUrl = requiredEnv('BRAIN_CHAT_BASE_URL', process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('BRAIN_CHAT_API_KEY', process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
  const model = requiredEnv('BRAIN_CHAT_MODEL', process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL)
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildUserPrompt(contextPackJson) }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  const text = Array.isArray(data.content)
    ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    : ''
  return parseJsonOrThrow(text, 'Anthropic')
}

async function callOpenAICompatible(contextPackJson, systemPrompt) {
  const baseUrl = requiredEnv('BRAIN_CHAT_BASE_URL', process.env.LLM_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('BRAIN_CHAT_API_KEY', process.env.LLM_API_KEY)
  const model = requiredEnv('BRAIN_CHAT_MODEL', process.env.LLM_MODEL)
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserPrompt(contextPackJson) },
      ],
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return parseJsonOrThrow(data?.choices?.[0]?.message?.content ?? '', 'OpenAI-compatible')
}

async function callOllama(contextPackJson, systemPrompt) {
  const baseUrl = (process.env.BRAIN_CHAT_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = requiredEnv('BRAIN_CHAT_MODEL', process.env.OLLAMA_MODEL)
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: buildPrompt(contextPackJson, systemPrompt), stream: false, format: 'json' }),
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return parseJsonOrThrow(data.response ?? '', 'Ollama')
}

function buildPrompt(contextPackJson, systemPrompt = SYSTEM_PROMPT) {
  return `${systemPrompt}\n\n${buildUserPrompt(contextPackJson)}`
}

function buildUserPrompt(contextPackJson) {
  return `CONTEXT PACK:\n${contextPackJson}\n\nBalas hanya JSON valid.`
}

function scoreNode(node, tokens, query) {
  const review = reviewStatus(node)
  if (review === 'ignored' || review === 'deleted' || review === 'merged') return -1000
  let score = 0
  const canon = normalize(node.canonical_name)
  const name = normalize(node.name)
  const normalizedQuery = normalize(query)
  if (canon && normalizedQuery.includes(canon)) score += 50
  if (name && normalizedQuery.includes(name)) score += 50
  for (const alias of asArray(node.aliases)) {
    if (normalize(alias) && normalizedQuery.includes(normalize(alias))) score += 40
  }
  score += textTokenScore([node.name, node.canonical_name], tokens, 20)
  score += textTokenScore([node.summary, node.description], tokens, 15)
  score += Number(node.importance_score ?? 0) / 10
  score += Math.min(Number(node.frequency_score ?? 0), 10)
  score += Number(node.confidence_score ?? 0.6) * 10
  score += recencyBonus(node.last_seen_at)
  if (review === 'approved') score += 10
  if (review === 'pending_review') score -= 3
  return score
}

function scoreEdge(edge, tokens, query) {
  const review = reviewStatus(edge)
  if (review === 'ignored' || review === 'deleted') return -1000
  let score = 0
  const normalizedQuery = normalize(query)
  if (normalize(edge.relation_type) && normalizedQuery.includes(normalize(edge.relation_type))) score += 10
  score += textTokenScore([edge.relation_type], tokens, 10)
  score += textTokenScore([edge.summary], tokens, 15)
  score += Number(edge.confidence_score ?? 0.6) * 10
  if (review === 'approved') score += 10
  if (review === 'pending_review') score -= 3
  return score
}

function scoreMemory(memory, tokens, query) {
  const review = reviewStatus(memory)
  if (review === 'ignored' || review === 'deleted') return -1000
  let score = 0
  const content = normalize(memory.content)
  const normalizedQuery = normalize(query)
  if (content && normalizedQuery && content.includes(normalizedQuery)) score += 20
  score += textTokenScore([memory.content, memory.memory_type, memory.importance_level], tokens, 20)
  score += memory.importance_level === 'core' ? 20 : memory.importance_level === 'important' ? 14 : 5
  score += memory.stability === 'core' ? 10 : memory.stability === 'stable' ? 7 : 2
  score += recencyBonus(memory.created_at)
  if (review === 'approved') score += 10
  return score
}

function scoreLongTermMemory(memory, tokens, query) {
  let score = 0
  const text = [memory.title, memory.canonical_statement, memory.summary, memory.memory_type].join(' ')
  const normalizedQuery = normalize(query)
  if (normalize(memory.title) && normalizedQuery.includes(normalize(memory.title))) score += 24
  score += textTokenScore([text], tokens, 28)
  score += Number(memory.importance_score ?? 0.5) * 24
  score += Number(memory.confidence_score ?? 0.5) * 16
  score += memory.stability === 'core' ? 18 : memory.stability === 'stable' ? 12 : memory.stability === 'recurring' ? 8 : 2
  if (memory.status === 'needs_review') score -= 10
  if (memory.freshness === 'stale') score -= 8
  return score
}

function scoreRawEntry(entry, tokens, query) {
  let score = 0
  const normalizedQuery = normalize(query)
  if (normalize(entry.title) && normalizedQuery.includes(normalize(entry.title))) score += 20
  score += textTokenScore([entry.title, entry.content], tokens, 20)
  score += recencyBonus(entry.happened_at ?? entry.created_at)
  return score
}

function textTokenScore(values, tokens, weight) {
  if (tokens.length === 0) return 0
  const text = normalizeWords(values.filter(Boolean).join(' '))
  if (!text) return 0
  let hits = 0
  for (const token of tokens) {
    if (text.includes(token)) hits += 1
  }
  return (hits / tokens.length) * weight
}

function topPositive(scored, limit) {
  return topUnique(scored.filter(({ score }) => score > 0), limit)
}

function topUnique(scored, limit) {
  const seen = new Set()
  return scored
    .sort((a, b) => b.score - a.score)
    .filter(({ item }) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .slice(0, limit)
    .map(({ item }) => item)
}

function formatNode(node) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    canonical_name: node.canonical_name,
    aliases: asArray(node.aliases),
    summary: node.summary,
    description: node.description,
    importance_score: node.importance_score,
    frequency_score: node.frequency_score,
    confidence_score: node.confidence_score,
    review_status: reviewStatus(node),
    last_seen_at: node.last_seen_at,
  }
}

function formatEdge(edge, nodeById) {
  return {
    id: edge.id,
    from: nodeById.get(edge.from_node_id)?.name ?? edge.from_node_id,
    to: nodeById.get(edge.to_node_id)?.name ?? edge.to_node_id,
    relation_type: edge.relation_type,
    summary: edge.summary,
    weight: edge.weight,
    confidence_score: edge.confidence_score,
    review_status: reviewStatus(edge),
  }
}

function formatMemory(memory) {
  return {
    id: memory.id,
    memory_type: memory.memory_type,
    content: memory.content,
    importance_level: memory.importance_level,
    stability: memory.stability,
    sensitivity: memory.sensitivity,
    created_at: memory.created_at,
    review_status: reviewStatus(memory),
  }
}

function formatLongTermMemory(memory) {
  return {
    id: memory.id,
    memory_type: memory.memory_type,
    title: memory.title,
    canonical_statement: memory.canonical_statement,
    summary: memory.summary,
    importance_score: memory.importance_score,
    confidence_score: memory.confidence_score,
    stability: memory.stability,
    freshness: memory.freshness,
    status: memory.status,
    related_conflict_ids: memory.related_conflict_ids ?? [],
  }
}

function formatRawEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    date: entry.happened_at ?? entry.created_at,
    excerpt: excerpt(entry.content, 900),
    processing_status: entry.processing_status,
  }
}

function buildIdentityContext(query, facts, snapshots, personalIdentity, greeting) {
  const activeFacts = asArray(facts).filter((fact) => ['active', 'contradicted', 'needs_review'].includes(fact.status))
  const candidateFacts = greeting ? activeFacts.filter((fact) => fact.fact_type === 'communication_pattern') : activeFacts
  const latestSnapshot = asArray(snapshots).find((snapshot) => snapshot.status === 'done' || snapshot.status === 'needs_review') ?? null
  const scored = candidateFacts
    .map((fact) => ({ fact, score: scoreIdentityFact(fact, query, personalIdentity, greeting) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, greeting ? 6 : 18)
    .map(({ fact }) => formatIdentityFact(fact))
  const warnings = []
  if (personalIdentity && activeFacts.length === 0) warnings.push('Identity facts belum tersedia. Jalankan npm run identity:build.')
  if (personalIdentity && scored.length === 0) warnings.push('Identity facts tersedia, tetapi belum cukup relevan untuk pertanyaan ini.')
  if (greeting && !scored.some((fact) => fact.fact_type === 'communication_pattern' && Number(fact.confidence_score) >= 0.65)) {
    warnings.push('Communication pattern untuk greeting belum cukup kuat.')
  }
  const lowConfidence = scored.filter((fact) => Number(fact.confidence_score) < 0.65).length
  if (lowConfidence) warnings.push(`${lowConfidence} identity facts relevan masih low/medium confidence; jangan dipakai sebagai klaim tegas.`)
  return {
    priority: personalIdentity ? 'primary' : 'supporting',
    facts: scored,
    snapshot: latestSnapshot ? {
      id: latestSnapshot.id,
      title: latestSnapshot.title,
      summary: latestSnapshot.summary,
      confidence_summary: latestSnapshot.confidence_summary,
      data_coverage: latestSnapshot.data_coverage,
      warnings: latestSnapshot.warnings,
      created_at: latestSnapshot.created_at,
    } : null,
    usage_rules: [
      'High-confidence identity facts boleh dipakai untuk klaim tegas.',
      'Low-confidence identity facts hanya boleh disebut sebagai kemungkinan.',
      'Jika evidence tidak cukup, jawab belum cukup data.',
      'Persona profile lama hanya konteks tambahan jika identity_facts tersedia.',
    ],
    warnings,
  }
}

function buildResponsePolicy(isSocialGreeting, communicationContext = null) {
  const responseShape = communicationContext?.response_shape ?? {}
  if (isSocialGreeting) {
    return {
      intentType: 'social_greeting',
      isSocialGreeting: true,
      requiresSources: false,
      requiresBasis: false,
      requiresMissingContext: false,
      requiresNextActions: false,
      requiresDeepRetrieval: false,
      maxAnswerSentences: 1,
      exposeWarningsToUser: false,
      exposeDebugToUser: false,
      responseShape: { max_sentences: 1, show_sources: false, show_debug_by_default: false, ...(responseShape ?? {}) },
    }
  }
  return {
    intentType: communicationContext?.intent ?? 'analytical_query',
    isSocialGreeting: false,
    requiresSources: true,
    requiresBasis: true,
    requiresMissingContext: true,
    requiresNextActions: true,
    requiresDeepRetrieval: true,
    maxAnswerSentences: null,
    exposeWarningsToUser: true,
    exposeDebugToUser: true,
    responseShape,
  }
}

function generateGreetingAnswer({ identityFacts, question }) {
  const normalized = normalizeWords(question)
  const communicationPattern = asArray(identityFacts).find((fact) => fact.fact_type === 'communication_pattern' && Number(fact.confidence_score ?? 0) >= 0.65)
  if (/^assalamu\s?alaikum/i.test(normalized)) return 'Wa’alaikumussalam, ada apa?'
  if (/^p+$/i.test(normalized) || normalized === 'ping') return 'Iya, kenapa?'
  if (/^bro+$/i.test(normalized)) return 'Iya bro, ada apa?'
  if (/^selamat pagi$/i.test(normalized)) return 'Pagi, ada apa?'
  if (/^selamat siang$/i.test(normalized)) return 'Siang, ada apa?'
  if (/^selamat sore$/i.test(normalized)) return 'Sore, ada apa?'
  if (/^selamat malam$/i.test(normalized)) return 'Malam, ada apa?'
  if (communicationPattern) return 'Halo, kenapa?'
  return normalized.startsWith('hai') ? 'Hai, mau bahas apa?' : 'Halo, kenapa?'
}

function buildCommunicationContext(query, patterns, samples, intent, greeting) {
  const scored = asArray(patterns)
    .map((pattern) => ({ pattern, score: scoreCommunicationPattern(pattern, intent, query, greeting) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, greeting ? 2 : 8)
    .map(({ pattern }) => formatCommunicationPattern(pattern))
  const sampleHits = asArray(samples)
    .filter((sample) => sample.intent_type === intent || (greeting && sample.intent_type === 'greeting'))
    .slice(0, greeting ? 3 : 10)
  const responseShape = mergeResponseShapes(scored.map((pattern) => pattern.preferred_response_shape))
  return {
    intent,
    patterns: scored,
    samples: sampleHits.map((sample) => ({
      id: sample.id,
      sample_type: sample.sample_type,
      text: sample.text,
      tone: sample.tone,
      formality: sample.formality,
      length_class: sample.length_class,
      intent_type: sample.intent_type,
      confidence_score: sample.confidence_score,
    })),
    response_shape: responseShape,
    warnings: scored.length ? [] : [`Communication pattern untuk intent ${intent} belum tersedia.`],
  }
}

function scoreCommunicationPattern(pattern, intent, query, greeting) {
  let score = Number(pattern.confidence_score ?? 0.45) * 40
  const triggers = asArray(pattern.trigger_intents)
  if (triggers.includes(intent)) score += 50
  if (greeting && pattern.pattern_type === 'greeting_style') score += 80
  if (intent === 'request_prompt' && pattern.pattern_type === 'prompt_request_style') score += 80
  if (intent === 'technical_instruction' && pattern.pattern_type === 'technical_style') score += 70
  if (intent === 'correction' && pattern.pattern_type === 'correction_style') score += 70
  if (intent === 'strategy_question' && pattern.pattern_type === 'decision_style') score += 60
  const text = normalizeWords([pattern.label, pattern.description].join(' '))
  for (const token of tokenize(query)) if (text.includes(token)) score += 5
  return score
}

function formatCommunicationPattern(pattern) {
  return {
    id: pattern.id,
    pattern_type: pattern.pattern_type,
    label: pattern.label,
    description: pattern.description,
    examples: asArray(pattern.examples),
    anti_examples: asArray(pattern.anti_examples),
    preferred_response_shape: pattern.preferred_response_shape ?? {},
    trigger_intents: asArray(pattern.trigger_intents),
    confidence_score: Number(pattern.confidence_score ?? 0),
    stability: pattern.stability,
    usage_rules: asArray(pattern.usage_rules),
  }
}

function mergeResponseShapes(shapes) {
  return shapes.reduce((acc, shape) => ({ ...acc, ...(shape && typeof shape === 'object' ? shape : {}) }), {})
}

function detectCommunicationIntent(query, greeting = isSocialGreeting(query)) {
  const normalized = normalizeWords(query)
  if (greeting) return 'greeting'
  if (/\b(buatkan|bikin|tuliskan).{0,40}\bprompt\b|\bprompt siap paste\b/i.test(normalized)) return 'request_prompt'
  if (/\b(revisi|kurang|belum sesuai|ubah|jangan|fix|perbaiki|hotfix)\b/i.test(normalized)) return 'correction'
  if (/\b(file|command|npm|script|migration|endpoint|logic|frontend|backend|supabase|table|route|json|build|implementasi|coding agent)\b/i.test(normalized)) return 'technical_instruction'
  if (/\b(fokus|strategi|prioritas|harus|apakah sudah|arah|keputusan)\b/i.test(normalized)) return 'strategy_question'
  if (/\b(saya|pola pikir|takut|ambisi|menurut data|menurut diary)\b/i.test(normalized)) return 'reflection'
  if (/\b(lanjut|oke|sip|gas|next)\b/i.test(normalized)) return 'follow_up'
  return 'unknown'
}

function scoreIdentityFact(fact, query, personalIdentity, greeting) {
  if (!fact?.label || !fact?.statement) return 0
  const confidence = Number(fact.confidence_score ?? 0.45)
  let score = confidence * 30 + asArray(fact.evidence_refs).length * 4
  const normalized = normalizeWords(query)
  const haystack = normalizeWords([fact.fact_type, fact.label, fact.statement].join(' '))
  for (const token of tokenize(query)) {
    if (haystack.includes(token)) score += 8
  }
  if (greeting) {
    if (fact.fact_type === 'communication_pattern') score += 80
    else if (['boundary', 'identity_summary'].includes(fact.fact_type)) score += 8
    else score -= 20
  } else if (personalIdentity) {
    if (['trait', 'belief', 'value', 'preference', 'goal', 'fear', 'ambition', 'decision_pattern', 'communication_pattern', 'emotional_pattern', 'risk_pattern', 'contradiction', 'boundary', 'identity_summary'].includes(fact.fact_type)) score += 35
  }
  if (normalized.includes('belum cukup') || normalized.includes('apa yang belum')) {
    if (fact.fact_type === 'boundary' || confidence < 0.65) score += 30
  }
  if (fact.status === 'contradicted' || fact.fact_type === 'contradiction') score += normalized.includes('kontradiksi') ? 40 : 10
  if (fact.status === 'needs_review') score -= 10
  return score
}

function formatIdentityFact(fact) {
  return {
    id: fact.id,
    fact_type: fact.fact_type,
    label: fact.label,
    statement: fact.statement,
    evidence_refs: asArray(fact.evidence_refs),
    confidence_score: Number(fact.confidence_score ?? 0),
    stability: fact.stability,
    strength: fact.strength,
    polarity: fact.polarity,
    usage_scope: asArray(fact.usage_scope),
    status: fact.status,
    contradiction_refs: asArray(fact.contradiction_refs),
    last_seen_at: fact.last_seen_at,
  }
}

function isSocialGreeting(query) {
  const normalized = normalizeWords(query)
  return [
    /^hi+$/i,
    /^hai+$/i,
    /^halo+$/i,
    /^hello+$/i,
    /^p+$/i,
    /^ping$/i,
    /^bro+$/i,
    /^yo$/i,
    /^hei$/i,
    /^assalamu\s?alaikum/i,
    /^salam/i,
    /^selamat pagi$/i,
    /^selamat siang$/i,
    /^selamat sore$/i,
    /^selamat malam$/i,
  ].some((pattern) => pattern.test(normalized))
}

function isPersonalIdentityQuery(query) {
  const normalized = normalizeWords(query)
  return [
    'saya orang seperti apa',
    'menurut data saya',
    'pola saya',
    'gaya saya',
    'cara saya',
    'nilai saya',
    'prinsip saya',
    'preferensi saya',
    'ketakutan saya',
    'ambisi saya',
    'tujuan saya',
    'kontradiksi saya',
    'belum cukup kamu tahu',
    'apa yang belum cukup',
    'mirip saya',
    'pemilik diary',
  ].some((keyword) => normalized.includes(keyword))
}

function localSourcesFromContext(contextPack) {
  return [
    ...asArray(contextPack.identity_context?.facts).map((fact) => ({
      type: 'identity_fact',
      id: fact.id,
      label: `${fact.fact_type}: ${fact.label}`,
      excerpt: excerpt(fact.statement, 180),
    })),
    ...(contextPack.identity_context?.snapshot ? [{
      type: 'identity_snapshot',
      id: contextPack.identity_context.snapshot.id,
      label: contextPack.identity_context.snapshot.title || 'Identity snapshot',
      excerpt: excerpt(contextPack.identity_context.snapshot.summary, 180),
    }] : []),
    ...contextPack.relevant_memories.map((memory) => ({
      type: 'agent_memory',
      id: memory.id,
      label: `${memory.memory_type} memory`,
      excerpt: excerpt(memory.content, 180),
    })),
    ...contextPack.relevant_nodes.map((node) => ({
      type: 'brain_node',
      id: node.id,
      label: node.name,
      excerpt: excerpt(node.summary ?? node.description, 180),
    })),
    ...contextPack.relevant_edges.map((edge) => ({
      type: 'brain_edge',
      id: edge.id,
      label: `${edge.from} -> ${edge.relation_type} -> ${edge.to}`,
      excerpt: excerpt(edge.summary, 180),
    })),
    ...contextPack.relevant_raw_entries.map((entry) => ({
      type: 'raw_entry',
      id: entry.id,
      label: entry.title || entry.date || 'Raw entry',
      excerpt: excerpt(entry.excerpt, 180),
    })),
  ]
}

function normalizeAnswer(raw, localSources, warnings, debug, personaRoute, personaProfile) {
  const answer = typeof raw?.answer === 'string' && raw.answer.trim()
    ? raw.answer.trim()
    : 'Memory yang tersedia belum cukup untuk menjawab ini. Tambahkan diary atau review graph terlebih dahulu.'
  const rawSources = Array.isArray(raw?.sources) ? raw.sources : []
  const validLocalIds = new Set(localSources.map((source) => `${source.type}:${source.id}`))
  const sourceByKey = new Map(localSources.map((source) => [`${source.type}:${source.id}`, source]))
  const sources = rawSources
    .map((source) => sourceByKey.get(`${source?.type}:${source?.id}`))
    .filter(Boolean)
  const finalSources = sources.length > 0 ? sources : localSources.slice(0, 10)

  return {
    ok: true,
    answer,
    confidence: clampNumber(raw?.confidence, 0, 1, localSources.length ? 0.5 : 0.1),
    persona_mode: validPersonaMode(raw?.persona_mode) ? raw.persona_mode : personaRoute.mode,
    persona_reason: typeof raw?.persona_reason === 'string' && raw.persona_reason.trim() ? raw.persona_reason.trim() : personaRoute.reason,
    persona_confidence: clampNumber(raw?.persona_confidence, 0, 1, personaRoute.confidence),
    basis: arrayOfStrings(raw?.basis).slice(0, 8),
    sources: finalSources.filter((source) => validLocalIds.has(`${source.type}:${source.id}`)).slice(0, 10),
    missing_context: arrayOfStrings(raw?.missing_context).slice(0, 6),
    suggested_next_actions: arrayOfStrings(raw?.suggested_next_actions).slice(0, 6),
    style_warnings: [
      ...arrayOfStrings(raw?.style_warnings),
      ...(personaProfile ? [] : ['Persona profile belum tersedia atau belum cukup data.']),
    ].slice(0, 6),
    warnings: [...new Set([...(Array.isArray(raw?.warnings) ? arrayOfStrings(raw.warnings) : []), ...warnings])],
    debug,
    communication_style_used: debug.communication_style_used,
    communication_pattern_ids: debug.communication_pattern_ids,
    communication_intent: debug.communication_intent,
    response_shape: debug.response_shape,
  }
}

function fallbackAnswer(query, contextPack, personaRoute) {
  if (contextPack.is_social_greeting) {
    return generateGreetingAnswer({ identityFacts: contextPack.identity_context?.facts ?? [], personaProfile: null, question: query })
  }
  if (asArray(contextPack.identity_context?.facts).length && ['self_clone_reflection', 'diary_owner_voice', 'strategic_mirror'].includes(personaRoute.mode)) {
    const high = contextPack.identity_context.facts.filter((fact) => Number(fact.confidence_score ?? 0) >= 0.65).slice(0, 5)
    const low = contextPack.identity_context.facts.filter((fact) => Number(fact.confidence_score ?? 0) < 0.65).slice(0, 3)
    return [
      high.length ? `Yang cukup kuat dari identity_facts: ${high.map((fact) => fact.statement).join(' ')}` : 'Identity_facts belum punya klaim high-confidence untuk pertanyaan ini.',
      low.length ? `Yang masih kemungkinan: ${low.map((fact) => fact.statement).join(' ')}` : '',
    ].filter(Boolean).join('\n')
  }
  if (personaRoute.mode === 'planning_guard') {
    return 'Berdasarkan memory yang tersedia, dorongan menambah fase/fitur perlu ditahan dulu. Pertanyaan terpenting bukan fitur apa lagi, tapi apakah fitur yang sudah ada dipakai harian, menghasilkan keputusan lebih baik, dan mengurangi noise. Lanjutkan hanya setelah ada bukti penggunaan nyata.'
  }
  if (personaRoute.mode === 'contradiction_detector') {
    return 'Berdasarkan context yang ada, saya bisa mencari kontradiksi hanya dari memory yang terambil. Fokus koreksinya: bandingkan target yang sering muncul dengan tindakan/entry yang benar-benar tercatat. Jika evidence belum cukup, tulis diary yang eksplisit: target, tindakan hari ini, dan alasan tidak jalan.'
  }
  if (personaRoute.mode === 'strategic_mirror') {
    return 'Yang paling penting: pakai sistem yang sudah dibangun untuk menghasilkan keputusan nyata, bukan hanya menambah lapisan baru. Yang harus dihentikan: ekspansi fitur tanpa bukti pemakaian. Yang harus dibuktikan: minimal satu minggu diary, review, chat, digest, dan keputusan yang benar-benar terbantu. Next 3 actions: review low confidence, pakai Brain Chat untuk satu keputusan, lalu tulis hasilnya di diary.'
  }
  const parts = []
  if (contextPack.relevant_memories.length) parts.push(`Memory relevan: ${contextPack.relevant_memories.slice(0, 3).map((m) => m.content).join(' ')}`)
  if (contextPack.relevant_nodes.length) parts.push(`Node relevan: ${contextPack.relevant_nodes.slice(0, 5).map((n) => `${n.name} (${n.type})`).join(', ')}.`)
  if (contextPack.relevant_edges.length) parts.push(`Relasi relevan: ${contextPack.relevant_edges.slice(0, 5).map((e) => `${e.from} -> ${e.relation_type} -> ${e.to}`).join(', ')}.`)
  if (!parts.length) return 'Memory yang tersedia belum cukup untuk menjawab ini. Tambahkan diary atau review graph terlebih dahulu.'
  return `Berdasarkan context pack untuk pertanyaan "${query}", ini ringkasan read-only yang bisa dipercaya terbatas: ${parts.join('\n')}`
}

function fallbackBasis(contextPack) {
  return [
    ...contextPack.relevant_memories.slice(0, 3).map((memory) => `Agent memory: ${excerpt(memory.content, 120)}`),
    ...contextPack.relevant_nodes.slice(0, 3).map((node) => `Node ${node.name} punya importance ${node.importance_score ?? 'unknown'} dan confidence ${node.confidence_score ?? 'unknown'}.`),
    ...contextPack.relevant_edges.slice(0, 3).map((edge) => `Edge ${edge.from} -> ${edge.relation_type} -> ${edge.to}.`),
  ]
}

function loadPersonaProfile() {
  const path = resolve(vaultPath, '_system', 'persona', 'Persona Profile.md')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const auto = text.includes('<!-- BRAIN_PERSONA_AUTO_START -->') && text.includes('<!-- BRAIN_PERSONA_AUTO_END -->')
    ? text.slice(text.indexOf('<!-- BRAIN_PERSONA_AUTO_START -->'), text.indexOf('<!-- BRAIN_PERSONA_AUTO_END -->'))
    : text
  return {
    raw: excerpt(auto, 5000),
    communication_style: extractSectionList(auto, 'Communication Style'),
    active_projects: extractSectionList(auto, 'Active Projects'),
    goals: extractSectionList(auto, 'Goals'),
    repeated_patterns: extractSectionList(auto, 'Repeated Patterns'),
    risk_patterns: extractSectionList(auto, 'Risk Patterns'),
    confidence_warnings: extractSectionList(auto, 'Confidence Warnings'),
  }
}

function attachPersonaContext(contextPack, personaProfile, personaRoute) {
  contextPack.persona_profile = personaProfile
  contextPack.persona_route = personaRoute
  contextPack.style_warnings = personaProfile ? personaProfile.confidence_warnings ?? [] : ['Persona profile belum tersedia. Jalankan npm run brain:persona.']
}

function detectPersonaMode(question, contextPack, personaProfile) {
  const sourceCount = contextPack.relevant_nodes.length + contextPack.relevant_edges.length + contextPack.relevant_memories.length + contextPack.relevant_raw_entries.length
  if (contextPack.is_social_greeting) {
    return { mode: 'social_response', reason: 'Pertanyaan adalah sapaan ringan, jadi jawab pendek tanpa retrieval report.', confidence: 0.82 }
  }
  const identityCount = contextPack.identity_context?.facts?.length ?? 0
  if (sourceCount === 0) {
    if (identityCount > 0) return { mode: 'self_clone_reflection', reason: 'Context umum kosong, tetapi identity_facts relevan tersedia.', confidence: 0.76 }
    return { mode: 'unknown_or_insufficient_memory', reason: 'Context retrieval tidak menemukan memory relevan.', confidence: 0.9 }
  }
  const normalized = normalizeWords(question)
  const scores = {
    factual_brain_reader: keywordScore(normalized, ['apa itu', 'hubungan', 'project apa', 'siapa', 'kapan', 'berapa', 'data', 'muncul', 'sering']),
    self_clone_reflection: keywordScore(normalized, ['saya ini orang seperti apa', 'pola pikir', 'takut', 'sebenarnya saya', 'yang saya kejar', 'diri saya', 'refleksi', 'menurut diary']),
    strategic_mirror: keywordScore(normalized, ['harus fokus', 'fokuskan', 'apa yang salah', 'langkah paling cepat', 'menghambat', 'strategi', 'prioritas', 'eksekusi']),
    diary_owner_voice: keywordScore(normalized, ['jawab seperti saya', 'kalau saya yang ngomong', 'gaya saya', 'seolah kamu', 'versi diary saya', 'seperti pemilik diary']),
    contradiction_detector: keywordScore(normalized, ['tidak saya lakukan', 'kontradiksi', 'pola buruk', 'romantisasi', 'saya bilang tapi', 'bohongi diri', 'menghindar']),
    planning_guard: keywordScore(normalized, ['fitur apa lagi', 'roadmap besar', 'tambah agent', 'fase berikutnya', 'lanjut fitur', 'bikin fitur', 'next phase']),
  }
  if (/\b(apa|siapa|kapan|berapa|hubungan|project)\b/.test(normalized)) scores.factual_brain_reader += 1
  if (/\b(fokus|prioritas|strategi|cepat|hambat|salah)\b/.test(normalized)) scores.strategic_mirror += 1
  if (/\b(kontradiksi|buruk|romantisasi|tidak saya lakukan)\b/.test(normalized)) scores.contradiction_detector += 2
  if (!personaProfile && scores.diary_owner_voice > 0) {
    return { mode: 'diary_owner_voice', reason: 'User meminta gaya pemilik diary, tetapi persona profile belum tersedia penuh.', confidence: 0.72 }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [mode, score] = ranked[0]
  if (!mode || score <= 0) {
    return { mode: contextPack.warnings.length ? 'unknown_or_insufficient_memory' : 'factual_brain_reader', reason: contextPack.warnings.length ? 'Intent tidak jelas dan context memiliki warning.' : 'Pertanyaan paling dekat dengan pembacaan factual.', confidence: 0.45 }
  }
  return { mode, reason: personaReason(mode), confidence: Math.min(0.95, 0.55 + score * 0.12) }
}

function buildPersonaSystemPrompt(mode, personaProfile) {
  return `${SYSTEM_PROMPT}

PERSONA LAYER:
- Mode dipilih otomatis: ${mode}
- Jangan tampilkan pilihan mode ke user.
- Jangan mengaku sebagai user asli dan jangan berkata "aku adalah kamu".
- Gunakan formula aman: "Berdasarkan diary dan memory yang tersedia..." atau "Versi jawaban yang paling cocok dengan pola kamu adalah..."
- Tetap grounded pada context pack dan sources.
- Jika context pack berisi identity_context, prioritaskan identity_facts daripada persona profile lama untuk klaim tentang identitas, gaya, nilai, pola keputusan, risiko, dan sapaan.
- Jika context pack berisi communication_context, gunakan communication_patterns dan response_shape untuk menentukan panjang, format, dan nada jawaban.
- Jika context pack berisi reflection_context, perlakukan sebagai konteks pendukung saja: identity_facts tetap sumber utama klaim identitas. Jika reflection_context menyebut uncertainty atau high-risk fidelity, turunkan confidence dan jawab lebih hati-hati. Jangan menjawab hanya berdasarkan reflection tanpa evidence.
- Untuk intent request_prompt, langsung berikan prompt siap paste dalam blok yang rapi; minim teori sebelum prompt.
- Untuk intent correction, jangan defensif; langsung revisi.
- Untuk intent technical_instruction, jawab step-by-step dan sebut file/command jika relevan.
- Klaim tegas hanya boleh memakai identity_facts dengan confidence_score >= 0.65. Di bawah itu gunakan bahasa "kemungkinan", "sinyal awal", atau "belum cukup kuat".
- Untuk greeting, jangan membongkar diary panjang. Jawab pendek memakai communication_pattern jika confidence cukup; kalau belum cukup, jawab netral pendek.
- Persona profile tersedia: ${personaProfile ? 'ya' : 'tidak'}.

VOICE MEMORY:
${personaProfile ? personaProfile.raw : 'Persona profile belum tersedia. Pakai gaya netral dan jujur soal keterbatasan data.'}

MODE RULES:
${modeRules(mode)}

Balas hanya JSON valid dengan field:
answer, confidence, persona_mode, persona_reason, persona_confidence, basis, sources, missing_context, suggested_next_actions, style_warnings.`
}

function modeRules(mode) {
  const rules = {
    social_response: '- Jawab maksimal 1 kalimat.\n- Jangan tampilkan sources, missing context, basis, next actions, atau warning identity.\n- Jangan menyebut diary, memory, atau Personal Brain OS kecuali user menyebutnya.',
    factual_brain_reader: '- Jawab langsung, objektif, ringkas, dan tampilkan sources.\n- Jika data tidak cukup, bilang tidak cukup.',
    self_clone_reflection: '- Struktur: Yang tampak dari data; Kemungkinan maknanya; Yang belum pasti.\n- Jangan mengarang kepribadian.',
    strategic_mirror: '- Struktur: Yang paling penting; Yang harus dihentikan; Yang harus dibuktikan; Next 3 actions.\n- Tajam, fokus eksekusi, proof, revenue, leverage, skill.',
    diary_owner_voice: '- Jawab dengan gaya yang mirip voice memory.\n- Awali dengan "Berdasarkan pola diary, versi jawaban yang paling mirip adalah..."\n- Jangan klaim identitas asli.',
    contradiction_detector: '- Struktur: Klaim/target; Bukti perilaku dari diary; Kontradiksi; Dampak; Koreksi.\n- Keras tapi fokus perilaku, bukan menyerang personal.',
    planning_guard: '- Tahan scope creep.\n- Cek apakah fitur berikutnya menambah penggunaan nyata.\n- Sebut proof yang harus ada sebelum lanjut dan fitur yang harus ditunda.',
    unknown_or_insufficient_memory: '- Jangan karang.\n- Sebut data yang kurang.\n- Sarankan diary/data spesifik yang perlu ditambahkan.',
  }
  return rules[mode] ?? rules.factual_brain_reader
}

function personaReason(mode) {
  const reasons = {
    social_response: 'Pertanyaan adalah sapaan ringan, jadi jawab pendek tanpa retrieval report.',
    factual_brain_reader: 'Pertanyaan meminta fakta/data dari brain.',
    self_clone_reflection: 'Pertanyaan meminta refleksi diri berdasarkan diary dan memory.',
    strategic_mirror: 'Pertanyaan meminta evaluasi strategi, fokus, atau langkah eksekusi.',
    diary_owner_voice: 'Pertanyaan meminta jawaban dengan gaya komunikasi pemilik diary.',
    contradiction_detector: 'Pertanyaan meminta konflik antara klaim, pola, dan perilaku.',
    planning_guard: 'Pertanyaan mengarah ke penambahan fitur/roadmap sehingga perlu guard terhadap scope creep.',
    unknown_or_insufficient_memory: 'Memory relevan belum cukup untuk menjawab dengan aman.',
  }
  return reasons[mode] ?? reasons.factual_brain_reader
}

function keywordScore(text, keywords) {
  return keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0)
}

function extractSectionList(text, title) {
  const match = text.match(new RegExp(`## ${title}\\n([\\s\\S]*?)(\\n## |$)`))
  if (!match) return []
  return match[1].split(/\r?\n/).map((line) => line.replace(/^-\s*/, '').trim()).filter(Boolean)
}

function validPersonaMode(value) {
  return ['social_response', 'factual_brain_reader', 'self_clone_reflection', 'strategic_mirror', 'diary_owner_voice', 'contradiction_detector', 'planning_guard', 'unknown_or_insufficient_memory'].includes(value)
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) {
    console.log('[brain-chat] Supabase mode: service role local')
    return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  }

  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  })
  if (accessToken) return client

  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) {
    throw new Error('Set SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, atau SUPABASE_USER_EMAIL/SUPABASE_USER_PASSWORD untuk brain-chat.')
  }
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

async function resolveUserId() {
  const { data } = await supabase.auth.getUser()
  if (data?.user?.id) return data.user.id
  const latest = await supabase.from('raw_entries').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (latest.error) throw latest.error
  return latest.data?.user_id ?? null
}

function reviewStatus(item) {
  const status = item?.metadata?.review_status
  return ['pending_review', 'approved', 'ignored', 'merged', 'deleted'].includes(status) ? status : 'pending_review'
}

function tokenize(value) {
  return normalizeWords(value).split(/\s+/).filter((token) => token.length > 2)
}

function normalize(value) {
  return String(value ?? '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9]+/g, '')
}

function normalizeWords(value) {
  return String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ')
}

function recencyBonus(value) {
  if (!value) return 0
  const ageMs = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0
  const days = ageMs / 86400000
  return Math.max(0, Math.min(10, 10 - days / 30))
}

function excerpt(value, length) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length - 1)}...` : text
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

function runCommand(command, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timeout setelah ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${command} exited ${code}: ${output.slice(0, 1000)}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function parseArgs(argv) {
  const parsed = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    parsed.set(item.slice(2), argv[i + 1] ?? '')
    i += 1
  }
  return parsed
}

function readArg(name) {
  const value = args.get(name)
  if (!value) throw new Error(`Missing required argument --${name}`)
  return value
}

function readOptionalArg(name) {
  const value = args.get(name)
  return value ? String(value) : ''
}

function readIntArg(name, fallback, min, max) {
  const raw = args.get(name)
  const value = raw ? Number(raw) : fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function readBoolArg(name, fallback) {
  const raw = args.get(name)
  if (!raw) return fallback
  return raw === 'true'
}

function readBoolEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
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

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function vectorLiteral(values) {
  if (values.length !== embeddingDimensions) {
    throw new Error(`Embedding dimension mismatch: got ${values.length}, expected ${embeddingDimensions}`)
  }
  return `[${values.map((value) => Number(value).toFixed(8)).join(',')}]`
}
