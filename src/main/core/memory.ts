import { and, desc, eq } from 'drizzle-orm'
import type { AgentMemory, MemoryKind } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { toMemory } from '../infra/db/mappers'
import { agentMemories } from '../infra/db/schema'
import type { EventBus } from './event-bus'
import { newId, nowIso, OrbitError } from './util'

/**
 * Per-agent memory. Only entries flagged `includeInContext` are ever sent to a
 * provider. Text search for now; `search()` is the seam for semantic search later.
 */
export class MemoryStore {
  constructor(
    private db: OrbitDb,
    private bus: EventBus,
  ) {}

  list(agentId: string): AgentMemory[] {
    return this.db.select().from(agentMemories).where(eq(agentMemories.agentId, agentId)).orderBy(desc(agentMemories.updatedAt)).all().map(toMemory)
  }

  create(input: { agentId: string; kind: MemoryKind; content: string; includeInContext: boolean }): AgentMemory {
    const ts = nowIso()
    const row = { id: newId(), ...input, createdAt: ts, updatedAt: ts }
    this.db.insert(agentMemories).values(row).run()
    this.bus.invalidate('memory')
    return toMemory(row)
  }

  update(id: string, patch: { content?: string; includeInContext?: boolean }): AgentMemory {
    this.db.update(agentMemories).set({ ...patch, updatedAt: nowIso() }).where(eq(agentMemories.id, id)).run()
    const row = this.db.select().from(agentMemories).where(eq(agentMemories.id, id)).get()
    if (!row) throw new OrbitError('not_found', 'Mémoire introuvable.')
    this.bus.invalidate('memory')
    return toMemory(row)
  }

  delete(id: string): void {
    this.db.delete(agentMemories).where(eq(agentMemories.id, id)).run()
    this.bus.invalidate('memory')
  }

  /** Context block appended to the system prompt. */
  contextFor(agentId: string): string {
    const rows = this.db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.includeInContext, true)))
      .orderBy(desc(agentMemories.updatedAt))
      .limit(30)
      .all()
    if (!rows.length) return ''
    return `\n\n<memoire_validee>\n${rows.map((r) => `- (${r.kind}) ${r.content}`).join('\n')}\n</memoire_validee>`
  }
}
