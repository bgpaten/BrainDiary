import { useMemo, useState } from 'react'
import type { BrainCluster, BrainEdge, BrainNode, ExtractionJobReview, NodeType, RawEntryReview } from '../types/brain'
import { NODE_TYPES } from '../types/brain'
import {
  findPossibleDuplicateNodes,
  getLowConfidenceEdges,
  getLowConfidenceNodes,
  getReviewStatus,
  withReviewStatus,
} from '../lib/brainQuality'

type NodePatch = Partial<Pick<
  BrainNode,
  'name' | 'canonical_name' | 'aliases' | 'summary' | 'description' | 'type' | 'importance_score' | 'confidence_score' | 'cluster_id' | 'metadata'
>>

type EdgePatch = Partial<Pick<BrainEdge, 'relation_type' | 'summary' | 'weight' | 'confidence_score' | 'metadata'>>

interface BrainQualityReviewProps {
  nodes: BrainNode[]
  edges: BrainEdge[]
  clusters: BrainCluster[]
  rawEntries: RawEntryReview[]
  extractionJobs: ExtractionJobReview[]
  busy: boolean
  onRefresh: () => void
  onUpdateNode: (node: BrainNode, patch: NodePatch) => Promise<void>
  onUpdateEdge: (edge: BrainEdge, patch: EdgePatch) => Promise<void>
  onMergeNode: (sourceNodeId: string, targetNodeId: string) => Promise<void>
  onDeleteNode: (nodeId: string) => Promise<void>
  onDeleteEdge: (edgeId: string) => Promise<void>
  onRetryEntry: (rawEntryId: string) => Promise<void>
}

export function BrainQualityReview({
  nodes,
  edges,
  clusters,
  rawEntries,
  extractionJobs,
  busy,
  onRefresh,
  onUpdateNode,
  onUpdateEdge,
  onMergeNode,
  onDeleteNode,
  onDeleteEdge,
  onRetryEntry,
}: BrainQualityReviewProps) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null)
  const duplicates = useMemo(() => findPossibleDuplicateNodes(nodes), [nodes])
  const lowNodes = useMemo(() => getLowConfidenceNodes(nodes), [nodes])
  const lowEdges = useMemo(() => getLowConfidenceEdges(edges), [edges])
  const nameById = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes])

  return (
    <div className="review-view">
      <div className="review-view__header">
        <div>
          <h2>Brain Quality Control</h2>
          <p>Review node/edge rendah confidence, duplicate candidate, dan extraction yang gagal.</p>
        </div>
        <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
          {busy ? 'Refreshing...' : 'Quality Refresh'}
        </button>
      </div>

      <section className="review-section">
        <SectionTitle title="Possible Duplicates" count={duplicates.length} />
        {duplicates.length === 0 && <p className="muted">Belum ada kandidat duplicate.</p>}
        <div className="review-list">
          {duplicates.map(({ a, b, score, reasons }) => (
            <article key={`${a.id}:${b.id}`} className="review-card">
              <div className="review-card__main">
                <span className="review-card__kicker">{a.type} · similarity {score}</span>
                <h3>{a.name} <span className="muted">vs</span> {b.name}</h3>
                <p className="muted">{reasons.join(', ')}</p>
                <p className="review-card__meta">
                  {a.canonical_name} · {b.canonical_name}
                </p>
              </div>
              <div className="review-card__actions">
                <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onMergeNode(b.id, a.id)}>
                  Merge into {a.name}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => onMergeNode(a.id, b.id)}>
                  Merge into {b.name}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => Promise.all([
                    onUpdateNode(a, { metadata: withReviewStatus(a.metadata, 'ignored', `Duplicate pair ignored with ${b.id}`) }),
                    onUpdateNode(b, { metadata: withReviewStatus(b.metadata, 'ignored', `Duplicate pair ignored with ${a.id}`) }),
                  ]).then(() => undefined)}
                >
                  Ignore
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="review-section">
        <SectionTitle title="Low Confidence Nodes" count={lowNodes.length} />
        {lowNodes.length === 0 && <p className="muted">Tidak ada node confidence rendah.</p>}
        <div className="review-list">
          {lowNodes.map((node) => (
            <article key={node.id} className="review-card">
              {editingNodeId === node.id ? (
                <NodeEditForm
                  node={node}
                  clusters={clusters}
                  busy={busy}
                  onCancel={() => setEditingNodeId(null)}
                  onSave={(patch) => onUpdateNode(node, patch).then(() => setEditingNodeId(null))}
                />
              ) : (
                <>
                  <div className="review-card__main">
                    <span className="review-card__kicker">{node.type} · confidence {node.confidence_score ?? '—'} · {getReviewStatus(node)}</span>
                    <h3>{node.name}</h3>
                    <p>{node.summary ?? node.description ?? 'Tidak ada summary.'}</p>
                    <p className="review-card__meta">Canonical: {node.canonical_name}</p>
                  </div>
                  <div className="review-card__actions">
                    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onUpdateNode(node, { metadata: withReviewStatus(node.metadata, 'approved', 'Node confirmed by user.') })}>
                      Approve
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setEditingNodeId(node.id)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onUpdateNode(node, { metadata: withReviewStatus(node.metadata, 'ignored', 'Node ignored by user.') })}>
                      Ignore
                    </button>
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => onDeleteNode(node.id)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="review-section">
        <SectionTitle title="Low Confidence Edges" count={lowEdges.length} />
        {lowEdges.length === 0 && <p className="muted">Tidak ada edge confidence rendah.</p>}
        <div className="review-list">
          {lowEdges.map((edge) => (
            <article key={edge.id} className="review-card">
              {editingEdgeId === edge.id ? (
                <EdgeEditForm
                  edge={edge}
                  busy={busy}
                  onCancel={() => setEditingEdgeId(null)}
                  onSave={(patch) => onUpdateEdge(edge, patch).then(() => setEditingEdgeId(null))}
                />
              ) : (
                <>
                  <div className="review-card__main">
                    <span className="review-card__kicker">confidence {edge.confidence_score ?? '—'} · {getReviewStatus(edge)}</span>
                    <h3>{nameById.get(edge.from_node_id) ?? edge.from_node_id} → {edge.relation_type} → {nameById.get(edge.to_node_id) ?? edge.to_node_id}</h3>
                    <p>{edge.summary ?? 'Tidak ada summary.'}</p>
                  </div>
                  <div className="review-card__actions">
                    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onUpdateEdge(edge, { metadata: withReviewStatus(edge.metadata, 'approved', 'Edge confirmed by user.') })}>
                      Approve
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setEditingEdgeId(edge.id)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onUpdateEdge(edge, { metadata: withReviewStatus(edge.metadata, 'ignored', 'Edge ignored by user.') })}>
                      Ignore
                    </button>
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => onDeleteEdge(edge.id)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="review-section">
        <SectionTitle title="Failed Entries" count={rawEntries.length + extractionJobs.length} />
        {rawEntries.length === 0 && extractionJobs.length === 0 && <p className="muted">Tidak ada raw entry atau extraction job gagal.</p>}
        <div className="review-list">
          {rawEntries.map((entry) => (
            <article key={entry.id} className="review-card">
              <div className="review-card__main">
                <span className="review-card__kicker">raw_entries · {entry.processing_status}</span>
                <h3>{entry.title ?? entry.id}</h3>
                <p>{entry.content?.slice(0, 180) ?? 'Tidak ada content.'}</p>
              </div>
              <div className="review-card__actions">
                <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onRetryEntry(entry.id)}>
                  Retry
                </button>
              </div>
            </article>
          ))}
          {extractionJobs.map((job) => (
            <article key={job.id} className="review-card">
              <div className="review-card__main">
                <span className="review-card__kicker">extraction_jobs · {job.status}</span>
                <h3>{job.raw_entry_id ?? job.id}</h3>
                <p>{job.error_message ?? 'Tidak ada error_message.'}</p>
              </div>
              {job.raw_entry_id && (
                <div className="review-card__actions">
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onRetryEntry(job.raw_entry_id!)}>
                    Retry
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="review-section__title">
      <h3>{title}</h3>
      <span>{count}</span>
    </div>
  )
}

function NodeEditForm({
  node,
  clusters,
  busy,
  onCancel,
  onSave,
}: {
  node: BrainNode
  clusters: BrainCluster[]
  busy: boolean
  onCancel: () => void
  onSave: (patch: NodePatch) => Promise<void>
}) {
  const [name, setName] = useState(node.name)
  const [canonicalName, setCanonicalName] = useState(node.canonical_name)
  const [aliases, setAliases] = useState((node.aliases ?? []).join(', '))
  const [summary, setSummary] = useState(node.summary ?? '')
  const [description, setDescription] = useState(node.description ?? '')
  const [type, setType] = useState<NodeType>(node.type)
  const [importanceScore, setImportanceScore] = useState(String(node.importance_score ?? ''))
  const [confidenceScore, setConfidenceScore] = useState(String(node.confidence_score ?? ''))
  const [clusterId, setClusterId] = useState(node.cluster_id ?? '')

  return (
    <form className="review-form" onSubmit={(event) => {
      event.preventDefault()
      void onSave({
        name,
        canonical_name: canonicalName,
        aliases: aliases.split(',').map((value) => value.trim()).filter(Boolean),
        summary: summary || null,
        description: description || null,
        type,
        importance_score: toNumberOrNull(importanceScore),
        confidence_score: toNumberOrNull(confidenceScore),
        cluster_id: clusterId || null,
        metadata: withReviewStatus(node.metadata, 'approved', 'Node edited and approved by user.'),
      })
    }}>
      <div className="review-form__grid">
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Canonical<input value={canonicalName} onChange={(event) => setCanonicalName(event.target.value)} /></label>
        <label>Type<select value={type} onChange={(event) => setType(event.target.value as NodeType)}>{NODE_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>Cluster<select value={clusterId} onChange={(event) => setClusterId(event.target.value)}><option value="">No cluster</option>{clusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.name}</option>)}</select></label>
        <label>Importance<input type="number" step="0.01" value={importanceScore} onChange={(event) => setImportanceScore(event.target.value)} /></label>
        <label>Confidence<input type="number" step="0.01" value={confidenceScore} onChange={(event) => setConfidenceScore(event.target.value)} /></label>
      </div>
      <label>Aliases<input value={aliases} onChange={(event) => setAliases(event.target.value)} /></label>
      <label>Summary<textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
      <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="review-form__actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>Save</button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

function EdgeEditForm({
  edge,
  busy,
  onCancel,
  onSave,
}: {
  edge: BrainEdge
  busy: boolean
  onCancel: () => void
  onSave: (patch: EdgePatch) => Promise<void>
}) {
  const [relationType, setRelationType] = useState(edge.relation_type)
  const [summary, setSummary] = useState(edge.summary ?? '')
  const [weight, setWeight] = useState(String(edge.weight ?? ''))
  const [confidenceScore, setConfidenceScore] = useState(String(edge.confidence_score ?? ''))

  return (
    <form className="review-form" onSubmit={(event) => {
      event.preventDefault()
      void onSave({
        relation_type: relationType,
        summary: summary || null,
        weight: toNumberOrNull(weight),
        confidence_score: toNumberOrNull(confidenceScore),
        metadata: withReviewStatus(edge.metadata, 'approved', 'Edge edited and approved by user.'),
      })
    }}>
      <div className="review-form__grid">
        <label>Relation<input value={relationType} onChange={(event) => setRelationType(event.target.value)} /></label>
        <label>Weight<input type="number" step="0.01" value={weight} onChange={(event) => setWeight(event.target.value)} /></label>
        <label>Confidence<input type="number" step="0.01" value={confidenceScore} onChange={(event) => setConfidenceScore(event.target.value)} /></label>
      </div>
      <label>Summary<textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
      <div className="review-form__actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>Save</button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

function toNumberOrNull(value: string): number | null {
  if (!value.trim()) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
