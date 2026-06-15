import { useEffect, useMemo, useState } from 'react'

interface EntityRuntimeProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

type RuntimePayload = {
  active_session?: Record<string, any> | null
  policies?: Array<Record<string, any>>
  latest_events?: Array<Record<string, any>>
  proposals?: Array<Record<string, any>>
  safety_report?: Record<string, any> | null
  summary?: Record<string, any>
}

export function EntityRuntime({ onNotify }: EntityRuntimeProps) {
  const [data, setData] = useState<RuntimePayload>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null)

  const policies = data.policies ?? []
  const proposals = data.proposals ?? []
  const events = data.latest_events ?? []
  const selectedProposal = useMemo(() => proposals.find((proposal) => proposal.id === selectedProposalId) ?? proposals[0] ?? null, [proposals, selectedProposalId])

  async function refresh() {
    const res = await fetch('/__entity-runtime/latest')
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca runtime.')
    setData(payload)
    if (!selectedProposalId && payload?.proposals?.[0]?.id) setSelectedProposalId(payload.proposals[0].id)
  }

  useEffect(() => {
    void refresh().catch((err) => onNotify?.('error', err instanceof Error ? err.message : 'Gagal membaca runtime.'))
  }, [])

  async function runAction(name: string, path: string, body: Record<string, unknown>, success: string) {
    if (busy) return
    setBusy(name)
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.message ?? 'Entity Runtime action gagal.')
      onNotify?.('success', success)
      await refresh()
    } catch (err) {
      onNotify?.('error', err instanceof Error ? err.message : 'Entity Runtime action gagal.')
    } finally {
      setBusy(null)
    }
  }

  async function reviewProposal(status: 'approved' | 'rejected' | 'ignored') {
    if (!selectedProposal) return
    await runAction('review', '/__entity-runtime/review-proposal', {
      proposalId: selectedProposal.id,
      status,
      reviewNote: status === 'approved' ? 'Approved for manual follow-up only. Step 28 does not execute actions.' : '',
    }, `Proposal ${status}. Tidak ada aksi eksternal dijalankan.`)
  }

  const runtimeMode = data.active_session?.runtime_mode ?? 'none'
  const enabledPolicies = policies.filter((policy) => policy.enabled)
  const criticalPolicies = enabledPolicies.filter((policy) => policy.severity === 'critical')
  const blockedEvents = events.filter((event) => event.blocked)

  return (
    <section className="runtime-view">
      <div className="chat-view__header">
        <div>
          <h2>Safe Entity Runtime</h2>
          <p>Read-only autonomy boundary: boleh membaca, menjawab, dan membuat proposal. Tidak mengeksekusi aksi eksternal.</p>
        </div>
        <div className="runtime-actions">
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('seed', '/__entity-runtime/seed-policies', { force: false }, 'Runtime policies seeded.')}>Seed Policies</button>
          <button className="btn btn--primary" disabled={Boolean(busy)} onClick={() => void runAction('start', '/__entity-runtime/start-session', { runtimeMode: 'read_only', sessionType: 'manual' }, 'Read-only session started.')}>Start Read-Only Session</button>
          <button className="btn btn--ghost" disabled={Boolean(busy) || !data.active_session?.id} onClick={() => void runAction('end', '/__entity-runtime/end-session', { sessionId: data.active_session?.id }, 'Session ended.')}>End Session</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void runAction('audit', '/__entity-runtime/audit', { save: true }, 'Runtime audit selesai.')}>Run Audit</button>
          <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
        </div>
      </div>

      <div className="runtime-status-grid">
        <div>
          <span>Runtime</span>
          <strong>{runtimeMode}</strong>
        </div>
        <div>
          <span>Active Session</span>
          <strong>{data.active_session?.id ? 'active' : 'none'}</strong>
        </div>
        <div>
          <span>Readiness</span>
          <strong>{data.active_session?.readiness_level ?? 'unknown'}</strong>
        </div>
        <div>
          <span>Safety</span>
          <strong>{data.safety_report?.status ?? data.summary?.safety_status ?? 'unreported'}</strong>
        </div>
      </div>

      <div className="runtime-layout">
        <section className="runtime-panel">
          <div className="panel-heading">
            <h3>Policy Summary</h3>
            <span>{enabledPolicies.length} enabled · {criticalPolicies.length} critical</span>
          </div>
          <div className="runtime-policy-list">
            {policies.map((policy) => (
              <div key={policy.id ?? policy.policy_name} className={`runtime-row ${policy.enabled ? '' : 'runtime-row--muted'}`}>
                <strong>{policy.policy_name}</strong>
                <span>{policy.policy_type} · {policy.severity} · priority {policy.priority}</span>
                {Array.isArray(policy.blocked_actions) && policy.blocked_actions.length > 0 && (
                  <small>Blocks: {policy.blocked_actions.slice(0, 3).join(', ')}</small>
                )}
              </div>
            ))}
            {policies.length === 0 && <p className="muted runtime-empty">Belum ada policy. Jalankan Seed Policies.</p>}
          </div>
        </section>

        <section className="runtime-panel">
          <div className="panel-heading">
            <h3>Runtime Events</h3>
            <span>{blockedEvents.length} blocked</span>
          </div>
          <div className="runtime-policy-list">
            {events.map((event) => (
              <div key={event.id} className={`runtime-row ${event.blocked ? 'runtime-row--blocked' : ''}`}>
                <strong>{event.event_type}</strong>
                <span>Risk {Number(event.risk_score ?? 0).toFixed(2)} · blocked {event.blocked ? 'yes' : 'no'} · approval {event.requires_approval ? 'yes' : 'no'}</span>
                <small>{event.event_summary}</small>
              </div>
            ))}
            {events.length === 0 && <p className="muted runtime-empty">Belum ada event runtime.</p>}
          </div>
        </section>
      </div>

      <div className="runtime-layout">
        <section className="runtime-panel">
          <div className="panel-heading">
            <h3>Action Proposals</h3>
            <span>{proposals.length} proposals</span>
          </div>
          <div className="runtime-policy-list">
            {proposals.map((proposal) => (
              <button key={proposal.id} type="button" className={`runtime-row runtime-proposal ${selectedProposal?.id === proposal.id ? 'runtime-row--active' : ''}`} onClick={() => setSelectedProposalId(proposal.id)}>
                <strong>{proposal.title}</strong>
                <span>{proposal.proposal_type} · {proposal.target_system} · risk {Number(proposal.risk_score ?? 0).toFixed(2)}</span>
                <small>{proposal.status} · approval {proposal.required_approval_level}</small>
              </button>
            ))}
            {proposals.length === 0 && <p className="muted runtime-empty">Belum ada proposal.</p>}
          </div>
        </section>

        <section className="runtime-panel runtime-detail">
          <div className="panel-heading">
            <h3>Proposal Detail</h3>
            {selectedProposal && <span>{selectedProposal.status}</span>}
          </div>
          {selectedProposal ? (
            <>
              <h4>{selectedProposal.title}</h4>
              <p>{selectedProposal.description}</p>
              <div className="runtime-meta">
                <span>{selectedProposal.proposal_type}</span>
                <span>{selectedProposal.target_system}</span>
                <span>{selectedProposal.required_approval_level}</span>
                <span>risk {Number(selectedProposal.risk_score ?? 0).toFixed(2)}</span>
              </div>
              <details><summary>Proposed action JSON</summary><pre>{JSON.stringify(selectedProposal.proposed_action ?? {}, null, 2)}</pre></details>
              <p className="muted">{selectedProposal.fidelity_reason}</p>
              <div className="runtime-actions">
                <button className="btn btn--primary" disabled={Boolean(busy)} onClick={() => void reviewProposal('approved')}>Approve</button>
                <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void reviewProposal('rejected')}>Reject</button>
                <button className="btn btn--ghost" disabled={Boolean(busy)} onClick={() => void reviewProposal('ignored')}>Ignore</button>
              </div>
              <p className="chat-warning">Approval di Step 28 hanya mengubah status proposal. Tidak ada aksi eksternal yang dieksekusi.</p>
            </>
          ) : (
            <p className="muted runtime-empty">Pilih proposal untuk melihat detail.</p>
          )}
        </section>
      </div>
    </section>
  )
}
