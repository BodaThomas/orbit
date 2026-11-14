import { cn } from '@/lib/cn'
import { Companion } from './Companion'

/** Empty states feature a sleepy little companion instead of a generic icon. */
export function OrbitEmptyState({ title, body, action, compact, className }: { title: string; body?: React.ReactNode; action?: React.ReactNode; compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-7' : 'px-6 py-14', className)}>
      <div className="relative mb-3">
        <div className="absolute inset-x-1 -bottom-1 h-2 rounded-[50%] bg-black/40 blur-[3px]" />
        <Companion appearance={{ species: 'cloud', palette: 'slate', expression: 'sleepy' }} size={compact ? 40 : 56} />
      </div>
      <div className="text-[14px] font-medium text-fg">{title}</div>
      {body && <div className="mt-1 max-w-sm text-[13px] leading-relaxed text-fg-3">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
