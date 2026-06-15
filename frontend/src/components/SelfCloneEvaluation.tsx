import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

interface SelfCloneEvaluationProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface EvalRun {
  id: string
  readiness_level: string
  overall_score: number
  passed_cases: number
  failed_cases: number
  critical_failed_cases: number
  identity_fidelity_score: number
  communication_style_score: number
  owner_similarity_score: number
  memory_grounding_score: number
  conflict_handling_score: number
  drift_safety_score: number
  calibration_score: number
  reflection_score: number
  too_ai_score: number
  overclaim_risk: number
  private_leak_risk: number
  created_at: string
}

interface EvalCase {
  id: string
  case_type: string
  intent_type: string
  prompt: string
  priority: string
  status: string
}

interface EvalResult {
  id: string
  case_type: string
  prompt: string
  agent_answer: string
  expected_behavior: string
  score: number
  passed: boolean
  failure_reason: string | null
  recommendations: string[]
}

interface ReadinessReport {
  readiness_level: string
  overall_score: number
  summary: string
  release_decision: string
  strengths: string[]
  weaknesses: string[]
  critical_blockers: Array<Record<string, unknown>>
  recommended_next_steps: string[]
}

export function SelfCloneEvaluation({ onNotify }: SelfCloneEvaluationProps) {
  const [run, setRun] = useState<EvalRun | null>(null)
  const [cases, setCases] = useState<EvalCase[]>([])
  const [results, setResults] = useState<EvalResult[]>([])
  const [report, setReport] = useState<ReadinessReport | null>(null)
  const [critical, setCritical] = useState<EvalResult[]>([])
  const [audit, setAudit] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/__self-clone-eval/latest')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca Self-Clone Eval.')
      setRun((payload.latest_run ?? null) as EvalRun | null)
      setCases((payload.cases ?? []) as EvalCase[])
      setResults((payload.results ?? []) as EvalResult[])
      setReport((payload.readiness_report ?? null) as ReadinessReport | null)
      setCritical((payload.critical_failures ?? []) as EvalResult[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membaca Self-Clone Eval.')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const recommendations = useMemo(() => report?.recommended_next_steps ?? unique(results.flatMap((item) => item.recommendations ?? [])), [report, results])

  async function runAction(kind: string, url: string, body: Record<string, unknown>, success: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Self-Clone Eval action gagal.')
      if (kind === 'audit') setAudit(payload)
      onNotify?.('success', success)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Self-Clone Eval action gagal.'
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
          <h2>Self-Clone Evaluation</h2>
          <p>Final readiness suite: similarity, calibration, style, identity, conflicts, drift, grounding, privacy, dan honesty.</p>
        </div>
        <div className="backup-actions">
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('cases', '/__self-clone-eval/generate-cases', { suiteType: 'release', force: false }, 'Cases generated.')}>Generate Cases</button>
          <button className="btn btn--primary" disabled={Boolean(busy)} onClick={() => void runAction('run', '/__self-clone-eval/run', { suiteType: 'release', caseType: null, useJudge: false }, 'Evaluation selesai.')}>{busy === 'run' ? 'Running...' : 'Run Evaluation'}</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('release', '/__self-clone-eval/run', { suiteType: 'release', caseType: null, useJudge: false }, 'Release evaluation selesai.')}>Run Release Evaluation</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('audit', '/__self-clone-eval/audit', { save: true }, 'Audit selesai.')}>Audit</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      <section className="backup-panel clone-readiness">
        <div>
          <span>Readiness</span>
          <strong>{run?.readiness_level ?? 'none'}</strong>
        </div>
        <div>
          <span>Release Decision</span>
          <strong>{report?.release_decision ?? 'none'}</strong>
        </div>
        <div>
          <span>Overall</span>
          <strong>{num(run?.overall_score)}</strong>
        </div>
        <div>
          <span>Cases</span>
          <strong>{run ? `${run.passed_cases}/${run.passed_cases + run.failed_cases}` : '0/0'}</strong>
        </div>
      </section>

      <div className="routine-metrics">
        <Metric label="Identity" value={num(run?.identity_fidelity_score)} />
        <Metric label="Style" value={num(run?.communication_style_score)} />
        <Metric label="Owner Sim" value={num(run?.owner_similarity_score)} />
        <Metric label="Grounding" value={num(run?.memory_grounding_score)} />
        <Metric label="Conflicts" value={num(run?.conflict_handling_score)} />
        <Metric label="Drift" value={num(run?.drift_safety_score)} />
        <Metric label="Calibration" value={num(run?.calibration_score)} />
        <Metric label="Reflection" value={num(run?.reflection_score)} />
        <Metric label="Too AI" value={num(run?.too_ai_score)} />
        <Metric label="Overclaim" value={num(run?.overclaim_risk)} />
        <Metric label="Private Leak" value={num(run?.private_leak_risk)} />
      </div>

      {audit && <Panel title="Audit"><details><summary>Audit JSON</summary><pre className="brain-answer__artifact">{JSON.stringify(audit, null, 2)}</pre></details></Panel>}

      <div className="clone-grid">
        <Panel title={`Cases (${cases.length})`}>
          <div className="clone-list">
            {cases.slice(0, 80).map((item) => (
              <article key={item.id} className="clone-row">
                <strong>{item.case_type}</strong>
                <p>{item.prompt}</p>
                <span>{item.intent_type} · {item.priority} · {item.status}</span>
              </article>
            ))}
          </div>
        </Panel>
        <Panel title={`Results (${results.length})`}>
          <div className="clone-list">
            {results.map((item) => (
              <article key={item.id} className={`clone-row ${item.passed ? 'clone-row--pass' : 'clone-row--fail'}`}>
                <strong>{item.passed ? 'PASSED' : 'FAILED'} · {item.case_type} · {num(item.score)}</strong>
                <p>{item.prompt}</p>
                <blockquote>{item.agent_answer}</blockquote>
                <small>{item.failure_reason ?? item.expected_behavior}</small>
              </article>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title={`Critical Failures (${critical.length})`}>
        {critical.length ? critical.map((item) => <div key={item.id} className="reflection-item"><strong>{item.case_type}</strong><p>{item.prompt}</p><span>{item.failure_reason}</span></div>) : <p className="muted">Tidak ada critical failure pada latest run.</p>}
      </Panel>

      <Panel title="Recommendations">
        {recommendations.length ? recommendations.map((item) => <p key={item}>- {item}</p>) : <p className="muted">Belum ada rekomendasi.</p>}
      </Panel>

      <Panel title="Readiness Report">
        {report ? <details><summary>Readiness report JSON</summary><pre className="brain-answer__artifact">{JSON.stringify(report, null, 2)}</pre></details> : <p className="muted">Belum ada readiness report.</p>}
      </Panel>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="routine-metric"><span>{label}</span><strong>{value}</strong></div>
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="backup-panel clone-panel"><div className="evaluation-panel__title"><h3>{title}</h3></div>{children}</section>
}

function num(value: unknown): string {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n.toFixed(2) : '0.00'
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
