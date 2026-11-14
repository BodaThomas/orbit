import { asc, eq, max } from 'drizzle-orm'
import type { AgentInput } from '@shared/ipc'
import type { Agent, AgentStatus } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { toAgent } from '../infra/db/mappers'
import { agentAppearances, agents } from '../infra/db/schema'
import type { EventBus } from './event-bus'
import type { Journal } from './journal'
import { newId, nowIso, OrbitError } from './util'

export class AgentManager {
  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
  ) {}

  list(): Agent[] {
    const rows = this.db
      .select()
      .from(agents)
      .innerJoin(agentAppearances, eq(agentAppearances.agentId, agents.id))
      .orderBy(asc(agents.sortOrder), asc(agents.createdAt))
      .all()
    return rows.map((r) => toAgent(r.agents, r.agent_appearances.appearance))
  }

  get(id: string): Agent {
    const r = this.db
      .select()
      .from(agents)
      .innerJoin(agentAppearances, eq(agentAppearances.agentId, agents.id))
      .where(eq(agents.id, id))
      .get()
    if (!r) throw new OrbitError('not_found', 'Compagnon introuvable.')
    return toAgent(r.agents, r.agent_appearances.appearance)
  }

  create(input: AgentInput, opts: { silent?: boolean } = {}): Agent {
    const id = newId()
    const ts = nowIso()
    const order = (this.db.select({ m: max(agents.sortOrder) }).from(agents).get()?.m ?? -1) + 1
    this.db.transaction((tx) => {
      tx.insert(agents)
        .values({
          id,
          name: input.name,
          role: input.role,
          description: input.description,
          providerId: input.providerId,
          model: input.model,
          instructions: input.instructions,
          autonomy: input.autonomy,
          permissions: input.permissions,
          workingDirectory: input.workingDirectory,
          dailyBudgetUsd: input.dailyBudgetUsd,
          status: 'available',
          sortOrder: order,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
      tx.insert(agentAppearances).values({ agentId: id, appearance: input.appearance, updatedAt: ts }).run()
    })
    const agent = this.get(id)
    if (!opts.silent) {
      this.journal.activity({ type: 'agent.created', level: 'success', agentId: id, title: `${agent.name} a rejoint votre univers`, detail: agent.role })
    }
    this.bus.invalidate('agents')
    return agent
  }

  update(id: string, patch: Partial<AgentInput>): Agent {
    const current = this.get(id)
    const { appearance, ...rest } = patch
    const ts = nowIso()
    this.db.transaction((tx) => {
      if (Object.keys(rest).length) tx.update(agents).set({ ...rest, updatedAt: ts }).where(eq(agents.id, id)).run()
      if (appearance) tx.update(agentAppearances).set({ appearance, updatedAt: ts }).where(eq(agentAppearances.agentId, id)).run()
    })
    const agent = this.get(id)
    this.journal.activity({ type: 'agent.updated', agentId: id, title: `${current.name} a été mis à jour` })
    this.journal.audit({ actor: 'user', agentId: id, action: 'agent.update', target: Object.keys(patch).join(','), allowed: true, reason: null })
    this.bus.invalidate('agents')
    return agent
  }

  delete(id: string): void {
    const agent = this.get(id)
    this.db.delete(agents).where(eq(agents.id, id)).run()
    this.journal.activity({ type: 'agent.deleted', level: 'warning', title: `${agent.name} a quitté votre univers` })
    this.journal.audit({ actor: 'user', agentId: null, action: 'agent.delete', target: agent.name, allowed: true, reason: null })
    this.bus.invalidate('agents', 'conversations', 'missions', 'activity')
  }

  duplicate(id: string): Agent {
    const a = this.get(id)
    return this.create({
      name: `${a.name} (copie)`.slice(0, 40),
      role: a.role,
      description: a.description,
      appearance: a.appearance,
      providerId: a.providerId,
      model: a.model,
      instructions: a.instructions,
      autonomy: a.autonomy,
      permissions: a.permissions,
      workingDirectory: a.workingDirectory,
      dailyBudgetUsd: a.dailyBudgetUsd,
    })
  }

  setEnabled(id: string, enabled: boolean): Agent {
    this.db.update(agents).set({ enabled, status: enabled ? 'available' : 'disabled', statusText: null, updatedAt: nowIso() }).where(eq(agents.id, id)).run()
    this.bus.invalidate('agents')
    return this.get(id)
  }

  setStatus(id: string, status: AgentStatus, statusText: string | null = null): void {
    this.db.update(agents).set({ status, statusText, updatedAt: nowIso() }).where(eq(agents.id, id)).run()
    this.bus.invalidate('agents')
  }

  /** On boot nothing can still be running: reset transient states. */
  resetTransientStatuses(): void {
    for (const a of this.list()) {
      if (a.status === 'working' || a.status === 'awaiting_approval') this.setStatus(a.id, 'available', null)
    }
  }
}
