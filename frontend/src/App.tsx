import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, supabaseConfigured } from './lib/supabase'
import { processPending } from './lib/brainEngine'
import { buildGraphElements } from './lib/brainGraphMapper'
import { DEV_FALLBACK_DATA, useDevFallback } from './lib/devFallbackData'
import type { BrainCluster, BrainData, BrainEdge, BrainNode, ExtractionJobReview, NodeType, RawEntryReview } from './types/brain'
import { findPossibleDuplicateNodes } from './lib/brainQuality'
import type { ElementDefinition } from 'cytoscape'
import { BrainToolbar } from './components/BrainToolbar'
import { EmptyBrainState } from './components/EmptyBrainState'
import { LoginRequired } from './components/LoginRequired'
import { Icon, type IconName } from './components/Icon'
import { BottomCommandDock } from './components/layout/BottomCommandDock'

const BrainVisualizer = lazy(() => import('./components/BrainVisualizer').then((module) => ({ default: module.BrainVisualizer })))
const BrainNodeDetailPanel = lazy(() => import('./components/BrainNodeDetailPanel').then((module) => ({ default: module.BrainNodeDetailPanel })))
const BrainQualityReview = lazy(() => import('./components/BrainQualityReview').then((module) => ({ default: module.BrainQualityReview })))
const BrainChat = lazy(() => import('./components/BrainChat').then((module) => ({ default: module.BrainChat })))
const BrainBackup = lazy(() => import('./components/BrainBackup').then((module) => ({ default: module.BrainBackup })))
const BrainDigest = lazy(() => import('./components/BrainDigest').then((module) => ({ default: module.BrainDigest })))
const BrainEvaluation = lazy(() => import('./components/BrainEvaluation').then((module) => ({ default: module.BrainEvaluation })))
const BrainRoutine = lazy(() => import('./components/BrainRoutine').then((module) => ({ default: module.BrainRoutine })))
const BrainTimeline = lazy(() => import('./components/BrainTimeline').then((module) => ({ default: module.BrainTimeline })))
const OwnerCalibration = lazy(() => import('./components/OwnerCalibration').then((module) => ({ default: module.OwnerCalibration })))
const SimilarityEvaluation = lazy(() => import('./components/SimilarityEvaluation').then((module) => ({ default: module.SimilarityEvaluation })))
const DriftControl = lazy(() => import('./components/DriftControl').then((module) => ({ default: module.DriftControl })))
const SelfReflection = lazy(() => import('./components/SelfReflection').then((module) => ({ default: module.SelfReflection })))
const ChatSampleImporter = lazy(() => import('./components/ChatSampleImporter').then((module) => ({ default: module.ChatSampleImporter })))
const IdentityConflicts = lazy(() => import('./components/IdentityConflicts').then((module) => ({ default: module.IdentityConflicts })))
const SelfCloneEvaluation = lazy(() => import('./components/SelfCloneEvaluation').then((module) => ({ default: module.SelfCloneEvaluation })))
const EntityRuntime = lazy(() => import('./components/EntityRuntime').then((module) => ({ default: module.EntityRuntime })))
const LongTermMemory = lazy(() => import('./components/LongTermMemory').then((module) => ({ default: module.LongTermMemory })))
const FinalRelease = lazy(() => import('./components/FinalRelease').then((module) => ({ default: module.FinalRelease })))

// Kolom yang dibaca (sesuai task Fase 4).
const NODE_COLUMNS =
  'id,type,name,canonical_name,aliases,summary,description,importance_score,frequency_score,confidence_score,cluster_id,first_seen_at,last_seen_at,metadata'
const EDGE_COLUMNS =
  'id,from_node_id,to_node_id,relation_type,summary,weight,confidence_score,valid_at,invalid_at,metadata'
const CLUSTER_COLUMNS = 'id,name,slug,description,color_key,priority'
const RAW_ENTRY_REVIEW_COLUMNS = 'id,title,content,processing_status,created_at'
const EXTRACTION_JOB_REVIEW_COLUMNS = 'id,raw_entry_id,status,error_message,created_at,finished_at'
const obsidianImporterEnabled = import.meta.env.VITE_OBSIDIAN_IMPORTER_ENABLED === 'true'
const attachmentImporterEnabled = import.meta.env.VITE_ATTACHMENT_IMPORTER_ENABLED !== 'false'
const brainIndexerEnabled = import.meta.env.VITE_BRAIN_INDEXER_ENABLED !== 'false'
const obsidianSyncEnabled = import.meta.env.VITE_OBSIDIAN_SYNC_ENABLED !== 'false'
const brainRoutineEnabled = import.meta.env.VITE_BRAIN_ROUTINE_ENABLED !== 'false'
const brainBackupEnabled = import.meta.env.VITE_BRAIN_BACKUP_ENABLED !== 'false'
const chatSampleImportEnabled = import.meta.env.VITE_CHAT_SAMPLE_IMPORT_ENABLED !== 'false'
const finalReleaseEnabled = import.meta.env.VITE_FINAL_RELEASE_ENABLED !== 'false'

type DataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: BrainData }

type ToastState = { id: number; kind: 'success' | 'error' | 'info'; message: string } | null
type ViewMode = 'graph' | 'review' | 'chat' | 'timeline' | 'digest' | 'evaluation' | 'routine' | 'backup' | 'calibration' | 'similarity' | 'drift' | 'reflection' | 'chat-samples' | 'conflicts' | 'self-clone-eval' | 'runtime' | 'long-term-memory' | 'final-release'
type QualityBusy = 'merge' | 'delete-node' | 'delete-edge' | 'update-node' | 'update-edge' | 'retry' | null

const MODE_META: Record<ViewMode, { title: string; subtitle: string; group: 'Core' | 'Identity' | 'System'; icon: IconName }> = {
  graph: { title: 'Graph', subtitle: 'Explore structured memory nodes and relationships.', group: 'Core', icon: 'graph' },
  review: { title: 'Review', subtitle: 'Resolve duplicates, low-confidence nodes, and failed extraction jobs.', group: 'Core', icon: 'review' },
  chat: { title: 'Chat', subtitle: 'Fidelity-first conversation with the personal entity.', group: 'Core', icon: 'chat' },
  timeline: { title: 'Timeline', subtitle: 'Scan memory chronology and temporal patterns.', group: 'Core', icon: 'timeline' },
  digest: { title: 'Digest', subtitle: 'Generate daily, weekly, and monthly brain reports.', group: 'Core', icon: 'digest' },
  evaluation: { title: 'Evaluation', subtitle: 'Run memory accuracy checks and inspect failed cases.', group: 'Identity', icon: 'evaluation' },
  calibration: { title: 'Calibration', subtitle: 'Compare owner answers against generated responses.', group: 'Identity', icon: 'calibration' },
  similarity: { title: 'Similarity', subtitle: 'Track response similarity and regressions.', group: 'Identity', icon: 'similarity' },
  drift: { title: 'Drift', subtitle: 'Guard against overclaim, source leaks, and too-AI phrasing.', group: 'Identity', icon: 'drift' },
  reflection: { title: 'Reflection', subtitle: 'Review self-reflection logs and evolution suggestions.', group: 'Identity', icon: 'reflection' },
  'chat-samples': { title: 'Chat Samples', subtitle: 'Import owner chat samples as communication evidence.', group: 'Identity', icon: 'chat-samples' },
  conflicts: { title: 'Conflicts', subtitle: 'Review identity tensions and contradiction guidance.', group: 'Identity', icon: 'conflicts' },
  routine: { title: 'Routine', subtitle: 'Run daily maintenance and health checks.', group: 'System', icon: 'routine' },
  backup: { title: 'Backup', subtitle: 'Create, inspect, and restore local-first backups.', group: 'System', icon: 'backup' },
  'self-clone-eval': { title: 'Self-Clone Eval', subtitle: 'Final evaluation suite for owner-response fidelity.', group: 'System', icon: 'self-clone' },
  runtime: { title: 'Runtime', subtitle: 'Read-only autonomy boundary and proposal queue.', group: 'System', icon: 'runtime' },
  'long-term-memory': { title: 'Long-Term Memory', subtitle: 'Consolidated evidence-bound memory state.', group: 'System', icon: 'memory' },
  'final-release': { title: 'Final Release', subtitle: 'Release readiness, blockers, artifacts, and notes.', group: 'System', icon: 'release' },
}

const MODE_GROUPS: Array<{ label: 'Core' | 'Identity' | 'System'; modes: ViewMode[] }> = [
  { label: 'Core', modes: ['graph', 'review', 'chat', 'timeline', 'digest'] },
  { label: 'Identity', modes: ['evaluation', 'calibration', 'similarity', 'drift', 'reflection', 'chat-samples', 'conflicts'] },
  { label: 'System', modes: ['routine', 'backup', 'self-clone-eval', 'runtime', 'long-term-memory', 'final-release'] },
]

interface ReviewData {
  rawEntries: RawEntryReview[]
  extractionJobs: ExtractionJobReview[]
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [dataState, setDataState] = useState<DataState>({ status: 'idle' })

  const [selectedTypes, setSelectedTypes] = useState<Set<NodeType>>(new Set())
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [headerOpen, setHeaderOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('graph')
  const [reviewData, setReviewData] = useState<ReviewData>({ rawEntries: [], extractionJobs: [] })
  const [pendingBusy, setPendingBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [indexBusy, setIndexBusy] = useState(false)
  const [qualityBusy, setQualityBusy] = useState<QualityBusy>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [toast, setToast] = useState<ToastState>(null)

  const notify = useCallback((kind: 'success' | 'error' | 'info', message: string) => {
    const next = { id: Date.now(), kind, message }
    setToast(next)
    window.setTimeout(() => {
      setToast((current) => (current?.id === next.id ? null : current))
    }, 4200)
  }, [])

  // --- Auth bootstrap -------------------------------------------------------
  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setAuthChecked(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      setAuthChecked(true)
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // --- Fetch brain data -----------------------------------------------------
  const fetchData = useCallback(async () => {
    // Mode dev fallback: pakai data lokal, tanpa Supabase. Jelas terpisah.
    if (useDevFallback) {
      setDataState({ status: 'ready', data: DEV_FALLBACK_DATA })
      return
    }
    if (!session) return

    setDataState({ status: 'loading' })
    try {
      const [nodesRes, edgesRes, clustersRes, rawEntriesRes, jobsRes] = await Promise.all([
        supabase.from('brain_nodes').select(NODE_COLUMNS),
        supabase.from('brain_edges').select(EDGE_COLUMNS),
        supabase.from('brain_clusters').select(CLUSTER_COLUMNS),
        supabase
          .from('raw_entries')
          .select(RAW_ENTRY_REVIEW_COLUMNS)
          .in('processing_status', ['needs_review', 'failed'])
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('extraction_jobs')
          .select(EXTRACTION_JOB_REVIEW_COLUMNS)
          .eq('status', 'failed')
          .order('created_at', { ascending: false })
          .limit(20),
      ])

      const firstError = nodesRes.error || edgesRes.error || clustersRes.error || rawEntriesRes.error || jobsRes.error
      if (firstError) {
        setDataState({ status: 'error', message: firstError.message })
        return
      }

      setDataState({
        status: 'ready',
        data: {
          nodes: (nodesRes.data ?? []) as BrainNode[],
          edges: (edgesRes.data ?? []) as BrainEdge[],
          clusters: (clustersRes.data ?? []) as BrainCluster[],
        },
      })
      setReviewData({
        rawEntries: (rawEntriesRes.data ?? []) as RawEntryReview[],
        extractionJobs: (jobsRes.data ?? []) as ExtractionJobReview[],
      })
    } catch (err) {
      setDataState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Gagal membaca Supabase.',
      })
    }
  }, [session])

  useEffect(() => {
    if (useDevFallback || session) void fetchData()
  }, [session, fetchData])

  // --- Derived --------------------------------------------------------------
  const data: BrainData = dataState.status === 'ready' ? dataState.data : { nodes: [], edges: [], clusters: [] }

  const elements: ElementDefinition[] = useMemo(
    () =>
      buildGraphElements(data.nodes, data.edges, data.clusters, {
        types: selectedTypes,
        clusterId: selectedClusterId,
      }),
    [data, selectedTypes, selectedClusterId],
  )

  const nodeCount = elements.filter((e) => !('source' in (e.data as Record<string, unknown>))).length
  const edgeCount = elements.length - nodeCount

  const selectedNode = useMemo(
    () => data.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [data.nodes, selectedNodeId],
  )

  const duplicateNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const pair of findPossibleDuplicateNodes(data.nodes)) {
      ids.add(pair.a.id)
      ids.add(pair.b.id)
    }
    return ids
  }, [data.nodes])

  const layoutKey = `${selectedClusterId ?? 'all'}|${[...selectedTypes].sort().join(',')}|${data.nodes.length}`
  const activeMode = MODE_META[viewMode]
  const visibleMode = (mode: ViewMode) => {
    if (mode === 'routine') return brainRoutineEnabled
    if (mode === 'backup') return brainBackupEnabled
    if (mode === 'chat-samples') return chatSampleImportEnabled
    if (mode === 'final-release') return finalReleaseEnabled
    return true
  }

  // --- Filter handlers ------------------------------------------------------
  const toggleType = (type: NodeType) =>
    setSelectedTypes((prev) => {
      const next = new Set(prev)
      next.has(type) ? next.delete(type) : next.add(type)
      return next
    })

  const handleSignOut = () => void supabase.auth.signOut()

  const handleProcessPending = async () => {
    if (!session?.user.id || pendingBusy) return
    setPendingBusy(true)
    notify('info', 'Memproses entry pending/failed...')
    const { processed, results } = await processPending(5)
    setPendingBusy(false)
    if (processed === 0) {
      notify('success', 'Tidak ada entry pending/failed.')
      return
    }
    const ok = results.filter((r) => r.status === 'done').length
    const firstError = results.find((r) => r.status !== 'done')?.error
      ?? results.find((r) => r.status !== 'done')?.message
    if (firstError) {
      notify('error', `Diproses ${ok}/${processed}. ${firstError}`)
    } else {
      notify(ok === processed ? 'success' : 'error', `Diproses ${ok}/${processed} entry.`)
    }
    void fetchData()
  }

  const handleToggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
        setIsFullscreen(true)
      } else {
        await document.exitFullscreen()
        setIsFullscreen(false)
      }
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Gagal toggle fullscreen.')
    }
  }

  const handleImportObsidian = async () => {
    if (importBusy) return
    setImportBusy(true)
    notify('info', 'Import Obsidian berjalan...')
    try {
      const res = await fetch('/__obsidian-importer/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 5 }),
      })
      const data = await res.json().catch(() => ({}))
      const message = summarizeOutput(data?.output) ?? data?.error ?? 'Import Obsidian selesai.'
      notify(res.ok ? 'success' : 'error', message)
      if (res.ok) void fetchData()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Import Obsidian gagal.')
    } finally {
      setImportBusy(false)
    }
  }

  const handleImportAttachments = async () => {
    if (attachmentBusy) return
    setAttachmentBusy(true)
    notify('info', 'Import Attachments berjalan...')
    try {
      const res = await fetch('/__attachments/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 5 }),
      })
      const data = await res.json().catch(() => ({}))
      const message = summarizeOutput(data?.output) ?? data?.error ?? 'Import Attachments selesai.'
      notify(res.ok ? 'success' : 'error', message)
      if (res.ok) void fetchData()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Import Attachments gagal.')
    } finally {
      setAttachmentBusy(false)
    }
  }

  const handleSyncObsidian = async () => {
    if (syncBusy) return
    setSyncBusy(true)
    notify('info', 'Sync Obsidian berjalan...')
    try {
      const res = await fetch('/__obsidian-sync/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 100, dryRun: false, indexesOnly: false }),
      })
      const data = await res.json().catch(() => ({}))
      const message = summarizeOutput(data?.output) ?? data?.error ?? 'Sync Obsidian selesai.'
      notify(res.ok ? 'success' : 'error', message)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Sync Obsidian gagal.')
    } finally {
      setSyncBusy(false)
    }
  }

  const handleReindexBrain = async () => {
    if (indexBusy) return
    setIndexBusy(true)
    notify('info', 'Reindex Brain berjalan...')
    try {
      const res = await fetch('/__brain-indexer/index', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 25 }),
      })
      const data = await res.json().catch(() => ({}))
      const message = summarizeOutput(data?.output) ?? data?.error ?? 'Reindex Brain selesai.'
      notify(res.ok ? 'success' : 'error', message)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Reindex Brain gagal.')
    } finally {
      setIndexBusy(false)
    }
  }

  const handleQualityAction = async (action: string, body: Record<string, unknown>) => {
    const res = await fetch(`/__brain-quality/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, user_id: session?.user.id ?? null }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload?.error ?? `Quality action failed: ${action}`)
    return payload
  }

  const updateNode = async (node: BrainNode, patch: Partial<BrainNode>) => {
    if (useDevFallback) {
      notify('error', 'Quality action tidak tersedia di dev fallback.')
      return
    }
    setQualityBusy('update-node')
    try {
      const { error } = await supabase.from('brain_nodes').update(patch).eq('id', node.id)
      if (error) throw error
      notify('success', 'Node updated.')
      void fetchData()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Gagal update node.')
    } finally {
      setQualityBusy(null)
    }
  }

  const updateEdge = async (edge: BrainEdge, patch: Partial<BrainEdge>) => {
    if (useDevFallback) {
      notify('error', 'Quality action tidak tersedia di dev fallback.')
      return
    }
    setQualityBusy('update-edge')
    try {
      const { error } = await supabase.from('brain_edges').update(patch).eq('id', edge.id)
      if (error) throw error
      notify('success', 'Edge updated.')
      void fetchData()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Gagal update edge.')
    } finally {
      setQualityBusy(null)
    }
  }

  const mergeNode = async (sourceNodeId: string, targetNodeId: string) => {
    if (!window.confirm('Merge node ini? Source node akan digabung ke target node.')) return
    setQualityBusy('merge')
    try {
      await handleQualityAction('merge-node', { source_node_id: sourceNodeId, target_node_id: targetNodeId })
      notify('success', 'Node merged.')
      setSelectedNodeId(targetNodeId)
      void fetchData()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Gagal merge node.')
    } finally {
      setQualityBusy(null)
    }
  }

  const deleteNode = async (nodeId: string) => {
    if (!window.confirm('Delete node ini? Operasi ini tidak bisa dibatalkan dari UI.')) return
    setQualityBusy('delete-node')
    try {
      await handleQualityAction('delete-node', { node_id: nodeId })
      notify('success', 'Node deleted.')
      if (selectedNodeId === nodeId) setSelectedNodeId(null)
      void fetchData()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Gagal delete node.')
    } finally {
      setQualityBusy(null)
    }
  }

  const deleteEdge = async (edgeId: string) => {
    if (!window.confirm('Delete edge ini? Operasi ini tidak bisa dibatalkan dari UI.')) return
    setQualityBusy('delete-edge')
    try {
      await handleQualityAction('delete-edge', { edge_id: edgeId })
      notify('success', 'Edge deleted.')
      void fetchData()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Gagal delete edge.')
    } finally {
      setQualityBusy(null)
    }
  }

  const retryEntry = async (rawEntryId: string) => {
    setQualityBusy('retry')
    try {
      const res = await fetch('/__brain-worker/process', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw_entry_id: rawEntryId, limit: 1 }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.output ?? 'Retry failed.')
      notify('success', summarizeOutput(payload?.output) ?? 'Retry selesai.')
      void fetchData()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Retry gagal.')
    } finally {
      setQualityBusy(null)
    }
  }

  useEffect(() => {
    const onFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => document.removeEventListener('fullscreenchange', onFullscreen)
  }, [])

  // --- Gating states --------------------------------------------------------
  if (!supabaseConfigured && !useDevFallback) {
    return (
      <Shell session={null} onSignOut={handleSignOut}>
        <EmptyBrainState
          title="Supabase belum dikonfigurasi"
          message="Variabel VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY belum diisi."
          hint="Salin .env.example menjadi .env, isi kredensial Supabase, lalu restart dev server."
        />
      </Shell>
    )
  }

  if (!authChecked && !useDevFallback) {
    return (
      <Shell session={null} onSignOut={handleSignOut}>
        <EmptyBrainState title="Memuat…" message="Memeriksa session Supabase." />
      </Shell>
    )
  }

  if (!session && !useDevFallback) {
    return (
      <Shell session={null} onSignOut={handleSignOut}>
        <LoginRequired />
      </Shell>
    )
  }

  // --- Main -----------------------------------------------------------------
  const expanded = !sidebarCollapsed
  return (
    <div className={`os ${expanded ? 'os--rail-open' : ''}`}>
      {/* Floating left sidebar: icon rail by default, expands to show labels */}
      <aside className={`rail ${expanded ? 'rail--expanded' : ''}`}>
        <div className="rail__brand">
          <span className="rail__logo" aria-hidden="true">
            <Icon name="logo" size={22} />
          </span>
          {expanded && (
            <span className="rail__brand-text">
              <span className="rail__brand-title">Brain OS</span>
              {useDevFallback && <span className="rail__brand-badge">DEV</span>}
            </span>
          )}
        </div>

        <button
          type="button"
          className="rail__btn rail__toggle"
          onClick={() => setSidebarCollapsed((v) => !v)}
          title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          <Icon name={expanded ? 'chevron-left' : 'chevron-right'} />
          {expanded && <span className="rail__label">Collapse</span>}
        </button>

        <nav className="rail__nav">
          {MODE_GROUPS.map((group) => (
            <div className="rail__group" key={group.label}>
              {expanded && <span className="rail__group-label">{group.label}</span>}
              {group.modes.filter(visibleMode).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`rail__btn ${viewMode === mode ? 'rail__btn--active' : ''}`}
                  onClick={() => setViewMode(mode)}
                  title={MODE_META[mode].title}
                  aria-label={MODE_META[mode].title}
                >
                  <Icon name={MODE_META[mode].icon} />
                  {expanded && <span className="rail__label">{MODE_META[mode].title}</span>}
                </button>
              ))}
            </div>
          ))}

          {/* Tools group (moved from the bottom dock) */}
          <div className="rail__group">
            {expanded && <span className="rail__group-label">Tools</span>}
            <button
              type="button"
              className="rail__btn"
              onClick={() => void fetchData()}
              disabled={dataState.status === 'loading'}
              title="Quality refresh"
              aria-label="Quality refresh"
            >
              <Icon name="refresh" />
              {expanded && <span className="rail__label">Refresh</span>}
            </button>
            <button type="button" className="rail__btn" onClick={() => setViewMode('review')} title="Find duplicates" aria-label="Find duplicates">
              <Icon name="duplicate" />
              {expanded && <span className="rail__label">Find Duplicates</span>}
            </button>
            <button
              type="button"
              className="rail__btn"
              onClick={handleProcessPending}
              disabled={pendingBusy}
              title={pendingBusy ? 'Processing...' : 'Process pending'}
              aria-label="Process pending"
            >
              <Icon name="process" />
              {expanded && <span className="rail__label">{pendingBusy ? 'Processing...' : 'Process'}</span>}
            </button>
            {obsidianImporterEnabled && (
              <button
                type="button"
                className="rail__btn"
                onClick={handleImportObsidian}
                disabled={importBusy}
                title={importBusy ? 'Importing...' : 'Import Obsidian'}
                aria-label="Import Obsidian"
              >
                <Icon name="import" />
                {expanded && <span className="rail__label">{importBusy ? 'Importing...' : 'Import Obsidian'}</span>}
              </button>
            )}
            {obsidianSyncEnabled && (
              <button
                type="button"
                className="rail__btn"
                onClick={handleSyncObsidian}
                disabled={syncBusy}
                title={syncBusy ? 'Syncing...' : 'Sync Obsidian'}
                aria-label="Sync Obsidian"
              >
                <Icon name="sync" />
                {expanded && <span className="rail__label">{syncBusy ? 'Syncing...' : 'Sync Obsidian'}</span>}
              </button>
            )}
            {attachmentImporterEnabled && (
              <button
                type="button"
                className="rail__btn"
                onClick={handleImportAttachments}
                disabled={attachmentBusy}
                title={attachmentBusy ? 'Importing...' : 'Import Attachments'}
                aria-label="Import Attachments"
              >
                <Icon name="import" />
                {expanded && <span className="rail__label">{attachmentBusy ? 'Importing...' : 'Import Attachments'}</span>}
              </button>
            )}
            {brainIndexerEnabled && (
              <button
                type="button"
                className="rail__btn"
                onClick={handleReindexBrain}
                disabled={indexBusy}
                title={indexBusy ? 'Reindexing...' : 'Reindex'}
                aria-label="Reindex"
              >
                <Icon name="index" />
                {expanded && <span className="rail__label">{indexBusy ? 'Reindexing...' : 'Reindex'}</span>}
              </button>
            )}
            <button
              type="button"
              className="rail__btn"
              onClick={handleToggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label="Toggle fullscreen"
            >
              <Icon name="expand" />
              {expanded && <span className="rail__label">{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>}
            </button>
          </div>
        </nav>

        <div className="rail__footer">
          <button
            type="button"
            className="rail__btn"
            onClick={() => setViewMode('routine')}
            title="Settings & routine"
          >
            <Icon name="settings" />
            {expanded && <span className="rail__label">Settings</span>}
          </button>
          <button type="button" className="rail__btn" onClick={handleSignOut} title="Logout">
            <Icon name="logout" />
            {expanded && <span className="rail__label">Logout</span>}
          </button>
          <div className="rail__user" title={session?.user.email ?? session?.user.id ?? 'User'}>
            <span className="rail__avatar" aria-hidden="true">
              <Icon name="user" size={16} />
            </span>
            {expanded && <span className="rail__user-id">{session?.user.email ?? session?.user.id}</span>}
          </div>
        </div>
      </aside>

      {/* Dark canvas with dotted grid */}
      <main className="canvas">
        {/* Collapsible header — toggled by the floating icon at top-right */}
        <div className={`canvas__header ${headerOpen ? 'canvas__header--open' : ''}`}>
          {headerOpen && (
            <div className="canvas__header-inner">
              <div className="canvas__header-top">
                <div className="canvas__header-title">
                  <span className="canvas__header-icon" aria-hidden="true">
                    <Icon name={activeMode.icon} size={18} />
                  </span>
                  <div className="canvas__header-text">
                    <h2>{activeMode.title}</h2>
                    <p>{activeMode.subtitle}</p>
                  </div>
                </div>
                <span className="badge badge-info">Runtime: Read-only</span>
              </div>

              {viewMode === 'graph' && (
                <BrainToolbar
                  clusters={data.clusters}
                  selectedTypes={selectedTypes}
                  selectedClusterId={selectedClusterId}
                  onToggleType={toggleType}
                  onClearTypes={() => setSelectedTypes(new Set())}
                  onSelectCluster={setSelectedClusterId}
                  onRefresh={() => void fetchData()}
                  loading={dataState.status === 'loading'}
                  nodeCount={nodeCount}
                  edgeCount={edgeCount}
                />
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className="canvas__header-toggle"
          onClick={() => setHeaderOpen((v) => !v)}
          title={headerOpen ? 'Hide header' : 'Show header'}
          aria-label={headerOpen ? 'Hide header' : 'Show header'}
          aria-expanded={headerOpen}
        >
          <Icon name={headerOpen ? 'close' : 'panel'} size={18} />
        </button>

        <div className="canvas__scroll">
          <Suspense fallback={<ModeLoading />}>
            {viewMode === 'graph' ? (
              <div className="visualizer-area">
                {dataState.status === 'loading' && (
                  <EmptyBrainState title="Memuat graph..." message="Mengambil node & edge dari Supabase." />
                )}

                {dataState.status === 'error' && (
                  <EmptyBrainState
                    title="Gagal membaca Supabase"
                    message={dataState.message}
                    hint="Cek koneksi, kebijakan RLS, dan apakah kamu login sebagai user yang benar. Lalu klik Refresh."
                  />
                )}

                {dataState.status === 'ready' && data.nodes.length === 0 && (
                  <EmptyBrainState
                    title="Brain masih kosong"
                    message="Tidak ada node yang bisa dibaca untuk user ini."
                    hint="Pastikan seed sudah dijalankan dan user_id pada seed = id user yang login (RLS)."
                  />
                )}

                {dataState.status === 'ready' && data.nodes.length > 0 && elements.length === 0 && (
                  <EmptyBrainState
                    title="Tidak ada node yang cocok filter"
                    message="Filter type/cluster menyembunyikan semua node."
                    hint="Reset filter type ke 'Semua' atau pilih cluster lain."
                  />
                )}

                {dataState.status === 'ready' && elements.length > 0 && (
                  <BrainVisualizer
                    elements={elements}
                    onNodeClick={setSelectedNodeId}
                    onBackgroundClick={() => setSelectedNodeId(null)}
                    layoutKey={layoutKey}
                  />
                )}

                {selectedNode && (
                  <BrainNodeDetailPanel
                    node={selectedNode}
                    allNodes={data.nodes}
                    edges={data.edges}
                    clusters={data.clusters}
                    possibleDuplicate={duplicateNodeIds.has(selectedNode.id)}
                    onClose={() => setSelectedNodeId(null)}
                  />
                )}
              </div>
            ) : viewMode === 'review' ? (
              <BrainQualityReview
                nodes={data.nodes}
                edges={data.edges}
                clusters={data.clusters}
                rawEntries={reviewData.rawEntries}
                extractionJobs={reviewData.extractionJobs}
                busy={Boolean(qualityBusy) || dataState.status === 'loading'}
                onRefresh={() => void fetchData()}
                onUpdateNode={updateNode}
                onUpdateEdge={updateEdge}
                onMergeNode={mergeNode}
                onDeleteNode={deleteNode}
                onDeleteEdge={deleteEdge}
                onRetryEntry={retryEntry}
              />
            ) : viewMode === 'chat' ? (
              <BrainChat />
            ) : viewMode === 'timeline' ? (
              <BrainTimeline nodes={data.nodes} edges={data.edges} />
            ) : viewMode === 'digest' ? (
              <BrainDigest onNotify={notify} />
            ) : viewMode === 'routine' ? (
              <BrainRoutine onNotify={notify} />
            ) : viewMode === 'backup' ? (
              <BrainBackup onNotify={notify} />
            ) : viewMode === 'calibration' ? (
              <OwnerCalibration onNotify={notify} />
            ) : viewMode === 'similarity' ? (
              <SimilarityEvaluation onNotify={notify} />
            ) : viewMode === 'drift' ? (
              <DriftControl onNotify={notify} />
            ) : viewMode === 'reflection' ? (
              <SelfReflection onNotify={notify} />
            ) : viewMode === 'chat-samples' ? (
              <ChatSampleImporter onNotify={notify} />
            ) : viewMode === 'conflicts' ? (
              <IdentityConflicts onNotify={notify} />
            ) : viewMode === 'self-clone-eval' ? (
              <SelfCloneEvaluation onNotify={notify} />
            ) : viewMode === 'runtime' ? (
              <EntityRuntime onNotify={notify} />
            ) : viewMode === 'long-term-memory' ? (
              <LongTermMemory onNotify={notify} />
            ) : viewMode === 'final-release' ? (
              <FinalRelease onNotify={notify} />
            ) : (
              <BrainEvaluation onNotify={notify} />
            )}
          </Suspense>
        </div>

        {/* Floating bottom dock: 3 routine buttons + diary input only */}
        <BottomCommandDock
          userId={session?.user.id ?? null}
          onAfterProcess={() => void fetchData()}
          onNotify={notify}
          showLabels={expanded}
        />

        {toast && <Toast kind={toast.kind} message={toast.message} onClose={() => setToast(null)} />}
      </main>
    </div>
  )
}

function summarizeOutput(output: unknown): string | undefined {
  if (typeof output !== 'string' || !output.trim()) return undefined
  const lines = output.trim().split(/\r?\n/).filter(Boolean)
  return [...lines].reverse().find((line) =>
    line.includes('[obsidian-importer] processed=') ||
    line.includes('[obsidian-importer] failed') ||
    line.includes('[obsidian-sync] nodes=') ||
    line.includes('[obsidian-sync] failed') ||
    line.includes('[attachment-importer] processed=') ||
    line.includes('[attachment-importer] failed') ||
    line.includes('[brain-indexer] processed=') ||
    line.includes('[brain-indexer] failed') ||
    line.includes('[brain-digest] done') ||
    line.includes('[brain-digest] failed') ||
    line.includes('[brain-worker] processed='),
  ) ?? lines[lines.length - 1]
}

function Toast({
  kind,
  message,
  onClose,
}: {
  kind: 'success' | 'error' | 'info'
  message: string
  onClose: () => void
}) {
  return (
    <div className={`toast toast--${kind}`}>
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Close notification">x</button>
    </div>
  )
}

function ModeLoading() {
  return (
    <div className="mode-loading">
      <span>Loading mode...</span>
    </div>
  )
}

// Kerangka minimal untuk gating state (loading / login / config).
// Tanpa header/topbar — hanya canvas gelap dengan konten di tengah.
function Shell({
  children,
  session,
  onSignOut,
}: {
  children: React.ReactNode
  session: Session | null
  onSignOut: () => void
}) {
  return (
    <div className="os os--bare">
      <aside className="rail">
        <div className="rail__brand">
          <span className="rail__logo" aria-hidden="true">
            <Icon name="logo" size={22} />
          </span>
        </div>
        <div className="rail__footer">
          {session && (
            <button type="button" className="rail__btn" onClick={onSignOut} title="Logout">
              <Icon name="logout" />
            </button>
          )}
        </div>
      </aside>
      <main className="canvas">
        <div className="canvas__scroll canvas__scroll--center">{children}</div>
      </main>
    </div>
  )
}
