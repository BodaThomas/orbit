import { and, desc, gte, sql } from 'drizzle-orm'
import { estimateCost } from '@shared/pricing'
import type { CostBreakdown, CostKind, MissionStatus, ProviderId, RateLimitSnapshot, UsageRecord, UsageSummary } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { missionCounts } from '@shared/stats'
import { missions, subscriptionUsageRecords, usageRecords } from '../infra/db/schema'
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
    /** Cost already computed elsewhere (engine estimate, subscription). Otherwise priced from the dated table. */
    cost?: { costUsd: number | null; costKind: CostKind; pricingVersion: string | null }
    /** Subscription only: theoretical API-price equivalent, stored apart, never summed into spend. */
    equivalentUsd?: number | null
  }): { costUsd: number | null; costKind: CostKind } {
    const { cost, equivalentUsd, ...row } = input
    const est = cost ?? estimateCost(input.providerId, input.model, input.inputTokens, input.outputTokens)
    this.db
      .insert(usageRecords)
      .values({ id: newId(), ...row, costUsd: est.costKind === 'subscription' ? null : est.costUsd, costKind: est.costKind, pricingVersion: est.pricingVersion, equivalentUsd: est.costKind === 'subscription' ? (equivalentUsd ?? null) : null, createdAt: nowIso() })
      .run()
    this.bus.invalidate('usage')
    return { costUsd: est.costUsd, costKind: est.costKind }
  }

  /** Records a provider usage chunk, splitting it per model when a fallback served the turn. */
  recordChunk(
    agentId: string,
    providerId: ProviderId,
    requestedModel: string,
    chunk: { inputTokens: number; outputTokens: number; model?: string; byModel?: { model: string; inputTokens: number; outputTokens: number }[] },
    source: UsageRecord['source'],
  ): { costUsd: number | null; costKind: CostKind; model: string } {
    const parts = chunk.byModel?.length ? chunk.byModel : [{ model: chunk.model ?? requestedModel, inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens }]
    let costUsd: number | null = 0
    let costKind: CostKind = 'estimated'
    for (const part of parts) {
      const c = this.record({ agentId, providerId, model: part.model, inputTokens: part.inputTokens, outputTokens: part.outputTokens, source })
      if (c.costUsd == null) costUsd = null
      else if (costUsd != null) costUsd += c.costUsd
      if (c.costKind !== 'estimated') costKind = c.costKind
    }
    return { costUsd, costKind, model: chunk.model ?? requestedModel }
  }

  /** Latest official quota snapshot per provider. Older than 6 h → dropped (no stale quota shown as current). */
  quotas(maxAgeMs = 6 * 3600_000): RateLimitSnapshot[] {
    const rows = this.db.select().from(subscriptionUsageRecords).orderBy(desc(subscriptionUsageRecords.observedAt)).limit(200).all()
    const seen = new Map<string, RateLimitSnapshot>()
    for (const r of rows) {
      if (seen.has(r.providerId) || Date.now() - new Date(r.observedAt).getTime() > maxAgeMs) continue
      seen.set(r.providerId, { providerId: r.providerId as ProviderId, windows: r.windows, observedAt: r.observedAt, source: r.source })
    }
    return [...seen.values()]
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

  /** Smallest remaining amount across every configured limit, or null when none applies. */
  remainingBudget(agent: { id: string; dailyBudgetUsd: number | null }): number | null {
    const s = this.settings.get()
    const left: number[] = []
    if (agent.dailyBudgetUsd != null) left.push(agent.dailyBudgetUsd - this.spentToday(agent.id))
    if (s.dailyLimitUsd != null) left.push(s.dailyLimitUsd - this.spentToday())
    if (s.monthlyBudgetUsd != null) left.push(s.monthlyBudgetUsd - this.spentThisMonth())
    return left.length ? Math.max(0, Math.min(...left)) : null
  }

  /** Returns a human reason if a new execution must be blocked by a budget. */
  budgetBlock(agent: { id: string; name: string; dailyBudgetUsd: number | null }): string | null {
    const s = this.settings.get()
    if (agent.dailyBudgetUsd != null && this.spentToday(agent.id) >= agent.dailyBudgetUsd) {
      return `Budget journalier de ${agent.name} atteint (${agent.dailyBudgetUsd.toFixed(2)} $).`
    }
    if (s.dailyLimitUsd != null && this.spentToday() >= s.dailyLimitUsd) {
      return `Budget journalier global atteinte (${s.dailyLimitUsd.toFixed(2)} $).`
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
      missionsCancelled: 0,
      missionCounts: missionCounts([]),
      subscriptionMonth: { requests: 0, tokens: 0, equivalentUsd: null },
      avgMissionSeconds: null,
      dailyLimitUsd: this.settings.get().dailyLimitUsd,
      monthlyBudgetUsd: this.settings.get().monthlyBudgetUsd,
    }
    const byProvider = new Map<ProviderId, CostBreakdown>()
    const byAgent = new Map<string, { cost: CostBreakdown; requests: number; tokens: number }>()
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
        if (kind === 'subscription') {
          s.subscriptionMonth.requests++
          s.subscriptionMonth.tokens += r.inputTokens + r.outputTokens
          if (r.equivalentUsd != null) s.subscriptionMonth.equivalentUsd = (s.subscriptionMonth.equivalentUsd ?? 0) + r.equivalentUsd
        }
        if (r.agentId) {
          const a = byAgent.get(r.agentId) ?? { cost: empty(), requests: 0, tokens: 0 }
          add(a.cost, kind, r.costUsd)
          a.requests++
          a.tokens += r.inputTokens + r.outputTokens
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
      .sort((a, b) => b.requests - a.requests || b.cost.official + b.cost.estimated - (a.cost.official + a.cost.estimated) || a.agentId.localeCompare(b.agentId))
    s.daily = [...daily].map(([date, v]) => ({ date, ...v }))

    // Missions created this month. Same function as every other screen (shared/stats.ts).
    const monthMissions = this.db.select({ status: missions.status, startedAt: missions.startedAt, finishedAt: missions.finishedAt }).from(missions).where(gte(missions.createdAt, monthStart.toISOString())).all()
    const mc = missionCounts(monthMissions.map((m) => ({ status: m.status as MissionStatus })))
    s.missionCounts = mc
    s.missionsDone = mc.done
    s.missionsFailed = mc.failed
    s.missionsCancelled = mc.cancelled
    const durations = monthMissions.filter((m) => m.status === 'done' && m.startedAt && m.finishedAt).map((m) => (new Date(m.finishedAt!).getTime() - new Date(m.startedAt!).getTime()) / 1000)
    s.avgMissionSeconds = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null
    return s
  }
}
