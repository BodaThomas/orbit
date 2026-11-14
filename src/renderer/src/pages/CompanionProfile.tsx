import { useState } from 'react'
import { Brain, MessageCircle, MoreHorizontal, Pencil, Plus, Rocket, Trash2, Wrench } from 'lucide-react'
import { PERMISSION_LABELS, STATUS_LABELS } from '@shared/catalog'
import type { Agent, AgentPermissions, MemoryKind } from '@shared/types'
import { Page } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Segmented, Switch, Textarea } from '@/components/ui/field'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { duration, integer, money, relative } from '@/lib/format'
import { useAction, useActivity, useAgent, useConversations, useMemory, useMissions, useProviders, useUsage } from '@/lib/queries'
import { ActivityEventRow } from '@/orbit/ActivityEvent'
import { CompanionAvatar, CompanionStatusIndicator } from '@/orbit/CompanionAvatar'
import { CompanionContextItems } from '@/orbit/CompanionListItem'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { MissionStatusLabel, PriorityGlyph } from '@/orbit/MissionStatus'
import { ProviderMark } from '@/orbit/ProviderMark'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

const TABS = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'missions', label: 'Missions' },
  { key: 'activity', label: 'Activité' },
  { key: 'memory', label: 'Mémoire' },
  { key: 'tools', label: 'Outils' },
  { key: 'stats', label: 'Statistiques' },
  { key: 'config', label: 'Configuration' },
] as const

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
    return <OrbitEmptyState title="Aucune conversation" body={`Commencez à discuter avec ${agent.name}.`} action={<Button variant="primary" onClick={() => create.mutate({ agentId: agent.id })}><MessageCircle /> Nouvelle conversation</Button>} />
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
    return <OrbitEmptyState title="Aucune mission" body={`Confiez une première mission à ${agent.name}.`} action={<Button variant="primary" onClick={() => useUi.getState().openNewMission(agent.id)}><Rocket /> Nouvelle mission</Button>} />
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

function Tools({ agent }: { agent: Agent }) {
  const providers = useProviders()
  const p = providers.data?.find((x) => x.id === agent.providerId)
  return (
    <div className="space-y-4">
      <div className="rounded-[12px] bg-white/[0.02] p-4 ring-1 ring-line">
        <div className="flex items-center gap-2 text-[13.5px] text-fg">
          <Wrench className="size-4 text-fg-3" /> Capacités du moteur
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p &&
            (
              [
                ['streaming', 'Streaming'],
                ['cancel', 'Annulation'],
                ['tools', 'Outils'],
                ['sessions', 'Sessions fournisseur'],
              ] as const
            ).map(([k, l]) => <Badge key={k} tone={p.capabilities[k] ? 'success' : 'neutral'}>{p.capabilities[k] ? '✓' : '—'} {l}</Badge>)}
          {p && <Badge tone="info">Usage : {p.capabilities.usage === 'official' ? 'jetons officiels' : p.capabilities.usage === 'estimated' ? 'estimé' : 'aucun'}</Badge>}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-fg-3">
          {p?.capabilities.tools
            ? 'Ce moteur peut appeler des outils. Chaque appel passe par le gestionnaire de permissions d’Orbit.'
            : `${p?.name ?? 'Ce fournisseur'} est utilisé ici en mode conversationnel, sans outils. Les outils fichiers et commandes arrivent avec l’adaptateur Claude Agent SDK, et seront soumis aux permissions ci-dessous.`}
        </p>
      </div>
      <div className="divide-y divide-line rounded-[12px] bg-white/[0.02] ring-1 ring-line">
        {(Object.keys(PERMISSION_LABELS) as (keyof AgentPermissions)[]).map((k) => (
          <div key={k} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-[13px] text-fg-2">{PERMISSION_LABELS[k].label}</span>
            <Badge tone={agent.permissions[k] ? (PERMISSION_LABELS[k].sensitive ? 'warning' : 'success') : 'neutral'}>{agent.permissions[k] ? 'Autorisé' : 'Refusé'}</Badge>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stats({ agent }: { agent: Agent }) {
  const usage = useUsage()
  const missions = useMissions(agent.id)
  const row = usage.data?.byAgentMonth.find((r) => r.agentId === agent.id)
  const done = missions.data?.filter((m) => m.status === 'done') ?? []
  const avg = done.length ? done.reduce((s, m) => s + (m.finishedAt && m.startedAt ? new Date(m.finishedAt).getTime() - new Date(m.startedAt).getTime() : 0), 0) / done.length : null
  const tiles = [
    ['Coût du mois', row ? money(row.cost.official + row.cost.estimated) : money(0), row && row.cost.estimated > 0 ? 'estimé' : undefined],
    ['Requêtes ce mois', integer(row?.requests ?? 0)],
    ['Missions terminées', integer(done.length)],
    ['Durée moyenne', avg != null ? duration(new Date(0).toISOString(), new Date(avg).toISOString()) : '—'],
  ] as const
  return (
    <div className="grid grid-cols-4 gap-3">
      {tiles.map(([label, value, hint]) => (
        <div key={label} className="rounded-[12px] bg-white/[0.02] p-4 ring-1 ring-line">
          <div className="text-xs text-fg-3">{label}</div>
          <div className="mt-1 text-[22px] font-semibold text-fg tabular">{value}</div>
          {hint && <div className="text-2xs text-fg-3">{hint}</div>}
        </div>
      ))}
    </div>
  )
}

function Config({ agent }: { agent: Agent }) {
  const rows: [string, React.ReactNode][] = [
    ['Autonomie', { manual: 'Manuel', supervised: 'Supervisé', automated: 'Automatisé' }[agent.autonomy]],
    ['Dossier de travail', agent.workingDirectory ?? '—'],
    ['Environnement', 'Ce Mac'],
    ['Budget journalier', agent.dailyBudgetUsd != null ? money(agent.dailyBudgetUsd) : 'Illimité'],
    ['Créé', new Date(agent.createdAt).toLocaleString('fr-FR')],
  ]
  return (
    <div className="space-y-4">
      <div className="divide-y divide-line rounded-[12px] bg-white/[0.02] ring-1 ring-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
            <span className="text-fg-3">{k}</span>
            <span className="selectable text-fg">{v}</span>
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
  const current = TABS.find((t) => t.key === tab)?.key ?? 'conversations'
  if (isLoading) return null
  if (!agent) return <Page><OrbitEmptyState title="Compagnon introuvable" body="Il a peut-être été supprimé." /></Page>
  const provider = providers.data?.find((p) => p.id === agent.providerId)
  const running = missions.data?.find((m) => m.status === 'running')

  return (
    <Page>
      <section className="relative mb-6 overflow-hidden rounded-2xl ring-1 ring-line">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_50%,#1d2030_0%,#13141b_60%,#111218_100%)]" />
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {Array.from({ length: 30 }, (_, i) => (
            <span key={i} className="absolute size-px rounded-full bg-white" style={{ left: `${(i * 41) % 100}%`, top: `${(i * 67) % 100}%`, opacity: 0.12 + ((i * 7) % 5) / 14 }} />
          ))}
        </div>
        <div className="relative flex items-center gap-7 px-8 py-6">
          <CompanionAvatar appearance={agent.appearance} variant="profile" size={190} seed={agent.id} status={agent.status} animated />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.02em] text-fg">{agent.name}</h1>
              <span className="flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-xs text-fg-2">
                <CompanionStatusIndicator status={agent.status} size={7} ring="transparent" />
                {STATUS_LABELS[agent.status]}
              </span>
            </div>
            <div className="mt-0.5 text-[15px] text-fg-2">{agent.role || 'Compagnon'}</div>
            {agent.description && <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-fg-3">{agent.description}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-fg-2">
              <span className="flex items-center gap-2">
                <ProviderMark id={agent.providerId} size={18} /> {provider?.name}
              </span>
              <span className="text-fg-3">{provider?.models.find((m) => m.id === agent.model)?.label ?? agent.model}</span>
              {running && (
                <button onClick={() => navigate(`/missions/${running.id}`)} className="flex items-center gap-1.5 text-accent hover:underline">
                  <Rocket className="size-3.5" /> {running.title} · {duration(running.startedAt)}
                </button>
              )}
            </div>
          </div>
          <div className="no-drag flex flex-col items-end gap-2 self-start">
            <div className="flex gap-2">
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
        </div>
      </section>

      <div className="no-drag mb-5">
        <Segmented
          value={current}
          onChange={(k) => navigate(`/companions/${agent.id}/${k}`)}
          options={TABS.map((t) => ({ value: t.key, label: t.label }))}
        />
      </div>

      <div className={cn('rounded-xl bg-surface p-3 ring-1 ring-line', (current === 'stats' || current === 'memory' || current === 'tools' || current === 'config') && 'p-5')}>
        {current === 'conversations' && <Conversations agent={agent} />}
        {current === 'missions' && <Missions agent={agent} />}
        {current === 'activity' && (activity.data?.length ? activity.data.map((e) => <ActivityEventRow key={e.id} event={e} agent={agent} />) : <OrbitEmptyState compact title="Aucune activité" />)}
        {current === 'memory' && <Memory agent={agent} />}
        {current === 'tools' && <Tools agent={agent} />}
        {current === 'stats' && <Stats agent={agent} />}
        {current === 'config' && <Config agent={agent} />}
      </div>
    </Page>
  )
}
