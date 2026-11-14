import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, CalendarClock, Check, ChevronDown, Clock, MoreHorizontal, Pencil, Play, Plus, Power, Trash2, Waypoints, Zap } from 'lucide-react'
import { describeRecurrence, localDateTimeInput, type Recurrence } from '@shared/schedule'
import type { Automation, AutomationRun, MissedPolicy } from '@shared/types'
import { Page, PageHeader, Panel } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Label, Segmented, Skeleton, Switch, Textarea } from '@/components/ui/field'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/overlay'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { relative } from '@/lib/format'
import { useAction, useAgents, useAutomationRuns, useAutomations, useConstellations } from '@/lib/queries'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { useConfirm } from '@/orbit/Confirm'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { navigate } from '@/stores/router'
import { useQuery } from '@tanstack/react-query'

const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const RUN_META: Record<AutomationRun['status'], { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' | 'accent' }> = {
  pending_confirmation: { label: 'À confirmer', tone: 'warning' },
  running: { label: 'En cours', tone: 'accent' },
  done: { label: 'Terminée', tone: 'success' },
  failed: { label: 'Échec', tone: 'danger' },
  skipped: { label: 'Ignorée', tone: 'neutral' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
  uncertain: { label: 'Incertaine', tone: 'warning' },
}
const TRIGGER_LABELS: Record<AutomationRun['trigger'], string> = { schedule: 'planifiée', missed: 'rattrapage', manual: 'manuelle', event: 'événement' }

export function whenLabel(iso: string | null, tz: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('fr-FR', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function useTarget(a: Pick<Automation, 'targetKind' | 'targetId'>) {
  const agents = useAgents()
  const defs = useConstellations()
  if (a.targetKind === 'agent') {
    const agent = agents.data?.find((x) => x.id === a.targetId)
    return { name: agent?.name ?? 'Compagnon supprimé', avatars: agent ? [agent] : [] }
  }
  const def = defs.data?.find((x) => x.id === a.targetId)
  return { name: def ? `Constellation « ${def.name} »` : 'Constellation supprimée', avatars: (def?.members ?? []).map((m) => agents.data?.find((x) => x.id === m.agentId)).filter((x): x is NonNullable<typeof x> => Boolean(x)) }
}

function AutomationCard({ a }: { a: Automation }) {
  const target = useTarget(a)
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const runs = useAutomationRuns(open ? a.id : undefined)
  const setStatus = useAction('automations.setStatus')
  const runNow = useAction('automations.runNow', { success: 'Exécution lancée' })
  const del = useAction('automations.delete', { success: 'Automatisation supprimée' })
  const active = a.status === 'active'
  return (
    <section className={cn('card overflow-hidden', !active && 'opacity-80')}>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span className="flex shrink-0 -space-x-2 pt-0.5">
          {target.avatars.slice(0, 3).map((x) => (
            <span key={x.id} className="rounded-full bg-surface ring-2 ring-surface">
              <CompanionAvatar appearance={x.appearance} size={30} />
            </span>
          ))}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[14.5px] font-semibold text-fg">{a.name}</h3>
            {a.status === 'paused' && <Badge>En pause</Badge>}
            {a.status === 'completed' && <Badge tone="success">Terminée</Badge>}
            {a.sensitive && <Badge tone="warning" >Peut modifier des fichiers</Badge>}
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-fg-3">
            {target.name} · {a.title}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
            <span className="flex items-center gap-1.5 text-fg-2">
              <CalendarClock className="size-3.5 text-fg-3" />
              {a.recurrence ? describeRecurrence(a.recurrence) : 'Sur événement'}
              {a.recurrence && <span className="text-fg-4">· {a.timezone}</span>}
            </span>
            {a.triggers.length > 0 && (
              <span className="flex items-center gap-1.5 text-fg-2">
                <Zap className="size-3.5 text-fg-3" /> {a.triggers.length} déclencheur{a.triggers.length > 1 ? 's' : ''}
              </span>
            )}
            {active && a.nextRunAt && (
              <span className="flex items-center gap-1.5 text-accent">
                <Clock className="size-3.5" /> Prochaine : {whenLabel(a.nextRunAt, a.timezone)} <span className="text-fg-3">({relative(a.nextRunAt)})</span>
              </span>
            )}
            {a.lastRun && (
              <span className="flex items-center gap-1.5 text-fg-3">
                Dernière : <Badge tone={RUN_META[a.lastRun.status].tone}>{RUN_META[a.lastRun.status].label}</Badge> {relative(a.lastRun.createdAt)}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {a.status !== 'completed' && <Switch checked={active} onChange={(v) => setStatus.mutate({ id: a.id, status: v ? 'active' : 'paused' })} label={active ? 'Mettre en pause' : 'Reprendre'} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex size-7 items-center justify-center rounded-[7px] text-fg-3 hover:bg-white/5 hover:text-fg" aria-label="Actions">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={async () => {
                  if (!a.sensitive || (await confirm({ title: `Exécuter « ${a.name} » maintenant ?`, body: 'La cible peut modifier des fichiers ou exécuter des commandes. Les approbations habituelles s’appliquent.', confirm: 'Exécuter' }))) runNow.mutate({ id: a.id })
                }}
              >
                <Play /> Exécuter maintenant
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate(`/automations/${a.id}/edit`)}><Pencil /> Modifier</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={async () => (await confirm({ title: `Supprimer « ${a.name} » ?`, body: 'Son historique d’exécutions sera supprimé. Les missions déjà réalisées restent dans Missions.', confirm: 'Supprimer', danger: true })) && del.mutate({ id: a.id })}>
                <Trash2 /> Supprimer…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1.5 border-t border-line px-4 py-2 text-left text-[12px] text-fg-3 hover:bg-white/[0.02] hover:text-fg-2">
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} /> Historique
      </button>
      {open && (
        <div className="px-2 pb-2">
          {runs.isLoading && <Skeleton className="m-2 h-8" />}
          {runs.data?.length === 0 && <div className="px-3 py-2 text-[12.5px] text-fg-3">Aucune exécution pour l’instant.</div>}
          {runs.data?.slice(0, 12).map((r) => (
            <button
              key={r.id}
              disabled={!r.missionId && !r.constellationRunId}
              onClick={() => navigate(r.missionId ? `/missions/${r.missionId}` : `/constellations/runs/${r.constellationRunId}`)}
              className="grid w-full grid-cols-[110px_90px_1fr_auto] items-center gap-3 rounded-[9px] px-3 py-1.5 text-left text-[12.5px] enabled:hover:bg-white/[0.03]"
            >
              <Badge tone={RUN_META[r.status].tone}>{RUN_META[r.status].label}</Badge>
              <span className="text-fg-3">{TRIGGER_LABELS[r.trigger]}</span>
              <span className="truncate text-fg-3" title={r.note ?? undefined}>{r.note ?? (r.trigger === 'event' ? 'Déclenchée par un événement' : `Prévue ${whenLabel(r.scheduledFor, a.timezone)}`)}</span>
              <span className="text-2xs text-fg-4">{relative(r.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function PendingConfirmations({ focus }: { focus?: string | null }) {
  const runs = useAutomationRuns()
  const automations = useAutomations()
  const confirmRun = useAction('automations.confirmRun', { success: (r) => (r.status === 'skipped' ? 'Exécution ignorée' : 'Exécution lancée') })
  const pending = (runs.data ?? []).filter((r) => r.status === 'pending_confirmation')
  if (!pending.length) return null
  return (
    <div className="mb-5 space-y-2">
      {pending.map((r) => {
        const a = automations.data?.find((x) => x.id === r.automationId)
        return (
          <div key={r.id} className={cn('flex items-center gap-3 rounded-[12px] bg-warning/[0.05] px-4 py-3 ring-1 ring-warning/20', focus === r.id && 'ring-2 ring-warning/60')}>
            <AlertTriangle className="size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-fg">« {a?.name} » n’a pas pu s’exécuter</div>
              <div className="truncate text-[12px] text-fg-3">{r.note}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => confirmRun.mutate({ id: r.id, approve: false })}>Ignorer</Button>
            <Button size="sm" variant="primary" onClick={() => confirmRun.mutate({ id: r.id, approve: true })}>
              <Play /> Lancer maintenant
            </Button>
          </div>
        )
      })}
    </div>
  )
}

export function AutomationsPage({ focusRun }: { focusRun?: string | null }) {
  const automations = useAutomations()
  const login = useQuery({ queryKey: ['launchAtLogin'], queryFn: () => call('app.launchAtLogin', {}) })
  const list = automations.data ?? []
  const upcoming = list.filter((a) => a.status === 'active' && a.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
  const failures = list.filter((a) => a.lastRun?.status === 'failed' || a.lastRun?.status === 'uncertain')
  return (
    <Page wide>
      <PageHeader
        title="Automatisations"
        subtitle={list.length ? `${list.filter((a) => a.status === 'active').length} active${list.filter((a) => a.status === 'active').length > 1 ? 's' : ''}${upcoming[0] ? ` · prochaine ${relative(upcoming[0].nextRunAt)}` : ''}${failures.length ? ` · ${failures.length} à vérifier` : ''}` : 'Des missions récurrentes pour vos compagnons et vos constellations.'}
        actions={
          <Button variant="primary" onClick={() => navigate('/automations/new')}>
            <Plus /> Nouvelle automatisation
          </Button>
        }
      />
      <PendingConfirmations focus={focusRun} />
      {automations.data && list.length === 0 ? (
        <div className="card">
          <OrbitEmptyState
            title="Aucune automatisation"
            body="Confiez une mission récurrente — un résumé chaque matin, une vérification chaque semaine — ou déclenchez-la à la fin d’une autre mission. Orbit affiche toujours la prochaine exécution calculée."
            hints={[
              { icon: <CalendarClock />, label: 'Récurrence et fuseau horaire' },
              { icon: <Zap />, label: 'Déclencheurs' },
              { icon: <Power />, label: 'Pause à tout moment' },
            ]}
            action={<Button variant="primary" onClick={() => navigate('/automations/new')}><Plus /> Créer une automatisation</Button>}
          />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4">
          <div className="space-y-3">{list.map((a) => <AutomationCard key={a.id} a={a} />)}</div>
          <div className="space-y-4">
            <Panel title="Prochaines exécutions">
              {upcoming.length === 0 && <div className="px-2.5 pb-3 text-[12.5px] text-fg-3">Rien de prévu.</div>}
              <ol className="relative mx-2 mb-2 border-l border-line pl-3">
                {upcoming.slice(0, 8).map((a) => (
                  <li key={a.id} className="relative py-1.5">
                    <span className="absolute top-[11px] -left-[16px] size-[7px] rounded-full bg-accent ring-2 ring-surface" />
                    <div className="truncate text-[12.5px] text-fg">{a.name}</div>
                    <div className="text-[11.5px] text-fg-3">{whenLabel(a.nextRunAt, a.timezone)}</div>
                  </li>
                ))}
              </ol>
            </Panel>
            <section className="card p-4 text-[12.5px] leading-relaxed text-fg-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-fg"><Clock className="size-3.5" /> Quand Orbit peut agir</div>
              Les automatisations s’exécutent tant qu’Orbit est ouvert — même fenêtre fermée. Si le Mac est éteint ou en veille, rien ne s’exécute : au réveil, chaque exécution manquée suit la règle choisie (ignorer, rattraper une fois, ou vous demander). Pour un fonctionnement continu, utilisez une machine distante (Machines).
              <label className="mt-3 flex items-center justify-between gap-2 text-fg-2">
                Ouvrir Orbit à l’ouverture de session
                <Switch
                  checked={Boolean(login.data?.enabled)}
                  disabled={!login.data?.supported}
                  onChange={async (v) => {
                    await call('app.launchAtLogin', { enabled: v })
                    void login.refetch()
                  }}
                  label="Ouvrir Orbit à l’ouverture de session"
                />
              </label>
              {login.data && !login.data.supported && <div className="mt-1 text-2xs text-fg-4">Disponible dans l’application installée (pas en mode développement).</div>}
            </section>
          </div>
        </div>
      )}
    </Page>
  )
}

// Assistant

type Preset = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'interval' | 'cron' | 'event'
const DAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']
const POLICIES: { id: MissedPolicy; label: string; body: string }[] = [
  { id: 'ask', label: 'Me demander', body: 'Une notification vous propose de la lancer ou de l’ignorer.' },
  { id: 'run_once', label: 'Rattraper une fois', body: 'Une seule exécution au retour, même après plusieurs jours d’absence.' },
  { id: 'skip', label: 'Ignorer', body: 'On attend simplement la prochaine date prévue.' },
]

function recurrenceFrom(p: Preset, s: { time: string; days: number[]; day: number; at: string; minutes: number; cron: string }): Recurrence | null {
  switch (p) {
    case 'once':
      return { kind: 'once', at: s.at }
    case 'daily':
      return { kind: 'daily', time: s.time }
    case 'weekdays':
      return { kind: 'weekly', days: [1, 2, 3, 4, 5], time: s.time }
    case 'weekly':
      return { kind: 'weekly', days: s.days, time: s.time }
    case 'monthly':
      return { kind: 'monthly', day: s.day, time: s.time }
    case 'interval':
      return { kind: 'interval', minutes: s.minutes, anchor: new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000).toISOString() }
    case 'cron':
      return { kind: 'cron', expr: s.cron }
    case 'event':
      return null
  }
}

export function AutomationWizardPage({ automationId }: { automationId?: string }) {
  const agents = useAgents()
  const defs = useConstellations()
  const automations = useAutomations()
  const existing = automations.data?.find((a) => a.id === automationId)
  const [loaded, setLoaded] = useState(!automationId)
  const [name, setName] = useState('')
  const [targetKind, setTargetKind] = useState<'agent' | 'constellation'>('agent')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preset, setPreset] = useState<Preset>('daily')
  const [s, setS] = useState({ time: '08:00', days: [1], day: 1, at: localDateTimeInput(Date.now() + 3600_000, SYSTEM_TZ), minutes: 60, cron: '0 9 * * 1-5' })
  const [tz, setTz] = useState(SYSTEM_TZ)
  const [policy, setPolicy] = useState<MissedPolicy>('ask')
  const [maxRuns, setMaxRuns] = useState<number | null>(null)
  const [eventSource, setEventSource] = useState<string | null>(null)
  const [eventKind, setEventKind] = useState<'mission.completed' | 'mission.failed'>('mission.completed')

  useEffect(() => {
    if (!existing || loaded) return
    setName(existing.name)
    setTargetKind(existing.targetKind)
    setTargetId(existing.targetId)
    setTitle(existing.title)
    setPrompt(existing.prompt)
    setTz(existing.timezone)
    setPolicy(existing.missedPolicy)
    setMaxRuns(existing.maxRunsPerDay)
    const r = existing.recurrence
    if (!r) {
      setPreset('event')
      setEventSource(existing.triggers[0]?.sourceAgentId ?? null)
    } else if (r.kind === 'weekly' && r.days.join() === '1,2,3,4,5') setPreset('weekdays')
    else setPreset(r.kind as Preset)
    if (r?.kind === 'daily' || r?.kind === 'weekly' || r?.kind === 'monthly') setS((x) => ({ ...x, time: r.time, ...(r.kind === 'weekly' ? { days: r.days } : {}), ...(r.kind === 'monthly' ? { day: r.day } : {}) }))
    if (r?.kind === 'once') setS((x) => ({ ...x, at: r.at }))
    if (r?.kind === 'interval') setS((x) => ({ ...x, minutes: r.minutes }))
    if (r?.kind === 'cron') setS((x) => ({ ...x, cron: r.expr }))
    setLoaded(true)
  }, [existing, loaded])

  const recurrence = useMemo(() => recurrenceFrom(preset, s), [preset, s])
  const preview = useQuery({ queryKey: ['automation-preview', recurrence, tz], queryFn: () => call('automations.preview', { recurrence: recurrence!, timezone: tz, count: 3 }), enabled: Boolean(recurrence) })
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')
    } catch {
      return [SYSTEM_TZ]
    }
  }, [])
  const targets = targetKind === 'agent' ? (agents.data ?? []).filter((a) => a.enabled).map((a) => ({ id: a.id, label: a.name, appearance: a.appearance })) : (defs.data ?? []).filter((d) => !d.isTemplate).map((d) => ({ id: d.id, label: d.name, appearance: agents.data?.find((a) => a.id === d.coordinatorAgentId)?.appearance }))
  const create = useAction('automations.create', { success: (a) => `« ${a.name} » est planifiée`, onSuccess: () => navigate('/automations') })
  const update = useAction('automations.update', { success: 'Automatisation mise à jour', onSuccess: () => navigate('/automations') })
  const valid = name.trim() && targetId && title.trim() && (preset === 'event' ? Boolean(eventSource) : !preview.data?.error)
  const save = () => {
    if (!valid) return
    const input = {
      name: name.trim(),
      description: '',
      targetKind,
      targetId: targetId!,
      title: title.trim(),
      prompt,
      recurrence,
      timezone: tz,
      missedPolicy: policy,
      maxRunsPerDay: maxRuns,
      triggers: preset === 'event' ? [{ kind: eventKind, sourceAgentId: eventSource, sourceAutomationId: null, cooldownSec: 300 }] : [],
    }
    if (automationId) update.mutate({ id: automationId, input })
    else create.mutate(input)
  }
  if (!loaded) return null

  const section = (n: number, label: string, children: React.ReactNode) => (
    <section className="rounded-2xl bg-surface p-5 ring-1 ring-line">
      <div className="mb-4 flex items-center gap-2 text-[13.5px] font-medium text-fg">
        <span className="flex size-5 items-center justify-center rounded-full bg-white/10 text-[11px] tabular">{n}</span> {label}
      </div>
      {children}
    </section>
  )

  return (
    <Page>
      <button onClick={() => navigate('/automations')} className="no-drag mb-1 flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft className="size-3.5" /> Automatisations
      </button>
      <h1 className="mb-5 text-[24px] leading-8 font-semibold tracking-[-0.015em] text-fg">{automationId ? `Modifier « ${name} »` : 'Nouvelle automatisation'}</h1>
      <div className="space-y-4">
        {section(
          1,
          'Quoi',
          <div className="space-y-4">
            <div>
              <Label>Nom</Label>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Revue du matin" maxLength={80} />
            </div>
            <div>
              <Label>Qui s’en charge ?</Label>
              <Segmented value={targetKind} onChange={(v) => { setTargetKind(v); setTargetId(null) }} options={[{ value: 'agent', label: 'Un compagnon' }, { value: 'constellation', label: 'Une constellation' }]} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {targets.map((t) => (
                  <button key={t.id} type="button" onClick={() => setTargetId(t.id)} aria-pressed={targetId === t.id} className={cn('flex h-9 items-center gap-2 rounded-full pr-3 pl-1 text-[13px]', targetId === t.id ? 'bg-accent/[0.12] text-fg shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.55)]' : 'bg-white/[0.03] text-fg-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06]')}>
                    {t.appearance ? <CompanionAvatar appearance={t.appearance} size={26} /> : <Waypoints className="ml-1.5 size-4" />}
                    {t.label}
                  </button>
                ))}
                {targets.length === 0 && <span className="text-[12.5px] text-fg-3">{targetKind === 'agent' ? 'Aucun compagnon actif.' : 'Aucune constellation.'}</span>}
              </div>
            </div>
            <div>
              <Label>Mission</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Résumer les nouveautés du projet" maxLength={160} />
            </div>
            <div>
              <Label hint="Ce que le compagnon doit faire à chaque exécution">Instructions</Label>
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-24" />
            </div>
          </div>,
        )}
        {section(
          2,
          'Quand',
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['once', 'Une fois'],
                  ['daily', 'Chaque jour'],
                  ['weekdays', 'Jours de semaine'],
                  ['weekly', 'Chaque semaine'],
                  ['monthly', 'Chaque mois'],
                  ['interval', 'Intervalle'],
                  ['cron', 'Avancé (cron)'],
                  ['event', 'Après un événement'],
                ] as [Preset, string][]
              ).map(([p, l]) => (
                <button key={p} type="button" onClick={() => setPreset(p)} aria-pressed={preset === p} className={cn('h-8 rounded-[9px] px-3 text-[12.5px]', preset === p ? 'bg-accent/[0.1] text-fg shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.55)]' : 'bg-white/[0.025] text-fg-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]')}>
                  {l}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {preset === 'once' && (
                <div>
                  <Label>Date et heure</Label>
                  <Input type="datetime-local" value={s.at} onChange={(e) => setS({ ...s, at: e.target.value })} />
                </div>
              )}
              {['daily', 'weekdays', 'weekly', 'monthly'].includes(preset) && (
                <div>
                  <Label>Heure</Label>
                  <Input type="time" value={s.time} onChange={(e) => setS({ ...s, time: e.target.value })} className="w-32" />
                </div>
              )}
              {preset === 'weekly' && (
                <div>
                  <Label>Jours</Label>
                  <div className="flex gap-1">
                    {DAYS.map((d, i) => {
                      const day = i + 1
                      const on = s.days.includes(day)
                      return (
                        <button key={day} type="button" aria-pressed={on} aria-label={['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'][i]} onClick={() => setS({ ...s, days: on ? s.days.filter((x) => x !== day) : [...s.days, day].sort() })} className={cn('size-8 rounded-full text-[12px]', on ? 'bg-accent text-[#14112b]' : 'bg-white/[0.04] text-fg-2 hover:bg-white/[0.08]')}>
                          {d}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {preset === 'monthly' && (
                <div>
                  <Label hint="31 = dernier jour">Jour du mois</Label>
                  <Input type="number" min={1} max={31} value={s.day} onChange={(e) => setS({ ...s, day: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })} className="w-24" />
                </div>
              )}
              {preset === 'interval' && (
                <div>
                  <Label hint="Minimum 5 minutes">Toutes les</Label>
                  <div className="relative">
                    <Input type="number" min={5} value={s.minutes} onChange={(e) => setS({ ...s, minutes: Math.max(5, Number(e.target.value) || 5) })} className="w-36 pr-12" />
                    <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-fg-3">min</span>
                  </div>
                </div>
              )}
              {preset === 'cron' && (
                <div className="min-w-64 flex-1">
                  <Label hint="minute heure jour mois jour-de-semaine">Expression cron</Label>
                  <Input value={s.cron} onChange={(e) => setS({ ...s, cron: e.target.value })} className="font-mono" />
                </div>
              )}
              {preset === 'event' && (
                <>
                  <div>
                    <Label>Quand</Label>
                    <Segmented value={eventKind} onChange={setEventKind} options={[{ value: 'mission.completed', label: 'Une mission se termine' }, { value: 'mission.failed', label: 'Une mission échoue' }]} />
                  </div>
                  <div>
                    <Label>Mission de</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {(agents.data ?? []).map((a) => (
                        <button key={a.id} type="button" onClick={() => setEventSource(a.id)} aria-pressed={eventSource === a.id} className={cn('flex h-8 items-center gap-1.5 rounded-full pr-3 pl-1 text-[12.5px]', eventSource === a.id ? 'bg-accent/[0.12] text-fg shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.55)]' : 'bg-white/[0.03] text-fg-2 hover:bg-white/[0.06]')}>
                          <CompanionAvatar appearance={a.appearance} size={22} /> {a.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {preset !== 'event' && preset !== 'interval' && (
                <div className="min-w-56">
                  <Label>Fuseau horaire</Label>
                  <select value={tz} onChange={(e) => setTz(e.target.value)} className="h-9 w-full rounded-[9px] bg-white/[0.04] px-2.5 text-[13px] text-fg ring-1 ring-line outline-none focus:ring-accent/50">
                    {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
              )}
            </div>
            {preset !== 'event' && (
              <div className={cn('rounded-[11px] px-3.5 py-2.5 text-[12.5px] ring-1', preview.data?.error ? 'bg-danger/[0.05] text-danger ring-danger/15' : 'bg-white/[0.025] text-fg-2 ring-line')}>
                {preview.data?.error ?? (
                  <>
                    <div className="text-fg">{preview.data?.description}</div>
                    <div className="mt-1 flex flex-wrap gap-x-4 text-fg-3">
                      Prochaines exécutions : {preview.data?.next.map((n) => <span key={n} className="text-fg-2 tabular">{whenLabel(n, tz)}</span>)}
                      {preview.data && preview.data.next.length === 0 && 'aucune (date passée)'}
                    </div>
                  </>
                )}
              </div>
            )}
            {preset === 'event' && <p className="text-xs text-fg-3">Protection contre les répétitions : 5 minutes minimum entre deux déclenchements, jamais sur ses propres missions, et mise en pause automatique au-delà de 12 déclenchements par heure.</p>}
          </div>,
        )}
        {section(
          3,
          'Si Orbit était fermé à l’heure prévue',
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              {POLICIES.map((p) => (
                <button key={p.id} type="button" onClick={() => setPolicy(p.id)} aria-pressed={policy === p.id} className={cn('rounded-[11px] p-3 text-left', policy === p.id ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]')}>
                  <div className="flex items-center gap-1.5 text-[13px] text-fg">{policy === p.id && <Check className="size-3.5 text-accent" />}{p.label}</div>
                  <div className="mt-1 text-[12px] leading-snug text-fg-3">{p.body}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-fg-3">Une cible qui peut modifier des fichiers ou exécuter des commandes n’est jamais relancée sans votre confirmation, et une exécution interrompue n’est jamais rejouée automatiquement.</p>
          </div>,
        )}
        {section(
          4,
          'Limites',
          <div className="flex items-end gap-4">
            <div>
              <Label hint="Laisser vide : pas de limite">Exécutions maximum par 24 h</Label>
              <Input type="number" min={1} max={500} value={maxRuns ?? ''} onChange={(e) => setMaxRuns(e.target.value === '' ? null : Math.max(1, Number(e.target.value)))} className="w-36" placeholder="Aucune" />
            </div>
            <p className="flex-1 pb-2 text-xs text-fg-3">Les budgets du compagnon ou de la constellation, ses permissions et ses approbations s’appliquent à chaque exécution. Un compagnon en mode manuel refuse les missions automatiques.</p>
          </div>,
        )}
        <div className="flex justify-end gap-2 pb-6">
          <Button variant="ghost" onClick={() => navigate('/automations')}>Annuler</Button>
          <Button variant="primary" disabled={!valid || create.isPending || update.isPending} onClick={save}>
            <Check /> {automationId ? 'Enregistrer' : 'Planifier'}
          </Button>
        </div>
      </div>
    </Page>
  )
}
