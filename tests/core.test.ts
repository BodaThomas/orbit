import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMISSIONS } from '@shared/catalog'
import { runMigrations } from '../src/main/infra/db/client'
import { dispatch } from '../src/main/ipc/router'
import type { HostApi } from '../src/main/ipc/handlers'
import { fakeAdapter, makeCore, novaInput, waitFor } from './helpers'

describe('persistence', () => {
  it('migrations are idempotent', () => {
    const { handle } = makeCore()
    expect(runMigrations(handle.sqlite)).toEqual([])
  })
  it('creates, updates, duplicates and deletes companions with their appearance', () => {
    const c = makeCore()
    const a = c.agents.create(novaInput())
    expect(c.agents.get(a.id).appearance.planet.ring).toBe(true)
    c.agents.update(a.id, { name: 'Nova 2', appearance: { ...a.appearance, palette: 'rose' } })
    expect(c.agents.get(a.id)).toMatchObject({ name: 'Nova 2', appearance: { palette: 'rose' } })
    const copy = c.agents.duplicate(a.id)
    expect(c.agents.list()).toHaveLength(2)
    c.agents.delete(copy.id)
    expect(c.agents.list().map((x) => x.id)).toEqual([a.id])
    expect(c.journal.listActivity({}).some((e) => e.type === 'agent.deleted')).toBe(true)
  })
})

describe('provider secrets', () => {
  it('stores only the encrypted key and validates before saving', async () => {
    const c = makeCore()
    await expect(c.providers.setKey('anthropic', 'sk-wrong-key')).rejects.toThrow(/invalide/)
    const info = await c.providers.setKey('anthropic', 'sk-valid-key')
    expect(info).toMatchObject({ connected: true, hasSecret: true, secretHint: '…-key' })
    const raw = c.handle.sqlite.prepare('select encrypted_secret from provider_connections').get() as { encrypted_secret: string }
    expect(raw.encrypted_secret).not.toContain('sk-valid-key')
    expect(c.providers.secretFor('anthropic')).toBe('sk-valid-key')
    expect(JSON.stringify(c.providers.list())).not.toContain('sk-valid-key')
  })
})

describe('conversations', () => {
  it('streams, persists the answer and records usage', async () => {
    const c = makeCore()
    await c.providers.setKey('anthropic', 'sk-valid-key')
    const a = c.agents.create(novaInput())
    const conv = c.conversations.create(a.id)
    const { assistantMessage } = c.conversations.send(conv.id, 'Salut Nova')
    await waitFor(() => !c.conversations.isStreaming(conv.id))
    const msgs = c.conversations.messages(conv.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]).toMatchObject({ id: assistantMessage.id, content: 'Bonjour Orbit', status: 'complete', inputTokens: 1000, outputTokens: 500, costKind: 'estimated' })
    expect(c.events.filter((e) => e.type === 'message.delta')).toHaveLength(3)
    expect(c.conversations.get(conv.id).title).toBe('Salut Nova')
    expect(c.usage.summary().today.estimated).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 8)
  })

  it('can be cancelled mid-stream', async () => {
    const c = makeCore(fakeAdapter({ words: Array(50).fill('mot '), delayMs: 10 }))
    await c.providers.setKey('anthropic', 'sk-valid-key')
    const a = c.agents.create(novaInput())
    const conv = c.conversations.create(a.id)
    c.conversations.send(conv.id, 'Longue réponse')
    await waitFor(() => c.events.some((e) => e.type === 'message.delta'))
    c.conversations.cancel(conv.id)
    await waitFor(() => !c.conversations.isStreaming(conv.id))
    const last = c.conversations.messages(conv.id).at(-1)!
    expect(last.status).toBe('cancelled')
    expect(last.content.length).toBeLessThan(250)
  })

  it('refuses to send without a configured key', () => {
    const c = makeCore()
    const a = c.agents.create(novaInput())
    const conv = c.conversations.create(a.id)
    expect(() => c.conversations.send(conv.id, 'Salut')).toThrow(/Connectez Anthropic/)
  })

  it('blocks new executions once the daily limit is reached', async () => {
    const c = makeCore(fakeAdapter({ usage: [1_000_000, 0] }))
    await c.providers.setKey('anthropic', 'sk-valid-key')
    c.settings.update({ dailyLimitUsd: 1 })
    const a = c.agents.create(novaInput())
    const conv = c.conversations.create(a.id)
    c.conversations.send(conv.id, 'Premier')
    await waitFor(() => !c.conversations.isStreaming(conv.id))
    expect(() => c.conversations.send(conv.id, 'Second')).toThrow(/Limite journalière/)
  })
})

describe('missions', () => {
  it('runs a mission to completion with persisted events', async () => {
    const c = makeCore()
    await c.providers.setKey('anthropic', 'sk-valid-key')
    const a = c.agents.create(novaInput())
    const m = c.missions.create({ title: 'Résumer', description: 'Un texte', agentId: a.id, priority: 'normal', startNow: true })
    expect(m.status).toBe('running')
    await waitFor(() => c.missions.get(m.id).status === 'done')
    const done = c.missions.get(m.id)
    expect(done.result).toBe('Bonjour Orbit')
    expect(c.missions.events(m.id).map((e) => e.type)).toEqual(['started', 'output', 'usage', 'completed'])
    expect(c.notified).toContain('Nova a terminé')
  })

  it('stops a running mission', async () => {
    const c = makeCore(fakeAdapter({ words: Array(100).fill('x '), delayMs: 10 }))
    await c.providers.setKey('anthropic', 'sk-valid-key')
    const a = c.agents.create(novaInput())
    const m = c.missions.create({ title: 'Long', description: '', agentId: a.id, priority: 'normal', startNow: true })
    await new Promise((r) => setTimeout(r, 40))
    c.missions.cancel(m.id)
    await waitFor(() => c.missions.get(m.id).status === 'cancelled')
    expect(c.missions.events(m.id).at(-1)!.type).toBe('cancelled')
  })

  it('asks for approval in supervised mode with sensitive permissions', async () => {
    const c = makeCore()
    await c.providers.setKey('anthropic', 'sk-valid-key')
    const a = c.agents.create(novaInput({ permissions: { ...DEFAULT_PERMISSIONS, writeFiles: true } }))
    const m = c.missions.create({ title: 'Écrire', description: '', agentId: a.id, priority: 'high', startNow: true })
    expect(m.status).toBe('approval_required')
    const [approval] = c.missions.approvals('pending')
    expect(approval!.missionId).toBe(m.id)
    c.missions.resolveApproval(approval!.id, true)
    await waitFor(() => c.missions.get(m.id).status === 'done')
    expect(() => c.missions.resolveApproval(approval!.id, true)).toThrow(/déjà/)
  })

  it('marks provider failures and allows retry', async () => {
    const c = makeCore(fakeAdapter({ fail: 'Surcharge' }))
    await c.providers.setKey('anthropic', 'sk-valid-key')
    const a = c.agents.create(novaInput())
    const m = c.missions.create({ title: 'Fragile', description: '', agentId: a.id, priority: 'normal', startNow: true })
    await waitFor(() => c.missions.get(m.id).status === 'failed')
    expect(c.missions.get(m.id).error).toBe('Surcharge')
    expect(c.agents.get(a.id).status).toBe('error')
    expect(() => c.missions.start(m.id, 'user')).toThrow(/Transition interdite|déjà/)
  })
})

describe('ipc router', () => {
  const host = { runtime: () => { throw new Error('unused') } } as unknown as HostApi
  it('rejects unknown channels and invalid payloads without throwing', async () => {
    expect(await dispatch('fs.readFile', {}, host)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await dispatch('agents.delete', { id: 42 }, host)).toMatchObject({ ok: false, error: { code: 'validation' } })
  })
})
