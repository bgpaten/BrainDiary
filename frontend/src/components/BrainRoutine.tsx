import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { BrainHealthCheckResult, BrainRoutineRun, BrainRoutineStep } from '../types/brain'

interface BrainRoutineProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

type BusyState = 'routine' | 'health' | null

export function BrainRoutine({ onNotify }: BrainRoutineProps) {
  const [runs, setRuns] = useState<BrainRoutineRun[]>([])
  const [health, setHealth] = useState<BrainHealthCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState<string | null>(null)
  const [includeAttachments, setIncludeAttachments] = useState(true)
  const [includeEvaluation, setIncludeEvaluation] = useState(true)
  const [includeSync, setIncludeSync] = useState(true)
  const [dryRun, setDryRun] = useState(false)

  const latest = runs[0] ?? null
  const metrics = useMemo(() => latest?.metrics ?? {}, [latest])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: runError } = await supabase
        .from('brain_routine_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10)
      if (runError) throw runError
      setRuns((data ?? []) as BrainRoutineRun[])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca routine data.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runRoutine = async () => {
    if (busy) return
    setBusy('routine')
    setError(null)
    onNotify?.('info', dryRun ? 'Daily Routine dry-run berjalan...' : 'Daily Routine berjalan...')
    try {
      const res = await fetch('/__brain-routine/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'daily',
          skipEval: !includeEvaluation,
          skipAttachments: !includeAttachments,
          skipSync: !includeSync,
          dryRun,
          limit: 5,
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.stdout ?? 'Daily Brain Routine gagal.')
      onNotify?.('success', dryRun ? 'Dry-run selesai.' : `Routine selesai: ${payload?.status ?? 'done'}.`)
      if (!dryRun) await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Daily Brain Routine gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  const runHealth = async () => {
    if (busy) return
    setBusy('health')
    setError(null)
    onNotify?.('info', 'Brain Health Check berjalan...')
    try {
      const res = await fetch('/__brain-routine/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ save: true }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.stdout ?? 'Brain Health Check gagal.')
      setHealth(payload as BrainHealthCheckResult)
      onNotify?.(payload.status === 'critical' ? 'error' : payload.status === 'warning' ? 'info' : 'success', `Health: ${payload.status} (${payload.score}/100).`)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Brain Health Check gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="routine-view">
      <header className="routine-view__header">
        <div>
          <h2>Daily Brain Routine</h2>
          <p>Workflow harian lokal untuk import, processing, indexing, sync, digest, persona refresh, dan lightweight evaluation.</p>
        </div>
        <div className="routine-actions">
          <button type="button" className="btn btn--primary" onClick={() => void runRoutine()} disabled={Boolean(busy)}>
            {busy === 'routine' ? 'Running...' : 'Run Daily Routine'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void runHealth()} disabled={Boolean(busy)}>
            {busy === 'health' ? 'Checking...' : 'Run Health Check'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void refresh()} disabled={loading || Boolean(busy)}>
            Refresh
          </button>
        </div>
      </header>

      <div className="routine-options">
        <Toggle label="Include attachments" checked={includeAttachments} onChange={setIncludeAttachments} />
        <Toggle label="Include evaluation" checked={includeEvaluation} onChange={setIncludeEvaluation} />
        <Toggle label="Include sync" checked={includeSync} onChange={setIncludeSync} />
        <Toggle label="Dry run" checked={dryRun} onChange={setDryRun} />
      </div>

      {error && <div className="evaluation-alert">{error}</div>}

      {health && (
        <div className={`routine-health routine-health--${health.status}`}>
          <strong>Health {health.status}</strong>
          <span>{health.score}/100</span>
          <small>{health.warnings.length} warnings, {health.errors.length} errors</small>
        </div>
      )}

      {!latest ? (
        <div className="evaluation-empty">
          <h3>Belum ada routine run</h3>
          <p>Jalankan health check atau daily routine dari dev server lokal.</p>
        </div>
      ) : (
        <>
          <div className="routine-summary">
            <MetricCard label="Status" value={latest.status} />
            <MetricCard label="Duration" value={formatDuration(latest.duration_ms)} />
            <MetricCard label="Pending Raw" value={metricValue(metrics, 'after.raw_entries_pending')} />
            <MetricCard label="Failed Raw" value={metricValue(metrics, 'after.raw_entries_failed')} />
            <MetricCard label="Low Nodes" value={metricValue(metrics, 'after.low_confidence_node_count')} />
            <MetricCard label="Eval Score" value={percent(metricValue(metrics, 'after.latest_eval.average_score'))} />
          </div>

          <div className="routine-grid">
            <div className="routine-panel">
              <div className="evaluation-panel__title">
                <h3>Step Status</h3>
                <span>{latest.steps?.length ?? 0}</span>
              </div>
              <div className="routine-step-list">
                {(latest.steps ?? []).map((step) => <StepRow key={step.name} step={step} />)}
              </div>
            </div>

            <div className="routine-panel">
              <div className="evaluation-panel__title">
                <h3>Warnings / Errors</h3>
                <span>{(latest.warnings?.length ?? 0) + (latest.errors?.length ?? 0)}</span>
              </div>
              <ListBlock title="Warnings" items={latest.warnings ?? []} />
              <ListBlock title="Errors" items={latest.errors ?? []} />
              <DetailBlock label="Summary" value={latest.summary ?? '-'} />
            </div>
          </div>

          <div className="routine-panel routine-metrics">
            <div className="evaluation-panel__title">
              <h3>Metrics</h3>
              <span>{latest.routine_type}</span>
            </div>
            <details><summary>Metrics JSON</summary><pre>{JSON.stringify(latest.metrics ?? {}, null, 2)}</pre></details>
          </div>

          <div className="routine-panel">
            <div className="evaluation-panel__title">
              <h3>History</h3>
              <span>{runs.length}</span>
            </div>
            <div className="routine-history">
              {runs.map((run) => (
                <div key={run.id} className="routine-history__item">
                  <span className={`routine-status routine-status--${run.status}`}>{run.status}</span>
                  <strong>{run.routine_type}</strong>
                  <small>{formatDate(run.created_at)}</small>
                  <small>{formatDuration(run.duration_ms)}</small>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="routine-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function StepRow({ step }: { step: BrainRoutineStep }) {
  return (
    <div className="routine-step">
      <span className={`routine-status routine-status--${step.status}`}>{step.status}</span>
      <div>
        <strong>{step.label}</strong>
        <small>{formatDuration(step.duration_ms)}</small>
        {step.error && <p>{step.error}</p>}
      </div>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="evaluation-score-card">
      <span>{label}</span>
      <strong>{String(value ?? '-')}</strong>
    </div>
  )
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="routine-list-block">
      <span>{title}</span>
      {items.length ? items.map((item) => <p key={item}>{item}</p>) : <p>-</p>}
    </div>
  )
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="evaluation-detail-block">
      <span>{label}</span>
      <p className="evaluation-detail-block--multiline">{value}</p>
    </div>
  )
}

function metricValue(metrics: Record<string, unknown>, path: string) {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && key in value) return (value as Record<string, unknown>)[key]
    return null
  }, metrics)
}

function percent(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '-'
  return `${Math.round(number * 100)}%`
}

function formatDuration(value: number | null | undefined) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number <= 0) return '-'
  if (number < 1000) return `${number}ms`
  return `${Math.round(number / 1000)}s`
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}
