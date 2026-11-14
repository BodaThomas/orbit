import { useMemo, useState } from 'react'
import { MessageCircle, MoreHorizontal, Plus, Search } from 'lucide-react'
import { STATUS_LABELS } from '@shared/catalog'
import { Page, PageHeader } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Segmented, Skeleton } from '@/components/ui/field'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/overlay'
import { relative } from '@/lib/format'
import { useAgents, useProviders } from '@/lib/queries'
import { CompanionAvatar, statusColorClass } from '@/orbit/CompanionAvatar'
import { CompanionContextItems } from '@/orbit/CompanionListItem'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { ProviderMark } from '@/orbit/ProviderMark'
import { cn } from '@/lib/cn'
import { navigate } from '@/stores/router'

export function CompanionsPage() {
  const agents = useAgents()
  const providers = useProviders()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'disabled'>('all')
  const list = useMemo(
    () =>
      (agents.data ?? []).filter((a) => {
        if (filter === 'active' && !a.enabled) return false
        if (filter === 'disabled' && a.enabled) return false
        return !q || `${a.name} ${a.role}`.toLowerCase().includes(q.toLowerCase())
      }),
    [agents.data, q, filter],
  )
  const autonomy = { manual: 'Manuel', supervised: 'Supervisé', automated: 'Automatisé' }

  return (
    <Page>
      <PageHeader
        title="Compagnons"
        subtitle="Créez, personnalisez et configurez les habitants de votre univers."
        actions={
          <Button variant="primary" onClick={() => navigate('/companions/new')}>
            <Plus /> Nouveau compagnon
          </Button>
        }
      />
      <div className="mb-4 flex items-center gap-3">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un compagnon" className="pl-8" />
        </div>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Tous' }, { value: 'active', label: 'Actifs' }, { value: 'disabled', label: 'Désactivés' }]} />
      </div>

      {agents.isLoading && <div className="grid grid-cols-3 gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-56 rounded-xl" />)}</div>}
      {agents.data && list.length === 0 && (
        <OrbitEmptyState title={agents.data.length ? 'Aucun résultat' : 'Aucun compagnon'} body={agents.data.length ? 'Essayez une autre recherche.' : 'Créez votre premier compagnon pour peupler votre univers.'} />
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {list.map((a) => {
          const p = providers.data?.find((x) => x.id === a.providerId)
          return (
            <div key={a.id} className={cn('group relative rounded-xl bg-surface ring-1 ring-line transition-[box-shadow,background] hover:bg-[#1d1f27] hover:ring-line-strong', !a.enabled && 'opacity-70')}>
              <button onClick={() => navigate(`/companions/${a.id}`)} className="block w-full p-4 text-left">
                <div className="flex justify-center rounded-[12px] bg-[radial-gradient(ellipse_at_50%_60%,#1b1e2b,transparent_70%)] py-2">
                  <CompanionAvatar appearance={a.appearance} status={a.status} variant="detailed" size={120} seed={a.id} />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-fg">{a.name}</span>
                  <span className={cn('size-[7px] rounded-full', statusColorClass(a.status))} />
                  <span className="truncate text-xs text-fg-3">{STATUS_LABELS[a.status]}</span>
                </div>
                <div className="truncate text-[13px] text-fg-2">{a.role || '—'}</div>
                <div className="mt-3 flex items-center gap-2 text-xs text-fg-3">
                  <ProviderMark id={a.providerId} size={16} />
                  <span className="truncate">{p?.models.find((m) => m.id === a.model)?.label ?? a.model}</span>
                  <Badge className="ml-auto">{autonomy[a.autonomy]}</Badge>
                </div>
                <div className="mt-2 text-2xs text-fg-4">Modifié {relative(a.updatedAt)}</div>
              </button>
              <div className="absolute top-3 right-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <Button size="icon" variant="secondary" onClick={() => navigate(`/chat/${a.id}`)} aria-label={`Parler à ${a.name}`}>
                  <MessageCircle />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="secondary" aria-label="Plus d’actions">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <CompanionContextItems agent={a} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )
        })}
      </div>
    </Page>
  )
}
