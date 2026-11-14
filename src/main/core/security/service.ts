import { desc } from 'drizzle-orm'
import type { OrbitDb } from '../../infra/db/client'
import { securityAuditEvents } from '../../infra/db/schema'
import { newId, nowIso } from '../util'
import { selfTest, seatbeltAvailable, type ConfinementProof } from './seatbelt'

export interface SecurityAuditEvent {
  id: string
  agentId: string | null
  missionId: string | null
  layer: 'policy' | 'engine' | 'isolation' | 'approval'
  action: string
  target: string | null
  decision: 'allow' | 'ask' | 'deny' | 'approved' | 'denied'
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

  list(limit = 200): SecurityAuditEvent[] {
    return this.db
      .select()
      .from(securityAuditEvents)
      .orderBy(desc(securityAuditEvents.createdAt))
      .limit(limit)
      .all()
      .map((r) => ({ ...r, layer: r.layer as SecurityAuditEvent['layer'], decision: r.decision as SecurityAuditEvent['decision'] }))
  }
}
