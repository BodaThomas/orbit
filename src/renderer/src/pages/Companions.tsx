import { useMemo, useState } from 'react'
import { MessageCircle, MoreHorizontal, Plus, Rocket } from 'lucide-react'
import { ACTIVE_MISSION_STATUSES } from '@shared/mission-states'
import { PALETTES, STATUS_LABELS } from '@shared/catalog'
import { Page, PageHeader } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Kbd, SearchField, Segmented, Skeleton } from '@/components/ui/field'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/overlay'
import { duration, money } from '@/lib/format'
import { useAgents, useMissions, useProviders, useUsage } from '@/lib/queries'
import { CompanionAvatar, statusColorClass } from '@/orbit/CompanionAvatar'
import { CompanionContextItems } from '@/orbit/CompanionListItem'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { ProviderMark } from '@/orbit/ProviderMark'
import { cn } from '@/lib/cn'
import { navigate } from '@/stores/router'

const AUTONOMY = { manual: 'Manuel', supervised: 'Supervisé', automated: 'Automatisé' } as const
const STATUS_TEXT: Partial<Record<string, string>> = { working: 'text-accent', awaiting_approval: 'text-warning', error: 'text-danger' }

export function CompanionsPage() {
  const agents = useAgents()
  const providers = useProviders()
  const missions = useMissions()
  const usage = useUsage()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'disabled'>('all')
  const all = useMemo(() => agents.data ?? [], [agents.data])
  const list = useMemo(
    () =>
      all.filter((a) => {
        if (filter === 'active' && !a.enabled) return false
        if (filter === 'disabled' && a.enabled) return false
        return !q || `${a.name} ${a.role} ${a.description}`.toLowerCase().includes(q.toLowerCase())
      }),
    [all, q, filter],
  )
  const stats = useMemo(() => {
    const m = new Map<string, { total: number; done: number }>()
    for (const x of missions.data ?? []) {
      const s = m.get(x.agentId) ?? { total: 0, done: 0 }
      s.total++
      if (x.status === 'done') s.done++
      m.set(x.agentId, s)
    }
    return m
  }, [missions.data])
  const current = (id: string) => (missions.data ?? []).find((m) => m.agentId === id && ACTIVE_MISSION_STATUSES.includes(m.status))
  const enabled = all.filter((a) => a.enabled).length
  const busy = all.filter((a) => a.status === 'working' || a.status === 'awaiting_approval').length

  return (
    <Page>
      <PageHeader
        title="Compagnons"
        subtitle={
          all.length ? (
            <span>
              {all.length} habitant{all.length > 1 ? 's' : ''} dans votre univers
              <span className="text-fg-3"> · {busy} en mission · {all.length - enabled} désactivé{all.length - enabled > 1 ? 's' : ''}</span>
            </span>
          ) : (
            'Créez, personnalisez et configurez les habitants de votre univers.'
          )
        }
        actions={
          <Button variant="primary" onClick={() => navigate('/companions/new')}>
            <Plus /> Nouveau compagnon
          </Button>
        }
      />
      <div className="mb-4 flex items-center gap-2.5">
        <SearchField value={q} onChange={setQ} placeholder="Rechercher par nom, rôle, description" className="w-80" trailing={<Kbd>esc</Kbd>} />
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: <>Tous <span className="text-fg-4 tabular">{all.length}</span></> },
            { value: 'active', label: <>Actifs <span className="text-fg-4 tabular">{enabled}</span></> },
            { value: 'disabled', label: <>Désactivés <span className="text-fg-4 tabular">{all.length - enabled}</span></> },
          ]}
        />
        {q && <span className="ml-auto text-[12px] text-fg-3">{list.length} résultat{list.length > 1 ? 's' : ''}</span>}
      </div>

      {agents.isLoading && <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[300px] rounded-xl" />)}</div>}
      {agents.data && list.length === 0 && (
        <div className="card">
          <OrbitEmptyState
            title={all.length ? 'Aucun compagnon ne correspond' : 'Aucun compagnon'}
            body={all.length ? `Rien pour « ${q} »${filter !== 'all' ? ' avec ce filtre' : ''}. Essayez un autre nom ou un rôle.` : 'Créez votre premier compagnon pour peupler votre univers.'}
            action={
              all.length ? (
                <Button variant="secondary" onClick={() => { setQ(''); setFilter('all') }}>Réinitialiser les filtres</Button>
              ) : (
                <Button variant="primary" onClick={() => navigate('/companions/new')}><Plus /> Créer un compagnon</Button>
              )
            }
          />
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
        {list.map((a) => {
          const p = providers.data?.find((x) => x.id === a.providerId)
          const glow = PALETTES[a.appearance.palette].glow
          const m = current(a.id)
          const st = stats.get(a.id)
          const u = usage.data?.byAgentMonth.find((r) => r.agentId === a.id)
          return (
            <div key={a.id} className={cn('card card-hover group relative overflow-hidden', !a.enabled && 'opacity-60 saturate-50')}>
              <button onClick={() => navigate(`/companions/${a.id}`)} className="block w-full text-left">
                <div className="relative flex h-[150px] items-center justify-center overflow-hidden border-b border-line">
                  <span aria-hidden className="absolute inset-0 transition-opacity duration-300 group-hover:opacity-100" style={{ background: `radial-gradient(70% 80% at 50% 62%, ${glow}24, transparent 70%)`, opacity: 0.75 }} />
                  <span aria-hidden className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle at 18% 22%, #ffffff40 0 0.6px, transparent 1px), radial-gradient(circle at 82% 30%, #ffffff30 0 0.6px, transparent 1px), radial-gradient(circle at 70% 82%, #ffffff28 0 0.5px, transparent 1px), radial-gradient(circle at 26% 76%, #ffffff22 0 0.5px, transparent 1px)' }} />
                  <span className="relative transition-transform duration-500 ease-[var(--ease-orbit)] group-hover:-translate-y-1 group-hover:scale-[1.04]">
                    <CompanionAvatar appearance={a.appearance} status={a.status} variant="detailed" size={118} seed={a.id} animated={a.status === 'working'} />
                  </span>
                  <span className="absolute top-2.5 left-2.5 flex h-[22px] items-center gap-1.5 rounded-full bg-black/35 px-2 text-[11px] text-fg-2 ring-1 ring-white/[0.06] backdrop-blur">
                    <span className={cn('size-[6px] rounded-full', statusColorClass(a.status), a.status === 'awaiting_approval' && 'orbit-blip')} />
                    <span className={STATUS_TEXT[a.status]}>{a.enabled ? STATUS_LABELS[a.status] : 'Désactivé'}</span>
                  </span>
                </div>
                <div className="px-3.5 pt-3">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{a.name}</span>
                    <span className="truncate text-[12.5px] text-fg-3">{a.role || 'Compagnon'}</span>
                  </div>
                  {m ? (
                    <div className="mt-1.5 flex h-[36px] items-start gap-1.5 text-[12.5px] leading-[18px] text-fg-2">
                      <Rocket className="mt-[3px] size-3 shrink-0 text-accent" />
                      <span className="line-clamp-2">
                        {m.title}
                        {m.startedAt && <span className="whitespace-nowrap text-fg-3 tabular"> · {duration(m.startedAt)}</span>}
                      </span>
                    </div>
                  ) : (
                    <p className="mt-1.5 line-clamp-2 h-[36px] text-[12.5px] leading-[18px] text-fg-3">{a.description || 'Aucune description.'}</p>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-2 px-3.5 text-[12px] text-fg-3">
                  <ProviderMark id={a.providerId} size={15} />
                  <span className="min-w-0 truncate text-fg-2">{p?.models.find((x) => x.id === a.model)?.label ?? a.model}</span>
                  <span className="ml-auto shrink-0 rounded-[5px] bg-white/[0.05] px-1.5 text-[11px] leading-[18px] text-fg-2">{AUTONOMY[a.autonomy]}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 border-t border-line text-[11.5px]">
                  <div className="border-r border-line px-3.5 py-2">
                    <div className="text-fg-4">Missions</div>
                    <div className="mt-px text-fg-2 tabular">{st ? `${st.done} / ${st.total} terminées` : 'Aucune'}</div>
                  </div>
                  <div className="px-3.5 py-2">
                    <div className="text-fg-4">Ce mois</div>
                    <div className="mt-px truncate text-fg-2 tabular">{u ? `${money(u.cost.official + u.cost.estimated)} · ${u.requests} req.` : 'Aucune requête'}</div>
                  </div>
                </div>
              </button>
              <div className="absolute top-2.5 right-2.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <Button size="icon" variant="secondary" className="backdrop-blur" onClick={() => navigate(`/chat/${a.id}`)} aria-label={`Parler à ${a.name}`}>
                  <MessageCircle />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="secondary" className="backdrop-blur" aria-label="Plus d’actions">
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
        {list.length > 0 && !q && filter !== 'disabled' && (
          <button
            onClick={() => navigate('/companions/new')}
            className="group flex min-h-[260px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.09] text-center transition-colors hover:border-accent/40 hover:bg-accent/[0.03]"
          >
            <span className="relative flex size-16 items-center justify-center">
              <svg viewBox="0 0 64 64" className="absolute inset-0 text-white/15 transition-colors group-hover:text-accent/50" aria-hidden>
                <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" strokeDasharray="2 4" />
                <g className="orbit-anim-spin" style={{ transformOrigin: '32px 32px' }}>
                  <circle cx="62" cy="32" r="2" fill="currentColor" />
                </g>
              </svg>
              <span className="flex size-9 items-center justify-center rounded-full bg-white/[0.05] text-fg-2 ring-1 ring-line transition-colors group-hover:bg-accent/15 group-hover:text-accent">
                <Plus className="size-4" />
              </span>
            </span>
            <span>
              <span className="block text-[13.5px] font-medium text-fg">Nouveau compagnon</span>
              <span className="mt-0.5 block text-[12px] text-fg-3">Une planète, un caractère, un rôle.</span>
            </span>
          </button>
        )}
      </div>
    </Page>
  )
}
