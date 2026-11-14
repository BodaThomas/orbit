import { asc, count, desc, eq, like } from 'drizzle-orm'
import type { Conversation, Message } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { toConversation, toMessage } from '../infra/db/mappers'
import { conversations, messages } from '../infra/db/schema'
import type { AgentManager } from './agents'
import type { EventBus } from './event-bus'
import type { Journal } from './journal'
import type { MemoryStore } from './memory'
import type { PermissionManager } from './permissions'
import type { ProviderRegistry } from './providers'
import type { UsageTracker } from './usage'
import { newId, nowIso, OrbitError } from './util'

const HISTORY_LIMIT = 40
const FLUSH_MS = 400

export class ConversationManager {
  private active = new Map<string, AbortController>()

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private agents: AgentManager,
    private providers: ProviderRegistry,
    private usage: UsageTracker,
    private permissions: PermissionManager,
    private memory: MemoryStore,
  ) {}

  list(agentId: string): Conversation[] {
    const rows = this.db
      .select({ c: conversations, n: count(messages.id) })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .where(eq(conversations.agentId, agentId))
      .groupBy(conversations.id)
      .orderBy(desc(conversations.updatedAt))
      .all()
    return rows.map((r) => toConversation(r.c, r.n))
  }

  get(id: string): Conversation {
    const c = this.db.select().from(conversations).where(eq(conversations.id, id)).get()
    if (!c) throw new OrbitError('not_found', 'Conversation introuvable.')
    const n = this.db.select({ n: count() }).from(messages).where(eq(messages.conversationId, id)).get()?.n ?? 0
    return toConversation(c, n)
  }

  create(agentId: string, title?: string): Conversation {
    this.agents.get(agentId)
    const ts = nowIso()
    const row = { id: newId(), agentId, title: title?.trim() || 'Nouvelle conversation', providerSessionId: null, createdAt: ts, updatedAt: ts }
    this.db.insert(conversations).values(row).run()
    this.bus.invalidate('conversations')
    return toConversation(row, 0)
  }

  rename(id: string, title: string): Conversation {
    this.db.update(conversations).set({ title }).where(eq(conversations.id, id)).run()
    this.bus.invalidate('conversations')
    return this.get(id)
  }

  delete(id: string): void {
    this.cancel(id)
    this.db.delete(conversations).where(eq(conversations.id, id)).run()
    this.bus.invalidate('conversations')
  }

  messages(conversationId: string): Message[] {
    return this.db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)).all().map(toMessage)
  }

  search(query: string): { conversation: Conversation; snippet: string }[] {
    const rows = this.db
      .select({ c: conversations, content: messages.content })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(like(messages.content, `%${query}%`))
      .orderBy(desc(messages.createdAt))
      .limit(30)
      .all()
    const seen = new Set<string>()
    const out: { conversation: Conversation; snippet: string }[] = []
    for (const r of rows) {
      if (seen.has(r.c.id)) continue
      seen.add(r.c.id)
      const i = r.content.toLowerCase().indexOf(query.toLowerCase())
      const snippet = r.content.slice(Math.max(0, i - 40), i + query.length + 60).replace(/\s+/g, ' ')
      out.push({ conversation: toConversation(r.c, 0), snippet })
    }
    return out
  }

  isStreaming(conversationId: string): boolean {
    return this.active.has(conversationId)
  }

  send(conversationId: string, content: string): { userMessage: Message; assistantMessage: Message } {
    const conversation = this.get(conversationId)
    const agent = this.agents.get(conversation.agentId)
    if (this.active.has(conversationId)) throw new OrbitError('conflict', `${agent.name} est déjà en train de répondre.`)

    const decision = this.permissions.check(agent, 'conversation.send', 'user')
    if (!decision.allowed) throw new OrbitError('forbidden', decision.reason ?? 'Action refusée.')
    const adapter = this.providers.adapter(agent.providerId)
    if (adapter.availability !== 'available') throw new OrbitError('provider', `${adapter.name} n’est pas encore disponible.`)
    const blocked = this.usage.budgetBlock(agent)
    if (blocked) {
      this.journal.activity({ type: 'budget.reached', level: 'warning', agentId: agent.id, title: 'Budget atteint', detail: blocked })
      throw new OrbitError('budget', blocked)
    }
    const secret = adapter.requiresSecret ? this.providers.secretFor(agent.providerId) : null
    if (adapter.requiresSecret && !secret) {
      throw new OrbitError('provider', `Connectez ${adapter.name} dans Paramètres → Fournisseurs pour parler à ${agent.name}.`)
    }

    const history = this.messages(conversationId)
      .filter((m) => m.role !== 'system' && m.status === 'complete' && m.content.trim())
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const t0 = Date.now()
    const userRow = {
      id: newId(), conversationId, role: 'user' as const, content, status: 'complete' as const,
      error: null, model: null, inputTokens: null, outputTokens: null, costUsd: null, costKind: null,
      createdAt: new Date(t0).toISOString(),
    }
    const assistantRow = {
      ...userRow, id: newId(), role: 'assistant' as const, content: '', status: 'streaming' as const,
      model: agent.model, createdAt: new Date(t0 + 1).toISOString(),
    }
    this.db.insert(messages).values([userRow, assistantRow]).run()
    const patch: { updatedAt: string; title?: string } = { updatedAt: assistantRow.createdAt }
    if (conversation.messageCount === 0 && conversation.title === 'Nouvelle conversation') {
      patch.title = content.replace(/\s+/g, ' ').slice(0, 60)
    }
    this.db.update(conversations).set(patch).where(eq(conversations.id, conversationId)).run()
    this.bus.invalidate('conversations')

    const controller = new AbortController()
    this.active.set(conversationId, controller)
    this.agents.setStatus(agent.id, 'working', 'Répond dans une conversation')

    void this.run({
      controller,
      conversationId,
      messageId: assistantRow.id,
      agentId: agent.id,
      agentName: agent.name,
      providerId: agent.providerId,
      model: agent.model,
      system: agent.instructions + this.memory.contextFor(agent.id),
      turns: [...history, { role: 'user', content }],
      secret,
    })

    return { userMessage: toMessage(userRow), assistantMessage: toMessage(assistantRow) }
  }

  cancel(conversationId: string): void {
    this.active.get(conversationId)?.abort()
  }

  cancelAll(): void {
    for (const c of this.active.values()) c.abort()
  }

  private async run(job: {
    controller: AbortController
    conversationId: string
    messageId: string
    agentId: string
    agentName: string
    providerId: import('@shared/types').ProviderId
    model: string
    system: string
    turns: { role: 'user' | 'assistant'; content: string }[]
    secret: string | null
  }): Promise<void> {
    const adapter = this.providers.adapter(job.providerId)
    let text = ''
    let lastFlush = Date.now()
    let usage: Extract<import('../infra/providers').StreamChunk, { type: 'usage' }> | null = null
    const flush = (status: Message['status'], extra: Partial<typeof messages.$inferInsert> = {}) => {
      this.db.update(messages).set({ content: text, status, ...extra }).where(eq(messages.id, job.messageId)).run()
    }
    try {
      for await (const chunk of adapter.stream(
        { model: job.model, system: job.system, messages: job.turns, maxTokens: 16_000 },
        job.secret,
        job.controller.signal,
      )) {
        if (chunk.type === 'text') {
          text += chunk.text
          this.bus.emit({ type: 'message.delta', conversationId: job.conversationId, messageId: job.messageId, delta: chunk.text })
          if (Date.now() - lastFlush > FLUSH_MS) {
            flush('streaming')
            lastFlush = Date.now()
          }
        } else if (chunk.type === 'usage') usage = chunk
      }
      const cost = usage ? this.usage.recordChunk(job.agentId, job.providerId, job.model, usage, 'conversation') : null
      const status = job.controller.signal.aborted ? 'cancelled' : 'complete'
      flush(status, {
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: cost?.costUsd ?? null,
        costKind: cost?.costKind ?? null,
        model: cost?.model ?? job.model,
      })
      if (status === 'complete') {
        this.journal.activity({ type: 'message.received', agentId: job.agentId, conversationId: job.conversationId, title: `${job.agentName} a répondu`, detail: text.slice(0, 140) })
      }
      this.agents.setStatus(job.agentId, 'available', null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      flush('error', { error: msg })
      this.journal.activity({ type: 'provider.error', level: 'error', agentId: job.agentId, conversationId: job.conversationId, title: `${adapter.name} : réponse interrompue`, detail: msg })
      this.agents.setStatus(job.agentId, 'error', msg.slice(0, 120))
    } finally {
      this.active.delete(job.conversationId)
      const row = this.db.select().from(messages).where(eq(messages.id, job.messageId)).get()
      if (row) this.bus.emit({ type: 'message.updated', message: toMessage(row) })
      this.bus.invalidate('conversations')
    }
  }

  /** Messages left "streaming" by a crash are marked as interrupted on boot. */
  recoverInterrupted(): void {
    this.db.update(messages).set({ status: 'error', error: 'Interrompu (Orbit a été fermé).' }).where(eq(messages.status, 'streaming')).run()
  }
}
