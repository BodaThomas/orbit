import { Rocket, ShieldAlert, TriangleAlert } from 'lucide-react'
import { PALETTES, STATUS_LABELS } from '@shared/catalog'
import { ENGINE_INFO } from '@shared/engines'
import type { Agent, Mission, ProviderInfo } from '@shared/types'
import { cn } from '@/lib/cn'
import { duration, relative } from '@/lib/format'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'
import { CompanionAvatar, statusColorClass } from './CompanionAvatar'
import { ProviderMark } from './ProviderMark'

const STATUS_TEXT: Partial<Record<Agent['status'], string>> = {
  working: 'text-accent',
  awaiting_approval: 'text-warning',
  error: 'text-danger',
  done: 'text-success',
}

const SHORT: Record<Agent['status'], string> = {
  available: 'Disponible',
  working: 'En mission',
  awaiting_approval: 'Attend votre accord',
  done: 'Terminé',
  error: 'Erreur',
  offline: 'Hors ligne',
  disabled: 'Désactivé',
}

/**
 * Overview card: one companion and what it is doing right now. Working cards
 * carry an indeterminate "live" sweep - never an invented progress value.
 */
export function CompanionCard({ agent, mission, provider }: { agent: Agent; mission?: Mission; provider?: ProviderInfo }) {
  const model = provider?.models.find((m) => m.id === agent.model)?.label ?? agent.model
  const live = useUi((s) => (mission ? s.missionActivity[mission.id] : null))
  const palette = PALETTES[agent.appearance.palette]
  const busy = agent.status === 'working' || agent.status === 'awaiting_approval'
  const eyebrow =
    agent.status === 'awaiting_approval'
      ? { icon: ShieldAlert, text: 'Attend votre accord' }
      : agent.status === 'error'
        ? { icon: TriangleAlert, text: 'Mission interrompue' }
        : mission
          ? { icon: Rocket, text: 'Mission en cours' }
          : null

  return (
    <button
      onClick={() => navigate(`/companions/${agent.id}`)}
      className="card card-hover group relative flex min-w-0 flex-col overflow-hidden text-left"
    >
      <span
        aria-hidden
        className={cn('pointer-events-none absolute inset-0 transition-opacity duration-300', busy ? 'opacity-100' : 'opacity-50 group-hover:opacity-80')}
        style={{ background: `radial-gradient(110% 80% at 0% 0%, ${palette.glow}1c, transparent 55%)` }}
      />
      <div className="relative flex items-center gap-3 px-3.5 pt-3.5">
        <CompanionAvatar appearance={agent.appearance} status={agent.status} variant="detailed" size={56} seed={agent.id} animated={busy} className="-my-1 -ml-1" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{agent.name}</span>
            <span className={cn('ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.05] px-1.5 py-px text-[11px]', STATUS_TEXT[agent.status] ?? 'text-fg-3')}>
              <span className={cn('size-[5px] rounded-full', statusColorClass(agent.status), agent.status === 'awaiting_approval' && 'orbit-blip')} />
              {SHORT[agent.status]}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-fg-3">{agent.role || 'Compagnon'}</div>
        </div>
      </div>

      <div className="relative mt-3 min-h-[58px] flex-1 px-3.5">
        {eyebrow ? (
          <>
            <div className={cn('flex items-center gap-1.5 text-[11px] font-medium tracking-[0.04em] uppercase', STATUS_TEXT[agent.status] ?? 'text-fg-3')}>
              <eyebrow.icon className="size-3" />
              {eyebrow.text}
              {mission?.startedAt && busy && <span className="ml-auto font-normal tracking-normal text-fg-3 normal-case tabular">{duration(mission.startedAt)}</span>}
            </div>
            <div className="mt-1 line-clamp-2 text-[13.5px] leading-[19px] font-medium text-fg">{mission?.title ?? agent.statusText ?? STATUS_LABELS[agent.status]}</div>
            {live?.label && <div className="mt-0.5 truncate text-[12px] text-fg-3">{live.label}</div>}
          </>
        ) : (
          <>
            <div className="text-[11px] font-medium tracking-[0.04em] text-fg-4 uppercase">Au repos</div>
            <div className="mt-1 line-clamp-2 text-[13px] leading-[19px] text-fg-3">{agent.statusText ?? agent.description ?? 'Prêt pour une nouvelle mission.'}</div>
          </>
        )}
      </div>

      <div className="relative mt-3 h-px bg-line">
        {agent.status === 'working' && (
          <span className="absolute inset-0 overflow-hidden">
            <span className="orbit-anim-sweep absolute inset-y-0 left-0 w-1/3" style={{ background: `linear-gradient(90deg, transparent, ${palette.accent}, transparent)` }} />
          </span>
        )}
      </div>
      <div className="relative flex h-9 items-center gap-2 px-3.5 text-[12px] text-fg-3">
        <ProviderMark id={agent.providerId} size={15} />
        <span className="truncate"><span className="text-fg-2">{ENGINE_INFO[agent.providerId].label}</span> · {model === 'default' ? 'modèle par défaut' : model}</span>
        {!busy && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              useUi.getState().openNewMission(agent.id)
            }}
            className="ml-auto flex h-6 shrink-0 -mr-1.5 items-center gap-1 rounded-[6px] px-1.5 text-fg-2 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.06] hover:text-fg"
          >
            <Rocket className="size-3" /> Confier
          </span>
        )}
        {!busy && <span className="absolute right-3.5 shrink-0 text-fg-4 transition-opacity group-hover:opacity-0">{relative(agent.updatedAt)}</span>}
      </div>
    </button>
  )
}
