import { useCallback, useEffect, useMemo, useState } from 'react'

interface LongTermMemoryProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface LongTermMemoryRow {
  id: string
  memory_type: string
  title: string
  summary: string | null
  canonical_statement: string
  evidence_refs: Array<Record<string, unknown>>
  related_identity_fact_ids: string[]
  related_communication_pattern_ids: string[]
  related_conflict_ids: string[]
  importance_score: number
  confidence_score: number
  stability: string
  freshness: string
  status: string
  last_seen_at: string | null
}

interface ReviewItem {
  id: string
  review_type: string
  title: string
  description: string | null
  suggested_action: string
  priority: string
  status: string
  risk_score: number
}

export function LongTermMemory({ onNotify }: LongTermMemoryProps) {
  const [memories, setMemories] = useState<LongTermMemoryRow[]>([])
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [health, setHealth] = useState<Record<string, number>>({})
  const [latestRun, setLatestRun] = useState<Record<string, unknown> | null>(null)
  const [latestSnapshot, setLatestSnapshot] = useState<Record<string, unknown> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [stabilityFilter, setStabilityFilter] = useState('all')
  const [freshnessFilter, setFreshnessFilter] = useState('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    const res = await fetch('/__memory-consolidation/latest')
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca Long-Term Memory.')
    setMemories((payload.long_term_memories ?? []) as LongTermMemoryRow[])
    setReviews((payload.review_queue ?? []) as ReviewItem[])
    setHealth((payload.memory_health ?? {}) as Record<string, number>)
    setLatestRun(payload.latest_run ?? null)
    setLatestSnapshot(payload.latest_snapshot ?? null)
    if (!selectedId && payload.long_term_memories?.[0]?.id) setSelectedId(payload.long_term_memories[0].id)
  }, [selectedId])

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : 'Gagal membaca Long-Term Memory.'))
  }, [refresh])

  const filtered = useMemo(() => memories.filter((memory) =>
    (typeFilter === 'all' || memory.memory_type === typeFilter)
    && (statusFilter === 'all' || memory.status === statusFilter)
    && (stabilityFilter === 'all' || memory.stability === stabilityFilter)
    && (freshnessFilter === 'all' || memory.freshness === freshnessFilter)
  ), [memories, typeFilter, statusFilter, stabilityFilter, freshnessFilter])
  const selected = memories.find((memory) => memory.id === selectedId) ?? filtered[0] ?? null
  const pendingReviews = reviews.filter((review) => review.status === 'pending')

  async function runAction(kind: string, path: string, body: Record<string, unknown>, success: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Long-Term Memory action gagal.')
      onNotify?.('success', success)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Long-Term Memory action gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  async function reviewItem(id: string, status: 'approved' | 'rejected' | 'ignored') {
    await runAction('review', '/__memory-consolidation/review', { reviewItemId: id, status, ownerNote: status === 'approved' ? 'Approved for manual follow-up. No destructive action.' : '' }, `Review ${status}.`)
  }

  return (
    <section className="memory-view">
      <header className="backup-view__header">
        <div>
          <h2>Long-Term Memory</h2>
          <p>Consolidated, evidence-bound memory layer. Tidak menghapus raw diary/chat/file dan tidak auto-merge/archive default.</p>
        </div>
        <div className="backup-actions">
          <button className="btn btn--primary" disabled={Boolean(busy)} onClick={() => void runAction('run', '/__memory-consolidation/run', { runType: 'manual', from: null, to: null, full: false, snapshot: true }, 'Consolidation selesai.')}>{busy === 'run' ? 'Running...' : 'Run Consolidation'}</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('full', '/__memory-consolidation/run', { runType: 'full', from: null, to: null, full: true, snapshot: true }, 'Full consolidation selesai.')}>Full Consolidation</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('snapshot', '/__memory-consolidation/snapshot', { snapshotType: 'manual' }, 'Snapshot dibuat.')}>Create Snapshot</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('audit', '/__memory-consolidation/audit', { save: true }, 'Audit selesai.')}>Audit</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      <section className="memory-health">
        <div><span>Total</span><strong>{health.total_long_term_memories ?? memories.length}</strong></div>
        <div><span>Core</span><strong>{health.core_memory_count ?? 0}</strong></div>
        <div><span>Active</span><strong>{health.active_memory_count ?? 0}</strong></div>
        <div><span>Stale</span><strong>{health.stale_candidate_count ?? 0}</strong></div>
        <div><span>Duplicate</span><strong>{health.duplicate_candidate_count ?? 0}</strong></div>
        <div><span>Review</span><strong>{health.review_queue_count ?? pendingReviews.length}</strong></div>
      </section>

      <div className="memory-meta-strip">
        <span>Latest run: {String(latestRun?.status ?? 'none')}</span>
        <span>Snapshot: {latestSnapshot ? String(latestSnapshot.title ?? latestSnapshot.id) : 'none'}</span>
      </div>

      <div className="memory-filters">
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">All types</option>{unique(memories.map((m) => m.memory_type)).map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All status</option>{unique(memories.map((m) => m.status)).map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <select value={stabilityFilter} onChange={(event) => setStabilityFilter(event.target.value)}><option value="all">All stability</option>{unique(memories.map((m) => m.stability)).map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <select value={freshnessFilter} onChange={(event) => setFreshnessFilter(event.target.value)}><option value="all">All freshness</option>{unique(memories.map((m) => m.freshness)).map((item) => <option key={item} value={item}>{item}</option>)}</select>
      </div>

      <div className="memory-layout">
        <section className="memory-panel">
          <div className="panel-heading"><h3>Memories</h3><span>{filtered.length} shown</span></div>
          <div className="memory-list">
            {filtered.map((memory) => (
              <button key={memory.id} className={`memory-row ${selected?.id === memory.id ? 'memory-row--active' : ''}`} onClick={() => setSelectedId(memory.id)}>
                <strong>{memory.title}</strong>
                <span>{memory.memory_type} · {memory.stability} · {memory.freshness}</span>
                <small>confidence {Number(memory.confidence_score ?? 0).toFixed(2)} · importance {Number(memory.importance_score ?? 0).toFixed(2)} · {memory.status}</small>
              </button>
            ))}
            {!filtered.length && <p className="muted memory-empty">Belum ada long-term memory.</p>}
          </div>
        </section>

        <section className="memory-panel memory-detail">
          <div className="panel-heading"><h3>Memory Detail</h3>{selected && <span>{selected.status}</span>}</div>
          {selected ? (
            <>
              <h4>{selected.title}</h4>
              <p>{selected.canonical_statement}</p>
              {selected.summary && <blockquote>{selected.summary}</blockquote>}
              <div className="memory-tags">
                <span>{selected.memory_type}</span><span>{selected.stability}</span><span>{selected.freshness}</span><span>{selected.status}</span>
              </div>
              <h4>Evidence refs</h4>
              <ul>{(selected.evidence_refs ?? []).slice(0, 8).map((ref, index) => <li key={`${String(ref.id)}-${index}`}>{String(ref.type ?? 'source')}: {String(ref.label ?? ref.id ?? 'unknown')}</li>)}</ul>
              <h4>Related</h4>
              <p className="muted">Identity {selected.related_identity_fact_ids?.length ?? 0} · Communication {selected.related_communication_pattern_ids?.length ?? 0} · Conflicts {selected.related_conflict_ids?.length ?? 0}</p>
            </>
          ) : <p className="muted memory-empty">Pilih memory untuk melihat detail.</p>}
        </section>
      </div>

      <section className="memory-panel">
        <div className="panel-heading"><h3>Review Queue</h3><span>{pendingReviews.length} pending</span></div>
        <div className="memory-review-grid">
          {reviews.slice(0, 80).map((item) => (
            <article key={item.id} className="memory-review-card">
              <strong>{item.title}</strong>
              <span>{item.review_type} · {item.priority} · risk {Number(item.risk_score ?? 0).toFixed(2)} · {item.status}</span>
              <p>{item.description}</p>
              <div className="runtime-actions">
                <button className="btn btn--primary" disabled={Boolean(busy) || item.status !== 'pending'} onClick={() => void reviewItem(item.id, 'approved')}>Approve</button>
                <button className="btn btn--ghost" disabled={Boolean(busy) || item.status !== 'pending'} onClick={() => void reviewItem(item.id, 'rejected')}>Reject</button>
                <button className="btn btn--ghost" disabled={Boolean(busy) || item.status !== 'pending'} onClick={() => void reviewItem(item.id, 'ignored')}>Ignore</button>
              </div>
            </article>
          ))}
          {!reviews.length && <p className="muted memory-empty">Review queue kosong.</p>}
        </div>
      </section>
    </section>
  )
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))].sort()
}
