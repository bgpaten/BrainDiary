// Tipe domain yang mencerminkan schema Supabase (Fase 3).
// Hanya kolom yang dibaca frontend (lihat task Fase 4).

export type NodeType =
  | 'person'
  | 'place'
  | 'event'
  | 'project'
  | 'decision'
  | 'emotion'
  | 'goal'
  | 'pattern'
  | 'organization'
  | 'topic'
  | 'tool'
  | 'document'

// Urutan tampil di filter toolbar.
export const NODE_TYPES: NodeType[] = [
  'person',
  'project',
  'tool',
  'topic',
  'pattern',
  'goal',
  'organization',
  'place',
  'event',
  'decision',
  'emotion',
  'document',
]

export interface BrainNode {
  id: string
  type: NodeType
  name: string
  canonical_name: string
  aliases: string[] | null
  summary: string | null
  description: string | null
  importance_score: number | null
  frequency_score: number | null
  confidence_score: number | null
  cluster_id: string | null
  first_seen_at: string | null
  last_seen_at: string | null
  metadata: Record<string, unknown> | null
}

export interface BrainEdge {
  id: string
  from_node_id: string
  to_node_id: string
  relation_type: string
  summary: string | null
  weight: number | null
  confidence_score: number | null
  valid_at: string | null
  invalid_at: string | null
  metadata: Record<string, unknown> | null
}

export interface AgentMemory {
  id: string
  memory_type: string
  content: string
  importance_level: string | null
  stability: string | null
  sensitivity: string | null
  source_entry_id: string | null
  source_node_id?: string | null
  valid_from?: string | null
  valid_until?: string | null
  created_at: string | null
  updated_at?: string | null
}

export interface BrainCluster {
  id: string
  name: string
  slug: string
  description: string | null
  color_key: string | null
  priority: number | null
}

export interface BrainData {
  nodes: BrainNode[]
  edges: BrainEdge[]
  clusters: BrainCluster[]
}

export interface RawEntryReview {
  id: string
  title: string | null
  content: string | null
  processing_status: string | null
  created_at: string | null
}

export interface ExtractionJobReview {
  id: string
  raw_entry_id: string | null
  status: string | null
  error_message: string | null
  created_at: string | null
  finished_at: string | null
}

export type BrainReportType = 'daily' | 'weekly' | 'monthly' | 'custom'

export interface BrainReport {
  id: string
  user_id: string
  report_type: BrainReportType
  period_start: string
  period_end: string
  title: string
  summary: string | null
  content: string | null
  highlights: Array<Record<string, unknown>>
  active_projects: Array<Record<string, unknown>>
  repeated_patterns: Array<Record<string, unknown>>
  decisions: Array<Record<string, unknown>>
  risks: Array<Record<string, unknown>>
  suggested_next_actions: string[]
  source_refs: Array<Record<string, unknown>>
  model_provider: string | null
  model_name: string | null
  status: 'draft' | 'done' | 'failed'
  metadata: Record<string, unknown> | null
  created_at: string | null
  updated_at: string | null
}

export type PersonaMode =
  | 'factual_brain_reader'
  | 'social_response'
  | 'self_clone_reflection'
  | 'strategic_mirror'
  | 'diary_owner_voice'
  | 'contradiction_detector'
  | 'planning_guard'
  | 'unknown_or_insufficient_memory'

export interface PersonaRouteResult {
  mode: PersonaMode
  reason: string
  confidence: number
}

export interface PersonaProfile {
  identity_summary: string
  active_projects: string[]
  goals: string[]
  decision_patterns: string[]
  repeated_patterns: string[]
  communication_style: string[]
  risk_patterns: string[]
  ambition_signals: string[]
  values_principles_inferred: string[]
  current_constraints: string[]
  confidence_warnings: string[]
  last_updated: string
}

export interface BrainChatPersonaMeta {
  persona_mode: PersonaMode
  persona_reason: string
  persona_confidence: number
  persona_profile_used: boolean
  style_warnings: string[]
}

export interface RawEntryTimelineItem {
  id: string
  title: string | null
  content: string | null
  source_origin: string | null
  source_type: string | null
  happened_at: string | null
  processing_status: string | null
  obsidian_path: string | null
  created_at: string | null
}

export interface BrainChatSource {
  type: 'brain_node' | 'brain_edge' | 'agent_memory' | 'raw_entry' | 'brain_cluster' | 'identity_fact' | 'identity_snapshot' | 'long_term_memory'
  id: string
  label: string
  excerpt?: string
}

export interface BrainChatResponse {
  ok: boolean
  answer: string
  confidence: number | null
  intent_type?: string
  inference_mode?: string
  inference_scores?: {
    fidelity_score: number
    groundedness_score: number
    style_match_score: number
    overclaim_risk: number
    underfit_risk: number
  }
  response_inference_log_id?: string | null
  owner_calibration_used?: boolean
  owner_calibration_hint_ids?: string[]
  owner_similarity_baseline?: number | null
  drift_guard?: {
    enabled: boolean
    risk_level: 'safe' | 'warning' | 'high' | 'critical'
    final_risk_score: number
    triggered_rules: string[]
    actions: string[]
    blocked: boolean
    fallback_used: boolean
    warnings: string[]
  }
  entity_runtime?: {
    enabled: boolean
    runtime_mode?: string
    runtime_session_id?: string | null
    boundary_checked?: boolean
    action_detected?: boolean
    action_blocked?: boolean
    proposal_created?: boolean
    proposal_id?: string | null
    proposal_title?: string | null
    required_approval_level?: string | null
    policy_warnings?: string[]
    runtime_risk_score?: number
    readiness_level?: string | null
  }
  persona_mode?: PersonaMode
  persona_reason?: string
  persona_confidence?: number | null
  basis: string[]
  sources: BrainChatSource[]
  missing_context: string[]
  suggested_next_actions: string[]
  style_warnings?: string[]
  warnings?: string[]
  communication_style_used?: boolean
  communication_pattern_ids?: string[]
  communication_intent?: string
  long_term_memory_used?: boolean
  long_term_memory_ids?: string[]
  memory_freshness_warnings?: string[]
  memory_consolidation_snapshot_id?: string | null
  response_shape?: Record<string, unknown> | null
  debug?: {
    retrieved_nodes: number
    retrieved_edges: number
    retrieved_memories: number
    retrieved_raw_entries: number
    retrieval_methods?: string[]
    semantic_enabled?: boolean
    semantic_hits?: number
    keyword_hits?: number
    semantic_warnings?: string[]
    provider?: string
    persona_profile_used?: boolean
    identity_facts_used?: number
    identity_snapshot_used?: string | null
    identity_confidence_warnings?: string[]
    intent_type?: string
    inference_mode?: string
    inference_scores?: {
      confidence_score: number
      fidelity_score: number
      groundedness_score: number
      style_match_score: number
      overclaim_risk: number
      underfit_risk: number
    }
    response_inference_log_id?: string | null
    owner_calibration_used?: boolean
    owner_calibration_hint_ids?: string[]
    owner_similarity_baseline?: number | null
    owner_calibration_hints?: Array<Record<string, unknown>>
    drift_guard?: Record<string, unknown>
    identity_fact_ids?: string[]
    memory_refs?: Array<Record<string, unknown>>
    retrieval_summary?: Record<string, unknown>
    inference_trace?: Record<string, unknown>
    is_social_greeting?: boolean
    response_policy?: Record<string, unknown>
    warnings_hidden_from_user?: string[]
    communication_style_used?: boolean
    communication_pattern_ids?: string[]
    communication_intent?: string
    long_term_memory_used?: boolean
    long_term_memories?: Array<Record<string, unknown>>
    long_term_memory_ids?: string[]
    memory_freshness_warnings?: string[]
    memory_consolidation_snapshot_id?: string | null
    response_shape?: Record<string, unknown> | null
    entity_runtime?: Record<string, unknown>
  }
}

export type BrainEvalCaseType =
  | 'factual'
  | 'persona_mode'
  | 'source_grounding'
  | 'insufficient_memory'
  | 'contradiction'
  | 'strategy'
  | 'semantic_retrieval'
  | 'timeline'
  | 'digest'

export interface BrainEvalRun {
  id: string
  user_id: string
  title: string
  status: 'pending' | 'running' | 'done' | 'failed'
  total_cases: number
  passed_cases: number
  failed_cases: number
  average_score: number
  retrieval_accuracy: number
  source_accuracy: number
  groundedness_score: number
  hallucination_risk: number
  persona_mode_accuracy: number
  insufficient_memory_score: number
  answer_usefulness: number
  started_at: string | null
  finished_at: string | null
  metadata: Record<string, unknown> | null
  created_at: string | null
  updated_at: string | null
}

export interface BrainEvalScores {
  retrieval_accuracy?: number
  source_accuracy?: number
  groundedness?: number
  hallucination_risk?: number
  persona_mode_accuracy?: number
  insufficient_memory_handling?: number
  answer_usefulness?: number
  average_score?: number
  [key: string]: unknown
}

export interface BrainEvalResult {
  id: string
  user_id: string
  eval_run_id: string
  eval_case_id: string | null
  question: string
  answer: string | null
  expected_mode: PersonaMode | string | null
  actual_mode: PersonaMode | string | null
  sources: Array<Record<string, unknown>>
  scores: BrainEvalScores
  passed: boolean
  failure_reason: string | null
  judge_feedback: string | null
  raw_response: Record<string, unknown> | null
  created_at: string | null
}

export type BrainRoutineStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed'
export type BrainRoutineType = 'daily' | 'manual' | 'health_check'
export type BrainRoutineStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface BrainRoutineStep {
  name: string
  label: string
  status: BrainRoutineStepStatus
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  stdout_excerpt: string
  error: string | null
}

export interface BrainRoutineRun {
  id: string
  user_id: string
  routine_type: BrainRoutineType
  status: BrainRoutineStatus
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  summary: string | null
  steps: BrainRoutineStep[]
  metrics: Record<string, unknown>
  warnings: string[]
  errors: string[]
  metadata: Record<string, unknown> | null
  created_at: string | null
  updated_at: string | null
}

export interface BrainHealthCheckResult {
  id?: string
  user_id?: string
  status: 'healthy' | 'warning' | 'critical'
  score: number
  checks: Array<Record<string, unknown>>
  metrics?: Record<string, unknown>
  warnings: string[]
  errors: string[]
  recommended_fixes?: string[]
  created_at?: string | null
}

export interface BrainBackupManifest {
  backup_id: string
  created_at: string
  app_name: string
  backup_version: string
  user_id: string
  included_tables: string[]
  table_row_counts: Record<string, number>
  missing_tables: string[]
  obsidian_vault_included: boolean
  obsidian_file_count: number
  total_size_bytes: number
  checksum: string | null
  warnings: string[]
  errors: string[]
  restore_notes: string[]
}

export interface BrainBackupListItem {
  backup_id: string
  path: string
  created_at: string | null
  table_row_counts: Record<string, number>
  obsidian_file_count: number
  warnings: string[]
  errors: string[]
  total_size_bytes: number
}

export interface BrainRestorePreview {
  ok: boolean
  status: 'ready' | 'warning' | 'critical'
  backup_id: string
  manifest: BrainBackupManifest
  tables: Record<string, { backup_rows: number; current_rows: number | null; action: string }>
  warnings: string[]
  errors: string[]
  restore_notes: string[]
}

export interface BrainRecoveryCheck {
  ok: boolean
  status: 'healthy' | 'warning' | 'critical'
  score: number
  issues: Array<{ severity: string; code: string; message: string; count: number }>
  recommended_fixes: string[]
  created_at: string
}

// Payload insert ke raw_entries dari Quick Diary Input.
// CATATAN: tidak pernah menyentuh brain_nodes / brain_edges.
export interface RawEntryInsert {
  user_id: string
  source_type: 'text'
  source_origin: 'react_input'
  title: string
  content: string
  happened_at: string
  processed: false
  processing_status: 'pending'
}
