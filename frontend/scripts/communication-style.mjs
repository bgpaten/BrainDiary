import { createClient } from '@supabase/supabase-js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const AUTO_START = '<!-- COMMUNICATION_STYLE_AUTO_START -->'
const AUTO_END = '<!-- COMMUNICATION_STYLE_AUTO_END -->'
const SAMPLE_TYPES = new Set(['diary_sentence', 'chat_message', 'instruction', 'reply', 'reflection', 'question', 'decision_note', 'manual_example'])
const SOURCE_TYPES = new Set(['raw_entry', 'agent_memory', 'manual', 'imported_chat', 'brain_report'])
const TONES = new Set(['direct', 'casual', 'formal', 'firm', 'reflective', 'technical', 'emotional', 'neutral', 'mixed'])
const FORMALITY = new Set(['very_casual', 'casual', 'neutral', 'formal'])
const LENGTHS = new Set(['short', 'medium', 'long'])
const INTENTS = new Set(['greeting', 'request_prompt', 'technical_instruction', 'strategy_question', 'reflection', 'correction', 'complaint', 'decision', 'follow_up', 'casual_reply', 'unknown'])
const PATTERN_TYPES = new Set(['greeting_style', 'instruction_style', 'question_style', 'correction_style', 'decision_style', 'technical_style', 'reflection_style', 'casual_style', 'rejection_style', 'follow_up_style', 'prompt_request_style', 'general_voice'])
const STABILITY = ['temporary', 'recurring', 'stable', 'core']
const SYSTEM_PROMPT = `Kamu adalah Communication Style Extractor untuk Personal Entity OS.

Tugasmu:
- Mengekstrak gaya komunikasi pemilik diary dari data.
- Jangan mengarang gaya yang tidak ada evidence.
- Bedakan gaya sapaan, gaya instruksi, gaya koreksi, gaya teknis, gaya refleksi, dan gaya santai.
- Jangan membuat pemilik diary terdengar lebih formal dari data.
- Jangan membuat pemilik diary terdengar lebih puitis dari data.
- Jangan membuat pemilik diary terdengar lebih sopan atau lebih kasar dari data.
- Jika data kurang, tulis warning.
- Semua pattern harus punya evidence atau confidence rendah.
- Output hanya JSON valid.`

loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env.local'), { override: true })

const args = parseArgs(process.argv.slice(2))
const command = args.has('audit') ? 'audit' : args.has('samples') ? 'samples' : args.has('patterns') ? 'patterns' : 'build'
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const vaultPath = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault')
const provider = (process.env.COMMUNICATION_PROVIDER || process.env.IDENTITY_PROVIDER || process.env.BRAIN_CHAT_PROVIDER || process.env.LLM_PROVIDER || 'claude-code').toLowerCase()
const modelName = process.env.COMMUNICATION_MODEL || process.env.IDENTITY_MODEL || process.env.BRAIN_CHAT_MODEL || process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || process.env.OLLAMA_MODEL || ''
const useLlm = readBoolEnv('COMMUNICATION_USE_LLM', true) && provider !== 'disabled'
const outputObsidian = readBoolEnv('COMMUNICATION_OUTPUT_OBSIDIAN', true)
const minConfidence = readNumberEnv('COMMUNICATION_MIN_CONFIDENCE', 0.45, 0, 1)
const coreConfidence = readNumberEnv('COMMUNICATION_CORE_CONFIDENCE', 0.85, 0, 1)
const limits = {
  rawEntries: readIntArg('limit', readIntEnv('COMMUNICATION_MAX_RAW_ENTRIES', 150, 1, 500), 1, 500),
  samples: readIntEnv('COMMUNICATION_MAX_SAMPLES', 300, 1, 800),
  patterns: readIntEnv('COMMUNICATION_MAX_PATTERNS', 100, 1, 300),
}
const supabase = await createSupabaseClient()
let userId = ''

try {
  userId = await resolveUserId()
  if (command === 'audit') {
    console.log(JSON.stringify(await auditCommunication()))
  } else {
    const brain = await readBrain()
    const extracted = command === 'patterns'
      ? { communication_samples: [], communication_patterns: await buildPatternsFromExistingSamples(brain), warnings: [] }
      : await extractCommunication(brain)
    const samples = command === 'patterns' ? [] : await upsertSamples(extracted.communication_samples ?? [])
    const patterns = command === 'samples' ? [] : await upsertPatterns(extracted.communication_patterns?.length ? extracted.communication_patterns : buildPatterns([...(brain.existingSamples ?? []), ...samples], brain))
    const latestSamples = await readSamples()
    const latestPatterns = await readPatterns()
    if (outputObsidian) writeCommunicationMarkdown(latestSamples, latestPatterns, extracted.warnings ?? [])
    writeRunLog({ action: command, samples_upserted: samples.length, patterns_upserted: patterns.length, warnings: extracted.warnings ?? [] })
    console.log(JSON.stringify({ ok: true, action: command, samples_upserted: samples.length, patterns_upserted: patterns.length, warnings: extracted.warnings ?? [], counts: { samples: latestSamples.length, patterns: latestPatterns.length } }))
  }
} catch (err) {
  const message = formatError(err)
  writeRunLog({ action: `${command}_failed`, error: message })
  console.error(`[communication-style] failed ${message}`)
  process.exit(1)
}

async function readBrain() {
  const [rawRes, memoriesRes, identityFactsRes, snapshotsRes, samplesRes, patternsRes, reportsRes] = await Promise.all([
    supabase.from('raw_entries').select('id,title,content,source_origin,source_type,happened_at,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(limits.rawEntries),
    supabase.from('agent_memories').select('id,memory_type,content,importance_level,stability,source_entry_id,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    supabase.from('identity_facts').select('id,fact_type,label,statement,evidence_refs,confidence_score,stability,status').eq('user_id', userId).eq('fact_type', 'communication_pattern').in('status', ['active', 'needs_review']).limit(80),
    supabase.from('identity_snapshots').select('id,title,summary,identity_model,confidence_summary,warnings,created_at,status').eq('user_id', userId).in('status', ['done', 'needs_review']).order('created_at', { ascending: false }).limit(5),
    supabase.from('communication_samples').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limits.samples),
    supabase.from('communication_patterns').select('*').eq('user_id', userId).order('updated_at', { ascending: false }).limit(limits.patterns),
    supabase.from('brain_reports').select('id,title,summary,repeated_patterns,decisions,risks,suggested_next_actions,source_refs,status,period_end').eq('user_id', userId).eq('status', 'done').order('period_end', { ascending: false }).limit(20),
  ])
  const optionalErrors = [identityFactsRes, snapshotsRes, samplesRes, patternsRes, reportsRes].map((res) => res.error?.code === '42P01' ? null : res.error)
  const firstError = rawRes.error || memoriesRes.error || optionalErrors.find(Boolean)
  if (firstError) throw firstError
  return {
    rawEntries: rawRes.data ?? [],
    memories: memoriesRes.data ?? [],
    identityFacts: identityFactsRes.error?.code === '42P01' ? [] : identityFactsRes.data ?? [],
    snapshots: snapshotsRes.error?.code === '42P01' ? [] : snapshotsRes.data ?? [],
    existingSamples: samplesRes.error?.code === '42P01' ? [] : samplesRes.data ?? [],
    existingPatterns: patternsRes.error?.code === '42P01' ? [] : patternsRes.data ?? [],
    reports: reportsRes.error?.code === '42P01' ? [] : reportsRes.data ?? [],
    personaProfile: loadPersonaProfile(),
  }
}

async function extractCommunication(brain) {
  const fallbackSamples = deterministicSamples(brain)
  const fallbackPatterns = buildPatterns([...brain.existingSamples, ...fallbackSamples], brain)
  if (!useLlm) return { communication_samples: fallbackSamples, communication_patterns: fallbackPatterns, warnings: ['COMMUNICATION_USE_LLM=false; memakai deterministic fallback.'] }
  try {
    const raw = await callLLM(JSON.stringify(buildExtractorPack(brain), null, 2))
    const normalized = normalizeExtraction(raw, brain)
    if (normalized.communication_samples.length || normalized.communication_patterns.length) return normalized
    return { communication_samples: fallbackSamples, communication_patterns: fallbackPatterns, warnings: ['LLM tidak menghasilkan style JSON valid; memakai deterministic fallback.'] }
  } catch (err) {
    return { communication_samples: fallbackSamples, communication_patterns: fallbackPatterns, warnings: [`LLM communication extraction gagal; memakai deterministic fallback: ${formatError(err)}`] }
  }
}

function buildExtractorPack(brain) {
  return {
    task: 'Extract evidence-bound communication samples and patterns for Personal Entity OS.',
    allowed_sample_types: [...SAMPLE_TYPES],
    allowed_tone: [...TONES],
    allowed_formality: [...FORMALITY],
    allowed_length_class: [...LENGTHS],
    allowed_intent_type: [...INTENTS],
    allowed_pattern_type: [...PATTERN_TYPES],
    sources: {
      raw_entries: brain.rawEntries.map((entry) => ({ type: 'raw_entry', id: entry.id, label: entry.title || entry.happened_at || entry.created_at, content: excerpt(entry.content, 2200) })),
      agent_memories: brain.memories.map((memory) => ({ type: 'agent_memory', id: memory.id, label: `${memory.memory_type} memory`, content: excerpt(memory.content, 1000) })),
      identity_communication_facts: brain.identityFacts,
      existing_samples: brain.existingSamples.slice(0, 80),
      existing_patterns: brain.existingPatterns.slice(0, 50),
      brain_reports: brain.reports.map((report) => ({ type: 'brain_report', id: report.id, title: report.title, summary: report.summary, repeated_patterns: report.repeated_patterns, decisions: report.decisions, risks: report.risks })),
      persona_profile_context_only: brain.personaProfile ? excerpt(brain.personaProfile.raw, 2500) : null,
    },
    output_shape: {
      communication_samples: [{ text: 'oke buatkan saya prompt untuk step 18', sample_type: 'instruction', tone: 'direct', formality: 'casual', length_class: 'short', intent_type: 'request_prompt', context_label: 'requesting implementation prompt', confidence_score: 0.9, evidence_refs: [{ type: 'raw_entry', id: 'uuid', label: 'Diary' }] }],
      communication_patterns: [{ pattern_type: 'prompt_request_style', label: 'Meminta prompt siap implementasi secara langsung', description: 'Pemilik diary sering meminta prompt implementasi fase berikutnya dengan bahasa singkat, langsung, dan praktis.', preferred_response_shape: { format: 'writing_block', length: 'long_detailed_when_prompt_requested', style: 'direct_structured', avoid: ['teori terlalu panjang sebelum prompt', 'pertanyaan klarifikasi berlebihan'] }, trigger_intents: ['request_prompt', 'technical_instruction'], confidence_score: 0.92, stability: 'stable', evidence_refs: [] }],
      warnings: [],
    },
  }
}

function deterministicSamples(brain) {
  const samples = []
  for (const entry of brain.rawEntries) {
    for (const sentence of splitSamples(entry.content).slice(0, 12)) {
      const classified = classifySample(sentence)
      if (classified.intent_type === 'unknown' && sentence.length < 18) continue
      samples.push(normalizeSample({ ...classified, text: sentence, source_type: 'raw_entry', source_id: entry.id, context_label: entry.title || entry.happened_at || 'raw entry', metadata: { generated_by: 'deterministic_fallback' } }))
    }
  }
  for (const memory of brain.memories.slice(0, 60)) {
    const classified = classifySample(memory.content)
    if (classified.intent_type === 'unknown') continue
    samples.push(normalizeSample({ ...classified, text: excerpt(memory.content, 600), source_type: 'agent_memory', source_id: memory.id, context_label: `${memory.memory_type} memory`, metadata: { generated_by: 'deterministic_fallback' } }))
  }
  for (const fact of brain.identityFacts) {
    samples.push(normalizeSample({ text: fact.statement, sample_type: 'reflection', source_type: 'manual', source_id: null, language: 'id', tone: 'direct', formality: 'neutral', length_class: lengthClass(fact.statement), intent_type: 'reflection', context_label: `identity fact: ${fact.label}`, confidence_score: Number(fact.confidence_score ?? 0.5), metadata: { generated_by: 'identity_fact_context', identity_fact_id: fact.id } }))
  }
  return dedupeBy(samples.filter(Boolean), (sample) => `${sample.source_type}:${sample.source_id}:${sample.normalized_text}`).slice(0, limits.samples)
}

function classifySample(text) {
  const normalized = normalizeWords(text)
  const technical = /\b(file|command|npm|script|migration|endpoint|logic|frontend|backend|supabase|table|route|json|build|implementasi|coding agent)\b/i.test(normalized)
  const promptRequest = /\b(buatkan|bikin|tuliskan).{0,40}\bprompt\b|\bprompt siap paste\b/i.test(normalized)
  const correction = /\b(revisi|kurang|belum sesuai|ubah|jangan|fix|perbaiki|hotfix)\b/i.test(normalized)
  const followUp = /\b(lanjut|oke|sip|gas|next)\b/i.test(normalized)
  const greeting = /^(hi+|hai+|halo+|hello|p+|ping|bro+|assalamu\s?alaikum|salam)\b/i.test(normalized)
  const strategy = /\b(fokus|strategi|prioritas|harus|apakah sudah|arah|keputusan)\b/i.test(normalized)
  const reflection = /\b(saya|aku|menurut diary|pola pikir|takut|ambisi|kenapa)\b/i.test(normalized) && !technical
  const intent_type = greeting ? 'greeting' : promptRequest ? 'request_prompt' : correction ? 'correction' : technical ? 'technical_instruction' : strategy ? 'strategy_question' : followUp ? 'follow_up' : reflection ? 'reflection' : normalized.endsWith('?') || normalized.includes('apakah') ? 'strategy_question' : 'unknown'
  const sample_type = promptRequest || technical ? 'instruction' : correction ? 'instruction' : greeting || followUp ? 'reply' : strategy ? 'question' : reflection ? 'reflection' : 'diary_sentence'
  const tone = technical ? 'technical' : correction ? 'firm' : greeting || followUp ? 'casual' : strategy || promptRequest ? 'direct' : reflection ? 'reflective' : 'neutral'
  const formality = /\b(bro|p|oke|gas|gak|nggak|buatkan|bikin)\b/i.test(normalized) ? 'casual' : 'neutral'
  return { sample_type, source_type: 'raw_entry', language: detectLanguage(text), tone, formality, length_class: lengthClass(text), intent_type, context_label: intent_type.replace('_', ' '), confidence_score: intent_type === 'unknown' ? 0.35 : 0.68 }
}

function buildPatterns(samples, brain) {
  const byIntent = (intent) => samples.filter((sample) => sample.intent_type === intent)
  const patterns = []
  const add = (pattern) => {
    const normalized = normalizePattern(pattern)
    if (normalized) patterns.push(normalized)
  }
  add(patternFromSamples('greeting_style', 'Sapaan pendek dan langsung', 'Prompt ringan dijawab pendek, natural, dan langsung ke maksud pembicaraan.', byIntent('greeting'), { max_sentences: 1, style: 'short_direct', examples: ['Halo, kenapa?', 'Iya, ada apa?', 'Iya bro, ada apa?'], show_sources: false, show_debug_by_default: false }, ['greeting', 'casual_reply']))
  add(patternFromSamples('prompt_request_style', 'Meminta prompt siap paste', 'Saat meminta prompt, pemilik diary biasanya menginginkan blok prompt siap pakai, terstruktur, minim teori, dan bisa langsung dijalankan di coding agent.', byIntent('request_prompt'), { format: 'structured_prompt', length: 'detailed', style: 'direct_structured', must_include: ['context', 'target', 'constraints', 'acceptance criteria'], avoid: ['jawaban terlalu umum', 'teori panjang sebelum prompt'] }, ['request_prompt', 'technical_instruction']))
  add(patternFromSamples('technical_style', 'Instruksi teknis langsung dan bertahap', 'Untuk topik teknis, gaya yang cocok adalah langkah jelas, file/command eksplisit, dan hasil yang bisa diverifikasi.', byIntent('technical_instruction'), { style: 'direct_step_by_step', include_commands: true, include_files: true, avoid: ['abstraksi tanpa implementasi'] }, ['technical_instruction']))
  add(patternFromSamples('correction_style', 'Koreksi langsung tanpa defensif', 'Saat user memberi koreksi, respons harus langsung memperbaiki, tidak defensif, dan tidak banyak alasan.', byIntent('correction'), { style: 'direct_revision', max_preface_sentences: 1, avoid: ['defensif', 'mengulang penjelasan lama'] }, ['correction']))
  add(patternFromSamples('decision_style', 'Strategi tajam dan berbasis prioritas', 'Pertanyaan strategi dijawab dengan prioritas, risiko, bukti, dan next step praktis tanpa motivasi kosong.', byIntent('strategy_question'), { style: 'sharp_grounded', sections: ['prioritas', 'risiko', 'langkah'], avoid: ['motivational filler'] }, ['strategy_question', 'decision']))
  add(patternFromSamples('reflection_style', 'Refleksi tetap grounded', 'Refleksi diri harus membedakan fakta, inferensi, dan data yang belum cukup.', byIntent('reflection'), { style: 'grounded_reflection', include_uncertainty: true, avoid: ['mengarang psikologi'] }, ['reflection']))
  add(patternFromSamples('general_voice', 'Bahasa Indonesia informal tapi instruktif', 'Voice umum cenderung Bahasa Indonesia, langsung, praktis, dan teknis campur Inggris jika membahas sistem.', samples.filter((sample) => sample.intent_type !== 'unknown').slice(0, 60), { language: 'id', style: 'direct_practical', formality: dominant(samples, 'formality') || 'casual', avoid: ['assistant generic', 'puitis berlebihan', 'terlalu formal'] }, ['unknown', 'follow_up', 'casual_reply']))
  for (const fact of brain.identityFacts ?? []) {
    add({
      pattern_type: 'general_voice',
      label: `Identity communication fact: ${fact.label}`,
      description: fact.statement,
      examples: [],
      anti_examples: ['jawaban seperti chatbot umum'],
      preferred_response_shape: { style: 'identity_informed', avoid: ['overclaim tanpa evidence'] },
      trigger_intents: ['unknown'],
      confidence_score: Math.max(minConfidence, Number(fact.confidence_score ?? 0.5)),
      stability: fact.stability || 'temporary',
      evidence_refs: asArray(fact.evidence_refs).length ? fact.evidence_refs : [{ type: 'identity_fact', id: fact.id, label: fact.label }],
      usage_rules: ['Gunakan sebagai konteks gaya, bukan klaim identitas baru.'],
      status: 'active',
      metadata: { generated_by: 'identity_fact_context' },
    })
  }
  return dedupeBy(patterns, (pattern) => `${pattern.pattern_type}:${normalizeWords(pattern.label)}`).slice(0, limits.patterns)
}

function patternFromSamples(pattern_type, label, description, samples, responseShape, triggerIntents) {
  const examples = samples.slice(0, 8).map((sample) => sample.text)
  const evidence_refs = samples.slice(0, 12).map((sample) => ({ type: 'communication_sample', id: sample.id || sample.source_id || normalizeWords(sample.text).slice(0, 32), label: sample.context_label || sample.intent_type }))
  const count = samples.length
  return {
    pattern_type,
    label,
    description,
    examples,
    anti_examples: ['jawaban chatbot umum', 'warning panjang untuk prompt ringan'],
    preferred_response_shape: responseShape,
    trigger_intents: triggerIntents,
    confidence_score: count >= 8 ? 0.82 : count >= 3 ? 0.68 : count ? 0.52 : 0.45,
    stability: count >= 10 ? 'stable' : count >= 3 ? 'recurring' : 'temporary',
    evidence_refs,
    usage_rules: ['Gunakan hanya untuk response style, bukan untuk membuat fakta baru.', 'Jika confidence rendah, pakai gaya netral pendek.'],
    status: count ? 'active' : 'needs_review',
    metadata: { generated_by: 'deterministic_fallback', sample_count: count },
  }
}

async function buildPatternsFromExistingSamples(brain) {
  const samples = brain.existingSamples.length ? brain.existingSamples : deterministicSamples(brain)
  return buildPatterns(samples, brain)
}

async function upsertSamples(samples) {
  const changed = []
  for (const sample of samples.map(normalizeSample).filter(Boolean)) {
    const payload = { ...sample, user_id: userId }
    const existing = await supabase.from('communication_samples').select('id').eq('user_id', userId).eq('source_type', payload.source_type).eq('normalized_text', payload.normalized_text).limit(1).maybeSingle()
    if (existing.error && existing.error.code !== 'PGRST116') throw existing.error
    const query = existing.data?.id
      ? supabase.from('communication_samples').update(payload).eq('id', existing.data.id).select().single()
      : supabase.from('communication_samples').insert(payload).select().single()
    const { data, error } = await query
    if (error) throw error
    changed.push(data)
  }
  return changed
}

async function upsertPatterns(patterns) {
  const changed = []
  for (const pattern of patterns.map(normalizePattern).filter(Boolean)) {
    const payload = { ...pattern, user_id: userId }
    const existing = await supabase.from('communication_patterns').select('id,evidence_refs,confidence_score,metadata').eq('user_id', userId).eq('pattern_type', payload.pattern_type).ilike('label', payload.label).limit(1).maybeSingle()
    if (existing.error && existing.error.code !== 'PGRST116') throw existing.error
    const nextPayload = existing.data?.id ? { ...payload, evidence_refs: mergeEvidence(existing.data.evidence_refs, payload.evidence_refs), metadata: { ...(existing.data.metadata ?? {}), ...(payload.metadata ?? {}), last_communication_refresh: new Date().toISOString() } } : payload
    const query = existing.data?.id
      ? supabase.from('communication_patterns').update(nextPayload).eq('id', existing.data.id).select().single()
      : supabase.from('communication_patterns').insert(nextPayload).select().single()
    const { data, error } = await query
    if (error) throw error
    changed.push(data)
  }
  return changed
}

function normalizeExtraction(raw, brain) {
  const samples = asArray(raw?.communication_samples).map((sample) => normalizeSample({ ...sample, source_type: sample.source_type ?? 'manual', metadata: { ...(sample.metadata ?? {}), generated_by: 'llm' } })).filter(Boolean)
  const patterns = asArray(raw?.communication_patterns).map((pattern) => normalizePattern({ ...pattern, metadata: { ...(pattern.metadata ?? {}), generated_by: 'llm' } })).filter(Boolean)
  return { communication_samples: samples.length ? samples : deterministicSamples(brain), communication_patterns: patterns, warnings: arrayOfStrings(raw?.warnings) }
}

function normalizeSample(sample) {
  const text = String(sample?.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text || text.length < 2) return null
  const classified = classifySample(text)
  const sourceType = SOURCE_TYPES.has(sample.source_type) ? sample.source_type : 'manual'
  return {
    sample_type: SAMPLE_TYPES.has(sample.sample_type) ? sample.sample_type : classified.sample_type,
    source_type: sourceType,
    source_id: sourceType === 'manual' ? null : sample.source_id ?? null,
    text: excerpt(text, 1600),
    normalized_text: normalizeWords(text),
    language: sample.language || detectLanguage(text),
    tone: TONES.has(sample.tone) ? sample.tone : classified.tone,
    formality: FORMALITY.has(sample.formality) ? sample.formality : classified.formality,
    length_class: LENGTHS.has(sample.length_class) ? sample.length_class : lengthClass(text),
    intent_type: INTENTS.has(sample.intent_type) ? sample.intent_type : classified.intent_type,
    context_label: sample.context_label || classified.context_label,
    confidence_score: clampNumber(sample.confidence_score, 0, 1, classified.confidence_score),
    metadata: typeof sample.metadata === 'object' && sample.metadata ? sample.metadata : {},
  }
}

function normalizePattern(pattern) {
  const patternType = String(pattern?.pattern_type ?? '').trim()
  const label = String(pattern?.label ?? '').trim()
  const description = String(pattern?.description ?? '').trim()
  if (!PATTERN_TYPES.has(patternType) || !label || !description) return null
  const evidenceRefs = asArray(pattern.evidence_refs)
  const confidence = clampNumber(pattern.confidence_score, 0, 1, evidenceRefs.length ? 0.55 : 0.45)
  return {
    pattern_type: patternType,
    label: excerpt(label, 180),
    description: excerpt(description, 1600),
    examples: asArray(pattern.examples).map(String).slice(0, 20),
    anti_examples: asArray(pattern.anti_examples).map(String).slice(0, 20),
    preferred_response_shape: typeof pattern.preferred_response_shape === 'object' && pattern.preferred_response_shape ? pattern.preferred_response_shape : {},
    trigger_intents: asArray(pattern.trigger_intents).map(String).filter((item) => INTENTS.has(item) || item === 'technical_question').slice(0, 20),
    confidence_score: Number(confidence.toFixed(4)),
    stability: STABILITY.includes(pattern.stability) ? pattern.stability : confidence >= coreConfidence ? 'stable' : confidence >= 0.65 ? 'recurring' : 'temporary',
    evidence_refs: evidenceRefs,
    usage_rules: asArray(pattern.usage_rules).map(String).slice(0, 20),
    status: ['active', 'needs_review', 'deprecated', 'rejected'].includes(pattern.status) ? pattern.status : confidence < minConfidence ? 'needs_review' : 'active',
    metadata: typeof pattern.metadata === 'object' && pattern.metadata ? pattern.metadata : {},
  }
}

async function auditCommunication() {
  const [samples, patterns] = await Promise.all([readSamples(), readPatterns()])
  const active = patterns.filter((pattern) => pattern.status === 'active')
  const noEvidence = active.filter((pattern) => asArray(pattern.evidence_refs).length === 0)
  const highFew = active.filter((pattern) => Number(pattern.confidence_score) >= coreConfidence && asArray(pattern.evidence_refs).length < 3)
  const stale = active.filter((pattern) => Date.now() - new Date(pattern.updated_at ?? pattern.created_at).getTime() > 7 * 86400000)
  const has = (type) => active.some((pattern) => pattern.pattern_type === type)
  const warnings = []
  if (!samples.length) warnings.push('Belum ada communication_samples.')
  if (!patterns.length) warnings.push('Belum ada communication_patterns.')
  if (!has('greeting_style')) warnings.push('Greeting style belum tersedia.')
  if (!has('prompt_request_style')) warnings.push('Prompt request style belum tersedia.')
  if (!has('technical_style')) warnings.push('Technical style belum tersedia.')
  if (noEvidence.length) warnings.push(`${noEvidence.length} patterns tidak punya evidence_refs.`)
  if (highFew.length) warnings.push(`${highFew.length} high-confidence patterns punya sample/evidence sedikit.`)
  if (stale.length) warnings.push(`${stale.length} patterns lebih lama dari 7 hari.`)
  const score = Math.max(0, 100 - (samples.length ? 0 : 25) - (patterns.length ? 0 : 25) - (has('greeting_style') ? 0 : 10) - (has('prompt_request_style') ? 0 : 10) - (has('technical_style') ? 0 : 10) - noEvidence.length * 8 - highFew.length * 8 - Math.min(stale.length * 2, 10))
  return {
    ok: true,
    status: score < 50 ? 'critical' : warnings.length ? 'warning' : 'healthy',
    score,
    counts: {
      communication_samples: samples.length,
      communication_patterns: patterns.length,
      greeting_patterns: active.filter((pattern) => pattern.pattern_type === 'greeting_style').length,
      prompt_request_patterns: active.filter((pattern) => pattern.pattern_type === 'prompt_request_style').length,
      technical_patterns: active.filter((pattern) => pattern.pattern_type === 'technical_style').length,
      correction_patterns: active.filter((pattern) => pattern.pattern_type === 'correction_style').length,
      patterns_without_evidence: noEvidence.length,
      high_confidence_low_evidence: highFew.length,
      stale_patterns: stale.length,
    },
    warnings,
    recommended_fixes: recommendedFixes(warnings),
  }
}

async function readSamples() {
  const { data, error } = await supabase.from('communication_samples').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limits.samples)
  if (error) throw error
  return data ?? []
}

async function readPatterns() {
  const { data, error } = await supabase.from('communication_patterns').select('*').eq('user_id', userId).order('confidence_score', { ascending: false }).order('updated_at', { ascending: false }).limit(limits.patterns)
  if (error) throw error
  return data ?? []
}

function writeCommunicationMarkdown(samples, patterns, warnings = []) {
  const dir = resolve(vaultPath, '_system', 'communication')
  mkdirSync(dir, { recursive: true })
  writeMarkedFile(resolve(dir, 'Communication Style Model.md'), renderStyleModel(samples, patterns, warnings))
  writeMarkedFile(resolve(dir, 'Communication Samples.md'), renderSamples(samples))
}

function renderStyleModel(samples, patterns, warnings) {
  const byType = (type) => patterns.filter((pattern) => pattern.pattern_type === type)
  return [
    '---',
    'type: communication_style_model',
    `last_updated: "${new Date().toISOString()}"`,
    `communication_samples: ${samples.length}`,
    `communication_patterns: ${patterns.length}`,
    '---',
    '',
    '# Communication Style Model',
    '',
    AUTO_START,
    '',
    '## Summary Gaya Komunikasi',
    summaryVoice(patterns),
    '',
    patternSection('Greeting Style', byType('greeting_style')),
    patternSection('Prompt Request Style', byType('prompt_request_style')),
    patternSection('Technical Style', byType('technical_style')),
    patternSection('Correction Style', byType('correction_style')),
    patternSection('Decision Style', byType('decision_style')),
    patternSection('Casual Style', byType('casual_style').concat(byType('general_voice'))),
    '## Preferred Response Shape',
    '```json',
    JSON.stringify(Object.fromEntries(patterns.slice(0, 12).map((pattern) => [pattern.pattern_type, pattern.preferred_response_shape])), null, 2),
    '```',
    '',
    listSection('Anti-Style / Harus Dihindari', dedupeBy(patterns.flatMap((pattern) => asArray(pattern.anti_examples)), (item) => item).slice(0, 20)),
    listSection('Confidence Warnings', warnings),
    listSection('Evidence Highlights', patterns.flatMap((pattern) => asArray(pattern.evidence_refs).slice(0, 2).map((ref) => `${pattern.label}: ${ref.type}:${ref.id} ${ref.label ?? ''}`)).slice(0, 24)),
    '## Last Updated',
    new Date().toISOString(),
    '',
    AUTO_END,
    '',
  ].join('\n')
}

function renderSamples(samples) {
  return [
    '---',
    'type: communication_samples',
    `last_updated: "${new Date().toISOString()}"`,
    `communication_samples: ${samples.length}`,
    '---',
    '',
    '# Communication Samples',
    '',
    AUTO_START,
    '',
    ...samples.slice(0, 120).map((sample) => `- [${sample.intent_type}/${sample.sample_type}/${sample.tone}/${sample.length_class}] ${sample.text}`),
    '',
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
  throw new Error(`COMMUNICATION_PROVIDER/LLM_PROVIDER tidak dikenal: ${provider}`)
}

async function callClaudeCode(contextPackJson) {
  const commandName = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
  const settingsArg = process.env.CLAUDE_CODE_API_KEY_HELPER === 'false' ? [] : ['--settings', JSON.stringify({ apiKeyHelper: 'node -e "process.stdout.write(process.env.COMMUNICATION_API_KEY || process.env.IDENTITY_API_KEY || process.env.BRAIN_CHAT_API_KEY || process.env.ANTHROPIC_API_KEY || \'\')"'} )]
  return await runCommand(commandName, [...(process.env.CLAUDE_CODE_BARE === 'false' ? [] : ['--bare']), ...settingsArg, '--no-session-persistence', '--output-format', 'text', '-p', `${SYSTEM_PROMPT}\n\nCONTEXT PACK:\n${contextPackJson}`], { timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180000) })
}

async function callAnthropic(contextPackJson) {
  const baseUrl = requiredEnv('COMMUNICATION_BASE_URL', process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('COMMUNICATION_API_KEY', process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY)
  const model = requiredEnv('COMMUNICATION_MODEL', modelName)
  const res = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 5000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: `CONTEXT PACK:\n${contextPackJson}` }] }) })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return Array.isArray(data.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
}

async function callOpenAICompatible(contextPackJson) {
  const baseUrl = requiredEnv('COMMUNICATION_BASE_URL', process.env.IDENTITY_BASE_URL ?? process.env.BRAIN_CHAT_BASE_URL ?? process.env.LLM_BASE_URL).replace(/\/+$/, '')
  const apiKey = requiredEnv('COMMUNICATION_API_KEY', process.env.IDENTITY_API_KEY ?? process.env.BRAIN_CHAT_API_KEY ?? process.env.LLM_API_KEY)
  const model = requiredEnv('COMMUNICATION_MODEL', modelName)
  const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `CONTEXT PACK:\n${contextPackJson}` }], response_format: { type: 'json_object' } }) })
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

async function callOllama(contextPackJson) {
  const baseUrl = (process.env.COMMUNICATION_BASE_URL || process.env.IDENTITY_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = requiredEnv('COMMUNICATION_MODEL', modelName)
  const res = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt: `${SYSTEM_PROMPT}\n\nCONTEXT PACK:\n${contextPackJson}`, stream: false, format: 'json' }) })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data.response ?? ''
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
  throw new Error('Tidak bisa menentukan user_id untuk communication-style.')
}

function splitSamples(text) {
  return String(text ?? '').split(/\r?\n|(?<=[.!?])\s+/).map((item) => item.replace(/^[-*#>\s]+/, '').trim()).filter((item) => item.length >= 2 && item.length <= 1000)
}

function writeMarkedFile(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) return writeFileSync(path, `${content}\n`, 'utf8')
  const existing = readFileSync(path, 'utf8')
  const auto = content.slice(content.indexOf(AUTO_START), content.indexOf(AUTO_END) + AUTO_END.length)
  const next = existing.includes(AUTO_START) && existing.includes(AUTO_END) ? `${existing.slice(0, existing.indexOf(AUTO_START))}${auto}${existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length)}` : `${existing.replace(/\s*$/, '\n\n')}${auto}\n`
  writeFileSync(path, next, 'utf8')
}

function loadPersonaProfile() {
  const path = resolve(vaultPath, '_system', 'persona', 'Persona Profile.md')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const raw = text.includes('<!-- BRAIN_PERSONA_AUTO_START -->') && text.includes('<!-- BRAIN_PERSONA_AUTO_END -->') ? text.slice(text.indexOf('<!-- BRAIN_PERSONA_AUTO_START -->'), text.indexOf('<!-- BRAIN_PERSONA_AUTO_END -->')) : text
  return { raw }
}

function patternSection(title, patterns) {
  const lines = [`## ${title}`]
  if (!patterns.length) lines.push('- Belum cukup data.')
  else lines.push(...patterns.map((pattern) => `- ${pattern.description} _(confidence ${Number(pattern.confidence_score).toFixed(2)}, ${pattern.stability})_`))
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

function summaryVoice(patterns) {
  const general = patterns.find((pattern) => pattern.pattern_type === 'general_voice')
  return general?.description || 'Gaya komunikasi belum cukup stabil; gunakan jawaban netral, pendek untuk greeting, dan direct untuk prompt teknis.'
}

function recommendedFixes(warnings) {
  if (!warnings.length) return []
  return dedupeBy(warnings.map((warning) => {
    if (warning.includes('Greeting')) return 'Tambahkan chat sample sapaan atau diary percakapan, lalu jalankan npm run communication:build.'
    if (warning.includes('Prompt request')) return 'Tambahkan contoh permintaan prompt siap paste.'
    if (warning.includes('Technical')) return 'Tambahkan contoh instruksi teknis atau prompt coding.'
    if (warning.includes('evidence')) return 'Rebuild samples dan review pattern tanpa evidence.'
    return 'Tambahkan sample komunikasi asli dan jalankan audit ulang.'
  }), (item) => item)
}

function dominant(items, key) {
  const counts = new Map()
  for (const item of items) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function lengthClass(text) {
  const words = normalizeWords(text).split(/\s+/).filter(Boolean).length
  return words <= 8 ? 'short' : words <= 35 ? 'medium' : 'long'
}

function detectLanguage(text) {
  const normalized = normalizeWords(text)
  return /\b(the|and|with|for|response|style)\b/.test(normalized) && !/\b(saya|yang|untuk|dengan|buatkan)\b/.test(normalized) ? 'en' : 'id'
}

function normalizeWords(value) {
  return String(value ?? '').toLowerCase().trim().replace(/[’']/g, '').replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ')
}

function excerpt(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function mergeEvidence(a, b) {
  const seen = new Set()
  return [...asArray(a), ...asArray(b)].filter((ref) => {
    const key = `${ref?.type}:${ref?.id}`
    if (!ref?.type || !ref?.id || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeBy(items, keyFn) {
  const seen = new Set()
  return items.filter((item) => {
    const key = keyFn(item)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseJsonOrThrow(text, label) {
  const raw = String(text ?? '').trim()
  try { return JSON.parse(raw) } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`${label} tidak mengembalikan JSON.`)
    return JSON.parse(match[0])
  }
}

function runCommand(commandName, commandArgs, { timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, commandArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${commandName} timeout setelah ${timeoutMs}ms`)) }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolvePromise(output) : reject(new Error(`${commandName} exited ${code}: ${output.slice(0, 1000)}`)) })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function writeRunLog(payload) {
  try {
    const logDir = resolve(vaultPath, '_system', 'logs')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(resolve(logDir, `communication-style-${new Date().toISOString().slice(0, 10)}.md`), `\n## ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`, 'utf8')
  } catch {}
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

function readIntArg(name, fallback, min, max) {
  const value = Number(args.get(name) ?? fallback)
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback
}

function readIntEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback)
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback
}

function readNumberEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback)
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function readBoolEnv(key, fallback) {
  const value = process.env[key]
  if (value === undefined || value === '') return fallback
  return value === 'true'
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
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

function formatError(err) {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    try { return JSON.stringify(err) } catch { return Object.prototype.toString.call(err) }
  }
  return String(err)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}
