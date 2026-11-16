import { useState } from 'react'
import { Check, ChevronRight, Infinity as InfinityIcon, Rocket, Server, ShieldAlert, X } from 'lucide-react'
import { CATEGORY_LABELS, SENSITIVE_CATEGORIES } from '@shared/permission-labels'
import type { Agent, ApprovalRequest as A } from '@shared/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { relative } from '@/lib/format'
import { useAction } from '@/lib/queries'
import { useRemoteState } from './RemoteMission'
import { Tooltip } from '@/components/ui/overlay'
import { navigate } from '@/stores/router'
import { CompanionAvatar } from './CompanionAvatar'

const KIND_LABEL: Record<string, string> = {
  edit: 'Modification de fichiers',
  command: 'Commande',
  web: 'Accès réseau',
  mcp: 'Action externe',
  read: 'Lecture',
  search: 'Recherche',
}

function shorten(path: string, cwd?: string) {
  return cwd && path.startsWith(cwd) ? path.slice(cwd.length).replace(/^\//, '') || '.' : path
}

export function DiffView({ diff, className }: { diff: string; className?: string }) {
  return (
    <pre className={cn('selectable max-h-72 overflow-auto rounded-[9px] bg-black/30 p-2.5 font-mono text-[11.5px] leading-[1.55] ring-1 ring-line', className)}>
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre',
            line.startsWith('+') && !line.startsWith('+++') ? 'text-success' : line.startsWith('-') && !line.startsWith('---') ? 'text-danger' : line.startsWith('@@') ? 'text-accent-2' : 'text-fg-3',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

export function ApprovalRequestCard({ approval, agent, expanded = false }: { approval: A; agent?: Agent; expanded?: boolean }) {
  const remote = useRemoteState(approval.machineId)
  const resolve = useAction('approvals.resolve', { success: (a) => (a.machineId ? `Réponse envoyée à ${remote.machine?.name ?? 'la machine'} : elle s’applique dès qu’elle la confirme` : a.status === 'approved' ? 'Demande approuvée' : 'Demande refusée') })
  const blocked = resolve.isPending || (Boolean(approval.machineId) && !remote.online)
  const [open, setOpen] = useState(expanded)
  const p = approval.payload
  const grant = p?.grant
  const canMission = Boolean(grant && approval.missionId && (grant.max === 'mission' || grant.max === 'always'))
  const canAlways = grant?.max === 'always'
  const sensitive = Boolean(p?.category && SENSITIVE_CATEGORIES.includes(p.category))
  const hasDetail = Boolean(p && (p.command || p.paths?.length || p.diff))
  return (
    <div className="rounded-[11px] bg-warning/[0.05] p-3 ring-1 ring-warning/15">
      <div className="flex items-start gap-2.5">
        {agent ? <CompanionAvatar appearance={agent.appearance} size={28} seed={agent.id} status="awaiting_approval" animated /> : <ShieldAlert className="size-5 text-warning" />}
        <div className="min-w-0 flex-1">
          {p && (
            <div className={cn('mb-0.5 text-2xs font-medium tracking-wide uppercase', sensitive ? 'text-danger' : 'text-warning')}>
              {p.category ? (CATEGORY_LABELS[p.category] ?? KIND_LABEL[p.kind] ?? p.tool) : (KIND_LABEL[p.kind] ?? p.tool)}
            </div>
          )}
          <button className="text-left text-[13px] leading-snug text-fg hover:underline" onClick={() => approval.missionId && navigate(`/missions/${approval.missionId}`)}>
            {approval.summary}
          </button>
          {approval.detail && <div className="mt-0.5 text-xs text-fg-3">{approval.detail}</div>}
          {approval.machineId && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-3">
              <Server className="size-3" /> L’opération attend sur {remote.machine?.name ?? 'une machine distante'}
              {!remote.online && <span className="text-warning">· hors ligne : reconnectez-la pour répondre</span>}
            </div>
          )}

          {hasDetail && (
            <div className="mt-2">
              <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2" aria-expanded={open}>
                <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} /> Détails exacts
              </button>
              {open && p && (
                <div className="mt-2 space-y-2">
                  {p.command && (
                    <div>
                      <div className="mb-1 text-2xs text-fg-3">Commande{p.cwd ? ` · dans ${p.cwd}` : ''}</div>
                      <pre className="selectable overflow-x-auto rounded-[9px] bg-black/30 px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg ring-1 ring-line">{p.command}</pre>
                    </div>
                  )}
                  {!!p.paths?.length && !p.command && (
                    <div>
                      <div className="mb-1 text-2xs text-fg-3">Fichiers concernés</div>
                      <ul className="space-y-0.5 font-mono text-[11.5px] text-fg-2">
                        {p.paths.map((f) => (
                          <li key={f} className="truncate">{shorten(f, p.cwd)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {p.diff && <DiffView diff={p.diff} />}
                </div>
              )}
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="success" disabled={blocked} onClick={() => resolve.mutate({ id: approval.id, approve: true, scope: 'once' })}>
              <Check /> {approval.kind === 'tool_use' ? 'Autoriser une fois' : 'Autoriser'}
            </Button>
            {canMission && (
              <Tooltip content={`${grant!.label} — jusqu’à la fin de cette mission`}>
                <Button size="xs" variant="secondary" disabled={blocked} onClick={() => resolve.mutate({ id: approval.id, approve: true, scope: 'mission' })}>
                  <Rocket /> Pendant cette mission
                </Button>
              </Tooltip>
            )}
            {canAlways && (
              <Tooltip content={`${grant!.label} — toujours, pour ce compagnon et ce dossier. Révocable dans les permissions du compagnon.`}>
                <Button size="xs" variant="secondary" disabled={blocked} onClick={() => resolve.mutate({ id: approval.id, approve: true, scope: 'always' })}>
                  <InfinityIcon /> Toujours, dans ce dossier
                </Button>
              </Tooltip>
            )}
            <Button size="xs" variant="ghost" disabled={blocked} onClick={() => resolve.mutate({ id: approval.id, approve: false })}>
              <X /> Refuser
            </Button>
            <span className="ml-auto text-2xs text-fg-3 tabular">{relative(approval.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
