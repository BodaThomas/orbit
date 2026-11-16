import { Copy, MessageCircle, Pause, Play, Rocket, Trash2, UserRound } from 'lucide-react'
import { STATUS_LABELS } from '@shared/catalog'
import type { Agent } from '@shared/types'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/overlay'
import { useAction } from '@/lib/queries'
import { cn } from '@/lib/cn'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'
import { CompanionAvatar } from './CompanionAvatar'
import { useConfirm } from './Confirm'

export function CompanionContextItems({ agent, Item = ContextMenuItem, Separator = ContextMenuSeparator }: { agent: Agent; Item?: typeof ContextMenuItem; Separator?: () => React.ReactNode }) {
  const duplicate = useAction('agents.duplicate', { success: (a) => `${a.name} a été créé` })
  const toggle = useAction('agents.setEnabled')
  const remove = useAction('agents.delete', { success: `${agent.name} a été supprimé` })
  const confirm = useConfirm()
  return (
    <>
      <Item onSelect={() => navigate(`/chat/${agent.id}`)}>
        <MessageCircle /> Ouvrir la conversation
      </Item>
      <Item onSelect={() => useUi.getState().openNewMission(agent.id)}>
        <Rocket /> Nouvelle mission
      </Item>
      <Item onSelect={() => navigate(`/companions/${agent.id}`)}>
        <UserRound /> Voir le profil
      </Item>
      <Separator />
      <Item onSelect={() => duplicate.mutate({ id: agent.id })}>
        <Copy /> Dupliquer
      </Item>
      <Item onSelect={() => toggle.mutate({ id: agent.id, enabled: !agent.enabled })}>
        {agent.enabled ? <Pause /> : <Play />} {agent.enabled ? 'Désactiver' : 'Réactiver'}
      </Item>
      <Item
        danger
        onSelect={async () => {
          const ok = await confirm({
            title: `Supprimer ${agent.name} ?`,
            body: 'Ses conversations, missions et souvenirs seront supprimés définitivement.',
            confirm: 'Supprimer',
            danger: true,
          })
          // Leave the companion's pages only once it is really gone; failures are toasted by useAction.
          if (ok) remove.mutate({ id: agent.id }, { onSuccess: () => navigate('/') })
        }}
      >
        <Trash2 /> Supprimer…
      </Item>
    </>
  )
}

export function CompanionListItem({ agent, selected }: { agent: Agent; selected: boolean }) {
  const subtitle = agent.status === 'working' || agent.status === 'awaiting_approval' ? (agent.statusText ?? STATUS_LABELS[agent.status]) : STATUS_LABELS[agent.status]
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          data-companion-item
          tabIndex={0}
          aria-label={`${agent.name}, ${subtitle}`}
          aria-current={selected ? 'page' : undefined}
          onClick={() => navigate(`/chat/${agent.id}`)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              navigate(`/chat/${agent.id}`)
            }
          }}
          className={cn(
            'group relative flex h-[50px] items-center gap-3 rounded-[11px] px-2.5 outline-none transition-colors',
            selected ? 'bg-surface' : 'hover:bg-white/[0.03] focus-visible:bg-white/[0.04]',
          )}
        >
          <CompanionAvatar appearance={agent.appearance} status={agent.status} size={34} showStatus statusRing={selected ? 'var(--color-surface)' : 'var(--color-sidebar)'} seed={agent.id} name={agent.name} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] leading-tight font-medium text-fg">{agent.name}</div>
            <div className={cn('mt-0.5 truncate text-[12.5px] leading-tight', agent.status === 'error' ? 'text-danger/90' : 'text-fg-3')}>{subtitle}</div>
          </div>
          <div className="pointer-events-none absolute right-2 flex gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            <button
              aria-label={`Nouvelle mission pour ${agent.name}`}
              title="Nouvelle mission"
              onClick={(e) => {
                e.stopPropagation()
                useUi.getState().openNewMission(agent.id)
              }}
              className="flex size-6 items-center justify-center rounded-[6px] bg-elevated text-fg-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-fg"
            >
              <Rocket className="size-3.5" />
            </button>
            <button
              aria-label={`Profil de ${agent.name}`}
              title="Profil"
              onClick={(e) => {
                e.stopPropagation()
                navigate(`/companions/${agent.id}`)
              }}
              className="flex size-6 items-center justify-center rounded-[6px] bg-elevated text-fg-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-fg"
            >
              <UserRound className="size-3.5" />
            </button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <CompanionContextItems agent={agent} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
