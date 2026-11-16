import { Check, Lock, Rocket, ShieldCheck, Undo2, X, Zap } from 'lucide-react'
import { AUTONOMY_EXPLAINED, CATEGORY_LABELS } from '@shared/permission-labels'
import type { Agent, AutonomyLevel } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { relative } from '@/lib/format'
import { useAction, useAgents, useAutoLog, useGrants } from '@/lib/queries'
import { useConfirm } from '@/orbit/Confirm'
import { navigate } from '@/stores/router'

const MODE_ICON = { manual: Lock, supervised: ShieldCheck, automated: Zap, autonomous: Rocket } as const

/** The autonomy modes, with the current one highlighted. */
export function AutonomyModes({ current }: { current: AutonomyLevel }) {
  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      {(Object.keys(AUTONOMY_EXPLAINED) as AutonomyLevel[]).map((k) => {
        const m = AUTONOMY_EXPLAINED[k]
        const Icon = MODE_ICON[k]
        const on = k === current
        return (
          <div key={k} className={cn('rounded-[11px] p-3', on ? 'bg-accent/[0.08] ring-1 ring-accent/40' : 'bg-white/[0.02] ring-1 ring-line')}>
            <div className="flex items-center gap-1.5 text-[13px] text-fg">
              <Icon className={cn('size-3.5', on ? 'text-accent' : 'text-fg-3')} /> {m.label}
              {on && <Badge tone="accent" className="ml-auto">Actuel</Badge>}
            </div>
            <p className="mt-1 text-[11.5px] leading-snug text-fg-3">{m.short}</p>
            <ul className="mt-2 space-y-1">
              {m.points.map((p) => (
                <li key={p} className="flex gap-1.5 text-[11.5px] leading-snug text-fg-2">
                  <span className="mt-[5px] size-1 shrink-0 rounded-full bg-fg-4" /> {p}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/** What this companion does without asking, given its mode and permissions (mirrors policy.ts). */
export function AutoAllowedList({ agent }: { agent: Agent }) {
  const p = agent.permissions
  const manual = agent.autonomy === 'manual'
  const full = agent.autonomy === 'autonomous'
  const auto = agent.autonomy === 'automated' || full
  const codex = agent.providerId === 'codex'
  const items: { label: string; on: boolean; note?: string }[] = [
    { label: 'Lire des fichiers dans le dossier autorisé', on: p.readFiles },
    { label: 'Rechercher dans le code (Grep, Glob, rg, find)', on: p.readFiles },
    { label: 'Modifier des fichiers du dossier', on: p.writeFiles && !manual, note: 'hors fichiers sensibles, hooks Git et configuration d’outils' },
    { label: 'Inspecter : ls, cat, git status, git diff, git log…', on: p.runCommands && !manual },
    { label: 'Tests et vérifications : npm test, tsc --noEmit, eslint, cargo test…', on: p.runCommands && !manual, note: codex && !auto ? 'premier accord demandé (commandes Codex non confinées)' : undefined },
    { label: 'Compilation et Git local : npm run build, git add, git commit…', on: p.runCommands && p.writeFiles && !manual, note: codex && !auto ? 'premier accord demandé' : undefined },
    { label: 'Pages et recherches web', on: p.network && auto },
    ...(full
      ? [
          { label: 'Installations, Git distant ou destructif, suppressions, déploiements, publication', on: p.runCommands, note: 'autonomie complète : exécuté puis journalisé' },
          { label: 'Fichiers sensibles, hooks, chemins hors du dossier', on: p.readFiles || p.writeFiles || p.runCommands, note: 'les données d’Orbit restent refusées' },
          { label: 'Outils externes (MCP)', on: p.externalActions },
        ]
      : []),
    { label: 'Commandes que vous avez autorisées « toujours »', on: true },
  ]
  return (
    <ul className="divide-y divide-line rounded-[12px] bg-white/[0.02] ring-1 ring-line">
      {items.map((i) => (
        <li key={i.label} className="flex items-start gap-2.5 px-4 py-2 text-[12.5px]">
          {i.on ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" /> : <X className="mt-0.5 size-3.5 shrink-0 text-fg-4" />}
          <span className={i.on ? 'text-fg-2' : 'text-fg-4'}>
            {i.label}
            {i.note && i.on && <span className="block text-2xs text-fg-4">{i.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Persistent authorisations, revocable. Without `agentId`: every companion (settings). */
export function GrantList({ agentId }: { agentId?: string }) {
  const grants = useGrants(agentId)
  const agents = useAgents()
  const revoke = useAction('permissions.revoke', { success: 'Autorisation révoquée' })
  const confirm = useConfirm()
  if (grants.data?.length === 0)
    return <div className="rounded-[12px] bg-white/[0.02] px-4 py-5 text-center text-[12.5px] text-fg-3 ring-1 ring-line">Aucune autorisation mémorisée. Elles apparaissent ici quand vous choisissez « Pour cette mission » ou « Toujours » sur une demande.</div>
  return (
    <div className="divide-y divide-line rounded-[12px] bg-white/[0.02] ring-1 ring-line">
      {grants.data?.map((g) => {
        const agent = agents.data?.find((a) => a.id === g.agentId)
        return (
          <div key={g.id} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <div className="truncate font-mono text-[12px] text-fg" title={g.operationKey}>{g.label}</div>
              <div className="mt-0.5 truncate text-2xs text-fg-4" title={g.workspace}>
                {!agentId && agent ? `${agent.name} · ` : ''}
                {g.scope === 'always' ? 'Toujours' : 'Cette mission'} · {g.workspace.split('/').filter(Boolean).slice(-2).join('/')}
                {g.category ? ` · ${CATEGORY_LABELS[g.category] ?? g.category}` : ''} · utilisée {g.uses} fois{g.lastUsedAt ? `, ${relative(g.lastUsedAt)}` : ''}
              </div>
            </div>
            <Button size="xs" variant="ghost" disabled={revoke.isPending} onClick={async () => {
              if (await confirm({ title: 'Révoquer cette autorisation ?', body: `${g.label} vous sera de nouveau demandé à chaque fois.`, confirm: 'Révoquer' })) revoke.mutate({ id: g.id })
            }}>
              <Undo2 /> Révoquer
            </Button>
          </div>
        )
      })}
    </div>
  )
}

const VIA_LABEL = { policy: 'Action courante', grant: 'Votre autorisation', engine: 'Mode auto de Claude' } as const

/** Actions that ran without a confirmation. */
export function AutoActionLog({ agentId, limit = 40 }: { agentId?: string; limit?: number }) {
  const log = useAutoLog(agentId, limit)
  const agents = useAgents()
  if (log.data?.length === 0) return <div className="rounded-[12px] bg-white/[0.02] px-4 py-5 text-center text-[12.5px] text-fg-3 ring-1 ring-line">Aucune action exécutée sans confirmation pour l’instant.</div>
  return (
    <div className="divide-y divide-line rounded-[12px] bg-white/[0.02] ring-1 ring-line">
      {log.data?.map((e) => (
        <div key={e.id} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2">
          <button className="min-w-0 text-left" onClick={() => e.missionId && navigate(`/missions/${e.missionId}`)}>
            <div className="truncate text-[12.5px] text-fg-2" title={e.reason ?? undefined}>{e.title}</div>
            <div className="truncate text-2xs text-fg-4">
              {!agentId && e.agentId ? `${agents.data?.find((a) => a.id === e.agentId)?.name ?? 'Compagnon'} · ` : ''}
              {e.category ? (CATEGORY_LABELS[e.category] ?? e.category) : ''} · {relative(e.createdAt)}
            </div>
          </button>
          <Badge tone={e.via === 'grant' ? 'accent' : e.via === 'engine' ? 'info' : 'neutral'}>{VIA_LABEL[e.via]}</Badge>
        </div>
      ))}
    </div>
  )
}
