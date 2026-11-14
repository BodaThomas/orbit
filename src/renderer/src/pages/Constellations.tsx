import { useMemo } from 'react'
import { Waypoints } from 'lucide-react'
import { Page, PageHeader } from '@/components/shell/Page'
import { Badge } from '@/components/ui/field'
import { relative } from '@/lib/format'
import { useAgents, useMissions, useWorkflows } from '@/lib/queries'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { MissionStatusLabel } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'

export function ConstellationsPage() {
  const workflows = useWorkflows()
  const agents = useAgents()
  const missions = useMissions()
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])

  return (
    <Page>
      <PageHeader title="Constellations" subtitle="Des groupes de compagnons qui collaborent sur une même mission." />
      {workflows.data?.length === 0 && (
        <div className="rounded-xl bg-surface ring-1 ring-line">
          <OrbitEmptyState
            title="Aucune constellation pour l’instant"
            body="L’orchestration multi-agents (délégation, sous-missions, limites de budget et de profondeur) arrive dans une prochaine phase. Les constellations n’apparaîtront ici qu’à partir de collaborations réelles."
          />
        </div>
      )}
      <div className="space-y-4">
        {workflows.data?.map((wf) => {
          const coordinator = byId.get(wf.coordinatorAgentId)
          const members = wf.memberAgentIds.filter((id) => id !== wf.coordinatorAgentId).map((id) => byId.get(id)).filter(Boolean)
          const W = 640
          return (
            <section key={wf.id} className="overflow-hidden rounded-xl bg-surface ring-1 ring-line">
              <div className="flex items-center gap-3 px-5 pt-4">
                <Waypoints className="size-4 text-accent" />
                <h2 className="text-[15px] font-semibold text-fg">{wf.name}</h2>
                <Badge tone={wf.status === 'active' ? 'accent' : wf.status === 'done' ? 'success' : 'danger'}>{wf.status === 'active' ? 'Active' : wf.status === 'done' ? 'Terminée' : 'Échec'}</Badge>
                <span className="ml-auto text-xs text-fg-3">Créée {relative(wf.createdAt)}</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4 p-5">
                <div className="relative h-[220px] rounded-[12px] bg-[radial-gradient(ellipse_at_50%_30%,#1a1d2b,#13141b_70%)] ring-1 ring-line">
                  <svg viewBox={`0 0 ${W} 220`} className="absolute inset-0 h-full w-full" aria-hidden preserveAspectRatio="none">
                    {members.map((_, i) => {
                      const x = ((i + 1) / (members.length + 1)) * W
                      return <path key={i} d={`M${W / 2} 62 Q${(W / 2 + x) / 2} 110 ${x} 160`} fill="none" stroke="#A59BFA" strokeOpacity="0.5" strokeDasharray="1 5" strokeLinecap="round" />
                    })}
                  </svg>
                  {coordinator && (
                    <button onClick={() => navigate(`/companions/${coordinator.id}`)} className="absolute top-2 left-1/2 flex -translate-x-1/2 flex-col items-center">
                      <CompanionAvatar appearance={coordinator.appearance} variant="detailed" size={72} seed={coordinator.id} status={coordinator.status} />
                      <span className="text-xs text-fg">{coordinator.name} <span className="text-fg-3">· coordination</span></span>
                    </button>
                  )}
                  {members.map((m, i) => (
                    <button key={m!.id} onClick={() => navigate(`/companions/${m!.id}`)} className="absolute bottom-2 flex -translate-x-1/2 flex-col items-center" style={{ left: `${((i + 1) / (members.length + 1)) * 100}%` }}>
                      <CompanionAvatar appearance={m!.appearance} variant="detailed" size={60} seed={m!.id} status={m!.status} animated={m!.status === 'working'} />
                      <span className="text-xs text-fg">{m!.name}</span>
                    </button>
                  ))}
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium text-fg-3">Vue liste</div>
                  <ul className="space-y-1">
                    {[coordinator, ...members].filter(Boolean).map((a) => {
                      const m = missions.data?.find((x) => x.agentId === a!.id && (x.workflowId === wf.id || x.id === wf.missionId || ['running', 'approval_required'].includes(x.status)))
                      return (
                        <li key={a!.id} className="flex items-center gap-2.5 rounded-[9px] px-2 py-1.5">
                          <CompanionAvatar appearance={a!.appearance} size={22} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] text-fg">{a!.name}{a!.id === wf.coordinatorAgentId && <span className="text-fg-3"> · coordinateur</span>}</span>
                            {m && <button onClick={() => navigate(`/missions/${m.id}`)} className="block truncate text-left text-xs text-fg-3 hover:text-fg-2">{m.title}</button>}
                          </span>
                          {m && <MissionStatusLabel status={m.status} />}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
            </section>
          )
        })}
      </div>
    </Page>
  )
}
