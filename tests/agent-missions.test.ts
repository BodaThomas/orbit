import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OrbitEvent } from '@shared/ipc'
import type { AgentPermissions } from '@shared/types'
import { AgentRunner } from '../src/main/core/agent-runner'
import { EngineError, type AgentEngine, type EngineIO, type EngineRunRequest, type EngineRunResult } from '../src/main/core/engine/types'
import { MissionManager } from '../src/main/core/missions'
import { makeCore, novaInput, waitFor } from './helpers'

const PERMS: AgentPermissions = { readFiles: true, writeFiles: true, runCommands: true, network: false, manageProjects: false, externalActions: false }

type Script = (req: EngineRunRequest, io: EngineIO) => Promise<EngineRunResult>

/** An engine whose behaviour each test scripts; records every request it receives. */
function scriptedEngine(id: 'codex' | 'claude-agent', script: Script) {
  const requests: EngineRunRequest[] = []
  const engine: AgentEngine = {
    id,
    name: id === 'codex' ? 'Codex' : 'Claude Agent SDK',
    capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: true, budgetCap: id === 'claude-agent', usage: 'official' },
    checkReady: async () => ({ ready: true, detail: 'ok', auth: 'subscription' }),
    run: async (req, io) => {
      requests.push(req)
      return script(req, io)
    },
  }
  return { engine, requests }
}

const ok = (req: EngineRunRequest, finalText = 'Analyse terminée.'): EngineRunResult => ({ status: 'completed', finalText, error: null, sessionId: req.sessionId ?? 'sess-1' })

function setup(id: 'codex' | 'claude-agent', script: Script, perms: Partial<AgentPermissions> = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'orbit-mission-'))
  const { engine, requests } = scriptedEngine(id, script)
  const core = makeCore(undefined, { [id]: engine })
  if (id === 'claude-agent') core.providers.secretFor = (p) => (p === 'claude-agent' || p === 'anthropic' ? 'sk-ant-test' : null)
  const agent = core.agents.create(novaInput({ name: 'Atlas', providerId: id, model: 'default', workingDirectory: ws, permissions: { ...PERMS, ...perms } }))
  return { ...core, ws, agent, requests }
}

const pendingToolApprovals = (core: ReturnType<typeof setup>) => core.missions.approvals('pending').filter((a) => a.kind === 'tool_use')

describe('agent missions (engine + runner + persistence)', () => {
  it('requires an authorised folder for engine companions', () => {
    const core = setup('codex', async (req) => ok(req))
    const noFolder = core.agents.create(novaInput({ name: 'Sans dossier', providerId: 'codex', model: 'default', workingDirectory: null }))
    expect(() => core.missions.create({ title: 'x', description: '', agentId: noFolder.id, priority: 'normal', startNow: false })).toThrow(/dossier autorisé/)
    const home = core.agents.create(novaInput({ name: 'Maison', providerId: 'codex', model: 'default', workingDirectory: process.env.HOME! }))
    expect(() => core.missions.create({ title: 'x', description: '', agentId: home.id, priority: 'normal', startNow: false })).toThrow(/dossier personnel/)
  })

  it('runs a full mission: live events, tool calls, approval, file change, result, session', async () => {
    const core = setup('codex', async (req, io) => {
      io.emit({ type: 'session', sessionId: 'th-42', model: 'gpt-x' })
      io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })
      io.emit({ type: 'tool.started', tool: { externalId: 'c1', name: 'commandExecution', kind: 'read', title: 'Lit README.md', input: null, files: [join(req.policy.workspace, 'README.md')] } })
      io.emit({ type: 'tool.completed', tool: { externalId: 'c1', status: 'completed', output: '# Demo' } })
      const tool = { externalId: 'f1', name: 'fileChange', kind: 'edit' as const, title: 'Modifie NOTES.md', input: null, files: [join(req.policy.workspace, 'NOTES.md')] }
      io.emit({ type: 'tool.started', tool })
      const approved = await io.requestApproval({ externalId: 'f1', tool, summary: 'Modifie NOTES.md', payload: { tool: 'fileChange', kind: 'edit', diff: '+x', paths: tool.files } })
      io.emit({ type: 'tool.completed', tool: { externalId: 'f1', status: approved ? 'completed' : 'denied' } })
      if (approved) io.emit({ type: 'file.changed', change: { path: tool.files[0]!, kind: 'add', diff: '+x' } })
      io.emit({ type: 'message.delta', text: 'Ana' })
      io.emit({ type: 'message', text: 'Analyse terminée.' })
      io.emit({ type: 'usage', usage: { model: 'gpt-x', inputTokens: 1000, outputTokens: 200, cachedInputTokens: 0, costUsd: null, costKind: 'subscription' } })
      return { ...ok(req), sessionId: 'th-42' }
    })
    const m = core.missions.create({ title: 'Analyser le projet', description: 'Fais le tour.', agentId: core.agent.id, priority: 'normal', startNow: true })
    expect(m.engine).toBe('codex')
    expect(m.workspace).toBe(core.ws)

    await waitFor(() => pendingToolApprovals(core).length === 1)
    expect(core.missions.get(m.id).status).toBe('approval_required')
    expect(core.agents.get(core.agent.id).status).toBe('awaiting_approval')
    const approval = pendingToolApprovals(core)[0]!
    expect(approval.payload).toMatchObject({ kind: 'edit', diff: '+x' })
    expect(core.missions.detail(m.id).toolCalls.find((t) => t.externalId === 'f1')?.status).toBe('awaiting_approval')
    expect(core.notified).toContain('Atlas attend votre accord')

    core.missions.resolveApproval(approval.id, true)
    await waitFor(() => core.missions.get(m.id).status === 'done')

    const d = core.missions.detail(m.id)
    expect(d.mission).toMatchObject({ result: 'Analyse terminée.', sessionId: 'th-42', costKind: 'subscription' })
    expect(d.toolCalls.map((t) => [t.externalId, t.status])).toEqual([['c1', 'completed'], ['f1', 'completed']])
    expect(d.fileChanges).toHaveLength(1)
    expect(d.executions[0]).toMatchObject({ status: 'done', inputTokens: 1000, outputTokens: 200, costKind: 'subscription' })
    expect(d.events.map((e) => e.type)).toEqual(expect.arrayContaining(['started', 'session', 'tool', 'approval', 'file', 'message', 'usage', 'completed']))
    expect(core.requests[0]!.policy).toMatchObject({ workspace: core.ws, autonomy: 'supervised' })
    expect(core.requests[0]!.instructions).toContain(`Dossier de travail autorisé : ${core.ws}`)

    const types = core.events.map((e: OrbitEvent) => e.type)
    expect(types).toEqual(expect.arrayContaining(['mission.activity', 'mission.tool', 'mission.delta', 'mission.event']))
    const lastActivity = core.events.filter((e): e is Extract<OrbitEvent, { type: 'mission.activity' }> => e.type === 'mission.activity').at(-1)
    expect(lastActivity?.activity).toBeNull()
  })

  it('a refusal is final: the tool stays denied and the mission still completes', async () => {
    const core = setup('codex', async (req, io) => {
      const tool = { externalId: 'b1', name: 'commandExecution', kind: 'command' as const, title: 'npm install', input: null, files: [] }
      io.emit({ type: 'tool.started', tool })
      const yes = await io.requestApproval({ externalId: 'b1', tool, summary: 'npm install', payload: { tool: 'commandExecution', kind: 'command', command: 'npm install' } })
      // The engine reports its own failure afterwards: Orbit must keep « denied ».
      io.emit({ type: 'tool.completed', tool: { externalId: 'b1', status: yes ? 'completed' : 'failed' } })
      return ok(req, yes ? 'Installé.' : 'Je n’ai rien installé.')
    })
    const m = core.missions.create({ title: 'Installer', description: '', agentId: core.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => pendingToolApprovals(core).length === 1)
    core.missions.resolveApproval(pendingToolApprovals(core)[0]!.id, false)
    await waitFor(() => core.missions.get(m.id).status === 'done')
    const d = core.missions.detail(m.id)
    expect(d.toolCalls[0]!.status).toBe('denied')
    expect(d.mission.result).toBe('Je n’ai rien installé.')
    expect(core.journal.listActivity({}).some((a) => a.type === 'tool.denied')).toBe(true)
    expect(() => core.missions.resolveApproval(core.missions.approvals().find((a) => a.kind === 'tool_use')!.id, true)).toThrow(/déjà été traitée/)
  })

  it('cancel while waiting for approval: question expires, tools close, mission cancelled', async () => {
    const core = setup('codex', async (req, io) => {
      const tool = { externalId: 'e1', name: 'fileChange', kind: 'edit' as const, title: 'Modifie a.ts', input: null, files: [] }
      io.emit({ type: 'tool.started', tool })
      const approved = await io.requestApproval({ externalId: 'e1', tool, summary: 'Modifie a.ts', payload: { tool: 'fileChange', kind: 'edit' } })
      expect(approved).toBe(false)
      expect(req.signal.aborted).toBe(true)
      return { status: 'cancelled', finalText: '', error: null, sessionId: 'sess-1' }
    })
    const m = core.missions.create({ title: 'Long', description: '', agentId: core.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => pendingToolApprovals(core).length === 1)
    core.missions.cancel(m.id)
    await waitFor(() => core.missions.get(m.id).status === 'cancelled')
    expect(core.missions.approvals().find((a) => a.kind === 'tool_use')?.status).toBe('expired')
    expect(core.missions.detail(m.id).toolCalls[0]!.status).toBe('cancelled')
    expect(core.agents.get(core.agent.id).status).toBe('available')
    expect(core.missions.detail(m.id).executions[0]!.status).toBe('cancelled')
  })

  it('survives a restart: interrupted work is closed, then the same session is resumed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-db-'))
    const ws = mkdtempSync(join(tmpdir(), 'orbit-ws-'))
    const dbFile = join(dir, 'orbit.db')
    try {
      // First « launch »: the engine hangs on an approval when Orbit quits.
      const first = scriptedEngine('codex', async (_req, io) => {
        io.emit({ type: 'session', sessionId: 'th-persist', model: 'gpt-x' })
        const tool = { externalId: 'x1', name: 'fileChange', kind: 'edit' as const, title: 'Modifie a.ts', input: null, files: [] }
        io.emit({ type: 'tool.started', tool })
        await io.requestApproval({ externalId: 'x1', tool, summary: 'Modifie a.ts', payload: { tool: 'fileChange', kind: 'edit' } })
        return new Promise<never>(() => {})
      })
      const { OrbitRuntime } = await import('../src/main/core/runtime')
      const { EventBus } = await import('../src/main/core/event-bus')
      const platform = { secrets: { available: () => true, encrypt: (s: string) => s, decrypt: (s: string) => s }, nativeNotify: () => {}, fetch, appVersion: 'test' }
      const rt1 = new OrbitRuntime('real', dbFile, new EventBus(), platform, { codex: first.engine })
      const agent = rt1.agents.create(novaInput({ name: 'Atlas', providerId: 'codex', model: 'default', workingDirectory: ws, permissions: PERMS }))
      const m = rt1.missions.create({ title: 'Analyser', description: '', agentId: agent.id, priority: 'normal', startNow: true })
      await waitFor(() => rt1.missions.approvals('pending').length === 1)
      rt1.handle.close() // crash: nothing is cleaned up

      // Second launch on the same database.
      const second = scriptedEngine('codex', async (req, io) => {
        io.emit({ type: 'message', text: 'Reprise faite.' })
        return ok(req, 'Reprise faite.')
      })
      const rt2 = new OrbitRuntime('real', dbFile, new EventBus(), platform, { codex: second.engine })
      const after = rt2.missions.detail(m.id)
      expect(after.mission.status).toBe('failed')
      expect(after.mission.error).toMatch(/session est conservée/)
      expect(after.mission.sessionId).toBe('th-persist')
      expect(after.toolCalls[0]!.status).toBe('cancelled')
      expect(rt2.missions.approvals().find((a) => a.kind === 'tool_use')?.status).toBe('expired')
      expect(rt2.agents.get(agent.id).status).toBe('available')

      rt2.missions.followUp(m.id, 'Continue où tu en étais.')
      await waitFor(() => rt2.missions.get(m.id).status === 'done')
      expect(second.requests[0]).toMatchObject({ sessionId: 'th-persist', prompt: 'Continue où tu en étais.' })
      const d = rt2.missions.detail(m.id)
      expect(d.executions).toHaveLength(2)
      expect(d.executions[1]!.prompt).toBe('Continue où tu en étais.')
      expect(d.mission.result).toBe('Reprise faite.')
      rt2.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('budgets: blocks the start when spent, and passes the remaining amount as a hard cap', async () => {
    const core = setup('claude-agent', async (req) => {
      if (req.budgetUsd != null && req.budgetUsd < 0.5) return { status: 'failed', finalText: '', error: new EngineError('budget', 'Budget de la mission atteint : le compagnon s’est arrêté.'), sessionId: 'sess-1' }
      return ok(req)
    })
    core.agents.update(core.agent.id, { dailyBudgetUsd: 2 })
    const m1 = core.missions.create({ title: 'Un', description: '', agentId: core.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => core.missions.get(m1.id).status === 'done')
    expect(core.requests[0]!.budgetUsd).toBe(2)

    core.usage.record({ agentId: core.agent.id, providerId: 'claude-agent', model: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, source: 'mission', cost: { costUsd: 1.7, costKind: 'estimated', pricingVersion: 'test' } })
    const m2 = core.missions.create({ title: 'Deux', description: '', agentId: core.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => core.missions.get(m2.id).status === 'failed')
    expect(core.requests[1]!.budgetUsd).toBeCloseTo(0.3)
    expect(core.missions.get(m2.id).error).toMatch(/Budget/)

    core.usage.record({ agentId: core.agent.id, providerId: 'claude-agent', model: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, source: 'mission', cost: { costUsd: 1, costKind: 'estimated', pricingVersion: 'test' } })
    expect(() => core.missions.create({ title: 'Trois', description: '', agentId: core.agent.id, priority: 'normal', startNow: true })).toThrow(/Budget journalier/)
  })

  it('network errors fail the mission with a readable message and flag the companion', async () => {
    const core = setup('codex', async (req) => ({ status: 'failed', finalText: '', error: new EngineError('network', 'Réseau indisponible pour Codex : stream disconnected'), sessionId: req.sessionId }))
    const m = core.missions.create({ title: 'Réseau', description: '', agentId: core.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => core.missions.get(m.id).status === 'failed')
    expect(core.missions.get(m.id).error).toMatch(/Réseau indisponible/)
    expect(core.agents.get(core.agent.id).status).toBe('error')
    expect(core.notified.some((n) => n.startsWith('Mission échouée'))).toBe(true)
  })

  it('an engine mission starts without the « may I start » approval, even when supervised', async () => {
    const core = setup('codex', async (req) => ok(req))
    const m = core.missions.create({ title: 'Direct', description: '', agentId: core.agent.id, priority: 'normal', startNow: true })
    expect(m.status).toBe('running')
    expect(core.missions.approvals('pending').filter((a) => a.kind === 'mission_start')).toHaveLength(0)
    await waitFor(() => core.missions.get(m.id).status === 'done')
  })

  it('an approval left over from a finished run expires instead of resolving nothing', () => {
    const core = setup('codex', async (req) => ok(req))
    const runner = new AgentRunner(core.db, core.bus, core.journal, core.agents, core.usage)
    const missions = new MissionManager(core.db, core.bus, core.journal, core.agents, core.providers, core.usage, core.permissions, core.memory, runner)
    const m = missions.create({ title: 'x', description: '', agentId: core.agent.id, priority: 'normal', startNow: false })
    core.handle.sqlite
      .prepare(`INSERT INTO approval_requests (id, agent_id, mission_id, kind, summary, status, created_at) VALUES ('stale', ?, ?, 'tool_use', 'vieux', 'pending', '2026-01-01T00:00:00Z')`)
      .run(core.agent.id, m.id)
    expect(() => missions.resolveApproval('stale', true)).toThrow(/expiré/)
    expect(missions.approvals().find((a) => a.id === 'stale')?.status).toBe('expired')
  })

  it('deleting a running mission stops it cleanly', async () => {
    let seen: AbortSignal | null = null
    const core = setup('codex', async (req) => {
      seen = req.signal
      await new Promise((r) => req.signal.addEventListener('abort', r))
      return { status: 'cancelled', finalText: '', error: null, sessionId: null }
    })
    const m = core.missions.create({ title: 'Effacer', description: '', agentId: core.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => seen !== null)
    core.missions.delete(m.id)
    await waitFor(() => core.agents.get(core.agent.id).status === 'available')
    expect(() => core.missions.get(m.id)).toThrow(/introuvable/)
  })
})
