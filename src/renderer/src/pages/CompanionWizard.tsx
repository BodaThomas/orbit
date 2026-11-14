import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, FolderOpen, Laptop, Lock, Server, ShieldCheck, Sparkles, Wand2, Zap } from 'lucide-react'
import { COMPANION_PRESETS, DEFAULT_PERMISSIONS, EXPRESSIONS, PALETTE_IDS, PALETTES, PERMISSION_LABELS, SPECIES, TEXTURES } from '@shared/catalog'
import { AUTONOMY_EXPLAINED } from '@shared/permission-labels'
import { EFFORT_LEVELS, isAgentEngine } from '@shared/engines'
import type { AgentInput } from '@shared/ipc'
import type { AgentPermissions, Appearance, AutonomyLevel, PaletteId, ProviderInfo } from '@shared/types'
import { Page } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Label, Switch, Textarea } from '@/components/ui/field'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useAction, useAgent, useProviders, useRemoteMachines, useSecurity } from '@/lib/queries'
import { Companion } from '@/orbit/Companion'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { Planet } from '@/orbit/Planet'
import { ProviderMark } from '@/orbit/ProviderMark'
import { navigate } from '@/stores/router'

const STEPS = [
  { key: 'identity', label: 'Identité' },
  { key: 'look', label: 'Personnage' },
  { key: 'planet', label: 'Planète' },
  { key: 'mind', label: 'Intelligence' },
  { key: 'frame', label: 'Cadre' },
] as const

const AUTONOMY: { id: AutonomyLevel; label: string; body: string; icon: typeof Lock }[] = [
  { id: 'manual', label: AUTONOMY_EXPLAINED.manual.label, body: AUTONOMY_EXPLAINED.manual.short, icon: Lock },
  { id: 'supervised', label: AUTONOMY_EXPLAINED.supervised.label, body: AUTONOMY_EXPLAINED.supervised.short, icon: ShieldCheck },
  { id: 'automated', label: AUTONOMY_EXPLAINED.automated.label, body: AUTONOMY_EXPLAINED.automated.short, icon: Zap },
]

function initialDraft(): AgentInput {
  const p = COMPANION_PRESETS[0]
  return {
    name: '',
    role: '',
    description: '',
    appearance: { ...p.appearance, planet: { ...p.appearance.planet } },
    providerId: 'anthropic',
    model: 'claude-opus-5-5',
    instructions: '',
    autonomy: 'supervised',
    permissions: { ...DEFAULT_PERMISSIONS },
    workingDirectory: null,
    dailyBudgetUsd: null,
    isolation: 'standard',
    effort: null,
    runtime: 'local',
    machineId: null,
  }
}

function Swatch({ id, selected, onClick, kind }: { id: PaletteId; selected: boolean; onClick: () => void; kind: 'body' | 'planet' }) {
  const p = PALETTES[id]
  const [a, b, c] = kind === 'body' ? p.body : p.planet
  return (
    <button
      type="button"
      title={p.label}
      aria-label={p.label}
      aria-pressed={selected}
      onClick={onClick}
      className={cn('size-8 rounded-full transition-transform duration-200 hover:scale-110', selected && 'ring-2 ring-fg ring-offset-2 ring-offset-surface')}
      style={{ background: `radial-gradient(circle at 35% 30%, ${a}, ${b} 55%, ${c})` }}
    />
  )
}

function Tile({ selected, onClick, children, label, className }: { selected: boolean; onClick: () => void; children: React.ReactNode; label: string; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'group flex flex-col items-center gap-1.5 rounded-[12px] p-3 transition-[background,box-shadow] duration-200',
        selected ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]',
        className,
      )}
    >
      {children}
      <span className={cn('text-xs', selected ? 'text-fg' : 'text-fg-2')}>{label}</span>
    </button>
  )
}

function Range({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-[#A59BFA]"
    />
  )
}

function Preview({ draft }: { draft: AgentInput }) {
  return (
    <div className="sticky top-[60px] overflow-hidden rounded-2xl bg-[radial-gradient(ellipse_at_50%_40%,#1a1d2b_0%,#111218_70%)] ring-1 ring-line">
      <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden>
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i} className="absolute size-px rounded-full bg-white" style={{ left: `${(i * 37) % 100}%`, top: `${(i * 53) % 100}%`, opacity: 0.2 + ((i * 7) % 5) / 12 }} />
        ))}
      </div>
      <div className="relative flex flex-col items-center px-6 pt-8 pb-6">
        <CompanionAvatar appearance={draft.appearance} variant="profile" size={240} seed="preview" animated />
        <div className="mt-1 text-[19px] font-semibold text-fg">{draft.name || 'Votre compagnon'}</div>
        <div className="mt-0.5 text-[13px] text-fg-3">{draft.role || 'Rôle à définir'}</div>
        <div className="mt-6 flex items-end gap-5 border-t border-line pt-5">
          {[20, 28, 40].map((s) => (
            <div key={s} className="flex flex-col items-center gap-1.5">
              <Companion appearance={draft.appearance} size={s} />
              <span className="text-2xs text-fg-4 tabular">{s} px</span>
            </div>
          ))}
          <div className="flex flex-col items-center gap-1.5">
            <CompanionAvatar appearance={draft.appearance} variant="standard" size={40} />
            <span className="text-2xs text-fg-4">Standard</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <CompanionAvatar appearance={draft.appearance} variant="detailed" size={56} />
            <span className="text-2xs text-fg-4">Détaillé</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function CompanionWizardPage({ agentId }: { agentId?: string }) {
  const existing = useAgent(agentId)
  const providers = useProviders()
  const security = useSecurity()
  const remoteMachines = useRemoteMachines()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<AgentInput>(initialDraft)
  const [loaded, setLoaded] = useState(!agentId)
  const editing = Boolean(agentId)

  useEffect(() => {
    if (agentId && existing.data && !loaded) {
      const a = existing.data
      setDraft({ name: a.name, role: a.role, description: a.description, appearance: a.appearance, providerId: a.providerId, model: a.model, instructions: a.instructions, autonomy: a.autonomy, permissions: a.permissions, workingDirectory: a.workingDirectory, dailyBudgetUsd: a.dailyBudgetUsd, isolation: a.isolation, effort: a.effort as AgentInput['effort'], runtime: a.runtime, machineId: a.machineId })
      setLoaded(true)
    }
  }, [agentId, existing.data, loaded])

  // Default to demo provider when nothing real is connected and demo is available.
  useEffect(() => {
    if (editing || !providers.data) return
    const demo = providers.data.find((p) => p.id === 'demo')
    const anyConnected = providers.data.some((p) => p.id !== 'demo' && p.connected)
    if (demo && !anyConnected) setDraft((d) => ({ ...d, providerId: 'demo', model: 'demo-orbit' }))
  }, [providers.data, editing])

  const create = useAction('agents.create', { success: (a) => `${a.name} a rejoint votre univers`, onSuccess: (a) => navigate(`/chat/${a.id}`) })
  const update = useAction('agents.update', { success: 'Modifications enregistrées', onSuccess: (a) => navigate(`/companions/${a.id}`) })

  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const setLook = (patch: Partial<Appearance>) => setDraft((d) => ({ ...d, appearance: { ...d.appearance, ...patch } }))
  const setPlanet = (patch: Partial<Appearance['planet']>) => setDraft((d) => ({ ...d, appearance: { ...d.appearance, planet: { ...d.appearance.planet, ...patch } } }))
  const provider: ProviderInfo | undefined = providers.data?.find((p) => p.id === draft.providerId)
  const canNext = step !== 0 || draft.name.trim().length > 0
  const last = step === STEPS.length - 1

  const save = () => (editing ? update.mutate({ id: agentId!, patch: draft }) : create.mutate(draft))

  const sensitive = useMemo(() => (Object.keys(draft.permissions) as (keyof AgentPermissions)[]).filter((k) => draft.permissions[k] && PERMISSION_LABELS[k].sensitive), [draft.permissions])

  if (agentId && !loaded) return null

  return (
    <Page wide>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <button onClick={() => (editing ? navigate(`/companions/${agentId}`) : navigate('/companions'))} className="no-drag mb-1 flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
            <ArrowLeft className="size-3.5" /> {editing ? 'Profil' : 'Compagnons'}
          </button>
          <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-fg">{editing ? `Modifier ${existing.data?.name}` : 'Nouveau compagnon'}</h1>
        </div>
        <ol className="no-drag flex items-center gap-1" aria-label="Étapes">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1">
              <button
                onClick={() => (editing || i <= step || canNext) && setStep(i)}
                aria-current={i === step ? 'step' : undefined}
                className={cn('flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors', i === step ? 'bg-white/[0.08] text-fg' : i < step ? 'text-fg-2 hover:text-fg' : 'text-fg-3 hover:text-fg-2')}
              >
                <span className={cn('flex size-4 items-center justify-center rounded-full text-[10px] tabular', i < step ? 'bg-accent text-[#14112b]' : i === step ? 'bg-fg text-canvas' : 'bg-white/10')}>
                  {i < step ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <span className="h-px w-3 bg-line-strong" />}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_400px] gap-6">
        <div className="min-w-0 rounded-2xl bg-surface p-6 ring-1 ring-line">
          {step === 0 && (
            <div className="space-y-5">
              {!editing && (
                <div>
                  <Label hint="Point de départ, tout reste modifiable">Modèles</Label>
                  <div className="grid grid-cols-4 gap-2">
                    {COMPANION_PRESETS.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, name: p.name, role: p.role, description: p.description, instructions: p.instructions, appearance: { ...p.appearance, planet: { ...p.appearance.planet } } }))}
                        className="flex items-center gap-2.5 rounded-[11px] bg-white/[0.025] p-2.5 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]"
                      >
                        <Companion appearance={p.appearance} size={30} />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-fg">{p.name}</span>
                          <span className="block truncate text-2xs text-fg-3">{p.role}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Nom</Label>
                  <Input autoFocus value={draft.name} maxLength={40} onChange={(e) => set('name', e.target.value)} placeholder="Nova" onKeyDown={(e) => e.key === 'Enter' && canNext && setStep(1)} />
                </div>
                <div>
                  <Label>Rôle</Label>
                  <Input value={draft.role} maxLength={60} onChange={(e) => set('role', e.target.value)} placeholder="Assistante personnelle" />
                </div>
              </div>
              <div>
                <Label hint={`${draft.description.length}/400`}>Description</Label>
                <Textarea value={draft.description} maxLength={400} onChange={(e) => set('description', e.target.value)} placeholder="Ce que ce compagnon fait pour vous, en une ou deux phrases." />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <div>
                <Label hint="Silhouette">Personnage</Label>
                <div className="grid grid-cols-6 gap-2">
                  {SPECIES.map((s) => (
                    <Tile key={s.id} label={s.label} selected={draft.appearance.species === s.id} onClick={() => setLook({ species: s.id })}>
                      <Companion appearance={{ ...draft.appearance, species: s.id }} size={48} />
                    </Tile>
                  ))}
                </div>
              </div>
              <div>
                <Label>Couleur</Label>
                <div className="flex flex-wrap gap-3 px-1">
                  {PALETTE_IDS.map((id) => (
                    <Swatch key={id} id={id} kind="body" selected={draft.appearance.palette === id} onClick={() => setLook({ palette: id })} />
                  ))}
                </div>
              </div>
              <div>
                <Label>Expression</Label>
                <div className="grid grid-cols-6 gap-2">
                  {EXPRESSIONS.map((e) => (
                    <Tile key={e.id} label={e.label} selected={draft.appearance.expression === e.id} onClick={() => setLook({ expression: e.id })}>
                      <Companion appearance={{ ...draft.appearance, expression: e.id }} size={40} />
                    </Tile>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div>
                <Label>Couleur de la planète</Label>
                <div className="flex flex-wrap items-center gap-3 px-1">
                  {PALETTE_IDS.map((id) => (
                    <Swatch key={id} id={id} kind="planet" selected={draft.appearance.planet.palette === id} onClick={() => setPlanet({ palette: id })} />
                  ))}
                  <Button size="xs" variant="ghost" className="ml-2" onClick={() => setPlanet({ palette: draft.appearance.palette })}>
                    <Wand2 /> Assortir au personnage
                  </Button>
                </div>
              </div>
              <div>
                <Label>Surface</Label>
                <div className="grid grid-cols-5 gap-2">
                  {TEXTURES.map((t) => (
                    <Tile key={t.id} label={t.label} selected={draft.appearance.planet.texture === t.id} onClick={() => setPlanet({ texture: t.id })}>
                      <Planet spec={{ ...draft.appearance.planet, texture: t.id, ring: false, satellite: false, atmosphere: 0.2 }} size={56} seed={t.id} />
                    </Tile>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <Label hint={`${Math.round(draft.appearance.planet.atmosphere * 100)} %`}>Atmosphère</Label>
                  <Range label="Atmosphère" value={draft.appearance.planet.atmosphere} min={0} max={1} step={0.05} onChange={(v) => setPlanet({ atmosphere: v })} />
                </div>
                <div>
                  <Label hint={`× ${draft.appearance.planet.scale.toFixed(2)}`}>Taille</Label>
                  <Range label="Taille" value={draft.appearance.planet.scale} min={0.8} max={1.2} step={0.05} onChange={(v) => setPlanet({ scale: v })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center justify-between rounded-[11px] bg-white/[0.025] px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
                  <span>
                    <span className="block text-[13px] text-fg">Anneau</span>
                    <span className="block text-xs text-fg-3">Un anneau délicat autour de la planète</span>
                  </span>
                  <Switch checked={draft.appearance.planet.ring} onChange={(v) => setPlanet({ ring: v })} label="Anneau" />
                </label>
                <label className="flex items-center justify-between rounded-[11px] bg-white/[0.025] px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
                  <span>
                    <span className="block text-[13px] text-fg">Satellite</span>
                    <span className="block text-xs text-fg-3">Une petite lune en orbite</span>
                  </span>
                  <Switch checked={draft.appearance.planet.satellite} onChange={(v) => setPlanet({ satellite: v })} label="Satellite" />
                </label>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div>
                <Label>Fournisseur</Label>
                <div className="grid grid-cols-2 gap-2">
                  {providers.data?.map((p) => {
                    const disabled = p.availability !== 'available'
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => setDraft((d) => ({ ...d, providerId: p.id, model: p.models[0]?.id ?? d.model }))}
                        className={cn(
                          'flex items-center gap-3 rounded-[11px] p-3 text-left transition-[background,box-shadow] disabled:opacity-45',
                          draft.providerId === p.id ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] enabled:hover:bg-white/[0.05]',
                        )}
                      >
                        <ProviderMark id={p.id} size={26} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-fg">{p.name}</span>
                          <span className="block truncate text-2xs text-fg-3">{disabled ? 'Bientôt' : p.id === 'demo' ? 'Hors ligne, réponses fictives' : p.capabilities.kind === 'agent' ? 'Moteur agent · fichiers, commandes, sessions' : p.connected ? 'Connecté' : 'Clé API requise'}</span>
                        </span>
                        {!disabled && p.id !== 'demo' && <Badge tone={p.connected ? 'success' : 'warning'}>{p.connected ? 'Prêt' : 'À connecter'}</Badge>}
                      </button>
                    )
                  })}
                </div>
                {provider?.capabilities.kind === 'agent' && (
                  <p className="mt-2 text-xs leading-relaxed text-fg-3">
                    {provider.name} travaille dans un dossier que vous choisirez à l’étape suivante, au fil de missions que vous suivez en direct. {provider.statusDetail}
                  </p>
                )}
                {provider && !provider.connected && provider.id !== 'demo' && provider.availability === 'available' && provider.capabilities.kind !== 'agent' && (
                  <p className="mt-2 text-xs text-fg-3">
                    Vous pourrez connecter {provider.name} dans{' '}
                    <button className="text-accent hover:underline" onClick={() => navigate('/settings/providers')}>
                      Paramètres → Fournisseurs
                    </button>
                    . Le compagnon sera créé dès maintenant.
                  </p>
                )}
              </div>
              <div>
                <Label hint={provider?.models.length ? undefined : 'Saisissez l’identifiant exact'}>Modèle</Label>
                {provider?.models.length ? (
                  <div className="grid grid-cols-2 gap-2">
                    {provider.models.slice(0, 8).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => set('model', m.id)}
                        className={cn('rounded-[10px] px-3 py-2 text-left', draft.model === m.id ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]')}
                      >
                        <span className="block text-[13px] text-fg">{m.label}</span>
                        {m.hint && <span className="block text-2xs text-fg-3">{m.hint}</span>}
                      </button>
                    ))}
                  </div>
                ) : (
                  <Input value={draft.model} onChange={(e) => set('model', e.target.value)} placeholder="identifiant-du-modèle" />
                )}
              </div>
              {isAgentEngine(draft.providerId) && (
                <div>
                  <Label hint="Plus d’effort : réponses plus réfléchies, plus de jetons">Effort de raisonnement</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {[{ id: null, label: 'Par défaut' }, ...EFFORT_LEVELS].map((e) => (
                      <button
                        key={e.id ?? 'default'}
                        type="button"
                        aria-pressed={draft.effort === e.id}
                        onClick={() => set('effort', e.id as AgentInput['effort'])}
                        className={cn('h-8 rounded-[9px] px-3 text-[12.5px]', draft.effort === e.id ? 'bg-accent/[0.09] text-fg shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] text-fg-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]')}
                      >
                        {e.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-2xs text-fg-4">Transmis tel quel au moteur. Si le modèle ne le prend pas en charge, la mission échoue avec un message clair : aucun repli silencieux.</p>
                </div>
              )}
              <div>
                <Label hint="Envoyées à chaque échange">Instructions permanentes</Label>
                <Textarea className="min-h-36" value={draft.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder={`Tu es ${draft.name || 'un compagnon'}…`} />
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-6">
              <div>
                <Label>Niveau d’autonomie</Label>
                <div className="grid grid-cols-3 gap-2">
                  {AUTONOMY.map((a) => {
                    const Icon = a.icon
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => set('autonomy', a.id)}
                        className={cn('rounded-[11px] p-3.5 text-left', draft.autonomy === a.id ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]')}
                      >
                        <Icon className={cn('size-4', draft.autonomy === a.id ? 'text-accent' : 'text-fg-3')} />
                        <div className="mt-2 text-[13px] font-medium text-fg">{a.label}</div>
                        <div className="mt-0.5 text-xs leading-snug text-fg-3">{a.body}</div>
                      </button>
                    )
                  })}
                </div>
              </div>
              <div>
                <Label hint="Appliquées par Orbit, pas par le modèle">Permissions</Label>
                <div className="divide-y divide-line rounded-[11px] bg-white/[0.02] shadow-[inset_0_0_0_1px_var(--color-line)]">
                  {(Object.keys(PERMISSION_LABELS) as (keyof AgentPermissions)[]).map((k) => (
                    <label key={k} className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                      <span>
                        <span className="flex items-center gap-2 text-[13px] text-fg">
                          {PERMISSION_LABELS[k].label}
                          {PERMISSION_LABELS[k].sensitive && <Badge tone="warning">Sensible</Badge>}
                        </span>
                        <span className="block text-xs text-fg-3">{PERMISSION_LABELS[k].hint}</span>
                      </span>
                      <Switch checked={draft.permissions[k]} onChange={(v) => set('permissions', { ...draft.permissions, [k]: v })} label={PERMISSION_LABELS[k].label} />
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-fg-3">
                  {provider?.capabilities.kind === 'agent'
                    ? `Chaque action de ${provider.name} est vérifiée par Orbit avant de s’exécuter, uniquement dans le dossier autorisé. Une permission désactivée bloque l’action ; ${draft.autonomy === 'automated' ? 'en mode automatique, seules les actions sensibles vous sont soumises' : draft.autonomy === 'supervised' ? 'en mode supervisé, lectures, modifications, tests et compilation se font sans vous déranger ; installations, déploiements, Git distant ou destructif, secrets et suppressions massives attendent votre accord' : 'en mode manuel, chaque modification, commande ou accès réseau attend votre accord'}.`
                    : `Ce fournisseur répond sans outils : ces permissions s’appliqueront s’il passe sur un moteur agent${sensitive.length > 0 && draft.autonomy === 'supervised' ? '. En mode supervisé, chaque mission demandera votre approbation' : ''}.`}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label hint={provider?.capabilities.kind === 'agent' ? 'Requis : seul dossier accessible' : undefined}>Dossier autorisé</Label>
                  <div className="flex gap-2">
                    <Input readOnly value={draft.runtime === 'remote' ? `Sur la machine distante : projects/${draft.workingDirectory ?? ''}` : (draft.workingDirectory ?? '')} placeholder="Aucun" className="text-fg-2" disabled={draft.runtime === 'remote'} />
                    <Button
                      variant="secondary"
                      disabled={draft.runtime === 'remote'}
                      onClick={async () => {
                        const dir = await call('app.chooseDirectory')
                        if (dir) set('workingDirectory', dir)
                      }}
                    >
                      <FolderOpen /> Choisir
                    </Button>
                  </div>
                </div>
                <div>
                  <Label hint="Bloque les nouvelles exécutions">Budget journalier</Label>
                  <div className="relative">
                    <Input
                      type="number"
                      min={0}
                      step={0.5}
                      value={draft.dailyBudgetUsd ?? ''}
                      onChange={(e) => set('dailyBudgetUsd', e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
                      placeholder="Illimité"
                      className="pr-7 tabular"
                    />
                    <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-fg-3">$</span>
                  </div>
                </div>
              </div>
              {isAgentEngine(draft.providerId) && (
                <div>
                  <Label hint="Niveau 3 · bloque les lectures hors du projet">Isolation renforcée</Label>
                  <div className="flex items-start gap-3 rounded-[11px] bg-white/[0.025] px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
                    <ShieldCheck className={cn('mt-0.5 size-4', draft.isolation === 'strict' ? 'text-success' : 'text-fg-3')} />
                    <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-fg-3">
                      <span className="block text-[13px] text-fg">Confiner tout le moteur au dossier du projet</span>
                      Le noyau macOS refuse à {draft.name || 'ce compagnon'} et à toutes ses commandes la lecture de votre dossier personnel hors du projet (clés SSH, .env d’autres projets…).
                      {security.data && !security.data.isolation.ok && <span className="mt-1 block text-warning">Indisponible : l’auto-test de confinement n’a pas réussi sur ce Mac.</span>}
                      {security.data?.isolation.ok && <span className="mt-1 block text-fg-4">Auto-test réussi le {new Date(security.data.isolation.checkedAt!).toLocaleString('fr-FR')}. Le dossier de connexion du moteur reste lisible.</span>}
                    </span>
                    <Switch checked={draft.isolation === 'strict'} disabled={!security.data?.isolation.ok} onChange={(v) => set('isolation', v ? 'strict' : 'standard')} label="Isolation renforcée" />
                  </div>
                </div>
              )}
              <div>
                <Label hint={isAgentEngine(draft.providerId) ? 'Une machine distante travaille même Mac éteint' : 'Moteurs agents uniquement'}>Environnement d’exécution</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" aria-pressed={draft.runtime === 'local'} onClick={() => setDraft((d) => ({ ...d, runtime: 'local', machineId: null, workingDirectory: d.runtime === 'remote' ? null : d.workingDirectory }))} className={cn('flex items-center gap-3 rounded-[11px] px-3.5 py-3 text-left', draft.runtime === 'local' ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]')}>
                    <Laptop className="size-4 text-fg-2" />
                    <span className="flex-1 text-[13px] text-fg">Ce Mac</span>
                  </button>
                  {(remoteMachines.data ?? []).map((m) => (
                    <button key={m.id} type="button" disabled={!isAgentEngine(draft.providerId)} aria-pressed={draft.machineId === m.id} onClick={() => setDraft((d) => ({ ...d, runtime: 'remote', machineId: m.id, isolation: 'standard', workingDirectory: d.runtime === 'remote' ? d.workingDirectory : 'projet' }))} className={cn('flex items-center gap-3 rounded-[11px] px-3.5 py-3 text-left disabled:opacity-45', draft.machineId === m.id ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] enabled:hover:bg-white/[0.05]')}>
                      <Server className="size-4 text-fg-2" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-fg">{m.name}</span>
                        <span className="block truncate text-2xs text-fg-3">{m.status === 'online' ? 'En ligne' : 'Hors ligne'}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {draft.runtime === 'remote' && (
                  <div className="mt-2">
                    <Label hint="Dossier sous projects/ sur la machine">Projet distant</Label>
                    <Input value={draft.workingDirectory ?? ''} onChange={(e) => set('workingDirectory', e.target.value.replace(/[^A-Za-z0-9._-]/g, ''))} className="font-mono" maxLength={64} />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
            <Button variant="ghost" onClick={() => (step === 0 ? navigate(editing ? `/companions/${agentId}` : '/companions') : setStep(step - 1))}>
              {step === 0 ? 'Annuler' : (
                <>
                  <ArrowLeft /> Retour
                </>
              )}
            </Button>
            <div className="flex gap-2">
              {editing && !last && (
                <Button variant="secondary" disabled={!draft.name.trim() || update.isPending} onClick={save}>
                  Enregistrer
                </Button>
              )}
              {last ? (
                <Button variant="primary" disabled={!draft.name.trim() || create.isPending || update.isPending} onClick={save}>
                  {editing ? <Check /> : <Sparkles />} {editing ? 'Enregistrer' : `Créer ${draft.name || 'le compagnon'}`}
                </Button>
              ) : (
                <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
                  Continuer <ArrowRight />
                </Button>
              )}
            </div>
          </div>
        </div>

        <Preview draft={draft} />
      </div>
    </Page>
  )
}
