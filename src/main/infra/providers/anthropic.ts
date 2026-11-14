import Anthropic from '@anthropic-ai/sdk'
import type { ProviderAdapter, StreamChunk, StreamRequest } from './types'
import { ProviderError } from './types'

/** Models with a server-side refusal fallback ("default" routing). Haiku has none. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'])

function client(secret: string | null): Anthropic {
  if (!secret) throw new ProviderError('Aucune clé API Anthropic configurée.', 'auth')
  return new Anthropic({ apiKey: secret, maxRetries: 2 })
}

function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError('Clé API Anthropic invalide.', 'auth')
  if (err instanceof Anthropic.PermissionDeniedError)
    return new ProviderError('Accès refusé par Anthropic pour ce modèle.', 'auth')
  if (err instanceof Anthropic.RateLimitError)
    return new ProviderError('Limite de débit Anthropic atteinte, réessayez dans un instant.', 'rate_limit')
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(err.message, 'bad_request')
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError('Impossible de joindre l’API Anthropic.', 'network')
  if (err instanceof Anthropic.APIError)
    return new ProviderError(`Erreur Anthropic ${err.status ?? ''} : ${err.message}`, 'unavailable')
  return new ProviderError(err instanceof Error ? err.message : String(err), 'unknown')
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  name: 'Anthropic',
  availability: 'available',
  capabilities: { streaming: true, cancel: true, tools: false, sessions: false, usage: 'official', apiKeyAuth: true },
  requiresSecret: true,
  defaultModels: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'Par défaut · polyvalent' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'Rapide · quotidien' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', hint: 'Très économique' },
    { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', hint: 'Le plus capable' },
  ],
  statusPage: {
    api: 'https://status.claude.com/api/v2',
    page: 'https://status.claude.com',
    services: ['claude.ai', 'Claude API', 'Claude Code'],
  },
  notes:
    'Messages API officielle avec clé Console. Jetons d’entrée/sortie renvoyés par l’API ; coût calculé avec les tarifs publics datés.',

  async validate(secret) {
    try {
      await client(secret).models.list({ limit: 1 })
    } catch (err) {
      throw mapError(err)
    }
  },

  async *stream(req: StreamRequest, secret, signal): AsyncIterable<StreamChunk> {
    const anthropic = client(secret)
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system || undefined,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    }
    const run = async function* (withFallback: boolean): AsyncIterable<StreamChunk> {
      const stream = withFallback
        ? anthropic.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
        : anthropic.messages.stream(params, { signal })
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text }
        }
      }
      const final = await stream.finalMessage()
      yield { type: 'usage', inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens }
      if (final.stop_reason === 'refusal') {
        throw new ProviderError('Le modèle a refusé de répondre à cette demande.', 'refusal')
      }
      yield { type: 'done', stopReason: final.stop_reason ?? null }
    }
    let emitted = false
    try {
      // Server-side refusal fallback where the model supports it.
      for await (const chunk of run(FALLBACK_MODELS.has(req.model))) {
        emitted = true
        yield chunk
      }
    } catch (err) {
      if (signal.aborted) return
      // If the account/model rejects the fallback beta before any output, retry once without it.
      if (!emitted && FALLBACK_MODELS.has(req.model) && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
        try {
          yield* run(false)
          return
        } catch (retryErr) {
          if (signal.aborted) return
          throw mapError(retryErr)
        }
      }
      throw mapError(err)
    }
  },
}
