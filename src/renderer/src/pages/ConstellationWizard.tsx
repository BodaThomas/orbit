import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Crown, FolderOpen, GitBranch, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import { DEFAULT_PERMISSIONS, PERMISSION_LABELS } from '@shared/catalog'
import { ENGINE_INFO, isAgentEngine } from '@shared/engines'
import type { PlanApprovalPolicy, AgentPermissions, ConstellationLimits, ConstellationMember } from '@shared/types'
import { Page } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Input, Label, Segmented, Switch, Textarea } from '@/components/ui/field'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useAction, useAgents, useConstellations } from '@/lib/queries'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { ConstellationMap } from '@/orbit/ConstellationMap'
import { toast } from 'sonner'
import { navigate } from '@/stores/router'

const STEPS = [
  { key: 'identity', label: 'Nom' },
  { key: 'goal', label: 'Objectif' },
  { key: 'team', label: 'Équipe' },
  { key: 'roles', label: 'Rôles' },
  { key: 'frame', label: 'Cadre' },
  { key: 'limits', label: 'Limites' },
  { key: 'review', label: 'Validation' },
] as const

const DEFAULT_LIMITS: ConstellationLimits = { maxDepth: 2, maxSubtasks: 8, maxParallel: 2, maxDurationMin: 60, maxTokens: 2_000_000, maxBudgetUsd: 5 }

interface Draft {
  name: string
  description: string
  objective: string
  coordinatorAgentId: string | null
  members: ConstellationMember[]
  workspace: string | null
  workspaceMode: 'shared' | 'worktrees'
  permissions: AgentPermissions
  limits: ConstellationLimits
  isTemplate: boolean
  planApproval: PlanApprovalPolicy
}

const empty = (): Draft => ({ name: '', description: '', objective: '', coordinatorAgentId: null, members: [], workspace: null, workspaceMode: 'shared', permissions: { ...DEFAULT_PERMISSIONS, readFiles: true, writeFiles: true }, limits: { ...DEFAULT_LIMITS }, isTemplate: false, planApproval: 'writes' })

function NumberField({ label, hint, value, onChange, min, max, step = 1, suffix, nullable }: { label: string; hint?: string; value: number | null; onChange: (v: number | null) => void; min: number; max?: number; step?: number; suffix?: string; nullable?: boolean }) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <div className="relative">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value ?? ''}
          placeholder={nullable ? 'Aucune' : undefined}
          onChange={(e) => onChange(e.target.value === '' ? (nullable ? null : min) : Math.max(min, Math.min(max ?? Infinity, Number(e.target.value))))}
          className="pr-12 tabular"
        />
        {suffix && <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-fg-3">{suffix}</span>}
      </div>
    </div>
  )
}

export function ConstellationWizardPage({ constellationId }: { constellationId?: string }) {
  const agents = useAgents()
  const defs = useConstellations()
  const [step, setStep] = useState(0)
  const [d, setD] = useState<Draft>(empty)
  const [loaded, setLoaded] = useState(!constellationId)
  const editing = Boolean(constellationId)
  useEffect(() => {
    const existing = defs.data?.find((x) => x.id === constellationId)
    if (constellationId && existing && !loaded) {
      setD({ ...existing })
      setLoaded(true)
    }
  }, [constellationId, defs.data, loaded])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const list = (agents.data ?? []).filter((a) => a.enabled)
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])
  const toggleMember = (id: string) =>
    setD((x) => {
      const has = x.members.some((m) => m.agentId === id)
      const members = has ? x.members.filter((m) => m.agentId !== id) : [...x.members, { agentId: id, role: byId.get(id)?.role ?? '', responsibilities: '', canDelegate: false }]
      const coordinatorAgentId = has && x.coordinatorAgentId === id ? null : x.coordinatorAgentId ?? (members.length === 1 ? id : null)
      return { ...x, members: members.map((m) => ({ ...m, canDelegate: m.agentId === coordinatorAgentId })), coordinatorAgentId }
    })
  const setCoordinator = (id: string) => setD((x) => ({ ...x, coordinatorAgentId: id, members: x.members.map((m) => ({ ...m, canDelegate: m.agentId === id })) }))
  const setMember = (id: string, patch: Partial<ConstellationMember>) => setD((x) => ({ ...x, members: x.members.map((m) => (m.agentId === id ? { ...m, ...patch } : m)) }))

  const engines = d.members.map((m) => byId.get(m.agentId)).filter((a) => a && isAgentEngine(a.providerId))
  const warnings: string[] = []
  if (d.members.length < 2) warnings.push('Une constellation réunit au moins deux compagnons.')
  if (!d.coordinatorAgentId) warnings.push('Choisissez un coordinateur.')
  if (engines.length && !d.workspace) {
    const missing = engines.filter((a) => !a!.workingDirectory)
    if (missing.length) warnings.push(`${missing.map((a) => a!.name).join(', ')} n’ont pas de dossier : choisissez le dossier de la constellation.`)
  }
  const coordinator = d.coordinatorAgentId ? byId.get(d.coordinatorAgentId) : null
  const canNext = [d.name.trim().length > 0, true, d.members.length >= 2 && Boolean(d.coordinatorAgentId), true, true, true, warnings.length === 0][step]

  const create = useAction('constellations.create', { success: (c) => `« ${c.name} » est prête`, onSuccess: () => navigate('/constellations') })
  const update = useAction('constellations.update', { success: 'Constellation mise à jour', onSuccess: () => navigate('/constellations') })
  const save = () => {
    if (!d.coordinatorAgentId) return
    const input = { ...d, coordinatorAgentId: d.coordinatorAgentId, name: d.name.trim() }
    if (editing) update.mutate({ id: constellationId!, input })
    else create.mutate(input)
  }

  const nodes = d.members
    .map((m) => {
      const agent = byId.get(m.agentId)
      return agent ? { agent, role: m.role || agent.role, coordinator: m.agentId === d.coordinatorAgentId, state: 'idle' as const, caption: ENGINE_INFO[agent.providerId].label } : null
    })
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
  if (!loaded) return null

  return (
    <Page wide>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/constellations')} className="no-drag mb-1 flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
            <ArrowLeft className="size-3.5" /> Constellations
          </button>
          <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-fg">{editing ? `Modifier « ${d.name} »` : 'Nouvelle constellation'}</h1>
        </div>
        <ol className="no-drag flex items-center gap-1" aria-label="Étapes">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1">
              <button onClick={() => (editing || i <= step) && setStep(i)} aria-current={i === step ? 'step' : undefined} className={cn('flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors', i === step ? 'bg-white/[0.08] text-fg' : i < step ? 'text-fg-2 hover:text-fg' : 'text-fg-3')}>
                <span className={cn('flex size-4 items-center justify-center rounded-full text-[10px] tabular', i < step ? 'bg-accent text-[#14112b]' : i === step ? 'bg-fg text-canvas' : 'bg-white/10')}>{i < step ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}</span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <span className="h-px w-2 bg-line-strong" />}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(340px,440px)] gap-6">
        <div className="min-w-0 rounded-2xl bg-surface p-6 ring-1 ring-line">
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <Label>Nom</Label>
                <Input autoFocus value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex. Développement Orbit" maxLength={80} />
              </div>
              <div>
                <Label hint="Pour vous retrouver">Description</Label>
                <Textarea value={d.description} onChange={(e) => set('description', e.target.value)} className="min-h-24" placeholder="Une équipe qui analyse, développe et vérifie les évolutions d’Orbit." />
              </div>
            </div>
          )}
          {step === 1 && (
            <div>
              <Label hint="Rappelé au coordinateur à chaque exécution">Objectif principal</Label>
              <Textarea autoFocus value={d.objective} onChange={(e) => set('objective', e.target.value)} className="min-h-40" placeholder="Faire évoluer Orbit avec des changements petits, testés et documentés." />
              <p className="mt-2 text-xs text-fg-3">Chaque lancement précise ensuite la demande du moment. L’objectif sert de cap commun.</p>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <Label hint="Un compagnon peut appartenir à plusieurs constellations">Compagnons</Label>
                <div className="grid grid-cols-2 gap-2">
                  {list.map((a) => {
                    const on = d.members.some((m) => m.agentId === a.id)
                    return (
                      <button key={a.id} type="button" aria-pressed={on} onClick={() => toggleMember(a.id)} className={cn('flex items-center gap-3 rounded-[12px] p-2.5 text-left transition-[background,box-shadow]', on ? 'bg-accent/[0.09] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]')}>
                        <CompanionAvatar appearance={a.appearance} size={36} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13.5px] font-medium text-fg">{a.name}</span>
                          <span className="block truncate text-2xs text-fg-3">{a.role} · {ENGINE_INFO[a.providerId].label}</span>
                        </span>
                        {on && <Check className="size-4 text-accent" />}
                      </button>
                    )
                  })}
                </div>
              </div>
              {d.members.length > 0 && (
                <div>
                  <Label hint="Organise, délègue et synthétise">Coordinateur</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {d.members.map((m) => {
                      const a = byId.get(m.agentId)
                      if (!a) return null
                      return (
                        <button key={m.agentId} type="button" onClick={() => setCoordinator(m.agentId)} aria-pressed={d.coordinatorAgentId === m.agentId} className={cn('flex h-9 items-center gap-2 rounded-full pr-3 pl-1 text-[13px]', d.coordinatorAgentId === m.agentId ? 'bg-accent/[0.12] text-fg shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.55)]' : 'bg-white/[0.03] text-fg-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06]')}>
                          <CompanionAvatar appearance={a.appearance} size={26} />
                          {a.name}
                          {d.coordinatorAgentId === m.agentId && <Crown className="size-3.5 text-accent" />}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          {step === 3 && (
            <div className="space-y-3">
              {d.members.map((m) => {
                const a = byId.get(m.agentId)
                if (!a) return null
                const coord = m.agentId === d.coordinatorAgentId
                return (
                  <div key={m.agentId} className="rounded-[12px] bg-white/[0.02] p-3 ring-1 ring-line">
                    <div className="mb-2 flex items-center gap-2.5">
                      <CompanionAvatar appearance={a.appearance} size={28} />
                      <span className="text-[13.5px] font-medium text-fg">{a.name}</span>
                      <span className="text-2xs text-fg-3">{ENGINE_INFO[a.providerId].label}</span>
                      {coord && <Badge tone="accent">Coordination</Badge>}
                    </div>
                    <div className="grid grid-cols-[180px_1fr] gap-2">
                      <Input value={m.role} onChange={(e) => setMember(m.agentId, { role: e.target.value })} placeholder="Rôle" maxLength={80} />
                      <Input value={m.responsibilities} onChange={(e) => setMember(m.agentId, { responsibilities: e.target.value })} placeholder={coord ? 'Organise les missions et synthétise les résultats.' : 'Ce que le coordinateur peut lui confier'} maxLength={1000} />
                    </div>
                    {coord && (
                      <label className="mt-2 flex items-center gap-2 text-xs text-fg-2">
                        <Switch checked={m.canDelegate} onChange={(v) => setMember(m.agentId, { canDelegate: v })} label="Autoriser la délégation" /> Autoriser {a.name} à créer des sous-missions
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {step === 4 && (
            <div className="space-y-5">
              <div>
                <Label hint="Choisi par vous : tous les membres y travaillent">Dossier de travail</Label>
                <div className="flex gap-2">
                  <Input readOnly value={d.workspace ?? ''} placeholder="Dossier de chaque compagnon" className="text-fg-2" />
                  <Button variant="secondary" onClick={async () => {
                    try {
                      const dir = await call('app.chooseDirectory')
                      if (dir) set('workspace', dir)
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : String(err))
                    }
                  }}>
                    <FolderOpen /> Choisir
                  </Button>
                  {d.workspace && <Button variant="ghost" onClick={() => set('workspace', null)}>Retirer</Button>}
                </div>
              </div>
              <div>
                <Label>Modifications simultanées</Label>
                <Segmented
                  value={d.workspaceMode}
                  onChange={(v) => set('workspaceMode', v)}
                  options={[
                    { value: 'shared', label: 'Dossier partagé, un rédacteur à la fois' },
                    { value: 'worktrees', label: 'Un worktree Git par rédacteur' },
                  ]}
                />
                <p className="mt-2 flex gap-2 text-xs leading-relaxed text-fg-3">
                  <GitBranch className="mt-0.5 size-3.5 shrink-0" />
                  {d.workspaceMode === 'worktrees'
                    ? 'Chaque compagnon qui écrit reçoit sa propre copie de travail sur une branche dédiée. Vous comparez les diffs, Orbit détecte les conflits, et rien n’est fusionné sans votre clic. Les worktrees séparent les espaces de travail ; ils ne constituent pas une isolation de sécurité.'
                    : 'Les lectures se font en parallèle ; deux compagnons n’écrivent jamais en même temps dans le dossier.'}
                </p>
              </div>
              <div>
                <Label hint="Plafond : jamais plus que ce que chaque compagnon a déjà">Permissions maximales</Label>
                <div className="divide-y divide-line rounded-[12px] bg-white/[0.02] ring-1 ring-line">
                  {(['readFiles', 'writeFiles', 'runCommands', 'network', 'externalActions'] as (keyof AgentPermissions)[]).map((k) => (
                    <div key={k} className="flex items-center justify-between px-3.5 py-2.5">
                      <span className="text-[13px] text-fg-2">{PERMISSION_LABELS[k].label}</span>
                      <Switch checked={d.permissions[k]} onChange={(v) => set('permissions', { ...d.permissions, [k]: v })} label={PERMISSION_LABELS[k].label} />
                    </div>
                  ))}
                </div>
                <p className="mt-2 flex gap-2 text-xs text-fg-3"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" />Chaque action reste soumise aux règles et approbations habituelles du compagnon qui l’exécute.</p>
              </div>
            </div>
          )}
          {step === 5 && (
            <div className="space-y-5">
              <div>
                <div className="mb-2 text-xs font-medium text-fg-2">Consommation</div>
                <div className="grid grid-cols-3 gap-3">
                  <NumberField label="Budget mesuré" hint="Dépense API connue" value={d.limits.maxBudgetUsd} onChange={(v) => set('limits', { ...d.limits, maxBudgetUsd: v })} min={0} max={10000} step={0.5} suffix="$" nullable />
                  <NumberField label="Jetons" value={d.limits.maxTokens} onChange={(v) => set('limits', { ...d.limits, maxTokens: v })} min={1000} max={100_000_000} step={50000} nullable />
                  <NumberField label="Durée maximale" value={d.limits.maxDurationMin} onChange={(v) => set('limits', { ...d.limits, maxDurationMin: v ?? 60 })} min={1} max={1440} suffix="min" />
                </div>
                <p className="mt-2 text-xs text-fg-3">Un abonnement (Claude Code, Codex via ChatGPT) n’a pas de coût mesurable : seuls les jetons, la durée et le nombre de sous-missions le limitent. Orbit ne promet pas de plafond en dollars dans ce cas.</p>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-fg-2">Délégation</div>
                <div className="grid grid-cols-3 gap-3">
                  <NumberField label="Sous-missions au total" value={d.limits.maxSubtasks} onChange={(v) => set('limits', { ...d.limits, maxSubtasks: v ?? 1 })} min={1} max={50} />
                  <NumberField label="En parallèle" value={d.limits.maxParallel} onChange={(v) => set('limits', { ...d.limits, maxParallel: v ?? 1 })} min={1} max={8} />
                  <NumberField label="Tours de délégation" hint="Profondeur" value={d.limits.maxDepth} onChange={(v) => set('limits', { ...d.limits, maxDepth: v ?? 1 })} min={1} />
                </div>
                <p className="mt-2 text-xs text-fg-3">Un membre ne peut pas déléguer à son tour, et le coordinateur ne peut pas se confier de mission : aucune boucle possible.</p>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-fg-2">Validation des plans</div>
                <Segmented
                  value={d.planApproval}
                  onChange={(v) => set('planApproval', v)}
                  options={[
                    { value: 'auto', label: 'Automatique', title: 'Les plans validés par Orbit démarrent aussitôt' },
                    { value: 'writes', label: 'Si le plan modifie', title: 'Votre accord quand une sous-mission peut modifier des fichiers ou exécuter des commandes' },
                    { value: 'always', label: 'Toujours', title: 'Votre accord pour chaque plan' },
                  ]}
                />
                <p className="mt-2 text-xs text-fg-3">Dans tous les cas, un plan reçu au fil d’une discussion avec le coordinateur, ou que le coordinateur vous soumet lui-même, attend votre accord explicite. Un accord vaut pour un plan précis, pas pour les suivants.</p>
              </div>
            </div>
          )}
          {step === 6 && (
            <div className="space-y-4">
              {warnings.length > 0 && (
                <div className="space-y-1 rounded-[11px] bg-warning/[0.06] p-3 text-[12.5px] text-fg-2 ring-1 ring-warning/20">
                  {warnings.map((w) => (
                    <div key={w} className="flex gap-2"><TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />{w}</div>
                  ))}
                </div>
              )}
              <div className="divide-y divide-line rounded-[12px] bg-white/[0.02] text-[13px] ring-1 ring-line">
                {[
                  ['Nom', d.name || '—'],
                  ['Coordination', coordinator ? `${coordinator.name} · ${ENGINE_INFO[coordinator.providerId].label}${d.members.find((m) => m.agentId === coordinator.id)?.canDelegate ? '' : ' · délégation désactivée'}` : '—'],
                  ['Membres', d.members.filter((m) => m.agentId !== d.coordinatorAgentId).map((m) => `${byId.get(m.agentId)?.name} (${m.role || '—'})`).join(', ') || '—'],
                  ['Moteurs', [...new Set(d.members.map((m) => ENGINE_INFO[byId.get(m.agentId)?.providerId ?? 'demo'].label))].join(' · ')],
                  ['Dossier', d.workspace ?? 'Dossier de chaque compagnon'],
                  ['Écritures simultanées', d.workspaceMode === 'worktrees' ? 'Worktree Git par rédacteur' : 'Un rédacteur à la fois'],
                  ['Permissions maximales', (Object.keys(PERMISSION_LABELS) as (keyof AgentPermissions)[]).filter((k) => d.permissions[k]).map((k) => PERMISSION_LABELS[k].label).join(', ') || 'Lecture seule'],
                  ['Limites', `${d.limits.maxSubtasks} sous-missions · ${d.limits.maxParallel} en parallèle · ${d.limits.maxDepth} tour(s) · ${d.limits.maxDurationMin} min`],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 px-3.5 py-2">
                    <span className="shrink-0 text-fg-3">{k}</span>
                    <span className="text-right text-fg">{v}</span>
                  </div>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[13px] text-fg-2">
                <Switch checked={d.isTemplate} onChange={(v) => set('isTemplate', v)} label="Modèle réutilisable" /> Enregistrer comme modèle réutilisable (dupliquez-le pour l’utiliser)
              </label>
            </div>
          )}

          <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
            <Button variant="ghost" onClick={() => (step === 0 ? navigate('/constellations') : setStep(step - 1))}>{step === 0 ? 'Annuler' : <><ArrowLeft /> Précédent</>}</Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Suivant <ArrowRight />
              </Button>
            ) : (
              <Button variant="primary" disabled={!canNext || create.isPending || update.isPending} onClick={save}>
                <Check /> {editing ? 'Enregistrer' : 'Créer la constellation'}
              </Button>
            )}
          </div>
        </div>
        <div className="sticky top-[60px] space-y-3 self-start">
          {nodes.length ? (
            <ConstellationMap nodes={nodes} height={330} />
          ) : (
            <div className="flex h-[330px] flex-col items-center justify-center gap-2 rounded-[14px] bg-[radial-gradient(ellipse_at_50%_38%,#1b1e2d_0%,#13141b_62%)] text-[13px] text-fg-3 ring-1 ring-line">
              <Users className="size-5" /> Ajoutez des compagnons pour former la constellation
            </div>
          )}
          <p className="px-1 text-xs leading-relaxed text-fg-3">Chaque compagnon garde son identité, son moteur, son modèle, ses permissions et sa mémoire. Le coordinateur répartit le travail ; Orbit vérifie chaque délégation avant de l’exécuter.</p>
        </div>
      </div>
    </Page>
  )
}
