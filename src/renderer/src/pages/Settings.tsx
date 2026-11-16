import { useState } from 'react'
import { Bell, CheckCircle2, Database, Eye, EyeOff, XCircle, FlaskConical, Info, KeyRound, ShieldCheck, SlidersHorizontal, Wallet } from 'lucide-react'
import type { ProviderInfo } from '@shared/types'
import { Page, PageHeader } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Segmented, Switch } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { dateTime, relative } from '@/lib/format'
import { useQueryClient } from '@tanstack/react-query'
import { call } from '@/lib/api'
import { useDemoModeToggle } from '@/lib/demo-mode'
import { useAction, useAudit, useBootstrap, useNotifications, useProviders, useSecurity } from '@/lib/queries'
import { AutoActionLog, GrantList } from '@/orbit/PermissionPanels'
import { ProviderMark } from '@/orbit/ProviderMark'
import { ClaudeCodeConnection } from '@/orbit/ClaudeCodeConnection'
import { navigate } from '@/stores/router'
import { toast } from 'sonner'

const SECTIONS = [
  { key: 'general', label: 'Général', icon: SlidersHorizontal },
  { key: 'providers', label: 'Fournisseurs', icon: KeyRound },
  { key: 'budgets', label: 'Budgets', icon: Wallet },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'security', label: 'Sécurité & audit', icon: ShieldCheck },
  { key: 'data', label: 'Données & démo', icon: Database },
  { key: 'about', label: 'À propos', icon: Info },
] as const

function Row({ title, body, children }: { title: string; body?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div>
        <div className="text-[13.5px] text-fg">{title}</div>
        {body && <div className="mt-0.5 text-xs text-fg-3">{body}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={cn('divide-y divide-line rounded-xl bg-surface ring-1 ring-line', className)}>{children}</div>

export function ProviderConnect({ provider, compact }: { provider: ProviderInfo; compact?: boolean }) {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const save = useAction('providers.setKey', { success: `${provider.name} connecté — clé enregistrée dans le Trousseau`, onSuccess: () => setKey('') })
  const remove = useAction('providers.removeKey', { success: 'Clé supprimée' })
  const validate = useAction('providers.validate', { success: (r) => (r.ok ? 'Connexion vérifiée' : `Échec : ${r.error}`) })
  const planned = provider.availability !== 'available'
  return (
    <div className={cn('px-4', compact ? 'py-3' : 'py-4')}>
      <div className="flex items-center gap-3">
        <ProviderMark id={provider.id} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium text-fg">
            {provider.name}
            {planned ? (
              <Badge>Bientôt</Badge>
            ) : provider.capabilities.kind === 'agent' ? (
              <>
                <Badge tone="accent">Moteur agent</Badge>
                {provider.connected ? <Badge tone="success">Prêt</Badge> : <Badge tone="warning">À vérifier</Badge>}
              </>
            ) : provider.connected ? (
              <Badge tone="success">Connecté</Badge>
            ) : provider.hasSecret ? (
              <Badge tone="danger">Erreur</Badge>
            ) : (
              <Badge tone="warning">Non connecté</Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs leading-snug text-fg-3">{provider.notes}</div>
        </div>
      </div>
      {!planned && provider.capabilities.kind === 'agent' && (
        <div className="mt-3 flex items-center gap-3 pl-10">
          <span className={cn('text-xs leading-snug', provider.connected ? 'text-fg-2' : 'text-warning')}>
            {provider.statusDetail ?? 'État inconnu : lancez une vérification.'}
            {provider.lastValidatedAt && <span className="text-fg-4"> · vérifié {relative(provider.lastValidatedAt)}</span>}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto shrink-0" disabled={validate.isPending} onClick={() => validate.mutate({ providerId: provider.id })}>
            {validate.isPending ? 'Vérification…' : 'Vérifier'}
          </Button>
        </div>
      )}
      {!planned && provider.id !== 'demo' && provider.capabilities.kind !== 'agent' && (
        <div className="mt-3 pl-10">
          {provider.hasSecret ? (
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-white/[0.04] px-2.5 py-1.5 font-mono text-xs text-fg-2 ring-1 ring-line">{provider.secretHint}</span>
              <span className="text-xs text-fg-3">{provider.lastValidatedAt ? `vérifiée ${relative(provider.lastValidatedAt)}` : ''}</span>
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="ghost" disabled={validate.isPending} onClick={() => validate.mutate({ providerId: provider.id })}>Vérifier</Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate({ providerId: provider.id })}>Supprimer</Button>
              </div>
            </div>
          ) : null}
          <form
            className={cn('flex gap-2', provider.hasSecret && 'mt-2')}
            onSubmit={(e) => {
              e.preventDefault()
              if (key.trim()) save.mutate({ providerId: provider.id, apiKey: key.trim() })
            }}
          >
            <div className="relative flex-1">
              <Input
                type={show ? 'text' : 'password'}
                value={key}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setKey(e.target.value)}
                placeholder={provider.hasSecret ? 'Remplacer la clé API' : 'Clé API'}
                className="pr-8 font-mono"
              />
              <button type="button" onClick={() => setShow((s) => !s)} className="absolute top-1/2 right-2 -translate-y-1/2 text-fg-3 hover:text-fg" aria-label={show ? 'Masquer' : 'Afficher'}>
                {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            <Button type="submit" variant="primary" disabled={!key.trim() || save.isPending}>
              {save.isPending ? 'Vérification…' : 'Connecter'}
            </Button>
          </form>
          <p className="mt-1.5 text-2xs text-fg-4">La clé est vérifiée auprès du fournisseur puis chiffrée via le Trousseau macOS. Elle ne quitte jamais le processus principal d’Orbit.</p>
        </div>
      )}
    </div>
  )
}

const SECURITY_LAYERS: Record<string, string> = { policy: 'Politique', engine: 'Moteur', isolation: 'Isolation', approval: 'Vous', grant: 'Autorisation' }

function securityDecision(action: string, decision: string): { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' } {
  // Revocations are stored as `deny` but nothing was blocked: the user withdrew a grant.
  if (action === 'grant.revoke') return { label: 'révoquée', tone: 'neutral' }
  switch (decision) {
    case 'deny':
      return { label: 'bloqué', tone: 'danger' }
    case 'denied':
      return { label: 'refusé', tone: 'danger' }
    case 'ask':
      return { label: 'demandé', tone: 'warning' }
    case 'approved':
      return { label: 'approuvé', tone: 'success' }
    case 'allow':
      return { label: 'autorisé', tone: 'success' }
    case 'auto':
      return { label: 'sans confirmation', tone: 'success' }
    default:
      return { label: decision, tone: 'neutral' }
  }
}

const AUDIT_ACTORS: Record<string, string> = { user: 'Vous', agent: 'Compagnon', system: 'Orbit' }
const AUDIT_ACTIONS: Record<string, string> = {
  'agent.delete': 'Compagnon supprimé',
  'agent.update': 'Compagnon modifié',
  'app.launchAtLogin': 'Ouverture à la connexion',
  'approval.approve': 'Approbation accordée',
  'approval.deny': 'Approbation refusée',
  'automation.create': 'Automatisation créée',
  'automation.pause': 'Automatisation en pause',
  'automation.resume': 'Automatisation reprise',
  'automation.transfer': 'Automatisation transférée',
  claudeLocalLogs: 'Journaux locaux de Claude',
  'constellation.create': 'Constellation créée',
  'constellation.limits': 'Limites de constellation',
  'constellation.plan.approve': 'Plan approuvé',
  'engine.test': 'Test du moteur',
  'grant.always': 'Autorisation permanente',
  'grant.mission': 'Autorisation pour la mission',
  'grant.revoke': 'Autorisation révoquée',
  'machine.deploy': 'Runtime installé',
  'machine.pair': 'Machine appairée',
  'machine.pinHostKey': 'Clé d’hôte épinglée',
  'machine.pinRuntimeIdentity': 'Identité du runtime confirmée',
  'machine.register': 'Machine ajoutée',
  'machine.revoke': 'Machine révoquée',
  'provider.removeKey': 'Clé API retirée',
  'provider.setKey': 'Clé API enregistrée',
  'tool.denied': 'Outil refusé',
  'workspace.merge': 'Proposition fusionnée',
}
const auditAction = (action: string) => AUDIT_ACTIONS[action] ?? action

function SecurityLevels() {
  const security = useSecurity()
  const qc = useQueryClient()
  const [testing, setTesting] = useState(false)
  const iso = security.data?.isolation
  const rerun = async () => {
    setTesting(true)
    try {
      qc.setQueryData(['security'], await call('security.selfTest'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }
  return (
    <>
      <div className="px-1 text-xs font-medium text-fg-3">Niveaux de sécurité des compagnons</div>
      <Card>
        <Row title="Niveau 1 · Politique d’Orbit" body="Chaque action d’un moteur est évaluée par Orbit avant de s’exécuter (hook PreToolUse pour Claude, demandes d’approbation pour Codex) : dossier autorisé, chemins relatifs et liens symboliques résolus, fichiers sensibles, commandes analysées selon leurs arguments et leurs effets (sous-shells compris). Les actions courantes passent sans vous déranger en mode supervisé ; les actions sensibles vous sont soumises. Une commande shell reste en partie opaque : ce niveau ne garantit pas l’isolation.">
          <Badge tone="success">Toujours actif</Badge>
        </Row>
        <Row title="Niveau 2 · Bac à sable du moteur" body="Codex : Seatbelt en lecture seule (supervisé) ou écriture limitée au dossier, réseau coupé sans permission. Claude : outils retirés, lecture confinée aux dossiers de travail, commandes dans le bac à sable de Claude Code. Ces bacs à sable limitent l’écriture et le réseau, pas toutes les lectures.">
          <Badge tone="success">Selon le moteur</Badge>
        </Row>
        <Row
          title="Niveau 3 · Isolation renforcée (ce Mac)"
          body={
            <>
              Profil Seatbelt d’Orbit appliqué à tout l’arbre de processus du moteur : votre dossier personnel devient illisible hors du projet, des outils de développement et du dossier de connexion du moteur. Activable par compagnon, uniquement si l’auto-test ci-dessous réussit.
              {iso && (
                <span className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
                  {iso.checks.map((c) => (
                    <span key={c.label} className={cn('flex items-center gap-1.5 text-[11.5px]', c.ok ? 'text-fg-3' : 'text-danger')}>
                      {c.ok ? <CheckCircle2 className="size-3 text-success" /> : <XCircle className="size-3" />} {c.label}
                    </span>
                  ))}
                </span>
              )}
              {iso?.error && <span className="mt-1 block text-danger">{iso.error}</span>}
            </>
          }
        >
          <div className="flex flex-col items-end gap-1.5">
            <Badge tone={iso?.ok ? 'success' : iso?.available === false ? 'neutral' : 'danger'}>{iso?.ok ? 'Prouvée' : iso?.available === false ? 'Indisponible' : 'Échec'}</Badge>
            <Button size="sm" variant="ghost" onClick={rerun} disabled={testing}>{testing ? 'Test…' : 'Relancer l’auto-test'}</Button>
          </div>
        </Row>
        <Row title="Isolation forte (VM / conteneur)" body="Seule une machine séparée garantit qu’aucune donnée de ce Mac n’est lisible. Le runtime distant d’Orbit (Machines) peut s’exécuter sur un serveur Linux ou une VM dédiée : c’est le mode recommandé pour les tâches non supervisées.">
          <Button size="sm" variant="ghost" onClick={() => navigate('/machines')}>Machines</Button>
        </Row>
      </Card>
      <div className="px-1 pt-2 text-xs font-medium text-fg-3">Autorisations mémorisées (tous les compagnons)</div>
      <GrantList />
      <div className="px-1 pt-2 text-xs font-medium text-fg-3">Actions exécutées sans confirmation</div>
      <AutoActionLog limit={60} />
      <div className="px-1 pt-2 text-xs font-medium text-fg-3">Décisions de sécurité récentes</div>
      <Card>
        {security.data?.events.slice(0, 40).map((e) => (
          <div key={e.id} className="grid grid-cols-[110px_90px_1fr_auto] items-center gap-3 px-4 py-2 text-[12.5px]">
            <span className="text-fg-3 tabular">{dateTime(e.createdAt)}</span>
            <span className="text-fg-3">{SECURITY_LAYERS[e.layer] ?? e.layer}</span>
            <span className="truncate text-[12px] text-fg-2" title={e.reason ?? undefined}>{e.target ?? e.action}{e.reason ? ` — ${e.reason}` : ''}</span>
            {(() => {
              const d = securityDecision(e.action, e.decision)
              return <Badge tone={d.tone}>{d.label}</Badge>
            })()}
          </div>
        ))}
        {security.data?.events.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-fg-3">Aucune décision enregistrée.</div>}
      </Card>
    </>
  )
}

export function SettingsPage({ section }: { section?: string }) {
  const current = SECTIONS.find((s) => s.key === section)?.key ?? 'general'
  const boot = useBootstrap()
  const providers = useProviders()
  const notifications = useNotifications()
  const audit = useAudit()
  const update = useAction('settings.update', { success: 'Enregistré' })
  const markRead = useAction('notifications.markRead')
  const demo = useDemoModeToggle()
  const s = boot.data?.settings
  const [daily, setDaily] = useState<string>(s?.dailyLimitUsd?.toString() ?? '')
  const [monthly, setMonthly] = useState<string>(s?.monthlyBudgetUsd?.toString() ?? '')
  const [name, setName] = useState(s?.userName ?? '')
  if (!s) return null

  return (
    <Page>
      <PageHeader title="Paramètres" />
      <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-8">
        <nav className="no-drag space-y-px">
          {SECTIONS.map((x) => {
            const Icon = x.icon
            return (
              <button key={x.key} onClick={() => navigate(`/settings/${x.key}`)} className={cn('flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-[13.5px]', current === x.key ? 'bg-white/[0.06] text-fg' : 'text-fg-2 hover:bg-white/[0.03] hover:text-fg')}>
                <Icon className={cn('size-[15px]', current === x.key ? 'text-accent' : 'text-fg-3')} /> {x.label}
              </button>
            )
          })}
        </nav>

        <div className="min-w-0 space-y-4">
          {current === 'general' && (
            <Card>
              <Row title="Votre prénom" body="Utilisé pour vous saluer sur la vue d’ensemble.">
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); update.mutate({ userName: name.trim() }) }}>
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="w-48" maxLength={40} />
                  <Button type="submit" variant="secondary">OK</Button>
                </form>
              </Row>
              <Row title="Animations" body="Respecte par défaut le réglage « Réduire les animations » de macOS.">
                <Segmented value={s.reduceMotion} onChange={(v) => update.mutate({ reduceMotion: v })} options={[{ value: 'system', label: 'Système' }, { value: 'always', label: 'Réduites' }, { value: 'never', label: 'Toujours' }]} />
              </Row>
              <Row title="Langue" body="Architecture de localisation prête pour d’autres langues.">
                <Badge>Français</Badge>
              </Row>
            </Card>
          )}

          {current === 'providers' && (
            <>
              {!boot.data?.secureStorage && (
                <div className="rounded-xl bg-danger/[0.06] p-4 text-[13px] text-danger ring-1 ring-danger/20">Le stockage sécurisé (Trousseau) est indisponible : aucune clé ne peut être enregistrée.</div>
              )}
              <div className="px-1 text-xs font-medium text-fg-3">Anthropic · deux connexions indépendantes</div>
              <Card>
                {providers.data?.filter((p) => p.id === 'claude-code').map((p) => <ClaudeCodeConnection key={p.id} provider={p} />)}
                {providers.data?.filter((p) => p.id === 'anthropic' || p.id === 'claude-agent').map((p) => <ProviderConnect key={p.id} provider={p} />)}
              </Card>
              <div className="px-1 pt-2 text-xs font-medium text-fg-3">OpenAI</div>
              <Card>{providers.data?.filter((p) => p.availability === 'available' && (p.id === 'openai' || p.id === 'codex')).map((p) => <ProviderConnect key={p.id} provider={p} />)}</Card>
              <div className="px-1 pt-2 text-xs font-medium text-fg-3">Prévus</div>
              <Card>{providers.data?.filter((p) => p.availability !== 'available').map((p) => <ProviderConnect key={p.id} provider={p} compact />)}</Card>
            </>
          )}

          {current === 'budgets' && (
            <Card>
              <Row title="Limite journalière" body="Au-delà, Orbit bloque les nouvelles conversations et missions. Basée sur les coûts connus (officiels + estimés).">
                <div className="flex gap-2">
                  <Input type="number" min={0} step={1} value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="Aucune" className="w-28 tabular" />
                  <Button variant="secondary" onClick={() => update.mutate({ dailyLimitUsd: daily === '' ? null : Number(daily) })}>Appliquer</Button>
                </div>
              </Row>
              <Row title="Budget mensuel" body="Même comportement, sur le mois calendaire.">
                <div className="flex gap-2">
                  <Input type="number" min={0} step={5} value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="Aucun" className="w-28 tabular" />
                  <Button variant="secondary" onClick={() => update.mutate({ monthlyBudgetUsd: monthly === '' ? null : Number(monthly) })}>Appliquer</Button>
                </div>
              </Row>
              <Row title="Tarifs" body="Tarifs publics Anthropic datés du 03/11/2026. Les modèles sans tarif connu sont comptés « coût inconnu », jamais à zéro.">
                <Badge tone="info">2026-11-03</Badge>
              </Row>
            </Card>
          )}

          {current === 'notifications' && (
            <>
              <Card>
                <Row title="Notifications macOS" body="Missions terminées ou échouées, approbations, budgets, incidents fournisseurs.">
                  <Switch checked={s.nativeNotifications} onChange={(v) => update.mutate({ nativeNotifications: v })} label="Notifications macOS" />
                </Row>
              </Card>
              <div className="flex items-center justify-between px-1 pt-2">
                <span className="text-xs font-medium text-fg-3">Historique</span>
                <Button size="xs" variant="ghost" onClick={() => markRead.mutate({})}>Tout marquer comme lu</Button>
              </div>
              <Card>
                {notifications.data?.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-fg-3">Aucune notification.</div>}
                {notifications.data?.map((n) => (
                  <button key={n.id} onClick={() => { markRead.mutate({ id: n.id }); if (n.route) navigate(n.route) }} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-white/[0.02]">
                    <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-accent')} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] text-fg">{n.title}</span>
                      <span className="block truncate text-xs text-fg-3">{n.body}</span>
                    </span>
                    <span className="text-xs text-fg-3 tabular">{relative(n.createdAt)}</span>
                  </button>
                ))}
              </Card>
            </>
          )}

          {current === 'security' && (
            <>
              <SecurityLevels />
              <Card>
                <Row title="Isolation du rendu" body="Context isolation, sandbox, aucune intégration Node, CSP stricte, IPC sur liste blanche et validé."><Badge tone="success">Active</Badge></Row>
                <Row title="Secrets" body={boot.data?.secureStorage ? 'Chiffrés via safeStorage (clé dans le Trousseau macOS).' : 'Indisponible'}><Badge tone={boot.data?.secureStorage ? 'success' : 'danger'}>{boot.data?.secureStorage ? 'Trousseau' : 'Indisponible'}</Badge></Row>
                <Row title="Règles d’autonomie" body="Appliquées dans le processus principal et dans chaque moteur. Aucun texte produit par un modèle ne peut les modifier, et aucun outil d’un compagnon ne peut lire ou écrire les données d’Orbit (autorisations, journal)."><Badge tone="success">Code, pas prompt</Badge></Row>
              </Card>
              <div className="px-1 pt-2 text-xs font-medium text-fg-3">Journal d’audit</div>
              <Card>
                {audit.data?.slice(0, 80).map((e) => (
                  <div key={e.id} className="grid grid-cols-[110px_80px_1fr_auto] items-center gap-3 px-4 py-2 text-[12.5px]">
                    <span className="text-fg-3 tabular">{dateTime(e.createdAt)}</span>
                    <span className="text-fg-3">{AUDIT_ACTORS[e.actor] ?? e.actor}</span>
                    <span className="truncate text-[12px] text-fg-2" title={e.action}>{auditAction(e.action)}{e.target ? ` · ${e.target}` : ''}{e.reason ? ` — ${e.reason}` : ''}</span>
                    <Badge tone={e.allowed ? 'success' : 'danger'}>{e.allowed ? 'autorisé' : 'refusé'}</Badge>
                  </div>
                ))}
                {audit.data?.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-fg-3">Journal vide.</div>}
              </Card>
            </>
          )}

          {current === 'data' && (
            <Card>
              <Row title="Mode démo" body={s.mode === 'demo' ? 'Vous explorez des données fictives dans une base séparée.' : 'Explorez Orbit avec des compagnons fictifs, sans clé ni réseau. Vos données réelles ne sont pas touchées.'}>
                <Button
                  variant={s.mode === 'demo' ? 'secondary' : 'outline'}
                  disabled={demo.isPending}
                  onClick={() => void demo.switchTo(s.mode === 'demo' ? 'real' : 'demo')}
                >
                  <FlaskConical /> {s.mode === 'demo' ? 'Revenir à mes données' : 'Ouvrir la démo'}
                </Button>
              </Row>
              <Row title="Emplacement des données" body="SQLite local. Rien n’est envoyé ailleurs que vers les fournisseurs que vous connectez.">
                <span className="selectable max-w-80 truncate font-mono text-xs text-fg-3">{boot.data?.dataPath}</span>
              </Row>
              <Row title="Revoir l’accueil" body="Relance immédiatement l’écran d’accueil. Vos compagnons et vos données sont conservés.">
                <Button variant="ghost" onClick={() => update.mutate({ onboarded: false })}>Relancer</Button>
              </Row>
            </Card>
          )}

          {current === 'about' && (
            <Card>
              <Row title="Orbit" body="Votre univers personnel d’IA."><span className="text-xs text-fg-3 tabular">v{boot.data?.appVersion}</span></Row>
              <Row title="Plateforme"><span className="text-xs text-fg-3">{boot.data?.platform}</span></Row>
            </Card>
          )}
        </div>
      </div>
    </Page>
  )
}
