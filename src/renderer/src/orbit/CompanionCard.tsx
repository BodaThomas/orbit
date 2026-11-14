import { STATUS_LABELS } from '@shared/catalog'
import type { Agent, Mission, ProviderInfo } from '@shared/types'
import { cn } from '@/lib/cn'
import { duration } from '@/lib/format'
import { navigate } from '@/stores/router'
import { CompanionAvatar, statusColorClass } from './CompanionAvatar'
import { ProviderMark } from './ProviderMark'

export function CompanionCard({ agent, mission, provider }: { agent: Agent; mission?: Mission; provider?: ProviderInfo }) {
  const model = provider?.models.find((m) => m.id === agent.model)?.label ?? agent.model
  return (
    <button
      onClick={() => navigate(`/companions/${agent.id}`)}
      className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl bg-surface p-4 text-left shadow-card ring-1 ring-line transition-[background,box-shadow] duration-200 hover:bg-[#1d1f27] hover:ring-line-strong"
    >
      <div className="flex items-start gap-3.5">
        <CompanionAvatar appearance={agent.appearance} status={agent.status} variant="detailed" size={64} seed={agent.id} animated={agent.status === 'working'} className="-mt-1 -ml-1" />
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-fg">{agent.name}</span>
            <span className={cn('size-[7px] shrink-0 rounded-full', statusColorClass(agent.status), agent.status === 'awaiting_approval' && 'orbit-blip')} />
          </div>
          <div className="truncate text-[12.5px] text-fg-3">{agent.role || 'Compagnon'}</div>
        </div>
      </div>
      <div className="mt-3 min-h-[38px]">
        <div className={cn('line-clamp-2 text-[13px] leading-snug', mission ? 'text-fg-2' : 'text-fg-3')}>
          {mission ? mission.title : (agent.statusText ?? STATUS_LABELS[agent.status])}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-xs text-fg-3">
        <ProviderMark id={agent.providerId} size={16} />
        <span className="truncate">{model}</span>
        {mission?.startedAt && (agent.status === 'working' || agent.status === 'awaiting_approval') && (
          <span className="ml-auto shrink-0 tabular">{duration(mission.startedAt)}</span>
        )}
      </div>
    </button>
  )
}
