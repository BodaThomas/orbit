import { useState } from 'react'
import { Bell, Database, Eye, EyeOff, FlaskConical, Info, KeyRound, ShieldCheck, SlidersHorizontal, Wallet } from 'lucide-react'
import type { ProviderInfo } from '@shared/types'
import { Page, PageHeader } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Segmented, Switch } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { dateTime, relative } from '@/lib/format'
import { useAction, useAudit, useBootstrap, useNotifications, useProviders } from '@/lib/queries'
import { useConfirm } from '@/orbit/Confirm'
import { ProviderMark } from '@/orbit/ProviderMark'
import { navigate } from '@/stores/router'

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
            {planned ? <Badge>Bientôt</Badge> : provider.connected ? <Badge tone="success">Connecté</Badge> : provider.hasSecret ? <Badge tone="danger">Erreur</Badge> : <Badge tone="warning">Non connecté</Badge>}
          </div>
          <div className="mt-0.5 text-xs leading-snug text-fg-3">{provider.notes}</div>
        </div>
      </div>
      {!planned && provider.id !== 'demo' && (
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

export function SettingsPage({ section }: { section?: string }) {
  const current = SECTIONS.find((s) => s.key === section)?.key ?? 'general'
  const boot = useBootstrap()
  const providers = useProviders()
  const notifications = useNotifications()
  const audit = useAudit()
  const update = useAction('settings.update', { success: 'Enregistré' })
  const markRead = useAction('notifications.markRead')
  const setMode = useAction('app.setMode', { onSuccess: () => navigate('/') })
  const confirm = useConfirm()
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
              <Card>{providers.data?.filter((p) => p.availability === 'available' && p.id !== 'demo').map((p) => <ProviderConnect key={p.id} provider={p} />)}</Card>
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
              <Card>
                <Row title="Isolation du rendu" body="Context isolation, sandbox, aucune intégration Node, CSP stricte, IPC sur liste blanche et validé."><Badge tone="success">Active</Badge></Row>
                <Row title="Secrets" body={boot.data?.secureStorage ? 'Chiffrés via safeStorage (clé dans le Trousseau macOS).' : 'Indisponible'}><Badge tone={boot.data?.secureStorage ? 'success' : 'danger'}>{boot.data?.secureStorage ? 'Trousseau' : 'Indisponible'}</Badge></Row>
                <Row title="Règles d’autonomie" body="Appliquées dans le processus principal. Aucun texte produit par un modèle ne peut les modifier."><Badge tone="success">Code, pas prompt</Badge></Row>
              </Card>
              <div className="px-1 pt-2 text-xs font-medium text-fg-3">Journal d’audit</div>
              <Card>
                {audit.data?.slice(0, 80).map((e) => (
                  <div key={e.id} className="grid grid-cols-[110px_80px_1fr_auto] items-center gap-3 px-4 py-2 text-[12.5px]">
                    <span className="text-fg-3 tabular">{dateTime(e.createdAt)}</span>
                    <span className="text-fg-3">{e.actor}</span>
                    <span className="truncate font-mono text-[11.5px] text-fg-2">{e.action}{e.target ? ` · ${e.target}` : ''}{e.reason ? ` — ${e.reason}` : ''}</span>
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
                  onClick={async () => {
                    if (s.mode === 'demo' || (await confirm({ title: 'Passer en mode démo ?', body: 'Orbit ouvrira une base de démonstration séparée. Vous pourrez revenir à vos données à tout moment.', confirm: 'Ouvrir la démo' })))
                      setMode.mutate({ mode: s.mode === 'demo' ? 'real' : 'demo' })
                  }}
                >
                  <FlaskConical /> {s.mode === 'demo' ? 'Revenir à mes données' : 'Ouvrir la démo'}
                </Button>
              </Row>
              <Row title="Emplacement des données" body="SQLite local. Rien n’est envoyé ailleurs que vers les fournisseurs que vous connectez.">
                <span className="selectable max-w-80 truncate font-mono text-xs text-fg-3">{boot.data?.dataPath}</span>
              </Row>
              <Row title="Revoir l’accueil" body="Relance l’onboarding au prochain affichage.">
                <Button variant="ghost" onClick={() => update.mutate({ onboarded: false })}>Relancer</Button>
              </Row>
            </Card>
          )}

          {current === 'about' && (
            <Card>
              <Row title="Orbit" body="Your personal AI universe."><span className="text-xs text-fg-3 tabular">v{boot.data?.appVersion}</span></Row>
              <Row title="Plateforme"><span className="text-xs text-fg-3">{boot.data?.platform}</span></Row>
            </Card>
          )}
        </div>
      </div>
    </Page>
  )
}
