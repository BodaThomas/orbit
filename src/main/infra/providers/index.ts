import type { ProviderId } from '@shared/types'
import { anthropicAdapter } from './anthropic'
import { demoAdapter } from './demo'
import { openaiAdapter } from './openai'
import { plannedAdapter, type ProviderAdapter } from './types'

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  'claude-agent': plannedAdapter(
    'claude-agent',
    'Claude Agent SDK',
    'Missions outillées (fichiers, commandes) avec validation par le Permission Manager. Prévu phase 6.',
  ),
  codex: plannedAdapter('codex', 'Codex', 'Pilotage du CLI Codex via @openai/codex-sdk. Prévu phase 6.'),
  gemini: plannedAdapter('gemini', 'Gemini', 'Adaptateur prévu.'),
  grok: plannedAdapter('grok', 'Grok', 'Adaptateur prévu.'),
  openrouter: plannedAdapter('openrouter', 'OpenRouter', 'Adaptateur prévu (coûts officiels renvoyés par l’API).'),
  ollama: plannedAdapter('ollama', 'Ollama', 'Modèles locaux, prévu.'),
  demo: demoAdapter,
}

export * from './types'
