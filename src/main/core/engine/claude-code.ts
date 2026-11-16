import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { RateLimitSnapshot, RateLimitWindow } from '@shared/types'
import { engineConfinement } from '../security/seatbelt'
import { allowedClaudeTools, changedPathFor, describeClaudeTool, permissionModeWarning } from './claude-agent'
import { createClaudeGate } from './gate'
import { spawnLineProcess, type LineProcess, type LineProcessOptions } from './process'
import { EngineError, writeRoots, type AgentEngine, type EngineIO, type EngineReadiness, type EngineRunRequest, type EngineRunResult, type ToolStart, type UsageReport } from './types'

const run = promisify(execFile)

/**
 * Claude Code CLI - the user's own, unmodified `claude` binary, signed in through
 * Anthropic's own flow (`claude` → /login). Orbit never reads a token, a keychain
 * item or a cookie: it starts the CLI and talks to it through its structured
 * stream-json protocol (the one the official Agent SDK speaks):
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          --permission-prompt-tool stdio --restricted --strict-mcp-config --tools …
 *          --permission-mode default|auto --settings '{"sandbox":{…}}'
 *
 * - `--restricted`: user/project/local settings are ignored (they could pre-allow tools),
 *   file tools are confined to the working directory, bypassPermissions is refused.
 * - Orbit registers a PreToolUse hook in the `initialize` request: *every* tool call is
 *   decided by Orbit's policy before it runs, including those the CLI would otherwise allow
 *   by itself. Remaining permission prompts arrive as `can_use_tool` control requests and
 *   are answered by the same gate (same answer, never a second question).
 * - The permission mode is always explicit (`claude -p` would otherwise pick `auto` where
 *   available) and checked against the session's init message. `--dangerously-skip-permissions`
 *   and `bypassPermissions` are never used.
 * - Bash runs in Claude Code's own sandbox (`--settings`, honoured under `--restricted`):
 *   writes limited to the workspace and the temp folder, no unsandboxed fallback.
 * - Quotas come only from the CLI's own `rate_limit_event` messages.
 *
 * Usage terms (code.claude.com/docs/en/legal-and-compliance): signing in to the
 * unmodified Claude Code binary with one's own subscription is allowed; offering
 * claude.ai login inside a third-party product or routing others' usage is not.
 * See docs/ENGINES.md.
 */

/** Oldest CLI known to support everything Orbit relies on (`--permission-prompts host`, `--restricted`). */
export const MIN_CLAUDE_CODE_VERSION = '2.1.259'
const MAX_OUTPUT = 8_000

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

export function parseClaudeVersion(out: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null
}

/**
 * The user's install, never the copy bundled inside the Agent SDK: ORBIT_CLAUDE_CODE_PATH,
 * the official installer locations, then PATH (apps launched from Finder get a short PATH).
 */
export function findClaudeCli(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ORBIT_CLAUDE_CODE_PATH) return existsSync(env.ORBIT_CLAUDE_CODE_PATH) ? env.ORBIT_CLAUDE_CODE_PATH : null
  const home = env.HOME ?? homedir()
  const candidates = [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', ...(env.PATH ?? '').split(delimiter).map((d) => join(d, 'claude'))]
  for (const c of candidates) if (c && existsSync(c)) return c
  return null
}

export interface ClaudeAuthStatus {
  loggedIn: boolean
  authMethod: string | null
  subscriptionType: string | null
  apiProvider: string | null
}

/** `claude auth status --json`: official, prints no secret. Only non-identifying fields are kept. */
export function parseAuthStatus(stdout: string): ClaudeAuthStatus {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>
    return {
      loggedIn: j.loggedIn === true,
      authMethod: typeof j.authMethod === 'string' ? j.authMethod : null,
      subscriptionType: typeof j.subscriptionType === 'string' ? j.subscriptionType : null,
      apiProvider: typeof j.apiProvider === 'string' ? j.apiProvider : null,
    }
  } catch {
    return { loggedIn: false, authMethod: null, subscriptionType: null, apiProvider: null }
  }
}

const AUTH_LABELS: Record<string, string> = {
  'claude.ai': 'Compte Claude (abonnement)',
  oauth_token: 'Jeton OAuth (CLAUDE_CODE_OAUTH_TOKEN)',
  api_key: 'Clé API Anthropic',
  api_key_helper: 'Assistant de clé API',
  third_party: 'Fournisseur tiers (Bedrock, Vertex…)',
  none: 'Aucune',
}

/** `rate_limit_event` → Orbit snapshot. Utilization is reported as a 0–1 fraction. */
export function claudeRateLimit(info: Record<string, unknown>): RateLimitSnapshot | null {
  const windows: RateLimitWindow[] = []
  const kindOf = (k: string): RateLimitWindow['kind'] => (['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].includes(k) ? (k as RateLimitWindow['kind']) : 'other')
  const statusOf = (s: unknown): RateLimitWindow['status'] => (s === 'allowed' || s === 'allowed_warning' || s === 'rejected' ? s : 'unknown')
  const toIso = (n: unknown) => (typeof n === 'number' && n > 0 ? new Date(n * 1000).toISOString() : null)
  const frac = (n: unknown) => (typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(1, n)) : null)
  const unified = info.unifiedWindows as Record<string, Record<string, unknown>> | undefined
  if (unified && typeof unified === 'object') {
    for (const [k, w] of Object.entries(unified)) windows.push({ kind: kindOf(k), utilization: frac(w.utilization), resetsAt: toIso(w.resetsAt), status: statusOf(w.status) })
  } else if (typeof info.rateLimitType === 'string') {
    windows.push({ kind: kindOf(info.rateLimitType), utilization: frac(info.utilization), resetsAt: toIso(info.resetsAt), status: statusOf(info.status) })
  }
  if (!windows.length) return null
  return { providerId: 'claude-code', windows, observedAt: new Date().toISOString(), source: 'Claude Code · rate_limit_event' }
}

function mapCliError(message: string): EngineError {
  if (/not logged in|please run \/login|invalid api key|authentication|401|unauthori[sz]ed|oauth token (has )?expired/i.test(message)) return new EngineError('auth', 'Claude Code n’est pas connecté. Ouvrez un terminal et lancez « claude », puis /login (processus officiel d’Anthropic).')
  if (/model.*(not found|not available|does not exist|invalid)|not_found_error|unknown model/i.test(message)) return new EngineError('protocol', `Modèle indisponible pour votre compte Claude Code : ${message}. Choisissez un autre modèle ou « Modèle par défaut du compte » ; Orbit ne change jamais de modèle à votre place.`)
  if (/usage limit|rate.?limit|429|overloaded|limit reached/i.test(message)) return new EngineError('rate_limit', `Limite Claude Code atteinte : ${message}`)
  if (/ENOTFOUND|ECONN|network|fetch failed|timed? ?out/i.test(message)) return new EngineError('network', `Réseau indisponible pour Claude Code : ${message}`)
  return new EngineError('unknown', message)
}

export interface ClaudeCodeEngineOptions {
  /** Test seam: replaces the real subprocess. */
  spawn?: (opts: LineProcessOptions) => LineProcess
  /** Test seam for version/auth probes. */
  probe?: (bin: string, args: string[]) => Promise<string>
  findBinary?: () => string | null
}

/** Callback id of Orbit's PreToolUse hook, registered in the `initialize` request. */
export const ORBIT_HOOK_ID = 'orbit_pretooluse'

export function claudePermissionMode(req: EngineRunRequest): 'auto' | 'default' {
  return req.policy.autonomy === 'automated' ? 'auto' : 'default'
}

/** Same command sandbox as the Agent SDK adapter, passed as flag settings. */
export function claudeSandboxSettings(req: EngineRunRequest): Record<string, unknown> {
  const p = req.policy
  return {
    sandbox: {
      // Full delegation: no command sandbox (see claude-agent.ts). Orbit's hook still decides.
      enabled: p.autonomy !== 'autonomous',
      failIfUnavailable: p.commandsContained === true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: p.permissions.writeFiles ? [...writeRoots(p), tmpdir()] : [tmpdir()] },
    },
  }
}

export function buildClaudeCodeArgs(req: EngineRunRequest): string[] {
  const tools = allowedClaudeTools(req.policy)
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Every prompt comes back to Orbit as a can_use_tool control request.
    '--permission-prompt-tool', 'stdio',
    '--permission-prompts', 'host',
    // No user/project settings, file tools confined, bypassPermissions refused.
    '--restricted',
    '--strict-mcp-config',
    '--tools', tools.join(','),
    '--permission-mode', claudePermissionMode(req),
    '--settings', JSON.stringify(claudeSandboxSettings(req)),
    '--append-system-prompt', req.instructions,
  ]
  if (req.model) args.push('--model', req.model)
  if (req.effort) args.push('--effort', req.effort)
  if (req.sessionId) args.push('--resume', req.sessionId)
  return args
}

export function createClaudeCodeEngine(opts: ClaudeCodeEngineOptions = {}): AgentEngine {
  const spawnProc = opts.spawn ?? spawnLineProcess
  const findBin = opts.findBinary ?? (() => findClaudeCli())
  const probe = opts.probe ?? (async (bin: string, args: string[]) => (await run(bin, args, { timeout: 15_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: process.env.LANG ?? 'fr_FR.UTF-8' } })).stdout)
  let lastAuth: EngineReadiness['auth'] = 'unknown'

  return {
    id: 'claude-code',
    name: 'Claude Code',
    capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: false, budgetCap: false, usage: 'official', confinable: true, effort: true, containsCommands: process.platform === 'darwin' },

    async checkReady() {
      const bin = findBin()
      if (!bin) return { ready: false, detail: 'Claude Code n’est pas installé (binaire « claude » introuvable). Installez-le depuis la documentation officielle, puis vérifiez à nouveau.', auth: 'none', facts: { Installation: 'Introuvable' } }
      const facts: Record<string, string> = { Binaire: bin }
      let version: string | null
      try {
        version = parseClaudeVersion(await probe(bin, ['--version']))
      } catch (err) {
        return { ready: false, detail: `Claude Code ne répond pas : ${err instanceof Error ? err.message : String(err)}`, auth: 'unknown', facts }
      }
      facts.Version = version ?? 'inconnue'
      if (!version || compareVersions(version, MIN_CLAUDE_CODE_VERSION) < 0) {
        return { ready: false, detail: `Version ${version ?? 'inconnue'} trop ancienne : Orbit a besoin de Claude Code ${MIN_CLAUDE_CODE_VERSION} ou plus récent (« claude update »).`, auth: 'unknown', facts }
      }
      let auth: ClaudeAuthStatus
      try {
        auth = parseAuthStatus(await probe(bin, ['auth', 'status', '--json']))
      } catch (err) {
        // Exit code 1 means « not logged in »: stdout still carries the JSON.
        const out = (err as { stdout?: string }).stdout
        auth = out ? parseAuthStatus(out) : { loggedIn: false, authMethod: null, subscriptionType: null, apiProvider: null }
      }
      facts.Connexion = auth.loggedIn ? 'Connecté' : 'Non connecté'
      if (auth.authMethod) facts['Méthode'] = AUTH_LABELS[auth.authMethod] ?? auth.authMethod
      if (auth.subscriptionType) facts.Abonnement = auth.subscriptionType
      if (!auth.loggedIn) return { ready: false, detail: 'Claude Code est installé mais pas connecté. Dans un terminal : « claude », puis /login (processus officiel d’Anthropic).', auth: 'none', facts }
      lastAuth = auth.authMethod === 'claude.ai' || auth.authMethod === 'oauth_token' ? 'subscription' : auth.authMethod === 'api_key' || auth.authMethod === 'api_key_helper' ? 'api_key' : 'unknown'
      return {
        ready: true,
        detail: `Claude Code ${version} · ${AUTH_LABELS[auth.authMethod ?? ''] ?? 'connecté'}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ''}. Orbit ne lit jamais vos identifiants.`,
        auth: lastAuth,
        facts,
      }
    },

    async run(req: EngineRunRequest, io: EngineIO): Promise<EngineRunResult> {
      const { policy } = req
      const bin = findBin()
      if (!bin) return { status: 'failed', finalText: '', error: new EngineError('engine_missing', 'Claude Code n’est pas installé sur ce Mac (binaire « claude » introuvable).'), sessionId: req.sessionId }

      let sessionId = req.sessionId
      let finalText = ''
      let pendingText = ''
      let error: EngineError | null = null
      let subscription = lastAuth === 'subscription'
      const started = new Map<string, ToolStart>()
      let finished = false
      let settle: () => void = () => {}
      const done = new Promise<void>((r) => (settle = r))

      const env: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        LANG: process.env.LANG ?? 'fr_FR.UTF-8',
        TMPDIR: process.env.TMPDIR,
        SHELL: process.env.SHELL,
        TERM: 'dumb',
        // No ANTHROPIC_API_KEY: the CLI uses the user's own login, never Orbit's key.
        DISABLE_AUTOUPDATER: '1',
      }
      let realBin = bin
      try {
        realBin = realpathSync(bin)
      } catch {
        /* keep the link */
      }
      const proc = spawnProc({ command: bin, args: buildClaudeCodeArgs(req), cwd: policy.workspace, env, confinement: engineConfinement('claude-code', policy, { binary: realBin }), label: 'claude' })
      const send = (o: unknown) => proc.write(JSON.stringify(o))
      let reqSeq = 0

      const startTool = (id: string, name: string, input: unknown): ToolStart => {
        const existing = started.get(id)
        if (existing) return existing
        const { action, title } = describeClaudeTool(name, input, policy.workspace)
        const tool: ToolStart = { externalId: id, name, kind: action.kind, title, input, files: action.paths.filter(Boolean) }
        started.set(id, tool)
        io.emit({ type: 'tool.started', tool })
        return tool
      }

      const requestedMode = claudePermissionMode(req)
      let autoActive = false
      const gate = createClaudeGate({ policy, io, engine: 'claude-code', startTool, autoModeActive: () => autoActive })
      const reply = (requestId: string, response: unknown) => {
        if (!finished) send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
      }

      /** PreToolUse hook callback: Orbit decides before the CLI applies its own rules. */
      const answerHook = async (requestId: string, r: Record<string, unknown>) => {
        const input = (r.input ?? {}) as Record<string, unknown>
        if (r.callback_id !== ORBIT_HOOK_ID || input.hook_event_name !== 'PreToolUse') {
          send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Hook inconnu d’Orbit : refusé.' } })
          return
        }
        const toolUseId = String(r.tool_use_id ?? input.tool_use_id ?? `hook-${requestId}`)
        const res = await gate.preToolUse(toolUseId, String(input.tool_name ?? ''), (input.tool_input ?? {}) as Record<string, unknown>)
        reply(requestId, res.decision === 'defer' ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: res.decision, permissionDecisionReason: res.reason } })
      }

      /** Orbit's answer to a permission prompt. Fail closed on anything unexpected. */
      const answerPermission = async (requestId: string, r: Record<string, unknown>) => {
        const name = String(r.tool_name ?? '')
        const input = (r.input ?? {}) as Record<string, unknown>
        const toolUseId = String(r.tool_use_id ?? `perm-${requestId}`)
        const res = await gate.permission(toolUseId, name, input, typeof r.decision_reason === 'string' ? r.decision_reason : undefined)
        // Never send updatedPermissions: persistent authorisations live in Orbit, revocable there.
        reply(requestId, res.allow ? { behavior: 'allow', updatedInput: input, toolUseID: toolUseId } : { behavior: 'deny', message: res.reason, toolUseID: toolUseId })
      }

      const flushText = () => {
        if (pendingText.trim()) {
          finalText = pendingText
          io.emit({ type: 'message', text: pendingText })
        }
        pendingText = ''
      }

      const handle = (m: Record<string, unknown>) => {
        switch (m.type) {
          case 'control_request': {
            const r = (m.request ?? {}) as Record<string, unknown>
            const id = String(m.request_id)
            if (r.subtype === 'can_use_tool') void answerPermission(id, r)
            else if (r.subtype === 'hook_callback') void answerHook(id, r)
            // Elicitations, dialogs…: not supported → refused.
            else send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Non pris en charge par Orbit : refusé.' } })
            return
          }
          case 'control_response':
          case 'control_cancel_request':
            return
          case 'system':
            if (m.subtype === 'init') {
              sessionId = String(m.session_id)
              autoActive = m.permissionMode === 'auto'
              if (typeof m.permissionMode === 'string' && m.permissionMode !== requestedMode) io.emit({ type: 'warning', message: permissionModeWarning(requestedMode, m.permissionMode) })
              // apiKeySource « none » = the CLI runs on the user's Claude login (subscription).
              if (typeof m.apiKeySource === 'string') subscription = m.apiKeySource === 'none' && lastAuth !== 'api_key'
              io.emit({ type: 'session', sessionId, model: typeof m.model === 'string' ? m.model : null })
              io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })
            }
            return
          case 'rate_limit_event': {
            const snap = claudeRateLimit((m.rate_limit_info ?? {}) as Record<string, unknown>)
            if (snap) io.emit({ type: 'rate_limit', snapshot: snap })
            return
          }
          case 'stream_event': {
            if (m.parent_tool_use_id) return
            const ev = m.event as { type: string; delta?: { type: string; text?: string }; content_block?: { type: string } }
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              if (!pendingText) io.emit({ type: 'status', phase: 'writing', label: 'Rédige' })
              pendingText += ev.delta.text
              io.emit({ type: 'message.delta', text: ev.delta.text })
            } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })
            return
          }
          case 'assistant': {
            if (m.error) error = mapCliError(typeof m.error === 'string' ? m.error : JSON.stringify(m.error))
            if (m.parent_tool_use_id) return
            const content = ((m.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[]
            for (const block of content) {
              if (block.type === 'text' && !pendingText) pendingText = String(block.text ?? '')
              if (block.type === 'tool_use') {
                flushText()
                startTool(String(block.id), String(block.name), block.input)
              }
            }
            return
          }
          case 'user': {
            const content = (m.message as { content?: unknown })?.content
            if (!Array.isArray(content)) return
            for (const block of content as Record<string, unknown>[]) {
              if (block.type !== 'tool_result') continue
              const id = String(block.tool_use_id)
              const tool = started.get(id)
              const raw = block.content
              const text = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n') : '').slice(0, MAX_OUTPUT)
              gate.settled(id, !block.is_error)
              io.emit({ type: 'tool.completed', tool: { externalId: id, status: block.is_error ? 'failed' : 'completed', output: text } })
              if (tool && !block.is_error) {
                const path = changedPathFor(tool.name, (tool.input ?? {}) as Record<string, unknown>)
                if (path) io.emit({ type: 'file.changed', change: { path, kind: tool.name === 'Write' ? 'add' : 'update', diff: null } })
              }
            }
            io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })
            return
          }
          case 'result': {
            flushText()
            // The CLI's own final answer is authoritative over intermediate text blocks.
            if (m.subtype === 'success' && typeof m.result === 'string' && m.result.trim()) finalText = m.result
            const models = Object.entries((m.modelUsage ?? {}) as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>)
            for (const [model, u] of models) {
              const usage: UsageReport = {
                model,
                inputTokens: (u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
                outputTokens: u.outputTokens ?? 0,
                cachedInputTokens: u.cacheReadInputTokens ?? 0,
                // Subscription: the CLI's dollar figure is only an API-price equivalent.
                costUsd: subscription ? null : (u.costUSD ?? null),
                costKind: subscription ? 'subscription' : u.costUSD != null ? 'estimated' : 'unknown',
                equivalentUsd: subscription ? (u.costUSD ?? null) : null,
              }
              io.emit({ type: 'usage', usage })
            }
            if (m.subtype !== 'success') error = error ?? mapCliError(Array.isArray(m.errors) && m.errors.length ? m.errors.join(' · ') : String(m.subtype))
            else if (m.is_error && !error) error = mapCliError(typeof m.result === 'string' ? m.result : 'Erreur de Claude Code.')
            finished = true
            proc.close()
            settle()
            return
          }
          default:
            return
        }
      }

      proc.onLine((line) => {
        try {
          handle(JSON.parse(line) as Record<string, unknown>)
        } catch {
          /* non-JSON noise on stdout is ignored */
        }
      })
      proc.onExit((reason, code) => {
        if (!finished) {
          finished = true
          if (!req.signal.aborted && !error) {
            const tail = proc.stderrTail().trim().split('\n').slice(-3).join(' ')
            error = /introuvable/.test(reason) ? new EngineError('engine_missing', 'Binaire Claude Code introuvable.') : mapCliError(tail || `Claude Code s’est arrêté (${reason}${code != null ? '' : ''}).`)
          }
        }
        settle()
      })

      const onAbort = () => {
        // Polite interrupt first, then the whole process group goes.
        send({ type: 'control_request', request_id: `orbit-int-${++reqSeq}`, request: { subtype: 'interrupt' } })
        setTimeout(() => {
          proc.close(500)
        }, 2500).unref?.()
      }
      if (req.signal.aborted) onAbort()
      req.signal.addEventListener('abort', onAbort)

      // Orbit's PreToolUse hook: every tool call is decided by Orbit, whatever the CLI's own rules.
      send({ type: 'control_request', request_id: `orbit-init-${++reqSeq}`, request: { subtype: 'initialize', hooks: { PreToolUse: [{ hookCallbackIds: [ORBIT_HOOK_ID], timeout: 86_400, onFailure: 'block' }] } } })
      send({ type: 'user', message: { role: 'user', content: req.prompt }, parent_tool_use_id: null, session_id: sessionId ?? '' })
      io.emit({ type: 'status', phase: 'thinking', label: 'Démarre Claude Code' })

      try {
        await done
      } finally {
        req.signal.removeEventListener('abort', onAbort)
        if (!finished) proc.kill()
      }
      flushText()
      if (req.signal.aborted) return { status: 'cancelled', finalText, error: null, sessionId }
      if (error) return { status: 'failed', finalText, error, sessionId }
      return { status: 'completed', finalText, error: null, sessionId }
    },
  }
}

/** Claude Code's own session store (read-only use, documented in docs/ENGINES.md). */
export const claudeCodeProjectsDir = (): string => join(homedir(), '.claude', 'projects')
