import { existsSync, statSync } from 'node:fs'
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { canTransition, MISSION_STATUS_LABELS } from '@shared/mission-states'
import type { Agent, AgentPermissions, ApprovalRequest, ExecutionEvent, GrantScope, Mission, MissionDetail, MissionPriority, MissionStatus, RecentFileChange, StructuredResult, SubtaskSpec } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { toApproval, toExecution, toExecutionEvent, toFileChange, toInventory, toMission, toToolCall } from '../infra/db/mappers'
import { approvalRequests, executionEvents, fileChanges, fileInventories, missionExecutions, missions, toolCalls } from '../infra/db/schema'
import { isSafeProjectName } from '../../runtime/protocol'
import type { StreamChunk } from '../infra/providers'
import type { AgentRunner } from './agent-runner'
import type { AgentManager } from './agents'
import type { EventBus } from './event-bus'
import type { Journal } from './journal'
import type { MemoryStore } from './memory'
import type { PermissionManager } from './permissions'
import type { ProviderRegistry } from './providers'
import type { SecurityService } from './security/service'
import type { UsageTracker } from './usage'
import { newId, nowIso, OrbitError, shortId } from './util'

const OUTPUT_FLUSH_MS = 1200

/**
 * Missions of a companion placed on a runtime are executed and owned by that
 * runtime. Orbit Desktop keeps a synced copy and turns every action into a command.
 */
export interface MissionRemote {
  submit(mission: Mission, origin: 'user' | 'automation', followUp?: string): void
  cancel(mission: Mission): void
  resolveApproval(row: ApprovalRequest, approve: boolean, scope: GrantScope): void
}

/** Runtime host only: may defer (capacity) or block (budget) a start. */
export type Admission = (agent: Agent, mission: Mission) => { defer: string } | { block: string } | null

export function intersectPermissions(a: AgentPermissions, b: AgentPermissions | null | undefined): AgentPermissions {
  if (!b) return { ...a }
  return {
    readFiles: a.readFiles && b.readFiles,
    writeFiles: a.writeFiles && b.writeFiles,
    runCommands: a.runCommands && b.runCommands,
    network: a.network && b.network,
    manageProjects: a.manageProjects && b.manageProjects,
    externalActions: a.externalActions && b.externalActions,
  }
}

/** Orbit's rules appended to every engine session. Enforcement itself lives in the tool policy. */
function engineRules(agent: Agent, workspace: string): string {
  const p = agent.permissions
  const can = [p.readFiles && 'lire', p.writeFiles && 'modifier des fichiers', p.runCommands && 'exécuter des commandes', p.network && 'accéder au web'].filter(Boolean).join(', ')
  return [
    `Tu travailles pour l’utilisateur dans Orbit, une application qui supervise ses compagnons IA.`,
    `Dossier de travail autorisé : ${workspace}. Tout accès en dehors est bloqué.`,
    `Tu peux : ${can || 'seulement lire ce qu’on te donne'}. Certaines actions demandent l’accord de l’utilisateur ; s’il refuse, ne retente pas la même action.`,
    `Réponds en français. Termine par un récapitulatif Markdown : ce que tu as fait, les fichiers modifiés (s’il y en a), puis « Prochaines étapes ».`,
  ].join('\n')
}

export class MissionManager {
  private running = new Map<string, AbortController>()
  /** Missions admitted later (runtime at capacity), oldest first. */
  readonly deferred = new Map<string, { origin: 'user' | 'automation'; followUp?: string }>()
  /** Orbit Desktop: routes runtime-owned missions to their machine. */
  remote: MissionRemote | null = null
  /** Orbit Runtime: machine-wide limits (concurrency, budgets). */
  admission: Admission | null = null
  /** Wording of « interrupted » after a restart (Orbit Desktop vs runtime). */
  interruptedNote = 'Interrompue : Orbit a été fermé pendant l’exécution. Vous pouvez poursuivre la mission, la session est conservée.'
  private idleWaiters = new Map<string, (() => void)[]>()

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private agents: AgentManager,
    private providers: ProviderRegistry,
    private usage: UsageTracker,
    private permissions: PermissionManager,
    private memory: MemoryStore,
    private runner: AgentRunner,
    private security: SecurityService | null = null,
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

  detail(id: string): MissionDetail {
    return {
      mission: this.get(id),
      events: this.events(id),
      executions: this.db.select().from(missionExecutions).where(eq(missionExecutions.missionId, id)).orderBy(asc(missionExecutions.startedAt)).all().map(toExecution),
      toolCalls: this.db.select().from(toolCalls).where(eq(toolCalls.missionId, id)).orderBy(asc(toolCalls.createdAt)).all().map(toToolCall),
      fileChanges: this.db.select().from(fileChanges).where(eq(fileChanges.missionId, id)).orderBy(asc(fileChanges.createdAt)).all().map(toFileChange),
      inventories: this.db.select().from(fileInventories).where(eq(fileInventories.missionId, id)).orderBy(asc(fileInventories.createdAt)).all().map(toInventory),
    }
  }

  /** Latest file changes across missions, newest first, with their mission. */
  recentFiles(agentId?: string, limit = 200): RecentFileChange[] {
    const rows = this.db
      .select({ f: fileChanges, title: missions.title, shortId: missions.shortId, missionAgent: missions.agentId })
      .from(fileChanges)
      .innerJoin(missions, eq(missions.id, fileChanges.missionId))
      .where(agentId ? eq(missions.agentId, agentId) : undefined)
      .orderBy(desc(fileChanges.createdAt))
      .limit(limit)
      .all()
    return rows.map((r) => ({ ...toFileChange(r.f), agentId: r.f.agentId ?? r.missionAgent, missionTitle: r.title, missionShortId: r.shortId }))
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

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  // Commands

  create(input: {
    /** Global identifiers chosen by Orbit Desktop for a mission it sends to a runtime. */
    id?: string
    shortId?: string
    title: string
    description: string
    agentId: string
    priority: MissionPriority
    startNow: boolean
    /** Constellations: explicit folder chosen by the user for the whole run (or a worktree). */
    workspace?: string | null
    constellationRunId?: string | null
    parentMissionId?: string | null
    depth?: number
    subtask?: SubtaskSpec | null
    permissionsOverride?: AgentPermissions | null
    origin?: 'user' | 'automation'
  }): Mission {
    const agent = this.agents.get(input.agentId)
    const engine = this.providers.engine(agent.providerId)
    let workspace: string | null = null
    if (agent.runtime === 'remote') {
      // On a remote machine the « folder » is a project name under the runtime's home.
      if (!agent.machineId) throw new OrbitError('validation', `${agent.name} n’a pas de machine d’exécution.`)
      if (!this.remote) throw new OrbitError('provider', 'Exécution distante indisponible.')
      if (engine && (!agent.workingDirectory || !isSafeProjectName(agent.workingDirectory))) throw new OrbitError('validation', `Choisissez le projet distant de ${agent.name} (nom simple, sans chemin).`)
      workspace = engine ? agent.workingDirectory : null
    } else if (engine) {
      if (input.workspace) {
        this.checkWorkspace(input.workspace, agent)
        workspace = input.workspace
      } else workspace = this.requireWorkspace(agent)
    }
    const ts = nowIso()
    if (input.id && this.db.select({ id: missions.id }).from(missions).where(eq(missions.id, input.id)).get()) throw new OrbitError('conflict', 'Cette mission existe déjà.')
    const row = {
      id: input.id ?? newId(),
      shortId: input.shortId && !this.db.select({ id: missions.id }).from(missions).where(eq(missions.shortId, input.shortId)).get() ? input.shortId : this.uniqueShortId(),
      title: input.title,
      description: input.description,
      agentId: input.agentId,
      priority: input.priority,
      status: 'todo',
      engine: engine ? agent.providerId : null,
      workspace,
      constellationRunId: input.constellationRunId ?? null,
      parentMissionId: input.parentMissionId ?? null,
      depth: input.depth ?? 0,
      subtask: input.subtask ?? null,
      permissionsOverride: input.permissionsOverride ?? null,
      remoteMachineId: agent.runtime === 'remote' ? agent.machineId : null,
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.insert(missions).values(row).run()
    this.journal.activity({ type: 'mission.created', agentId: agent.id, missionId: row.id, title: input.depth ? `${agent.name} reçoit une sous-mission` : `Nouvelle mission pour ${agent.name}`, detail: input.title })
    this.bus.invalidate('missions')
    if (input.startNow) return this.start(row.id, input.origin ?? 'user')
    return this.get(row.id)
  }

  /** Resolves when the mission's current execution ends (done, failed, cancelled, or waiting on a start approval). */
  awaitIdle(id: string): Promise<Mission> {
    if (!this.running.has(id)) return Promise.resolve(this.get(id))
    return new Promise((resolve) => {
      const list = this.idleWaiters.get(id) ?? []
      list.push(() => {
        try {
          resolve(this.get(id))
        } catch {
          resolve({ ...({} as Mission), id, status: 'cancelled' } as Mission)
        }
      })
      this.idleWaiters.set(id, list)
    })
  }

  /** Persists a parsed structured result (constellation sub-missions). */
  setResultData(id: string, data: StructuredResult | null): void {
    this.db.update(missions).set({ resultData: data, updatedAt: nowIso() }).where(eq(missions.id, id)).run()
  }

  /** Back to « à faire » without starting (constellation resume). */
  reset(id: string): void {
    const m = this.get(id)
    if (m.status === 'failed' || m.status === 'cancelled') this.transition(m, 'todo', { error: null, finishedAt: null })
  }

  /** Marks a never-started mission as skipped (dependency failed, run cancelled). */
  skip(id: string, reason: string): void {
    const m = this.get(id)
    if (m.status !== 'todo' && m.status !== 'approval_required') return
    this.transition(m, 'cancelled', { finishedAt: nowIso(), error: reason })
    this.expireApprovals(id)
  }

  start(id: string, origin: 'user' | 'automation', followUp?: string): Mission {
    const mission = this.get(id)
    if (mission.remoteMachineId) {
      if (!this.remote) throw new OrbitError('provider', 'Exécution distante indisponible.')
      this.remote.submit(mission, origin, followUp)
      return this.get(id)
    }
    if (this.running.has(id)) throw new OrbitError('conflict', 'Cette mission est déjà en cours.')
    const agent = this.agents.get(mission.agentId)
    const engine = mission.engine ? this.providers.engine(mission.engine) : null
    if (mission.engine && !engine) throw new OrbitError('provider', 'Le moteur de cette mission n’est pas disponible.')
    if (engine && mission.engine !== agent.providerId) {
      throw new OrbitError('conflict', `Cette mission appartient à une session ${engine.name}. Dupliquez-la pour la confier au moteur actuel de ${agent.name}.`)
    }
    if (engine && agent.runtime !== 'remote') this.checkWorkspace(mission.workspace, agent)
    if (agent.isolation === 'strict' && agent.runtime !== 'remote') {
      // Fail closed: never run « strict » silently in standard mode.
      if (!engine?.capabilities.confinable) throw new OrbitError('forbidden', `L’isolation renforcée n’est pas disponible pour ${engine?.name ?? 'ce fournisseur'}.`)
      if (this.security && !this.security.isolationProven()) throw new OrbitError('forbidden', 'Isolation renforcée demandée, mais l’auto-test de confinement a échoué sur ce Mac. Paramètres → Sécurité.')
    }

    const decision = this.permissions.check(agent, 'mission.start', origin, { toolGated: Boolean(engine) })
    if (!decision.allowed) throw new OrbitError('forbidden', decision.reason ?? 'Démarrage refusé.')

    const adapter = this.providers.adapter(agent.providerId)
    if (adapter.availability !== 'available') throw new OrbitError('provider', `${adapter.name} n’est pas encore disponible.`)
    if (adapter.requiresSecret && !this.providers.secretFor(agent.providerId)) {
      const from = adapter.secretFrom ? this.providers.adapter(adapter.secretFrom).name : adapter.name
      throw new OrbitError('provider', `Connectez ${from} pour que ${agent.name} puisse travailler.`)
    }
    const admitted = this.admission?.(agent, mission) ?? null
    const blocked = this.usage.budgetBlock(agent) ?? (admitted && 'block' in admitted ? admitted.block : null)
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

    if (admitted && 'defer' in admitted) {
      // Machine at capacity: stays « à faire », started by the host when a slot frees up.
      this.deferred.set(id, { origin, followUp })
      this.event(id, 'queue', 'warning', admitted.defer)
      this.bus.invalidate('missions')
      return this.get(id)
    }
    this.deferred.delete(id)
    this.transition(mission, 'running', { startedAt: mission.startedAt && followUp ? mission.startedAt : nowIso(), finishedAt: null, error: null, ...(followUp ? {} : { result: null }) })
    void this.execute(id, followUp).catch((err) => this.journal.activity({ type: 'mission.failed', level: 'error', missionId: id, title: 'Erreur interne d’exécution', detail: String(err) }))
    return this.get(id)
  }

  /** Continues an agent mission in the same engine session (resumes after a restart too). */
  followUp(id: string, prompt: string, origin: 'user' | 'automation' = 'user'): Mission {
    const mission = this.get(id)
    if (mission.remoteMachineId) {
      if (mission.status === 'running' || mission.status === 'approval_required') throw new OrbitError('conflict', 'Le compagnon travaille encore sur cette mission.')
      return this.start(id, origin, prompt)
    }
    // Constellation coordinators on a chat provider get their full context in the prompt itself.
    if (!mission.engine && !mission.constellationRunId) throw new OrbitError('validation', 'Seules les missions confiées à un moteur agent (Claude Code, Claude Agent SDK, Codex) peuvent être poursuivies.')
    if (this.running.has(id)) throw new OrbitError('conflict', 'Le compagnon travaille encore sur cette mission.')
    if (mission.status === 'approval_required') throw new OrbitError('conflict', 'Répondez d’abord à la demande d’approbation en attente.')
    if (mission.status !== 'todo') this.transition(mission, 'todo')
    return this.start(id, origin, prompt)
  }

  cancel(id: string): Mission {
    const mission = this.get(id)
    if (mission.remoteMachineId && this.remote) {
      this.remote.cancel(mission)
      return this.get(id)
    }
    if (this.deferred.delete(id) && mission.status === 'todo') {
      this.transition(mission, 'cancelled', { finishedAt: nowIso() })
      return this.get(id)
    }
    const controller = this.running.get(id)
    if (controller) {
      this.runner.denyAllFor(id)
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
    this.runner.denyAllFor(id)
    this.running.get(id)?.abort()
    this.db.delete(missions).where(eq(missions.id, id)).run()
    this.runner.grants.expireMission(id)
    this.bus.invalidate('missions', 'approvals')
  }

  /**
   * The user's answer. `scope` widens a « yes » into a persistent authorisation for this exact
   * operation (« for this mission » / « always for this companion and folder »), within the
   * limit the policy offered when it asked. Only reachable from the UI, never from an engine.
   */
  resolveApproval(id: string, approve: boolean, scope: GrantScope = 'once'): ApprovalRequest {
    const row = this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
    if (!row) throw new OrbitError('not_found', 'Demande introuvable.')
    if (row.status !== 'pending') throw new OrbitError('conflict', 'Cette demande a déjà été traitée.')
    if (row.machineId && this.remote) {
      // Decided on the runtime that holds the paused operation; this copy updates when it answers.
      this.remote.resolveApproval(toApproval(row), approve, scope)
      return toApproval(row)
    }
    if (row.kind === 'tool_use' && !this.runner.hasPendingApproval(id)) {
      this.db.update(approvalRequests).set({ status: 'expired', resolvedAt: nowIso() }).where(eq(approvalRequests.id, id)).run()
      this.bus.invalidate('approvals')
      throw new OrbitError('conflict', 'Cette demande a expiré : l’exécution qui l’attendait est terminée.')
    }
    // Validated before anything is resolved: a refused widening leaves the question open.
    const grant = approve && row.kind === 'tool_use' && scope !== 'once' ? this.runner.grants.grantFromApproval({ agentId: row.agentId, missionId: row.missionId, payload: row.payload, scope }) : null
    this.db.update(approvalRequests).set({ status: approve ? 'approved' : 'denied', resolvedAt: nowIso() }).where(eq(approvalRequests.id, id)).run()
    this.journal.audit({ actor: 'user', agentId: row.agentId, action: `approval.${approve ? 'approve' : 'deny'}`, target: row.missionId, allowed: approve, reason: row.summary })
    if (grant) {
      this.journal.audit({ actor: 'user', agentId: row.agentId, action: `grant.${grant.scope}`, target: grant.label, allowed: true, reason: grant.workspace })
      this.security?.audit({ agentId: row.agentId, missionId: row.missionId, layer: 'grant', action: `grant.${grant.scope}`, target: grant.label, decision: 'approved', reason: grant.scope === 'always' ? 'Toujours, pour ce compagnon et ce dossier' : 'Pour cette mission' })
      this.bus.invalidate('security')
    }
    this.journal.activity({ type: 'approval.resolved', level: approve ? 'success' : 'info', agentId: row.agentId, missionId: row.missionId, title: approve ? 'Demande approuvée' : 'Demande refusée', detail: row.summary })
    if (row.kind === 'tool_use') {
      this.runner.resolveApproval(id, approve)
      // Same exact operation already waiting elsewhere: the new rule answers it too.
      if (grant) {
        const others = this.db.select().from(approvalRequests).where(and(eq(approvalRequests.agentId, row.agentId), eq(approvalRequests.status, 'pending'), eq(approvalRequests.kind, 'tool_use'))).all()
        for (const o of others) {
          const ows = o.payload?.grant?.workspace ?? o.payload?.cwd
          if (o.payload?.grant?.key !== grant.operationKey || !ows || this.runner.grants.find({ agentId: o.agentId, workspace: ows, missionId: o.missionId, key: grant.operationKey })?.id !== grant.id) continue
          if (!this.runner.hasPendingApproval(o.id)) continue
          this.db.update(approvalRequests).set({ status: 'approved', resolvedAt: nowIso() }).where(eq(approvalRequests.id, o.id)).run()
          this.runner.resolveApproval(o.id, true)
        }
      }
      if (!approve) this.journal.activity({ type: 'tool.denied', agentId: row.agentId, missionId: row.missionId, title: 'Action refusée', detail: row.summary })
    } else if (row.missionId && row.kind === 'mission_start') {
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
    for (const id of this.running.keys()) this.runner.denyAllFor(id)
    for (const c of this.running.values()) c.abort()
  }

  /**
   * After a crash or quit nothing is running. Interrupted work is marked failed, its
   * questions expire and its tools are closed. Engine sessions stay resumable: the user
   * can continue the mission, which resumes the same session.
   */
  recoverInterrupted(): void {
    const ts = nowIso()
    // Copies of runtime-owned missions are never touched here: their runtime says what happened.
    const open = this.db.select({ ex: missionExecutions }).from(missionExecutions).innerJoin(missions, eq(missions.id, missionExecutions.missionId)).where(and(eq(missionExecutions.status, 'running'), isNull(missions.remoteMachineId))).all().map((r) => r.ex)
    for (const ex of open) {
      this.db
        .update(missions)
        .set({ status: 'failed', error: this.interruptedNote, finishedAt: ts, updatedAt: ts })
        .where(and(eq(missions.id, ex.missionId), inArray(missions.status, ['running', 'waiting', 'approval_required'])))
        .run()
      this.db.update(missionExecutions).set({ status: 'failed', error: 'Interrompue', finishedAt: ts }).where(eq(missionExecutions.id, ex.id)).run()
    }
    this.db.update(approvalRequests).set({ status: 'expired', resolvedAt: ts }).where(and(eq(approvalRequests.kind, 'tool_use'), eq(approvalRequests.status, 'pending'), isNull(approvalRequests.machineId))).run()
    const local = this.db.select({ id: missions.id }).from(missions).where(isNull(missions.remoteMachineId))
    this.db.update(toolCalls).set({ status: 'cancelled', finishedAt: ts }).where(and(inArray(toolCalls.status, ['running', 'awaiting_approval']), inArray(toolCalls.missionId, local))).run()
  }

  // Execution engine

  private async execute(missionId: string, followUp?: string): Promise<void> {
    const mission = this.get(missionId)
    const agent = this.agents.get(mission.agentId)
    const adapter = this.providers.adapter(agent.providerId)
    const attempts = this.db.select({ n: count() }).from(missionExecutions).where(eq(missionExecutions.missionId, missionId)).get()?.n ?? 0
    const executionId = newId()
    const prompt = followUp ?? `# Mission ${mission.shortId} — ${mission.title}\n\nPriorité : ${mission.priority}\n\n${mission.description || '(pas de description)'}`
    try {
      this.db.insert(missionExecutions).values({ id: executionId, missionId, idempotencyKey: `${missionId}:${attempts + 1}`, status: 'running', prompt, startedAt: nowIso() }).run()
    } catch {
      throw new OrbitError('conflict', 'Cette exécution a déjà été lancée.')
    }
    const controller = new AbortController()
    this.running.set(missionId, controller)
    this.agents.setStatus(agent.id, 'working', mission.title)
    const engine = mission.engine ? this.providers.engine(mission.engine) : null
    // A delegated mission never gets more than its companion: intersection, never union.
    const effectivePerms = intersectPermissions(agent.permissions, mission.permissionsOverride)
    if (followUp) this.event(missionId, executionId, 'user', followUp)
    this.event(missionId, executionId, 'started', `${agent.name} ${followUp ? 'reprend' : 'commence'} la mission avec ${adapter.name} · ${agent.model}${mission.workspace ? ` · ${mission.workspace}` : ''}`)
    if (!followUp) this.journal.activity({ type: 'mission.started', agentId: agent.id, missionId, title: `${agent.name} a démarré une mission`, detail: mission.title })

    let text = ''
    let usage: { inputTokens: number; outputTokens: number; costUsd: number | null; costKind: Mission['costKind'] } | null = null
    let failure: string | null = null
    let cancelled = false
    try {
      if (engine) {
        const outcome = await this.runner.run({
          mission,
          agent,
          engine,
          executionId,
          prompt,
          instructions: `${agent.instructions}${this.memory.contextFor(agent.id)}\n\n${engineRules({ ...agent, permissions: effectivePerms }, mission.workspace!)}`,
          permissions: effectivePerms,
          remote: agent.runtime === 'remote',
          secret: adapter.requiresSecret ? this.providers.secretFor(agent.providerId) : null,
          budgetUsd: engine.capabilities.budgetCap ? this.usage.remainingBudget(agent) : null,
          signal: controller.signal,
          onSession: (model) => this.providers.noteEngineSession(engine.id, model),
          onWaiting: (waiting) => {
            const fresh = this.get(missionId)
            if (waiting && fresh.status === 'running') this.transition(fresh, 'approval_required')
            else if (!waiting && fresh.status === 'approval_required') this.transition(fresh, 'running')
          },
        })
        text = outcome.finalText
        usage = outcome.usage.costKind || outcome.usage.inputTokens ? outcome.usage : null
        cancelled = outcome.status === 'cancelled' || controller.signal.aborted
        if (outcome.status === 'failed') failure = outcome.error?.message ?? 'Le moteur a échoué.'
      } else {
        const r = await this.streamChat(missionId, executionId, agent, prompt, controller.signal)
        text = r.text
        usage = r.usage
        cancelled = controller.signal.aborted
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    } finally {
      this.running.delete(missionId)
    }

    try {
      this.finish({ missionId, executionId, agent, mission, text, usage, failure, cancelled, followUp: Boolean(followUp) })
    } catch (err) {
      // The mission may have been deleted while running.
      if (!(err instanceof OrbitError && err.code === 'not_found')) throw err
      this.agents.setStatus(agent.id, 'available', null)
    } finally {
      this.bus.invalidate('missions', 'agents')
      for (const w of this.idleWaiters.get(missionId)?.splice(0) ?? []) w()
      this.idleWaiters.delete(missionId)
    }
  }

  private finish(o: {
    missionId: string
    executionId: string
    agent: Agent
    mission: Mission
    text: string
    usage: { inputTokens: number; outputTokens: number; costUsd: number | null; costKind: Mission['costKind'] } | null
    failure: string | null
    cancelled: boolean
    followUp: boolean
  }) {
    const { missionId, executionId, agent, mission, usage } = o
    const fresh = this.get(missionId)
    const prevCost = o.followUp ? fresh.costUsd : null
    const costUsd = usage?.costUsd != null ? (prevCost ?? 0) + usage.costUsd : prevCost
    const costPatch = usage ? { costUsd, costKind: usage.costKind } : {}
    const result = o.text || (o.followUp ? fresh.result : null)
    this.db
      .update(missionExecutions)
      .set({
        status: o.failure ? 'failed' : o.cancelled ? 'cancelled' : 'done',
        error: o.failure,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: usage?.costUsd ?? null,
        costKind: usage?.costKind ?? null,
        finishedAt: nowIso(),
      })
      .where(eq(missionExecutions.id, executionId))
      .run()

    if (o.cancelled) {
      if (canTransition(fresh.status, 'cancelled')) this.transition(fresh, 'cancelled', { finishedAt: nowIso(), result, ...costPatch })
      this.event(missionId, executionId, 'cancelled', 'Mission arrêtée par l’utilisateur.')
      this.agents.setStatus(agent.id, 'available', null)
      this.journal.activity({ type: 'mission.cancelled', agentId: agent.id, missionId, title: 'Mission arrêtée', detail: mission.title })
    } else if (o.failure) {
      if (canTransition(fresh.status, 'failed')) this.transition(fresh, 'failed', { finishedAt: nowIso(), error: o.failure, result, ...costPatch })
      this.event(missionId, executionId, 'failed', o.failure)
      this.agents.setStatus(agent.id, 'error', o.failure.slice(0, 120))
      this.journal.activity({ type: 'mission.failed', level: 'error', agentId: agent.id, missionId, title: `Échec de la mission de ${agent.name}`, detail: o.failure })
      this.journal.notify('mission_failed', `Mission échouée · ${agent.name}`, o.failure, `/missions/${missionId}`)
    } else {
      this.transition(fresh, 'done', { finishedAt: nowIso(), result, ...costPatch })
      this.event(missionId, executionId, 'completed', 'Mission terminée.')
      this.agents.setStatus(agent.id, 'done', mission.title)
      setTimeout(() => {
        try {
          if (this.agents.get(agent.id).status === 'done') this.agents.setStatus(agent.id, 'available', null)
        } catch {
          /* agent deleted meanwhile */
        }
      }, 8000).unref?.()
      this.journal.activity({ type: 'mission.completed', level: 'success', agentId: agent.id, missionId, title: `${agent.name} a terminé une mission`, detail: mission.title })
      this.journal.notify('mission_done', `${agent.name} a terminé`, mission.title, `/missions/${missionId}`)
    }
  }

  /** Chat providers: one streamed answer, no tools. */
  private async streamChat(missionId: string, executionId: string, agent: Agent, prompt: string, signal: AbortSignal) {
    const adapter = this.providers.adapter(agent.providerId)
    let text = ''
    let pending = ''
    let lastFlush = Date.now()
    let chunkUsage: Extract<StreamChunk, { type: 'usage' }> | null = null
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
      for await (const chunk of adapter.stream({ model: agent.model, system, messages: [{ role: 'user', content: prompt }], maxTokens: 32_000 }, secret, signal)) {
        if (chunk.type === 'text') {
          text += chunk.text
          pending += chunk.text
          this.bus.emit({ type: 'mission.delta', missionId, executionId, delta: chunk.text })
          if (Date.now() - lastFlush > OUTPUT_FLUSH_MS) flushOutput()
        } else if (chunk.type === 'usage') chunkUsage = chunk
      }
    } finally {
      flushOutput()
    }
    if (!chunkUsage) return { text, usage: null }
    const cost = this.usage.recordChunk(agent.id, agent.providerId, agent.model, chunkUsage, 'mission')
    this.event(missionId, executionId, 'usage', `${chunkUsage.inputTokens.toLocaleString('fr-FR')} jetons en entrée · ${chunkUsage.outputTokens.toLocaleString('fr-FR')} en sortie${cost.model !== agent.model ? ` · servi par ${cost.model}` : ''}`, { ...chunkUsage, ...cost })
    return { text, usage: { inputTokens: chunkUsage.inputTokens, outputTokens: chunkUsage.outputTokens, costUsd: cost.costUsd, costKind: cost.costKind } }
  }

  private requireWorkspace(agent: Agent): string {
    if (!agent.workingDirectory) {
      throw new OrbitError('validation', `Choisissez d’abord le dossier autorisé de ${agent.name} (fiche du compagnon → Permissions).`)
    }
    this.checkWorkspace(agent.workingDirectory, agent)
    return agent.workingDirectory
  }

  private checkWorkspace(workspace: string | null, agent: Agent) {
    if (!workspace || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw new OrbitError('validation', `Le dossier autorisé de ${agent.name} est introuvable : ${workspace ?? 'aucun'}.`)
    }
    if (workspace === '/' || workspace === process.env.HOME) {
      throw new OrbitError('forbidden', 'Par sécurité, un compagnon ne peut pas travailler à la racine du disque ni dans tout votre dossier personnel. Choisissez un dossier de projet.')
    }
  }

  private event(missionId: string, executionId: string, type: ExecutionEvent['type'], message: string, data: Record<string, unknown> | null = null) {
    const row = { id: newId(), missionId, executionId, type, message, data, createdAt: nowIso() }
    this.db.insert(executionEvents).values(row).run()
    this.bus.emit({ type: 'mission.event', event: toExecutionEvent(row) })
  }

  private transition(mission: Mission, to: MissionStatus, extra: Partial<typeof missions.$inferInsert> = {}) {
    if (!canTransition(mission.status, to)) {
      throw new OrbitError('conflict', `Transition interdite : ${MISSION_STATUS_LABELS[mission.status]} → ${MISSION_STATUS_LABELS[to]}.`)
    }
    this.db.update(missions).set({ ...extra, status: to, updatedAt: nowIso() }).where(eq(missions.id, mission.id)).run()
    mission.status = to
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
