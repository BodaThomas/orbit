import { useMemo } from 'react'
import { AlertTriangle, ArrowRight, Plus } from 'lucide-react'
import { ACTIVE_MISSION_STATUSES } from '@shared/mission-states'
import { Page, PageHeader, Panel } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/field'
import { longDate, greeting, relative, money } from '@/lib/format'
import { useActivity, useAgents, useApprovals, useBootstrap, useMissions, useProviders, useUsage } from '@/lib/queries'
import { ActivityEventRow } from '@/orbit/ActivityEvent'
import { ApprovalRequestCard } from '@/orbit/ApprovalRequest'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { CompanionCard } from '@/orbit/CompanionCard'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { MissionStatusIcon, MissionStatusLabel } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

export function OverviewPage() {
  const boot = useBootstrap()
  const agents = useAgents()
  const missions = useMissions()
  const approvals = useApprovals()
  const activity = useActivity({ limit: 14 })
  const providers = useProviders()
  const usage = useUsage()
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])

  const name = boot.data?.settings.userName
  const list = agents.data ?? []
  const active = list.filter((a) => ['working', 'awaiting_approval', 'error', 'done'].includes(a.status))
  const featured = (active.length ? [...active, ...list.filter((a) => !active.includes(a))] : list).slice(0, 4)
  const working = list.filter((a) => a.status === 'working').length
  const failing = (missions.data ?? []).filter((m) => m.status === 'failed').slice(0, 3)
  const recent = (missions.data ?? []).slice(0, 6)
  const currentMission = (agentId: string) => (missions.data ?? []).find((m) => m.agentId === agentId && ACTIVE_MISSION_STATUSES.includes(m.status))
  const todo = (approvals.data?.length ?? 0) + failing.length
  const today = usage.data?.today

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
              {todo > 0 && <span className="text-warning"> · {todo} élément{todo > 1 ? 's' : ''} à traiter</span>}
              {today && today.official + today.estimated > 0 && <span className="text-fg-3"> · {money(today.official + today.estimated)} aujourd’hui</span>}
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
            body="Créez un compagnon, choisissez sa planète et connectez-le à un fournisseur pour commencer."
            action={
              <Button variant="primary" onClick={() => navigate('/companions/new')}>
                <Plus /> Créer un compagnon
              </Button>
            }
          />
        </Panel>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13.5px] font-medium text-fg-2">{active.length ? 'Compagnons actifs' : 'Vos compagnons'}</h2>
            <button onClick={() => navigate('/universe')} className="flex items-center gap-1 text-[12.5px] text-fg-3 hover:text-fg">
              Voir mon univers <ArrowRight className="size-3.5" />
            </button>
          </div>
          <div className="mb-7 grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
            {agents.isLoading
              ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[168px] rounded-xl" />)
              : featured.map((a) => <CompanionCard key={a.id} agent={a} mission={currentMission(a.id)} provider={providers.data?.find((p) => p.id === a.providerId)} />)}
          </div>

          <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)] gap-4">
            <Panel
              title="Activité récente"
              action={
                <button onClick={() => navigate('/activity')} className="text-[12.5px] text-fg-3 hover:text-fg">
                  Tout voir
                </button>
              }
            >
              {activity.data?.length === 0 && <OrbitEmptyState compact title="Rien à signaler" body="Les événements de vos compagnons apparaîtront ici en temps réel." />}
              <div className="space-y-px">
                {activity.isLoading && [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="mx-2.5 my-2 h-9" />)}
                {activity.data?.map((e) => <ActivityEventRow key={e.id} event={e} agent={e.agentId ? byId.get(e.agentId) : undefined} />)}
              </div>
            </Panel>

            <div className="space-y-4">
              <Panel title={<span className="flex items-center gap-2">À traiter {todo > 0 && <span className="rounded-full bg-warning/15 px-1.5 text-[11px] text-warning tabular">{todo}</span>}</span>}>
                {todo === 0 ? (
                  <div className="px-2.5 pt-0.5 pb-3 text-[13px] text-fg-3">Aucune approbation ni erreur en attente.</div>
                ) : (
                  <div className="space-y-2 px-1 pb-1">
                    {approvals.data?.map((a) => <ApprovalRequestCard key={a.id} approval={a} agent={byId.get(a.agentId)} />)}
                    {failing.map((m) => (
                      <button key={m.id} onClick={() => navigate(`/missions/${m.id}`)} className="flex w-full items-start gap-2.5 rounded-[11px] bg-danger/[0.05] p-3 text-left ring-1 ring-danger/15 hover:bg-danger/[0.08]">
                        <AlertTriangle className="mt-px size-4 shrink-0 text-danger" />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] text-fg">{m.title}</span>
                          <span className="block truncate text-xs text-fg-3">{m.error}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel
                title="Missions récentes"
                action={
                  <button onClick={() => navigate('/missions')} className="text-[12.5px] text-fg-3 hover:text-fg">
                    Tout voir
                  </button>
                }
              >
                {recent.length === 0 && <div className="px-2.5 pb-3 text-[13px] text-fg-3">Aucune mission pour l’instant.</div>}
                {recent.map((m) => {
                  const a = byId.get(m.agentId)
                  return (
                    <button key={m.id} onClick={() => navigate(`/missions/${m.id}`)} className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-white/[0.03]">
                      <MissionStatusIcon status={m.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-fg">{m.title}</span>
                        <span className="flex items-center gap-1.5 text-xs text-fg-3">
                          {a && <CompanionAvatar appearance={a.appearance} size={14} />}
                          {a?.name} · {relative(m.updatedAt)}
                        </span>
                      </span>
                      <span className="hidden xl:block">
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
