import { Cloud, Laptop, Plus, Server } from 'lucide-react'
import { Page, PageHeader } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/field'
import { relative } from '@/lib/format'
import { useAgents, useMachines } from '@/lib/queries'

export function MachinesPage() {
  const machines = useMachines()
  const agents = useAgents()
  return (
    <Page>
      <PageHeader
        title="Machines"
        subtitle="Où vos compagnons s’exécutent."
        actions={
          <Button variant="secondary" disabled title="Runtime distant sécurisé : prochaine phase">
            <Plus /> Ajouter une machine · bientôt
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-4">
        {machines.data?.map((m) => (
          <section key={m.id} className="rounded-xl bg-surface p-5 ring-1 ring-line">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-[11px] bg-white/[0.05]"><Laptop className="size-5 text-fg-2" /></span>
              <div className="flex-1">
                <div className="text-[15px] font-semibold text-fg">{m.name}</div>
                <div className="text-xs text-fg-3">{m.platform} · battement {relative(m.lastHeartbeatAt)}</div>
              </div>
              <Badge tone="success">● En ligne</Badge>
            </div>
            <dl className="mt-4 divide-y divide-line rounded-[11px] bg-white/[0.02] ring-1 ring-line">
              {Object.entries(m.details).map(([k, v]) => (
                <div key={k} className="flex justify-between px-3.5 py-2 text-[13px]"><dt className="text-fg-3">{k}</dt><dd className="selectable text-fg-2">{v}</dd></div>
              ))}
              <div className="flex justify-between px-3.5 py-2 text-[13px]"><dt className="text-fg-3">Compagnons</dt><dd className="text-fg-2">{agents.data?.length ?? 0}</dd></div>
            </dl>
          </section>
        ))}
        <section className="rounded-xl border border-dashed border-line-strong p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-[11px] bg-white/[0.03]"><Server className="size-5 text-fg-3" /></span>
            <div>
              <div className="text-[15px] font-medium text-fg-2">Machines distantes</div>
              <div className="text-xs text-fg-3">Linux, VPS, Mac distant</div>
            </div>
            <Badge className="ml-auto">Prévu</Badge>
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-fg-3">
            Un runtime distant avec battements de cœur, reconnexion et permissions par machine. Aucun shell distant ne sera exposé sans validation explicite. Les missions locales ne s’exécutent pas lorsque ce Mac est éteint.
          </p>
          <div className="mt-4 flex items-center gap-2 text-xs text-fg-4"><Cloud className="size-3.5" /> Architecture prête dans le Machine Registry</div>
        </section>
      </div>
    </Page>
  )
}
