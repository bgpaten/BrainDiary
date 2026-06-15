import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const rootDir = resolve(process.cwd(), '..')
loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(rootDir, 'supabase/functions/.env'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })

const args = parseArgs(process.argv.slice(2))
const action = readArg('action')
const userId = readArg('user-id')
const supabaseUrl = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
const supabase = await createSupabaseClient()

try {
  let result
  if (action === 'merge-node') {
    result = await mergeNode(readArg('source-node-id'), readArg('target-node-id'), userId)
  } else if (action === 'delete-node') {
    result = await deleteNode(readArg('node-id'), userId)
  } else if (action === 'delete-edge') {
    result = await deleteEdge(readArg('edge-id'), userId)
  } else {
    throw new Error(`Unsupported brain quality action: ${action}`)
  }
  console.log(JSON.stringify({ status: 'done', action, ...result }))
} catch (err) {
  await writeLog({
    action,
    user_id: userId,
    error: err instanceof Error ? err.message : String(err),
  })
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

async function mergeNode(sourceNodeId, targetNodeId, expectedUserId) {
  if (sourceNodeId === targetNodeId) throw new Error('source-node-id dan target-node-id tidak boleh sama.')

  const source = await getNode(sourceNodeId, expectedUserId)
  const target = await getNode(targetNodeId, expectedUserId)
  if (source.type !== target.type) {
    throw new Error(`Tidak bisa merge type berbeda: ${source.type} -> ${target.type}`)
  }

  const { data: allEdges, error: edgeErr } = await supabase.from('brain_edges').select('*').eq('user_id', expectedUserId)
  if (edgeErr) throw edgeErr
  const edges = allEdges ?? []
  const affected = edges.filter((edge) => edge.from_node_id === sourceNodeId || edge.to_node_id === sourceNodeId)
  const now = new Date().toISOString()
  const edgeActions = []

  for (const edge of affected) {
    const nextFrom = edge.from_node_id === sourceNodeId ? targetNodeId : edge.from_node_id
    const nextTo = edge.to_node_id === sourceNodeId ? targetNodeId : edge.to_node_id
    const wasSelfLoop = edge.from_node_id === edge.to_node_id

    if (nextFrom === nextTo && !wasSelfLoop) {
      await must(supabase.from('brain_edges').delete().eq('id', edge.id).eq('user_id', expectedUserId))
      edgeActions.push({ edge_id: edge.id, action: 'deleted_self_loop_after_merge' })
      continue
    }

    const duplicate = edges.find((candidate) =>
      candidate.id !== edge.id &&
      candidate.from_node_id === nextFrom &&
      candidate.to_node_id === nextTo &&
      candidate.relation_type === edge.relation_type &&
      candidate.user_id === expectedUserId
    )

    if (duplicate) {
      await must(
        supabase
          .from('brain_edges')
          .update({
            weight: Number(duplicate.weight ?? 0) + Number(edge.weight ?? 0),
            confidence_score: Math.max(Number(duplicate.confidence_score ?? 0), Number(edge.confidence_score ?? 0)),
            summary: combineText(duplicate.summary, edge.summary),
            metadata: {
              ...(duplicate.metadata ?? {}),
              merged_edge_ids: [...new Set([...asArray(duplicate.metadata?.merged_edge_ids), edge.id])],
              updated_by: 'brain-quality',
              updated_at: now,
            },
            updated_at: now,
          })
          .eq('id', duplicate.id)
          .eq('user_id', expectedUserId),
      )
      await must(supabase.from('brain_edges').delete().eq('id', edge.id).eq('user_id', expectedUserId))
      edgeActions.push({ edge_id: edge.id, action: 'merged_into_duplicate_edge', duplicate_edge_id: duplicate.id })
      continue
    }

    await must(
      supabase
        .from('brain_edges')
        .update({
          from_node_id: nextFrom,
          to_node_id: nextTo,
          metadata: {
            ...(edge.metadata ?? {}),
            remapped_by: 'brain-quality',
            merge_source_node_id: sourceNodeId,
            merge_target_node_id: targetNodeId,
          },
          updated_at: now,
        })
        .eq('id', edge.id)
        .eq('user_id', expectedUserId),
    )
    edgeActions.push({ edge_id: edge.id, action: 'remapped', from: nextFrom, to: nextTo })
  }

  const afterTarget = {
    aliases: mergeAliases(target, source),
    summary: combineText(target.summary, source.summary),
    description: combineText(target.description, source.description),
    frequency_score: Number(target.frequency_score ?? 0) + Number(source.frequency_score ?? 0),
    importance_score: Math.max(Number(target.importance_score ?? 0), Number(source.importance_score ?? 0)),
    confidence_score: Math.max(Number(target.confidence_score ?? 0), Number(source.confidence_score ?? 0)),
    last_seen_at: latestDate(target.last_seen_at, source.last_seen_at),
    metadata: {
      ...(target.metadata ?? {}),
      review_status: 'approved',
      reviewed_at: now,
      merged_node_ids: [...new Set([...asArray(target.metadata?.merged_node_ids), sourceNodeId])],
      merge_source_names: [...new Set([...asArray(target.metadata?.merge_source_names), source.name, source.canonical_name].filter(Boolean))],
    },
    updated_at: now,
  }

  await must(supabase.from('brain_nodes').update(afterTarget).eq('id', targetNodeId).eq('user_id', expectedUserId))
  await must(supabase.from('brain_nodes').delete().eq('id', sourceNodeId).eq('user_id', expectedUserId))

  await writeLog({
    action: 'merge-node',
    user_id: expectedUserId,
    merge_source: sourceNodeId,
    merge_target: targetNodeId,
    before: { source, target, affected_edges: affected },
    after: { target_patch: afterTarget, edge_actions: edgeActions },
  })

  return { source_node_id: sourceNodeId, target_node_id: targetNodeId, remapped_edges: edgeActions.length }
}

async function deleteNode(nodeId, expectedUserId) {
  const node = await getNode(nodeId, expectedUserId)
  const { data: edges, error } = await supabase
    .from('brain_edges')
    .select('*')
    .eq('user_id', expectedUserId)
    .or(`from_node_id.eq.${nodeId},to_node_id.eq.${nodeId}`)
  if (error) throw error

  for (const edge of edges ?? []) {
    await must(supabase.from('brain_edges').delete().eq('id', edge.id).eq('user_id', expectedUserId))
  }
  await must(supabase.from('brain_nodes').delete().eq('id', nodeId).eq('user_id', expectedUserId))
  await writeLog({ action: 'delete-node', user_id: expectedUserId, node_id: nodeId, before: { node, edges: edges ?? [] }, after: null })
  return { node_id: nodeId, deleted_edges: edges?.length ?? 0 }
}

async function deleteEdge(edgeId, expectedUserId) {
  const { data: edge, error } = await supabase
    .from('brain_edges')
    .select('*')
    .eq('id', edgeId)
    .eq('user_id', expectedUserId)
    .maybeSingle()
  if (error) throw error
  if (!edge) throw new Error(`Edge tidak ditemukan atau bukan milik user aktif: ${edgeId}`)
  await must(supabase.from('brain_edges').delete().eq('id', edgeId).eq('user_id', expectedUserId))
  await writeLog({ action: 'delete-edge', user_id: expectedUserId, edge_id: edgeId, before: edge, after: null })
  return { edge_id: edgeId }
}

async function getNode(nodeId, expectedUserId) {
  const { data, error } = await supabase
    .from('brain_nodes')
    .select('*')
    .eq('id', nodeId)
    .eq('user_id', expectedUserId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error(`Node tidak ditemukan atau bukan milik user aktif: ${nodeId}`)
  return data
}

function mergeAliases(target, source) {
  return [...new Set([
    ...(Array.isArray(target.aliases) ? target.aliases : []),
    ...(Array.isArray(source.aliases) ? source.aliases : []),
    source.name,
    source.canonical_name,
  ].filter(Boolean))]
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function combineText(left, right) {
  if (!left) return right ?? null
  if (!right || left === right) return left
  if (left.includes(right)) return left
  if (right.includes(left)) return right
  return `${left}\n\nMerged note: ${right}`
}

function latestDate(left, right) {
  if (!left) return right ?? null
  if (!right) return left
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right
}

async function must(result) {
  const resolved = await result
  if (resolved.error) throw resolved.error
  return resolved
}

async function createSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) {
    console.log('[brain-quality] Supabase mode: service role')
    return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  }

  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = process.env.SUPABASE_USER_EMAIL
  const password = process.env.SUPABASE_USER_PASSWORD
  if (!email || !password) {
    throw new Error('Set SUPABASE_SERVICE_ROLE_KEY, atau SUPABASE_USER_EMAIL dan SUPABASE_USER_PASSWORD untuk brain-quality.')
  }
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  console.log(`[brain-quality] Supabase mode: signed-in user ${data.user?.email ?? data.user?.id}`)
  return client
}

async function writeLog(entry) {
  const vault = process.env.BRAIN_VAULT_PATH || resolve(rootDir, 'AhyarBrainVault')
  const day = new Date().toISOString().slice(0, 10)
  const path = resolve(vault, '_system', 'logs', `brain-quality-${day}.md`)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, [
    `\n## ${new Date().toISOString()} ${entry.action ?? 'unknown'}`,
    '',
    '```json',
    JSON.stringify(entry, null, 2),
    '```',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const parsed = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    parsed.set(item.slice(2), argv[i + 1] ?? '')
    i += 1
  }
  return parsed
}

function readArg(name) {
  const value = args.get(name)
  if (!value) throw new Error(`Missing required argument --${name}`)
  return value
}

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing env ${name}`)
  return value
}

function loadEnv(path, options = {}) {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const key = match[1]
    if (!options.override && process.env[key]) continue
    process.env[key] = match[2].replace(/^['"]|['"]$/g, '')
  }
}
