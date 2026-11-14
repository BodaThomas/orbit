import type { RateLimitSnapshot, ToolKind } from '@shared/types'
import { engineConfinement, type ConfinementSpec } from '../security/seatbelt'
import { CodexRpc, resolveCodexBinary, spawnCodexTransport, type RpcTransport } from './codex-rpc'
import { evaluateTool, isInside } from './policy'
import { EngineError, type AgentEngine, type EngineIO, type EngineReadiness, type EngineRunRequest, type EngineRunResult, type RunPolicy, type ToolStart } from './types'

/**
 * OpenAI Codex through `codex app-server` (the interface the official IDE integrations use):
 * threads persist on disk and can be resumed, every item is streamed, and commands / file
 * changes that leave the sandbox come back to Orbit as approval requests.
 *
 * Enforcement is layered: Codex's own OS sandbox (Seatbelt on macOS) limits writes to the
 * workspace - or forbids them entirely so each write must be escalated - and Orbit's policy
 * answers every escalation. Auth is the user's own Codex CLI login (`codex login`).
 */

// Protocol subset (codex app-server v0.169, see `codex app-server generate-ts`)

type SandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }
type AskForApproval = 'untrusted' | 'on-request' | 'never'
interface Account {
  type: 'apiKey' | 'chatgpt' | 'amazonBedrock' | 'gcp'
  planType?: string
}
interface CommandAction {
  type: string
  path?: string | null
  name?: string
  query?: string | null
}
type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string; phase?: string | null }
  | { type: 'reasoning'; id: string; summary: string[] }
  | { type: 'plan'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command: string; cwd: string; status: string; commandActions: CommandAction[]; aggregatedOutput: string | null; exitCode: number | null }
  | { type: 'fileChange'; id: string; changes: { path: string; kind: { type: 'add' | 'delete' | 'update' }; diff: string }[]; status: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string; error: { message?: string } | null }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: string; id: string }
interface TokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}
interface Turn {
  id: string
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: { message: string } | null
}

const MAX_OUTPUT = 8_000

export function codexSandbox(policy: RunPolicy): { mode: 'read-only' | 'workspace-write'; sandboxPolicy: SandboxPolicy; approvalPolicy: AskForApproval } {
  const { permissions: p, autonomy, workspace } = policy
  const automated = autonomy === 'automated'
  // Supervised companions get a read-only sandbox: every write must be escalated, so
  // every write reaches Orbit as an approval request (answered by the tool policy).
  const canWriteFreely = p.writeFiles && automated
  return {
    mode: canWriteFreely ? 'workspace-write' : 'read-only',
    sandboxPolicy: canWriteFreely
      ? { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: p.network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: 'readOnly', networkAccess: p.network },
    // With « run commands »: commands run freely *inside* the sandbox (read-only, no network
    // unless allowed) and anything leaving it is escalated to Orbit. Without it: « untrusted »,
    // only Codex's own safe read commands (ls, cat, rg…) run; every other command is escalated
    // to Orbit, whose policy refuses it. The permission is never merely cosmetic.
    approvalPolicy: p.runCommands ? 'on-request' : 'untrusted',
  }
}

/** `/bin/zsh -lc "npm test"` → `npm test`: what the user cares about. The raw form stays in the details. */
export function unwrapShell(command: string): string {
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  if (!m) return command
  return m[1] === "'" ? m[2]!.replace(/'"'"'/g, "'") : m[2]!.replace(/\\(["\\$`])/g, '$1')
}

const rel = (ws: string, p: string) => (p.startsWith(ws) ? p.slice(ws.length).replace(/^\//, '') || '.' : p)

export function describeCodexItem(item: ThreadItem, workspace: string): ToolStart | null {
  switch (item.type) {
    case 'commandExecution': {
      const it = item as Extract<ThreadItem, { type: 'commandExecution' }>
      const actions = it.commandActions ?? []
      const reads = actions.filter((a) => a.type === 'read' && a.path)
      let kind: ToolKind = 'command'
      const shown = unwrapShell(it.command)
      let title = shown.length > 80 ? `${shown.slice(0, 80)}…` : shown
      if (actions.length && actions.every((a) => a.type === 'read')) {
        kind = 'read'
        title = `Lit ${reads.map((a) => rel(workspace, a.path!)).join(', ')}`
      } else if (actions.length && actions.every((a) => a.type === 'search' || a.type === 'listFiles')) {
        kind = 'search'
        const q = actions.find((a) => a.query)?.query
        title = q ? `Recherche « ${q} »` : 'Parcourt les fichiers'
      }
      return { externalId: it.id, name: 'commandExecution', kind, title, input: { command: it.command, cwd: it.cwd }, files: reads.map((a) => a.path!) }
    }
    case 'fileChange': {
      const it = item as Extract<ThreadItem, { type: 'fileChange' }>
      const files = it.changes.map((c) => c.path)
      return { externalId: it.id, name: 'fileChange', kind: 'edit', title: `Modifie ${files.map((f) => rel(workspace, f)).join(', ')}`, input: { changes: it.changes.map((c) => ({ path: c.path, kind: c.kind.type })) }, files }
    }
    case 'mcpToolCall': {
      const it = item as Extract<ThreadItem, { type: 'mcpToolCall' }>
      return { externalId: it.id, name: 'mcpToolCall', kind: 'mcp', title: `${it.server} · ${it.tool}`, input: null, files: [] }
    }
    case 'webSearch': {
      const it = item as Extract<ThreadItem, { type: 'webSearch' }>
      return { externalId: it.id, name: 'webSearch', kind: 'web', title: it.query ? `Recherche web « ${it.query} »` : 'Recherche web', input: null, files: [] }
    }
    default:
      return null
  }
}

function mapCodexError(message: string): EngineError {
  if (/unauthori[sz]ed|401|login|not logged|auth/i.test(message)) return new EngineError('auth', 'Codex n’est pas connecté. Lancez « codex login » dans un terminal.')
  if (/usage limit|rate.?limit|429|quota/i.test(message)) return new EngineError('rate_limit', `Limite Codex atteinte : ${message}`)
  if (/stream disconnected|network|ENOTFOUND|ECONN|timed? ?out|connection/i.test(message)) return new EngineError('network', `Réseau indisponible pour Codex : ${message}`)
  return new EngineError('unknown', message)
}

interface CodexRateWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}
export interface CodexRateLimitSnapshot {
  primary: CodexRateWindow | null
  secondary: CodexRateWindow | null
  rateLimitReachedType?: string | null
}

/** Official Codex rate limits (account/rateLimits) → Orbit snapshot. Never reconstructed from tokens. */
export function codexRateLimits(r: CodexRateLimitSnapshot | null | undefined): RateLimitSnapshot | null {
  if (!r) return null
  const windows = [r.primary, r.secondary]
    .filter((w): w is CodexRateWindow => Boolean(w))
    .map((w) => ({
      kind: (w.windowDurationMins === 300 ? 'five_hour' : w.windowDurationMins === 10080 ? 'seven_day' : 'other') as RateLimitSnapshot['windows'][number]['kind'],
      utilization: Math.max(0, Math.min(1, w.usedPercent / 100)),
      resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
      status: (r.rateLimitReachedType ? 'rejected' : w.usedPercent >= 90 ? 'allowed_warning' : 'allowed') as RateLimitSnapshot['windows'][number]['status'],
    }))
  if (!windows.length) return null
  return { providerId: 'codex', windows, observedAt: new Date().toISOString(), source: 'Codex app-server · account/rateLimits' }
}

export interface CodexEngineOptions {
  transportFactory?: (cwd: string, confinement?: ConfinementSpec | null) => RpcTransport
  clientVersion: string
}

async function connect(transport: RpcTransport, version: string, onNotification: (m: string, p: unknown) => void, onRequest: (m: string, p: unknown) => Promise<unknown>) {
  const rpc = new CodexRpc(transport, onNotification, onRequest)
  await rpc.request('initialize', { clientInfo: { name: 'orbit', title: 'Orbit', version }, capabilities: { experimentalApi: false, requestAttestation: false } })
  rpc.notify('initialized')
  return rpc
}

function readinessFrom(res: { account: Account | null; requiresOpenaiAuth: boolean }): EngineReadiness {
  if (!res.account) {
    return res.requiresOpenaiAuth
      ? { ready: false, detail: 'Codex n’est pas connecté. Lancez « codex login » dans un terminal, puis vérifiez à nouveau.', auth: 'none' }
      : { ready: true, detail: 'Codex prêt (fournisseur de modèles personnalisé).', auth: 'unknown' }
  }
  if (res.account.type === 'chatgpt') return { ready: true, detail: `Connecté avec ChatGPT${res.account.planType ? ` (${res.account.planType})` : ''} : usage inclus dans l’abonnement.`, auth: 'subscription' }
  if (res.account.type === 'apiKey') return { ready: true, detail: 'Connecté avec une clé API OpenAI : jetons facturés par OpenAI.', auth: 'api_key' }
  return { ready: true, detail: `Connecté (${res.account.type}).`, auth: 'unknown' }
}

export function createCodexEngine(opts: CodexEngineOptions): AgentEngine {
  const makeTransport = opts.transportFactory ?? spawnCodexTransport

  return {
    id: 'codex',
    name: 'Codex',
    capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: true, budgetCap: false, usage: 'official', confinable: true, effort: true },

    async checkReady() {
      const transport = makeTransport(process.env.HOME ?? '/')
      try {
        const rpc = await connect(transport, opts.clientVersion, () => {}, async () => {
          throw new Error('unsupported')
        })
        const res = await rpc.request<{ account: Account | null; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false })
        return readinessFrom(res)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/introuvable|ENOENT/.test(msg)) return { ready: false, detail: 'Binaire Codex introuvable. Réinstallez Orbit ou définissez ORBIT_CODEX_PATH.', auth: 'none' }
        return { ready: false, detail: `Codex ne répond pas : ${msg}`, auth: 'unknown' }
      } finally {
        transport.close()
      }
    },

    async listModels() {
      const transport = makeTransport(process.env.HOME ?? '/')
      try {
        const rpc = await connect(transport, opts.clientVersion, () => {}, async () => {
          throw new Error('unsupported')
        })
        const res = await rpc.request<{ data: { id: string; displayName: string; description: string; hidden: boolean; isDefault: boolean }[] }>('model/list', { limit: 50 })
        return res.data.filter((m) => !m.hidden).map((m) => ({ id: m.id, label: m.displayName || m.id, hint: m.isDefault ? 'Par défaut' : undefined }))
      } finally {
        transport.close()
      }
    },

    async readRateLimits() {
      const transport = makeTransport(process.env.HOME ?? '/')
      try {
        const rpc = await connect(transport, opts.clientVersion, () => {}, async () => {
          throw new Error('unsupported')
        })
        const res = await rpc.request<{ rateLimits: CodexRateLimitSnapshot }>('account/rateLimits/read', { excludeResetCreditDetails: true })
        return codexRateLimits(res.rateLimits)
      } catch {
        return null
      } finally {
        transport.close()
      }
    },

    async run(req: EngineRunRequest, io: EngineIO): Promise<EngineRunResult> {
      const { policy } = req
      const ws = policy.workspace
      if (!policy.permissions.readFiles) {
        return { status: 'failed', finalText: '', error: new EngineError('protocol', 'Codex a besoin de la permission « Lire des fichiers » pour travailler.'), sessionId: req.sessionId }
      }
      const sandbox = codexSandbox(policy)
      const items = new Map<string, ThreadItem>()
      let threadId = req.sessionId
      let turnId: string | null = null
      let finalText = ''
      let error: EngineError | null = null
      let auth: EngineReadiness['auth']
      let model: string | null = req.model
      let baseline: TokenBreakdown | null = null
      let latest: TokenBreakdown | null = null
      let settle: (t: Turn) => void = () => {}
      const turnDone = new Promise<Turn>((r) => (settle = r))
      const earlyTurns = new Map<string, Turn>()

      const onNotification = (method: string, params: unknown) => {
        const p = params as Record<string, unknown>
        if (p && typeof p.threadId === 'string' && threadId && p.threadId !== threadId) return
        switch (method) {
          case 'item/started': {
            const item = p.item as ThreadItem
            items.set(item.id, item)
            if (item.type === 'reasoning') io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })
            else if (item.type === 'agentMessage') io.emit({ type: 'status', phase: 'writing', label: 'Rédige' })
            const tool = describeCodexItem(item, ws)
            if (tool) io.emit({ type: 'tool.started', tool })
            return
          }
          case 'item/agentMessage/delta':
            io.emit({ type: 'message.delta', text: String(p.delta ?? '') })
            return
          case 'item/completed': {
            const item = p.item as ThreadItem
            items.set(item.id, item)
            if (item.type === 'agentMessage') {
              const text = (item as Extract<ThreadItem, { type: 'agentMessage' }>).text
              if (text.trim()) {
                finalText = text
                io.emit({ type: 'message', text })
              }
            } else if (item.type === 'commandExecution') {
              const it = item as Extract<ThreadItem, { type: 'commandExecution' }>
              const status = it.status === 'declined' ? 'denied' : it.status === 'failed' || (it.exitCode != null && it.exitCode !== 0) ? 'failed' : 'completed'
              io.emit({ type: 'tool.completed', tool: { externalId: it.id, status, output: it.aggregatedOutput?.slice(-MAX_OUTPUT) ?? null, exitCode: it.exitCode } })
            } else if (item.type === 'fileChange') {
              const it = item as Extract<ThreadItem, { type: 'fileChange' }>
              const status = it.status === 'declined' ? 'denied' : it.status === 'failed' ? 'failed' : 'completed'
              io.emit({ type: 'tool.completed', tool: { externalId: it.id, status, files: it.changes.map((c) => c.path) } })
              if (status === 'completed') for (const c of it.changes) io.emit({ type: 'file.changed', change: { path: c.path, kind: c.kind.type, diff: c.diff } })
            } else if (item.type === 'mcpToolCall' || item.type === 'webSearch') {
              const failed = item.type === 'mcpToolCall' && (item as Extract<ThreadItem, { type: 'mcpToolCall' }>).status === 'failed'
              io.emit({ type: 'tool.completed', tool: { externalId: item.id, status: failed ? 'failed' : 'completed' } })
            }
            if (item.type !== 'agentMessage') io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })
            return
          }
          case 'thread/tokenUsage/updated': {
            const usage = p.tokenUsage as { total: TokenBreakdown; last: TokenBreakdown }
            if (!baseline) {
              baseline = {
                totalTokens: usage.total.totalTokens - usage.last.totalTokens,
                inputTokens: usage.total.inputTokens - usage.last.inputTokens,
                cachedInputTokens: usage.total.cachedInputTokens - usage.last.cachedInputTokens,
                outputTokens: usage.total.outputTokens - usage.last.outputTokens,
              }
            }
            latest = usage.total
            return
          }
          case 'error': {
            const e = p as { error: { message: string }; willRetry: boolean }
            if (e.willRetry) io.emit({ type: 'warning', message: `Codex réessaie : ${e.error.message}` })
            else error = mapCodexError(e.error.message)
            return
          }
          case 'account/rateLimits/updated': {
            const snap = codexRateLimits((p as { rateLimits: CodexRateLimitSnapshot }).rateLimits)
            if (snap) io.emit({ type: 'rate_limit', snapshot: snap })
            return
          }
          case 'turn/completed': {
            const turn = p.turn as Turn
            if (turnId && turn.id === turnId) settle(turn)
            else earlyTurns.set(turn.id, turn)
            return
          }
          default:
            return
        }
      }

      const ask = async (itemId: string, tool: ToolStart, extra: { command?: string; cwd?: string; paths?: string[]; diff?: string; reason?: string | null }) => {
        const verdict = evaluateTool(policy, { kind: tool.kind === 'read' || tool.kind === 'search' ? 'command' : tool.kind, name: tool.name, paths: extra.paths ?? [], command: extra.command })
        if (verdict.decision === 'deny') return false
        if (verdict.decision === 'allow') return true
        return io.requestApproval({
          externalId: itemId,
          tool,
          summary: tool.title,
          payload: { tool: tool.name, kind: tool.kind, command: extra.command, cwd: extra.cwd, paths: extra.paths, diff: extra.diff, reason: extra.reason ?? verdict.reason, engine: 'codex' },
        })
      }

      const onRequest = async (method: string, params: unknown): Promise<unknown> => {
        const p = params as Record<string, unknown>
        if (method === 'item/commandExecution/requestApproval') {
          const itemId = String(p.itemId)
          const command = typeof p.command === 'string' ? p.command : ''
          const cwd = typeof p.cwd === 'string' ? p.cwd : ws
          const known = items.get(itemId)
          const tool = (known && describeCodexItem(known, ws)) ?? { externalId: itemId, name: 'commandExecution', kind: 'command' as const, title: unwrapShell(command) || 'Commande', input: { command, cwd }, files: [] }
          if (tool.kind !== 'command') tool.kind = 'command'
          const ok = await ask(itemId, tool, { command, cwd, paths: [cwd], reason: p.reason as string | null })
          return { decision: ok ? 'accept' : 'decline' }
        }
        if (method === 'item/fileChange/requestApproval') {
          const itemId = String(p.itemId)
          const known = items.get(itemId) as Extract<ThreadItem, { type: 'fileChange' }> | undefined
          const paths = known?.changes?.map((c) => c.path) ?? []
          const grantRoot = typeof p.grantRoot === 'string' ? p.grantRoot : null
          if (grantRoot && !isInside(ws, grantRoot)) return { decision: 'decline' }
          const tool = (known && describeCodexItem(known, ws)) ?? { externalId: itemId, name: 'fileChange', kind: 'edit' as const, title: 'Modification de fichiers', input: null, files: paths }
          const ok = await ask(itemId, tool, { paths, diff: known?.changes?.map((c) => `--- ${c.path}\n${c.diff}`).join('\n').slice(0, 20_000), reason: p.reason as string | null })
          return { decision: ok ? 'accept' : 'decline' }
        }
        // Permission escalations, MCP elicitations, user-input prompts, legacy v1 approvals:
        // not supported by Orbit → refused (fail closed).
        throw new Error('Non pris en charge par Orbit : refusé.')
      }

      const transport = makeTransport(ws, engineConfinement('codex', policy, { binary: resolveCodexBinary().path }))
      let rpc: CodexRpc | null = null
      const onAbort = () => {
        if (rpc && threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
        setTimeout(() => settle({ id: turnId ?? '', status: 'interrupted', error: null }), 5000).unref?.()
      }
      try {
        rpc = await connect(transport, opts.clientVersion, onNotification, onRequest)
        const account = await rpc.request<{ account: Account | null; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false })
        const ready = readinessFrom(account)
        auth = ready.auth
        if (!ready.ready) throw new EngineError('auth', ready.detail)
        if (req.signal.aborted) return { status: 'cancelled', finalText: '', error: null, sessionId: threadId }

        // « Default » means the account's default as reported by Codex - not whatever
        // ~/.codex/config.toml pins, which may be a model this account cannot use.
        if (!req.model) {
          const list = await rpc.request<{ data: { id: string; isDefault: boolean; hidden: boolean }[] }>('model/list', { limit: 50 }).catch(() => null)
          model = list?.data.find((m) => m.isDefault && !m.hidden)?.id ?? null
        }
        const threadParams = { cwd: ws, approvalPolicy: sandbox.approvalPolicy, sandbox: sandbox.mode, model, developerInstructions: req.instructions }
        const res = threadId
          ? await rpc.request<{ thread: { id: string }; model: string }>('thread/resume', { threadId, ...threadParams })
          : await rpc.request<{ thread: { id: string }; model: string }>('thread/start', threadParams)
        threadId = res.thread.id
        model = res.model ?? model
        io.emit({ type: 'session', sessionId: threadId, model })
        io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })

        req.signal.addEventListener('abort', onAbort)
        const started = await rpc.request<{ turn: Turn }>('turn/start', {
          threadId,
          input: [{ type: 'text', text: req.prompt, text_elements: [] }],
          cwd: ws,
          approvalPolicy: sandbox.approvalPolicy,
          sandboxPolicy: sandbox.sandboxPolicy,
          ...(req.effort ? { effort: req.effort } : {}),
        })
        turnId = started.turn.id
        const early = earlyTurns.get(turnId)
        if (early) settle(early)
        if (req.signal.aborted) onAbort()

        const turn = await turnDone
        const used = latest as TokenBreakdown | null
        if (used) {
          const base = baseline ?? { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
          io.emit({
            type: 'usage',
            usage: {
              model: model ?? 'codex',
              inputTokens: Math.max(0, used.inputTokens - base.inputTokens),
              outputTokens: Math.max(0, used.outputTokens - base.outputTokens),
              cachedInputTokens: Math.max(0, used.cachedInputTokens - base.cachedInputTokens),
              costUsd: null,
              costKind: auth === 'subscription' ? 'subscription' : 'unknown',
            },
          })
        }
        if (turn.status === 'interrupted' || req.signal.aborted) return { status: 'cancelled', finalText, error: null, sessionId: threadId }
        if (turn.status === 'failed') return { status: 'failed', finalText, error: error ?? mapCodexError(turn.error?.message ?? 'Le tour Codex a échoué.'), sessionId: threadId }
        if (error) return { status: 'failed', finalText, error, sessionId: threadId }
        return { status: 'completed', finalText, error: null, sessionId: threadId }
      } catch (err) {
        if (req.signal.aborted) return { status: 'cancelled', finalText, error: null, sessionId: threadId }
        const e = err instanceof EngineError ? err : mapCodexError(err instanceof Error ? err.message : String(err))
        if (/introuvable|ENOENT/.test(e.message)) return { status: 'failed', finalText, error: new EngineError('engine_missing', 'Binaire Codex introuvable. Réinstallez Orbit ou définissez ORBIT_CODEX_PATH.'), sessionId: threadId }
        return { status: 'failed', finalText, error: e, sessionId: threadId }
      } finally {
        req.signal.removeEventListener('abort', onAbort)
        rpc?.close()
      }
    },
  }
}
