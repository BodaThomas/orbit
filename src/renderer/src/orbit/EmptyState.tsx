import type { Appearance } from '@shared/types'
import { PALETTES } from '@shared/catalog'
import { cn } from '@/lib/cn'
import { Companion } from './Companion'

const SLEEPY: Appearance = { species: 'cloud', palette: 'slate', expression: 'sleepy', planet: { palette: 'slate', texture: 'smooth', atmosphere: 0, ring: false, satellite: false, scale: 1 } }

function moonPath(stage: number) {
  const k = stage / 120
  const [cx, cy, rx, ry] = [60 * k, 44 * k, 56 * k, 20 * k]
  return `M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${rx * 2} 0 a${rx} ${ry} 0 1 0 ${-rx * 2} 0`
}

/**
 * Empty states feature a little companion resting in its own orbit - never a
 * generic icon. Pass `appearance` to show the companion the page is about.
 */
export function OrbitEmptyState({
  title,
  body,
  action,
  secondary,
  hints,
  compact,
  appearance,
  className,
}: {
  title: string
  body?: React.ReactNode
  action?: React.ReactNode
  secondary?: React.ReactNode
  hints?: { icon?: React.ReactNode; label: React.ReactNode }[]
  compact?: boolean
  appearance?: Appearance
  className?: string
}) {
  const a = appearance ?? SLEEPY
  const glow = PALETTES[a.palette].glow
  const size = compact ? 34 : 50
  const stage = compact ? 92 : 132
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-6' : 'px-6 py-12', className)}>
      <div className="relative mb-3" style={{ width: stage, height: stage * 0.62 }} aria-hidden>
        <div className="absolute inset-0 rounded-[50%] opacity-60 blur-2xl" style={{ background: `radial-gradient(ellipse at 50% 60%, ${glow}33, transparent 70%)` }} />
        <svg viewBox="0 0 120 74" className="absolute inset-0 h-full w-full overflow-visible">
          <ellipse cx="60" cy="44" rx="56" ry="20" fill="none" stroke="#fff" strokeOpacity="0.09" strokeDasharray="1.5 4" />
          <ellipse cx="60" cy="44" rx="38" ry="13" fill="none" stroke="#fff" strokeOpacity="0.05" />
          <circle cx="12" cy="26" r="0.9" fill="#fff" opacity="0.5" />
          <circle cx="104" cy="14" r="0.7" fill="#fff" opacity="0.4" />
          <circle cx="92" cy="66" r="0.6" fill="#fff" opacity="0.35" />
        </svg>
        {/* A tiny moon riding the outer ellipse (CSS motion path, stilled for reduced motion). */}
        <span
          className="orbit-anim-path absolute top-0 left-0 size-[5px] rounded-full"
          style={{ background: glow, boxShadow: `0 0 6px ${glow}`, offsetPath: `path('${moonPath(stage)}')`, offsetRotate: '0deg' }}
        />
        <div className="absolute left-1/2 -translate-x-1/2" style={{ top: stage * 0.62 * 0.62 - size * 0.86 }}>
          <div className="orbit-anim-float">
            <Companion appearance={{ ...a, expression: appearance ? a.expression : 'sleepy' }} size={size} animated />
          </div>
          <div className="mx-auto -mt-0.5 h-1.5 w-2/3 rounded-[50%] bg-black/45 blur-[3px]" />
        </div>
      </div>
      <div className={cn('font-medium text-fg', compact ? 'text-[13.5px]' : 'text-[15px]')}>{title}</div>
      {body && <div className={cn('mt-1 max-w-sm leading-relaxed text-fg-3', compact ? 'text-[12.5px]' : 'text-[13px]')}>{body}</div>}
      {hints && hints.length > 0 && (
        <ul className="mt-4 flex flex-wrap justify-center gap-1.5">
          {hints.map((h, i) => (
            <li key={i} className="flex h-6 items-center gap-1.5 rounded-full bg-white/[0.035] px-2.5 text-[11.5px] text-fg-2 ring-1 ring-line [&_svg]:size-3 [&_svg]:text-fg-3">
              {h.icon}
              {h.label}
            </li>
          ))}
        </ul>
      )}
      {(action || secondary) && (
        <div className={cn('flex items-center gap-2', hints?.length ? 'mt-5' : 'mt-4')}>
          {action}
          {secondary}
        </div>
      )}
    </div>
  )
}

/** Loading skeleton or retryable error for a list query; renders nothing once data is there. */
export function QueryFallback({ query, what }: { query: { isLoading: boolean; isError: boolean; data?: unknown; error: unknown; refetch: () => unknown }; what: string }) {
  if (query.isLoading) return <div className="skeleton h-48 rounded-xl" aria-busy="true" aria-label="Chargement" />
  if (query.isError && !query.data) {
    return (
      <div className="card">
        <OrbitEmptyState
          title={`Impossible de charger ${what}`}
          body={query.error instanceof Error ? query.error.message : 'Une erreur est survenue.'}
          action={<button className="text-[13px] text-accent hover:underline" onClick={() => void query.refetch()}>Réessayer</button>}
        />
      </div>
    )
  }
  return null
}
