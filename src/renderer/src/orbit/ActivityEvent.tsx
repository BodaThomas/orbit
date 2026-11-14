import { AlertTriangle, Bot, CheckCircle2, FileText, KeyRound, MessageSquare, Play, Rocket, ShieldCheck, Square, Trash2, Wallet, Wrench, XCircle } from 'lucide-react'
import type { ActivityEvent as Evt, Agent } from '@shared/types'
import { Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { dateTime, relative } from '@/lib/format'
import { navigate } from '@/stores/router'
import { CompanionAvatar } from './CompanionAvatar'

const ICONS: Record<Evt['type'], typeof Bot> = {
  'agent.created': Bot,
  'agent.updated': Bot,
  'agent.deleted': Trash2,
  'conversation.created': MessageSquare,
  'message.received': MessageSquare,
  'mission.created': Rocket,
  'mission.started': Play,
  'mission.completed': CheckCircle2,
  'mission.failed': XCircle,
  'mission.cancelled': Square,
  'approval.requested': ShieldCheck,
  'approval.resolved': ShieldCheck,
  'tool.called': Wrench,
  'file.written': FileText,
  'provider.connected': KeyRound,
  'provider.error': AlertTriangle,
  'budget.reached': Wallet,
}

const LEVEL = { info: 'text-fg-3', success: 'text-success', warning: 'text-warning', error: 'text-danger' }

export function ActivityEventRow({ event, agent, dense }: { event: Evt; agent?: Agent; dense?: boolean }) {
  const Icon = ICONS[event.type] ?? Bot
  const target = event.missionId ? `/missions/${event.missionId}` : event.conversationId && agent ? `/chat/${agent.id}/${event.conversationId}` : agent ? `/companions/${agent.id}` : null
  return (
    <button
      disabled={!target}
      onClick={() => target && navigate(target)}
      className={cn('group flex w-full items-start gap-3 rounded-[10px] px-2.5 text-left transition-colors enabled:hover:bg-white/[0.03]', dense ? 'py-2' : 'py-2.5')}
    >
      <span className="relative mt-0.5 shrink-0">
        {agent ? (
          <CompanionAvatar appearance={agent.appearance} size={28} seed={agent.id} />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-full bg-white/[0.05]">
            <Icon className={cn('size-3.5', LEVEL[event.level])} />
          </span>
        )}
        {agent && (
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-surface ring-2 ring-surface">
            <Icon className={cn('size-3', LEVEL[event.level])} strokeWidth={2.2} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[13.5px] text-fg">{event.title}</span>
        </span>
        {event.detail && <span className="mt-0.5 block truncate text-[12.5px] text-fg-3">{event.detail}</span>}
      </span>
      <Tooltip content={dateTime(event.createdAt)}>
        <span className="mt-0.5 shrink-0 text-xs text-fg-3 tabular">{relative(event.createdAt)}</span>
      </Tooltip>
    </button>
  )
}
