import { useState } from 'react'
import { askBrain } from '../lib/brainChat'
import type { BrainChatResponse } from '../types/brain'

interface ChatMessage {
  id: number
  question: string
  response: BrainChatResponse | null
  error: string | null
}

export function BrainChat() {
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [personaBusy, setPersonaBusy] = useState(false)
  const [personaStatus, setPersonaStatus] = useState<string | null>(null)
  const [identityBusy, setIdentityBusy] = useState(false)
  const [identityStatus, setIdentityStatus] = useState<string | null>(null)
  const [communicationBusy, setCommunicationBusy] = useState(false)
  const [communicationStatus, setCommunicationStatus] = useState<string | null>(null)

  const currentQuestion = question.trim()
  const disabled = busy || currentQuestion.length === 0 || currentQuestion.length > 2000

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (disabled) return
    const id = Date.now()
    setBusy(true)
    setMessages((prev) => [...prev, { id, question: currentQuestion, response: null, error: null }])
    setQuestion('')
    try {
      const response = await askBrain(currentQuestion)
      setMessages((prev) => prev.map((item) => (item.id === id ? { ...item, response } : item)))
    } catch (err) {
      setMessages((prev) =>
        prev.map((item) => (item.id === id ? { ...item, error: err instanceof Error ? err.message : 'Brain Chat gagal.' } : item)),
      )
    } finally {
      setBusy(false)
    }
  }

  async function copyAnswer(response: BrainChatResponse) {
    await navigator.clipboard.writeText(response.answer)
  }

  async function refreshPersona() {
    if (personaBusy) return
    setPersonaBusy(true)
    setPersonaStatus('Refreshing persona...')
    try {
      const res = await fetch('/__brain-persona/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Refresh persona gagal.')
      setPersonaStatus('Persona refreshed.')
    } catch (err) {
      setPersonaStatus(err instanceof Error ? err.message : 'Refresh persona gagal.')
    } finally {
      setPersonaBusy(false)
    }
  }

  async function refreshIdentity() {
    if (identityBusy) return
    setIdentityBusy(true)
    setIdentityStatus('Building identity model...')
    try {
      const res = await fetch('/__identity-fidelity/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 100, snapshot: true, force: false }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Refresh identity gagal.')
      setIdentityStatus(`Identity refreshed: ${payload?.facts_upserted ?? 0} facts updated.`)
    } catch (err) {
      setIdentityStatus(err instanceof Error ? err.message : 'Refresh identity gagal.')
    } finally {
      setIdentityBusy(false)
    }
  }

  async function refreshCommunicationStyle() {
    if (communicationBusy) return
    setCommunicationBusy(true)
    setCommunicationStatus('Building communication style...')
    try {
      const res = await fetch('/__communication-style/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 100, force: false }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Refresh communication style gagal.')
      setCommunicationStatus(`Communication refreshed: ${payload?.patterns_upserted ?? 0} patterns updated.`)
    } catch (err) {
      setCommunicationStatus(err instanceof Error ? err.message : 'Refresh communication style gagal.')
    } finally {
      setCommunicationBusy(false)
    }
  }

  const latestIdentityDebug = [...messages].reverse().find((message) => message.response?.debug && !message.response.debug.is_social_greeting)?.response?.debug
  const latestCommunicationDebug = [...messages].reverse().find((message) => message.response?.debug?.communication_intent)?.response?.debug

  return (
    <section className="chat-view">
      <div className="chat-view__header">
        <div>
          <h2>Brain Chat MVP</h2>
          <p>Agent reader read-only untuk structured brain. Jawaban harus berbasis memory yang tersedia.</p>
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => setMessages([])} disabled={messages.length === 0 || busy}>
          Clear Chat
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => void refreshPersona()} disabled={personaBusy}>
          {personaBusy ? 'Refreshing...' : 'Refresh Persona'}
        </button>
      </div>
      {personaStatus && <div className="chat-persona-status">{personaStatus}</div>}
      <div className="identity-fidelity-card">
        <div>
          <h3>Identity Fidelity</h3>
          <p>
            Facts used: {latestIdentityDebug?.identity_facts_used ?? 0} · Snapshot:{' '}
            {latestIdentityDebug?.identity_snapshot_used ? 'available' : 'not used'}
          </p>
          {latestIdentityDebug?.identity_confidence_warnings?.slice(0, 2).map((warning) => (
            <span key={warning} className="chat-warning">{warning}</span>
          ))}
          {identityStatus && <span className="chat-persona-status">{identityStatus}</span>}
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => void refreshIdentity()} disabled={identityBusy}>
          {identityBusy ? 'Refreshing...' : 'Refresh Identity'}
        </button>
      </div>
      <div className="identity-fidelity-card">
        <div>
          <h3>Communication Style</h3>
          <p>
            Intent: {latestCommunicationDebug?.communication_intent ?? 'none'} · Patterns:{' '}
            {latestCommunicationDebug?.communication_pattern_ids?.length ?? 0}
          </p>
          {communicationStatus && <span className="chat-persona-status">{communicationStatus}</span>}
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => void refreshCommunicationStyle()} disabled={communicationBusy}>
          {communicationBusy ? 'Refreshing...' : 'Refresh Communication Style'}
        </button>
      </div>

      <div className="chat-thread">
        {messages.length === 0 && (
          <div className="chat-empty">
            <h3>Tanya brain kamu</h3>
            <p>Contoh: apa project yang paling sering saya pikirkan, atau apa hubungan Obsidian dengan Personal Brain OS?</p>
          </div>
        )}

        {messages.map((message) => (
          <article key={message.id} className="chat-message">
            <div className="chat-bubble chat-bubble--user">
              <span className="chat-bubble__label">You</span>
              <p>{message.question}</p>
            </div>

            <div className="chat-bubble chat-bubble--agent">
              <div className="chat-bubble__top">
                <span className="chat-bubble__label">Brain Reader</span>
                {message.response && (
                  <button type="button" className="btn btn--ghost" onClick={() => void copyAnswer(message.response!)}>
                    Copy
                  </button>
                )}
              </div>

              {!message.response && !message.error && <p className="muted">Membaca memory...</p>}
              {message.error && <p className="status status--err">{message.error}</p>}
              {message.response && (
                <BrainAnswer response={message.response} />
              )}
            </div>
          </article>
        ))}
      </div>

      <form className="chat-input" onSubmit={submit}>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Tanya sesuatu berdasarkan diary, node, edge, dan memory..."
          rows={3}
          maxLength={2000}
          disabled={busy}
        />
        <div className="chat-input__actions">
          <span className={currentQuestion.length > 1900 ? 'chat-input__count chat-input__count--warn' : 'chat-input__count'}>
            {currentQuestion.length}/2000
          </span>
          <button type="submit" className="btn btn--primary" disabled={disabled}>
            {busy ? 'Asking...' : 'Ask Brain'}
          </button>
        </div>
      </form>
    </section>
  )
}

function BrainAnswer({ response }: { response: BrainChatResponse }) {
  const [showDebug, setShowDebug] = useState(false)
  const intentType = response.intent_type ?? response.debug?.intent_type
  const inferenceMode = response.inference_mode ?? response.debug?.inference_mode
  const responseShape = response.response_shape ?? response.debug?.response_shape
  const isSocialGreeting = response.debug?.is_social_greeting === true || intentType === 'social_greeting'
  const isPromptRequest = intentType === 'request_prompt' || responseShape?.format === 'writing_block'
  const showDiagnostics = !isSocialGreeting
  const runtime = response.entity_runtime

  return (
    <div className="brain-answer">
      {showDiagnostics && response.warnings?.map((warning) => (
        <div key={warning} className="chat-warning">{warning}</div>
      ))}
      {(intentType || inferenceMode) && (
        <div className="chat-inference-badges">
          {intentType && <span className="persona-badge">Intent: {formatPersonaMode(intentType)}</span>}
          {inferenceMode && <span className="persona-badge">Mode: {formatPersonaMode(inferenceMode)}</span>}
          {response.drift_guard && response.drift_guard.risk_level !== 'safe' && (
            <span className={`drift-badge drift-badge--${response.drift_guard.risk_level}`}>
              Drift: {response.drift_guard.risk_level}
            </span>
          )}
          {runtime?.enabled && (
            <span className="persona-badge">Runtime: {formatPersonaMode(runtime.runtime_mode ?? 'read_only')}</span>
          )}
        </div>
      )}
      {runtime?.action_blocked && (
        <div className="runtime-block-card">
          <strong>Action blocked</strong>
          <span>Proposal: {runtime.proposal_title ?? runtime.proposal_id ?? 'created for review'}</span>
          <span>Approval: {runtime.required_approval_level ?? 'explicit_confirm'}</span>
          {runtime.policy_warnings?.slice(0, 2).map((warning) => <small key={warning}>{warning}</small>)}
        </div>
      )}
      {showDiagnostics && response.style_warnings?.map((warning) => (
        <div key={warning} className="chat-warning">{warning}</div>
      ))}
      {isPromptRequest ? (
        <pre className="brain-answer__artifact">{response.answer}</pre>
      ) : (
        <p className="brain-answer__text">{response.answer}</p>
      )}
      {response.debug && (
        <button type="button" className="chat-debug-toggle" onClick={() => setShowDebug((value) => !value)}>
          {showDebug ? 'Hide inference debug' : 'Show inference debug'}
        </button>
      )}
      {showDiagnostics && (
        <div className="brain-answer__meta">
        <span>Confidence: {response.confidence === null ? '—' : response.confidence.toFixed(2)}</span>
        {response.debug && (
          <span>
            Retrieved: {response.debug.retrieved_memories} memories · {response.debug.retrieved_nodes} nodes · {response.debug.retrieved_edges} edges
          </span>
        )}
        </div>
      )}
      {response.debug && showDebug && (
        <div className="brain-answer__debug">
          {intentType && <span>Intent: {intentType}</span>}
          {inferenceMode && <span>Inference mode: {inferenceMode}</span>}
          {response.response_inference_log_id && <span>Inference log: {response.response_inference_log_id}</span>}
          <span>Owner calibration: {response.owner_calibration_used ? 'used' : 'not used'}</span>
          {response.owner_calibration_hint_ids && <span>Owner hint ids: {response.owner_calibration_hint_ids.join(', ') || 'none'}</span>}
          <span>Methods: {response.debug.retrieval_methods?.join(', ') || 'keyword'}</span>
          <span>Semantic hits: {response.debug.semantic_hits ?? 0}</span>
          <span>Keyword hits: {response.debug.keyword_hits ?? 0}</span>
          <span>Persona profile: {response.debug.persona_profile_used ? 'used' : 'missing'}</span>
          <span>Identity facts: {response.debug.identity_facts_used ?? 0}</span>
          {response.debug.communication_intent && <span>Communication intent: {response.debug.communication_intent}</span>}
          {response.debug.communication_pattern_ids && <span>Communication patterns: {response.debug.communication_pattern_ids.length}</span>}
          {responseShape && <span>Response shape: {JSON.stringify(responseShape)}</span>}
          {response.inference_scores && <span>Inference scores: {JSON.stringify(response.inference_scores)}</span>}
          {response.debug.identity_fact_ids && <span>Identity fact ids: {response.debug.identity_fact_ids.join(', ') || 'none'}</span>}
          {response.debug.inference_trace && <span>Inference trace: {JSON.stringify(response.debug.inference_trace)}</span>}
          {response.debug.owner_calibration_hints && <span>Owner calibration hints: {JSON.stringify(response.debug.owner_calibration_hints)}</span>}
          {response.drift_guard && <span>Drift guard: {JSON.stringify(response.drift_guard)}</span>}
          {response.debug.drift_guard && <span>Drift debug: {JSON.stringify(response.debug.drift_guard)}</span>}
          {response.entity_runtime && <span>Entity runtime: {JSON.stringify(response.entity_runtime)}</span>}
          {response.debug.retrieval_summary && <span>Retrieval summary: {JSON.stringify(response.debug.retrieval_summary)}</span>}
          {response.debug.identity_snapshot_used && <span>Identity snapshot: {response.debug.identity_snapshot_used}</span>}
          {response.persona_reason && <span>Mode reason: {response.persona_reason}</span>}
          {response.debug.semantic_warnings?.map((warning) => <span key={warning}>Warning: {warning}</span>)}
          {response.debug.identity_confidence_warnings?.map((warning) => <span key={warning}>Identity: {warning}</span>)}
          {response.debug.warnings_hidden_from_user?.map((warning) => <span key={warning}>Hidden: {warning}</span>)}
        </div>
      )}

      {showDiagnostics && response.basis.length > 0 && (
        <section>
          <h3>Basis</h3>
          <ul>
            {response.basis.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      {showDiagnostics && response.sources.length > 0 && (
        <section>
          <h3>Sources</h3>
          <div className="source-list">
            {response.sources.map((source) => (
              <div key={`${source.type}:${source.id}`} className="source-pill">
                <span>{source.type.replace('_', ' ')}</span>
                <strong>{source.label}</strong>
                {source.excerpt && <p>{source.excerpt}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {showDiagnostics && response.missing_context.length > 0 && (
        <section>
          <h3>Missing Context</h3>
          <ul>
            {response.missing_context.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      {showDiagnostics && response.suggested_next_actions.length > 0 && (
        <section>
          <h3>Next Actions</h3>
          <ul>
            {response.suggested_next_actions.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}
    </div>
  )
}

function formatPersonaMode(mode: string) {
  return mode.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}
