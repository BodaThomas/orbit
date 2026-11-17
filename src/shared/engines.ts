import type { ProviderId, ProviderInfo } from './types'

/**
 * How each provider runs and how it connects. Shown on every companion so that
 * « Claude Code », « Claude Agent SDK » and « Anthropic API » are never confused.
 * `summary` is the one line that sets an engine apart from its neighbours in pickers.
 */
export const ENGINE_INFO: Record<ProviderId, { label: string; kind: 'agent' | 'chat' | 'demo'; summary: string; connection: string; billing: string }> = {
  'claude-code': { label: 'Claude Code', kind: 'agent', summary: 'Votre CLI Claude Code, avec votre connexion', connection: 'CLI local officiel · votre connexion Claude Code', billing: 'Abonnement Claude ou crédits API, selon votre connexion' },
  'claude-agent': { label: 'Claude Agent SDK', kind: 'agent', summary: 'Agent intégré à Orbit, avec votre clé API', connection: 'SDK intégré · clé API Anthropic d’Orbit', billing: 'Crédits API Anthropic, jamais l’abonnement' },
  anthropic: { label: 'Anthropic API', kind: 'chat', summary: 'Conversation seule, sans accès aux fichiers', connection: 'Messages API · clé API Anthropic', billing: 'Crédits API Anthropic, jamais l’abonnement' },
  codex: { label: 'Codex', kind: 'agent', summary: 'Votre CLI Codex, avec votre connexion', connection: 'Codex app-server · votre connexion Codex CLI', billing: 'Abonnement ChatGPT ou crédits API, selon votre connexion' },
  openai: { label: 'OpenAI API', kind: 'chat', summary: 'Conversation seule, sans accès aux fichiers', connection: 'Responses API · clé API OpenAI', billing: 'Crédits API OpenAI' },
  gemini: { label: 'Gemini', kind: 'chat', summary: 'Bientôt', connection: 'Bientôt', billing: '—' },
  grok: { label: 'Grok', kind: 'chat', summary: 'Bientôt', connection: 'Bientôt', billing: '—' },
  openrouter: { label: 'OpenRouter', kind: 'chat', summary: 'Bientôt', connection: 'Bientôt', billing: '—' },
  ollama: { label: 'Ollama', kind: 'chat', summary: 'Bientôt', connection: 'Bientôt', billing: '—' },
  demo: { label: 'Démo locale', kind: 'demo', summary: 'Hors ligne, réponses fictives', connection: 'Hors ligne · réponses fictives', billing: 'Aucun' },
}

export type BillingKind = 'subscription' | 'api' | 'free' | 'unknown'

/** Engines whose billing depends on how the user signed in to their own CLI. */
const SIGN_IN_BILLING: Partial<Record<ProviderId, { plan: string; api: string }>> = {
  'claude-code': { plan: 'Claude', api: 'Anthropic' },
  codex: { plan: 'ChatGPT', api: 'OpenAI' },
}

/**
 * What a run on this engine is charged to. CLI engines are only labelled from what
 * was detected at the last check; until then the answer stays « unknown » rather
 * than a guess, since a wrong guess is exactly what makes users fear surprise bills.
 */
export function engineBilling(p: { id: ProviderId; engineAuth: ProviderInfo['engineAuth']; engineFacts: ProviderInfo['engineFacts'] }): { kind: BillingKind; label: string } {
  const signIn = SIGN_IN_BILLING[p.id]
  if (signIn) {
    if (p.engineAuth === 'subscription') {
      const plan = p.engineFacts?.Abonnement
      return { kind: 'subscription', label: `Sur votre abonnement ${signIn.plan}${plan ? ` ${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : ''}` }
    }
    if (p.engineAuth === 'api_key') return { kind: 'api', label: `Sur vos crédits API ${signIn.api}` }
    return { kind: 'unknown', label: `Abonnement ${signIn.plan} ou crédits API, selon votre connexion` }
  }
  if (p.id === 'claude-agent' || p.id === 'anthropic') return { kind: 'api', label: 'Sur vos crédits API Anthropic' }
  if (p.id === 'openai') return { kind: 'api', label: 'Sur vos crédits API OpenAI' }
  if (p.id === 'demo') return { kind: 'free', label: 'Gratuit' }
  return { kind: 'unknown', label: '—' }
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
