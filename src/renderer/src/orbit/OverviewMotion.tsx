import { ACTIVE_RUN_STATUSES, RUN_STATUS_INFO } from '@shared/constellation-states'
import { ArrowRight, CalendarClock, Server, Waypoints } from 'lucide-react'
import { Badge } from '@/components/ui/field'
import { relative } from '@/lib/format'
import { useAgents, useAutomations, useConstellationRuns, useMissions, useRemoteMachines } from '@/lib/queries'
import { navigate } from '@/stores/router'
import { CompanionAvatar } from './CompanionAvatar'

function Cell({ icon: Icon, title, onOpen, children }: { icon: typeof Waypoints; title: string; onOpen: () => void; children: React.ReactNode }) {
  return (
    <section className="card flex min-w-0 flex-col px-4 py-3">
      <button onClick={onOpen} className="group mb-2 flex items-center gap-1.5 text-left">
        <Icon className="size-3.5 text-fg-3" />
        <span className="eyebrow flex-1">{title}</span>
        <ArrowRight className="size-3 text-fg-4 transition-colors group-hover:text-fg-2" />
      </button>
      <div className="min-w-0 space-y-1.5 text-[12.5px]">{children}</div>
    </section>
  )
}

/**
 * Compact « what is moving » strip: active constellations and their delegated missions,
 * upcoming automations, remote machines. Hidden entirely when none of it is used yet.
 */
export function OverviewMotion() {
  const runs = useConstellationRuns()
  const automations = useAutomations()
  const machines = useRemoteMachines()
  const agents = useAgents()
  const missions = useMissions()
  const activeRuns = (runs.data ?? []).filter((r) => ACTIVE_RUN_STATUSES.includes(r.status))
  const recentRuns = (runs.data ?? []).slice(0, 2)
  const upcoming = (automations.data ?? []).filter((a) => a.status === 'active' && a.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)).slice(0, 3)
  const pendingConfirm = (automations.data ?? []).filter((a) => a.lastRun?.status === 'pending_confirmation').length
  const remote = machines.data ?? []
  const remoteAgents = (agents.data ?? []).filter((a) => a.runtime === 'remote')
  if (!(runs.data?.length || automations.data?.length || remote.length)) return null
  return (
    <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
      <Cell icon={Waypoints} title="Constellations" onOpen={() => navigate('/constellations')}>
        {activeRuns.length ? (
          activeRuns.slice(0, 2).map((r) => (
            <button key={r.id} onClick={() => navigate(`/constellations/runs/${r.id}`)} className="flex w-full items-center gap-2 text-left hover:text-fg">
              <span className="orbit-blip size-1.5 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 flex-1 truncate text-fg-2">{r.constellationName} · {r.goal.split('\n')[0]}</span>
            </button>
          ))
        ) : recentRuns.length ? (
          recentRuns.map((r) => (
            <button key={r.id} onClick={() => navigate(`/constellations/runs/${r.id}`)} className="flex w-full items-center gap-2 text-left">
              <span className="min-w-0 flex-1 truncate text-fg-3">{r.constellationName}</span>
              <Badge tone={RUN_STATUS_INFO[r.status].tone}>{RUN_STATUS_INFO[r.status].label}</Badge>
            </button>
          ))
        ) : (
          <span className="text-fg-3">Aucune exécution</span>
        )}
        {activeRuns.length > 0 && <div className="text-2xs text-fg-4">{activeRuns.length} en cours</div>}
      </Cell>
      <Cell icon={CalendarClock} title="À venir" onOpen={() => navigate('/automations')}>
        {upcoming.length ? (
          upcoming.map((a) => (
            <div key={a.id} className="flex items-center gap-2">
              {a.schedulerOwner !== 'local' && <Server className="size-3 shrink-0 text-fg-4" aria-label="Sur une machine" />}
              <span className="min-w-0 flex-1 truncate text-fg-2">{a.name}</span>
              <span className="shrink-0 text-2xs text-fg-3 tabular">{relative(a.nextRunAt)}</span>
            </div>
          ))
        ) : (
          <span className="text-fg-3">Aucune automatisation prévue</span>
        )}
        {pendingConfirm > 0 && <div className="text-2xs text-warning">{pendingConfirm} exécution{pendingConfirm > 1 ? 's' : ''} manquée{pendingConfirm > 1 ? 's' : ''} à confirmer</div>}
      </Cell>
      {remote.length > 0 && (
        <Cell icon={Server} title="Machines distantes" onOpen={() => navigate('/machines')}>
          {remote.slice(0, 2).map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <span className={`size-1.5 shrink-0 rounded-full ${m.status === 'online' ? 'bg-success' : m.status === 'error' ? 'bg-danger' : 'bg-fg-4'}`} />
              <span className="min-w-0 flex-1 truncate text-fg-2">{m.name}</span>
              <span className="shrink-0 text-2xs text-fg-3">{m.runningMissions ? `${m.runningMissions} mission${m.runningMissions > 1 ? 's' : ''}` : m.status === 'online' ? 'en ligne' : 'hors ligne'}</span>
            </div>
          ))}
          {(() => {
            const approvals = remote.reduce((n, m) => n + m.pendingApprovals, 0)
            const last = (missions.data ?? []).find((x) => x.remoteMachineId && x.status === 'done')
            return (
              <>
                {approvals > 0 && <div className="text-2xs text-warning">{approvals} accord{approvals > 1 ? 's' : ''} demandé{approvals > 1 ? 's' : ''} par une machine</div>}
                {last && (
                  <button onClick={() => navigate(`/missions/${last.id}`)} className="block w-full truncate text-left text-2xs text-fg-4 hover:text-fg-2">
                    Terminée sur une machine : {last.title}
                  </button>
                )}
              </>
            )
          })()}
          {remoteAgents.length > 0 && (
            <div className="flex items-center gap-1.5 text-2xs text-fg-4">
              <span className="flex -space-x-1">{remoteAgents.slice(0, 4).map((a) => <CompanionAvatar key={a.id} appearance={a.appearance} size={14} />)}</span>
              {remoteAgents.length} compagnon{remoteAgents.length > 1 ? 's' : ''} distant{remoteAgents.length > 1 ? 's' : ''}
            </div>
          )}
        </Cell>
      )}
    </div>
  )
}
