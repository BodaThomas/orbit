import { and, asc, desc, eq, gte, inArray, isNull, sum } from 'drizzle-orm'
import { TERMINAL_MISSION_STATUSES } from '@shared/mission-states'
import { describeRecurrence, nextOccurrence, validateRecurrence, type Recurrence } from '@shared/schedule'
import type { Automation, AutomationRun, AutomationTrigger, MissedPolicy, Mission } from '@shared/types'
import type { OrbitDb } from '../../infra/db/client'
import { automationDefinitions, automationRuns, automationTriggers, missions } from '../../infra/db/schema'
import type { AgentManager } from '../agents'
import type { ConstellationEngine } from '../constellations/engine'
import type { EventBus } from '../event-bus'
import type { Journal } from '../journal'
import type { MissionManager } from '../missions'
import { newId, nowIso, OrbitError } from '../util'

export interface AutomationInput {
  name: string
  description: string
  targetKind: 'agent' | 'constellation'
  targetId: string
  title: string
  prompt: string
  recurrence: Recurrence | null
  timezone: string
  missedPolicy: MissedPolicy
  maxRunsPerDay: number | null
  triggers: Omit<AutomationTrigger, 'id'>[]
  /** Optional for older callers. */
  maxDurationMin?: number | null
  budgetUsd?: number | null
  failurePolicy?: 'notify' | 'pause'
}

/**
 * Orbit Desktop: automations owned by a runtime are scheduled there. Every action on them
 * is a command to that runtime; this scheduler never fires them.
 */
export interface AutomationRemote {
  push(a: Automation): void
  setStatus(a: Automation, status: 'active' | 'paused'): void
  runNow(a: Automation): void
  confirmRun(a: Automation, runId: string, approve: boolean): void
  release(a: Automation): void
}

/** The only automations this scheduler may fire. */
const OWNED = and(eq(automationDefinitions.schedulerOwner, 'local'), eq(automationDefinitions.ownerState, 'active'))

/** A run is late once its time is this far behind: it is then treated as « missed ». */
const GRACE_MS = 2 * 60_000
const TICK_MS = 15_000
/** Event triggers: at most this many runs per automation per hour, then it pauses itself. */
const MAX_EVENT_RUNS_PER_HOUR = 12

/**
 * Persistent scheduler. Runs inside Orbit's main process: it keeps working while the window
 * is closed (macOS keeps the app alive), but not while the Mac sleeps or Orbit is quit -
 * on wake/launch, missed occurrences follow the automation's explicit policy.
 *
 * Guarantees:
 * - one run per occurrence (unique idempotency key: automation + scheduled instant);
 * - a sensitive target (writes, commands, external actions) is never relaunched without
 *   confirmation after a miss, and an interrupted run is marked « uncertain », never retried;
 * - event triggers have a cooldown, ignore their own runs and pause on runaway repetition.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private unsub: (() => void) | null = null
  private ticking = false
  remote: AutomationRemote | null = null
  /** Last completed tick (health reports). */
  lastTickAt: string | null = null
  get running(): boolean {
    return this.timer !== null
  }

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private agents: AgentManager,
    private missions: MissionManager,
    private constellations: ConstellationEngine,
    private now: () => number = Date.now,
  ) {}

  // Lifecycle

  start(): void {
    this.recoverOnLaunch()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    this.unsub = this.bus.on((e) => {
      if (e.type === 'mission.event' && ['completed', 'failed', 'cancelled'].includes(e.event.type)) this.onMissionFinished(e.event.missionId)
    })
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.unsub?.()
    this.timer = null
    this.unsub = null
  }

  /**
   * At launch: interrupted runs are uncertain (never retried automatically) and past
   * occurrences follow the missed-run policy. Called before the first tick.
   */
  recoverOnLaunch(): void {
    const ts = nowIso()
    for (const r of this.db.select().from(automationRuns).where(and(eq(automationRuns.status, 'running'), isNull(automationRuns.machineId))).all()) {
      const done = this.targetOutcome(r)
      if (done) this.closeRun(r.id, done.status, done.note)
      else this.db.update(automationRuns).set({ status: 'uncertain', note: 'Orbit a été fermé pendant l’exécution : résultat incertain, rien n’est relancé automatiquement.', finishedAt: ts }).where(eq(automationRuns.id, r.id)).run()
    }
    this.handleMissed()
  }

  // Queries

  list(): Automation[] {
    return this.db.select().from(automationDefinitions).orderBy(asc(automationDefinitions.createdAt)).all().map((r) => this.toAutomation(r))
  }

  get(id: string): Automation {
    const r = this.db.select().from(automationDefinitions).where(eq(automationDefinitions.id, id)).get()
    if (!r) throw new OrbitError('not_found', 'Automatisation introuvable.')
    return this.toAutomation(r)
  }

  runs(automationId?: string, limit = 100): AutomationRun[] {
    return this.db
      .select()
      .from(automationRuns)
      .where(automationId ? eq(automationRuns.automationId, automationId) : undefined)
      .orderBy(desc(automationRuns.createdAt))
      .limit(limit)
      .all()
      .map((r) => this.toRun(r))
  }

  /** Is the target allowed to modify things? Then it is never relaunched blindly. */
  private isSensitive(kind: string, targetId: string): boolean {
    try {
      if (kind === 'agent') {
        const p = this.agents.get(targetId).permissions
        return p.writeFiles || p.runCommands || p.externalActions
      }
      const def = this.constellations.get(targetId)
      return def.permissions.writeFiles || def.permissions.runCommands || def.permissions.externalActions
    } catch {
      return true
    }
  }

  private toAutomation(r: typeof automationDefinitions.$inferSelect): Automation {
    const triggers = this.db.select().from(automationTriggers).where(eq(automationTriggers.automationId, r.id)).all()
    const last = this.db.select().from(automationRuns).where(eq(automationRuns.automationId, r.id)).orderBy(desc(automationRuns.createdAt)).limit(1).get()
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      targetKind: r.targetKind === 'constellation' ? 'constellation' : 'agent',
      targetId: r.targetId,
      title: r.title,
      prompt: r.prompt,
      recurrence: r.recurrence ?? null,
      timezone: r.timezone,
      status: r.status as Automation['status'],
      missedPolicy: r.missedPolicy as MissedPolicy,
      maxRunsPerDay: r.maxRunsPerDay,
      nextRunAt: r.nextRunAt,
      lastRunAt: r.lastRunAt,
      triggers: triggers.map((t) => ({ id: t.id, kind: t.kind as AutomationTrigger['kind'], sourceAgentId: t.sourceAgentId, sourceAutomationId: t.sourceAutomationId, cooldownSec: t.cooldownSec })),
      sensitive: this.isSensitive(r.targetKind, r.targetId),
      lastRun: last ? this.toRun(last) : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      schedulerOwner: r.schedulerOwner,
      ownerState: r.ownerState === 'transferring' ? 'transferring' : 'active',
      pendingOwner: r.pendingOwner,
      configVersion: r.configVersion,
      maxDurationMin: r.maxDurationMin,
      budgetUsd: r.budgetUsd,
      failurePolicy: r.failurePolicy === 'pause' ? 'pause' : 'notify',
    }
  }

  private toRun(r: typeof automationRuns.$inferSelect): AutomationRun {
    return { ...r, trigger: r.trigger as AutomationRun['trigger'], status: r.status as AutomationRun['status'], machineId: r.machineId ?? null }
  }

  // Commands

  private validate(input: AutomationInput) {
    if (!input.recurrence && !input.triggers.length) throw new OrbitError('validation', 'Choisissez une récurrence ou un déclencheur.')
    if (input.recurrence) {
      const err = validateRecurrence(input.recurrence, input.timezone)
      if (err) throw new OrbitError('validation', err)
    }
    if (input.targetKind === 'agent') this.agents.get(input.targetId)
    else this.constellations.get(input.targetId)
  }

  create(input: AutomationInput): Automation {
    this.validate(input)
    const id = newId()
    const ts = nowIso()
    const next = input.recurrence ? nextOccurrence(input.recurrence, input.timezone, this.now()) : null
    this.db.transaction((tx) => {
      tx.insert(automationDefinitions).values({ id, name: input.name, description: input.description, targetKind: input.targetKind, targetId: input.targetId, title: input.title, prompt: input.prompt, recurrence: input.recurrence, timezone: input.timezone, status: 'active', missedPolicy: input.missedPolicy, maxRunsPerDay: input.maxRunsPerDay, nextRunAt: next?.toISOString() ?? null, maxDurationMin: input.maxDurationMin ?? null, budgetUsd: input.budgetUsd ?? null, failurePolicy: input.failurePolicy ?? 'notify', createdAt: ts, updatedAt: ts }).run()
      for (const t of input.triggers) tx.insert(automationTriggers).values({ id: newId(), automationId: id, kind: t.kind, sourceAgentId: t.sourceAgentId, sourceAutomationId: t.sourceAutomationId, cooldownSec: Math.max(60, t.cooldownSec), createdAt: ts }).run()
    })
    this.journal.audit({ actor: 'user', agentId: input.targetKind === 'agent' ? input.targetId : null, action: 'automation.create', target: input.name, allowed: true, reason: input.recurrence ? describeRecurrence(input.recurrence) : 'déclencheur' })
    this.bus.invalidate('automations')
    return this.get(id)
  }

  update(id: string, input: AutomationInput): Automation {
    const before = this.get(id)
    if (before.ownerState === 'transferring') throw new OrbitError('conflict', 'Transfert en cours : attendez sa confirmation avant de modifier cette automatisation.')
    this.validate(input)
    const remote = before.schedulerOwner !== 'local'
    const next = input.recurrence ? nextOccurrence(input.recurrence, input.timezone, this.now()) : null
    this.db.transaction((tx) => {
      // A runtime-owned automation keeps its runtime-computed schedule until the runtime answers.
      tx.update(automationDefinitions).set({ name: input.name, description: input.description, targetKind: input.targetKind, targetId: input.targetId, title: input.title, prompt: input.prompt, recurrence: input.recurrence, timezone: input.timezone, missedPolicy: input.missedPolicy, maxRunsPerDay: input.maxRunsPerDay, ...(remote ? {} : { nextRunAt: next?.toISOString() ?? null }), maxDurationMin: input.maxDurationMin ?? null, budgetUsd: input.budgetUsd ?? null, failurePolicy: input.failurePolicy ?? 'notify', configVersion: before.configVersion + 1, updatedAt: nowIso() }).where(eq(automationDefinitions.id, id)).run()
      tx.delete(automationTriggers).where(eq(automationTriggers.automationId, id)).run()
      for (const t of input.triggers) tx.insert(automationTriggers).values({ id: newId(), automationId: id, kind: t.kind, sourceAgentId: t.sourceAgentId, sourceAutomationId: t.sourceAutomationId, cooldownSec: Math.max(60, t.cooldownSec), createdAt: nowIso() }).run()
    })
    const after = this.get(id)
    if (remote) this.requireRemote().push(after)
    this.bus.invalidate('automations')
    return after
  }

  delete(id: string): void {
    const a = this.get(id)
    if (a.ownerState === 'transferring') throw new OrbitError('conflict', 'Transfert en cours : attendez sa confirmation.')
    // Never leave a runtime firing an automation Orbit no longer shows: release it first.
    if (a.schedulerOwner !== 'local') this.requireRemote().release(a)
    this.db.delete(automationDefinitions).where(eq(automationDefinitions.id, id)).run()
    this.bus.invalidate('automations')
  }

  private requireRemote(): AutomationRemote {
    if (!this.remote) throw new OrbitError('provider', 'Planificateur distant indisponible.')
    return this.remote
  }

  /**
   * Runtime host: stores Orbit's definition under Orbit's id. The runtime then owns the
   * schedule (next/last run) and fires it; `released` ones are kept for history only.
   */
  upsertFromOrbit(id: string, input: AutomationInput & { status: 'active' | 'paused'; configVersion: number }): Automation {
    this.validate(input)
    const existing = this.db.select().from(automationDefinitions).where(eq(automationDefinitions.id, id)).get()
    const ts = nowIso()
    const sameSchedule = existing && JSON.stringify(existing.recurrence) === JSON.stringify(input.recurrence) && existing.timezone === input.timezone && existing.status === input.status && existing.schedulerOwner === 'local'
    const next = input.status === 'active' && input.recurrence ? (sameSchedule && existing?.nextRunAt ? new Date(existing.nextRunAt) : nextOccurrence(input.recurrence, input.timezone, this.now())) : null
    const values = { name: input.name, description: input.description, targetKind: input.targetKind, targetId: input.targetId, title: input.title, prompt: input.prompt, recurrence: input.recurrence, timezone: input.timezone, status: input.recurrence && input.status === 'active' && !next ? 'completed' : input.status, missedPolicy: input.missedPolicy, maxRunsPerDay: input.maxRunsPerDay, nextRunAt: next?.toISOString() ?? null, maxDurationMin: input.maxDurationMin ?? null, budgetUsd: input.budgetUsd ?? null, failurePolicy: input.failurePolicy ?? 'notify', configVersion: input.configVersion, schedulerOwner: 'local', ownerState: 'active', updatedAt: ts }
    this.db.transaction((tx) => {
      if (existing) tx.update(automationDefinitions).set(values).where(eq(automationDefinitions.id, id)).run()
      else tx.insert(automationDefinitions).values({ id, ...values, createdAt: ts }).run()
      tx.delete(automationTriggers).where(eq(automationTriggers.automationId, id)).run()
      for (const t of input.triggers) tx.insert(automationTriggers).values({ id: newId(), automationId: id, kind: t.kind, sourceAgentId: t.sourceAgentId, sourceAutomationId: t.sourceAutomationId, cooldownSec: Math.max(60, t.cooldownSec), createdAt: ts }).run()
    })
    this.bus.invalidate('automations')
    return this.get(id)
  }

  /** Runtime host: stops firing (transfer back to the Mac, deletion in Orbit). History is kept. */
  release(id: string): Automation {
    this.get(id)
    this.db.update(automationDefinitions).set({ schedulerOwner: 'released', status: 'paused', nextRunAt: null, updatedAt: nowIso() }).where(eq(automationDefinitions.id, id)).run()
    this.bus.invalidate('automations')
    return this.get(id)
  }

  setStatus(id: string, status: 'active' | 'paused'): Automation {
    const a = this.get(id)
    if (a.ownerState === 'transferring') throw new OrbitError('conflict', 'Transfert en cours : attendez sa confirmation.')
    if (a.schedulerOwner !== 'local') {
      this.requireRemote().setStatus(a, status)
      return a
    }
    // Resuming recomputes from now: paused occurrences are not replayed.
    const next = status === 'active' && a.recurrence ? nextOccurrence(a.recurrence, a.timezone, this.now()) : a.nextRunAt ? new Date(a.nextRunAt) : null
    this.db.update(automationDefinitions).set({ status: status === 'active' && a.recurrence && !next ? 'completed' : status, nextRunAt: next?.toISOString() ?? null, updatedAt: nowIso() }).where(eq(automationDefinitions.id, id)).run()
    this.journal.audit({ actor: 'user', agentId: null, action: `automation.${status === 'active' ? 'resume' : 'pause'}`, target: a.name, allowed: true, reason: null })
    this.bus.invalidate('automations')
    return this.get(id)
  }

  runNow(id: string): AutomationRun | null {
    const a = this.get(id)
    if (a.ownerState === 'transferring') throw new OrbitError('conflict', 'Transfert en cours : attendez sa confirmation.')
    if (a.schedulerOwner !== 'local') {
      this.requireRemote().runNow(a)
      return null
    }
    return this.fire(a, new Date(this.now()).toISOString(), 'manual', `manual:${id}:${this.now()}`)
  }

  /** The user's answer to « run this missed occurrence? ». */
  confirmRun(runId: string, approve: boolean): AutomationRun {
    const r = this.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).get()
    if (!r) throw new OrbitError('not_found', 'Exécution introuvable.')
    if (r.status !== 'pending_confirmation') throw new OrbitError('conflict', 'Cette exécution a déjà été traitée.')
    if (r.machineId) {
      this.requireRemote().confirmRun(this.get(r.automationId), runId, approve)
      return this.toRun(r)
    }
    if (!approve) {
      this.closeRun(r.id, 'skipped', 'Ignorée à votre demande.')
      return this.toRun(this.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).get()!)
    }
    const a = this.get(r.automationId)
    this.launchInto(a, r.id)
    return this.toRun(this.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).get()!)
  }

  // The clock

  /** Fires every due occurrence once. Safe to call any time (wake, timer, tests). */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      this.refreshRunning()
      const now = this.now()
      const due = this.db.select().from(automationDefinitions).where(and(eq(automationDefinitions.status, 'active'), OWNED)).all().filter((r) => r.nextRunAt && Date.parse(r.nextRunAt) <= now)
      for (const r of due) {
        const a = this.toAutomation(r)
        const late = now - Date.parse(r.nextRunAt!) > GRACE_MS
        if (late) {
          this.handleMissed()
          continue
        }
        this.fire(a, r.nextRunAt!, 'schedule', `${a.id}:${r.nextRunAt}`)
        this.advance(a)
      }
      this.lastTickAt = new Date(now).toISOString()
    } finally {
      this.ticking = false
    }
  }

  private advance(a: Automation) {
    if (!a.recurrence) return
    const next = nextOccurrence(a.recurrence, a.timezone, this.now())
    this.db.update(automationDefinitions).set({ nextRunAt: next?.toISOString() ?? null, status: next ? 'active' : 'completed', updatedAt: nowIso() }).where(eq(automationDefinitions.id, a.id)).run()
    this.bus.invalidate('automations')
  }

  /** Past occurrences (Mac asleep, Orbit closed) → one decision per automation, never a burst. */
  private handleMissed() {
    const now = this.now()
    for (const r of this.db.select().from(automationDefinitions).where(and(eq(automationDefinitions.status, 'active'), OWNED)).all()) {
      if (!r.nextRunAt || now - Date.parse(r.nextRunAt) <= GRACE_MS) continue
      const a = this.toAutomation(r)
      const key = `${a.id}:${r.nextRunAt}`
      const when = new Date(r.nextRunAt).toLocaleString('fr-FR', { timeZone: a.timezone, dateStyle: 'medium', timeStyle: 'short' })
      // A sensitive target is never relaunched without a human, whatever the policy says.
      const policy: MissedPolicy = a.missedPolicy === 'run_once' && a.sensitive ? 'ask' : a.missedPolicy
      if (policy === 'skip') {
        this.insertRun(a.id, r.nextRunAt, 'missed', 'skipped', key, `Exécution du ${when} manquée (${this.downtimeLabel}) : ignorée selon votre réglage.`)
        this.journal.activity({ type: 'automation.skipped', level: 'warning', title: `« ${a.name} » : exécution manquée ignorée`, detail: when })
      } else if (policy === 'run_once') {
        this.fire(a, r.nextRunAt, 'missed', key)
      } else {
        const id = this.insertRun(a.id, r.nextRunAt, 'missed', 'pending_confirmation', key, `Exécution du ${when} manquée (${this.downtimeLabel})${a.missedPolicy === 'run_once' && a.sensitive ? ' : la cible peut modifier des fichiers, Orbit attend votre confirmation' : ''}.`)
        if (id) this.journal.notify('approval', `« ${a.name} » a été reportée`, `L’exécution prévue le ${when} n’a pas eu lieu. La lancer maintenant ?`, `/automations?run=${id}`)
      }
      this.advance(a)
    }
  }

  /** Wording for missed runs (« Mac éteint ou Orbit fermé » vs « runtime arrêté »). */
  downtimeLabel = 'Mac éteint ou Orbit fermé'

  /** API spend of this automation's runs over the last 24 h (measured or estimated; subscriptions unknown). */
  private spentLast24h(automationId: string): number {
    const since = new Date(this.now() - 86400_000).toISOString()
    const ids = this.db.select({ id: automationRuns.missionId }).from(automationRuns).where(and(eq(automationRuns.automationId, automationId), gte(automationRuns.createdAt, since))).all().map((r) => r.id).filter((x): x is string => Boolean(x))
    if (!ids.length) return 0
    const row = this.db.select({ total: sum(missions.costUsd) }).from(missions).where(inArray(missions.id, ids)).get()
    return Number(row?.total ?? 0)
  }

  /** Records the occurrence (idempotent) and launches its target. */
  private fire(a: Automation, scheduledFor: string, trigger: AutomationRun['trigger'], key: string): AutomationRun {
    if (a.budgetUsd != null && this.spentLast24h(a.id) >= a.budgetUsd) {
      const id = this.insertRun(a.id, scheduledFor, trigger, 'skipped', key, `Budget de l’automatisation atteint (${a.budgetUsd} $ sur 24 h).`)
      if (id) this.journal.notify('budget', `« ${a.name} » : budget atteint`, `Exécution ignorée : ${a.budgetUsd} $ dépensés sur 24 h.`, '/automations', `budget:${a.id}:${scheduledFor}`)
      return this.toRun(this.db.select().from(automationRuns).where(eq(automationRuns.idempotencyKey, key)).get()!)
    }
    if (a.maxRunsPerDay != null) {
      const since = new Date(this.now() - 86400_000).toISOString()
      const count = this.db.select().from(automationRuns).where(and(eq(automationRuns.automationId, a.id), gte(automationRuns.createdAt, since), inArray(automationRuns.status, ['running', 'done', 'failed', 'uncertain']))).all().length
      if (count >= a.maxRunsPerDay) {
        const id = this.insertRun(a.id, scheduledFor, trigger, 'skipped', key, `Limite de ${a.maxRunsPerDay} exécution(s) par jour atteinte.`)
        return this.toRun(this.db.select().from(automationRuns).where(eq(automationRuns.id, id ?? '')).get() ?? { id: '', automationId: a.id, scheduledFor, trigger, status: 'skipped', missionId: null, constellationRunId: null, note: null, idempotencyKey: key, startedAt: null, finishedAt: null, createdAt: nowIso(), machineId: null })
      }
    }
    const id = this.insertRun(a.id, scheduledFor, trigger, 'running', key, null)
    if (!id) {
      // Already fired for this occurrence (restart, double tick): never twice.
      return this.toRun(this.db.select().from(automationRuns).where(eq(automationRuns.idempotencyKey, key)).get()!)
    }
    this.launchInto(a, id)
    return this.toRun(this.db.select().from(automationRuns).where(eq(automationRuns.id, id)).get()!)
  }

  private insertRun(automationId: string, scheduledFor: string, trigger: AutomationRun['trigger'], status: AutomationRun['status'], key: string, note: string | null): string | null {
    const id = newId()
    try {
      this.db.insert(automationRuns).values({ id, automationId, scheduledFor, trigger, status, idempotencyKey: key, note, createdAt: nowIso(), startedAt: status === 'running' ? nowIso() : null, finishedAt: status === 'skipped' ? nowIso() : null }).run()
    } catch {
      return null
    }
    this.bus.invalidate('automations')
    return id
  }

  private launchInto(a: Automation, runId: string) {
    const ts = nowIso()
    try {
      if (a.targetKind === 'agent') {
        const m = this.missions.create({ title: a.title, description: a.prompt, agentId: a.targetId, priority: 'normal', startNow: true, origin: 'automation' })
        this.db.update(automationRuns).set({ status: 'running', missionId: m.id, startedAt: ts }).where(eq(automationRuns.id, runId)).run()
        if (m.status === 'approval_required') this.journal.notify('approval', `« ${a.name} » attend votre accord`, `${a.title} : démarrage à approuver.`, `/missions/${m.id}`)
      } else {
        const run = this.constellations.launch(a.targetId, `${a.title}\n\n${a.prompt}`, { origin: 'automation', idempotencyKey: `automation:${runId}` })
        this.db.update(automationRuns).set({ status: 'running', constellationRunId: run.id, startedAt: ts }).where(eq(automationRuns.id, runId)).run()
      }
      this.db.update(automationDefinitions).set({ lastRunAt: ts }).where(eq(automationDefinitions.id, a.id)).run()
      this.journal.activity({ type: 'automation.started', agentId: a.targetKind === 'agent' ? a.targetId : null, title: `Automatisation « ${a.name} » démarrée`, detail: a.title })
      this.journal.notify('mission_done', `Mission planifiée démarrée · ${a.name}`, a.title, '/automations')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.closeRun(runId, 'failed', msg)
    }
    this.bus.invalidate('automations')
  }

  /** Reads the target's state to close finished runs (missions and constellation runs). */
  private refreshRunning() {
    for (const r of this.db.select().from(automationRuns).where(and(eq(automationRuns.status, 'running'), isNull(automationRuns.machineId))).all()) {
      const out = this.targetOutcome(r)
      if (out) {
        this.closeRun(r.id, out.status, out.note)
        continue
      }
      // Duration limit: the target is stopped, the run is marked failed with the reason.
      const def = this.db.select({ max: automationDefinitions.maxDurationMin }).from(automationDefinitions).where(eq(automationDefinitions.id, r.automationId)).get()
      if (def?.max && r.startedAt && this.now() - Date.parse(r.startedAt) > def.max * 60_000) {
        try {
          if (r.missionId) this.missions.cancel(r.missionId)
          else if (r.constellationRunId) this.constellations.cancel(r.constellationRunId)
        } catch {
          /* already finished */
        }
        this.closeRun(r.id, 'failed', `Durée maximale atteinte (${def.max} min) : arrêtée.`)
      }
    }
  }

  private targetOutcome(r: typeof automationRuns.$inferSelect): { status: AutomationRun['status']; note: string | null } | null {
    try {
      if (r.missionId) {
        const m: Mission = this.missions.get(r.missionId)
        if (this.missions.isRunning(m.id) || !TERMINAL_MISSION_STATUSES.includes(m.status)) return null
        return { status: m.status === 'done' ? 'done' : m.status === 'cancelled' ? 'cancelled' : 'failed', note: m.error }
      }
      if (r.constellationRunId) {
        const run = this.constellations.run(r.constellationRunId)
        if (['planning', 'running', 'synthesizing'].includes(run.status)) return null
        return { status: run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'cancelled' : run.status === 'interrupted' ? 'uncertain' : 'failed', note: run.error }
      }
    } catch {
      return { status: 'cancelled', note: 'Cible supprimée.' }
    }
    return null
  }

  private closeRun(id: string, status: AutomationRun['status'], note: string | null) {
    const r = this.db.select().from(automationRuns).where(eq(automationRuns.id, id)).get()
    if (!r) return
    this.db.update(automationRuns).set({ status, note: note ?? r.note, finishedAt: nowIso() }).where(eq(automationRuns.id, id)).run()
    const a = this.db.select().from(automationDefinitions).where(eq(automationDefinitions.id, r.automationId)).get()
    if (a && (status === 'done' || status === 'failed')) {
      this.journal.activity({ type: status === 'done' ? 'automation.completed' : 'automation.failed', level: status === 'done' ? 'success' : 'error', title: `« ${a.name} » ${status === 'done' ? 'a terminé' : 'a échoué'}`, detail: note })
      this.journal.notify(status === 'done' ? 'mission_done' : 'mission_failed', `${status === 'done' ? 'Mission planifiée terminée' : 'Mission planifiée échouée'} · ${a.name}`, note ?? a.title, r.missionId ? `/missions/${r.missionId}` : r.constellationRunId ? `/constellations/runs/${r.constellationRunId}` : '/automations')
      if (status === 'done') this.fireEventTriggers('automation.completed', { automationId: a.id, eventId: r.id })
      if (status === 'failed' && a.failurePolicy === 'pause' && a.status === 'active') {
        this.db.update(automationDefinitions).set({ status: 'paused', updatedAt: nowIso() }).where(eq(automationDefinitions.id, a.id)).run()
        this.journal.activity({ type: 'automation.paused', level: 'warning', title: `« ${a.name} » mise en pause après un échec`, detail: note })
      }
    }
    this.bus.invalidate('automations')
  }

  // Event triggers

  private onMissionFinished(missionId: string) {
    this.refreshRunning()
    let m: Mission
    try {
      m = this.missions.get(missionId)
    } catch {
      return
    }
    if (m.status === 'done') this.fireEventTriggers('mission.completed', { agentId: m.agentId, eventId: `${m.id}:${m.updatedAt}`, missionId: m.id })
    if (m.status === 'failed') this.fireEventTriggers('mission.failed', { agentId: m.agentId, eventId: `${m.id}:${m.updatedAt}`, missionId: m.id })
  }

  private fireEventTriggers(kind: AutomationTrigger['kind'], ev: { agentId?: string; automationId?: string; eventId: string; missionId?: string }) {
    const triggers = this.db.select().from(automationTriggers).where(eq(automationTriggers.kind, kind)).all()
    for (const t of triggers) {
      if (t.sourceAgentId && t.sourceAgentId !== ev.agentId) continue
      if (t.sourceAutomationId && t.sourceAutomationId !== ev.automationId) continue
      const def = this.db.select().from(automationDefinitions).where(eq(automationDefinitions.id, t.automationId)).get()
      if (!def || def.status !== 'active' || def.schedulerOwner !== 'local' || def.ownerState !== 'active') continue
      // Loop protection 1: an automation never reacts to its own runs.
      if (ev.automationId === def.id) continue
      if (ev.missionId && this.db.select().from(automationRuns).where(and(eq(automationRuns.automationId, def.id), eq(automationRuns.missionId, ev.missionId))).get()) continue
      // Loop protection 2: cooldown and hourly cap (then the automation pauses itself).
      const recent = this.db.select().from(automationRuns).where(and(eq(automationRuns.automationId, def.id), eq(automationRuns.trigger, 'event'), gte(automationRuns.createdAt, new Date(this.now() - 3600_000).toISOString()))).all()
      if (recent.some((r) => this.now() - Date.parse(r.createdAt) < t.cooldownSec * 1000)) continue
      if (recent.length >= MAX_EVENT_RUNS_PER_HOUR) {
        this.db.update(automationDefinitions).set({ status: 'paused' }).where(eq(automationDefinitions.id, def.id)).run()
        this.journal.notify('agent', `« ${def.name} » mise en pause`, `Plus de ${MAX_EVENT_RUNS_PER_HOUR} déclenchements en une heure : répétition anormale.`, '/automations')
        continue
      }
      this.fire(this.toAutomation(def), new Date(this.now()).toISOString(), 'event', `event:${def.id}:${ev.eventId}`)
    }
  }
}
