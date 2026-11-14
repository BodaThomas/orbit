import { useEffect, useMemo, useRef, useState } from 'react'
import { LocateFixed, Minus, Plus, Waypoints } from 'lucide-react'
import { STATUS_LABELS } from '@shared/catalog'
import type { Agent, Workflow } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { useAgents, useWorkflows } from '@/lib/queries'
import { CompanionAvatar, statusColorClass } from '@/orbit/CompanionAvatar'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { navigate } from '@/stores/router'

/**
 * Deterministic, aesthetic layout: companions sit on gently tilted elliptical
 * orbits around the user's « centre ». Not a physical simulation.
 */
function layout(agents: Agent[], w: number, h: number) {
  const cx = w / 2
  const cy = h / 2 + 10
  const n = agents.length
  const rings = n <= 4 ? 1 : n <= 10 ? 2 : 3
  const perRing = Math.ceil(n / rings)
  return agents.map((a, i) => {
    const ring = Math.floor(i / perRing)
    const k = i % perRing
    const count = Math.min(perRing, n - ring * perRing)
    const base = Math.min(w * 0.36, 440)
    const rx = rings === 1 ? base : base * (0.55 + ring * (0.45 / (rings - 1)))
    const ry = Math.min(rx * 0.44, h * 0.3)
    const angle = (k / count) * Math.PI * 2 + (ring * Math.PI) / count - Math.PI / 2 + 0.35
    return { agent: a, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, ring, rx, ry, depth: Math.sin(angle) }
  })
}

// Fixed, sparse star field: decorative, static, never animated.
const STARS = Array.from({ length: 70 }, (_, i) => {
  const r = Math.sin(i * 12.9898) * 43758.5453
  const r2 = Math.sin(i * 78.233) * 12345.678
  return { x: r - Math.floor(r), y: r2 - Math.floor(r2), s: (i % 7 === 0 ? 1.4 : 0.8) as number, o: 0.15 + ((i * 37) % 10) / 40 }
})

export function UniversePage() {
  const agents = useAgents()
  const workflows = useWorkflows()
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1000, h: 700 })
  const [zoom, setZoom] = useState(1)
  const [focus, setFocus] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [showLinks, setShowLinks] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const list = useMemo(() => agents.data ?? [], [agents.data])
  const placed = useMemo(() => layout(list, size.w, size.h), [list, size])
  const byId = new Map(placed.map((p) => [p.agent.id, p]))
  const planetSize = Math.max(120, Math.min(200, size.w / (list.length > 6 ? 8 : 6.2)))

  const links = (workflows.data ?? []).flatMap((wf: Workflow) =>
    wf.memberAgentIds.filter((m) => m !== wf.coordinatorAgentId).map((m) => ({ wf, from: byId.get(wf.coordinatorAgentId), to: byId.get(m) })),
  ).filter((l) => l.from && l.to)

  const onKey = (e: React.KeyboardEvent) => {
    if (!placed.length) return
    const idx = placed.findIndex((p) => p.agent.id === focus)
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      setFocus(placed[(idx + 1) % placed.length]!.agent.id)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      setFocus(placed[(idx - 1 + placed.length) % placed.length]!.agent.id)
    } else if (e.key === 'Enter' && focus) navigate(`/companions/${focus}`)
    else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(1.6, z + 0.1))
    else if (e.key === '-') setZoom((z) => Math.max(0.6, z - 0.1))
    else if (e.key === '0') setZoom(1)
  }

  useEffect(() => {
    if (focus) document.getElementById(`planet-${focus}`)?.focus()
  }, [focus])

  return (
    <div className="relative h-full overflow-hidden bg-[radial-gradient(ellipse_at_50%_55%,#151826_0%,#0d0f16_45%,#0b0c10_80%)]">
      <div className="drag absolute inset-x-0 top-0 z-10 h-[52px]" />
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {STARS.map((s, i) => (
          <span key={i} className="absolute rounded-full bg-white" style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: s.s, height: s.s, opacity: s.o }} />
        ))}
      </div>

      <header className="absolute top-[30px] left-8 z-20">
        <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-fg">Mon univers</h1>
        <p className="mt-1 text-[13.5px] text-fg-2">
          {list.length ? `${list.length} compagnon${list.length > 1 ? 's' : ''} · ${list.filter((a) => a.status === 'working').length} en mission` : 'Aucun compagnon'}
        </p>
      </header>

      <div className="no-drag absolute top-[34px] right-6 z-20 flex items-center gap-1 rounded-md bg-surface/80 p-1 ring-1 ring-line backdrop-blur">
        <Tooltip content="Constellations">
          <Button size="icon" variant={showLinks ? 'secondary' : 'ghost'} aria-pressed={showLinks} onClick={() => setShowLinks((v) => !v)} aria-label="Afficher les constellations">
            <Waypoints />
          </Button>
        </Tooltip>
        <div className="mx-0.5 h-4 w-px bg-line" />
        <Button size="icon" variant="ghost" onClick={() => setZoom((z) => Math.max(0.6, z - 0.1))} aria-label="Dézoomer">
          <Minus />
        </Button>
        <span className="w-10 text-center text-xs text-fg-3 tabular">{Math.round(zoom * 100)} %</span>
        <Button size="icon" variant="ghost" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))} aria-label="Zoomer">
          <Plus />
        </Button>
        <Tooltip content="Recentrer">
          <Button size="icon" variant="ghost" onClick={() => { setZoom(1); setFocus(null) }} aria-label="Recentrer">
            <LocateFixed />
          </Button>
        </Tooltip>
      </div>

      {agents.data && list.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <OrbitEmptyState title="Un univers encore vide" body="Chaque compagnon que vous créez apparaîtra ici sur sa planète." action={<Button variant="primary" onClick={() => navigate('/companions/new')}>Créer un compagnon</Button>} />
        </div>
      ) : (
        <div
          ref={ref}
          role="listbox"
          aria-label="Compagnons de votre univers. Flèches pour naviguer, Entrée pour ouvrir."
          tabIndex={-1}
          onKeyDown={onKey}
          className="absolute inset-0 transition-transform duration-500 ease-[var(--ease-orbit)]"
          style={{ transform: `scale(${zoom})` }}
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <defs>
              <radialGradient id="core" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stopColor="#A59BFA" stopOpacity="0.32" />
                <stop offset="0.4" stopColor="#7E9CE8" stopOpacity="0.08" />
                <stop offset="1" stopColor="#7E9CE8" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="link" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#A59BFA" stopOpacity="0.15" />
                <stop offset="0.5" stopColor="#C9C2FF" stopOpacity="0.75" />
                <stop offset="1" stopColor="#A59BFA" stopOpacity="0.15" />
              </linearGradient>
            </defs>
            {[...new Set(placed.map((p) => `${p.rx}:${p.ry}`))].map((k) => {
              const [rx, ry] = k.split(':').map(Number)
              return <ellipse key={k} cx={size.w / 2} cy={size.h / 2 + 10} rx={rx} ry={ry} fill="none" stroke="#fff" strokeOpacity="0.055" strokeDasharray="2 6" />
            })}
            <circle cx={size.w / 2} cy={size.h / 2 + 10} r="90" fill="url(#core)" />
            <circle cx={size.w / 2} cy={size.h / 2 + 10} r="3" fill="#E4DEFF" opacity="0.8" />
            {showLinks &&
              links.map(({ wf, from, to }) => {
                const hot = hover === from!.agent.id || hover === to!.agent.id
                const mx = (from!.x + to!.x) / 2
                const my = (from!.y + to!.y) / 2 - 40
                return (
                  <path
                    key={`${wf.id}-${to!.agent.id}`}
                    d={`M${from!.x} ${from!.y} Q${mx} ${my} ${to!.x} ${to!.y}`}
                    fill="none"
                    stroke="url(#link)"
                    strokeWidth={hot ? 1.6 : 1}
                    strokeDasharray="1 5"
                    strokeLinecap="round"
                    opacity={hot ? 1 : 0.7}
                  />
                )
              })}
          </svg>
          <div className="pointer-events-none absolute text-center text-2xs tracking-[0.12em] text-fg-3 uppercase" style={{ left: size.w / 2 - 60, top: size.h / 2 + 30, width: 120 }}>
            Vous
          </div>

          {placed
            .slice()
            .sort((a, b) => a.depth - b.depth)
            .map(({ agent, x, y, depth }) => {
              const s = planetSize * (0.88 + (depth + 1) * 0.08)
              const active = hover === agent.id || focus === agent.id
              return (
                <div
                  key={agent.id}
                  className="absolute"
                  style={{ left: x - s / 2, top: y - s / 2 - s * 0.1, width: s, zIndex: Math.round((depth + 2) * 10) }}
                >
                  <button
                    id={`planet-${agent.id}`}
                    role="option"
                    aria-selected={focus === agent.id}
                    aria-label={`${agent.name}, ${agent.role}, ${STATUS_LABELS[agent.status]}`}
                    onMouseEnter={() => setHover(agent.id)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setFocus(agent.id)}
                    onClick={() => navigate(`/companions/${agent.id}`)}
                    className="group relative block w-full rounded-full outline-none"
                  >
                    <span
                      aria-hidden
                      className={cn('absolute inset-[14%] rounded-full transition-opacity duration-300', active ? 'opacity-100' : 'opacity-0')}
                      style={{ boxShadow: '0 0 0 1.5px rgb(165 155 250 / 0.55), 0 0 40px 6px rgb(165 155 250 / 0.18)' }}
                    />
                    <span className={cn('block transition-transform duration-300 ease-[var(--ease-orbit)]', active && 'scale-[1.06]')}>
                      <CompanionAvatar appearance={agent.appearance} status={agent.status} variant="detailed" size={s} seed={agent.id} animated />
                    </span>
                  </button>
                  <div className="pointer-events-none -mt-[10%] text-center">
                    <div className="flex items-center justify-center gap-1.5 text-[13.5px] font-medium text-fg">
                      <span className={cn('size-[6px] rounded-full', statusColorClass(agent.status), agent.status === 'awaiting_approval' && 'orbit-blip')} />
                      {agent.name}
                    </div>
                    <div className={cn('mx-auto max-w-[180px] truncate text-xs transition-opacity duration-200', active ? 'text-fg-2 opacity-100' : 'text-fg-3 opacity-80')}>
                      {active ? agent.role || STATUS_LABELS[agent.status] : (agent.statusText ?? STATUS_LABELS[agent.status])}
                    </div>
                  </div>
                </div>
              )
            })}
        </div>
      )}
      <div className="absolute bottom-5 left-8 z-20 text-2xs text-fg-3">
        ← → pour parcourir · Entrée pour ouvrir · +/− pour zoomer
        {links.length > 0 && showLinks && ' · Les lignes relient les compagnons d’une même constellation'}
      </div>
    </div>
  )
}
