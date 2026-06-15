import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BrainBackupListItem, BrainRecoveryCheck, BrainRestorePreview } from '../types/brain'

interface BrainBackupProps {
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

type BusyState = 'create' | 'preview' | 'restore' | 'recovery' | null

export function BrainBackup({ onNotify }: BrainBackupProps) {
  const [backups, setBackups] = useState<BrainBackupListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<BrainRestorePreview | null>(null)
  const [recovery, setRecovery] = useState<BrainRecoveryCheck | null>(null)
  const [busy, setBusy] = useState<BusyState>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [includeVault, setIncludeVault] = useState(true)
  const [includeEnv, setIncludeEnv] = useState(false)
  const [compress, setCompress] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)

  const selected = useMemo(() => backups.find((item) => item.backup_id === selectedId) ?? backups[0] ?? null, [backups, selectedId])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__brain-backup/list')
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? 'Gagal membaca daftar backup.')
      const next = (payload.backups ?? []) as BrainBackupListItem[]
      setBackups(next)
      setSelectedId((current) => current ?? next[0]?.backup_id ?? null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membaca daftar backup.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const createBackup = async () => {
    if (busy) return
    setBusy('create')
    setError(null)
    onNotify?.('info', 'Membuat brain backup...')
    try {
      const res = await fetch('/__brain-backup/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeVault, includeEnv, compress }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.stdout ?? 'Backup gagal.')
      onNotify?.('success', `Backup dibuat: ${payload.backup_id ?? payload.manifest?.backup_id ?? 'done'}.`)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Backup gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  const previewRestore = async (backupId = selected?.backup_id) => {
    if (!backupId || busy) return
    setBusy('preview')
    setError(null)
    try {
      const res = await fetch('/__brain-backup/preview-restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backupId }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.stdout ?? 'Restore preview gagal.')
      setPreview(payload as BrainRestorePreview)
      setSelectedId(backupId)
      onNotify?.('success', 'Restore preview siap.')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Restore preview gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  const restore = async () => {
    if (!selected?.backup_id || busy || !confirmRestore) return
    setBusy('restore')
    setError(null)
    try {
      const res = await fetch('/__brain-backup/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backupId: selected.backup_id, confirm: true, mode: 'upsert' }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.stdout ?? 'Restore gagal.')
      onNotify?.(payload.status === 'partial' ? 'info' : 'success', `Restore ${payload.status ?? 'done'}.`)
      setConfirmRestore(false)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Restore gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  const runRecovery = async () => {
    if (busy) return
    setBusy('recovery')
    setError(null)
    try {
      const res = await fetch('/__brain-backup/recovery-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ save: true }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error ?? payload?.stdout ?? 'Recovery check gagal.')
      setRecovery(payload as BrainRecoveryCheck)
      onNotify?.(payload.status === 'critical' ? 'error' : payload.status === 'warning' ? 'info' : 'success', `Recovery ${payload.status} (${payload.score}/100).`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Recovery check gagal.'
      setError(message)
      onNotify?.('error', message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="backup-view">
      <header className="backup-view__header">
        <div>
          <h2>Brain Backup</h2>
          <p>Local-first backup, export, restore preview, restore upsert, dan recovery audit untuk Personal Brain OS.</p>
        </div>
        <div className="backup-actions">
          <button type="button" className="btn btn--primary" onClick={() => void createBackup()} disabled={Boolean(busy)}>
            {busy === 'create' ? 'Creating...' : 'Create Backup'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void previewRestore()} disabled={Boolean(busy) || !selected}>
            {busy === 'preview' ? 'Previewing...' : 'Preview Latest Backup'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void runRecovery()} disabled={Boolean(busy)}>
            {busy === 'recovery' ? 'Checking...' : 'Run Recovery Check'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void refresh()} disabled={loading || Boolean(busy)}>
            Refresh
          </button>
        </div>
      </header>

      <div className="backup-options">
        <Toggle label="Include vault" checked={includeVault} onChange={setIncludeVault} />
        <Toggle label="Include .env redacted" checked={includeEnv} onChange={setIncludeEnv} />
        <Toggle label="Compress" checked={compress} onChange={setCompress} />
      </div>

      <div className="backup-danger">
        Restore can overwrite rows with matching ids. MVP restore is upsert-only, requires confirmation, and never deletes existing data.
      </div>

      {error && <div className="evaluation-alert">{error}</div>}

      <div className="backup-grid">
        <div className="backup-panel">
          <div className="evaluation-panel__title">
            <h3>Local Backups</h3>
            <span>{backups.length}</span>
          </div>
          <div className="backup-list">
            {backups.length ? backups.map((backup) => (
              <button
                key={backup.backup_id}
                type="button"
                className={`backup-list__item ${selected?.backup_id === backup.backup_id ? 'backup-list__item--active' : ''}`}
                onClick={() => setSelectedId(backup.backup_id)}
              >
                <strong>{backup.backup_id}</strong>
                <small>{formatDate(backup.created_at)} · {formatBytes(backup.total_size_bytes)}</small>
                <small>{Object.keys(backup.table_row_counts ?? {}).length} tables · {backup.obsidian_file_count} vault files</small>
              </button>
            )) : (
              <div className="evaluation-empty">
                <h3>Belum ada backup</h3>
                <p>Klik Create Backup untuk membuat snapshot pertama.</p>
              </div>
            )}
          </div>
        </div>

        <div className="backup-panel">
          <div className="evaluation-panel__title">
            <h3>Manifest</h3>
            <span>{selected?.warnings?.length ?? 0} warnings</span>
          </div>
          {selected ? (
            <div className="backup-manifest">
              <Metric label="Backup time" value={formatDate(selected.created_at)} />
              <Metric label="Vault files" value={selected.obsidian_file_count} />
              <Metric label="Size" value={formatBytes(selected.total_size_bytes)} />
              <List title="Warnings" items={selected.warnings ?? []} />
              <List title="Errors" items={selected.errors ?? []} />
              <details><summary>Table row counts</summary><pre>{JSON.stringify(selected.table_row_counts ?? {}, null, 2)}</pre></details>
            </div>
          ) : (
            <p className="muted">Tidak ada manifest.</p>
          )}
        </div>
      </div>

      {preview && (
        <div className="backup-panel backup-preview">
          <div className="evaluation-panel__title">
            <h3>Restore Preview</h3>
            <span>{preview.status}</span>
          </div>
          <div className="backup-table-preview">
            {Object.entries(preview.tables ?? {}).map(([table, info]) => (
              <div key={table}>
                <strong>{table}</strong>
                <span>backup {info.backup_rows}</span>
                <span>current {info.current_rows ?? '-'}</span>
                <span>{info.action}</span>
              </div>
            ))}
          </div>
          <List title="Warnings" items={preview.warnings ?? []} />
          <List title="Errors" items={preview.errors ?? []} />
          <label className="backup-confirm">
            <input type="checkbox" checked={confirmRestore} onChange={(event) => setConfirmRestore(event.target.checked)} />
            <span>I understand restore will upsert rows and can overwrite matching ids.</span>
          </label>
          <button type="button" className="btn btn--primary" onClick={() => void restore()} disabled={!confirmRestore || Boolean(busy)}>
            {busy === 'restore' ? 'Restoring...' : 'Restore Upsert'}
          </button>
        </div>
      )}

      {recovery && (
        <div className="backup-panel backup-recovery">
          <div className="evaluation-panel__title">
            <h3>Recovery Check</h3>
            <span>{recovery.status} · {recovery.score}/100</span>
          </div>
          <div className="backup-issues">
            {recovery.issues.length ? recovery.issues.map((item) => (
              <div key={`${item.code}-${item.message}`}>
                <strong>{item.severity}: {item.code}</strong>
                <span>{item.message}</span>
              </div>
            )) : <p className="muted">Tidak ada issue.</p>}
          </div>
          <List title="Recommended fixes" items={recovery.recommended_fixes ?? []} />
        </div>
      )}
    </section>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="routine-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="backup-metric">
      <span>{label}</span>
      <strong>{String(value ?? '-')}</strong>
    </div>
  )
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="routine-list-block">
      <span>{title}</span>
      {items.length ? items.map((item) => <p key={item}>{item}</p>) : <p>-</p>}
    </div>
  )
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

function formatBytes(value: number | null | undefined) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number <= 0) return '0 B'
  if (number < 1024) return `${number} B`
  if (number < 1024 * 1024) return `${Math.round(number / 1024)} KB`
  return `${(number / 1024 / 1024).toFixed(1)} MB`
}
