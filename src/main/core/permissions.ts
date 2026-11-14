import type { Agent, AgentPermissions } from '@shared/types'
import type { Journal } from './journal'

export type PermissionAction = keyof AgentPermissions | 'mission.start' | 'conversation.send'

export interface PermissionDecision {
  allowed: boolean
  requiresApproval: boolean
  reason: string | null
}

const SENSITIVE: (keyof AgentPermissions)[] = ['writeFiles', 'runCommands', 'externalActions']

/**
 * Single authority on what an agent may do. Rules are code, never prompt text:
 * nothing a model outputs can change a decision here.
 */
export class PermissionManager {
  constructor(private journal: Journal) {}

  /** Pure decision, no side effect - unit tested. */
  /**
   * `toolGated`: the mission runs on an agent engine where every sensitive tool call is
   * individually gated by the tool policy, so a user-started mission needs no extra
   * « may I start? » approval.
   */
  static decide(
    agent: Pick<Agent, 'enabled' | 'autonomy' | 'permissions'>,
    action: PermissionAction,
    origin: 'user' | 'automation',
    opts: { toolGated?: boolean } = {},
  ): PermissionDecision {
    if (!agent.enabled) return { allowed: false, requiresApproval: false, reason: 'Compagnon désactivé.' }

    if (action === 'conversation.send') return { allowed: true, requiresApproval: false, reason: null }

    if (action === 'mission.start') {
      if (agent.autonomy === 'manual' && origin === 'automation') {
        return { allowed: false, requiresApproval: false, reason: 'Mode manuel : seules vos demandes déclenchent une mission.' }
      }
      const hasSensitive = SENSITIVE.some((p) => agent.permissions[p])
      if (opts.toolGated && origin === 'user') return { allowed: true, requiresApproval: false, reason: null }
      if (agent.autonomy === 'supervised' && hasSensitive) {
        return { allowed: true, requiresApproval: true, reason: 'Mode supervisé avec permissions sensibles.' }
      }
      return { allowed: true, requiresApproval: false, reason: null }
    }

    if (!agent.permissions[action]) {
      return { allowed: false, requiresApproval: false, reason: `Permission « ${action} » non accordée.` }
    }
    if (SENSITIVE.includes(action)) {
      // External actions always require a human, even in automated mode.
      if (action === 'externalActions' || agent.autonomy !== 'automated') {
        return { allowed: true, requiresApproval: true, reason: 'Action sensible.' }
      }
    }
    return { allowed: true, requiresApproval: false, reason: null }
  }

  check(agent: Agent, action: PermissionAction, origin: 'user' | 'automation', opts: { toolGated?: boolean } = {}): PermissionDecision {
    const d = PermissionManager.decide(agent, action, origin, opts)
    this.journal.audit({
      actor: origin === 'user' ? 'user' : 'system',
      agentId: agent.id,
      action,
      target: null,
      allowed: d.allowed,
      reason: d.reason,
    })
    return d
  }
}
