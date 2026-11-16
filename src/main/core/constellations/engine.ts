import { join } from 'node:path'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { TERMINAL_MISSION_STATUSES } from '@shared/mission-states'
import { ACTIVE_RUN_STATUSES, normalizeRunStatus, TERMINAL_RUN_STATUSES } from '@shared/constellation-states'
import type {
  Agent,
  AgentPermissions,
  AgentWorkspace,
  ConstellationDefinition,
  ConstellationLimits,
  ConstellationMember,
  ConstellationPlan,
  ConstellationRun,
  ConstellationRunAction,
  ConstellationRunDetail,
  ConstellationRunEvent,
  ConstellationRunStatus,
  ConstellationSignal,
  ConstellationTask,
  ExecutionHandoff,
  Mission,
  PlanApprovalPolicy,
  PlanTaskRecord,
  SubtaskSpec,
} from '@shared/types'
import type { OrbitDb } from '../../infra/db/client'
import {
  agentWorkspaces,
  constellationDefinitions,
  constellationMembers,
  constellationPlans,
  constellationRunEvents,
  constellationRuns,
  executionHandoffs,
  fileChanges,
  missionDependencies,
  missionExecutions,
  missions,
} from '../../infra/db/schema'
import type { AgentManager } from '../agents'
import type { EventBus } from '../event-bus'
import type { Journal } from '../journal'
import { intersectPermissions, type MissionManager, type MissionSettled } from '../missions'
import type { ProviderRegistry } from '../providers'
import { newId, nowIso, OrbitError } from '../util'
import { continuationPrompt, diffPlans, handoffPrompt, parseResult, planHash, planningPrompt, sameWork, scopesOverlap, stripProtocol, synthesisPrompt, validatePlan, type PlanValidation } from './protocol'
import { addWorktree, branchDiff, commitAll, conflictsBetween, diffStat, headRef, mergeBranch, removeWorktree, repoRoot } from './worktrees'

/** Orbit Desktop: runs whose companions all live on one runtime are coordinated there. */
export interface ConstellationRemote {
  launch(def: ConstellationDefinition, run: ConstellationRun, goal: string, origin: 'user' | 'automation'): void
  cancel(run: ConstellationRun): void
}

export const DEFAULT_LIMITS: ConstellationLimits = { maxDepth: 2, maxSubtasks: 8, maxParallel: 2, maxDurationMin: 60, maxTokens: 2_000_000, maxBudgetUsd: 5 }
/** Bounds the user can raise limits to (same as the definition form). */
const LIMIT_BOUNDS = { maxDepth: [1, 5], maxSubtasks: [1, 50], maxParallel: [1, 8], maxDurationMin: [1, 24 * 60] } as const

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
  planApproval?: PlanApprovalPolicy
}

/** A task as the user edits it in « Modifier le plan ». */
export interface PlanTaskInput {
  id: string
  assignee: string
  objective: string
  expected?: string
  context?: string
  dependsOn?: string[]
  readOnly?: boolean
  writes?: string[]
}

interface RunState {
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  /** Writers running in a shared folder: mission id → folder and write scopes (empty → the whole folder). */
  writerLocks: Map<string, { workspace: string; writes: string[] }>
  /** When this drive started (active time accounting). */
  since: number
  /** Set while the loop itself is talking to the coordinator. */
  coordinatorTurn: boolean
}

/** What the drive loop does next. Everything it needs is persisted: a step can always be rebuilt. */
type Step =
  | { kind: 'coordinator'; prompt: string | null; phase: 'planning' | 'synthesizing'; repaired?: boolean; canDelegate?: boolean }
  | { kind: 'execute' }
  | { kind: 'synthesize' }
  | { kind: 'stop' }

/** Appended to the error of a failed sub-mission the user chose to go on without. */
const SKIPPED_MARK = 'ignorée sur votre décision'

const BLOCKING_ERRORS = /Trop de sous-missions|Profondeur maximale|Aucune nouvelle délégation/

/**
 * Orchestrates a constellation. The **run** owns the lifecycle (planning → awaiting_approval →
 * ready → running → synthesizing → completed, with paused / blocked / failed / cancelled):
 * the coordinator is a participant whose replies Orbit reads - the end of one of its replies
 * never completes the run by itself.
 *
 * Every member keeps its own engine, model, permissions and memory: sub-missions are
 * ordinary missions of that companion, so all existing guarantees (tool policy,
 * approvals, file inventory, usage) apply unchanged. Delegation can only lower
 * permissions (companion ∩ constellation ceiling ∩ read-only flag).
 *
 * Durable state: plans (versioned, hashed), decisions and important events, sub-missions and
 * their dependencies, handoffs. Every transition is a compare-and-set on the run's status, and
 * every coordinator reply is ingested at most once (by execution id), so a double click, a
 * resume or a re-sent plan never starts the same work twice.
 */
export class ConstellationEngine {
  private active = new Map<string, RunState>()
  remote: ConstellationRemote | null = null
  /** Set on shutdown: drive loops still unwinding must not write to the closed database. */
  private disposed = false
  /** Last settled execution of each coordinator mission, with its own text. */
  private lastSettled = new Map<string, MissionSettled>()

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private agents: AgentManager,
    private missions: MissionManager,
    private providers: ProviderRegistry,
    private worktreeRoot: string,
  ) {
    missions.onSettled((e) => this.onMissionSettled(e))
    missions.followUpGuard = (m) => this.guardCoordinatorChat(m)
  }

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
      tx.insert(constellationDefinitions).values({ id, name: input.name, description: input.description, objective: input.objective, coordinatorAgentId: input.coordinatorAgentId, workspace: input.workspace, workspaceMode: input.workspaceMode, permissions: input.permissions, limits: input.limits, isTemplate: input.isTemplate, planApproval: input.planApproval ?? 'auto', createdAt: ts, updatedAt: ts }).run()
      input.members.forEach((m, i) => tx.insert(constellationMembers).values({ constellationId: id, agentId: m.agentId, role: m.role, responsibilities: m.responsibilities, canDelegate: m.canDelegate, sortOrder: i }).run())
    })
    this.journal.activity({ type: 'constellation.created', level: 'success', agentId: input.coordinatorAgentId, title: `Constellation « ${input.name} » créée`, detail: `${input.members.length} compagnons` })
    this.journal.audit({ actor: 'user', agentId: null, action: 'constellation.create', target: input.name, allowed: true, reason: null })
    this.bus.invalidate('constellations')
    return this.get(id)
  }

  update(id: string, input: ConstellationInput): ConstellationDefinition {
    const prev = this.get(id)
    this.validateDefinition(input)
    this.db.transaction((tx) => {
      tx.update(constellationDefinitions).set({ name: input.name, description: input.description, objective: input.objective, coordinatorAgentId: input.coordinatorAgentId, workspace: input.workspace, workspaceMode: input.workspaceMode, permissions: input.permissions, limits: input.limits, isTemplate: input.isTemplate, planApproval: input.planApproval ?? prev.planApproval, updatedAt: nowIso() }).where(eq(constellationDefinitions.id, id)).run()
      tx.delete(constellationMembers).where(eq(constellationMembers.constellationId, id)).run()
      input.members.forEach((m, i) => tx.insert(constellationMembers).values({ constellationId: id, agentId: m.agentId, role: m.role, responsibilities: m.responsibilities, canDelegate: m.canDelegate, sortOrder: i }).run())
    })
    this.bus.invalidate('constellations')
    return this.get(id)
  }

  delete(id: string): void {
    const open = this.db.select({ id: constellationRuns.id, status: constellationRuns.status }).from(constellationRuns).where(eq(constellationRuns.constellationId, id)).all()
    if (open.some((r) => ACTIVE_RUN_STATUSES.includes(normalizeRunStatus(r.status)) || this.active.has(r.id))) throw new OrbitError('conflict', 'Arrêtez d’abord l’exécution en cours de cette constellation.')
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
    this.checkLimits(input.limits)
  }

  private checkLimits(l: ConstellationLimits) {
    for (const [k, [lo, hi]] of Object.entries(LIMIT_BOUNDS) as [keyof typeof LIMIT_BOUNDS, readonly [number, number]][]) {
      if (!Number.isInteger(l[k]) || l[k] < lo || l[k] > hi) throw new OrbitError('validation', 'Limites hors des bornes autorisées.')
    }
    if (l.maxTokens != null && (l.maxTokens < 1000 || l.maxTokens > 100_000_000)) throw new OrbitError('validation', 'Limite de jetons hors des bornes autorisées.')
    if (l.maxBudgetUsd != null && (l.maxBudgetUsd < 0 || l.maxBudgetUsd > 10_000)) throw new OrbitError('validation', 'Budget hors des bornes autorisées.')
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
      planApproval: r.planApproval === 'writes' || r.planApproval === 'always' ? r.planApproval : 'auto',
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
    return this.toRun(this.runRow(id))
  }

  private runRow(id: string) {
    const r = this.db.select().from(constellationRuns).where(eq(constellationRuns.id, id)).get()
    if (!r) throw new OrbitError('not_found', 'Exécution introuvable.')
    return r
  }

  /** Runs that still need something (to find unfinished work after reopening Orbit). */
  unfinished(): ConstellationRun[] {
    return this.runs(undefined, 200).filter((r) => !TERMINAL_RUN_STATUSES.includes(r.status))
  }

  detail(id: string): ConstellationRunDetail {
    const run = this.run(id)
    let definition: ConstellationDefinition | null
    try {
      definition = this.get(run.constellationId)
    } catch {
      definition = null
    }
    const tasks = this.tasks(id)
    const plans = this.plans(id)
    const pendingPlan = plans.filter((p) => p.status === 'proposed').at(-1) ?? null
    const driving = this.active.has(id)
    const retryable = this.retryable(id, tasks)
    const blockedTasks = tasks.filter((t) => t.status === 'todo' && t.dependsOnMissionIds.some((d) => ['failed', 'cancelled'].includes(tasks.find((x) => x.missionId === d)?.status ?? '')))
    return {
      run,
      definition,
      tasks,
      handoffs: this.db.select().from(executionHandoffs).where(eq(executionHandoffs.runId, id)).orderBy(asc(executionHandoffs.createdAt)).all().map((h) => ({ ...h, kind: h.kind as ExecutionHandoff['kind'] })),
      workspaces: this.db.select().from(agentWorkspaces).where(eq(agentWorkspaces.runId, id)).all().map((w) => this.toWorkspace(w)),
      plans,
      events: this.events(id),
      pendingPlan,
      actions: this.availableActions(run, pendingPlan, driving, retryable.length),
      driving,
      progress: {
        total: tasks.length,
        done: tasks.filter((t) => t.status === 'done').length,
        running: tasks.filter((t) => t.status === 'running' || t.status === 'waiting').length,
        remaining: tasks.filter((t) => !TERMINAL_MISSION_STATUSES.includes(t.status)).length,
        failed: tasks.filter((t) => t.status === 'failed').length,
        blocked: blockedTasks.length,
        awaitingApproval: tasks.filter((t) => t.status === 'approval_required').length + (pendingPlan ? 1 : 0),
      },
      retryable,
    }
  }

  private availableActions(run: ConstellationRun, pending: ConstellationPlan | null, driving: boolean, retryable: number): ConstellationRunAction[] {
    const s = run.status
    const out: ConstellationRunAction[] = []
    if (!TERMINAL_RUN_STATUSES.includes(s)) out.push('cancel')
    // Runs coordinated by a runtime are driven there: only cancellation is relayed for now.
    if (run.machineId && this.remote) return out
    if (driving && ACTIVE_RUN_STATUSES.includes(s)) out.push('pause')
    if (driving) return out
    const waiting = ['paused', 'blocked', 'failed'].includes(s)
    if (s === 'awaiting_approval' && pending) {
      if (pending.tasks.length && !pending.errors.length) out.push('approve', 'reject')
      out.push('answer')
    }
    if (pending?.errors.length || s === 'blocked') out.push('raise_limits')
    if (waiting && !pending) out.push('resume')
    if ((waiting || s === 'awaiting_approval') && retryable) out.push('retry')
    if ((waiting || s === 'awaiting_approval') && this.plans(run.id).some((p) => p.tasks.length && ['approved', 'proposed'].includes(p.status))) out.push('edit_plan')
    if ((s === 'completed' || waiting) && run.coordinatorMissionId) out.push('continue')
    // A run left « active » by a crash without a drive loop (should not happen after boot): resumable.
    if (ACTIVE_RUN_STATUSES.includes(s)) out.push('resume')
    return [...new Set(out)]
  }

  plans(runId: string): ConstellationPlan[] {
    const rows = this.db.select().from(constellationPlans).where(eq(constellationPlans.runId, runId)).orderBy(asc(constellationPlans.version)).all()
    const done = new Set(this.tasks(runId).filter((t) => t.status === 'done').map((t) => t.spec.key))
    let lastApproved: PlanTaskRecord[] | null = null
    return rows.map((r) => {
      const plan: ConstellationPlan = {
        id: r.id,
        runId: r.runId,
        version: r.version,
        round: r.round,
        status: r.status as ConstellationPlan['status'],
        hash: r.hash,
        tasks: r.tasks,
        questions: r.questions,
        note: r.note,
        errors: r.errors,
        source: r.source as ConstellationPlan['source'],
        sourceExecutionId: r.sourceExecutionId,
        approvalReason: r.approvalReason,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        decidedBy: r.decidedBy,
        diff: r.tasks.length && lastApproved ? diffPlans(lastApproved, r.tasks, done) : null,
      }
      if (r.status === 'approved' && r.tasks.length) lastApproved = r.tasks
      return plan
    })
  }

  events(runId: string): ConstellationRunEvent[] {
    return this.db
      .select()
      .from(constellationRunEvents)
      .where(eq(constellationRunEvents.runId, runId))
      .orderBy(asc(constellationRunEvents.createdAt))
      .all()
      .map((e) => ({ id: e.id, runId: e.runId, kind: e.kind, level: e.level as ConstellationRunEvent['level'], message: e.message, data: e.data ?? null, actor: e.actor, createdAt: e.createdAt }))
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

  /** Failed or interrupted tasks, with what they already did (checked before any retry). */
  private retryable(runId: string, tasks = this.tasks(runId)) {
    const inPlan = this.inActivePlan(runId)
    return tasks
      .filter((t) => inPlan(t) && (t.status === 'failed' || (t.status === 'cancelled' && this.missions.executionCount(t.missionId) > 0)))
      .map((t) => ({
        missionId: t.missionId,
        key: t.spec.key,
        executions: this.missions.executionCount(t.missionId),
        fileChanges: this.db.select({ id: fileChanges.id }).from(fileChanges).where(eq(fileChanges.missionId, t.missionId)).all().length,
        canWrite: !t.spec.readOnly && (t.permissions.writeFiles || t.permissions.runCommands),
        interrupted: t.status === 'cancelled' || (t.error ?? '').startsWith('Interrompue'),
      }))
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
      status: normalizeRunStatus(r.status),
      coordinatorAgentId: r.coordinatorAgentId,
      coordinatorMissionId: r.coordinatorMissionId,
      round: r.round,
      workspace: r.workspace,
      limits: { ...DEFAULT_LIMITS, ...r.limits },
      synthesis: r.synthesis,
      error: r.error,
      tokens: t.tokens,
      costUsd: t.costUsd,
      origin: r.origin === 'automation' ? 'automation' : 'user',
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      machineId: r.machineId ?? null,
      phase: r.phase ?? null,
      activeMs: r.activeMs ?? 0,
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

  isActive(runId: string): boolean {
    return this.active.has(runId)
  }

  // Lifecycle primitives

  /**
   * Compare-and-set on the run's status. Synchronous read + write (better-sqlite3 / node:sqlite
   * are synchronous and JS is single-threaded): two concurrent commands can never both win.
   */
  private transition(runId: string, from: ConstellationRunStatus[] | null, to: ConstellationRunStatus, extra: Partial<typeof constellationRuns.$inferInsert> = {}): boolean {
    const row = this.runRow(runId)
    const current = normalizeRunStatus(row.status)
    if (from && !from.includes(current)) return false
    this.db.update(constellationRuns).set({ status: to, version: (row.version ?? 0) + 1, ...extra }).where(eq(constellationRuns.id, runId)).run()
    if (current !== to) this.event(runId, 'status', null, null, null)
    this.bus.invalidate('constellations')
    return true
  }

  private requireStatus(runId: string, allowed: ConstellationRunStatus[], what: string): ConstellationRun {
    const run = this.run(runId)
    if (run.machineId && this.remote) throw new OrbitError('validation', 'Cette constellation est coordonnée par un serveur : cette action n’est pas encore disponible à distance. Vous pouvez l’annuler puis la relancer.')
    if (!allowed.includes(run.status)) throw new OrbitError('conflict', `${what} impossible : la constellation est « ${run.status} ».`)
    return run
  }

  /** Important event (decisions included). With a key, recorded at most once: false if already there. */
  private log(runId: string, kind: string, level: ConstellationRunEvent['level'], message: string, o: { data?: Record<string, unknown>; actor?: string; key?: string } = {}): boolean {
    if (o.key && this.db.select({ id: constellationRunEvents.id }).from(constellationRunEvents).where(eq(constellationRunEvents.idempotencyKey, o.key)).get()) return false
    this.db.insert(constellationRunEvents).values({ id: newId(), runId, kind, level, message, data: o.data ?? null, actor: o.actor ?? 'orbit', idempotencyKey: o.key ?? null, createdAt: nowIso() }).run()
    this.bus.invalidate('constellations')
    return true
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
      .values({ id, constellationId, goal, status: 'planning', phase: 'planning', coordinatorAgentId: def.coordinatorAgentId, workspace: def.workspace, limits: def.limits, origin: opts.origin ?? 'user', idempotencyKey: opts.idempotencyKey ?? null, createdAt: nowIso(), startedAt: nowIso(), machineId })
      .run()
    if (machineId) {
      // Coordinated by the runtime: this row is the copy it will keep up to date.
      this.remote!.launch(def, this.run(id), goal, opts.origin ?? 'user')
      this.bus.invalidate('constellations')
      return this.run(id)
    }
    this.log(id, 'run.started', 'info', `Mission collective lancée : ${coordinator.name} planifie.`, { actor: opts.origin ?? 'user' })
    this.journal.activity({ type: 'constellation.started', agentId: coordinator.id, title: `Constellation « ${def.name} » en route`, detail: goal.slice(0, 200) })
    this.bus.invalidate('constellations', 'missions')
    this.spawnDrive(id, { kind: 'coordinator', prompt: null, phase: 'planning' })
    return this.run(id)
  }

  cancel(runId: string): ConstellationRun {
    const run = this.run(runId)
    if (run.machineId && this.remote) {
      this.remote.cancel(run)
      return run
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return run
    const state = this.active.get(runId)
    if (state) state.controller.abort()
    for (const t of this.tasks(runId)) {
      if (this.missions.isRunning(t.missionId)) this.missions.cancel(t.missionId)
      else this.missions.skip(t.missionId, 'Constellation annulée.')
    }
    if (run.coordinatorMissionId && this.missions.isRunning(run.coordinatorMissionId)) this.missions.cancel(run.coordinatorMissionId)
    for (const p of this.plans(runId)) if (p.status === 'proposed') this.db.update(constellationPlans).set({ status: 'rejected', decidedAt: nowIso(), decidedBy: 'user' }).where(eq(constellationPlans.id, p.id)).run()
    this.log(runId, 'decision.cancel', 'warning', 'Mission collective annulée par vous. L’historique et les résultats obtenus sont conservés.', { actor: 'user' })
    this.finishRun(runId, 'cancelled', null, 'Annulée par l’utilisateur.')
    return this.run(runId)
  }

  /** Stops scheduling new sub-missions. Those already running finish normally. */
  pause(runId: string): ConstellationRun {
    this.requireStatus(runId, ACTIVE_RUN_STATUSES, 'Mettre en pause')
    if (!this.transition(runId, ACTIVE_RUN_STATUSES, 'paused', { error: null })) throw new OrbitError('conflict', 'La constellation a changé d’état entre-temps.')
    const running = this.tasks(runId).filter((t) => this.missions.isRunning(t.missionId)).length
    this.log(runId, 'decision.pause', 'info', running ? `Pause demandée : aucune nouvelle sous-mission ne démarre ; ${running} en cours se termine${running > 1 ? 'nt' : ''} normalement.` : 'Pause : aucune nouvelle sous-mission ne démarre.', { actor: 'user' })
    return this.run(runId)
  }

  /**
   * Continues a paused, blocked or failed run where it stopped. Finished sub-missions keep
   * their results and never run again; failed or interrupted ones are only re-run through
   * `retryTasks` (explicit selection), or skipped with `skipFailed`.
   */
  resume(runId: string, opts: { skipFailed?: boolean } = {}): ConstellationRun {
    const run = this.requireStatus(runId, ['paused', 'blocked', 'failed', ...ACTIVE_RUN_STATUSES], 'Reprendre')
    if (this.active.has(runId)) throw new OrbitError('conflict', 'Cette constellation est déjà en cours.')
    const pending = this.plans(runId).filter((p) => p.status === 'proposed').at(-1)
    if (pending && !pending.errors.length) {
      this.transition(runId, null, 'awaiting_approval', { error: null })
      this.log(runId, 'approval.pending', 'warning', `Le plan v${pending.version} attend toujours votre validation.`)
      return this.run(runId)
    }
    if (pending?.errors.length) throw new OrbitError('conflict', `Le plan v${pending.version} dépasse les limites de cette exécution : relevez-les ou modifiez le plan.`)
    if (opts.skipFailed) this.skipFailed(runId)
    const step = this.stepFor(runId)
    if (step.kind === 'stop') {
      const blocked = this.blockedReason(runId)
      if (blocked) {
        this.transition(runId, null, 'blocked', { error: blocked })
        return this.run(runId)
      }
    }
    if (!this.transition(runId, ['paused', 'blocked', 'failed', ...ACTIVE_RUN_STATUSES], step.kind === 'coordinator' ? (step.phase === 'planning' ? 'planning' : 'synthesizing') : 'running', { error: null, finishedAt: null })) throw new OrbitError('conflict', 'La constellation a changé d’état entre-temps.')
    this.log(runId, 'decision.resume', 'info', opts.skipFailed ? 'Reprise sans les sous-missions en échec (votre décision).' : 'Reprise de la mission collective.', { actor: 'user' })
    this.journal.activity({ type: 'constellation.started', agentId: run.coordinatorAgentId, title: `Reprise de « ${run.constellationName} »`, detail: run.goal.slice(0, 200) })
    this.spawnDrive(runId, step)
    return this.run(runId)
  }

  /** Re-runs only the selected failed / interrupted sub-missions (and dependents that never started). */
  retryTasks(runId: string, missionIds: string[]): ConstellationRun {
    this.requireStatus(runId, ['paused', 'blocked', 'failed', 'awaiting_approval'], 'Réessayer')
    if (this.active.has(runId)) throw new OrbitError('conflict', 'Cette constellation est déjà en cours.')
    const tasks = this.tasks(runId)
    const chosen = tasks.filter((t) => missionIds.includes(t.missionId))
    if (!chosen.length || chosen.length !== new Set(missionIds).size) throw new OrbitError('validation', 'Sélectionnez des sous-missions de cette exécution.')
    for (const t of chosen) if (t.status !== 'failed' && t.status !== 'cancelled') throw new OrbitError('conflict', `« ${t.spec.key} » n’est pas en échec : elle n’est pas relancée.`)
    const inPlan = this.inActivePlan(runId)
    for (const t of chosen) if (!inPlan(t)) throw new OrbitError('validation', `« ${t.spec.key} » ne fait plus partie du plan en cours : elle n’est pas relancée. Modifiez le plan pour la reprendre.`)
    for (const t of chosen) this.missions.reset(t.missionId)
    this.resetSkippedDependents(runId, new Set(chosen.map((t) => t.missionId)))
    this.log(runId, 'decision.retry', 'info', `Nouvelle tentative demandée pour : ${chosen.map((t) => t.spec.key).join(', ')}.`, { actor: 'user', data: { missionIds } })
    const pending = this.plans(runId).some((p) => p.status === 'proposed')
    if (pending) return this.run(runId)
    this.transition(runId, null, 'running', { error: null, finishedAt: null, phase: 'executing' })
    this.spawnDrive(runId, { kind: 'execute' })
    return this.run(runId)
  }

  /**
   * The user's structured approval of one exact plan version. `hash` guards against approving
   * a plan that changed after it was displayed. Authorises *these* sub-missions only: each
   * still goes through its companion's permissions and approvals when it starts.
   */
  approvePlan(runId: string, planId: string, hash?: string): ConstellationRun {
    const plan = this.planRow(runId, planId)
    if (plan.status === 'approved' && plan.decidedBy === 'user') return this.run(runId) // double click
    this.requireStatus(runId, ['awaiting_approval', 'blocked', 'paused'], 'Approuver le plan')
    if (this.active.has(runId)) throw new OrbitError('conflict', 'Cette constellation est déjà en cours.')
    if (plan.status !== 'proposed') throw new OrbitError('conflict', `Le plan v${plan.version} n’est plus en attente (${plan.status}).`)
    if (hash && hash !== plan.hash) throw new OrbitError('conflict', 'Le plan a changé depuis son affichage : vérifiez la nouvelle version avant de l’approuver.')
    if (plan.errors.length) throw new OrbitError('validation', `Ce plan ne peut pas être approuvé : ${plan.errors.join(' ')}`)
    if (!plan.tasks.length) throw new OrbitError('validation', 'Ce plan ne contient aucune sous-mission : répondez aux questions du coordinateur.')
    const latest = this.plans(runId).filter((p) => p.status === 'proposed').at(-1)
    if (latest?.id !== planId) throw new OrbitError('conflict', 'Une version plus récente du plan attend votre validation.')
    // Re-validated now: companions, membership or permissions may have changed since.
    const v = this.revalidate(runId, plan.tasks)
    if (v.errors.length) throw new OrbitError('validation', `Plan devenu invalide : ${v.errors.join(' ')}`)
    if (!this.log(runId, 'decision.approve', 'success', `Plan v${plan.version} approuvé par vous (${plan.tasks.length} sous-missions).`, { actor: 'user', key: `approve:${planId}`, data: { planId, hash: plan.hash } })) return this.run(runId)
    this.markPlan(planId, 'approved', 'user')
    this.journal.audit({ actor: 'user', agentId: this.run(runId).coordinatorAgentId, action: 'constellation.plan.approve', target: `${runId}#v${plan.version}`, allowed: true, reason: plan.approvalReason })
    this.applyPlan(runId, this.plans(runId).find((p) => p.id === planId)!)
    this.transition(runId, null, 'ready', { error: null, finishedAt: null, phase: 'executing' })
    this.spawnDrive(runId, { kind: 'execute' })
    return this.run(runId)
  }

  /** Refuses a plan; the coordinator receives the feedback and proposes again. */
  rejectPlan(runId: string, planId: string, feedback: string): ConstellationRun {
    const plan = this.planRow(runId, planId)
    if (plan.status === 'rejected') return this.run(runId)
    const run = this.requireStatus(runId, ['awaiting_approval', 'blocked', 'paused'], 'Refuser le plan')
    if (plan.status !== 'proposed') throw new OrbitError('conflict', `Le plan v${plan.version} n’est plus en attente.`)
    if (!this.log(runId, 'decision.reject', 'info', `Plan v${plan.version} refusé${feedback ? ` : ${feedback.slice(0, 200)}` : '.'}`, { actor: 'user', key: `reject:${planId}` })) return this.run(runId)
    this.markPlan(planId, 'rejected', 'user')
    return this.askCoordinatorAgain(run, continuationPrompt({ kind: 'rejected', text: feedback, remaining: this.remainingSubtasks(runId), round: Math.max(1, run.round), usedIds: this.usedIds(runId) }))
  }

  /**
   * Answers the coordinator's questions, or gives it a new instruction (a completed, paused or
   * blocked run continues). The answer is data for the coordinator, never an approval: any plan
   * it sends back is validated and, if needed, approved like any other.
   */
  answer(runId: string, text: string): ConstellationRun {
    const run = this.requireStatus(runId, ['awaiting_approval', 'completed', 'paused', 'blocked', 'failed'], 'Répondre au coordinateur')
    if (this.active.has(runId)) throw new OrbitError('conflict', 'Cette constellation est déjà en cours.')
    if (!run.coordinatorMissionId) throw new OrbitError('validation', 'Le coordinateur n’a pas encore été sollicité.')
    const pending = this.plans(runId).filter((p) => p.status === 'proposed').at(-1)
    if (pending) this.markPlan(pending.id, pending.tasks.length ? 'rejected' : 'approved', 'user')
    const kind = pending?.questions.length && !pending.tasks.length ? 'answer' : 'continue'
    this.log(runId, kind === 'answer' ? 'decision.answer' : 'decision.continue', 'info', kind === 'answer' ? 'Vous avez répondu aux questions du coordinateur.' : 'Nouvelle consigne transmise au coordinateur : la mission collective continue.', { actor: 'user', data: { text: text.slice(0, 2000) } })
    return this.askCoordinatorAgain(run, continuationPrompt({ kind, text, questions: pending?.questions, remaining: this.remainingSubtasks(runId), round: Math.max(1, run.round), usedIds: this.usedIds(runId) }))
  }

  /** « Modifier le plan »: a new version (history kept), validated, then approved explicitly. */
  editPlan(runId: string, input: PlanTaskInput[]): ConstellationPlan {
    const run = this.requireStatus(runId, ['awaiting_approval', 'paused', 'blocked', 'failed'], 'Modifier le plan')
    if (this.active.has(runId)) throw new OrbitError('conflict', 'Mettez d’abord la constellation en pause.')
    const tasks = this.tasks(runId)
    const frozen = new Map(tasks.filter((t) => t.status === 'done' || t.status === 'running' || this.missions.isRunning(t.missionId)).map((t) => [t.spec.key, t]))
    const records = input.map((t) => ({ id: t.id, assignee: t.assignee, objective: t.objective, expected: t.expected ?? '', context: t.context ?? '', dependsOn: t.dependsOn ?? [], readOnly: t.readOnly ?? false, writes: t.readOnly ? [] : (t.writes ?? []) }))
    const agentIdOf = (assignee: string) => this.agents.list().find((a) => a.id === assignee || a.name.toLowerCase() === assignee.toLowerCase())?.id ?? ''
    for (const r of records) {
      const f = frozen.get(r.id)
      if (f && !sameWork({ agentId: f.agentId, ...f.spec }, { ...r, agentId: agentIdOf(r.assignee) }))
        throw new OrbitError('validation', `« ${r.id} » est déjà ${f.status === 'done' ? 'terminée' : 'en cours'} : elle ne peut plus être modifiée.`)
      // An attempted (failed / interrupted) task keeps its history: its content can change, not its companion.
      const attempted = tasks.find((t) => t.spec.key === r.id && !frozen.has(r.id) && this.missions.executionCount(t.missionId) > 0)
      if (attempted && attempted.agentId !== agentIdOf(r.assignee)) throw new OrbitError('validation', `« ${r.id} » a déjà été tentée par un autre compagnon : gardez-le, ou créez une nouvelle sous-mission avec un autre identifiant.`)
    }
    const v = this.revalidate(runId, records)
    const plan = this.storePlan(runId, v, { source: 'user', round: Math.max(1, run.round), executionId: null, reason: 'Plan modifié par vous : vérifiez les différences puis approuvez.' })
    this.log(runId, 'plan.edited', 'info', `Plan v${plan.version} rédigé par vous${v.errors.length ? ' (à corriger)' : ' : en attente de votre validation'}.`, { actor: 'user' })
    this.transition(runId, null, v.errors.length ? 'blocked' : 'awaiting_approval', { error: v.errors.length ? v.errors.join(' ') : null })
    return this.plans(runId).find((p) => p.id === plan.id)!
  }

  /** Raises (or lowers) this run's limits, within the same bounds as the definition. */
  updateLimits(runId: string, patch: Partial<ConstellationLimits>): ConstellationRun {
    const run = this.requireStatus(runId, ['awaiting_approval', 'paused', 'blocked', 'failed', 'planning', 'ready', 'running', 'synthesizing'], 'Modifier les limites')
    const limits = { ...run.limits, ...patch }
    this.checkLimits(limits)
    this.db.update(constellationRuns).set({ limits }).where(eq(constellationRuns.id, runId)).run()
    this.journal.audit({ actor: 'user', agentId: null, action: 'constellation.limits', target: runId, allowed: true, reason: JSON.stringify(patch) })
    this.log(runId, 'decision.limits', 'info', `Limites de cette exécution modifiées : ${Object.entries(patch).map(([k, v]) => `${k} → ${v}`).join(', ')}.`, { actor: 'user', data: patch })
    // A plan refused for its size can now be proposed again (it still needs approval).
    const pending = this.plans(runId).filter((p) => p.status === 'proposed' && p.errors.length).at(-1)
    if (pending && !this.active.has(runId)) {
      const v = this.revalidate(runId, pending.tasks, pending.round)
      this.db.update(constellationPlans).set({ errors: v.errors }).where(eq(constellationPlans.id, pending.id)).run()
      // Older rows stored no reason for a blocked plan: recomputed (the policy still applies).
      const reason = pending.approvalReason ?? this.approvalReason(runId, pending.tasks, pending.source, false)
      if (!v.errors.length) this.decideOrQueue(runId, this.plans(runId).find((p) => p.id === pending.id)!, reason)
    }
    return this.run(runId)
  }

  private askCoordinatorAgain(run: ConstellationRun, prompt: string): ConstellationRun {
    const from: ConstellationRunStatus[] = ['awaiting_approval', 'completed', 'paused', 'blocked', 'failed']
    if (!this.transition(run.id, from, 'planning', { error: null, finishedAt: null, phase: 'planning' })) throw new OrbitError('conflict', 'La constellation a changé d’état entre-temps.')
    this.spawnDrive(run.id, { kind: 'coordinator', prompt, phase: 'planning' })
    return this.run(run.id)
  }

  /**
   * Boot. Nothing runs after a restart: active runs become « paused » (never relaunched by
   * themselves), their unstarted sub-missions stay to do. Coordinator replies that arrived
   * outside the orchestration (a chat with the coordinator after the run had stopped) are
   * read now, as proposals that need the user's approval.
   */
  recoverInterrupted(): void {
    // Runs coordinated by a runtime are left alone: their runtime reports what happened.
    const rows = this.db.select().from(constellationRuns).where(isNull(constellationRuns.machineId)).all()
    for (const r of rows) {
      const status = normalizeRunStatus(r.status)
      if (ACTIVE_RUN_STATUSES.includes(status)) {
        this.db.update(constellationRuns).set({ status: 'paused', error: this.interruptedNote, version: (r.version ?? 0) + 1 }).where(eq(constellationRuns.id, r.id)).run()
        this.log(r.id, 'run.interrupted', 'warning', this.interruptedNote)
      }
      this.backfillPlans(r.id)
      if (status !== 'cancelled') this.ingestOrphanReply(r.id)
    }
  }

  /** Runs from before versioned plans: their sub-missions become the approved plan of each round. */
  private backfillPlans(runId: string) {
    if (this.db.select({ id: constellationPlans.id }).from(constellationPlans).where(eq(constellationPlans.runId, runId)).limit(1).get()) return
    const tasks = this.tasks(runId)
    if (!tasks.length) return
    const rounds = [...new Set(tasks.map((t) => t.spec.round || 1))].sort((a, b) => a - b)
    rounds.forEach((round, i) => {
      const records: PlanTaskRecord[] = tasks
        .filter((t) => (t.spec.round || 1) === round)
        .map((t) => ({ id: t.spec.key, assignee: this.safeAgent(t.agentId)?.name ?? t.agentId, agentId: t.agentId, objective: t.spec.objective, expected: t.spec.expected, context: t.spec.context, dependsOn: t.spec.dependsOn, readOnly: t.spec.readOnly, writes: t.spec.writes ?? [] }))
      this.db.insert(constellationPlans).values({ id: newId(), runId, version: i + 1, round, status: 'approved', hash: planHash(records), tasks: records, questions: [], note: null, errors: [], source: 'coordinator', sourceExecutionId: null, approvalReason: null, createdAt: tasks.find((t) => (t.spec.round || 1) === round)?.startedAt ?? nowIso(), decidedAt: nowIso(), decidedBy: 'policy' }).run()
    })
  }

  interruptedNote = 'Interrompue : Orbit a été fermé pendant l’exécution. Les résultats déjà obtenus sont conservés ; reprenez quand vous voulez.'

  cancelAll(): void {
    // Shutdown: stop the loops without marking runs cancelled (they become « paused » at boot).
    this.disposed = true
    for (const [id, s] of this.active) {
      s.controller.abort()
      for (const t of this.tasks(id)) if (this.missions.isRunning(t.missionId)) this.missions.cancel(t.missionId)
    }
  }

  // Coordinator replies outside the loop

  private guardCoordinatorChat(m: Mission) {
    if (!m.constellationRunId || m.depth > 0) return
    const state = this.active.get(m.constellationRunId)
    if (state && !state.coordinatorTurn) throw new OrbitError('conflict', 'La constellation est en cours : utilisez ses actions (pause, modifier le plan) plutôt que la discussion avec le coordinateur.')
  }

  private onMissionSettled(e: MissionSettled) {
    if (this.disposed) return
    let m: Mission
    try {
      m = this.missions.get(e.missionId)
    } catch {
      return
    }
    if (!m.constellationRunId) return
    this.lastSettled.set(e.missionId, e)
    if (m.depth > 0) return
    // The drive loop reads its own turns; anything else is a conversation with the coordinator.
    if (this.active.get(m.constellationRunId)?.coordinatorTurn) return
    if (e.status !== 'done') return
    try {
      const run = this.run(m.constellationRunId)
      if (run.coordinatorMissionId !== m.id || run.status === 'cancelled') return
      this.ingest(run.id, e.executionId, e.text, 'conversation', 'planning')
    } catch (err) {
      this.journal.activity({ type: 'constellation.failed', level: 'error', agentId: m.agentId, title: 'Réponse du coordinateur non lue', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Legacy runs: the coordinator answered after the run had been closed. */
  private ingestOrphanReply(runId: string) {
    const r = this.runRow(runId)
    if (!r.coordinatorMissionId) return
    let m: Mission
    try {
      m = this.missions.get(r.coordinatorMissionId)
    } catch {
      return
    }
    if (m.status !== 'done' || !m.result) return
    const last = this.db.select().from(missionExecutions).where(eq(missionExecutions.missionId, m.id)).orderBy(desc(missionExecutions.startedAt)).limit(1).get()
    if (!last || last.status !== 'done' || last.id === r.lastIngestedExecutionId) return
    // Without a record of what was read (pre-lifecycle runs), only replies after the run ended count.
    if (!r.lastIngestedExecutionId && (!r.finishedAt || last.startedAt <= r.finishedAt)) return
    if (this.db.select({ id: constellationPlans.id }).from(constellationPlans).where(and(eq(constellationPlans.runId, runId), eq(constellationPlans.sourceExecutionId, last.id))).get()) return
    this.ingest(runId, last.id, m.result, 'conversation', 'planning', { recovered: true })
  }

  // Reading a coordinator reply

  private existing(runId: string) {
    return this.tasks(runId).map((t) => ({ key: t.spec.key, agentId: t.agentId, status: t.status, spec: t.spec }))
  }

  /** Task ids already taken in the run (told to the coordinator so it never reuses a finished one). */
  private usedIds(runId: string): string[] {
    return this.tasks(runId).map((t) => t.spec.key)
  }

  private remainingSubtasks(runId: string) {
    return Math.max(0, this.run(runId).limits.maxSubtasks - this.tasks(runId).length)
  }

  private revalidate(runId: string, tasks: Pick<PlanTaskRecord, 'id' | 'assignee' | 'objective' | 'expected' | 'context' | 'dependsOn' | 'readOnly' | 'writes'>[], round?: number): PlanValidation {
    const run = this.run(runId)
    const def = this.get(run.constellationId)
    const coord = def.members.find((m) => m.agentId === def.coordinatorAgentId)
    const text = '```orbit-plan\n' + JSON.stringify({ tasks: tasks.map((t) => ({ id: t.id, assignee: t.assignee, objective: t.objective, expected: t.expected, context: t.context, dependsOn: t.dependsOn, readOnly: t.readOnly, writes: t.writes ?? [] })) }) + '\n```'
    const v = validatePlan(text, { definition: { ...def, limits: run.limits }, agents: this.agents.list(), existing: this.existing(runId), coordinatorCanDelegate: coord?.canDelegate ?? false })
    if (round && round > run.limits.maxDepth) v.errors.push(`Profondeur maximale atteinte : tour ${round}, limite ${run.limits.maxDepth}.`)
    return v
  }

  private validate(runId: string, text: string): PlanValidation {
    const run = this.run(runId)
    const def = this.get(run.constellationId)
    const coord = def.members.find((m) => m.agentId === def.coordinatorAgentId)
    return validatePlan(text, { definition: { ...def, limits: run.limits }, agents: this.agents.list(), existing: this.existing(runId), coordinatorCanDelegate: coord?.canDelegate ?? false })
  }

  /**
   * Reads one coordinator reply, at most once (keyed by its execution), and decides what
   * happens next. `via: 'conversation'` = a chat outside the loop: whatever it proposes waits
   * for an explicit approval (a conversational « go ahead » never authorises sub-missions).
   */
  private ingest(runId: string, executionId: string, text: string, via: 'coordinator' | 'conversation', phase: 'planning' | 'synthesizing', o: { repaired?: boolean; recovered?: boolean; canDelegate?: boolean } = {}): Step {
    const row = this.runRow(runId)
    if (row.lastIngestedExecutionId === executionId) return { kind: 'stop' }
    this.db.update(constellationRuns).set({ lastIngestedExecutionId: executionId }).where(eq(constellationRuns.id, runId)).run()
    const run = this.run(runId)
    const coordName = this.safeAgent(run.coordinatorAgentId)?.name ?? 'Le coordinateur'
    const v = this.validate(runId, text)
    const reply = stripProtocol(text)
    const tasks = this.tasks(runId)
    // A new round once the previous one has fully run (or after a synthesis).
    const nextRound = phase === 'synthesizing' || (tasks.length > 0 && tasks.every((t) => TERMINAL_MISSION_STATUSES.includes(t.status))) ? Math.max(1, run.round) + 1 : Math.max(1, run.round)
    if (o.recovered) this.log(runId, 'plan.recovered', 'warning', `Réponse de ${coordName} reçue après la fin de l’orchestration (discussion) : relue par Orbit.`, { data: { executionId } })

    if (via === 'coordinator' && phase === 'synthesizing' && o.canDelegate === false && !v.noDelegation && (v.tasks.length || v.errors.length)) {
      // Last round: no new delegation possible - the user decides whether to raise the limits.
      v.errors.push(`Aucune nouvelle délégation possible dans cette exécution (profondeur, nombre de sous-missions ou budget atteints).`)
    } else if (v.tasks.length && nextRound > run.limits.maxDepth) v.errors.push(`Profondeur maximale atteinte : tour ${nextRound}, limite ${run.limits.maxDepth}.`)

    // 1. Refused plan.
    if (v.errors.length) {
      const limitOnly = v.errors.every((e) => BLOCKING_ERRORS.test(e))
      if (limitOnly) {
        // Keep the tasks so the user can raise the limits and approve without asking again.
        const cand = this.candidates(runId, text)
        // The approval it will need once the limits allow it (policy, coordinator's request, conversation).
        const reason = this.approvalReason(runId, cand, via, v.requestApproval)
        const plan = this.storePlan(runId, { ...v, tasks: cand }, { source: via, round: nextRound, executionId, reason })
        this.log(runId, 'plan.blocked', 'warning', `Plan v${plan.version} de ${coordName} hors limites : ${v.errors.join(' ')}`)
        this.transition(runId, null, 'blocked', { error: `${v.errors.join(' ')} Relevez les limites de cette exécution ou modifiez le plan.`, synthesis: reply || run.synthesis, phase: 'planning' })
        this.notifyAttention(runId, 'Constellation bloquée', v.errors.join(' '))
        return { kind: 'stop' }
      }
      const plan = this.storePlan(runId, v, { source: via, round: nextRound, executionId, reason: null })
      this.handoff(runId, 'synthesis', 'orbit', run.coordinatorAgentId, run.coordinatorMissionId, 'Plan refusé par Orbit', v.errors.join('\n'), 0)
      this.log(runId, 'plan.invalid', 'error', `Plan v${plan.version} refusé par Orbit : ${v.errors.join(' ')}`)
      if (via === 'coordinator' && !o.repaired) {
        return { kind: 'coordinator', phase, repaired: true, canDelegate: o.canDelegate, prompt: `Orbit a refusé ton plan :\n- ${v.errors.join('\n- ')}\nCorrige-le et renvoie un bloc orbit-plan valide.` }
      }
      if (via === 'coordinator') {
        this.finishRun(runId, 'failed', null, `Plan refusé par Orbit : ${v.errors.join(' ')} Reprenez pour que ${coordName} propose un nouveau plan.`)
      } else {
        this.transition(runId, null, 'blocked', { error: `Plan refusé par Orbit : ${v.errors.join(' ')}` })
        this.notifyAttention(runId, 'Plan de constellation invalide', v.errors.join(' '))
      }
      return { kind: 'stop' }
    }

    // 2. Questions for the user (with or without tasks to validate).
    if (!v.tasks.length && (v.questions.length || v.requestApproval)) {
      const plan = this.storePlan(runId, v, { source: via, round: Math.max(1, run.round), executionId, reason: 'Le coordinateur attend vos décisions.' })
      this.log(runId, 'approval.requested', 'warning', `${coordName} attend vos décisions (${v.questions.length} question${v.questions.length > 1 ? 's' : ''}).`, { data: { planId: plan.id } })
      this.transition(runId, null, 'awaiting_approval', { synthesis: reply || run.synthesis, error: null, finishedAt: null })
      this.notifyAttention(runId, 'Décision attendue', `${coordName} attend votre réponse pour continuer.`)
      return { kind: 'stop' }
    }

    // 3. No delegation: the coordinator considers the collective mission finished.
    if (v.noDelegation) {
      if (via === 'conversation') {
        if (v.blockFound) this.log(runId, 'exchange.ended', 'info', `Échange avec ${coordName} terminé, sans nouvelle sous-mission.`)
        return { kind: 'stop' }
      }
      const open = tasks.filter((t) => !TERMINAL_MISSION_STATUSES.includes(t.status))
      if (open.length) {
        // Never « completed » while mandatory sub-missions are pending.
        this.log(runId, 'run.incoherent', 'warning', `${coordName} a conclu alors que ${open.length} sous-mission(s) restent à faire : ${open.map((t) => t.spec.key).join(', ')}.`)
        this.transition(runId, null, 'blocked', { error: `${coordName} a terminé son échange, mais ${open.length} sous-mission(s) restent à faire. Reprenez pour les exécuter, ou annulez-les.`, synthesis: reply || run.synthesis, phase: 'executing' })
        return { kind: 'stop' }
      }
      this.finishRun(runId, 'completed', reply, null)
      return { kind: 'stop' }
    }

    // 4. A plan with tasks.
    const records = v.tasks.map((t) => ({ id: t.id, assignee: t.assignee, agentId: t.agentId, objective: t.objective, expected: t.expected, context: t.context, dependsOn: t.dependsOn, readOnly: t.readOnly, writes: t.writes }))
    const hash = planHash(records)
    const same = this.plans(runId).filter((p) => p.hash === hash && (p.status === 'approved' || p.status === 'proposed')).at(-1)
    if (same) {
      this.log(runId, 'plan.recognized', 'info', `Plan identique à la version v${same.version} (${same.status === 'approved' ? 'déjà validée' : 'en attente de validation'}) : reconnu, aucune sous-mission recréée.`, { data: { planId: same.id } })
      if (same.status === 'proposed') {
        this.transition(runId, null, 'awaiting_approval', { error: null })
        return { kind: 'stop' }
      }
      const left = same.tasks.some((t) => !this.taskSettled(this.tasks(runId), t.id))
      if (via === 'coordinator' && left) return { kind: 'execute' }
      if (via === 'coordinator') {
        this.finishRun(runId, 'completed', reply || run.synthesis, null)
      }
      return { kind: 'stop' }
    }
    const reason = this.approvalReason(runId, records, via, v.requestApproval)
    const plan = this.storePlan(runId, { ...v, tasks: v.tasks }, { source: via, round: nextRound, executionId, reason })
    if (reply) this.db.update(constellationRuns).set({ synthesis: reply }).where(eq(constellationRuns.id, runId)).run()
    return this.decideOrQueue(runId, plan, reason, via === 'coordinator')
  }

  private conversationReason = 'Plan reçu dans une discussion avec le coordinateur : une réponse conversationnelle ne vaut pas validation.'

  /** Approved by policy and executed, or waiting for the user. */
  private decideOrQueue(runId: string, plan: ConstellationPlan, reason: string | null, inLoop = false): Step {
    if (reason) {
      this.log(runId, 'approval.requested', 'warning', `Plan v${plan.version} (${plan.tasks.length} sous-missions) en attente de votre validation : ${reason}`, { data: { planId: plan.id } })
      this.transition(runId, null, 'awaiting_approval', { error: null, finishedAt: null })
      this.notifyAttention(runId, 'Plan à valider', `${plan.tasks.length} sous-missions attendent votre validation.`)
      return { kind: 'stop' }
    }
    this.markPlan(plan.id, 'approved', 'policy')
    this.log(runId, 'plan.approved', 'info', `Plan v${plan.version} validé par Orbit (${plan.tasks.length} sous-missions, aucune validation humaine requise par la constellation).`)
    this.applyPlan(runId, this.plans(runId).find((p) => p.id === plan.id)!)
    if (!inLoop) {
      if (this.active.has(runId)) return { kind: 'stop' }
      this.transition(runId, null, 'ready', { phase: 'executing', error: null })
      this.spawnDrive(runId, { kind: 'execute' })
      return { kind: 'stop' }
    }
    return { kind: 'execute' }
  }

  private approvalReason(runId: string, tasks: PlanTaskRecord[], via: 'coordinator' | 'conversation' | 'user', requested: boolean): string | null {
    if (via === 'conversation') return this.conversationReason
    if (requested) return 'Le coordinateur demande votre validation avant de lancer ces sous-missions.'
    const def = this.get(this.run(runId).constellationId)
    if (def.planApproval === 'always') return 'Cette constellation demande votre validation pour chaque plan.'
    if (def.planApproval === 'writes' && tasks.some((t) => !t.readOnly)) return 'Ce plan contient des sous-missions qui peuvent modifier des fichiers ou exécuter des commandes.'
    // A plan the user approved, then modified by the coordinator, is approved again.
    const prev = this.plans(runId).filter((p) => p.status === 'approved' && p.tasks.length).at(-1)
    if (prev?.decidedBy === 'user' && def.planApproval !== 'auto') return 'Le plan a changé depuis votre dernière validation.'
    return null
  }

  /** Every task the coordinator wrote (agent resolved when possible), even if the plan is refused. */
  private candidates(runId: string, text: string) {
    const run = this.run(runId)
    const def = this.get(run.constellationId)
    const v = validatePlan(text, { definition: { ...def, limits: { maxSubtasks: 50 } }, agents: this.agents.list(), existing: this.existing(runId), coordinatorCanDelegate: true })
    return v.tasks
  }

  private storePlan(runId: string, v: Pick<PlanValidation, 'tasks' | 'errors' | 'questions' | 'note'>, o: { source: ConstellationPlan['source']; round: number; executionId: string | null; reason: string | null }): ConstellationPlan {
    const records: PlanTaskRecord[] = v.tasks.map((t) => ({ id: t.id, assignee: this.safeAgent(t.agentId)?.name ?? t.assignee, agentId: t.agentId, objective: t.objective, expected: t.expected, context: t.context, dependsOn: t.dependsOn, readOnly: t.readOnly, writes: t.writes }))
    const id = newId()
    this.db.transaction((tx) => {
      const version = (tx.select({ v: constellationPlans.version }).from(constellationPlans).where(eq(constellationPlans.runId, runId)).orderBy(desc(constellationPlans.version)).limit(1).get()?.v ?? 0) + 1
      // A newer proposal replaces the one still waiting (history kept).
      tx.update(constellationPlans).set({ status: 'superseded', decidedAt: nowIso(), decidedBy: 'orbit' }).where(and(eq(constellationPlans.runId, runId), eq(constellationPlans.status, 'proposed'))).run()
      tx.insert(constellationPlans)
        .values({ id, runId, version, round: o.round, status: v.errors.length && !records.length ? 'invalid' : 'proposed', hash: planHash(records, v.questions), tasks: records, questions: v.questions, note: v.note, errors: v.errors, source: o.source, sourceExecutionId: o.executionId, approvalReason: o.reason, createdAt: nowIso() })
        .run()
    })
    this.bus.invalidate('constellations')
    return this.plans(runId).find((p) => p.id === id)!
  }

  private planRow(runId: string, planId: string): ConstellationPlan {
    const p = this.plans(runId).find((x) => x.id === planId)
    if (!p) throw new OrbitError('not_found', 'Plan introuvable pour cette exécution.')
    return p
  }

  private markPlan(planId: string, status: ConstellationPlan['status'], by: string) {
    this.db.update(constellationPlans).set({ status, decidedAt: nowIso(), decidedBy: by }).where(eq(constellationPlans.id, planId)).run()
    this.bus.invalidate('constellations')
  }

  /** Latest approved plan with tasks: the one being executed. */
  private activePlan(runId: string): ConstellationPlan | null {
    return this.plans(runId).filter((p) => p.status === 'approved' && p.tasks.length).at(-1) ?? null
  }

  /**
   * Only tasks of the plan being executed can be retried: executePlan runs nothing else, and an
   * older task the current plan dropped (or superseded) must not come back by a retry.
   */
  private inActivePlan(runId: string): (t: ConstellationTask) => boolean {
    const plan = this.activePlan(runId)
    if (!plan) return () => true
    const keys = new Set(plan.tasks.map((p) => p.id))
    return (t) => keys.has(t.spec.key)
  }

  private taskSettled(tasks: ConstellationTask[], key: string) {
    const t = tasks.find((x) => x.spec.key === key)
    return Boolean(t && TERMINAL_MISSION_STATUSES.includes(t.status))
  }

  /**
   * Turns an approved plan into sub-missions, idempotently: a key that already exists is the
   * same task (finished → kept, never re-run; never started → updated), a new key creates one,
   * a never-started task the plan dropped is skipped. Unique (run, key) in the database.
   */
  private applyPlan(runId: string, plan: ConstellationPlan) {
    const run = this.run(runId)
    const def = this.get(run.constellationId)
    const coordId = run.coordinatorMissionId
    const byKey = new Map(this.tasks(runId).map((t) => [t.spec.key, t]))
    const keyToMission = new Map([...byKey].map(([k, t]) => [k, t.missionId]))
    const created: string[] = []
    const updated: string[] = []
    for (const t of plan.tasks) {
      const agent = this.agents.get(t.agentId)
      const spec: SubtaskSpec = { key: t.id, objective: t.objective, expected: t.expected, context: t.context, dependsOn: t.dependsOn, readOnly: t.readOnly, writes: t.writes ?? [], round: plan.round }
      const perms = intersectPermissions(def.permissions, t.readOnly ? { ...def.permissions, writeFiles: false, runCommands: false } : null)
      const prev = byKey.get(t.id)
      if (prev) {
        const started = this.missions.executionCount(prev.missionId) > 0
        if (prev.status === 'done' || this.missions.isRunning(prev.missionId)) continue // finished or running: kept as is
        if (started) {
          // Attempted (failed / interrupted): the edited content is kept for the explicit retry; history stays.
          if (prev.agentId === agent.id && (prev.status === 'failed' || prev.status === 'cancelled') && !sameWork({ agentId: prev.agentId, ...prev.spec }, { ...t, agentId: agent.id })) {
            this.db.update(missions).set({ subtask: spec, title: t.objective.split('\n')[0]!.slice(0, 150), description: t.objective, permissionsOverride: perms, updatedAt: nowIso() }).where(eq(missions.id, prev.missionId)).run()
            updated.push(t.id)
          }
          continue
        }
        if (prev.agentId !== agent.id) {
          this.db.delete(missions).where(eq(missions.id, prev.missionId)).run()
        } else {
          if (prev.status === 'cancelled') this.missions.reset(prev.missionId)
          this.db.update(missions).set({ subtask: spec, title: t.objective.split('\n')[0]!.slice(0, 150), description: t.objective, permissionsOverride: perms, updatedAt: nowIso() }).where(eq(missions.id, prev.missionId)).run()
          updated.push(t.id)
          continue
        }
      }
      const workspace = this.providers.engine(agent.providerId) ? def.workspace ?? agent.workingDirectory ?? null : null
      const m = this.missions.create({ title: t.objective.split('\n')[0]!.slice(0, 150), description: t.objective, agentId: agent.id, priority: 'normal', startNow: false, workspace, constellationRunId: runId, parentMissionId: coordId, depth: 1, subtask: spec, permissionsOverride: perms })
      keyToMission.set(t.id, m.id)
      created.push(t.id)
    }
    // Dropped from the plan and never started: skipped (history kept).
    const keys = new Set(plan.tasks.map((t) => t.id))
    for (const [k, t] of byKey) if (!keys.has(k) && t.status === 'todo' && this.missions.executionCount(t.missionId) === 0) this.missions.skip(t.missionId, `Retirée du plan v${plan.version}.`)
    // Dependencies of every task that has not started yet are rebuilt from the plan.
    for (const t of plan.tasks) {
      const mid = keyToMission.get(t.id)
      if (!mid || !(created.includes(t.id) || updated.includes(t.id) || this.missions.executionCount(mid) === 0)) continue
      if (this.missions.get(mid).status === 'done') continue
      this.db.delete(missionDependencies).where(eq(missionDependencies.missionId, mid)).run()
      for (const d of t.dependsOn) if (keyToMission.get(d)) this.db.insert(missionDependencies).values({ missionId: mid, dependsOnMissionId: keyToMission.get(d)! }).onConflictDoNothing().run()
    }
    this.db.update(constellationRuns).set({ round: plan.round }).where(eq(constellationRuns.id, runId)).run()
    const coordinator = this.safeAgent(run.coordinatorAgentId)
    if (created.length) this.journal.activity({ type: 'constellation.delegated', agentId: run.coordinatorAgentId, title: `${coordinator?.name ?? 'Le coordinateur'} a réparti ${created.length} sous-mission${created.length > 1 ? 's' : ''}`, detail: created.map((k) => `${k} → ${plan.tasks.find((t) => t.id === k)?.assignee}`).join(', ') })
    this.log(runId, 'plan.applied', 'info', `Plan v${plan.version} appliqué : ${created.length} créée(s), ${updated.length} mise(s) à jour, ${plan.tasks.length - created.length - updated.length} conservée(s).`, { data: { created, updated } })
    this.bus.invalidate('constellations', 'missions')
  }

  /** Failed tasks (and never-started dependents) skipped on the user's decision. */
  private skipFailed(runId: string) {
    const tasks = this.tasks(runId)
    // Failed, or interrupted after it started (time limit, restart): both are gone past.
    const skipped = tasks.filter((t) => this.failedAttempt(t))
    const failed = new Set(skipped.map((t) => t.missionId))
    for (const t of skipped) this.db.update(missions).set({ status: 'cancelled', error: `${t.error ?? (t.status === 'failed' ? 'Échec' : 'Interrompue')} — ${SKIPPED_MARK}.`, updatedAt: nowIso() }).where(eq(missions.id, t.missionId)).run()
    let changed = true
    while (changed) {
      changed = false
      for (const t of this.tasks(runId)) if (t.status === 'todo' && t.dependsOnMissionIds.some((d) => failed.has(d))) {
        this.missions.skip(t.missionId, 'Dépend d’une sous-mission ignorée.')
        failed.add(t.missionId)
        changed = true
      }
    }
  }

  private resetSkippedDependents(runId: string, roots: Set<string>) {
    const inPlan = this.inActivePlan(runId)
    let changed = true
    while (changed) {
      changed = false
      for (const t of this.tasks(runId)) {
        if (t.status !== 'cancelled' || roots.has(t.missionId) || !inPlan(t) || this.missions.executionCount(t.missionId) > 0) continue
        if (t.dependsOnMissionIds.some((d) => roots.has(d))) {
          this.missions.reset(t.missionId)
          roots.add(t.missionId)
          changed = true
        }
      }
    }
  }

  /** Where to continue a stopped run, from what is persisted. */
  private stepFor(runId: string): Step {
    const run = this.run(runId)
    const tasks = this.tasks(runId)
    const plan = this.activePlan(runId)
    if (!run.coordinatorMissionId) return { kind: 'coordinator', prompt: null, phase: 'planning' }
    const coord = this.missions.get(run.coordinatorMissionId)
    const coordUnread = coord.status !== 'done' || this.lastExecutionId(coord.id) !== this.runRow(runId).lastIngestedExecutionId
    if (run.phase === 'synthesizing' && coordUnread) return { kind: 'synthesize' }
    if (!plan) return { kind: 'coordinator', prompt: continuationPrompt({ kind: 'resume', text: 'Orbit a été interrompu ou arrêté. Reprends la planification.', remaining: this.remainingSubtasks(runId), round: Math.max(1, run.round), usedIds: this.usedIds(runId) }), phase: 'planning' }
    const planTasks = tasks.filter((t) => plan.tasks.some((p) => p.id === t.spec.key))
    if (planTasks.some((t) => t.status === 'todo' || t.status === 'approval_required')) return { kind: 'execute' }
    if (planTasks.some((t) => this.failedAttempt(t))) return { kind: 'stop' }
    if (run.phase === 'executing' || run.phase === 'synthesizing') return { kind: 'synthesize' }
    return { kind: 'synthesize' }
  }

  /** Failed, or interrupted after it started - unless the user chose to go on without it. */
  private failedAttempt(t: ConstellationTask) {
    if ((t.error ?? '').includes(SKIPPED_MARK)) return false
    return t.status === 'failed' || (t.status === 'cancelled' && this.missions.executionCount(t.missionId) > 0)
  }

  private blockedReason(runId: string): string | null {
    const r = this.retryable(runId).filter((x) => !(this.tasks(runId).find((t) => t.missionId === x.missionId)?.error ?? '').includes(SKIPPED_MARK))
    if (!r.length) return null
    return `${r.length} sous-mission(s) en échec ou interrompue(s) : ${r.map((x) => x.key).join(', ')}. Vérifiez leurs effets puis réessayez-les, ou poursuivez sans elles.`
  }

  private lastExecutionId(missionId: string): string | null {
    return this.db.select({ id: missionExecutions.id }).from(missionExecutions).where(eq(missionExecutions.missionId, missionId)).orderBy(desc(missionExecutions.startedAt)).limit(1).get()?.id ?? null
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

  private spawnDrive(runId: string, first: Step) {
    if (this.active.has(runId)) return
    const state: RunState = { controller: new AbortController(), timer: null, writerLocks: new Map(), since: Date.now(), coordinatorTurn: false }
    this.active.set(runId, state)
    const run = this.run(runId)
    // Only time actually spent driving counts (approvals and pauses excluded).
    const leftMs = Math.max(5_000, run.limits.maxDurationMin * 60_000 - run.activeMs)
    state.timer = setTimeout(() => this.timeLimit(runId), leftMs)
    state.timer.unref?.()
    this.bus.invalidate('constellations')
    void this.drive(runId, state, first)
      .catch((err) => {
        if (!this.disposed && !state.controller.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err)
          this.log(runId, 'run.error', 'error', `Erreur d’orchestration : ${msg}`)
          this.finishRun(runId, 'failed', null, msg)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (state.timer) clearTimeout(state.timer)
        this.active.delete(runId)
        if (this.disposed) return
        try {
          const r = this.runRow(runId)
          this.db.update(constellationRuns).set({ activeMs: (r.activeMs ?? 0) + (Date.now() - state.since) }).where(eq(constellationRuns.id, runId)).run()
        } catch {
          /* deleted */
        }
        this.bus.invalidate('constellations', 'missions')
      })
  }

  private timeLimit(runId: string) {
    const state = this.active.get(runId)
    const run = this.run(runId)
    // Only active work is stopped: a run cancelled, finished or waiting meanwhile keeps its state.
    const from: ConstellationRunStatus[] = [...ACTIVE_RUN_STATUSES, 'paused']
    if (!from.includes(run.status)) return
    const reason = `Durée maximale atteinte (${run.limits.maxDurationMin} min de travail) : la constellation a été arrêtée. Relevez la limite puis reprenez ; les sous-missions interrompues sont à vérifier avant de les réessayer.`
    state?.controller.abort()
    for (const t of this.tasks(runId)) if (this.missions.isRunning(t.missionId)) this.missions.cancel(t.missionId)
    if (run.coordinatorMissionId && this.missions.isRunning(run.coordinatorMissionId)) this.missions.cancel(run.coordinatorMissionId)
    this.event(runId, 'error', run.coordinatorAgentId, null, null)
    if (!this.transition(runId, from, 'blocked', { error: reason })) return
    this.log(runId, 'limit.duration', 'warning', reason)
    this.notifyAttention(runId, 'Constellation bloquée', reason)
  }

  private paused(runId: string) {
    return this.run(runId).status === 'paused'
  }

  private async drive(runId: string, state: RunState, first: Step): Promise<void> {
    const signal = state.controller.signal
    let step: Step = first
    for (;;) {
      if (signal.aborted || step.kind === 'stop') return
      // Paused: a reply already requested is read, nothing new is started.
      if (this.paused(runId)) return
      if (step.kind === 'coordinator') {
        const { text, executionId } = await this.askCoordinator(runId, state, step.prompt, step.phase)
        if (signal.aborted) return
        step = this.ingest(runId, executionId, text, 'coordinator', step.phase, { repaired: step.repaired, canDelegate: step.canDelegate })
        if (step.kind === 'coordinator') this.event(runId, 'synthesis', null, this.run(runId).coordinatorAgentId, this.run(runId).coordinatorMissionId)
        continue
      }
      if (step.kind === 'execute') {
        step = await this.executePlan(runId, state)
        continue
      }
      if (step.kind === 'synthesize') {
        step = this.synthesisStep(runId)
        continue
      }
    }
  }

  /** Sends the coordinator its next prompt (or its brief) and waits for its own reply. */
  private async askCoordinator(runId: string, state: RunState, prompt: string | null, phase: 'planning' | 'synthesizing'): Promise<{ text: string; executionId: string }> {
    const run = this.run(runId)
    const def = this.get(run.constellationId)
    const coordinator = this.agents.get(def.coordinatorAgentId)
    if (!coordinator.enabled) throw new Error(`${coordinator.name} (coordinateur) est désactivé.`)
    this.transition(runId, ['planning', 'ready', 'running', 'synthesizing'], phase === 'planning' ? 'planning' : 'synthesizing', { phase })
    let coordId = run.coordinatorMissionId
    state.coordinatorTurn = true
    try {
      if (!coordId) {
        const brief = planningPrompt({ goal: run.goal, definition: def, agents: this.agents.list(), engines: this.engineNames(def), round: 1, limits: run.limits })
        const m = this.missions.create({ title: `Coordination · ${run.goal.slice(0, 120)}`, description: brief, agentId: coordinator.id, priority: 'normal', startNow: false, workspace: def.workspace, constellationRunId: runId, depth: 0, permissionsOverride: { ...def.permissions, writeFiles: false } })
        coordId = m.id
        this.db.update(constellationRuns).set({ coordinatorMissionId: coordId, round: 1 }).where(eq(constellationRuns.id, runId)).run()
        this.missions.start(coordId, run.origin)
      } else {
        this.missions.followUp(coordId, prompt ?? continuationPrompt({ kind: 'resume', text: '', remaining: this.remainingSubtasks(runId), round: Math.max(1, run.round), usedIds: this.usedIds(runId) }), run.origin)
      }
      await this.waitText(coordId, state.controller.signal)
    } finally {
      state.coordinatorTurn = false
    }
    if (state.controller.signal.aborted) return { text: '', executionId: '' }
    const m = this.missions.get(coordId)
    const settled = this.lastSettled.get(coordId)
    const executionId = this.lastExecutionId(coordId)
    if (m.status !== 'done' || !executionId || settled?.executionId !== executionId) {
      throw new Error(`${coordinator.name} n’a pas pu ${phase === 'planning' ? 'planifier' : 'rédiger la synthèse'} : ${m.error ?? 'échec'}. Reprenez quand le problème est résolu.`)
    }
    return { text: settled.text, executionId }
  }

  private synthesisStep(runId: string): Step {
    const run = this.run(runId)
    const def = this.get(run.constellationId)
    const coordinator = this.agents.get(def.coordinatorAgentId)
    const coordMember = def.members.find((m) => m.agentId === coordinator.id)
    const plan = this.activePlan(runId)
    const all = this.tasks(runId)
    const round = Math.max(1, run.round)
    const inPlan = plan ? all.filter((t) => plan.tasks.some((p) => p.id === t.spec.key)) : all
    const thisRound = inPlan.filter((t) => t.spec.round === round)
    const results = (thisRound.length ? thisRound : inPlan).map((t) => ({ key: t.spec.key, agentName: this.safeAgent(t.agentId)?.name ?? '?', status: t.status === 'done' ? 'terminée' : t.status === 'failed' ? `échec : ${t.error ?? ''}` : 'non exécutée', text: t.structured?.summary ? `${t.structured.summary}\n\n${stripProtocol(t.result ?? '')}` : stripProtocol(t.result ?? '') }))
    const canDelegateAgain = round < run.limits.maxDepth && all.length < run.limits.maxSubtasks && Boolean(coordMember?.canDelegate) && !this.overBudget(runId).over
    const sp = synthesisPrompt({ results, round, canDelegateAgain, remaining: run.limits.maxSubtasks - all.length, usedIds: all.map((t) => t.spec.key) })
    this.handoff(runId, 'synthesis', 'orbit', coordinator.id, run.coordinatorMissionId, `Résultats du tour ${round} transmis à ${coordinator.name}`, sp.prompt, sp.redactions)
    this.event(runId, 'synthesis', null, coordinator.id, run.coordinatorMissionId)
    this.log(runId, 'round.done', 'success', `Tour ${round} terminé : résultats transmis à ${coordinator.name} pour la synthèse.`)
    this.db.update(constellationRuns).set({ phase: 'synthesizing' }).where(eq(constellationRuns.id, runId)).run()
    return { kind: 'coordinator', prompt: sp.prompt, phase: 'synthesizing', canDelegate: canDelegateAgain }
  }

  private engineNames(def: ConstellationDefinition): Record<string, string> {
    const out: Record<string, string> = {}
    for (const m of def.members) {
      const a = this.safeAgent(m.agentId)
      if (a) out[a.id] = this.providers.adapter(a.providerId).name
    }
    return out
  }

  /**
   * Write scopes the scheduler may rely on to run writers side by side. Only when Orbit holds
   * the task to them: a local run, and commands confined by the engine's sandbox whenever the
   * task may run any. Otherwise the task locks the whole folder, as if it declared no scope.
   */
  private lockScopes(t: ConstellationTask): string[] {
    const writes = t.spec.writes ?? []
    if (!writes.length) return []
    const agent = this.safeAgent(t.agentId)
    if (!agent || agent.runtime !== 'local') return []
    if (t.permissions.runCommands && (agent.autonomy === 'autonomous' || this.providers.engine(agent.providerId)?.capabilities.containsCommands !== true)) return []
    return writes
  }

  /** Worktree per writer agent when requested and possible; otherwise the shared folder. */
  private async workspaceFor(runId: string, def: ConstellationDefinition, agent: Agent, t: ConstellationTask): Promise<string | null> {
    const base = def.workspace ?? agent.workingDirectory
    if (!base) return null
    const writer = (t.permissions.writeFiles || t.permissions.runCommands) && !t.spec.readOnly && agent.permissions.writeFiles
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
    const all = this.tasks(runId)
    for (const d of t.dependsOnMissionIds) {
      const depAgent = all.find((x) => x.missionId === d)?.agentId
      const depWs = depAgent ? this.db.select().from(agentWorkspaces).where(and(eq(agentWorkspaces.runId, runId), eq(agentWorkspaces.agentId, depAgent))).get() : null
      if (depWs?.branch) baseRef = depWs.branch
    }
    const branch = `orbit/${runId.slice(0, 8)}/${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const path = join(this.worktreeRoot, runId, agent.id)
    await addWorktree(repo, path, branch, baseRef)
    this.db.insert(agentWorkspaces).values({ id: newId(), runId, agentId: agent.id, path, kind: 'worktree', branch, baseRef: head, status: 'active', createdAt: nowIso() }).run()
    return path
  }

  /** Runs the approved plan's remaining tasks, then decides: synthesis, blocked, or stop (paused). */
  private async executePlan(runId: string, state: RunState): Promise<Step> {
    const plan = this.activePlan(runId)
    if (!plan) return { kind: 'synthesize' }
    this.transition(runId, ['ready', 'running', 'planning', 'synthesizing'], 'running', { phase: 'executing' })
    const keys = new Set(plan.tasks.map((t) => t.id))
    const outcome = await this.executeRound(runId, keys, state)
    if (state.controller.signal.aborted) return { kind: 'stop' }
    if (outcome.limit) {
      this.log(runId, 'limit.reached', 'warning', outcome.limit)
      this.transition(runId, null, 'blocked', { error: `${outcome.limit} Les sous-missions restantes n’ont pas démarré : relevez la limite puis reprenez.` })
      this.notifyAttention(runId, 'Constellation bloquée', outcome.limit)
      return { kind: 'stop' }
    }
    if (this.paused(runId)) {
      this.log(runId, 'run.paused', 'info', 'Pause effective : les sous-missions en cours sont terminées, aucune autre n’a démarré.')
      return { kind: 'stop' }
    }
    const tasks = this.tasks(runId).filter((t) => keys.has(t.spec.key))
    const failed = tasks.filter((t) => this.failedAttempt(t))
    const waiting = tasks.filter((t) => t.status === 'todo' || t.status === 'approval_required')
    if (failed.length || waiting.length) {
      const msg = failed.length
        ? `${failed.length} sous-mission(s) en échec : ${failed.map((t) => t.spec.key).join(', ')}${waiting.length ? ` ; ${waiting.length} en attente de celles-ci` : ''}. Les résultats des autres sont conservés. Réessayez-les après vérification, ou poursuivez sans elles.`
        : `${waiting.length} sous-mission(s) ne peuvent pas démarrer : ${waiting.map((t) => t.spec.key).join(', ')}.`
      this.log(runId, 'run.blocked', 'warning', msg)
      this.transition(runId, null, 'blocked', { error: msg })
      this.notifyAttention(runId, 'Constellation bloquée', msg)
      return { kind: 'stop' }
    }
    return { kind: 'synthesize' }
  }

  private async executeRound(runId: string, keys: Set<string>, state: RunState): Promise<{ limit: string | null }> {
    const signal = state.controller.signal
    const run = this.run(runId)
    const def = this.get(run.constellationId)
    const coordinator = this.agents.get(def.coordinatorAgentId)
    const running = new Map<string, Promise<void>>()
    const statusOf = (id: string) => this.missions.get(id).status
    let limit: string | null = null
    for (;;) {
      if (signal.aborted) break
      const stopStarting = this.paused(runId) || limit !== null
      const fresh = this.tasks(runId).filter((t) => keys.has(t.spec.key))
      // Started by an earlier drive (restart, time limit) and still waiting for its start approval,
      // or running: awaited and post-processed like any other (never orphaned, never restarted).
      for (const t of fresh) {
        if (running.has(t.missionId) || !(t.status === 'approval_required' || this.missions.isRunning(t.missionId))) continue
        const agent = this.safeAgent(t.agentId)
        if (!agent) continue
        running.set(t.missionId, this.settleTask(runId, coordinator, agent, t, signal).finally(() => running.delete(t.missionId)))
      }
      const todo = stopStarting ? [] : fresh.filter((t) => t.status === 'todo' && !running.has(t.missionId))
      let started = 0
      for (const t of todo) {
        const deps = t.dependsOnMissionIds.map((d) => statusOf(d))
        // A failed dependency leaves the task to do: the user retries or skips (never silently dropped).
        if (!deps.every((s) => s === 'done')) continue
        if (running.size >= this.run(runId).limits.maxParallel) break
        const over = this.overBudget(runId, running.size + 1)
        if (over.over) {
          if (running.size) break // wait for the reservations to settle
          limit = over.reason
          break
        }
        // Shared folder: writers whose scopes overlap run one at a time (readers run in parallel).
        const writer = (t.permissions.writeFiles || t.permissions.runCommands) && !t.spec.readOnly && t.workspace
        const writes = writer ? this.lockScopes(t) : []
        if (writer && def.workspaceMode === 'shared' && [...state.writerLocks.values()].some((l) => l.workspace === t.workspace && scopesOverlap(l.writes, writes))) continue
        if (writer) state.writerLocks.set(t.missionId, { workspace: t.workspace!, writes })
        started++
        running.set(
          t.missionId,
          this.runTask(runId, coordinator, t, signal).finally(() => {
            running.delete(t.missionId)
            state.writerLocks.delete(t.missionId)
          }),
        )
      }
      if (running.size) {
        await Promise.race(running.values())
        continue
      }
      if (!started) break // nothing runnable: done, failed dependencies, paused, or limit
    }
    await Promise.allSettled(running.values())
    await this.refreshConflicts(runId)
    return { limit }
  }

  /**
   * Starts one sub-mission. Everything is re-checked at this moment (a resume may happen long
   * after the plan): member still in the constellation and enabled, permissions = what was
   * granted ∩ today's ceiling ∩ the companion, folder, then the companion's own policy.
   */
  private async runTask(runId: string, coordinator: Agent, t: ConstellationTask, signal: AbortSignal): Promise<void> {
    const fail = (reason: string) => {
      this.db.update(missions).set({ status: 'failed', error: reason, finishedAt: nowIso(), updatedAt: nowIso() }).where(eq(missions.id, t.missionId)).run()
      this.log(runId, 'task.refused', 'error', `« ${t.spec.key} » n’a pas démarré : ${reason}`)
      this.event(runId, 'error', t.agentId, coordinator.id, t.missionId)
      this.bus.invalidate('missions', 'constellations')
    }
    const def = this.get(this.run(runId).constellationId)
    const agent = this.safeAgent(t.agentId)
    if (!agent) return fail('ce compagnon n’existe plus.')
    if (!def.members.some((m) => m.agentId === agent.id)) return fail(`${agent.name} ne fait plus partie de la constellation.`)
    if (!agent.enabled) return fail(`${agent.name} est désactivé.`)
    const row = this.missions.get(t.missionId)
    const ceiling = intersectPermissions(def.permissions, t.spec.readOnly ? { ...def.permissions, writeFiles: false, runCommands: false } : null)
    const perms = intersectPermissions(ceiling, row.permissionsOverride)
    let workspace = t.workspace
    try {
      if (this.providers.engine(agent.providerId) && agent.runtime !== 'remote') workspace = await this.workspaceFor(runId, def, agent, { ...t, permissions: intersectPermissions(agent.permissions, perms) })
    } catch (err) {
      return fail(`espace de travail indisponible (${err instanceof Error ? err.message : String(err)}).`)
    }
    const all = this.tasks(runId)
    const deps = all.filter((x) => t.dependsOnMissionIds.includes(x.missionId)).map((x) => ({ key: x.spec.key, agentName: this.safeAgent(x.agentId)?.name ?? '?', text: x.structured?.summary ? `${x.structured.summary}\n\n${stripProtocol(x.result ?? '')}` : stripProtocol(x.result ?? '') }))
    const h = handoffPrompt({ goal: this.run(runId).goal, spec: t.spec, coordinatorName: coordinator.name, dependencyResults: deps, workspace, permissions: intersectPermissions(agent.permissions, perms) })
    this.db.update(missions).set({ description: h.prompt, permissionsOverride: perms, workspace, updatedAt: nowIso() }).where(eq(missions.id, t.missionId)).run()
    this.handoff(runId, 'delegation', coordinator.id, agent.id, t.missionId, `${coordinator.name} → ${agent.name} : ${t.spec.objective.slice(0, 140)}`, h.prompt, h.redactions)
    this.event(runId, 'delegation', coordinator.id, agent.id, t.missionId)
    try {
      this.missions.start(t.missionId, this.run(runId).origin)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    await this.settleTask(runId, coordinator, agent, t, signal)
  }

  /**
   * Waits for a started sub-mission (start approval included) and records its outcome. Also used
   * for one started by an earlier drive (restart, time limit) and still awaiting its approval.
   */
  private async settleTask(runId: string, coordinator: Agent, agent: Agent, t: ConstellationTask, signal: AbortSignal): Promise<void> {
    await this.waitText(t.missionId, signal)
    const m = this.missions.get(t.missionId)
    if (m.status === 'approval_required') return // drive stopped while it waits: adopted by the next one
    const text = this.lastSettledText(t.missionId) ?? m.result ?? ''
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
      this.log(runId, 'task.done', 'success', `Sous-mission « ${t.spec.key} » terminée par ${agent.name}.`)
    } else {
      this.event(runId, 'error', agent.id, coordinator.id, t.missionId)
      if (m.status === 'failed') this.log(runId, 'task.failed', 'error', `Sous-mission « ${t.spec.key} » (${agent.name}) en échec : ${m.error ?? 'erreur inconnue'}`)
      else if (m.status === 'cancelled') this.log(runId, 'task.cancelled', 'warning', `Sous-mission « ${t.spec.key} » (${agent.name}) arrêtée${m.error ? ` : ${m.error}` : ''}.`)
    }
    this.bus.invalidate('constellations')
  }

  private lastSettledText(missionId: string): string | null {
    const e = this.lastSettled.get(missionId)
    return e && e.executionId === this.lastExecutionId(missionId) ? e.text : null
  }

  /**
   * Budget and token limits, counting what is already spent *and* a reservation for runs
   * in flight (average cost of finished sub-missions, or an even share of the budget).
   */
  private overBudget(runId: string, inFlight = 0): { over: boolean; reason: string | null } {
    const run = this.run(runId)
    const t = this.totals(runId)
    if (run.limits.maxTokens != null && t.tokens >= run.limits.maxTokens) return { over: true, reason: `Limite de jetons atteinte (${t.tokens.toLocaleString('fr-FR')} / ${run.limits.maxTokens.toLocaleString('fr-FR')}).` }
    if (run.limits.maxBudgetUsd != null) {
      // Nothing measured yet (subscription coordinator) still reserves for the tasks about to start.
      const spent = t.costUsd ?? 0
      const finished = this.tasks(runId).filter((x) => x.costUsd != null && TERMINAL_MISSION_STATUSES.includes(x.status))
      const reservation = finished.length ? finished.reduce((s, x) => s + (x.costUsd ?? 0), 0) / finished.length : run.limits.maxBudgetUsd / Math.max(1, run.limits.maxSubtasks)
      if (spent + reservation * inFlight > run.limits.maxBudgetUsd) return { over: true, reason: `Budget de la constellation atteint (${spent.toFixed(2)} $ dépensés, ${(reservation * inFlight).toFixed(2)} $ réservés, limite ${run.limits.maxBudgetUsd.toFixed(2)} $).` }
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

  private finishRun(runId: string, status: 'completed' | 'failed' | 'cancelled', synthesis: string | null, error: string | null) {
    const run = this.run(runId)
    if (TERMINAL_RUN_STATUSES.includes(run.status) && status !== 'cancelled') return
    if (run.status === 'cancelled') return
    this.transition(runId, null, status, { synthesis: synthesis ?? run.synthesis, error, finishedAt: nowIso(), phase: null })
    this.event(runId, status === 'completed' ? 'status' : 'error', null, null, null)
    const route = `/constellations/runs/${runId}`
    if (status === 'completed') {
      this.log(runId, 'run.completed', 'success', 'Mission collective terminée : toutes les étapes obligatoires sont faites.')
      this.journal.activity({ type: 'constellation.completed', level: 'success', agentId: run.coordinatorAgentId, title: `« ${run.constellationName} » a terminé`, detail: run.goal.slice(0, 200) })
      this.journal.notify('mission_done', `Constellation terminée · ${run.constellationName}`, (synthesis ?? '').slice(0, 140) || run.goal.slice(0, 140), route)
    } else if (status === 'failed') {
      this.log(runId, 'run.failed', 'error', error ?? 'Échec.')
      this.journal.activity({ type: 'constellation.failed', level: 'error', agentId: run.coordinatorAgentId, title: `« ${run.constellationName} » a échoué`, detail: error })
      this.journal.notify('mission_failed', `Constellation en échec · ${run.constellationName}`, error ?? '', route)
    } else this.journal.activity({ type: 'constellation.cancelled', agentId: run.coordinatorAgentId, title: `« ${run.constellationName} » annulée`, detail: error })
    this.bus.invalidate('constellations', 'missions')
  }

  private notifyAttention(runId: string, title: string, body: string) {
    const run = this.run(runId)
    this.journal.notify('approval', `${title} · ${run.constellationName}`, body.slice(0, 200), `/constellations/runs/${runId}`)
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
