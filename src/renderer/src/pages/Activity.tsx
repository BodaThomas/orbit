import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { ActivityEvent, ActivityLevel } from '@shared/types'
import { Page, PageHeader } from '@/components/shell/Page'
import { Input, Segmented, Skeleton } from '@/components/ui/field'
import { useActivity, useAgents } from '@/lib/queries'
import { ActivityEventRow } from '@/orbit/ActivityEvent'
import { OrbitEmptyState } from '@/orbit/EmptyState'

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Aujourd’hui'
  if (d.toDateString() === y.toDateString()) return 'Hier'
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
}

export function ActivityPage({ initialQuery = '' }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery)
  const [level, setLevel] = useState<ActivityLevel | 'all'>('all')
  const [agentId, setAgentId] = useState('all')
  const agents = useAgents()
  const activity = useActivity({ limit: 300, query: query || undefined, level: level === 'all' ? undefined : level, agentId: agentId === 'all' ? undefined : agentId })
  const data = activity.data
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])
  const groups = useMemo(() => {
    const out: { label: string; items: ActivityEvent[] }[] = []
    for (const e of data ?? []) {
      const label = dayLabel(e.createdAt)
      const last = out.at(-1)
      if (last?.label === label) last.items.push(e)
      else out.push({ label, items: [e] })
    }
    return out
  }, [data])

  return (
    <Page>
      <PageHeader title="Activité" subtitle="Tous les événements de votre univers, persistés et mis à jour en direct." />
      <div className="no-drag mb-4 flex items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher dans l’activité" className="pl-8" />
        </div>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Compagnon" className="h-8 rounded-md bg-white/[0.035] px-2.5 text-[13px] text-fg-2 ring-1 ring-line outline-none">
          <option value="all">Tous les compagnons</option>
          {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <Segmented className="ml-auto" value={level} onChange={setLevel} options={[{ value: 'all', label: 'Tout' }, { value: 'success', label: 'Succès' }, { value: 'warning', label: 'Alertes' }, { value: 'error', label: 'Erreurs' }]} />
      </div>
      {activity.isLoading && <Skeleton className="h-80 rounded-xl" />}
      {activity.data?.length === 0 && <div className="rounded-xl bg-surface ring-1 ring-line"><OrbitEmptyState title="Aucun événement" body="Rien ne correspond à ces filtres." /></div>}
      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.label}>
            <h2 className="mb-1.5 px-1 text-xs font-medium text-fg-3 first-letter:uppercase">{g.label}</h2>
            <div className="rounded-xl bg-surface p-1.5 ring-1 ring-line">
              {g.items.map((e) => <ActivityEventRow key={e.id} event={e} agent={e.agentId ? byId.get(e.agentId) : undefined} dense />)}
            </div>
          </section>
        ))}
      </div>
    </Page>
  )
}
