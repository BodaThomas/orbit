import { COMPANION_PRESETS, DEFAULT_PERMISSIONS } from '@shared/catalog'
import type { OrbitEvent } from '@shared/ipc'
import type { ProviderId } from '@shared/types'
import { AgentManager } from '../src/main/core/agents'
import { ConversationManager } from '../src/main/core/conversations'
import { EventBus } from '../src/main/core/event-bus'
import { Journal } from '../src/main/core/journal'
import { MemoryStore } from '../src/main/core/memory'
import { MissionManager } from '../src/main/core/missions'
import { PermissionManager } from '../src/main/core/permissions'
import type { PlatformServices } from '../src/main/core/platform'
import { ProviderRegistry } from '../src/main/core/providers'
import { SettingsStore } from '../src/main/core/settings'
import { UsageTracker } from '../src/main/core/usage'
import { openDatabase } from '../src/main/infra/db/client'
import { ADAPTERS, type ProviderAdapter, type StreamChunk } from '../src/main/infra/providers'

/** A deterministic adapter: streams `words`, can be slowed down or made to fail. */
export function fakeAdapter(opts: { words?: string[]; delayMs?: number; fail?: string; usage?: [number, number] } = {}): ProviderAdapter {
  return {
    ...ADAPTERS.anthropic,
    id: 'anthropic',
    async validate(secret) {
      if (secret !== 'sk-valid-key') throw new Error('Clé API Anthropic invalide.')
    },
    async *stream(_req, _secret, signal): AsyncIterable<StreamChunk> {
      for (const w of opts.words ?? ['Bonjour', ' ', 'Orbit']) {
        if (signal.aborted) return
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        if (signal.aborted) return
        yield { type: 'text', text: w }
      }
      if (opts.fail) throw new Error(opts.fail)
      const [i, o] = opts.usage ?? [1000, 500]
      yield { type: 'usage', inputTokens: i, outputTokens: o }
      yield { type: 'done', stopReason: 'end_turn' }
    },
  }
}

export function makeCore(adapter: ProviderAdapter = fakeAdapter()) {
  const handle = openDatabase(':memory:')
  const db = handle.db
  const bus = new EventBus()
  const events: OrbitEvent[] = []
  bus.on((e) => events.push(e))
  const notified: string[] = []
  const platform: PlatformServices = {
    secrets: { available: () => true, encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (c) => Buffer.from(c.slice(4), 'base64').toString() },
    nativeNotify: (title) => notified.push(title),
    fetch,
  }
  const settings = new SettingsStore(db, 'real')
  const journal = new Journal(db, bus, platform, () => true)
  const agents = new AgentManager(db, bus, journal)
  const adapters = { ...ADAPTERS, anthropic: adapter } as Record<ProviderId, ProviderAdapter>
  const providers = new ProviderRegistry(db, bus, journal, platform.secrets, settings, 'real', adapters)
  const usage = new UsageTracker(db, bus, settings)
  const permissions = new PermissionManager(journal)
  const memory = new MemoryStore(db, bus)
  const conversations = new ConversationManager(db, bus, journal, agents, providers, usage, permissions, memory)
  const missions = new MissionManager(db, bus, journal, agents, providers, usage, permissions, memory)
  return { handle, db, bus, events, notified, settings, journal, agents, providers, usage, permissions, memory, conversations, missions }
}

export function novaInput(overrides: Partial<Parameters<AgentManager['create']>[0]> = {}) {
  const p = COMPANION_PRESETS[0]
  return {
    name: p.name,
    role: p.role,
    description: p.description,
    appearance: p.appearance,
    providerId: 'anthropic' as const,
    model: 'claude-opus-5-5',
    instructions: p.instructions,
    autonomy: 'supervised' as const,
    permissions: { ...DEFAULT_PERMISSIONS },
    workingDirectory: null,
    dailyBudgetUsd: null,
    ...overrides,
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
