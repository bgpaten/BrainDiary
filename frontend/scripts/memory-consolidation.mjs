import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AUTO_START = '<!-- LONG_TERM_MEMORY_AUTO_START -->'
const AUTO_END = '<!-- LONG_TERM_MEMORY_AUTO_END -->'
const RUN_TYPES = new Set(['manual', 'daily', 'weekly', 'monthly', 'full', 'after_import', 'after_reflection'])
const SNAPSHOT_TYPES = new Set(['daily', 'weekly', 'monthly', 'manual', 'baseline'])
const REVIEW_STATUSES = new Set(['approved', 'rejected', 'ignored'])

const SYSTEM_PROMPT = `Kamu adalah Long-Term Memory Consolidation Engine untuk Personal Entity OS.

Tugasmu:
- Mengubah data memory yang banyak menjadi memory jangka panjang yang rapi.
- Jangan menghapus data mentah.
- Jangan mengarang memory tanpa evidence.
- Jangan menaikkan confidence tanpa evidence berulang.
- Jangan membuat owner terlihat lebih ideal dari data.
- Jangan menyederhanakan kontradiksi.
- Bedakan memory core, active, temporary, stale, dan historical.
- Jika memory bertentangan, hubungkan ke conflict, jangan hapus salah satu.
- Jika data kurang, buat review item.
- Output harus JSON valid.`

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    let result
    const snapshotOnly = args.has('snapshot') && !args.has('run-type') && !args.has('type') && !args.has('full') && !args.has('from') && !args.has('to')
    if (snapshotOnly) {
      result = await createMemorySnapshot({ snapshotType: sanitizeSnapshotType(args.get('snapshot-type') ?? args.get('type') ?? 'manual') })
    } else if (args.has('review')) {
      if (args.has('update')) result = await reviewMemoryItem({ reviewItemId: readArg(args, 'review-item-id') || readArg(args, 'update'), status: readArg(args, 'status'), ownerNote: args.get('owner-note') ?? '' })
      else result = await latestMemoryConsolidation()
    } else if (args.has('audit')) {
      result = await auditMemoryConsolidation({ save: readBoolArg(args, 'save', true) })
    } else if (args.has('latest')) {
      result = await latestMemoryConsolidation()
    } else {
      result = await runMemoryConsolidation({
        runType: args.has('full') ? 'full' : sanitizeRunType(args.get('run-type') ?? args.get('type') ?? 'manual'),
        from: args.get('from') ?? null,
        to: args.get('to') ?? null,
        full: args.has('full'),
        snapshot: args.has('snapshot-output') || readBoolArg(args, 'snapshot', false),
      })
    }
    console.log(JSON.stringify(result, null, args.has('pretty') ? 2 : 0))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

async function runMemoryConsolidation({ runType = 'manual', from = null, to = null, full = false, snapshot = false } = {}) {
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const period = resolvePeriod(runType, from, to, full)
  const run = await insertRun(supabase, userId, runType, period)
  try {
    const context = await readConsolidationContext(supabase, userId, period, full)
    const plan = await buildConsolidationPlan(context, period, runType)
    const applied = await applyConsolidationPlan(supabase, userId, run.id, plan, context)
    let snapshotRow = null
    if (snapshot) snapshotRow = await createMemorySnapshot({ snapshotType: runType === 'weekly' ? 'weekly' : 'manual', supabase, userId })
    const status = plan.warnings.length || applied.reviewItems.length ? 'partial' : 'done'
    const finished = await updateRun(supabase, run.id, {
      status,
      source_counts: context.counts,
      created_memory_count: applied.created,
      updated_memory_count: applied.updated,
      duplicate_candidate_count: applied.duplicates,
      archive_candidate_count: applied.archiveCandidates,
      stale_candidate_count: applied.staleCandidates,
      contradiction_link_count: applied.contradictionLinks,
      review_suggestion_count: applied.reviewItems.length,
      summary: plan.summary,
      warnings: plan.warnings,
      finished_at: new Date().toISOString(),
      metadata: { generated_by: plan.generated_by, period, snapshot_id: snapshotRow?.id ?? null },
    })
    const latest = await latestMemoryConsolidation({ supabase, userId })
    if (readBoolEnv('MEMORY_CONSOLIDATION_OUTPUT_OBSIDIAN', true)) writeMemoryReports(latest)
    return { ok: true, run: finished, snapshot_id: snapshotRow?.id ?? null, ...applied, warnings: plan.warnings }
  } catch (err) {
    await updateRun(supabase, run.id, { status: 'failed', warnings: [err instanceof Error ? err.message : String(err)], finished_at: new Date().toISOString() })
    throw err
  }
}

async function buildConsolidationPlan(context, period, runType) {
  if (useLlm()) {
    try {
      const raw = await callLLM(buildPrompt(context, period, runType))
      const normalized = normalizePlan(raw, 'llm')
      if (normalized.long_term_memories.length) return normalized
      return { ...deterministicPlan(context, period), warnings: ['LLM menghasilkan plan kosong; memakai deterministic fallback.'], generated_by: 'deterministic_fallback' }
    } catch (err) {
      return { ...deterministicPlan(context, period), warnings: [`LLM gagal; memakai deterministic fallback: ${err instanceof Error ? err.message : String(err)}`], generated_by: 'deterministic_fallback' }
    }
  }
  return { ...deterministicPlan(context, period), warnings: ['MEMORY_CONSOLIDATION_USE_LLM=false atau disabled; memakai deterministic fallback.'], generated_by: 'deterministic_fallback' }
}

function deterministicPlan(context, period) {
  const memories = []
  const reviews = []
  const warnings = []
  for (const fact of context.identityFacts.slice(0, 80)) {
    const confidence = Number(fact.confidence_score ?? 0.55)
    const importance = Math.min(0.96, 0.58 + confidence * 0.28 + stabilityBoost(fact.stability))
    const type = mapFactType(fact.fact_type)
    const refs = evidenceRefsFromJson(fact.evidence_refs, { type: 'identity_fact', id: fact.id, label: fact.label ?? fact.fact_type })
    const memory = {
      memory_type: type,
      title: fact.label || titleFromText(fact.statement, type),
      canonical_statement: fact.statement || fact.label || 'Identity memory candidate',
      summary: fact.statement || fact.label || null,
      importance_score: round4(importance),
      confidence_score: round4(Math.min(0.92, confidence)),
      stability: stabilityForEvidence(confidence, refs.length, fact.stability),
      recurrence: recurrenceForEvidence(refs.length, confidence),
      freshness: freshnessForDate(fact.last_seen_at ?? fact.updated_at ?? fact.created_at, type === 'life_event_summary'),
      evidence_refs: refs,
      related_identity_fact_ids: [fact.id],
      related_raw_entry_ids: idsByType(refs, 'raw_entry'),
      related_agent_memory_ids: idsByType(refs, 'agent_memory'),
      metadata: { source: 'identity_fact', source_id: fact.id },
    }
    memories.push(memory)
    if (memory.stability === 'core' || confidence >= readFloatEnv('MEMORY_CONSOLIDATION_CORE_CONFIDENCE', 0.85, 0, 1)) {
      reviews.push(review('core_memory_candidate', `Core memory candidate: ${memory.title}`, 'Memory ini kuat dan berulang; review sebelum dianggap core.', 'keep_active', 'high', 0.2, memory.evidence_refs, [{ type: 'long_term_memory_candidate', label: memory.title }]))
    }
    if (confidence < readFloatEnv('MEMORY_CONSOLIDATION_MIN_CONFIDENCE', 0.55, 0, 1) && importance >= 0.72) {
      reviews.push(review('low_confidence_memory', `Low confidence high importance: ${memory.title}`, 'Memory penting tetapi confidence masih rendah.', 'add_evidence', 'medium', 0.48, memory.evidence_refs, []))
    }
  }

  for (const pattern of context.communicationPatterns.slice(0, 60)) {
    const confidence = Number(pattern.confidence_score ?? 0.55)
    const refs = evidenceRefsFromJson(pattern.evidence_refs, { type: 'communication_pattern', id: pattern.id, label: pattern.label ?? pattern.pattern_type })
    memories.push({
      memory_type: 'communication_style',
      title: pattern.label || titleFromText(pattern.description, 'communication_style'),
      canonical_statement: pattern.description || pattern.label || 'Communication style memory candidate',
      summary: pattern.description || pattern.label || null,
      importance_score: round4(Math.min(0.9, 0.56 + confidence * 0.28)),
      confidence_score: round4(Math.min(0.9, confidence)),
      stability: stabilityForEvidence(confidence, refs.length, pattern.stability),
      recurrence: recurrenceForEvidence(refs.length, confidence),
      freshness: freshnessForDate(pattern.updated_at ?? pattern.created_at, false),
      evidence_refs: refs,
      related_communication_pattern_ids: [pattern.id],
      metadata: { source: 'communication_pattern', source_id: pattern.id },
    })
  }

  for (const conflict of context.identityConflicts.slice(0, 40)) {
    const confidence = conflict.recurrence === 'core_tension' ? 0.82 : conflict.severity === 'high' ? 0.74 : 0.64
    const refs = [{ type: 'identity_conflict', id: conflict.id, label: conflict.title }]
    memories.push({
      memory_type: 'conflict_context',
      title: conflict.title,
      canonical_statement: conflict.summary || `${conflict.side_a_label ?? 'Side A'} vs ${conflict.side_b_label ?? 'Side B'}`,
      summary: conflict.summary,
      importance_score: conflict.severity === 'critical' ? 0.92 : conflict.severity === 'high' ? 0.84 : 0.68,
      confidence_score: confidence,
      stability: conflict.recurrence === 'core_tension' ? 'core' : 'recurring',
      recurrence: conflict.recurrence === 'core_tension' ? 'persistent' : 'recurring',
      freshness: freshnessForDate(conflict.last_seen_at ?? conflict.created_at, false),
      evidence_refs: refs,
      related_conflict_ids: [conflict.id],
      metadata: { source: 'identity_conflict', source_id: conflict.id },
    })
    reviews.push(review('conflicting_memory', `Conflict-linked memory: ${conflict.title}`, 'Memory terkait konflik harus dipakai dengan nuansa, bukan klaim satu sisi.', 'link_conflict', conflict.severity === 'critical' ? 'critical' : 'high', 0.55, refs, []))
  }

  for (const report of context.brainReports.slice(0, 20)) {
    for (const item of arrayFrom(report.repeated_patterns).slice(0, 5)) {
      const label = item.label || item.title || item.pattern || 'Recurring pattern'
      memories.push({
        memory_type: 'recurring_pattern',
        title: String(label),
        canonical_statement: String(item.description || item.summary || label),
        summary: String(item.description || item.summary || label),
        importance_score: 0.66,
        confidence_score: 0.58,
        stability: 'emerging',
        recurrence: 'repeated',
        freshness: freshnessForDate(report.created_at, false),
        evidence_refs: [{ type: 'brain_report', id: report.id, label: report.title }],
        metadata: { source: 'brain_report', source_id: report.id },
      })
    }
  }

  for (const reflection of context.reflectionLogs.slice(0, 20)) {
    for (const item of arrayFrom(reflection.strengthened_patterns).slice(0, 5)) {
      const label = item.label || item.target_label || 'Strengthened pattern'
      memories.push({
        memory_type: 'recurring_pattern',
        title: String(label),
        canonical_statement: String(item.description || label),
        summary: String(item.description || label),
        importance_score: 0.62,
        confidence_score: Number(item.confidence_score ?? 0.56),
        stability: 'emerging',
        recurrence: 'repeated',
        freshness: freshnessForDate(reflection.created_at, false),
        evidence_refs: evidenceRefsFromJson(item.evidence_refs, { type: 'self_reflection_log', id: reflection.id, label: reflection.title ?? reflection.reflection_type }),
        related_reflection_log_ids: [reflection.id],
        metadata: { source: 'self_reflection_log', source_id: reflection.id },
      })
    }
  }

  const duplicates = duplicateCandidates(memories, context.longTermMemories)
  for (const dup of duplicates) {
    reviews.push(review('duplicate_memory', `Duplicate candidate: ${dup.title}`, 'Ada memory dengan judul/statement mirip. Jangan auto-merge tanpa review.', 'merge', 'medium', 0.42, dup.source_refs, dup.target_refs))
  }

  const stale = staleCandidates(context.longTermMemories)
  for (const item of stale) {
    reviews.push(review('stale_memory', `Stale memory: ${item.title}`, 'Memory ini tidak muncul lagi dalam periode freshness; review sebelum dianggap historical/archive.', 'keep_active', 'medium', 0.45, [{ type: 'long_term_memory', id: item.id, label: item.title }], []))
  }
  if (!memories.length) warnings.push('Tidak ada memory candidate kuat dari data saat ini.')
  return {
    summary: `Memory consolidation ${period.start.toISOString().slice(0, 10)} sampai ${period.end.toISOString().slice(0, 10)} menghasilkan ${memories.length} long-term memory candidate.`,
    long_term_memories: memories,
    review_items: reviews,
    duplicates,
    stale_candidates: stale,
    archive_candidates: stale.filter((item) => item.freshness === 'stale' && Number(item.importance_score ?? 0) < 0.55),
    warnings,
    generated_by: 'deterministic_fallback',
  }
}

async function applyConsolidationPlan(supabase, userId, runId, plan, context) {
  let created = 0
  let updated = 0
  let contradictionLinks = 0
  const reviewItems = []
  const targetIds = []
  for (const candidate of plan.long_term_memories) {
    const saved = await upsertLongTermMemory(supabase, userId, candidate)
    if (saved.created) created += 1
    else updated += 1
    targetIds.push(saved.row.id)
    if ((candidate.related_conflict_ids ?? []).length) contradictionLinks += 1
    await insertConsolidationItem(supabase, userId, runId, {
      source_type: sourceTypeForCandidate(candidate),
      source_id: sourceIdForCandidate(candidate),
      target_long_term_memory_id: saved.row.id,
      action_type: saved.created ? 'create_long_term_memory' : 'merge_into_existing',
      reason: saved.created ? 'Created consolidated memory candidate.' : 'Merged evidence into existing long-term memory.',
      confidence_score: candidate.confidence_score,
      risk_score: candidate.status === 'needs_review' ? 0.45 : 0.2,
      status: readBoolEnv('MEMORY_CONSOLIDATION_REVIEW_REQUIRED', true) && candidate.status === 'needs_review' ? 'needs_review' : 'applied',
      metadata: { generated_by: plan.generated_by },
    })
    for (const reviewItem of reviewItemsForMemory(candidate, saved.row)) {
      reviewItems.push(await insertReviewItem(supabase, userId, reviewItem))
    }
  }
  for (const reviewItem of plan.review_items) reviewItems.push(await insertReviewItem(supabase, userId, reviewItem))
  for (const duplicate of plan.duplicates) {
    await insertConsolidationItem(supabase, userId, runId, { source_type: 'long_term_memory', source_id: duplicate.source_id ?? null, target_long_term_memory_id: duplicate.target_id ?? null, action_type: 'mark_duplicate_candidate', reason: 'Duplicate candidate detected. No auto-merge by default.', confidence_score: 0.62, risk_score: 0.42, status: 'needs_review', metadata: duplicate })
  }
  for (const stale of plan.stale_candidates) {
    await insertConsolidationItem(supabase, userId, runId, { source_type: 'long_term_memory', source_id: stale.id, target_long_term_memory_id: stale.id, action_type: 'mark_stale_candidate', reason: 'Memory stale candidate. No auto-archive by default.', confidence_score: Number(stale.confidence_score ?? 0.5), risk_score: 0.42, status: 'needs_review', metadata: { freshness: stale.freshness } })
  }
  return {
    created,
    updated,
    duplicates: plan.duplicates.length,
    staleCandidates: plan.stale_candidates.length,
    archiveCandidates: plan.archive_candidates.length,
    contradictionLinks,
    reviewItems,
    targetIds,
  }
}

async function upsertLongTermMemory(supabase, userId, candidate) {
  const normalized = normalizeTitle(candidate.title)
  const { data: existingRows, error } = await supabase.from('long_term_memories').select('*').eq('user_id', userId).eq('memory_type', candidate.memory_type).limit(250)
  if (error && error.code !== '42P01') throw error
  const existing = (existingRows ?? []).find((row) => normalizeTitle(row.title) === normalized)
  const patch = normalizeMemoryRow(userId, candidate)
  if (!existing) {
    const { data, error: insertError } = await supabase.from('long_term_memories').insert(patch).select('*').single()
    if (insertError) throw insertError
    return { created: true, row: data }
  }
  const merged = {
    ...patch,
    evidence_refs: mergeJsonArrays(existing.evidence_refs, patch.evidence_refs),
    related_raw_entry_ids: mergeJsonArrays(existing.related_raw_entry_ids, patch.related_raw_entry_ids),
    related_agent_memory_ids: mergeJsonArrays(existing.related_agent_memory_ids, patch.related_agent_memory_ids),
    related_identity_fact_ids: mergeJsonArrays(existing.related_identity_fact_ids, patch.related_identity_fact_ids),
    related_communication_pattern_ids: mergeJsonArrays(existing.related_communication_pattern_ids, patch.related_communication_pattern_ids),
    related_conflict_ids: mergeJsonArrays(existing.related_conflict_ids, patch.related_conflict_ids),
    related_reflection_log_ids: mergeJsonArrays(existing.related_reflection_log_ids, patch.related_reflection_log_ids),
    confidence_score: round4(Math.max(Number(existing.confidence_score ?? 0), Math.min(Number(patch.confidence_score ?? 0), Number(existing.confidence_score ?? 0) + 0.05))),
    importance_score: round4(Math.max(Number(existing.importance_score ?? 0), Number(patch.importance_score ?? 0))),
    status: ['archived', 'deprecated'].includes(existing.status) ? existing.status : patch.status,
    first_seen_at: earlierDate(existing.first_seen_at, patch.first_seen_at),
    last_seen_at: laterDate(existing.last_seen_at, patch.last_seen_at),
    metadata: { ...(existing.metadata ?? {}), ...(patch.metadata ?? {}), last_consolidation_merge_at: new Date().toISOString() },
  }
  const { data, error: updateError } = await supabase.from('long_term_memories').update(merged).eq('id', existing.id).eq('user_id', userId).select('*').single()
  if (updateError) throw updateError
  return { created: false, row: data }
}

function normalizeMemoryRow(userId, item) {
  const evidence = arrayFrom(item.evidence_refs)
  const lastSeen = item.last_seen_at ?? latestEvidenceDate(evidence) ?? new Date().toISOString()
  const firstSeen = item.first_seen_at ?? earliestEvidenceDate(evidence) ?? lastSeen
  const status = item.status ?? (Number(item.confidence_score ?? 0) < readFloatEnv('MEMORY_CONSOLIDATION_MIN_CONFIDENCE', 0.55, 0, 1) ? 'needs_review' : 'active')
  return {
    user_id: userId,
    memory_type: sanitizeMemoryType(item.memory_type),
    title: String(item.title || titleFromText(item.canonical_statement, item.memory_type)),
    summary: item.summary ?? item.canonical_statement ?? null,
    canonical_statement: String(item.canonical_statement || item.summary || item.title),
    evidence_refs: evidence,
    related_raw_entry_ids: arrayFrom(item.related_raw_entry_ids),
    related_agent_memory_ids: arrayFrom(item.related_agent_memory_ids),
    related_identity_fact_ids: arrayFrom(item.related_identity_fact_ids),
    related_communication_pattern_ids: arrayFrom(item.related_communication_pattern_ids),
    related_conflict_ids: arrayFrom(item.related_conflict_ids),
    related_reflection_log_ids: arrayFrom(item.related_reflection_log_ids),
    importance_score: round4(clamp(Number(item.importance_score ?? 0.5))),
    confidence_score: round4(clamp(Number(item.confidence_score ?? 0.5))),
    stability: sanitizeStability(item.stability),
    recurrence: sanitizeRecurrence(item.recurrence),
    freshness: item.freshness ?? freshnessForDate(lastSeen, false),
    status,
    first_seen_at: firstSeen,
    last_seen_at: lastSeen,
    consolidated_at: new Date().toISOString(),
    metadata: item.metadata ?? {},
  }
}

async function createMemorySnapshot({ snapshotType = 'manual', supabase = null, userId = null } = {}) {
  const client = supabase ?? await createSupabaseClient()
  const activeUserId = userId ?? await resolveUserId(client)
  const [memories, reviews] = await Promise.all([
    safeMany(client.from('long_term_memories').select('*').eq('user_id', activeUserId).in('status', ['active', 'needs_review', 'contradicted']).order('importance_score', { ascending: false }).limit(300)),
    safeMany(client.from('memory_review_queue').select('*').eq('user_id', activeUserId).eq('status', 'pending').order('created_at', { ascending: false }).limit(100)),
  ])
  const health = memoryHealth(memories, reviews)
  const row = {
    user_id: activeUserId,
    snapshot_type: snapshotType,
    title: `Long-Term Memory Snapshot ${new Date().toISOString().slice(0, 10)}`,
    summary: `${memories.length} long-term memories, ${health.core_memory_count} core, ${reviews.length} pending review.`,
    core_memories: memories.filter((m) => m.stability === 'core').slice(0, 30),
    active_patterns: memories.filter((m) => ['recurring_pattern', 'decision_pattern'].includes(m.memory_type)).slice(0, 40),
    long_term_goals: memories.filter((m) => m.memory_type === 'long_term_goal').slice(0, 30),
    active_projects: memories.filter((m) => m.memory_type === 'project_context').slice(0, 30),
    communication_memory: memories.filter((m) => m.memory_type === 'communication_style').slice(0, 30),
    risk_memory: memories.filter((m) => m.memory_type === 'risk_pattern').slice(0, 30),
    conflict_memory: memories.filter((m) => m.memory_type === 'conflict_context' || arrayFrom(m.related_conflict_ids).length).slice(0, 30),
    archived_summary: { archived_count: memories.filter((m) => m.status === 'archived').length, stale_count: memories.filter((m) => m.freshness === 'stale').length },
    uncertainties: reviews.filter((r) => ['high', 'critical'].includes(r.priority)).slice(0, 30),
    memory_health: health,
    status: reviews.some((r) => r.priority === 'critical') ? 'needs_review' : 'active',
    metadata: { generated_by: 'memory-consolidation' },
  }
  const { data, error } = await client.from('memory_consolidation_snapshots').insert(row).select('*').single()
  if (error) throw error
  const latest = await latestMemoryConsolidation({ supabase: client, userId: activeUserId })
  if (readBoolEnv('MEMORY_CONSOLIDATION_OUTPUT_OBSIDIAN', true)) writeMemoryReports(latest)
  return { ok: true, snapshot: data, snapshot_id: data.id }
}

async function reviewMemoryItem({ reviewItemId, status, ownerNote = '' }) {
  if (!isUuid(reviewItemId)) throw new Error('reviewItemId tidak valid.')
  if (!REVIEW_STATUSES.has(status)) throw new Error('status review tidak valid.')
  if (ownerNote.length > 5000) throw new Error('ownerNote terlalu panjang.')
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const { data, error } = await supabase.from('memory_review_queue').update({
    status,
    owner_note: ownerNote || null,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: { reviewed_by: 'owner', destructive_action_executed: false },
  }).eq('user_id', userId).eq('id', reviewItemId).select('*').single()
  if (error) throw error
  return { ok: true, review_item: data, applied_to_core_brain: false }
}

async function auditMemoryConsolidation({ save = true } = {}) {
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const latest = await latestMemoryConsolidation({ supabase, userId })
  const memories = latest.long_term_memories
  const reviews = latest.review_queue
  const warnings = []
  if (!memories.length) warnings.push('long_term_memories belum tersedia.')
  if (!latest.latest_run) warnings.push('Belum ada memory_consolidation_runs.')
  if (!latest.latest_snapshot) warnings.push('Belum ada memory_consolidation_snapshots.')
  const withoutEvidence = memories.filter((m) => !arrayFrom(m.evidence_refs).length)
  const highImportanceLowConfidence = memories.filter((m) => Number(m.importance_score ?? 0) >= 0.75 && Number(m.confidence_score ?? 0) < 0.6)
  const stale = memories.filter((m) => m.freshness === 'stale')
  const duplicates = reviews.filter((r) => r.review_type === 'duplicate_memory' && r.status === 'pending')
  const pending = reviews.filter((r) => r.status === 'pending')
  const conflictLinked = memories.filter((m) => arrayFrom(m.related_conflict_ids).length || m.memory_type === 'conflict_context')
  if (withoutEvidence.length) warnings.push(`${withoutEvidence.length} long-term memories tanpa evidence_refs.`)
  if (highImportanceLowConfidence.length) warnings.push(`${highImportanceLowConfidence.length} high-importance memories masih low confidence.`)
  if (duplicates.length) warnings.push(`${duplicates.length} duplicate candidates pending review.`)
  if (stale.length) warnings.push(`${stale.length} stale memory candidates perlu review.`)
  if (pending.length) warnings.push(`${pending.length} review queue pending.`)
  if (readBoolEnv('MEMORY_CONSOLIDATION_AUTO_MERGE', false)) warnings.push('MEMORY_CONSOLIDATION_AUTO_MERGE=true; default aman seharusnya false.')
  if (readBoolEnv('MEMORY_CONSOLIDATION_AUTO_ARCHIVE', false)) warnings.push('MEMORY_CONSOLIDATION_AUTO_ARCHIVE=true; default aman seharusnya false.')
  let score = 100 - warnings.length * 8
  if (!memories.length) score -= 30
  if (!latest.latest_run) score -= 15
  if (!latest.latest_snapshot) score -= 10
  score = Math.max(0, Math.min(100, score))
  const result = {
    ok: true,
    status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
    score,
    warnings,
    recommended_fixes: recommendedFixes(warnings),
    checks: {
      long_term_memories_count: memories.length,
      core_memory_count: memories.filter((m) => m.stability === 'core').length,
      memories_without_evidence: withoutEvidence.length,
      duplicate_candidates: duplicates.length,
      stale_candidates: stale.length,
      review_queue_pending: pending.length,
      high_importance_low_confidence: highImportanceLowConfidence.length,
      conflict_linked_memories: conflictLinked.length,
      latest_consolidation_run_id: latest.latest_run?.id ?? null,
      latest_snapshot_id: latest.latest_snapshot?.id ?? null,
      brain_chat_can_read_long_term_memories: true,
      unsafe_auto_merge_enabled: readBoolEnv('MEMORY_CONSOLIDATION_AUTO_MERGE', false),
      unsafe_auto_archive_enabled: readBoolEnv('MEMORY_CONSOLIDATION_AUTO_ARCHIVE', false),
    },
  }
  if (save && readBoolEnv('MEMORY_CONSOLIDATION_OUTPUT_OBSIDIAN', true)) writeMemoryReports({ ...latest, audit: result })
  return result
}

async function latestMemoryConsolidation(existing = {}) {
  const supabase = existing.supabase ?? await createSupabaseClient()
  const userId = existing.userId ?? await resolveUserId(supabase)
  const [runRes, memoriesRes, reviewsRes, snapshotRes] = await Promise.all([
    supabase.from('memory_consolidation_runs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1),
    supabase.from('long_term_memories').select('*').eq('user_id', userId).order('importance_score', { ascending: false }).limit(300),
    supabase.from('memory_review_queue').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(200),
    supabase.from('memory_consolidation_snapshots').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1),
  ])
  for (const res of [runRes, memoriesRes, reviewsRes, snapshotRes]) if (res.error && res.error.code !== '42P01') throw res.error
  const memories = memoriesRes.data ?? []
  const reviews = reviewsRes.data ?? []
  return {
    ok: true,
    latest_run: runRes.data?.[0] ?? null,
    long_term_memories: memories,
    review_queue: reviews,
    latest_snapshot: snapshotRes.data?.[0] ?? null,
    memory_health: memoryHealth(memories, reviews),
  }
}

async function readConsolidationContext(supabase, userId, period, full) {
  const rawLimit = readIntEnv('MEMORY_CONSOLIDATION_MAX_RAW_ENTRIES', 300, 1, 1000)
  const memoryLimit = readIntEnv('MEMORY_CONSOLIDATION_MAX_AGENT_MEMORIES', 300, 1, 1000)
  const identityLimit = readIntEnv('MEMORY_CONSOLIDATION_MAX_IDENTITY_FACTS', 200, 1, 1000)
  const chatLimit = readIntEnv('MEMORY_CONSOLIDATION_MAX_CHAT_MESSAGES', 500, 0, 2000)
  const periodFilter = (query, dateColumn = 'created_at') => full ? query : query.gte(dateColumn, period.start.toISOString()).lte(dateColumn, period.end.toISOString())
  const [
    rawEntries, agentMemories, nodes, edges, reports, identityFacts, snapshots,
    communicationPatterns, communicationSamples, ownerExamples, chatMessages, replyPairs,
    reflectionLogs, evolutionSuggestions, identityConflicts, similarityRuns, driftLogs,
    readinessReports, longTermMemories,
  ] = await Promise.all([
    safeMany(periodFilter(supabase.from('raw_entries').select('id,title,content,happened_at,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(rawLimit))),
    safeMany(periodFilter(supabase.from('agent_memories').select('id,memory_type,content,importance_level,stability,sensitivity,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(memoryLimit))),
    safeMany(supabase.from('brain_nodes').select('id,type,name,canonical_name,summary,description,importance_score,confidence_score,last_seen_at,metadata').eq('user_id', userId).limit(500)),
    safeMany(supabase.from('brain_edges').select('id,from_node_id,to_node_id,relation_type,summary,weight,confidence_score,metadata').eq('user_id', userId).limit(500)),
    safeMany(supabase.from('brain_reports').select('id,report_type,title,summary,repeated_patterns,active_projects,risks,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(50)),
    safeMany(supabase.from('identity_facts').select('id,fact_type,label,statement,evidence_refs,confidence_score,stability,status,last_seen_at,created_at,updated_at').eq('user_id', userId).in('status', ['active', 'contradicted', 'needs_review']).order('confidence_score', { ascending: false }).limit(identityLimit)),
    safeMany(supabase.from('identity_snapshots').select('id,title,summary,identity_model,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)),
    safeMany(supabase.from('communication_patterns').select('id,pattern_type,label,description,evidence_refs,confidence_score,stability,status,created_at,updated_at').eq('user_id', userId).in('status', ['active', 'needs_review']).order('confidence_score', { ascending: false }).limit(150)),
    safeMany(supabase.from('communication_samples').select('id,text,intent_type,tone,formality,length_class,confidence_score,created_at').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(200)),
    safeMany(supabase.from('owner_answer_examples').select('id,prompt,owner_answer,intent_type,answer_style,quality_score,status,created_at').eq('user_id', userId).order('quality_score', { ascending: false }).limit(120)),
    safeMany(periodFilter(supabase.from('chat_messages').select('id,speaker_role,text,intent_type,tone,formality,length_class,is_owner_message,created_at').eq('user_id', userId).eq('is_owner_message', true).order('created_at', { ascending: false }).limit(chatLimit))),
    safeMany(supabase.from('chat_reply_pairs').select('id,prompt_text,owner_reply_text,intent_type,answer_style,confidence_score,created_at').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(120)),
    safeMany(supabase.from('self_reflection_logs').select('id,reflection_type,title,summary,strengthened_patterns,new_contradictions,uncertainties,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(80)),
    safeMany(supabase.from('identity_evolution_suggestions').select('id,suggestion_type,label,description,target_type,confidence_score,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(80)),
    safeMany(supabase.from('identity_conflicts').select('*').eq('user_id', userId).order('last_seen_at', { ascending: false }).limit(100)),
    safeMany(supabase.from('similarity_eval_runs').select('id,overall_score,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20)),
    safeMany(supabase.from('drift_guard_logs').select('id,risk_level,final_risk_score,warnings,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(80)),
    safeMany(supabase.from('self_clone_readiness_reports').select('id,readiness_level,overall_score,summary,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10)),
    safeMany(supabase.from('long_term_memories').select('*').eq('user_id', userId).order('importance_score', { ascending: false }).limit(400)),
  ])
  return {
    rawEntries, agentMemories, nodes, edges, brainReports: reports, identityFacts, identitySnapshots: snapshots,
    communicationPatterns, communicationSamples, ownerExamples, chatMessages, replyPairs, reflectionLogs,
    evolutionSuggestions, identityConflicts, similarityRuns, driftLogs, readinessReports, longTermMemories,
    counts: { raw_entries: rawEntries.length, agent_memories: agentMemories.length, brain_nodes: nodes.length, brain_edges: edges.length, brain_reports: reports.length, identity_facts: identityFacts.length, communication_patterns: communicationPatterns.length, chat_messages: chatMessages.length, owner_answer_examples: ownerExamples.length, identity_conflicts: identityConflicts.length, long_term_memories: longTermMemories.length },
  }
}

function buildPrompt(context, period, runType) {
  return `${SYSTEM_PROMPT}\n\nInput JSON:\n${JSON.stringify({
    run_type: runType,
    period,
    evidence_priority: ['raw_entries asli', 'chat messages owner', 'owner answer examples', 'identity facts high confidence', 'communication patterns high confidence', 'self reflection logs', 'identity conflicts', 'brain reports', 'agent memories'],
    source_counts: context.counts,
    identity_facts: context.identityFacts.slice(0, 80).map((x) => ({ id: x.id, type: x.fact_type, label: x.label, statement: excerpt(x.statement, 400), confidence_score: x.confidence_score, stability: x.stability, evidence_refs: x.evidence_refs })),
    communication_patterns: context.communicationPatterns.slice(0, 50).map((x) => ({ id: x.id, type: x.pattern_type, label: x.label, description: excerpt(x.description, 400), confidence_score: x.confidence_score, evidence_refs: x.evidence_refs })),
    identity_conflicts: context.identityConflicts.slice(0, 30).map((x) => ({ id: x.id, title: x.title, summary: excerpt(x.summary, 400), severity: x.severity, recurrence: x.recurrence, status: x.resolution_status })),
    brain_reports: context.brainReports.slice(0, 10).map((x) => ({ id: x.id, title: x.title, repeated_patterns: x.repeated_patterns, risks: x.risks })),
    existing_long_term_memories: context.longTermMemories.slice(0, 80).map((x) => ({ id: x.id, type: x.memory_type, title: x.title, status: x.status, freshness: x.freshness, confidence_score: x.confidence_score })),
    output_shape: { summary: '...', long_term_memories: [], review_items: [], duplicates: [], stale_candidates: [], archive_candidates: [], warnings: [] },
  }, null, 2)}`
}

async function callLLM(prompt) {
  const provider = resolvedProvider()
  if (provider === 'disabled') throw new Error('Provider disabled.')
  if (provider === 'claude-code') {
    const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude'
    const output = await runCommand(command, ['--bare', '--no-session-persistence', '--output-format', 'text', '-p', prompt], { timeoutMs: 180000 })
    return parseJsonOrThrow(output)
  }
  throw new Error(`Provider ${provider} belum diaktifkan untuk memory consolidation MVP.`)
}

async function insertRun(supabase, userId, runType, period) {
  const { data, error } = await supabase.from('memory_consolidation_runs').insert({ user_id: userId, run_type: runType, status: 'running', period_start: period.start.toISOString(), period_end: period.end.toISOString(), started_at: new Date().toISOString(), metadata: { generated_by: 'memory-consolidation' } }).select('*').single()
  if (error) throw error
  return data
}
async function updateRun(supabase, runId, patch) { const { data, error } = await supabase.from('memory_consolidation_runs').update(patch).eq('id', runId).select('*').single(); if (error) throw error; return data }
async function insertConsolidationItem(supabase, userId, runId, item) { const { error } = await supabase.from('memory_consolidation_items').insert({ user_id: userId, consolidation_run_id: runId, ...item }); if (error) throw error }
async function insertReviewItem(supabase, userId, item) {
  const existing = await safeMany(supabase.from('memory_review_queue').select('id').eq('user_id', userId).eq('status', 'pending').eq('review_type', item.review_type).eq('title', item.title).limit(1))
  if (existing.length) return existing[0]
  const { data, error } = await supabase.from('memory_review_queue').insert({ user_id: userId, ...item }).select('*').single()
  if (error) throw error
  return data
}

function writeMemoryReports(latest) {
  const dir = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault', '_system/memory')
  mkdirSync(dir, { recursive: true })
  const memories = latest.long_term_memories ?? []
  const reviews = latest.review_queue ?? []
  const core = memories.filter((m) => m.stability === 'core')
  const stale = memories.filter((m) => m.freshness === 'stale')
  const duplicateReviews = reviews.filter((r) => r.review_type === 'duplicate_memory')
  writeMarked(resolve(dir, 'Long-Term Memory Latest.md'), ['# Long-Term Memory Latest', '', `Generated: ${new Date().toISOString()}`, `Total memories: ${memories.length}`, `Core memories: ${core.length}`, '', '## Core memories', ...core.slice(0, 30).map((m) => `- ${m.title}: ${m.canonical_statement}`), '', '## Active recurring patterns', ...memories.filter((m) => ['recurring_pattern', 'decision_pattern'].includes(m.memory_type)).slice(0, 30).map((m) => `- ${m.title}`), '', '## Warnings', ...arrayOfStrings(latest.audit?.warnings).map((w) => `- ${w}`)].join('\n'))
  writeMarked(resolve(dir, 'Long-Term Memory Snapshot.md'), ['# Long-Term Memory Snapshot', '', latest.latest_snapshot?.summary ?? 'No snapshot yet.', '', '## Memory health', '```json', JSON.stringify(latest.memory_health ?? {}, null, 2), '```'].join('\n'))
  writeMarked(resolve(dir, 'Memory Review Queue.md'), ['# Memory Review Queue', '', ...reviews.slice(0, 80).map((r) => `- [${r.priority}] ${r.review_type}: ${r.title} (${r.status})`)].join('\n'))
  writeMarked(resolve(dir, 'Memory Consolidation Report.md'), ['# Memory Consolidation Report', '', `Latest run: ${latest.latest_run?.id ?? 'none'}`, `Summary: ${latest.latest_run?.summary ?? 'none'}`, '', '## Stale candidates', ...stale.map((m) => `- ${m.title}`), '', '## Duplicate candidates', ...duplicateReviews.map((r) => `- ${r.title}`), '', '## Next actions', '- Review high/critical queue items.', '- Keep auto-merge and auto-archive disabled unless an explicit safe path is built.'].join('\n'))
}

function writeMarked(path, content) { const wrapped = `${AUTO_START}\n${content}\n${AUTO_END}\n`; const current = existsSync(path) ? readFileSync(path, 'utf8') : ''; if (current.includes(AUTO_START) && current.includes(AUTO_END)) writeFileSync(path, current.replace(new RegExp(`${escapeRegExp(AUTO_START)}[\\s\\S]*?${escapeRegExp(AUTO_END)}`), wrapped.trim()), 'utf8'); else writeFileSync(path, wrapped, 'utf8') }

function normalizePlan(raw, generatedBy) {
  return {
    summary: String(raw?.summary ?? 'Memory consolidation completed.'),
    long_term_memories: arrayFrom(raw?.long_term_memories).map((item) => normalizePlanMemory(item)).filter(Boolean),
    review_items: arrayFrom(raw?.review_items).map((item) => normalizeReviewItem(item)).filter(Boolean),
    duplicates: arrayFrom(raw?.duplicates),
    stale_candidates: arrayFrom(raw?.stale_candidates),
    archive_candidates: arrayFrom(raw?.archive_candidates),
    warnings: arrayOfStrings(raw?.warnings),
    generated_by: generatedBy,
  }
}
function normalizePlanMemory(item) { if (!item?.title && !item?.canonical_statement) return null; return { memory_type: sanitizeMemoryType(item.memory_type), title: String(item.title ?? titleFromText(item.canonical_statement, 'unknown')), canonical_statement: String(item.canonical_statement ?? item.summary ?? item.title), summary: item.summary ?? item.canonical_statement ?? null, importance_score: clamp(Number(item.importance_score ?? 0.55)), confidence_score: clamp(Number(item.confidence_score ?? 0.55)), stability: sanitizeStability(item.stability), recurrence: sanitizeRecurrence(item.recurrence), freshness: sanitizeFreshness(item.freshness), evidence_refs: arrayFrom(item.evidence_refs), metadata: { generated_by: 'llm' } } }
function normalizeReviewItem(item) { if (!item?.title) return null; return review(item.review_type ?? 'evidence_missing', item.title, item.description ?? '', item.suggested_action ?? 'add_evidence', item.priority ?? 'medium', item.risk_score ?? 0.4, item.source_refs ?? [], item.target_refs ?? []) }

function review(review_type, title, description, suggested_action, priority, risk_score, source_refs = [], target_refs = []) { return { review_type: sanitizeReviewType(review_type), title: String(title), description: String(description ?? ''), source_refs: arrayFrom(source_refs), target_refs: arrayFrom(target_refs), suggested_action: sanitizeSuggestedAction(suggested_action), risk_score: round4(clamp(Number(risk_score ?? 0.4))), priority: sanitizePriority(priority), status: 'pending', metadata: { generated_by: 'memory-consolidation' } } }
function reviewItemsForMemory(memory, saved) { const out = []; if (memory.stability === 'core') out.push(review('core_memory_candidate', `Core memory candidate: ${memory.title}`, 'Review sebelum memory dipakai sebagai core jangka panjang.', 'keep_active', 'high', 0.2, memory.evidence_refs, [{ type: 'long_term_memory', id: saved.id, label: saved.title }])); if (memory.freshness === 'stale') out.push(review('stale_memory', `Stale memory: ${memory.title}`, 'Memory stale tidak boleh dipakai sebagai current fact tanpa konteks historis.', 'keep_active', 'medium', 0.45, [{ type: 'long_term_memory', id: saved.id, label: saved.title }], [])); if (arrayFrom(memory.related_conflict_ids).length) out.push(review('conflicting_memory', `Conflict-linked memory: ${memory.title}`, 'Memory terkait conflict perlu jawaban bernuansa.', 'link_conflict', 'high', 0.55, memory.evidence_refs, [{ type: 'long_term_memory', id: saved.id, label: saved.title }])); return out }
function duplicateCandidates(candidates, existing) { const out = []; for (const candidate of candidates) { const cTitle = normalizeTitle(candidate.title); const cText = normalizeWords(candidate.canonical_statement); const match = existing.find((m) => m.memory_type === candidate.memory_type && (normalizeTitle(m.title) === cTitle || similarity(cText, normalizeWords(m.canonical_statement)) > 0.72)); if (match) out.push({ title: candidate.title, source_id: null, target_id: match.id, source_refs: candidate.evidence_refs ?? [], target_refs: [{ type: 'long_term_memory', id: match.id, label: match.title }] }) } return out.slice(0, 50) }
function staleCandidates(existing) { const staleDays = readIntEnv('MEMORY_CONSOLIDATION_STALE_DAYS', 180, 30, 2000); const cutoff = Date.now() - staleDays * 86400000; return existing.filter((m) => m.status === 'active' && m.last_seen_at && Date.parse(m.last_seen_at) < cutoff).slice(0, 80) }
function memoryHealth(memories, reviews) { return { total_long_term_memories: memories.length, core_memory_count: memories.filter((m) => m.stability === 'core').length, active_memory_count: memories.filter((m) => m.status === 'active').length, stale_candidate_count: memories.filter((m) => m.freshness === 'stale').length, duplicate_candidate_count: reviews.filter((r) => r.review_type === 'duplicate_memory' && r.status === 'pending').length, review_queue_count: reviews.filter((r) => r.status === 'pending').length, needs_review_count: memories.filter((m) => m.status === 'needs_review').length } }

async function createSupabaseClient() { const url = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL); const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; if (serviceKey) return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }); const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY); const accessToken = process.env.SUPABASE_ACCESS_TOKEN; const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined }); if (!accessToken && process.env.SUPABASE_USER_EMAIL && process.env.SUPABASE_USER_PASSWORD) { const { error } = await client.auth.signInWithPassword({ email: process.env.SUPABASE_USER_EMAIL, password: process.env.SUPABASE_USER_PASSWORD }); if (error) throw error } return client }
async function resolveUserId(supabase) { if (process.env.BRAIN_USER_ID) return process.env.BRAIN_USER_ID; const { data: userData } = await supabase.auth.getUser(); if (userData?.user?.id) return userData.user.id; const { data, error } = await supabase.from('raw_entries').select('user_id').limit(1); if (error && error.code !== '42P01') throw error; if (data?.[0]?.user_id) return data[0].user_id; throw new Error('BRAIN_USER_ID belum tersedia dan user tidak bisa dideteksi.') }
async function safeMany(query) { const { data, error } = await query; if (error && error.code !== '42P01') throw error; return data ?? [] }
function resolvedProvider() { return (process.env.MEMORY_CONSOLIDATION_PROVIDER || process.env.ENTITY_RUNTIME_PROVIDER || process.env.SELF_CLONE_EVAL_PROVIDER || process.env.IDENTITY_CONFLICTS_PROVIDER || process.env.SELF_REFLECTION_PROVIDER || process.env.DRIFT_CONTROL_PROVIDER || process.env.SIMILARITY_EVAL_PROVIDER || process.env.OWNER_CALIBRATION_PROVIDER || process.env.RESPONSE_INFERENCE_PROVIDER || process.env.COMMUNICATION_PROVIDER || process.env.IDENTITY_PROVIDER || process.env.BRAIN_CHAT_PROVIDER || process.env.LLM_PROVIDER || 'claude-code').toLowerCase() }
function useLlm() { return readBoolEnv('LONG_TERM_MEMORY_ENABLED', true) && readBoolEnv('MEMORY_CONSOLIDATION_USE_LLM', true) && resolvedProvider() !== 'disabled' }
function resolvePeriod(runType, from, to, full) { if (full || runType === 'full') return { start: new Date('1970-01-01T00:00:00.000Z'), end: new Date() }; const end = to ? parseDate(to, 'to') : new Date(); const start = from ? parseDate(from, 'from') : new Date(end.getTime() - (runType === 'monthly' ? 30 : runType === 'weekly' ? 7 : 1) * 86400000); return { start, end } }
function parseDate(value, label) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} harus YYYY-MM-DD.`); const date = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(date.getTime())) throw new Error(`${label} tidak valid.`); return date }
function mapFactType(type) { const map = { goal: 'long_term_goal', preference: 'belief_or_value', value: 'belief_or_value', belief: 'belief_or_value', trait: 'core_identity', identity_summary: 'core_identity', decision_pattern: 'decision_pattern', risk_pattern: 'risk_pattern', emotional_pattern: 'emotional_pattern', boundary: 'boundary', communication_pattern: 'communication_style' }; return map[type] ?? 'core_identity' }
function stabilityForEvidence(confidence, evidenceCount, sourceStability) { if (sourceStability === 'core' || confidence >= 0.86 && evidenceCount >= 3) return 'core'; if (sourceStability === 'stable' || confidence >= 0.75 && evidenceCount >= 2) return 'stable'; if (evidenceCount >= 2 || confidence >= 0.65) return 'recurring'; if (confidence >= 0.55) return 'emerging'; return 'temporary' }
function recurrenceForEvidence(evidenceCount, confidence) { if (evidenceCount >= 4 || confidence >= 0.85) return 'persistent'; if (evidenceCount >= 3 || confidence >= 0.75) return 'recurring'; if (evidenceCount >= 2 || confidence >= 0.6) return 'repeated'; return 'one_time' }
function freshnessForDate(value, historical) { if (historical) return 'historical'; const time = value ? Date.parse(value) : Date.now(); if (Number.isNaN(time)) return 'active'; const days = (Date.now() - time) / 86400000; if (days <= 14) return 'fresh'; if (days <= 90) return 'active'; if (days <= readIntEnv('MEMORY_CONSOLIDATION_STALE_DAYS', 180, 30, 2000)) return 'aging'; return 'stale' }
function evidenceRefsFromJson(value, fallback) { const refs = arrayFrom(value).filter((item) => item && typeof item === 'object').map((item) => ({ type: item.type ?? item.source_type ?? fallback.type, id: item.id ?? item.source_id ?? fallback.id, label: item.label ?? item.title ?? fallback.label })).filter((item) => item.id); return refs.length ? refs : [fallback] }
function idsByType(refs, type) { return refs.filter((ref) => ref.type === type).map((ref) => ref.id).filter(Boolean) }
function sourceTypeForCandidate(candidate) { const source = candidate.metadata?.source; return ['identity_fact', 'communication_pattern', 'identity_conflict', 'brain_report', 'self_reflection_log'].includes(source) ? source : 'long_term_memory' }
function sourceIdForCandidate(candidate) { const id = candidate.metadata?.source_id; return isUuid(id) ? id : null }
function latestEvidenceDate(refs) { return refs.map((r) => r.created_at ?? r.date).filter(Boolean).sort().at(-1) ?? null }
function earliestEvidenceDate(refs) { return refs.map((r) => r.created_at ?? r.date).filter(Boolean).sort()[0] ?? null }
function earlierDate(a, b) { if (!a) return b ?? null; if (!b) return a; return Date.parse(a) <= Date.parse(b) ? a : b }
function laterDate(a, b) { if (!a) return b ?? null; if (!b) return a; return Date.parse(a) >= Date.parse(b) ? a : b }
function mergeJsonArrays(a, b) { const map = new Map(); for (const item of [...arrayFrom(a), ...arrayFrom(b)]) map.set(typeof item === 'object' ? JSON.stringify(item) : String(item), item); return [...map.values()] }
function recommendedFixes(warnings) { if (!warnings.length) return ['Memory consolidation sehat. Jalankan snapshot berkala.']; return warnings.map((w) => w.includes('belum') ? 'Jalankan npm run memory:consolidate lalu npm run memory:snapshot.' : w.includes('auto') ? 'Pastikan AUTO_MERGE/AUTO_ARCHIVE tetap false.' : `Review: ${w}`) }
function titleFromText(text, fallback) { const clean = String(text ?? fallback ?? 'Memory').replace(/\s+/g, ' ').trim(); return clean.length > 72 ? clean.slice(0, 72) : clean }
function normalizeTitle(value) { return normalizeWords(value).slice(0, 120) }
function normalizeWords(value) { return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s_-]+/gu, ' ').replace(/\s+/g, ' ').trim() }
function similarity(a, b) { const as = new Set(a.split(' ').filter((x) => x.length > 3)); const bs = new Set(b.split(' ').filter((x) => x.length > 3)); if (!as.size || !bs.size) return 0; let overlap = 0; for (const token of as) if (bs.has(token)) overlap += 1; return overlap / Math.max(as.size, bs.size) }
function stabilityBoost(value) { return value === 'core' ? 0.12 : value === 'stable' ? 0.08 : value === 'recurring' ? 0.05 : 0 }
function sanitizeRunType(value) { return RUN_TYPES.has(value) ? value : 'manual' }
function sanitizeSnapshotType(value) { return SNAPSHOT_TYPES.has(value) ? value : 'manual' }
function sanitizeMemoryType(value) { return ['core_identity','recurring_pattern','long_term_goal','communication_style','decision_pattern','relationship_context','project_context','risk_pattern','emotional_pattern','belief_or_value','conflict_context','boundary','technical_context','life_event_summary','unknown'].includes(value) ? value : 'unknown' }
function sanitizeStability(value) { return ['temporary','emerging','recurring','stable','core'].includes(value) ? value : 'emerging' }
function sanitizeRecurrence(value) { return ['one_time','repeated','recurring','persistent'].includes(value) ? value : 'one_time' }
function sanitizeFreshness(value) { return ['fresh','active','aging','stale','historical'].includes(value) ? value : 'active' }
function sanitizeReviewType(value) { return ['duplicate_memory','stale_memory','conflicting_memory','low_confidence_memory','archive_candidate','merge_candidate','core_memory_candidate','identity_update_candidate','communication_update_candidate','evidence_missing'].includes(value) ? value : 'evidence_missing' }
function sanitizeSuggestedAction(value) { return ['merge','archive','keep_active','mark_needs_review','link_conflict','add_evidence','reject','ignore'].includes(value) ? value : 'add_evidence' }
function sanitizePriority(value) { return ['low','medium','high','critical'].includes(value) ? value : 'medium' }
function arrayFrom(value) { return Array.isArray(value) ? value : [] }
function arrayOfStrings(value) { return arrayFrom(value).map((item) => String(item)).filter(Boolean) }
function clamp(value) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) }
function round4(value) { return Math.round(Number(value ?? 0) * 10000) / 10000 }
function excerpt(value, max = 260) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function requiredEnv(key, fallback) { const value = process.env[key] || fallback; if (!value) throw new Error(`${key} belum tersedia.`); return value }
function readIntEnv(key, fallback, min, max) { const value = Number(process.env[key] ?? fallback); return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : fallback)) }
function readFloatEnv(key, fallback, min, max) { const value = Number(process.env[key] ?? fallback); return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback)) }
function readBoolEnv(key, fallback) { const value = process.env[key]; if (value === undefined || value === '') return fallback; return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()) }
function readBoolArg(args, key, fallback) { const value = args.get(key); if (value === undefined) return fallback; if (value === true) return true; return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()) }
function readArg(args, key) { const value = args.get(key); return typeof value === 'string' ? value : '' }
function parseArgs(argv) { const args = new Map(); for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (!arg.startsWith('--')) continue; const key = arg.slice(2); const next = argv[i + 1]; if (next && !next.startsWith('--')) { args.set(key, next); i += 1 } else args.set(key, true) } return args }
function parseJsonOrThrow(text) { const cleaned = String(text).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim(); try { return JSON.parse(cleaned) } catch { const match = cleaned.match(/\{[\s\S]*\}/); if (match) return JSON.parse(match[0]); throw new Error('LLM output bukan JSON valid.') } }
function loadEnv(path, { override = false } = {}) { if (!existsSync(path)) return; for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue; const index = trimmed.indexOf('='); const key = trimmed.slice(0, index).trim(); const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, ''); if (override || process.env[key] === undefined) process.env[key] = value } }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function runCommand(command, commandArgs, { timeoutMs = 120000 } = {}) { return new Promise((resolvePromise, reject) => { const child = spawn(command, commandArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timeout`)) }, timeoutMs); child.stdout.on('data', (chunk) => { output += chunk.toString() }); child.stderr.on('data', (chunk) => { output += chunk.toString() }); child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolvePromise(output); else reject(new Error(output || `${command} exited ${code}`)) }); child.on('error', (err) => { clearTimeout(timer); reject(err) }) }) }
