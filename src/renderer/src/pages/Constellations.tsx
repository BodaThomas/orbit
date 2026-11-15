import { useMemo, useState } from 'react'
import { Copy, LayoutTemplate, MoreHorizontal, Pencil, Play, Plus, Trash2, Waypoints } from 'lucide-react'
import type { ConstellationDefinition, ConstellationRun } from '@shared/types'
import { Page, PageHeader, Panel } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge, Label, Textarea } from '@/components/ui/field'
import { Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/overlay'
import { compactNumber, duration, relative } from '@/lib/format'
import { useAction, useAgents, useConstellationRuns, useConstellations } from '@/lib/queries'
import { useConfirm } from '@/orbit/Confirm'
import { ConstellationMap } from '@/orbit/ConstellationMap'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { navigate } from '@/stores/router'
import { ACTIVE_RUN_STATUSES, RUN_STATUS_INFO, TERMINAL_RUN_STATUSES } from '@shared/constellation-states'

/** Kept for existing imports: labels and tones of the run lifecycle. */
export const RUN_STATUS = RUN_STATUS_INFO

export function LaunchDialog({ def, onClose }: { def: ConstellationDefinition | null; onClose: () => void }) {
  const [goal, setGoal] = useState('')
  const launch = useAction('constellations.launch', {
    success: (r) => `« ${r.constellationName} » est en route`,
    onSuccess: (r) => {
      onClose()
      navigate(`/constellations/runs/${r.id}`)
    },
  })
  return (
    <Dialog open={Boolean(def)} onOpenChange={(o) => !o && onClose()}>
      {def && (
        <DialogContent title={`Lancer « ${def.name} »`} description="Le coordinateur répartit le travail, Orbit vérifie chaque délégation, puis vous recevez une synthèse." className="w-[560px]">
          <form
            className="space-y-4 px-5 pb-5"
            onSubmit={(e) => {
              e.preventDefault()
              if (goal.trim()) launch.mutate({ id: def.id, goal: goal.trim() })
            }}
          >
            <div>
              <Label hint={def.objective ? `Objectif permanent : ${def.objective.slice(0, 60)}` : undefined}>Que doit accomplir l’équipe ?</Label>
              <Textarea autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} className="min-h-32" placeholder="Ex. Analyse le projet, propose une amélioration de la page d’accueil et implémente-la." />
            </div>
            <div className="rounded-[10px] bg-white/[0.025] px-3 py-2 text-[12px] text-fg-3 ring-1 ring-line">
              Limites : {def.limits.maxSubtasks} sous-missions, {def.limits.maxParallel} en parallèle, {def.limits.maxDepth} tour{def.limits.maxDepth > 1 ? 's' : ''} de délégation, {def.limits.maxDurationMin} min
              {def.limits.maxBudgetUsd != null ? `, ${def.limits.maxBudgetUsd} $ mesurés` : ''}
              {def.limits.maxTokens != null ? `, ${compactNumber(def.limits.maxTokens)} jetons` : ''}.
            </div>
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={onClose}>Annuler</Button>
              <Button type="submit" variant="primary" disabled={!goal.trim() || launch.isPending}>
                <Play /> Lancer
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}

function DefinitionCard({ def, lastRun, onLaunch }: { def: ConstellationDefinition; lastRun?: ConstellationRun; onLaunch: () => void }) {
  const agents = useAgents()
  const confirm = useConfirm()
  const dup = useAction('constellations.duplicate', { success: (d) => `${d.name} créée` })
  const del = useAction('constellations.delete', { success: 'Constellation supprimée' })
  const nodes = def.members
    .map((m) => {
      const agent = agents.data?.find((a) => a.id === m.agentId)
      return agent ? { agent, role: m.role || agent.role, coordinator: m.agentId === def.coordinatorAgentId, state: 'idle' as const } : null
    })
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
  return (
    <section className="card card-hover flex flex-col overflow-hidden">
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{def.name}</h2>
            {def.isTemplate && <Badge tone="info">Modèle</Badge>}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12.5px] text-fg-3">{def.description || def.objective || `${def.members.length} compagnons`}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex size-7 items-center justify-center rounded-[7px] text-fg-3 hover:bg-white/5 hover:text-fg" aria-label="Actions">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => navigate(`/constellations/${def.id}/edit`)}><Pencil /> Modifier</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => dup.mutate({ id: def.id })}><Copy /> Dupliquer</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => dup.mutate({ id: def.id, asTemplate: true })}><LayoutTemplate /> Enregistrer comme modèle</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              onSelect={async () => {
                if (await confirm({ title: `Supprimer « ${def.name} » ?`, body: 'La définition et l’historique de ses exécutions seront supprimés. Les missions déjà réalisées restent visibles dans Missions.', confirm: 'Supprimer', danger: true })) del.mutate({ id: def.id })
              }}
            >
              <Trash2 /> Supprimer…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-3 pt-3">
        <ConstellationMap nodes={nodes} compact height={150} />
      </div>
      <div className="mt-auto flex items-center gap-2 px-4 py-3 text-[12px] text-fg-3">
        {lastRun ? (
          <button className="min-w-0 flex-1 truncate text-left hover:text-fg-2" onClick={() => navigate(`/constellations/runs/${lastRun.id}`)}>
            <Badge tone={RUN_STATUS[lastRun.status].tone}>{RUN_STATUS[lastRun.status].label}</Badge> <span className="ml-1">{relative(lastRun.createdAt)}</span>
          </button>
        ) : (
          <span className="flex-1">Jamais lancée</span>
        )}
        <Button size="sm" variant="secondary" onClick={onLaunch} disabled={def.isTemplate}>
          <Play /> Lancer
        </Button>
      </div>
    </section>
  )
}

export function ConstellationsPage() {
  const defs = useConstellations()
  const runs = useConstellationRuns()
  const agents = useAgents()
  const [launching, setLaunching] = useState<ConstellationDefinition | null>(null)
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data])
  const list = defs.data ?? []
  const active = (runs.data ?? []).filter((r) => ACTIVE_RUN_STATUSES.includes(r.status))
  // Unfinished runs survive a restart: waiting for a decision, paused, blocked or failed.
  const unfinished = (runs.data ?? []).filter((r) => !ACTIVE_RUN_STATUSES.includes(r.status) && !TERMINAL_RUN_STATUSES.includes(r.status))

  return (
    <Page wide>
      <PageHeader
        title="Constellations"
        subtitle={list.length ? `${list.length} constellation${list.length > 1 ? 's' : ''}${active.length ? ` · ${active.length} en cours` : ''} · des compagnons qui collaborent sur un objectif commun` : 'Des compagnons qui collaborent sur un objectif commun.'}
        actions={
          <Button variant="primary" onClick={() => navigate('/constellations/new')} disabled={(agents.data?.length ?? 0) < 2}>
            <Plus /> Nouvelle constellation
          </Button>
        }
      />
      {defs.data && list.length === 0 ? (
        <div className="card">
          <OrbitEmptyState
            title="Aucune constellation pour l’instant"
            body="Réunissez plusieurs compagnons autour d’un coordinateur : il répartit le travail, chacun agit avec son propre moteur et ses permissions, et vous recevez une synthèse. Chaque délégation est vérifiée par Orbit."
            hints={[
              { icon: <Waypoints />, label: 'Un coordinateur' },
              { icon: <Play />, label: 'Des sous-missions suivies' },
              { icon: <LayoutTemplate />, label: 'Réutilisable comme modèle' },
            ]}
            action={
              <Button variant="primary" onClick={() => navigate('/constellations/new')} disabled={(agents.data?.length ?? 0) < 2}>
                <Plus /> Créer une constellation
              </Button>
            }
          />
        </div>
      ) : (
        <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
          {list.map((d) => (
            <DefinitionCard key={d.id} def={d} lastRun={(runs.data ?? []).find((r) => r.constellationId === d.id)} onLaunch={() => setLaunching(d)} />
          ))}
        </div>
      )}
      {unfinished.length > 0 && (
        <Panel title={<span>Missions inachevées <span className="font-normal text-fg-3">· à reprendre, valider ou débloquer</span></span>} className="mb-4">
          <div className="space-y-px">
            {unfinished.map((r) => (
              <button key={r.id} onClick={() => navigate(`/constellations/runs/${r.id}`)} className="grid w-full grid-cols-[150px_minmax(0,1fr)_120px] items-center gap-3 rounded-[10px] px-3 py-2 text-left hover:bg-white/[0.03]">
                <span><Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge></span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-fg">{r.goal.split('\n')[0]}</span>
                  <span className="block truncate text-2xs text-fg-3">{r.constellationName} · {r.error ?? RUN_STATUS[r.status].hint}</span>
                </span>
                <span className="text-right text-2xs text-fg-3">{relative(r.createdAt)}</span>
              </button>
            ))}
          </div>
        </Panel>
      )}
      {(runs.data?.length ?? 0) > 0 && (
        <Panel title="Exécutions récentes">
          <div className="space-y-px">
            {runs.data!.slice(0, 20).map((r) => {
              const coord = byId.get(r.coordinatorAgentId)
              return (
                <button key={r.id} onClick={() => navigate(`/constellations/runs/${r.id}`)} className="grid w-full grid-cols-[110px_minmax(0,1fr)_140px_120px] items-center gap-3 rounded-[10px] px-3 py-2 text-left hover:bg-white/[0.03]">
                  <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-fg">{r.goal.split('\n')[0]}</span>
                    <span className="block truncate text-2xs text-fg-3">{r.constellationName} · coordination {coord?.name ?? '?'}{r.origin === 'automation' ? ' · automatisation' : ''}</span>
                  </span>
                  <span className="text-right text-2xs text-fg-3 tabular">{compactNumber(r.tokens)} jetons · {duration(r.startedAt, r.finishedAt)}</span>
                  <span className="text-right text-2xs text-fg-3">{relative(r.createdAt)}</span>
                </button>
              )
            })}
          </div>
        </Panel>
      )}
      <LaunchDialog def={launching} onClose={() => setLaunching(null)} />
    </Page>
  )
}
