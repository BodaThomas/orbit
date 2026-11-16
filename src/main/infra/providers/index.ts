import type { ProviderId } from '@shared/types'
import { anthropicAdapter } from './anthropic'
import { demoAdapter } from './demo'
import { openaiAdapter } from './openai'
import { ProviderError, plannedAdapter, type ProviderAdapter, type StatusPageSource } from './types'

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  'claude-code': engineAdapter({
    id: 'claude-code',
    name: 'Claude Code',
    defaultModels: [{ id: 'default', label: 'Modèle par défaut du compte', hint: 'Choisi par Claude Code selon votre abonnement' }],
    statusPage: anthropicAdapter.statusPage,
    notes:
      'Votre installation locale et officielle de Claude Code (binaire « claude »), avec votre propre connexion (abonnement Claude ou clé). Orbit pilote le CLI par son protocole structuré (stream-json) : il ne lit jamais vos identifiants. Chaque action sensible passe par la politique d’Orbit.',
  }),
  'claude-agent': engineAdapter({
    id: 'claude-agent',
    name: 'Claude Agent SDK',
    secretFrom: 'anthropic',
    defaultModels: anthropicAdapter.defaultModels,
    statusPage: anthropicAdapter.statusPage,
    notes:
      'Moteur agent officiel d’Anthropic (outils Claude Code). Lit, modifie et exécute dans le dossier de travail du compagnon ; chaque outil passe par la politique d’Orbit. Utilise votre clé API Anthropic. Coût estimé par le SDK au tarif public.',
  }),
  codex: engineAdapter({
    id: 'codex',
    name: 'Codex',
    defaultModels: [{ id: 'default', label: 'Modèle par défaut de Codex', hint: 'Défini par votre configuration Codex' }],
    statusPage: { api: 'https://status.openai.com/api/v2', page: 'https://status.openai.com', services: ['Codex'] },
    notes:
      'OpenAI Codex via « codex app-server » (binaire fourni avec Orbit). Utilise votre connexion Codex CLI (« codex login ») : abonnement ChatGPT ou clé API. Bac à sable du système + validation Orbit des écritures et commandes.',
  }),
  gemini: plannedAdapter('gemini', 'Gemini', 'Adaptateur prévu.'),
  grok: plannedAdapter('grok', 'Grok', 'Adaptateur prévu.'),
  openrouter: plannedAdapter('openrouter', 'OpenRouter', 'Adaptateur prévu (coûts officiels renvoyés par l’API).'),
  ollama: plannedAdapter('ollama', 'Ollama', 'Modèles locaux, prévu.'),
  demo: demoAdapter,
}

export * from './types'

/** Agent engines appear as providers so companions can pick them; they run missions, not chat streams. */
function engineAdapter(e: { id: ProviderId; name: string; secretFrom?: ProviderId; defaultModels: ProviderAdapter['defaultModels']; statusPage: StatusPageSource | null; notes: string }): ProviderAdapter {
  return {
    id: e.id,
    name: e.name,
    availability: 'available',
    secretFrom: e.secretFrom,
    capabilities: { kind: 'agent', streaming: true, cancel: true, tools: true, sessions: true, usage: 'official', apiKeyAuth: Boolean(e.secretFrom) },
    requiresSecret: Boolean(e.secretFrom),
    defaultModels: e.defaultModels,
    statusPage: e.statusPage,
    notes: e.notes,
    async validate() {
      /* readiness is checked by the engine itself, see ProviderRegistry.validate */
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new ProviderError(`${e.name} travaille par missions : confiez-lui une mission pour qu’il agisse dans son dossier.`, 'bad_request')
    },
  }
}
