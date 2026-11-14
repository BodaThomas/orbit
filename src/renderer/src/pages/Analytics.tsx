import { useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import { PRICING_VERSION } from '@shared/pricing'
import type { CostBreakdown } from '@shared/types'
import { Page, PageHeader, Panel } from '@/components/shell/Page'
import { Badge, Skeleton } from '@/components/ui/field'
import { Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { compactNumber, duration, integer, money, moneyParts } from '@/lib/format'
import { useAgents, useProviders, useUsage } from '@/lib/queries'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { ProviderMark } from '@/orbit/ProviderMark'

const known = (c: CostBreakdown) => c.official + c.estimated

function Kpi({ label, value, hint, unit, tone }: { label: string; value: string; hint?: React.ReactNode; unit?: string; tone?: 'warning' }) {
  return (
    <div className="rounded-xl bg-surface p-4 ring-1 ring-line">
      <div className="text-[12.5px] text-fg-3">{label}</div>
      <div className="mt-1 flex items-baseline gap-1 tabular">
        <span className={cn('text-[26px] leading-8 font-semibold tracking-[-0.02em]', tone === 'warning' ? 'text-warning' : 'text-fg')}>{value}</span>
        {unit && <span className="text-[14px] text-fg-3">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-2xs text-fg-3">{hint}</div>}
    </div>
  )
}

function CostHint({ c }: { c: CostBreakdown }) {
  const parts: string[] = []
  if (c.official > 0) parts.push(`${money(c.official)} officiel`)
  if (c.estimated > 0) parts.push(`${money(c.estimated)} estimé`)
  if (c.unknownCount) parts.push(`${c.unknownCount} req. coût inconnu`)
  if (c.subscriptionCount) parts.push(`${c.subscriptionCount} req. abonnement`)
  return <>{parts.length ? parts.join(' · ') : 'Aucune dépense'}</>
}

function DailyChart({ daily }: { daily: { date: string; official: number; estimated: number; requests: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(0.01, ...daily.map((d) => d.official + d.estimated))
  const nice = Math.pow(10, Math.floor(Math.log10(max)))
  const top = Math.ceil(max / nice) * nice
  const W = 760
  const H = 200
  const bw = W / daily.length
  const h = hover != null ? daily[hover] : null
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W + 44} ${H + 24}`} className="w-full" role="img" aria-label="Dépenses quotidiennes sur 30 jours">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={0} x2={W} y1={H - t * H} y2={H - t * H} stroke="#fff" strokeOpacity={t === 0 ? 0.1 : 0.05} />
            <text x={W + 8} y={H - t * H + 4} fontSize="10.5" fill="#707484" className="tabular">{money(top * t)}</text>
          </g>
        ))}
        {daily.map((d, i) => {
          const eh = (d.estimated / top) * H
          const oh = (d.official / top) * H
          const x = i * bw + bw * 0.18
          const w = bw * 0.64
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {oh > 0 && <rect x={x} y={H - oh} width={w} height={oh} rx={2.5} fill="#A59BFA" opacity={hover == null || hover === i ? 1 : 0.5} />}
              {eh > 0 && <rect x={x} y={H - oh - eh} width={w} height={Math.max(eh, 1)} rx={2.5} fill="#7E9CE8" opacity={hover == null || hover === i ? 0.85 : 0.4} />}
              {d.official + d.estimated === 0 && <rect x={x} y={H - 2} width={w} height={2} rx={1} fill="#fff" opacity="0.06" />}
              {(i % 5 === 0 || i === daily.length - 1) && (
                <text x={i * bw + bw / 2} y={H + 16} textAnchor="middle" fontSize="10.5" fill="#707484">{new Date(`${d.date}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</text>
              )}
            </g>
          )
        })}
      </svg>
      {h && (
        <div className="pointer-events-none absolute top-0 right-12 rounded-[8px] bg-[#2a2c36] px-2.5 py-1.5 text-xs shadow-pop tabular">
          <div className="text-fg">{new Date(`${h.date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
          <div className="text-fg-2">{money(h.official + h.estimated)} · {h.requests} req.</div>
        </div>
      )}
    </div>
  )
}

export function AnalyticsPage() {
  const usage = useUsage()
  const agents = useAgents()
  const providers = useProviders()
  const u = usage.data
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])

  if (usage.isLoading || !u) return <Page><PageHeader title="Statistiques" /><Skeleton className="h-96 rounded-xl" /></Page>
  const today = moneyParts(known(u.today))
  const month = known(u.month)
  const maxAgent = Math.max(0.0001, ...u.byAgentMonth.map((a) => known(a.cost)))
  const totalProv = u.byProviderToday.reduce((s, p) => s + known(p.cost), 0)
  const dailyPct = u.dailyLimitUsd ? Math.min(100, (known(u.today) / u.dailyLimitUsd) * 100) : null
  const monthPct = u.monthlyBudgetUsd ? Math.min(100, (month / u.monthlyBudgetUsd) * 100) : null

  return (
    <Page wide>
      <PageHeader
        title="Statistiques"
        subtitle="Consommation et performances de vos compagnons."
        actions={
          <Tooltip content={`Les jetons sont fournis par chaque API. Les coûts « estimés » sont calculés avec les tarifs publics du ${new Date(PRICING_VERSION).toLocaleDateString('fr-FR')}. Les coûts « officiels » proviennent directement d’un fournisseur. Rien n’est mélangé.`}>
            <span className="flex items-center gap-1.5 text-xs text-fg-3"><Info className="size-3.5" /> Méthode de calcul</span>
          </Tooltip>
        }
      />
      <div className="mb-4 grid grid-cols-4 gap-3">
        <div className="rounded-xl bg-surface p-4 ring-1 ring-line">
          <div className="text-[12.5px] text-fg-3">Aujourd’hui</div>
          <div className="mt-1 flex items-baseline gap-1 tabular">
            <span className="text-[30px] leading-9 font-semibold tracking-[-0.02em] text-fg">{today.value}</span>
            <span className="text-[16px] text-fg-3">$</span>
          </div>
          <div className="mt-1 text-2xs text-fg-3"><CostHint c={u.today} /></div>
          {dailyPct != null && (
            <div className="mt-2.5">
              <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]"><div className={cn('h-full rounded-full', dailyPct >= 100 ? 'bg-danger' : dailyPct > 80 ? 'bg-warning' : 'bg-accent')} style={{ width: `${dailyPct}%` }} /></div>
              <div className="mt-1 text-2xs text-fg-3 tabular">Limite {money(u.dailyLimitUsd)}</div>
            </div>
          )}
        </div>
        <Kpi label="Hier" value={moneyParts(known(u.yesterday)).value} unit="$" hint={<CostHint c={u.yesterday} />} />
        <div className="rounded-xl bg-surface p-4 ring-1 ring-line">
          <div className="text-[12.5px] text-fg-3">Ce mois-ci</div>
          <div className="mt-1 flex items-baseline gap-1 tabular">
            <span className="text-[26px] leading-8 font-semibold tracking-[-0.02em] text-fg">{moneyParts(month).value}</span>
            <span className="text-[14px] text-fg-3">$</span>
          </div>
          <div className="mt-1 text-2xs text-fg-3"><CostHint c={u.month} /></div>
          {monthPct != null && <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/[0.07]"><div className={cn('h-full rounded-full', monthPct >= 100 ? 'bg-danger' : 'bg-accent')} style={{ width: `${monthPct}%` }} /></div>}
        </div>
        <Kpi label="Requêtes ce mois" value={integer(u.requestsMonth)} hint={`${integer(u.requestsToday)} aujourd’hui · ${compactNumber(u.tokensMonth.input + u.tokensMonth.output)} jetons`} />
      </div>

      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_340px] gap-4">
        <Panel
          title="Dépenses quotidiennes · 30 jours"
          action={
            <span className="flex items-center gap-3 text-2xs text-fg-3">
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-accent" /> Officiel</span>
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-accent-2" /> Estimé</span>
            </span>
          }
          bodyClassName="px-4 pb-4"
        >
          <DailyChart daily={u.daily} />
        </Panel>
        <div className="grid grid-rows-3 gap-3">
          <Kpi label="Missions terminées (mois)" value={integer(u.missionsDone)} />
          <Kpi label="Missions en échec (mois)" value={integer(u.missionsFailed)} tone={u.missionsFailed ? 'warning' : undefined} />
          <Kpi label="Durée moyenne d’exécution" value={u.avgMissionSeconds != null ? duration(new Date(0).toISOString(), new Date(u.avgMissionSeconds * 1000).toISOString()) : '—'} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Panel title="Classement des compagnons · ce mois">
          {u.byAgentMonth.length === 0 && <OrbitEmptyState compact title="Aucune consommation ce mois-ci" />}
          {u.byAgentMonth.map((r, i) => {
            const a = byId.get(r.agentId)
            const v = known(r.cost)
            return (
              <div key={r.agentId} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2">
                <span className="w-4 text-xs text-fg-4 tabular">{i + 1}</span>
                {a ? <CompanionAvatar appearance={a.appearance} size={26} /> : <span className="size-[26px] rounded-full bg-white/5" />}
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between text-[13px]">
                    <span className="truncate text-fg">{a?.name ?? 'Compagnon supprimé'}</span>
                    <span className="text-fg-2 tabular">{money(v)}</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className="h-full rounded-full bg-accent/80" style={{ width: `${(v / maxAgent) * 100}%` }} />
                  </div>
                  <div className="mt-1 text-2xs text-fg-3 tabular">{integer(r.requests)} requêtes{r.cost.unknownCount ? ` · ${r.cost.unknownCount} au coût inconnu` : ''}</div>
                </div>
              </div>
            )
          })}
        </Panel>
        <Panel title="Fournisseurs · aujourd’hui">
          {u.byProviderToday.length === 0 && <OrbitEmptyState compact title="Aucune requête aujourd’hui" />}
          {u.byProviderToday.length > 0 && (
            <div className="px-2.5 pt-1 pb-3">
              <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
                {u.byProviderToday.map((p, i) => (
                  <div key={p.providerId} style={{ width: `${totalProv ? (known(p.cost) / totalProv) * 100 : 0}%`, background: ['#A59BFA', '#7E9CE8', '#69C996', '#E5B565'][i % 4] }} />
                ))}
              </div>
            </div>
          )}
          {u.byProviderToday.map((p, i) => {
            const info = providers.data?.find((x) => x.id === p.providerId)
            return (
              <div key={p.providerId} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-[13px]">
                <span className="size-2 rounded-full" style={{ background: ['#A59BFA', '#7E9CE8', '#69C996', '#E5B565'][i % 4] }} />
                <ProviderMark id={p.providerId} size={20} />
                <span className="flex-1 text-fg">{info?.name ?? p.providerId}</span>
                {p.cost.estimated > 0 && <Badge>estimé</Badge>}
                {p.cost.unknownCount > 0 && <Badge tone="warning">{p.cost.unknownCount} inconnu</Badge>}
                <span className="w-20 text-right text-fg-2 tabular">{money(known(p.cost))}</span>
              </div>
            )
          })}
        </Panel>
      </div>
    </Page>
  )
}
