import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { ApprovalPayload, GrantScope, PermissionGrant, ToolKind } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { permissionGrants } from '../infra/db/schema'
import { newId, nowIso, OrbitError } from './util'

const SCOPE_RANK: Record<GrantScope, number> = { once: 0, mission: 1, always: 2 }

/** `always` ≥ `mission` ≥ `once`: may the user give `wanted` when the policy offers at most `max`? */
export function scopeAllowed(wanted: GrantScope, max: GrantScope | undefined): boolean {
  return SCOPE_RANK[wanted] <= SCOPE_RANK[max ?? 'once']
}

const canonical = (ws: string) => (existsSync(ws) ? realpathSync(ws) : resolve(ws))

/**
 * Persistent authorisations. Orbit-side only: nothing is ever written to an engine's own
 * permission rules (`updatedPermissions`), so revoking here takes effect on the next action.
 *
 * A grant matches only the exact operation key it was given for (same command words, same
 * file, same host), for the same companion, in the same real folder, and - for `mission`
 * scope - in the same mission. It never turns a policy refusal into an approval: it is only
 * consulted when the policy says « ask » and offered this scope.
 */
export class GrantStore {
  constructor(private db: OrbitDb) {}

  find(o: { agentId: string; workspace: string; missionId: string | null; key: string }): PermissionGrant | null {
    const ws = canonical(o.workspace)
    const rows = this.db
      .select()
      .from(permissionGrants)
      .where(and(eq(permissionGrants.agentId, o.agentId), eq(permissionGrants.operationKey, o.key), isNull(permissionGrants.revokedAt)))
      .all()
    const row = rows.find((r) => r.workspace === ws && (r.scope === 'always' || (r.scope === 'mission' && o.missionId != null && r.missionId === o.missionId)))
    return row ? toGrant(row) : null
  }

  /** Marks a grant used (shown in the settings, helps the user prune old ones). */
  touch(id: string): void {
    const row = this.db.select({ uses: permissionGrants.uses }).from(permissionGrants).where(eq(permissionGrants.id, id)).get()
    if (row) this.db.update(permissionGrants).set({ uses: row.uses + 1, lastUsedAt: nowIso() }).where(eq(permissionGrants.id, id)).run()
  }

  /**
   * Creates a grant from an approval the *user* answered. The payload was written by Orbit's
   * policy when the approval was created; the scope is checked against what it offered.
   */
  grantFromApproval(o: { agentId: string; missionId: string | null; payload: ApprovalPayload | null; scope: GrantScope }): PermissionGrant | null {
    if (o.scope === 'once') return null
    const g = o.payload?.grant
    const ws = g?.workspace ?? o.payload?.cwd
    if (!g || !ws) throw new OrbitError('validation', 'Cette action ne peut être autorisée qu’une fois.')
    if (!scopeAllowed(o.scope, g.max)) throw new OrbitError('forbidden', o.scope === 'always' ? 'Cette action sensible ne peut pas être autorisée définitivement : seulement pour cette mission ou une fois.' : 'Cette action ne peut être autorisée qu’une fois.')
    if (o.scope === 'mission' && !o.missionId) throw new OrbitError('validation', 'Aucune mission associée à cette demande.')
    const workspace = canonical(ws)
    const existing = this.find({ agentId: o.agentId, workspace, missionId: o.missionId, key: g.key })
    if (existing && (existing.scope === 'always' || o.scope === 'mission')) return existing
    const row = {
      id: newId(),
      agentId: o.agentId,
      workspace,
      scope: o.scope,
      missionId: o.scope === 'mission' ? o.missionId : null,
      kind: o.payload!.kind,
      operationKey: g.key,
      label: g.label,
      category: o.payload!.category ?? null,
      uses: 0,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: nowIso(),
    }
    this.db.insert(permissionGrants).values(row).run()
    return toGrant(row)
  }

  list(o: { agentId?: string; includeRevoked?: boolean } = {}): PermissionGrant[] {
    return this.db
      .select()
      .from(permissionGrants)
      .where(and(o.agentId ? eq(permissionGrants.agentId, o.agentId) : undefined, o.includeRevoked ? undefined : isNull(permissionGrants.revokedAt)))
      .orderBy(desc(permissionGrants.createdAt))
      .all()
      .map(toGrant)
  }

  revoke(id: string): PermissionGrant {
    const row = this.db.select().from(permissionGrants).where(eq(permissionGrants.id, id)).get()
    if (!row) throw new OrbitError('not_found', 'Autorisation introuvable.')
    if (!row.revokedAt) this.db.update(permissionGrants).set({ revokedAt: nowIso() }).where(eq(permissionGrants.id, id)).run()
    return toGrant(this.db.select().from(permissionGrants).where(eq(permissionGrants.id, id)).get()!)
  }

  /** Mission-scoped grants end with their mission (they would never match again anyway). */
  expireMission(missionId: string): void {
    this.db.update(permissionGrants).set({ revokedAt: nowIso() }).where(and(eq(permissionGrants.missionId, missionId), isNull(permissionGrants.revokedAt))).run()
  }
}

function toGrant(r: typeof permissionGrants.$inferSelect): PermissionGrant {
  return { ...r, scope: r.scope as PermissionGrant['scope'], kind: r.kind as ToolKind }
}
