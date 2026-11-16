import { useEffect, useState } from 'react'
import { Activity, BarChart3, CalendarClock, ChevronRight, FlaskConical, Globe2, LayoutGrid, Plus, Rocket, Search, Server, Settings, Sparkles, Users, Waypoints } from 'lucide-react'
import type { ProviderInfo } from '@shared/types'
import { Kbd } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { moneyParts, money } from '@/lib/format'
import { useAgents, useApprovals, useBootstrap, useHealth, useProviders, useUsage } from '@/lib/queries'
import { call } from '@/lib/api'
import { useDemoModeToggle } from '@/lib/demo-mode'
import { CompanionListItem } from '@/orbit/CompanionListItem'
import { OrbitLogo } from '@/orbit/Logo'
import { HEALTH_META, ProviderHealthCard } from '@/orbit/ProviderHealthPopover'
import { ProviderMark } from '@/orbit/ProviderMark'
import { navigate, useRouter } from '@/stores/router'
import { useUi } from '@/stores/ui'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

const NAV = [
  { path: '/', label: 'Vue d’ensemble', icon: LayoutGrid, key: '1' },
  { path: '/universe', label: 'Mon univers', icon: Globe2, key: '2' },
  { path: '/companions', label: 'Compagnons', icon: Users, key: '3' },
  { path: '/missions', label: 'Missions', icon: Rocket, key: '4' },
  { path: '/constellations', label: 'Constellations', icon: Waypoints },
  { path: '/automations', label: 'Automatisations', icon: CalendarClock },
  { path: '/activity', label: 'Activité', icon: Activity, key: '5' },
  { path: '/analytics', label: 'Statistiques', icon: BarChart3, key: '6' },
  { path: '/machines', label: 'Machines', icon: Server },
  { path: '/settings', label: 'Paramètres', icon: Settings, key: ',' },
] as const

function isActive(path: string, current: string) {
  if (path === '/') return current === '/'
  return current === path || current.startsWith(`${path}/`)
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-2.5">
      <span className="text-[12.5px] font-medium text-fg-3">{children}</span>
      {action}
    </div>
  )
}

function GlobalStatus() {
  const health = useHealth()
  const approvals = useApprovals()
  const worst = (health.data ?? []).reduce<'operational' | 'degraded' | 'outage' | 'unknown'>((acc, h) => {
    const rank = { unknown: 0, operational: 1, degraded: 2, outage: 3 }
    return rank[h.level] > rank[acc] ? h.level : acc
  }, 'unknown')
  const pending = approvals.data?.length ?? 0
  const label = pending
    ? `${pending} demande${pending > 1 ? 's' : ''} en attente`
    : worst === 'operational'
      ? 'Tous les fournisseurs sont opérationnels'
      : worst === 'unknown'
        ? 'Statut des fournisseurs inconnu'
        : `Un fournisseur est ${worst === 'degraded' ? 'dégradé' : 'en incident'}`
  const dot = pending ? 'bg-warning orbit-blip' : HEALTH_META[worst].dot
  return (
    <Tooltip content={label} side="bottom">
      <span className={cn('size-[7px] rounded-full', dot)} aria-label={label} role="img" />
    </Tooltip>
  )
}

function ProviderRow({ provider, cost, selected, onSelect }: { provider: ProviderInfo; cost: number | null; selected: boolean; onSelect: (open: boolean) => void }) {
  const health = useHealth().data?.find((h) => h.providerId === provider.id)
  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const level = health?.level ?? 'unknown'
  return (
    <Popover open={selected} onOpenChange={onSelect}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex h-[36px] w-full items-center gap-3 rounded-[11px] px-2.5 text-left transition-colors outline-none',
            selected ? 'bg-surface shadow-[inset_0_0_0_1px_rgb(126_156_232/0.45)]' : 'hover:bg-white/[0.03]',
          )}
        >
          <ProviderMark id={provider.id} size={20} />
          <span className="flex-1 truncate text-[14px] text-fg">{provider.name}</span>
          <span className="text-[13px] text-fg-2 tabular">{cost == null ? '—' : money(cost)}</span>
          <span className={cn('size-[7px] rounded-full', HEALTH_META[level].dot)} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={14} className="p-0">
        <ProviderHealthCard
          provider={provider}
          health={health}
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true)
            try {
              await call('providers.refreshHealth')
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err))
            }
            await qc.invalidateQueries({ queryKey: ['health'] })
            setRefreshing(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

const PROVIDERS_KEY = 'orbit.sidebar.providers'

/** Collapsed automatically on short windows so companions keep the space; the user's choice wins. */
function useProvidersOpen(): [boolean, (v: boolean) => void] {
  const short = useMediaQuery('(max-height: 1080px)')
  const [pref, setPref] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(PROVIDERS_KEY)
      return v == null ? null : v === '1'
    } catch {
      return null
    }
  })
  const open = pref ?? !short
  return [
    open,
    (v) => {
      setPref(v)
      try {
        localStorage.setItem(PROVIDERS_KEY, v ? '1' : '0')
      } catch {
        /* storage unavailable */
      }
    },
  ]
}

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatch(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}

function ProvidersSection() {
  const providers = useProviders()
  const usage = useUsage()
  const health = useHealth()
  const [open, setOpen] = useState<string | null>(null)
  const [expanded, setExpanded] = useProvidersOpen()
  const today = usage.data?.today
  const known = today ? today.official + today.estimated : 0
  const parts = moneyParts(known)
  const shown = (providers.data ?? []).filter((p) => p.availability === 'available' && (p.hasSecret || p.id === 'demo' || p.connected || p.statusPage))
  const worst = (health.data ?? []).some((h) => h.level === 'outage') ? 'outage' : (health.data ?? []).some((h) => h.level === 'degraded') ? 'degraded' : (health.data ?? []).length ? 'operational' : 'unknown'
  return (
    <div className="px-3 pt-2 pb-2.5">
      <div className="flex h-7 items-center justify-between px-2.5">
        <button
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls="sidebar-providers"
          className="flex items-center gap-1 rounded-[5px] text-[12.5px] font-medium text-fg-3 outline-none hover:text-fg-2 focus-visible:text-fg"
        >
          <ChevronRight className={cn('size-3 transition-transform duration-200', expanded && 'rotate-90')} />
          Fournisseurs · Consommation
        </button>
        {!expanded && <span className={cn('size-[7px] rounded-full', HEALTH_META[worst].dot)} title="Statut des fournisseurs" />}
      </div>
      <button onClick={() => navigate('/analytics')} className="w-full rounded-[11px] px-2.5 py-1 text-left hover:bg-white/[0.02]">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
            Aujourd’hui {expanded && <span className={cn('size-[6px] rounded-full', HEALTH_META[worst].dot)} title="Statut des fournisseurs" />}
          </span>
          {expanded ? <BarChart3 className="size-3.5 text-fg-3" /> : <span className="flex items-baseline gap-0.5 tabular"><span className="text-[15px] font-semibold text-fg">{parts.value}</span><span className="text-[12px] text-fg-2">{parts.currency}</span></span>}
        </div>
        {expanded && (
          <div className="mt-0.5 flex items-baseline gap-1 tabular">
            <span className="text-[28px] leading-8 font-semibold tracking-[-0.02em] text-fg">{parts.value}</span>
            <span className="text-[17px] text-fg-2">{parts.currency}</span>
          </div>
        )}
        {today && (today.unknownCount > 0 || today.estimated > 0 || today.subscriptionCount > 0) && (
          <div className="truncate text-2xs text-fg-3">
            {today.estimated > 0 && (today.official === 0 ? 'Estimé' : 'Dont estimé')}
            {today.unknownCount > 0 && `${today.estimated > 0 ? ' · ' : ''}${today.unknownCount} req. au coût inconnu`}
            {today.subscriptionCount > 0 && `${today.estimated > 0 || today.unknownCount > 0 ? ' · ' : ''}${today.subscriptionCount} req. incluses dans un abonnement`}
          </div>
        )}
      </button>
      {expanded && (
        <div id="sidebar-providers" className="mt-1 max-h-[150px] space-y-px overflow-y-auto">
          {shown.map((p) => {
            const c = usage.data?.byProviderToday.find((b) => b.providerId === p.id)?.cost
            // Usage covered by a subscription or with no known price has no dollar amount: show « — », not 0,00 $.
            const priced = c ? c.official + c.estimated : 0
            const cost = c ? (priced === 0 && (c.subscriptionCount > 0 || c.unknownCount > 0) ? null : priced) : p.hasSecret || p.id === 'demo' ? 0 : null
            return <ProviderRow key={p.id} provider={p} cost={cost} selected={open === p.id} onSelect={(o) => setOpen(o ? p.id : null)} />
          })}
        </div>
      )}
    </div>
  )
}

function DemoPill() {
  const boot = useBootstrap()
  const demo = useDemoModeToggle()
  if (boot.data?.settings.mode !== 'demo') return null
  return (
    <div className="mx-3 mb-3 flex items-center gap-2 rounded-[10px] bg-accent/[0.08] py-1.5 pr-1.5 pl-2.5 text-xs text-accent ring-1 ring-accent/20" role="status">
      <FlaskConical className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 leading-tight">
        Mode démo
        <span className="block text-2xs text-accent/70">Données fictives · hors ligne</span>
      </span>
      <button onClick={() => void demo.switchTo('real')} disabled={demo.isPending} className="rounded-[6px] px-2 py-1 text-2xs font-medium hover:bg-accent/15">
        Quitter
      </button>
    </div>
  )
}

export function Sidebar() {
  const path = useRouter((s) => s.path)
  const agents = useAgents()
  const activeAgentId = /^\/(chat|companions)\/([^/]+)/.exec(path)?.[2]
  /** Arrow keys move between companions; Home/End jump to the ends. */
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-companion-item]')]
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)
    items[next]!.focus()
    items[next]!.scrollIntoView({ block: 'nearest' })
  }

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col bg-sidebar shadow-[inset_-1px_0_0_var(--color-line)]">
      {/* Title bar area: traffic lights live at the top-left */}
      <div className="drag h-[52px] shrink-0" />
      <div className="flex items-center gap-2.5 px-5 pb-3">
        <OrbitLogo size={24} />
        <span className="text-[19px] font-semibold tracking-[-0.01em] text-fg">Orbit</span>
        <GlobalStatus />
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip content={<span className="flex items-center gap-1.5">Rechercher <Kbd>⌘K</Kbd></span>}>
            <button onClick={() => useUi.getState().setPaletteOpen(true)} aria-label="Rechercher" className="flex size-7 items-center justify-center rounded-sm text-fg-3 hover:bg-white/5 hover:text-fg">
              <Search className="size-4" />
            </button>
          </Tooltip>
          <Tooltip content="Nouveau compagnon">
            <button onClick={() => navigate('/companions/new')} aria-label="Nouveau compagnon" className="flex size-7 items-center justify-center rounded-sm text-fg-3 hover:bg-white/5 hover:text-fg">
              <Plus className="size-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      <DemoPill />
      <nav className="shrink-0 space-y-px px-3" aria-label="Navigation principale">
        {NAV.map((item) => {
          const active = isActive(item.path, path) && !(item.path === '/companions' && activeAgentId && path.startsWith('/chat'))
          const Icon = item.icon
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group flex h-[30px] w-full items-center gap-2.5 rounded-[8px] px-2.5 text-[13.5px] transition-colors outline-none focus-visible:bg-white/[0.05] [@media(max-height:760px)]:h-[26px]',
                active ? 'bg-white/[0.06] text-fg' : 'text-fg-2 hover:bg-white/[0.03] hover:text-fg',
              )}
            >
              <Icon className={cn('size-[15px]', active ? 'text-accent' : 'text-fg-3 group-hover:text-fg-2')} strokeWidth={1.8} />
              {item.label}
              {'key' in item && <span className="ml-auto text-2xs text-fg-4 opacity-0 group-hover:opacity-100">⌘{item.key}</span>}
            </button>
          )
        })}
      </nav>

      <div className="mt-3 flex min-h-[160px] flex-1 flex-col px-3">
        <SectionTitle
          action={
            <button onClick={() => navigate('/companions/new')} className="flex size-5 items-center justify-center rounded-[5px] text-fg-3 hover:bg-white/5 hover:text-fg" aria-label="Ajouter un compagnon">
              <Plus className="size-3.5" />
            </button>
          }
        >
          Mes compagnons{agents.data && agents.data.length > 0 && <span className="ml-1.5 text-fg-4 tabular">{agents.data.length}</span>}
        </SectionTitle>
        <div
          role="group"
          aria-label="Mes compagnons · flèches haut/bas pour naviguer"
          onKeyDown={onListKey}
          className="sidebar-scroll -mx-1 mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 pb-2"
        >
          {agents.isLoading &&
            [0, 1, 2].map((i) => (
              <div key={i} className="flex h-[50px] items-center gap-3 px-2.5">
                <div className="skeleton size-[34px] rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-3 w-20 rounded" />
                  <div className="skeleton h-2.5 w-28 rounded" />
                </div>
              </div>
            ))}
          {agents.data?.map((a) => <CompanionListItem key={a.id} agent={a} selected={a.id === activeAgentId} />)}
          {agents.data && agents.data.length === 0 && (
            <button onClick={() => navigate('/companions/new')} className="flex w-full items-center gap-3 rounded-[11px] px-2.5 py-2.5 text-left text-[13px] text-fg-3 hover:bg-white/[0.03] hover:text-fg-2">
              <span className="flex size-[34px] items-center justify-center rounded-full border border-dashed border-line-strong">
                <Sparkles className="size-4" />
              </span>
              Créer votre premier compagnon
            </button>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line">
        <ProvidersSection />
      </div>
    </aside>
  )
}
