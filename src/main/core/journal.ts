import { and, desc, eq, like, or } from 'drizzle-orm'
import type { ActivityEvent, ActivityLevel, ActivityType, AuditEntry, OrbitNotification } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { toActivity, toAudit, toNotification } from '../infra/db/mappers'
import { activityEvents, auditLogs, notifications } from '../infra/db/schema'
import type { EventBus } from './event-bus'
import type { PlatformServices } from './platform'
import { newId, nowIso } from './util'

export interface ActivityInput {
  type: ActivityType
  level?: ActivityLevel
  agentId?: string | null
  missionId?: string | null
  conversationId?: string | null
  title: string
  detail?: string | null
}

/** Normalised, persisted activity feed + audit log + notification centre. */
export class Journal {
  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private platform: PlatformServices,
    private getNativeEnabled: () => boolean,
  ) {}

  activity(input: ActivityInput): ActivityEvent {
    const row = {
      id: newId(),
      type: input.type,
      level: input.level ?? 'info',
      agentId: input.agentId ?? null,
      missionId: input.missionId ?? null,
      conversationId: input.conversationId ?? null,
      title: input.title,
      detail: input.detail ?? null,
      createdAt: nowIso(),
    }
    this.db.insert(activityEvents).values(row).run()
    const event = toActivity(row)
    this.bus.emit({ type: 'activity', event })
    this.bus.invalidate('activity')
    return event
  }

  listActivity(opts: { limit?: number; agentId?: string; query?: string; level?: ActivityLevel }): ActivityEvent[] {
    const where = and(
      opts.agentId ? eq(activityEvents.agentId, opts.agentId) : undefined,
      opts.level ? eq(activityEvents.level, opts.level) : undefined,
      opts.query
        ? or(like(activityEvents.title, `%${opts.query}%`), like(activityEvents.detail, `%${opts.query}%`))
        : undefined,
    )
    return this.db
      .select()
      .from(activityEvents)
      .where(where)
      .orderBy(desc(activityEvents.createdAt))
      .limit(opts.limit ?? 100)
      .all()
      .map(toActivity)
  }

  audit(entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
    this.db
      .insert(auditLogs)
      .values({ ...entry, id: newId(), createdAt: nowIso() })
      .run()
  }

  listAudit(limit = 200): AuditEntry[] {
    return this.db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit).all().map(toAudit)
  }

  notify(kind: OrbitNotification['kind'], title: string, body: string, route: string | null = null): void {
    this.db
      .insert(notifications)
      .values({ id: newId(), kind, title, body, route, read: false, createdAt: nowIso() })
      .run()
    this.bus.invalidate('notifications')
    if (this.getNativeEnabled()) this.platform.nativeNotify(title, body, route)
  }

  listNotifications(): OrbitNotification[] {
    return this.db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(100).all().map(toNotification)
  }

  markRead(id?: string): void {
    const q = this.db.update(notifications).set({ read: true })
    if (id) q.where(eq(notifications.id, id)).run()
    else q.run()
    this.bus.invalidate('notifications')
  }
}
