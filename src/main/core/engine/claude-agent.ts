import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { CanUseTool, HookCallback, Options, PermissionResult, Query, SDKMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { confine, engineConfinement } from '../security/seatbelt'
import type { ToolKind } from '@shared/types'
import { createClaudeGate } from './gate'
import type { ToolAction } from './policy'
import { EngineError, type AgentEngine, type EngineIO, type EngineRunRequest, type EngineRunResult, type RunPolicy, type ToolStart, type UsageReport } from './types'

type QueryFn = (params: { prompt: string; options?: Options }) => Query

const MAX_OUTPUT = 8_000
const CLIENT_APP = 'orbit/0.1.0'

/** Built-in Claude Code tools Orbit knows how to supervise, by permission. */
const TOOLSETS = {
  read: ['Read', 'Glob', 'Grep'],
  write: ['Edit', 'Write', 'NotebookEdit'],
  commands: ['Bash'],
  network: ['WebFetch', 'WebSearch'],
  always: ['TodoWrite'],
}

export function allowedClaudeTools(policy: RunPolicy): string[] {
  const p = policy.permissions
  return [
    ...TOOLSETS.always,
    ...(p.readFiles ? TOOLSETS.read : []),
    ...(p.writeFiles ? TOOLSETS.write : []),
    ...(p.runCommands ? TOOLSETS.commands : []),
    ...(p.network ? TOOLSETS.network : []),
  ]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Maps a Claude Code tool call to Orbit's normalised action + a short French label. */
export function describeClaudeTool(name: string, rawInput: unknown, workspace: string): { action: ToolAction; title: string } {
  const input = (rawInput ?? {}) as Record<string, unknown>
  const short = (p: string) => (p.startsWith(workspace) ? p.slice(workspace.length).replace(/^\//, '') || '.' : p)
  const act = (kind: ToolKind, paths: string[], title: string, command?: string, target?: string) => ({ action: { kind, name, paths, command, target }, title })
  switch (name) {
    case 'Read': {
      const f = str(input.file_path) ?? ''
      return act('read', [f], `Lit ${short(f)}`)
    }
    case 'Glob':
      return act('search', [str(input.path) ?? workspace], `Cherche ${str(input.pattern) ?? 'des fichiers'}`)
    case 'Grep':
      return act('search', [str(input.path) ?? workspace], `Recherche « ${str(input.pattern) ?? ''} »`)
    case 'Edit':
    case 'Write': {
      const f = str(input.file_path) ?? ''
      return act('edit', [f], `${name === 'Write' ? 'Écrit' : 'Modifie'} ${short(f)}`)
    }
    case 'NotebookEdit': {
      const f = str(input.notebook_path) ?? ''
      return act('edit', [f], `Modifie ${short(f)}`)
    }
    case 'Bash': {
      const cmd = str(input.command) ?? ''
      return act('command', [], cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd, cmd)
    }
    case 'WebFetch':
      return act('web', [], `Consulte ${str(input.url) ?? 'une page web'}`, undefined, str(input.url))
    case 'WebSearch':
      return act('web', [], `Recherche web « ${str(input.query) ?? ''} »`)
    case 'TodoWrite':
      return act('plan', [], 'Met à jour son plan')
    default:
      return act(name.startsWith('mcp__') ? 'mcp' : 'other', [], name, undefined, name)
  }
}

export function changedPathFor(name: string, input: Record<string, unknown>): string | null {
  if (name === 'Edit' || name === 'Write') return str(input.file_path) ?? null
  if (name === 'NotebookEdit') return str(input.notebook_path) ?? null
  return null
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function mapSdkError(message: string): EngineError {
  if (/api key|authentication|401|unauthori[sz]ed|invalid x-api-key/i.test(message)) return new EngineError('auth', 'Clé API Anthropic refusée. Vérifiez-la dans Paramètres → Fournisseurs.')
  if (/rate.?limit|429|overloaded/i.test(message)) return new EngineError('rate_limit', 'Limite de débit Anthropic atteinte, réessayez dans un instant.')
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed|connection/i.test(message)) return new EngineError('network', 'Impossible de joindre l’API Anthropic.')
  return new EngineError('unknown', message)
}

export interface ClaudeEngineOptions {
  /** Where Orbit keeps the engine's sessions/config, isolated from the user's ~/.claude. */
  configDir: string
  queryFn?: QueryFn
  pathToExecutable?: string
}

export function createClaudeAgentEngine(opts: ClaudeEngineOptions): AgentEngine {
  const loadQuery = async (): Promise<QueryFn> => opts.queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query

  return {
    id: 'claude-agent',
    name: 'Claude Agent SDK',
    // Bash runs in Claude Code's Seatbelt sandbox, writes limited to the workspace and tmp.
    capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: false, budgetCap: true, usage: 'official', confinable: true, effort: true, containsCommands: process.platform === 'darwin' },

    async checkReady(secret) {
      if (!secret) return { ready: false, detail: 'Connectez d’abord Anthropic (clé API Console) : le moteur l’utilise.', auth: 'none' }
      return { ready: true, detail: 'Utilise votre clé API Anthropic. Sessions conservées par Orbit.', auth: 'api_key' }
    },

    async run(req: EngineRunRequest, io: EngineIO): Promise<EngineRunResult> {
      const { policy } = req
      let sessionId = req.sessionId
      let finalText = ''
      let pendingText = ''
      let error: EngineError | null = null
      const started = new Map<string, ToolStart>()
      const stderrTail: string[] = []

      if (!req.secret) return { status: 'failed', finalText: '', error: new EngineError('auth', 'Aucune clé API Anthropic configurée.'), sessionId }

      const abort = new AbortController()
      const onAbort = () => abort.abort()
      if (req.signal.aborted) abort.abort()
      req.signal.addEventListener('abort', onAbort)

      const startTool = (id: string, name: string, input: unknown): ToolStart => {
        const existing = started.get(id)
        if (existing) return existing
        const { action, title } = describeClaudeTool(name, input, policy.workspace)
        const tool: ToolStart = { externalId: id, name, kind: action.kind, title, input, files: action.paths.filter(Boolean) }
        started.set(id, tool)
        io.emit({ type: 'tool.started', tool })
        return tool
      }

      // Automated companions use Claude's native auto mode for what Orbit leaves open;
      // the mode really in force is read back from the session's init message.
      const requestedMode: Options['permissionMode'] = policy.autonomy === 'automated' ? 'auto' : 'default'
      let autoActive = false
      const gate = createClaudeGate({ policy, io, engine: 'claude-agent', startTool, autoModeActive: () => autoActive })

      const preToolUse: HookCallback = async (input, toolUseId) => {
        if (input.hook_event_name !== 'PreToolUse') return {}
        const id = toolUseId ?? input.tool_use_id
        const res = await gate.preToolUse(id, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>)
        // `defer`: no decision here, the session's permission mode (auto classifier) decides.
        if (res.decision === 'defer') return {}
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: res.decision, permissionDecisionReason: res.reason } }
      }
      // Fallback path if Claude Code still asks: same gate, same (cached) answer.
      const canUseTool: CanUseTool = async (name, input, o): Promise<PermissionResult> => {
        const id = o.toolUseID ?? `perm-${name}-${Date.now()}`
        const res = await gate.permission(id, name, input, o.decisionReason)
        return res.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: res.reason }
      }

      mkdirSync(opts.configDir, { recursive: true })
      const confinement = engineConfinement('claude-agent', policy, { configDir: opts.configDir, binary: opts.pathToExecutable })
      const env: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        LANG: process.env.LANG ?? 'fr_FR.UTF-8',
        TMPDIR: process.env.TMPDIR,
        SHELL: process.env.SHELL,
        ANTHROPIC_API_KEY: req.secret,
        CLAUDE_CONFIG_DIR: opts.configDir,
        CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
      }

      const options: Options = {
        cwd: policy.workspace,
        abortController: abort,
        model: req.model ?? undefined,
        resume: sessionId ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: req.instructions },
        // Only the tools this companion may use exist in the session at all.
        tools: allowedClaudeTools(policy),
        allowedTools: [],
        // Never bypassPermissions: `default` (every open decision comes back to Orbit) or `auto`.
        permissionMode: requestedMode,
        // Isolation: no user/project settings (they could pre-allow tools or add hooks).
        settingSources: [],
        canUseTool,
        hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: 86_400, onFailure: 'block' }] },
        sandbox: {
          enabled: true,
          // When Orbit counts on the sandbox to auto-approve routine commands, no sandbox = no run.
          failIfUnavailable: policy.commandsContained === true,
          autoAllowBashIfSandboxed: false,
          allowUnsandboxedCommands: false,
          filesystem: { allowWrite: policy.permissions.writeFiles ? [policy.workspace, tmpdir()] : [tmpdir()] },
        },
        includePartialMessages: true,
        maxBudgetUsd: req.budgetUsd ?? undefined,
        effort: (req.effort as Options['effort']) ?? undefined,
        env,
        // Level 3: the whole Claude Code process tree under Orbit's Seatbelt profile.
        ...(confinement
          ? {
              spawnClaudeCodeProcess: (o: SpawnOptions): SpawnedProcess => {
                const c = confine(o.command, o.args, confinement)
                return spawn(c.command, c.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal })
              },
            }
          : {}),
        pathToClaudeCodeExecutable: opts.pathToExecutable,
        stderr: (d) => {
          stderrTail.push(d)
          if (stderrTail.length > 20) stderrTail.shift()
        },
      }

      const flushText = () => {
        if (pendingText.trim()) {
          finalText = pendingText
          io.emit({ type: 'message', text: pendingText })
        }
        pendingText = ''
      }

      try {
        const query = await loadQuery()
        const q = query({ prompt: req.prompt, options })
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          handle(msg)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (abort.signal.aborted || req.signal.aborted) {
          flushText()
          return { status: 'cancelled', finalText, error: null, sessionId }
        }
        if (!error) error = mapSdkError(message)
      } finally {
        req.signal.removeEventListener('abort', onAbort)
      }
      flushText()
      if (req.signal.aborted) return { status: 'cancelled', finalText, error: null, sessionId }
      if (error) return { status: 'failed', finalText, error, sessionId }
      return { status: 'completed', finalText, error: null, sessionId }

      function handle(msg: SDKMessage) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              sessionId = msg.session_id
              autoActive = msg.permissionMode === 'auto'
              if (msg.permissionMode !== requestedMode) io.emit({ type: 'warning', message: permissionModeWarning(requestedMode, msg.permissionMode) })
              io.emit({ type: 'session', sessionId: msg.session_id, model: msg.model })
              io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })
            }
            return
          case 'stream_event': {
            if (msg.parent_tool_use_id) return
            const ev = msg.event
            if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
              if (!pendingText) io.emit({ type: 'status', phase: 'writing', label: 'Rédige' })
              pendingText += ev.delta.text
              io.emit({ type: 'message.delta', text: ev.delta.text })
            } else if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') {
              io.emit({ type: 'status', phase: 'thinking', label: 'Réfléchit' })
            }
            return
          }
          case 'assistant': {
            if (msg.error) {
              error = mapSdkError(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error))
            }
            if (msg.parent_tool_use_id) return
            for (const block of msg.message.content) {
              if (block.type === 'text' && !pendingText) pendingText = block.text
              if (block.type === 'tool_use') {
                flushText()
                startTool(block.id, block.name, block.input)
              }
            }
            return
          }
          case 'user': {
            const content = msg.message.content
            if (!Array.isArray(content)) return
            for (const block of content) {
              if (typeof block !== 'object' || block.type !== 'tool_result') continue
              const tool = started.get(block.tool_use_id)
              const text = toolResultText(block.content).slice(0, MAX_OUTPUT)
              gate.settled(block.tool_use_id, !block.is_error)
              io.emit({ type: 'tool.completed', tool: { externalId: block.tool_use_id, status: block.is_error ? 'failed' : 'completed', output: text } })
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
            if (msg.subtype === 'success' && msg.result && !finalText) finalText = msg.result
            const models = Object.entries(msg.modelUsage ?? {})
            for (const [model, u] of models) {
              const usage: UsageReport = {
                model,
                inputTokens: u.inputTokens + u.cacheCreationInputTokens,
                outputTokens: u.outputTokens,
                cachedInputTokens: u.cacheReadInputTokens,
                costUsd: u.costUSD,
                costKind: 'estimated',
              }
              io.emit({ type: 'usage', usage })
            }
            if (msg.subtype === 'error_max_budget_usd') error = new EngineError('budget', 'Budget de la mission atteint : le compagnon s’est arrêté.')
            else if (msg.subtype !== 'success') error = error ?? new EngineError('unknown', msg.errors?.join(' · ') || 'Le moteur Claude a échoué.')
            else if (msg.is_error && !error) error = mapSdkError(msg.result || 'Erreur du moteur Claude.')
            return
          }
          default:
            return
        }
      }
    },
  }
}

/** What Orbit tells the user when the engine does not run in the permission mode it asked for. */
export function permissionModeWarning(requested: string | undefined, actual: string | undefined): string {
  if (requested === 'auto') return `Mode auto de Claude indisponible pour ce compte (mode ${actual ?? 'inconnu'}) : les commandes qu’Orbit ne sait pas classer vous seront soumises.`
  return `Claude a démarré en mode « ${actual ?? 'inconnu'} » au lieu de « ${requested} » : chaque action reste décidée par la politique d’Orbit (hook PreToolUse).`
}

/** Short label for a path in the UI. */
export const fileLabel = (p: string): string => basename(p)
export const claudeConfigDir = (dataDir: string): string => join(dataDir, 'claude-agent')

/**
 * The SDK's native Claude Code binary, outside the asar archive in a packaged app
 * (a binary inside app.asar cannot be executed). Undefined → let the SDK find it.
 */
export function resolveClaudeExecutable(): string | undefined {
  if (process.env.ORBIT_CLAUDE_PATH) return process.env.ORBIT_CLAUDE_PATH
  try {
    const req = createRequire(import.meta.url)
    const root = dirname(req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`))
    const bin = join(root, 'claude').replace(`app.asar${'/'}`, `app.asar.unpacked${'/'}`)
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}
