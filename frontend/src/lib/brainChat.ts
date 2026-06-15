import type { BrainChatResponse } from '../types/brain'

export interface AskBrainOptions {
  includeRawEntries: boolean
  maxNodes: number
  maxEdges: number
  maxRawEntries: number
  maxAgentMemories: number
}

export async function askBrain(question: string, options: Partial<AskBrainOptions> = {}): Promise<BrainChatResponse> {
  const res = await fetch('/__brain-chat/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question,
      options: {
        includeRawEntries: options.includeRawEntries ?? true,
        maxNodes: options.maxNodes ?? 12,
        maxEdges: options.maxEdges ?? 20,
        maxRawEntries: options.maxRawEntries ?? 5,
        maxAgentMemories: options.maxAgentMemories ?? 10,
      },
    }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error ?? `Brain Chat HTTP ${res.status}`)
  }
  return data as BrainChatResponse
}
