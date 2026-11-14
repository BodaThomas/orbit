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

function Kpi({ label, value, unit, hint, tone, children }: { label: string; value: string; unit?: string; hint?: React.ReactNode; tone?: 'warning'; children?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <div className="eyebrow">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1 tabular">
        <span className={cn('text-[24px] leading-8 font-semibold tracking-[-0.025em]', tone === 'warning' ? 'text-warning' : 'text-fg')}>{value}</span>
        {unit && <span className="text-[14px] text-fg-3">{unit}</span>}
        {children}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11.5px] text-fg-3">{hint}</div>}
    </div>
  )
}

function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return null
  const pct = Math.round(((now - before) / before) * 100)
  if (!isFinite(pct)) return null
  return (
    <span className={cn('ml-1.5 self-center rounded-[5px] px-1 text-[11px] leading-[18px] font-medium', pct > 0 ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success')}>
      {pct > 0 ? '+' : ''}
      {pct} %
    </span>
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
  const totals = daily.map((d) => d.official + d.estimated)
  const max = Math.max(0.01, ...totals)
  const nice = Math.pow(10, Math.floor(Math.log10(max)))
  const top = Math.ceil(max / nice) * nice
  const avg = totals.reduce((a, b) => a + b, 0) / Math.max(1, totals.length)
  const W = 760
  const H = 190
  const bw = W / daily.length
  const h = hover != null ? daily[hover] : null
  const fmtDay = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', o)
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W + 48} ${H + 26}`} className="w-full overflow-visible" role="img" aria-label="Dépenses quotidiennes sur 30 jours">
        <defs>
          <linearGradient id="bar-off" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#B9B1FF" />
            <stop offset="1" stopColor="#A59BFA" stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="bar-est" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#97B0F0" />
            <stop offset="1" stopColor="#7E9CE8" stopOpacity="0.4" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={0} x2={W} y1={H - t * H} y2={H - t * H} stroke="#fff" strokeOpacity={t === 0 ? 0.1 : 0.04} strokeDasharray={t === 0 ? undefined : '2 4'} />
            {(t === 0 || t === 1) && <text x={W + 10} y={H - t * H + 3.5} fontSize="10" fill="#5d6070" className="tabular">{money(top * t)}</text>}
          </g>
        ))}
        {hover != null && <rect x={hover * bw + 1} y={0} width={bw - 2} height={H} rx={4} fill="#fff" opacity="0.035" />}
        {daily.map((d, i) => {
          const eh = (d.estimated / top) * H
          const oh = (d.official / top) * H
          const x = i * bw + bw * 0.22
          const w = bw * 0.56
          const dim = hover != null && hover !== i
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} className="transition-opacity duration-150" opacity={dim ? 0.45 : 1}>
              <rect x={i * bw} y={0} width={bw} height={H + 20} fill="transparent" />
              {oh > 0 && <rect x={x} y={H - oh} width={w} height={oh} rx={3} fill="url(#bar-off)" />}
              {eh > 0 && <rect x={x} y={H - oh - eh} width={w} height={Math.max(eh, 1)} rx={3} fill="url(#bar-est)" />}
              {d.official + d.estimated === 0 && <rect x={x} y={H - 2} width={w} height={2} rx={1} fill="#fff" opacity="0.06" />}
              {((i % 7 === 0 && daily.length - 1 - i > 3) || i === daily.length - 1) && (
                <text x={i * bw + bw / 2} y={H + 17} textAnchor="middle" fontSize="10" fill={hover === i ? '#a2a4b0' : '#5d6070'}>{fmtDay(d.date, { day: 'numeric', month: 'short' })}</text>
              )}
            </g>
          )
        })}
        {avg > 0 && (
          <g className="pointer-events-none">
            <line x1={0} x2={W} y1={H - (avg / top) * H} y2={H - (avg / top) * H} stroke="#E5B565" strokeOpacity="0.55" strokeDasharray="3 4" />
            <rect x={W + 4} y={H - (avg / top) * H - 8} width={44} height={16} rx={4} fill="#E5B565" fillOpacity="0.12" />
            <text x={W + 26} y={H - (avg / top) * H + 3.5} textAnchor="middle" fontSize="9.5" fill="#E5B565" className="tabular">{money(avg).replace(' $', '')}</text>
          </g>
        )}
      </svg>
      {h && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-[148px] rounded-[10px] bg-[#25272f]/95 px-3 py-2 text-xs shadow-pop backdrop-blur tabular"
          style={{ left: `clamp(0px, calc(${((hover + 0.5) / daily.length) * (W / (W + 48)) * 100}% - 74px), calc(100% - 148px))`, transform: 'translateY(-8px)' }}
        >
          <div className="text-[11px] text-fg-3 capitalize">{fmtDay(h.date, { weekday: 'long', day: 'numeric', month: 'short' })}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-fg">{money(h.official + h.estimated)}</div>
          <div className="mt-1 space-y-0.5 text-[11px] text-fg-2">
            {h.official > 0 && <div className="flex justify-between"><span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-accent" />Officiel</span>{money(h.official)}</div>}
            {h.estimated > 0 && <div className="flex justify-between"><span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-accent-2" />Estimé</span>{money(h.estimated)}</div>}
            <div className="flex justify-between text-fg-3"><span>Requêtes</span>{h.requests}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function Ring({ value, size = 64 }: { value: number; size?: number }) {
  const r = size / 2 - 5
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#fff" strokeOpacity="0.07" strokeWidth="5" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#69C996" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${c * value} ${c}`} />
    </svg>
  )
}

const PROVIDER_COLORS = ['#A59BFA', '#7E9CE8', '#69C996', '#E5B565']

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

  const yesterday = known(u.yesterday)
  const leader = u.byAgentMonth[0] ? byId.get(u.byAgentMonth[0].agentId) : undefined
  const totalMissions = u.missionsDone + u.missionsFailed
  const successRate = totalMissions ? u.missionsDone / totalMissions : 0
  const activeDays = u.daily.filter((d) => d.official + d.estimated > 0).length
  const tokens = u.tokensMonth.input + u.tokensMonth.output
  const avgDuration = u.avgMissionSeconds != null ? duration(new Date(0).toISOString(), new Date(u.avgMissionSeconds * 1000).toISOString()) : '—'

  return (
    <Page wide>
      <PageHeader
        title="Statistiques"
        subtitle={
          u.requestsMonth ? (
            <span>
              Ce mois-ci, {money(month)} pour {integer(u.requestsMonth)} requêtes
              {leader && <span className="text-fg-3"> · {leader.name} est le plus sollicité</span>}
              <span className="text-fg-3"> · actif {activeDays} jour{activeDays > 1 ? 's' : ''} sur {u.daily.length}</span>
            </span>
          ) : (
            'Consommation et performances de vos compagnons.'
          )
        }
        actions={
          <Tooltip content={`Les jetons sont fournis par chaque API. Les coûts « estimés » sont calculés avec les tarifs publics du ${new Date(PRICING_VERSION).toLocaleDateString('fr-FR')}. Les coûts « officiels » proviennent directement d’un fournisseur. Rien n’est mélangé.`}>
            <span className="flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-xs text-fg-3 ring-1 ring-line transition-colors hover:text-fg-2"><Info className="size-3.5" /> Méthode de calcul</span>
          </Tooltip>
        }
      />
      <section className="card mb-4 grid grid-cols-4 divide-x divide-line">
        <div className="min-w-0 px-4 py-3.5">
          <div className="eyebrow">Aujourd’hui</div>
          <div className="mt-1.5 flex items-baseline gap-1 tabular">
            <span className="text-[24px] leading-8 font-semibold tracking-[-0.025em] text-fg">{today.value}</span>
            <span className="text-[14px] text-fg-3">$</span>
            <Delta now={known(u.today)} before={yesterday} />
          </div>
          {dailyPct != null ? (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]"><div className={cn('h-full rounded-full', dailyPct >= 100 ? 'bg-danger' : dailyPct > 80 ? 'bg-warning' : 'bg-accent')} style={{ width: `${dailyPct}%` }} /></div>
              <span className="text-[11px] text-fg-3 tabular">/ {money(u.dailyLimitUsd)}</span>
            </div>
          ) : (
            <div className="mt-0.5 truncate text-[11.5px] text-fg-3"><CostHint c={u.today} /></div>
          )}
        </div>
        <Kpi label="Hier" value={moneyParts(yesterday).value} unit="$" hint={<CostHint c={u.yesterday} />} />
        <div className="min-w-0 px-4 py-3.5">
          <div className="eyebrow">Ce mois-ci</div>
          <div className="mt-1.5 flex items-baseline gap-1 tabular">
            <span className="text-[24px] leading-8 font-semibold tracking-[-0.025em] text-fg">{moneyParts(month).value}</span>
            <span className="text-[14px] text-fg-3">$</span>
          </div>
          {monthPct != null ? (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]"><div className={cn('h-full rounded-full', monthPct >= 100 ? 'bg-danger' : 'bg-accent')} style={{ width: `${monthPct}%` }} /></div>
              <span className="text-[11px] text-fg-3 tabular">/ {money(u.monthlyBudgetUsd)}</span>
            </div>
          ) : (
            <div className="mt-0.5 truncate text-[11.5px] text-fg-3"><CostHint c={u.month} /></div>
          )}
        </div>
        <Kpi label="Requêtes ce mois" value={integer(u.requestsMonth)} hint={`${integer(u.requestsToday)} aujourd’hui · ${compactNumber(tokens)} jetons`} />
      </section>

      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_300px] gap-4">
        <Panel
          title={<span>Dépenses quotidiennes <span className="font-normal text-fg-3">· 30 jours</span></span>}
          action={
            <span className="flex items-center gap-3 text-[11px] text-fg-3">
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent" /> Officiel</span>
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent-2" /> Estimé</span>
              <span className="flex items-center gap-1.5"><span className="h-px w-3 border-t border-dashed border-warning/70" /> Moyenne</span>
            </span>
          }
          bodyClassName="px-4 pt-3 pb-3"
        >
          <DailyChart daily={u.daily} />
        </Panel>
        <section className="card flex flex-col p-4">
          <div className="text-[13px] font-medium text-fg">Missions <span className="font-normal text-fg-3">· ce mois</span></div>
          <div className="mt-4 flex items-center gap-4">
            <div className="relative">
              <Ring value={successRate} size={72} />
              <span className="absolute inset-0 flex items-center justify-center text-[15px] font-semibold text-fg tabular">{totalMissions ? `${Math.round(successRate * 100)}%` : '—'}</span>
            </div>
            <div>
              <div className="text-[13px] text-fg">Taux de réussite</div>
              <div className="mt-0.5 text-[12px] leading-snug text-fg-3">{totalMissions ? `${u.missionsDone} sur ${totalMissions} missions menées à terme` : 'Aucune mission terminée ce mois-ci'}</div>
            </div>
          </div>
          <div className="mt-auto divide-y divide-line pt-4 text-[13px]">
            {[
              ['Terminées', integer(u.missionsDone), 'text-success'],
              ['En échec', integer(u.missionsFailed), u.missionsFailed ? 'text-warning' : 'text-fg'],
              ['Durée moyenne', avgDuration, 'text-fg'],
            ].map(([k, v, c]) => (
              <div key={k} className="flex items-center justify-between py-2">
                <span className="text-fg-3">{k}</span>
                <span className={cn('font-medium tabular', c)}>{v}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-2 items-start gap-4">
        <Panel title={<span>Classement des compagnons <span className="font-normal text-fg-3">· ce mois</span></span>}>
          {u.byAgentMonth.length === 0 && <OrbitEmptyState compact title="Aucune consommation ce mois-ci" body="Discutez avec un compagnon ou lancez une mission pour voir apparaître sa consommation." />}
          {u.byAgentMonth.map((r, i) => {
            const a = byId.get(r.agentId)
            const v = known(r.cost)
            return (
              <div key={r.agentId} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 transition-colors hover:bg-white/[0.02]">
                <span className={cn('w-4 text-center text-[11px] tabular', i === 0 ? 'font-semibold text-accent' : 'text-fg-4')}>{i + 1}</span>
                {a ? <CompanionAvatar appearance={a.appearance} size={26} /> : <span className="size-[26px] rounded-full bg-white/5" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2 text-[13px]">
                    <span className="truncate text-fg">{a?.name ?? 'Compagnon supprimé'} <span className="text-[11.5px] text-fg-3">· {integer(r.requests)} req.{r.cost.unknownCount ? ` · ${r.cost.unknownCount} au coût inconnu` : ''}</span></span>
                    <span className="text-fg-2 tabular">{money(v)}</span>
                  </div>
                  <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-white/[0.05]">
                    <div className="h-full rounded-full bg-gradient-to-r from-accent/50 to-accent" style={{ width: `${(v / maxAgent) * 100}%` }} />
                  </div>
                </div>
              </div>
            )
          })}
        </Panel>
        <Panel title={<span>Fournisseurs <span className="font-normal text-fg-3">· aujourd’hui</span></span>}>
          {u.byProviderToday.length === 0 && <OrbitEmptyState compact title="Aucune requête aujourd’hui" body="La répartition par fournisseur s’affichera dès la première requête." />}
          {u.byProviderToday.length > 0 && (
            <div className="px-2.5 pt-1 pb-2">
              <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
                {u.byProviderToday.map((p, i) => (
                  <div key={p.providerId} className="rounded-full" style={{ width: `${totalProv ? (known(p.cost) / totalProv) * 100 : 0}%`, background: PROVIDER_COLORS[i % 4] }} />
                ))}
              </div>
            </div>
          )}
          {u.byProviderToday.map((p, i) => {
            const info = providers.data?.find((x) => x.id === p.providerId)
            return (
              <div key={p.providerId} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-[13px]">
                <span className="size-2 rounded-full" style={{ background: PROVIDER_COLORS[i % 4] }} />
                <ProviderMark id={p.providerId} size={20} />
                <span className="flex-1 text-fg">{info?.name ?? p.providerId}</span>
                {p.cost.estimated > 0 && <Badge>estimé</Badge>}
                {p.cost.unknownCount > 0 && <Badge tone="warning">{p.cost.unknownCount} inconnu</Badge>}
                <span className="w-16 text-right text-fg-2 tabular">{totalProv ? `${Math.round((known(p.cost) / totalProv) * 100)} %` : '—'}</span>
                <span className="w-16 text-right text-fg tabular">{money(known(p.cost))}</span>
              </div>
            )
          })}
          <div className="mx-1 mt-1.5 mb-1 rounded-[11px] bg-white/[0.02] p-3 ring-1 ring-line">
            <div className="flex items-baseline justify-between">
              <span className="eyebrow">Jetons ce mois</span>
              <span className="text-[13px] font-medium text-fg tabular">{compactNumber(tokens)}</span>
            </div>
            <div className="mt-2.5 space-y-2 text-[12px]">
              {[
                ['Entrée', u.tokensMonth.input, '#7E9CE8'],
                ['Sortie', u.tokensMonth.output, '#A59BFA'],
              ].map(([k, v, c]) => (
                <div key={k as string} className="flex items-center gap-3">
                  <span className="w-12 text-fg-3">{k}</span>
                  <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                    <div className="h-full rounded-full" style={{ width: `${tokens ? ((v as number) / tokens) * 100 : 0}%`, background: c as string }} />
                  </div>
                  <span className="w-14 text-right text-fg-2 tabular">{compactNumber(v as number)}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </Page>
  )
}
