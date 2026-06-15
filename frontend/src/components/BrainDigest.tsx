import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { BrainReport, BrainReportType } from '../types/brain'

const REPORT_COLUMNS =
  'id,user_id,report_type,period_start,period_end,title,summary,content,highlights,active_projects,repeated_patterns,decisions,risks,suggested_next_actions,source_refs,model_provider,model_name,status,metadata,created_at,updated_at'

interface BrainDigestProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

export function BrainDigest({ onNotify }: BrainDigestProps) {
  const [reports, setReports] = useState<BrainReport[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<BrainReportType | 'all'>('all')
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState<BrainReportType | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchReports = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: fetchError } = await supabase
      .from('brain_reports')
      .select(REPORT_COLUMNS)
      .order('period_end', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(30)
    setLoading(false)
    if (fetchError) {
      setError(fetchError.message)
      return
    }
    const next = (data ?? []) as BrainReport[]
    setReports(next)
    setSelectedId((current) => current ?? next[0]?.id ?? null)
  }, [])

  useEffect(() => {
    void fetchReports()
  }, [fetchReports])

  const visibleReports = useMemo(
    () => reports.filter((report) => filter === 'all' || report.report_type === filter),
    [reports, filter],
  )
  const selected = reports.find((report) => report.id === selectedId) ?? visibleReports[0] ?? null

  async function generate(type: BrainReportType) {
    setGenerating(type)
    setError(null)
    onNotify?.('info', `Generating ${type} brain digest...`)
    try {
      const res = await fetch('/__brain-digest/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, force: true }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Generate digest gagal.')
      onNotify?.('success', payload?.title ?? `${type} digest generated.`)
      await fetchReports()
      if (payload?.report_id) setSelectedId(payload.report_id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generate digest gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setGenerating(null)
    }
  }

  return (
    <section className="digest-view">
      <div className="digest-view__header">
        <div>
          <h2>Brain Digest</h2>
          <p>Daily, weekly, dan monthly report dari structured brain. Digest tidak mengubah node atau edge.</p>
        </div>
        <div className="digest-actions">
          <button type="button" className="btn btn--ghost" onClick={() => void fetchReports()} disabled={loading || Boolean(generating)}>
            Refresh
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void generate('daily')} disabled={Boolean(generating)}>
            {generating === 'daily' ? 'Generating...' : 'Generate Today'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void generate('weekly')} disabled={Boolean(generating)}>
            {generating === 'weekly' ? 'Generating...' : 'Generate This Week'}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void generate('monthly')} disabled={Boolean(generating)}>
            {generating === 'monthly' ? 'Generating...' : 'Generate This Month'}
          </button>
        </div>
      </div>

      <div className="digest-layout">
        <aside className="digest-list">
          <div className="digest-filter">
            {(['all', 'daily', 'weekly', 'monthly'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={`chip ${filter === item ? 'chip--active' : ''}`}
                onClick={() => setFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>
          {loading && <p className="muted">Memuat report...</p>}
          {error && <p className="status status--err">{error}</p>}
          {!loading && visibleReports.length === 0 && (
            <div className="digest-empty">
              <h3>Belum ada digest</h3>
              <p>Generate report pertama dari tombol di atas setelah migration `brain_reports` dijalankan.</p>
            </div>
          )}
          {visibleReports.map((report) => (
            <button
              key={report.id}
              type="button"
              className={`digest-list__item ${selected?.id === report.id ? 'digest-list__item--active' : ''}`}
              onClick={() => setSelectedId(report.id)}
            >
              <span>{report.report_type}</span>
              <strong>{report.title}</strong>
              <small>{report.period_start} - {report.period_end}</small>
            </button>
          ))}
        </aside>

        <main className="digest-detail">
          {selected ? <DigestDetail report={selected} /> : <p className="muted">Pilih atau generate digest.</p>}
        </main>
      </div>
    </section>
  )
}

function DigestDetail({ report }: { report: BrainReport }) {
  const memoryQuality = (report.metadata?.memory_quality ?? {}) as Record<string, unknown>
  return (
    <article className="digest-report">
      <div className="digest-report__top">
        <div>
          <span className="review-status">{report.report_type}</span>
          <h2>{report.title}</h2>
          <p>{report.period_start} - {report.period_end}</p>
        </div>
        <div className="brain-answer__meta">
          <span>{report.status}</span>
          <span>{report.model_provider ?? 'provider unknown'}</span>
        </div>
      </div>

      <section>
        <h3>Summary</h3>
        <p>{report.summary || 'Belum ada summary.'}</p>
      </section>

      <ReportObjects title="Highlights" items={report.highlights} primaryKey="title" secondaryKey="description" />
      <ReportObjects title="Active Projects" items={report.active_projects} primaryKey="name" secondaryKey="evidence" tertiaryKey="risk" />
      <ReportObjects title="Repeated Patterns" items={report.repeated_patterns} primaryKey="name" secondaryKey="evidence" tertiaryKey="recommendation" />
      <ReportObjects title="Decisions" items={report.decisions} primaryKey="decision" secondaryKey="impact" />
      <ReportObjects title="Risks" items={report.risks} primaryKey="risk" secondaryKey="mitigation" />

      <section>
        <h3>Suggested Next Actions</h3>
        <ul>
          {report.suggested_next_actions?.length ? report.suggested_next_actions.map((item) => <li key={item}>{item}</li>) : <li>Tidak ada next action kuat.</li>}
        </ul>
      </section>

      <section>
        <h3>Memory Quality</h3>
        <div className="brain-answer__meta">
          <span>Low nodes: {String(memoryQuality.low_confidence_nodes ?? 0)}</span>
          <span>Low edges: {String(memoryQuality.low_confidence_edges ?? 0)}</span>
          <span>Failed entries: {String(memoryQuality.failed_entries ?? 0)}</span>
        </div>
        {Array.isArray(memoryQuality.warnings) && memoryQuality.warnings.length > 0 && (
          <ul>
            {memoryQuality.warnings.map((warning) => <li key={String(warning)}>{String(warning)}</li>)}
          </ul>
        )}
      </section>

      <ReportObjects title="Sources" items={report.source_refs} primaryKey="label" secondaryKey="type" />
    </article>
  )
}

function ReportObjects({
  title,
  items,
  primaryKey,
  secondaryKey,
  tertiaryKey,
}: {
  title: string
  items: Array<Record<string, unknown>>
  primaryKey: string
  secondaryKey?: string
  tertiaryKey?: string
}) {
  return (
    <section>
      <h3>{title}</h3>
      <div className="digest-card-list">
        {items?.length ? items.map((item, index) => {
          const secondary = secondaryKey ? item[secondaryKey] : null
          const tertiary = tertiaryKey ? item[tertiaryKey] : null
          return (
            <div key={`${title}-${index}`} className="digest-card">
              <strong>{String(item[primaryKey] ?? item.title ?? 'Untitled')}</strong>
              {secondary ? <p>{String(secondary)}</p> : null}
              {tertiary ? <small>{String(tertiary)}</small> : null}
            </div>
          )
        }) : <p className="muted">Tidak ada data kuat.</p>}
      </div>
    </section>
  )
}
