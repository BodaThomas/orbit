import { useEffect, useState } from 'react'
import { FolderOpen, Rocket, TriangleAlert, Waypoints } from 'lucide-react'
import type { MissionPriority } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input, Kbd, Label, Segmented, Switch, Textarea } from '@/components/ui/field'
import { Dialog, DialogContent } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { useAction, useAgents, useConstellations, useProviders } from '@/lib/queries'
import { Companion } from '@/orbit/Companion'
import { PRIORITY_LABELS } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

export function NewMissionDialog() {
  const target = useUi((s) => s.newMissionFor)
  const open = target !== undefined
  const agents = useAgents()
  const providers = useProviders()
  const [agentId, setAgentId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<MissionPriority>('normal')
  const [startNow, setStartNow] = useState(true)
  const [mode, setMode] = useState<'agent' | 'constellation'>('agent')
  const [constellationId, setConstellationId] = useState<string | null>(null)
  const constellations = useConstellations()
  const launch = useAction('constellations.launch', {
    success: (r) => `« ${r.constellationName} » est en route`,
    onSuccess: (r) => {
      useUi.getState().closeNewMission()
      navigate(`/constellations/runs/${r.id}`)
    },
  })
  const create = useAction('missions.create', {
    success: (m) => (m.status === 'approval_required' ? 'Mission créée — approbation demandée' : m.status === 'running' ? 'Mission lancée' : 'Mission créée'),
    onSuccess: (m) => {
      useUi.getState().closeNewMission()
      navigate(`/missions/${m.id}`)
    },
  })

  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setPriority('normal')
    setStartNow(true)
    setAgentId(target ?? agents.data?.find((a) => a.enabled)?.id ?? null)
    setMode('agent')
    setConstellationId(constellations.data?.[0]?.id ?? null)
  }, [open, target]) // eslint-disable-line react-hooks/exhaustive-deps

  const enabled = (agents.data ?? []).filter((a) => a.enabled)
  const selected = enabled.find((a) => a.id === agentId)
  const engine = providers.data?.find((p) => p.id === selected?.providerId && p.capabilities.kind === 'agent')
  const missingFolder = Boolean(engine && !selected?.workingDirectory)
  const defs = constellations.data ?? []
  const chosen = defs.find((d) => d.id === constellationId)
  const submit = () => {
    // ⌘↵ bypasses the disabled submit button: guard here too.
    if (launch.isPending || create.isPending) return
    if (mode === 'constellation') {
      if (chosen && title.trim()) launch.mutate({ id: chosen.id, goal: description.trim() ? `${title.trim()}\n\n${description.trim()}` : title.trim() })
      return
    }
    if (agentId && title.trim() && !missingFolder) create.mutate({ agentId, title: title.trim(), description, priority, startNow })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && useUi.getState().closeNewMission()}>
      {open && (
        <DialogContent title="Nouvelle mission" description={mode === 'agent' ? 'Confiez une tâche à l’un de vos compagnons.' : 'Confiez un objectif à une équipe : le coordinateur répartit le travail et vous présente une synthèse.'} className="w-[600px]">
          <form
            className="space-y-4 px-5 pb-5"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.metaKey) submit()
            }}
          >
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'agent', label: 'Un compagnon' },
                { value: 'constellation', label: `Une constellation${defs.length ? '' : ' (aucune)'}` },
              ]}
            />
            {mode === 'constellation' ? (
              defs.length ? (
                <div>
                  <Label>Constellation</Label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {defs.map((d) => {
                      const members = d.members.map((m) => agents.data?.find((a) => a.id === m.agentId)).filter(Boolean)
                      return (
                        <button
                          type="button"
                          key={d.id}
                          onClick={() => setConstellationId(d.id)}
                          aria-pressed={constellationId === d.id}
                          className={cn('flex items-center gap-2.5 rounded-[11px] px-3 py-2 text-left', constellationId === d.id ? 'bg-accent/[0.1] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.55)]' : 'bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06]')}
                        >
                          <span className="flex -space-x-2">{members.slice(0, 4).map((a) => <Companion key={a!.id} appearance={a!.appearance} size={22} />)}</span>
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] text-fg">{d.name}</span>
                            <span className="block truncate text-2xs text-fg-3">Coordination : {agents.data?.find((a) => a.id === d.coordinatorAgentId)?.name}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div className="rounded-[10px] bg-white/[0.025] px-3 py-3 text-[12.5px] text-fg-3 ring-1 ring-line">
                  Aucune constellation pour l’instant.{' '}
                  <button type="button" className="text-accent hover:underline" onClick={() => { useUi.getState().closeNewMission(); navigate('/constellations/new') }}>Créer une constellation</button>
                </div>
              )
            ) : (
            <>
            <div>
              <Label>Compagnon</Label>
              <div className="flex flex-wrap gap-1.5">
                {enabled.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    onClick={() => setAgentId(a.id)}
                    aria-pressed={agentId === a.id}
                    className={cn('flex h-9 items-center gap-2 rounded-full pr-3 pl-1 text-[13px] transition-colors', agentId === a.id ? 'bg-accent/[0.12] text-fg shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.55)]' : 'bg-white/[0.03] text-fg-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06]')}
                  >
                    <Companion appearance={a.appearance} size={26} />
                    {a.name}
                  </button>
                ))}
              </div>
            </div>
            {engine && selected && (
              missingFolder ? (
                <div className="flex items-center gap-2.5 rounded-[10px] bg-warning/[0.06] px-3 py-2.5 text-[12.5px] text-fg-2 ring-1 ring-warning/20">
                  <TriangleAlert className="size-4 shrink-0 text-warning" />
                  <span className="flex-1">{selected.name} utilise {engine.name} : choisissez d’abord le dossier qu’il a le droit de toucher.</span>
                  <Button size="xs" variant="secondary" onClick={() => { useUi.getState().closeNewMission(); navigate(`/companions/${selected.id}/edit`) }}>
                    Choisir
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-[10px] bg-white/[0.025] px-3 py-2 text-[12.5px] text-fg-3 ring-1 ring-line">
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {engine.name} · <span className="font-mono text-[11.5px] text-fg-2">{selected.workingDirectory}</span>
                  </span>
                  {!engine.connected && <span className="text-warning">moteur à vérifier</span>}
                </div>
              )
            )}
            </>
            )}
            <div>
              <Label>{mode === 'constellation' ? 'Objectif' : 'Titre'}</Label>
              <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Synthétiser les retours utilisateurs de la semaine" maxLength={160} />
            </div>
            <div>
              <Label hint="Contexte, livrable attendu, contraintes">Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-28" />
            </div>
            {mode === 'agent' && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-xs text-fg-2">Priorité</span>
                <Segmented value={priority} onChange={setPriority} options={(['low', 'normal', 'high', 'urgent'] as const).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
              </div>
              <label className="flex items-center gap-2 text-xs text-fg-2">
                <Switch checked={startNow} onChange={setStartNow} label="Lancer maintenant" /> Lancer maintenant
              </label>
            </div>
            )}
            <div className="flex items-center justify-between border-t border-line pt-4">
              <span className="text-2xs text-fg-3">
                <Kbd>⌘</Kbd> <Kbd>↵</Kbd> pour créer
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => useUi.getState().closeNewMission()}>
                  Annuler
                </Button>
                {mode === 'constellation' ? (
                  <Button type="submit" variant="primary" disabled={!chosen || !title.trim() || launch.isPending}>
                    <Waypoints /> Lancer la constellation
                  </Button>
                ) : (
                  <Button type="submit" variant="primary" disabled={!agentId || !title.trim() || missingFolder || create.isPending}>
                    <Rocket /> {startNow ? 'Lancer la mission' : 'Créer la mission'}
                  </Button>
                )}
              </div>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}
