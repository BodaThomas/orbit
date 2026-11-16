import { useState } from 'react'
import { Eye, FileText, FolderSearch, Package, Server } from 'lucide-react'
import type { Mission } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/field'
import { Dialog, DialogContent } from '@/components/ui/overlay'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { relative } from '@/lib/format'
import { useRemoteMachines } from '@/lib/queries'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

/** Where a runtime-owned mission runs, and how fresh this copy is. Never claims more than it knows. */
export function useRemoteState(machineId: string | null) {
  const machines = useRemoteMachines()
  const m = machineId ? machines.data?.find((x) => x.id === machineId) : null
  return { machine: m ?? null, online: m?.status === 'online', lastSyncedAt: m?.lastSyncedAt ?? null }
}

export function RemoteBanner({ mission }: { mission: Mission }) {
  const { machine, online, lastSyncedAt } = useRemoteState(mission.remoteMachineId)
  if (!mission.remoteMachineId) return null
  return (
    <div className={cn('flex items-center gap-2.5 rounded-[11px] px-3.5 py-2.5 text-[12.5px] ring-1', online ? 'bg-white/[0.025] text-fg-2 ring-line' : 'bg-warning/[0.05] text-fg-2 ring-warning/20')}>
      <Server className={cn('size-4 shrink-0', online ? 'text-fg-3' : 'text-warning')} />
      <span className="min-w-0 flex-1">
        Exécutée sur <span className="text-fg">{machine?.name ?? 'une machine distante'}</span>, indépendamment de ce Mac.
        {!online && <span className="text-fg-3"> Serveur injoignable : dernier état connu{lastSyncedAt ? `, synchronisé ${relative(lastSyncedAt)}` : ''}. La mission a pu avancer depuis.</span>}
      </span>
      <span className={cn('size-1.5 shrink-0 rounded-full', online ? 'bg-success' : 'bg-fg-4')} />
    </div>
  )
}

const KIND: Record<string, string> = { report: 'Rapport', file: 'Fichier', diff: 'Diff', log: 'Journal' }
const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : n >= 1024 ? `${Math.round(n / 1024)} Ko` : `${n} o`)

export function ArtifactsPanel({ mission }: { mission: Mission }) {
  const list = useQuery({ queryKey: ['missions', 'artifacts', mission.id], queryFn: () => call('artifacts.list', { missionId: mission.id }), enabled: Boolean(mission.remoteMachineId) })
  const { online } = useRemoteState(mission.remoteMachineId)
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  if (!mission.remoteMachineId || !list.data?.length) return null
  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id)
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="rounded-xl bg-surface ring-1 ring-line">
      <div className="flex h-10 items-center gap-1.5 px-4 text-xs font-medium text-fg-3"><Package className="size-3.5" /> Résultats conservés sur la machine</div>
      <div className="space-y-0.5 px-2 pb-2">
        {list.data.map((a) => {
          const stored = a.status === 'stored'
          const canFetch = stored && (online || Boolean(a.localPath))
          return (
            <div key={a.id} className="flex items-center gap-2 rounded-[9px] px-2 py-1.5 text-[12.5px] hover:bg-white/[0.025]">
              <FileText className="size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg-2" title={a.name}>{a.name}</span>
                <span className="block truncate text-[11px] text-fg-4" title={`SHA-256 ${a.sha256}`}>{KIND[a.kind] ?? a.kind} · {size(a.size)}{a.sha256 && ` · ${a.sha256.slice(0, 10)}…`}</span>
              </span>
              {!stored ? (
                <Badge tone="warning">{a.status === 'skipped_quota' ? 'Quota atteint' : a.status === 'skipped_size' ? 'Trop volumineux' : 'Introuvable'}</Badge>
              ) : (
                <>
                  <Button size="xs" variant="ghost" aria-label="Aperçu" disabled={!canFetch || busy === a.id} onClick={() => act(a.id, async () => { const r = await call('artifacts.fetch', { id: a.id }); setPreview({ name: a.name, text: r.preview ?? 'Aperçu indisponible (fichier binaire ou volumineux). Utilisez « Afficher dans le Finder ».' }) })}><Eye /></Button>
                  <Button size="xs" variant="ghost" aria-label="Afficher dans le Finder" disabled={!canFetch || busy === a.id} onClick={() => act(a.id, () => call('artifacts.reveal', { id: a.id }))}><FolderSearch /></Button>
                </>
              )}
            </div>
          )
        })}
        <p className="px-2 pt-1 text-[11px] leading-snug text-fg-4">Récupérés par identifiant, jamais par chemin, et vérifiés par empreinte avant d’être gardés sur ce Mac.</p>
      </div>
      <Dialog open={Boolean(preview)} onOpenChange={(o) => !o && setPreview(null)}>
        {preview && (
          <DialogContent title={preview.name} className="w-[720px]">
            <pre className="selectable mx-5 mb-5 max-h-[60vh] overflow-auto rounded-[10px] bg-black/30 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg-2">{preview.text}</pre>
          </DialogContent>
        )}
      </Dialog>
    </section>
  )
}
