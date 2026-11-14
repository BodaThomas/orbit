import { and, gte, sql } from 'drizzle-orm'
import { estimateCost } from '@shared/pricing'
import type { CostBreakdown, CostKind, ProviderId, UsageRecord, UsageSummary } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { missions, usageRecords } from '../infra/db/schema'
import type { EventBus } from './event-bus'
import type { SettingsStore } from './settings'
import { newId, nowIso, startOfLocalDay } from './util'

const empty = (): CostBreakdown => ({ official: 0, estimated: 0, unknownCount: 0, subscriptionCount: 0 })

function add(b: CostBreakdown, kind: CostKind, cost: number | null): void {
  if (kind === 'official') b.official += cost ?? 0
  else if (kind === 'estimated') b.estimated += cost ?? 0
  else if (kind === 'subscription') b.subscriptionCount++
  else b.unknownCount++
}

function localDateKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class UsageTracker {
  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private settings: SettingsStore,
  ) {}

  record(input: {
    agentId: string | null
    providerId: ProviderId
    model: string
    inputTokens: number
    outputTokens: number
    source: UsageRecord['source']
  }): { costUsd: number | null; costKind: CostKind } {
    const est = estimateCost(input.providerId, input.model, input.inputTokens, input.outputTokens)
    this.db
      .insert(usageRecords)
      .values({ id: newId(), ...input, costUsd: est.costUsd, costKind: est.costKind, pricingVersion: est.pricingVersion, createdAt: nowIso() })
      .run()
    this.bus.invalidate('usage')
    return { costUsd: est.costUsd, costKind: est.costKind }
  }

  /** Known spend (official + estimated) since local midnight, optionally per agent. */
  spentToday(agentId?: string): number {
    const since = startOfLocalDay().toISOString()
    const rows = this.db
      .select({ cost: sql<number>`coalesce(sum(${usageRecords.costUsd}), 0)` })
      .from(usageRecords)
      .where(and(gte(usageRecords.createdAt, since), agentId ? sql`${usageRecords.agentId} = ${agentId}` : undefined))
      .get()
    return rows?.cost ?? 0
  }

  spentThisMonth(): number {
    const now = new Date()
    const since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    return (
      this.db
        .select({ cost: sql<number>`coalesce(sum(${usageRecords.costUsd}), 0)` })
        .from(usageRecords)
        .where(gte(usageRecords.createdAt, since))
        .get()?.cost ?? 0
    )
  }

  /** Returns a human reason if a new execution must be blocked by a budget. */
  budgetBlock(agent: { id: string; name: string; dailyBudgetUsd: number | null }): string | null {
    const s = this.settings.get()
    if (agent.dailyBudgetUsd != null && this.spentToday(agent.id) >= agent.dailyBudgetUsd) {
      return `Budget journalier de ${agent.name} atteint (${agent.dailyBudgetUsd.toFixed(2)} $).`
    }
    if (s.dailyLimitUsd != null && this.spentToday() >= s.dailyLimitUsd) {
      return `Limite journalière globale atteinte (${s.dailyLimitUsd.toFixed(2)} $).`
    }
    if (s.monthlyBudgetUsd != null && this.spentThisMonth() >= s.monthlyBudgetUsd) {
      return `Budget mensuel atteint (${s.monthlyBudgetUsd.toFixed(2)} $).`
    }
    return null
  }

  summary(): UsageSummary {
    const now = new Date()
    const today = startOfLocalDay(now)
    const yesterday = startOfLocalDay(now, -1)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const windowStart = startOfLocalDay(now, -29)
    const since = monthStart < windowStart ? monthStart : windowStart

    const rows = this.db.select().from(usageRecords).where(gte(usageRecords.createdAt, since.toISOString())).all()

    const s: UsageSummary = {
      today: empty(),
      yesterday: empty(),
      month: empty(),
      byProviderToday: [],
      byAgentMonth: [],
      daily: [],
      requestsToday: 0,
      requestsMonth: 0,
      tokensMonth: { input: 0, output: 0 },
      missionsDone: 0,
      missionsFailed: 0,
      avgMissionSeconds: null,
      dailyLimitUsd: this.settings.get().dailyLimitUsd,
      monthlyBudgetUsd: this.settings.get().monthlyBudgetUsd,
    }
    const byProvider = new Map<ProviderId, CostBreakdown>()
    const byAgent = new Map<string, { cost: CostBreakdown; requests: number }>()
    const daily = new Map<string, { official: number; estimated: number; requests: number }>()
    for (let i = 29; i >= 0; i--) daily.set(localDateKey(startOfLocalDay(now, -i).toISOString()), { official: 0, estimated: 0, requests: 0 })

    for (const r of rows) {
      const at = new Date(r.createdAt)
      const kind = r.costKind as CostKind
      if (at >= today) {
        add(s.today, kind, r.costUsd)
        s.requestsToday++
        const p = byProvider.get(r.providerId as ProviderId) ?? empty()
        add(p, kind, r.costUsd)
        byProvider.set(r.providerId as ProviderId, p)
      } else if (at >= yesterday) add(s.yesterday, kind, r.costUsd)
      if (at >= monthStart) {
        add(s.month, kind, r.costUsd)
        s.requestsMonth++
        s.tokensMonth.input += r.inputTokens
        s.tokensMonth.output += r.outputTokens
        if (r.agentId) {
          const a = byAgent.get(r.agentId) ?? { cost: empty(), requests: 0 }
          add(a.cost, kind, r.costUsd)
          a.requests++
          byAgent.set(r.agentId, a)
        }
      }
      const d = daily.get(localDateKey(r.createdAt))
      if (d) {
        d.requests++
        if (kind === 'official') d.official += r.costUsd ?? 0
        if (kind === 'estimated') d.estimated += r.costUsd ?? 0
      }
    }
    s.byProviderToday = [...byProvider].map(([providerId, cost]) => ({ providerId, cost }))
    s.byAgentMonth = [...byAgent]
      .map(([agentId, v]) => ({ agentId, ...v }))
      .sort((a, b) => b.cost.official + b.cost.estimated - (a.cost.official + a.cost.estimated))
    s.daily = [...daily].map(([date, v]) => ({ date, ...v }))

    const m = this.db
      .select({
        done: sql<number>`sum(case when ${missions.status} = 'done' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${missions.status} = 'failed' then 1 else 0 end)`,
        avg: sql<number | null>`avg(case when ${missions.finishedAt} is not null and ${missions.startedAt} is not null then (julianday(${missions.finishedAt}) - julianday(${missions.startedAt})) * 86400 end)`,
      })
      .from(missions)
      .where(gte(missions.createdAt, monthStart.toISOString()))
      .get()
    s.missionsDone = m?.done ?? 0
    s.missionsFailed = m?.failed ?? 0
    s.avgMissionSeconds = m?.avg ?? null
    return s
  }
}
