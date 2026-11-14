import { useState } from 'react'
import { Activity, Brain, CalendarClock, Waypoints, Folder, Gauge, MessageCircle, MoreHorizontal, Pencil, Plus, Rocket, ShieldCheck, Trash2, Wallet, Wrench } from 'lucide-react'
import { PALETTES, PERMISSION_LABELS, STATUS_LABELS } from '@shared/catalog'
import { ACTIVE_MISSION_STATUSES } from '@shared/mission-states'
import { ENGINE_INFO, EFFORT_LEVELS } from '@shared/engines'
import { effectivePermissions } from '@shared/permissions-matrix'
import { missionCounts } from '@shared/stats'
import type { Agent, AgentPermissions, EffectiveLevel, EffectivePermissionRow, MemoryKind } from '@shared/types'
import { Page } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Switch, Tabs, Textarea } from '@/components/ui/field'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { compactNumber, duration, integer, money, relative } from '@/lib/format'
import { useAction, useActivity, useAgent, useAutomations, useConstellations, useConversations, useMachines, useMemory, useMissions, useProviders, useRecentFiles, useSecurity, useUsage } from '@/lib/queries'
import { ActivityEventRow } from '@/orbit/ActivityEvent'
import { CompanionAvatar, CompanionStatusIndicator } from '@/orbit/CompanionAvatar'
import { CompanionContextItems } from '@/orbit/CompanionListItem'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { MissionStatusIcon, MissionStatusLabel, PriorityGlyph } from '@/orbit/MissionStatus'
import { ProviderMark } from '@/orbit/ProviderMark'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

const TABS = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'missions', label: 'Missions' },
  { key: 'activity', label: 'Activité' },
  { key: 'memory', label: 'Mémoire' },
  { key: 'files', label: 'Fichiers' },
  { key: 'tools', label: 'Permissions' },
  { key: 'stats', label: 'Statistiques' },
  { key: 'config', label: 'Configuration' },
] as const

/** What this companion is allowed to do, as short chips for empty states. */
function abilities(agent: Agent) {
  const on = (Object.keys(PERMISSION_LABELS) as (keyof AgentPermissions)[]).filter((k) => agent.permissions[k])
  if (!on.length) return [{ icon: <MessageCircle />, label: 'Conversation uniquement' }]
  return on.slice(0, 4).map((k) => ({ icon: <ShieldCheck />, label: PERMISSION_LABELS[k].label }))
}

const MEMORY_KINDS: { id: MemoryKind; label: string }[] = [
  { id: 'instruction', label: 'Instruction' },
  { id: 'personal', label: 'Contexte personnel' },
  { id: 'fact', label: 'Information validée' },
  { id: 'summary', label: 'Résumé' },
  { id: 'document', label: 'Document' },
  { id: 'mission', label: 'Mission' },
]

function Conversations({ agent }: { agent: Agent }) {
  const conversations = useConversations(agent.id)
  const create = useAction('conversations.create', { onSuccess: (c) => navigate(`/chat/${agent.id}/${c.id}`) })
  if (conversations.data?.length === 0)
    return (
      <OrbitEmptyState
        appearance={agent.appearance}
        title={`Pas encore de conversation avec ${agent.name}`}
        body={agent.description ? `${agent.description} Posez une question, ou confiez directement une mission.` : 'Posez une question, ou confiez directement une mission.'}
        hints={abilities(agent)}
        action={<Button variant="primary" onClick={() => create.mutate({ agentId: agent.id })}><MessageCircle /> Nouvelle conversation</Button>}
        secondary={<Button variant="secondary" onClick={() => useUi.getState().openNewMission(agent.id)}><Rocket /> Confier une mission</Button>}
      />
    )
  return (
    <div className="space-y-px">
      {conversations.data?.map((c) => (
        <button key={c.id} onClick={() => navigate(`/chat/${agent.id}/${c.id}`)} className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-white/[0.03]">
          <MessageCircle className="size-4 text-fg-3" />
          <span className="flex-1 truncate text-[13.5px] text-fg">{c.title}</span>
          <span className="text-xs text-fg-3 tabular">{c.messageCount} msg · {relative(c.updatedAt)}</span>
        </button>
      ))}
    </div>
  )
}

function Missions({ agent }: { agent: Agent }) {
  const missions = useMissions(agent.id)
  if (missions.data?.length === 0)
    return <OrbitEmptyState appearance={agent.appearance} title="Aucune mission pour l’instant" body={`Confiez une première tâche à ${agent.name} : chaque étape s’affichera ici, avec ses demandes d’accord.`} hints={abilities(agent)} action={<Button variant="primary" onClick={() => useUi.getState().openNewMission(agent.id)}><Rocket /> Nouvelle mission</Button>} />
  return (
    <div className="space-y-px">
      {missions.data?.map((m) => (
        <button key={m.id} onClick={() => navigate(`/missions/${m.id}`)} className="grid w-full grid-cols-[56px_1fr_auto_180px] items-center gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-white/[0.03]">
          <span className="font-mono text-2xs text-fg-3">{m.shortId}</span>
          <span className="truncate text-[13.5px] text-fg">{m.title}</span>
          <PriorityGlyph priority={m.priority} />
          <span className="flex justify-end"><MissionStatusLabel status={m.status} /></span>
        </button>
      ))}
    </div>
  )
}

function Memory({ agent }: { agent: Agent }) {
  const memory = useMemory(agent.id)
  const [kind, setKind] = useState<MemoryKind>('fact')
  const [text, setText] = useState('')
  const [share, setShare] = useState(true)
  const create = useAction('memory.create', { onSuccess: () => setText('') })
  const update = useAction('memory.update')
  const remove = useAction('memory.delete')
  return (
    <div className="space-y-4">
      <div className="rounded-[12px] bg-white/[0.02] p-3 ring-1 ring-line">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={`Quelque chose que ${agent.name} doit retenir…`} className="min-h-16 bg-transparent shadow-none focus:shadow-none" />
        <div className="mt-2 flex items-center gap-3">
          <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} className="h-7 rounded-sm bg-elevated px-2 text-xs text-fg-2 ring-1 ring-line outline-none">
            {MEMORY_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-fg-2">
            <Switch checked={share} onChange={setShare} label="Envoyer au fournisseur" /> Inclure dans le contexte envoyé au fournisseur
          </label>
          <Button size="sm" variant="primary" className="ml-auto" disabled={!text.trim()} onClick={() => create.mutate({ agentId: agent.id, kind, content: text.trim(), includeInContext: share })}>
            <Plus /> Ajouter
          </Button>
        </div>
      </div>
      <p className="text-xs text-fg-3">Seuls les souvenirs marqués « contexte » sont transmis au fournisseur, jamais l’ensemble de la mémoire. Recherche textuelle locale ; la recherche sémantique viendra plus tard.</p>
      {memory.data?.length === 0 && <OrbitEmptyState compact title="Mémoire vide" />}
      <div className="space-y-1.5">
        {memory.data?.map((m) => (
          <div key={m.id} className="group flex items-start gap-3 rounded-[10px] bg-white/[0.02] px-3 py-2.5 ring-1 ring-line">
            <Brain className="mt-0.5 size-4 shrink-0 text-fg-3" />
            <div className="min-w-0 flex-1">
              <div className="selectable text-[13.5px] whitespace-pre-wrap text-fg">{m.content}</div>
              <div className="mt-1 flex items-center gap-2 text-2xs text-fg-3">
                <Badge>{MEMORY_KINDS.find((k) => k.id === m.kind)?.label}</Badge>
                {m.includeInContext ? <Badge tone="accent">Dans le contexte</Badge> : <Badge>Local uniquement</Badge>}
                {relative(m.updatedAt)}
              </div>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
              <Switch checked={m.includeInContext} onChange={(v) => update.mutate({ id: m.id, includeInContext: v })} label="Dans le contexte" />
              <Button size="icon-sm" variant="ghost" aria-label="Supprimer" onClick={() => remove.mutate({ id: m.id })}>
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const LEVEL_META: Record<EffectiveLevel, { label: string; tone: 'success' | 'warning' | 'neutral' | 'info' }> = {
  allowed: { label: 'Autorisé', tone: 'success' },
  ask: { label: 'Sur accord', tone: 'warning' },
  denied: { label: 'Bloqué', tone: 'neutral' },
  partial: { label: 'Partiel', tone: 'info' },
}
const LAYER_LABELS: Record<EffectivePermissionRow['enforcedBy'][number], string> = {
  policy: 'Politique Orbit',
  engine: 'Moteur',
  sandbox: 'Bac à sable du moteur',
  isolation: 'Isolation renforcée',
  approval: 'Votre accord',
}

function Tools({ agent }: { agent: Agent }) {
  const providers = useProviders()
  const security = useSecurity()
  const p = providers.data?.find((x) => x.id === agent.providerId)
  const proven = Boolean(security.data?.isolation.ok)
  const rows = effectivePermissions(agent, { isolationProven: proven })
  const engine = ENGINE_INFO[agent.providerId]
  return (
    <div className="space-y-4">
      <div className="rounded-[12px] bg-white/[0.02] p-4 ring-1 ring-line">
        <div className="flex items-center gap-2 text-[13.5px] text-fg">
          <Wrench className="size-4 text-fg-3" /> {engine.label} <span className="text-fg-3">· {engine.connection}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p &&
            (
              [
                ['streaming', 'Streaming'],
                ['cancel', 'Annulation'],
                ['tools', 'Outils'],
                ['sessions', 'Sessions reprenables'],
              ] as const
            ).map(([k, l]) => <Badge key={k} tone={p.capabilities[k] ? 'success' : 'neutral'}>{p.capabilities[k] ? '✓' : '—'} {l}</Badge>)}
          {p && <Badge tone="info">Usage : {p.capabilities.usage === 'official' ? 'jetons officiels' : p.capabilities.usage === 'estimated' ? 'estimé' : 'aucun'}</Badge>}
          <Badge tone={agent.isolation === 'strict' ? (proven ? 'success' : 'danger') : 'neutral'}>
            {agent.isolation === 'strict' ? (proven ? 'Isolation renforcée' : 'Isolation renforcée non prouvée') : 'Isolation standard'}
          </Badge>
        </div>
      </div>
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <div className="text-xs font-medium text-fg-2">Ce que {agent.name} peut réellement faire</div>
          <span className="text-2xs text-fg-4">Toutes les couches combinées</span>
        </div>
        <div className="divide-y divide-line rounded-[12px] bg-white/[0.02] ring-1 ring-line">
          {rows.map((r) => (
            <div key={r.key} className="grid grid-cols-[180px_1fr_auto] items-start gap-3 px-4 py-2.5">
              <span className="text-[13px] text-fg">
                {r.label}
                <span className="block text-2xs text-fg-4">{r.key === 'outside' || r.key === 'secrets' ? 'Garde-fou permanent' : `Réglage : ${r.companion ? 'activé' : 'désactivé'}`}</span>
              </span>
              <span className="text-[12px] leading-snug text-fg-3">
                {r.detail}
                <span className="mt-0.5 block text-2xs text-fg-4">Appliqué par : {r.enforcedBy.map((l) => LAYER_LABELS[l]).join(' · ')}</span>
              </span>
              <Badge tone={LEVEL_META[r.effective].tone}>{LEVEL_META[r.effective].label}</Badge>
            </div>
          ))}
        </div>
        <p className="mt-2 text-2xs leading-relaxed text-fg-4">
          Les approbations ponctuelles ne valent que pour une action. Aucune autorisation de session n’est mémorisée par Orbit : chaque nouvelle action sensible repasse par la politique.{' '}
          <button className="text-accent hover:underline" onClick={() => navigate('/settings/security')}>Sécurité et niveaux d’isolation</button>
        </p>
      </div>
    </div>
  )
}

function Files({ agent }: { agent: Agent }) {
  const files = useRecentFiles(agent.id)
  const [open, setOpen] = useState<string | null>(null)
  if (files.data?.length === 0)
    return <OrbitEmptyState compact title="Aucun fichier modifié" body={`Les fichiers créés, modifiés ou supprimés par ${agent.name} apparaîtront ici, avec leur diff et la mission associée.`} />
  return (
    <div className="space-y-px">
      {files.data?.map((f) => (
        <div key={f.id} className="rounded-[10px] hover:bg-white/[0.02]">
          <button onClick={() => setOpen(open === f.id ? null : f.id)} className="grid w-full grid-cols-[64px_1fr_auto] items-center gap-3 px-3 py-2 text-left">
            <FileKindBadge kind={f.kind} />
            <span className="min-w-0">
              <span className="block truncate font-mono text-[12.5px] text-fg">{f.path}</span>
              <span className="block truncate text-2xs text-fg-3">
                {f.missionShortId} · {f.missionTitle} · {f.source === 'engine' ? 'rapporté par le moteur' : 'détecté par instantané'}
              </span>
            </span>
            <span className="text-2xs text-fg-3 tabular">{relative(f.createdAt)}</span>
          </button>
          {open === f.id && (
            <div className="px-3 pb-3">
              {f.diff ? <pre className="selectable max-h-80 overflow-auto rounded-[10px] bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed text-fg-2 ring-1 ring-line">{f.diff}</pre> : <div className="text-xs text-fg-3">Diff indisponible pour ce fichier (binaire, trop volumineux ou supprimé).</div>}
              <button className="mt-1.5 text-xs text-accent hover:underline" onClick={() => navigate(`/missions/${f.missionId}`)}>Ouvrir la mission</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function FileKindBadge({ kind }: { kind: 'add' | 'update' | 'delete' }) {
  return <Badge tone={kind === 'add' ? 'success' : kind === 'delete' ? 'danger' : 'info'}>{kind === 'add' ? 'Créé' : kind === 'delete' ? 'Supprimé' : 'Modifié'}</Badge>
}

function Stats({ agent }: { agent: Agent }) {
  const usage = useUsage()
  const missions = useMissions(agent.id)
  const row = usage.data?.byAgentMonth.find((r) => r.agentId === agent.id)
  const mc = missionCounts(missions.data ?? [])
  const done = missions.data?.filter((m) => m.status === 'done') ?? []
  const avg = done.length ? done.reduce((s, m) => s + (m.finishedAt && m.startedAt ? new Date(m.finishedAt).getTime() - new Date(m.startedAt).getTime() : 0), 0) / done.length : null
  const tiles: [string, string, string | undefined][] = [
    ['Dépense du mois', row ? money(row.cost.official + row.cost.estimated) : money(0), row && row.cost.estimated > 0 ? 'dont estimé' : row?.cost.subscriptionCount ? `+ ${row.cost.subscriptionCount} req. incluses dans un abonnement` : undefined],
    ['Requêtes ce mois', integer(row?.requests ?? 0), row ? `${compactNumber(row.tokens)} jetons` : undefined],
    ['Missions', `${mc.done} / ${mc.total}`, `${mc.failed} échec${mc.failed > 1 ? 's' : ''} · ${mc.cancelled} annulée${mc.cancelled > 1 ? 's' : ''}`],
    ['Taux de réussite', mc.successRate == null ? '—' : `${Math.round(mc.successRate * 100)} %`, 'hors missions annulées'],
    ['Durée moyenne', avg != null ? duration(new Date(0).toISOString(), new Date(avg).toISOString()) : '—', undefined],
  ]
  return (
    <div className="grid grid-cols-5 divide-x divide-line rounded-[12px] ring-1 ring-line">
      {tiles.map(([label, value, hint]) => (
        <div key={label} className="min-w-0 px-4 py-3">
          <div className="eyebrow">{label}</div>
          <div className="mt-1.5 text-[22px] leading-7 font-semibold tracking-[-0.02em] text-fg tabular">{value}</div>
          {hint && <div className="truncate text-2xs text-fg-3">{hint}</div>}
        </div>
      ))}
    </div>
  )
}

function Config({ agent }: { agent: Agent }) {
  const machines = useMachines()
  const engine = ENGINE_INFO[agent.providerId]
  const machine = agent.runtime === 'remote' ? machines.data?.find((m) => m.id === agent.machineId) : null
  const rows: [string, React.ReactNode][] = [
    ['Moteur', engine.label],
    ['Mode de connexion', engine.connection],
    ['Facturation', engine.billing],
    ['Modèle', agent.model === 'default' ? 'Modèle par défaut du moteur' : agent.model],
    ['Effort de raisonnement', agent.effort ? (EFFORT_LEVELS.find((e) => e.id === agent.effort)?.label ?? agent.effort) : 'Par défaut'],
    ['Autonomie', { manual: 'Manuel', supervised: 'Supervisé', automated: 'Automatisé' }[agent.autonomy]],
    ['Isolation', agent.isolation === 'strict' ? 'Renforcée (Seatbelt Orbit)' : 'Standard (politique + bac à sable du moteur)'],
    ['Dossier de travail', agent.workingDirectory ?? '—'],
    ['Machine', machine ? `${machine.name} (distante)` : agent.runtime === 'remote' ? 'Machine distante introuvable' : 'Ce Mac'],
    ['Budget journalier', agent.dailyBudgetUsd != null ? money(agent.dailyBudgetUsd) : 'Illimité'],
    ['Créé', new Date(agent.createdAt).toLocaleString('fr-FR')],
  ]
  return (
    <div className="space-y-4">
      <div className="divide-y divide-line rounded-[12px] bg-white/[0.02] ring-1 ring-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13px]">
            <span className="shrink-0 text-fg-3">{k}</span>
            <span className="selectable truncate text-right text-fg">{v}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1.5 text-xs font-medium text-fg-2">Instructions permanentes</div>
        <pre className="selectable max-h-72 overflow-auto rounded-[12px] bg-white/[0.02] p-4 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-fg-2 ring-1 ring-line">{agent.instructions || '—'}</pre>
      </div>
      <Button variant="secondary" onClick={() => navigate(`/companions/${agent.id}/edit`)}>
        <Pencil /> Modifier la configuration
      </Button>
    </div>
  )
}

export function CompanionProfilePage({ agentId, tab }: { agentId: string; tab?: string }) {
  const { data: agent, isLoading } = useAgent(agentId)
  const providers = useProviders()
  const activity = useActivity({ agentId, limit: 50 })
  const missions = useMissions(agentId)
  const conversations = useConversations(agentId)
  const memory = useMemory(agentId)
  const usage = useUsage()
  const current = TABS.find((t) => t.key === tab)?.key ?? 'conversations'
  if (isLoading) return null
  if (!agent) return <Page><OrbitEmptyState title="Compagnon introuvable" body="Il a peut-être été supprimé." action={<Button variant="secondary" onClick={() => navigate('/companions')}>Voir tous les compagnons</Button>} /></Page>
  const provider = providers.data?.find((p) => p.id === agent.providerId)
  const running = missions.data?.find((m) => ACTIVE_MISSION_STATUSES.includes(m.status))
  const palette = PALETTES[agent.appearance.palette]
  const month = usage.data?.byAgentMonth.find((r) => r.agentId === agent.id)
  const done = missions.data?.filter((m) => m.status === 'done').length ?? 0
  const lastEvent = activity.data?.[0]
  const counts: Partial<Record<(typeof TABS)[number]['key'], number | undefined>> = {
    conversations: conversations.data?.length,
    missions: missions.data?.length,
    activity: activity.data?.length,
    memory: memory.data?.length,
  }
  const autonomy = { manual: 'Manuel', supervised: 'Supervisé', automated: 'Automatisé' }[agent.autonomy]
  const presence =
    running && running.startedAt
      ? `Travaille sur « ${running.title} » depuis ${duration(running.startedAt)}`
      : lastEvent
        ? `${STATUS_LABELS[agent.status]} · dernière activité ${relative(lastEvent.createdAt)}`
        : `${STATUS_LABELS[agent.status]} · aucune activité récente`
  const strip: [string, React.ReactNode, React.ReactNode?][] = [
    ['Missions', <>{done}<span className="text-[13px] font-normal text-fg-3"> / {missions.data?.length ?? 0}</span></>, 'terminées'],
    ['Conversations', conversations.data?.length ?? 0],
    ['Ce mois', money(month ? month.cost.official + month.cost.estimated : 0), month ? `${integer(month.requests)} requêtes` : 'aucune requête'],
    ['Mémoire', memory.data?.length ?? 0, `${memory.data?.filter((m) => m.includeInContext).length ?? 0} dans le contexte`],
  ]

  return (
    <Page>
      <section className="relative mb-5 overflow-hidden rounded-2xl ring-1 ring-line">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_16%_45%,#1d2030_0%,#13141b_60%,#111218_100%)]" />
        <div className="absolute inset-0" style={{ background: `radial-gradient(55% 90% at 12% 40%, ${palette.glow}24, transparent 70%)` }} />
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {Array.from({ length: 34 }, (_, i) => (
            <span key={i} className={cn('absolute size-px rounded-full bg-white', i % 7 === 0 && 'orbit-anim-twinkle')} style={{ left: `${(i * 41) % 100}%`, top: `${(i * 67) % 100}%`, opacity: 0.12 + ((i * 7) % 5) / 14, ['--o' as string]: 0.12 + ((i * 7) % 5) / 14, animationDelay: `${i * 0.3}s` }} />
          ))}
        </div>
        <div className="relative flex items-center gap-6 px-7 pt-5 pb-4">
          <CompanionAvatar appearance={agent.appearance} variant="profile" size={164} seed={agent.id} status={agent.status} animated className="-my-2" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.025em] text-fg">{agent.name}</h1>
              <span className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-[3px] text-xs text-fg-2 ring-1 ring-white/[0.05]">
                <CompanionStatusIndicator status={agent.status} size={7} ring="transparent" />
                {STATUS_LABELS[agent.status]}
              </span>
            </div>
            <div className="text-[15px] text-fg-2">{agent.role || 'Compagnon'}</div>
            {agent.description && <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-fg-3">{agent.description}</p>}
            <div className="mt-3 flex items-center gap-2 text-[12.5px]">
              <span className="relative flex size-2">
                {agent.status === 'working' && <span className="absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden" style={{ background: palette.accent }} />}
                <span className="relative size-2 rounded-full" style={{ background: agent.status === 'working' ? palette.accent : 'var(--color-fg-4)' }} />
              </span>
              {running ? (
                <button onClick={() => navigate(`/missions/${running.id}`)} className="truncate text-fg-2 hover:text-fg hover:underline">{presence}</button>
              ) : (
                <span className="truncate text-fg-3">{presence}</span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] text-fg-2">
              <Chip><ProviderMark id={agent.providerId} size={14} /> {provider?.name} <span className="text-fg-3">· {provider?.models.find((m) => m.id === agent.model)?.label ?? agent.model}</span></Chip>
              <Chip><Gauge /> {autonomy}</Chip>
              {agent.workingDirectory && <Chip title={agent.workingDirectory}><Folder /> <span className="max-w-[200px] truncate">{agent.workingDirectory.split('/').filter(Boolean).slice(-2).join('/')}</span></Chip>}
              <Chip><Wallet /> {agent.dailyBudgetUsd != null ? `${money(agent.dailyBudgetUsd)} / jour` : 'Budget illimité'}</Chip>
            </div>
          </div>
          <div className="no-drag flex gap-2 self-start">
            <Button variant="secondary" onClick={() => useUi.getState().openNewMission(agent.id)}>
              <Rocket /> Mission
            </Button>
            <Button variant="primary" onClick={() => navigate(`/chat/${agent.id}`)}>
              <MessageCircle /> Discuter
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8" aria-label="Plus d’actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => navigate(`/companions/${agent.id}/edit`)}>
                  <Pencil /> Modifier
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <CompanionContextItems agent={agent} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="relative grid grid-cols-4 divide-x divide-white/[0.06] border-t border-white/[0.06] bg-black/15">
          {strip.map(([label, value, hint]) => (
            <div key={label} className="flex items-baseline gap-2 px-7 py-2.5">
              <span className="eyebrow">{label}</span>
              <span className="text-[15px] font-semibold text-fg tabular">{value}</span>
              {hint && <span className="truncate text-[11.5px] text-fg-3">{hint}</span>}
            </div>
          ))}
        </div>
      </section>

      <Tabs
        className="no-drag mb-4"
        value={current}
        onChange={(k) => navigate(`/companions/${agent.id}/${k}`)}
        options={TABS.map((t) => ({ value: t.key, label: t.label, count: counts[t.key] }))}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_296px] items-start gap-4">
        <div className={cn('card min-h-[320px] p-2', (current === 'stats' || current === 'memory' || current === 'tools' || current === 'config') && 'p-5')}>
          {current === 'conversations' && <Conversations agent={agent} />}
          {current === 'missions' && <Missions agent={agent} />}
          {current === 'activity' && (activity.data?.length ? activity.data.map((e) => <ActivityEventRow key={e.id} event={e} agent={agent} />) : <OrbitEmptyState appearance={agent.appearance} compact title="Aucune activité" body={`Les actions de ${agent.name} apparaîtront ici en temps réel.`} />)}
          {current === 'memory' && <Memory agent={agent} />}
          {current === 'files' && <Files agent={agent} />}
          {current === 'tools' && <Tools agent={agent} />}
          {current === 'stats' && <Stats agent={agent} />}
          {current === 'config' && <Config agent={agent} />}
        </div>

        <aside className="space-y-3">
          <section className="card p-3.5">
            <div className="eyebrow mb-2">En ce moment</div>
            {running ? (
              <button onClick={() => navigate(`/missions/${running.id}`)} className="group block w-full rounded-[10px] bg-white/[0.03] p-2.5 text-left ring-1 ring-line transition-colors hover:bg-white/[0.05]">
                <div className="flex items-center gap-2">
                  <MissionStatusIcon status={running.status} className="size-3.5" />
                  <span className="text-[11px] text-fg-3 tabular">{running.shortId} · {duration(running.startedAt)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-fg">{running.title}</div>
              </button>
            ) : (
              <div className="text-[12.5px] leading-relaxed text-fg-3">
                {agent.enabled ? `${agent.name} est disponible et attend sa prochaine mission.` : `${agent.name} est désactivé.`}
              </div>
            )}
          </section>
          <section className="card p-1.5">
            <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
              <span className="eyebrow flex items-center gap-1.5"><Activity className="size-3" /> Récemment</span>
              {current !== 'activity' && (activity.data?.length ?? 0) > 0 && (
                <button onClick={() => navigate(`/companions/${agent.id}/activity`)} className="text-[11.5px] text-fg-3 hover:text-fg">Tout voir</button>
              )}
            </div>
            {activity.data?.length ? (
              <ol className="relative mx-2 mb-1.5 border-l border-line pl-3">
                {activity.data.slice(0, 4).map((e) => (
                  <li key={e.id} className="relative py-1.5">
                    <span className={cn('absolute top-[11px] -left-[16px] size-[7px] rounded-full ring-2 ring-surface', e.level === 'error' ? 'bg-danger' : e.level === 'warning' ? 'bg-warning' : e.level === 'success' ? 'bg-success' : 'bg-fg-4')} />
                    <div className="truncate text-[12.5px] text-fg">{e.title}</div>
                    <div className="truncate text-[11.5px] text-fg-3">{relative(e.createdAt)}{e.detail ? ` · ${e.detail}` : ''}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="px-2 pb-2 text-[12.5px] text-fg-3">Aucun événement pour l’instant.</div>
            )}
          </section>
          <TeamAndSchedule agent={agent} />
          <EffectiveSummary agent={agent} />
        </aside>
      </div>
    </Page>
  )
}

function TeamAndSchedule({ agent }: { agent: Agent }) {
  const defs = useConstellations()
  const automations = useAutomations()
  const missions = useMissions(agent.id)
  const mine = (defs.data ?? []).filter((d) => d.members.some((m) => m.agentId === agent.id))
  const planned = (automations.data ?? []).filter((a) => a.status === 'active' && (a.targetId === agent.id || mine.some((d) => d.id === a.targetId)))
  const sessions = (missions.data ?? []).filter((m) => m.sessionId && ACTIVE_MISSION_STATUSES.includes(m.status)).length
  const resumable = (missions.data ?? []).filter((m) => m.sessionId).length
  if (!mine.length && !planned.length && !resumable) return null
  return (
    <section className="card space-y-3 p-3.5 text-[12.5px]">
      {mine.length > 0 && (
        <div>
          <div className="eyebrow mb-1.5">Constellations</div>
          {mine.map((d) => (
            <button key={d.id} onClick={() => navigate('/constellations')} className="flex w-full items-center gap-2 py-0.5 text-left text-fg-2 hover:text-fg">
              <Waypoints className="size-3.5 text-accent" />
              <span className="flex-1 truncate">{d.name}</span>
              <span className="text-2xs text-fg-3">{d.coordinatorAgentId === agent.id ? 'coordination' : d.members.find((m) => m.agentId === agent.id)?.role}</span>
            </button>
          ))}
        </div>
      )}
      {planned.length > 0 && (
        <div>
          <div className="eyebrow mb-1.5">Missions planifiées</div>
          {planned.slice(0, 4).map((a) => (
            <button key={a.id} onClick={() => navigate('/automations')} className="flex w-full items-center gap-2 py-0.5 text-left text-fg-2 hover:text-fg">
              <CalendarClock className="size-3.5 text-fg-3" />
              <span className="flex-1 truncate">{a.name}</span>
              <span className="text-2xs text-fg-3">{relative(a.nextRunAt)}</span>
            </button>
          ))}
        </div>
      )}
      {resumable > 0 && (
        <div className="flex justify-between text-fg-3">
          <span>Sessions</span>
          <span className="text-fg-2 tabular">{sessions} active{sessions > 1 ? 's' : ''} · {resumable} reprenable{resumable > 1 ? 's' : ''}</span>
        </div>
      )}
    </section>
  )
}

function EffectiveSummary({ agent }: { agent: Agent }) {
  const security = useSecurity()
  const rows = effectivePermissions(agent, { isolationProven: Boolean(security.data?.isolation.ok) })
  return (
    <section className="card p-3.5">
      <button onClick={() => navigate(`/companions/${agent.id}/tools`)} className="eyebrow mb-2 flex w-full items-center gap-1.5 hover:text-fg-2">
        <ShieldCheck className="size-3" /> Permissions effectives
      </button>
      <div className="flex flex-wrap gap-1">
        {rows.map((r) => (
          <span
            key={r.key}
            title={r.detail}
            className={cn(
              'rounded-[6px] px-1.5 py-0.5 text-[11px]',
              r.effective === 'allowed' ? 'bg-success/10 text-success' : r.effective === 'ask' ? 'bg-warning/10 text-warning' : r.effective === 'partial' ? 'bg-accent-2/10 text-accent-2' : 'bg-white/[0.04] text-fg-4',
            )}
          >
            {r.label}
            {r.effective === 'ask' ? ' · accord' : r.effective === 'partial' ? ' · partiel' : r.effective === 'denied' ? ' · bloqué' : ''}
          </span>
        ))}
      </div>
    </section>
  )
}

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="flex h-6 items-center gap-1.5 rounded-[7px] bg-white/[0.045] px-2 ring-1 ring-white/[0.05] [&_svg]:size-3 [&_svg]:text-fg-3">
      {children}
    </span>
  )
}
