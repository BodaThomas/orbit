import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildClaudeCodeArgs, claudeRateLimit, compareVersions, createClaudeCodeEngine, parseAuthStatus } from '../src/main/core/engine/claude-code'
import type { LineProcess, LineProcessOptions } from '../src/main/core/engine/process'
import type { ApprovalAsk, EngineEvent, EngineRunRequest } from '../src/main/core/engine/types'

const ws = () => realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cc-')))
const PERMS = { readFiles: true, writeFiles: true, runCommands: false, network: false, manageProjects: false, externalActions: false }

function request(over: Partial<EngineRunRequest> = {}, signal = new AbortController().signal): EngineRunRequest {
  return { runId: 'r1', sessionId: null, prompt: 'Écris b.txt', instructions: 'Règles Orbit', model: null, policy: { workspace: ws(), permissions: PERMS, autonomy: 'manual', isolation: 'standard' }, secret: null, budgetUsd: null, signal, ...over }
}

/**
 * A scripted stand-in for the `claude` process: reacts to what Orbit writes on stdin
 * exactly like the real CLI does (verified against Claude Code 2.1.322).
 */
function fakeCli(script: (msg: Record<string, unknown>, out: (o: unknown) => void, exit: (code?: number) => void) => void) {
  const spawned: LineProcessOptions[] = []
  const written: Record<string, unknown>[] = []
  let killed = false
  const spawn = (opts: LineProcessOptions): LineProcess => {
    spawned.push(opts)
    const lines: ((l: string) => void)[] = []
    const exits: ((r: string, c: number | null) => void)[] = []
    let exited = false
    const exit = (code = 0) => {
      if (exited) return
      exited = true
      queueMicrotask(() => exits.forEach((e) => e(`code ${code}`, code)))
    }
    const out = (o: unknown) => queueMicrotask(() => lines.forEach((l) => l(JSON.stringify(o))))
    return {
      pid: 1,
      write: (line) => {
        const m = JSON.parse(line) as Record<string, unknown>
        written.push(m)
        script(m, out, exit)
      },
      onLine: (cb) => lines.push(cb),
      onExit: (cb) => exits.push(cb),
      stderrTail: () => '',
      close: () => exit(0),
      kill: () => {
        killed = true
        exit(137)
      },
    }
  }
  return { spawn, spawned, written, wasKilled: () => killed }
}

function io(answer: boolean | (() => Promise<boolean>) = true) {
  const events: EngineEvent[] = []
  const asks: ApprovalAsk[] = []
  return {
    events,
    asks,
    io: {
      emit: (e: EngineEvent) => events.push(e),
      requestApproval: async (a: ApprovalAsk) => {
        asks.push(a)
        return typeof answer === 'function' ? answer() : answer
      },
    },
  }
}

const init = (session = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-5-5', apiKeySource: 'none', tools: ['Read', 'Write'] })
const result = (cost = 0.0123) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Fait.', session_id: 'sess-1', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 5, costUSD: cost } } })

const engineWith = (fake: ReturnType<typeof fakeCli>, probe?: (bin: string, args: string[]) => Promise<string>) =>
  createClaudeCodeEngine({ spawn: fake.spawn, findBinary: () => '/usr/local/bin/claude', probe: probe ?? (async (_b, a) => (a[0] === '--version' ? '2.1.322 (Claude Code)' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'secret@example.invalid', orgId: 'org-x' }))) })

describe('Claude Code CLI — détection', () => {
  it('binaire absent', async () => {
    const e = createClaudeCodeEngine({ findBinary: () => null })
    expect(await e.checkReady(null)).toMatchObject({ ready: false, auth: 'none' })
    const r = await e.run(request(), io().io)
    expect(r.error?.kind).toBe('engine_missing')
  })
  it('binaire détecté, version et méthode d’authentification, sans e-mail ni organisation', async () => {
    const r = await engineWith(fakeCli(() => {})).checkReady(null)
    expect(r).toMatchObject({ ready: true, auth: 'subscription' })
    expect(r.facts).toMatchObject({ Version: '2.1.322', Abonnement: 'max' })
    expect(JSON.stringify(r)).not.toContain('secret@example.invalid')
    expect(JSON.stringify(r)).not.toContain('org-x')
  })
  it('authentification absente', async () => {
    const r = await engineWith(fakeCli(() => {}), async (_b, a) => {
      if (a[0] === '--version') return '2.1.322 (Claude Code)'
      throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) })
    }).checkReady(null)
    expect(r.ready).toBe(false)
    expect(r.detail).toContain('/login')
  })
  it('version incompatible', async () => {
    const r = await engineWith(fakeCli(() => {}), async () => '1.0.3 (Claude Code)').checkReady(null)
    expect(r.ready).toBe(false)
    expect(r.detail).toContain('trop ancienne')
    expect(compareVersions('2.1.322', '2.1.259')).toBe(1)
    expect(parseAuthStatus('pas du json').loggedIn).toBe(false)
  })
})

describe('Claude Code CLI — exécution', () => {
  it('arguments sûrs : protocole structuré, jamais de contournement des permissions ni de clé', () => {
    const args = buildClaudeCodeArgs(request({ sessionId: 's-9', model: 'claude-opus-5-5', effort: 'high' }))
    expect(args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--restricted', '--strict-mcp-config']))
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions|acceptEdits/)
    expect(args).toEqual(expect.arrayContaining(['--resume', 's-9', '--model', 'claude-opus-5-5', '--effort', 'high']))
    expect(args[args.indexOf('--tools') + 1]).not.toContain('Bash')
  })
  it('session, streaming, approbation acceptée, usage abonnement, quota officiel', async () => {
    const fake = fakeCli((m, out) => {
      if (m.type === 'user') {
        out(init())
        out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1795021200, status: 'allowed' } } } })
        out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Je ' } } })
        out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'b.txt', content: 'x' } }] } })
        out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'b.txt', content: 'x' }, tool_use_id: 'tu1' } })
      }
      if (m.type === 'control_response') {
        out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } })
        out(result())
      }
    })
    const rec = io(true)
    const req = request()
    const r = await engineWith(fake).run(req, rec.io)
    expect(r).toMatchObject({ status: 'completed', sessionId: 'sess-1', finalText: 'Fait.' })
    expect(rec.asks[0]!.payload).toMatchObject({ tool: 'Write', kind: 'edit', diff: 'x', engine: 'claude-code' })
    const resp = fake.written.find((w) => w.type === 'control_response') as { response: { response: Record<string, unknown> } }
    expect(resp.response.response).toMatchObject({ behavior: 'allow', toolUseID: 'tu1' })
    expect(resp.response.response.updatedPermissions).toBeUndefined()
    const usage = rec.events.find((e) => e.type === 'usage') as Extract<EngineEvent, { type: 'usage' }>
    expect(usage.usage).toMatchObject({ costKind: 'subscription', costUsd: null, equivalentUsd: 0.0123 })
    const rl = rec.events.find((e) => e.type === 'rate_limit') as Extract<EngineEvent, { type: 'rate_limit' }>
    expect(rl.snapshot.windows[0]).toMatchObject({ kind: 'five_hour', utilization: 0.42 })
    expect(rec.events.some((e) => e.type === 'file.changed')).toBe(true)
    // No API key and no Orbit secret ever reach the CLI.
    expect(Object.keys(fake.spawned[0]!.env)).not.toContain('ANTHROPIC_API_KEY')
    expect(fake.spawned[0]!.cwd).toBe(req.policy.workspace)
  })
  it('refus : réponse deny, l’outil est marqué refusé', async () => {
    const fake = fakeCli((m, out) => {
      if (m.type === 'user') {
        out(init())
        out({ type: 'control_request', request_id: 'p', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'b.txt', content: 'x' }, tool_use_id: 'tu1' } })
      }
      if (m.type === 'control_response') out(result())
    })
    const rec = io(false)
    await engineWith(fake).run(request(), rec.io)
    const resp = fake.written.find((w) => w.type === 'control_response') as { response: { response: Record<string, unknown> } }
    expect(resp.response.response.behavior).toBe('deny')
    expect(rec.events).toContainEqual(expect.objectContaining({ type: 'tool.completed', tool: expect.objectContaining({ status: 'denied' }) }))
  })
  it('politique : hors dossier refusé sans vous déranger ; autres requêtes de contrôle refusées', async () => {
    const fake = fakeCli((m, out) => {
      if (m.type === 'user') {
        out(init())
        out({ type: 'control_request', request_id: 'p', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/etc/master.passwd' }, tool_use_id: 'tu1' } })
        out({ type: 'control_request', request_id: 'h', request: { subtype: 'elicitation' } })
      }
      if (m.type === 'control_response' && (m.response as { request_id: string }).request_id === 'p') out(result())
    })
    const rec = io(true)
    await engineWith(fake).run(request(), rec.io)
    expect(rec.asks).toHaveLength(0)
    const responses = fake.written.filter((w) => w.type === 'control_response') as { response: { subtype: string; request_id: string; response?: { behavior: string } } }[]
    expect(responses.find((r) => r.response.request_id === 'p')!.response.response!.behavior).toBe('deny')
    expect(responses.find((r) => r.response.request_id === 'h')!.response.subtype).toBe('error')
  })
  it('annulation et approbation sans réponse : interruption puis arrêt du processus', async () => {
    const controller = new AbortController()
    const fake = fakeCli((m, out) => {
      if (m.type === 'user') {
        out(init())
        out({ type: 'control_request', request_id: 'p', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'b.txt', content: 'x' }, tool_use_id: 'tu1' } })
      }
    })
    const rec = io(() => new Promise<boolean>((resolve) => controller.signal.addEventListener('abort', () => resolve(false))))
    const p = engineWith(fake).run(request({}, controller.signal), rec.io)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    const r = await p
    expect(r.status).toBe('cancelled')
    expect(fake.written.some((w) => w.type === 'control_request' && (w.request as { subtype: string }).subtype === 'interrupt')).toBe(true)
  })
  it('modèle indisponible : erreur claire, aucun repli', async () => {
    const fake = fakeCli((m, out) => {
      if (m.type === 'user') out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['model: claude-x not found'] })
    })
    const r = await engineWith(fake).run(request({ model: 'claude-x' }), io().io)
    expect(r.status).toBe('failed')
    expect(r.error!.message).toContain('Modèle indisponible')
    expect(buildClaudeCodeArgs(request({ model: 'claude-x' }))).not.toContain('--fallback-model')
  })
  it('reprise : la session est passée à --resume', async () => {
    const fake = fakeCli((m, out) => {
      if (m.type === 'user') {
        out(init('sess-1'))
        out(result())
      }
    })
    const r = await engineWith(fake).run(request({ sessionId: 'sess-1' }), io().io)
    expect(r.sessionId).toBe('sess-1')
    expect(fake.spawned[0]!.args).toEqual(expect.arrayContaining(['--resume', 'sess-1']))
  })
  it('quota : traduction fidèle de rate_limit_event, sans reconstruction', () => {
    expect(claudeRateLimit({ status: 'allowed', resetsAt: 1795021200, rateLimitType: 'seven_day', utilization: 0.03 })!.windows[0]).toMatchObject({ kind: 'seven_day', utilization: 0.03 })
    expect(claudeRateLimit({})).toBeNull()
  })
  it('aucune extraction d’identifiants dans le code du moteur', () => {
    const src = readFileSync(join(__dirname, '../src/main/core/engine/claude-code.ts'), 'utf8')
    for (const forbidden of ['.credentials.json', 'find-generic-password', 'Claude Code-credentials', 'claude.ai/api', 'api/oauth', 'Cookies', 'dangerously-skip-permissions\'']) expect(src).not.toContain(forbidden)
  })
})
