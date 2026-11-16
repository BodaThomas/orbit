import type { MissionStatus } from './types'

/** Allowed mission transitions. Anything not listed is rejected by the MissionManager. */
export const MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  todo: ['scheduled', 'running', 'approval_required', 'cancelled'],
  scheduled: ['running', 'approval_required', 'cancelled', 'todo'],
  approval_required: ['running', 'cancelled', 'todo'],
  running: ['waiting', 'done', 'failed', 'cancelled', 'approval_required'],
  waiting: ['running', 'cancelled', 'failed'],
  done: ['todo'],
  failed: ['todo'],
  cancelled: ['todo'],
}

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to)
}

export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  todo: 'À faire',
  scheduled: 'Planifiée',
  running: 'En cours',
  waiting: 'En attente',
  approval_required: 'Attend votre accord',
  done: 'Terminée',
  failed: 'Échec',
  cancelled: 'Annulée',
}

export const ACTIVE_MISSION_STATUSES: MissionStatus[] = ['running', 'waiting', 'approval_required']
export const TERMINAL_MISSION_STATUSES: MissionStatus[] = ['done', 'failed', 'cancelled']
