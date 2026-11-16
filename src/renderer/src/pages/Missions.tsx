import { useMemo, useState } from 'react'
import { Columns3, List, Plus, Search } from 'lucide-react'
import { MISSION_STATUS_LABELS } from '@shared/mission-states'
import type { Agent, Mission, MissionStatus } from '@shared/types'
import { Page, PageHeader } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Input, Segmented, Skeleton } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { duration, money, relative } from '@/lib/format'
import { useAgents, useMissions } from '@/lib/queries'
import { Companion } from '@/orbit/Companion'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { MissionStatusIcon, MissionStatusLabel, PriorityGlyph } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

const COLUMNS: { title: string; statuses: MissionStatus[] }[] = [
  { title: 'À faire', statuses: ['todo', 'scheduled'] },
  { title: 'En cours', statuses: ['running', 'waiting'] },
  { title: 'À approuver', statuses: ['approval_required'] },
  { title: 'Terminées', statuses: ['done'] },
  { title: 'Échecs & annulées', statuses: ['failed', 'cancelled'] },
]

function MissionCard({ m, agent }: { m: Mission; agent?: Agent }) {
  return (
    <button onClick={() => navigate(`/missions/${m.id}`)} className="w-full rounded-[11px] bg-surface p-3 text-left ring-1 ring-line transition-colors hover:bg-[#1d1f27] hover:ring-line-strong">
      <div className="flex items-center gap-2 text-2xs text-fg-3">
        <span className="font-mono">{m.shortId}</span>
        <PriorityGlyph priority={m.priority} />
        <span className="ml-auto">
          <MissionStatusIcon status={m.status} className="size-3.5" />
        </span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-fg">{m.title}</div>
      <div className="mt-2.5 flex items-center gap-1.5 text-xs text-fg-3">
        {agent && <Companion appearance={agent.appearance} size={16} />}
        <span className="truncate">{agent?.name}</span>
        <span className="ml-auto tabular">{m.status === 'running' ? duration(m.startedAt) : relative(m.updatedAt)}</span>
      </div>
    </button>
  )
}

export function MissionsPage() {
  const missions = useMissions()
  const agents = useAgents()
  const [view, setView] = useState<'list' | 'board'>('list')
  const [q, setQ] = useState('')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<MissionStatus | 'all'>('all')
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])
  const list = (missions.data ?? []).filter(
    (m) =>
      (agentFilter === 'all' || m.agentId === agentFilter) &&
      (statusFilter === 'all' || m.status === statusFilter) &&
      (!q || `${m.title} ${m.shortId} ${m.description}`.toLowerCase().includes(q.toLowerCase())),
  )

  return (
    <Page wide>
      <PageHeader
        title="Missions"
        subtitle="Les tâches confiées à vos compagnons, en temps réel."
        actions={
          <Button variant="primary" onClick={() => useUi.getState().openNewMission(null)} disabled={!agents.data?.length}>
            <Plus /> Nouvelle mission
          </Button>
        }
      />
      <div className="no-drag mb-4 flex items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher" className="pl-8" />
        </div>
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="h-8 rounded-md bg-white/[0.035] px-2.5 text-[13px] text-fg-2 ring-1 ring-line outline-none" aria-label="Filtrer par compagnon">
          <option value="all">Tous les compagnons</option>
          {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as MissionStatus | 'all')} className="h-8 rounded-md bg-white/[0.035] px-2.5 text-[13px] text-fg-2 ring-1 ring-line outline-none" aria-label="Filtrer par statut">
          <option value="all">Tous les statuts</option>
          {(Object.keys(MISSION_STATUS_LABELS) as MissionStatus[]).map((s) => <option key={s} value={s}>{MISSION_STATUS_LABELS[s]}</option>)}
        </select>
        <Segmented
          className="ml-auto"
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: <><List /> Liste</> },
            { value: 'board', label: <><Columns3 /> Tableau</> },
          ]}
        />
      </div>

      {missions.isLoading && <Skeleton className="h-64 rounded-xl" />}
      {missions.isError && !missions.data && (
        <div className="rounded-xl bg-surface ring-1 ring-line">
          <OrbitEmptyState
            title="Impossible de charger les missions"
            body={missions.error instanceof Error ? missions.error.message : 'Une erreur est survenue.'}
            action={<Button onClick={() => void missions.refetch()}>Réessayer</Button>}
          />
        </div>
      )}
      {missions.data && list.length === 0 && (
        <div className="rounded-xl bg-surface ring-1 ring-line">
          <OrbitEmptyState title={missions.data.length ? 'Aucune mission ne correspond' : 'Aucune mission'} body={missions.data.length ? 'Modifiez vos filtres.' : 'Créez une mission pour mettre un compagnon au travail.'} />
        </div>
      )}

      {list.length > 0 && view === 'list' && (
        <div className="overflow-hidden rounded-xl bg-surface ring-1 ring-line">
          <div className="grid grid-cols-[64px_minmax(0,1fr)_150px_44px_190px_120px_96px] items-center gap-3 border-b border-line px-4 py-2 text-2xs font-medium text-fg-3">
            <span>ID</span><span>Mission</span><span>Compagnon</span><span>Prio.</span><span>Statut</span><span className="text-right">Coût</span><span className="text-right">Mis à jour</span>
          </div>
          {list.map((m) => {
            const a = byId.get(m.agentId)
            return (
              <button key={m.id} onClick={() => navigate(`/missions/${m.id}`)} className="grid w-full grid-cols-[64px_minmax(0,1fr)_150px_44px_190px_120px_96px] items-center gap-3 border-b border-line/60 px-4 py-2.5 text-left last:border-0 hover:bg-white/[0.02]">
                <span className="font-mono text-2xs text-fg-3">{m.shortId}</span>
                <span className="truncate text-[13.5px] text-fg">{m.title}</span>
                <span className="flex items-center gap-2 truncate text-[13px] text-fg-2">{a && <Companion appearance={a.appearance} size={18} />}{a?.name}</span>
                <PriorityGlyph priority={m.priority} />
                <MissionStatusLabel status={m.status} />
                <span className={cn('text-right text-xs tabular', m.costUsd == null ? 'text-fg-4' : 'text-fg-2')} title={m.costKind === 'estimated' ? 'Coût estimé : jetons officiels × tarifs publics datés' : undefined}>
                  {m.costUsd == null ? '—' : money(m.costUsd, true)}
                  {m.costUsd != null && m.costKind === 'estimated' && <span className="ml-1 text-2xs text-fg-4">estimé</span>}
                </span>
                <span className="text-right text-xs text-fg-3 tabular">{relative(m.updatedAt)}</span>
              </button>
            )
          })}
        </div>
      )}

      {list.length > 0 && view === 'board' && (
        <div className="grid grid-cols-5 gap-3">
          {COLUMNS.map((col) => {
            const items = list.filter((m) => col.statuses.includes(m.status))
            return (
              <div key={col.title} className="min-w-0 rounded-xl bg-white/[0.015] p-2 ring-1 ring-line">
                <div className="mb-2 flex items-center justify-between px-1.5 pt-0.5 text-xs text-fg-2">
                  {col.title} <span className="text-fg-3 tabular">{items.length}</span>
                </div>
                <div className="space-y-2">{items.map((m) => <MissionCard key={m.id} m={m} agent={byId.get(m.agentId)} />)}</div>
              </div>
            )
          })}
        </div>
      )}
    </Page>
  )
}
