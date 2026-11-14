import { useMemo } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, Plus, Rocket, ShieldCheck } from 'lucide-react'
import { ACTIVE_MISSION_STATUSES } from '@shared/mission-states'
import { Page, PageHeader, Panel, PanelLink } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/field'
import { longDate, greeting, relative, money, moneyParts, integer } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useActivity, useAgents, useApprovals, useBootstrap, useMissions, useProviders, useUsage } from '@/lib/queries'
import { ActivityEventRow } from '@/orbit/ActivityEvent'
import { ApprovalRequestCard } from '@/orbit/ApprovalRequest'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { CompanionCard } from '@/orbit/CompanionCard'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { MissionStatusIcon, MissionStatusLabel } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

/** Tiny inline trend, no axes: the last N days of known spend. */
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const W = 96
  const H = 28
  const max = Math.max(0.0001, ...values)
  const step = W / Math.max(1, values.length - 1)
  const pts = values.map((v, i) => [i * step, H - 2 - (v / max) * (H - 6)] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn('h-7 w-24 overflow-visible', className)} aria-hidden>
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#A59BFA" stopOpacity="0.28" />
          <stop offset="1" stopColor="#A59BFA" stopOpacity="0" />
        </linearGradient>
      </defs>
      {values.length > 1 && <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="url(#spark-fill)" />}
      <path d={line} fill="none" stroke="#A59BFA" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r="2.2" fill="#C9C2FF" />}
    </svg>
  )
}

function PulseCell({ label, children, foot, className }: { label: string; children: React.ReactNode; foot?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 px-4 py-3', className)}>
      <div className="eyebrow">{label}</div>
      <div className="mt-1.5 flex items-end justify-between gap-3">{children}</div>
      {foot && <div className="mt-1 truncate text-[11.5px] text-fg-3">{foot}</div>}
    </div>
  )
}

export function OverviewPage() {
  const boot = useBootstrap()
  const agents = useAgents()
  const missions = useMissions()
  const approvals = useApprovals()
  const activity = useActivity({ limit: 9 })
  const providers = useProviders()
  const usage = useUsage()
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])

  const name = boot.data?.settings.userName
  const list = agents.data ?? []
  const active = list.filter((a) => ['working', 'awaiting_approval', 'error', 'done'].includes(a.status))
  const featured = (active.length ? [...active, ...list.filter((a) => !active.includes(a))] : list).slice(0, 4)
  const workingAgents = list.filter((a) => a.status === 'working' || a.status === 'awaiting_approval')
  const working = list.filter((a) => a.status === 'working').length
  const failing = (missions.data ?? []).filter((m) => m.status === 'failed').slice(0, 3)
  const recent = (missions.data ?? []).slice(0, 5)
  const running = (missions.data ?? []).filter((m) => ACTIVE_MISSION_STATUSES.includes(m.status)).length
  const currentMission = (agentId: string) => (missions.data ?? []).find((m) => m.agentId === agentId && ACTIVE_MISSION_STATUSES.includes(m.status))
  const pendingApprovals = approvals.data?.length ?? 0
  const todo = pendingApprovals + failing.length
  const u = usage.data
  const today = u?.today
  const todayCost = today ? today.official + today.estimated : 0
  const yesterdayCost = u ? u.yesterday.official + u.yesterday.estimated : 0
  const spark = (u?.daily ?? []).slice(-14).map((d) => d.official + d.estimated)

  return (
    <Page>
      <PageHeader
        eyebrow={longDate()}
        title={name ? `${greeting()}, ${name}` : greeting()}
        subtitle={
          agents.isLoading ? (
            <Skeleton className="h-4 w-64" />
          ) : list.length === 0 ? (
            'Votre univers attend son premier compagnon.'
          ) : (
            <span>
              {working ? `${working} compagnon${working > 1 ? 's' : ''} en mission` : 'Tous vos compagnons sont disponibles'}
              {todo > 0 ? <span className="text-warning"> · {todo} élément{todo > 1 ? 's' : ''} attend{todo > 1 ? 'ent' : ''} votre attention</span> : <span className="text-fg-3"> · rien ne vous attend</span>}
            </span>
          )
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => useUi.getState().setPaletteOpen(true)}>
              Rechercher <Kbd>⌘K</Kbd>
            </Button>
            <Button variant="primary" onClick={() => useUi.getState().openNewMission(null)} disabled={!list.length}>
              <Plus /> Nouvelle mission
            </Button>
          </>
        }
      />

      {list.length === 0 && !agents.isLoading ? (
        <Panel>
          <OrbitEmptyState
            title="Aucun compagnon pour l’instant"
            body="Un compagnon est un assistant IA avec sa planète, sa personnalité et ses permissions. Créez le premier pour donner vie à votre univers."
            hints={[
              { icon: <Plus />, label: 'Choisir une planète' },
              { icon: <ShieldCheck />, label: 'Définir ses permissions' },
              { icon: <Rocket />, label: 'Lui confier une mission' },
            ]}
            action={
              <Button variant="primary" onClick={() => navigate('/companions/new')}>
                <Plus /> Créer un compagnon
              </Button>
            }
          />
        </Panel>
      ) : (
        <>
          <section className="card mb-6 grid grid-cols-4 divide-x divide-line" aria-label="En un coup d’œil">
            <PulseCell label="Occupés" foot={workingAgents.length ? workingAgents.map((a) => a.name).join(', ') : 'Personne n’est occupé'}>
              <span className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-fg tabular">
                {workingAgents.length}
                <span className="text-[14px] font-normal text-fg-3"> / {list.length}</span>
              </span>
              <span className="flex -space-x-1.5">
                {workingAgents.slice(0, 4).map((a) => (
                  <span key={a.id} className="rounded-full bg-surface ring-2 ring-surface">
                    <CompanionAvatar appearance={a.appearance} size={22} />
                  </span>
                ))}
              </span>
            </PulseCell>
            <PulseCell label="À traiter" foot={todo ? [pendingApprovals && `${pendingApprovals} approbation${pendingApprovals > 1 ? 's' : ''}`, failing.length && `${failing.length} échec${failing.length > 1 ? 's' : ''}`].filter(Boolean).join(' · ') : 'Tout est en ordre'}>
              <span className={cn('text-[22px] leading-7 font-semibold tracking-[-0.02em] tabular', todo ? 'text-warning' : 'text-fg')}>{todo}</span>
              {todo ? <span className="orbit-blip mb-2 size-2 rounded-full bg-warning" /> : <CheckCircle2 className="mb-1 size-4 text-success" />}
            </PulseCell>
            <PulseCell label="Missions" foot={u ? `${integer(u.missionsDone)} terminée${u.missionsDone > 1 ? 's' : ''} ce mois` : ' '}>
              <span className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-fg tabular">
                {running}
                <span className="text-[14px] font-normal text-fg-3"> en cours</span>
              </span>
            </PulseCell>
            <PulseCell
              label="Aujourd’hui"
              foot={u ? (yesterdayCost ? `Hier ${money(yesterdayCost)}` : 'Estimé · 14 derniers jours') : ' '}
            >
              <span className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-fg tabular">
                {moneyParts(todayCost).value}
                <span className="text-[14px] font-normal text-fg-3"> $</span>
              </span>
              {spark.length > 1 && <Sparkline values={spark} />}
            </PulseCell>
          </section>

          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-[13px] font-medium text-fg-2">{active.length ? 'Compagnons actifs' : 'Vos compagnons'}</h2>
            <PanelLink onClick={() => navigate('/universe')}>Voir mon univers</PanelLink>
          </div>
          <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-3">
            {agents.isLoading
              ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[176px] rounded-xl" />)
              : featured.map((a) => <CompanionCard key={a.id} agent={a} mission={currentMission(a.id)} provider={providers.data?.find((p) => p.id === a.providerId)} />)}
          </div>

          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] items-start gap-4">
            <Panel title="Activité récente" action={<PanelLink onClick={() => navigate('/activity')} />}>
              {activity.data?.length === 0 && <OrbitEmptyState compact title="Rien à signaler" body="Les événements de vos compagnons apparaîtront ici en temps réel." />}
              <div className="space-y-px">
                {activity.isLoading && [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="mx-2.5 my-2 h-9" />)}
                {activity.data?.map((e) => <ActivityEventRow key={e.id} event={e} agent={e.agentId ? byId.get(e.agentId) : undefined} dense />)}
              </div>
            </Panel>

            <div className="space-y-4">
              <Panel
                title={
                  <span className="flex items-center gap-2">
                    À traiter
                    {todo > 0 && <span className="rounded-[5px] bg-warning/15 px-1.5 text-[11px] leading-[18px] text-warning tabular">{todo}</span>}
                  </span>
                }
              >
                {todo === 0 ? (
                  <div className="mx-1 mb-1 flex items-center gap-3 rounded-[11px] bg-success/[0.04] px-3 py-2.5 ring-1 ring-success/10">
                    <span className="flex size-7 items-center justify-center rounded-full bg-success/10">
                      <CheckCircle2 className="size-4 text-success" />
                    </span>
                    <span>
                      <span className="block text-[13px] text-fg">Tout est en ordre</span>
                      <span className="block text-[12px] text-fg-3">Aucune approbation ni erreur en attente.</span>
                    </span>
                  </div>
                ) : (
                  <div className="space-y-1.5 px-0.5 pb-0.5">
                    {approvals.data?.map((a) => <ApprovalRequestCard key={a.id} approval={a} agent={byId.get(a.agentId)} />)}
                    {failing.map((m) => (
                      <button key={m.id} onClick={() => navigate(`/missions/${m.id}`)} className="group flex w-full items-start gap-2.5 rounded-[11px] bg-danger/[0.045] p-3 text-left ring-1 ring-danger/15 transition-colors hover:bg-danger/[0.08]">
                        <AlertTriangle className="mt-px size-4 shrink-0 text-danger" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-fg">{m.title}</span>
                          <span className="block truncate text-xs text-fg-3">{m.error}</span>
                        </span>
                        <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-fg-4 transition-colors group-hover:text-fg-2" />
                      </button>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Missions récentes" action={<PanelLink onClick={() => navigate('/missions')} />}>
                {recent.length === 0 && <div className="px-2.5 pb-3 text-[13px] text-fg-3">Aucune mission pour l’instant.</div>}
                {recent.map((m) => {
                  const a = byId.get(m.agentId)
                  return (
                    <button key={m.id} onClick={() => navigate(`/missions/${m.id}`)} className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-left transition-colors hover:bg-white/[0.03]">
                      <MissionStatusIcon status={m.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-fg">{m.title}</span>
                        <span className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                          {a && <CompanionAvatar appearance={a.appearance} size={13} />}
                          {a?.name} · {relative(m.updatedAt)}
                        </span>
                      </span>
                      <span className="hidden 2xl:block">
                        <MissionStatusLabel status={m.status} />
                      </span>
                    </button>
                  )
                })}
              </Panel>
            </div>
          </div>
        </>
      )}
    </Page>
  )
}
