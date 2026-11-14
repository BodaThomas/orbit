import type { AgentPermissions, ApprovalPayload, AutonomyLevel, CostKind, FileChange, IsolationMode, RateLimitSnapshot, ToolCallStatus, ToolKind } from '@shared/types'

/**
 * Common contract between Orbit and every agent engine (Claude Agent SDK, Codex app-server…).
 *
 * An engine receives a prompt and a workspace, streams normalised events and asks Orbit
 * - never the model - whether each sensitive action may run. Anything an engine can do
 * that this contract cannot express stays inside the adapter (see `raw` on events).
 */

export type EngineId = 'claude-agent' | 'codex' | 'claude-code'

export interface EngineCapabilities {
  /** The engine keeps a resumable session across runs and app restarts. */
  resume: boolean
  /** Tool calls can be paused for a human decision before they run. */
  approvals: boolean
  /** A running turn can be interrupted cleanly. */
  interrupt: boolean
  /** The engine reports file changes with diffs. */
  fileDiffs: boolean
  /** The engine can stop by itself when a dollar budget is reached. */
  budgetCap: boolean
  /** Where the token counts come from. */
  usage: 'official' | 'none'
  /** Orbit can wrap the engine's whole process tree in its Seatbelt profile (level 3). */
  confinable: boolean
  /** The engine lets the caller pick a reasoning effort. */
  effort: boolean
}

export interface EngineReadiness {
  ready: boolean
  /** One French sentence for the UI. Never contains a secret. */
  detail: string
  /** Account kind when known: drives how costs are labelled. */
  auth: 'api_key' | 'subscription' | 'none' | 'unknown'
  /** Optional facts for the settings screen (never a secret): version, auth method, plan… */
  facts?: Record<string, string>
}

/** Everything the policy needs to decide. Built by Orbit from the companion, never by the model. */
export interface RunPolicy {
  workspace: string
  permissions: AgentPermissions
  autonomy: AutonomyLevel
  /** `strict`: the engine process tree runs under Orbit's Seatbelt profile (proven by self-test). */
  isolation: IsolationMode
}

export interface EngineRunRequest {
  runId: string
  /** Engine session to resume, or null for a fresh one. */
  sessionId: string | null
  prompt: string
  /** Companion identity + Orbit rules, appended to the engine's own system prompt. */
  instructions: string
  /** null → engine default. */
  model: string | null
  policy: RunPolicy
  /** Anthropic API key for Claude; unused by Codex (it uses its own CLI login). */
  secret: string | null
  /** Hard dollar cap for this run when the engine can enforce one. */
  budgetUsd: number | null
  /** Reasoning effort when the engine supports it; null → engine default. */
  effort?: string | null
  signal: AbortSignal
}

export interface ToolStart {
  externalId: string
  name: string
  kind: ToolKind
  title: string
  input: unknown
  files: string[]
}

export interface ToolEnd {
  externalId: string
  status: Exclude<ToolCallStatus, 'running' | 'awaiting_approval'>
  output?: string | null
  exitCode?: number | null
  files?: string[]
}

export interface UsageReport {
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** Cost computed by the engine itself (Agent SDK list-price estimate), if any. */
  costUsd: number | null
  costKind: CostKind
  /** Subscription runs: what the same tokens would cost at API list price (never spend). */
  equivalentUsd?: number | null
}

export type EngineEvent =
  | { type: 'session'; sessionId: string; model: string | null }
  | { type: 'status'; phase: 'thinking' | 'writing' | 'finishing'; label: string }
  | { type: 'message.delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool.started'; tool: ToolStart }
  | { type: 'tool.completed'; tool: ToolEnd }
  | { type: 'file.changed'; change: Pick<FileChange, 'path' | 'kind' | 'diff'> }
  | { type: 'usage'; usage: UsageReport }
  | { type: 'warning'; message: string }
  /** Official subscription rate-limit information emitted by the engine itself. */
  | { type: 'rate_limit'; snapshot: RateLimitSnapshot }

export interface ApprovalAsk {
  externalId: string
  tool: ToolStart
  payload: ApprovalPayload
  summary: string
}

export interface EngineIO {
  emit(event: EngineEvent): void
  /** Resolves true when the human approves. Resolves false on refusal, cancellation or shutdown. */
  requestApproval(ask: ApprovalAsk): Promise<boolean>
}

export type EngineErrorKind = 'auth' | 'network' | 'rate_limit' | 'budget' | 'engine_missing' | 'protocol' | 'refusal' | 'cancelled' | 'unknown'

export class EngineError extends Error {
  constructor(
    readonly kind: EngineErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export interface EngineRunResult {
  status: 'completed' | 'failed' | 'cancelled'
  /** Last assistant message: the deliverable. */
  finalText: string
  error: EngineError | null
  sessionId: string | null
}

export interface AgentEngine {
  id: EngineId
  name: string
  capabilities: EngineCapabilities
  checkReady(secret: string | null): Promise<EngineReadiness>
  listModels?(): Promise<{ id: string; label: string; hint?: string }[]>
  /** Official subscription quota, only if the engine itself exposes it. */
  readRateLimits?(): Promise<RateLimitSnapshot | null>
  /** Never throws: failures are returned in the result. */
  run(req: EngineRunRequest, io: EngineIO): Promise<EngineRunResult>
}
