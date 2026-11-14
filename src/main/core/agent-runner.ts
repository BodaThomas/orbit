import { and, eq } from 'drizzle-orm'
import type { Agent, ExecutionEvent, LiveActivity, Mission, ToolCall } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { toApproval, toExecutionEvent, toToolCall } from '../infra/db/mappers'
import { approvalRequests, executionEvents, fileChanges, missions, toolCalls } from '../infra/db/schema'
import type { AgentManager } from './agents'
import type { AgentEngine, ApprovalAsk, EngineEvent, EngineId, EngineRunResult, UsageReport } from './engine/types'
import type { EventBus } from './event-bus'
import type { Journal } from './journal'
import type { UsageTracker } from './usage'
import { newId, nowIso } from './util'

export interface AgentRunJob {
  mission: Mission
  agent: Agent
  engine: AgentEngine
  executionId: string
  prompt: string
  instructions: string
  secret: string | null
  budgetUsd: number | null
  signal: AbortSignal
  /** Called when the run starts or stops waiting on a human. */
  onWaiting(waiting: boolean): void
}

export interface AgentRunOutcome extends EngineRunResult {
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; costKind: UsageReport['costKind'] | null }
}

/**
 * Runs one engine turn for a mission and turns its normalised events into Orbit state:
 * tool call rows, file changes, approval requests, timeline events, live activity, usage.
 */
export class AgentRunner {
  /** approvalId → resolver of the engine's pending question. */
  private pendingApprovals = new Map<string, { missionId: string; resolve: (ok: boolean, cancelled?: boolean) => void }>()

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private agents: AgentManager,
    private usage: UsageTracker,
  ) {}

  hasPendingApproval(approvalId: string): boolean {
    return this.pendingApprovals.has(approvalId)
  }

  /** Returns false if no live run is waiting on this approval (e.g. after a restart). */
  resolveApproval(approvalId: string, approved: boolean): boolean {
    const p = this.pendingApprovals.get(approvalId)
    if (!p) return false
    this.pendingApprovals.delete(approvalId)
    p.resolve(approved)
    return true
  }

  /** Every pending question of a mission is answered « no » (cancel, delete, shutdown). */
  denyAllFor(missionId: string): void {
    for (const [id, p] of this.pendingApprovals) {
      if (p.missionId !== missionId) continue
      this.pendingApprovals.delete(id)
      this.db.update(approvalRequests).set({ status: 'expired', resolvedAt: nowIso() }).where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending'))).run()
      p.resolve(false, true)
    }
    this.bus.invalidate('approvals')
  }

  async run(job: AgentRunJob): Promise<AgentRunOutcome> {
    const { mission, agent, executionId } = job
    const missionId = mission.id
    const toolIds = new Map<string, string>()
    const totals = { inputTokens: 0, outputTokens: 0, costUsd: null as number | null, costKind: null as UsageReport['costKind'] | null }
    let sessionId = mission.sessionId
    let waiting = 0

    const setActivity = (phase: LiveActivity['phase'], label: string, toolCallId: string | null = null) => {
      const activity: LiveActivity = { missionId, phase, label, toolCallId, since: nowIso() }
      this.bus.emit({ type: 'mission.activity', missionId, activity })
      this.agents.setStatus(agent.id, phase === 'approval' ? 'awaiting_approval' : 'working', label.slice(0, 120))
    }
    const event = (type: ExecutionEvent['type'], message: string, data: Record<string, unknown> | null = null) => {
      const row = { id: newId(), missionId, executionId, type, message, data, createdAt: nowIso() }
      this.db.insert(executionEvents).values(row).run()
      this.bus.emit({ type: 'mission.event', event: toExecutionEvent(row) })
    }
    const pushTool = (id: string) => {
      const row = this.db.select().from(toolCalls).where(eq(toolCalls.id, id)).get()
      if (row) this.bus.emit({ type: 'mission.tool', toolCall: toToolCall(row) })
    }
    const ensureTool = (t: { externalId: string; name: string; kind: ToolCall['kind']; title: string; input: unknown; files: string[] }): string => {
      const known = toolIds.get(t.externalId)
      if (known) return known
      const id = newId()
      toolIds.set(t.externalId, id)
      this.db
        .insert(toolCalls)
        .values({ id, executionId, missionId, agentId: agent.id, externalId: t.externalId, name: t.name, kind: t.kind, title: t.title, input: t.input ?? null, files: t.files, status: 'running', createdAt: nowIso() })
        .run()
      if (t.kind !== 'plan') event('tool', t.title, { toolCallId: id, kind: t.kind })
      pushTool(id)
      return id
    }

    const onEvent = (e: EngineEvent) => {
      switch (e.type) {
        case 'session':
          if (e.sessionId !== sessionId) {
            sessionId = e.sessionId
            this.db.update(missions).set({ sessionId: e.sessionId, updatedAt: nowIso() }).where(eq(missions.id, missionId)).run()
            event('session', `Session ${job.engine.name} ${e.sessionId.slice(0, 8)}${e.model ? ` · ${e.model}` : ''}`, { sessionId: e.sessionId, model: e.model })
            this.bus.invalidate('missions')
          }
          return
        case 'status':
          if (!waiting) setActivity(e.phase, e.label)
          return
        case 'message.delta':
          this.bus.emit({ type: 'mission.delta', missionId, executionId, delta: e.text })
          return
        case 'message':
          event('message', e.text)
          return
        case 'tool.started': {
          const id = ensureTool(e.tool)
          if (!waiting) setActivity('tool', e.tool.kind === 'command' ? `Exécute ${e.tool.title}` : e.tool.title, id)
          return
        }
        case 'tool.completed': {
          const id = toolIds.get(e.tool.externalId)
          if (!id) return
          const current = this.db.select({ status: toolCalls.status }).from(toolCalls).where(eq(toolCalls.id, id)).get()
          // A refusal is final: the engine's later « error » result must not overwrite it.
          const status = current?.status === 'denied' || current?.status === 'cancelled' ? current.status : e.tool.status
          const patch: Partial<typeof toolCalls.$inferInsert> = { status, finishedAt: nowIso() }
          if (e.tool.output !== undefined) patch.output = e.tool.output
          if (e.tool.exitCode !== undefined) patch.exitCode = e.tool.exitCode
          if (e.tool.files) patch.files = e.tool.files
          this.db.update(toolCalls).set(patch).where(eq(toolCalls.id, id)).run()
          pushTool(id)
          return
        }
        case 'file.changed':
          this.db.insert(fileChanges).values({ id: newId(), missionId, executionId, path: e.change.path, kind: e.change.kind, diff: e.change.diff, createdAt: nowIso() }).run()
          event('file', e.change.path, { kind: e.change.kind })
          this.journal.activity({ type: 'file.written', agentId: agent.id, missionId, title: `${agent.name} a modifié un fichier`, detail: e.change.path })
          this.bus.invalidate('missions')
          return
        case 'usage': {
          const u = e.usage
          const cost = this.usage.record({
            agentId: agent.id,
            providerId: job.engine.id,
            model: u.model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            source: 'mission',
            cost: u.costKind === 'estimated' && u.costUsd != null ? { costUsd: u.costUsd, costKind: 'estimated', pricingVersion: `${job.engine.id}-sdk` } : u.costKind === 'subscription' ? { costUsd: null, costKind: 'subscription', pricingVersion: null } : undefined,
          })
          totals.inputTokens += u.inputTokens
          totals.outputTokens += u.outputTokens
          if (cost.costUsd != null) totals.costUsd = (totals.costUsd ?? 0) + cost.costUsd
          totals.costKind = totals.costKind && totals.costKind !== cost.costKind ? 'unknown' : cost.costKind
          event('usage', `${u.model} · ${u.inputTokens.toLocaleString('fr-FR')} jetons en entrée${u.cachedInputTokens ? ` (+${u.cachedInputTokens.toLocaleString('fr-FR')} en cache)` : ''} · ${u.outputTokens.toLocaleString('fr-FR')} en sortie`, { ...u, costUsd: cost.costUsd, costKind: cost.costKind })
          return
        }
        case 'warning':
          event('warning', e.message)
          return
      }
    }

    const requestApproval = (ask: ApprovalAsk): Promise<boolean> => {
      if (job.signal.aborted) return Promise.resolve(false)
      const toolCallId = ensureTool(ask.tool)
      this.db.update(toolCalls).set({ status: 'awaiting_approval' }).where(eq(toolCalls.id, toolCallId)).run()
      pushTool(toolCallId)
      const id = newId()
      const summary = `${agent.name} : ${ask.summary}`
      this.db
        .insert(approvalRequests)
        .values({ id, agentId: agent.id, missionId, executionId, toolCallId, kind: 'tool_use', summary, detail: ask.payload.reason ?? null, payload: ask.payload, status: 'pending', createdAt: nowIso() })
        .run()
      event('approval', `Demande de validation : ${ask.summary}`, { approvalId: id, toolCallId })
      this.journal.activity({ type: 'approval.requested', level: 'warning', agentId: agent.id, missionId, title: 'Validation demandée', detail: summary })
      this.journal.notify('approval', `${agent.name} attend votre accord`, ask.summary, `/missions/${missionId}`)
      waiting++
      if (waiting === 1) job.onWaiting(true)
      setActivity('approval', `Attend votre accord : ${ask.summary}`, toolCallId)
      this.bus.invalidate('approvals')
      return new Promise<boolean>((resolve) => {
        this.pendingApprovals.set(id, {
          missionId,
          resolve: (ok, cancelled = false) => {
            waiting--
            if (waiting === 0) job.onWaiting(false)
            // Orbit records the human decision itself: the engine's later report cannot overwrite it.
            const status = ok ? 'running' : cancelled ? 'cancelled' : 'denied'
            this.db
              .update(toolCalls)
              .set({ status, ...(ok ? {} : { finishedAt: nowIso(), output: cancelled ? 'Mission arrêtée avant votre réponse.' : 'Refusé par l’utilisateur.' }) })
              .where(eq(toolCalls.id, toolCallId))
              .run()
            pushTool(toolCallId)
            if (ok) setActivity('tool', ask.summary, toolCallId)
            event('approval', ok ? `Approuvé : ${ask.summary}` : cancelled ? `Sans réponse (mission arrêtée) : ${ask.summary}` : `Refusé : ${ask.summary}`, { approvalId: id, toolCallId, approved: ok })
            resolve(ok)
          },
        })
      })
    }

    setActivity('starting', `Démarre ${job.engine.name}`)
    let result: EngineRunResult
    try {
      result = await job.engine.run(
        {
          runId: executionId,
          sessionId: mission.sessionId,
          prompt: job.prompt,
          instructions: job.instructions,
          model: agent.model && agent.model !== 'default' ? agent.model : null,
          policy: { workspace: mission.workspace!, permissions: agent.permissions, autonomy: agent.autonomy },
          secret: job.secret,
          budgetUsd: job.budgetUsd,
          signal: job.signal,
        },
        { emit: onEvent, requestApproval },
      )
    } finally {
      this.denyAllFor(missionId)
      // Tools left open by an interrupted run are closed, never left « running » forever.
      this.db
        .update(toolCalls)
        .set({ status: 'cancelled', finishedAt: nowIso() })
        .where(and(eq(toolCalls.executionId, executionId), eq(toolCalls.status, 'running')))
        .run()
      this.db
        .update(toolCalls)
        .set({ status: 'cancelled', finishedAt: nowIso() })
        .where(and(eq(toolCalls.executionId, executionId), eq(toolCalls.status, 'awaiting_approval')))
        .run()
      this.bus.emit({ type: 'mission.activity', missionId, activity: null })
    }
    return { ...result, sessionId: result.sessionId ?? sessionId, usage: totals }
  }

  static engineIdOf(providerId: string): EngineId | null {
    return providerId === 'claude-agent' || providerId === 'codex' ? providerId : null
  }

  /** Used by tests and the approval UI. */
  approvalRow(id: string) {
    const row = this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
    return row ? toApproval(row) : null
  }
}
