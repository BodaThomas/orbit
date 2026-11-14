import { Check, ShieldAlert, X } from 'lucide-react'
import type { Agent, ApprovalRequest as A } from '@shared/types'
import { Button } from '@/components/ui/button'
import { relative } from '@/lib/format'
import { useAction } from '@/lib/queries'
import { navigate } from '@/stores/router'
import { CompanionAvatar } from './CompanionAvatar'

export function ApprovalRequestCard({ approval, agent }: { approval: A; agent?: Agent }) {
  const resolve = useAction('approvals.resolve', { success: (a) => (a.status === 'approved' ? 'Demande approuvée' : 'Demande refusée') })
  return (
    <div className="rounded-[11px] bg-warning/[0.05] p-3 ring-1 ring-warning/15">
      <div className="flex items-start gap-2.5">
        {agent ? <CompanionAvatar appearance={agent.appearance} size={28} seed={agent.id} /> : <ShieldAlert className="size-5 text-warning" />}
        <div className="min-w-0 flex-1">
          <button className="text-left text-[13px] leading-snug text-fg hover:underline" onClick={() => approval.missionId && navigate(`/missions/${approval.missionId}`)}>
            {approval.summary}
          </button>
          {approval.detail && <div className="mt-0.5 text-xs text-fg-3">{approval.detail}</div>}
          <div className="mt-2.5 flex items-center gap-1.5">
            <Button size="xs" variant="success" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: approval.id, approve: true })}>
              <Check /> Approuver
            </Button>
            <Button size="xs" variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: approval.id, approve: false })}>
              <X /> Refuser
            </Button>
            <span className="ml-auto text-2xs text-fg-3 tabular">{relative(approval.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
