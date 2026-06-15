import type { BrainCluster, NodeType } from '../types/brain'
import { NODE_TYPES } from '../types/brain'

interface BrainToolbarProps {
  clusters: BrainCluster[]
  selectedTypes: Set<NodeType>
  selectedClusterId: string | null
  onToggleType: (type: NodeType) => void
  onClearTypes: () => void
  onSelectCluster: (clusterId: string | null) => void
  onRefresh: () => void
  loading: boolean
  nodeCount: number
  edgeCount: number
}

// Controls di sidebar: filter type/cluster, refresh, dan count graph.
export function BrainToolbar({
  clusters,
  selectedTypes,
  selectedClusterId,
  onToggleType,
  onClearTypes,
  onSelectCluster,
  onRefresh,
  loading,
  nodeCount,
  edgeCount,
}: BrainToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar__row">
        <span className="toolbar__label">Filter Type</span>
        <div className="toolbar__chips">
          <button
            type="button"
            className={`chip ${selectedTypes.size === 0 ? 'chip--active' : ''}`}
            onClick={onClearTypes}
          >
            Semua
          </button>
          {NODE_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className={`chip ${selectedTypes.has(type) ? 'chip--active' : ''}`}
              onClick={() => onToggleType(type)}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      <div className="toolbar__row">
        <span className="toolbar__label">Filter Cluster</span>
        <select
          className="toolbar__select"
          value={selectedClusterId ?? ''}
          onChange={(e) => onSelectCluster(e.target.value || null)}
        >
          <option value="">Semua cluster</option>
          {clusters
            .slice()
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>

        <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Memuat...' : 'Refresh'}
        </button>

        <span className="toolbar__count">
          {nodeCount} node / {edgeCount} edge
        </span>
      </div>
    </div>
  )
}
