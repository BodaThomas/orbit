import { useEffect, useMemo, useRef, useState } from 'react'
import { PALETTES } from '@shared/catalog'
import type { Agent, AgentStatus, ConstellationSignal } from '@shared/types'
import { cn } from '@/lib/cn'
import { useUi } from '@/stores/ui'
import { CompanionAvatar } from './CompanionAvatar'

export type LinkState = 'idle' | 'pending' | 'working' | 'awaiting' | 'done' | 'error'

export interface MapNode {
  agent: Agent
  role: string
  coordinator: boolean
  state: LinkState
  /** Short line under the name: current mission or result. */
  caption?: string | null
  /** Live engine activity label (never invented). */
  activity?: string | null
}

export interface MapProps {
  nodes: MapNode[]
  /** Member → member dependencies (agent ids). */
  dependencies?: { from: string; to: string; state: LinkState }[]
  runId?: string | null
  height?: number
  compact?: boolean
  selected?: string | null
  onSelect?: (agentId: string) => void
  className?: string
}

const LINK_COLORS: Record<LinkState, { stroke: string; opacity: number; dash?: string }> = {
  idle: { stroke: '#A59BFA', opacity: 0.18, dash: '1 6' },
  pending: { stroke: '#A59BFA', opacity: 0.3, dash: '3 5' },
  working: { stroke: '#A59BFA', opacity: 0.6 },
  awaiting: { stroke: '#E5B565', opacity: 0.65, dash: '4 4' },
  done: { stroke: '#69C996', opacity: 0.45 },
  error: { stroke: '#EF808A', opacity: 0.6, dash: '2 4' },
}

const STATE_TO_STATUS: Record<LinkState, AgentStatus> = { idle: 'available', pending: 'available', working: 'working', awaiting: 'awaiting_approval', done: 'done', error: 'error' }
const STATE_LABEL: Record<LinkState, string> = { idle: 'En réserve', pending: 'Prévu', working: 'Au travail', awaiting: 'Attend votre accord', done: 'Résultat transmis', error: 'Erreur' }

function reducedMotion(): boolean {
  if (document.documentElement.dataset.motion === 'reduce') return true
  if (document.documentElement.dataset.motion === 'always') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Quadratic curve between two points, bowed slightly so links read as orbits. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, bow = 0.18) {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${(mx - dy * bow).toFixed(1)} ${(my + dx * bow).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
}

/**
 * A constellation drawn like « Mon univers »: the coordinator's planet in the centre,
 * members around it, links whose style reflects real task states. A light pulse
 * travels along a link only when Orbit receives a real delegation or result event.
 */
export function ConstellationMap({ nodes, dependencies = [], runId, height = 360, compact, selected, onSelect, className }: MapProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(720)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const coordinator = nodes.find((n) => n.coordinator)
  const members = nodes.filter((n) => !n.coordinator)
  const planet = compact ? 54 : Math.max(76, Math.min(112, w / (members.length + 3)))
  const hubSize = compact ? 64 : planet * 1.2
  const positions = useMemo(() => {
    const cx = w / 2
    const cy = compact ? height / 2 : height * 0.42
    const map = new Map<string, { x: number; y: number }>()
    if (coordinator) map.set(coordinator.agent.id, { x: cx, y: cy })
    const n = members.length
    const rx = Math.min(w * 0.4, compact ? w * 0.36 : 360)
    const ry = Math.min(height * 0.36, compact ? height * 0.34 : 150)
    members.forEach((m, i) => {
      const a = n === 1 ? Math.PI / 2 : Math.PI * (0.08 + (0.84 * i) / (n - 1)) + (n > 4 ? -Math.PI * 0.08 : 0)
      const angle = n > 4 ? (i / n) * Math.PI * 2 + Math.PI / 2 : a
      map.set(m.agent.id, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry * (n > 4 ? 1 : 1.05) })
    })
    // Labels never leave the frame: half a label width of margin on each side.
    const half = (compact ? 110 : 170) / 2 + 6
    for (const [id, p] of map) map.set(id, { x: Math.min(w - half, Math.max(half, p.x)), y: p.y })
    return map
  }, [w, height, coordinator, members, compact])

  // Real events only: each new signal for this run spawns one pulse, then disappears.
  const signals = useUi((s) => s.signals)
  const [pulses, setPulses] = useState<{ seq: number; from: string; to: string; kind: ConstellationSignal['kind'] }[]>([])
  const lastSeq = useRef(signals.at(-1)?.seq ?? 0)
  useEffect(() => {
    const fresh = signals.filter((s) => s.seq > lastSeq.current && s.runId === runId && s.fromAgentId && s.toAgentId)
    if (!signals.length) return
    lastSeq.current = signals.at(-1)!.seq
    if (!fresh.length) return
    setPulses((p) => [...p, ...fresh.map((s) => ({ seq: s.seq, from: s.fromAgentId!, to: s.toAgentId!, kind: s.kind }))])
    const t = setTimeout(() => setPulses((p) => p.filter((x) => !fresh.some((f) => f.seq === x.seq))), 1800)
    return () => clearTimeout(t)
  }, [signals, runId])
  const reduce = reducedMotion()

  return (
    <div ref={ref} className={cn('relative overflow-hidden rounded-[14px] bg-[radial-gradient(ellipse_at_50%_38%,#1b1e2d_0%,#13141b_62%,#0f1015_100%)] ring-1 ring-line', className)} style={{ height }}>
      <div className="pointer-events-none absolute inset-0 opacity-60" aria-hidden>
        {Array.from({ length: compact ? 14 : 36 }, (_, i) => (
          <span key={i} className="absolute size-px rounded-full bg-white" style={{ left: `${(i * 37 + 11) % 100}%`, top: `${(i * 53 + 7) % 100}%`, opacity: 0.12 + ((i * 7) % 5) / 14 }} />
        ))}
      </div>
      <svg className="pointer-events-none absolute inset-0" width={w} height={height} aria-hidden>
        <defs>
          <radialGradient id="pulse-glow">
            <stop offset="0" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.4" stopColor="#C9C2FF" stopOpacity="0.8" />
            <stop offset="1" stopColor="#A59BFA" stopOpacity="0" />
          </radialGradient>
        </defs>
        {coordinator &&
          members.map((m) => {
            const a = positions.get(coordinator.agent.id)
            const b = positions.get(m.agent.id)
            if (!a || !b) return null
            const c = LINK_COLORS[m.state]
            const dim = selected && selected !== m.agent.id && selected !== coordinator.agent.id
            return <path key={m.agent.id} id={`link-${runId ?? 'x'}-${m.agent.id}`} d={curve(a, b)} fill="none" stroke={c.stroke} strokeOpacity={dim ? c.opacity * 0.4 : c.opacity} strokeWidth={m.state === 'working' ? 1.6 : 1.1} strokeDasharray={c.dash} strokeLinecap="round" />
          })}
        {dependencies.map((d) => {
          const a = positions.get(d.from)
          const b = positions.get(d.to)
          if (!a || !b) return null
          const c = LINK_COLORS[d.state]
          return <path key={`${d.from}-${d.to}`} d={curve(a, b, -0.12)} fill="none" stroke={c.stroke} strokeOpacity={c.opacity * 0.7} strokeWidth={1} strokeDasharray="2 6" markerEnd="" />
        })}
        {pulses.map((p) => {
          const a = positions.get(p.from)
          const b = positions.get(p.to)
          if (!a || !b) return null
          const color = p.kind === 'error' ? '#EF808A' : p.kind === 'result' ? '#69C996' : '#C9C2FF'
          // Reduced motion: the link flashes once instead of a travelling light.
          if (reduce) return <path key={p.seq} d={curve(a, b)} fill="none" stroke={color} strokeOpacity="0.9" strokeWidth="2.2" className="orbit-link-flash" />
          return (
            <g key={p.seq}>
              <path d={curve(a, b)} fill="none" stroke={color} strokeOpacity="0.35" strokeWidth="2" className="orbit-link-flash" />
              <circle r="7" fill="url(#pulse-glow)">
                <animateMotion dur="1.2s" repeatCount="1" fill="freeze" path={curve(a, b)} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
              </circle>
              <circle r="2.2" fill={color}>
                <animateMotion dur="1.2s" repeatCount="1" fill="freeze" path={curve(a, b)} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
              </circle>
            </g>
          )
        })}
      </svg>
      {nodes.map((n) => {
        const p = positions.get(n.agent.id)
        if (!p) return null
        const size = n.coordinator ? hubSize : planet
        const palette = PALETTES[n.agent.appearance.palette]
        const isSel = selected === n.agent.id
        return (
          <button
            key={n.agent.id}
            type="button"
            onClick={() => onSelect?.(n.agent.id)}
            aria-pressed={isSel}
            aria-label={`${n.agent.name}, ${n.role}, ${STATE_LABEL[n.state]}`}
            className={cn('group absolute flex -translate-x-1/2 flex-col items-center outline-none', onSelect ? 'cursor-pointer' : 'cursor-default')}
            style={{ left: p.x, top: p.y - size / 2, width: compact ? 110 : 170 }}
          >
            <span className={cn('relative rounded-full transition-transform duration-300', isSel && 'scale-[1.06]', n.state === 'working' && 'orbit-planet-lit')} style={{ ['--glow' as string]: palette.glow }}>
              <CompanionAvatar appearance={n.agent.appearance} variant="detailed" size={size} seed={n.agent.id} status={STATE_TO_STATUS[n.state]} animated={n.state === 'working'} showStatus={!compact} />
              {isSel && <span className="absolute -inset-2 rounded-full ring-1 ring-white/20" />}
            </span>
            {!compact && (
              <span className="mt-1 max-w-full text-center">
                <span className="block truncate text-[13px] font-medium text-fg">
                  {n.agent.name} <span className="font-normal text-fg-3">· {n.role}</span>
                </span>
                <span className={cn('block truncate text-[11.5px]', n.state === 'error' ? 'text-danger' : n.state === 'awaiting' ? 'text-warning' : n.state === 'working' ? 'text-accent' : 'text-fg-3')}>{n.activity ?? n.caption ?? STATE_LABEL[n.state]}</span>
              </span>
            )}
            {compact && <span className="mt-0.5 max-w-full truncate text-[11px] text-fg-2">{n.agent.name}</span>}
          </button>
        )
      })}
    </div>
  )
}
