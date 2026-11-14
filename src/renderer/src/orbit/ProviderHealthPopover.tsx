import { AlertTriangle, CheckCircle2, CircleHelp, ExternalLink, OctagonAlert, RefreshCw } from 'lucide-react'
import type { HealthLevel, ProviderHealth, ProviderInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/api'
import { clock, relative } from '@/lib/format'
import { cn } from '@/lib/cn'
import { ProviderMark } from './ProviderMark'
import { UptimeHistoryBars } from './UptimeHistoryBars'

export const HEALTH_META: Record<HealthLevel, { label: string; icon: typeof CheckCircle2; text: string; dot: string }> = {
  operational: { label: 'Opérationnel', icon: CheckCircle2, text: 'text-success', dot: 'bg-success' },
  degraded: { label: 'Dégradé', icon: AlertTriangle, text: 'text-warning', dot: 'bg-warning' },
  outage: { label: 'Incident', icon: OctagonAlert, text: 'text-danger', dot: 'bg-danger' },
  unknown: { label: 'Inconnu', icon: CircleHelp, text: 'text-fg-3', dot: 'bg-unknown' },
}

const STATUS_FR: Record<string, string> = {
  investigating: 'Enquête',
  identified: 'Identifié',
  monitoring: 'Surveillance',
  resolved: 'Résolu',
  update: 'Mise à jour',
  scheduled: 'Planifié',
  in_progress: 'En cours',
}

export function ProviderHealthCard({ provider, health, onRefresh, refreshing }: { provider: ProviderInfo; health: ProviderHealth | undefined; onRefresh?: () => void; refreshing?: boolean }) {
  const level = health?.level ?? 'unknown'
  const meta = HEALTH_META[level]
  const Icon = meta.icon
  const incident = health?.activeIncidents[0]
  const affected = health?.components.filter((c) => c.level !== 'operational' && c.level !== 'unknown') ?? []

  return (
    <div className="w-[400px]">
      <div className="m-2 rounded-[14px] bg-white/[0.03] p-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
        <div className="flex items-start gap-3">
          <ProviderMark id={provider.id} size={28} />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-fg">{provider.name}</div>
            <div className="mt-0.5 text-[12.5px] leading-snug text-fg-3">{provider.services.join(' · ') || 'Aucun service suivi'}</div>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className={cn('flex items-center gap-2 text-[14px] font-medium', meta.text)}>
            <Icon className="size-[18px]" />
            <span className="text-fg">{health ? meta.label : 'Jamais vérifié'}</span>
          </div>
          {affected.length > 0 && <span className="text-xs text-fg-3">{affected.length} service{affected.length > 1 ? 's' : ''} touché{affected.length > 1 ? 's' : ''}</span>}
        </div>

        <UptimeHistoryBars days={health?.days ?? []} className="mt-3" />
        <div className="mt-2 flex justify-between text-xs text-fg-3 tabular">
          <span>30 jours · UTC</span>
          <span title="Estimée à partir des incidents majeurs publiés">
            {health?.uptimePct != null ? `Disponibilité ${health.uptimePct.toLocaleString('fr-FR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} %` : 'Disponibilité —'}
          </span>
        </div>

        {incident && (
          <div className="mt-4 border-t border-line pt-3.5">
            <div className="text-[14px] leading-snug font-semibold text-fg">{incident.name}</div>
            <div className="mt-0.5 text-xs text-fg-3 tabular">
              Commencé {clock(incident.startedAt)} · Mis à jour {clock(incident.updatedAt)}
            </div>
            <ol className="mt-3 space-y-2.5">
              {incident.updates.slice(0, 2).map((u, i) => (
                <li key={i} className="relative pl-4">
                  <span className={cn('absolute top-[7px] left-0 size-[7px] rounded-full', i === 0 ? 'bg-fg' : 'bg-fg-4')} />
                  <div className="text-[13px] font-medium text-fg">
                    {STATUS_FR[u.status] ?? u.status} <span className="ml-1 font-normal text-fg-3 tabular">{clock(u.at)}</span>
                  </div>
                  <p className="selectable mt-0.5 line-clamp-4 text-[12.5px] leading-relaxed text-fg-2">{u.body}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
        {health?.error && <p className="mt-3 text-xs text-fg-3">Dernière vérification impossible : {health.error}</p>}
      </div>
      <div className="flex items-center justify-between px-4 pt-1 pb-3">
        <span className="text-xs text-fg-3">{health ? `Mesuré ${relative(health.checkedAt)}` : 'Aucune mesure'}</span>
        <div className="flex gap-1">
          {onRefresh && (
            <Button size="icon-sm" variant="ghost" onClick={onRefresh} aria-label="Actualiser" title="Actualiser">
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
            </Button>
          )}
          {provider.statusPage && (
            <Button size="xs" variant="ghost" onClick={() => void call('app.openStatusPage', { providerId: provider.id })}>
              Source officielle <ExternalLink />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
