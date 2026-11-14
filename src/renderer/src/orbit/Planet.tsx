import { useId } from 'react'
import { PALETTES } from '@shared/catalog'
import type { AgentStatus, PlanetSpec } from '@shared/types'
import { cn } from '@/lib/cn'

/** Deterministic pseudo-random from a string, for stable texture placement. */
function seeded(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

function Texture({ spec, r, light, deep, seed }: { spec: PlanetSpec; r: number; light: string; deep: string; seed: string }) {
  const rnd = seeded(seed + spec.texture)
  const c = 50
  switch (spec.texture) {
    case 'bands':
      return (
        <g transform={`rotate(-10 ${c} ${c})`}>
          <ellipse cx={c} cy={c - r * 0.48} rx={r * 1.3} ry={r * 0.075} fill={light} opacity="0.22" />
          <ellipse cx={c} cy={c - r * 0.16} rx={r * 1.3} ry={r * 0.14} fill={deep} opacity="0.22" />
          <ellipse cx={c} cy={c + r * 0.16} rx={r * 1.3} ry={r * 0.06} fill={light} opacity="0.16" />
          <ellipse cx={c} cy={c + r * 0.42} rx={r * 1.3} ry={r * 0.12} fill={deep} opacity="0.2" />
          <ellipse cx={c + r * 0.3} cy={c + r * 0.06} rx={r * 0.17} ry={r * 0.09} fill={deep} opacity="0.32" />
        </g>
      )
    case 'craters': {
      const craters = [
        [-0.38, -0.22, 0.2],
        [0.28, 0.14, 0.15],
        [-0.08, 0.46, 0.11],
        [0.42, -0.4, 0.09],
        [-0.5, 0.28, 0.07],
      ] as const
      return (
        <g>
          {craters.map(([x, y, s], i) => (
            <g key={i}>
              <circle cx={c + x * r} cy={c + y * r} r={s * r} fill={deep} opacity="0.3" />
              <path
                d={`M${c + x * r - s * r * 0.8} ${c + y * r + s * r * 0.35} A${s * r} ${s * r} 0 0 0 ${c + x * r + s * r * 0.8} ${c + y * r + s * r * 0.35}`}
                fill="none"
                stroke={light}
                strokeOpacity="0.32"
                strokeWidth={Math.max(0.6, s * r * 0.22)}
              />
            </g>
          ))}
        </g>
      )
    }
    case 'facets': {
      const pts = Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2 + rnd() * 0.5
        const d = r * (0.45 + rnd() * 0.25)
        return [c + Math.cos(a) * d, c + Math.sin(a) * d] as const
      })
      return (
        <g strokeLinejoin="round">
          {pts.map(([x, y], i) => {
            const [x2, y2] = pts[(i + 1) % pts.length]!
            return (
              <path
                key={i}
                d={`M${c} ${c}L${x} ${y}L${x2} ${y2}Z`}
                fill={i % 2 ? '#fff' : '#000'}
                fillOpacity={i % 2 ? 0.05 + rnd() * 0.05 : 0.08 + rnd() * 0.08}
                stroke="#fff"
                strokeOpacity="0.07"
                strokeWidth="0.5"
              />
            )
          })}
          {pts.map(([x, y], i) => (
            <path key={`o${i}`} d={`M${x} ${y}L${x + (x - c) * 0.9} ${y + (y - c) * 0.9}`} stroke="#fff" strokeOpacity="0.06" strokeWidth="0.5" />
          ))}
        </g>
      )
    }
    case 'organic':
      return (
        <g>
          <path
            d={`M${c - r * 0.7} ${c - r * 0.1}c${r * 0.1} -${r * 0.4} ${r * 0.5} -${r * 0.55} ${r * 0.7} -${r * 0.3}s${r * 0.15} ${r * 0.35} -${r * 0.15} ${r * 0.5} -${r * 0.45} ${r * 0.05} -${r * 0.55} -${r * 0.2}z`}
            fill={deep}
            opacity="0.32"
          />
          <path
            d={`M${c + r * 0.05} ${c + r * 0.3}c${r * 0.2} -${r * 0.25} ${r * 0.6} -${r * 0.2} ${r * 0.65} ${r * 0.05}s-${r * 0.2} ${r * 0.4} -${r * 0.45} ${r * 0.32} -${r * 0.35} -${r * 0.15} -${r * 0.2} -${r * 0.37}z`}
            fill={deep}
            opacity="0.28"
          />
          <ellipse cx={c + r * 0.38} cy={c - r * 0.42} rx={r * 0.16} ry={r * 0.09} fill={light} opacity="0.3" />
          <ellipse cx={c - r * 0.3} cy={c + r * 0.55} rx={r * 0.12} ry={r * 0.06} fill={light} opacity="0.22" />
        </g>
      )
    default:
      return <ellipse cx={c} cy={c + r * 0.15} rx={r * 1.2} ry={r * 0.22} fill={light} opacity="0.08" transform={`rotate(-12 ${c} ${c})`} />
  }
}

export interface PlanetProps {
  spec: PlanetSpec
  size?: number
  status?: AgentStatus
  /** Stable seed for textures (agent id). */
  seed?: string
  animated?: boolean
  className?: string
}

/** A small world for a companion. 100×100 design grid. */
export function Planet({ spec, size = 96, status, seed = 'orbit', animated = false, className }: PlanetProps) {
  const uid = useId().replace(/:/g, '')
  const p = PALETTES[spec.palette]
  const r = 29 * Math.min(1.2, Math.max(0.8, spec.scale))
  const c = 50
  const atmo = Math.max(0, Math.min(1, spec.atmosphere))
  const R = r + 5 + atmo * 9
  const working = status === 'working'
  const muted = status === 'offline' || status === 'disabled'
  const ringTilt = -16

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden
      className={cn('shrink-0 overflow-visible transition-[filter,opacity] duration-500', muted && 'opacity-50 grayscale-[0.8]', className)}
    >
      <defs>
        <radialGradient id={`atm${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset={r / R} stopColor={p.glow} stopOpacity={0.12 + 0.38 * atmo} />
          <stop offset={(r / R + 1) / 2} stopColor={p.glow} stopOpacity={0.05 + 0.1 * atmo} />
          <stop offset="1" stopColor={p.glow} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`sph${uid}`} cx="0.34" cy="0.3" r="0.85">
          <stop offset="0" stopColor={p.planet[0]} />
          <stop offset="0.5" stopColor={p.planet[1]} />
          <stop offset="1" stopColor={p.planet[2]} />
        </radialGradient>
        <linearGradient id={`night${uid}`} x1="0.2" y1="0.15" x2="0.85" y2="0.95">
          <stop offset="0.45" stopColor="#05060c" stopOpacity="0" />
          <stop offset="1" stopColor="#05060c" stopOpacity="0.62" />
        </linearGradient>
        <linearGradient id={`rim${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`ring${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={p.glow} stopOpacity="0.15" />
          <stop offset="0.5" stopColor={p.planet[0]} stopOpacity="0.85" />
          <stop offset="1" stopColor={p.glow} stopOpacity="0.2" />
        </linearGradient>
        <clipPath id={`clip${uid}`}>
          <circle cx={c} cy={c} r={r} />
        </clipPath>
        <clipPath id={`back${uid}`}>
          <rect x="-50" y="-50" width="200" height={100} />
        </clipPath>
        <clipPath id={`front${uid}`}>
          <rect x="-50" y="50" width="200" height="100" />
        </clipPath>
      </defs>

      {atmo > 0 && <circle cx={c} cy={c} r={R} fill={`url(#atm${uid})`} />}

      {working && (
        <circle cx={c} cy={c} r={r + 4} fill="none" stroke={p.glow} strokeWidth="1.2" className="orbit-anim-halo" opacity="0.6" />
      )}

      {spec.ring && (
        <g transform={`rotate(${ringTilt} ${c} ${c})`} clipPath={`url(#back${uid})`}>
          <ellipse cx={c} cy={c} rx={r * 1.62} ry={r * 0.36} fill="none" stroke={`url(#ring${uid})`} strokeWidth="2.6" opacity="0.55" />
          <ellipse cx={c} cy={c} rx={r * 1.4} ry={r * 0.29} fill="none" stroke={p.glow} strokeWidth="0.7" opacity="0.35" />
        </g>
      )}

      <circle cx={c} cy={c} r={r} fill={`url(#sph${uid})`} />
      <g clipPath={`url(#clip${uid})`}>
        <Texture spec={spec} r={r} light={p.planet[0]} deep={p.planet[2]} seed={seed} />
        <circle cx={c} cy={c} r={r} fill={`url(#night${uid})`} />
      </g>
      <circle cx={c} cy={c} r={r - 0.4} fill="none" stroke={`url(#rim${uid})`} strokeWidth="0.8" />

      {spec.ring && (
        <g transform={`rotate(${ringTilt} ${c} ${c})`} clipPath={`url(#front${uid})`}>
          <ellipse cx={c} cy={c} rx={r * 1.62} ry={r * 0.36} fill="none" stroke={`url(#ring${uid})`} strokeWidth="2.6" opacity="0.9" />
          <ellipse cx={c} cy={c} rx={r * 1.4} ry={r * 0.29} fill="none" stroke={p.glow} strokeWidth="0.7" opacity="0.5" />
        </g>
      )}

      {spec.satellite && (
        <g className={animated ? 'orbit-anim-orbit' : undefined} style={animated ? { animationDuration: '26s' } : undefined}>
          <ellipse cx={c} cy={c} rx={r * 1.42} ry={r * 1.42} fill="none" stroke="#fff" strokeOpacity="0.05" strokeWidth="0.5" />
          <circle cx={c + r * 1.0} cy={c - r * 1.0} r="3.4" fill={PALETTES.slate.planet[1]} />
          <circle cx={c + r * 1.0 - 1} cy={c - r * 1.0 - 1} r="1.4" fill="#fff" opacity="0.35" />
        </g>
      )}

      {working && (
        <g className="orbit-anim-orbit" style={{ animationDuration: '5s' }}>
          {[0, 1, 2].map((i) => {
            const a = (i / 3) * Math.PI * 2
            return <circle key={i} cx={c + Math.cos(a) * (r + 9)} cy={c + Math.sin(a) * (r + 9)} r={1.6 - i * 0.35} fill={p.glow} opacity={0.9 - i * 0.2} />
          })}
        </g>
      )}
    </svg>
  )
}
