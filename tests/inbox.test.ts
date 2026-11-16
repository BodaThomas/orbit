import { describe, expect, it } from 'vitest'
import { Inbox } from '../src/main/core/inbox'
import { missions } from '../src/main/infra/db/schema'
import { makeCore, novaInput, waitFor } from './helpers'

describe('inbox', () => {
  it('lists recent failed missions until they are marked as handled', async () => {
    const c = makeCore()
    const inbox = new Inbox(c.db, c.bus)
    const a = c.agents.create(novaInput())
    const m = c.missions.create({ agentId: a.id, title: 'Rapport', description: '', priority: 'normal', startNow: false })
    expect(inbox.list()).toEqual([])

    c.db.update(missions).set({ status: 'failed', error: 'boom', updatedAt: new Date().toISOString() }).run()
    const [item] = inbox.list()
    expect(item).toMatchObject({ kind: 'mission_failed', refId: m.id, dismissible: true, route: `/missions/${m.id}`, detail: 'boom' })

    inbox.dismiss([item!.key])
    inbox.dismiss([item!.key])
    expect(inbox.list()).toEqual([])
    await waitFor(() => c.events.some((e) => e.type === 'invalidate' && e.scopes.includes('inbox')))
  })

  it('ignores failures older than two weeks', () => {
    const c = makeCore()
    const inbox = new Inbox(c.db, c.bus)
    const a = c.agents.create(novaInput())
    c.missions.create({ agentId: a.id, title: 'Ancienne', description: '', priority: 'normal', startNow: false })
    c.db.update(missions).set({ status: 'failed', updatedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }).run()
    expect(inbox.list()).toEqual([])
  })
})
