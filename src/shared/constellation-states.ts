import type { ConstellationRunStatus } from './types'

/** The drive loop is (or should be) working: planning, ready to start, running, synthesizing. */
export const ACTIVE_RUN_STATUSES: ConstellationRunStatus[] = ['planning', 'ready', 'running', 'synthesizing']
/** Nothing more will happen without the user. */
export const WAITING_RUN_STATUSES: ConstellationRunStatus[] = ['awaiting_approval', 'paused', 'blocked', 'failed']
/** Final: completed (every mandatory step done) or cancelled (explicitly). */
export const TERMINAL_RUN_STATUSES: ConstellationRunStatus[] = ['completed', 'cancelled']

/** Older databases and runtimes: `done` → completed, `interrupted` → paused. */
export function normalizeRunStatus(s: string): ConstellationRunStatus {
  if (s === 'done') return 'completed'
  if (s === 'interrupted') return 'paused'
  return s as ConstellationRunStatus
}

export const RUN_STATUS_INFO: Record<ConstellationRunStatus, { label: string; tone: 'accent' | 'success' | 'danger' | 'warning' | 'neutral'; hint: string }> = {
  planning: { label: 'Planification', tone: 'accent', hint: 'Le coordinateur prépare le plan.' },
  awaiting_approval: { label: 'Validation attendue', tone: 'warning', hint: 'Une décision de votre part est nécessaire pour continuer.' },
  ready: { label: 'Prête', tone: 'accent', hint: 'Plan validé : les sous-missions vont démarrer.' },
  running: { label: 'En cours', tone: 'accent', hint: 'Des sous-missions sont en cours.' },
  synthesizing: { label: 'Synthèse', tone: 'accent', hint: 'Le coordinateur rédige la synthèse du tour.' },
  paused: { label: 'En pause', tone: 'warning', hint: 'Aucune nouvelle sous-mission ne démarre. Reprenez quand vous voulez.' },
  blocked: { label: 'Bloquée', tone: 'warning', hint: 'Une intervention est nécessaire.' },
  failed: { label: 'Échec', tone: 'danger', hint: 'L’orchestration a échoué : une résolution est nécessaire.' },
  completed: { label: 'Terminée', tone: 'success', hint: 'Toutes les étapes obligatoires sont terminées.' },
  cancelled: { label: 'Annulée', tone: 'neutral', hint: 'Arrêtée par l’utilisateur. L’historique est conservé.' },
}
