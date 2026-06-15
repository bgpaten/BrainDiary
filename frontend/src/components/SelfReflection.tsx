import { useCallback, useEffect, useMemo, useState } from 'react'

interface SelfReflectionProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface EvidenceRef {
  type: string
  id: string
  label?: string
}

interface ReflectionItem {
  label?: string
  target_label?: string
  description?: string
  suggestion?: string
  suggestion_type?: string
  confidence_score?: number
  risk_score?: number
  needed_data?: string[]
  evidence_refs?: EvidenceRef[]
}

interface ReflectionLog {
  id: string
  reflection_type: string
  title: string
  summary: string
  status: string
  confidence_score: number
  new_observations: ReflectionItem[]
  strengthened_patterns: ReflectionItem[]
  weakened_patterns: ReflectionItem[]
  new_contradictions: ReflectionItem[]
  identity_implications: ReflectionItem[]
  communication_implications: ReflectionItem[]
  risk_implications: ReflectionItem[]
  uncertainties: ReflectionItem[]
  created_at: string
}

interface EvolutionSuggestion {
  id: string
  target_type: string
  target_id: string | null
  suggestion_type: string
  label: string
  description: string
  before_state: Record<string, unknown>
  after_state: Record<string, unknown>
  evidence_refs: EvidenceRef[]
  confidence_score: number
  risk_score: number
  status: string
  created_at: string
}

interface EntitySnapshot {
  id: string
  snapshot_type: string
  title: string
  summary: string
  evolution_score: number
  stability_score: number
  fidelity_risk_score: number
  status: string
  open_uncertainties: ReflectionItem[]
  active_boundaries: Array<{ label?: string; statement?: string }>
  created_at: string
}

const REFLECTION_TYPES = ['manual', 'daily', 'weekly', 'after_import', 'after_digest', 'after_calibration', 'after_similarity_eval']
const SUGGESTION_FILTERS = ['proposed', 'approved', 'rejected', 'applied', 'ignored'] as const

type SuggestionFilter = (typeof SUGGESTION_FILTERS)[number]

export function SelfReflection({ onNotify }: SelfReflectionProps) {
  const [reflection, setReflection] = useState<ReflectionLog | null>(null)
  const [suggestions, setSuggestions] = useState<EvolutionSuggestion[]>([])
  const [snapshot, setSnapshot] = useState<EntitySnapshot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reflectionType, setReflectionType] = useState('manual')
  const [filter, setFilter] = useState<SuggestionFilter>('proposed')
  const [audit, setAudit] = useState<Record<string, unknown> | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/__self-reflection/latest')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca Self-Reflection.')
      setReflection((payload.reflection ?? null) as ReflectionLog | null)
      setSuggestions((payload.suggestions ?? []) as EvolutionSuggestion[])
      setSnapshot((payload.snapshot ?? null) as EntitySnapshot | null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca Self-Reflection.'
      setError(message)
      onNotify?.('error', message)
    }
  }, [onNotify])

  useEffect(() => { void refresh() }, [refresh])

  const filteredSuggestions = useMemo(() => suggestions.filter((item) => item.status === filter), [suggestions, filter])
  const highRisk = useMemo(() => suggestions.filter((item) => Number(item.risk_score) > 0.75), [suggestions])

  async function runAction(kind: string, url: string, body: Record<string, unknown>, message: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Reflection action gagal.')
      onNotify?.('success', message)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Reflection action gagal.'
      setError(msg)
      onNotify?.('error', msg)
    } finally {
      setBusy(null)
    }
  }

  async function runAudit() {
    if (busy) return
    setBusy('audit')
    setError(null)
    try {
      // Audit dijalankan lewat endpoint run dengan tipe manual hanya untuk segarkan data;
      // hasil audit penuh tersedia via CLI `npm run reflection:audit`. Di UI cukup tampilkan ringkasan latest.
      const res = await fetch('/__self-reflection/latest')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Audit gagal.')
      setAudit(payload.suggestion_summary ?? {})
      onNotify?.('info', 'Ringkasan reflection diperbarui. Audit penuh: npm run reflection:audit.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Audit gagal.'
      setError(msg)
      onNotify?.('error', msg)
    } finally {
      setBusy(null)
    }
  }

  async function updateSuggestion(suggestionId: string, status: 'approved' | 'rejected' | 'ignored') {
    await runAction(`update-${suggestionId}`, '/__self-reflection/update-suggestion', { suggestionId, status }, `Suggestion ${status}.`)
  }

  return (
    <section className="calibration-view">
      <header className="backup-view__header">
        <div>
          <h2>Self-Reflection Memory Evolution</h2>
          <p>Refleksi berkala evidence-bound: apa arti data baru terhadap model diri owner. Saran perubahan bersifat proposal, bukan auto-apply.</p>
        </div>
        <div className="backup-actions">
          <label className="reflection-type">
            <select value={reflectionType} onChange={(e) => setReflectionType(e.target.value)}>
              {REFLECTION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <button className="btn btn--primary" type="button" disabled={Boolean(busy)} onClick={() => void runAction('run', '/__self-reflection/run', { type: reflectionType, from: null, to: null, snapshot: true }, 'Reflection selesai.')}>
            {busy === 'run' ? 'Reflecting...' : 'Run Reflection'}
          </button>
          <button className="btn btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void runAction('snapshot', '/__self-reflection/snapshot', { type: 'manual' }, 'Entity snapshot dibuat.')}>
            Create Snapshot
          </button>
          <button className="btn btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void runAudit()}>Audit</button>
          <button className="btn btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      <div className="routine-metrics">
        <Metric label="Reflection" value={reflection ? reflection.reflection_type : '-'} />
        <Metric label="Confidence" value={reflection ? num(reflection.confidence_score) : '-'} />
        <Metric label="Proposed" value={String(suggestions.filter((s) => s.status === 'proposed').length)} />
        <Metric label="High Risk" value={String(highRisk.length)} />
        <Metric label="Evolution" value={snapshot ? num(snapshot.evolution_score) : '-'} />
        <Metric label="Fidelity Risk" value={snapshot ? num(snapshot.fidelity_risk_score) : '-'} />
      </div>

      {audit && (
        <section className="backup-panel">
          <div className="evaluation-panel__title"><h3>Suggestion Summary</h3></div>
          <details><summary>Audit JSON</summary><pre className="brain-answer__artifact">{JSON.stringify(audit, null, 2)}</pre></details>
        </section>
      )}

      <section className="backup-panel">
        <div className="evaluation-panel__title"><h3>Latest Reflection</h3>{reflection && <span>{reflection.status}</span>}</div>
        {reflection ? (
          <>
            <h4>{reflection.title}</h4>
            <p>{reflection.summary}</p>
            <div className="reflection-sections">
              <ReflectionSection title="New Observations" items={reflection.new_observations} />
              <ReflectionSection title="Strengthened Patterns" items={reflection.strengthened_patterns} />
              <ReflectionSection title="Weakened Patterns" items={reflection.weakened_patterns} />
              <ReflectionSection title="Contradictions" items={reflection.new_contradictions} />
              <ReflectionSection title="Identity Implications" items={reflection.identity_implications} />
              <ReflectionSection title="Communication Implications" items={reflection.communication_implications} />
              <ReflectionSection title="Risk Implications" items={reflection.risk_implications} />
              <ReflectionSection title="Uncertainties" items={reflection.uncertainties} />
            </div>
          </>
        ) : (
          <p className="muted">Belum ada reflection. Klik Run Reflection.</p>
        )}
      </section>

      <section className="backup-panel">
        <div className="evaluation-panel__title">
          <h3>Evolution Suggestions</h3>
          <div className="reflection-filters">
            {SUGGESTION_FILTERS.map((value) => (
              <button key={value} type="button" className={`btn ${filter === value ? 'btn--primary' : 'btn--ghost'}`} onClick={() => setFilter(value)}>
                {value} ({suggestions.filter((s) => s.status === value).length})
              </button>
            ))}
          </div>
        </div>
        <div className="calibration-results">
          {filteredSuggestions.map((item) => (
            <article key={item.id} className={Number(item.risk_score) > 0.75 ? 'calibration-result' : 'calibration-result calibration-result--pass'}>
              <div className="evaluation-panel__title">
                <h4>{item.label}</h4>
                <span>{Number(item.risk_score) > 0.75 ? 'HIGH RISK' : ''} conf {num(item.confidence_score)} · risk {num(item.risk_score)}</span>
              </div>
              <p>{item.description}</p>
              <div className="brain-answer__meta">
                <span>{item.target_type}</span>
                <span>{item.suggestion_type}</span>
                <span>evidence {Array.isArray(item.evidence_refs) ? item.evidence_refs.length : 0}</span>
                <span>{item.status}</span>
              </div>
              {Array.isArray(item.evidence_refs) && item.evidence_refs.length > 0 && (
                <details>
                  <summary>Evidence & before/after</summary>
                  <pre className="brain-answer__artifact">{JSON.stringify({ before_state: item.before_state, after_state: item.after_state, evidence_refs: item.evidence_refs }, null, 2)}</pre>
                </details>
              )}
              {item.status === 'proposed' && (
                <div className="backup-actions">
                  <button className="btn btn--primary" type="button" disabled={Boolean(busy)} onClick={() => void updateSuggestion(item.id, 'approved')}>Approve</button>
                  <button className="btn btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void updateSuggestion(item.id, 'rejected')}>Reject</button>
                  <button className="btn btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void updateSuggestion(item.id, 'ignored')}>Ignore</button>
                </div>
              )}
            </article>
          ))}
          {filteredSuggestions.length === 0 && <p className="muted">Tidak ada suggestion dengan status {filter}.</p>}
        </div>
        <p className="muted">Approve/reject hanya mengubah status suggestion. Identity facts & communication patterns TIDAK diubah otomatis.</p>
      </section>

      {snapshot && (
        <section className="backup-panel">
          <div className="evaluation-panel__title"><h3>Entity Evolution Snapshot</h3><span>{snapshot.status}</span></div>
          <p>{snapshot.summary}</p>
          <div className="routine-metrics">
            <Metric label="Evolution" value={num(snapshot.evolution_score)} />
            <Metric label="Stability" value={num(snapshot.stability_score)} />
            <Metric label="Fidelity Risk" value={num(snapshot.fidelity_risk_score)} />
          </div>
        </section>
      )}
    </section>
  )
}

function ReflectionSection({ title, items }: { title: string; items: ReflectionItem[] }) {
  const list = Array.isArray(items) ? items : []
  return (
    <div className="reflection-section">
      <h5>{title} ({list.length})</h5>
      {list.length === 0 ? (
        <p className="muted">Belum cukup data.</p>
      ) : (
        <ul>
          {list.slice(0, 8).map((item, index) => (
            <li key={index}>
              <strong>{item.label || item.target_label}</strong>
              {item.description ? `: ${item.description}` : ''}
              {item.risk_score !== undefined ? ` (risk ${num(item.risk_score)})` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="routine-metric"><span>{label}</span><strong>{value}</strong></div>
}

function num(value: unknown): string {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n.toFixed(2) : '-'
}
