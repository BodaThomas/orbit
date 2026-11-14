import OpenAI from 'openai'
import type { ModelInfo } from '@shared/types'
import type { ProviderAdapter, StreamChunk, StreamRequest } from './types'
import { ProviderError } from './types'

function client(secret: string | null): OpenAI {
  if (!secret) throw new ProviderError('Aucune clé API OpenAI configurée.', 'auth')
  return new OpenAI({ apiKey: secret, maxRetries: 2 })
}

function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof OpenAI.AuthenticationError) return new ProviderError('Clé API OpenAI invalide.', 'auth')
  if (err instanceof OpenAI.RateLimitError) return new ProviderError('Limite OpenAI atteinte.', 'rate_limit')
  if (err instanceof OpenAI.BadRequestError) return new ProviderError(err.message, 'bad_request')
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError('Impossible de joindre l’API OpenAI.', 'network')
  if (err instanceof OpenAI.APIError) return new ProviderError(`Erreur OpenAI ${err.status ?? ''} : ${err.message}`, 'unavailable')
  return new ProviderError(err instanceof Error ? err.message : String(err), 'unknown')
}

const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  name: 'OpenAI',
  availability: 'available',
  capabilities: { streaming: true, cancel: true, tools: false, sessions: false, usage: 'official', apiKeyAuth: true },
  requiresSecret: true,
  defaultModels: [],
  statusPage: {
    api: 'https://status.openai.com/api/v2',
    page: 'https://status.openai.com',
    services: ['Responses', 'Chat Completions', 'Codex'],
  },
  notes:
    'Responses API avec clé API. La liste des modèles est lue sur votre compte après connexion. Coût inconnu tant qu’aucun tarif n’est configuré.',

  async validate(secret) {
    try {
      await client(secret).models.list()
    } catch (err) {
      throw mapError(err)
    }
  },

  async listModels(secret): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = []
      for await (const m of client(secret).models.list()) {
        if (CHAT_MODEL.test(m.id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(m.id)) {
          out.push({ id: m.id, label: m.id })
        }
      }
      return out.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 40)
    } catch (err) {
      throw mapError(err)
    }
  },

  async *stream(req: StreamRequest, secret, signal): AsyncIterable<StreamChunk> {
    try {
      const stream = await client(secret).responses.create(
        {
          model: req.model,
          instructions: req.system || undefined,
          input: req.messages.map((m) => ({ role: m.role, content: m.content })),
          max_output_tokens: req.maxTokens,
          stream: true,
        },
        { signal },
      )
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') yield { type: 'text', text: event.delta }
        else if (event.type === 'response.completed') {
          const u = event.response.usage
          if (u) yield { type: 'usage', inputTokens: u.input_tokens, outputTokens: u.output_tokens }
          yield { type: 'done', stopReason: event.response.status ?? null }
        } else if (event.type === 'response.failed') {
          throw new ProviderError(event.response.error?.message ?? 'La réponse OpenAI a échoué.', 'unavailable')
        }
      }
    } catch (err) {
      if (signal.aborted) return
      throw mapError(err)
    }
  },
}
