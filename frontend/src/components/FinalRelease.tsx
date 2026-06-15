import { useCallback, useEffect, useMemo, useState } from 'react'

interface FinalReleaseProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface ReleaseRun {
  id: string
  release_version: string
  status: string
  release_type: string
  overall_score: number | null
  readiness_level: string | null
  release_decision: string | null
  blocker_count: number | null
  warning_count: number | null
  passed_check_count: number | null
  failed_check_count: number | null
  summary: string | null
}

interface ReleaseCheck {
  id: string
  check_category: string
  check_name: string
  description: string
  status: string
  severity: string
  score: number
  expected: string | null
  actual: string | null
  recommended_fix: string | null
}

interface ReleaseArtifact {
  id: string
  artifact_type: string
  title: string
  path: string | null
  description: string | null
  status: string
}

interface ReleaseNotes {
  id: string
  version: string
  title: string
  summary: string | null
  known_limitations: string[]
  safety_boundaries: string[]
  daily_usage_instructions: string[]
  recommended_next_steps: string[]
}

const CATEGORIES = [
  'environment', 'database', 'migration', 'security', 'frontend', 'scripts', 'obsidian', 'backup',
  'brain_data', 'identity', 'communication', 'response_inference', 'calibration', 'similarity',
  'drift', 'reflection', 'chat_samples', 'conflicts', 'self_clone_eval', 'runtime',
  'long_term_memory', 'documentation', 'release',
]

export function FinalRelease({ onNotify }: FinalReleaseProps) {
  const [latestRun, setLatestRun] = useState<ReleaseRun | null>(null)
  const [checks, setChecks] = useState<ReleaseCheck[]>([])
  const [artifacts, setArtifacts] = useState<ReleaseArtifact[]>([])
  const [notes, setNotes] = useState<ReleaseNotes | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState('all')

  const refresh = useCallback(async () => {
    setError(null)
    const res = await fetch('/__final-release/latest')
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca final release.')
    setLatestRun(payload.latest_run ?? null)
    setChecks((payload.checks ?? []) as ReleaseCheck[])
    setArtifacts((payload.artifacts ?? []) as ReleaseArtifact[])
    setNotes(payload.release_notes ?? null)
  }, [])

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : 'Gagal membaca final release.'))
  }, [refresh])

  const blockers = useMemo(() => checks.filter((check) => ['blocked', 'failed'].includes(check.status) && ['critical', 'high'].includes(check.severity)), [checks])
  const warnings = useMemo(() => checks.filter((check) => check.status === 'warning'), [checks])
  const filteredChecks = useMemo(() => checks.filter((check) => category === 'all' || check.check_category === category), [checks, category])

  async function runAction(kind: string, path: string, body: Record<string, unknown>, success: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Final release action gagal.')
      onNotify?.('success', success)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Final release action gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="final-release-view">
      <header className="backup-view__header">
        <div>
          <h2>Final Release</h2>
          <p>Final daily-use gate untuk build, security, runtime boundary, backup, self-clone eval, memory, dan dokumentasi.</p>
        </div>
        <div className="backup-actions">
          <button className="btn btn--primary" disabled={Boolean(busy)} onClick={() => void runAction('check', '/__final-release/check', { releaseType: 'release_candidate' }, 'Release check selesai.')}>{busy === 'check' ? 'Running...' : 'Run Release Check'}</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('final', '/__final-release/final', { version: latestRun?.release_version ?? '1.0.0' }, 'Final release run selesai.')}>Run Final Release</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('notes', '/__final-release/notes', { version: latestRun?.release_version ?? '1.0.0' }, 'Release notes dibuat.')}>Generate Release Notes</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      <section className="release-status-grid">
        <div><span>Version</span><strong>{latestRun?.release_version ?? 'none'}</strong></div>
        <div><span>Score</span><strong>{Number(latestRun?.overall_score ?? 0).toFixed(1)}</strong></div>
        <div><span>Readiness</span><strong>{latestRun?.readiness_level ?? 'not evaluated'}</strong></div>
        <div><span>Decision</span><strong>{latestRun?.release_decision ?? 'not evaluated'}</strong></div>
      </section>

      <div className="release-summary-strip">
        <span>Status: {latestRun?.status ?? 'none'}</span>
        <span>Type: {latestRun?.release_type ?? 'none'}</span>
        <span>Passed: {latestRun?.passed_check_count ?? checks.filter((check) => check.status === 'passed').length}</span>
        <span>Failed: {latestRun?.failed_check_count ?? checks.filter((check) => ['failed', 'blocked'].includes(check.status)).length}</span>
      </div>

      <div className="release-two-column">
        <section className="release-panel">
          <div className="panel-heading"><h3>Blockers</h3><span>{blockers.length}</span></div>
          {blockers.length ? blockers.slice(0, 12).map((item) => <ReleaseIssue key={item.id} item={item} />) : <p className="muted">Tidak ada blocker pada latest run.</p>}
        </section>
        <section className="release-panel">
          <div className="panel-heading"><h3>Warnings</h3><span>{warnings.length}</span></div>
          {warnings.length ? warnings.slice(0, 12).map((item) => <ReleaseIssue key={item.id} item={item} />) : <p className="muted">Tidak ada warning pada latest run.</p>}
        </section>
      </div>

      <section className="release-panel">
        <div className="panel-heading">
          <h3>Check Categories</h3>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All categories</option>
            {CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
        <div className="release-check-list">
          {filteredChecks.map((check) => (
            <article key={check.id} className={`release-check release-check--${check.status}`}>
              <strong>{check.check_category}/{check.check_name}</strong>
              <span>{check.status} · {check.severity} · score {Number(check.score ?? 0).toFixed(0)}</span>
              <p>{check.description}</p>
              {check.actual && <small>Actual: {check.actual}</small>}
              {check.recommended_fix && <small>Fix: {check.recommended_fix}</small>}
            </article>
          ))}
          {!filteredChecks.length && <p className="muted">Belum ada check. Jalankan release check.</p>}
        </div>
      </section>

      <div className="release-two-column">
        <section className="release-panel">
          <div className="panel-heading"><h3>Artifacts</h3><span>{artifacts.length}</span></div>
          <div className="release-artifact-list">
            {artifacts.map((artifact) => (
              <article key={artifact.id}>
                <strong>{artifact.title}</strong>
                <span>{artifact.artifact_type} · {artifact.status}</span>
                {artifact.path && <small>{artifact.path}</small>}
              </article>
            ))}
            {!artifacts.length && <p className="muted">Belum ada artifact.</p>}
          </div>
        </section>
        <section className="release-panel">
          <div className="panel-heading"><h3>Release Notes</h3><span>{notes?.version ?? 'none'}</span></div>
          {notes ? (
            <>
              <h4>{notes.title}</h4>
              <p>{notes.summary}</p>
              <h4>Manual next steps</h4>
              <ul>{(notes.recommended_next_steps ?? []).slice(0, 8).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
            </>
          ) : <p className="muted">Release notes belum dibuat.</p>}
        </section>
      </div>
    </section>
  )
}

function ReleaseIssue({ item }: { item: ReleaseCheck }) {
  return (
    <article className="release-issue">
      <strong>{item.check_category}/{item.check_name}</strong>
      <span>{item.status} · {item.severity} · score {Number(item.score ?? 0).toFixed(0)}</span>
      <p>{item.actual || item.description}</p>
      {item.recommended_fix && <small>{item.recommended_fix}</small>}
    </article>
  )
}
