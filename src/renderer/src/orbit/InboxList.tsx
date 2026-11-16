import { AlertTriangle, ArrowRight, CalendarClock, Check, CheckCircle2, ListChecks, OctagonPause } from 'lucide-react'
import type { Agent, InboxItem } from '@shared/types'
import { Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { relative } from '@/lib/format'
import { useAction, useApprovals, useInbox } from '@/lib/queries'
import { navigate } from '@/stores/router'
import { ApprovalRequestCard } from './ApprovalRequest'
import { CompanionAvatar } from './CompanionAvatar'

const KIND_META: Record<Exclude<InboxItem['kind'], 'approval'>, { icon: typeof AlertTriangle; tone: 'warning' | 'danger'; label: string }> = {
  plan: { icon: ListChecks, tone: 'warning', label: 'Plan à valider' },
  run_blocked: { icon: OctagonPause, tone: 'warning', label: 'Mission collective bloquée' },
  run_failed: { icon: AlertTriangle, tone: 'danger', label: 'Mission collective en échec' },
  automation_confirm: { icon: CalendarClock, tone: 'warning', label: 'Exécution à confirmer' },
  automation_failed: { icon: AlertTriangle, tone: 'danger', label: 'Automatisation en échec' },
  mission_failed: { icon: AlertTriangle, tone: 'danger', label: 'Mission en échec' },
}

/** Number of things waiting for the user, shared by the sidebar badge and the overview. */
export function useInboxCount(): number {
  return useInbox().data?.length ?? 0
}

function InboxRow({ item, agent }: { item: InboxItem; agent?: Agent }) {
  const dismiss = useAction('inbox.dismiss')
  const meta = KIND_META[item.kind as Exclude<InboxItem['kind'], 'approval'>]
  const Icon = meta.icon
  return (
    <div className={cn('group flex items-start gap-2.5 rounded-[11px] p-3 ring-1 transition-colors', meta.tone === 'danger' ? 'bg-danger/[0.045] ring-danger/15 hover:bg-danger/[0.07]' : 'bg-warning/[0.05] ring-warning/15 hover:bg-warning/[0.08]')}>
      {agent ? <CompanionAvatar appearance={agent.appearance} size={22} seed={agent.id} /> : <Icon className={cn('mt-px size-4 shrink-0', meta.tone === 'danger' ? 'text-danger' : 'text-warning')} />}
      <button onClick={() => navigate(item.route)} className="min-w-0 flex-1 text-left">
        <span className="block text-2xs text-fg-3">
          {meta.label} · {relative(item.createdAt)}
        </span>
        <span className="block truncate text-[13px] text-fg">{item.title}</span>
        {item.detail && <span className="block truncate text-xs text-fg-3">{item.detail}</span>}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        {item.dismissible && (
          <Tooltip content="Marquer comme traité">
            <button onClick={() => dismiss.mutate({ keys: [item.key] })} disabled={dismiss.isPending} aria-label="Marquer comme traité" className="flex size-6 items-center justify-center rounded-[6px] text-fg-3 hover:bg-white/[0.06] hover:text-fg">
              <Check className="size-3.5" />
            </button>
          </Tooltip>
        )}
        <button onClick={() => navigate(item.route)} aria-label="Ouvrir" className="flex size-6 items-center justify-center rounded-[6px] text-fg-3 hover:bg-white/[0.06] hover:text-fg">
          <ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

/** The single « À traiter » list: decisions first, then failures the user has not handled yet. */
export function InboxList({ byId, limit }: { byId: Map<string, Agent>; limit?: number }) {
  const inbox = useInbox()
  const approvals = useApprovals()
  const dismiss = useAction('inbox.dismiss', { success: 'Marqué comme traité' })
  const items = inbox.data ?? []
  if (inbox.isLoading) return <div className="skeleton mx-1 mb-1 h-14 rounded-[11px]" />
  if (items.length === 0) {
    return (
      <div className="mx-1 mb-1 flex items-center gap-3 rounded-[11px] bg-success/[0.04] px-3 py-2.5 ring-1 ring-success/10">
        <span className="flex size-7 items-center justify-center rounded-full bg-success/10">
          <CheckCircle2 className="size-4 text-success" />
        </span>
        <span>
          <span className="block text-[13px] text-fg">Tout est en ordre</span>
          <span className="block text-[12px] text-fg-3">Aucune demande d’accord ni erreur en attente.</span>
        </span>
      </div>
    )
  }
  const shown = limit ? items.slice(0, limit) : items
  const dismissible = items.filter((i) => i.dismissible)
  return (
    <div className="space-y-1.5 px-0.5 pb-0.5">
      {shown.map((item) => {
        if (item.kind === 'approval') {
          const approval = approvals.data?.find((a) => a.id === item.refId)
          return approval ? <ApprovalRequestCard key={item.key} approval={approval} agent={item.agentId ? byId.get(item.agentId) : undefined} /> : null
        }
        return <InboxRow key={item.key} item={item} agent={item.agentId ? byId.get(item.agentId) : undefined} />
      })}
      <div className="flex items-center justify-between px-1 pt-0.5 text-[12px] text-fg-3">
        <span>{items.length > shown.length ? `et ${items.length - shown.length} autre${items.length - shown.length > 1 ? 's' : ''}` : ''}</span>
        {dismissible.length > 1 && (
          <button onClick={() => dismiss.mutate({ keys: dismissible.map((i) => i.key) })} disabled={dismiss.isPending} className="hover:text-fg">
            Marquer les échecs comme traités
          </button>
        )}
      </div>
    </div>
  )
}
