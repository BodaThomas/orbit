import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, CalendarClock, Check, ChevronRight, Cloud, Cpu, Fingerprint, Gauge, HardDrive, KeyRound, Laptop, Link2, Link2Off, MemoryStick, Plus, RefreshCw, Rocket, Server, ShieldCheck, SlidersHorizontal, Trash2, Users } from 'lucide-react'
import type { EngineStatus, MachineLimits } from '@shared/remote'
import type { RemoteMachine } from '@shared/types'
import { Page, PageHeader } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Label, Tabs } from '@/components/ui/field'
import { Dialog, DialogContent, Tooltip } from '@/components/ui/overlay'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { relative } from '@/lib/format'
import { useAction, useAgents, useAutomations, useMachines, useRemoteMachines } from '@/lib/queries'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { useConfirm } from '@/orbit/Confirm'
import { navigate } from '@/stores/router'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

const STATUS: Record<RemoteMachine['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent' }> = {
  new: { label: 'Nouvelle', tone: 'neutral' },
  pending_host_key: { label: 'Clé d’hôte à vérifier', tone: 'warning' },
  ready: { label: 'Prête', tone: 'accent' },
  online: { label: '● En ligne', tone: 'success' },
  offline: { label: 'Hors ligne', tone: 'neutral' },
  error: { label: 'Erreur', tone: 'danger' },
  revoked: { label: 'Révoquée', tone: 'neutral' },
}

const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} Go` : `${mb} Mo`)
const fmtUptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} j ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.max(1, Math.floor(s / 60))} min`)
const address = (m: RemoteMachine) => (m.transport === 'ssh' ? `${m.user ? `${m.user}@` : ''}${m.host}:${m.port}` : 'Runtime sur ce Mac (test)')

// Identity checks

function HostKeyCheck({ m }: { m: RemoteMachine }) {
  const [fp, setFp] = useState<{ fingerprint: string; algorithm: string } | null>(null)
  const [scanning, setScanning] = useState(false)
  const pin = useAction('runtime.confirmHostKey', { success: 'Clé d’hôte enregistrée' })
  const scan = async () => {
    setScanning(true)
    try {
      setFp(await call('runtime.scanHostKey', { id: m.id }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }
  return (
    <div className="rounded-[11px] bg-warning/[0.05] p-3 text-[12.5px] ring-1 ring-warning/20">
      <div className="flex items-center gap-2 text-fg"><KeyRound className="size-3.5 text-warning" /> Vérifiez l’identité du serveur (SSH)</div>
      <p className="mt-1 text-fg-3">Comparez avec l’empreinte affichée par votre hébergeur, ou par « ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub » sur le serveur. Orbit refusera toute autre clé ensuite.</p>
      {fp ? (
        <div className="mt-2 flex items-center gap-2">
          <code className="selectable flex-1 truncate rounded-[7px] bg-black/30 px-2 py-1 font-mono text-[11.5px] text-fg-2">{fp.algorithm} {fp.fingerprint}</code>
          <Button size="xs" variant="primary" disabled={pin.isPending} onClick={() => pin.mutate({ id: m.id, fingerprint: fp.fingerprint })}><ShieldCheck /> C’est la bonne</Button>
        </div>
      ) : (
        <Button size="xs" variant="secondary" className="mt-2" disabled={scanning} onClick={scan}>{scanning ? 'Lecture…' : 'Lire l’empreinte'}</Button>
      )}
    </div>
  )
}

function RuntimeIdentityCheck({ m }: { m: RemoteMachine }) {
  const confirmId = useAction('runtime.confirmIdentity', { success: (x) => `${x.name} est connectée` })
  const p = m.pendingRuntimeKey!
  return (
    <div className={cn('rounded-[11px] p-3 text-[12.5px] ring-1', p.changed ? 'bg-danger/[0.05] ring-danger/25' : 'bg-accent/[0.05] ring-accent/20')}>
      <div className="flex items-center gap-2 text-fg"><Fingerprint className={cn('size-3.5', p.changed ? 'text-danger' : 'text-accent')} /> {p.changed ? 'L’identité du runtime a changé' : 'Vérifiez l’identité du runtime'}</div>
      <p className="mt-1 text-fg-3">
        {p.changed ? 'Le runtime ne présente plus la clé que vous aviez validée. C’est normal seulement si vous l’avez réinstallé. Sinon, ne confirmez pas.' : 'Chaque runtime a sa propre clé. Comparez avec la sortie de « orbit-runtime doctor » ou le fichier identity/ sur le serveur.'}
        {' '}Commande : <code className="font-mono text-fg-2">orbit-runtime health</code>
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="selectable flex-1 truncate rounded-[7px] bg-black/30 px-2 py-1 font-mono text-[11.5px] text-fg-2">{p.runtimeId} · {p.fingerprint}</code>
        <Button size="xs" variant={p.changed ? 'danger' : 'primary'} disabled={confirmId.isPending} onClick={() => confirmId.mutate({ id: m.id, fingerprint: p.fingerprint })}><ShieldCheck /> {p.changed ? 'Faire confiance' : 'C’est le bon'}</Button>
      </div>
    </div>
  )
}

// Supervision

function Metric({ icon, label, value, sub, warn }: { icon: React.ReactNode; label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-[11px] bg-white/[0.025] px-3 py-2.5 ring-1 ring-line">
      <div className="flex items-center gap-1.5 text-[11px] text-fg-3 [&_svg]:size-3.5">{icon}{label}</div>
      <div className={cn('mt-1 truncate text-[15px] font-semibold tabular', warn ? 'text-warning' : 'text-fg')}>{value}</div>
      {sub && <div className="truncate text-[11px] text-fg-4">{sub}</div>}
    </div>
  )
}

function Resources({ m }: { m: RemoteMachine }) {
  const x = m.metrics
  if (!x) return <div className="rounded-[11px] bg-white/[0.02] px-3 py-2.5 text-[12px] text-fg-3 ring-1 ring-line">Ressources : mesurées dès la première connexion.</div>
  const memUsed = x.memory.totalMb - x.memory.freeMb
  const load = x.loadAvg ? x.loadAvg[0] / Math.max(1, x.cpus) : null
  return (
    <div>
      <div className="grid grid-cols-5 gap-2">
        <Metric icon={<Cpu />} label="Charge" value={x.loadAvg ? x.loadAvg[0].toFixed(2) : '—'} sub={`${x.cpus} cœurs`} warn={load != null && load > 0.9} />
        <Metric icon={<MemoryStick />} label="Mémoire" value={`${Math.round((memUsed / x.memory.totalMb) * 100)} %`} sub={`${fmtMb(memUsed)} / ${fmtMb(x.memory.totalMb)}`} warn={memUsed / x.memory.totalMb > 0.9} />
        <Metric icon={<HardDrive />} label="Disque libre" value={x.disk ? fmtMb(x.disk.freeMb) : '—'} sub={x.disk ? `sur ${fmtMb(x.disk.totalMb)}` : 'indisponible'} warn={Boolean(x.disk && x.disk.freeMb < 2048)} />
        <Metric icon={<Activity />} label="Processus" value={x.processes != null ? String(x.processes) : '—'} sub={`${x.engineProcesses} mission(s) active(s)`} />
        <Metric icon={<Gauge />} label="Runtime" value={fmtUptime(x.uptimeSec)} sub={`système ${fmtUptime(x.osUptimeSec)}`} />
      </div>
      <div className="mt-1 text-right text-[10.5px] text-fg-4">Mesuré {relative(x.at)}{m.status !== 'online' && ' · dernier état connu'}</div>
    </div>
  )
}

function EnginesList({ m }: { m: RemoteMachine }) {
  const [busy, setBusy] = useState(false)
  const engines = m.engines as (EngineStatus & { available: boolean })[]
  return (
    <div className="space-y-1.5">
      {engines.length === 0 && <div className="px-1 py-2 text-[12.5px] text-fg-3">Moteurs détectés à la connexion.</div>}
      {engines.map((e) => (
        <div key={e.id} className="flex items-start gap-3 rounded-[10px] bg-white/[0.02] px-3 py-2 ring-1 ring-line">
          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', e.available ? 'bg-success' : e.installed === false ? 'bg-fg-4' : 'bg-warning')} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-fg">
              {e.name ?? e.id}
              {e.version && <span className="font-mono text-[11px] text-fg-3">{e.version}</span>}
              {e.installed === false ? <Badge>Non installé</Badge> : e.available ? <Badge tone="success">Prêt</Badge> : e.authenticated === false ? <Badge tone="warning">Non connecté</Badge> : <Badge tone="warning">Indisponible</Badge>}
            </div>
            <div className="truncate text-[11.5px] text-fg-3" title={e.detail}>{e.detail}</div>
            {(e.capabilities?.length || e.restrictions?.length) ? <div className="mt-0.5 truncate text-[11px] text-fg-4">{[...(e.capabilities ?? []), ...(e.restrictions ?? [])].join(' · ')}</div> : null}
          </div>
        </div>
      ))}
      <p className="px-1 text-[11.5px] leading-relaxed text-fg-4">Connexion des moteurs : sur le serveur, par vous (« claude » puis /login, « codex login », ou « orbit-runtime secrets set anthropic »). Orbit ne copie jamais vos identifiants de ce Mac.</p>
      <Button
        size="xs"
        variant="ghost"
        disabled={busy || m.status !== 'online'}
        onClick={async () => {
          setBusy(true)
          try {
            await call('runtime.engines', { id: m.id, refresh: true })
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <RefreshCw className={cn(busy && 'animate-spin')} /> Actualiser
      </Button>
    </div>
  )
}

function SchedulerPanel({ m }: { m: RemoteMachine }) {
  const automations = useAutomations()
  const owned = (automations.data ?? []).filter((a) => a.schedulerOwner === m.id || a.pendingOwner === m.id)
  const h = m.health
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        <Metric icon={<CalendarClock />} label="Planificateur" value={h ? (h.scheduler.running ? 'Actif' : 'Arrêté') : '—'} sub={h?.scheduler.lastTickAt ? `passage ${relative(h.scheduler.lastTickAt)}` : undefined} warn={Boolean(h && !h.scheduler.running)} />
        <Metric icon={<CalendarClock />} label="Automatisations" value={String(m.activeAutomations)} sub="actives ici" />
        <Metric icon={<ChevronRight />} label="Prochaine" value={h?.scheduler.nextRunAt ? relative(h.scheduler.nextRunAt) : '—'} />
        <Metric icon={<AlertTriangle />} label="Échecs (24 h)" value={h ? String(h.scheduler.recentFailures) : '—'} warn={Boolean(h?.scheduler.recentFailures)} />
      </div>
      {owned.map((a) => (
        <button key={a.id} onClick={() => navigate('/automations')} className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-white/[0.03]">
          <CalendarClock className="size-3.5 text-fg-3" />
          <span className="flex-1 truncate text-fg-2">{a.name}</span>
          {a.ownerState === 'transferring' ? <Badge tone="warning">Transfert…</Badge> : a.status === 'active' ? <span className="text-fg-3">{a.nextRunAt ? relative(a.nextRunAt) : '—'}</span> : <Badge>En pause</Badge>}
        </button>
      ))}
      {owned.length === 0 && <p className="px-1 text-[12px] text-fg-3">Aucune automatisation planifiée sur ce serveur. Depuis Automatisations, « Lieu d’exécution » la confie au serveur.</p>}
    </div>
  )
}

function EventsPanel({ m }: { m: RemoteMachine }) {
  const events = useQuery({ queryKey: ['machines', 'events', m.id], queryFn: () => call('runtime.events', { id: m.id }) })
  const errors = m.health?.lastErrors ?? []
  const LABEL: Record<string, string> = { 'runtime.started': 'Runtime démarré', 'client.paired': 'Client appairé', 'client.revoked': 'Client révoqué', 'mission.timeout': 'Mission arrêtée (durée maximale)' }
  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <div className="rounded-[10px] bg-danger/[0.04] p-2.5 ring-1 ring-danger/15">
          <div className="mb-1 text-[12px] font-medium text-danger">Dernières erreurs du runtime</div>
          {errors.slice(-5).map((e) => <div key={e.at + e.message} className="truncate text-[11.5px] text-fg-3"><span className="text-fg-4">{relative(e.at)}</span> · {e.message}</div>)}
        </div>
      )}
      {(events.data ?? []).slice(0, 12).map((e) => (
        <div key={e.seq} className="flex items-center gap-2 px-1 text-[12.5px]">
          <span className="w-20 shrink-0 text-[11px] text-fg-4">{relative(e.at)}</span>
          <span className="truncate text-fg-2">{LABEL[e.kind] ?? e.kind}</span>
          {typeof e.data?.version === 'string' && <span className="font-mono text-[11px] text-fg-4">{e.data.version}</span>}
        </div>
      ))}
      {events.data?.length === 0 && errors.length === 0 && <p className="px-1 text-[12px] text-fg-3">Aucun évènement du runtime pour l’instant.</p>}
    </div>
  )
}

function SecurityPanel({ m }: { m: RemoteMachine }) {
  const clients = useQuery({ queryKey: ['machines', 'clients', m.id], queryFn: () => call('runtime.clients', { id: m.id }), enabled: m.status === 'online' })
  const [limits, setLimits] = useState<MachineLimits | null>(null)
  const save = useAction('runtime.setLimits', { success: 'Limites appliquées par le serveur' })
  useEffect(() => setLimits(m.limits ?? { maxConcurrentMissions: 2, maxMissionDurationMin: 120, dailyBudgetUsd: null, monthlyBudgetUsd: null }), [m.limits])
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-3 px-3 py-1.5 text-[12.5px]"><dt className="text-fg-3">{k}</dt><dd className="selectable min-w-0 truncate text-right font-mono text-[11.5px] text-fg-2">{v}</dd></div>
  )
  return (
    <div className="space-y-3">
      <dl className="divide-y divide-line rounded-[11px] bg-white/[0.02] ring-1 ring-line">
        {m.transport === 'ssh' && row('Clé d’hôte SSH', m.hostKeyFingerprint ?? 'non vérifiée')}
        {row('Identité du runtime', m.runtimeKeyFingerprint ? `${m.runtimeId} · ${m.runtimeKeyFingerprint}` : 'non vérifiée')}
        {row('Transport', m.transport === 'ssh' ? 'SSH (clé, hôte épinglé) → socket Unix 0600' : 'Socket Unix local')}
        {row('Protocole', m.protocol ? `v${m.protocol} · schéma ${m.schemaVersion ?? '—'}` : '—')}
      </dl>
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-fg"><Users className="size-3.5 text-fg-3" /> Clients appairés</div>
        {(clients.data ?? []).map((c) => (
          <div key={c.id} className="flex items-center gap-2 px-1 py-1 text-[12px]">
            <span className={cn('size-1.5 rounded-full', c.revoked_at ? 'bg-fg-4' : 'bg-success')} />
            <span className="text-fg-2">{c.name}{c.self && ' (ce Mac)'}</span>
            <code className="truncate font-mono text-[11px] text-fg-4">{c.fingerprint}</code>
            <span className="ml-auto shrink-0 text-[11px] text-fg-4">{c.revoked_at ? 'révoqué' : c.last_seen_at ? `vu ${relative(c.last_seen_at)}` : ''}</span>
          </div>
        ))}
        {m.status !== 'online' && <p className="px-1 text-[12px] text-fg-3">Connectez la machine pour voir ses clients.</p>}
      </div>
      {limits && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-fg"><SlidersHorizontal className="size-3.5 text-fg-3" /> Limites appliquées par le serveur</div>
          <div className="grid grid-cols-4 gap-2">
            <div><Label>Missions simultanées</Label><Input type="number" min={1} max={16} value={limits.maxConcurrentMissions} onChange={(e) => setLimits({ ...limits, maxConcurrentMissions: Math.max(1, Math.min(16, Number(e.target.value) || 1)) })} /></div>
            <div><Label>Durée max. (min)</Label><Input type="number" min={1} max={1440} value={limits.maxMissionDurationMin} onChange={(e) => setLimits({ ...limits, maxMissionDurationMin: Math.max(1, Math.min(1440, Number(e.target.value) || 1)) })} /></div>
            <div><Label hint="API">Budget / jour ($)</Label><Input type="number" min={0} value={limits.dailyBudgetUsd ?? ''} placeholder="Aucun" onChange={(e) => setLimits({ ...limits, dailyBudgetUsd: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></div>
            <div><Label hint="API">Budget / mois ($)</Label><Input type="number" min={0} value={limits.monthlyBudgetUsd ?? ''} placeholder="Aucun" onChange={(e) => setLimits({ ...limits, monthlyBudgetUsd: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></div>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <p className="flex-1 text-[11.5px] text-fg-4">Appliquées par le runtime à chaque mission, quoi que demande un client. Les abonnements n’ont pas de prix : seuls les coûts API mesurés ou estimés comptent.</p>
            <Button size="xs" variant="secondary" disabled={m.status !== 'online' || save.isPending} onClick={() => save.mutate({ id: m.id, limits })}><Check /> Appliquer</Button>
          </div>
        </div>
      )}
    </div>
  )
}

type Tab = 'overview' | 'engines' | 'scheduler' | 'events' | 'security'

function RemoteCard({ m }: { m: RemoteMachine }) {
  const agents = useAgents()
  const confirm = useConfirm()
  const [tab, setTab] = useState<Tab>('overview')
  const connect = useAction('runtime.connect', { success: (x) => `${x.name} est connectée` })
  const disconnect = useAction('runtime.disconnect')
  const revoke = useAction('runtime.revoke', { success: 'Machine révoquée' })
  const deploy = useAction('runtime.deploy', { success: 'Runtime installé' })
  const companions = (agents.data ?? []).filter((a) => a.runtime === 'remote' && a.machineId === m.id)
  const h = m.health
  const online = m.status === 'online'
  return (
    <section className="rounded-xl bg-surface p-5 ring-1 ring-line">
      <div className="flex items-center gap-3">
        <span className="relative flex size-10 items-center justify-center rounded-[11px] bg-white/[0.05]">
          {m.transport === 'ssh' ? <Server className="size-5 text-fg-2" /> : <Laptop className="size-5 text-fg-2" />}
          <span className={cn('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface', online ? 'bg-success' : m.status === 'error' ? 'bg-danger' : 'bg-fg-4')} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            {m.name}
            {m.runtimeVersion && <span className="font-mono text-[11px] font-normal text-fg-4">runtime {m.runtimeVersion}</span>}
          </div>
          <div className="truncate text-xs text-fg-3">
            {address(m)} · {online ? `battement ${relative(m.lastHeartbeatAt)}` : m.lastSyncedAt ? `dernier état connu, synchronisé ${relative(m.lastSyncedAt)}` : 'jamais connectée'}
            {m.info?.['Système'] && ` · ${m.info['Système']} ${m.info.Architecture ?? ''}`}
          </div>
        </div>
        {h && online && <Tooltip content={h.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`).join('\n')}><span><Badge tone={h.ready ? 'success' : 'warning'}>{h.ready ? 'Prêt' : 'Dégradé'}</Badge></span></Tooltip>}
        <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
      </div>

      <div className="mt-3 space-y-2">
        {m.lastError && !online && !m.pendingRuntimeKey && <div className="rounded-[10px] bg-danger/[0.05] px-3 py-2 text-[12px] text-danger ring-1 ring-danger/15">{m.lastError}</div>}
        {m.syncError && <div className="rounded-[10px] bg-warning/[0.05] px-3 py-2 text-[12px] text-warning ring-1 ring-warning/15">Synchronisation partielle : {m.syncError}</div>}
        {m.status === 'pending_host_key' && <HostKeyCheck m={m} />}
        {m.pendingRuntimeKey && <RuntimeIdentityCheck m={m} />}
      </div>

      {m.runtimeKeyFingerprint && (
        <>
          <Tabs
            className="mt-4"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'overview', label: 'Aperçu' },
              { value: 'engines', label: 'Moteurs', count: m.engines.filter((e) => e.available).length },
              { value: 'scheduler', label: 'Planificateur', count: m.activeAutomations },
              { value: 'events', label: 'Évènements', count: h?.lastErrors.length ?? null },
              { value: 'security', label: 'Sécurité' },
            ]}
          />
          <div className="pt-3">
            {tab === 'overview' && (
              <div className="space-y-3">
                <Resources m={m} />
                <div className="grid grid-cols-5 gap-2">
                  <Metric icon={<Rocket />} label="En cours" value={String(h?.missions.running ?? m.runningMissions)} />
                  <Metric icon={<CalendarClock />} label="En attente" value={String(h?.missions.queued ?? 0)} />
                  <Metric icon={<ShieldCheck />} label="Accords" value={String(m.pendingApprovals)} warn={m.pendingApprovals > 0} />
                  <Metric icon={<Check />} label="Terminées 24 h" value={h ? String(h.missions.done24h) : '—'} />
                  <Metric icon={<AlertTriangle />} label="Échecs 24 h" value={h ? String(h.missions.failed24h) : '—'} warn={Boolean(h?.missions.failed24h)} />
                </div>
                {companions.length > 0 ? (
                  <div className="flex items-center gap-2 text-[12px] text-fg-3">
                    <span className="flex -space-x-1.5">{companions.map((a) => <CompanionAvatar key={a.id} appearance={a.appearance} size={22} />)}</span>
                    {companions.map((a) => a.name).join(', ')} travaille{companions.length > 1 ? 'nt' : ''} ici
                  </div>
                ) : (
                  <p className="text-[12px] text-fg-3">Aucun compagnon placé ici. Dans le profil d’un compagnon : Modifier → Où travaille-t-il ?</p>
                )}
              </div>
            )}
            {tab === 'engines' && <EnginesList m={m} />}
            {tab === 'scheduler' && <SchedulerPanel m={m} />}
            {tab === 'events' && <EventsPanel m={m} />}
            {tab === 'security' && <SecurityPanel m={m} />}
          </div>
        </>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line pt-3">
        {online ? (
          <Button size="sm" variant="ghost" onClick={() => disconnect.mutate({ id: m.id })}><Link2Off /> Déconnecter</Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={m.status === 'pending_host_key' || connect.isPending} onClick={() => connect.mutate({ id: m.id })}><Link2 /> {connect.isPending ? 'Connexion…' : m.runtimeKeyFingerprint ? 'Se reconnecter' : 'Tester la connexion'}</Button>
        )}
        {m.transport === 'ssh' && m.status !== 'pending_host_key' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const plan = await call('runtime.deployPlan', { id: m.id })
              const ok = await confirm({ title: `Installer le runtime sur ${m.name} ?`, body: `Orbit exécutera exactement, par SSH :\n\n${plan.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nRien d’autre n’est installé ni modifié.`, confirm: 'Installer' })
              if (ok) deploy.mutate({ id: m.id })
            }}
          >
            <Rocket /> Installer / mettre à jour
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-danger"
          onClick={async () => {
            if (await confirm({ title: `Révoquer ${m.name} ?`, body: 'Orbit demande au runtime d’oublier ce Mac, se déconnecte et oublie la clé d’hôte et l’identité du runtime. L’historique déjà synchronisé reste consultable. Retirez aussi la clé SSH d’Orbit du fichier authorized_keys du serveur.', confirm: 'Révoquer', danger: true })) revoke.mutate({ id: m.id })
          }}
        >
          <Trash2 /> Révoquer
        </Button>
      </div>
    </section>
  )
}

// Wizard

const STEPS = ['Type', 'Connexion', 'Identité', 'Runtime', 'Moteurs', 'Confirmation']

function AddMachineWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const remote = useRemoteMachines()
  const [step, setStep] = useState(0)
  const [transport, setTransport] = useState<'ssh' | 'local'>('ssh')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('orbit')
  const [port, setPort] = useState(22)
  const [home, setHome] = useState('/var/lib/orbit/runtime')
  const [identityFile, setIdentityFile] = useState('')
  const [machineId, setMachineId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const m = remote.data?.find((x) => x.id === machineId) ?? null
  useEffect(() => {
    if (!open) {
      setStep(0)
      setMachineId(null)
    }
  }, [open])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const register = () =>
    run(async () => {
      const created = await call('runtime.register', { name: name.trim() || host.trim() || 'Runtime local', transport, host: transport === 'ssh' ? host.trim() : null, user: transport === 'ssh' && user.trim() ? user.trim() : null, port, runtimeHome: home.trim(), identityFile: transport === 'ssh' && identityFile.trim() ? identityFile.trim() : null })
      setMachineId(created.id)
      setStep(transport === 'ssh' ? 2 : 3)
    })
  const canNext = step === 0 || (step === 1 ? (transport === 'local' || host.trim()) && home.trim().startsWith('/') : step === 2 ? Boolean(m?.hostKeyFingerprint) : step === 3 ? Boolean(m?.runtimeKeyFingerprint && m.status === 'online') : true)
  const next = () => (step === 1 && !machineId ? register() : setStep((s) => Math.min(STEPS.length - 1, s + (step === 1 && transport === 'local' ? 2 : 1))))
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent title="Connecter une machine" description="Orbit se connecte par SSH avec votre clé, vérifie l’identité du serveur et celle de son runtime. Aucun service n’est exposé sur Internet, rien n’est installé sans votre accord." className="w-[620px]">
          <div className="px-5 pb-5">
            <ol className="mb-4 flex items-center gap-1 text-[11.5px]">
              {STEPS.map((s, i) => (
                <li key={s} className={cn('flex items-center gap-1', i === step ? 'text-fg' : i < step ? 'text-fg-3' : 'text-fg-4')}>
                  <span className={cn('flex size-[18px] items-center justify-center rounded-full text-[10px] tabular', i < step ? 'bg-accent/20 text-accent' : i === step ? 'bg-accent text-[#14112b]' : 'bg-white/[0.06]')}>{i < step ? <Check className="size-3" /> : i + 1}</span>
                  {s}
                  {i < STEPS.length - 1 && <ChevronRight className="size-3 text-fg-4" />}
                </li>
              ))}
            </ol>

            {step === 0 && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { v: 'ssh' as const, icon: <Cloud className="size-5" />, t: 'Serveur Linux / VPS', d: 'Le runtime s’exécute en continu, Mac éteint compris.' },
                  { v: 'local' as const, icon: <Laptop className="size-5" />, t: 'Runtime de test sur ce Mac', d: 'Pour essayer : s’arrête avec ce Mac.' },
                ].map((o) => (
                  <button key={o.v} type="button" aria-pressed={transport === o.v} onClick={() => setTransport(o.v)} className={cn('rounded-[12px] p-4 text-left', transport === o.v ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]')}>
                    <span className="text-fg-2">{o.icon}</span>
                    <div className="mt-2 text-[13.5px] font-medium text-fg">{o.t}</div>
                    <div className="mt-0.5 text-[12px] text-fg-3">{o.d}</div>
                  </button>
                ))}
              </div>
            )}

            {step === 1 && (
              <div className="space-y-3">
                <div><Label>Nom</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. VPS Hetzner" maxLength={60} /></div>
                {transport === 'ssh' && (
                  <div className="grid grid-cols-[1fr_140px_90px] gap-2">
                    <div><Label hint="Adresse Tailscale conseillée">Hôte</Label><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="vps.tailnet.ts.net" /></div>
                    <div><Label>Utilisateur</Label><Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="orbit" /></div>
                    <div><Label>Port</Label><Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} /></div>
                  </div>
                )}
                {transport === 'ssh' && <div><Label hint="Facultatif — sinon votre agent SSH">Clé SSH réservée à Orbit</Label><Input value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} placeholder="/Users/vous/.ssh/orbit_ed25519" className="font-mono" /></div>}
                <div><Label hint="Sur la machine, chemin absolu">Dossier du runtime</Label><Input value={home} onChange={(e) => setHome(e.target.value)} className="font-mono" /></div>
                <p className="text-xs leading-relaxed text-fg-3">Conseils : un utilisateur dédié sans droits administrateur (« orbit »), une clé SSH réservée à Orbit dans votre agent SSH, le port SSH accessible seulement par votre réseau privé (Tailscale). Installation pas à pas : docs/REMOTE_SETUP.md.</p>
              </div>
            )}

            {step === 2 && m && (m.hostKeyFingerprint ? <div className="flex items-center gap-2 rounded-[11px] bg-success/[0.05] p-3 text-[12.5px] text-fg ring-1 ring-success/20"><ShieldCheck className="size-4 text-success" /> Clé d’hôte vérifiée : <code className="truncate font-mono text-[11.5px] text-fg-2">{m.hostKeyFingerprint}</code></div> : <HostKeyCheck m={m} />)}

            {step === 3 && m && (
              <div className="space-y-2">
                {m.pendingRuntimeKey ? (
                  <RuntimeIdentityCheck m={m} />
                ) : m.runtimeKeyFingerprint && m.status === 'online' ? (
                  <div className="flex items-center gap-2 rounded-[11px] bg-success/[0.05] p-3 text-[12.5px] text-fg ring-1 ring-success/20"><ShieldCheck className="size-4 text-success" /> Runtime {m.runtimeVersion} vérifié et appairé · {m.info?.['Système']} {m.info?.Architecture}</div>
                ) : (
                  <>
                    <p className="text-[12.5px] text-fg-3">Orbit va se connecter au runtime, vérifier sa version de protocole et vous montrer son identité. S’il n’est pas encore installé, suivez docs/REMOTE_SETUP.md (installation système recommandée) ou utilisez « Installer » depuis la carte de la machine.</p>
                    {m.lastError && <div className="rounded-[10px] bg-danger/[0.05] px-3 py-2 text-[12px] text-danger ring-1 ring-danger/15">{m.lastError}</div>}
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => call('runtime.connect', { id: m.id }).catch((e: unknown) => { if (!(e instanceof Error && /empreinte|identité/i.test(e.message))) throw e }))}>
                      <Link2 /> {busy ? 'Connexion…' : 'Tester la connexion'}
                    </Button>
                  </>
                )}
              </div>
            )}

            {step === 4 && m && <EnginesList m={m} />}

            {step === 5 && m && (
              <div className="space-y-2 text-[12.5px]">
                <div className="flex items-center gap-2 text-fg"><Check className="size-4 text-success" /> {m.name} est prête.</div>
                <ul className="space-y-1 text-fg-3">
                  <li>• Identité SSH {m.hostKeyFingerprint ? 'vérifiée' : '— (runtime local)'} · identité du runtime vérifiée · ce Mac est appairé.</li>
                  <li>• {m.engines.filter((e) => e.available).length} moteur(s) prêt(s) : {m.engines.filter((e) => e.available).map((e) => e.name ?? e.id).join(', ') || 'aucun pour l’instant'}.</li>
                  <li>• Prochaine étape : placer un compagnon sur cette machine (profil → Modifier), puis lui confier une mission ou une automatisation.</li>
                </ul>
              </div>
            )}

            <div className="mt-5 flex items-center justify-between gap-2 border-t border-line pt-4">
              <span className="text-[11.5px] text-fg-4">{machineId && step < 5 ? 'Machine enregistrée : vous pouvez terminer plus tard depuis sa carte.' : ''}</span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>{step === 5 ? 'Fermer' : 'Annuler'}</Button>
                {step < 5 && <Button variant="primary" disabled={!canNext || busy} onClick={() => void next()}>{step === 1 && !machineId ? <><Plus /> Enregistrer</> : <>Continuer <ChevronRight /></>}</Button>}
                {step === 5 && <Button variant="primary" onClick={onClose}><Check /> Terminer</Button>}
              </div>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

// Page

export function MachinesPage() {
  const machines = useMachines()
  const remote = useRemoteMachines()
  const agents = useAgents()
  const [adding, setAdding] = useState(false)
  const list = remote.data ?? []
  const online = list.filter((m) => m.status === 'online').length
  return (
    <Page wide>
      <PageHeader
        title="Machines"
        subtitle={list.length ? `${online}/${list.length} serveur${list.length > 1 ? 's' : ''} en ligne · ${list.reduce((s, m) => s + m.remoteCompanions, 0)} compagnon(s) distant(s) · ${list.reduce((s, m) => s + m.activeAutomations, 0)} automatisation(s) sur serveur` : 'Où vos compagnons s’exécutent. Un serveur continue de travailler quand ce Mac est éteint.'}
        actions={
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus /> Connecter une machine
          </Button>
        }
      />
      <div className="grid grid-cols-1 items-start gap-4 min-[1280px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          {list.map((m) => <RemoteCard key={m.id} m={m} />)}
          {list.length === 0 && (
            <section className="rounded-xl border border-dashed border-line-strong p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-[11px] bg-white/[0.03]"><Cloud className="size-5 text-fg-3" /></span>
                <div>
                  <div className="text-[15px] font-medium text-fg-2">Aucun serveur</div>
                  <div className="text-xs text-fg-3">Serveur Linux ou VPS · via SSH</div>
                </div>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-fg-3">
                Installez « orbit-runtime » sur un serveur : vos compagnons y exécutent missions, constellations et automatisations même quand ce Mac est éteint. Orbit s’y connecte par SSH, vérifie l’identité du serveur et du runtime, puis retrouve tout l’historique à chaque reconnexion.
              </p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => setAdding(true)}><Plus /> Connecter une machine</Button>
            </section>
          )}
        </div>
        <div className="grid gap-4 max-[1279px]:grid-cols-2 min-[1280px]:space-y-4 min-[1280px]:grid-cols-1">
          {machines.data?.map((m) => (
            <section key={m.id} className="rounded-xl bg-surface p-4 ring-1 ring-line">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-[10px] bg-white/[0.05]"><Laptop className="size-[18px] text-fg-2" /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-fg">{m.name}</div>
                  <div className="truncate text-xs text-fg-3">{m.platform} · ce Mac</div>
                </div>
                <Badge tone="success">● En ligne</Badge>
              </div>
              <dl className="mt-3 divide-y divide-line rounded-[11px] bg-white/[0.02] ring-1 ring-line">
                {Object.entries(m.details).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 px-3 py-1.5 text-[12.5px]"><dt className="text-fg-3">{k}</dt><dd className="selectable truncate text-fg-2">{v}</dd></div>
                ))}
                <div className="flex justify-between px-3 py-1.5 text-[12.5px]"><dt className="text-fg-3">Compagnons</dt><dd className="text-fg-2">{(agents.data ?? []).filter((a) => a.runtime === 'local').length}</dd></div>
              </dl>
              <p className="mt-3 text-[11.5px] leading-relaxed text-fg-4">Ici, missions et automatisations ne tournent que si ce Mac est allumé et Orbit ouvert.</p>
            </section>
          ))}
          <section className="card p-4 text-[12.5px] leading-relaxed text-fg-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-fg"><ShieldCheck className="size-3.5" /> Comment Orbit protège la connexion</div>
            SSH avec votre clé et une clé d’hôte vérifiée · identité du runtime vérifiée par signature · ce Mac appairé avec sa propre clé, sessions limitées dans le temps et révocables · chaque commande a un identifiant unique, jamais exécutée deux fois · aucun port ouvert, aucun identifiant copié vers le serveur.
          </section>
        </div>
      </div>
      <AddMachineWizard open={adding} onClose={() => setAdding(false)} />
    </Page>
  )
}
