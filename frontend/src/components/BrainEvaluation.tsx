import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { BrainEvalResult, BrainEvalRun } from '../types/brain'

type BusyState = 'generate' | 'run' | null

interface BrainEvaluationProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

export function BrainEvaluation({ onNotify }: BrainEvaluationProps) {
  const [run, setRun] = useState<BrainEvalRun | null>(null)
  const [results, setResults] = useState<BrainEvalResult[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(
    () => results.find((item) => item.id === selectedId) ?? results.find((item) => !item.passed) ?? results[0] ?? null,
    [results, selectedId],
  )
  const failed = useMemo(() => results.filter((item) => !item.passed), [results])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data: latestRun, error: runError } = await supabase
        .from('brain_eval_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (runError) throw runError
      setRun((latestRun as BrainEvalRun | null) ?? null)
      if (!latestRun) {
        setResults([])
        setSelectedId(null)
        return
      }
      const { data: latestResults, error: resultsError } = await supabase
        .from('brain_eval_results')
        .select('*')
        .eq('eval_run_id', latestRun.id)
        .order('created_at', { ascending: true })
      if (resultsError) throw resultsError
      const next = (latestResults ?? []) as BrainEvalResult[]
      setResults(next)
      setSelectedId((current) => current ?? next.find((item) => !item.passed)?.id ?? next[0]?.id ?? null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca evaluation data.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const trigger = async (kind: BusyState) => {
    if (!kind || busy) return
    setBusy(kind)
    setError(null)
    onNotify?.('info', kind === 'generate' ? 'Generating eval cases...' : 'Running brain evaluation...')
    try {
      const res = await fetch(kind === 'generate' ? '/__brain-eval/generate-cases' : '/__brain-eval/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'generate' ? { limit: 25, force: false } : { limit: 25, useJudge: false }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.stdout ?? 'Brain Evaluation gagal.')
      onNotify?.('success', kind === 'generate' ? 'Eval cases siap.' : 'Evaluation selesai.')
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Brain Evaluation gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="evaluation-view">
      <header className="evaluation-view__header">
        <div>
          <h2>Brain Evaluation</h2>
          <p>Memory Accuracy Test untuk mengukur retrieval, grounding, source, persona mode, dan hallucination risk.</p>
        </div>
        <div className="evaluation-actions">
          <button type="button" className="btn btn--ghost" onClick={() => void trigger('generate')} disabled={Boolean(busy)}>
            {busy === 'generate' ? 'Generating...' : 'Generate Test Cases'}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void trigger('run')} disabled={Boolean(busy)}>
            {busy === 'run' ? 'Running...' : 'Run Evaluation'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void refresh()} disabled={loading || Boolean(busy)}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}

      {!run ? (
        <div className="evaluation-empty">
          <h3>Belum ada evaluation run</h3>
          <p>Generate test cases lalu jalankan evaluation dari dev server lokal.</p>
        </div>
      ) : (
        <>
          <div className="evaluation-summary">
            <ScoreCard label="Overall" value={run.average_score} />
            <ScoreCard label="Retrieval" value={run.retrieval_accuracy} />
            <ScoreCard label="Source" value={run.source_accuracy} />
            <ScoreCard label="Groundedness" value={run.groundedness_score} />
            <ScoreCard label="Hallucination Risk" value={run.hallucination_risk} danger />
            <ScoreCard label="Persona Mode" value={run.persona_mode_accuracy} />
          </div>

          <div className="evaluation-run-meta">
            <span>{run.title}</span>
            <span>Status: {run.status}</span>
            <span>Passed: {run.passed_cases}</span>
            <span>Failed: {run.failed_cases}</span>
            <span>Total: {run.total_cases}</span>
          </div>

          <div className="evaluation-grid">
            <div className="evaluation-panel">
              <div className="evaluation-panel__title">
                <h3>Failed Cases</h3>
                <span>{failed.length}</span>
              </div>
              <div className="evaluation-result-list">
                {(failed.length ? failed : results).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`evaluation-result ${selected?.id === item.id ? 'evaluation-result--active' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className={item.passed ? 'eval-pass' : 'eval-fail'}>{item.passed ? 'PASS' : 'FAIL'}</span>
                    <span>{item.question}</span>
                    <small>{percent(item.scores?.average_score)}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="evaluation-panel evaluation-detail">
              {selected ? (
                <>
                  <div className="evaluation-panel__title">
                    <h3>Result Detail</h3>
                    <span className={selected.passed ? 'eval-pass' : 'eval-fail'}>{selected.passed ? 'PASS' : 'FAIL'}</span>
                  </div>
                  <DetailBlock label="Question" value={selected.question} />
                  <DetailBlock label="Answer" value={selected.answer ?? '-'} multiline />
                  <div className="evaluation-detail__modes">
                    <span>Expected: {selected.expected_mode ?? '-'}</span>
                    <span>Actual: {selected.actual_mode ?? '-'}</span>
                  </div>
                  <div className="evaluation-score-grid">
                    <ScorePill label="Retrieval" value={selected.scores?.retrieval_accuracy} />
                    <ScorePill label="Source" value={selected.scores?.source_accuracy} />
                    <ScorePill label="Grounded" value={selected.scores?.groundedness} />
                    <ScorePill label="Hallucination" value={selected.scores?.hallucination_risk} danger />
                    <ScorePill label="Persona" value={selected.scores?.persona_mode_accuracy} />
                    <ScorePill label="Useful" value={selected.scores?.answer_usefulness} />
                  </div>
                  <DetailBlock label="Sources" value={formatSources(selected.sources)} multiline />
                  {selected.failure_reason && <DetailBlock label="Failure Reason" value={selected.failure_reason} multiline />}
                  {selected.judge_feedback && <DetailBlock label="Judge Feedback" value={selected.judge_feedback} multiline />}
                </>
              ) : (
                <p className="muted">Tidak ada result.</p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function ScoreCard({ label, value, danger = false }: { label: string; value: number | null | undefined; danger?: boolean }) {
  return (
    <div className={`evaluation-score-card ${danger ? 'evaluation-score-card--danger' : ''}`}>
      <span>{label}</span>
      <strong>{percent(value)}</strong>
    </div>
  )
}

function ScorePill({ label, value, danger = false }: { label: string; value: unknown; danger?: boolean }) {
  return (
    <span className={`evaluation-score-pill ${danger ? 'evaluation-score-pill--danger' : ''}`}>
      {label}: {percent(value)}
    </span>
  )
}

function DetailBlock({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="evaluation-detail-block">
      <span>{label}</span>
      <p className={multiline ? 'evaluation-detail-block--multiline' : ''}>{value}</p>
    </div>
  )
}

function percent(value: unknown) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return '0%'
  return `${Math.round(number * 100)}%`
}

function formatSources(sources: Array<Record<string, unknown>>) {
  if (!sources.length) return '-'
  return sources
    .map((source) => `${String(source.type ?? 'source')}:${String(source.id ?? '-')}${source.label ? ` - ${String(source.label)}` : ''}`)
    .join('\n')
}
