import { useState } from 'react'
import { AlertTriangle, Check, CirclePause, CircleStop, Gauge, ListChecks, MessageSquareReply, Pencil, Play, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { RUN_STATUS_INFO } from '@shared/constellation-states'
import type { Agent, ConstellationLimits, ConstellationPlan, ConstellationRunDetail, ConstellationRunEvent, PlanTaskRecord } from '@shared/types'
import { Panel } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Label, Textarea } from '@/components/ui/field'
import { Dialog, DialogContent } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { clock, duration } from '@/lib/format'
import { useAction } from '@/lib/queries'
import { useConfirm } from '@/orbit/Confirm'

const toneRing = { accent: 'bg-accent/[0.06] ring-accent/20 text-accent', success: 'bg-success/[0.06] ring-success/20 text-success', danger: 'bg-danger/[0.06] ring-danger/15 text-danger', warning: 'bg-warning/[0.07] ring-warning/20 text-warning', neutral: 'bg-white/[0.03] ring-line text-fg-2' } as const

/**
 * The run's real state and what can be done about it. Actions come from the engine
 * (`detail.actions`): only those that make sense for this state are shown.
 */
export function RunStatusBanner({ detail, byId }: { detail: ConstellationRunDetail; byId: Map<string, Agent> }) {
  const { run, progress, actions } = detail
  const info = RUN_STATUS_INFO[run.status]
  const confirm = useConfirm()
  const [retryOpen, setRetryOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [continueOpen, setContinueOpen] = useState(false)
  const pause = useAction('constellations.pause', { success: 'Pause demandée : aucune nouvelle sous-mission ne démarrera' })
  const resume = useAction('constellations.resume', { success: 'La mission collective reprend' })
  const cancel = useAction('constellations.cancel', { success: 'Mission collective annulée (historique conservé)' })
  const activeAgents = [...new Set(detail.tasks.filter((t) => t.status === 'running' || t.status === 'waiting').map((t) => byId.get(t.agentId)?.name).filter(Boolean))]
  const failed = detail.retryable.length
  const canSkip = actions.includes('resume') && failed > 0

  return (
    <section className={cn('mb-4 rounded-[14px] px-4 py-3 ring-1', toneRing[info.tone])}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium">
            {info.label}
            {detail.driving && <span className="orbit-blip size-1.5 rounded-full bg-current" />}
            {run.phase && ['planning', 'running', 'synthesizing', 'ready'].includes(run.status) && <span className="text-2xs font-normal text-fg-3">· {run.phase === 'executing' ? 'exécution des sous-missions' : run.phase === 'synthesizing' ? 'synthèse du coordinateur' : 'planification'}</span>}
          </div>
          <p className="mt-0.5 text-[12.5px] text-fg-2">{run.error ?? info.hint}</p>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-fg-3 tabular">
            <span>{progress.done} / {progress.total} sous-missions terminées</span>
            {progress.remaining > 0 && <span>{progress.remaining} restante{progress.remaining > 1 ? 's' : ''}</span>}
            {progress.running > 0 && <span>{progress.running} en cours</span>}
            {progress.failed > 0 && <span className="text-danger">{progress.failed} en échec</span>}
            {progress.blocked > 0 && <span className="text-warning">{progress.blocked} bloquée{progress.blocked > 1 ? 's' : ''} par une dépendance</span>}
            {progress.awaitingApproval > 0 && <span className="text-warning">{progress.awaitingApproval} décision{progress.awaitingApproval > 1 ? 's' : ''} en attente</span>}
            {activeAgents.length > 0 && <span>au travail : {activeAgents.join(', ')}</span>}
            {run.activeMs > 0 && <span>temps de travail {duration(new Date(Date.now() - run.activeMs).toISOString())}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {actions.includes('resume') && (
            <Button size="sm" variant="primary" onClick={() => resume.mutate({ id: run.id })} disabled={resume.isPending}>
              <Play /> Reprendre la mission
            </Button>
          )}
          {actions.includes('retry') && (
            <Button size="sm" variant="secondary" onClick={() => setRetryOpen(true)}>
              <RotateCcw /> Réessayer les sous-missions échouées
            </Button>
          )}
          {canSkip && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (await confirm({ title: 'Poursuivre sans les sous-missions en échec ?', body: 'Elles sont marquées « ignorées » (leur historique reste consultable), ainsi que celles qui en dépendent. Le coordinateur fera la synthèse avec les résultats obtenus.', confirm: 'Poursuivre sans elles' })) resume.mutate({ id: run.id, skipFailed: true })
              }}
            >
              Ignorer les échecs et continuer
            </Button>
          )}
          {actions.includes('edit_plan') && (
            <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
              <Pencil /> Modifier le plan
            </Button>
          )}
          {actions.includes('raise_limits') && (
            <Button size="sm" variant="ghost" onClick={() => setLimitsOpen(true)}>
              <Gauge /> Limites
            </Button>
          )}
          {actions.includes('continue') && !detail.pendingPlan && (
            <Button size="sm" variant="ghost" onClick={() => setContinueOpen(true)}>
              <MessageSquareReply /> Répondre au coordinateur
            </Button>
          )}
          {actions.includes('pause') && (
            <Button size="sm" variant="secondary" onClick={() => pause.mutate({ id: run.id })} disabled={pause.isPending}>
              <CirclePause /> Mettre en pause
            </Button>
          )}
          {actions.includes('cancel') && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (await confirm({ title: 'Arrêter la mission collective ?', body: 'Les sous-missions en cours sont interrompues (leurs processus arrêtés) et les suivantes ne démarrent pas. L’historique, les plans et les résultats déjà obtenus sont conservés.', confirm: 'Arrêter', cancel: 'Continuer', danger: true })) cancel.mutate({ id: run.id })
              }}
            >
              <CircleStop /> Arrêter
            </Button>
          )}
        </div>
      </div>
      {retryOpen && <RetryDialog detail={detail} onClose={() => setRetryOpen(false)} />}
      {editOpen && <EditPlanDialog detail={detail} byId={byId} onClose={() => setEditOpen(false)} />}
      {limitsOpen && <LimitsDialog runId={run.id} limits={run.limits} used={progress.total} onClose={() => setLimitsOpen(false)} />}
      {continueOpen && <AnswerDialog runId={run.id} title="Nouvelle consigne pour le coordinateur" description="Le coordinateur reprend la mission collective avec votre consigne. Tout nouveau plan qu’il proposera est vérifié par Orbit et, si nécessaire, soumis à votre validation." onClose={() => setContinueOpen(false)} />}
    </section>
  )
}

function DiffLine({ plan }: { plan: ConstellationPlan }) {
  if (!plan.diff) return null
  const d = plan.diff
  const parts = [d.added.length && `${d.added.length} ajoutée(s)`, d.changed.length && `${d.changed.length} modifiée(s)`, d.removed.length && `${d.removed.length} retirée(s)`, d.unchanged.length && `${d.unchanged.length} inchangée(s)`, d.keptDone.length && `${d.keptDone.length} déjà terminée(s), conservée(s)`].filter(Boolean)
  return parts.length ? <div className="text-2xs text-fg-3">Par rapport au plan validé : {parts.join(' · ')}</div> : null
}

function taskMark(plan: ConstellationPlan, id: string): { label: string; tone: 'success' | 'warning' | 'accent' | 'neutral' } | null {
  if (!plan.diff) return null
  if (plan.diff.added.includes(id)) return { label: 'nouvelle', tone: 'success' }
  if (plan.diff.changed.includes(id)) return { label: 'modifiée', tone: 'warning' }
  if (plan.diff.keptDone.includes(id)) return { label: 'déjà terminée', tone: 'neutral' }
  return null
}

/** The decision waiting for the user: approve these exact tasks, refuse, or answer questions. */
export function PendingPlanCard({ detail, byId }: { detail: ConstellationRunDetail; byId: Map<string, Agent> }) {
  const plan = detail.pendingPlan
  const approve = useAction('constellations.approvePlan', { success: 'Plan validé : les sous-missions prêtes démarrent' })
  const [reply, setReply] = useState<'reject' | 'answer' | null>(null)
  const [limitsOpen, setLimitsOpen] = useState(false)
  if (!plan) return null
  const writers = plan.tasks.filter((t) => !t.readOnly)
  const coordinator = byId.get(detail.run.coordinatorAgentId)?.name ?? 'Le coordinateur'
  return (
    <Panel title={<span className="flex items-center gap-2"><ListChecks className="size-3.5 text-warning" /> {plan.tasks.length ? `Plan v${plan.version} à valider` : `${coordinator} attend vos décisions`} <Badge tone="warning">{plan.source === 'conversation' ? 'reçu en discussion' : plan.source === 'user' ? 'modifié par vous' : 'proposé par le coordinateur'}</Badge></span>} className="mb-4">
      <div className="space-y-3 px-3 pb-3 text-[13px]">
        {plan.approvalReason && <p className="text-fg-2">{plan.approvalReason}</p>}
        {plan.errors.length > 0 && (
          <div className="flex items-start gap-2 rounded-[10px] bg-danger/[0.06] px-3 py-2 text-danger ring-1 ring-danger/15">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="flex-1">{plan.errors.join(' ')}</div>
            <Button size="xs" variant="secondary" onClick={() => setLimitsOpen(true)}><Gauge /> Relever les limites</Button>
          </div>
        )}
        {plan.questions.length > 0 && (
          <ol className="list-decimal space-y-1 pl-5 text-fg">
            {plan.questions.map((q, i) => <li key={i}>{q}</li>)}
          </ol>
        )}
        {plan.tasks.length > 0 && (
          <>
            <DiffLine plan={plan} />
            <ul className="divide-y divide-line rounded-[10px] ring-1 ring-line">
              {plan.tasks.map((t) => {
                const mark = taskMark(plan, t.id)
                const agent = byId.get(t.agentId)
                return (
                  <li key={t.id} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-2xs text-fg-3">{t.id}</span>
                      <span className="min-w-0 flex-1 truncate text-fg">{t.objective.split('\n')[0]}</span>
                      {mark && <Badge tone={mark.tone}>{mark.label}</Badge>}
                      <Badge tone={t.readOnly ? 'neutral' : 'warning'}>{t.readOnly ? 'lecture seule' : t.writes?.length ? `écrit dans ${t.writes.join(', ')}` : 'peut modifier tout le dossier'}</Badge>
                    </div>
                    <div className="mt-0.5 text-2xs text-fg-3">{agent?.name ?? t.assignee}{t.dependsOn.length ? ` · après ${t.dependsOn.join(', ')}` : ' · sans dépendance'}{t.expected ? ` · attendu : ${t.expected.slice(0, 140)}` : ''}</div>
                  </li>
                )
              })}
              {plan.diff?.removed.map((id) => <li key={id} className="px-3 py-2 text-2xs text-fg-3 line-through">{id} · retirée du plan</li>)}
            </ul>
            <p className="text-2xs text-fg-3">Votre accord vaut pour ces sous-missions uniquement : chacune reste soumise aux permissions et aux demandes d’accord de son compagnon, et un plan modifié ensuite sera de nouveau soumis.{writers.length ? ` ${writers.length} peuvent modifier des fichiers ou exécuter des commandes.` : ''}</p>
          </>
        )}
        <div className="flex flex-wrap gap-1.5">
          {detail.actions.includes('approve') && (
            <Button size="sm" variant="primary" disabled={approve.isPending} onClick={() => approve.mutate({ id: detail.run.id, planId: plan.id, hash: plan.hash })}>
              <Check /> Valider et lancer
            </Button>
          )}
          {detail.actions.includes('reject') && (
            <Button size="sm" variant="ghost" onClick={() => setReply('reject')}>
              <X /> Refuser avec un commentaire
            </Button>
          )}
          {detail.actions.includes('answer') && (
            <Button size="sm" variant={plan.tasks.length ? 'ghost' : 'primary'} onClick={() => setReply('answer')}>
              <MessageSquareReply /> {plan.tasks.length ? 'Répondre sans valider' : 'Répondre au coordinateur'}
            </Button>
          )}
        </div>
      </div>
      {reply === 'reject' && <RejectDialog runId={detail.run.id} planId={plan.id} onClose={() => setReply(null)} />}
      {reply === 'answer' && <AnswerDialog runId={detail.run.id} title={plan.questions.length ? 'Vos décisions' : 'Réponse au coordinateur'} description="Votre réponse est transmise au coordinateur, qui poursuit la planification. Elle ne vaut pas validation : tout plan qu’il proposera vous sera soumis." onClose={() => setReply(null)} />}
      {limitsOpen && <LimitsDialog runId={detail.run.id} limits={detail.run.limits} used={detail.progress.total} suggestSubtasks={detail.progress.total + plan.tasks.filter((t) => !detail.tasks.some((x) => x.spec.key === t.id)).length} onClose={() => setLimitsOpen(false)} />}
    </Panel>
  )
}

function AnswerDialog({ runId, title, description, onClose }: { runId: string; title: string; description: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const answer = useAction('constellations.answer', { success: 'Transmis au coordinateur', onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} description={description} className="w-[560px]">
        <form className="space-y-3 px-5 pb-5" onSubmit={(e) => { e.preventDefault(); if (text.trim()) answer.mutate({ id: runId, text }) }}>
          <Textarea autoFocus rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Votre réponse…" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button type="submit" variant="primary" disabled={!text.trim() || answer.isPending}>Envoyer</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RejectDialog({ runId, planId, onClose }: { runId: string; planId: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const reject = useAction('constellations.rejectPlan', { success: 'Plan refusé : le coordinateur en propose un autre', onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Refuser ce plan" description="Le coordinateur reçoit votre commentaire et propose un nouveau plan, qui vous sera de nouveau soumis." className="w-[560px]">
        <form className="space-y-3 px-5 pb-5" onSubmit={(e) => { e.preventDefault(); reject.mutate({ id: runId, planId, feedback: text }) }}>
          <Textarea autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ce qui ne convient pas…" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button type="submit" variant="primary" disabled={reject.isPending}>Refuser le plan</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Retry selected tasks only, after seeing what each attempt already did. */
function RetryDialog({ detail, onClose }: { detail: ConstellationRunDetail; onClose: () => void }) {
  const [sel, setSel] = useState<string[]>(detail.retryable.filter((r) => !r.canWrite || r.fileChanges === 0).map((r) => r.missionId))
  const retry = useAction('constellations.retry', { success: 'Nouvelle tentative lancée', onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Réessayer des sous-missions" description="Seules les sous-missions cochées repartent. Les sous-missions terminées gardent leurs résultats. Vérifiez d’abord ce qu’une tentative interrompue a déjà modifié." className="w-[600px]">
        <div className="space-y-3 px-5 pb-5">
          <ul className="divide-y divide-line rounded-[10px] ring-1 ring-line">
            {detail.retryable.map((r) => {
              const t = detail.tasks.find((x) => x.missionId === r.missionId)
              return (
                <li key={r.missionId} className="flex items-start gap-3 px-3 py-2 text-[13px]">
                  <input type="checkbox" className="mt-1" checked={sel.includes(r.missionId)} onChange={(e) => setSel(e.target.checked ? [...sel, r.missionId] : sel.filter((x) => x !== r.missionId))} />
                  <div className="min-w-0 flex-1">
                    <div className="text-fg"><span className="font-mono text-2xs text-fg-3">{r.key}</span> {t?.spec.objective.split('\n')[0]}</div>
                    <div className="text-2xs text-fg-3">
                      {r.interrupted ? 'Interrompue en cours de route' : 'En échec'} · {r.executions} tentative{r.executions > 1 ? 's' : ''} · {r.fileChanges} fichier{r.fileChanges > 1 ? 's' : ''} modifié{r.fileChanges > 1 ? 's' : ''}
                      {r.canWrite && r.fileChanges > 0 && <span className="text-warning"> · effets partiels possibles : vérifiez le dossier avant de relancer</span>}
                    </div>
                    {t?.error && <div className="text-2xs text-danger">{t.error}</div>}
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button variant="primary" disabled={!sel.length || retry.isPending} onClick={() => retry.mutate({ id: detail.run.id, missionIds: sel })}><RotateCcw /> Relancer {sel.length}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type EditableTask = Pick<PlanTaskRecord, 'id' | 'assignee' | 'objective' | 'expected' | 'context' | 'readOnly'> & { dependsOn: string; writes: string }

/** Edits the remaining tasks; finished or running ones are shown but locked. Saved as a new version to approve. */
function EditPlanDialog({ detail, byId, onClose }: { detail: ConstellationRunDetail; byId: Map<string, Agent>; onClose: () => void }) {
  const base = detail.pendingPlan?.tasks.length ? detail.pendingPlan : [...detail.plans].reverse().find((p) => p.status === 'approved' && p.tasks.length)
  const locked = new Set(detail.tasks.filter((t) => t.status === 'done' || t.status === 'running' || t.status === 'waiting').map((t) => t.spec.key))
  const members = (detail.definition?.members ?? []).filter((m) => m.agentId !== detail.run.coordinatorAgentId).map((m) => byId.get(m.agentId)).filter((a): a is Agent => Boolean(a))
  const [rows, setRows] = useState<EditableTask[]>((base?.tasks ?? []).map((t) => ({ ...t, assignee: byId.get(t.agentId)?.name ?? t.assignee, dependsOn: t.dependsOn.join(', '), writes: (t.writes ?? []).join(', ') })))
  const edit = useAction('constellations.editPlan', { success: 'Nouvelle version du plan : vérifiez les différences puis validez', onSuccess: onClose })
  const set = (i: number, patch: Partial<EditableTask>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Modifier le plan" description="Les sous-missions terminées ou en cours sont verrouillées. Votre version est enregistrée à côté des précédentes, puis soumise à votre validation." className="w-[760px]">
        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5">
          {rows.map((r, i) => {
            const isLocked = locked.has(r.id)
            return (
              <div key={i} className={cn('grid grid-cols-[110px_130px_1fr_auto] items-start gap-2 rounded-[10px] p-2 ring-1 ring-line', isLocked && 'opacity-60')}>
                <Input value={r.id} disabled={isLocked} onChange={(e) => set(i, { id: e.target.value })} placeholder="id" />
                <select className="h-8 rounded-[8px] bg-white/[0.04] px-2 text-[13px] ring-1 ring-line" value={r.assignee} disabled={isLocked} onChange={(e) => set(i, { assignee: e.target.value })}>
                  {members.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
                <div className="space-y-1">
                  <Textarea rows={2} value={r.objective} disabled={isLocked} onChange={(e) => set(i, { objective: e.target.value })} placeholder="Objectif" />
                  <div className="flex items-center gap-2 text-2xs text-fg-3">
                    <span>après</span>
                    <Input className="h-7" value={r.dependsOn} disabled={isLocked} onChange={(e) => set(i, { dependsOn: e.target.value })} placeholder="ids séparés par des virgules" />
                    <label className="flex shrink-0 items-center gap-1"><input type="checkbox" checked={r.readOnly} disabled={isLocked} onChange={(e) => set(i, { readOnly: e.target.checked })} /> lecture seule</label>
                  </div>
                  {!r.readOnly && (
                    <div className="flex items-center gap-2 text-2xs text-fg-3">
                      <span className="shrink-0">écrit dans</span>
                      <Input className="h-7" value={r.writes} disabled={isLocked} onChange={(e) => set(i, { writes: e.target.value })} placeholder="dossiers séparés par des virgules (vide : tout le dossier)" />
                    </div>
                  )}
                </div>
                {isLocked ? <Badge tone="neutral">verrouillée</Badge> : <Button size="xs" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 /></Button>}
              </div>
            )
          })}
          <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { id: nextRowId(rows), assignee: members[0]?.name ?? '', objective: '', expected: '', context: '', readOnly: true, dependsOn: '', writes: '' }])}><Plus /> Ajouter une sous-mission</Button>
        </div>
        <div className="flex justify-end gap-2 px-5 pt-3 pb-5">
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button
            variant="primary"
            disabled={!rows.length || rows.some((r) => !r.id.trim() || !r.objective.trim()) || edit.isPending}
            onClick={() => edit.mutate({ id: detail.run.id, tasks: rows.map((r) => ({ id: r.id.trim(), assignee: r.assignee, objective: r.objective, expected: r.expected, context: r.context, readOnly: r.readOnly, dependsOn: r.dependsOn.split(',').map((s) => s.trim()).filter(Boolean), writes: r.readOnly ? [] : r.writes.split(',').map((s) => s.trim()).filter(Boolean) })) })}
          >
            Enregistrer la nouvelle version
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function LimitsDialog({ runId, limits, used, suggestSubtasks, onClose }: { runId: string; limits: ConstellationLimits; used: number; suggestSubtasks?: number; onClose: () => void }) {
  const [v, setV] = useState({ maxSubtasks: Math.max(limits.maxSubtasks, Math.min(50, suggestSubtasks ?? 0)), maxDepth: limits.maxDepth, maxDurationMin: limits.maxDurationMin, maxTokens: limits.maxTokens, maxBudgetUsd: limits.maxBudgetUsd })
  const update = useAction('constellations.updateLimits', { success: 'Limites de cette exécution mises à jour', onSuccess: onClose })
  const num = (k: keyof typeof v, label: string, hint?: string) => (
    <div>
      <Label hint={hint}>{label}</Label>
      <Input type="number" value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value === '' ? null : Number(e.target.value) })} />
    </div>
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Limites de cette exécution" description="Ne modifie que cette exécution (pas la constellation). Un plan bloqué par une limite reste soumis à votre validation." className="w-[520px]">
        <div className="grid grid-cols-2 gap-3 px-5">
          {num('maxSubtasks', 'Sous-missions au total', `${used} déjà créées · max 50`)}
          {num('maxDepth', 'Tours de délégation')}
          {num('maxDurationMin', 'Durée de travail (min)', 'pauses et validations exclues')}
          {num('maxTokens', 'Jetons', 'vide = sans limite')}
          {num('maxBudgetUsd', 'Budget ($)', 'vide = sans limite')}
        </div>
        <div className="flex justify-end gap-2 px-5 pt-4 pb-5">
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" disabled={update.isPending} onClick={() => update.mutate({ id: runId, limits: { maxSubtasks: v.maxSubtasks, maxDepth: v.maxDepth, maxDurationMin: v.maxDurationMin, maxTokens: v.maxTokens, maxBudgetUsd: v.maxBudgetUsd } })}>Enregistrer</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const LEVEL_DOT = { info: 'bg-fg-3', success: 'bg-success', warning: 'bg-warning', error: 'bg-danger' } as const
/** Distinguishes the end of an exchange, of a sub-mission and of the collective run. */
/** First free `tache-N`: rows.length + 1 collides once a middle row has been deleted. */
function nextRowId(rows: { id: string }[]): string {
  let n = rows.length + 1
  while (rows.some((r) => r.id === `tache-${n}`)) n++
  return `tache-${n}`
}

const KIND_LABEL: Record<string, string> = {
  'exchange.ended': 'Fin d’échange',
  'task.done': 'Sous-mission terminée',
  'task.failed': 'Sous-mission en échec',
  'task.cancelled': 'Sous-mission arrêtée',
  'task.refused': 'Démarrage refusé',
  'run.completed': 'Mission collective terminée',
  'run.failed': 'Échec de la mission collective',
  'run.error': 'Erreur technique',
  'run.blocked': 'Intervention nécessaire',
  'run.incoherent': 'Incohérence détectée',
  'run.interrupted': 'Interrompue',
  'run.paused': 'Pause',
  'round.done': 'Tour terminé',
  'approval.requested': 'Validation demandée',
  'plan.recognized': 'Plan reconnu',
  'plan.recovered': 'Plan récupéré',
  'plan.invalid': 'Plan refusé',
  'plan.blocked': 'Plan hors limites',
  'limit.reached': 'Limite atteinte',
  'limit.duration': 'Durée maximale',
}

export function RunEvents({ events }: { events: ConstellationRunEvent[] }) {
  const [all, setAll] = useState(false)
  if (!events.length) return null
  const shown = all ? events : events.slice(-12)
  return (
    <Panel title={<span>Événements <span className="font-normal text-fg-3">· {events.length}</span></span>} className="mb-4">
      <ol className="space-y-1 px-3 pb-3">
        {events.length > shown.length && <li><button onClick={() => setAll(true)} className="text-2xs text-fg-3 hover:text-fg">Afficher les {events.length - shown.length} précédents</button></li>}
        {[...shown].reverse().map((e) => (
          <li key={e.id} className="flex items-baseline gap-2 text-[12.5px]">
            <span className="text-2xs text-fg-4 tabular">{clock(e.createdAt)}</span>
            <span className={cn('size-1.5 shrink-0 translate-y-[-1px] rounded-full', LEVEL_DOT[e.level])} />
            {(KIND_LABEL[e.kind] || e.kind.startsWith('decision.')) && <span className="shrink-0 text-2xs text-fg-3">{KIND_LABEL[e.kind] ?? 'Votre décision'}</span>}
            <span className={cn('min-w-0 flex-1', e.level === 'error' ? 'text-danger' : 'text-fg-2')}>{e.message}</span>
          </li>
        ))}
      </ol>
    </Panel>
  )
}
