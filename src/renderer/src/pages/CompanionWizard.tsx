import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CreditCard, FolderOpen, Laptop, Lock, Rocket, Server, ShieldCheck, Sparkles, Ticket, Wand2, Zap } from 'lucide-react'
import { COMPANION_PRESETS, DEFAULT_PERMISSIONS, EXPRESSIONS, PALETTE_IDS, PALETTES, PERMISSION_LABELS, SPECIES, TEXTURES } from '@shared/catalog'
import { AUTONOMY_EXPLAINED } from '@shared/permission-labels'
import { EFFORT_LEVELS, ENGINE_INFO, engineBilling, isAgentEngine } from '@shared/engines'
import type { AgentInput } from '@shared/ipc'
import type { AgentPermissions, Appearance, AutonomyLevel, PaletteId, ProviderId, ProviderInfo } from '@shared/types'
import { Page, PageLoading } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { AdvancedSection, Badge, Input, Label, Switch, Textarea } from '@/components/ui/field'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useAction, useAgent, useProviders, useRemoteMachines, useSecurity } from '@/lib/queries'
import { Companion } from '@/orbit/Companion'
import { useConfirm } from '@/orbit/Confirm'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { Planet } from '@/orbit/Planet'
import { ProviderMark } from '@/orbit/ProviderMark'
import { toast } from 'sonner'
import { navigate } from '@/stores/router'

const STEPS = [
  { key: 'identity', label: 'Identité' },
  { key: 'look', label: 'Apparence' },
  { key: 'mind', label: 'Moteur' },
  { key: 'frame', label: 'Cadre' },
] as const

const AUTONOMY: { id: AutonomyLevel; label: string; body: string; icon: typeof Lock }[] = [
  { id: 'manual', label: AUTONOMY_EXPLAINED.manual.label, body: AUTONOMY_EXPLAINED.manual.short, icon: Lock },
  { id: 'supervised', label: AUTONOMY_EXPLAINED.supervised.label, body: AUTONOMY_EXPLAINED.supervised.short, icon: ShieldCheck },
  { id: 'automated', label: AUTONOMY_EXPLAINED.automated.label, body: AUTONOMY_EXPLAINED.automated.short, icon: Zap },
  { id: 'autonomous', label: AUTONOMY_EXPLAINED.autonomous.label, body: AUTONOMY_EXPLAINED.autonomous.short, icon: Rocket },
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

  const create = useAction('agents.create', { success: (a) => `${a.name} a rejoint votre univers`, onSuccess: (a) => navigate(`/companions/${a.id}`) })
  const update = useAction('agents.update', { success: 'Modifications enregistrées', onSuccess: (a) => navigate(`/companions/${a.id}`) })

  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const setLook = (patch: Partial<Appearance>) => setDraft((d) => ({ ...d, appearance: { ...d.appearance, ...patch } }))
  const setPlanet = (patch: Partial<Appearance['planet']>) => setDraft((d) => ({ ...d, appearance: { ...d.appearance, planet: { ...d.appearance.planet, ...patch } } }))
  const provider: ProviderInfo | undefined = providers.data?.find((p) => p.id === draft.providerId)
  const engineGroups = useMemo(() => groupEngines(providers.data ?? []), [providers.data])

  // Billing on a CLI engine is only known once its sign-in was checked, so check it
  // quietly on the engine step instead of showing « selon votre connexion » forever.
  const checked = useRef(new Set<ProviderId>())
  useEffect(() => {
    if (step !== 2) return
    for (const p of providers.data ?? []) {
      if (!SIGN_IN_ENGINES.includes(p.id) || p.lastValidatedAt || checked.current.has(p.id)) continue
      checked.current.add(p.id)
      void call('providers.validate', { providerId: p.id }).catch(() => undefined)
    }
  }, [step, providers.data])
  const canNext = step !== 0 || draft.name.trim().length > 0
  const last = step === STEPS.length - 1
  const confirm = useConfirm()
  // An agent engine acts on files: without a folder it could never start a mission.
  const missingFolder = isAgentEngine(draft.providerId) && !draft.workingDirectory?.trim()
  const blocker = !draft.name.trim() ? 'Donnez-lui un nom (étape Identité).' : missingFolder ? 'Choisissez son dossier de travail (étape Cadre).' : null

  const save = () => (editing ? update.mutate({ id: agentId!, patch: draft }) : create.mutate(draft))
  const textOf = (d: Pick<AgentInput, 'name' | 'role' | 'description' | 'instructions' | 'workingDirectory'>) => [d.name, d.role, d.description, d.instructions, d.workingDirectory ?? ''].join('\u0000')
  const dirty = textOf(draft) !== textOf(editing && existing.data ? existing.data : initialDraft())
  const leave = async () => {
    if (dirty && !(await confirm({ title: 'Quitter sans enregistrer ?', body: 'Vos modifications seront perdues.', confirm: 'Quitter', cancel: 'Rester', danger: true }))) return
    navigate(editing ? `/companions/${agentId}` : '/companions')
  }

  const sensitive = useMemo(() => (Object.keys(draft.permissions) as (keyof AgentPermissions)[]).filter((k) => draft.permissions[k] && PERMISSION_LABELS[k].sensitive), [draft.permissions])

  if (agentId && !loaded) return <PageLoading />

  return (
    <Page wide>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <button onClick={() => void leave()} className="no-drag mb-1 flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
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

          {step === 1 && (
            <div className="mt-6 space-y-6 border-t border-line pt-6">
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

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <Label>Moteur</Label>
                <div className="space-y-4">
                  {engineGroups.main.map((g) => (
                    <div key={g.title}>
                      <div className="mb-2 text-2xs text-fg-3">
                        <span className="font-medium text-fg-2">{g.title}</span> · {g.hint}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {g.items.map((p) => (
                          <EngineCard key={p.id} provider={p} selected={draft.providerId === p.id} onSelect={() => setDraft((d) => ({ ...d, providerId: p.id, model: p.models[0]?.id ?? d.model }))} />
                        ))}
                      </div>
                    </div>
                  ))}
                  {engineGroups.more.length > 0 && (
                    <AdvancedSection label="Autres moteurs" defaultOpen={engineGroups.more.some((p) => p.id === draft.providerId)}>
                      <div className="grid grid-cols-2 gap-2">
                        {engineGroups.more.map((p) => (
                          <EngineCard key={p.id} provider={p} selected={draft.providerId === p.id} onSelect={() => setDraft((d) => ({ ...d, providerId: p.id, model: p.models[0]?.id ?? d.model }))} />
                        ))}
                      </div>
                    </AdvancedSection>
                  )}
                </div>
                {provider?.capabilities.kind === 'agent' && (
                  <p className="mt-3 text-xs leading-relaxed text-fg-3">
                    {provider.name} travaille dans un dossier que vous choisirez à l’étape suivante, au fil de missions que vous suivez en direct. {provider.statusDetail}
                  </p>
                )}
                {provider && !provider.connected && provider.id !== 'demo' && provider.availability === 'available' && provider.capabilities.kind !== 'agent' && (
                  <p className="mt-3 text-xs text-fg-3">
                    Vous pourrez connecter {provider.name} dans{' '}
                    <button className="text-accent hover:underline" onClick={() => navigate('/settings/providers')}>
                      Paramètres → Moteurs
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
              <div>
                <Label hint="Envoyées à chaque échange">Instructions permanentes</Label>
                <Textarea className="min-h-36" value={draft.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder={`Tu es ${draft.name || 'un compagnon'}…`} />
              </div>
              {isAgentEngine(draft.providerId) && (
                <AdvancedSection>
                  <div>
                    <Label hint="Plus d’effort : réponses plus réfléchies, mais plus lentes et plus chères">Effort de raisonnement</Label>
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
                </AdvancedSection>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div>
                <Label>Niveau d’autonomie</Label>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
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
                {draft.autonomy === 'autonomous' && (
                  <p className="mt-2 rounded-[10px] bg-warning/[0.08] px-3 py-2 text-xs leading-relaxed text-fg-2 ring-1 ring-warning/30">
                    Mode autonome : ce compagnon ne vous demandera jamais d’accord. Installations, Git distant, suppressions, déploiements, secrets et outils externes s’exécutent sans confirmation (et sans le bac à sable des commandes de Claude), puis sont journalisés. Seules les permissions désactivées ci‑dessous et les données d’Orbit restent bloquées — réduisez-les pour borner ce qu’il peut faire, et activez l’isolation renforcée pour garder une barrière du système.
                  </p>
                )}
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
                    ? `Chaque action de ${provider.name} est vérifiée par Orbit avant de s’exécuter, uniquement dans le dossier de travail. Une permission désactivée bloque l’action ; ${draft.autonomy === 'autonomous' ? 'en mode autonome, tout ce que ces permissions autorisent s’exécute sans jamais vous solliciter' : draft.autonomy === 'automated' ? 'en mode automatique, seules les actions sensibles vous sont soumises' : draft.autonomy === 'supervised' ? 'en mode supervisé, lectures, modifications, tests et compilation se font sans vous déranger ; installations, déploiements, Git distant ou destructif, secrets et suppressions massives attendent votre accord' : 'en mode manuel, chaque modification, commande ou accès réseau attend votre accord'}.`
                    : `Ce moteur répond sans outils : ces permissions s’appliqueront s’il passe sur un moteur agent${sensitive.length > 0 && draft.autonomy === 'supervised' ? '. En mode supervisé, chaque mission demandera votre approbation' : ''}.`}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label hint={provider?.capabilities.kind === 'agent' ? 'Requis : seul dossier accessible' : undefined}>Dossier de travail</Label>
                  <div className="flex gap-2">
                    <Input readOnly value={draft.runtime === 'remote' ? `Sur la machine distante : projects/${draft.workingDirectory ?? ''}` : (draft.workingDirectory ?? '')} placeholder="Aucun" className="text-fg-2" disabled={draft.runtime === 'remote'} />
                    <Button
                      variant="secondary"
                      disabled={draft.runtime === 'remote'}
                      onClick={async () => {
                        try {
                          const dir = await call('app.chooseDirectory')
                          if (dir) set('workingDirectory', dir)
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : String(err))
                        }
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
                <AdvancedSection>
                  <div>
                    <Label hint="Bloque les lectures hors du projet">Isolation renforcée</Label>
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
                </AdvancedSection>
              )}
              {/* Choosing where to run only makes sense once a machine is connected. */}
              {(remoteMachines.data?.length || draft.runtime === 'remote') ? (
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
                        <span className={cn('block truncate text-2xs', m.engines.find((e) => e.id === draft.providerId)?.available ? 'text-fg-3' : 'text-warning')}>
                          {m.status === 'online' ? 'En ligne' : 'Hors ligne'} · {(() => {
                            const e = m.engines.find((x) => x.id === draft.providerId)
                            return !m.engines.length ? 'moteurs non détectés' : !e ? 'moteur absent' : e.available ? 'moteur prêt' : 'moteur non prêt'
                          })()}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                {draft.runtime === 'remote' && (() => {
                  const m = remoteMachines.data?.find((x) => x.id === draft.machineId)
                  const e = m?.engines.find((x) => x.id === draft.providerId)
                  return m && !e?.available ? <p className="mt-2 rounded-[10px] bg-warning/[0.05] px-3 py-2 text-[12px] text-warning ring-1 ring-warning/15">Ce moteur n’est pas prêt sur {m.name}{e ? ` : ${e.detail}` : ''}. Les missions y échoueront tant qu’il n’est pas installé et connecté sur le serveur. Orbit ne changera pas de moteur à votre place.</p> : null
                })()}
                {draft.runtime === 'remote' && (
                  <div className="mt-2">
                    <Label hint="Dossier sous projects/ sur la machine">Projet distant</Label>
                    <Input value={draft.workingDirectory ?? ''} onChange={(e) => set('workingDirectory', e.target.value.replace(/[^A-Za-z0-9._-]/g, ''))} className="font-mono" maxLength={64} />
                  </div>
                )}
              </div>
              ) : null}
            </div>
          )}

          <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
            <Button variant="ghost" onClick={() => (step === 0 ? void leave() : setStep(step - 1))}>
              {step === 0 ? 'Annuler' : (
                <>
                  <ArrowLeft /> Retour
                </>
              )}
            </Button>
            <div className="flex items-center gap-2">
              {(last || editing) && blocker && <span className="text-[12px] text-warning">{blocker}</span>}
              {editing ? (
                <>
                  {!last && (
                    <Button variant="ghost" onClick={() => setStep(step + 1)}>
                      Étape suivante <ArrowRight />
                    </Button>
                  )}
                  <Button variant="primary" disabled={Boolean(blocker) || update.isPending} onClick={save}>
                    <Check /> Enregistrer
                  </Button>
                </>
              ) : last ? (
                <Button variant="primary" disabled={Boolean(blocker) || create.isPending} onClick={save}>
                  <Sparkles /> Créer {draft.name || 'le compagnon'}
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

const SIGN_IN_ENGINES: ProviderId[] = ['claude-code', 'codex']

/**
 * Agents first, then chat-only engines. The Agent SDK does what Claude Code does but
 * always on API credits, so it is folded away once Claude Code is ready, together with
 * the engines that are not available yet.
 */
function groupEngines(list: ProviderInfo[]) {
  const claudeCodeReady = list.some((p) => p.id === 'claude-code' && p.connected)
  const folded = (p: ProviderInfo) => p.availability !== 'available' || (p.id === 'claude-agent' && claudeCodeReady)
  const shown = list.filter((p) => !folded(p))
  return {
    main: [
      { title: 'Agents', hint: 'travaillent dans un dossier : fichiers, commandes', items: shown.filter((p) => p.capabilities.kind === 'agent') },
      { title: 'Conversation', hint: 'répondent dans le chat, sans accès aux fichiers', items: shown.filter((p) => p.capabilities.kind !== 'agent') },
    ].filter((g) => g.items.length),
    more: list.filter(folded),
  }
}

function EngineCard({ provider: p, selected, onSelect }: { provider: ProviderInfo; selected: boolean; onSelect: () => void }) {
  const disabled = p.availability !== 'available'
  const billing = engineBilling(p)
  const BillingIcon = billing.kind === 'subscription' ? Ticket : CreditCard
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex items-start gap-3 rounded-[11px] p-3 text-left transition-[background,box-shadow] disabled:opacity-45',
        selected ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] enabled:hover:bg-white/[0.05]',
      )}
    >
      <ProviderMark id={p.id} size={26} />
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-[13px] leading-snug font-medium text-fg">{p.name}</span>
          {!disabled && p.id !== 'demo' && <Badge tone={p.connected ? 'success' : 'warning'}>{p.connected ? 'Prêt' : 'À connecter'}</Badge>}
        </span>
        <span className="block text-2xs leading-snug text-fg-3">{ENGINE_INFO[p.id].summary}</span>
        {!disabled && (
          <span className={cn('mt-1 flex items-start gap-1 text-2xs leading-snug', billing.kind === 'subscription' ? 'text-success' : billing.kind === 'api' ? 'text-fg-2' : 'text-fg-3')}>
            {billing.kind !== 'free' && <BillingIcon className="mt-px size-3 shrink-0" />}
            <span>{billing.label}</span>
          </span>
        )}
      </span>
    </button>
  )
}
