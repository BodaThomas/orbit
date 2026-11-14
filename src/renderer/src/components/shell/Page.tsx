import { cn } from '@/lib/cn'

/** Scrollable page with a draggable title-bar strip and a consistent header. */
export function Page({ children, className, wide }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className="relative h-full overflow-y-auto">
      <div className="drag sticky top-0 z-20 h-[40px] bg-gradient-to-b from-canvas via-canvas/80 to-canvas/0" />
      <div className={cn('mx-auto mt-[2px] px-8 pb-12', wide ? 'max-w-[1400px]' : 'max-w-[1180px]', className)}>{children}</div>
    </div>
  )
}

export function PageHeader({ eyebrow, title, subtitle, actions, className }: { eyebrow?: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <header className={cn('mb-6 flex items-end justify-between gap-6', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[13px] text-fg-3">{eyebrow}</div>}
        <h1 className="truncate text-[24px] leading-8 font-semibold tracking-[-0.015em] text-fg">{title}</h1>
        {subtitle && <div className="mt-1 text-[13.5px] text-fg-2">{subtitle}</div>}
      </div>
      {actions && <div className="no-drag flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Panel({ title, action, children, className, bodyClassName }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('rounded-xl bg-surface shadow-card ring-1 ring-line', className)}>
      {title && (
        <div className="flex h-11 items-center justify-between gap-3 px-4">
          <h2 className="text-[13.5px] font-medium text-fg">{title}</h2>
          {action}
        </div>
      )}
      <div className={cn(title ? 'px-2 pb-2' : 'p-2', bodyClassName)}>{children}</div>
    </section>
  )
}

export function SectionLabel({ children, action, className }: { children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex items-center justify-between', className)}>
      <h2 className="text-[13.5px] font-medium text-fg-2">{children}</h2>
      {action}
    </div>
  )
}
