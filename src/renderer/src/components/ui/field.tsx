import { forwardRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

const base =
  'w-full rounded-md bg-white/[0.035] hover:bg-white/[0.05] transition-[background,box-shadow] text-[13px] text-fg placeholder:text-fg-3 shadow-[inset_0_0_0_1px_var(--color-line)] transition-shadow outline-none focus:shadow-[inset_0_0_0_1px_rgb(165_155_250/0.55),0_0_0_3px_rgb(165_155_250/0.12)] disabled:opacity-50'

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(base, 'h-8 px-2.5', className)} {...props} />
))
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(base, 'min-h-20 resize-none px-2.5 py-2 leading-relaxed', className)} {...props} />
))
Textarea.displayName = 'Textarea'

/** Search input with a leading glass icon and an optional trailing shortcut / count. */
export function SearchField({ value, onChange, placeholder, trailing, className }: { value: string; onChange: (v: string) => void; placeholder?: string; trailing?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('group relative', className)}>
      <svg viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3 transition-colors group-focus-within:text-accent" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => e.key === 'Escape' && onChange('')}
        className={cn(base, 'h-8 pr-16 pl-8')}
      />
      {(value || trailing) && (
        <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
          {value ? (
            <button type="button" onClick={() => onChange('')} className="flex h-5 items-center rounded-[5px] px-1.5 text-[11px] text-fg-3 hover:bg-white/[0.06] hover:text-fg" aria-label="Effacer la recherche">
              Effacer
            </button>
          ) : (
            trailing
          )}
        </span>
      )}
    </div>
  )
}

export function Label({ children, hint, className }: { children: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-1.5 flex items-baseline justify-between gap-3', className)}>
      <span className="text-xs font-medium text-fg-2">{children}</span>
      {hint && <span className="text-2xs text-fg-3">{hint}</span>}
    </div>
  )
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-white/[0.06] px-1 font-sans text-[11px] font-medium text-fg-3 shadow-[inset_0_-1px_0_rgb(255_255_255/0.04)]', className)}>
      {children}
    </kbd>
  )
}

export function Badge({ children, tone = 'neutral', className }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; className?: string }) {
  const tones = {
    neutral: 'bg-white/[0.06] text-fg-2',
    accent: 'bg-accent/14 text-accent',
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/12 text-warning',
    danger: 'bg-danger/12 text-danger',
    info: 'bg-accent-2/14 text-accent-2',
  }
  return <span className={cn('inline-flex h-5 items-center gap-1 rounded-[6px] px-1.5 text-[11px] font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} />
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-white/[0.12]',
      )}
    >
      <span className={cn('absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow transition-transform duration-200 ease-[var(--ease-orbit)]', checked && 'translate-x-[12px]')} />
    </button>
  )
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; title?: string }[]; className?: string }) {
  return (
    <div role="radiogroup" className={cn('inline-flex h-8 items-center gap-px rounded-md bg-black/20 p-[3px] shadow-[inset_0_0_0_1px_var(--color-line),inset_0_1px_2px_rgb(0_0_0/0.25)]', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-xs font-medium text-fg-3 transition-[background,color,box-shadow] duration-150 [&_svg]:size-3.5',
            value === o.value ? 'bg-elevated text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_0_0_1px_rgb(255_255_255/0.05),0_1px_3px_rgb(0_0_0/0.4)]' : 'hover:bg-white/[0.03] hover:text-fg-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Underlined tabs for page-level sections, with optional counts. */
export function Tabs<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; count?: number | null; icon?: React.ReactNode }[]; className?: string }) {
  return (
    <div role="tablist" className={cn('flex items-center gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]', className)}>
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative -mb-px flex h-9 items-center gap-1.5 px-2.5 text-[13px] font-medium transition-colors [&_svg]:size-3.5',
              active ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            {o.icon && <span className={cn('transition-colors', active ? 'text-accent' : 'text-fg-4')}>{o.icon}</span>}
            {o.label}
            {o.count != null && o.count > 0 && (
              <span className={cn('rounded-[5px] px-1 text-[10.5px] leading-4 tabular', active ? 'bg-accent/15 text-accent' : 'bg-white/[0.05] text-fg-3')}>{o.count}</span>
            )}
            <span className={cn('absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent transition-[opacity,transform] duration-200 ease-[var(--ease-orbit)]', active ? 'scale-x-100 opacity-100' : 'scale-x-50 opacity-0')} />
          </button>
        )
      })}
    </div>
  )
}

/** Options most people never change, folded away so the form stays short. */
export function AdvancedSection({ children, label = 'Options avancées', defaultOpen = false, className }: { children: React.ReactNode; label?: string; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 rounded-[5px] text-[12.5px] font-medium text-fg-3 outline-none hover:text-fg-2 focus-visible:text-fg">
        <ChevronRight className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')} />
        {label}
      </button>
      {open && <div className="mt-4 space-y-6">{children}</div>}
    </div>
  )
}
