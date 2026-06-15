// =============================================================================
// Brain Engine MVP — Supabase Edge Function: process-brain-entry
//
// Alur:
//   React Quick Input  -> raw_entries (pending)
//   -> function dipanggil dengan { raw_entry_id }
//   -> validasi user & kepemilikan entry
//   -> buat extraction_jobs (processing), raw_entries.processing_status=processing
//   -> LLM ekstrak node/edge (structured JSON)
//   -> upsert brain_nodes & brain_edges (anti-duplikat via canonical_name)
//   -> raw_entries.processed=true, processing_status=done
//   -> extraction_jobs.status=done, output_snapshot, finished_at
//   (jika error: status failed + error_message, diary mentah TETAP tersimpan)
//
// Keamanan:
//   - User harus login (Authorization JWT diverifikasi).
//   - Setiap query DB di-scope ke user.id (tidak memproses entry milik user lain).
//   - SERVICE_ROLE_KEY hanya dipakai di sini (server), tidak pernah di frontend.
// =============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { callLLM } from './llm.ts'
import {
  BRAIN_TOOL,
  SYSTEM_PROMPT,
  validateExtraction,
  canonicalize,
  nodeKey,
  type CleanNode,
  type CleanEdge,
} from './schema.ts'

// deno-lint-ignore no-explicit-any
type DB = any

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method tidak diizinkan' })

  try {
    const { raw_entry_id } = await req.json().catch(() => ({}))
    if (!raw_entry_id) return jsonResponse(400, { error: 'raw_entry_id wajib diisi' })
    if (typeof raw_entry_id !== 'string' || !UUID_RE.test(raw_entry_id)) {
      return jsonResponse(400, { error: 'raw_entry_id harus berupa UUID valid' })
    }

    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader) return jsonResponse(401, { error: 'Authorization header diperlukan' })

    const SUPABASE_URL = requiredEnv('SUPABASE_URL')
    const ANON = requiredEnv('SUPABASE_ANON_KEY')
    const SERVICE = requiredEnv('SUPABASE_SERVICE_ROLE_KEY')

    // 1. Autentikasi user dari JWT yang dikirim frontend.
    const userClient: DB = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user) {
      return jsonResponse(401, { error: 'User tidak terautentikasi' })
    }
    const userId: string = userData.user.id

    // 2. Admin client (service role) untuk operasi engine. SELALU di-scope ke userId.
    const admin: DB = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // 3. Ambil entry & pastikan milik user ini.
    const { data: entry, error: entryErr } = await admin
      .from('raw_entries')
      .select('*')
      .eq('id', raw_entry_id)
      .eq('user_id', userId)
      .maybeSingle()
    if (entryErr) throw entryErr
    if (!entry) return jsonResponse(404, { error: 'Entry tidak ditemukan atau bukan milik Anda' })

    // 4. Precondition.
    if (entry.source_type !== 'text') {
      return jsonResponse(400, { error: 'Hanya source_type=text yang diproses di fase ini' })
    }
    if (!entry.content || !String(entry.content).trim()) {
      return jsonResponse(400, { error: 'content kosong' })
    }
    if (!['pending', 'failed'].includes(entry.processing_status)) {
      return jsonResponse(200, {
        status: 'skipped',
        message: `Entry sudah diproses (status: ${entry.processing_status})`,
      })
    }

    // 5. Buat job + tandai processing.
    const { data: job, error: jobErr } = await admin
      .from('extraction_jobs')
      .insert({
        user_id: userId,
        raw_entry_id,
        job_type: 'diary_extract',
        status: 'processing',
        started_at: new Date().toISOString(),
        input_snapshot: { title: entry.title, content_length: String(entry.content).length },
      })
      .select('id')
      .single()
    if (jobErr) throw jobErr
    const jobId = job.id

    await must(
      admin
      .from('raw_entries')
      .update({ processing_status: 'processing' })
      .eq('id', raw_entry_id)
      .eq('user_id', userId),
    )

    // 6. Proses (LLM + upsert). Error di sini -> tandai failed.
    try {
      const rawExtraction = await callLLM(SYSTEM_PROMPT, String(entry.content), BRAIN_TOOL)
      const clean = validateExtraction(rawExtraction)

      // Upsert nodes -> peta key -> id.
      const idByKey = new Map<string, string>()
      for (const n of clean.nodes) {
        const clusterId = n.cluster_slug ? await resolveCluster(admin, userId, n.cluster_slug) : null
        const id = await upsertNode(admin, userId, raw_entry_id, n, clusterId)
        idByKey.set(nodeKey(n.type, n.canonical_name), id)
      }

      // Upsert edges (hanya bila kedua endpoint dapat di-resolve).
      let edgeCount = 0
      for (const e of clean.edges) {
        const fromId =
          idByKey.get(nodeKey(e.from.type, e.from.canonical_name)) ??
          (await findNodeId(admin, userId, e.from.type, e.from.canonical_name))
        const toId =
          idByKey.get(nodeKey(e.to.type, e.to.canonical_name)) ??
          (await findNodeId(admin, userId, e.to.type, e.to.canonical_name))
        if (!fromId || !toId || fromId === toId) continue
        await upsertEdge(admin, userId, raw_entry_id, fromId, toId, e)
        edgeCount++
      }

      // Agent memories: fokus important/core (sesuai catatan task).
      let memCount = 0
      for (const m of clean.agent_memories) {
        if (!['important', 'core'].includes(m.importance_level)) continue
        await must(admin.from('agent_memories').insert({
          user_id: userId,
          memory_type: m.memory_type,
          content: m.content,
          importance_level: m.importance_level,
          stability: m.stability,
          sensitivity: m.sensitivity,
          source_entry_id: raw_entry_id,
        }))
        memCount++
      }

      // 7. Sukses.
      const now = new Date().toISOString()
      await must(
        admin
        .from('raw_entries')
        .update({ processed: true, processing_status: 'done', updated_at: now })
        .eq('id', raw_entry_id)
        .eq('user_id', userId),
      )
      await must(
        admin
        .from('extraction_jobs')
        .update({ status: 'done', finished_at: now, output_snapshot: rawExtraction })
        .eq('id', jobId),
      )

      return jsonResponse(200, {
        status: 'done',
        nodes: clean.nodes.length,
        edges: edgeCount,
        agent_memories: memCount,
      })
    } catch (procErr) {
      // 8. Gagal: catat status & error. Diary mentah tetap tersimpan.
      const msg = procErr instanceof Error ? procErr.message : String(procErr)
      await markFailed(admin, userId, raw_entry_id, jobId, msg)
      return jsonResponse(500, { status: 'failed', error: msg })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return jsonResponse(500, { error: msg })
  }
})

// ---------------------------------------------------------------------------
// Helpers (semua di-scope ke userId)
// ---------------------------------------------------------------------------
function requiredEnv(key: string): string {
  const value = Deno.env.get(key)
  if (!value) throw new Error(`${key} belum disetel.`)
  return value
}

async function must<T extends { error?: unknown }>(query: PromiseLike<T>): Promise<T> {
  const result = await query
  if (result.error) throw result.error
  return result
}

async function markFailed(
  admin: DB,
  userId: string,
  entryId: string,
  jobId: string,
  message: string,
): Promise<void> {
  const rawResult = await admin
    .from('raw_entries')
    .update({ processing_status: 'failed' })
    .eq('id', entryId)
    .eq('user_id', userId)

  const jobResult = await admin
    .from('extraction_jobs')
    .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message })
    .eq('id', jobId)

  if (rawResult.error || jobResult.error) {
    throw new Error(
      [
        message,
        rawResult.error ? `raw_entries update failed: ${rawResult.error.message}` : null,
        jobResult.error ? `extraction_jobs update failed: ${jobResult.error.message}` : null,
      ].filter(Boolean).join(' | '),
    )
  }
}

async function resolveCluster(admin: DB, userId: string, slug: string): Promise<string | null> {
  const { data, error } = await admin
    .from('brain_clusters')
    .select('id')
    .eq('user_id', userId)
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw error
  // MVP: jika cluster tidak ada, biarkan null (hindari cluster liar).
  return data?.id ?? null
}

async function findNodeId(
  admin: DB,
  userId: string,
  type: string,
  canonicalRaw: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('brain_nodes')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type)
    .eq('canonical_name', canonicalize(canonicalRaw))
    .maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

// Upsert node berdasarkan (user_id, type, canonical_name) — anti-duplikat.
async function upsertNode(
  admin: DB,
  userId: string,
  entryId: string,
  n: CleanNode,
  clusterId: string | null,
): Promise<string> {
  const now = new Date().toISOString()
  const canon = canonicalize(n.canonical_name) // normalisasi simpan (cocok dgn unique constraint)

  const { data: existing, error: findErr } = await admin
    .from('brain_nodes')
    .select('id, summary, description, frequency_score, importance_score, aliases, cluster_id')
    .eq('user_id', userId)
    .eq('type', n.type)
    .eq('canonical_name', canon)
    .maybeSingle()
  if (findErr) throw findErr

  if (existing) {
    // Sudah ada: update frequency/last_seen, gabungkan aliases, perbarui skor.
    const mergedAliases = Array.from(
      new Set([...(existing.aliases ?? []), ...n.aliases, n.name]),
    ).filter(Boolean)
    const betterDesc =
      n.description && (!existing.description || n.description.length > (existing.description?.length ?? 0))
        ? n.description
        : existing.description
    await must(
      admin
      .from('brain_nodes')
      .update({
        name: n.name,
        summary: n.summary ?? existing.summary,
        description: betterDesc,
        frequency_score: (existing.frequency_score ?? 0) + 1,
        importance_score: Math.max(existing.importance_score ?? 0, n.importance_score),
        confidence_score: n.confidence_score,
        last_seen_at: now,
        aliases: mergedAliases,
        updated_at: now,
        ...(clusterId && !existing.cluster_id ? { cluster_id: clusterId } : {}),
      })
      .eq('id', existing.id),
    )
    return existing.id
  }

  // Baru: insert.
  const { data: inserted, error } = await admin
    .from('brain_nodes')
    .insert({
      user_id: userId,
      type: n.type,
      name: n.name,
      canonical_name: canon,
      aliases: Array.from(new Set([...n.aliases, n.name])).filter(Boolean),
      summary: n.summary,
      description: n.description,
      importance_score: n.importance_score,
      frequency_score: 1,
      confidence_score: n.confidence_score,
      cluster_id: clusterId,
      first_seen_at: now,
      last_seen_at: now,
      source_entry_id: entryId,
      metadata: n.metadata,
    })
    .select('id')
    .single()
  if (error) throw error
  return inserted.id
}

// Upsert edge berdasarkan (user_id, from, to, relation_type).
async function upsertEdge(
  admin: DB,
  userId: string,
  entryId: string,
  fromId: string,
  toId: string,
  e: CleanEdge,
): Promise<void> {
  const now = new Date().toISOString()
  const { data: existing, error: findErr } = await admin
    .from('brain_edges')
    .select('id, weight')
    .eq('user_id', userId)
    .eq('from_node_id', fromId)
    .eq('to_node_id', toId)
    .eq('relation_type', e.relation_type)
    .maybeSingle()
  if (findErr) throw findErr

  if (existing) {
    await must(
      admin
      .from('brain_edges')
      .update({
        weight: (existing.weight ?? 1) + 1,
        summary: e.summary,
        confidence_score: e.confidence_score,
        updated_at: now,
      })
      .eq('id', existing.id),
    )
    return
  }

  await must(admin.from('brain_edges').insert({
    user_id: userId,
    from_node_id: fromId,
    to_node_id: toId,
    relation_type: e.relation_type,
    summary: e.summary,
    weight: e.weight,
    confidence_score: e.confidence_score,
    source_entry_id: entryId,
    metadata: e.metadata,
  }))
}
