import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClaudeCodeEngine } from '../src/main/core/engine/claude-code'
import type { ApprovalAsk, EngineEvent, EngineRunRequest } from '../src/main/core/engine/types'

/**
 * Real Claude Code CLI, with the user's own login. Opt-in: ORBIT_LIVE_CLAUDE_CODE=1.
 * Throw-away folder and fake files only; model Haiku to keep the quota impact tiny.
 */
describe.runIf(process.env.ORBIT_LIVE_CLAUDE_CODE === '1')('Claude Code CLI (réel)', () => {
  const engine = createClaudeCodeEngine()
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-live-cc-')))
  writeFileSync(join(ws, 'notes.txt'), 'Le mot secret du test est GRENADINE.\n')
  const base = (over: Partial<EngineRunRequest>): EngineRunRequest => ({
    runId: 'live',
    sessionId: null,
    prompt: '',
    instructions: 'Réponds en français, brièvement.',
    model: 'haiku',
    policy: { workspace: ws, permissions: { readFiles: true, writeFiles: true, runCommands: false, network: false, manageProjects: false, externalActions: false }, autonomy: 'manual', isolation: 'standard' },
    secret: null,
    budgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  })
  let session: string | null = null

  it('détecte et vérifie la connexion', async () => {
    const r = await engine.checkReady(null)
    console.log('readiness', r.detail)
    expect(r.ready).toBe(true)
  }, 30_000)

  it('lit, demande l’accord avant d’écrire, écrit après approbation', async () => {
    const events: EngineEvent[] = []
    const asks: ApprovalAsk[] = []
    const r = await engine.run(base({ prompt: 'Lis notes.txt, puis crée resultat.txt contenant uniquement le mot secret.' }), {
      emit: (e) => events.push(e),
      requestApproval: async (a) => {
        asks.push(a)
        return true
      },
    })
    console.log('run1', r.status, r.error?.message, r.finalText.slice(0, 120), asks.map((a) => a.summary))
    expect(r.status).toBe('completed')
    expect(asks.length).toBeGreaterThan(0)
    expect(asks[0]!.payload.kind).toBe('edit')
    expect(readFileSync(join(ws, 'resultat.txt'), 'utf8')).toContain('GRENADINE')
    expect(events.some((e) => e.type === 'tool.started' && e.tool.kind === 'read')).toBe(true)
    const usage = events.find((e) => e.type === 'usage') as Extract<EngineEvent, { type: 'usage' }> | undefined
    console.log('usage', usage?.usage, events.filter((e) => e.type === 'rate_limit').map((e) => JSON.stringify((e as { snapshot: unknown }).snapshot)))
    session = r.sessionId
    expect(session).toBeTruthy()
  }, 180_000)

  it('refus : rien n’est écrit', async () => {
    const r = await engine.run(base({ prompt: 'Crée refus.txt contenant « non ».' }), { emit: () => {}, requestApproval: async () => false })
    expect(r.status).toBe('completed')
    expect(existsSync(join(ws, 'refus.txt'))).toBe(false)
  }, 180_000)

  it('reprend la même session', async () => {
    const r = await engine.run(base({ sessionId: session, prompt: 'Quel mot as-tu écrit dans resultat.txt ? Réponds sans outil.' }), { emit: () => {}, requestApproval: async () => false })
    console.log('resume', r.sessionId, r.finalText.slice(0, 120))
    expect(r.sessionId).toBe(session)
    expect(r.finalText.toUpperCase()).toContain('GRENADINE')
  }, 180_000)

  it('fonctionne sous isolation renforcée', async () => {
    const r = await engine.run(base({ prompt: 'Lis notes.txt. Quel mot en majuscules contient-il ? Réponds par ce mot seul.', policy: { ...base({}).policy, isolation: 'strict' } }), { emit: () => {}, requestApproval: async () => false })
    console.log('strict', r.status, r.error?.message, r.finalText.slice(0, 80))
    expect(r.status).toBe('completed')
    expect(r.finalText.toUpperCase()).toContain('GRENADINE')
  }, 180_000)
})
