import { useCallback, useEffect, useMemo, useState } from 'react'

interface DriftControlProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface DriftLog {
  id: string
  question: string
  answer_before_guard: string
  answer_after_guard: string
  intent_type: string
  triggered_rules: string[]
  guard_actions: string[]
  overclaim_score: number
  style_drift_score: number
  too_ai_score: number
  unsupported_claim_score: number
  irrelevant_context_score: number
  final_risk_score: number
  blocked: boolean
  fallback_used: boolean
  warnings: string[]
  created_at: string
}

interface DriftRule {
  id: string
  rule_type: string
  rule_name: string
  severity: string
  enabled: boolean
}

const INTENTS = ['social_greeting','casual_reply','request_prompt','technical_instruction','strategy_question','correction','identity_question','contradiction_check','decision_help','personal_reflection','unknown']

export function DriftControl({ onNotify }: DriftControlProps) {
  const [logs, setLogs] = useState<DriftLog[]>([])
  const [rules, setRules] = useState<DriftRule[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState({ question: 'hi', answer: 'Halo! Ada yang bisa saya bantu hari ini?', intentType: 'social_greeting' })
  const [result, setResult] = useState<Record<string, unknown> | null>(null)

  const highRisk = useMemo(() => logs.filter((log) => Number(log.final_risk_score) >= 0.51), [logs])

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/__drift-control/latest')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca Drift Control.')
      setLogs((payload.logs ?? []) as DriftLog[])
      setRules((payload.active_rules ?? []) as DriftRule[])
      setSummary((payload.risk_summary ?? {}) as Record<string, number>)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca Drift Control.'
      setError(message)
      onNotify?.('error', message)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function runAction(kind: string, url: string, body: Record<string, unknown>, message: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Drift action gagal.')
      if (kind === 'check') setResult(payload)
      onNotify?.('success', message)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Drift action gagal.'
      setError(msg)
      onNotify?.('error', msg)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="calibration-view">
      <header className="backup-view__header">
        <div>
          <h2>Drift Control</h2>
          <p>Guard anti-overclaim, anti AI-like phrase, source/debug leak, dan style drift sebelum jawaban tampil ke user.</p>
        </div>
        <div className="backup-actions">
          <button className="btn btn--primary" type="button" onClick={() => void runAction('seed', '/__drift-control/seed-rules', { force: false }, 'Drift rules seeded.')} disabled={Boolean(busy)}>
            {busy === 'seed' ? 'Seeding...' : 'Seed Rules'}
          </button>
          <button className="btn btn--ghost" type="button" onClick={() => void runAction('baseline', '/__drift-control/create-baseline', { activate: true }, 'Drift baseline dibuat.')} disabled={Boolean(busy)}>
            Create Baseline
          </button>
          <button className="btn btn--ghost" type="button" onClick={() => void refresh()} disabled={Boolean(busy)}>Refresh</button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      <div className="routine-metrics">
        <Metric label="Overclaim" value={score(summary.overclaim_average)} />
        <Metric label="Too AI" value={score(summary.too_ai_average)} />
        <Metric label="Style Drift" value={score(summary.style_drift_average)} />
        <Metric label="Unsupported" value={score(summary.unsupported_claim_average)} />
        <Metric label="Irrelevant" value={score(summary.irrelevant_context_average)} />
        <Metric label="High Risk" value={String(summary.high_risk_count ?? 0)} />
      </div>

      <div className="backup-grid">
        <section className="backup-panel">
          <div className="evaluation-panel__title"><h3>Test Draft Answer</h3></div>
          <div className="calibration-form">
            <label>Question<textarea rows={2} value={test.question} onChange={(e) => setTest((v) => ({ ...v, question: e.target.value }))} /></label>
            <label>Draft Answer<textarea rows={5} value={test.answer} onChange={(e) => setTest((v) => ({ ...v, answer: e.target.value }))} /></label>
            <label>Intent<select value={test.intentType} onChange={(e) => setTest((v) => ({ ...v, intentType: e.target.value }))}>{INTENTS.map((intent) => <option key={intent} value={intent}>{intent}</option>)}</select></label>
            <button className="btn btn--primary" type="button" onClick={() => void runAction('check', '/__drift-control/check', test, 'Drift check selesai.')} disabled={Boolean(busy)}>
              {busy === 'check' ? 'Checking...' : 'Check Drift'}
            </button>
          </div>
          {result && <details><summary>Drift result JSON</summary><pre className="brain-answer__artifact">{JSON.stringify(result, null, 2)}</pre></details>}
        </section>

        <section className="backup-panel">
          <div className="evaluation-panel__title"><h3>Active Rules</h3><span>{rules.length}</span></div>
          <div className="calibration-list">
            {rules.map((rule) => <article key={rule.id} className="calibration-item"><span className="persona-badge">{rule.severity} · {rule.rule_type}</span><strong>{rule.rule_name}</strong></article>)}
          </div>
        </section>
      </div>

      <section className="backup-panel">
        <div className="evaluation-panel__title"><h3>Latest Guard Logs</h3><span>{highRisk.length} high risk</span></div>
        <div className="calibration-results">
          {logs.map((log) => (
            <article key={log.id} className={Number(log.final_risk_score) >= 0.51 ? 'calibration-result' : 'calibration-result calibration-result--pass'}>
              <div className="evaluation-panel__title"><h4>{log.question}</h4><span>risk {score(log.final_risk_score)}</span></div>
              <div className="calibration-compare"><div><strong>Before</strong><p>{log.answer_before_guard}</p></div><div><strong>After</strong><p>{log.answer_after_guard}</p></div></div>
              <div className="brain-answer__meta"><span>{log.intent_type}</span><span>blocked {String(log.blocked)}</span><span>fallback {String(log.fallback_used)}</span><span>{(log.triggered_rules ?? []).join(', ')}</span></div>
            </article>
          ))}
          {logs.length === 0 && <p className="muted">Belum ada drift logs.</p>}
        </div>
      </section>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="routine-metric"><span>{label}</span><strong>{value}</strong></div>
}

function score(value: unknown): string {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n.toFixed(2) : '-'
}
