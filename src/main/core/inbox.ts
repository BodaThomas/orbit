import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { InboxItem } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { approvalRequests, automationDefinitions, automationRuns, constellationDefinitions, constellationRuns, inboxDismissals, missions } from '../infra/db/schema'
import type { EventBus } from './event-bus'

/** How far back failures are surfaced: older ones only live in their history. */
const FAILURE_WINDOW_MS = 14 * 24 * 3600 * 1000
const LIMIT = 50

/**
 * Everything waiting for the user, in one list: decisions to take (approvals, plans,
 * missed automation runs, blocked team missions) and failures not yet marked as handled.
 */
export class Inbox {
  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private now: () => number = Date.now,
  ) {}

  list(): InboxItem[] {
    const since = new Date(this.now() - FAILURE_WINDOW_MS).toISOString()
    const dismissed = new Set(this.db.select({ key: inboxDismissals.key }).from(inboxDismissals).all().map((r) => r.key))
    const items: InboxItem[] = []

    for (const a of this.db.select().from(approvalRequests).where(eq(approvalRequests.status, 'pending')).orderBy(desc(approvalRequests.createdAt)).all()) {
      items.push({
        key: `approval:${a.id}`,
        kind: 'approval',
        refId: a.id,
        title: a.summary,
        detail: a.detail,
        agentId: a.agentId,
        route: a.missionId ? `/missions/${a.missionId}?approval=${a.id}` : '/',
        createdAt: a.createdAt,
        dismissible: false,
      })
    }

    const runs = this.db
      .select({ id: constellationRuns.id, status: constellationRuns.status, goal: constellationRuns.goal, error: constellationRuns.error, agentId: constellationRuns.coordinatorAgentId, createdAt: constellationRuns.createdAt, finishedAt: constellationRuns.finishedAt, name: constellationDefinitions.name })
      .from(constellationRuns)
      .innerJoin(constellationDefinitions, eq(constellationDefinitions.id, constellationRuns.constellationId))
      .where(inArray(constellationRuns.status, ['awaiting_approval', 'blocked', 'failed']))
      .orderBy(desc(constellationRuns.createdAt))
      .all()
    for (const r of runs) {
      if (r.status === 'failed' && (r.finishedAt ?? r.createdAt) < since) continue
      const kind = r.status === 'awaiting_approval' ? 'plan' : r.status === 'blocked' ? 'run_blocked' : 'run_failed'
      items.push({
        key: `${kind}:${r.id}`,
        kind,
        refId: r.id,
        title: kind === 'plan' ? `« ${r.name} » attend votre accord sur le plan` : kind === 'run_blocked' ? `« ${r.name} » est bloquée` : `« ${r.name} » a échoué`,
        detail: kind === 'run_failed' ? (r.error ?? r.goal) : r.goal,
        agentId: r.agentId,
        route: `/constellations/runs/${r.id}`,
        createdAt: r.finishedAt ?? r.createdAt,
        dismissible: kind === 'run_failed',
      })
    }

    const autoRuns = this.db
      .select({ id: automationRuns.id, status: automationRuns.status, note: automationRuns.note, missionId: automationRuns.missionId, constellationRunId: automationRuns.constellationRunId, createdAt: automationRuns.createdAt, finishedAt: automationRuns.finishedAt, name: automationDefinitions.name })
      .from(automationRuns)
      .innerJoin(automationDefinitions, eq(automationDefinitions.id, automationRuns.automationId))
      .where(inArray(automationRuns.status, ['pending_confirmation', 'failed', 'uncertain']))
      .orderBy(desc(automationRuns.createdAt))
      .all()
    for (const r of autoRuns) {
      if (r.status === 'pending_confirmation') {
        items.push({ key: `automation_confirm:${r.id}`, kind: 'automation_confirm', refId: r.id, title: `« ${r.name} » n’a pas pu s’exécuter à l’heure prévue`, detail: r.note, agentId: null, route: `/automations?run=${r.id}`, createdAt: r.createdAt, dismissible: false })
        continue
      }
      // A run that produced a mission or a team mission is reported through that one.
      if (r.missionId || r.constellationRunId || (r.finishedAt ?? r.createdAt) < since) continue
      items.push({ key: `automation_failed:${r.id}`, kind: 'automation_failed', refId: r.id, title: `« ${r.name} » a échoué`, detail: r.note, agentId: null, route: `/automations?run=${r.id}`, createdAt: r.finishedAt ?? r.createdAt, dismissible: true })
    }

    const failed = this.db
      .select({ id: missions.id, title: missions.title, error: missions.error, agentId: missions.agentId, updatedAt: missions.updatedAt })
      .from(missions)
      // Sub-missions of a team mission are handled from the team mission itself.
      .where(and(eq(missions.status, 'failed'), isNull(missions.constellationRunId)))
      .orderBy(desc(missions.updatedAt))
      .limit(LIMIT)
      .all()
    for (const m of failed) {
      if (m.updatedAt < since) continue
      items.push({ key: `mission_failed:${m.id}`, kind: 'mission_failed', refId: m.id, title: m.title, detail: m.error, agentId: m.agentId, route: `/missions/${m.id}`, createdAt: m.updatedAt, dismissible: true })
    }

    return items.filter((i) => !i.dismissible || !dismissed.has(i.key)).slice(0, LIMIT)
  }

  dismiss(keys: string[]): void {
    for (const key of keys) this.db.insert(inboxDismissals).values({ key }).onConflictDoNothing().run()
    this.bus.invalidate('inbox')
  }
}
