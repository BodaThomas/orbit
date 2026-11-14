import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { canTransition, MISSION_STATUS_LABELS } from '@shared/mission-states'
import type { ApprovalRequest, ExecutionEvent, Mission, MissionPriority, MissionStatus } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { toApproval, toExecutionEvent, toMission } from '../infra/db/mappers'
import { approvalRequests, executionEvents, missionExecutions, missions } from '../infra/db/schema'
import type { AgentManager } from './agents'
import type { EventBus } from './event-bus'
import type { Journal } from './journal'
import type { MemoryStore } from './memory'
import type { PermissionManager } from './permissions'
import type { ProviderRegistry } from './providers'
import type { UsageTracker } from './usage'
import { newId, nowIso, OrbitError, shortId } from './util'

const OUTPUT_FLUSH_MS = 1200

export class MissionManager {
  private running = new Map<string, AbortController>()

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private agents: AgentManager,
    private providers: ProviderRegistry,
    private usage: UsageTracker,
    private permissions: PermissionManager,
    private memory: MemoryStore,
  ) {}

  // Queries

  list(agentId?: string): Mission[] {
    return this.db
      .select()
      .from(missions)
      .where(agentId ? eq(missions.agentId, agentId) : undefined)
      .orderBy(desc(missions.updatedAt))
      .limit(500)
      .all()
      .map(toMission)
  }

  get(id: string): Mission {
    const row = this.db.select().from(missions).where(eq(missions.id, id)).get()
    if (!row) throw new OrbitError('not_found', 'Mission introuvable.')
    return toMission(row)
  }

  events(missionId: string): ExecutionEvent[] {
    return this.db.select().from(executionEvents).where(eq(executionEvents.missionId, missionId)).orderBy(asc(executionEvents.createdAt)).all().map(toExecutionEvent)
  }

  approvals(status?: ApprovalRequest['status']): ApprovalRequest[] {
    return this.db
      .select()
      .from(approvalRequests)
      .where(status ? eq(approvalRequests.status, status) : undefined)
      .orderBy(desc(approvalRequests.createdAt))
      .limit(200)
      .all()
      .map(toApproval)
  }

  // Commands

  create(input: { title: string; description: string; agentId: string; priority: MissionPriority; startNow: boolean }): Mission {
    const agent = this.agents.get(input.agentId)
    const ts = nowIso()
    const row = {
      id: newId(),
      shortId: this.uniqueShortId(),
      title: input.title,
      description: input.description,
      agentId: input.agentId,
      priority: input.priority,
      status: 'todo',
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.insert(missions).values(row).run()
    this.journal.activity({ type: 'mission.created', agentId: agent.id, missionId: row.id, title: `Nouvelle mission pour ${agent.name}`, detail: input.title })
    this.bus.invalidate('missions')
    if (input.startNow) return this.start(row.id, 'user')
    return this.get(row.id)
  }

  start(id: string, origin: 'user' | 'automation'): Mission {
    const mission = this.get(id)
    if (this.running.has(id)) throw new OrbitError('conflict', 'Cette mission est déjà en cours.')
    const agent = this.agents.get(mission.agentId)

    const decision = this.permissions.check(agent, 'mission.start', origin)
    if (!decision.allowed) throw new OrbitError('forbidden', decision.reason ?? 'Démarrage refusé.')

    const adapter = this.providers.adapter(agent.providerId)
    if (adapter.availability !== 'available') throw new OrbitError('provider', `${adapter.name} n’est pas encore disponible.`)
    if (adapter.requiresSecret && !this.providers.secretFor(agent.providerId)) {
      throw new OrbitError('provider', `Connectez ${adapter.name} pour que ${agent.name} puisse travailler.`)
    }
    const blocked = this.usage.budgetBlock(agent)
    if (blocked) {
      this.journal.activity({ type: 'budget.reached', level: 'warning', agentId: agent.id, missionId: id, title: 'Mission bloquée par le budget', detail: blocked })
      this.journal.notify('budget', 'Budget atteint', blocked, `/missions/${id}`)
      throw new OrbitError('budget', blocked)
    }

    if (decision.requiresApproval && mission.status !== 'approval_required') {
      this.transition(mission, 'approval_required')
      const approval = {
        id: newId(),
        agentId: agent.id,
        missionId: id,
        kind: 'mission_start',
        summary: `${agent.name} demande à démarrer « ${mission.title} »`,
        detail: decision.reason,
        status: 'pending',
        createdAt: nowIso(),
      }
      this.db.insert(approvalRequests).values(approval).run()
      this.agents.setStatus(agent.id, 'awaiting_approval', mission.title)
      this.journal.activity({ type: 'approval.requested', level: 'warning', agentId: agent.id, missionId: id, title: 'Approbation demandée', detail: approval.summary })
      this.journal.notify('approval', 'Approbation nécessaire', approval.summary, '/')
      this.bus.invalidate('approvals', 'missions')
      return this.get(id)
    }

    this.transition(mission, 'running', { startedAt: nowIso(), finishedAt: null, error: null, result: null })
    void this.execute(id)
    return this.get(id)
  }

  cancel(id: string): Mission {
    const mission = this.get(id)
    const controller = this.running.get(id)
    if (controller) {
      controller.abort()
      return this.get(id)
    }
    if (!canTransition(mission.status, 'cancelled')) {
      throw new OrbitError('conflict', `Impossible d’annuler une mission « ${MISSION_STATUS_LABELS[mission.status]} ».`)
    }
    this.transition(mission, 'cancelled', { finishedAt: nowIso() })
    this.expireApprovals(id)
    this.agents.setStatus(mission.agentId, 'available', null)
    this.journal.activity({ type: 'mission.cancelled', agentId: mission.agentId, missionId: id, title: 'Mission annulée', detail: mission.title })
    return this.get(id)
  }

  retry(id: string): Mission {
    const mission = this.get(id)
    this.transition(mission, 'todo')
    return this.start(id, 'user')
  }

  duplicate(id: string): Mission {
    const m = this.get(id)
    return this.create({ title: `${m.title} (copie)`.slice(0, 160), description: m.description, agentId: m.agentId, priority: m.priority, startNow: false })
  }

  delete(id: string): void {
    this.running.get(id)?.abort()
    this.db.delete(missions).where(eq(missions.id, id)).run()
    this.bus.invalidate('missions', 'approvals')
  }

  resolveApproval(id: string, approve: boolean): ApprovalRequest {
    const row = this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
    if (!row) throw new OrbitError('not_found', 'Demande introuvable.')
    if (row.status !== 'pending') throw new OrbitError('conflict', 'Cette demande a déjà été traitée.')
    this.db.update(approvalRequests).set({ status: approve ? 'approved' : 'denied', resolvedAt: nowIso() }).where(eq(approvalRequests.id, id)).run()
    this.journal.audit({ actor: 'user', agentId: row.agentId, action: `approval.${approve ? 'approve' : 'deny'}`, target: row.missionId, allowed: approve, reason: row.summary })
    this.journal.activity({ type: 'approval.resolved', level: approve ? 'success' : 'info', agentId: row.agentId, missionId: row.missionId, title: approve ? 'Demande approuvée' : 'Demande refusée', detail: row.summary })
    if (row.missionId && row.kind === 'mission_start') {
      const mission = this.get(row.missionId)
      if (approve && mission.status === 'approval_required') {
        this.transition(mission, 'running', { startedAt: nowIso(), finishedAt: null, error: null, result: null })
        void this.execute(mission.id)
      } else if (!approve && mission.status === 'approval_required') {
        this.transition(mission, 'cancelled', { finishedAt: nowIso() })
        this.agents.setStatus(mission.agentId, 'available', null)
      }
    }
    this.bus.invalidate('approvals', 'missions')
    return toApproval(this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()!)
  }

  cancelAll(): void {
    for (const c of this.running.values()) c.abort()
  }

  /** After a crash or quit, nothing is running: mark interrupted work as failed. */
  recoverInterrupted(): void {
    const open = this.db.select().from(missionExecutions).where(eq(missionExecutions.status, 'running')).all()
    for (const ex of open) {
      this.db
        .update(missions)
        .set({ status: 'failed', error: 'Interrompue : Orbit a été fermé pendant l’exécution.', finishedAt: nowIso(), updatedAt: nowIso() })
        .where(and(eq(missions.id, ex.missionId), inArray(missions.status, ['running', 'waiting'])))
        .run()
      this.db.update(missionExecutions).set({ status: 'failed', finishedAt: nowIso() }).where(eq(missionExecutions.id, ex.id)).run()
    }
  }

  // Execution engine

  private async execute(missionId: string): Promise<void> {
    const mission = this.get(missionId)
    const agent = this.agents.get(mission.agentId)
    const adapter = this.providers.adapter(agent.providerId)
    const attempts = this.db.select({ n: count() }).from(missionExecutions).where(eq(missionExecutions.missionId, missionId)).get()?.n ?? 0
    const executionId = newId()
    try {
      this.db.insert(missionExecutions).values({ id: executionId, missionId, idempotencyKey: `${missionId}:${attempts + 1}`, status: 'running', startedAt: nowIso() }).run()
    } catch {
      throw new OrbitError('conflict', 'Cette exécution a déjà été lancée.')
    }
    const controller = new AbortController()
    this.running.set(missionId, controller)
    this.agents.setStatus(agent.id, 'working', mission.title)
    this.event(missionId, executionId, 'started', `${agent.name} commence la mission avec ${adapter.name} · ${agent.model}`)
    this.journal.activity({ type: 'mission.started', agentId: agent.id, missionId, title: `${agent.name} a démarré une mission`, detail: mission.title })

    let text = ''
    let pending = ''
    let lastFlush = Date.now()
    let usage: { inputTokens: number; outputTokens: number } | null = null
    const flushOutput = () => {
      if (!pending) return
      this.event(missionId, executionId, 'output', pending)
      pending = ''
      lastFlush = Date.now()
    }

    try {
      const secret = adapter.requiresSecret ? this.providers.secretFor(agent.providerId) : null
      const system =
        agent.instructions +
        this.memory.contextFor(agent.id) +
        `\n\nTu exécutes une mission confiée par l’utilisateur dans Orbit. Tu n’as accès à aucun outil : produis directement le livrable, structuré en Markdown, puis termine par une courte section « Prochaines étapes ».`
      const prompt = `# Mission ${mission.shortId} — ${mission.title}\n\nPriorité : ${mission.priority}\n\n${mission.description || '(pas de description)'}`
      for await (const chunk of adapter.stream({ model: agent.model, system, messages: [{ role: 'user', content: prompt }], maxTokens: 32_000 }, secret, controller.signal)) {
        if (chunk.type === 'text') {
          text += chunk.text
          pending += chunk.text
          if (Date.now() - lastFlush > OUTPUT_FLUSH_MS) flushOutput()
        } else if (chunk.type === 'usage') usage = chunk
      }
      flushOutput()
      const cost = usage ? this.usage.record({ agentId: agent.id, providerId: agent.providerId, model: agent.model, ...usage, source: 'mission' }) : null
      if (usage) {
        this.event(missionId, executionId, 'usage', `${usage.inputTokens.toLocaleString('fr-FR')} jetons en entrée · ${usage.outputTokens.toLocaleString('fr-FR')} en sortie`, { ...usage, ...cost })
      }
      const fresh = this.get(missionId)
      if (controller.signal.aborted) {
        this.transition(fresh, 'cancelled', { finishedAt: nowIso(), result: text || null, costUsd: cost?.costUsd ?? null, costKind: cost?.costKind ?? null })
        this.event(missionId, executionId, 'cancelled', 'Mission arrêtée par l’utilisateur.')
        this.finishExecution(executionId, 'cancelled')
        this.agents.setStatus(agent.id, 'available', null)
        this.journal.activity({ type: 'mission.cancelled', agentId: agent.id, missionId, title: 'Mission arrêtée', detail: mission.title })
      } else {
        this.transition(fresh, 'done', { finishedAt: nowIso(), result: text, costUsd: cost?.costUsd ?? null, costKind: cost?.costKind ?? null })
        this.event(missionId, executionId, 'completed', 'Mission terminée.')
        this.finishExecution(executionId, 'done')
        this.agents.setStatus(agent.id, 'done', mission.title)
        setTimeout(() => {
          try {
            if (this.agents.get(agent.id).status === 'done') this.agents.setStatus(agent.id, 'available', null)
          } catch {
            /* agent deleted meanwhile */
          }
        }, 8000)
        this.journal.activity({ type: 'mission.completed', level: 'success', agentId: agent.id, missionId, title: `${agent.name} a terminé une mission`, detail: mission.title })
        this.journal.notify('mission_done', `${agent.name} a terminé`, mission.title, `/missions/${missionId}`)
      }
    } catch (err) {
      flushOutput()
      const msg = err instanceof Error ? err.message : String(err)
      const fresh = this.get(missionId)
      if (canTransition(fresh.status, 'failed')) this.transition(fresh, 'failed', { finishedAt: nowIso(), error: msg, result: text || null })
      this.event(missionId, executionId, 'failed', msg)
      this.finishExecution(executionId, 'failed')
      this.agents.setStatus(agent.id, 'error', msg.slice(0, 120))
      this.journal.activity({ type: 'mission.failed', level: 'error', agentId: agent.id, missionId, title: `Échec de la mission de ${agent.name}`, detail: msg })
      this.journal.notify('mission_failed', `Mission échouée · ${agent.name}`, msg, `/missions/${missionId}`)
    } finally {
      this.running.delete(missionId)
      this.bus.invalidate('missions', 'agents')
    }
  }

  private event(missionId: string, executionId: string, type: ExecutionEvent['type'], message: string, data: Record<string, unknown> | null = null) {
    const row = { id: newId(), missionId, executionId, type, message, data, createdAt: nowIso() }
    this.db.insert(executionEvents).values(row).run()
    this.bus.emit({ type: 'mission.event', event: toExecutionEvent(row) })
  }

  private finishExecution(id: string, status: string) {
    this.db.update(missionExecutions).set({ status, finishedAt: nowIso() }).where(eq(missionExecutions.id, id)).run()
  }

  private transition(mission: Mission, to: MissionStatus, extra: Partial<typeof missions.$inferInsert> = {}) {
    if (!canTransition(mission.status, to)) {
      throw new OrbitError('conflict', `Transition interdite : ${MISSION_STATUS_LABELS[mission.status]} → ${MISSION_STATUS_LABELS[to]}.`)
    }
    this.db.update(missions).set({ ...extra, status: to, updatedAt: nowIso() }).where(eq(missions.id, mission.id)).run()
    this.bus.invalidate('missions')
  }

  private expireApprovals(missionId: string) {
    this.db
      .update(approvalRequests)
      .set({ status: 'expired', resolvedAt: nowIso() })
      .where(and(eq(approvalRequests.missionId, missionId), eq(approvalRequests.status, 'pending')))
      .run()
    this.bus.invalidate('approvals')
  }

  private uniqueShortId(): string {
    for (let i = 0; i < 10; i++) {
      const candidate = shortId()
      if (!this.db.select({ id: missions.id }).from(missions).where(eq(missions.shortId, candidate)).get()) return candidate
    }
    return shortId() + shortId()
  }
}
