import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { effectivePermissions } from '@shared/permissions-matrix'
import type { AgentPermissions } from '@shared/types'
import { buildClaudeCodeArgs, claudePermissionMode, claudeSandboxSettings } from '../src/main/core/engine/claude-code'
import { codexSandbox } from '../src/main/core/engine/codex'
import { evaluateTool, type ToolAction } from '../src/main/core/engine/policy'
import type { AgentEngine, EngineRunRequest, RunPolicy } from '../src/main/core/engine/types'
import { PermissionManager } from '../src/main/core/permissions'
import { makeCore, novaInput, waitFor } from './helpers'

const ALL: AgentPermissions = { readFiles: true, writeFiles: true, runCommands: true, network: true, manageProjects: false, externalActions: true }
const BASE = join(process.cwd(), 'node_modules', '.cache')
mkdirSync(BASE, { recursive: true })

function world() {
  const root = realpathSync(mkdtempSync(join(BASE, 'orbit-auto-')))
  const ws = join(root, 'projet')
  const data = join(root, 'orbit-data')
  mkdirSync(join(ws, '.git', 'hooks'), { recursive: true })
  mkdirSync(data, { recursive: true })
  writeFileSync(join(ws, '.env'), 'API_TOKEN=fake\n')
  writeFileSync(join(data, 'orbit.db'), 'FAKE-DB')
  writeFileSync(join(root, 'ailleurs.txt'), 'x')
  return { root, ws, data }
}
const pol = (ws: string, data: string, o: Partial<RunPolicy> = {}): RunPolicy => ({ workspace: ws, permissions: ALL, autonomy: 'autonomous', isolation: 'standard', protectedPaths: [data], ...o })
const cmd = (command: string): ToolAction => ({ kind: 'command', name: 'Bash', paths: [], command })

describe('autonomie complète — politique', () => {
  it('ne demande jamais : actions sensibles, hors dossier, secrets, hooks, MCP, web', () => {
    const { root, ws, data } = world()
    const p = pol(ws, data)
    const actions: ToolAction[] = [
      cmd('npm install left-pad'),
      cmd('git push --force origin main'),
      cmd('rm -rf dist build'),
      cmd('vercel deploy --prod'),
      cmd('sudo launchctl list'),
      cmd(`cat ${join(root, 'ailleurs.txt')}`),
      cmd('cat .env'),
      cmd('some-unknown-tool --flag'),
      { kind: 'read', name: 'Read', paths: [join(ws, '.env')] },
      { kind: 'read', name: 'Read', paths: [join(root, 'ailleurs.txt')] },
      { kind: 'edit', name: 'Write', paths: [join(ws, '.git', 'hooks', 'pre-commit')] },
      { kind: 'edit', name: 'Write', paths: [join(ws, 'package.json')] },
      { kind: 'web', name: 'WebFetch', paths: [], target: 'https://example.com' },
      { kind: 'mcp', name: 'mcp__linear__create_issue', paths: [], target: 'mcp__linear__create_issue' },
    ]
    for (const a of actions) {
      const v = evaluateTool(p, a)
      expect(v.decision, `${a.kind} ${a.command ?? a.paths.join(',')}`).toBe('allow')
      expect(v.rule.startsWith('autonomous.') || v.rule === 'plan').toBe(true)
    }
    // Every action that changes something lands in the « done without confirmation » log.
    expect(evaluateTool(p, cmd('git push origin main')).routine).toBe(true)
  })

  it('les données d’Orbit restent refusées', () => {
    const { ws, data } = world()
    const p = pol(ws, data)
    expect(evaluateTool(p, { kind: 'read', name: 'Read', paths: [join(data, 'orbit.db')] }).decision).toBe('deny')
    expect(evaluateTool(p, cmd(`sqlite3 ${join(data, 'orbit.db')} "delete from permission_grants"`)).decision).toBe('deny')
    expect(evaluateTool(p, { kind: 'command', name: 'Bash', paths: [data], command: 'ls' }).decision).toBe('deny')
  })

  it('une permission désactivée reste un refus, jamais une question', () => {
    const { ws, data } = world()
    const off = (k: keyof AgentPermissions) => pol(ws, data, { permissions: { ...ALL, [k]: false } })
    expect(evaluateTool(off('runCommands'), cmd('ls')).decision).toBe('deny')
    expect(evaluateTool(off('writeFiles'), { kind: 'edit', name: 'Write', paths: [join(ws, 'a.ts')] }).decision).toBe('deny')
    expect(evaluateTool(off('writeFiles'), cmd('rm -rf dist')).decision).toBe('deny')
    expect(evaluateTool(off('network'), cmd('npm install left-pad')).decision).toBe('deny')
    expect(evaluateTool(off('network'), { kind: 'web', name: 'WebSearch', paths: [] }).decision).toBe('deny')
    expect(evaluateTool(off('externalActions'), { kind: 'mcp', name: 'mcp__x__y', paths: [] }).decision).toBe('deny')
  })

  it('les autres modes ne changent pas : le mode automatisé demande toujours pour un push', () => {
    const { ws, data } = world()
    expect(evaluateTool(pol(ws, data, { autonomy: 'automated' }), cmd('git push origin main')).decision).toBe('ask')
  })
})

describe('autonomie complète — démarrage des missions', () => {
  it('aucune approbation de démarrage, même lancée par une automatisation', () => {
    const agent = { enabled: true, autonomy: 'autonomous' as const, permissions: ALL }
    expect(PermissionManager.decide(agent, 'mission.start', 'automation')).toMatchObject({ allowed: true, requiresApproval: false })
    expect(PermissionManager.decide(agent, 'externalActions', 'automation')).toMatchObject({ allowed: true, requiresApproval: false })
    expect(PermissionManager.decide({ ...agent, permissions: { ...ALL, externalActions: false } }, 'externalActions', 'automation').allowed).toBe(false)
    expect(PermissionManager.decide({ ...agent, enabled: false }, 'mission.start', 'automation').allowed).toBe(false)
  })
})

describe('autonomie complète — moteurs', () => {
  const req = (ws: string, data: string): EngineRunRequest => ({ runId: 'r', sessionId: null, prompt: 'x', instructions: 'i', model: null, policy: pol(ws, data), secret: null, budgetUsd: null, effort: null, signal: new AbortController().signal }) as unknown as EngineRunRequest

  it('Claude Code : pas de bac à sable des commandes, le hook d’Orbit décide (jamais bypassPermissions)', () => {
    const { ws, data } = world()
    const r = req(ws, data)
    expect(claudeSandboxSettings(r)).toMatchObject({ sandbox: { enabled: false } })
    expect(claudePermissionMode(r)).toBe('default')
    expect(buildClaudeCodeArgs(r)).not.toContain('bypassPermissions')
  })

  it('Codex : écriture dans le dossier, réseau selon la permission', () => {
    const { ws, data } = world()
    expect(codexSandbox(pol(ws, data))).toMatchObject({ mode: 'workspace-write', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } })
  })

  it('la matrice des permissions effectives ne promet plus de confirmation', () => {
    const rows = effectivePermissions({ permissions: ALL, autonomy: 'autonomous', isolation: 'standard', providerId: 'claude-code' }, { isolationProven: false })
    expect(rows.filter((r) => r.effective === 'ask')).toEqual([])
  })
})

describe('autonomie complète — exécution réelle d’une mission', () => {
  it('une question qui parvient quand même à Orbit est acceptée sans attendre personne', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orbit-auto-mission-'))
    let answer: boolean | null = null
    const engine: AgentEngine = {
      id: 'codex',
      name: 'Codex',
      capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: true, budgetCap: false, usage: 'official', confinable: true, effort: false },
      checkReady: async () => ({ ready: true, detail: 'ok', auth: 'subscription' }),
      run: async (r, io) => {
        const tool = { externalId: 'b1', name: 'commandExecution', kind: 'command' as const, title: 'git push', input: null, files: [] }
        io.emit({ type: 'tool.started', tool })
        answer = await io.requestApproval({ externalId: 'b1', tool, summary: 'git push', payload: { tool: 'commandExecution', kind: 'command', command: 'git push', category: 'git-remote', reason: 'Git distant' } })
        io.emit({ type: 'tool.completed', tool: { externalId: 'b1', status: 'completed' } })
        return { status: 'completed', finalText: 'Poussé.', error: null, sessionId: 's' }
      },
    }
    const core = makeCore(undefined, { codex: engine })
    const agent = core.agents.create(novaInput({ name: 'Libre', providerId: 'codex', model: 'default', workingDirectory: ws, autonomy: 'autonomous', permissions: ALL }))
    const m = core.missions.create({ title: 'Pousser', description: '', agentId: agent.id, priority: 'normal', startNow: true })
    await waitFor(() => core.missions.get(m.id).status === 'done')
    expect(answer).toBe(true)
    expect(core.missions.approvals('pending')).toEqual([])
    expect(core.missions.approvals()).toEqual([])
  })
})
