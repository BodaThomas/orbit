import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Crown, FileDiff, GitMerge, Play, RotateCcw, Server, Square, Trash2, Waypoints } from 'lucide-react'
import { effectivePermissions } from '@shared/permissions-matrix'
import { ENGINE_INFO } from '@shared/engines'
import type { Agent, ConstellationRunDetail, ConstellationTask } from '@shared/types'
import { Page, Panel } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Segmented, Skeleton } from '@/components/ui/field'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { clock, compactNumber, duration, money, relative } from '@/lib/format'
import { useAction, useAgents, useConstellationRun, useMission } from '@/lib/queries'
import { useConfirm } from '@/orbit/Confirm'
import { ConstellationMap, type LinkState, type MapNode } from '@/orbit/ConstellationMap'
import { DiffView } from '@/orbit/ApprovalRequest'
import { Markdown } from '@/orbit/Markdown'
import { MissionStatusIcon, MissionStatusLabel } from '@/orbit/MissionStatus'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { navigate } from '@/stores/router'
import { Tooltip } from '@/components/ui/overlay'
import { useRemoteState } from '@/orbit/RemoteMission'
import { useUi } from '@/stores/ui'
import { RUN_STATUS } from './Constellations'

function taskState(t: ConstellationTask): LinkState {
  if (t.status === 'running' || t.status === 'waiting') return 'working'
  if (t.status === 'approval_required') return 'awaiting'
  if (t.status === 'failed') return 'error'
  if (t.status === 'done') return 'done'
  if (t.status === 'cancelled') return 'idle'
  return 'pending'
}

function memberState(tasks: ConstellationTask[]): LinkState {
  const s = tasks.map(taskState)
  for (const k of ['awaiting', 'working', 'error', 'pending'] as LinkState[]) if (s.includes(k)) return k
  return s.includes('done') ? 'done' : 'idle'
}

function Inspector({ detail, agent, onClose }: { detail: ConstellationRunDetail; agent: Agent; onClose: () => void }) {
  const isCoord = agent.id === detail.run.coordinatorAgentId
  const tasks = detail.tasks.filter((t) => t.agentId === agent.id)
  const current = tasks.find((t) => ['running', 'approval_required', 'waiting'].includes(t.status)) ?? tasks.at(-1)
  const missionId = isCoord ? detail.run.coordinatorMissionId : current?.missionId
  const mission = useMission(missionId ?? undefined)
  const live = useUi((s) => (missionId ? s.missionActivity[missionId] : null))
  const member = detail.definition?.members.find((m) => m.agentId === agent.id)
  const perms = current ? effectivePermissions({ ...agent, permissions: current.permissions }, { isolationProven: false }) : []
  const tools = mission.data?.toolCalls ?? []
  return (
    <section className="card flex max-h-[calc(100vh-160px)] flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <CompanionAvatar appearance={agent.appearance} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[14px] font-medium text-fg">
            {agent.name} {isCoord && <Crown className="size-3.5 text-accent" />}
          </div>
          <div className="truncate text-2xs text-fg-3">{member?.role || agent.role} · {ENGINE_INFO[agent.providerId].label} · {agent.model === 'default' ? 'modèle par défaut' : agent.model}</div>
        </div>
        <button onClick={onClose} className="text-xs text-fg-3 hover:text-fg">Fermer</button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[12.5px]">
        {live && <div className="rounded-[10px] bg-accent/[0.07] px-3 py-2 text-accent ring-1 ring-accent/20">{live.label} · depuis {duration(live.since)}</div>}
        <div>
          <div className="eyebrow mb-1.5">{isCoord ? 'Coordination' : 'Mission actuelle'}</div>
          {mission.data ? (
            <button onClick={() => navigate(`/missions/${mission.data!.mission.id}`)} className="group w-full rounded-[10px] bg-white/[0.03] p-2.5 text-left ring-1 ring-line hover:bg-white/[0.05]">
              <div className="flex items-center gap-2">
                <MissionStatusIcon status={mission.data.mission.status} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{isCoord ? 'Planification et synthèse' : current?.spec.objective.split('\n')[0]}</span>
                <ArrowRight className="size-3.5 text-fg-4 group-hover:text-fg-2" />
              </div>
              <div className="mt-1 text-2xs text-fg-3">
                {mission.data.mission.shortId} · {mission.data.mission.startedAt ? `${duration(mission.data.mission.startedAt, mission.data.mission.finishedAt)}` : 'pas encore démarrée'}
                {current && !isCoord && ` · ${compactNumber(current.inputTokens + current.outputTokens)} jetons`}
              </div>
            </button>
          ) : (
            <div className="text-fg-3">Aucune mission confiée pour l’instant.</div>
          )}
        </div>
        {current && !isCoord && current.spec.expected && (
          <div>
            <div className="eyebrow mb-1">Résultat attendu</div>
            <p className="text-fg-2">{current.spec.expected}</p>
          </div>
        )}
        {current?.structured && (
          <div>
            <div className="eyebrow mb-1">Résultat transmis</div>
            <p className="text-fg-2">{current.structured.summary}</p>
            {current.structured.files.length > 0 && <div className="mt-1 font-mono text-2xs text-fg-3">{current.structured.files.join(' · ')}</div>}
          </div>
        )}
        {current?.error && <div className="rounded-[10px] bg-danger/[0.06] px-3 py-2 text-danger ring-1 ring-danger/15">{current.error}</div>}
        {tools.length > 0 && (
          <div>
            <div className="eyebrow mb-1">Outils · {tools.length}</div>
            <ul className="space-y-0.5">
              {tools.slice(-6).map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-fg-2">
                  <span className={cn('size-1.5 shrink-0 rounded-full', t.status === 'completed' ? 'bg-success' : t.status === 'denied' || t.status === 'failed' ? 'bg-danger' : t.status === 'awaiting_approval' ? 'bg-warning' : 'bg-accent')} />
                  <span className="truncate">{t.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {perms.length > 0 && (
          <div>
            <div className="eyebrow mb-1">Permissions pour cette sous-mission</div>
            <div className="flex flex-wrap gap-1">
              {perms.filter((p) => ['read', 'write', 'commands', 'network'].includes(p.key)).map((p) => (
                <span key={p.key} title={p.detail} className={cn('rounded-[6px] px-1.5 py-0.5 text-[11px]', p.effective === 'denied' ? 'bg-white/[0.04] text-fg-4' : p.effective === 'ask' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success')}>
                  {p.label}{p.effective === 'denied' ? ' · non' : p.effective === 'ask' ? ' · accord' : ''}
                </span>
              ))}
            </div>
          </div>
        )}
        {isCoord && detail.tasks.length > 0 && (
          <div>
            <div className="eyebrow mb-1">Sous-missions déléguées · {detail.tasks.length}</div>
            <ul className="space-y-1">
              {detail.tasks.map((t) => (
                <li key={t.missionId} className="flex items-center gap-2">
                  <MissionStatusIcon status={t.status} className="size-3" />
                  <span className="min-w-0 flex-1 truncate text-fg-2">{t.spec.key} · {t.spec.objective.split('\n')[0]}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

function Timeline({ detail, byId }: { detail: ConstellationRunDetail; byId: Map<string, Agent> }) {
  const start = new Date(detail.run.startedAt ?? detail.run.createdAt).getTime()
  const end = Math.max(Date.now(), ...detail.tasks.map((t) => (t.finishedAt ? new Date(t.finishedAt).getTime() : 0)), detail.run.finishedAt ? new Date(detail.run.finishedAt).getTime() : 0)
  const span = Math.max(1, (detail.run.finishedAt ? new Date(detail.run.finishedAt).getTime() : end) - start)
  const pct = (iso: string | null) => (iso ? Math.max(0, Math.min(100, ((new Date(iso).getTime() - start) / span) * 100)) : 0)
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        {detail.tasks.map((t) => {
          const a = byId.get(t.agentId)
          const left = pct(t.startedAt)
          const right = t.finishedAt ? pct(t.finishedAt) : t.startedAt ? 100 : left
          return (
            <div key={t.missionId} className="grid grid-cols-[150px_1fr] items-center gap-3">
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-2">
                {a && <CompanionAvatar appearance={a.appearance} size={16} />}
                <span className="truncate">{a?.name} · {t.spec.key}</span>
              </span>
              <div className="relative h-5 rounded-[5px] bg-white/[0.03]">
                {t.startedAt ? (
                  <div className={cn('absolute top-0.5 bottom-0.5 rounded-[4px]', t.status === 'done' ? 'bg-success/40' : t.status === 'failed' ? 'bg-danger/45' : t.status === 'approval_required' ? 'bg-warning/45' : 'bg-accent/45')} style={{ left: `${left}%`, width: `${Math.max(1.2, right - left)}%` }} title={`${clock(t.startedAt)} → ${t.finishedAt ? clock(t.finishedAt) : 'en cours'}`} />
                ) : (
                  <span className="absolute inset-y-0 left-2 flex items-center text-2xs text-fg-4">{t.status === 'cancelled' ? 'non exécutée' : 'en attente'}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div>
        <div className="eyebrow mb-2">Transferts de contexte</div>
        <ol className="relative ml-1.5 border-l border-line pl-4">
          {detail.handoffs.map((h) => (
            <li key={h.id} className="relative py-1.5">
              <span className={cn('absolute top-[12px] -left-[20.5px] size-[7px] rounded-full ring-2 ring-surface', h.kind === 'delegation' ? 'bg-accent' : h.kind === 'result' ? 'bg-success' : 'bg-accent-2')} />
              <div className="flex items-baseline gap-2 text-[12.5px]">
                <span className="text-2xs text-fg-4 tabular">{clock(h.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate text-fg-2" title={h.summary}>{h.summary}</span>
                {h.redactions > 0 && <Badge tone="warning">{h.redactions} secret{h.redactions > 1 ? 's' : ''} masqué{h.redactions > 1 ? 's' : ''}</Badge>}
              </div>
            </li>
          ))}
          {detail.handoffs.length === 0 && <li className="py-1.5 text-[12.5px] text-fg-3">Aucun transfert pour l’instant.</li>}
        </ol>
      </div>
    </div>
  )
}

function Workspaces({ detail, byId }: { detail: ConstellationRunDetail; byId: Map<string, Agent> }) {
  const ws = detail.workspaces.filter((w) => w.kind === 'worktree')
  const [diff, setDiff] = useState<{ id: string; text: string } | null>(null)
  const confirm = useConfirm()
  const merge = useAction('constellations.mergeWorkspace', { success: 'Modifications fusionnées dans votre dossier' })
  const discard = useAction('constellations.discardWorkspace', { success: 'Proposition écartée' })
  if (!ws.length) return null
  return (
    <Panel title={<span>Propositions de modifications <span className="font-normal text-fg-3">· worktrees Git</span></span>}>
      <div className="space-y-2 px-1 pb-1">
        {ws.map((w) => {
          const a = byId.get(w.agentId)
          return (
            <div key={w.id} className="rounded-[11px] bg-white/[0.02] p-3 ring-1 ring-line">
              <div className="flex items-center gap-2.5">
                {a && <CompanionAvatar appearance={a.appearance} size={22} />}
                <span className="text-[13px] text-fg">{a?.name}</span>
                <span className="font-mono text-2xs text-fg-3">{w.branch}</span>
                <span className="ml-auto">
                  <Badge tone={w.status === 'merged' ? 'success' : w.status === 'conflict' ? 'danger' : w.status === 'discarded' ? 'neutral' : w.status === 'ready' ? 'accent' : 'info'}>
                    {{ active: 'En cours', ready: 'Prête à fusionner', merged: 'Fusionnée', discarded: 'Écartée', conflict: 'Conflit' }[w.status]}
                  </Badge>
                </span>
              </div>
              {w.diffStat && <pre className="mt-2 max-h-24 overflow-auto font-mono text-[11px] text-fg-3">{w.diffStat}</pre>}
              {w.conflictWith.length > 0 && <div className="mt-1.5 text-[12px] text-danger">Incompatible avec la proposition de {w.conflictWith.map((id) => byId.get(id)?.name).join(', ')} : fusionnez l’une, écartez ou corrigez l’autre.</div>}
              {['ready', 'conflict'].includes(w.status) && (
                <div className="mt-2 flex gap-1.5">
                  <Button size="xs" variant="ghost" onClick={async () => setDiff(diff?.id === w.id ? null : { id: w.id, text: await call('constellations.workspaceDiff', { id: w.id }) })}>
                    <FileDiff /> {diff?.id === w.id ? 'Masquer le diff' : 'Voir le diff'}
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={async () => {
                      if (await confirm({ title: `Fusionner le travail de ${a?.name} ?`, body: 'Orbit fusionne la branche dans la branche actuelle de votre dossier (git merge --no-ff). Refusé si votre dossier contient des modifications non enregistrées ; en cas de conflit, rien n’est modifié.', confirm: 'Fusionner' })) merge.mutate({ id: w.id })
                    }}
                  >
                    <GitMerge /> Fusionner
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => discard.mutate({ id: w.id })}>
                    <Trash2 /> Écarter
                  </Button>
                </div>
              )}
              {diff?.id === w.id && <div className="mt-2">{diff.text ? <DiffView diff={diff.text} /> : <span className="text-2xs text-fg-3">Aucune modification.</span>}</div>}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function RunMachineBadge({ machineId }: { machineId: string }) {
  const { machine, online, lastSyncedAt } = useRemoteState(machineId)
  return (
    <Tooltip content={online ? 'Coordonnée par le serveur, indépendamment de ce Mac.' : `Serveur injoignable : dernier état connu${lastSyncedAt ? `, synchronisé ${relative(lastSyncedAt)}` : ''}.`}>
      <span><Badge tone={online ? 'neutral' : 'warning'}><Server className="size-3" /> {machine?.name ?? 'Serveur'}{online ? '' : ' · hors ligne'}</Badge></span>
    </Tooltip>
  )
}

export function ConstellationRunPage({ runId }: { runId: string }) {
  const q = useConstellationRun(runId)
  const agents = useAgents()
  const confirm = useConfirm()
  const [view, setView] = useState<'universe' | 'list' | 'timeline'>('universe')
  const [selected, setSelected] = useState<string | null>(null)
  const activity = useUi((s) => s.missionActivity)
  const cancel = useAction('constellations.cancel', { success: 'Constellation arrêtée' })
  const resume = useAction('constellations.resume', { success: 'Reprise en cours' })
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])
  if (q.isLoading || !q.data) return <Page wide><Skeleton className="h-[480px] rounded-xl" /></Page>
  const d = q.data
  const { run } = d
  const active = ['planning', 'running', 'synthesizing'].includes(run.status)
  const members = d.definition?.members ?? [{ agentId: run.coordinatorAgentId, role: 'Coordination', responsibilities: '', canDelegate: true }]
  const coordMission = run.coordinatorMissionId
  const nodes = members
    .map((m): MapNode | null => {
      const agent = byId.get(m.agentId)
      if (!agent) return null
      const coordinator = m.agentId === run.coordinatorAgentId
      const tasks = d.tasks.filter((t) => t.agentId === m.agentId)
      const working = tasks.find((t) => ['running', 'approval_required'].includes(t.status))
      const state: LinkState = coordinator ? (run.status === 'failed' ? 'error' : run.status === 'done' ? 'done' : (run.status === 'planning' || run.status === 'synthesizing') ? 'working' : 'idle') : memberState(tasks)
      const live = coordinator ? (coordMission ? activity[coordMission] : null) : working ? activity[working.missionId] : null
      return {
        agent,
        role: m.role || agent.role,
        coordinator,
        state,
        activity: live?.label ?? null,
        caption: coordinator ? { planning: 'Planifie', running: `Suit ${d.tasks.filter((t) => ['running', 'approval_required'].includes(t.status)).length} sous-mission(s)`, synthesizing: 'Rédige la synthèse', done: 'Synthèse livrée', failed: 'Échec', cancelled: 'Arrêtée', interrupted: 'Interrompue' }[run.status] : working ? working.spec.objective.split('\n')[0] : tasks.at(-1)?.structured?.summary ?? null,
      }
    })
    .filter((n): n is MapNode => n !== null)
  const deps = d.tasks.flatMap((t) => t.dependsOnMissionIds.map((dep) => ({ from: d.tasks.find((x) => x.missionId === dep)?.agentId ?? '', to: t.agentId, state: taskState(t) }))).filter((x) => x.from && x.from !== x.to)
  const sel = selected ? byId.get(selected) : null
  const totalTokens = run.tokens

  return (
    <Page wide>
      <button onClick={() => navigate('/constellations')} className="no-drag mb-1 flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft className="size-3.5" /> Constellations
      </button>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Waypoints className="size-5 text-accent" />
            <h1 className="truncate text-[22px] leading-8 font-semibold tracking-[-0.015em] text-fg">{run.constellationName}</h1>
            <Badge tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</Badge>
            {run.machineId && <RunMachineBadge machineId={run.machineId} />}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[13.5px] text-fg-2">{run.goal}</p>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-fg-3 tabular">
            <span>Tour {run.round || 1} / {run.limits.maxDepth}</span>
            <span>{d.tasks.length} / {run.limits.maxSubtasks} sous-missions</span>
            <span>{compactNumber(totalTokens)} jetons{run.limits.maxTokens ? ` / ${compactNumber(run.limits.maxTokens)}` : ''}</span>
            <span>{run.costUsd != null ? `${money(run.costUsd)} mesurés ou estimés` : 'aucune dépense mesurée'}</span>
            <span>{duration(run.startedAt, run.finishedAt)}</span>
            {run.origin === 'automation' && <span>déclenchée par une automatisation</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {coordMission && <Button variant="ghost" onClick={() => navigate(`/missions/${coordMission}`)}>Coordination <ArrowRight /></Button>}
          {active && (
            <Button variant="secondary" onClick={async () => { if (await confirm({ title: 'Arrêter la constellation ?', body: 'Toutes les sous-missions en cours sont interrompues (leurs processus sont arrêtés) et les suivantes ne démarrent pas.', confirm: 'Arrêter', danger: true })) cancel.mutate({ id: run.id }) }}>
              <Square /> Arrêter
            </Button>
          )}
          {['interrupted', 'failed', 'cancelled'].includes(run.status) && (
            <Button
              variant="primary"
              onClick={async () => {
                const again = d.tasks.filter((t) => t.status !== 'done')
                const sensitive = again.filter((t) => t.permissions.writeFiles || t.permissions.runCommands)
                const ok = await confirm({
                  title: 'Reprendre la constellation ?',
                  body: `${d.tasks.length - again.length} sous-mission(s) terminée(s) conservée(s). ${again.length} seront relancée(s)${sensitive.length ? `, dont ${sensitive.length} pouvant modifier des fichiers ou exécuter des commandes (${sensitive.map((t) => t.spec.key).join(', ')}) : leur résultat précédent est incertain, vérifiez le dossier avant de continuer` : ''}.`,
                  confirm: 'Reprendre',
                })
                if (ok) resume.mutate({ id: run.id })
              }}
            >
              <RotateCcw /> Reprendre
            </Button>
          )}
        </div>
      </div>
      {run.error && <div className="mb-4 rounded-[12px] bg-danger/[0.06] px-4 py-3 text-[13px] text-danger ring-1 ring-danger/15">{run.error}</div>}

      <div className="mb-3 flex items-center justify-between">
        <Segmented value={view} onChange={setView} options={[{ value: 'universe', label: 'Univers' }, { value: 'list', label: 'Liste' }, { value: 'timeline', label: 'Timeline' }]} />
        <span className="flex items-center gap-3 text-[11px] text-fg-3">
          <span className="flex items-center gap-1.5"><span className="h-px w-4 bg-accent" /> au travail</span>
          <span className="flex items-center gap-1.5"><span className="h-px w-4 border-t border-dashed border-warning" /> attend votre accord</span>
          <span className="flex items-center gap-1.5"><span className="h-px w-4 bg-success" /> résultat transmis</span>
          <span className="flex items-center gap-1.5"><span className="h-px w-4 border-t border-dotted border-fg-3" /> dépendance</span>
        </span>
      </div>

      <div className={cn('mb-4 grid gap-4', sel && view === 'universe' ? 'grid-cols-[minmax(0,1fr)_340px]' : 'grid-cols-1')}>
        {view === 'universe' && <ConstellationMap nodes={nodes} dependencies={deps} runId={run.id} height={440} selected={selected} onSelect={(id) => setSelected(selected === id ? null : id)} />}
        {view === 'list' && (
          <section className="card p-2">
            {d.tasks.length === 0 && <OrbitEmptyState compact title={run.status === 'planning' ? 'Le coordinateur planifie…' : 'Aucune sous-mission'} body="Les sous-missions apparaissent dès que le plan du coordinateur est validé par Orbit." />}
            {d.tasks.map((t) => {
              const a = byId.get(t.agentId)
              return (
                <button key={t.missionId} onClick={() => navigate(`/missions/${t.missionId}`)} className="grid w-full grid-cols-[120px_minmax(0,1fr)_160px_150px_80px] items-center gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-white/[0.03]">
                  <MissionStatusLabel status={t.status} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-fg">{t.spec.key} · {t.spec.objective.split('\n')[0]}</span>
                    <span className="block truncate text-2xs text-fg-3">{t.dependsOnMissionIds.length ? `après ${t.dependsOnMissionIds.map((id) => d.tasks.find((x) => x.missionId === id)?.spec.key).join(', ')}` : 'sans dépendance'}{t.spec.readOnly ? ' · lecture seule' : ''} · tour {t.spec.round}</span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-2">{a && <CompanionAvatar appearance={a.appearance} size={18} />}<span className="truncate">{a?.name} · {a ? ENGINE_INFO[a.providerId].label : ''}</span></span>
                  <span className="text-right text-2xs text-fg-3 tabular">{compactNumber(t.inputTokens + t.outputTokens)} jetons · {duration(t.startedAt, t.finishedAt)}</span>
                  <span className="text-right text-2xs text-fg-4">{relative(t.finishedAt ?? t.startedAt)}</span>
                </button>
              )
            })}
          </section>
        )}
        {view === 'timeline' && <section className="card p-4"><Timeline detail={d} byId={byId} /></section>}
        {sel && view === 'universe' && <Inspector detail={d} agent={sel} onClose={() => setSelected(null)} />}
      </div>

      {(run.synthesis || run.status === 'synthesizing') && (
        <Panel title={<span className="flex items-center gap-2"><Crown className="size-3.5 text-accent" /> Synthèse de {byId.get(run.coordinatorAgentId)?.name}</span>} className="mb-4">
          <div className="prose-orbit px-3 pb-3">{run.synthesis ? <Markdown text={run.synthesis} /> : <span className="text-[13px] text-fg-3">Rédaction en cours…</span>}</div>
        </Panel>
      )}
      <Workspaces detail={d} byId={byId} />
      {!active && !run.synthesis && run.status === 'done' && <div className="text-[13px] text-fg-3"><Play className="inline size-3.5" /> Terminé sans synthèse.</div>}
    </Page>
  )
}
