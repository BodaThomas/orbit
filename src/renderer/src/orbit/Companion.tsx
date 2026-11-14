import { useId } from 'react'
import { PALETTES } from '@shared/catalog'
import type { AgentStatus, Appearance, Expression, Species } from '@shared/types'
import { cn } from '@/lib/cn'

/**
 * Orbit companion creature. Pure SVG, 64×64 design grid, crisp from 20px to 400px.
 * Details (cheeks, mouth, highlights) are dropped progressively at small sizes.
 */

interface SpeciesGeometry {
  body: string
  /** extra parts drawn behind the body with the body gradient */
  back?: (g: string, inner: string) => React.ReactNode
  /** extra parts drawn in front */
  front?: (g: string, light: string) => React.ReactNode
  eyesY: number
  eyeGap: number
  mouthY: number
}

const GEOMETRY: Record<Species, SpeciesGeometry> = {
  round: {
    body: 'M32 14C45.3 14 54 23.2 54 36.2 54 48.6 44.6 56 32 56S10 48.6 10 36.2C10 23.2 18.7 14 32 14Z',
    eyesY: 35,
    eyeGap: 7.2,
    mouthY: 43.5,
  },
  oval: {
    body: 'M32 10.5C42.8 10.5 50.5 20.5 50.5 34.5 50.5 48.2 42.6 57 32 57S13.5 48.2 13.5 34.5C13.5 20.5 21.2 10.5 32 10.5Z',
    eyesY: 33,
    eyeGap: 6.6,
    mouthY: 41.5,
  },
  antenna: {
    body: 'M32 19.5C44.6 19.5 53 27.6 53 39 53 50.2 44.4 57 32 57S11 50.2 11 39C11 27.6 19.4 19.5 32 19.5Z',
    back: (g) => (
      <>
        <path d="M25.5 21.5C24.6 16.5 22.6 12.6 19.8 9.8" fill="none" stroke={g} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M38.5 21.5C39.4 16.5 41.4 12.6 44.2 9.8" fill="none" stroke={g} strokeWidth="2.4" strokeLinecap="round" />
      </>
    ),
    front: (g, light) => (
      <>
        <circle cx="19.3" cy="9.2" r="3.4" fill={g} />
        <circle cx="44.7" cy="9.2" r="3.4" fill={g} />
        <circle cx="18.4" cy="8.2" r="1.1" fill={light} opacity="0.7" />
        <circle cx="43.8" cy="8.2" r="1.1" fill={light} opacity="0.7" />
      </>
    ),
    eyesY: 38,
    eyeGap: 7.4,
    mouthY: 46,
  },
  eared: {
    body: 'M32 17C45 17 54 25.8 54 38 54 49.8 44.8 57 32 57S10 49.8 10 38C10 25.8 19 17 32 17Z',
    back: (g, inner) => (
      <>
        <circle cx="16.5" cy="19.5" r="7.6" fill={g} />
        <circle cx="47.5" cy="19.5" r="7.6" fill={g} />
        <circle cx="16.8" cy="19.8" r="4" fill={inner} opacity="0.55" />
        <circle cx="47.2" cy="19.8" r="4" fill={inner} opacity="0.55" />
      </>
    ),
    eyesY: 37,
    eyeGap: 7.4,
    mouthY: 45,
  },
  cloud: {
    body: 'M18.5 55C10.4 55 7 48.6 9.6 43.2 6.2 38.6 8.6 30.4 16.2 29.8 17.2 22.2 24.4 17.2 31.4 19 35.8 12.6 46.6 13.6 48.6 21.8 55.8 22.2 59.6 30 56.4 36 60.6 41.4 57.4 55 47 55Z',
    eyesY: 37.5,
    eyeGap: 7.4,
    mouthY: 45.5,
  },
  drop: {
    body: 'M32 7.5C36.4 15.6 52 27.4 52 41.2 52 51 43.4 57 32 57S12 51 12 41.2C12 27.4 27.6 15.6 32 7.5Z',
    eyesY: 39,
    eyeGap: 7,
    mouthY: 47,
  },
}

const INK = '#16142A'

function Eyes({ expression, cx, y, gap, detail, animated }: { expression: Expression; cx: number; y: number; gap: number; detail: boolean; animated: boolean }) {
  const l = cx - gap
  const r = cx + gap
  const stroke = { fill: 'none', stroke: INK, strokeWidth: 2.3, strokeLinecap: 'round' as const }
  switch (expression) {
    case 'calm':
      return (
        <g>
          <path d={`M${l - 3} ${y} Q${l} ${y + 3} ${l + 3} ${y}`} {...stroke} />
          <path d={`M${r - 3} ${y} Q${r} ${y + 3} ${r + 3} ${y}`} {...stroke} />
        </g>
      )
    case 'joyful':
      return (
        <g>
          <path d={`M${l - 3} ${y + 1.6} Q${l} ${y - 2.8} ${l + 3} ${y + 1.6}`} {...stroke} />
          <path d={`M${r - 3} ${y + 1.6} Q${r} ${y - 2.8} ${r + 3} ${y + 1.6}`} {...stroke} />
        </g>
      )
    case 'sleepy':
      return (
        <g fill={INK}>
          <path d={`M${l - 3.2} ${y - 0.4}h6.4a3.2 2.9 0 0 1-6.4 0Z`} />
          <path d={`M${r - 3.2} ${y - 0.4}h6.4a3.2 2.9 0 0 1-6.4 0Z`} />
        </g>
      )
    default: {
      const big = expression === 'curious'
      const focused = expression === 'focused'
      const ry = focused ? 3.3 : 4.3
      return (
        <g className={animated ? 'orbit-anim-blink' : undefined}>
          <ellipse cx={l} cy={y} rx="3.1" ry={ry} fill={INK} />
          <ellipse cx={r} cy={big ? y - 0.6 : y} rx={big ? 3.6 : 3.1} ry={big ? 4.9 : ry} fill={INK} />
          {focused && (
            <g fill="currentColor">
              <path d={`M${l - 3.6} ${y - 3.4}h7.2v1.9h-7.2Z`} />
              <path d={`M${r - 3.6} ${y - 3.4}h7.2v1.9h-7.2Z`} />
            </g>
          )}
          {detail && (
            <g fill="#fff">
              <circle cx={l + 1} cy={y - 1.5} r="1.15" />
              <circle cx={r + 1.1} cy={(big ? y - 0.6 : y) - 1.6} r={big ? 1.35 : 1.15} />
            </g>
          )}
        </g>
      )
    }
  }
}

function Mouth({ expression, cx, y }: { expression: Expression; cx: number; y: number }) {
  const s = { fill: 'none', stroke: INK, strokeWidth: 1.8, strokeLinecap: 'round' as const }
  switch (expression) {
    case 'welcoming':
    case 'calm':
      return <path d={`M${cx - 2.6} ${y} Q${cx} ${y + 2.4} ${cx + 2.6} ${y}`} {...s} />
    case 'joyful':
      return <path d={`M${cx - 3.4} ${y - 0.6} Q${cx} ${y + 5} ${cx + 3.4} ${y - 0.6} Z`} fill={INK} />
    case 'curious':
      return <ellipse cx={cx} cy={y + 0.6} rx="1.6" ry="1.9" fill={INK} />
    case 'focused':
      return <path d={`M${cx - 2} ${y + 0.6} H${cx + 2}`} {...s} />
    case 'sleepy':
      return <circle cx={cx} cy={y + 0.8} r="1.1" fill={INK} />
  }
}

export interface CompanionProps {
  appearance: Pick<Appearance, 'species' | 'palette' | 'expression'>
  size?: number
  status?: AgentStatus
  /** Idle animations (breathing, blinking). Off by default: lists stay calm. */
  animated?: boolean
  className?: string
  title?: string
}

export function Companion({ appearance, size = 32, status, animated = false, className, title }: CompanionProps) {
  const uid = useId().replace(/:/g, '')
  const palette = PALETTES[appearance.palette]
  const geo = GEOMETRY[appearance.species]
  const detail = size >= 28
  const rich = size >= 44
  const muted = status === 'offline' || status === 'disabled'
  const bodyFill = `url(#b${uid})`
  const anim =
    status === 'done' ? 'orbit-anim-cheer' : status === 'error' ? 'orbit-anim-shake' : animated ? 'orbit-anim-breathe' : undefined

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn('shrink-0 overflow-visible transition-[filter,opacity] duration-500', muted && 'opacity-55 grayscale-[0.75]', className)}
      style={{ color: palette.body[2] }}
    >
      <defs>
        <radialGradient id={`b${uid}`} cx="0.36" cy="0.26" r="0.82">
          <stop offset="0" stopColor={palette.body[0]} />
          <stop offset="0.52" stopColor={palette.body[1]} />
          <stop offset="1" stopColor={palette.body[2]} />
        </radialGradient>
        <radialGradient id={`h${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`s${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <g className={anim} key={status}>
        {geo.back?.(bodyFill, palette.body[0])}
        <path d={geo.body} fill={bodyFill} />
        <path d={geo.body} fill={`url(#s${uid})`} />
        {rich && <path d={geo.body} fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="0.8" />}
        {detail && <ellipse cx="23.5" cy={geo.eyesY - 12} rx="7.5" ry="4.6" transform={`rotate(-24 23.5 ${geo.eyesY - 12})`} fill={`url(#h${uid})`} />}
        {geo.front?.(bodyFill, palette.body[0])}
        {detail && (
          <g fill="#FF8FB1" opacity="0.32">
            <ellipse cx={32 - geo.eyeGap - 5.2} cy={geo.eyesY + 6} rx="3.3" ry="2.1" />
            <ellipse cx={32 + geo.eyeGap + 5.2} cy={geo.eyesY + 6} rx="3.3" ry="2.1" />
          </g>
        )}
        <Eyes expression={appearance.expression} cx={32} y={geo.eyesY} gap={geo.eyeGap} detail={detail} animated={animated && rich} />
        {detail && <Mouth expression={appearance.expression} cx={32} y={geo.mouthY} />}
      </g>
    </svg>
  )
}
