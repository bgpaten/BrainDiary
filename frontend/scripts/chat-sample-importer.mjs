import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHAT_AUTO_START = '<!-- CHAT_SAMPLE_IMPORT_AUTO_START -->'
const CHAT_AUTO_END = '<!-- CHAT_SAMPLE_IMPORT_AUTO_END -->'
const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv'])
const SYSTEM_SPEAKERS = new Set(['system', 'admin', 'bot'])

loadEnv(resolve(process.cwd(), '.env'))
loadEnv(resolve(process.cwd(), '.env.local'))
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env'), { override: true })
loadEnv(resolve(process.cwd(), 'scripts/brain-worker.env.local'), { override: true })

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const command = detectCommand(args)
    const result = command === 'audit'
      ? await auditChatSamples({ save: args.get('save') !== 'false' })
      : command === 'pairs'
        ? await generatePairsForExistingImports()
        : command === 'latest'
          ? await getLatestChatSamples()
          : await runChatImport({
            file: readOptionalArg(args, 'file'),
            limit: readIntArg(args, 'limit', readIntEnv('CHAT_SAMPLE_MAX_FILES', 50, 1, 100), 1, 100),
            dryRun: args.has('dry-run'),
            watch: args.has('watch'),
          })
    console.log(JSON.stringify(result, null, 2))
  } catch (err) {
    console.error(`[chat-sample-importer] failed ${messageOf(err)}`)
    process.exit(1)
  }
}

export async function runChatImport(options = {}) {
  if (!readBoolEnv('CHAT_SAMPLE_IMPORT_ENABLED', true)) throw new Error('CHAT_SAMPLE_IMPORT_ENABLED=false.')
  const config = readConfig()
  ensureDir(config.chatSampleDir)
  if (options.watch) {
    const first = await runChatImport({ ...options, watch: false })
    const intervalMs = readIntEnv('CHAT_SAMPLE_WATCH_INTERVAL_MS', 30000, 5000, 3600000)
    while (true) {
      await sleep(intervalMs)
      await runChatImport({ ...options, watch: false })
    }
  }

  const files = scanChatFiles(config.chatSampleDir, options.file, options.limit ?? config.maxFiles)
  const dryRun = options.dryRun === true
  const supabase = dryRun ? null : await createSupabaseClient()
  const userId = dryRun ? 'dry-run-user' : await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk chat sample import.')

  const summary = emptySummary()
  summary.files_found = files.length
  summary.dry_run = dryRun
  const warnings = []
  const imported = []

  for (const file of files) {
    const sourceFile = toDisplayPath(file)
    try {
      const raw = readFileSync(file, 'utf8')
      const sourceHash = sha256(raw)
      const sourceFormat = detectSourceFormat(file, raw)
      if (!SUPPORTED_EXTENSIONS.has(extname(file).toLowerCase())) {
        warnings.push(`${sourceFile}: unsupported extension`)
        if (!dryRun) await createReview(supabase, userId, null, 'unsupported_format', sourceFile, 'Format file tidak didukung.', { source_file: sourceFile })
        summary.reviews_needed += 1
        continue
      }
      if (config.dedupByHash && !dryRun) {
        const existing = await findExistingImport(supabase, userId, sourceHash)
        if (existing) {
          summary.skipped_duplicates += 1
          imported.push({ source_file: sourceFile, status: 'skipped', reason: 'duplicate_source_hash', chat_import_id: existing.id })
          continue
        }
      }

      const parsed = parseMessages(file, raw, sourceFormat, config)
      const capped = parsed.messages.slice(0, config.maxMessagesPerFile)
      const enriched = capped.map((message, index) => enrichMessage(message, index, config, parsed.conversationKey))
      const reviews = buildReviewsForMessages(enriched, config)
      const pairs = buildReplyPairs(enriched)
      const ownerMessages = enriched.filter((message) => message.is_owner_message)
      const otherMessages = enriched.filter((message) => message.speaker_role === 'other')

      summary.files_imported += dryRun ? 0 : 1
      summary.total_messages += enriched.length
      summary.owner_messages += ownerMessages.length
      summary.other_messages += otherMessages.length
      summary.reply_pairs += pairs.length
      summary.reviews_needed += reviews.length
      if (reviews.length) warnings.push(`${sourceFile}: ${reviews.length} item perlu review.`)

      if (dryRun) {
        imported.push({ source_file: sourceFile, status: 'dry_run', source_format: sourceFormat, total_messages: enriched.length, owner_messages: ownerMessages.length, reply_pairs: pairs.length, reviews: reviews.length })
        continue
      }

      const chatImport = await insertChatImport(supabase, userId, {
        source_file: sourceFile,
        source_hash: sourceHash,
        source_format: sourceFormat,
        owner_aliases: config.ownerAliases,
        status: reviews.length ? 'needs_review' : 'done',
        total_messages: enriched.length,
        owner_messages: ownerMessages.length,
        other_messages: otherMessages.length,
        conversation_count: new Set(enriched.map((message) => message.conversation_key)).size,
        metadata: { parser: parsed.parser, truncated: parsed.messages.length > capped.length, original_message_count: parsed.messages.length },
      })
      const savedMessages = await insertChatMessages(supabase, userId, chatImport.id, enriched)
      await insertReviews(supabase, userId, chatImport.id, reviews)
      const pairResult = await insertReplyPairs(supabase, userId, chatImport.id, pairs, savedMessages, config)
      const sampleResult = await insertCommunicationSamples(supabase, userId, savedMessages, config)
      await updateChatImport(supabase, chatImport.id, { status: pairResult.reviews_added || reviews.length ? 'needs_review' : 'done', imported_at: new Date().toISOString(), metadata: { ...chatImport.metadata, pair_count: pairResult.created, communication_samples_created: sampleResult.created } })

      summary.owner_examples_created += pairResult.owner_examples_created
      summary.communication_samples_created += sampleResult.created
      summary.used_for_calibration += pairResult.used_for_calibration
      summary.reviews_needed += pairResult.reviews_added
      imported.push({ source_file: sourceFile, status: reviews.length ? 'needs_review' : 'done', chat_import_id: chatImport.id, total_messages: enriched.length, owner_messages: ownerMessages.length, reply_pairs: pairResult.created })
    } catch (err) {
      summary.failed += 1
      warnings.push(`${sourceFile}: ${messageOf(err)}`)
      if (!dryRun && supabase && userId) {
        const failedImport = await insertChatImport(supabase, userId, {
          source_file: sourceFile,
          source_hash: fileHashSafe(file),
          source_format: 'unknown',
          owner_aliases: config.ownerAliases,
          status: 'failed',
          total_messages: 0,
          owner_messages: 0,
          other_messages: 0,
          conversation_count: 0,
          metadata: { error: messageOf(err) },
        }).catch(() => null)
        await createReview(supabase, userId, failedImport?.id ?? null, 'parse_error', sourceFile, messageOf(err), { source_file: sourceFile })
      }
    }
  }

  summary.warnings = warnings
  summary.imports = imported
  summary.next_commands = ['npm run communication:build', 'npm run owner:calibrate', 'npm run similarity:run']
  if (config.outputObsidian) writeChatReports(summary, [], [])
  return { ok: summary.failed === 0, summary }
}

export async function generatePairsForExistingImports(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk chat pairs.')
  const { data: imports, error } = await supabase.from('chat_imports').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(options.limit ?? 50)
  if (error) throw error
  let created = 0
  for (const item of imports ?? []) {
    const { data: messages, error: msgError } = await supabase.from('chat_messages').select('*').eq('user_id', userId).eq('chat_import_id', item.id).order('message_index', { ascending: true })
    if (msgError) throw msgError
    const pairInputs = buildReplyPairs((messages ?? []).map((message, index) => ({ ...message, id: message.id, message_index: index })))
    const result = await insertReplyPairs(supabase, userId, item.id, pairInputs, messages ?? [], readConfig())
    created += result.created
  }
  return { ok: true, pairs_created: created }
}

export async function auditChatSamples(options = {}) {
  const config = readConfig()
  ensureDir(config.chatSampleDir)
  const files = scanChatFiles(config.chatSampleDir, null, config.maxFiles)
  const supabase = await createSupabaseClient()
  const userId = await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk audit chat sample.')
  const [imports, messages, pairs, reviews, examples, samples] = await Promise.all([
    countRows(supabase, 'chat_imports', userId),
    countRows(supabase, 'chat_messages', userId),
    countRows(supabase, 'chat_reply_pairs', userId),
    countRows(supabase, 'chat_import_reviews', userId, (q) => q.eq('status', 'pending')),
    countRows(supabase, 'owner_answer_examples', userId, (q) => q.eq('source_type', 'chat_sample')),
    countRows(supabase, 'communication_samples', userId, (q) => q.eq('source_type', 'imported_chat')),
  ])
  const duplicateHashes = await duplicateImportHashes(supabase, userId)
  const unknownSpeakers = await countRows(supabase, 'chat_messages', userId, (q) => q.eq('speaker_role', 'unknown'))
  const warnings = []
  if (!files.length) warnings.push(`Belum ada file chat di ${config.chatSampleDir}`)
  if (!config.ownerAliases.length) warnings.push('CHAT_SAMPLE_OWNER_ALIASES belum diset.')
  if (unknownSpeakers > 0) warnings.push(`${unknownSpeakers} messages speaker_role unknown.`)
  if (reviews > 0) warnings.push(`${reviews} review chat pending.`)
  if (duplicateHashes > 0) warnings.push(`${duplicateHashes} duplicate source_hash imports.`)
  if (messages > 0 && pairs === 0) warnings.push('Belum ada reply pairs dari chat messages.')
  const score = Math.max(0, 100 - warnings.length * 12 - (reviews > 0 ? 10 : 0) - (unknownSpeakers > 0 ? 10 : 0))
  const status = score >= 85 ? 'healthy' : score >= 60 ? 'warning' : 'critical'
  const result = {
    ok: status !== 'critical',
    status,
    score,
    checks: {
      folder_exists: existsSync(config.chatSampleDir),
      chat_sample_dir: config.chatSampleDir,
      file_count: files.length,
      imports_count: imports,
      duplicate_imports: duplicateHashes,
      unknown_speakers: unknownSpeakers,
      owner_aliases_configured: config.ownerAliases.length,
      owner_messages_count: await countRows(supabase, 'chat_messages', userId, (q) => q.eq('is_owner_message', true)),
      reply_pairs_count: pairs,
      owner_examples_created: examples,
      communication_samples_created: samples,
      sensitive_reviews_pending: await countRows(supabase, 'chat_import_reviews', userId, (q) => q.eq('review_type', 'possible_sensitive_content').eq('status', 'pending')),
      parsing_errors: await countRows(supabase, 'chat_import_reviews', userId, (q) => q.eq('review_type', 'parse_error')),
    },
    warnings,
    recommended_fixes: recommendedFixes(warnings),
  }
  if (options.save !== false && config.outputObsidian) writeChatReports({ ...emptySummary(), warnings, audit: result }, [], [])
  return result
}

export async function getLatestChatSamples(options = {}) {
  const supabase = await createSupabaseClient()
  const userId = options.userId || await resolveUserId(supabase)
  if (!userId) throw new Error('user_id tidak tersedia untuk latest chat sample.')
  const [importsRes, pairsRes, reviewsRes] = await Promise.all([
    supabase.from('chat_imports').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('chat_reply_pairs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(30),
    supabase.from('chat_import_reviews').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(30),
  ])
  const firstError = importsRes.error || pairsRes.error || reviewsRes.error
  if (firstError) throw firstError
  const imports = importsRes.data ?? []
  const replyPairs = pairsRes.data ?? []
  const reviews = reviewsRes.data ?? []
  const summary = {
    total_files: imports.length,
    messages: sum(imports, 'total_messages'),
    owner_messages: sum(imports, 'owner_messages'),
    other_messages: sum(imports, 'other_messages'),
    reply_pairs: replyPairs.length,
    owner_examples_created: replyPairs.filter((pair) => pair.owner_answer_example_id).length,
    review_needed: reviews.filter((review) => review.status === 'pending').length,
    skipped_duplicates: imports.filter((item) => item.status === 'skipped').length,
  }
  writeChatReports({ ...emptySummary(), ...summary, files_imported: imports.length }, replyPairs, reviews)
  return { ok: true, latest_imports: imports, reply_pairs: replyPairs, reviews, summary }
}

function parseMessages(file, raw, sourceFormat, config) {
  if (sourceFormat === 'json') return parseJsonMessages(file, raw)
  if (sourceFormat === 'csv') return parseCsvMessages(file, raw)
  if (sourceFormat === 'whatsapp_txt') return parseWhatsAppMessages(file, raw, config)
  return parsePlainTextMessages(file, raw, config)
}

function parsePlainTextMessages(file, raw) {
  const messages = []
  const lines = raw.split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const match = line.match(/^\[(.+?)\]\s*([^:]+):\s*(.*)$/)
    if (match) {
      if (current) messages.push(current)
      current = { timestamp: parseTimestamp(match[1]), speaker: match[2].trim(), text: match[3].trim() }
    } else if (current && line.trim()) {
      current.text += `\n${line.trim()}`
    }
  }
  if (current) messages.push(current)
  if (!messages.length) throw new Error('Tidak ada pesan plain text valid.')
  return { parser: 'plain_text', conversationKey: conversationKeyFor(file), messages }
}

function parseWhatsAppMessages(file, raw) {
  const messages = []
  const lines = raw.split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const match = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}[.:]\d{2})\s*-\s*([^:]+):\s*(.*)$/)
    if (match) {
      if (current) messages.push(current)
      current = { timestamp: parseWhatsAppTimestamp(match[1], match[2]), speaker: match[3].trim(), text: match[4].trim() }
    } else if (current && line.trim()) {
      current.text += `\n${line.trim()}`
    }
  }
  if (current) messages.push(current)
  if (!messages.length) throw new Error('Tidak ada pesan WhatsApp-like valid.')
  return { parser: 'whatsapp_txt', conversationKey: conversationKeyFor(file), messages }
}

function parseJsonMessages(file, raw) {
  const parsed = JSON.parse(raw)
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.messages) ? parsed.messages : []
  if (!rows.length) throw new Error('JSON harus berupa array messages atau object { messages }.')
  return {
    parser: 'json',
    conversationKey: conversationKeyFor(file),
    messages: rows.map((row) => ({ timestamp: parseTimestamp(row.timestamp ?? row.time ?? row.date), speaker: String(row.speaker ?? row.sender ?? row.author ?? '').trim(), text: String(row.text ?? row.message ?? row.content ?? '').trim() })).filter((row) => row.text),
  }
}

function parseCsvMessages(file, raw) {
  const rows = parseCsv(raw)
  if (!rows.length) throw new Error('CSV kosong.')
  const header = rows[0].map((value) => normalizeWords(value))
  const timestampIdx = findHeader(header, ['timestamp', 'time', 'date'])
  const speakerIdx = findHeader(header, ['speaker', 'sender', 'author'])
  const textIdx = findHeader(header, ['text', 'message', 'content'])
  if (speakerIdx < 0 || textIdx < 0) throw new Error('CSV wajib punya kolom speaker dan text.')
  return {
    parser: 'csv',
    conversationKey: conversationKeyFor(file),
    messages: rows.slice(1).map((row) => ({ timestamp: timestampIdx >= 0 ? parseTimestamp(row[timestampIdx]) : null, speaker: String(row[speakerIdx] ?? '').trim(), text: String(row[textIdx] ?? '').trim() })).filter((row) => row.text),
  }
}

function enrichMessage(message, index, config, conversationKey) {
  const speaker = String(message.speaker ?? '').trim()
  const speakerNorm = normalizeAlias(speaker)
  const isSystem = SYSTEM_SPEAKERS.has(speakerNorm)
  const isOwner = config.ownerAliasesNormalized.has(speakerNorm)
  const speakerRole = isSystem ? 'system' : isOwner ? 'owner' : speaker ? 'other' : 'unknown'
  const classified = classifyText(message.text)
  return {
    conversation_key: conversationKey,
    message_index: index,
    timestamp: message.timestamp,
    speaker: speaker || null,
    speaker_role: speakerRole,
    text: message.text.trim(),
    normalized_text: normalizeWords(message.text),
    language: detectLanguage(message.text),
    ...classified,
    is_owner_message: speakerRole === 'owner',
    metadata: { owner_detection: speakerRole === 'owner' ? 'alias_match' : speakerRole === 'unknown' ? 'missing_speaker' : isSystem ? 'system_speaker' : 'not_owner_alias' },
  }
}

function buildReplyPairs(messages) {
  const pairs = []
  const byConversation = groupBy(messages, (message) => message.conversation_key)
  for (const [conversationKey, items] of byConversation) {
    const sorted = [...items].sort((a, b) => Number(a.message_index) - Number(b.message_index))
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const prompt = sorted[i]
      const reply = sorted[i + 1]
      if (prompt.speaker_role !== 'other' || reply.speaker_role !== 'owner') continue
      const answerStyle = detectAnswerStyle(reply.text, reply.intent_type, reply.length_class)
      pairs.push({
        conversation_key: conversationKey,
        prompt_message_index: prompt.message_index,
        owner_reply_message_index: reply.message_index,
        prompt_text: prompt.text,
        owner_reply_text: reply.text,
        intent_type: prompt.intent_type === 'unknown' ? reply.intent_type : prompt.intent_type,
        answer_style: answerStyle,
        confidence_score: pairConfidence(prompt, reply),
        metadata: { generated_by: 'chat_sample_importer', prompt_speaker: prompt.speaker, owner_speaker: reply.speaker },
      })
    }
  }
  return pairs
}

async function insertReplyPairs(supabase, userId, chatImportId, pairs, savedMessages, config) {
  let created = 0
  let ownerExamplesCreated = 0
  let usedForCalibration = 0
  const reviews = []
  const byIndex = new Map(savedMessages.map((message) => [Number(message.message_index), message]))
  for (const pair of pairs) {
    const prompt = byIndex.get(Number(pair.prompt_message_index))
    const reply = byIndex.get(Number(pair.owner_reply_message_index))
    if (!prompt || !reply) continue
    const insert = await supabase.from('chat_reply_pairs').upsert({
      user_id: userId,
      chat_import_id: chatImportId,
      conversation_key: pair.conversation_key,
      prompt_message_id: prompt.id,
      owner_reply_message_id: reply.id,
      prompt_text: pair.prompt_text,
      owner_reply_text: pair.owner_reply_text,
      intent_type: pair.intent_type,
      answer_style: pair.answer_style,
      confidence_score: pair.confidence_score,
      used_for_calibration: false,
      metadata: pair.metadata,
    }, { onConflict: 'prompt_message_id,owner_reply_message_id', ignoreDuplicates: true }).select('*').maybeSingle()
    if (insert.error) throw insert.error
    const savedPair = insert.data
    if (!savedPair) continue
    created += 1
    if (config.autoCreateOwnerExamples) {
      const example = await createOwnerAnswerExample(supabase, userId, savedPair)
      if (example.created) {
        ownerExamplesCreated += 1
        usedForCalibration += savedPair.confidence_score >= 0.75 ? 1 : 0
        await supabase.from('chat_reply_pairs').update({ used_for_calibration: savedPair.confidence_score >= 0.75, owner_answer_example_id: example.id }).eq('id', savedPair.id)
      }
    }
    if (Number(savedPair.confidence_score) < 0.75) reviews.push(savedPair.id)
  }
  return { created, owner_examples_created: ownerExamplesCreated, used_for_calibration: usedForCalibration, reviews_added: reviews.length }
}

async function createOwnerAnswerExample(supabase, userId, pair) {
  const prompt = pair.prompt_text.trim()
  const ownerAnswer = pair.owner_reply_text.trim()
  const exampleHash = sha256(`${normalizeWords(prompt)}\n${ownerAnswer}`)
  const row = {
    user_id: userId,
    prompt,
    normalized_prompt: normalizeWords(prompt),
    owner_answer: ownerAnswer,
    example_hash: exampleHash,
    intent_type: mapOwnerExampleIntent(pair.intent_type),
    answer_style: pair.answer_style,
    language: detectLanguage(ownerAnswer),
    tone: classifyText(ownerAnswer).tone === 'formal' ? 'neutral' : classifyText(ownerAnswer).tone,
    formality: classifyText(ownerAnswer).formality,
    length_class: classifyText(ownerAnswer).length_class,
    context_note: 'Imported from owner chat sample reply pair.',
    source_type: 'chat_sample',
    source_ref: { chat_reply_pair_id: pair.id, chat_import_id: pair.chat_import_id },
    quality_score: pair.confidence_score,
    status: Number(pair.confidence_score) >= 0.75 ? 'active' : 'needs_review',
    metadata: { generated_by: 'chat_sample_importer' },
  }
  const existing = await supabase.from('owner_answer_examples').select('id').eq('user_id', userId).eq('example_hash', exampleHash).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data?.id) return { created: false, id: existing.data.id }
  const { data, error } = await supabase.from('owner_answer_examples').insert(row).select('id').single()
  if (error) throw error
  return { created: true, id: data.id }
}

async function insertCommunicationSamples(supabase, userId, savedMessages) {
  let created = 0
  for (const message of savedMessages.filter((item) => item.is_owner_message)) {
    const existing = await supabase.from('communication_samples').select('id').eq('user_id', userId).eq('source_type', 'imported_chat').eq('source_id', message.id).maybeSingle()
    if (existing.error) throw existing.error
    if (existing.data?.id) continue
    const { error } = await supabase.from('communication_samples').insert({
      user_id: userId,
      sample_type: 'chat_message',
      source_type: 'imported_chat',
      source_id: message.id,
      text: message.text,
      normalized_text: message.normalized_text,
      language: message.language,
      tone: message.tone === 'formal' ? 'neutral' : message.tone,
      formality: message.formality,
      length_class: message.length_class === 'very_short' ? 'short' : message.length_class,
      intent_type: message.intent_type,
      context_label: `Imported chat: ${message.conversation_key}`,
      confidence_score: message.speaker_role === 'owner' ? 0.88 : 0.45,
      metadata: { generated_by: 'chat_sample_importer', chat_import_id: message.chat_import_id },
    })
    if (error && error.code !== '23505') throw error
    if (!error) created += 1
  }
  return { created }
}

async function insertChatImport(supabase, userId, row) {
  const { data, error } = await supabase.from('chat_imports').insert({ user_id: userId, ...row }).select('*').single()
  if (error) throw error
  return data
}

async function updateChatImport(supabase, id, patch) {
  const { error } = await supabase.from('chat_imports').update(patch).eq('id', id)
  if (error) throw error
}

async function insertChatMessages(supabase, userId, chatImportId, messages) {
  const rows = messages.map((message) => ({
    user_id: userId,
    chat_import_id: chatImportId,
    conversation_key: message.conversation_key,
    message_index: message.message_index,
    timestamp: message.timestamp,
    speaker: message.speaker,
    speaker_role: message.speaker_role,
    text: message.text,
    normalized_text: message.normalized_text,
    language: message.language,
    intent_type: message.intent_type,
    tone: message.tone,
    formality: message.formality,
    length_class: message.length_class,
    is_owner_message: message.is_owner_message,
    metadata: message.metadata,
  }))
  const { data, error } = await supabase.from('chat_messages').insert(rows).select('*')
  if (error) throw error
  return data ?? []
}

async function insertReviews(supabase, userId, chatImportId, reviews) {
  if (!reviews.length) return []
  const rows = reviews.map((review) => ({ user_id: userId, chat_import_id: chatImportId, ...review }))
  const { data, error } = await supabase.from('chat_import_reviews').insert(rows).select('*')
  if (error) throw error
  return data ?? []
}

async function createReview(supabase, userId, chatImportId, reviewType, label, description, payload = {}) {
  const { error } = await supabase.from('chat_import_reviews').insert({ user_id: userId, chat_import_id: chatImportId, review_type: reviewType, label, description, payload, status: 'pending' })
  if (error) throw error
}

function buildReviewsForMessages(messages, config) {
  const reviews = []
  for (const message of messages) {
    if (message.speaker_role === 'unknown') {
      reviews.push({ review_type: 'unknown_speaker', label: `Unknown speaker message ${message.message_index}`, description: 'Speaker kosong atau tidak bisa diparse.', payload: { message_index: message.message_index, text_excerpt: excerpt(message.text, 220) }, status: 'pending' })
    }
    if (config.reviewSensitive && looksSensitive(message.text)) {
      reviews.push({ review_type: 'possible_sensitive_content', label: `Possible sensitive content ${message.message_index}`, description: 'Pesan mengandung pola data sensitif dan perlu review sebelum dipakai luas.', payload: { message_index: message.message_index, speaker_role: message.speaker_role }, status: 'pending' })
    }
  }
  return reviews
}

function classifyText(text) {
  const normalized = normalizeWords(text)
  const greeting = /^(hi|hai|halo|hello|p+|ping|assalamualaikum|assalamu alaikum|selamat pagi|selamat malam)\b/.test(normalized)
  const casual = /^(oke|ok|iya|ya|ngga|nggak|gak|gas|siap|lanjut|wkwk|hehe|boleh)\b/.test(normalized)
  const requestPrompt = /\b(buatkan|bikin|tuliskan).{0,40}\bprompt\b|\bprompt untuk\b|\bsiap paste\b/.test(normalized)
  const technical = /\b(error|command|script|file|database|supabase|frontend|backend|implementasi|migration|endpoint|npm|json|csv|table|rls)\b/.test(normalized)
  const correction = /\b(revisi|kurang|salah|ubah|belum sesuai|perbaiki|fix)\b/.test(normalized)
  const strategy = /\b(menurutmu|fokus apa|langkah terbaik|lanjut apa|strategi|prioritas)\b/.test(normalized)
  const reflection = /\b(saya merasa|saya pikir|kenapa saya|aku merasa|aku pikir)\b/.test(normalized)
  const followUp = /^(lanjut|terus|next)\b/.test(normalized)
  const complaint = /\b(capek|kesal|gagal|berantakan|ribet|lambat)\b/.test(normalized)
  const decision = /\b(putuskan|pilih|keputusan|ambil opsi|lebih baik)\b/.test(normalized)
  const intent_type = greeting ? 'greeting' : requestPrompt ? 'request_prompt' : technical ? 'technical_instruction' : correction ? 'correction' : strategy ? 'strategy_question' : reflection ? 'reflection' : followUp ? 'follow_up' : complaint ? 'complaint' : decision ? 'decision' : casual ? 'casual_reply' : 'unknown'
  const length_class = classifyLength(text)
  const tone = technical ? 'technical' : correction ? 'firm' : reflection ? 'reflective' : greeting || casual || followUp ? 'casual' : strategy || requestPrompt || decision ? 'direct' : 'neutral'
  const formality = /\b(wkwk|bro|gue|lu|ngga|nggak|gak|gas|aja|dong)\b/.test(normalized) || length_class === 'very_short' ? 'very_casual' : /\b(mohon|terima kasih|dengan hormat)\b/.test(normalized) ? 'formal' : tone === 'casual' ? 'casual' : 'neutral'
  return { intent_type, tone, formality, length_class }
}

function detectAnswerStyle(text, intent, lengthClass) {
  const normalized = normalizeWords(text)
  if (['very_short', 'short'].includes(lengthClass) && !/\n|1\.|2\./.test(text)) return 'short_direct'
  if (/\b(error|command|script|file|database|supabase|frontend|backend|implementasi|migration|endpoint|npm|```)\b/.test(normalized)) return 'technical_step_by_step'
  if (/\b(prompt|siap paste|copy paste|format)\b/.test(normalized)) return 'prompt_ready'
  if (/\b(strategi|prioritas|fokus|langkah terbaik|opsi)\b/.test(normalized) || intent === 'strategy_question') return 'strategic_direct'
  if (/\b(revisi|ubah|salah|kurang|belum sesuai)\b/.test(normalized) || intent === 'correction') return 'corrective'
  if (/\b(saya merasa|saya pikir|menurut saya|refleksi)\b/.test(normalized) || intent === 'reflection') return 'reflective'
  return /\b(oke|iya|siap|boleh|gas)\b/.test(normalized) ? 'casual_direct' : 'neutral'
}

function pairConfidence(prompt, reply) {
  let score = 0.72
  if (prompt.speaker_role === 'other' && reply.speaker_role === 'owner') score += 0.12
  if (prompt.timestamp && reply.timestamp) score += 0.04
  if (reply.intent_type !== 'unknown') score += 0.04
  if (reply.text.length > 0 && prompt.text.length > 0) score += 0.04
  return round4(score)
}

function detectSourceFormat(file, raw) {
  const ext = extname(file).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.csv') return 'csv'
  if ((ext === '.txt' || ext === '.md') && /^\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}[.:]\d{2}\s*-\s*[^:]+:/m.test(raw)) return 'whatsapp_txt'
  if (ext === '.txt') return 'txt'
  if (ext === '.md') return 'md'
  return 'unknown'
}

function scanChatFiles(dir, singleFile, limit) {
  const root = resolve(dir)
  if (singleFile) {
    const file = resolve(process.cwd(), singleFile)
    assertInside(file, root)
    if (!existsSync(file)) throw new Error(`File tidak ditemukan: ${file}`)
    if (!statSync(file).isFile()) throw new Error(`Bukan file: ${file}`)
    return [file]
  }
  const out = []
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    const st = statSync(full)
    if (st.isFile() && SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())) out.push(full)
  }
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, limit)
}

function readConfig() {
  const chatSampleDir = resolvePath(process.env.CHAT_SAMPLE_DIR ?? '../AhyarBrainVault/85_Chat_Samples')
  const ownerAliases = String(process.env.CHAT_SAMPLE_OWNER_ALIASES ?? 'Ahyar,Kukuh,Ahyar Pattani,owner,me,saya').split(',').map((item) => item.trim()).filter(Boolean)
  return {
    chatSampleDir,
    ownerAliases,
    ownerAliasesNormalized: new Set(ownerAliases.map(normalizeAlias)),
    outputObsidian: readBoolEnv('CHAT_SAMPLE_OUTPUT_OBSIDIAN', true),
    autoCreateOwnerExamples: readBoolEnv('CHAT_SAMPLE_AUTO_CREATE_OWNER_EXAMPLES', true),
    maxFiles: readIntEnv('CHAT_SAMPLE_MAX_FILES', 50, 1, 100),
    maxMessagesPerFile: readIntEnv('CHAT_SAMPLE_MAX_MESSAGES_PER_FILE', 5000, 1, 50000),
    dedupByHash: readBoolEnv('CHAT_SAMPLE_DEDUP_BY_HASH', true),
    reviewSensitive: readBoolEnv('CHAT_SAMPLE_REVIEW_SENSITIVE', true),
    vaultPath: resolvePath(process.env.OBSIDIAN_VAULT_PATH ?? '../AhyarBrainVault'),
  }
}

function writeChatReports(summary, replyPairs = [], reviews = []) {
  const config = readConfig()
  const dir = resolve(config.vaultPath, '_system', 'chat-samples')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'Chat Import Latest.md'), [
    '# Chat Import Latest',
    '',
    CHAT_AUTO_START,
    `Generated: ${new Date().toISOString()}`,
    `Files imported: ${summary.files_imported ?? 0}`,
    `Total messages: ${summary.total_messages ?? summary.messages ?? 0}`,
    `Owner messages: ${summary.owner_messages ?? 0}`,
    `Other messages: ${summary.other_messages ?? 0}`,
    `Reply pairs: ${summary.reply_pairs ?? 0}`,
    `Owner examples created: ${summary.owner_examples_created ?? 0}`,
    `Communication samples created: ${summary.communication_samples_created ?? 0}`,
    `Skipped duplicates: ${summary.skipped_duplicates ?? 0}`,
    `Reviews needed: ${summary.reviews_needed ?? summary.review_needed ?? 0}`,
    '',
    '## Warnings',
    ...((summary.warnings ?? []).length ? summary.warnings.map((item) => `- ${item}`) : ['- Tidak ada warning.']),
    '',
    '## Next Steps',
    '- npm run communication:build',
    '- npm run owner:calibrate',
    '- npm run similarity:run',
    CHAT_AUTO_END,
    '',
  ].join('\n'), 'utf8')
  writeFileSync(resolve(dir, 'Chat Reply Pairs.md'), [
    '# Chat Reply Pairs',
    '',
    CHAT_AUTO_START,
    ...(replyPairs.length ? replyPairs.map((pair) => `- ${pair.intent_type} / ${pair.answer_style} / ${pair.confidence_score}: "${excerpt(pair.prompt_text, 120)}" -> "${excerpt(pair.owner_reply_text, 160)}"`) : ['- Belum ada reply pair terbaru.']),
    CHAT_AUTO_END,
    '',
  ].join('\n'), 'utf8')
  writeFileSync(resolve(dir, 'Chat Import Reviews.md'), [
    '# Chat Import Reviews',
    '',
    CHAT_AUTO_START,
    ...(reviews.length ? reviews.map((review) => `- ${review.status} / ${review.review_type}: ${review.label} — ${review.description}`) : ['- Tidak ada review terbaru.']),
    CHAT_AUTO_END,
    '',
  ].join('\n'), 'utf8')
}

async function createSupabaseClient() {
  const url = requiredEnv('SUPABASE_URL', process.env.VITE_SUPABASE_URL)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceKey) return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const anonKey = requiredEnv('SUPABASE_ANON_KEY', process.env.VITE_SUPABASE_ANON_KEY)
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined })
  if (!accessToken && process.env.SUPABASE_USER_EMAIL && process.env.SUPABASE_USER_PASSWORD) {
    const { error } = await client.auth.signInWithPassword({ email: process.env.SUPABASE_USER_EMAIL, password: process.env.SUPABASE_USER_PASSWORD })
    if (error) throw error
  }
  return client
}

async function resolveUserId(supabase) {
  if (process.env.OBSIDIAN_USER_ID) return process.env.OBSIDIAN_USER_ID
  const authUser = await supabase.auth.getUser().catch(() => null)
  if (authUser?.data?.user?.id) return authUser.data.user.id
  for (const table of ['chat_imports', 'owner_answer_examples', 'raw_entries', 'communication_samples', 'brain_nodes']) {
    const { data, error } = await supabase.from(table).select('user_id').limit(1).maybeSingle()
    if (!error && data?.user_id) return data.user_id
  }
  return null
}

async function findExistingImport(supabase, userId, sourceHash) {
  const { data, error } = await supabase.from('chat_imports').select('id,status').eq('user_id', userId).eq('source_hash', sourceHash).in('status', ['done', 'needs_review']).limit(1).maybeSingle()
  if (error) throw error
  return data
}

async function countRows(supabase, table, userId, decorate = null) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId)
  if (decorate) query = decorate(query)
  const { count, error } = await query
  if (error?.code === '42P01') return 0
  if (error) throw error
  return count ?? 0
}

async function duplicateImportHashes(supabase, userId) {
  const { data, error } = await supabase.from('chat_imports').select('source_hash').eq('user_id', userId)
  if (error?.code === '42P01') return 0
  if (error) throw error
  const counts = new Map()
  for (const row of data ?? []) counts.set(row.source_hash, (counts.get(row.source_hash) ?? 0) + 1)
  return [...counts.values()].filter((count) => count > 1).length
}

function parseCsv(raw) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    const next = raw[i + 1]
    if (ch === '"' && inQuotes && next === '"') {
      cell += '"'
      i += 1
    } else if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      row.push(cell)
      cell = ''
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1
      row.push(cell)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

function findHeader(header, names) {
  return header.findIndex((item) => names.includes(item))
}

function parseTimestamp(value) {
  if (!value) return null
  const raw = String(value).trim()
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parseWhatsAppTimestamp(datePart, timePart) {
  const [day, month, rawYear] = datePart.split('/').map(Number)
  const year = rawYear < 100 ? 2000 + rawYear : rawYear
  const [hour, minute] = timePart.replace('.', ':').split(':').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function classifyLength(text) {
  const words = tokens(text).length
  if (words <= 2) return 'very_short'
  if (words <= 12) return 'short'
  if (words <= 60) return 'medium'
  return 'long'
}

function detectLanguage(text) {
  const normalized = normalizeWords(text)
  if (/\b(the|and|you|please|what|how|error|file|command)\b/.test(normalized) && !/\b(saya|aku|yang|dan|untuk|lanjut)\b/.test(normalized)) return 'en'
  return 'id'
}

function mapOwnerExampleIntent(intent) {
  if (intent === 'greeting') return 'social_greeting'
  if (intent === 'decision') return 'decision_help'
  if (intent === 'reflection') return 'personal_reflection'
  return ['casual_reply', 'request_prompt', 'technical_instruction', 'strategy_question', 'correction', 'unknown'].includes(intent) ? intent : 'unknown'
}

function looksSensitive(text) {
  return /(?:\b\d{12,16}\b)|(?:password|token|secret|api[_-]?key|rekening|nik|ktp|alamat rumah)/i.test(text)
}

function recommendedFixes(warnings) {
  if (!warnings.length) return ['Tidak ada fix wajib.']
  return warnings.map((warning) => {
    if (warning.includes('Belum ada file')) return 'Tambahkan file .txt/.md/.json/.csv ke AhyarBrainVault/85_Chat_Samples.'
    if (warning.includes('OWNER_ALIASES')) return 'Isi CHAT_SAMPLE_OWNER_ALIASES dengan nama owner di chat export.'
    if (warning.includes('unknown')) return 'Review speaker yang tidak jelas lalu ubah file sumber agar speaker owner/other eksplisit.'
    if (warning.includes('reply pairs')) return 'Pastikan urutan pesan other lalu owner berdekatan.'
    return 'Review Chat Import Reviews di Obsidian atau database.'
  })
}

function emptySummary() {
  return { files_found: 0, files_imported: 0, failed: 0, total_messages: 0, owner_messages: 0, other_messages: 0, reply_pairs: 0, owner_examples_created: 0, communication_samples_created: 0, skipped_duplicates: 0, reviews_needed: 0, used_for_calibration: 0, warnings: [] }
}

function detectCommand(args) {
  if (args.has('audit')) return 'audit'
  if (args.has('pairs')) return 'pairs'
  if (args.has('latest')) return 'latest'
  return 'import'
}

function conversationKeyFor(file) {
  return basename(file).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'chat-sample'
}

function resolvePath(value) {
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value)
}

function assertInside(file, root) {
  const rel = relative(root, file)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) throw new Error('Path harus berada di CHAT_SAMPLE_DIR.')
}

function toDisplayPath(file) {
  return relative(resolve(process.cwd(), '..'), file).replaceAll(sep, '/')
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function fileHashSafe(file) {
  try {
    return sha256(readFileSync(file, 'utf8'))
  } catch {
    return sha256(`${file}:${Date.now()}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function tokens(text) {
  return normalizeWords(text).split(' ').filter((token) => token.length > 0)
}

function normalizeWords(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeAlias(value) {
  return normalizeWords(value).replace(/\s+/g, ' ')
}

function groupBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return map
}

function excerpt(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
}

function round4(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Number(Math.max(0, Math.min(1, num)).toFixed(4))
}

function readIntEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function readBoolEnv(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args.set(key, next)
      i += 1
    } else {
      args.set(key, true)
    }
  }
  return args
}

function readOptionalArg(args, name) {
  const value = args.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readIntArg(args, name, fallback, min, max) {
  const raw = args.get(name)
  const value = raw ? Number(raw) : fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`${name} belum diset.`)
  return value
}

function loadEnv(path, options = {}) {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const index = trimmed.indexOf('=')
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (options.override || process.env[key] === undefined) process.env[key] = value
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}
