import { useCallback, useRef, useState } from 'react'
import { Icon, type IconName } from '../Icon'
import { QuickDiaryInput } from '../QuickDiaryInput'

type RoutineType = 'daily' | 'three-day' | 'weekly'
type RoutinePhase = 'idle' | 'loading' | 'success' | 'error'

interface RoutineDef {
  type: RoutineType
  icon: IconName
  title: string // tooltip (English, fixed)
  label: string // short visual label (Indonesian)
  running: string // dock status while running
}

const ROUTINES: RoutineDef[] = [
  { type: 'daily', icon: 'routine-daily', title: 'Run daily routine', label: 'Harian', running: 'Menjalankan routine harian...' },
  { type: 'three-day', icon: 'routine-three-day', title: 'Run 3-day routine', label: '3 Hari', running: 'Menjalankan routine 3 hari...' },
  { type: 'weekly', icon: 'routine-weekly', title: 'Run weekly routine', label: 'Mingguan', running: 'Menjalankan routine mingguan...' },
]

const ENDPOINT_MAP: Record<RoutineType, string> = {
  daily: '/__brain-routine/run-daily',
  'three-day': '/__brain-routine/run-three-day',
  weekly: '/__brain-routine/run-weekly',
}

interface BottomCommandDockProps {
  userId: string | null
  onAfterProcess?: () => void
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
  // Saat sidebar expanded / layar lebar, label pendek boleh tampil.
  showLabels?: boolean
}

// Bottom Command Dock: hanya 3 tombol routine + input diary.
// Tombol hanya menjalankan npm script allowlisted via endpoint lokal (confirm:true).
export function BottomCommandDock({ userId, onAfterProcess, onNotify, showLabels = false }: BottomCommandDockProps) {
  const [active, setActive] = useState<RoutineType | null>(null)
  const [result, setResult] = useState<{ type: RoutineType; phase: Exclude<RoutinePhase, 'idle' | 'loading'> } | null>(null)
  const [status, setStatus] = useState<string>('')
  const [errorDetail, setErrorDetail] = useState<string>('')
  const resetTimer = useRef<number | null>(null)

  const runRoutine = useCallback(
    async (type: RoutineType) => {
      if (active) return // satu routine pada satu waktu
      if (resetTimer.current) {
        window.clearTimeout(resetTimer.current)
        resetTimer.current = null
      }

      const def = ROUTINES.find((r) => r.type === type)!
      setActive(type)
      setResult(null)
      setStatus(def.running)
      setErrorDetail('')
      onNotify?.('info', def.running)

      try {
        const res = await fetch(ENDPOINT_MAP[type], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok || payload?.ok === false) {
          const message =
            typeof payload?.error === 'string'
              ? payload.error
              : typeof payload?.summary === 'string'
                ? payload.summary
                : `Routine gagal (HTTP ${res.status}).`
          throw new Error(message)
        }

        setResult({ type, phase: 'success' })
        setStatus('Routine selesai')
        onNotify?.('success', `${def.label}: routine selesai.`)
        onAfterProcess?.()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Routine gagal.'
        // Hanya tampilkan ringkasan singkat; detail penuh masuk accordion debug.
        const short = message.split(/\r?\n/)[0].slice(0, 160)
        setResult({ type, phase: 'error' })
        setStatus(`Routine gagal: ${short}`)
        setErrorDetail(message)
        onNotify?.('error', `${def.label}: ${short}`)
      } finally {
        setActive(null)
        resetTimer.current = window.setTimeout(() => {
          setResult(null)
          setStatus('')
          setErrorDetail('')
          resetTimer.current = null
        }, 6000)
      }
    },
    [active, onAfterProcess, onNotify],
  )

  const buttonStateClass = (type: RoutineType): string => {
    if (active === type) return 'is-loading'
    if (result?.type === type) return result.phase === 'success' ? 'is-success' : 'is-error'
    return ''
  }

  return (
    <div className="bottom-command-dock">
      <div className="dock-routine-actions" role="group" aria-label="Routine">
        {ROUTINES.map((r) => {
          const isActive = active === r.type
          return (
            <button
              key={r.type}
              type="button"
              className={`dock-icon-button ${buttonStateClass(r.type)}`}
              title={r.title}
              aria-label={r.title}
              aria-busy={isActive}
              disabled={active !== null && !isActive}
              onClick={() => void runRoutine(r.type)}
            >
              <span className={`dock-icon-button__icon ${isActive ? 'is-spinning' : ''}`}>
                <Icon name={isActive ? 'spinner' : r.icon} size={18} />
              </span>
              {showLabels && <span className="dock-icon-button__label">{r.label}</span>}
            </button>
          )
        })}
      </div>

      <QuickDiaryInput userId={userId} onAfterProcess={onAfterProcess} onNotify={onNotify} />

      {status && (
        <div className={`dock-status dock-status--${active ? 'loading' : result?.phase ?? 'idle'}`} role="status">
          <span className="dock-status__text">{status}</span>
          {result?.phase === 'error' && errorDetail && (
            <details className="dock-status__detail">
              <summary>Detail</summary>
              <pre>{errorDetail}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
