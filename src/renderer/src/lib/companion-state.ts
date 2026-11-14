import { useMemo } from 'react'
import { companionState, missionCounts, stateContext, teamCounts } from '@shared/stats'
import type { Agent, AgentStatus, CompanionState } from '@shared/types'
import { useAgents, useApprovals, useMissions } from './queries'

/**
 * Every screen asks the same question through this hook, backed by shared/stats.ts:
 * dashboard, sidebar, profiles, Universe and Analytics can never disagree.
 */
export function useCompanionStates() {
  const agents = useAgents()
  const missions = useMissions()
  const approvals = useApprovals()
  return useMemo(() => {
    const ctx = stateContext(missions.data ?? [], approvals.data ?? [])
    const states = new Map<string, CompanionState>((agents.data ?? []).map((a) => [a.id, companionState(a, ctx)]))
    return {
      stateOf: (id: string): CompanionState => states.get(id) ?? 'available',
      counts: teamCounts(agents.data ?? [], missions.data ?? [], approvals.data ?? []),
      missions: missionCounts(missions.data ?? []),
      ready: Boolean(agents.data && missions.data && approvals.data),
    }
  }, [agents.data, missions.data, approvals.data])
}

/** Visual status for avatars: the shared state, keeping the short « done » celebration. */
export function displayStatus(agent: Pick<Agent, 'status'>, state: CompanionState): AgentStatus {
  switch (state) {
    case 'in_mission':
      return 'working'
    case 'awaiting_approval':
      return 'awaiting_approval'
    case 'error':
      return 'error'
    case 'offline':
      return agent.status === 'disabled' ? 'disabled' : 'offline'
    default:
      return agent.status === 'done' ? 'done' : 'available'
  }
}
