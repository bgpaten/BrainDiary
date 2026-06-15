import { useCallback, useEffect, useMemo, useState } from 'react'

interface SimilarityEvaluationProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface SimilarityRun {
  id: string
  status: string
  run_type: string
  total_cases: number
  passed_cases: number
  failed_cases: number
  regression_count: number
  improvement_count: number
  average_similarity_score: number
  average_fidelity_score: number
  average_style_match_score: number
  average_too_ai_score: number
  average_overclaim_risk: number
  average_underfit_risk: number
  overall_score: number
  verdict: 'excellent' | 'good' | 'warning' | 'bad' | 'blocked'
  created_at: string | null
}

interface SimilarityResult {
  id: string
  prompt: string
  owner_answer: string
  agent_answer: string
  intent_type: string
  actual_intent_type: string
  similarity_score: number
  fidelity_score: number
  style_match_score: number
  too_ai_score: number
  overclaim_risk: number
  underfit_risk: number
  regression_score: number
  passed: boolean
  regressed: boolean
  improved: boolean
  failure_reason: string | null
  recommendations: string[]
}

interface SimilarityBaseline {
  id: string
  label: string
  status: string
  overall_score: number
  case_count: number
  created_at: string | null
}

export function SimilarityEvaluation({ onNotify }: SimilarityEvaluationProps) {
  const [run, setRun] = useState<SimilarityRun | null>(null)
  const [results, setResults] = useState<SimilarityResult[]>([])
  const [baseline, setBaseline] = useState<SimilarityBaseline | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const failed = useMemo(() => results.filter((result) => !result.passed), [results])
  const regressed = useMemo(() => results.filter((result) => result.regressed), [results])

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/__similarity-eval/latest')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca similarity eval.')
      setRun((payload.run ?? null) as SimilarityRun | null)
      setResults((payload.results ?? []) as SimilarityResult[])
      setBaseline((payload.baseline ?? null) as SimilarityBaseline | null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca similarity eval.'
      setError(message)
      onNotify?.('error', message)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function runSimilarity() {
    await runAction('run', '/__similarity-eval/run', { limit: 50, intentType: null, runType: 'manual', useJudge: false }, 'Similarity evaluation selesai.')
  }

  async function createBaseline() {
    await runAction('baseline', '/__similarity-eval/create-baseline', { activate: true }, 'Baseline dibuat dan diaktifkan.')
  }

  async function compareBaseline() {
    await runAction('compare', '/__similarity-eval/compare', { baselineId: null }, 'Compare selesai.')
  }

  async function runAction(kind: string, url: string, body: Record<string, unknown>, successMessage: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    onNotify?.('info', kind === 'run' ? 'Similarity evaluation berjalan...' : 'Similarity action berjalan...')
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Similarity action gagal.')
      onNotify?.('success', successMessage)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Similarity action gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="calibration-view">
      <header className="backup-view__header">
        <div>
          <h2>Similarity Evaluation</h2>
          <p>Loop evaluasi untuk menjaga self-clone tetap mirip owner dan tidak drift.</p>
        </div>
        <div className="backup-actions">
          <button type="button" className="btn btn--primary" onClick={() => void runSimilarity()} disabled={Boolean(busy)}>
            {busy === 'run' ? 'Running...' : 'Run Similarity Eval'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void createBaseline()} disabled={Boolean(busy) || !run}>
            {busy === 'baseline' ? 'Creating...' : 'Create Baseline'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void compareBaseline()} disabled={Boolean(busy) || !baseline}>
            {busy === 'compare' ? 'Comparing...' : 'Compare to Baseline'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void refresh()} disabled={Boolean(busy)}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      <div className="routine-metrics">
        <Metric label="Overall" value={formatScore(run?.overall_score)} />
        <Metric label="Similarity" value={formatScore(run?.average_similarity_score)} />
        <Metric label="Fidelity" value={formatScore(run?.average_fidelity_score)} />
        <Metric label="Style" value={formatScore(run?.average_style_match_score)} />
        <Metric label="Too AI" value={formatScore(run?.average_too_ai_score)} />
        <Metric label="Overclaim" value={formatScore(run?.average_overclaim_risk)} />
        <Metric label="Underfit" value={formatScore(run?.average_underfit_risk)} />
      </div>

      <section className="backup-panel">
        <div className="evaluation-panel__title">
          <h3>Latest Run</h3>
          {run && <span className={`similarity-verdict similarity-verdict--${run.verdict}`}>{run.verdict}</span>}
        </div>
        {run ? (
          <div className="brain-answer__meta">
            <span>{run.status} · {run.run_type}</span>
            <span>Passed {run.passed_cases}/{run.total_cases}</span>
            <span>Failed {run.failed_cases}</span>
            <span>Regressions {run.regression_count}</span>
            <span>Improvements {run.improvement_count}</span>
          </div>
        ) : (
          <p className="muted">Belum ada similarity run.</p>
        )}
      </section>

      <section className="backup-panel">
        <div className="evaluation-panel__title">
          <h3>Active Baseline</h3>
          <span>{baseline?.status ?? 'none'}</span>
        </div>
        {baseline ? (
          <div className="brain-answer__meta">
            <span>{baseline.label}</span>
            <span>Overall {formatScore(baseline.overall_score)}</span>
            <span>Cases {baseline.case_count}</span>
          </div>
        ) : (
          <p className="muted">Belum ada active baseline.</p>
        )}
      </section>

      <div className="backup-grid">
        <ResultSection title="Failed / Regressed Cases" results={[...regressed, ...failed.filter((item) => !item.regressed)]} />
        <ResultSection title="All Results" results={results} />
      </div>
    </section>
  )
}

function ResultSection({ title, results }: { title: string; results: SimilarityResult[] }) {
  return (
    <section className="backup-panel">
      <div className="evaluation-panel__title">
        <h3>{title}</h3>
        <span>{results.length}</span>
      </div>
      <div className="calibration-results">
        {results.map((result) => <ResultCard key={`${title}:${result.id}`} result={result} />)}
        {results.length === 0 && <p className="muted">Tidak ada case.</p>}
      </div>
    </section>
  )
}

function ResultCard({ result }: { result: SimilarityResult }) {
  return (
    <article className={result.passed && !result.regressed ? 'calibration-result calibration-result--pass' : 'calibration-result'}>
      <div className="evaluation-panel__title">
        <h4>{result.prompt}</h4>
        <span>{result.regressed ? 'regressed' : result.improved ? 'improved' : result.passed ? 'passed' : 'failed'}</span>
      </div>
      <div className="calibration-compare">
        <div>
          <strong>Owner</strong>
          <p>{result.owner_answer}</p>
        </div>
        <div>
          <strong>Agent</strong>
          <p>{result.agent_answer}</p>
        </div>
      </div>
      <div className="brain-answer__meta">
        <span>Similarity {formatScore(result.similarity_score)}</span>
        <span>Fidelity {formatScore(result.fidelity_score)}</span>
        <span>Style {formatScore(result.style_match_score)}</span>
        <span>Too AI {formatScore(result.too_ai_score)}</span>
        <span>Overclaim {formatScore(result.overclaim_risk)}</span>
        <span>Underfit {formatScore(result.underfit_risk)}</span>
      </div>
      {result.failure_reason && <div className="chat-warning">{result.failure_reason}</div>}
      {result.recommendations?.length > 0 && (
        <ul>
          {result.recommendations.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </article>
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

function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-'
  return Number(value).toFixed(2)
}
