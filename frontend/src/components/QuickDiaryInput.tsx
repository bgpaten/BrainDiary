import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { processEntry } from '../lib/brainEngine'
import type { RawEntryInsert } from '../types/brain'
import { Icon } from './Icon'

interface QuickDiaryInputProps {
  // user login Supabase; null bila belum login.
  userId: string | null
  // dipanggil setelah Brain Engine selesai agar App me-refresh graph.
  // Mengembalikan Promise agar kita bisa menunggu graph selesai dimuat.
  onAfterProcess?: () => void | Promise<void>
  onNotify?: (kind: 'success' | 'error' | 'info', message: string) => void
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving'; message: string }
  | { kind: 'processing'; message: string }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }

function todayTitle(): string {
  // Quick Diary YYYY-MM-DD (zona waktu lokal).
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `Quick Diary ${yyyy}-${mm}-${dd}`
}

// Area bawah: tulis cerita hari ini -> simpan ke raw_entries -> picu Brain Engine.
// Insert raw_entries TIDAK membuat node/edge sendiri; Brain Engine (server) yang
// mengekstrak. Jika engine gagal, diary mentah tetap tersimpan (status failed).
export function QuickDiaryInput({ userId, onAfterProcess, onNotify }: QuickDiaryInputProps) {
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' })

  const busy = status.kind === 'saving' || status.kind === 'processing'
  const disabled = !userId || busy || content.trim().length === 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!userId || content.trim().length === 0) return

    // 1. Simpan diary mentah.
    setStatus({ kind: 'saving', message: 'Menyimpan diary...' })
    const payload: RawEntryInsert = {
      user_id: userId,
      source_type: 'text',
      source_origin: 'react_input',
      title: todayTitle(),
      content: content.trim(),
      happened_at: new Date().toISOString(),
      processed: false,
      processing_status: 'pending',
    }

    const { data: inserted, error: insertError } = await supabase
      .from('raw_entries')
      .insert(payload)
      .select('id')
      .single()

    if (insertError || !inserted) {
      const message = `Gagal menyimpan: ${insertError?.message ?? 'tidak diketahui'}`
      setStatus({ kind: 'error', message })
      onNotify?.('error', message)
      return
    }

    // Diary tersimpan -> kosongkan textarea.
    setContent('')

    // 2. Picu Brain Engine.
    setStatus({ kind: 'processing', message: 'Memproses ke brain...' })
    const result = await processEntry(inserted.id as string)

    if (result.status === 'done') {
      const summary =
        typeof result.nodes === 'number' || typeof result.edges === 'number'
          ? `Brain berhasil diperbarui - ${result.nodes ?? 0} node, ${result.edges ?? 0} relasi.`
          : (result.message ?? 'Brain berhasil diperbarui.')
      setStatus({ kind: 'success', message: summary })
      onNotify?.('success', summary)
      // Tunggu graph selesai dimuat ulang, lalu beri tahu user bahwa
      // datanya sudah tampil di graph view.
      await onAfterProcess?.()
      onNotify?.('success', 'Diary tersimpan & sudah tampil di graph view.')
    } else {
      const message = `Gagal memproses brain: ${result.error ?? result.message ?? 'tidak diketahui'}. Diary mentah tetap tersimpan.`
      setStatus({ kind: 'error', message })
      onNotify?.('error', message)
    }
  }

  return (
    <form className="diary" onSubmit={handleSubmit}>
      <div className="diary__field">
        <span className="diary__icon" aria-hidden="true">
          <Icon name="sparkles" size={18} />
        </span>
        <textarea
          className="diary__textarea"
          placeholder="Ceritakan apa yang terjadi hari ini..."
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            if (status.kind !== 'idle') setStatus({ kind: 'idle' })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !disabled) {
              e.preventDefault()
              void handleSubmit(e as unknown as React.FormEvent)
            }
          }}
          rows={1}
          disabled={!userId || busy}
        />
        <button
          type="submit"
          className="diary__send"
          disabled={disabled}
          title={busy ? 'Memproses...' : 'Simpan ke Brain (Ctrl/Cmd + Enter)'}
          aria-label="Simpan ke Brain"
        >
          <Icon name={busy ? 'process' : 'send'} size={18} />
        </button>
      </div>
      {!userId && <div className="diary__hint">Login diperlukan untuk menyimpan diary.</div>}
      {status.kind === 'error' && <div className="diary__hint diary__hint--error">{status.message}</div>}
    </form>
  )
}
