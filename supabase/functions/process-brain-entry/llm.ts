// =============================================================================
// LLM client — model-agnostic.
//
// Default: protokol Anthropic Messages API (POST /v1/messages) dengan
// FORCED TOOL USE (tool_choice) untuk menjamin output JSON terstruktur.
//
// Bisa diganti tanpa mengubah logic Brain Engine, lewat env:
//   LLM_PROTOCOL = "anthropic" (default) | "openai"
//   LLM_BASE_URL / ANTHROPIC_BASE_URL   (mis. https://cc.freemodel.dev)
//   LLM_API_KEY  / ANTHROPIC_API_KEY
//   LLM_MODEL / ANTHROPIC_MODEL / CLAUDE_CODE_MODEL
// =============================================================================

interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

function env(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = Deno.env.get(k)
    if (v) return v
  }
  return undefined
}

function llmConfig() {
  const protocol = (env('LLM_PROTOCOL') ?? 'anthropic').toLowerCase()
  const rawBaseUrl = env('LLM_BASE_URL', 'ANTHROPIC_BASE_URL')
  const apiKey = env('LLM_API_KEY', 'ANTHROPIC_API_KEY')
  const model = env('LLM_MODEL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_MODEL') ?? defaultModelFor(protocol)
  if (!apiKey) throw new Error('LLM_API_KEY / ANTHROPIC_API_KEY belum disetel.')
  if (!rawBaseUrl) throw new Error('LLM_BASE_URL / ANTHROPIC_BASE_URL belum disetel.')
  const baseUrl = rawBaseUrl.replace(/\/+$/, '')
  return { protocol, baseUrl, apiKey, model }
}

function defaultModelFor(protocol: string): string {
  if (protocol === 'openai') {
    throw new Error('LLM_MODEL wajib disetel untuk LLM_PROTOCOL=openai.')
  }
  // Kompatibel dengan konfigurasi Claude Code/Anthropic proxy seperti FreeModel.
  // Tetap bisa dioverride dengan LLM_MODEL, ANTHROPIC_MODEL, atau CLAUDE_CODE_MODEL.
  return 'claude-sonnet-4-20250514'
}

// Memanggil LLM dan mengembalikan objek hasil tool (sudah ter-parse).
export async function callLLM(
  systemPrompt: string,
  userContent: string,
  tool: ToolDef,
): Promise<unknown> {
  const { protocol, baseUrl, apiKey, model } = llmConfig()
  if (protocol === 'openai') {
    return await callOpenAICompatible(baseUrl, apiKey, model, systemPrompt, userContent, tool)
  }
  return await callAnthropic(baseUrl, apiKey, model, systemPrompt, userContent, tool)
}

// --- Anthropic Messages API -------------------------------------------------
async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  tool: ToolDef,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      tools: [tool],
      // Paksa model memanggil tool -> output terstruktur dijamin.
      tool_choice: { type: 'tool', name: tool.name },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LLM (anthropic) HTTP ${res.status}: ${body.slice(0, 500)}`)
  }

  const data = await res.json()
  const block = Array.isArray(data?.content)
    ? data.content.find((b: { type?: string; name?: string }) => b?.type === 'tool_use' && b?.name === tool.name)
    : undefined
  if (!block || typeof block.input !== 'object') {
    const text = extractAnthropicText(data)
    const parsed = parseJsonObject(text)
    if (parsed) return parsed

    return await callAnthropicJsonFallback(baseUrl, apiKey, model, systemPrompt, userContent, tool, text)
  }
  return block.input
}

async function callAnthropicJsonFallback(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  tool: ToolDef,
  previousText: string,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: [
        systemPrompt,
        'Provider/proxy ini tidak selalu mendukung tool_use. Balas HANYA JSON valid, tanpa markdown, tanpa komentar.',
        `JSON harus mengikuti schema tool ${tool.name}: ${JSON.stringify(tool.input_schema)}`,
      ].join('\n\n'),
      messages: [{ role: 'user', content: userContent }],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LLM fallback (anthropic) HTTP ${res.status}: ${body.slice(0, 500)}`)
  }

  const data = await res.json()
  const text = extractAnthropicText(data)
  const parsed = parseJsonObject(text)
  if (!parsed) {
    const snippet = (text || previousText || JSON.stringify(data)).slice(0, 500)
    throw new Error(`LLM tidak mengembalikan tool_use atau JSON valid. Response: ${snippet}`)
  }
  return parsed
}

function extractAnthropicText(data: unknown): string {
  const content = (data as { content?: unknown })?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type?: string; text?: string } => Boolean(b) && typeof b === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function parseJsonObject(text: string): unknown | null {
  if (!text) return null
  const candidates = [
    text.trim(),
    stripJsonFence(text),
    extractJsonObject(text),
  ].filter((v): v is string => Boolean(v))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Try next candidate.
    }
  }
  return null
}

function stripJsonFence(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return match?.[1]?.trim() ?? null
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

// --- OpenAI-compatible chat/completions (function calling) ------------------
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  tool: ToolDef,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
      tool_choice: { type: 'function', function: { name: tool.name } },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LLM (openai) HTTP ${res.status}: ${body.slice(0, 500)}`)
  }

  const data = await res.json()
  const call = data?.choices?.[0]?.message?.tool_calls?.[0]
  const args = call?.function?.arguments
  if (!args) throw new Error('LLM tidak mengembalikan tool_calls yang valid.')
  try {
    return JSON.parse(args)
  } catch {
    throw new Error('Argumen tool dari LLM bukan JSON valid.')
  }
}
