import { desc, eq, sql } from 'drizzle-orm'
import type { HealthIncident, HealthLevel, ProviderHealth, ProviderId } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { providerHealthRecords } from '../infra/db/schema'
import { ADAPTERS } from '../infra/providers'
import type { EventBus } from './event-bus'
import type { Journal } from './journal'
import { newId, nowIso } from './util'

interface SpComponent { name: string; status: string; group?: boolean; group_id?: string | null }
interface SpUpdate { status: string; body: string; created_at?: string; display_at?: string }
interface SpIncident {
  id: string
  name: string
  status: string
  impact: string
  created_at: string
  started_at?: string
  updated_at: string
  resolved_at?: string | null
  shortlink?: string
  incident_updates?: SpUpdate[]
}

const RANK: Record<HealthLevel, number> = { unknown: -1, operational: 0, degraded: 1, outage: 2 }
const worst = (a: HealthLevel, b: HealthLevel): HealthLevel => (RANK[b] > RANK[a] ? b : a)

export function componentLevel(status: string): HealthLevel {
  switch (status) {
    case 'operational':
      return 'operational'
    case 'degraded_performance':
    case 'partial_outage':
    case 'under_maintenance':
      return 'degraded'
    case 'major_outage':
      return 'outage'
    default:
      return 'unknown'
  }
}

export function impactLevel(impact: string): HealthLevel {
  if (impact === 'major' || impact === 'critical') return 'outage'
  if (impact === 'minor' || impact === 'maintenance') return 'degraded'
  return 'operational'
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Derives a 30-day UTC history from published incidents (worst impact per day).
 * Days older than the oldest incident in the feed are `unknown` when the feed is
 * saturated (statuspage returns at most 50 incidents).
 */
export function buildDays(incidents: SpIncident[], now = new Date(), windowDays = 30) {
  const days: { date: string; level: HealthLevel; incidents: number }[] = []
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (windowDays - 1)))
  const saturated = incidents.length >= 50
  const oldest = incidents.reduce<Date | null>((min, i) => {
    const d = new Date(i.started_at ?? i.created_at)
    return !min || d < min ? d : min
  }, null)
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(start.getTime() + i * 86_400_000)
    const covered = !saturated || !oldest || d >= new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), oldest.getUTCDate()))
    days.push({ date: dayKey(d), level: covered ? 'operational' : 'unknown', incidents: 0 })
  }
  const index = new Map(days.map((d, i) => [d.date, i]))
  let downMs = 0
  const windowStart = start.getTime()
  for (const inc of incidents) {
    const from = new Date(inc.started_at ?? inc.created_at)
    const to = inc.resolved_at ? new Date(inc.resolved_at) : now
    const level = impactLevel(inc.impact)
    if (level === 'outage') downMs += Math.max(0, Math.min(to.getTime(), now.getTime()) - Math.max(from.getTime(), windowStart))
    for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t <= to.getTime(); t += 86_400_000) {
      const i = index.get(dayKey(new Date(t)))
      if (i === undefined) continue
      const day = days[i]!
      day.incidents++
      if (level !== 'operational') day.level = worst(day.level === 'unknown' ? 'operational' : day.level, level)
    }
  }
  const coveredDays = days.filter((d) => d.level !== 'unknown').length
  const uptimePct = coveredDays ? Math.max(0, 100 - (downMs / (coveredDays * 86_400_000)) * 100) : null
  return { days, uptimePct }
}

function toIncident(i: SpIncident): HealthIncident {
  return {
    id: i.id,
    name: i.name,
    status: i.status,
    impact: i.impact,
    startedAt: i.started_at ?? i.created_at,
    updatedAt: i.updated_at,
    url: i.shortlink ?? null,
    updates: (i.incident_updates ?? []).slice(0, 4).map((u) => ({ status: u.status, body: u.body, at: u.display_at ?? u.created_at ?? i.updated_at })),
  }
}

/** Polls official Statuspage v2 endpoints. Data is real or explicitly marked unknown. */
export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<ProviderHealth[]> | null = null

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private fetchImpl: typeof fetch,
  ) {}

  start(intervalMs = 5 * 60_000): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  latest(): ProviderHealth[] {
    const out: ProviderHealth[] = []
    for (const id of this.monitored()) {
      const row = this.db.select().from(providerHealthRecords).where(eq(providerHealthRecords.providerId, id)).orderBy(desc(providerHealthRecords.checkedAt)).get()
      if (row) out.push(row.payload as ProviderHealth)
    }
    return out
  }

  refresh(): Promise<ProviderHealth[]> {
    this.inflight ??= Promise.all(this.monitored().map((id) => this.check(id))).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private monitored(): ProviderId[] {
    return (Object.keys(ADAPTERS) as ProviderId[]).filter((id) => ADAPTERS[id].statusPage)
  }

  private async check(id: ProviderId): Promise<ProviderHealth> {
    const src = ADAPTERS[id].statusPage!
    const previous = this.latest().find((h) => h.providerId === id)
    let health: ProviderHealth
    try {
      const get = async <T>(path: string): Promise<T> => {
        const res = await this.fetchImpl(`${src.api}/${path}`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as T
      }
      const [summary, history] = await Promise.all([
        get<{ status?: { indicator: string; description: string }; components?: SpComponent[]; incidents?: SpIncident[] }>('summary.json'),
        get<{ incidents?: SpIncident[] }>('incidents.json'),
      ])
      const components = (summary.components ?? [])
        .filter((c) => !c.group)
        .map((c) => ({ name: c.name, level: componentLevel(c.status) }))
      let level: HealthLevel = components.reduce<HealthLevel>((acc, c) => worst(acc, c.level), 'operational')
      const active = (summary.incidents ?? []).filter((i) => i.status !== 'resolved' && i.status !== 'postmortem')
      for (const i of active) level = worst(level, impactLevel(i.impact) === 'operational' ? 'degraded' : impactLevel(i.impact))
      const { days, uptimePct } = buildDays(history.incidents ?? [])
      const description =
        level === 'operational' ? 'Opérationnel' : level === 'degraded' ? 'Dégradé' : level === 'outage' ? 'Incident en cours' : 'Inconnu'
      health = { providerId: id, level, description, components, days, uptimePct, activeIncidents: active.map(toIncident), checkedAt: nowIso(), source: src.page, error: null }
    } catch (err) {
      health = {
        providerId: id,
        level: 'unknown',
        description: 'Statut indisponible',
        components: previous?.components ?? [],
        days: previous?.days ?? [],
        uptimePct: previous?.uptimePct ?? null,
        activeIncidents: [],
        checkedAt: nowIso(),
        source: src.page,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    this.db.insert(providerHealthRecords).values({ id: newId(), providerId: id, level: health.level, payload: health, checkedAt: health.checkedAt }).run()
    this.prune(id)
    if (previous && previous.level !== health.level && (health.level === 'outage' || health.level === 'degraded')) {
      const name = ADAPTERS[id].name
      this.journal.activity({ type: 'provider.error', level: 'warning', title: `${name} : ${health.description.toLowerCase()}`, detail: health.activeIncidents[0]?.name ?? null })
      this.journal.notify('provider', `${name} · ${health.description}`, health.activeIncidents[0]?.name ?? 'Consultez la page de statut.', null)
    }
    this.bus.invalidate('health')
    return health
  }

  private prune(id: ProviderId): void {
    const keep = this.db.select({ id: providerHealthRecords.id }).from(providerHealthRecords).where(eq(providerHealthRecords.providerId, id)).orderBy(desc(providerHealthRecords.checkedAt)).limit(1).offset(287).get()
    if (keep) {
      // keep ~24h of 5-minute samples
      this.db.run(
        sql`DELETE FROM provider_health_records WHERE provider_id = ${id} AND checked_at <= (SELECT checked_at FROM provider_health_records WHERE id = ${keep.id})`,
      )
    }
  }
}
