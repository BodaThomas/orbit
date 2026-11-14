import { join } from 'node:path'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { TERMINAL_MISSION_STATUSES } from '@shared/mission-states'
import type {
  Agent,
  AgentPermissions,
  AgentWorkspace,
  ConstellationDefinition,
  ConstellationLimits,
  ConstellationMember,
  ConstellationRun,
  ConstellationRunDetail,
  ConstellationRunStatus,
  ConstellationSignal,
  ConstellationTask,
  ExecutionHandoff,
  Mission,
  SubtaskSpec,
} from '@shared/types'
import type { OrbitDb } from '../../infra/db/client'
import { agentWorkspaces, constellationDefinitions, constellationMembers, constellationRuns, executionHandoffs, missionDependencies, missionExecutions, missions } from '../../infra/db/schema'
import type { AgentManager } from '../agents'
import type { EventBus } from '../event-bus'
import type { Journal } from '../journal'
import { intersectPermissions, type MissionManager } from '../missions'
import type { ProviderRegistry } from '../providers'
import { newId, nowIso, OrbitError } from '../util'
import { handoffPrompt, parseResult, planningPrompt, stripProtocol, synthesisPrompt, validatePlan, type PlanTask } from './protocol'
import { addWorktree, branchDiff, commitAll, conflictsBetween, diffStat, headRef, mergeBranch, removeWorktree, repoRoot } from './worktrees'

/** Orbit Desktop: runs whose companions all live on one runtime are coordinated there. */
export interface ConstellationRemote {
  launch(def: ConstellationDefinition, run: ConstellationRun, goal: string, origin: 'user' | 'automation'): void
  cancel(run: ConstellationRun): void
}

export const DEFAULT_LIMITS: ConstellationLimits = { maxDepth: 2, maxSubtasks: 8, maxParallel: 2, maxDurationMin: 60, maxTokens: 2_000_000, maxBudgetUsd: 5 }
const ACTIVE_RUN: ConstellationRunStatus[] = ['planning', 'running', 'synthesizing']

export interface ConstellationInput {
  name: string
  description: string
  objective: string
  coordinatorAgentId: string
  members: ConstellationMember[]
  workspace: string | null
  workspaceMode: 'shared' | 'worktrees'
  permissions: AgentPermissions
  limits: ConstellationLimits
  isTemplate: boolean
}

interface RunState {
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  /** workspace → mission id currently holding the writer lock (shared mode). */
  writerLocks: Map<string, string>
}

/**
 * Orchestrates a constellation: the coordinator plans, Orbit validates and creates
 * sub-missions, runs them (dependencies, parallelism, writer lock, limits), hands
 * results back, and the coordinator synthesises - possibly over several rounds.
 *
 * Every member keeps its own engine, model, permissions and memory: sub-missions are
 * ordinary missions of that companion, so all existing guarantees (tool policy,
 * approvals, file inventory, usage) apply unchanged. Delegation can only lower
 * permissions (companion ∩ constellation ceiling ∩ read-only flag).
 */
export class ConstellationEngine {
  private active = new Map<string, RunState>()
  remote: ConstellationRemote | null = null
  /** Set on shutdown: drive loops still unwinding must not write to the closed database. */
  private disposed = false

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private agents: AgentManager,
    private missions: MissionManager,
    private providers: ProviderRegistry,
    private worktreeRoot: string,
  ) {}

  // Definitions

  list(): ConstellationDefinition[] {
    return this.db.select().from(constellationDefinitions).orderBy(asc(constellationDefinitions.createdAt)).all().map((r) => this.toDefinition(r))
  }

  get(id: string): ConstellationDefinition {
    const r = this.db.select().from(constellationDefinitions).where(eq(constellationDefinitions.id, id)).get()
    if (!r) throw new OrbitError('not_found', 'Constellation introuvable.')
    return this.toDefinition(r)
  }

  create(input: ConstellationInput): ConstellationDefinition {
    this.validateDefinition(input)
    const id = newId()
    const ts = nowIso()
    this.db.transaction((tx) => {
      tx.insert(constellationDefinitions).values({ id, name: input.name, description: input.description, objective: input.objective, coordinatorAgentId: input.coordinatorAgentId, workspace: input.workspace, workspaceMode: input.workspaceMode, permissions: input.permissions, limits: input.limits, isTemplate: input.isTemplate, createdAt: ts, updatedAt: ts }).run()
      input.members.forEach((m, i) => tx.insert(constellationMembers).values({ constellationId: id, agentId: m.agentId, role: m.role, responsibilities: m.responsibilities, canDelegate: m.canDelegate, sortOrder: i }).run())
    })
    this.journal.activity({ type: 'constellation.created', level: 'success', agentId: input.coordinatorAgentId, title: `Constellation « ${input.name} » créée`, detail: `${input.members.length} compagnons` })
    this.journal.audit({ actor: 'user', agentId: null, action: 'constellation.create', target: input.name, allowed: true, reason: null })
    this.bus.invalidate('constellations')
    return this.get(id)
  }

  update(id: string, input: ConstellationInput): ConstellationDefinition {
    this.get(id)
    this.validateDefinition(input)
    this.db.transaction((tx) => {
      tx.update(constellationDefinitions).set({ name: input.name, description: input.description, objective: input.objective, coordinatorAgentId: input.coordinatorAgentId, workspace: input.workspace, workspaceMode: input.workspaceMode, permissions: input.permissions, limits: input.limits, isTemplate: input.isTemplate, updatedAt: nowIso() }).where(eq(constellationDefinitions.id, id)).run()
      tx.delete(constellationMembers).where(eq(constellationMembers.constellationId, id)).run()
      input.members.forEach((m, i) => tx.insert(constellationMembers).values({ constellationId: id, agentId: m.agentId, role: m.role, responsibilities: m.responsibilities, canDelegate: m.canDelegate, sortOrder: i }).run())
    })
    this.bus.invalidate('constellations')
    return this.get(id)
  }

  delete(id: string): void {
    const running = this.db.select({ id: constellationRuns.id }).from(constellationRuns).where(and(eq(constellationRuns.constellationId, id), inArray(constellationRuns.status, ACTIVE_RUN))).all()
    if (running.length) throw new OrbitError('conflict', 'Arrêtez d’abord l’exécution en cours de cette constellation.')
    this.db.delete(constellationDefinitions).where(eq(constellationDefinitions.id, id)).run()
    this.bus.invalidate('constellations')
  }

  duplicate(id: string, asTemplate = false): ConstellationDefinition {
    const d = this.get(id)
    return this.create({ ...d, name: `${d.name} (copie)`.slice(0, 80), isTemplate: asTemplate })
  }

  private validateDefinition(input: ConstellationInput) {
    if (!input.members.some((m) => m.agentId === input.coordinatorAgentId)) throw new OrbitError('validation', 'Le coordinateur doit faire partie de la constellation.')
    if (new Set(input.members.map((m) => m.agentId)).size !== input.members.length) throw new OrbitError('validation', 'Un compagnon ne peut apparaître qu’une fois.')
    for (const m of input.members) this.agents.get(m.agentId)
    const l = input.limits
    if (l.maxDepth < 1 || l.maxDepth > 5 || l.maxSubtasks < 1 || l.maxSubtasks > 50 || l.maxParallel < 1 || l.maxParallel > 8 || l.maxDurationMin < 1 || l.maxDurationMin > 24 * 60) throw new OrbitError('validation', 'Limites hors des bornes autorisées.')
  }

  private toDefinition(r: typeof constellationDefinitions.$inferSelect): ConstellationDefinition {
    const members = this.db.select().from(constellationMembers).where(eq(constellationMembers.constellationId, r.id)).orderBy(asc(constellationMembers.sortOrder)).all()
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      objective: r.objective,
      coordinatorAgentId: r.coordinatorAgentId,
      members: members.map((m) => ({ agentId: m.agentId, role: m.role, responsibilities: m.responsibilities, canDelegate: m.canDelegate })),
      workspace: r.workspace,
      workspaceMode: r.workspaceMode === 'worktrees' ? 'worktrees' : 'shared',
      permissions: r.permissions,
      limits: { ...DEFAULT_LIMITS, ...r.limits },
      isTemplate: r.isTemplate,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  }

  // Runs: queries

  runs(constellationId?: string, limit = 100): ConstellationRun[] {
    return this.db
      .select()
      .from(constellationRuns)
      .where(constellationId ? eq(constellationRuns.constellationId, constellationId) : undefined)
      .orderBy(desc(constellationRuns.createdAt))
      .limit(limit)
      .all()
      .map((r) => this.toRun(r))
  }

  run(id: string): ConstellationRun {
    const r = this.db.select().from(constellationRuns).where(eq(constellationRuns.id, id)).get()
    if (!r) throw new OrbitError('not_found', 'Exécution introuvable.')
    return this.toRun(r)
  }

  detail(id: string): ConstellationRunDetail {
    const run = this.run(id)
    let definition: ConstellationDefinition | null
    try {
      definition = this.get(run.constellationId)
    } catch {
      definition = null
    }
    return {
      run,
      definition,
      tasks: this.tasks(id),
      handoffs: this.db.select().from(executionHandoffs).where(eq(executionHandoffs.runId, id)).orderBy(asc(executionHandoffs.createdAt)).all().map((h) => ({ ...h, kind: h.kind as ExecutionHandoff['kind'] })),
      workspaces: this.db.select().from(agentWorkspaces).where(eq(agentWorkspaces.runId, id)).all().map((w) => this.toWorkspace(w)),
    }
  }

  private tasks(runId: string): ConstellationTask[] {
    const rows = this.db.select().from(missions).where(and(eq(missions.constellationRunId, runId))).orderBy(asc(missions.createdAt)).all().filter((m) => m.depth > 0)
    const deps = rows.length ? this.db.select().from(missionDependencies).where(inArray(missionDependencies.missionId, rows.map((r) => r.id))).all() : []
    const usage = rows.length ? this.db.select().from(missionExecutions).where(inArray(missionExecutions.missionId, rows.map((r) => r.id))).all() : []
    return rows.map((m) => {
      const ex = usage.filter((u) => u.missionId === m.id)
      const agent = this.safeAgent(m.agentId)
      return {
        missionId: m.id,
        shortId: m.shortId,
        agentId: m.agentId,
        title: m.title,
        status: m.status as Mission['status'],
        spec: m.subtask!,
        dependsOnMissionIds: deps.filter((d) => d.missionId === m.id).map((d) => d.dependsOnMissionId),
        permissions: intersectPermissions(agent?.permissions ?? m.permissionsOverride!, m.permissionsOverride),
        workspace: m.workspace,
        result: m.result,
        structured: m.resultData ?? null,
        error: m.error,
        startedAt: m.startedAt,
        finishedAt: m.finishedAt,
        inputTokens: ex.reduce((s, e) => s + (e.inputTokens ?? 0), 0),
        outputTokens: ex.reduce((s, e) => s + (e.outputTokens ?? 0), 0),
        costUsd: ex.some((e) => e.costUsd != null) ? ex.reduce((s, e) => s + (e.costUsd ?? 0), 0) : null,
      }
    })
  }

  private totals(runId: string): { tokens: number; costUsd: number | null } {
    const rows = this.db
      .select({ i: missionExecutions.inputTokens, o: missionExecutions.outputTokens, c: missionExecutions.costUsd })
      .from(missionExecutions)
      .innerJoin(missions, eq(missions.id, missionExecutions.missionId))
      .where(eq(missions.constellationRunId, runId))
      .all()
    return { tokens: rows.reduce((s, r) => s + (r.i ?? 0) + (r.o ?? 0), 0), costUsd: rows.some((r) => r.c != null) ? rows.reduce((s, r) => s + (r.c ?? 0), 0) : null }
  }

  private toRun(r: typeof constellationRuns.$inferSelect): ConstellationRun {
    let name = '—'
    try {
      name = this.db.select({ n: constellationDefinitions.name }).from(constellationDefinitions).where(eq(constellationDefinitions.id, r.constellationId)).get()?.n ?? '—'
    } catch {
      /* deleted */
    }
    const t = this.totals(r.id)
    return {
      id: r.id,
      constellationId: r.constellationId,
      constellationName: name,
      goal: r.goal,
      status: r.status as ConstellationRunStatus,
      coordinatorAgentId: r.coordinatorAgentId,
      coordinatorMissionId: r.coordinatorMissionId,
      round: r.round,
      workspace: r.workspace,
      limits: r.limits,
      synthesis: r.synthesis,
      error: r.error,
      tokens: t.tokens,
      costUsd: t.costUsd,
      origin: r.origin === 'automation' ? 'automation' : 'user',
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      machineId: r.machineId ?? null,
    }
  }

  /**
   * Where a run executes: on this host, or on the one runtime machine where the coordinator
   * and every member are placed. Mixed placements are refused (a remote coordinator can't
   * reach a companion on the Mac, and a Mac coordinator would stop with the Mac).
   */
  placement(def: ConstellationDefinition): string | null {
    const places = new Set(def.members.map((m) => {
      const a = this.agents.get(m.agentId)
      return a.runtime === 'remote' ? `m:${a.machineId}` : 'local'
    }))
    if (places.size > 1) throw new OrbitError('validation', 'Tous les compagnons de cette constellation doivent travailler au même endroit (ce Mac, ou la même machine distante). Déplacez-les depuis leur profil.')
    const only = [...places][0]!
    return only === 'local' ? null : only.slice(2)
  }

  private toWorkspace(w: typeof agentWorkspaces.$inferSelect): AgentWorkspace {
    return { ...w, kind: w.kind === 'worktree' ? 'worktree' : 'shared', status: w.status as AgentWorkspace['status'], conflictWith: w.conflictWith ?? [] }
  }

  private safeAgent(id: string): Agent | null {
    try {
      return this.agents.get(id)
    } catch {
      return null
    }
  }

  // Runs: commands

  /** Starts a run. `idempotencyKey` prevents a double start (scheduler, double click). */
  launch(constellationId: string, goal: string, opts: { origin?: 'user' | 'automation'; idempotencyKey?: string; id?: string } = {}): ConstellationRun {
    const def = this.get(constellationId)
    if (opts.idempotencyKey) {
      const existing = this.db.select().from(constellationRuns).where(eq(constellationRuns.idempotencyKey, opts.idempotencyKey)).get()
      if (existing) return this.toRun(existing)
    }
    const coordinator = this.agents.get(def.coordinatorAgentId)
    if (!coordinator.enabled) throw new OrbitError('forbidden', `${coordinator.name} (coordinateur) est désactivé.`)
    const machineId = this.remote ? this.placement(def) : null
    if (machineId && def.workspace && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(def.workspace)) throw new OrbitError('validation', 'Sur une machine distante, le dossier de la constellation est un nom de projet (sans chemin).')
    const id = opts.id ?? newId()
    if (this.db.select({ id: constellationRuns.id }).from(constellationRuns).where(eq(constellationRuns.id, id)).get()) return this.run(id)
    this.db
      .insert(constellationRuns)
      .values({ id, constellationId, goal, status: 'planning', coordinatorAgentId: def.coordinatorAgentId, workspace: def.workspace, limits: def.limits, origin: opts.origin ?? 'user', idempotencyKey: opts.idempotencyKey ?? null, createdAt: nowIso(), startedAt: nowIso(), machineId })
      .run()
    if (machineId) {
      // Coordinated by the runtime: this row is the copy it will keep up to date.
      this.remote!.launch(def, this.run(id), goal, opts.origin ?? 'user')
      this.bus.invalidate('constellations')
      return this.run(id)
    }
    this.journal.activity({ type: 'constellation.started', agentId: coordinator.id, title: `Constellation « ${def.name} » en route`, detail: goal.slice(0, 200) })
    this.bus.invalidate('constellations', 'missions')
    this.spawnDrive(id)
    return this.run(id)
  }

  cancel(runId: string): ConstellationRun {
    const run = this.run(runId)
    if (run.machineId && this.remote) {
      this.remote.cancel(run)
      return run
    }
    const state = this.active.get(runId)
    if (state) state.controller.abort()
    for (const t of this.tasks(runId)) {
      if (this.missions.isRunning(t.missionId)) this.missions.cancel(t.missionId)
      else this.missions.skip(t.missionId, 'Constellation arrêtée.')
    }
    if (run.coordinatorMissionId && this.missions.isRunning(run.coordinatorMissionId)) this.missions.cancel(run.coordinatorMissionId)
    if (ACTIVE_RUN.includes(run.status) || run.status === 'interrupted') this.finishRun(runId, 'cancelled', null, 'Arrêtée par l’utilisateur.')
    return this.run(runId)
  }

  /**
   * Resumes an interrupted or failed run. Completed sub-missions keep their results;
   * the others run again - the user triggers this explicitly after seeing the list.
   */
  resume(runId: string): ConstellationRun {
    const run = this.run(runId)
    if (run.machineId && this.remote) throw new OrbitError('validation', 'Une constellation distante interrompue ne reprend pas automatiquement : relancez-la (les résultats obtenus restent consultables).')
    if (this.active.has(runId)) throw new OrbitError('conflict', 'Cette constellation est déjà en cours.')
    if (!['interrupted', 'failed', 'cancelled'].includes(run.status)) throw new OrbitError('conflict', 'Seule une exécution interrompue, échouée ou arrêtée peut reprendre.')
    this.db.update(constellationRuns).set({ status: 'running', error: null, finishedAt: null }).where(eq(constellationRuns.id, runId)).run()
    this.journal.activity({ type: 'constellation.started', agentId: run.coordinatorAgentId, title: `Reprise de « ${run.constellationName} »`, detail: run.goal.slice(0, 200) })
    this.bus.invalidate('constellations')
    this.spawnDrive(runId, true)
    return this.run(runId)
  }

  /** On boot nothing runs: open runs become « interrupted » (never auto-relaunched). */
  recoverInterrupted(): void {
    // Runs coordinated by a runtime are left alone: their runtime reports what happened.
    const open = this.db.select().from(constellationRuns).where(and(inArray(constellationRuns.status, ACTIVE_RUN), isNull(constellationRuns.machineId))).all()
    for (const r of open) {
      this.db.update(constellationRuns).set({ status: 'interrupted', error: this.interruptedNote, finishedAt: nowIso() }).where(eq(constellationRuns.id, r.id)).run()
      for (const t of this.tasks(r.id)) if (t.status === 'todo') this.missions.skip(t.missionId, 'Interrompue avant son démarrage.')
    }
  }

  isActive(runId: string): boolean {
    return this.active.has(runId)
  }

  interruptedNote = 'Interrompue : Orbit a été fermé pendant l’exécution. Les résultats déjà obtenus sont conservés.'

  cancelAll(): void {
    for (const id of [...this.active.keys()]) this.cancel(id)
    this.disposed = true
  }

  // Workspaces

  async workspaceDiff(workspaceId: string): Promise<string> {
    const w = this.workspaceRow(workspaceId)
    if (w.kind !== 'worktree' || !w.branch || !w.baseRef) return ''
    const repo = await repoRoot(this.run(w.runId).workspace ?? w.path)
    return repo ? branchDiff(repo, w.baseRef, w.branch) : ''
  }

  async mergeWorkspace(workspaceId: string): Promise<AgentWorkspace> {
    const w = this.workspaceRow(workspaceId)
    const run = this.run(w.runId)
    if (w.kind !== 'worktree' || !w.branch) throw new OrbitError('validation', 'Rien à fusionner : ce compagnon travaillait dans le dossier partagé.')
    if (w.status !== 'ready' && w.status !== 'conflict') throw new OrbitError('conflict', 'Cet espace de travail n’est pas prêt à être fusionné.')
    const repo = await repoRoot(run.workspace!)
    if (!repo) throw new OrbitError('validation', 'Dépôt Git introuvable.')
    const res = await mergeBranch(repo, w.branch)
    this.journal.audit({ actor: 'user', agentId: w.agentId, action: 'workspace.merge', target: w.branch, allowed: res.ok, reason: res.ok ? null : res.reason })
    if (!res.ok) {
      this.db.update(agentWorkspaces).set({ status: 'conflict' }).where(eq(agentWorkspaces.id, w.id)).run()
      this.bus.invalidate('constellations')
      throw new OrbitError('conflict', res.reason)
    }
    await removeWorktree(repo, w.path, w.branch, false)
    this.db.update(agentWorkspaces).set({ status: 'merged' }).where(eq(agentWorkspaces.id, w.id)).run()
    await this.refreshConflicts(w.runId)
    this.bus.invalidate('constellations')
    return this.toWorkspace(this.workspaceRow(workspaceId))
  }

  async discardWorkspace(workspaceId: string): Promise<AgentWorkspace> {
    const w = this.workspaceRow(workspaceId)
    if (w.kind === 'worktree') {
      const repo = await repoRoot(this.run(w.runId).workspace ?? w.path)
      if (repo) await removeWorktree(repo, w.path, w.branch, true)
    }
    this.db.update(agentWorkspaces).set({ status: 'discarded' }).where(eq(agentWorkspaces.id, w.id)).run()
    await this.refreshConflicts(w.runId)
    this.bus.invalidate('constellations')
    return this.toWorkspace(this.workspaceRow(workspaceId))
  }

  private workspaceRow(id: string) {
    const w = this.db.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, id)).get()
    if (!w) throw new OrbitError('not_found', 'Espace de travail introuvable.')
    return w
  }

  /** Pairwise conflict detection between proposals still pending (no checkout touched). */
  private async refreshConflicts(runId: string) {
    const ws = this.db.select().from(agentWorkspaces).where(and(eq(agentWorkspaces.runId, runId), eq(agentWorkspaces.kind, 'worktree'))).all().filter((w) => w.status === 'ready' || w.status === 'conflict')
    const run = this.run(runId)
    const repo = run.workspace ? await repoRoot(run.workspace) : null
    if (!repo) return
    for (const w of ws) {
      const conflicts: string[] = []
      for (const o of ws) if (o.id !== w.id && w.branch && o.branch && (await conflictsBetween(repo, w.branch, o.branch).catch(() => false))) conflicts.push(o.agentId)
      const head = await headRef(repo)
      const stale = head && w.branch ? await conflictsBetween(repo, head, w.branch).catch(() => false) : false
      this.db.update(agentWorkspaces).set({ conflictWith: conflicts, status: conflicts.length || stale ? 'conflict' : 'ready', diffStat: w.branch && w.baseRef ? await diffStat(repo, w.baseRef, w.branch).catch(() => w.diffStat) : w.diffStat }).where(eq(agentWorkspaces.id, w.id)).run()
    }
  }

  // The drive loop

  private spawnDrive(runId: string, resuming = false) {
    const state: RunState = { controller: new AbortController(), timer: null, writerLocks: new Map() }
    this.active.set(runId, state)
    const run = this.run(runId)
    const elapsedMs = run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : 0
    const leftMs = Math.max(5_000, run.limits.maxDurationMin * 60_000 - (resuming ? 0 : elapsedMs))
    state.timer = setTimeout(() => {
      this.event(runId, 'error', run.coordinatorAgentId, null, null)
      this.failRunning(runId, `Durée maximale atteinte (${run.limits.maxDurationMin} min) : la constellation a été arrêtée.`)
    }, leftMs)
    state.timer.unref?.()
    void this.drive(runId, state, resuming)
      .catch((err) => {
        if (!this.disposed && !state.controller.signal.aborted) this.finishRun(runId, 'failed', null, err instanceof Error ? err.message : String(err))
      })
      .catch(() => undefined)
      .finally(() => {
        if (state.timer) clearTimeout(state.timer)
        this.active.delete(runId)
        if (!this.disposed) this.bus.invalidate('constellations', 'missions')
      })
  }

  private failRunning(runId: string, reason: string) {
    const state = this.active.get(runId)
    state?.controller.abort()
    for (const t of this.tasks(runId)) {
      if (this.missions.isRunning(t.missionId)) this.missions.cancel(t.missionId)
      else this.missions.skip(t.missionId, reason)
    }
    const run = this.run(runId)
    if (run.coordinatorMissionId && this.missions.isRunning(run.coordinatorMissionId)) this.missions.cancel(run.coordinatorMissionId)
    this.finishRun(runId, 'failed', null, reason)
  }

  private async drive(runId: string, state: RunState, resuming: boolean): Promise<void> {
    const signal = state.controller.signal
    let run = this.run(runId)
    const def = this.get(run.constellationId)
    const coordinator = this.agents.get(def.coordinatorAgentId)
    const coordMember = def.members.find((m) => m.agentId === coordinator.id)!
    const origin = run.origin

    // 1. Coordinator mission (planning). It coordinates: no writes of its own.
    let coordId = run.coordinatorMissionId
    let coordText: string
    if (!coordId) {
      const brief = planningPrompt({ goal: run.goal, definition: def, agents: this.agents.list(), engines: this.engineNames(def), round: 1, limits: run.limits })
      const m = this.missions.create({
        title: `Coordination · ${run.goal.slice(0, 120)}`,
        description: brief,
        agentId: coordinator.id,
        priority: 'normal',
        startNow: false,
        workspace: def.workspace,
        constellationRunId: runId,
        depth: 0,
        permissionsOverride: { ...def.permissions, writeFiles: false },
      })
      coordId = m.id
      this.db.update(constellationRuns).set({ coordinatorMissionId: coordId, round: 1 }).where(eq(constellationRuns.id, runId)).run()
      this.missions.start(coordId, origin)
      coordText = await this.waitText(coordId, signal)
      if (signal.aborted) return
      if (this.missions.get(coordId).status !== 'done') throw new Error(`Le coordinateur ${coordinator.name} n’a pas pu planifier : ${this.missions.get(coordId).error ?? 'échec'}`)
    } else if (resuming && !this.tasks(runId).length) {
      this.missions.followUp(coordId, 'Orbit a été interrompu. Reprends la planification et termine par ton bloc orbit-plan.', origin)
      coordText = await this.waitText(coordId, signal)
      if (signal.aborted) return
      if (this.missions.get(coordId).status !== 'done') throw new Error(`Le coordinateur ${coordinator.name} n’a pas pu planifier : ${this.missions.get(coordId).error ?? 'échec'}`)
    } else {
      // Resuming mid-round: sub-missions not finished run again, results kept.
      coordText = this.missions.get(coordId).result ?? ''
      for (const t of this.tasks(runId)) if (t.status === 'failed' || t.status === 'cancelled') this.missions.reset(t.missionId)
    }
    if (signal.aborted) return

    // 2. Rounds: validate plan → run sub-missions → synthesis (→ maybe new plan).
    run = this.run(runId)
    let round = Math.max(1, run.round)
    let repaired = false
    for (;;) {
      if (signal.aborted) return
      const existing = this.tasks(runId)
      const pendingRound = existing.filter((t) => t.spec.round === round)
      let created: ConstellationTask[] = pendingRound
      if (!pendingRound.length || !resuming) {
        const v = validatePlan(coordText, { definition: def, agents: this.agents.list(), alreadyCreated: existing.length, existingKeys: existing.map((t) => t.spec.key), coordinatorCanDelegate: coordMember.canDelegate })
        if (v.errors.length) {
          if (repaired) throw new Error(`Plan refusé par Orbit : ${v.errors.join(' ')}`)
          repaired = true
          this.handoff(runId, 'synthesis', 'orbit', coordinator.id, coordId, 'Plan refusé : correction demandée', v.errors.join('\n'), 0)
          this.missions.followUp(coordId, `Orbit a refusé ton plan :\n- ${v.errors.join('\n- ')}\nCorrige-le et renvoie un bloc orbit-plan valide.`, origin)
          coordText = await this.waitText(coordId, signal)
          continue
        }
        if (v.noDelegation) {
          this.finishRun(runId, 'done', stripProtocol(coordText), null)
          return
        }
        created = await this.createTasks(runId, def, coordinator, coordId, v.tasks, round, existing)
      }
      resuming = false
      this.db.update(constellationRuns).set({ status: 'running', round }).where(eq(constellationRuns.id, runId)).run()
      this.bus.invalidate('constellations')
      await this.executeRound(runId, def, coordinator, created, state)
      if (signal.aborted) return

      // Synthesis
      this.db.update(constellationRuns).set({ status: 'synthesizing' }).where(eq(constellationRuns.id, runId)).run()
      this.bus.invalidate('constellations')
      const all = this.tasks(runId)
      const results = all.filter((t) => t.spec.round === round).map((t) => ({ key: t.spec.key, agentName: this.safeAgent(t.agentId)?.name ?? '?', status: t.status === 'done' ? 'terminée' : t.status === 'failed' ? `échec : ${t.error ?? ''}` : 'non exécutée', text: t.structured?.summary ? `${t.structured.summary}\n\n${stripProtocol(t.result ?? '')}` : stripProtocol(t.result ?? '') }))
      const canDelegateAgain = round < run.limits.maxDepth && all.length < run.limits.maxSubtasks && coordMember.canDelegate && !this.overBudget(runId).over
      const sp = synthesisPrompt({ results, round, canDelegateAgain, remaining: run.limits.maxSubtasks - all.length })
      this.handoff(runId, 'synthesis', 'orbit', coordinator.id, coordId, `Résultats du tour ${round} transmis à ${coordinator.name}`, sp.prompt, sp.redactions)
      this.event(runId, 'synthesis', null, coordinator.id, coordId)
      this.missions.followUp(coordId, sp.prompt, origin)
      coordText = await this.waitText(coordId, signal)
      if (signal.aborted) return
      if (this.missions.get(coordId).status !== 'done') throw new Error(`La synthèse de ${coordinator.name} a échoué : ${this.missions.get(coordId).error ?? 'échec'}`)
      if (!canDelegateAgain) {
        this.finishRun(runId, 'done', stripProtocol(coordText), null)
        return
      }
      const next = validatePlan(coordText, { definition: def, agents: this.agents.list(), alreadyCreated: all.length, existingKeys: all.map((t) => t.spec.key), coordinatorCanDelegate: true })
      if (next.noDelegation || (!next.tasks.length && !next.errors.length)) {
        this.finishRun(runId, 'done', stripProtocol(coordText), null)
        return
      }
      round++
      repaired = false
    }
  }

  private engineNames(def: ConstellationDefinition): Record<string, string> {
    const out: Record<string, string> = {}
    for (const m of def.members) {
      const a = this.safeAgent(m.agentId)
      if (a) out[a.id] = this.providers.adapter(a.providerId).name
    }
    return out
  }

  private async createTasks(runId: string, def: ConstellationDefinition, coordinator: Agent, coordId: string, plan: (PlanTask & { agentId: string })[], round: number, existing: ConstellationTask[]): Promise<ConstellationTask[]> {
    const keyToMission = new Map(existing.map((t) => [t.spec.key, t.missionId]))
    for (const t of plan) {
      const agent = this.agents.get(t.agentId)
      const spec: SubtaskSpec = { key: t.id, objective: t.objective, expected: t.expected, context: t.context, dependsOn: t.dependsOn, readOnly: t.readOnly, round }
      // Delegation never adds rights: companion ∩ constellation ceiling ∩ read-only flag.
      const perms = intersectPermissions(def.permissions, t.readOnly ? { ...def.permissions, writeFiles: false, runCommands: false } : null)
      const workspace = this.providers.engine(agent.providerId) ? await this.workspaceFor(runId, def, agent, perms, t, keyToMission) : null
      const m = this.missions.create({
        title: t.objective.split('\n')[0]!.slice(0, 150),
        description: t.objective,
        agentId: agent.id,
        priority: 'normal',
        startNow: false,
        workspace,
        constellationRunId: runId,
        parentMissionId: coordId,
        depth: 1,
        subtask: spec,
        permissionsOverride: perms,
      })
      keyToMission.set(t.id, m.id)
    }
    for (const t of plan) for (const d of t.dependsOn) this.db.insert(missionDependencies).values({ missionId: keyToMission.get(t.id)!, dependsOnMissionId: keyToMission.get(d)! }).onConflictDoNothing().run()
    this.journal.activity({ type: 'constellation.delegated', agentId: coordinator.id, title: `${coordinator.name} a réparti ${plan.length} sous-mission${plan.length > 1 ? 's' : ''}`, detail: plan.map((t) => `${t.id} → ${this.safeAgent(t.agentId)?.name}`).join(', ') })
    this.bus.invalidate('constellations', 'missions')
    return this.tasks(runId).filter((t) => t.spec.round === round)
  }

  /** Worktree per writer agent when requested and possible; otherwise the shared folder. */
  private async workspaceFor(runId: string, def: ConstellationDefinition, agent: Agent, perms: AgentPermissions, t: PlanTask, keyToMission: Map<string, string>): Promise<string | null> {
    const base = def.workspace ?? agent.workingDirectory
    if (!base) return null
    const writer = (perms.writeFiles || perms.runCommands) && !t.readOnly && agent.permissions.writeFiles
    if (def.workspaceMode !== 'worktrees' || !writer) return base
    const existing = this.db.select().from(agentWorkspaces).where(and(eq(agentWorkspaces.runId, runId), eq(agentWorkspaces.agentId, agent.id))).get()
    if (existing) return existing.path
    const repo = await repoRoot(base)
    const head = repo ? await headRef(repo) : null
    if (!repo || !head) {
      this.db.insert(agentWorkspaces).values({ id: newId(), runId, agentId: agent.id, path: base, kind: 'shared', status: 'active', createdAt: nowIso() }).onConflictDoNothing().run()
      return base
    }
    // Build on a dependency's branch when it produced files, otherwise on HEAD.
    let baseRef = head
    for (const d of t.dependsOn) {
      const depMission = keyToMission.get(d)
      const depAgent = depMission ? this.db.select({ a: missions.agentId }).from(missions).where(eq(missions.id, depMission)).get()?.a : null
      const depWs = depAgent ? this.db.select().from(agentWorkspaces).where(and(eq(agentWorkspaces.runId, runId), eq(agentWorkspaces.agentId, depAgent))).get() : null
      if (depWs?.branch) baseRef = depWs.branch
    }
    const branch = `orbit/${runId.slice(0, 8)}/${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const path = join(this.worktreeRoot, runId, agent.id)
    await addWorktree(repo, path, branch, baseRef)
    this.db.insert(agentWorkspaces).values({ id: newId(), runId, agentId: agent.id, path, kind: 'worktree', branch, baseRef: head, status: 'active', createdAt: nowIso() }).run()
    return path
  }

  private async executeRound(runId: string, def: ConstellationDefinition, coordinator: Agent, tasks: ConstellationTask[], state: RunState): Promise<void> {
    const signal = state.controller.signal
    const run = this.run(runId)
    const running = new Map<string, Promise<void>>()
    const terminal = (s: Mission['status']) => TERMINAL_MISSION_STATUSES.includes(s)
    const statusOf = (id: string) => this.missions.get(id).status
    let budgetNote = false
    for (;;) {
      if (signal.aborted) break
      const fresh = this.tasks(runId).filter((t) => tasks.some((x) => x.missionId === t.missionId))
      const todo = fresh.filter((t) => t.status === 'todo' && !running.has(t.missionId))
      if (!todo.length && !running.size) break
      for (const t of todo) {
        const deps = t.dependsOnMissionIds.map((d) => statusOf(d))
        if (deps.some((s) => s === 'failed' || s === 'cancelled')) {
          this.missions.skip(t.missionId, 'Une dépendance a échoué ou n’a pas été exécutée.')
          continue
        }
        if (!deps.every((s) => s === 'done')) continue
        if (running.size >= run.limits.maxParallel) break
        const limit = this.overBudget(runId, running.size + 1)
        if (limit.over) {
          if (running.size) break // wait for the reservations to settle
          if (!budgetNote) this.handoff(runId, 'synthesis', 'orbit', coordinator.id, null, 'Limite atteinte', limit.reason!, 0)
          budgetNote = true
          this.missions.skip(t.missionId, limit.reason!)
          continue
        }
        // Shared folder: one writer at a time (readers run in parallel).
        const writer = (t.permissions.writeFiles || t.permissions.runCommands) && !t.spec.readOnly && t.workspace
        if (writer && def.workspaceMode === 'shared' && state.writerLocks.has(t.workspace!)) continue
        if (writer && t.workspace) state.writerLocks.set(t.workspace, t.missionId)
        running.set(
          t.missionId,
          this.runTask(runId, coordinator, t, signal).finally(() => {
            running.delete(t.missionId)
            if (writer && t.workspace && state.writerLocks.get(t.workspace) === t.missionId) state.writerLocks.delete(t.workspace)
          }),
        )
      }
      if (running.size) await Promise.race(running.values())
      else if (!this.tasks(runId).some((t) => tasks.some((x) => x.missionId === t.missionId) && t.status === 'todo')) break
      else {
        // Everything left is blocked (writer lock held by a finished task, deps unresolved): avoid a busy loop.
        await new Promise((r) => setTimeout(r, 50))
        if (this.tasks(runId).filter((t) => tasks.some((x) => x.missionId === t.missionId)).every((t) => terminal(t.status) || t.status === 'todo') && !running.size) {
          const stuck = this.tasks(runId).filter((t) => tasks.some((x) => x.missionId === t.missionId) && t.status === 'todo' && t.dependsOnMissionIds.some((d) => !terminal(statusOf(d))))
          if (!stuck.length) continue
          for (const s of stuck) this.missions.skip(s.missionId, 'Dépendance non résolue.')
        }
      }
    }
    await Promise.allSettled(running.values())
    await this.refreshConflicts(runId)
  }

  private async runTask(runId: string, coordinator: Agent, t: ConstellationTask, signal: AbortSignal): Promise<void> {
    const agent = this.agents.get(t.agentId)
    const all = this.tasks(runId)
    const deps = all.filter((x) => t.dependsOnMissionIds.includes(x.missionId)).map((x) => ({ key: x.spec.key, agentName: this.safeAgent(x.agentId)?.name ?? '?', text: x.structured?.summary ? `${x.structured.summary}\n\n${stripProtocol(x.result ?? '')}` : stripProtocol(x.result ?? '') }))
    const h = handoffPrompt({ goal: this.run(runId).goal, spec: t.spec, coordinatorName: coordinator.name, dependencyResults: deps, workspace: t.workspace, permissions: t.permissions })
    this.db.update(missions).set({ description: h.prompt, updatedAt: nowIso() }).where(eq(missions.id, t.missionId)).run()
    this.handoff(runId, 'delegation', coordinator.id, agent.id, t.missionId, `${coordinator.name} → ${agent.name} : ${t.spec.objective.slice(0, 140)}`, h.prompt, h.redactions)
    this.event(runId, 'delegation', coordinator.id, agent.id, t.missionId)
    try {
      this.missions.start(t.missionId, this.run(runId).origin)
    } catch (err) {
      this.db.update(missions).set({ status: 'failed', error: err instanceof Error ? err.message : String(err), finishedAt: nowIso() }).where(eq(missions.id, t.missionId)).run()
      this.event(runId, 'error', agent.id, coordinator.id, t.missionId)
      this.bus.invalidate('missions', 'constellations')
      return
    }
    const text = await this.waitText(t.missionId, signal)
    const m = this.missions.get(t.missionId)
    if (m.status === 'done') {
      const structured = parseResult(text)
      this.missions.setResultData(t.missionId, structured)
      const ws = this.db.select().from(agentWorkspaces).where(and(eq(agentWorkspaces.runId, runId), eq(agentWorkspaces.agentId, agent.id))).get()
      if (ws?.kind === 'worktree') {
        await commitAll(ws.path, `Orbit · ${agent.name} · ${t.spec.key}`).catch(() => false)
        this.db.update(agentWorkspaces).set({ status: 'ready' }).where(eq(agentWorkspaces.id, ws.id)).run()
      }
      this.handoff(runId, 'result', agent.id, coordinator.id, t.missionId, `${agent.name} → ${coordinator.name} : ${structured?.summary.slice(0, 140) ?? 'résultat transmis'}`, stripProtocol(text).slice(0, 20_000), 0)
      this.event(runId, 'result', agent.id, coordinator.id, t.missionId)
    } else {
      this.event(runId, 'error', agent.id, coordinator.id, t.missionId)
    }
    this.bus.invalidate('constellations')
  }

  /**
   * Budget and token limits, counting what is already spent *and* a reservation for runs
   * in flight (average cost of finished sub-missions, or an even share of the budget).
   */
  private overBudget(runId: string, inFlight = 0): { over: boolean; reason: string | null } {
    const run = this.run(runId)
    const t = this.totals(runId)
    if (run.limits.maxTokens != null && t.tokens >= run.limits.maxTokens) return { over: true, reason: `Limite de jetons atteinte (${t.tokens.toLocaleString('fr-FR')} / ${run.limits.maxTokens.toLocaleString('fr-FR')}).` }
    if (run.limits.maxBudgetUsd != null && t.costUsd != null) {
      const finished = this.tasks(runId).filter((x) => x.costUsd != null && TERMINAL_MISSION_STATUSES.includes(x.status))
      const reservation = finished.length ? finished.reduce((s, x) => s + (x.costUsd ?? 0), 0) / finished.length : run.limits.maxBudgetUsd / Math.max(1, run.limits.maxSubtasks)
      if (t.costUsd + reservation * inFlight > run.limits.maxBudgetUsd) return { over: true, reason: `Budget de la constellation atteint (${t.costUsd.toFixed(2)} $ dépensés, ${(reservation * inFlight).toFixed(2)} $ réservés, limite ${run.limits.maxBudgetUsd.toFixed(2)} $).` }
    }
    return { over: false, reason: null }
  }

  /** Waits for a mission to settle (handles start approvals) and returns its final text. */
  private async waitText(missionId: string, signal: AbortSignal): Promise<string> {
    for (;;) {
      if (signal.aborted) return ''
      let m: Mission
      try {
        m = await this.missions.awaitIdle(missionId)
      } catch {
        return ''
      }
      if (m.status === 'approval_required' || (m.status === 'running' && !this.missions.isRunning(missionId))) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      if (this.missions.isRunning(missionId)) continue
      return m.result ?? ''
    }
  }

  private finishRun(runId: string, status: ConstellationRunStatus, synthesis: string | null, error: string | null) {
    const run = this.run(runId)
    if (['done', 'failed', 'cancelled'].includes(run.status) && status !== 'cancelled') return
    this.db.update(constellationRuns).set({ status, synthesis: synthesis ?? run.synthesis, error, finishedAt: nowIso() }).where(eq(constellationRuns.id, runId)).run()
    this.event(runId, status === 'done' ? 'status' : 'error', null, null, null)
    const route = `/constellations/runs/${runId}`
    if (status === 'done') {
      this.journal.activity({ type: 'constellation.completed', level: 'success', agentId: run.coordinatorAgentId, title: `« ${run.constellationName} » a terminé`, detail: run.goal.slice(0, 200) })
      this.journal.notify('mission_done', `Constellation terminée · ${run.constellationName}`, (synthesis ?? '').slice(0, 140) || run.goal.slice(0, 140), route)
    } else if (status === 'failed') {
      this.journal.activity({ type: 'constellation.failed', level: 'error', agentId: run.coordinatorAgentId, title: `« ${run.constellationName} » a échoué`, detail: error })
      this.journal.notify('mission_failed', `Constellation en échec · ${run.constellationName}`, error ?? '', route)
    } else if (status === 'cancelled') this.journal.activity({ type: 'constellation.cancelled', agentId: run.coordinatorAgentId, title: `« ${run.constellationName} » arrêtée`, detail: error })
    this.bus.invalidate('constellations', 'missions')
  }

  private handoff(runId: string, kind: ExecutionHandoff['kind'], from: string, to: string, missionId: string | null, summary: string, payload: string, redactions: number) {
    this.db.insert(executionHandoffs).values({ id: newId(), runId, kind, fromAgentId: from, toAgentId: to, missionId, summary, payload, redactions, createdAt: nowIso() }).run()
  }

  /** A real event, pushed to the UI: the light pulse travels only when this fires. */
  private event(runId: string, kind: ConstellationSignal['kind'], fromAgentId: string | null, toAgentId: string | null, missionId: string | null) {
    this.bus.emit({ type: 'constellation.signal', signal: { runId, kind, fromAgentId, toAgentId, missionId, at: nowIso() } })
    this.bus.invalidate('constellations')
  }
}
