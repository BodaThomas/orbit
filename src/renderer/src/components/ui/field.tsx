import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

const base =
  'w-full rounded-md bg-white/[0.035] text-[13px] text-fg placeholder:text-fg-3 shadow-[inset_0_0_0_1px_var(--color-line)] transition-shadow outline-none focus:shadow-[inset_0_0_0_1px_rgb(165_155_250/0.55),0_0_0_3px_rgb(165_155_250/0.12)] disabled:opacity-50'

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(base, 'h-8 px-2.5', className)} {...props} />
))
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(base, 'min-h-20 resize-none px-2.5 py-2 leading-relaxed', className)} {...props} />
))
Textarea.displayName = 'Textarea'

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
    <div role="radiogroup" className={cn('inline-flex h-7 items-center rounded-sm bg-white/[0.04] p-0.5 shadow-[inset_0_0_0_1px_var(--color-line)]', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-6 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium text-fg-3 transition-colors [&_svg]:size-3.5',
            value === o.value ? 'bg-elevated text-fg shadow-[0_1px_2px_rgb(0_0_0/0.3)]' : 'hover:text-fg-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
