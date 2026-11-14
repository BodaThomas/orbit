import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Scrollable page with a draggable title-bar strip and a consistent header. */
export function Page({ children, className, wide }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className="relative h-full overflow-y-auto">
      <div className="drag sticky top-0 z-20 h-[36px] bg-gradient-to-b from-canvas via-canvas/80 to-canvas/0" />
      <div className={cn('mx-auto px-7 pb-10', wide ? 'max-w-[1400px]' : 'max-w-[1240px]', className)}>{children}</div>
    </div>
  )
}

export function PageHeader({ eyebrow, title, subtitle, actions, className }: { eyebrow?: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <header className={cn('mb-5 flex items-end justify-between gap-6', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[12.5px] text-fg-3">{eyebrow}</div>}
        <h1 className="truncate text-[24px] leading-8 font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {subtitle && <div className="mt-0.5 text-[13.5px] text-fg-2">{subtitle}</div>}
      </div>
      {actions && <div className="no-drag flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Panel({ title, action, children, className, bodyClassName }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('card', className)}>
      {title && (
        <div className="flex h-10 items-center justify-between gap-3 pr-3 pl-4">
          <h2 className="text-[13px] font-medium text-fg">{title}</h2>
          {action}
        </div>
      )}
      <div className={cn(title ? 'px-1.5 pb-1.5' : 'p-1.5', bodyClassName)}>{children}</div>
    </section>
  )
}

/** Quiet "Tout voir →" link used in panel headers. */
export function PanelLink({ onClick, children = 'Tout voir' }: { onClick: () => void; children?: React.ReactNode }) {
  return (
    <button onClick={onClick} className="group/link flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12px] text-fg-3 transition-colors hover:bg-white/[0.04] hover:text-fg">
      {children}
      <ArrowRight className="-ml-1 size-3 w-0 opacity-0 transition-[opacity,width,margin] duration-200 group-hover/link:ml-0 group-hover/link:w-3 group-hover/link:opacity-100" />
    </button>
  )
}

export function SectionLabel({ children, action, className }: { children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2.5 flex items-center justify-between', className)}>
      <h2 className="text-[13px] font-medium text-fg-2">{children}</h2>
      {action}
    </div>
  )
}
