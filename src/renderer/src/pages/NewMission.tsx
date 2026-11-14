import { useEffect, useState } from 'react'
import { Rocket } from 'lucide-react'
import type { MissionPriority } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input, Kbd, Label, Segmented, Switch, Textarea } from '@/components/ui/field'
import { Dialog, DialogContent } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { useAction, useAgents } from '@/lib/queries'
import { Companion } from '@/orbit/Companion'
import { PRIORITY_LABELS } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

export function NewMissionDialog() {
  const target = useUi((s) => s.newMissionFor)
  const open = target !== undefined
  const agents = useAgents()
  const [agentId, setAgentId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<MissionPriority>('normal')
  const [startNow, setStartNow] = useState(true)
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
  }, [open, target]) // eslint-disable-line react-hooks/exhaustive-deps

  const enabled = (agents.data ?? []).filter((a) => a.enabled)
  const submit = () => agentId && title.trim() && create.mutate({ agentId, title: title.trim(), description, priority, startNow })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && useUi.getState().closeNewMission()}>
      {open && (
        <DialogContent title="Nouvelle mission" description="Confiez une tâche à l’un de vos compagnons." className="w-[600px]">
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
            <div>
              <Label>Titre</Label>
              <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Synthétiser les retours utilisateurs de la semaine" maxLength={160} />
            </div>
            <div>
              <Label hint="Contexte, livrable attendu, contraintes">Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-28" />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-xs text-fg-2">Priorité</span>
                <Segmented value={priority} onChange={setPriority} options={(['low', 'normal', 'high', 'urgent'] as const).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
              </div>
              <label className="flex items-center gap-2 text-xs text-fg-2">
                <Switch checked={startNow} onChange={setStartNow} label="Lancer maintenant" /> Lancer maintenant
              </label>
            </div>
            <div className="flex items-center justify-between border-t border-line pt-4">
              <span className="text-2xs text-fg-3">
                <Kbd>⌘</Kbd> <Kbd>↵</Kbd> pour créer
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => useUi.getState().closeNewMission()}>
                  Annuler
                </Button>
                <Button type="submit" variant="primary" disabled={!agentId || !title.trim() || create.isPending}>
                  <Rocket /> {startNow ? 'Lancer la mission' : 'Créer la mission'}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}
