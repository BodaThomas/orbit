import type { ProviderId, RateLimitSnapshot } from '@shared/types'
import { cn } from '@/lib/cn'
import { relative } from '@/lib/format'

const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Fenêtre de 5 heures',
  seven_day: 'Fenêtre hebdomadaire',
  seven_day_opus: 'Hebdomadaire · Opus',
  seven_day_sonnet: 'Hebdomadaire · Sonnet',
  other: 'Autre fenêtre',
}

/**
 * Subscription quota exactly as the engine reported it during a run (rate_limit_event,
 * account/rateLimits). Never reconstructed from local tokens. No snapshot → say so.
 */
export function QuotaCard({ providerId, snapshot, engineName, className }: { providerId: ProviderId; snapshot: RateLimitSnapshot | undefined; engineName: string; className?: string }) {
  if (!snapshot) {
    return (
      <div className={cn('rounded-[11px] bg-white/[0.02] px-3 py-2.5 text-[12.5px] text-fg-3 ring-1 ring-line', className)} data-provider={providerId}>
        Quota indisponible — consulter {engineName}
        <div className="mt-0.5 text-2xs text-fg-4">Orbit n’affiche un quota que lorsque {engineName} le communique lui-même pendant une exécution.</div>
      </div>
    )
  }
  return (
    <div className={cn('space-y-2.5 rounded-[11px] bg-white/[0.02] px-3 py-2.5 ring-1 ring-line', className)}>
      {snapshot.windows.map((w) => {
        const pct = w.utilization != null ? Math.round(w.utilization * 100) : null
        return (
          <div key={w.kind}>
            <div className="flex items-baseline justify-between text-[12.5px]">
              <span className="text-fg-2">{WINDOW_LABELS[w.kind] ?? w.kind}</span>
              <span className={cn('tabular', w.status === 'rejected' ? 'text-danger' : w.status === 'allowed_warning' ? 'text-warning' : 'text-fg')}>{pct != null ? `${pct} %` : w.status === 'rejected' ? 'Limite atteinte' : 'Utilisation non communiquée'}</span>
            </div>
            {pct != null && (
              <div className="mt-1 h-[5px] overflow-hidden rounded-full bg-white/[0.06]">
                <div className={cn('h-full rounded-full', pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-accent')} style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
            )}
            {w.resetsAt && <div className="mt-0.5 text-2xs text-fg-4">Réinitialisation {new Date(w.resetsAt).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
          </div>
        )
      })}
      <div className="text-2xs text-fg-4">Communiqué par {snapshot.source} · {relative(snapshot.observedAt)}</div>
    </div>
  )
}
