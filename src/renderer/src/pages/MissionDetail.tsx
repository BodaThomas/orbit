import { useEffect, useMemo, useRef } from 'react'
import { ArrowLeft, Copy, Play, RotateCcw, Square, Trash2 } from 'lucide-react'
import type { ExecutionEvent } from '@shared/types'
import { Page } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { clock, dateTime, duration, money } from '@/lib/format'
import { useAction, useAgent, useApprovals, useMission } from '@/lib/queries'
import { ApprovalRequestCard } from '@/orbit/ApprovalRequest'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { useConfirm } from '@/orbit/Confirm'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { Markdown } from '@/orbit/Markdown'
import { MissionStatusLabel, PRIORITY_LABELS, PriorityGlyph } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

const DOT: Record<ExecutionEvent['type'], string> = {
  started: 'bg-accent',
  thinking: 'bg-fg-3',
  output: 'bg-fg-4',
  tool: 'bg-accent-2',
  approval: 'bg-warning',
  usage: 'bg-fg-3',
  completed: 'bg-success',
  failed: 'bg-danger',
  cancelled: 'bg-fg-3',
}

export function MissionDetailPage({ missionId }: { missionId: string }) {
  const q = useMission(missionId)
  const live = useUi((s) => s.liveMissionEvents[missionId])
  const mission = q.data?.mission
  const { data: agent } = useAgent(mission?.agentId)
  const approvals = useApprovals()
  const confirm = useConfirm()
  const start = useAction('missions.start')
  const cancel = useAction('missions.cancel', { success: 'Arrêt demandé' })
  const retry = useAction('missions.retry')
  const duplicate = useAction('missions.duplicate', { onSuccess: (m) => navigate(`/missions/${m.id}`) })
  const remove = useAction('missions.delete', { onSuccess: () => navigate('/missions') })
  const logRef = useRef<HTMLDivElement>(null)

  const events = useMemo(() => {
    const map = new Map<string, ExecutionEvent>()
    for (const e of q.data?.events ?? []) map.set(e.id, e)
    for (const e of live ?? []) map.set(e.id, e)
    return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }, [q.data?.events, live])

  const streamed = events.filter((e) => e.type === 'output').map((e) => e.message).join('')
  const resultText = mission?.result ?? (mission?.status === 'running' ? streamed : '')

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [events.length])

  if (q.isLoading) return null
  if (!mission) return <Page><OrbitEmptyState title="Mission introuvable" /></Page>
  const pending = approvals.data?.filter((a) => a.missionId === mission.id) ?? []
  const running = mission.status === 'running' || mission.status === 'waiting'

  return (
    <Page wide>
      <button onClick={() => navigate('/missions')} className="no-drag mb-2 flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft className="size-3.5" /> Missions
      </button>
      <div className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2.5 text-xs text-fg-3">
            <span className="font-mono">{mission.shortId}</span>
            <MissionStatusLabel status={mission.status} />
            <span className="flex items-center gap-1.5"><PriorityGlyph priority={mission.priority} /> {PRIORITY_LABELS[mission.priority]}</span>
          </div>
          <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-fg">{mission.title}</h1>
        </div>
        <div className="no-drag flex shrink-0 gap-2">
          {running && (
            <Button variant="danger" onClick={() => cancel.mutate({ id: mission.id })}>
              <Square className="fill-current" /> Arrêter
            </Button>
          )}
          {(mission.status === 'todo' || mission.status === 'scheduled') && (
            <Button variant="primary" onClick={() => start.mutate({ id: mission.id })}>
              <Play /> Lancer
            </Button>
          )}
          {(mission.status === 'failed' || mission.status === 'cancelled' || mission.status === 'done') && (
            <Button variant="secondary" onClick={() => retry.mutate({ id: mission.id })}>
              <RotateCcw /> Relancer
            </Button>
          )}
          <Button variant="ghost" onClick={() => duplicate.mutate({ id: mission.id })}>
            <Copy /> Dupliquer
          </Button>
          <Button
            variant="ghost"
            aria-label="Supprimer"
            onClick={async () => {
              if (await confirm({ title: 'Supprimer cette mission ?', body: 'Son historique d’exécution sera supprimé.', confirm: 'Supprimer', danger: true })) remove.mutate({ id: mission.id })
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-5">
        <div className="min-w-0 space-y-4">
          {pending.map((a) => <ApprovalRequestCard key={a.id} approval={a} agent={agent} />)}
          {mission.description && (
            <section className="rounded-xl bg-surface p-5 ring-1 ring-line">
              <div className="mb-2 text-xs font-medium text-fg-3">Description</div>
              <p className="selectable text-[14px] leading-relaxed whitespace-pre-wrap text-fg-2">{mission.description}</p>
            </section>
          )}
          <section className="rounded-xl bg-surface p-5 ring-1 ring-line">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium text-fg-3">Résultat</span>
              {mission.result && (
                <Button size="xs" variant="ghost" onClick={() => void navigator.clipboard.writeText(mission.result ?? '')}>
                  <Copy /> Copier
                </Button>
              )}
            </div>
            {mission.error && <div className="mb-3 rounded-[10px] bg-danger/[0.07] px-3 py-2 text-[13px] text-danger ring-1 ring-danger/15">{mission.error}</div>}
            {resultText ? <Markdown text={resultText} /> : <div className="text-[13px] text-fg-3">{running ? 'Le compagnon travaille…' : 'Aucun résultat pour l’instant.'}</div>}
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-xl bg-surface p-4 ring-1 ring-line">
            {agent && (
              <button onClick={() => navigate(`/companions/${agent.id}`)} className="mb-3 flex w-full items-center gap-3 text-left">
                <CompanionAvatar appearance={agent.appearance} variant="detailed" size={52} seed={agent.id} status={agent.status} animated={running} />
                <span>
                  <span className="block text-[14px] font-medium text-fg">{agent.name}</span>
                  <span className="block text-xs text-fg-3">{agent.role}</span>
                </span>
              </button>
            )}
            <dl className="space-y-2 text-[13px]">
              {[
                ['Créée', dateTime(mission.createdAt)],
                ['Démarrée', mission.startedAt ? dateTime(mission.startedAt) : '—'],
                ['Durée', mission.startedAt ? duration(mission.startedAt, mission.finishedAt) : '—'],
                ['Coût', mission.costUsd != null ? <span key="c">{money(mission.costUsd, true)} {mission.costKind === 'estimated' && <Badge>estimé</Badge>}</span> : mission.costKind === 'unknown' ? 'Inconnu' : '—'],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between gap-3">
                  <dt className="text-fg-3">{k}</dt>
                  <dd className="text-right text-fg tabular">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="rounded-xl bg-surface ring-1 ring-line">
            <div className="flex h-10 items-center px-4 text-xs font-medium text-fg-3">Journal d’exécution</div>
            <div ref={logRef} className="max-h-[440px] overflow-y-auto px-4 pb-4">
              {events.length === 0 && <div className="text-[13px] text-fg-3">Aucun événement.</div>}
              <ol className="relative space-y-3 border-l border-line pl-4">
                {events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className={cn('absolute top-[6px] -left-[20.5px] size-[8px] rounded-full ring-4 ring-surface', DOT[e.type])} />
                    <div className="flex items-baseline justify-between gap-2 text-2xs text-fg-3">
                      <span className="uppercase tracking-wide">{e.type}</span>
                      <span className="tabular">{clock(e.createdAt)}</span>
                    </div>
                    <div className={cn('selectable mt-0.5 text-[12.5px] leading-snug', e.type === 'output' ? 'line-clamp-3 font-mono text-[11.5px] text-fg-3' : 'text-fg-2')}>{e.message}</div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        </aside>
      </div>
    </Page>
  )
}
