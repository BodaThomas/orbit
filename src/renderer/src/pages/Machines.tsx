import { useState } from 'react'
import { Cloud, KeyRound, Laptop, Link2, Link2Off, Plus, Rocket, Server, ShieldCheck, Trash2 } from 'lucide-react'
import type { RemoteMachine } from '@shared/types'
import { Page, PageHeader } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Label, Segmented } from '@/components/ui/field'
import { Dialog, DialogContent } from '@/components/ui/overlay'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { relative } from '@/lib/format'
import { useAction, useAgents, useMachines, useRemoteMachines } from '@/lib/queries'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { useConfirm } from '@/orbit/Confirm'

const STATUS: Record<RemoteMachine['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent' }> = {
  new: { label: 'Nouvelle', tone: 'neutral' },
  pending_host_key: { label: 'Clé d’hôte à vérifier', tone: 'warning' },
  ready: { label: 'Prête', tone: 'accent' },
  online: { label: '● En ligne', tone: 'success' },
  offline: { label: 'Hors ligne', tone: 'neutral' },
  error: { label: 'Erreur', tone: 'danger' },
  revoked: { label: 'Révoquée', tone: 'neutral' },
}

function AddMachineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [transport, setTransport] = useState<'ssh' | 'local'>('ssh')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState(22)
  const [home, setHome] = useState('~/.orbit-runtime')
  const register = useAction('runtime.register', { success: (m) => `${m.name} ajoutée`, onSuccess: onClose })
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent title="Ajouter une machine" description="Orbit se connecte uniquement par SSH, avec votre clé et une clé d’hôte que vous vérifiez. Aucun service n’est exposé sur Internet." className="w-[560px]">
          <form
            className="space-y-4 px-5 pb-5"
            onSubmit={(e) => {
              e.preventDefault()
              register.mutate({ name: name.trim() || host, transport, host: transport === 'ssh' ? host.trim() : null, user: transport === 'ssh' && user.trim() ? user.trim() : null, port, runtimeHome: home.trim() })
            }}
          >
            <Segmented value={transport} onChange={setTransport} options={[{ value: 'ssh', label: 'Serveur Linux (SSH)' }, { value: 'local', label: 'Runtime sur ce Mac (test)' }]} />
            <div>
              <Label>Nom</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. VPS Hetzner" maxLength={60} />
            </div>
            {transport === 'ssh' && (
              <div className="grid grid-cols-[1fr_140px_90px] gap-2">
                <div>
                  <Label>Hôte</Label>
                  <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="vps.exemple.fr" />
                </div>
                <div>
                  <Label>Utilisateur</Label>
                  <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="orbit" />
                </div>
                <div>
                  <Label>Port</Label>
                  <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} />
                </div>
              </div>
            )}
            <div>
              <Label hint="Sur la machine">Dossier du runtime</Label>
              <Input value={home} onChange={(e) => setHome(e.target.value)} className="font-mono" />
            </div>
            <p className="text-xs leading-relaxed text-fg-3">
              Conseil : un utilisateur dédié sans droits administrateur, une clé SSH réservée à Orbit (dans votre agent SSH), et les connexions de Codex ou Claude Code faites par vous sur le serveur. Orbit ne transmet jamais vos clés API ni vos identifiants à la machine.
            </p>
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={onClose}>Annuler</Button>
              <Button type="submit" variant="primary" disabled={(transport === 'ssh' && !host.trim()) || !home.trim() || register.isPending}>
                <Plus /> Ajouter
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}

function RemoteCard({ m }: { m: RemoteMachine }) {
  const agents = useAgents()
  const confirm = useConfirm()
  const [fp, setFp] = useState<{ fingerprint: string; algorithm: string } | null>(null)
  const [scanning, setScanning] = useState(false)
  const pin = useAction('runtime.confirmHostKey', { success: 'Clé d’hôte enregistrée' })
  const connect = useAction('runtime.connect', { success: (x) => `${x.name} est connectée` })
  const disconnect = useAction('runtime.disconnect')
  const revoke = useAction('runtime.revoke', { success: 'Machine révoquée' })
  const deploy = useAction('runtime.deploy', { success: 'Runtime installé' })
  const companions = (agents.data ?? []).filter((a) => a.machineId === m.id)
  const scan = async () => {
    setScanning(true)
    try {
      setFp(await call('runtime.scanHostKey', { id: m.id }))
    } finally {
      setScanning(false)
    }
  }
  return (
    <section className="rounded-xl bg-surface p-5 ring-1 ring-line">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-[11px] bg-white/[0.05]">{m.transport === 'ssh' ? <Server className="size-5 text-fg-2" /> : <Laptop className="size-5 text-fg-2" />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-fg">{m.name}</div>
          <div className="truncate text-xs text-fg-3">
            {m.transport === 'ssh' ? `${m.user ? `${m.user}@` : ''}${m.host}:${m.port}` : 'Runtime local (test)'} · {m.lastHeartbeatAt ? `battement ${relative(m.lastHeartbeatAt)}` : 'jamais connectée'}
          </div>
        </div>
        <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
      </div>
      {m.lastError && m.status !== 'online' && <div className="mt-3 rounded-[10px] bg-danger/[0.05] px-3 py-2 text-[12px] text-danger ring-1 ring-danger/15">{m.lastError}</div>}
      {m.status === 'pending_host_key' && (
        <div className="mt-3 rounded-[11px] bg-warning/[0.05] p-3 text-[12.5px] ring-1 ring-warning/20">
          <div className="flex items-center gap-2 text-fg"><KeyRound className="size-3.5 text-warning" /> Vérifiez l’identité de la machine</div>
          <p className="mt-1 text-fg-3">Comparez l’empreinte ci-dessous avec celle affichée par votre hébergeur ou par « ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub » sur le serveur. Orbit refusera toute autre clé ensuite.</p>
          {fp ? (
            <div className="mt-2 flex items-center gap-2">
              <code className="selectable flex-1 truncate rounded-[7px] bg-black/30 px-2 py-1 font-mono text-[11.5px] text-fg-2">{fp.algorithm} {fp.fingerprint}</code>
              <Button size="xs" variant="primary" onClick={() => pin.mutate({ id: m.id, fingerprint: fp.fingerprint })}><ShieldCheck /> C’est la bonne</Button>
            </div>
          ) : (
            <Button size="xs" variant="secondary" className="mt-2" disabled={scanning} onClick={scan}>{scanning ? 'Lecture…' : 'Lire l’empreinte'}</Button>
          )}
        </div>
      )}
      {m.info && (
        <dl className="mt-4 divide-y divide-line rounded-[11px] bg-white/[0.02] ring-1 ring-line">
          {Object.entries(m.info).map(([k, v]) => (
            <div key={k} className="flex justify-between px-3.5 py-1.5 text-[12.5px]"><dt className="text-fg-3">{k}</dt><dd className="selectable text-fg-2">{v}</dd></div>
          ))}
          <div className="flex justify-between px-3.5 py-1.5 text-[12.5px]"><dt className="text-fg-3">Runtime</dt><dd className="text-fg-2">{m.runtimeVersion} · protocole {m.protocol}</dd></div>
          <div className="flex justify-between gap-3 px-3.5 py-1.5 text-[12.5px]">
            <dt className="text-fg-3">Moteurs</dt>
            <dd className="flex flex-wrap justify-end gap-1">{m.engines.map((e) => <Badge key={e.id} tone={e.available ? 'success' : 'neutral'}>{e.id === 'echo' ? 'test' : e.id}{e.available ? '' : ' · indisponible'}</Badge>)}</dd>
          </div>
          <div className="flex justify-between px-3.5 py-1.5 text-[12.5px]"><dt className="text-fg-3">Missions en cours</dt><dd className="text-fg-2 tabular">{m.runningMissions}</dd></div>
        </dl>
      )}
      {companions.length > 0 && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-fg-3">
          <span className="flex -space-x-1.5">{companions.map((a) => <CompanionAvatar key={a.id} appearance={a.appearance} size={20} />)}</span>
          {companions.map((a) => a.name).join(', ')} travaille{companions.length > 1 ? 'nt' : ''} ici
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {m.status === 'online' ? (
          <Button size="sm" variant="ghost" onClick={() => disconnect.mutate({ id: m.id })}><Link2Off /> Déconnecter</Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={m.status === 'pending_host_key' || connect.isPending} onClick={() => connect.mutate({ id: m.id })}><Link2 /> {connect.isPending ? 'Connexion…' : 'Se connecter'}</Button>
        )}
        {m.transport === 'ssh' && m.status !== 'pending_host_key' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const plan = await call('runtime.deployPlan', { id: m.id })
              const ok = await confirm({ title: `Installer le runtime sur ${m.name} ?`, body: `Orbit exécutera exactement :\n\n${plan.map((c, i) => `${i + 1}. ${c}`).join('\n')}`, confirm: 'Installer' })
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
            if (await confirm({ title: `Révoquer ${m.name} ?`, body: 'Orbit se déconnecte et oublie la clé d’hôte. Pour révoquer complètement l’accès, retirez aussi la clé SSH d’Orbit du fichier authorized_keys du serveur.', confirm: 'Révoquer', danger: true })) revoke.mutate({ id: m.id })
          }}
        >
          <Trash2 /> Révoquer
        </Button>
      </div>
    </section>
  )
}

export function MachinesPage() {
  const machines = useMachines()
  const remote = useRemoteMachines()
  const agents = useAgents()
  const [adding, setAdding] = useState(false)
  return (
    <Page>
      <PageHeader
        title="Machines"
        subtitle="Où vos compagnons s’exécutent. Une machine distante continue de travailler quand ce Mac est éteint."
        actions={
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus /> Ajouter une machine
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-4">
        {machines.data?.map((m) => (
          <section key={m.id} className="rounded-xl bg-surface p-5 ring-1 ring-line">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-[11px] bg-white/[0.05]"><Laptop className="size-5 text-fg-2" /></span>
              <div className="flex-1">
                <div className="text-[15px] font-semibold text-fg">{m.name}</div>
                <div className="text-xs text-fg-3">{m.platform} · battement {relative(m.lastHeartbeatAt)}</div>
              </div>
              <Badge tone="success">● En ligne</Badge>
            </div>
            <dl className="mt-4 divide-y divide-line rounded-[11px] bg-white/[0.02] ring-1 ring-line">
              {Object.entries(m.details).map(([k, v]) => (
                <div key={k} className="flex justify-between px-3.5 py-1.5 text-[12.5px]"><dt className="text-fg-3">{k}</dt><dd className="selectable text-fg-2">{v}</dd></div>
              ))}
              <div className="flex justify-between px-3.5 py-1.5 text-[12.5px]"><dt className="text-fg-3">Compagnons</dt><dd className="text-fg-2">{(agents.data ?? []).filter((a) => a.runtime === 'local').length}</dd></div>
            </dl>
          </section>
        ))}
        {remote.data?.map((m) => <RemoteCard key={m.id} m={m} />)}
        {remote.data?.length === 0 && (
          <section className={cn('rounded-xl border border-dashed border-line-strong p-5')}>
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-[11px] bg-white/[0.03]"><Cloud className="size-5 text-fg-3" /></span>
              <div>
                <div className="text-[15px] font-medium text-fg-2">Machines distantes</div>
                <div className="text-xs text-fg-3">Serveur Linux ou VPS · via SSH</div>
              </div>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-fg-3">
              Installez « orbit-runtime » sur un serveur : vos compagnons y exécutent leurs missions et leurs automatisations même quand ce Mac est éteint. Orbit s’y connecte par SSH (clé d’hôte vérifiée), reçoit les événements et retrouve les résultats à la reconnexion. C’est aussi le mode d’isolation forte : le compagnon n’a accès à rien de ce Mac.
            </p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => setAdding(true)}><Plus /> Ajouter une machine</Button>
          </section>
        )}
      </div>
      <AddMachineDialog open={adding} onClose={() => setAdding(false)} />
    </Page>
  )
}
