import type { HealthLevel, ProviderHealth } from '@shared/types'
import { Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'

const COLORS: Record<HealthLevel, string> = {
  operational: 'bg-success/85',
  degraded: 'bg-warning',
  outage: 'bg-danger',
  unknown: 'bg-unknown/60',
}
const LABEL: Record<HealthLevel, string> = { operational: 'Aucun incident', degraded: 'Dégradé', outage: 'Incident majeur', unknown: 'Données indisponibles' }

export function UptimeHistoryBars({ days, height = 30, className }: { days: ProviderHealth['days']; height?: number; className?: string }) {
  const filled = days.length ? days : Array.from({ length: 30 }, (_, i) => ({ date: String(i), level: 'unknown' as const, incidents: 0 }))
  return (
    <div className={cn('flex items-stretch gap-[3px]', className)} style={{ height }} role="img" aria-label="Historique de disponibilité sur 30 jours">
      {filled.map((d) => (
        <Tooltip
          key={d.date}
          delay={80}
          content={
            <span className="tabular">
              {days.length ? new Date(`${d.date}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—'} · {LABEL[d.level]}
              {d.incidents > 0 && ` · ${d.incidents} incident${d.incidents > 1 ? 's' : ''}`}
            </span>
          }
        >
          <span className={cn('min-w-0 flex-1 rounded-[3px] transition-[filter] hover:brightness-125', COLORS[d.level])} />
        </Tooltip>
      ))}
    </div>
  )
}
