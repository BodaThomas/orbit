import { PALETTES, STATUS_LABELS } from '@shared/catalog'
import type { AgentStatus, Appearance } from '@shared/types'
import { cn } from '@/lib/cn'
import { Companion } from './Companion'
import { Planet } from './Planet'

export type AvatarVariant = 'compact' | 'standard' | 'detailed' | 'profile'

const STATUS_COLOR: Record<AgentStatus, string> = {
  available: 'bg-success',
  working: 'bg-accent',
  awaiting_approval: 'bg-warning',
  done: 'bg-success',
  error: 'bg-danger',
  offline: 'bg-fg-4',
  disabled: 'bg-fg-4',
}

export function statusColorClass(status: AgentStatus): string {
  return STATUS_COLOR[status]
}

/** Availability dot, cut out of its background like macOS presence badges. */
export function CompanionStatusIndicator({
  status,
  size = 10,
  ring = 'var(--color-sidebar)',
  className,
}: {
  status: AgentStatus
  size?: number
  ring?: string
  className?: string
}) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABELS[status]}
      title={STATUS_LABELS[status]}
      className={cn('block rounded-full', STATUS_COLOR[status], status === 'awaiting_approval' && 'orbit-blip', className)}
      style={{ width: size, height: size, boxShadow: `0 0 0 ${Math.max(2, size * 0.22)}px ${ring}` }}
    />
  )
}

interface AvatarProps {
  appearance: Appearance
  status?: AgentStatus
  variant?: AvatarVariant
  size?: number
  seed?: string
  showStatus?: boolean
  statusRing?: string
  animated?: boolean
  className?: string
  name?: string
}

/**
 * One companion, four presentations - silhouette and colour stay identical:
 *  compact  · creature only (lists, sidebar)
 *  standard · creature in a soft atmosphere disc with a planet horizon
 *  detailed · creature floating above its planet (cards, universe)
 *  profile  · full composition for the profile header
 */
export function CompanionAvatar({
  appearance,
  status,
  variant = 'compact',
  size = 32,
  seed,
  showStatus = false,
  statusRing,
  animated,
  className,
  name,
}: AvatarProps) {
  const palette = PALETTES[appearance.palette]
  const dotSize = Math.max(8, Math.round(size * 0.24))

  if (variant === 'compact' || variant === 'standard') {
    return (
      <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
        {variant === 'standard' && (
          <span
            aria-hidden
            className="absolute inset-0 overflow-hidden rounded-full"
            style={{
              background: `radial-gradient(circle at 50% 38%, ${palette.glow}26, transparent 70%), linear-gradient(180deg, #ffffff08, #ffffff02)`,
              boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.06)',
            }}
          >
            <span
              className="absolute left-1/2 -translate-x-1/2 rounded-full"
              style={{
                width: size * 1.5,
                height: size * 1.5,
                top: size * 0.8,
                background: `radial-gradient(circle at 40% 20%, ${palette.planet[1]}, ${palette.planet[2]} 70%)`,
                opacity: 0.85,
              }}
            />
          </span>
        )}
        <Companion
          appearance={appearance}
          size={variant === 'standard' ? size * 0.82 : size}
          status={status}
          animated={animated}
          title={name}
          className={variant === 'standard' ? 'absolute left-[9%] top-[4%]' : undefined}
        />
        {showStatus && status && (
          <CompanionStatusIndicator status={status} size={dotSize} ring={statusRing} className="absolute -right-px -bottom-px" />
        )}
      </span>
    )
  }

  // detailed / profile: creature above its planet, fully contained in the square.
  const floating = variant === 'profile'
  const scale = appearance.planet.scale
  const planetSize = floating ? size * 0.86 : size
  const planetTop = floating ? size - planetSize * 0.92 : size * 0.12
  const creature = size * (floating ? 0.36 : 0.4)
  const sphereTop = planetTop + planetSize * (0.5 - 0.29 * scale)
  const creatureTop = sphereTop - creature * (floating ? 1.02 : 0.82)
  return (
    <span className={cn('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      <span className="absolute left-1/2 -translate-x-1/2" style={{ top: planetTop, width: planetSize, height: planetSize }}>
        <Planet spec={appearance.planet} size={planetSize} status={status} seed={seed} animated={animated} />
      </span>
      {floating && (
        <span
          aria-hidden
          className="absolute left-1/2 -translate-x-1/2 rounded-[50%] bg-black/30 blur-[3px]"
          style={{ width: creature * 0.55, height: creature * 0.12, top: sphereTop + size * 0.03 }}
        />
      )}
      <span
        className={cn('absolute left-1/2 -translate-x-1/2', animated && floating && 'orbit-anim-float')}
        style={{ top: creatureTop, width: creature, height: creature }}
      >
        <Companion appearance={appearance} size={creature} status={status} animated={animated} title={name} />
      </span>
      {showStatus && status && (
        <CompanionStatusIndicator status={status} size={Math.max(10, size * 0.09)} ring={statusRing} className="absolute right-[18%] bottom-[10%]" />
      )}
    </span>
  )
}
