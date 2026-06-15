import { useCallback, useEffect, useMemo, useState } from 'react'

interface OwnerCalibrationProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface OwnerExample {
  id: string
  prompt: string
  owner_answer: string
  intent_type: string
  answer_style: string
  tone: string
  length_class: string
  status: string
  created_at: string | null
}

interface CalibrationRun {
  id: string
  status: string
  total_examples: number
  average_similarity_score: number
  average_style_match_score: number
  average_fidelity_score: number
  overclaim_count: number
  underfit_count: number
  too_ai_count: number
  created_at: string | null
}

interface CalibrationResult {
  id: string
  prompt: string
  owner_answer: string
  agent_answer: string
  intent_type: string
  actual_intent_type: string
  similarity_score: number
  style_match_score: number
  fidelity_score: number
  too_ai_score: number
  overclaim_risk: number
  underfit_risk: number
  missing_elements: string[]
  extra_elements: string[]
  calibration_hints: Array<Record<string, unknown>>
  passed: boolean
}

interface CalibrationHint {
  id: string
  intent_type: string
  hint_type: string
  label: string
  description: string
  status: string
  confidence_score: number
}

const INTENTS = ['social_greeting', 'casual_reply', 'request_prompt', 'technical_instruction', 'strategy_question', 'correction', 'identity_question', 'contradiction_check', 'decision_help', 'personal_reflection', 'unknown']
const ANSWER_STYLES = ['short_direct', 'casual_direct', 'technical_step_by_step', 'prompt_ready', 'strategic_direct', 'reflective', 'corrective', 'neutral']

export function OwnerCalibration({ onNotify }: OwnerCalibrationProps) {
  const [examples, setExamples] = useState<OwnerExample[]>([])
  const [run, setRun] = useState<CalibrationRun | null>(null)
  const [results, setResults] = useState<CalibrationResult[]>([])
  const [hints, setHints] = useState<CalibrationHint[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    prompt: '',
    ownerAnswer: '',
    intentType: 'social_greeting',
    answerStyle: 'short_direct',
    contextNote: '',
  })

  const failedResults = useMemo(() => results.filter((result) => !result.passed), [results])
  const activeHints = useMemo(() => hints.filter((hint) => hint.status === 'active'), [hints])
  const reviewHints = useMemo(() => hints.filter((hint) => hint.status === 'needs_review'), [hints])
  const deprecatedHints = useMemo(() => hints.filter((hint) => hint.status === 'deprecated'), [hints])

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/__owner-calibration/latest')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca owner calibration.')
      setExamples((payload.examples ?? []) as OwnerExample[])
      setRun((payload.run ?? null) as CalibrationRun | null)
      setResults((payload.results ?? []) as CalibrationResult[])
      setHints((payload.hints ?? []) as CalibrationHint[])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca owner calibration.'
      setError(message)
      onNotify?.('error', message)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function seedExamples() {
    await runAction('seed', '/__owner-calibration/seed-examples', { force: false }, 'Seed examples selesai.')
  }

  async function runCalibration() {
    await runAction('run', '/__owner-calibration/run', { limit: 25, intentType: null, useJudge: false }, 'Calibration selesai.')
  }

  async function addExample(event: React.FormEvent) {
    event.preventDefault()
    if (!form.prompt.trim() || !form.ownerAnswer.trim()) return
    await runAction('add', '/__owner-calibration/add-example', form, 'Owner example ditambahkan.')
    setForm((prev) => ({ ...prev, prompt: '', ownerAnswer: '', contextNote: '' }))
  }

  async function runAction(kind: string, url: string, body: Record<string, unknown>, successMessage: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    onNotify?.('info', kind === 'run' ? 'Owner calibration berjalan...' : 'Memproses owner calibration...')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Owner calibration gagal.')
      onNotify?.('success', successMessage)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Owner calibration gagal.'
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
          <h2>Owner Answer Calibration</h2>
          <p>Bandingkan jawaban agent dengan jawaban asli pemilik diary, lalu simpan hint kalibrasi.</p>
        </div>
        <div className="backup-actions">
          <button type="button" className="btn btn--primary" onClick={() => void runCalibration()} disabled={Boolean(busy) || examples.length === 0}>
            {busy === 'run' ? 'Running...' : 'Run Calibration'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void seedExamples()} disabled={Boolean(busy)}>
            {busy === 'seed' ? 'Seeding...' : 'Seed Examples'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void refresh()} disabled={Boolean(busy)}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      <div className="routine-metrics">
        <Metric label="Similarity" value={formatScore(run?.average_similarity_score)} />
        <Metric label="Style Match" value={formatScore(run?.average_style_match_score)} />
        <Metric label="Fidelity" value={formatScore(run?.average_fidelity_score)} />
        <Metric label="Too AI" value={String(run?.too_ai_count ?? 0)} />
        <Metric label="Overclaim" value={String(run?.overclaim_count ?? 0)} />
        <Metric label="Underfit" value={String(run?.underfit_count ?? 0)} />
      </div>

      <div className="backup-grid">
        <section className="backup-panel">
          <div className="evaluation-panel__title">
            <h3>Add Example</h3>
          </div>
          <form className="calibration-form" onSubmit={(event) => void addExample(event)}>
            <label>
              Prompt
              <textarea value={form.prompt} maxLength={2000} rows={3} onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))} />
            </label>
            <label>
              Owner Answer
              <textarea value={form.ownerAnswer} maxLength={10000} rows={5} onChange={(event) => setForm((prev) => ({ ...prev, ownerAnswer: event.target.value }))} />
            </label>
            <div className="calibration-form__grid">
              <label>
                Intent
                <select value={form.intentType} onChange={(event) => setForm((prev) => ({ ...prev, intentType: event.target.value }))}>
                  {INTENTS.map((intent) => <option key={intent} value={intent}>{intent}</option>)}
                </select>
              </label>
              <label>
                Style
                <select value={form.answerStyle} onChange={(event) => setForm((prev) => ({ ...prev, answerStyle: event.target.value }))}>
                  {ANSWER_STYLES.map((style) => <option key={style} value={style}>{style}</option>)}
                </select>
              </label>
            </div>
            <label>
              Context Note
              <textarea value={form.contextNote} maxLength={2000} rows={2} onChange={(event) => setForm((prev) => ({ ...prev, contextNote: event.target.value }))} />
            </label>
            <button type="submit" className="btn btn--primary" disabled={Boolean(busy) || !form.prompt.trim() || !form.ownerAnswer.trim()}>
              {busy === 'add' ? 'Adding...' : 'Add Example'}
            </button>
          </form>
        </section>

        <section className="backup-panel">
          <div className="evaluation-panel__title">
            <h3>Owner Examples</h3>
            <span>{examples.length}</span>
          </div>
          <div className="calibration-list">
            {examples.map((example) => (
              <article key={example.id} className="calibration-item">
                <span className="persona-badge">{example.intent_type}</span>
                <strong>{example.prompt}</strong>
                <p>{example.owner_answer}</p>
                <small>{example.answer_style} · {example.length_class} · {example.status}</small>
              </article>
            ))}
            {examples.length === 0 && <p className="muted">Belum ada example. Klik Seed Examples atau tambah manual.</p>}
          </div>
        </section>
      </div>

      <section className="backup-panel">
        <div className="evaluation-panel__title">
          <h3>Latest Calibration Run</h3>
          <span>{run ? `${run.status} · ${run.total_examples} examples` : 'none'}</span>
        </div>
        <div className="calibration-results">
          {failedResults.map((result) => <ResultCard key={result.id} result={result} />)}
          {failedResults.length === 0 && results.map((result) => <ResultCard key={result.id} result={result} />)}
          {results.length === 0 && <p className="muted">Belum ada result. Jalankan calibration.</p>}
        </div>
      </section>

      <div className="backup-grid">
        <HintPanel title="Active Hints" hints={activeHints} />
        <HintPanel title="Needs Review" hints={reviewHints} />
        <HintPanel title="Deprecated" hints={deprecatedHints} />
      </div>
    </section>
  )
}

function ResultCard({ result }: { result: CalibrationResult }) {
  return (
    <article className={result.passed ? 'calibration-result calibration-result--pass' : 'calibration-result'}>
      <div className="evaluation-panel__title">
        <h4>{result.prompt}</h4>
        <span>{result.passed ? 'passed' : 'failed'} · {formatScore(result.fidelity_score)}</span>
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
        <span>Style {formatScore(result.style_match_score)}</span>
        <span>Too AI {formatScore(result.too_ai_score)}</span>
        <span>Overclaim {formatScore(result.overclaim_risk)}</span>
        <span>Underfit {formatScore(result.underfit_risk)}</span>
      </div>
      {(result.missing_elements?.length > 0 || result.extra_elements?.length > 0) && (
        <div className="calibration-elements">
          {result.missing_elements?.length > 0 && <p><strong>Missing:</strong> {result.missing_elements.join(', ')}</p>}
          {result.extra_elements?.length > 0 && <p><strong>Extra:</strong> {result.extra_elements.join(', ')}</p>}
        </div>
      )}
      {result.calibration_hints?.length > 0 && <details><summary>Calibration hints JSON</summary><pre className="brain-answer__artifact">{JSON.stringify(result.calibration_hints, null, 2)}</pre></details>}
    </article>
  )
}

function HintPanel({ title, hints }: { title: string; hints: CalibrationHint[] }) {
  return (
    <section className="backup-panel">
      <div className="evaluation-panel__title">
        <h3>{title}</h3>
        <span>{hints.length}</span>
      </div>
      <div className="calibration-list">
        {hints.map((hint) => (
          <article key={hint.id} className="calibration-item">
            <span className="persona-badge">{hint.intent_type} · {hint.hint_type}</span>
            <strong>{hint.label}</strong>
            <p>{hint.description}</p>
            <small>confidence {formatScore(hint.confidence_score)} · {hint.status}</small>
          </article>
        ))}
        {hints.length === 0 && <p className="muted">Tidak ada hint.</p>}
      </div>
    </section>
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
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return Number(value).toFixed(2)
}
