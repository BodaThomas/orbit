import type { ProviderId } from './types'

/**
 * How each provider runs and how it connects. Shown on every companion so that
 * « Claude Code », « Claude Agent SDK » and « Anthropic API » are never confused.
 */
export const ENGINE_INFO: Record<ProviderId, { label: string; kind: 'agent' | 'chat' | 'demo'; connection: string; billing: string }> = {
  'claude-code': { label: 'Claude Code', kind: 'agent', connection: 'CLI local officiel · votre connexion Claude Code', billing: 'Abonnement Claude (ou clé, selon votre connexion)' },
  'claude-agent': { label: 'Claude Agent SDK', kind: 'agent', connection: 'SDK intégré · clé API Anthropic d’Orbit', billing: 'Facturé à l’usage (API)' },
  anthropic: { label: 'Anthropic API', kind: 'chat', connection: 'Messages API · clé API Anthropic', billing: 'Facturé à l’usage (API)' },
  codex: { label: 'Codex', kind: 'agent', connection: 'Codex app-server · votre connexion Codex CLI', billing: 'Abonnement ChatGPT ou clé API OpenAI' },
  openai: { label: 'OpenAI API', kind: 'chat', connection: 'Responses API · clé API OpenAI', billing: 'Facturé à l’usage (API)' },
  gemini: { label: 'Gemini', kind: 'chat', connection: 'Bientôt', billing: '—' },
  grok: { label: 'Grok', kind: 'chat', connection: 'Bientôt', billing: '—' },
  openrouter: { label: 'OpenRouter', kind: 'chat', connection: 'Bientôt', billing: '—' },
  ollama: { label: 'Ollama', kind: 'chat', connection: 'Bientôt', billing: '—' },
  demo: { label: 'Démo', kind: 'demo', connection: 'Hors ligne · réponses fictives', billing: 'Aucun' },
}

export const AGENT_ENGINES: ProviderId[] = ['claude-code', 'claude-agent', 'codex']
export const isAgentEngine = (id: ProviderId): boolean => AGENT_ENGINES.includes(id)

export const EFFORT_LEVELS = [
  { id: 'low', label: 'Faible' },
  { id: 'medium', label: 'Moyen' },
  { id: 'high', label: 'Élevé' },
  { id: 'xhigh', label: 'Très élevé' },
  { id: 'max', label: 'Maximum' },
] as const
