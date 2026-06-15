import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { BrainEdge, BrainNode, RawEntryTimelineItem } from '../types/brain'

const RAW_ENTRY_COLUMNS = 'id,title,content,source_origin,source_type,happened_at,processing_status,obsidian_path,created_at'

type PeriodFilter = 'today' | '7d' | '30d'
type TimelineKind = 'raw_entry' | 'event' | 'decision' | 'goal' | 'pattern' | 'project'

interface TimelineItem {
  id: string
  kind: TimelineKind
  date: string
  title: string
  subtitle: string
  detail: string
  confidence?: number | null
}

interface BrainTimelineProps {
  nodes: BrainNode[]
  edges: BrainEdge[]
}

export function BrainTimeline({ nodes, edges }: BrainTimelineProps) {
  const [rawEntries, setRawEntries] = useState<RawEntryTimelineItem[]>([])
  const [filter, setFilter] = useState<PeriodFilter>('7d')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchRawEntries = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: fetchError } = await supabase
      .from('raw_entries')
      .select(RAW_ENTRY_COLUMNS)
      .order('happened_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(120)
    setLoading(false)
    if (fetchError) {
      setError(fetchError.message)
      return
    }
    setRawEntries((data ?? []) as RawEntryTimelineItem[])
  }, [])

  useEffect(() => {
    void fetchRawEntries()
  }, [fetchRawEntries])

  const items = useMemo(() => {
    const range = rangeForFilter(filter)
    const timeline: TimelineItem[] = [
      ...rawEntries.map(rawEntryToTimelineItem),
      ...nodes.flatMap((node) => nodeToTimelineItems(node, edges)),
    ]
      .filter((item) => item.date >= range.start && item.date <= range.end)
      .sort((a, b) => b.date.localeCompare(a.date) || kindRank(a.kind) - kindRank(b.kind))
    return timeline
  }, [edges, filter, nodes, rawEntries])

  const grouped = useMemo(() => {
    const map = new Map<string, TimelineItem[]>()
    for (const item of items) {
      if (!map.has(item.date)) map.set(item.date, [])
      map.get(item.date)!.push(item)
    }
    return [...map.entries()]
  }, [items])

  const selected = items.find((item) => `${item.kind}:${item.id}` === selectedId) ?? null

  return (
    <section className="timeline-view">
      <div className="timeline-view__header">
        <div>
          <h2>Timeline Intelligence</h2>
          <p>Perubahan brain berdasarkan diary, event, decision, goal, pattern, dan project aktif.</p>
        </div>
        <div className="digest-actions">
          {(['today', '7d', '30d'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`chip ${filter === item ? 'chip--active' : ''}`}
              onClick={() => setFilter(item)}
            >
              {item === 'today' ? 'Today' : item === '7d' ? '7 days' : '30 days'}
            </button>
          ))}
          <button type="button" className="btn btn--ghost" onClick={() => void fetchRawEntries()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      <div className="timeline-layout">
        <main className="timeline-list">
          {loading && <p className="muted">Memuat timeline...</p>}
          {error && <p className="status status--err">{error}</p>}
          {!loading && grouped.length === 0 && (
            <div className="digest-empty">
              <h3>Timeline kosong</h3>
              <p>Tidak ada raw entry atau node tanggal aktif pada filter periode ini.</p>
            </div>
          )}
          {grouped.map(([date, dayItems]) => (
            <section key={date} className="timeline-day">
              <h3>{date}</h3>
              <div className="timeline-day__items">
                {dayItems.map((item) => {
                  const key = `${item.kind}:${item.id}`
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`timeline-item ${selectedId === key ? 'timeline-item--active' : ''}`}
                      onClick={() => setSelectedId(key)}
                    >
                      <span>{labelForKind(item.kind)}</span>
                      <strong>{item.title}</strong>
                      <small>{item.subtitle}</small>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </main>

        <aside className="timeline-detail">
          {selected ? (
            <article>
              <span className="review-status">{labelForKind(selected.kind)}</span>
              <h2>{selected.title}</h2>
              <p className="muted">{selected.date} · {selected.subtitle}</p>
              <p>{selected.detail || 'Tidak ada detail.'}</p>
              {selected.confidence !== undefined && (
                <div className="brain-answer__meta">
                  <span>Confidence: {selected.confidence === null ? '—' : selected.confidence.toFixed(2)}</span>
                </div>
              )}
            </article>
          ) : (
            <p className="muted">Pilih item timeline untuk melihat detail.</p>
          )}
        </aside>
      </div>
    </section>
  )
}

function rawEntryToTimelineItem(entry: RawEntryTimelineItem): TimelineItem {
  return {
    id: entry.id,
    kind: 'raw_entry',
    date: dateOnly(entry.happened_at ?? entry.created_at),
    title: entry.title || 'Untitled raw entry',
    subtitle: `${entry.source_origin ?? 'unknown'} · ${entry.processing_status ?? 'unknown'}`,
    detail: excerpt(entry.content, 900),
  }
}

function nodeToTimelineItems(node: BrainNode, edges: BrainEdge[]): TimelineItem[] {
  const date = dateOnly(node.last_seen_at ?? node.first_seen_at)
  if (!date) return []
  if (!['event', 'decision', 'goal', 'pattern', 'project'].includes(node.type)) return []
  const connectedEdges = edges.filter((edge) => edge.from_node_id === node.id || edge.to_node_id === node.id).length
  return [{
    id: node.id,
    kind: node.type as TimelineKind,
    date,
    title: node.canonical_name || node.name,
    subtitle: `${node.type} · ${connectedEdges} relations · freq ${node.frequency_score ?? 0}`,
    detail: node.summary || node.description || '',
    confidence: node.confidence_score,
  }]
}

function rangeForFilter(filter: PeriodFilter) {
  const end = dateOnly(new Date())
  const startDate = new Date(`${end}T00:00:00.000Z`)
  if (filter === 'today') return { start: end, end }
  startDate.setUTCDate(startDate.getUTCDate() - (filter === '7d' ? 6 : 29))
  return { start: dateOnly(startDate), end }
}

function dateOnly(value: string | Date | null | undefined) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

function excerpt(value: string | null | undefined, max: number) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function labelForKind(kind: TimelineKind) {
  return kind.replace('_', ' ')
}

function kindRank(kind: TimelineKind) {
  return ['raw_entry', 'event', 'decision', 'goal', 'pattern', 'project'].indexOf(kind)
}
