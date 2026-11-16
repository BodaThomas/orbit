import { ACTIVE_RUN_STATUSES } from '@shared/constellation-states'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LocateFixed, Minus, Plus, Rocket, Server, Waypoints } from 'lucide-react'
import { ACTIVE_MISSION_STATUSES } from '@shared/mission-states'
import { PALETTES, STATUS_LABELS } from '@shared/catalog'
import type { Agent, AgentStatus } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/field'
import { Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { duration, relative } from '@/lib/format'
import { useAgents, useAutomations, useConstellationRuns, useConstellations, useMissions, useRemoteMachines } from '@/lib/queries'
import { CompanionAvatar, statusColorClass } from '@/orbit/CompanionAvatar'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { HomeViewSwitch } from '@/orbit/HomeViewSwitch'
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

// Fixed, sparse star fields on two depths. A handful twinkle, gently.
const starField = (count: number, salt: number) =>
  Array.from({ length: count }, (_, i) => {
    const r = Math.sin((i + salt) * 12.9898) * 43758.5453
    const r2 = Math.sin((i + salt) * 78.233) * 12345.678
    return { x: r - Math.floor(r), y: r2 - Math.floor(r2), s: i % 9 === 0 ? 1.6 : i % 3 === 0 ? 1.1 : 0.8, o: 0.12 + ((i * 37) % 10) / 36, twinkle: i % 6 === 0, delay: (i * 0.73) % 4.5 }
  })
const FAR = starField(70, 0)
const NEAR = starField(26, 500)

const LEGEND: { status: AgentStatus[]; label: string }[] = [
  { status: ['working'], label: 'En mission' },
  { status: ['awaiting_approval'], label: 'Attend votre accord' },
  { status: ['available', 'done'], label: 'Disponible' },
  { status: ['error'], label: 'Erreur' },
]

const parallax = (k: number): React.CSSProperties => ({
  transform: `translate3d(calc(var(--px, 0) * ${k}px), calc(var(--py, 0) * ${k}px), 0)`,
  transition: 'transform 900ms cubic-bezier(0.22, 1, 0.36, 1)',
})

export function UniversePage() {
  const agents = useAgents()
  const defs = useConstellations()
  const runs = useConstellationRuns()
  const automations = useAutomations()
  // Real constellations (definitions); « active » only while a run is actually in progress.
  const activeRunDefs = new Set((runs.data ?? []).filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)).map((r) => r.constellationId))
  const workflows = { data: (defs.data ?? []).filter((d) => !d.isTemplate).map((d) => ({ id: d.id, name: d.name, coordinatorAgentId: d.coordinatorAgentId, memberAgentIds: d.members.map((m) => m.agentId), status: activeRunDefs.has(d.id) ? 'active' : 'done', missionId: null, createdAt: d.createdAt })) }
  const missions = useMissions()
  const remoteMachines = useRemoteMachines()
  const root = useRef<HTMLDivElement>(null)
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
  }, [agents.data?.length])

  // Pointer parallax through CSS variables: no React re-render per frame.
  useEffect(() => {
    const el = root.current
    if (!el) return
    let frame = 0
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        el.style.setProperty('--px', (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3))
        el.style.setProperty('--py', (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3))
      })
    }
    const onLeave = () => {
      el.style.setProperty('--px', '0')
      el.style.setProperty('--py', '0')
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  const list = useMemo(() => agents.data ?? [], [agents.data])
  const placed = useMemo(() => layout(list, size.w, size.h), [list, size])
  const byId = new Map(placed.map((p) => [p.agent.id, p]))
  const planetSize = Math.max(120, Math.min(196, size.w / (list.length > 6 ? 8 : 6.4)))
  const active = hover ?? focus

  const links = (workflows.data ?? [])
    .flatMap((wf) => wf.memberAgentIds.filter((m) => m !== wf.coordinatorAgentId).map((m) => ({ wf, from: byId.get(wf.coordinatorAgentId), to: byId.get(m) })))
    .filter((l) => l.from && l.to)
  // Companions sharing a constellation with the active one stay lit.
  const related = new Set<string>()
  if (active)
    for (const wf of workflows.data ?? [])
      if (wf.coordinatorAgentId === active || wf.memberAgentIds.includes(active)) [wf.coordinatorAgentId, ...wf.memberAgentIds].forEach((id) => related.add(id))
  const currentMission = (id: string) => (missions.data ?? []).find((m) => m.agentId === id && ACTIVE_MISSION_STATUSES.includes(m.status))
  const activePlaced = active ? byId.get(active) : undefined
  /** Next scheduled automation involving this companion (directly or through a constellation). */
  const nextActionFor = (agentId: string) => {
    const mine = (automations.data ?? []).filter((a) => a.status === 'active' && a.nextRunAt && (a.targetId === agentId || (a.targetKind === 'constellation' && defs.data?.find((d) => d.id === a.targetId)?.members.some((m) => m.agentId === agentId))))
    const first = mine.sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0]
    return first ? { name: first.name, at: first.nextRunAt! } : null
  }
  const activeConstellations = active ? (workflows.data ?? []).filter((wf) => wf.coordinatorAgentId === active || wf.memberAgentIds.includes(active)) : []
  const cx = size.w / 2
  const cy = size.h / 2 + 10

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
    else if (e.key === 'Escape') {
      setFocus(null)
      ;(document.activeElement as HTMLElement | null)?.blur()
    } else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(1.6, z + 0.1))
    else if (e.key === '-') setZoom((z) => Math.max(0.6, z - 0.1))
    else if (e.key === '0') setZoom(1)
  }

  useEffect(() => {
    if (focus) document.getElementById(`planet-${focus}`)?.focus()
  }, [focus])

  const activeWf = (workflows.data ?? []).filter((w) => w.status === 'active').length
  const counts = LEGEND.map((l) => ({ ...l, n: list.filter((a) => l.status.includes(a.status)).length })).filter((l) => l.n > 0)

  return (
    <div ref={root} className="relative h-full overflow-hidden bg-[radial-gradient(ellipse_at_50%_55%,#161a2a_0%,#0e1018_45%,#0b0c10_80%)]">
      <div className="drag absolute inset-x-0 top-0 z-10 h-[52px]" />
      {/* Nebula haze: two soft, offset glows give the field some depth. */}
      <div className="orbit-parallax pointer-events-none absolute inset-0" style={parallax(-6)} aria-hidden>
        <div className="absolute top-[8%] left-[12%] h-[38%] w-[34%] rounded-full bg-[#7E9CE8]/[0.05] blur-[90px]" />
        <div className="absolute right-[8%] bottom-[6%] h-[40%] w-[38%] rounded-full bg-[#A59BFA]/[0.05] blur-[100px]" />
      </div>
      <div className="orbit-parallax pointer-events-none absolute -inset-4" style={parallax(-5)} aria-hidden>
        {FAR.map((s, i) => (
          <span
            key={i}
            className={cn('absolute rounded-full bg-white', s.twinkle && 'orbit-anim-twinkle')}
            style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: s.s, height: s.s, opacity: s.o, ['--o' as string]: s.o, animationDelay: `${s.delay}s` }}
          />
        ))}
      </div>
      <div className="orbit-parallax pointer-events-none absolute -inset-6" style={parallax(-14)} aria-hidden>
        {NEAR.map((s, i) => (
          <span key={i} className="absolute rounded-full bg-[#dcd8ff]" style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: s.s + 0.4, height: s.s + 0.4, opacity: s.o * 0.9 }} />
        ))}
      </div>

      <header className="pointer-events-none absolute top-[30px] left-8 z-20">
        <div className="no-drag pointer-events-auto mb-3 w-fit">
          <HomeViewSwitch value="universe" />
        </div>
        <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-fg">Mon univers</h1>
        <p className="mt-0.5 text-[13.5px] text-fg-2">
          {list.length ? `${list.length} compagnon${list.length > 1 ? 's' : ''} en orbite` : 'Aucun compagnon'}
          {activeWf > 0 && <span className="text-fg-3"> · {activeWf} constellation{activeWf > 1 ? 's' : ''} active{activeWf > 1 ? 's' : ''}</span>}
        </p>
      </header>

      <div className="hud no-drag absolute top-[30px] right-6 z-20 flex h-9 items-center gap-0.5 rounded-[12px] px-1">
        <Tooltip content={showLinks ? 'Masquer les constellations' : 'Afficher les constellations'}>
          <button
            aria-pressed={showLinks}
            onClick={() => setShowLinks((v) => !v)}
            aria-label="Afficher les constellations"
            className={cn('flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[12px] font-medium transition-colors', showLinks ? 'bg-accent/15 text-accent' : 'text-fg-3 hover:bg-white/[0.05] hover:text-fg')}
          >
            <Waypoints className="size-3.5" /> Liens
          </button>
        </Tooltip>
        <div className="mx-1 h-4 w-px bg-white/[0.08]" />
        <Button size="icon" variant="ghost" className="rounded-[8px]" onClick={() => setZoom((z) => Math.max(0.6, z - 0.1))} aria-label="Dézoomer" disabled={zoom <= 0.6}>
          <Minus />
        </Button>
        <Tooltip content="Revenir à 100 %">
          <button onClick={() => setZoom(1)} className="h-7 w-11 rounded-[8px] text-center text-[11.5px] font-medium text-fg-2 tabular transition-colors hover:bg-white/[0.05] hover:text-fg">
            {Math.round(zoom * 100)} %
          </button>
        </Tooltip>
        <Button size="icon" variant="ghost" className="rounded-[8px]" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))} aria-label="Zoomer" disabled={zoom >= 1.6}>
          <Plus />
        </Button>
        <div className="mx-1 h-4 w-px bg-white/[0.08]" />
        <Tooltip content="Recentrer">
          <Button size="icon" variant="ghost" className="rounded-[8px]" onClick={() => { setZoom(1); setFocus(null) }} aria-label="Recentrer">
            <LocateFixed />
          </Button>
        </Tooltip>
      </div>

      {agents.data && list.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <OrbitEmptyState
            title="Un univers encore vide"
            body="Chaque compagnon que vous créez prend place ici, sur sa planète, en orbite autour de vous."
            action={<Button variant="primary" onClick={() => navigate('/companions/new')}><Plus /> Nouveau compagnon</Button>}
          />
        </div>
      ) : (
        <div
          ref={ref}
          role="listbox"
          aria-label="Compagnons de votre univers. Flèches pour naviguer, Entrée pour ouvrir."
          tabIndex={-1}
          onKeyDown={onKey}
          className="absolute inset-0 outline-none transition-transform duration-500 ease-[var(--ease-orbit)]"
          style={{ transform: `scale(${zoom})` }}
        >
          <svg className="orbit-parallax pointer-events-none absolute inset-0 h-full w-full overflow-visible" style={parallax(3)} aria-hidden>
            <defs>
              <radialGradient id="core" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stopColor="#A59BFA" stopOpacity="0.34" />
                <stop offset="0.4" stopColor="#7E9CE8" stopOpacity="0.08" />
                <stop offset="1" stopColor="#7E9CE8" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="link" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#A59BFA" stopOpacity="0.2" />
                <stop offset="0.5" stopColor="#C9C2FF" stopOpacity="0.9" />
                <stop offset="1" stopColor="#A59BFA" stopOpacity="0.2" />
              </linearGradient>
            </defs>
            {[...new Set(placed.map((p) => `${p.rx}:${p.ry}`))].map((k) => {
              const [rx, ry] = k.split(':').map(Number)
              return <ellipse key={k} cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke="#fff" strokeOpacity={active ? 0.035 : 0.06} strokeDasharray="2 6" className="transition-[stroke-opacity] duration-500" />
            })}
            <circle cx={cx} cy={cy} r="96" fill="url(#core)" />
            <circle cx={cx} cy={cy} r="14" fill="none" stroke="#C9C2FF" strokeOpacity="0.12" />
            <circle cx={cx} cy={cy} r="3" fill="#E4DEFF" opacity="0.85" />
            {/* Tether from you to the companion under the pointer. */}
            {activePlaced && (
              <line x1={cx} y1={cy} x2={activePlaced.x} y2={activePlaced.y} stroke="#C9C2FF" strokeOpacity="0.16" strokeDasharray="1 4" strokeLinecap="round" />
            )}
            {showLinks &&
              links.map(({ wf, from, to }) => {
                const hot = !!active && (active === from!.agent.id || active === to!.agent.id)
                const mx = (from!.x + to!.x) / 2
                const my = (from!.y + to!.y) / 2 - 40
                return (
                  <g key={`${wf.id}-${to!.agent.id}`} className="transition-opacity duration-300" opacity={active ? (hot ? 1 : 0.18) : 0.75}>
                    {hot && <path d={`M${from!.x} ${from!.y} Q${mx} ${my} ${to!.x} ${to!.y}`} fill="none" stroke="#A59BFA" strokeOpacity="0.18" strokeWidth="6" strokeLinecap="round" />}
                    <path
                      d={`M${from!.x} ${from!.y} Q${mx} ${my} ${to!.x} ${to!.y}`}
                      fill="none"
                      stroke="url(#link)"
                      strokeWidth={hot ? 1.6 : 1.1}
                      strokeDasharray={hot ? '3 5' : '1 5'}
                      strokeLinecap="round"
                      // Flowing dashes only while the constellation really runs: never decorative.
                      className={wf.status === 'active' ? 'orbit-anim-flow' : undefined}
                    />
                  </g>
                )
              })}
          </svg>
          <div className="orbit-parallax pointer-events-none absolute text-center text-2xs tracking-[0.16em] text-fg-3 uppercase" style={{ left: cx - 60, top: cy + 22, width: 120, ...parallax(3) }}>
            Vous
          </div>
          {showLinks && active && activeConstellations.length > 0 && activePlaced && (
            <div className="orbit-parallax pointer-events-none absolute flex -translate-x-1/2 flex-col items-center gap-1" style={{ left: cx, top: cy - 64, ...parallax(3) }}>
              {activeConstellations.map((wf) => (
                <span key={wf.id} className="orbit-anim-rise hud flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] text-fg-2">
                  <Waypoints className="size-3 text-accent" /> {wf.name}
                </span>
              ))}
            </div>
          )}

          {placed
            .slice()
            .sort((a, b) => a.depth - b.depth)
            .map(({ agent, x, y, depth }, order) => {
              const s = planetSize * (0.88 + (depth + 1) * 0.08)
              const isActive = active === agent.id
              const dimmed = !!active && !isActive
              const kin = dimmed && related.has(agent.id)
              const glow = PALETTES[agent.appearance.palette].glow
              return (
                <div
                  key={agent.id}
                  className="orbit-parallax absolute"
                  style={{ left: x - s / 2, top: y - s / 2 - s * 0.1, width: s, zIndex: isActive ? 60 : Math.round((depth + 2) * 10), ...parallax(4 + (depth + 1) * 4) }}
                >
                  <div className="orbit-anim-rise" style={{ animationDelay: `${order * 70}ms` }}>
                    <button
                      id={`planet-${agent.id}`}
                      role="option"
                      aria-selected={focus === agent.id}
                      aria-label={`${agent.name}, ${agent.role}, ${STATUS_LABELS[agent.status]}`}
                      onMouseEnter={() => setHover(agent.id)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setFocus(agent.id)}
                      onBlur={() => setFocus((f) => (f === agent.id ? null : f))}
                      onClick={() => navigate(`/companions/${agent.id}`)}
                      className={cn('group relative block w-full rounded-full outline-none transition-[opacity,filter] duration-300', dimmed && (kin ? 'opacity-80' : 'opacity-45 saturate-[0.7]'))}
                    >
                      <span aria-hidden className={cn('absolute inset-[6%] rounded-full blur-2xl transition-opacity duration-500', isActive ? 'opacity-100' : 'opacity-0')} style={{ background: `radial-gradient(circle, ${glow}40, transparent 65%)` }} />
                      <svg aria-hidden viewBox="0 0 100 100" className={cn('absolute inset-0 overflow-visible transition-[opacity,transform] duration-500 ease-[var(--ease-orbit)]', isActive ? 'scale-100 opacity-100' : 'scale-90 opacity-0')}>
                        <g className="orbit-anim-spin" style={{ transformOrigin: '50px 56px' }}>
                          <circle cx="50" cy="56" r="40" fill="none" stroke={glow} strokeOpacity="0.55" strokeWidth="0.5" strokeDasharray="1 3" />
                          <circle cx="90" cy="56" r="1.4" fill={glow} />
                        </g>
                      </svg>
                      <span className={cn('relative block transition-transform duration-500 ease-[var(--ease-orbit)]', isActive && 'scale-[1.06]')}>
                        <CompanionAvatar appearance={agent.appearance} status={agent.status} variant="detailed" size={s} seed={agent.id} animated />
                      </span>
                    </button>
                    <div className={cn('pointer-events-none -mt-[10%] text-center transition-opacity duration-300', dimmed && !kin && 'opacity-50')}>
                      <div className="flex items-center justify-center gap-1.5 text-[13.5px] font-medium text-fg [text-shadow:0_1px_8px_rgb(0_0_0/0.8)]">
                        <span className={cn('size-[6px] rounded-full', statusColorClass(agent.status), agent.status === 'awaiting_approval' && 'orbit-blip')} />
                        {agent.name}
                        {agent.runtime === 'remote' && (() => {
                          const m = remoteMachines.data?.find((x) => x.id === agent.machineId)
                          return <Server aria-label={`Sur ${m?.name ?? 'une machine distante'}${m?.status === 'online' ? '' : ' (hors ligne)'}`} className={cn('size-3', m?.status === 'online' ? 'text-fg-3' : 'text-fg-4 opacity-60')} />
                        })()}
                      </div>
                      <div className="mx-auto max-w-[180px] truncate text-xs text-fg-3">{agent.statusText ?? STATUS_LABELS[agent.status]}</div>
                    </div>
                  </div>
                </div>
              )
            })}

          {activePlaced && (
            <InfoCard
              placed={activePlaced}
              width={size.w}
              planet={planetSize}
              mission={currentMission(activePlaced.agent.id)}
              constellations={activeConstellations.map((w) => w.name)}
              next={nextActionFor(activePlaced.agent.id)}
            />
          )}
        </div>
      )}

      <div className="pointer-events-none absolute bottom-5 left-8 z-20 flex items-center gap-3 text-2xs text-fg-3">
        <span className="flex items-center gap-1"><Kbd>←</Kbd><Kbd>→</Kbd> parcourir</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd> ouvrir</span>
        <span className="flex items-center gap-1"><Kbd>+</Kbd><Kbd>−</Kbd> zoomer</span>
      </div>
      {counts.length > 0 && (
        <div className="hud pointer-events-none absolute right-6 bottom-5 z-20 flex h-8 items-center gap-3.5 rounded-[10px] px-3 text-[11.5px] text-fg-2">
          {counts.map((c) => (
            <span key={c.label} className="flex items-center gap-1.5">
              <span className={cn('size-[6px] rounded-full', statusColorClass(c.status[0]!))} />
              {c.label}
              <span className="text-fg-3 tabular">{c.n}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function InfoCard({ placed, width, planet, mission, constellations = [], next }: { placed: ReturnType<typeof layout>[number]; width: number; planet: number; mission?: { title: string; startedAt: string | null }; constellations?: string[]; next?: { name: string; at: string } | null }) {
  const { agent, x, y } = placed
  const right = x < width * 0.62
  const W = 236
  const left = right ? x + planet * 0.52 : x - planet * 0.52 - W
  return (
    <div
      className="hud orbit-anim-rise pointer-events-none absolute z-[70] rounded-[14px] p-3"
      style={{ left, top: y - planet * 0.42, width: W }}
      role="presentation"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[13.5px] font-semibold text-fg">{agent.name}</span>
        <span className="flex items-center gap-1 rounded-full bg-white/[0.06] px-1.5 py-px text-[10.5px] text-fg-2">
          <span className={cn('size-[5px] rounded-full', statusColorClass(agent.status))} />
          {STATUS_LABELS[agent.status]}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[12px] text-fg-3">{agent.role || 'Compagnon'}</div>
      {mission ? (
        <div className="mt-2.5 rounded-[9px] bg-white/[0.04] px-2.5 py-2 ring-1 ring-white/[0.05]">
          <div className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.04em] text-accent uppercase">
            <Rocket className="size-3" /> Mission
            {mission.startedAt && <span className="ml-auto font-normal tracking-normal text-fg-3 normal-case tabular">{duration(mission.startedAt)}</span>}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-fg">{mission.title}</div>
        </div>
      ) : (
        agent.description && <div className="mt-2 line-clamp-2 text-[12px] leading-snug text-fg-2">{agent.description}</div>
      )}
      {constellations.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {constellations.map((c) => (
            <span key={c} className="flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-px text-[10.5px] text-accent"><Waypoints className="size-2.5" /> {c}</span>
          ))}
        </div>
      )}
      {next && <div className="mt-2 text-[11.5px] text-fg-3">Prochaine action : <span className="text-fg-2">{next.name}</span> · {relative(next.at)}</div>}
      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-fg-3">
        <Kbd>↵</Kbd> Ouvrir le profil
      </div>
    </div>
  )
}
