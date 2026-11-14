import { CheckCircle2, Circle, CircleDashed, Clock, Loader, PauseCircle, ShieldAlert, XCircle } from 'lucide-react'
import { MISSION_STATUS_LABELS } from '@shared/mission-states'
import type { MissionPriority, MissionStatus as S } from '@shared/types'
import { cn } from '@/lib/cn'

const META: Record<S, { icon: typeof Circle; className: string }> = {
  todo: { icon: Circle, className: 'text-fg-3' },
  scheduled: { icon: Clock, className: 'text-accent-2' },
  running: { icon: Loader, className: 'text-accent' },
  waiting: { icon: PauseCircle, className: 'text-fg-2' },
  approval_required: { icon: ShieldAlert, className: 'text-warning' },
  done: { icon: CheckCircle2, className: 'text-success' },
  failed: { icon: XCircle, className: 'text-danger' },
  cancelled: { icon: CircleDashed, className: 'text-fg-3' },
}

export function MissionStatusIcon({ status, className }: { status: S; className?: string }) {
  const m = META[status]
  const Icon = m.icon
  return <Icon aria-label={MISSION_STATUS_LABELS[status]} className={cn('size-4 shrink-0', m.className, status === 'running' && 'animate-[spin_2.4s_linear_infinite] motion-reduce:animate-none', className)} strokeWidth={2} />
}

export function MissionStatusLabel({ status }: { status: S }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12.5px]', META[status].className)}>
      <MissionStatusIcon status={status} className="size-3.5" />
      <span className={status === 'todo' || status === 'cancelled' ? 'text-fg-3' : undefined}>{MISSION_STATUS_LABELS[status]}</span>
    </span>
  )
}

export const PRIORITY_LABELS: Record<MissionPriority, string> = { low: 'Basse', normal: 'Normale', high: 'Haute', urgent: 'Urgente' }

export function PriorityGlyph({ priority }: { priority: MissionPriority }) {
  const bars = { low: 1, normal: 2, high: 3, urgent: 3 }[priority]
  return (
    <span title={`Priorité ${PRIORITY_LABELS[priority].toLowerCase()}`} className="inline-flex h-3.5 items-end gap-[2px]">
      {[1, 2, 3].map((i) => (
        <span key={i} className={cn('w-[3px] rounded-[1px]', i <= bars ? (priority === 'urgent' ? 'bg-danger' : 'bg-fg-2') : 'bg-white/10')} style={{ height: 4 + i * 3 }} />
      ))}
    </span>
  )
}
