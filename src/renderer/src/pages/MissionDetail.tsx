import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  Ban,
  Check,
  ChevronRight,
  CircleSlash,
  Copy,
  FilePen,
  FilePlus2,
  FileText,
  FileX2,
  FolderOpen,
  Globe,
  ListTodo,
  Loader,
  Play,
  Plug,
  RotateCcw,
  Search,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react'
import type { Agent, ExecutionEvent, FileChange, FileInventory, LiveActivity, Mission, MissionExecution, ToolCall, ToolKind } from '@shared/types'
import { Page, PageLoading } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { clock, dateTime, duration, integer, money } from '@/lib/format'
import { useAction, useAgent, useApprovals, useConstellationRun, useMission, useProviders } from '@/lib/queries'
import { RUN_STATUS_INFO } from '@shared/constellation-states'
import { ApprovalRequestCard, DiffView } from '@/orbit/ApprovalRequest'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { useConfirm } from '@/orbit/Confirm'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { ArtifactsPanel, RemoteBanner, useRemoteState } from '@/orbit/RemoteMission'
import { Markdown } from '@/orbit/Markdown'
import { MissionStatusLabel, PRIORITY_LABELS, PriorityGlyph } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

const TOOL_ICON: Record<ToolKind, typeof FileText> = {
  read: FileText,
  search: Search,
  edit: FilePen,
  command: Terminal,
  web: Globe,
  mcp: Plug,
  plan: ListTodo,
  other: Wrench,
}

const rel = (ws: string | null, p: string) => (ws && p.startsWith(ws) ? p.slice(ws.length).replace(/^\//, '') || '.' : p)

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

// Live card

function LiveCard({ agent, activity, draft, startedAt, engineName }: { agent: Agent; activity: LiveActivity | null | undefined; draft: string; startedAt: string | null; engineName: string }) {
  const now = useNow(true)
  const waiting = activity?.phase === 'approval'
  return (
    <section className={cn('overflow-hidden rounded-xl ring-1', waiting ? 'bg-warning/[0.04] ring-warning/20' : 'bg-surface ring-line')} aria-live="polite">
      <div className="flex items-center gap-4 p-4">
        <CompanionAvatar appearance={agent.appearance} variant="detailed" size={64} seed={agent.id} status={waiting ? 'awaiting_approval' : 'working'} animated />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-fg-3">
            <span className={cn('inline-flex size-1.5 rounded-full', waiting ? 'bg-warning' : 'animate-pulse bg-accent motion-reduce:animate-none')} />
            {waiting ? `${agent.name} attend votre accord` : `${agent.name} travaille · ${engineName}`}
            {startedAt && <span className="tabular">· {duration(startedAt, null, now)}</span>}
          </div>
          <div className="mt-1 truncate text-[15px] font-medium text-fg">{activity?.label ?? 'Prépare la session…'}</div>
          {activity && activity.phase !== 'approval' && (
            <div className="mt-0.5 text-2xs text-fg-4 tabular">depuis {duration(activity.since, null, now)}</div>
          )}
        </div>
      </div>
      {draft && (
        <div className="max-h-48 overflow-hidden border-t border-line px-4 py-3 text-[13px] [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
          <Markdown text={draft} />
        </div>
      )}
    </section>
  )
}

// Timeline

function ToolStatusIcon({ status }: { status: ToolCall['status'] }) {
  switch (status) {
    case 'running':
      return <Loader className="size-3.5 animate-[spin_1.6s_linear_infinite] text-accent motion-reduce:animate-none" aria-label="En cours" />
    case 'awaiting_approval':
      return <ShieldAlert className="size-3.5 text-warning" aria-label="En attente de votre accord" />
    case 'completed':
      return <Check className="size-3.5 text-success" aria-label="Terminé" />
    case 'failed':
      return <X className="size-3.5 text-danger" aria-label="Échec" />
    case 'denied':
      return <Ban className="size-3.5 text-danger" aria-label="Refusé" />
    default:
      return <CircleSlash className="size-3.5 text-fg-3" aria-label="Annulé" />
  }
}

function ToolRow({ tool, workspace }: { tool: ToolCall; workspace: string | null }) {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[tool.kind]
  const command = tool.kind === 'command' && tool.input && typeof tool.input === 'object' && 'command' in tool.input ? String((tool.input as { command: unknown }).command) : null
  const expandable = Boolean(tool.output || command || tool.files.length)
  return (
    <div className={cn('rounded-[10px] ring-1', tool.status === 'awaiting_approval' ? 'bg-warning/[0.04] ring-warning/20' : 'bg-white/[0.02] ring-line')}>
      <button onClick={() => expandable && setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left" aria-expanded={open}>
        <Icon className="size-3.5 shrink-0 text-fg-3" />
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', tool.kind === 'command' ? 'font-mono text-[11.5px] text-fg' : 'text-fg-2')}>{tool.title.replaceAll(`${workspace}/`, '')}</span>
        {tool.exitCode != null && tool.exitCode !== 0 && <span className="font-mono text-2xs text-danger">code {tool.exitCode}</span>}
        {tool.finishedAt && <span className="text-2xs text-fg-4 tabular">{duration(tool.startedAt, tool.finishedAt)}</span>}
        <ToolStatusIcon status={tool.status} />
        {expandable && <ChevronRight className={cn('size-3 text-fg-4 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          {command && <pre className="selectable overflow-x-auto font-mono text-[11.5px] whitespace-pre-wrap text-fg">{command}</pre>}
          {!!tool.files.length && (
            <ul className="font-mono text-[11.5px] text-fg-3">
              {tool.files.map((f) => (
                <li key={f} className="truncate">{rel(workspace, f)}</li>
              ))}
            </ul>
          )}
          {tool.output && <pre className="selectable max-h-64 overflow-auto rounded-[8px] bg-black/30 p-2 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap text-fg-3">{tool.output}</pre>}
        </div>
      )}
    </div>
  )
}

function AgentMessage({ text, last }: { text: string; last: boolean }) {
  const long = text.length > 600
  const [open, setOpen] = useState(last || !long)
  return (
    <div className="text-[13.5px]">
      <div className={cn(!open && 'line-clamp-4')}>
        <Markdown text={text} />
      </div>
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-1 text-xs text-fg-3 hover:text-fg-2">
          {open ? 'Réduire' : 'Lire la suite'}
        </button>
      )}
    </div>
  )
}

function SystemLine({ event }: { event: ExecutionEvent }) {
  const tone = event.type === 'failed' ? 'text-danger' : event.type === 'completed' ? 'text-success' : event.type === 'warning' ? 'text-warning' : 'text-fg-3'
  const Icon = event.type === 'failed' ? TriangleAlert : event.type === 'completed' ? Check : event.type === 'cancelled' ? CircleSlash : event.type === 'approval' ? ShieldAlert : null
  return (
    <div className={cn('flex items-baseline gap-2 text-xs', tone)}>
      {Icon && <Icon className="size-3 shrink-0 translate-y-[1px]" />}
      <span className="min-w-0 flex-1 selectable">{event.message}</span>
      <span className="shrink-0 text-2xs text-fg-4 tabular">{clock(event.createdAt)}</span>
    </div>
  )
}

function Timeline({ mission, executions, events, toolCalls, agent }: { mission: Mission; executions: MissionExecution[]; events: ExecutionEvent[]; toolCalls: ToolCall[]; agent: Agent }) {
  const tools = useMemo(() => new Map(toolCalls.map((t) => [t.id, t])), [toolCalls])
  const lastMessageId = [...events].reverse().find((e) => e.type === 'message')?.id
  return (
    <div className="space-y-5">
      {executions.map((ex, i) => {
        const evs = events.filter((e) => e.executionId === ex.id)
        return (
          <section key={ex.id} className="space-y-2.5">
            <div className="flex items-center gap-2 text-2xs font-medium tracking-wide text-fg-4 uppercase">
              {i === 0 ? 'Mission confiée' : `Suite ${i}`} · {dateTime(ex.startedAt)}
              {ex.costUsd != null && <span className="normal-case">· {money(ex.costUsd, true)}</span>}
              {ex.costKind === 'subscription' && <span className="normal-case">· inclus dans l’abonnement</span>}
            </div>
            {i > 0 && ex.prompt && (
              <div className="ml-auto w-fit max-w-[85%] rounded-[13px] rounded-br-[5px] bg-accent/[0.12] px-3.5 py-2 text-[13.5px] whitespace-pre-wrap text-fg selectable">{ex.prompt}</div>
            )}
            {evs.map((e) => {
              if (e.type === 'tool') {
                const t = tools.get(String(e.data?.toolCallId))
                return t ? <ToolRow key={e.id} tool={t} workspace={mission.workspace} /> : null
              }
              if (e.type === 'message') {
                return (
                  <div key={e.id} className="flex gap-2.5">
                    <CompanionAvatar appearance={agent.appearance} size={22} seed={agent.id} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <AgentMessage text={e.message} last={e.id === lastMessageId} />
                    </div>
                  </div>
                )
              }
              if (e.type === 'file') {
                const Icon = e.data?.kind === 'add' ? FilePlus2 : e.data?.kind === 'delete' ? FileX2 : FilePen
                return (
                  <div key={e.id} className="flex items-center gap-2 pl-1 text-xs text-fg-2">
                    <Icon className="size-3.5 text-accent-2" /> <span className="font-mono text-[11.5px]">{rel(mission.workspace, e.message)}</span>
                  </div>
                )
              }
              if (e.type === 'output' || e.type === 'user' || e.type === 'thinking' || e.type === 'usage') return null
              if (e.type === 'approval' && !(e.data && 'approved' in e.data)) return null
              return <SystemLine key={e.id} event={e} />
            })}
          </section>
        )
      })}
    </div>
  )
}

// Follow-up

function FollowUp({ mission, agent }: { mission: Mission; agent: Agent }) {
  const [text, setText] = useState('')
  const send = useAction('missions.followUp', { success: 'Mission relancée dans la même session', onSuccess: () => setText('') })
  const submit = () => text.trim() && !send.isPending && send.mutate({ id: mission.id, prompt: text.trim() })
  return (
    <div className="rounded-[14px] bg-surface p-2 ring-1 ring-line focus-within:ring-accent/40">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) {
            e.preventDefault()
            submit()
          }
        }}
        rows={2}
        placeholder={mission.sessionId ? `Poursuivre avec ${agent.name} (même session)…` : `Donner une nouvelle consigne à ${agent.name}…`}
        className="block max-h-40 min-h-12 w-full resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-fg outline-none placeholder:text-fg-4"
      />
      <div className="flex items-center justify-between px-1">
        <span className="text-2xs text-fg-4">{mission.sessionId ? `Session ${mission.sessionId.slice(0, 8)} conservée — elle survit au redémarrage d’Orbit.` : 'Une nouvelle session sera ouverte.'}</span>
        <Button size="icon" variant="primary" disabled={!text.trim() || send.isPending} onClick={submit} aria-label="Envoyer" className="rounded-[9px]">
          <ArrowUp />
        </Button>
      </div>
    </div>
  )
}

// Files

function FilesPanel({ changes, workspace, inventories }: { changes: FileChange[]; workspace: string | null; inventories: FileInventory[] }) {
  const [openPath, setOpenPath] = useState<string | null>(null)
  const byPath = useMemo(() => {
    const m = new Map<string, FileChange[]>()
    for (const c of changes) m.set(c.path, [...(m.get(c.path) ?? []), c])
    return [...m]
  }, [changes])
  const last = inventories.at(-1)
  if (!byPath.length && !last) return null
  const incomplete = inventories.filter((i) => !i.complete)
  return (
    <section className="rounded-xl bg-surface ring-1 ring-line">
      <div className="flex h-10 items-center justify-between px-4 text-xs font-medium text-fg-3">
        Fichiers modifiés <span className="tabular text-fg-4">{byPath.length}</span>
      </div>
      {last && (
        <div className={cn('mx-3 mb-2 rounded-[8px] px-2.5 py-1.5 text-2xs leading-relaxed', incomplete.length ? 'bg-warning/[0.06] text-warning/90' : 'bg-white/[0.025] text-fg-3')}>
          {last.method === 'git' ? 'Instantanés Git avant/après (index et stash intacts)' : last.method === 'scan' ? 'Empreintes du dossier avant/après' : 'Liste fournie par le moteur'}
          {incomplete.length ? ' · inventaire non exhaustif : ' : ' · inventaire complet pour ce dossier.'}
          {incomplete.length > 0 && <span className="text-fg-3">{[...new Set(incomplete.map((i) => i.note).filter(Boolean))].join(' ')}</span>}
        </div>
      )}
      {!byPath.length && <div className="px-4 pb-3 text-[12px] text-fg-3">Aucun fichier modifié pendant cette mission.</div>}
      <ul className="px-2 pb-2">
        {byPath.map(([path, list]) => {
          const last = list.at(-1)!
          const diff = list.map((c) => c.diff).filter(Boolean).join('\n')
          const Icon = last.kind === 'add' ? FilePlus2 : last.kind === 'delete' ? FileX2 : FilePen
          return (
            <li key={path}>
              <button onClick={() => setOpenPath(openPath === path ? null : path)} className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-white/[0.04]" aria-expanded={openPath === path}>
                <Icon className="size-3.5 shrink-0 text-accent-2" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2" title={path}>{rel(workspace, path)}</span>
                {last.source !== 'engine' && <span className="text-2xs text-fg-4" title="Détecté par instantané (commande shell, script…)">shell</span>}
                <span className="text-2xs text-fg-4 tabular">{clock(last.createdAt)}</span>
                {list.length > 1 && <span className="text-2xs text-fg-4 tabular">×{list.length}</span>}
              </button>
              {openPath === path && <div className="px-2 pb-2">{diff ? <DiffView diff={diff} /> : <div className="text-2xs text-fg-4">Diff indisponible (fichier binaire, volumineux ou supprimé).</div>}</div>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Page

export function MissionDetailPage({ missionId, focusApproval }: { missionId: string; focusApproval?: string | null }) {
  const q = useMission(missionId)
  const live = useUi((s) => s.liveMissionEvents[missionId])
  const activity = useUi((s) => s.missionActivity[missionId])
  const draft = useUi((s) => s.missionDrafts[missionId] ?? '')
  const mission = q.data?.mission
  const { data: agent } = useAgent(mission?.agentId)
  const providers = useProviders()
  const approvals = useApprovals()
  const confirm = useConfirm()
  const start = useAction('missions.start')
  const cancel = useAction('missions.cancel', { success: 'Arrêt demandé' })
  const retry = useAction('missions.retry')
  const duplicate = useAction('missions.duplicate', { onSuccess: (m) => navigate(`/missions/${m.id}`) })
  const remove = useAction('missions.delete', { onSuccess: () => navigate('/missions') })
  const bottomRef = useRef<HTMLDivElement>(null)
  const remote = useRemoteState(q.data?.mission.remoteMachineId ?? null)
  const remoteOffline = Boolean(q.data?.mission.remoteMachineId) && !remote.online

  const events = useMemo(() => {
    const map = new Map<string, ExecutionEvent>()
    for (const e of q.data?.events ?? []) map.set(e.id, e)
    for (const e of live ?? []) map.set(e.id, e)
    return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }, [q.data?.events, live])

  const running = mission?.status === 'running' || mission?.status === 'waiting' || (mission?.status === 'approval_required' && Boolean(mission?.engine))
  useEffect(() => {
    if (running) bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [events.length, running])

  if (q.isLoading) return <PageLoading />
  if (!mission || !q.data) return <Page><OrbitEmptyState title="Mission introuvable" body="Elle a peut-être été supprimée." action={<Button variant="secondary" onClick={() => navigate('/missions')}>Voir toutes les missions</Button>} /></Page>
  const { executions, toolCalls, fileChanges, inventories } = q.data
  const pending = approvals.data?.filter((a) => a.missionId === mission.id) ?? []
  const engine = mission.engine ? providers.data?.find((p) => p.id === mission.engine) : null
  const streamed = events.filter((e) => e.type === 'output').map((e) => e.message).join('')
  const tokens = executions.reduce((acc, e) => ({ input: acc.input + (e.inputTokens ?? 0), output: acc.output + (e.outputTokens ?? 0) }), { input: 0, output: 0 })
  const toolStats = { done: toolCalls.filter((t) => t.status === 'completed').length, denied: toolCalls.filter((t) => t.status === 'denied').length, failed: toolCalls.filter((t) => t.status === 'failed').length }
  const lastExec = executions.at(-1)

  return (
    <Page wide>
      <button onClick={() => navigate('/missions')} className="no-drag mb-2 flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft className="size-3.5" /> Missions
      </button>
      {mission.constellationRunId && <ConstellationLink runId={mission.constellationRunId} coordinator={mission.depth === 0} />}
      <div className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2.5 text-xs text-fg-3">
            <span className="font-mono">{mission.shortId}</span>
            <MissionStatusLabel status={mission.status} />
            <span className="flex items-center gap-1.5"><PriorityGlyph priority={mission.priority} /> {PRIORITY_LABELS[mission.priority]}</span>
            {engine && <Badge tone="accent">{engine.name}</Badge>}
          </div>
          <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-fg">{mission.title}</h1>
        </div>
        <div className="no-drag flex shrink-0 gap-2">
          {running && (
            <Button variant="danger" disabled={remoteOffline} title={remoteOffline ? 'Serveur hors ligne : reconnectez-le pour agir.' : undefined} onClick={async () => {
                if (await confirm({ title: 'Arrêter la mission ?', body: 'Le travail en cours est interrompu. Les fichiers déjà modifiés restent en l’état.', confirm: 'Arrêter', cancel: 'Continuer la mission', danger: true })) cancel.mutate({ id: mission.id })
              }}>
              <Square className="fill-current" /> Arrêter
            </Button>
          )}
          {(mission.status === 'todo' || mission.status === 'scheduled') && (
            <Button variant="primary" disabled={start.isPending} onClick={() => start.mutate({ id: mission.id })}>
              <Play /> Lancer
            </Button>
          )}
          {(mission.status === 'failed' || mission.status === 'cancelled' || mission.status === 'done') && !mission.engine && (
            <Button variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate({ id: mission.id })}>
              <RotateCcw /> Relancer
            </Button>
          )}
          <Button variant="ghost" onClick={() => duplicate.mutate({ id: mission.id })}>
            <Copy /> Dupliquer
          </Button>
          <Button
            variant="ghost"
            aria-label="Supprimer"
            disabled={Boolean(mission.remoteMachineId) && (running || mission.status === 'approval_required')}
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
          <RemoteBanner mission={mission} />
          {pending.map((a) => (
            <div key={a.id} ref={a.id === focusApproval ? (el) => el?.scrollIntoView({ block: 'center', behavior: 'smooth' }) : undefined} className={cn('rounded-[12px]', a.id === focusApproval && 'ring-2 ring-warning/50')}>
              <ApprovalRequestCard approval={a} agent={agent} expanded />
            </div>
          ))}

          {mission.description && (
            <section className="rounded-xl bg-surface p-5 ring-1 ring-line">
              <div className="mb-2 text-xs font-medium text-fg-3">Consigne</div>
              <p className="selectable text-[14px] leading-relaxed whitespace-pre-wrap text-fg-2">{mission.description}</p>
            </section>
          )}

          {mission.engine && agent ? (
            <>
              {mission.result && !running && (
                <section className="rounded-xl bg-surface p-5 ring-1 ring-line">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-medium text-fg-3">Résultat</span>
                    <Button size="xs" variant="ghost" onClick={() => void navigator.clipboard.writeText(mission.result ?? '')}>
                      <Copy /> Copier
                    </Button>
                  </div>
                  <Markdown text={mission.result} />
                </section>
              )}
              {mission.error && !running && <div className="rounded-[10px] bg-danger/[0.07] px-3 py-2 text-[13px] text-danger ring-1 ring-danger/15">{mission.error}</div>}
              {executions.length > 0 && (
                <section className="rounded-xl bg-surface p-5 ring-1 ring-line">
                  <div className="mb-4 flex items-center justify-between text-xs font-medium text-fg-3">
                    <span>Déroulé</span>
                    <span className="flex gap-3 font-normal text-fg-4 tabular">
                      <span>{toolStats.done} actions</span>
                      {toolStats.denied > 0 && <span className="text-danger">{toolStats.denied} refusées</span>}
                      {toolStats.failed > 0 && <span>{toolStats.failed} en échec</span>}
                    </span>
                  </div>
                  <Timeline mission={mission} executions={executions} events={events} toolCalls={toolCalls} agent={agent} />
                </section>
              )}
              {running && <LiveCard agent={agent} activity={activity} draft={draft} startedAt={lastExec?.startedAt ?? mission.startedAt} engineName={engine?.name ?? ''} />}
              {!running && mission.status !== 'approval_required' && mission.status !== 'todo' && <FollowUp mission={mission} agent={agent} />}
            </>
          ) : (
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
              {mission.result || (running && (draft || streamed)) ? <Markdown text={mission.result ?? (draft || streamed)} /> : <div className="text-[13px] text-fg-3">{running ? 'Le compagnon rédige…' : 'Aucun résultat pour l’instant.'}</div>}
            </section>
          )}
          <div ref={bottomRef} />
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
                ...(engine ? [['Moteur', engine.name]] : []),
                ['Créée', dateTime(mission.createdAt)],
                ['Démarrée', mission.startedAt ? dateTime(mission.startedAt) : '—'],
                ['Durée', mission.startedAt ? duration(mission.startedAt, mission.finishedAt) : '—'],
                ...(tokens.input || tokens.output ? [['Jetons', `${integer(tokens.input)} → ${integer(tokens.output)}`]] : []),
                [
                  'Coût',
                  mission.costKind === 'subscription' ? (
                    <Badge key="s">abonnement</Badge>
                  ) : mission.costUsd != null ? (
                    <span key="c">
                      {money(mission.costUsd, true)} {mission.costKind === 'estimated' && <Badge>estimé</Badge>}
                    </span>
                  ) : mission.costKind === 'unknown' ? (
                    'Inconnu'
                  ) : (
                    '—'
                  ),
                ],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between gap-3">
                  <dt className="text-fg-3">{k}</dt>
                  <dd className="text-right text-fg tabular">{v}</dd>
                </div>
              ))}
            </dl>
            {mission.workspace && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="mb-1 flex items-center gap-1.5 text-2xs text-fg-3">
                  <FolderOpen className="size-3" /> Dossier de travail
                </div>
                <div className="font-mono text-[11.5px] break-all text-fg-2 selectable">{mission.workspace}</div>
                {mission.sessionId && <div className="mt-2 font-mono text-2xs text-fg-4 selectable">session {mission.sessionId}</div>}
              </div>
            )}
          </section>

          <ArtifactsPanel mission={mission} />
          <FilesPanel changes={fileChanges} workspace={mission.workspace} inventories={inventories} />

          {!mission.engine && events.length > 0 && (
            <section className="rounded-xl bg-surface ring-1 ring-line">
              <div className="flex h-10 items-center px-4 text-xs font-medium text-fg-3">Journal d’exécution</div>
              <div className="max-h-[440px] space-y-2 overflow-y-auto px-4 pb-4">
                {events.filter((e) => e.type !== 'output').map((e) => <SystemLine key={e.id} event={e} />)}
              </div>
            </section>
          )}
        </aside>
      </div>
    </Page>
  )
}

/**
 * A mission that belongs to a constellation: its own end (one exchange, one sub-mission) is not
 * the end of the collective mission, whose real state is shown here.
 */
function ConstellationLink({ runId, coordinator }: { runId: string; coordinator: boolean }) {
  const q = useConstellationRun(runId)
  const run = q.data?.run
  if (!run) return null
  const info = RUN_STATUS_INFO[run.status]
  return (
    <button onClick={() => navigate(`/constellations/runs/${runId}`)} className="no-drag mb-4 flex w-full items-center gap-2 rounded-[12px] bg-white/[0.03] px-3 py-2 text-left text-[12.5px] ring-1 ring-line hover:bg-white/[0.05]">
      <span className="text-fg-3">{coordinator ? 'Coordinateur de' : 'Sous-mission de'} « {run.constellationName} »</span>
      <Badge tone={info.tone}>Mission collective : {info.label.toLowerCase()}</Badge>
      <span className="min-w-0 flex-1 truncate text-fg-3">{q.data!.pendingPlan ? 'un plan attend votre validation' : `${q.data!.progress.done} / ${q.data!.progress.total} sous-missions terminées`}</span>
      <span className="text-fg-2">Ouvrir →</span>
    </button>
  )
}
