import { useCallback, useEffect, useMemo, useState } from 'react'

interface IdentityConflictsProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface IdentityConflict {
  id: string
  conflict_type: string
  title: string
  summary: string
  side_a_label: string
  side_a_statement: string
  side_a_evidence_refs: EvidenceRef[]
  side_a_confidence: number
  side_b_label: string
  side_b_statement: string
  side_b_evidence_refs: EvidenceRef[]
  side_b_confidence: number
  severity: string
  recurrence: string
  resolution_status: string
  impact_area: string
  chat_guidance: Record<string, unknown>
  last_seen_at: string
  created_at: string
}

interface EvidenceRef {
  type: string
  id: string
  label?: string
}

interface ConflictEvent {
  id: string
  identity_conflict_id: string
  event_type: string
  event_summary: string
  side_supported: string
  confidence_score: number
  created_at: string
}

interface ConflictReview {
  id: string
  identity_conflict_id: string
  review_status: string
  decision: string
  owner_note: string | null
  created_at: string
}

interface Summary {
  total?: number
  open?: number
  high_severity?: number
  core_tensions?: number
  review_needed?: number
  resolved_or_dismissed?: number
}

const STATUS_FILTERS = ['all', 'open', 'monitoring', 'needs_review', 'partially_resolved', 'resolved', 'dismissed']
const SEVERITY_FILTERS = ['all', 'low', 'medium', 'high', 'critical']
const TYPE_FILTERS = ['all', 'goal_vs_behavior', 'belief_vs_action', 'value_vs_decision', 'communication_mismatch', 'identity_tension', 'strategy_conflict', 'emotional_conflict', 'risk_pattern_conflict', 'autonomy_vs_fidelity', 'unknown']
const IMPACT_FILTERS = ['all', 'identity', 'communication', 'decision_making', 'strategy', 'emotion', 'project_execution', 'relationship', 'career', 'faith_or_values', 'unknown']

export function IdentityConflicts({ onNotify }: IdentityConflictsProps) {
  const [conflicts, setConflicts] = useState<IdentityConflict[]>([])
  const [events, setEvents] = useState<ConflictEvent[]>([])
  const [reviews, setReviews] = useState<ConflictReview[]>([])
  const [summary, setSummary] = useState<Summary>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState('all')
  const [severity, setSeverity] = useState('all')
  const [type, setType] = useState('all')
  const [impact, setImpact] = useState('all')
  const [ownerNote, setOwnerNote] = useState('')
  const [audit, setAudit] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/__identity-conflicts/latest')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca conflicts.')
      const rows = (payload.conflicts ?? []) as IdentityConflict[]
      setConflicts(rows)
      setEvents((payload.events ?? []) as ConflictEvent[])
      setReviews((payload.reviews ?? []) as ConflictReview[])
      setSummary((payload.summary ?? {}) as Summary)
      setSelectedId((current) => current ?? rows[0]?.id ?? null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca conflicts.'
      setError(message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const filtered = useMemo(() => conflicts.filter((item) =>
    (status === 'all' || item.resolution_status === status) &&
    (severity === 'all' || item.severity === severity) &&
    (type === 'all' || item.conflict_type === type) &&
    (impact === 'all' || item.impact_area === impact)
  ), [conflicts, status, severity, type, impact])

  const selected = useMemo(() => conflicts.find((item) => item.id === selectedId) ?? filtered[0] ?? null, [conflicts, filtered, selectedId])
  const selectedEvents = useMemo(() => events.filter((item) => item.identity_conflict_id === selected?.id), [events, selected])
  const selectedReviews = useMemo(() => reviews.filter((item) => item.identity_conflict_id === selected?.id), [reviews, selected])

  async function runAction(kind: string, url: string, body: Record<string, unknown>, success: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Conflict action gagal.')
      if (kind === 'audit') setAudit(payload)
      onNotify?.('success', success)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Conflict action gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  async function review(decision: string) {
    if (!selected) return
    await runAction(`review-${decision}`, '/__identity-conflicts/review', { conflictId: selected.id, decision, ownerNote }, 'Conflict review tersimpan.')
    setOwnerNote('')
  }

  return (
    <section className="calibration-view">
      <header className="backup-view__header">
        <div>
          <h2>Identity Conflicts</h2>
          <p>Kontradiksi manusia disimpan sebagai tension berbasis evidence, bukan bug yang dihapus otomatis.</p>
        </div>
        <div className="backup-actions">
          <button type="button" className="btn btn--primary" disabled={Boolean(busy)} onClick={() => void runAction('detect', '/__identity-conflicts/detect', { limit: 100, from: null, to: null }, 'Conflict detection selesai.')}>
            {busy === 'detect' ? 'Detecting...' : 'Detect Conflicts'}
          </button>
          <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('audit', '/__identity-conflicts/audit', { save: true }, 'Conflict audit selesai.')}>Run Audit</button>
          <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      <div className="routine-metrics">
        <Metric label="Total" value={String(summary.total ?? conflicts.length)} />
        <Metric label="Open" value={String(summary.open ?? 0)} />
        <Metric label="High" value={String(summary.high_severity ?? 0)} />
        <Metric label="Core" value={String(summary.core_tensions ?? 0)} />
        <Metric label="Review" value={String(summary.review_needed ?? 0)} />
        <Metric label="Resolved" value={String(summary.resolved_or_dismissed ?? 0)} />
      </div>

      <section className="backup-panel conflict-filters">
        <Select label="Status" value={status} options={STATUS_FILTERS} onChange={setStatus} />
        <Select label="Severity" value={severity} options={SEVERITY_FILTERS} onChange={setSeverity} />
        <Select label="Type" value={type} options={TYPE_FILTERS} onChange={setType} />
        <Select label="Impact" value={impact} options={IMPACT_FILTERS} onChange={setImpact} />
      </section>

      {audit && (
        <section className="backup-panel">
          <div className="evaluation-panel__title"><h3>Audit Result</h3></div>
          <details><summary>Audit JSON</summary><pre className="brain-answer__artifact">{JSON.stringify(audit, null, 2)}</pre></details>
        </section>
      )}

      <div className="conflict-layout">
        <section className="backup-panel conflict-list">
          <div className="evaluation-panel__title"><h3>Conflicts</h3><span>{filtered.length}</span></div>
          {filtered.length ? filtered.map((item) => (
            <button key={item.id} type="button" className={`conflict-list__item ${selected?.id === item.id ? 'conflict-list__item--active' : ''}`} onClick={() => setSelectedId(item.id)}>
              <strong>{item.title}</strong>
              <span>{item.severity} · {item.recurrence} · {item.resolution_status}</span>
              <small>{item.conflict_type} · {item.impact_area}</small>
            </button>
          )) : <p className="muted conflict-empty">Belum ada conflict sesuai filter.</p>}
        </section>

        <section className="backup-panel conflict-detail">
          {selected ? (
            <>
              <div className="evaluation-panel__title"><h3>{selected.title}</h3><span>{selected.resolution_status}</span></div>
              <p>{selected.summary}</p>
              <div className="conflict-sides">
                <Side title={selected.side_a_label} statement={selected.side_a_statement} confidence={selected.side_a_confidence} refs={selected.side_a_evidence_refs} />
                <Side title={selected.side_b_label} statement={selected.side_b_statement} confidence={selected.side_b_confidence} refs={selected.side_b_evidence_refs} />
              </div>
              <div className="conflict-meta">
                <span>{selected.conflict_type}</span>
                <span>{selected.severity}</span>
                <span>{selected.recurrence}</span>
                <span>{selected.impact_area}</span>
              </div>
              <section className="conflict-block">
                <h4>Chat Guidance</h4>
                <details><summary>Chat guidance JSON</summary><pre className="brain-answer__artifact">{JSON.stringify(selected.chat_guidance ?? {}, null, 2)}</pre></details>
              </section>
              <section className="conflict-block">
                <h4>Owner Note</h4>
                <textarea value={ownerNote} onChange={(event) => setOwnerNote(event.target.value.slice(0, 5000))} placeholder="Catatan review owner..." />
                <div className="backup-actions conflict-actions">
                  <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void review('mark_monitoring')}>Mark Monitoring</button>
                  <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void review('mark_resolved')}>Mark Resolved</button>
                  <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void review('dismiss')}>Dismiss</button>
                  <button type="button" className="btn btn--primary" disabled={Boolean(busy)} onClick={() => void review('needs_more_data')}>Needs More Data</button>
                </div>
              </section>
              <section className="conflict-block">
                <h4>Events</h4>
                {selectedEvents.length ? selectedEvents.map((event) => (
                  <div key={event.id} className="reflection-item">
                    <strong>{event.event_type}</strong>
                    <p>{event.event_summary}</p>
                    <span>{event.side_supported} · {Number(event.confidence_score ?? 0).toFixed(2)} · {new Date(event.created_at).toLocaleString()}</span>
                  </div>
                )) : <p className="muted">Belum ada event.</p>}
              </section>
              <section className="conflict-block">
                <h4>Reviews</h4>
                {selectedReviews.length ? selectedReviews.map((review) => (
                  <div key={review.id} className="reflection-item">
                    <strong>{review.decision}</strong>
                    <p>{review.owner_note || '-'}</p>
                    <span>{review.review_status} · {new Date(review.created_at).toLocaleString()}</span>
                  </div>
                )) : <p className="muted">Belum ada review.</p>}
              </section>
            </>
          ) : (
            <p className="muted conflict-empty">Pilih conflict untuk melihat detail.</p>
          )}
        </section>
      </div>
    </section>
  )
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="routine-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Side({ title, statement, confidence, refs }: { title: string; statement: string; confidence: number; refs: EvidenceRef[] }) {
  return (
    <article className="conflict-side">
      <h4>{title}</h4>
      <p>{statement}</p>
      <strong>{Number(confidence ?? 0).toFixed(2)}</strong>
      <ul>
        {(refs ?? []).slice(0, 5).map((ref) => <li key={`${ref.type}:${ref.id}`}>{ref.type}: {ref.label ?? ref.id}</li>)}
      </ul>
    </article>
  )
}
