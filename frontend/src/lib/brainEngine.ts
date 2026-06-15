import { supabase } from './supabase'

// Memanggil Edge Function Brain Engine (Fase 5). Frontend hanya memicu;
// ekstraksi & penulisan node/edge terjadi di server (RLS + service role).
export interface ProcessResult {
  status: 'done' | 'failed' | 'skipped' | string
  nodes?: number
  edges?: number
  agent_memories?: number
  message?: string
  error?: string
}

const brainEngineTrigger = import.meta.env.VITE_BRAIN_ENGINE_TRIGGER ?? 'edge_function'

// Proses satu raw_entry berdasarkan id.
export async function processEntry(rawEntryId: string): Promise<ProcessResult> {
  if (brainEngineTrigger === 'local_worker') {
    return invokeLocalWorker({ raw_entry_id: rawEntryId, limit: 1 })
  }

  const { data, error } = await supabase.functions.invoke('process-brain-entry', {
    body: { raw_entry_id: rawEntryId },
  })

  if (error) {
    // Function mengembalikan non-2xx → coba baca pesan dari body response.
    let message = error.message
    try {
      const ctx = (error as unknown as { context?: Response }).context
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json()
        message = body?.error ?? body?.message ?? message
      }
    } catch {
      // abaikan, pakai error.message
    }
    return { status: 'failed', error: message }
  }

  return data as ProcessResult
}

// Fallback: proses beberapa entry pending/failed milik user (maks `limit`, default 5).
export async function processPending(limit = 5): Promise<{ processed: number; results: ProcessResult[] }> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { processed: 0, results: [] }

  const { data: pending, error } = await supabase
    .from('raw_entries')
    .select('id')
    .eq('user_id', user.id)
    .in('processing_status', ['pending', 'failed'])
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error || !pending || pending.length === 0) return { processed: 0, results: [] }

  if (brainEngineTrigger === 'local_worker') {
    const result = await invokeLocalWorker({ limit })
    return { processed: pending.length, results: [result] }
  }

  const results: ProcessResult[] = []
  for (const row of pending) {
    results.push(await processEntry(row.id as string))
  }
  return { processed: pending.length, results }
}

async function invokeLocalWorker(body: { raw_entry_id?: string; limit: number }): Promise<ProcessResult> {
  try {
    const res = await fetch('/__brain-worker/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        status: 'failed',
        error: data?.error ?? summarizeWorkerOutput(data?.output) ?? `Local worker HTTP ${res.status}`,
      }
    }
    if (data?.status !== 'done') {
      return { status: 'failed', error: summarizeWorkerOutput(data?.output) ?? data?.error ?? 'Local worker gagal.' }
    }
    return { status: 'done', message: summarizeWorkerOutput(data?.output) ?? 'Local worker selesai.' }
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function summarizeWorkerOutput(output: unknown): string | undefined {
  if (typeof output !== 'string' || !output.trim()) return undefined
  const lines = output.trim().split(/\r?\n/).filter(Boolean)
  const important = [...lines].reverse().find((line) =>
    line.includes('[brain-worker] processed=') || line.includes('[brain-worker] failed'),
  )
  return important ?? lines.slice(-1)[0]
}
