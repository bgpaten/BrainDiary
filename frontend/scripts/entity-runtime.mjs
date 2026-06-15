import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AUTO_START = '<!-- ENTITY_RUNTIME_AUTO_START -->'
const AUTO_END = '<!-- ENTITY_RUNTIME_AUTO_END -->'
const RUNTIME_MODES = new Set(['read_only', 'proposal_only', 'supervised', 'debug', 'disabled'])
const SESSION_TYPES = new Set(['chat', 'reflection', 'evaluation', 'manual', 'daily_use', 'debug'])
const PROPOSAL_STATUSES = new Set(['approved', 'rejected', 'ignored'])
const DEFAULT_ALLOWED_WRITES = ['entity_runtime_sessions', 'entity_runtime_events', 'entity_action_proposals', 'entity_runtime_safety_reports']

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
    if (args.has('policies')) {
      result = args.has('seed') ? await seedRuntimePolicies({ force: args.has('force') }) : await latestRuntimeState()
    } else if (args.has('session')) {
      if (args.has('start')) result = await startRuntimeSession({ runtimeMode: args.get('mode') ?? 'read_only', sessionType: args.get('session-type') ?? 'manual' })
      else if (args.has('end')) result = await endRuntimeSession({ sessionId: args.get('session-id') })
      else result = await latestRuntimeState()
    } else if (args.has('run')) {
      const question = readArg(args, 'question')
      if (!question.trim()) throw new Error('Question kosong.')
      if (question.length > 5000) throw new Error('Question terlalu panjang. Maksimum 5000 karakter.')
      result = await runEntityQuestion({ question, dryRun: args.has('dry-run') })
    } else if (args.has('proposal')) {
      if (args.has('review')) {
        result = await reviewActionProposal({ proposalId: readArg(args, 'proposal-id'), status: readArg(args, 'status'), reviewNote: args.get('review-note') ?? '' })
      } else {
        result = await latestProposals()
      }
    } else if (args.has('audit')) {
      result = await auditEntityRuntime({ save: readBoolArg(args, 'save', true) })
    } else {
      result = await latestRuntimeState()
    }
    console.log(JSON.stringify(result, null, args.has('pretty') ? 2 : 0))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export async function prepareEntityRuntime({ supabase, userId, question, dryRun = false, source = 'response_inference' }) {
  if (!runtimeEnabled()) return { enabled: false, entity_runtime: { enabled: false } }
  const session = await ensureActiveSession(supabase, userId, { sessionType: source === 'brain_chat' ? 'chat' : 'manual' })
  const policies = await loadRuntimePolicies({ supabase, userId })
  const context = await buildRuntimeContext({ supabase, userId, session, policies })
  const requestedAction = classifyRequestedAction(question)
  const decision = checkRuntimeBoundary({ question, requestedAction, policies, context })
  await logRuntimeEvent({
    supabase,
    userId,
    runtimeSessionId: session?.id ?? null,
    eventType: 'chat_request',
    eventSummary: requestedAction.action_detected ? `Action request detected: ${requestedAction.action_kind}` : 'Runtime chat request checked.',
    inputPayload: { question, source },
    outputPayload: { requested_action: requestedAction },
    policyDecision: decision,
    blocked: decision.action_blocked,
    requiresApproval: decision.requires_approval,
    riskScore: decision.risk_score,
    warnings: decision.policy_warnings,
  })
  let proposal = null
  if (requestedAction.action_detected && shouldCreateProposal(requestedAction, decision) && !dryRun) {
    proposal = await createActionProposal({
      supabase,
      userId,
      runtimeSessionId: session?.id ?? null,
      requestedAction,
      decision,
      question,
    })
    await logRuntimeEvent({
      supabase,
      userId,
      runtimeSessionId: session?.id ?? null,
      eventType: 'proposal_created',
      eventSummary: `Proposal created: ${proposal?.title ?? requestedAction.action_kind}`,
      inputPayload: { question },
      outputPayload: { proposal_id: proposal?.id ?? null },
      policyDecision: decision,
      blocked: decision.action_blocked,
      requiresApproval: true,
      riskScore: decision.risk_score,
      warnings: decision.policy_warnings,
    })
  }
  const entityRuntime = buildEntityRuntimePayload({ session, decision, requestedAction, proposal, context })
  if (decision.action_blocked) {
    await logRuntimeEvent({
      supabase,
      userId,
      runtimeSessionId: session?.id ?? null,
      eventType: 'boundary_block',
      eventSummary: decision.block_reason,
      inputPayload: { question },
      outputPayload: { answer: decision.safe_answer, proposal_id: proposal?.id ?? null },
      policyDecision: decision,
      blocked: true,
      requiresApproval: true,
      riskScore: decision.risk_score,
      warnings: decision.policy_warnings,
    })
    return {
      enabled: true,
      blocked: true,
      answer: decision.safe_answer,
      entity_runtime: entityRuntime,
    }
  }
  return { enabled: true, blocked: false, entity_runtime: entityRuntime, context, requested_action: requestedAction }
}

export async function finalizeEntityRuntime({ supabase, userId, runtime, answer }) {
  if (!runtime?.enabled || !runtime?.entity_runtime?.enabled) return runtime?.entity_runtime ?? { enabled: false }
  const entityRuntime = {
    ...runtime.entity_runtime,
    boundary_checked: true,
    action_blocked: false,
    runtime_risk_score: runtime.entity_runtime.runtime_risk_score ?? 0.08,
  }
  await logRuntimeEvent({
    supabase,
    userId,
    runtimeSessionId: entityRuntime.runtime_session_id,
    eventType: 'safe_response_generated',
    eventSummary: 'Safe runtime response generated.',
    inputPayload: { action_detected: entityRuntime.action_detected },
    outputPayload: { answer: excerpt(answer, 800) },
    policyDecision: { runtime_mode: entityRuntime.runtime_mode, action_blocked: false },
    blocked: false,
    requiresApproval: false,
    riskScore: entityRuntime.runtime_risk_score,
    warnings: entityRuntime.policy_warnings ?? [],
  })
  return entityRuntime
}

async function runEntityQuestion({ question, dryRun = false }) {
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const runtime = await prepareEntityRuntime({ supabase, userId, question, dryRun, source: 'entity_runtime_cli' })
  if (runtime.blocked) {
    return {
      ok: true,
      answer: runtime.answer,
      entity_runtime: runtime.entity_runtime,
    }
  }
  const inferred = await runNpmJson(['run', 'response:infer', '--', '--question', question])
  return {
    ...inferred,
    entity_runtime: inferred?.entity_runtime ?? runtime.entity_runtime,
  }
}

async function seedRuntimePolicies({ force = false } = {}) {
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const policies = defaultPolicies(userId)
  if (!force) {
    const { data, error } = await supabase.from('entity_runtime_policies').select('policy_name').eq('user_id', userId).in('policy_name', policies.map((policy) => policy.policy_name))
    if (error && error.code !== '42P01') throw error
    const existing = new Set((data ?? []).map((row) => row.policy_name))
    const missing = policies.filter((policy) => !existing.has(policy.policy_name))
    if (!missing.length) {
      const latest = await latestRuntimeState({ supabase, userId })
      if (readBoolEnv('ENTITY_RUNTIME_OUTPUT_OBSIDIAN', true)) writeRuntimeReports(latest)
      return { ok: true, policies_upserted: 0, skipped_existing: policies.length, policies: data ?? [] }
    }
    const { data: inserted, error: insertError } = await supabase.from('entity_runtime_policies').upsert(missing, { onConflict: 'user_id,policy_name' }).select('*')
    if (insertError) throw insertError
    return { ok: true, policies_upserted: inserted?.length ?? missing.length, skipped_existing: existing.size, policies: inserted ?? [] }
  }
  const { data, error } = await supabase.from('entity_runtime_policies').upsert(policies, { onConflict: 'user_id,policy_name' }).select('*')
  if (error) throw error
  const result = { ok: true, policies_upserted: data?.length ?? policies.length, skipped_existing: 0, policies: data ?? [] }
  if (readBoolEnv('ENTITY_RUNTIME_OUTPUT_OBSIDIAN', true)) writeRuntimeReports(await latestRuntimeState({ supabase, userId }))
  return result
}

async function startRuntimeSession({ runtimeMode = 'read_only', sessionType = 'manual' } = {}) {
  if (!RUNTIME_MODES.has(runtimeMode)) throw new Error('runtime mode tidak valid.')
  if (!SESSION_TYPES.has(sessionType)) throw new Error('session type tidak valid.')
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  await seedRuntimePoliciesIfEmpty(supabase, userId)
  const policies = await loadRuntimePolicies({ supabase, userId })
  const latestReadiness = await safeSingle(supabase.from('self_clone_readiness_reports').select('id,readiness_level,overall_score,release_decision,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1))
  const latestEval = await safeSingle(supabase.from('self_clone_eval_runs').select('id,readiness_level,overall_score,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1))
  const identitySnapshot = await safeSingle(supabase.from('identity_snapshots').select('id').eq('user_id', userId).order('created_at', { ascending: false }).limit(1))
  const similarityBaseline = await safeSingle(supabase.from('similarity_baselines').select('id').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1))
  const driftBaseline = await safeSingle(supabase.from('drift_baseline_snapshots').select('id').eq('user_id', userId).order('created_at', { ascending: false }).limit(1))
  const activePolicyIds = policies.filter((policy) => policy.enabled).map((policy) => policy.id)
  const context = {
    runtime_mode: runtimeMode,
    readiness_level: latestReadiness?.readiness_level ?? latestEval?.readiness_level ?? 'unknown',
    allowed_reads: mergePolicyField(policies, 'allowed_reads'),
    allowed_writes: mergePolicyField(policies, 'allowed_writes'),
    blocked_actions: mergePolicyField(policies, 'blocked_actions'),
    active_boundaries: policies.filter((policy) => policy.enabled).map((policy) => policy.policy_name),
  }
  const { data, error } = await supabase.from('entity_runtime_sessions').insert({
    user_id: userId,
    session_type: sessionType,
    runtime_mode: runtimeMode,
    title: `Safe Entity Runtime ${runtimeMode}`,
    status: 'active',
    started_at: new Date().toISOString(),
    readiness_level: context.readiness_level,
    active_policy_ids: activePolicyIds,
    active_identity_snapshot_id: identitySnapshot?.id ?? null,
    active_similarity_baseline_id: similarityBaseline?.id ?? null,
    active_drift_baseline_id: driftBaseline?.id ?? null,
    active_self_clone_eval_run_id: latestEval?.id ?? null,
    runtime_context: context,
    warnings: runtimeWarnings(context),
    metadata: { created_by: 'entity-runtime', latest_readiness_report_id: latestReadiness?.id ?? null },
  }).select('*').single()
  if (error) throw error
  await logRuntimeEvent({ supabase, userId, runtimeSessionId: data.id, eventType: 'session_started', eventSummary: `Runtime session started in ${runtimeMode}.`, inputPayload: {}, outputPayload: { session_id: data.id }, policyDecision: { runtime_mode: runtimeMode }, blocked: false, requiresApproval: false, riskScore: 0.05, warnings: data.warnings ?? [] })
  const result = { ok: true, session: data, policies_enabled: activePolicyIds.length }
  if (readBoolEnv('ENTITY_RUNTIME_OUTPUT_OBSIDIAN', true)) writeRuntimeReports(await latestRuntimeState({ supabase, userId }))
  return result
}

async function endRuntimeSession({ sessionId } = {}) {
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  let id = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null
  if (id && !isUuid(id)) throw new Error('sessionId tidak valid.')
  if (!id) {
    const latest = await safeSingle(supabase.from('entity_runtime_sessions').select('id').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1))
    id = latest?.id ?? null
  }
  if (!id) return { ok: true, session_ended: null, message: 'Tidak ada active runtime session.' }
  const { data, error } = await supabase.from('entity_runtime_sessions').update({ status: 'ended', ended_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('user_id', userId).eq('id', id).select('*').single()
  if (error) throw error
  await logRuntimeEvent({ supabase, userId, runtimeSessionId: id, eventType: 'session_ended', eventSummary: 'Runtime session ended.', inputPayload: {}, outputPayload: { session_id: id }, policyDecision: {}, blocked: false, requiresApproval: false, riskScore: 0.02, warnings: [] })
  return { ok: true, session_ended: data }
}

async function latestRuntimeState(existing = {}) {
  const supabase = existing.supabase ?? await createSupabaseClient()
  const userId = existing.userId ?? await resolveUserId(supabase)
  const [policiesRes, sessionRes, eventsRes, proposalsRes, reportRes] = await Promise.all([
    supabase.from('entity_runtime_policies').select('*').eq('user_id', userId).order('priority', { ascending: true }),
    supabase.from('entity_runtime_sessions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    supabase.from('entity_runtime_events').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(30),
    supabase.from('entity_action_proposals').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(30),
    supabase.from('entity_runtime_safety_reports').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1),
  ])
  for (const res of [policiesRes, sessionRes, eventsRes, proposalsRes, reportRes]) {
    if (res.error && res.error.code !== '42P01') throw res.error
  }
  const sessions = sessionRes.data ?? []
  const activeSession = sessions.find((session) => session.status === 'active') ?? sessions[0] ?? null
  const policies = policiesRes.data ?? []
  const events = eventsRes.data ?? []
  const proposals = proposalsRes.data ?? []
  const safetyReport = reportRes.data?.[0] ?? null
  const summary = summarizeRuntime({ policies, activeSession, events, proposals, safetyReport })
  return {
    ok: true,
    active_session: activeSession,
    sessions,
    policies,
    latest_events: events,
    proposals,
    safety_report: safetyReport,
    summary,
  }
}

async function latestProposals() {
  const latest = await latestRuntimeState()
  return { ok: true, proposals: latest.proposals, summary: { proposal_count: latest.proposals.length } }
}

async function auditEntityRuntime({ save = true } = {}) {
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const latest = await latestRuntimeState({ supabase, userId })
  const warnings = []
  const policies = latest.policies ?? []
  const criticalPolicies = ['block_identity_mutation', 'block_communication_mutation', 'block_external_actions', 'fidelity_first_runtime']
  if (!policies.length) warnings.push('Runtime policies belum diseed.')
  for (const name of criticalPolicies) {
    if (!policies.some((policy) => policy.policy_name === name && policy.enabled)) warnings.push(`Critical policy belum aktif: ${name}.`)
  }
  if (process.env.ENTITY_RUNTIME_ALLOW_EXTERNAL_ACTIONS === 'true') warnings.push('External actions masih diizinkan oleh env.')
  if (process.env.ENTITY_RUNTIME_ALLOW_IDENTITY_MUTATION === 'true') warnings.push('Identity mutation masih diizinkan oleh env.')
  if (process.env.ENTITY_RUNTIME_ALLOW_COMMUNICATION_MUTATION === 'true') warnings.push('Communication mutation masih diizinkan oleh env.')
  if (process.env.ENTITY_RUNTIME_ALLOW_COMMAND_EXECUTION === 'true') warnings.push('Command execution masih diizinkan oleh env.')
  if (process.env.ENTITY_RUNTIME_ALLOW_FILE_WRITE === 'true') warnings.push('File write bebas masih diizinkan oleh env.')
  if (!latest.active_session) warnings.push('Belum ada runtime session aktif/terbaru.')
  const highRiskProposals = latest.proposals.filter((proposal) => Number(proposal.risk_score ?? 0) >= 0.65)
  const boundaryViolations = latest.latest_events.filter((event) => event.event_type === 'boundary_block' || event.blocked)
  if (highRiskProposals.length) warnings.push(`${highRiskProposals.length} proposal high-risk perlu review.`)
  if (boundaryViolations.length) warnings.push(`${boundaryViolations.length} boundary block tercatat.`)
  const readiness = latest.active_session?.readiness_level ?? latest.safety_report?.metadata?.readiness_level ?? 'unknown'
  if (['not_ready', 'early'].includes(readiness)) warnings.push(`Self-clone readiness masih ${readiness}.`)
  let score = 100
  score -= warnings.length * 8
  if (!policies.length) score -= 30
  if (!latest.active_session) score -= 10
  score = Math.max(0, Math.min(100, score))
  const status = score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical'
  const report = {
    ok: true,
    status,
    score,
    warnings,
    recommended_fixes: recommendedFixes(warnings),
    checks: {
      policies_seeded: policies.length,
      critical_policies_enabled: criticalPolicies.filter((name) => policies.some((policy) => policy.policy_name === name && policy.enabled)),
      active_runtime_mode: latest.active_session?.runtime_mode ?? null,
      latest_session_id: latest.active_session?.id ?? null,
      latest_self_clone_readiness_level: readiness,
      external_actions_blocked: process.env.ENTITY_RUNTIME_ALLOW_EXTERNAL_ACTIONS !== 'true',
      identity_mutation_blocked: process.env.ENTITY_RUNTIME_ALLOW_IDENTITY_MUTATION !== 'true',
      communication_mutation_blocked: process.env.ENTITY_RUNTIME_ALLOW_COMMUNICATION_MUTATION !== 'true',
      file_write_blocked: process.env.ENTITY_RUNTIME_ALLOW_FILE_WRITE !== 'true',
      command_execution_blocked: process.env.ENTITY_RUNTIME_ALLOW_COMMAND_EXECUTION !== 'true',
      proposal_count: latest.proposals.length,
      high_risk_proposals: highRiskProposals.length,
      boundary_violations: boundaryViolations.length,
      runtime_events: latest.latest_events.length,
    },
  }
  if (save) {
    const { data, error } = await supabase.from('entity_runtime_safety_reports').insert({
      user_id: userId,
      title: 'Safe Entity Runtime Safety Report',
      runtime_session_id: latest.active_session?.id ?? null,
      summary: `Runtime audit ${status} dengan score ${score}.`,
      runtime_mode: latest.active_session?.runtime_mode ?? process.env.ENTITY_RUNTIME_MODE ?? 'read_only',
      policy_status: report.checks,
      blocked_actions_count: boundaryViolations.length,
      proposal_count: latest.proposals.length,
      high_risk_event_count: latest.latest_events.filter((event) => Number(event.risk_score ?? 0) >= 0.65).length,
      read_only_violations: boundaryViolations.length,
      privacy_warnings: warnings.filter((warning) => /private|privacy|sensitive/i.test(warning)),
      fidelity_warnings: warnings.filter((warning) => /fidelity|readiness|identity/i.test(warning)),
      recommended_next_steps: recommendedFixes(warnings),
      status,
      metadata: { score, readiness_level: readiness, generated_by: 'entity-runtime', read_only_violation_events: boundaryViolations.map((event) => ({ id: event.id, summary: event.event_summary, created_at: event.created_at })) },
    }).select('*').single()
    if (error) throw error
    report.safety_report_id = data.id
  }
  if (readBoolEnv('ENTITY_RUNTIME_OUTPUT_OBSIDIAN', true)) writeRuntimeReports({ ...latest, safety_report: report, summary: { ...latest.summary, audit_status: status, audit_score: score } })
  return report
}

async function reviewActionProposal({ proposalId, status, reviewNote = '' }) {
  if (!isUuid(proposalId)) throw new Error('proposalId tidak valid.')
  if (!PROPOSAL_STATUSES.has(status)) throw new Error('status proposal tidak valid.')
  if (reviewNote.length > 5000) throw new Error('reviewNote terlalu panjang.')
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  const { data, error } = await supabase.from('entity_action_proposals').update({
    status,
    review_note: reviewNote || null,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('id', proposalId).select('*').single()
  if (error) throw error
  await logRuntimeEvent({ supabase, userId, runtimeSessionId: data.runtime_session_id, eventType: 'proposal_reviewed', eventSummary: `Proposal ${status}. No external action executed.`, inputPayload: { proposal_id: proposalId, status, review_note: reviewNote }, outputPayload: { proposal: data }, policyDecision: { external_action_executed: false }, blocked: false, requiresApproval: false, riskScore: Number(data.risk_score ?? 0.2), warnings: ['Approval only changes proposal status in Step 28.'] })
  return { ok: true, proposal: data, action_executed: false }
}

async function ensureActiveSession(supabase, userId, { sessionType = 'chat' } = {}) {
  const existing = await safeSingle(supabase.from('entity_runtime_sessions').select('*').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1))
  if (existing) return existing
  await seedRuntimePoliciesIfEmpty(supabase, userId)
  const result = await startRuntimeSession({ runtimeMode: process.env.ENTITY_RUNTIME_MODE ?? 'read_only', sessionType })
  return result.session
}

async function loadRuntimePolicies({ supabase, userId }) {
  const { data, error } = await supabase.from('entity_runtime_policies').select('*').eq('user_id', userId).eq('enabled', true).order('priority', { ascending: true })
  if (error && error.code !== '42P01') throw error
  return data ?? []
}

async function buildRuntimeContext({ supabase, userId, session = null, policies = [] }) {
  const [
    readiness,
    evalRun,
    similarityBaseline,
    similarityRun,
    driftBaseline,
    driftRules,
    driftLogs,
    identitySnapshot,
    facts,
    patterns,
    hints,
    conflicts,
    reflections,
    evolutionSnapshots,
    reports,
    longTermMemories,
    memorySnapshots,
    memoryReviewQueue,
  ] = await Promise.all([
    safeSingle(supabase.from('self_clone_readiness_reports').select('id,readiness_level,overall_score,release_decision,summary,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)),
    safeSingle(supabase.from('self_clone_eval_runs').select('id,readiness_level,overall_score,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)),
    safeSingle(supabase.from('similarity_baselines').select('id,baseline_name,overall_score,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)),
    safeSingle(supabase.from('similarity_eval_runs').select('id,overall_score,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)),
    safeSingle(supabase.from('drift_baseline_snapshots').select('id,title,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)),
    safeMany(supabase.from('drift_guard_rules').select('id,rule_name,rule_type,severity,enabled').eq('user_id', userId).eq('enabled', true).limit(50)),
    safeMany(supabase.from('drift_guard_logs').select('id,risk_level,final_risk_score,warnings,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20)),
    safeSingle(supabase.from('identity_snapshots').select('id,title,summary,identity_model,confidence_summary,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)),
    safeMany(supabase.from('identity_facts').select('id,fact_type,label,statement,confidence_score,status').eq('user_id', userId).in('status', ['active', 'contradicted', 'needs_review']).gte('confidence_score', 0.65).order('confidence_score', { ascending: false }).limit(80)),
    safeMany(supabase.from('communication_patterns').select('id,pattern_type,label,description,preferred_response_shape,confidence_score,status').eq('user_id', userId).eq('status', 'active').order('confidence_score', { ascending: false }).limit(80)),
    safeMany(supabase.from('owner_calibration_hints').select('id,intent_type,label,preferred_response,avoid_response,confidence_score,status').eq('user_id', userId).in('status', ['active', 'needs_review']).limit(80)),
    safeMany(supabase.from('identity_conflicts').select('id,conflict_type,title,summary,severity,recurrence,resolution_status,impact_area,chat_guidance').eq('user_id', userId).in('resolution_status', ['open', 'monitoring', 'partially_resolved', 'needs_review']).order('last_seen_at', { ascending: false }).limit(50)),
    safeMany(supabase.from('self_reflection_logs').select('id,reflection_type,summary,confidence_score,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20)),
    safeMany(supabase.from('entity_evolution_snapshots').select('id,snapshot_type,title,summary,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)),
    safeMany(supabase.from('brain_reports').select('id,report_type,title,summary,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10)),
    safeMany(supabase.from('long_term_memories').select('id,memory_type,title,canonical_statement,importance_score,confidence_score,stability,freshness,status').eq('user_id', userId).in('status', ['active', 'needs_review', 'contradicted']).order('importance_score', { ascending: false }).limit(50)),
    safeMany(supabase.from('memory_consolidation_snapshots').select('id,snapshot_type,title,summary,memory_health,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(3)),
    safeMany(supabase.from('memory_review_queue').select('id,review_type,title,priority,status,risk_score,created_at').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(50)),
  ])
  const runtimeMode = session?.runtime_mode ?? process.env.ENTITY_RUNTIME_MODE ?? 'read_only'
  return {
    runtime_mode: runtimeMode,
    readiness_level: readiness?.readiness_level ?? evalRun?.readiness_level ?? 'unknown',
    allowed_reads: mergePolicyField(policies, 'allowed_reads'),
    allowed_writes: mergePolicyField(policies, 'allowed_writes'),
    blocked_actions: mergePolicyField(policies, 'blocked_actions'),
    active_boundaries: policies.map((policy) => policy.policy_name),
    fidelity_warnings: fidelityWarnings({ readiness, facts, conflicts }),
    privacy_warnings: privacyWarnings(),
    current_identity_summary: {
      snapshot_id: identitySnapshot?.id ?? null,
      summary: identitySnapshot?.summary ?? null,
      high_confidence_fact_count: facts.length,
      facts: facts.slice(0, 12).map((fact) => ({ id: fact.id, label: fact.label, statement: fact.statement, confidence_score: fact.confidence_score })),
    },
    current_style_summary: {
      pattern_count: patterns.length,
      calibration_hint_count: hints.length,
      patterns: patterns.slice(0, 12).map((pattern) => ({ id: pattern.id, label: pattern.label, pattern_type: pattern.pattern_type, confidence_score: pattern.confidence_score })),
    },
    current_conflicts: conflicts.slice(0, 12),
    current_uncertainties: [...conflicts.filter((conflict) => conflict.resolution_status === 'needs_review').slice(0, 5), ...reflections.slice(0, 5)],
    current_long_term_memories: longTermMemories.slice(0, 20),
    memory_review_queue: memoryReviewQueue.slice(0, 20),
    latest_memory_snapshot: memorySnapshots[0] ?? null,
    latest: {
      readiness,
      eval_run: evalRun,
      similarity_baseline: similarityBaseline,
      similarity_run: similarityRun,
      drift_baseline: driftBaseline,
      drift_rules_count: driftRules.length,
      drift_logs_summary: summarizeDriftLogs(driftLogs),
      reflection_count: reflections.length,
      evolution_snapshot_count: evolutionSnapshots.length,
      brain_report_count: reports.length,
      long_term_memory_count: longTermMemories.length,
      memory_review_queue_count: memoryReviewQueue.length,
    },
  }
}

export function classifyRequestedAction(question) {
  const normalized = normalizeWords(question)
  const draftOnly = containsAny(normalized, ['buatkan draft', 'draft pesan', 'draft email', 'buat draft'])
  const detectors = [
    { kind: 'send_email', type: 'message_draft', target: 'gmail', risk: 0.72, phrases: ['kirim email', 'send email', 'email ke', 'gmail'] },
    { kind: 'calendar_event', type: 'task_suggestion', target: 'calendar', risk: 0.7, phrases: ['buat event calendar', 'jadwalkan', 'calendar event', 'buat reminder'] },
    { kind: 'github_action', type: 'project_suggestion', target: 'github', risk: 0.82, phrases: ['push ke github', 'buat issue', 'create issue', 'commit', 'pull request', 'deploy'] },
    { kind: 'shell_command', type: 'system_maintenance_suggestion', target: 'filesystem', risk: 0.95, phrases: ['jalankan command', 'run command', 'rm -rf', 'hapus folder', 'npm run', 'terminal'] },
    { kind: 'file_write', type: 'document_draft', target: 'filesystem', risk: 0.78, phrases: ['edit file', 'hapus file', 'tulis file', 'ubah file', 'delete file'] },
    { kind: 'identity_mutation', type: 'identity_review_suggestion', target: 'supabase', risk: 0.85, phrases: ['ubah identity', 'ubah identitas', 'update identity facts', 'ubah memory', 'update memory', 'ubah database'] },
    { kind: 'communication_mutation', type: 'communication_review_suggestion', target: 'supabase', risk: 0.8, phrases: ['ubah communication', 'ubah gaya komunikasi', 'update communication pattern'] },
    { kind: 'send_message', type: 'message_draft', target: normalized.includes('whatsapp') ? 'unknown' : 'telegram', risk: 0.74, phrases: ['kirim whatsapp', 'kirim telegram', 'send message', 'kirim pesan'] },
  ]
  const found = detectors.find((detector) => containsAny(normalized, detector.phrases))
  if (found) {
    return {
      action_detected: true,
      action_kind: found.kind,
      proposal_type: found.type,
      target_system: found.target,
      risk_score: found.risk,
      draft_only: draftOnly && ['send_email', 'send_message'].includes(found.kind),
      raw_question: question,
    }
  }
  if (draftOnly) {
    return { action_detected: true, action_kind: 'draft_only', proposal_type: 'message_draft', target_system: 'none', risk_score: 0.24, draft_only: true, raw_question: question }
  }
  return { action_detected: false, action_kind: 'none', proposal_type: 'other', target_system: 'none', risk_score: 0.08, draft_only: false, raw_question: question }
}

export function checkRuntimeBoundary({ question, requestedAction, context = {} }) {
  const mode = context.runtime_mode ?? process.env.ENTITY_RUNTIME_MODE ?? 'read_only'
  const warnings = []
  const actionDetected = requestedAction.action_detected
  const mutation = ['identity_mutation', 'communication_mutation'].includes(requestedAction.action_kind)
  const command = requestedAction.action_kind === 'shell_command'
  const fileWrite = requestedAction.action_kind === 'file_write'
  const external = ['send_email', 'calendar_event', 'github_action', 'send_message'].includes(requestedAction.action_kind)
  let blocked = false
  let blockReason = ''
  if (mode === 'disabled') {
    blocked = true
    blockReason = 'Runtime disabled.'
  } else if (external && readBoolEnv('ENTITY_RUNTIME_BLOCK_EXTERNAL_ACTIONS', true)) {
    blocked = true
    blockReason = 'External action blocked by read-only runtime.'
  } else if (mutation && requestedAction.action_kind === 'identity_mutation' && !readBoolEnv('ENTITY_RUNTIME_ALLOW_IDENTITY_MUTATION', false)) {
    blocked = true
    blockReason = 'Identity mutation blocked by runtime boundary.'
  } else if (mutation && requestedAction.action_kind === 'communication_mutation' && !readBoolEnv('ENTITY_RUNTIME_ALLOW_COMMUNICATION_MUTATION', false)) {
    blocked = true
    blockReason = 'Communication mutation blocked by runtime boundary.'
  } else if (command && !readBoolEnv('ENTITY_RUNTIME_ALLOW_COMMAND_EXECUTION', false)) {
    blocked = true
    blockReason = 'Shell command execution blocked by runtime boundary.'
  } else if (fileWrite && !readBoolEnv('ENTITY_RUNTIME_ALLOW_FILE_WRITE', false)) {
    blocked = true
    blockReason = 'File write blocked by runtime boundary.'
  } else if (mode === 'read_only' && actionDetected && !requestedAction.draft_only) {
    blocked = true
    blockReason = 'Read-only runtime allows answers and proposals, not direct actions.'
  }
  if (blocked) warnings.push(blockReason)
  if (requestedAction.risk_score > readFloatEnv('ENTITY_RUNTIME_MAX_RISK_SCORE', 0.3, 0, 1)) warnings.push('Requested action risk score exceeds runtime max risk threshold.')
  return {
    runtime_mode: mode,
    boundary_checked: true,
    action_detected: actionDetected,
    action_blocked: blocked,
    requires_approval: actionDetected || readBoolEnv('ENTITY_RUNTIME_REQUIRE_APPROVAL_FOR_ALL_ACTIONS', true),
    proposal_allowed: readBoolEnv('ENTITY_RUNTIME_ALLOW_PROPOSALS', true),
    risk_score: round4(actionDetected ? requestedAction.risk_score : 0.08),
    block_reason: blockReason,
    policy_warnings: warnings,
    safe_answer: blockedAnswer({ question, requestedAction, blockReason }),
  }
}

async function createActionProposal({ supabase, userId, runtimeSessionId, requestedAction, decision, question }) {
  const title = proposalTitle(requestedAction)
  const requiredApproval = decision.action_blocked && requestedAction.action_kind === 'shell_command' ? 'blocked' : requestedAction.draft_only ? 'user_review' : requestedAction.target_system === 'supabase' ? 'manual_only' : 'explicit_confirm'
  const status = requiredApproval === 'blocked' ? 'blocked' : 'proposed'
  const { data, error } = await supabase.from('entity_action_proposals').insert({
    user_id: userId,
    runtime_session_id: runtimeSessionId,
    proposal_type: requestedAction.proposal_type,
    title,
    description: proposalDescription(requestedAction, question),
    reason: decision.block_reason || 'Runtime hanya boleh membuat proposal, bukan menjalankan aksi langsung.',
    proposed_action: {
      requested_action: requestedAction.action_kind,
      question,
      execution_allowed_in_step_28: false,
      draft_only: requestedAction.draft_only,
    },
    target_system: requestedAction.target_system,
    required_approval_level: requiredApproval,
    risk_score: decision.risk_score,
    fidelity_reason: fidelityReason(requestedAction),
    evidence_refs: [],
    status,
    metadata: {
      generated_by: 'safe_entity_runtime',
      boundary_decision: decision,
    },
  }).select('*').single()
  if (error) throw error
  return data
}

async function logRuntimeEvent({ supabase, userId, runtimeSessionId, eventType, eventSummary, inputPayload = {}, outputPayload = {}, policyDecision = {}, blocked = false, requiresApproval = false, riskScore = 0.1, warnings = [], metadata = {} }) {
  const { error } = await supabase.from('entity_runtime_events').insert({
    user_id: userId,
    runtime_session_id: runtimeSessionId,
    event_type: eventType,
    event_summary: eventSummary,
    input_payload: inputPayload,
    output_payload: outputPayload,
    policy_decision: policyDecision,
    blocked,
    requires_approval: requiresApproval,
    risk_score: round4(riskScore),
    warnings,
    metadata,
  })
  if (error && error.code !== '42P01') throw error
}

function buildEntityRuntimePayload({ session, decision, requestedAction, proposal, context }) {
  return {
    enabled: true,
    runtime_mode: decision.runtime_mode,
    runtime_session_id: session?.id ?? null,
    boundary_checked: true,
    action_detected: decision.action_detected,
    action_blocked: decision.action_blocked,
    proposal_created: Boolean(proposal),
    proposal_id: proposal?.id ?? null,
    proposal_title: proposal?.title ?? null,
    required_approval_level: proposal?.required_approval_level ?? null,
    policy_warnings: decision.policy_warnings,
    runtime_risk_score: decision.risk_score,
    readiness_level: context?.readiness_level ?? session?.readiness_level ?? null,
  }
}

function defaultPolicies(userId) {
  const now = new Date().toISOString()
  const base = { user_id: userId, enabled: true, created_at: now, updated_at: now }
  return [
    { ...base, policy_name: 'read_core_brain_allowed', policy_type: 'read_boundary', description: 'Runtime boleh membaca sistem brain inti untuk menjawab fidelity-first.', allowed_reads: ['identity_facts', 'identity_snapshots', 'communication_patterns', 'owner_calibration_hints', 'similarity_baselines', 'drift_guard_rules', 'self_reflection_logs', 'identity_conflicts', 'self_clone_readiness_reports', 'brain_reports', 'agent_memories', 'brain_nodes', 'brain_edges', 'long_term_memories', 'memory_consolidation_snapshots', 'memory_review_queue'], allowed_writes: [], blocked_actions: [], requires_approval: [], runtime_modes: ['read_only', 'proposal_only', 'supervised'], severity: 'low', priority: 10, metadata: { default_policy: true } },
    { ...base, policy_name: 'runtime_logs_write_allowed', policy_type: 'write_boundary', description: 'Runtime hanya boleh menulis session, event, proposal, dan safety report.', allowed_reads: [], allowed_writes: DEFAULT_ALLOWED_WRITES, blocked_actions: [], requires_approval: [], runtime_modes: ['read_only', 'proposal_only', 'supervised', 'debug'], severity: 'low', priority: 20, metadata: { default_policy: true } },
    { ...base, policy_name: 'block_identity_mutation', policy_type: 'identity_mutation_boundary', description: 'Identity facts tidak boleh dimutasi otomatis.', allowed_reads: [], allowed_writes: [], blocked_actions: ['insert identity_facts', 'update identity_facts', 'delete identity_facts', 'auto-apply identity_evolution_suggestions'], requires_approval: ['manual identity review'], runtime_modes: ['read_only', 'proposal_only', 'supervised'], severity: 'critical', priority: 30, metadata: { default_policy: true } },
    { ...base, policy_name: 'block_communication_mutation', policy_type: 'communication_mutation_boundary', description: 'Communication patterns tidak boleh dimutasi otomatis.', allowed_reads: [], allowed_writes: [], blocked_actions: ['insert communication_patterns', 'update communication_patterns', 'delete communication_patterns', 'auto-apply communication style changes'], requires_approval: ['manual communication review'], runtime_modes: ['read_only', 'proposal_only', 'supervised'], severity: 'critical', priority: 40, metadata: { default_policy: true } },
    { ...base, policy_name: 'block_external_actions', policy_type: 'external_action_boundary', description: 'Runtime tidak menjalankan aksi eksternal.', allowed_reads: [], allowed_writes: [], blocked_actions: ['send email', 'create calendar event', 'push GitHub commit', 'create GitHub issue', 'send WhatsApp/Telegram message', 'run shell command', 'write file outside allowed report folders', 'call external API for action'], requires_approval: ['explicit user confirmation before any future external action phase'], runtime_modes: ['read_only', 'proposal_only', 'supervised'], severity: 'critical', priority: 50, metadata: { default_policy: true } },
    { ...base, policy_name: 'proposal_only_for_actions', policy_type: 'approval_boundary', description: 'Aksi hanya menjadi proposal pada Step 28.', allowed_reads: [], allowed_writes: ['entity_action_proposals'], blocked_actions: ['execute proposed action'], requires_approval: ['all action proposals require explicit user confirmation'], runtime_modes: ['read_only', 'proposal_only'], severity: 'high', priority: 60, metadata: { default_policy: true } },
    { ...base, policy_name: 'privacy_minimization', policy_type: 'privacy_boundary', description: 'Runtime tidak mengekspos konteks pribadi yang tidak diminta.', allowed_reads: [], allowed_writes: [], blocked_actions: ['expose irrelevant private context', 'reveal sensitive memory without user asking', 'dump full private profile'], requires_approval: ['private context expansion'], runtime_modes: ['read_only', 'proposal_only', 'supervised'], severity: 'high', priority: 70, metadata: { default_policy: true } },
    { ...base, policy_name: 'fidelity_first_runtime', policy_type: 'fidelity_boundary', description: 'Runtime selalu fidelity-bound dan evidence-bound.', allowed_reads: [], allowed_writes: [], blocked_actions: ['answer beyond evidence', 'claim real consciousness', 'claim to be the original human', 'improve owner beyond evidence', 'simplify contradictions'], requires_approval: [], runtime_modes: ['read_only', 'proposal_only', 'supervised'], severity: 'critical', priority: 80, metadata: { default_policy: true } },
    { ...base, policy_name: 'debug_hidden_by_default', policy_type: 'debug_boundary', description: 'Debug dan source mentah tidak tampil default untuk chat ringan.', allowed_reads: [], allowed_writes: [], blocked_actions: ['show debug by default', 'show sources for social greeting', 'show raw internal traces'], requires_approval: [], runtime_modes: ['read_only', 'proposal_only', 'supervised'], severity: 'medium', priority: 90, metadata: { default_policy: true } },
  ]
}

async function seedRuntimePoliciesIfEmpty(supabase, userId) {
  const { data, error } = await supabase.from('entity_runtime_policies').select('id').eq('user_id', userId).limit(1)
  if (error && error.code !== '42P01') throw error
  if (!data?.length) {
    const { error: upsertError } = await supabase.from('entity_runtime_policies').upsert(defaultPolicies(userId), { onConflict: 'user_id,policy_name' })
    if (upsertError) throw upsertError
  }
}

function writeRuntimeReports(state) {
  const dir = resolve(process.cwd(), process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault', '_system/runtime')
  mkdirSync(dir, { recursive: true })
  const active = state.active_session
  const policies = state.policies ?? []
  const proposals = state.proposals ?? []
  const events = state.latest_events ?? []
  const report = state.safety_report
  writeMarked(resolve(dir, 'Entity Runtime Latest.md'), [
    '# Entity Runtime Latest',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Runtime mode: ${active?.runtime_mode ?? 'none'}`,
    `Active session: ${active?.id ?? 'none'}`,
    `Readiness level: ${active?.readiness_level ?? report?.metadata?.readiness_level ?? 'unknown'}`,
    `Policies enabled: ${policies.filter((policy) => policy.enabled).length}`,
    `Proposals: ${proposals.length}`,
    `High-risk events: ${events.filter((event) => Number(event.risk_score ?? 0) >= 0.65).length}`,
    '',
    '## Recommended next steps',
    ...arrayOfStrings(report?.recommended_next_steps ?? state.summary?.recommended_next_steps).map((item) => `- ${item}`),
  ].join('\n'))
  writeMarked(resolve(dir, 'Runtime Policies.md'), ['# Runtime Policies', '', ...policies.map((policy) => `- ${policy.policy_name} (${policy.policy_type}, ${policy.severity}) enabled=${policy.enabled}`)].join('\n'))
  writeMarked(resolve(dir, 'Action Proposals.md'), ['# Action Proposals', '', ...proposals.map((proposal) => `- ${proposal.title} | ${proposal.proposal_type} | ${proposal.target_system} | risk ${Number(proposal.risk_score ?? 0).toFixed(2)} | ${proposal.status}`)].join('\n'))
  writeMarked(resolve(dir, 'Safety Report.md'), ['# Safety Report', '', `Status: ${report?.status ?? state.summary?.audit_status ?? 'unknown'}`, `Score: ${report?.metadata?.score ?? state.summary?.audit_score ?? 'n/a'}`, '', '## Warnings', ...arrayOfStrings(report?.warnings ?? report?.fidelity_warnings ?? []).map((warning) => `- ${warning}`)].join('\n'))
}

function writeMarked(path, content) {
  const wrapped = `${AUTO_START}\n${content}\n${AUTO_END}\n`
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (current.includes(AUTO_START) && current.includes(AUTO_END)) {
    writeFileSync(path, current.replace(new RegExp(`${escapeRegExp(AUTO_START)}[\\s\\S]*?${escapeRegExp(AUTO_END)}`), wrapped.trim()), 'utf8')
  } else {
    writeFileSync(path, `${wrapped}`, 'utf8')
  }
}

async function createSupabaseClient() {
  const url = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceKey) return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined })
  if (!accessToken && process.env.SUPABASE_USER_EMAIL && process.env.SUPABASE_USER_PASSWORD) {
    const { error } = await client.auth.signInWithPassword({ email: process.env.SUPABASE_USER_EMAIL, password: process.env.SUPABASE_USER_PASSWORD })
    if (error) throw error
  }
  return client
}

async function resolveUserId(supabase) {
  if (process.env.BRAIN_USER_ID) return process.env.BRAIN_USER_ID
  const { data: userData } = await supabase.auth.getUser()
  if (userData?.user?.id) return userData.user.id
  const { data, error } = await supabase.from('raw_entries').select('user_id').limit(1)
  if (error && error.code !== '42P01') throw error
  if (data?.[0]?.user_id) return data[0].user_id
  throw new Error('BRAIN_USER_ID belum tersedia dan user tidak bisa dideteksi.')
}

function runtimeEnabled() { return readBoolEnv('SAFE_ENTITY_RUNTIME_ENABLED', true) }
function shouldCreateProposal(action, decision) { return action.action_detected && decision.proposal_allowed !== false }
function mergePolicyField(policies, field) { return uniqueStrings(policies.flatMap((policy) => Array.isArray(policy[field]) ? policy[field] : [])) }
function runtimeWarnings(context) { return [...(context.fidelity_warnings ?? []), ...(context.privacy_warnings ?? [])] }
function fidelityWarnings({ readiness, facts, conflicts }) { const out = []; if (!readiness) out.push('Self-clone readiness belum tersedia.'); if (!facts.length) out.push('High-confidence identity facts belum banyak.'); if (conflicts.some((c) => ['high', 'critical'].includes(c.severity))) out.push('Ada identity conflict high/critical aktif.'); return out }
function privacyWarnings() { return ['Runtime memakai privacy minimization: jangan dump profil pribadi penuh tanpa diminta.'] }
function summarizeDriftLogs(logs) { return { count: logs.length, high_or_critical: logs.filter((log) => ['high', 'critical'].includes(log.risk_level)).length, latest_score: logs[0]?.final_risk_score ?? null } }
function summarizeRuntime({ policies, activeSession, events, proposals, safetyReport }) { return { runtime_mode: activeSession?.runtime_mode ?? null, policies_enabled: policies.filter((p) => p.enabled).length, blocked_actions_count: events.filter((event) => event.blocked).length, proposal_count: proposals.length, high_risk_event_count: events.filter((event) => Number(event.risk_score ?? 0) >= 0.65).length, safety_status: safetyReport?.status ?? null, recommended_next_steps: ['Review proposal high-risk secara manual.', 'Jalankan entity:audit setelah perubahan policy.', 'Jangan eksekusi action eksternal dari approval Step 28.'] } }
function recommendedFixes(warnings) { if (!warnings.length) return ['Runtime boundary sehat. Lanjut pakai read-only session.']; return warnings.map((warning) => warning.includes('policies') ? 'Jalankan npm run entity:policies -- --seed.' : warning.includes('External') ? 'Set ENTITY_RUNTIME_ALLOW_EXTERNAL_ACTIONS=false.' : warning.includes('session') ? 'Jalankan npm run entity:session -- --start --mode read_only.' : `Review: ${warning}`) }
function blockedAnswer({ requestedAction, blockReason }) { if (requestedAction.action_kind === 'identity_mutation') return 'Tidak saya ubah langsung. Klaim itu harus berbasis evidence. Saya bisa buat proposal review identity jika memang ada bukti yang mendukung.'; if (requestedAction.action_kind === 'communication_mutation') return 'Tidak saya ubah langsung. Gaya komunikasi harus berubah lewat review evidence, bukan otomatis dari satu prompt.'; if (requestedAction.action_kind === 'shell_command') return 'Saya tidak menjalankan command dalam runtime read-only. Saya buatkan proposal tindakan untuk kamu review manual.'; if (requestedAction.action_kind === 'file_write') return 'Saya tidak menulis atau menghapus file langsung dalam runtime read-only. Saya bisa buat proposal perubahan untuk kamu review.'; return blockReason ? 'Saya tidak menjalankan aksi itu langsung. Saya buatkan proposal tindakan untuk kamu review.' : 'Saya hanya bisa menjawab atau membuat proposal, bukan menjalankan aksi langsung.' }
function proposalTitle(action) { const titles = { send_email: 'Draft/proposal email', calendar_event: 'Proposal calendar event', github_action: 'Proposal GitHub action', shell_command: 'Blocked command proposal', file_write: 'Proposal file change', identity_mutation: 'Identity review suggestion', communication_mutation: 'Communication review suggestion', send_message: 'Message draft proposal', draft_only: 'Draft proposal' }; return titles[action.action_kind] ?? 'Action proposal' }
function proposalDescription(action, question) { return `Permintaan terdeteksi sebagai ${action.action_kind}. Runtime Step 28 menyimpan ini sebagai proposal, tidak mengeksekusi. Prompt: ${excerpt(question, 500)}` }
function fidelityReason(action) { if (action.action_kind === 'identity_mutation') return 'Identity harus evidence-bound dan manual review.'; if (action.action_kind === 'communication_mutation') return 'Communication style harus dibangun dari sample/evidence, bukan prompt tunggal.'; return 'Runtime menjaga fidelity dengan memisahkan jawaban, saran, dan eksekusi aksi.' }
function normalizeWords(value) { return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s_-]+/gu, ' ').replace(/\s+/g, ' ').trim() }
function containsAny(value, needles) { return needles.some((needle) => value.includes(needle)) }
function uniqueStrings(items) { return [...new Set(items.map((item) => String(item)).filter(Boolean))] }
function arrayOfStrings(value) { return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [] }
function excerpt(value, max = 240) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text }
function round4(value) { return Math.round(Number(value ?? 0) * 10000) / 10000 }
function readFloatEnv(key, fallback, min, max) { const value = Number(process.env[key] ?? fallback); return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback)) }
function readBoolEnv(key, fallback) { const value = process.env[key]; if (value === undefined || value === '') return fallback; return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()) }
function readBoolArg(args, key, fallback) { const value = args.get(key); if (value === undefined) return fallback; if (value === true) return true; return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()) }
function readArg(args, key) { const value = args.get(key); return typeof value === 'string' ? value : '' }
function requiredEnv(key, fallback) { const value = process.env[key] || fallback; if (!value) throw new Error(`${key} belum tersedia.`); return value }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function parseArgs(argv) { const args = new Map(); for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (!arg.startsWith('--')) continue; const key = arg.slice(2); const next = argv[i + 1]; if (next && !next.startsWith('--')) { args.set(key, next); i += 1 } else args.set(key, true) } return args }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function loadEnv(path, { override = false } = {}) { if (!existsSync(path)) return; for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue; const index = trimmed.indexOf('='); const key = trimmed.slice(0, index).trim(); const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, ''); if (override || process.env[key] === undefined) process.env[key] = value } }
async function safeSingle(query) { const { data, error } = await query; if (error && error.code !== '42P01') throw error; return Array.isArray(data) ? data[0] ?? null : data ?? null }
async function safeMany(query) { const { data, error } = await query; if (error && error.code !== '42P01') throw error; return data ?? [] }
function runNpmJson(args) { return new Promise((resolvePromise, reject) => { const child = spawn('npm', args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk.toString() }); child.stderr.on('data', (chunk) => { output += chunk.toString() }); child.on('close', (code) => { if (code !== 0) return reject(new Error(output || `npm exited ${code}`)); const line = output.trim().split(/\r?\n/).reverse().find((item) => item.trim().startsWith('{')); try { resolvePromise(JSON.parse(line ?? output)) } catch { resolvePromise({ ok: true, output }) } }); child.on('error', reject) }) }
