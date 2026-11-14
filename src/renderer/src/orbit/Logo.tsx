import { useId } from 'react'

/** Orbit mark: a lavender world crossed by an azure orbit, with a tiny moon. */
export function OrbitLogo({ size = 22, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-label="Orbit" role="img">
      <defs>
        <radialGradient id={`lg${id}`} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#E4DEFF" />
          <stop offset="0.55" stopColor="#A59BFA" />
          <stop offset="1" stopColor="#5D4FB8" />
        </radialGradient>
        <linearGradient id={`lr${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7E9CE8" stopOpacity="0.2" />
          <stop offset="0.55" stopColor="#C9D6FF" />
          <stop offset="1" stopColor="#7E9CE8" stopOpacity="0.5" />
        </linearGradient>
        <clipPath id={`lb${id}`}><rect x="-8" y="-8" width="48" height="24" /></clipPath>
        <clipPath id={`lf${id}`}><rect x="-8" y="16" width="48" height="24" /></clipPath>
      </defs>
      <g transform="rotate(-24 16 16)" clipPath={`url(#lb${id})`}>
        <ellipse cx="16" cy="16" rx="14.2" ry="5.2" fill="none" stroke={`url(#lr${id})`} strokeWidth="1.6" />
      </g>
      <circle cx="16" cy="16" r="8.6" fill={`url(#lg${id})`} />
      <g transform="rotate(-24 16 16)" clipPath={`url(#lf${id})`}>
        <ellipse cx="16" cy="16" rx="14.2" ry="5.2" fill="none" stroke={`url(#lr${id})`} strokeWidth="1.6" />
      </g>
      <circle cx="27.2" cy="9.4" r="1.9" fill="#F3F3F7" />
    </svg>
  )
}
