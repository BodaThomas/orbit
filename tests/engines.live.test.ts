import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCodexEngine } from '../src/main/core/engine/codex'
import type { ApprovalAsk, EngineEvent } from '../src/main/core/engine/types'

/**
 * Real Codex run against your own `codex login`. Never part of `npm test`:
 *   ORBIT_LIVE_CODEX=1 npm test -- engines.live
 * Uses a throwaway folder; consumes a small amount of your Codex quota.
 */
const live = process.env.ORBIT_LIVE_CODEX === '1'

describe.skipIf(!live)('Codex app-server (live)', () => {
  it('reads a project, asks before writing, honours a refusal, resumes the thread', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orbit-codex-'))
    writeFileSync(join(ws, 'README.md'), '# Demo\n\nUn petit projet de test pour Orbit.\n')
    writeFileSync(join(ws, 'index.js'), 'export const add = (a, b) => a + b\n')
    const engine = createCodexEngine({ clientVersion: '0.0.0-live' })
    const ready = await engine.checkReady(null)
    expect(ready.ready, ready.detail).toBe(true)

    const events: EngineEvent[] = []
    const asks: ApprovalAsk[] = []
    const policy = { workspace: ws, autonomy: 'supervised' as const, permissions: { readFiles: true, writeFiles: true, runCommands: true, network: false, manageProjects: false, externalActions: false } }
    const first = await engine.run(
      { runId: 'r1', sessionId: null, prompt: 'Crée un fichier NOTES.md contenant une phrase qui résume ce projet. Ne lance aucune commande de test.', instructions: 'Réponds en français, brièvement.', model: null, policy, secret: null, budgetUsd: null, signal: new AbortController().signal },
      { emit: (e) => events.push(e), requestApproval: async (a) => (asks.push(a), false) },
    )
    console.log('NOTES exists?', (() => { try { readFileSync(join(ws, 'NOTES.md')); return true } catch { return false } })(), 'final:', first.finalText.slice(0, 600))
    console.log('events', JSON.stringify(events.filter((e) => e.type !== 'message.delta' && e.type !== 'status')).slice(0, 3000))
    console.log('first run', first.status, first.error?.message, asks.map((a) => a.summary), events.filter((e) => e.type === 'tool.started').map((e) => (e as { tool: { title: string } }).tool.title))
    expect(first.status).toBe('completed')
    expect(first.sessionId).toBeTruthy()
    expect(asks.length).toBeGreaterThan(0)
    expect(() => readFileSync(join(ws, 'NOTES.md'))).toThrow()
    expect(events.some((e) => e.type === 'usage')).toBe(true)

    const second = await engine.run(
      { runId: 'r2', sessionId: first.sessionId, prompt: 'Rappelle en une phrase ce que je t’avais demandé juste avant.', instructions: 'Réponds en français.', model: null, policy, secret: null, budgetUsd: null, signal: new AbortController().signal },
      { emit: () => {}, requestApproval: async () => false },
    )
    console.log('resume', second.status, second.finalText)
    expect(second.status).toBe('completed')
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.finalText).toMatch(/NOTES/i)
  }, 240_000)
})
