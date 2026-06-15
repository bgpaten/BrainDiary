export type RuntimeMode = 'read_only' | 'proposal_only' | 'supervised' | 'debug' | 'disabled'
export type RuntimeSessionType = 'chat' | 'reflection' | 'evaluation' | 'manual' | 'daily_use' | 'debug'
export type ProposalReviewStatus = 'approved' | 'rejected' | 'ignored'

export interface RequestedAction {
  action_detected: boolean
  action_kind: string
  proposal_type: string
  target_system: string
  risk_score: number
  draft_only: boolean
}

export interface RuntimeBoundaryDecision {
  runtime_mode: RuntimeMode
  boundary_checked: boolean
  action_detected: boolean
  action_blocked: boolean
  requires_approval: boolean
  risk_score: number
  policy_warnings: string[]
}

export function classifyRequestedAction(question: string): RequestedAction {
  const normalized = question.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s_-]+/gu, ' ').replace(/\s+/g, ' ').trim()
  const draftOnly = ['buatkan draft', 'draft pesan', 'draft email', 'buat draft'].some((needle) => normalized.includes(needle))
  const detectors = [
    { kind: 'send_email', type: 'message_draft', target: 'gmail', risk: 0.72, phrases: ['kirim email', 'send email', 'email ke', 'gmail'] },
    { kind: 'calendar_event', type: 'task_suggestion', target: 'calendar', risk: 0.7, phrases: ['buat event calendar', 'jadwalkan', 'calendar event'] },
    { kind: 'github_action', type: 'project_suggestion', target: 'github', risk: 0.82, phrases: ['push ke github', 'buat issue', 'commit', 'pull request', 'deploy'] },
    { kind: 'shell_command', type: 'system_maintenance_suggestion', target: 'filesystem', risk: 0.95, phrases: ['jalankan command', 'rm -rf', 'npm run', 'terminal'] },
    { kind: 'file_write', type: 'document_draft', target: 'filesystem', risk: 0.78, phrases: ['edit file', 'hapus file', 'tulis file', 'ubah file'] },
    { kind: 'identity_mutation', type: 'identity_review_suggestion', target: 'supabase', risk: 0.85, phrases: ['ubah identity', 'ubah identitas', 'update identity facts', 'ubah memory', 'ubah database'] },
    { kind: 'communication_mutation', type: 'communication_review_suggestion', target: 'supabase', risk: 0.8, phrases: ['ubah communication', 'ubah gaya komunikasi', 'update communication pattern'] },
    { kind: 'send_message', type: 'message_draft', target: 'telegram', risk: 0.74, phrases: ['kirim whatsapp', 'kirim telegram', 'send message', 'kirim pesan'] },
  ]
  const found = detectors.find((detector) => detector.phrases.some((phrase) => normalized.includes(phrase)))
  if (found) return { action_detected: true, action_kind: found.kind, proposal_type: found.type, target_system: found.target, risk_score: found.risk, draft_only: draftOnly }
  if (draftOnly) return { action_detected: true, action_kind: 'draft_only', proposal_type: 'message_draft', target_system: 'none', risk_score: 0.24, draft_only: true }
  return { action_detected: false, action_kind: 'none', proposal_type: 'other', target_system: 'none', risk_score: 0.08, draft_only: false }
}

export function checkRuntimeBoundary(question: string, runtimeMode: RuntimeMode = 'read_only'): RuntimeBoundaryDecision {
  const action = classifyRequestedAction(question)
  const actionBlocked = runtimeMode === 'disabled' || (runtimeMode === 'read_only' && action.action_detected && !action.draft_only)
  return {
    runtime_mode: runtimeMode,
    boundary_checked: true,
    action_detected: action.action_detected,
    action_blocked: actionBlocked,
    requires_approval: action.action_detected,
    risk_score: action.action_detected ? action.risk_score : 0.08,
    policy_warnings: actionBlocked ? ['Action blocked by read-only runtime.'] : [],
  }
}

export function isActionAllowed(question: string, runtimeMode: RuntimeMode = 'read_only') {
  return !checkRuntimeBoundary(question, runtimeMode).action_blocked
}

export function applyReadOnlyBoundary(answer: string) {
  return sanitizeRuntimeResponse(answer)
}

export function sanitizeRuntimeResponse(answer: string) {
  return answer
    .replace(/\bI am the original human\b/gi, 'Saya adalah simulasi respons berbasis evidence')
    .replace(/\bsaya punya kesadaran asli\b/gi, 'saya hanya runtime berbasis memory')
    .trim()
}

export async function loadRuntimePolicies() {
  return fetchJson('/__entity-runtime/latest')
}

export async function startRuntimeSession(runtimeMode: RuntimeMode = 'read_only', sessionType: RuntimeSessionType = 'manual') {
  return fetchJson('/__entity-runtime/start-session', { runtimeMode, sessionType })
}

export async function endRuntimeSession(sessionId: string) {
  return fetchJson('/__entity-runtime/end-session', { sessionId })
}

export async function buildRuntimeContext() {
  return fetchJson('/__entity-runtime/latest')
}

export async function createActionProposal(question: string, dryRun = true) {
  return fetchJson('/__entity-runtime/check', { question, dryRun })
}

export async function logRuntimeEvent(question: string) {
  return fetchJson('/__entity-runtime/check', { question, dryRun: true })
}

export async function buildRuntimeSafetyReport(save = true) {
  return fetchJson('/__entity-runtime/audit', { save })
}

async function fetchJson(path: string, body?: Record<string, unknown>) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(payload?.error ?? 'Entity Runtime request failed.')
  return payload
}
