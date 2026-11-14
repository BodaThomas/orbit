import type { ModelInfo, ProviderCapabilities, ProviderId } from '@shared/types'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface StreamRequest {
  model: string
  system: string
  messages: ChatTurn[]
  maxTokens: number
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      /** Model that actually served the answer (differs from the request after a refusal fallback). */
      model?: string
      /** Per-model split when several models ran (declined attempt + fallback). */
      byModel?: { model: string; inputTokens: number; outputTokens: number }[]
    }
  | { type: 'done'; stopReason: string | null }

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limit' | 'bad_request' | 'unavailable' | 'refusal' | 'network' | 'unknown',
  ) {
    super(message)
  }
}

export interface StatusPageSource {
  /** Statuspage v2 API root, e.g. https://status.claude.com/api/v2 */
  api: string
  page: string
  services: string[]
}

/**
 * Common contract every provider adapter implements.
 * Capabilities are declared, never assumed by the UI.
 */
export interface ProviderAdapter {
  id: ProviderId
  name: string
  availability: 'available' | 'planned'
  /** Engines read their secret from another provider (Claude Agent SDK → Anthropic key). */
  secretFrom?: ProviderId
  capabilities: ProviderCapabilities
  requiresSecret: boolean
  defaultModels: ModelInfo[]
  statusPage: StatusPageSource | null
  notes: string
  validate(secret: string | null): Promise<void>
  listModels?(secret: string | null): Promise<ModelInfo[]>
  stream(req: StreamRequest, secret: string | null, signal: AbortSignal): AsyncIterable<StreamChunk>
}

export function plannedAdapter(id: ProviderId, name: string, notes: string): ProviderAdapter {
  return {
    id,
    name,
    availability: 'planned',
    capabilities: { kind: 'chat', streaming: false, cancel: false, tools: false, sessions: false, usage: 'none', apiKeyAuth: false },
    requiresSecret: true,
    defaultModels: [],
    statusPage: null,
    notes,
    async validate() {
      throw new ProviderError(`${name} n’est pas encore pris en charge.`, 'unavailable')
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new ProviderError(`${name} n’est pas encore pris en charge.`, 'unavailable')
    },
  }
}
