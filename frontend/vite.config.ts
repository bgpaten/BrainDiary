import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'

const OWNER_CALIBRATION_INTENTS = ['social_greeting', 'casual_reply', 'request_prompt', 'technical_instruction', 'strategy_question', 'correction', 'identity_question', 'contradiction_check', 'decision_help', 'personal_reflection', 'unknown']
const OWNER_CALIBRATION_ANSWER_STYLES = ['short_direct', 'casual_direct', 'technical_step_by_step', 'prompt_ready', 'strategic_direct', 'reflective', 'corrective', 'neutral']
const SIMILARITY_RUN_TYPES = ['manual', 'daily', 'weekly', 'baseline', 'regression']
const REFLECTION_TYPES = ['daily', 'weekly', 'manual', 'after_import', 'after_digest', 'after_calibration', 'after_similarity_eval']
const REFLECTION_SNAPSHOT_TYPES = ['daily', 'weekly', 'manual', 'baseline']
const REFLECTION_REVIEW_STATUSES = ['approved', 'rejected', 'ignored']
const CONFLICT_REVIEW_DECISIONS = ['keep_open', 'mark_monitoring', 'mark_resolved', 'dismiss', 'merge_with_other', 'needs_more_data']
const SELF_CLONE_SUITE_TYPES = ['baseline', 'daily', 'weekly', 'regression', 'release', 'manual']
const SELF_CLONE_CASE_TYPES = ['social_greeting','casual_reply','owner_answer_similarity','prompt_request','technical_instruction','strategy_question','identity_question','contradiction_handling','insufficient_memory','drift_guard','private_context_guard','style_regression','memory_grounding','reflection_awareness','conflict_awareness','calibration_hint_usage','general_response']
const ENTITY_RUNTIME_MODES = ['read_only', 'proposal_only', 'supervised', 'debug', 'disabled']
const ENTITY_RUNTIME_SESSION_TYPES = ['chat', 'reflection', 'evaluation', 'manual', 'daily_use', 'debug']
const ENTITY_PROPOSAL_REVIEW_STATUSES = ['approved', 'rejected', 'ignored']
const MEMORY_CONSOLIDATION_RUN_TYPES = ['manual', 'daily', 'weekly', 'monthly', 'full', 'after_import', 'after_reflection']
const MEMORY_CONSOLIDATION_SNAPSHOT_TYPES = ['daily', 'weekly', 'monthly', 'manual', 'baseline']
const MEMORY_REVIEW_STATUSES = ['approved', 'rejected', 'ignored']
const FINAL_RELEASE_TYPES = ['manual', 'daily_use', 'release_candidate', 'final']

function localBrainWorkerPlugin() {
  return {
    name: 'local-brain-worker-trigger',
    configureServer(server: any) {
      let running: Promise<{ code: number | null; output: string }> | null = null
      let importRunning: Promise<{ code: number | null; output: string }> | null = null
      let syncRunning: Promise<{ code: number | null; output: string }> | null = null
      let attachmentRunning: Promise<{ code: number | null; output: string }> | null = null
      let indexRunning: Promise<{ code: number | null; output: string }> | null = null
      let qualityRunning: Promise<{ code: number | null; output: string }> | null = null
      let chatRunning: Promise<{ code: number | null; output: string }> | null = null
      let digestRunning: Promise<{ code: number | null; output: string }> | null = null
      let personaRunning: Promise<{ code: number | null; output: string }> | null = null
      let evalRunning: Promise<{ code: number | null; output: string }> | null = null
      let evalCasesRunning: Promise<{ code: number | null; output: string }> | null = null
      let routineRunning: Promise<{ code: number | null; output: string }> | null = null
      let routineDailyRunning: Promise<{ code: number | null; output: string }> | null = null
      let routineThreeDayRunning: Promise<{ code: number | null; output: string }> | null = null
      let routineWeeklyRunning: Promise<{ code: number | null; output: string }> | null = null
      let healthRunning: Promise<{ code: number | null; output: string }> | null = null
      let backupRunning: Promise<{ code: number | null; output: string }> | null = null
      let restoreRunning: Promise<{ code: number | null; output: string }> | null = null
      let recoveryRunning: Promise<{ code: number | null; output: string }> | null = null
      let identityRunning: Promise<{ code: number | null; output: string }> | null = null
      let communicationRunning: Promise<{ code: number | null; output: string }> | null = null
      let responseInferenceRunning: Promise<{ code: number | null; output: string }> | null = null
      let ownerCalibrationRunning: Promise<{ code: number | null; output: string }> | null = null
      let similarityRunning: Promise<{ code: number | null; output: string }> | null = null
      let driftRunning: Promise<{ code: number | null; output: string }> | null = null
      let reflectionRunning: Promise<{ code: number | null; output: string }> | null = null
      let chatSampleRunning: Promise<{ code: number | null; output: string }> | null = null
      let conflictRunning: Promise<{ code: number | null; output: string }> | null = null
      let selfCloneEvalRunning: Promise<{ code: number | null; output: string }> | null = null
      let entityRuntimeRunning: Promise<{ code: number | null; output: string }> | null = null
      let memoryConsolidationRunning: Promise<{ code: number | null; output: string }> | null = null
      let finalReleaseRunning: Promise<{ code: number | null; output: string }> | null = null
      let routineDailyGoogleRunning: Promise<{ code: number | null; output: string }> | null = null

      server.middlewares.use('/__brain-worker/process', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        try {
          const body = await readJsonBody(req)
          const rawEntryId = typeof body.raw_entry_id === 'string' ? body.raw_entry_id : ''
          const limit = typeof body.limit === 'number' ? String(body.limit) : '1'

          if (running) {
            const result = await running
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ status: result.code === 0 ? 'done' : 'failed', output: result.output }))
            return
          }

          const args = ['run', 'brain:worker', '--', '--limit', limit]
          if (rawEntryId) args.push('--raw-entry-id', rawEntryId)
          running = runLocalWorker(args)
          const result = await running
          running = null

          res.statusCode = result.code === 0 ? 200 : 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            status: result.code === 0 ? 'done' : 'failed',
            output: result.output,
          }))
        } catch (err) {
          running = null
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ status: 'failed', error: err instanceof Error ? err.message : String(err) }))
        }
      })

      server.middlewares.use('/__obsidian-importer/import', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(body.limit) : '5'
          if (importRunning) {
            const result = await importRunning
            sendJson(res, result.code === 0 ? 200 : 500, { status: result.code === 0 ? 'done' : 'failed', output: result.output })
            return
          }
          importRunning = runLocalWorker(['run', 'obsidian:import', '--', '--limit', limit])
          const result = await importRunning
          importRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, { status: result.code === 0 ? 'done' : 'failed', output: result.output })
        } catch (err) {
          importRunning = null
          sendJson(res, 500, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__attachments/import', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(20, Math.floor(body.limit)))) : '5'
          if (attachmentRunning) {
            const result = await attachmentRunning
            sendJson(res, result.code === 0 ? 200 : 500, { status: result.code === 0 ? 'done' : 'failed', output: result.output })
            return
          }
          attachmentRunning = runLocalWorker(['run', 'attachments:import', '--', '--limit', limit])
          const result = await attachmentRunning
          attachmentRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, { status: result.code === 0 ? 'done' : 'failed', output: result.output })
        } catch (err) {
          attachmentRunning = null
          sendJson(res, 500, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__obsidian-sync/run', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(500, Math.floor(body.limit)))) : '100'
          const dryRun = body.dryRun === true
          const indexesOnly = body.indexesOnly === true
          if (syncRunning) {
            const result = await syncRunning
            sendJson(res, result.code === 0 ? 200 : 500, { status: result.code === 0 ? 'done' : 'failed', output: result.output })
            return
          }
          syncRunning = runLocalWorker([
            'run', 'obsidian:sync', '--',
            '--limit', limit,
            ...(dryRun ? ['--dry-run'] : []),
            ...(indexesOnly ? ['--indexes-only'] : []),
          ])
          const result = await syncRunning
          syncRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, { status: result.code === 0 ? 'done' : 'failed', output: result.output })
        } catch (err) {
          syncRunning = null
          sendJson(res, 500, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-quality/merge-node', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const userId = readRequiredString(body, 'user_id')
          const sourceNodeId = readRequiredString(body, 'source_node_id')
          const targetNodeId = readRequiredString(body, 'target_node_id')
          const result = await runQualityAction([
            'run', 'brain:quality', '--',
            '--action', 'merge-node',
            '--user-id', userId,
            '--source-node-id', sourceNodeId,
            '--target-node-id', targetNodeId,
          ])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { status: 'failed', error: result.output })
        } catch (err) {
          qualityRunning = null
          sendJson(res, 500, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-quality/delete-node', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const result = await runQualityAction([
            'run', 'brain:quality', '--',
            '--action', 'delete-node',
            '--user-id', readRequiredString(body, 'user_id'),
            '--node-id', readRequiredString(body, 'node_id'),
          ])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { status: 'failed', error: result.output })
        } catch (err) {
          qualityRunning = null
          sendJson(res, 500, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-quality/delete-edge', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const result = await runQualityAction([
            'run', 'brain:quality', '--',
            '--action', 'delete-edge',
            '--user-id', readRequiredString(body, 'user_id'),
            '--edge-id', readRequiredString(body, 'edge_id'),
          ])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { status: 'failed', error: result.output })
        } catch (err) {
          qualityRunning = null
          sendJson(res, 500, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-chat/ask', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const question = readRequiredString(body, 'question')
          if (question.length > 2000) throw new Error('Question terlalu panjang. Maksimum 2000 karakter.')
          const options = typeof body.options === 'object' && body.options ? body.options as Record<string, unknown> : {}
          if (chatRunning) throw new Error('Brain Chat masih memproses pertanyaan sebelumnya.')
          chatRunning = runLocalWorker([
            'run', 'brain:chat', '--',
            '--question', question,
            '--include-raw-entries', readBooleanOption(options, 'includeRawEntries', true),
            '--max-nodes', readNumberOption(options, 'maxNodes', 12, 1, 50),
            '--max-edges', readNumberOption(options, 'maxEdges', 20, 1, 80),
            '--max-raw-entries', readNumberOption(options, 'maxRawEntries', 5, 0, 20),
            '--max-agent-memories', readNumberOption(options, 'maxAgentMemories', 10, 0, 50),
          ])
          const result = await chatRunning
          chatRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          chatRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__response-inference/test', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const question = readRequiredString(body, 'question')
          if (question.length > 2000) throw new Error('Question terlalu panjang. Maksimum 2000 karakter.')
          if (/[<>]|(\.\.\/)|(^\/)|(~\/)/.test(question)) throw new Error('Question mengandung pola path/command yang tidak diterima endpoint test.')
          if (responseInferenceRunning) throw new Error('Response Inference masih memproses pertanyaan sebelumnya.')
          responseInferenceRunning = runLocalWorker(['run', 'response:infer', '--', '--question', question])
          const result = await responseInferenceRunning
          responseInferenceRunning = null
          const parsed = (result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }) as Record<string, any>
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? {
            intent: parsed.intent_type,
            response_shape: parsed.response_shape,
            answer: parsed.answer,
            scores: parsed.inference_scores,
          } : parsed)
        } catch (err) {
          responseInferenceRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__owner-calibration/seed-examples', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          if (ownerCalibrationRunning) throw new Error('Owner Calibration masih berjalan.')
          ownerCalibrationRunning = runLocalWorker(['run', 'owner:examples', '--', '--seed', '--force', body.force === true ? 'true' : 'false'])
          const result = await ownerCalibrationRunning
          ownerCalibrationRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          ownerCalibrationRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__owner-calibration/add-example', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const prompt = readRequiredString(body, 'prompt')
          const ownerAnswer = readRequiredString(body, 'ownerAnswer')
          const intentType = readEnumOption(body, 'intentType', OWNER_CALIBRATION_INTENTS, 'unknown')
          const answerStyle = readEnumOption(body, 'answerStyle', OWNER_CALIBRATION_ANSWER_STYLES, 'neutral')
          const contextNote = typeof body.contextNote === 'string' ? body.contextNote.slice(0, 2000) : ''
          if (prompt.length > 2000) throw new Error('prompt terlalu panjang. Maksimum 2000 karakter.')
          if (ownerAnswer.length > 10000) throw new Error('ownerAnswer terlalu panjang. Maksimum 10000 karakter.')
          if (/[<>]|(\.\.\/)|(^\/)|(~\/)/.test(prompt)) throw new Error('prompt mengandung pola path/command yang tidak diterima endpoint calibration.')
          if (ownerCalibrationRunning) throw new Error('Owner Calibration masih berjalan.')
          ownerCalibrationRunning = runLocalWorker([
            'run', 'owner:examples', '--',
            '--add-example',
            '--prompt', prompt,
            '--owner-answer', ownerAnswer,
            '--intent', intentType,
            '--answer-style', answerStyle,
            '--context-note', contextNote,
          ])
          const result = await ownerCalibrationRunning
          ownerCalibrationRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          ownerCalibrationRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__owner-calibration/run', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(100, Math.floor(body.limit)))) : '25'
          const intentType = typeof body.intentType === 'string' && OWNER_CALIBRATION_INTENTS.includes(body.intentType) ? body.intentType : ''
          const useJudge = body.useJudge === true
          if (ownerCalibrationRunning) throw new Error('Owner Calibration masih berjalan.')
          ownerCalibrationRunning = runLocalWorker([
            'run', 'owner:calibrate', '--',
            '--limit', limit,
            ...(intentType ? ['--intent', intentType] : []),
            ...(useJudge ? ['--use-judge'] : []),
          ])
          const result = await ownerCalibrationRunning
          ownerCalibrationRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          ownerCalibrationRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__owner-calibration/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const result = await runLocalWorker(['run', 'owner:calibrate:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__similarity-eval/run', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(100, Math.floor(body.limit)))) : '50'
          const intentType = typeof body.intentType === 'string' && OWNER_CALIBRATION_INTENTS.includes(body.intentType) ? body.intentType : ''
          const runType = readEnumOption(body, 'runType', SIMILARITY_RUN_TYPES, 'manual')
          const useJudge = body.useJudge === true
          if (similarityRunning) throw new Error('Similarity Evaluation masih berjalan.')
          similarityRunning = runLocalWorker([
            'run', 'similarity:run', '--',
            '--limit', limit,
            '--run-type', runType,
            ...(intentType ? ['--intent', intentType] : []),
            ...(useJudge ? ['--use-judge'] : []),
          ])
          const result = await similarityRunning
          similarityRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          similarityRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__similarity-eval/create-baseline', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const activate = body.activate === true
          if (similarityRunning) throw new Error('Similarity Evaluation masih berjalan.')
          similarityRunning = runLocalWorker(['run', 'similarity:baseline', '--', '--create', ...(activate ? ['--activate'] : [])])
          const result = await similarityRunning
          similarityRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          similarityRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__similarity-eval/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const result = await runLocalWorker(['run', 'similarity:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__similarity-eval/compare', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const baselineId = typeof body.baselineId === 'string' && /^[0-9a-f-]{36}$/i.test(body.baselineId) ? body.baselineId : ''
          const result = await runLocalWorker(['run', 'similarity:compare', '--', ...(baselineId ? ['--baseline-id', baselineId] : [])])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__drift-control/seed-rules', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          if (driftRunning) throw new Error('Drift Control masih berjalan.')
          driftRunning = runLocalWorker(['run', 'drift:rules', '--', '--seed', '--force', body.force === true ? 'true' : 'false'])
          const result = await driftRunning
          driftRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          driftRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__drift-control/check', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const question = readRequiredString(body, 'question')
          const answer = readRequiredString(body, 'answer')
          const intentType = readEnumOption(body, 'intentType', OWNER_CALIBRATION_INTENTS, 'unknown')
          if (question.length > 2000) throw new Error('question terlalu panjang. Maksimum 2000 karakter.')
          if (answer.length > 20000) throw new Error('answer terlalu panjang. Maksimum 20000 karakter.')
          if (/[<>]|(\.\.\/)|(^\/)|(~\/)/.test(question)) throw new Error('question mengandung pola path/command yang tidak diterima.')
          if (driftRunning) throw new Error('Drift Control masih berjalan.')
          driftRunning = runLocalWorker(['run', 'drift:check', '--', '--question', question, '--answer', answer, '--intent-type', intentType])
          const result = await driftRunning
          driftRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          driftRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__drift-control/create-baseline', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          if (driftRunning) throw new Error('Drift Control masih berjalan.')
          driftRunning = runLocalWorker(['run', 'drift:baseline', '--', ...(body.activate === false ? ['--create'] : ['--activate'])])
          const result = await driftRunning
          driftRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          driftRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__drift-control/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const result = await runLocalWorker(['run', 'drift:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__self-reflection/run', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const type = readEnumOption(body, 'type', REFLECTION_TYPES, 'manual')
          const from = body.from === null || body.from === undefined ? '' : (typeof body.from === 'string' && isDateOnly(body.from) ? body.from : (() => { throw new Error('from harus null atau YYYY-MM-DD.') })())
          const to = body.to === null || body.to === undefined ? '' : (typeof body.to === 'string' && isDateOnly(body.to) ? body.to : (() => { throw new Error('to harus null atau YYYY-MM-DD.') })())
          if (from && to && from > to) throw new Error('from tidak boleh setelah to.')
          const snapshot = readStrictBoolean(body, 'snapshot', false)
          if (reflectionRunning) throw new Error('Self-Reflection masih berjalan.')
          reflectionRunning = runLocalWorker([
            'run', 'reflection:run', '--',
            '--type', type,
            ...(from ? ['--from', from] : []),
            ...(to ? ['--to', to] : []),
            ...(snapshot ? ['--snapshot'] : []),
          ])
          const result = await reflectionRunning
          reflectionRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          reflectionRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__self-reflection/snapshot', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const type = readEnumOption(body, 'type', REFLECTION_SNAPSHOT_TYPES, 'manual')
          if (reflectionRunning) throw new Error('Self-Reflection masih berjalan.')
          reflectionRunning = runLocalWorker(['run', 'reflection:snapshot', '--', '--type', type])
          const result = await reflectionRunning
          reflectionRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          reflectionRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__self-reflection/update-suggestion', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const suggestionId = typeof body.suggestionId === 'string' && /^[0-9a-f-]{36}$/i.test(body.suggestionId) ? body.suggestionId : ''
          if (!suggestionId) throw new Error('suggestionId tidak valid (harus uuid).')
          const status = readEnumOption(body, 'status', REFLECTION_REVIEW_STATUSES, '')
          if (!status) throw new Error('status hanya boleh approved/rejected/ignored.')
          if (reflectionRunning) throw new Error('Self-Reflection masih berjalan.')
          // MVP: hanya mengubah status suggestion; identity_facts/communication_patterns TIDAK disentuh.
          reflectionRunning = runLocalWorker(['run', 'reflection:suggestions', '--', '--update', suggestionId, '--status', status])
          const result = await reflectionRunning
          reflectionRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          reflectionRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__self-reflection/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const result = await runLocalWorker(['run', 'reflection:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__chat-samples/import', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(100, Math.floor(body.limit)))) : '10'
          const dryRun = readStrictBoolean(body, 'dryRun', false)
          if (chatSampleRunning) throw new Error('Chat Sample Importer masih berjalan.')
          chatSampleRunning = runLocalWorker(['run', 'chats:import', '--', '--limit', limit, ...(dryRun ? ['--dry-run'] : [])])
          const result = await chatSampleRunning
          chatSampleRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          chatSampleRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__chat-samples/audit', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const save = readStrictBoolean(body, 'save', true)
          if (chatSampleRunning) throw new Error('Chat Sample Importer masih berjalan.')
          chatSampleRunning = runLocalWorker(['run', 'chats:audit', '--', '--save', save ? 'true' : 'false'])
          const result = await chatSampleRunning
          chatSampleRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          chatSampleRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__chat-samples/pairs', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          if (chatSampleRunning) throw new Error('Chat Sample Importer masih berjalan.')
          chatSampleRunning = runLocalWorker(['run', 'chats:pairs'])
          const result = await chatSampleRunning
          chatSampleRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          chatSampleRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__chat-samples/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const result = await runLocalWorker(['run', 'chats:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__identity-conflicts/detect', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(500, Math.floor(body.limit)))) : '100'
          const from = body.from === null || body.from === undefined ? null : String(body.from)
          const to = body.to === null || body.to === undefined ? null : String(body.to)
          if (from && !isDateOnly(from)) throw new Error('from harus YYYY-MM-DD atau null.')
          if (to && !isDateOnly(to)) throw new Error('to harus YYYY-MM-DD atau null.')
          if (conflictRunning) throw new Error('Identity Conflict Resolver masih berjalan.')
          conflictRunning = runLocalWorker(['run', 'conflicts:detect', '--', '--limit', limit, ...(from ? ['--from', from] : []), ...(to ? ['--to', to] : [])])
          const result = await conflictRunning
          conflictRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          conflictRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__identity-conflicts/review', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const conflictId = readRequiredString(body, 'conflictId')
          if (!isUuid(conflictId)) throw new Error('conflictId tidak valid.')
          const decision = readEnumOption(body, 'decision', CONFLICT_REVIEW_DECISIONS, 'needs_more_data')
          const ownerNote = typeof body.ownerNote === 'string' ? body.ownerNote : ''
          if (ownerNote.length > 5000) throw new Error('ownerNote maksimal 5000 karakter.')
          if (conflictRunning) throw new Error('Identity Conflict Resolver masih berjalan.')
          conflictRunning = runLocalWorker(['run', 'conflicts:review', '--', '--conflict-id', conflictId, '--decision', decision, ...(ownerNote ? ['--owner-note', ownerNote] : [])])
          const result = await conflictRunning
          conflictRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          conflictRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__identity-conflicts/audit', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const save = readStrictBoolean(body, 'save', true)
          if (conflictRunning) throw new Error('Identity Conflict Resolver masih berjalan.')
          conflictRunning = runLocalWorker(['run', 'conflicts:audit', '--', '--save', save ? 'true' : 'false'])
          const result = await conflictRunning
          conflictRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          conflictRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__identity-conflicts/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const result = await runLocalWorker(['run', 'conflicts:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__self-clone-eval/generate-cases', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const suiteType = readEnumOption(body, 'suiteType', SELF_CLONE_SUITE_TYPES, 'release')
          const force = readStrictBoolean(body, 'force', false)
          if (selfCloneEvalRunning) throw new Error('Self-Clone Evaluation masih berjalan.')
          selfCloneEvalRunning = runLocalWorker(['run', 'clone:cases', '--', '--generate', '--suite', suiteType, ...(force ? ['--force'] : [])])
          const result = await selfCloneEvalRunning
          selfCloneEvalRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          selfCloneEvalRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__self-clone-eval/run', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const suiteType = readEnumOption(body, 'suiteType', SELF_CLONE_SUITE_TYPES, 'release')
          const caseType = body.caseType === null || body.caseType === undefined ? null : String(body.caseType)
          if (caseType && !SELF_CLONE_CASE_TYPES.includes(caseType)) throw new Error('caseType tidak valid.')
          const useJudge = readStrictBoolean(body, 'useJudge', false)
          if (selfCloneEvalRunning) throw new Error('Self-Clone Evaluation masih berjalan.')
          selfCloneEvalRunning = runLocalWorker(['run', suiteType === 'release' && !caseType ? 'clone:release' : 'clone:run', '--', '--suite', suiteType, ...(caseType ? ['--case-type', caseType] : []), ...(useJudge ? ['--use-judge'] : [])])
          const result = await selfCloneEvalRunning
          selfCloneEvalRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          selfCloneEvalRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__self-clone-eval/audit', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const save = readStrictBoolean(body, 'save', true)
          if (selfCloneEvalRunning) throw new Error('Self-Clone Evaluation masih berjalan.')
          selfCloneEvalRunning = runLocalWorker(['run', 'clone:audit', '--', '--save', save ? 'true' : 'false'])
          const result = await selfCloneEvalRunning
          selfCloneEvalRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          selfCloneEvalRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__self-clone-eval/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const result = await runLocalWorker(['run', 'clone:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__entity-runtime/seed-policies', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const force = readStrictBoolean(body, 'force', false)
          if (entityRuntimeRunning) throw new Error('Entity Runtime masih berjalan.')
          entityRuntimeRunning = runLocalWorker(['run', 'entity:policies', '--', '--seed', ...(force ? ['--force'] : [])])
          const result = await entityRuntimeRunning
          entityRuntimeRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          entityRuntimeRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__entity-runtime/start-session', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const runtimeMode = readEnumOption(body, 'runtimeMode', ENTITY_RUNTIME_MODES, 'read_only')
          const sessionType = readEnumOption(body, 'sessionType', ENTITY_RUNTIME_SESSION_TYPES, 'manual')
          if (entityRuntimeRunning) throw new Error('Entity Runtime masih berjalan.')
          entityRuntimeRunning = runLocalWorker(['run', 'entity:session', '--', '--start', '--mode', runtimeMode, '--session-type', sessionType])
          const result = await entityRuntimeRunning
          entityRuntimeRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          entityRuntimeRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__entity-runtime/end-session', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const sessionId = readRequiredString(body, 'sessionId')
          if (!isUuid(sessionId)) throw new Error('sessionId tidak valid.')
          if (entityRuntimeRunning) throw new Error('Entity Runtime masih berjalan.')
          entityRuntimeRunning = runLocalWorker(['run', 'entity:session', '--', '--end', '--session-id', sessionId])
          const result = await entityRuntimeRunning
          entityRuntimeRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          entityRuntimeRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__entity-runtime/check', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const question = readRequiredString(body, 'question')
          if (question.length > 5000) throw new Error('question terlalu panjang.')
          const dryRun = readStrictBoolean(body, 'dryRun', true)
          if (entityRuntimeRunning) throw new Error('Entity Runtime masih berjalan.')
          entityRuntimeRunning = runLocalWorker(['run', 'entity:run', '--', '--question', question, ...(dryRun ? ['--dry-run'] : [])])
          const result = await entityRuntimeRunning
          entityRuntimeRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          entityRuntimeRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__entity-runtime/review-proposal', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const proposalId = readRequiredString(body, 'proposalId')
          if (!isUuid(proposalId)) throw new Error('proposalId tidak valid.')
          const status = readEnumOption(body, 'status', ENTITY_PROPOSAL_REVIEW_STATUSES, '')
          if (!status) throw new Error('status proposal tidak valid.')
          const reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote : ''
          if (reviewNote.length > 5000) throw new Error('reviewNote terlalu panjang.')
          if (entityRuntimeRunning) throw new Error('Entity Runtime masih berjalan.')
          entityRuntimeRunning = runLocalWorker(['run', 'entity:proposal', '--', '--review', '--proposal-id', proposalId, '--status', status, ...(reviewNote ? ['--review-note', reviewNote] : [])])
          const result = await entityRuntimeRunning
          entityRuntimeRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          entityRuntimeRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__entity-runtime/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const result = await runLocalWorker(['run', 'entity:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__entity-runtime/audit', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const save = readStrictBoolean(body, 'save', true)
          if (entityRuntimeRunning) throw new Error('Entity Runtime masih berjalan.')
          entityRuntimeRunning = runLocalWorker(['run', 'entity:audit', '--', '--save', save ? 'true' : 'false'])
          const result = await entityRuntimeRunning
          entityRuntimeRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          entityRuntimeRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__memory-consolidation/run', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const runType = readEnumOption(body, 'runType', MEMORY_CONSOLIDATION_RUN_TYPES, 'manual')
          const from = body.from === null || body.from === undefined || body.from === '' ? '' : String(body.from)
          const to = body.to === null || body.to === undefined || body.to === '' ? '' : String(body.to)
          if (from && !isDateOnly(from)) throw new Error('from harus YYYY-MM-DD atau null.')
          if (to && !isDateOnly(to)) throw new Error('to harus YYYY-MM-DD atau null.')
          if (from && to && from > to) throw new Error('from tidak boleh setelah to.')
          const full = readStrictBoolean(body, 'full', false)
          const snapshot = readStrictBoolean(body, 'snapshot', true)
          if (memoryConsolidationRunning) throw new Error('Memory Consolidation masih berjalan.')
          memoryConsolidationRunning = runLocalWorker(['run', full ? 'memory:consolidate:full' : 'memory:consolidate', '--', '--run-type', full ? 'full' : runType, ...(from ? ['--from', from] : []), ...(to ? ['--to', to] : []), ...(snapshot ? ['--snapshot', 'true'] : [])])
          const result = await memoryConsolidationRunning
          memoryConsolidationRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          memoryConsolidationRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__memory-consolidation/snapshot', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const snapshotType = readEnumOption(body, 'snapshotType', MEMORY_CONSOLIDATION_SNAPSHOT_TYPES, 'manual')
          if (memoryConsolidationRunning) throw new Error('Memory Consolidation masih berjalan.')
          memoryConsolidationRunning = runLocalWorker(['run', 'memory:snapshot', '--', '--snapshot-type', snapshotType])
          const result = await memoryConsolidationRunning
          memoryConsolidationRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          memoryConsolidationRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__memory-consolidation/review', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const reviewItemId = readRequiredString(body, 'reviewItemId')
          if (!isUuid(reviewItemId)) throw new Error('reviewItemId tidak valid.')
          const status = readEnumOption(body, 'status', MEMORY_REVIEW_STATUSES, '')
          if (!status) throw new Error('status review tidak valid.')
          const ownerNote = typeof body.ownerNote === 'string' ? body.ownerNote : ''
          if (ownerNote.length > 5000) throw new Error('ownerNote terlalu panjang.')
          if (memoryConsolidationRunning) throw new Error('Memory Consolidation masih berjalan.')
          memoryConsolidationRunning = runLocalWorker(['run', 'memory:review', '--', '--update', reviewItemId, '--status', status, ...(ownerNote ? ['--owner-note', ownerNote] : [])])
          const result = await memoryConsolidationRunning
          memoryConsolidationRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          memoryConsolidationRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__memory-consolidation/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const result = await runLocalWorker(['run', 'memory:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__memory-consolidation/audit', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const save = readStrictBoolean(body, 'save', true)
          if (memoryConsolidationRunning) throw new Error('Memory Consolidation masih berjalan.')
          memoryConsolidationRunning = runLocalWorker(['run', 'memory:audit', '--', '--save', save ? 'true' : 'false'])
          const result = await memoryConsolidationRunning
          memoryConsolidationRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          memoryConsolidationRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__final-release/check', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const releaseType = readEnumOption(body, 'releaseType', FINAL_RELEASE_TYPES, 'release_candidate')
          if (finalReleaseRunning) throw new Error('Final Release check masih berjalan.')
          finalReleaseRunning = runLocalWorker(['run', 'release:check', '--', '--type', releaseType])
          const result = await finalReleaseRunning
          finalReleaseRunning = null
          sendJson(res, result.code === 0 || result.code === 2 ? 200 : 500, result.code === 0 || result.code === 2 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          finalReleaseRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__final-release/final', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const version = typeof body.version === 'string' ? body.version.trim() : ''
          if (version.length > 50) throw new Error('version terlalu panjang.')
          if (finalReleaseRunning) throw new Error('Final Release check masih berjalan.')
          finalReleaseRunning = runLocalWorker(['run', 'release:final', '--', ...(version ? ['--version', version] : [])])
          const result = await finalReleaseRunning
          finalReleaseRunning = null
          sendJson(res, result.code === 0 || result.code === 2 ? 200 : 500, result.code === 0 || result.code === 2 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          finalReleaseRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__final-release/notes', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const version = typeof body.version === 'string' ? body.version.trim() : ''
          if (version.length > 50) throw new Error('version terlalu panjang.')
          if (finalReleaseRunning) throw new Error('Final Release check masih berjalan.')
          finalReleaseRunning = runLocalWorker(['run', 'release:notes', '--', ...(version ? ['--version', version] : [])])
          const result = await finalReleaseRunning
          finalReleaseRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          finalReleaseRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__final-release/latest', async (req: any, res: any) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const result = await runLocalWorker(['run', 'release:latest'])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__final-release/audit', async (req: any, res: any) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
        try {
          const body = await readJsonBody(req)
          const save = readStrictBoolean(body, 'save', true)
          if (finalReleaseRunning) throw new Error('Final Release audit masih berjalan.')
          finalReleaseRunning = runLocalWorker(['run', 'release:audit', '--', '--save', save ? 'true' : 'false'])
          const result = await finalReleaseRunning
          finalReleaseRunning = null
          sendJson(res, result.code === 0 || result.code === 2 ? 200 : 500, result.code === 0 || result.code === 2 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          finalReleaseRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-indexer/index', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(100, Math.floor(body.limit)))) : '25'
          const force = body.force === true
          if (indexRunning) throw new Error('Brain Indexer masih berjalan.')
          indexRunning = runLocalWorker(['run', 'brain:index', '--', '--limit', limit, ...(force ? ['--force'] : [])])
          const result = await indexRunning
          indexRunning = null
          sendJson(res, result.code === 0 ? 200 : 500, { status: result.code === 0 ? 'done' : 'failed', output: result.output })
        } catch (err) {
          indexRunning = null
          sendJson(res, 500, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-indexer/search', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const query = readRequiredString(body, 'query')
          if (query.length > 2000) throw new Error('Query terlalu panjang. Maksimum 2000 karakter.')
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(50, Math.floor(body.limit)))) : '10'
          const tables = Array.isArray(body.tables)
            ? body.tables.filter((item) => typeof item === 'string' && ['brain_nodes', 'brain_edges', 'agent_memories', 'raw_entries'].includes(item)).join(',')
            : 'brain_nodes,brain_edges,agent_memories,raw_entries'
          const result = await runLocalWorker(['run', 'brain:index', '--', '--search-query', query, '--limit', limit, '--tables', tables])
          sendJson(res, result.code === 0 ? 200 : 500, result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-digest/generate', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const type = typeof body.type === 'string' && ['daily', 'weekly', 'monthly', 'custom'].includes(body.type) ? body.type : 'daily'
          const from = typeof body.from === 'string' && isDateOnly(body.from) ? body.from : ''
          const to = typeof body.to === 'string' && isDateOnly(body.to) ? body.to : ''
          const force = body.force === true
          if (type === 'custom' && (!from || !to)) throw new Error('Custom digest membutuhkan from/to YYYY-MM-DD.')
          if (from && to && from > to) throw new Error('from tidak boleh setelah to.')
          if (digestRunning) throw new Error('Brain Digest masih berjalan.')
          digestRunning = runLocalWorker([
            'run', 'brain:digest', '--',
            '--type', type,
            ...(from ? ['--from', from] : []),
            ...(to ? ['--to', to] : []),
            ...(force ? ['--force'] : []),
          ])
          const result = await digestRunning
          digestRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          digestRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-persona/refresh', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const force = body.force === true
          if (personaRunning) throw new Error('Persona Builder masih berjalan.')
          personaRunning = runLocalWorker(['run', force ? 'brain:persona:refresh' : 'brain:persona'])
          const result = await personaRunning
          personaRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          personaRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__identity-fidelity/build', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(500, Math.floor(body.limit)))) : '100'
          const snapshot = readStrictBoolean(body, 'snapshot', true)
          readStrictBoolean(body, 'force', false)
          if (identityRunning) throw new Error('Identity Fidelity Engine masih berjalan.')
          identityRunning = runLocalWorker([
            'run', 'identity:build', '--',
            '--limit', limit,
            '--snapshot', snapshot ? 'true' : 'false',
          ])
          const result = await identityRunning
          identityRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          identityRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__communication-style/build', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(500, Math.floor(body.limit)))) : '100'
          readStrictBoolean(body, 'force', false)
          if (communicationRunning) throw new Error('Communication Style Model masih berjalan.')
          communicationRunning = runLocalWorker(['run', 'communication:build', '--', '--limit', limit])
          const result = await communicationRunning
          communicationRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          communicationRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-eval/generate-cases', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(100, Math.floor(body.limit)))) : '25'
          const force = body.force === true
          if (evalCasesRunning) throw new Error('Brain Eval case generator masih berjalan.')
          evalCasesRunning = runLocalWorker(['run', 'brain:eval:cases', '--', '--limit', limit, ...(force ? ['--force'] : [])])
          const result = await evalCasesRunning
          evalCasesRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          evalCasesRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-eval/run', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(100, Math.floor(body.limit)))) : '25'
          const useJudge = body.useJudge === true
          if (evalRunning) throw new Error('Brain Evaluation masih berjalan.')
          evalRunning = runLocalWorker(['run', 'brain:eval', '--', '--limit', limit, '--use-judge', useJudge ? 'true' : 'false'])
          const result = await evalRunning
          evalRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          evalRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-routine/run', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const type = typeof body.type === 'string' && ['daily', 'manual'].includes(body.type) ? body.type : 'manual'
          const limit = typeof body.limit === 'number' ? String(Math.max(1, Math.min(50, Math.floor(body.limit)))) : '5'
          const skipEval = readStrictBoolean(body, 'skipEval', false)
          const skipAttachments = readStrictBoolean(body, 'skipAttachments', false)
          const skipSync = readStrictBoolean(body, 'skipSync', false)
          const dryRun = readStrictBoolean(body, 'dryRun', false)
          if (routineRunning) throw new Error('Daily Brain Routine masih berjalan.')
          routineRunning = runLocalWorker([
            'run',
            type === 'daily' ? 'brain:routine:today' : 'brain:routine',
            '--',
            '--limit', limit,
            ...(skipEval ? ['--skip-eval'] : []),
            ...(skipAttachments ? ['--skip-attachments'] : []),
            ...(skipSync ? ['--skip-sync'] : []),
            ...(dryRun ? ['--dry-run'] : []),
          ])
          const result = await routineRunning
          routineRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          routineRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      // --- Allowlisted routine profiles (local dev only) ----------------------
      // Keamanan: endpoint TIDAK menerima command/path dari browser. Hanya boolean
      // `confirm: true`. Tiap endpoint terikat ke satu npm script tetap (allowlist).
      const routineProfileEndpoints: Array<{
        url: string
        script: string
        label: string
        getLock: () => Promise<{ code: number | null; output: string }> | null
        setLock: (value: Promise<{ code: number | null; output: string }> | null) => void
      }> = [
        {
          url: '/__brain-routine/run-daily',
          script: 'brain:routine:daily',
          label: 'Routine harian',
          getLock: () => routineDailyRunning,
          setLock: (value) => { routineDailyRunning = value },
        },
        {
          url: '/__brain-routine/run-three-day',
          script: 'brain:routine:three-day',
          label: 'Routine 3 hari',
          getLock: () => routineThreeDayRunning,
          setLock: (value) => { routineThreeDayRunning = value },
        },
        {
          url: '/__brain-routine/run-weekly',
          script: 'brain:routine:weekly',
          label: 'Routine mingguan',
          getLock: () => routineWeeklyRunning,
          setLock: (value) => { routineWeeklyRunning = value },
        },
        {
          url: '/__brain-routine/run-daily-google',
          script: 'brain:routine:daily:google',
          label: 'Routine harian + Google History',
          getLock: () => routineDailyGoogleRunning,
          setLock: (value) => { routineDailyGoogleRunning = value },
        },
      ]

      for (const endpoint of routineProfileEndpoints) {
        server.middlewares.use(endpoint.url, async (req: any, res: any) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }

          try {
            const body = await readJsonBody(req)
            // Hanya menerima request fixed: confirm === true. Tidak ada command/path.
            if (body.confirm !== true) {
              sendJson(res, 400, { ok: false, error: 'confirm harus boolean true.' })
              return
            }
            if (endpoint.getLock()) {
              throw new Error(`${endpoint.label} masih berjalan.`)
            }
            // Command bersifat tetap (allowlist), tidak pernah dibangun dari input user.
            const lock = runLocalWorker(['run', endpoint.script])
            endpoint.setLock(lock)
            const result = await lock
            endpoint.setLock(null)
            const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
            sendJson(res, result.code === 0 ? 200 : 500, {
              ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }),
              stdout: result.output,
            })
          } catch (err) {
            endpoint.setLock(null)
            sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        })
      }

      server.middlewares.use('/__brain-routine/health', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        try {
          const body = await readJsonBody(req)
          const save = readStrictBoolean(body, 'save', true)
          if (healthRunning) throw new Error('Brain Health Check masih berjalan.')
          healthRunning = runLocalWorker(['run', 'brain:health', '--', '--save', save ? 'true' : 'false'])
          const result = await healthRunning
          healthRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          healthRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-backup/create', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const includeVault = readStrictBoolean(body, 'includeVault', true)
          const includeEnv = readStrictBoolean(body, 'includeEnv', false)
          const compress = readStrictBoolean(body, 'compress', false)
          if (backupRunning) throw new Error('Brain Backup masih berjalan.')
          backupRunning = runLocalWorker([
            'run', 'brain:backup', '--',
            ...(includeVault ? [] : ['--no-vault']),
            '--include-env', includeEnv ? 'true' : 'false',
            '--compress', compress ? 'true' : 'false',
          ])
          const result = await backupRunning
          backupRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          backupRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-backup/list', async (req: any, res: any) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const result = await runLocalWorker(['run', 'brain:backup:list'])
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, parsed)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-backup/preview-restore', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const backupId = readBackupId(body)
          const result = await runLocalWorker(['run', 'brain:restore:preview', '--', '--backup', backupId])
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-backup/restore', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const backupId = readBackupId(body)
          const confirm = readStrictBoolean(body, 'confirm', false)
          const mode = typeof body.mode === 'string' && body.mode === 'upsert' ? 'upsert' : ''
          if (!confirm) throw new Error('Restore membutuhkan confirm=true.')
          if (mode !== 'upsert') throw new Error('Restore MVP hanya mendukung mode upsert.')
          if (restoreRunning) throw new Error('Brain Restore masih berjalan.')
          restoreRunning = runLocalWorker(['run', 'brain:restore', '--', '--backup', backupId, '--confirm', '--mode', 'upsert'])
          const result = await restoreRunning
          restoreRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          restoreRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      server.middlewares.use('/__brain-backup/recovery-check', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          readStrictBoolean(body, 'save', true)
          if (recoveryRunning) throw new Error('Brain Recovery Check masih berjalan.')
          recoveryRunning = runLocalWorker(['run', 'brain:recovery', '--', '--check'])
          const result = await recoveryRunning
          recoveryRunning = null
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          sendJson(res, result.code === 0 ? 200 : 500, { ...(typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : { output: parsed }), stdout: result.output })
        } catch (err) {
          recoveryRunning = null
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })

      async function runQualityAction(args: string[]) {
        if (qualityRunning) throw new Error('Brain quality action masih berjalan.')
        qualityRunning = runLocalWorker(args)
        const result = await qualityRunning
        qualityRunning = null
        return result
      }

      // --- Google History pending status endpoint ---
      server.middlewares.use('/__google-history/pending', async (req: any, res: any) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        try {
          const result = await runLocalWorker(['run', 'google:history:audit'])
          const parsed = result.code === 0 ? parseOutput(result.output) : { ok: false, error: result.output }
          const data = typeof parsed === 'object' && parsed ? parsed as Record<string, any> : {}
          sendJson(res, result.code === 0 ? 200 : 500, {
            pending_count: data?.raw_entries?.pending ?? 0,
            latest_collected_date: data?.latest_collected_date ?? null,
            latest_processed_date: data?.latest_processed_date ?? null,
            failed_count: data?.raw_entries?.failed ?? 0,
            done_count: data?.raw_entries?.done ?? 0,
          })
        } catch (err) {
          sendJson(res, 500, {
            pending_count: 0,
            latest_collected_date: null,
            latest_processed_date: null,
            failed_count: 0,
            done_count: 0,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    },
  }
}

function sendJson(res: any, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function readJsonBody(req: any): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function readRequiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required field: ${key}`)
  }
  return value
}

function readNumberOption(options: Record<string, unknown>, key: string, fallback: number, min: number, max: number): string {
  const value = typeof options[key] === 'number' ? options[key] as number : fallback
  if (!Number.isFinite(value)) return String(fallback)
  return String(Math.max(min, Math.min(max, Math.floor(value))))
}

function readBooleanOption(options: Record<string, unknown>, key: string, fallback: boolean): string {
  const value = typeof options[key] === 'boolean' ? options[key] as boolean : fallback
  return value ? 'true' : 'false'
}

function readEnumOption(body: Record<string, unknown>, key: string, allowed: string[], fallback: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !allowed.includes(value)) return fallback
  return value
}

function readStrictBoolean(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${key} harus boolean.`)
  return value
}

function readBackupId(body: Record<string, unknown>): string {
  const value = body.backupId
  if (typeof value !== 'string' || !/^brain-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('backupId tidak valid.')
  }
  return value
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function parseOutput(output: string): unknown {
  const trimmed = output.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall back to the last JSON-looking line for scripts that print status logs.
  }
  const line = trimmed.split(/\r?\n/).reverse().find((item) => item.trim().startsWith('{'))
  if (!line) return { status: 'done', output }
  try {
    return JSON.parse(line)
  } catch {
    return { status: 'done', output }
  }
}

function runLocalWorker(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm', args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('close', (code) => resolve({ code, output }))
    child.on('error', (err) => resolve({ code: 1, output: err.message }))
  })
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), localBrainWorkerPlugin()],
  server: {
    port: 5173,
  },
})
