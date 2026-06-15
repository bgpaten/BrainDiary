import { useCallback, useEffect, useMemo, useState } from 'react'

interface ChatSampleImporterProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

interface ChatImport {
  id: string
  source_file: string
  source_format: string
  status: string
  total_messages: number
  owner_messages: number
  other_messages: number
  conversation_count: number
  created_at: string
}

interface ChatReplyPair {
  id: string
  prompt_text: string
  owner_reply_text: string
  intent_type: string
  answer_style: string
  confidence_score: number
  used_for_calibration: boolean
  created_at: string
}

interface ChatReview {
  id: string
  review_type: string
  label: string
  description: string
  status: string
  created_at: string
}

interface ChatSummary {
  total_files?: number
  messages?: number
  owner_messages?: number
  reply_pairs?: number
  owner_examples_created?: number
  review_needed?: number
  skipped_duplicates?: number
}

export function ChatSampleImporter({ onNotify }: ChatSampleImporterProps) {
  const [imports, setImports] = useState<ChatImport[]>([])
  const [replyPairs, setReplyPairs] = useState<ChatReplyPair[]>([])
  const [reviews, setReviews] = useState<ChatReview[]>([])
  const [summary, setSummary] = useState<ChatSummary>({})
  const [audit, setAudit] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/__chat-samples/latest')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca Chat Samples.')
      setImports((payload.latest_imports ?? []) as ChatImport[])
      setReplyPairs((payload.reply_pairs ?? []) as ChatReplyPair[])
      setReviews((payload.reviews ?? []) as ChatReview[])
      setSummary((payload.summary ?? {}) as ChatSummary)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca Chat Samples.'
      setError(message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const groupedReviews = useMemo(() => {
    const groups: Record<string, ChatReview[]> = {}
    for (const review of reviews) {
      if (!groups[review.review_type]) groups[review.review_type] = []
      groups[review.review_type].push(review)
    }
    return groups
  }, [reviews])

  async function runAction(kind: string, url: string, body: Record<string, unknown>, success: string) {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.summary?.warnings?.[0] ?? 'Chat Samples action gagal.')
      if (kind === 'audit') setAudit(payload)
      onNotify?.('success', success)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chat Samples action gagal.'
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
          <h2>Chat Sample Importer</h2>
          <p>Import chat asli sebagai evidence gaya komunikasi. Hanya pesan owner yang dipakai untuk gaya komunikasi.</p>
        </div>
        <div className="backup-actions">
          <button type="button" className="btn btn--primary" disabled={Boolean(busy)} onClick={() => void runAction('import', '/__chat-samples/import', { limit: 10, dryRun: false }, 'Chat samples imported.')}>
            {busy === 'import' ? 'Importing...' : 'Import Chat Samples'}
          </button>
          <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('audit', '/__chat-samples/audit', { save: true }, 'Chat samples audit selesai.')}>
            Audit Chat Samples
          </button>
          <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('pairs', '/__chat-samples/pairs', {}, 'Reply pairs generated.')}>
            Generate Reply Pairs
          </button>
          <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="evaluation-alert">{error}</div>}
      <div className="evaluation-alert evaluation-alert--info">Hanya pesan owner yang dipakai untuk gaya komunikasi. Pesan lawan bicara hanya menjadi prompt/context.</div>

      <div className="routine-metrics">
        <Metric label="Files" value={String(summary.total_files ?? imports.length)} />
        <Metric label="Messages" value={String(summary.messages ?? 0)} />
        <Metric label="Owner" value={String(summary.owner_messages ?? 0)} />
        <Metric label="Reply Pairs" value={String(summary.reply_pairs ?? replyPairs.length)} />
        <Metric label="Examples" value={String(summary.owner_examples_created ?? 0)} />
        <Metric label="Reviews" value={String(summary.review_needed ?? reviews.filter((review) => review.status === 'pending').length)} />
      </div>

      {audit && (
        <section className="backup-panel">
          <div className="evaluation-panel__title"><h3>Audit Result</h3></div>
          <details><summary>Audit JSON</summary><pre className="brain-answer__artifact">{JSON.stringify(audit, null, 2)}</pre></details>
        </section>
      )}

      <section className="backup-panel">
        <div className="evaluation-panel__title"><h3>Latest Imports</h3><span>{imports.length}</span></div>
        {imports.length ? (
          <div className="chat-sample-list">
            {imports.map((item) => (
              <article key={item.id} className="chat-sample-row">
                <div>
                  <strong>{item.source_file}</strong>
                  <p>{item.source_format} · {item.status} · {new Date(item.created_at).toLocaleString()}</p>
                </div>
                <div className="chat-sample-row__stats">
                  <span>{item.total_messages} msg</span>
                  <span>{item.owner_messages} owner</span>
                  <span>{item.other_messages} other</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">Belum ada import chat sample.</p>
        )}
      </section>

      <section className="backup-panel">
        <div className="evaluation-panel__title"><h3>Reply Pairs</h3><span>{replyPairs.length}</span></div>
        {replyPairs.length ? (
          <div className="chat-pair-list">
            {replyPairs.map((pair) => (
              <article key={pair.id} className="chat-pair">
                <div className="chat-pair__text">
                  <span>Prompt</span>
                  <p>{pair.prompt_text}</p>
                </div>
                <div className="chat-pair__text">
                  <span>Owner Reply</span>
                  <p>{pair.owner_reply_text}</p>
                </div>
                <div className="chat-pair__meta">
                  <span>{pair.intent_type}</span>
                  <span>{pair.answer_style}</span>
                  <span>{Number(pair.confidence_score ?? 0).toFixed(2)}</span>
                  <span>{pair.used_for_calibration ? 'calibration' : 'review'}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">Belum ada reply pair. Jalankan import atau Generate Reply Pairs.</p>
        )}
      </section>

      <section className="backup-panel">
        <div className="evaluation-panel__title"><h3>Reviews</h3><span>{reviews.length}</span></div>
        {Object.keys(groupedReviews).length ? (
          <div className="reflection-sections">
            {Object.entries(groupedReviews).map(([type, items]) => (
              <div key={type} className="reflection-section">
                <h4>{type}</h4>
                {items.slice(0, 6).map((review) => (
                  <div key={review.id} className="reflection-item">
                    <strong>{review.label}</strong>
                    <p>{review.description}</p>
                    <span>{review.status}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Tidak ada review pending.</p>
        )}
      </section>
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
