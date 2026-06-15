import type { BrainCluster, BrainEdge, BrainNode } from '../types/brain'
import { relationsForNode } from '../lib/brainGraphMapper'
import { getReviewStatus } from '../lib/brainQuality'

interface BrainNodeDetailPanelProps {
  node: BrainNode
  allNodes: BrainNode[]
  edges: BrainEdge[]
  clusters: BrainCluster[]
  possibleDuplicate: boolean
  onClose: () => void
}

function fmtDate(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

function fmtScore(value: number | null): string {
  return value === null || value === undefined ? '—' : String(value)
}

// Panel detail saat sebuah node diklik. Menampilkan atribut node + ringkasan
// relasi masuk/keluar dan daftar relasi terkait.
export function BrainNodeDetailPanel({
  node,
  allNodes,
  edges,
  clusters,
  possibleDuplicate,
  onClose,
}: BrainNodeDetailPanelProps) {
  const { incoming, outgoing } = relationsForNode(node.id, edges)
  const nameById = new Map(allNodes.map((n) => [n.id, n.name]))
  const cluster = clusters.find((c) => c.id === node.cluster_id) ?? null

  return (
    <aside className="detail-panel">
      <div className="detail-panel__header">
        <div>
          <span className={`badge badge--${node.type}`}>{node.type}</span>
          <h2 className="detail-panel__title">{node.name}</h2>
        </div>
        <button type="button" className="detail-panel__close" onClick={onClose} aria-label="Tutup">
          ✕
        </button>
      </div>

      <div className="detail-panel__body">
        {node.summary && (
          <section>
            <h3>Summary</h3>
            <p>{node.summary}</p>
          </section>
        )}

        <section className="detail-alerts">
          <span className={`review-status review-status--${getReviewStatus(node)}`}>
            Review: {getReviewStatus(node)}
          </span>
          {(node.confidence_score ?? 1) < 0.7 && (
            <span className="detail-warning">Low confidence</span>
          )}
          {possibleDuplicate && (
            <span className="detail-warning">Possible duplicate</span>
          )}
        </section>

        {node.description && (
          <section>
            <h3>Description</h3>
            <p>{node.description}</p>
          </section>
        )}

        <section className="detail-grid">
          <div>
            <span className="detail-grid__k">Importance</span>
            <span className="detail-grid__v">{fmtScore(node.importance_score)}</span>
          </div>
          <div>
            <span className="detail-grid__k">Frequency</span>
            <span className="detail-grid__v">{fmtScore(node.frequency_score)}</span>
          </div>
          <div>
            <span className="detail-grid__k">Confidence</span>
            <span className="detail-grid__v">{fmtScore(node.confidence_score)}</span>
          </div>
          <div>
            <span className="detail-grid__k">Canonical</span>
            <span className="detail-grid__v">{node.canonical_name}</span>
          </div>
          <div>
            <span className="detail-grid__k">Aliases</span>
            <span className="detail-grid__v">{node.aliases?.join(', ') || '—'}</span>
          </div>
          <div>
            <span className="detail-grid__k">Cluster</span>
            <span className="detail-grid__v">{cluster ? cluster.name : '—'}</span>
          </div>
          <div>
            <span className="detail-grid__k">First seen</span>
            <span className="detail-grid__v">{fmtDate(node.first_seen_at)}</span>
          </div>
          <div>
            <span className="detail-grid__k">Last seen</span>
            <span className="detail-grid__v">{fmtDate(node.last_seen_at)}</span>
          </div>
        </section>

        <section>
          <h3>
            Relasi <span className="muted">({incoming.length} masuk · {outgoing.length} keluar)</span>
          </h3>

          {outgoing.length > 0 && (
            <>
              <h4 className="rel-subhead">Keluar →</h4>
              <ul className="rel-list">
                {outgoing.map((e) => (
                  <li key={e.id}>
                    <span className="rel-type">{e.relation_type}</span>
                    <span className="rel-arrow">→</span>
                    <span className="rel-target">{nameById.get(e.to_node_id) ?? e.to_node_id}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {incoming.length > 0 && (
            <>
              <h4 className="rel-subhead">← Masuk</h4>
              <ul className="rel-list">
                {incoming.map((e) => (
                  <li key={e.id}>
                    <span className="rel-target">{nameById.get(e.from_node_id) ?? e.from_node_id}</span>
                    <span className="rel-arrow">→</span>
                    <span className="rel-type">{e.relation_type}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {incoming.length === 0 && outgoing.length === 0 && (
            <p className="muted">Belum ada relasi untuk node ini.</p>
          )}
        </section>
      </div>
    </aside>
  )
}
