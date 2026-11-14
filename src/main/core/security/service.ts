import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import type { AutoActionEntry } from '@shared/types'
import type { OrbitDb } from '../../infra/db/client'
import { securityAuditEvents } from '../../infra/db/schema'
import { newId, nowIso } from '../util'
import { selfTest, seatbeltAvailable, type ConfinementProof } from './seatbelt'

export interface SecurityAuditEvent {
  id: string
  agentId: string | null
  missionId: string | null
  layer: 'policy' | 'engine' | 'isolation' | 'approval' | 'grant'
  action: string
  target: string | null
  /** `auto`: ran without confirmation (routine rule, persistent grant, engine classifier). */
  decision: 'allow' | 'ask' | 'deny' | 'approved' | 'denied' | 'auto'
  reason: string | null
  createdAt: string
}

/** Holds the level-3 proof for this Mac and the security audit trail. */
export class SecurityService {
  private proof: ConfinementProof | null = null

  constructor(
    private db: OrbitDb,
    private runSelfTest: () => ConfinementProof = selfTest,
  ) {}

  /** Re-runs the empirical self-test (≈100 ms, throw-away files only). */
  refreshProof(): ConfinementProof {
    this.proof = this.runSelfTest()
    return this.proof
  }

  getProof(): ConfinementProof {
    return this.proof ?? this.refreshProof()
  }

  isolationProven(): boolean {
    return seatbeltAvailable() && this.getProof().ok
  }

  audit(e: Omit<SecurityAuditEvent, 'id' | 'createdAt'>): void {
    this.db.insert(securityAuditEvents).values({ ...e, id: newId(), createdAt: nowIso() }).run()
  }

  /** Actions done without a confirmation, newest first: the « sans confirmation » history. */
  autoLog(o: { agentId?: string; limit?: number } = {}): AutoActionEntry[] {
    return this.db
      .select()
      .from(securityAuditEvents)
      .where(and(eq(securityAuditEvents.decision, 'auto'), o.agentId ? eq(securityAuditEvents.agentId, o.agentId) : undefined, inArray(securityAuditEvents.layer, ['policy', 'grant', 'engine'])))
      .orderBy(desc(securityAuditEvents.createdAt))
      .limit(o.limit ?? 200)
      .all()
      .map((r) => ({ id: r.id, agentId: r.agentId, missionId: r.missionId, via: (r.layer === 'policy' ? 'policy' : r.layer) as AutoActionEntry['via'], category: r.action.replace(/^auto\./, '') || null, title: r.target ?? r.action, reason: r.reason, createdAt: r.createdAt }))
  }

  list(limit = 200): SecurityAuditEvent[] {
    return this.db
      .select()
      .from(securityAuditEvents)
      // Routine auto-approvals have their own history (autoLog): keep this list for decisions.
      .where(ne(securityAuditEvents.decision, 'auto'))
      .orderBy(desc(securityAuditEvents.createdAt))
      .limit(limit)
      .all()
      .map((r) => ({ ...r, layer: r.layer as SecurityAuditEvent['layer'], decision: r.decision as SecurityAuditEvent['decision'] }))
  }
}
