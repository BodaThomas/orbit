import { ACTIVE_MISSION_STATUSES } from './mission-states'
import type { Agent, ApprovalRequest, CompanionState, Mission, MissionCounts, TeamCounts } from './types'

/**
 * The single source of truth for companion states and mission counters.
 * Dashboard, profiles, Universe, sidebar and Analytics all call these functions,
 * so the same companion can never be « busy » on one screen and « available » on another.
 *
 * Rules (documented in docs/STATS.md):
 * - offline: companion disabled.
 * - awaiting_approval: at least one pending approval for this companion (it is blocked on you).
 * - in_mission: at least one mission running (or waiting) and nothing pending for it.
 * - error: last run failed and nothing is running now.
 * - available: everything else (including « done », a transient celebration state).
 * - busy = in_mission + awaiting_approval.
 */
export function companionState(
  agent: Pick<Agent, 'id' | 'enabled' | 'status'>,
  ctx: { activeMissionAgentIds: ReadonlySet<string>; pendingApprovalAgentIds: ReadonlySet<string> },
): CompanionState {
  if (!agent.enabled || agent.status === 'disabled') return 'offline'
  if (ctx.pendingApprovalAgentIds.has(agent.id)) return 'awaiting_approval'
  if (ctx.activeMissionAgentIds.has(agent.id)) return 'in_mission'
  // A live conversation stream also marks the agent « working » without a mission.
  if (agent.status === 'working') return 'in_mission'
  if (agent.status === 'error') return 'error'
  return 'available'
}

export function stateContext(missions: readonly Pick<Mission, 'agentId' | 'status'>[], approvals: readonly Pick<ApprovalRequest, 'agentId' | 'status'>[]) {
  return {
    activeMissionAgentIds: new Set(missions.filter((m) => ACTIVE_MISSION_STATUSES.includes(m.status) && m.status !== 'approval_required').map((m) => m.agentId)),
    pendingApprovalAgentIds: new Set([
      ...approvals.filter((a) => a.status === 'pending').map((a) => a.agentId),
      ...missions.filter((m) => m.status === 'approval_required').map((m) => m.agentId),
    ]),
  }
}

export function teamCounts(
  agents: readonly Pick<Agent, 'id' | 'enabled' | 'status'>[],
  missions: readonly Pick<Mission, 'agentId' | 'status'>[],
  approvals: readonly Pick<ApprovalRequest, 'agentId' | 'status'>[],
): TeamCounts {
  const ctx = stateContext(missions, approvals)
  const c: TeamCounts = { total: agents.length, available: 0, inMission: 0, awaitingApproval: 0, busy: 0, error: 0, offline: 0 }
  for (const a of agents) {
    const s = companionState(a, ctx)
    if (s === 'available') c.available++
    else if (s === 'in_mission') c.inMission++
    else if (s === 'awaiting_approval') c.awaitingApproval++
    else if (s === 'error') c.error++
    else c.offline++
  }
  c.busy = c.inMission + c.awaitingApproval
  return c
}

/** Cancelled missions are counted but excluded from the success rate (the user stopped them). */
export function missionCounts(missions: readonly Pick<Mission, 'status'>[]): MissionCounts {
  const c: MissionCounts = { total: missions.length, active: 0, todo: 0, done: 0, failed: 0, cancelled: 0, successRate: null }
  for (const m of missions) {
    if (ACTIVE_MISSION_STATUSES.includes(m.status)) c.active++
    else if (m.status === 'todo' || m.status === 'scheduled') c.todo++
    else if (m.status === 'done') c.done++
    else if (m.status === 'failed') c.failed++
    else if (m.status === 'cancelled') c.cancelled++
  }
  c.successRate = c.done + c.failed > 0 ? c.done / (c.done + c.failed) : null
  return c
}

export interface RankedAgent {
  agentId: string
  requests: number
  knownCost: number
  tokens: number
}

/**
 * Deterministic ranking: by the chosen metric, then the other metric, then id.
 * `leaders` returns every agent tied for first place (« ex æquo »), never an arbitrary one.
 */
export function rankAgents<T extends RankedAgent>(rows: readonly T[], by: 'requests' | 'cost' | 'tokens'): T[] {
  const key = (r: RankedAgent) => (by === 'requests' ? [r.requests, r.knownCost, r.tokens] : by === 'cost' ? [r.knownCost, r.requests, r.tokens] : [r.tokens, r.requests, r.knownCost])
  return [...rows].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) if (kb[i]! !== ka[i]!) return kb[i]! - ka[i]!
    return a.agentId.localeCompare(b.agentId)
  })
}

export function leaders<T extends RankedAgent>(rows: readonly T[], by: 'requests' | 'cost' | 'tokens'): T[] {
  const ranked = rankAgents(rows, by)
  const top = ranked[0]
  if (!top) return []
  const v = (r: RankedAgent) => (by === 'requests' ? r.requests : by === 'cost' ? r.knownCost : r.tokens)
  if (v(top) === 0) return []
  return ranked.filter((r) => v(r) === v(top))
}

export const COMPANION_STATE_LABELS: Record<CompanionState, string> = {
  available: 'Disponible',
  in_mission: 'En mission',
  awaiting_approval: 'Attend votre accord',
  error: 'En erreur',
  offline: 'Hors ligne',
}
