import { useState } from 'react'
import { BookOpen, CheckCircle2, Copy, FlaskConical, RefreshCw, Terminal, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import type { ProviderInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Badge, Switch } from '@/components/ui/field'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { compactNumber, integer, relative } from '@/lib/format'
import { useAction, useLocalClaude, useQuotas } from '@/lib/queries'
import { useQueryClient } from '@tanstack/react-query'
import { useConfirm } from './Confirm'
import { ProviderMark } from './ProviderMark'
import { QuotaCard } from './QuotaCard'

const DOCS = 'https://code.claude.com/docs'

/**
 * « Claude Code » connection: the user's local, official CLI. Orbit only detects and
 * supervises it; signing in always happens in Anthropic's own flow, in a terminal.
 */
export function ClaudeCodeConnection({ provider }: { provider: ProviderInfo }) {
  const qc = useQueryClient()
  const validate = useAction('providers.validate')
  const quotas = useQuotas()
  const local = useLocalClaude()
  const confirm = useConfirm()
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; text: string; model: string | null; durationMs: number; error: string | null } | null>(null)
  const facts = provider.engineFacts ?? {}
  const installed = Boolean(facts.Version)
  const ready = provider.connected
  const status = !provider.lastValidatedAt ? { tone: 'neutral' as const, label: 'Non vérifié' } : ready ? { tone: 'success' as const, label: 'Prêt' } : installed ? { tone: 'warning' as const, label: 'À connecter' } : { tone: 'danger' as const, label: 'Non installé' }

  const runTest = async () => {
    const ok = await confirm({ title: 'Tester Claude Code ?', body: 'Orbit lance une vraie session très courte (réponse « OK », aucun outil, dossier temporaire vide). Elle consomme un peu de votre quota Claude Code.', confirm: 'Lancer le test' })
    if (!ok) return
    setTesting(true)
    try {
      setTest(await call('providers.testEngine', { providerId: provider.id }))
      void qc.invalidateQueries({ queryKey: ['providers'] })
      void qc.invalidateQueries({ queryKey: ['usage'] })
    } catch (err) {
      setTest({ ok: false, text: '', model: null, durationMs: 0, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }
  const setLocal = async (enabled: boolean) => {
    if (enabled) {
      const ok = await confirm({
        title: 'Lire les journaux locaux de Claude Code ?',
        body: 'Orbit lira en lecture seule ~/.claude/projects (modèles, jetons, nombre d’outils, horaires) pour afficher votre activité. Le texte des conversations n’est ni conservé ni envoyé. Aucun identifiant n’est lu.',
        confirm: 'Autoriser la lecture',
      })
      if (!ok) return
    }
    try {
      qc.setQueryData(['usage', 'localClaude'], await call('usage.setLocalClaude', { enabled }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  const lu = local.data?.usage
  const quota = quotas.data?.find((q) => q.providerId === 'claude-code')

  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-3">
        <ProviderMark id={provider.id} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium text-fg">
            Claude Code <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <div className="text-[12.5px] text-fg-3">Utiliser votre installation locale de Claude Code</div>
        </div>
        <Button size="sm" variant="ghost" disabled={validate.isPending} onClick={() => validate.mutate({ providerId: provider.id })}>
          <RefreshCw className={cn(validate.isPending && 'animate-spin')} /> {provider.lastValidatedAt ? 'Actualiser' : 'Vérifier l’installation'}
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 pl-10 text-[12.5px]">
        {[
          ['Installation', installed ? `Détectée · ${facts.Binaire ?? ''}` : provider.lastValidatedAt ? 'Introuvable' : '—'],
          ['Version du CLI', facts.Version ?? '—'],
          ['Connexion', facts.Connexion ?? '—'],
          ['Méthode d’authentification', facts['Méthode'] ? `${facts['Méthode']}${facts.Abonnement ? ` · ${facts.Abonnement}` : ''}` : '—'],
          ['Modèle par défaut', 'Celui de votre compte, choisi par Claude Code'],
          ['Dernier modèle utilisé', facts['Modèle utilisé (dernière session)'] ?? '—'],
          ['État du moteur', ready ? 'Opérationnel' : provider.statusDetail ?? 'Non vérifié'],
          ['Sessions disponibles', lu ? `${integer(lu.sessions)} sur ${lu.days} jours (journaux locaux)` : 'Lecture des journaux désactivée'],
          ['Dernière activité', facts['Dernière activité'] ? relative(facts['Dernière activité']) : lu?.lastActivity ? relative(lu.lastActivity) : '—'],
        ].map(([k, v]) => (
          <div key={k} className="flex min-w-0 justify-between gap-3 border-b border-line py-1">
            <span className="shrink-0 text-fg-3">{k}</span>
            <span className="truncate text-right text-fg-2" title={v}>{v}</span>
          </div>
        ))}
      </div>
      {provider.statusDetail && !ready && provider.lastValidatedAt && <p className="mt-2 pl-10 text-xs text-warning">{provider.statusDetail}</p>}

      <div className="mt-3 flex flex-wrap gap-1.5 pl-10">
        {!ready && installed && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText('claude')
              toast.success('Commande copiée', { description: 'Dans un terminal : collez « claude », puis tapez /login et suivez le processus officiel d’Anthropic.' })
            }}
          >
            <Terminal /> Configurer la connexion
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={!ready || testing} onClick={runTest}>
          <FlaskConical /> {testing ? 'Test en cours…' : 'Tester le moteur'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.open(DOCS)}>
          <BookOpen /> Documentation
        </Button>
        {facts.Binaire && (
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(facts.Binaire!).then(() => toast.success('Chemin copié'))}>
            <Copy /> Chemin du binaire
          </Button>
        )}
      </div>
      {test && (
        <div className={cn('mt-2 ml-10 flex items-start gap-2 rounded-[10px] px-3 py-2 text-[12.5px] ring-1', test.ok ? 'bg-success/[0.05] text-fg-2 ring-success/15' : 'bg-danger/[0.05] text-danger ring-danger/15')}>
          {test.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-3.5 shrink-0" />}
          <span>
            {test.ok ? `Réponse reçue en ${(test.durationMs / 1000).toFixed(1)} s${test.model ? ` · ${test.model}` : ''} : « ${test.text.trim().slice(0, 80)} »` : test.error}
          </span>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-4 pl-10">
        <div>
          <div className="mb-1.5 text-xs font-medium text-fg-2">Quota de l’abonnement</div>
          <QuotaCard providerId="claude-code" engineName="Claude Code" snapshot={quota} />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-fg-2">
            Journaux locaux (lecture seule)
            <Switch checked={Boolean(local.data?.enabled)} onChange={setLocal} label="Lire les journaux locaux de Claude Code" />
          </div>
          {lu ? (
            <div className="rounded-[11px] bg-white/[0.02] px-3 py-2.5 text-[12.5px] ring-1 ring-line">
              <div className="flex justify-between"><span className="text-fg-3">Jetons ({lu.days} j)</span><span className="text-fg tabular">{compactNumber(lu.inputTokens + lu.outputTokens)}</span></div>
              <div className="flex justify-between"><span className="text-fg-3">Messages · outils</span><span className="text-fg-2 tabular">{integer(lu.messages)} · {integer(lu.toolCalls)}</span></div>
              {lu.byModel.slice(0, 3).map((m) => (
                <div key={m.model} className="flex justify-between text-2xs"><span className="truncate text-fg-3">{m.model}</span><span className="text-fg-3 tabular">{compactNumber(m.tokens)}</span></div>
              ))}
              <div className="mt-1 text-2xs text-fg-4">Inclus dans votre abonnement · ce ne sont pas des quotas</div>
            </div>
          ) : (
            <div className="rounded-[11px] bg-white/[0.02] px-3 py-2.5 text-[12px] text-fg-3 ring-1 ring-line">{local.data?.error ?? 'Désactivé. Activez pour voir vos sessions, modèles et jetons locaux.'}</div>
          )}
        </div>
      </div>
      <p className="mt-3 pl-10 text-2xs leading-relaxed text-fg-4">
        Orbit lance le binaire officiel « claude » non modifié, avec votre propre connexion, et ne lit jamais vos jetons, votre Trousseau ni vos cookies. Usage personnel : conforme aux conditions de Claude Code. Les autorisations sont toujours demandées dans Orbit ; le mode qui ignore les permissions n’est jamais utilisé.
      </p>
    </div>
  )
}
