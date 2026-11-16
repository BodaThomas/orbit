import { z } from 'zod'
import type { ArtifactMeta, EngineStatus, HealthReport, MachineLimits, MetricsReport, RemoteEngineId } from '../shared/remote'

export type { ArtifactMeta, EngineStatus, HealthReport, MachineLimits, MetricsReport, RemoteEngineId }

/**
 * Orbit runtime protocol v2 - JSON-RPC 2.0, one JSON object per line.
 *
 * Transport: Orbit Desktop → `ssh (pinned host key) … orbit-runtime attach` → Unix socket
 * (0600, owner-only folder) → daemon. Nothing listens on the network.
 *
 * Authentication layers, all required:
 *  1. SSH: user key, pinned host key, encrypted channel.
 *  2. Local token: `attach` proves it runs as the runtime's OS user.
 *  3. Runtime identity: the daemon signs the client's hello nonce with its Ed25519 key;
 *     Orbit pins that key (a rebuilt server or another runtime is detected).
 *  4. Client identity: each paired Orbit Desktop signs a one-time server challenge with its
 *     own Ed25519 key → a session with an expiry. Clients can be revoked.
 * Side-effect methods carry a `requestId`: a command resent after a lost answer returns
 * the stored result, it never runs twice.
 *
 * Every params object is validated (zod) before anything runs.
 */

export const PROTOCOL_VERSION = 2
export const RUNTIME_VERSION = '0.4.0'
export const SESSION_TTL_MS = 12 * 3600_000
/** Minimum Node.js on the server: node:sqlite with array mode. */
export const MIN_NODE = [22, 16] as const

export const REMOTE_ENGINES: RemoteEngineId[] = ['claude-code', 'codex', 'claude-agent', 'anthropic', 'openai']

export const isSafeProjectName = (p: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p) && !p.includes('..')

/**
 * Unix socket paths are limited (104 bytes on macOS, 108 on Linux). A long runtime home
 * gets a short socket in /tmp, named after the home, and its location is written to
 * <home>/socket so `attach` and Orbit find it.
 */
export function socketPathFor(home: string, hash: (s: string) => string): string {
  const direct = `${home.replace(/\/$/, '')}/orbit.sock`
  return Buffer.byteLength(direct) <= 100 ? direct : `/tmp/orbit-rt-${hash(home).slice(0, 16)}.sock`
}

/** Messages signed by each side (domain-separated: a signature can't be reused elsewhere). */
export const helloProofMessage = (runtimeId: string, nonce: string) => `orbit-runtime-hello\n${runtimeId}\n${nonce}`
export const sessionProofMessage = (runtimeId: string, challenge: string, clientId: string) => `orbit-client-session\n${runtimeId}\n${challenge}\n${clientId}`

// Replication

/**
 * Tables the runtime owns and replicates to Orbit Desktop, with their key. Every insert,
 * update or delete is captured by a trigger in the same transaction (outbox) and published
 * as an `entity` event carrying the row's full state.
 */
export const REPLICATED_TABLES: Record<string, string[]> = {
  missions: ['id'],
  mission_executions: ['id'],
  execution_events: ['id'],
  tool_calls: ['id'],
  approval_requests: ['id'],
  file_changes: ['id'],
  file_inventories: ['id'],
  constellation_runs: ['id'],
  mission_dependencies: ['mission_id', 'depends_on_mission_id'],
  execution_handoffs: ['id'],
  agent_workspaces: ['id'],
  automation_definitions: ['id'],
  automation_runs: ['id'],
  usage_records: ['id'],
  activity_events: ['id'],
  security_audit_events: ['id'],
  rt_artifacts: ['id'],
}

export interface RuntimeEvent {
  seq: number
  at: string
  kind: 'entity' | 'runtime'
  /** entity: table, key (joined with '|'), deleted flag and full row (snake_case columns). */
  table?: string
  key?: string
  deleted?: boolean
  row?: Record<string, unknown> | null
  /** runtime: lifecycle facts (started, error, client paired/revoked, artifact skipped…). */
  data?: Record<string, unknown>
}

/** Pushed live only (never stored): streaming text, live activity, constellation pulses. */
export interface LiveEvent {
  type: 'mission.delta' | 'mission.activity' | 'constellation.signal'
  payload: Record<string, unknown>
  at: string
}

// Shared shapes

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:.-]+$/)
const requestId = z.string().min(8).max(80).regex(/^[A-Za-z0-9_:.-]+$/)
const iso = z.string().max(40)
const project = z.string().refine(isSafeProjectName, 'Nom de projet invalide (nom simple, sans chemin).')
const permissions = z.object({ readFiles: z.boolean(), writeFiles: z.boolean(), runCommands: z.boolean(), network: z.boolean(), manageProjects: z.boolean(), externalActions: z.boolean() })
const limits = z.object({ maxDepth: z.number().int().min(1), maxSubtasks: z.number().int().min(1).max(50), maxParallel: z.number().int().min(1).max(8), maxDurationMin: z.number().int().min(1).max(1440), maxTokens: z.number().int().min(1000).max(100_000_000).nullable(), maxBudgetUsd: z.number().min(0).max(10_000).nullable() })

export const agentSyncSchema = z.object({
  id,
  /** Orbit's updatedAt: an older snapshot never replaces a newer one. */
  version: iso,
  name: z.string().min(1).max(60),
  role: z.string().max(200),
  description: z.string().max(2000),
  appearance: z.record(z.string(), z.unknown()),
  providerId: z.enum(['claude-code', 'codex', 'claude-agent', 'anthropic', 'openai']),
  model: z.string().min(1).max(120),
  instructions: z.string().max(40_000),
  autonomy: z.enum(['manual', 'supervised', 'automated', 'autonomous']),
  permissions,
  project: project.nullable(),
  isolation: z.enum(['standard', 'strict']),
  effort: z.string().max(20).nullable(),
  dailyBudgetUsd: z.number().min(0).max(10_000).nullable(),
  enabled: z.boolean(),
})
export type AgentSync = z.infer<typeof agentSyncSchema>

export const constellationSyncSchema = z.object({
  id,
  version: iso,
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  objective: z.string().max(4000),
  coordinatorAgentId: id,
  members: z.array(z.object({ agentId: id, role: z.string().max(200), responsibilities: z.string().max(2000), canDelegate: z.boolean() })).min(1).max(12),
  project: project.nullable(),
  workspaceMode: z.enum(['shared', 'worktrees']),
  permissions,
  limits,
})
export type ConstellationSync = z.infer<typeof constellationSyncSchema>

export const automationSyncSchema = z.object({
  id,
  /** Orbit's config_version: strictly increasing. */
  version: z.number().int().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  targetKind: z.enum(['agent', 'constellation']),
  targetId: id,
  title: z.string().min(1).max(200),
  prompt: z.string().max(40_000),
  recurrence: z.unknown().nullable(),
  timezone: z.string().min(1).max(64),
  missedPolicy: z.enum(['skip', 'run_once', 'ask']),
  maxRunsPerDay: z.number().int().min(1).max(1440).nullable(),
  triggers: z.array(z.object({ kind: z.enum(['mission.completed', 'mission.failed', 'automation.completed']), sourceAgentId: id.nullable(), sourceAutomationId: id.nullable(), cooldownSec: z.number().int().min(60).max(86400) })).max(10),
  status: z.enum(['active', 'paused']),
  maxDurationMin: z.number().int().min(1).max(1440).nullable(),
  budgetUsd: z.number().min(0).max(10_000).nullable(),
  failurePolicy: z.enum(['notify', 'pause']),
})
export type AutomationSync = z.infer<typeof automationSyncSchema>

export const machineLimitsSchema: z.ZodType<MachineLimits> = z.object({
  /** Missions running at once on this runtime (queued beyond). */
  maxConcurrentMissions: z.number().int().min(1).max(16),
  /** Hard stop for any single mission, in minutes. */
  maxMissionDurationMin: z.number().int().min(1).max(1440),
  /** API spend (measured or estimated) on this runtime; subscriptions have no price and are not counted. */
  dailyBudgetUsd: z.number().min(0).max(10_000).nullable(),
  monthlyBudgetUsd: z.number().min(0).max(100_000).nullable(),
})
export const DEFAULT_LIMITS: MachineLimits = { maxConcurrentMissions: 2, maxMissionDurationMin: 120, dailyBudgetUsd: null, monthlyBudgetUsd: null }

// Methods

export const methods = {
  // open (local token only)
  hello: z.object({ protocol: z.number().int(), client: z.object({ id: id.nullable(), name: z.string().max(80), version: z.string().max(40) }), nonce: z.string().min(16).max(128) }),
  'client.pair': z.object({ clientId: id, name: z.string().min(1).max(80), publicKey: z.string().min(40).max(200) }),
  'session.open': z.object({ clientId: id, signature: z.string().min(40).max(200) }),
  'health.liveness': z.object({}),
  // session required
  heartbeat: z.object({}),
  health: z.object({}),
  metrics: z.object({}),
  engines: z.object({ refresh: z.boolean().optional() }),
  'events.since': z.object({ cursor: z.number().int().min(0), limit: z.number().int().min(1).max(2000).optional() }),
  snapshot: z.object({ tables: z.array(z.string().max(40)).max(30).optional(), limit: z.number().int().min(1).max(20_000).optional() }),
  'client.list': z.object({}),
  'client.revoke': z.object({ requestId, clientId: id }),
  'limits.put': z.object({ requestId, limits: machineLimitsSchema }),
  'agent.put': z.object({ requestId, agent: agentSyncSchema }),
  'agent.delete': z.object({ requestId, id }),
  'constellation.put': z.object({ requestId, constellation: constellationSyncSchema }),
  'constellation.delete': z.object({ requestId, id }),
  'mission.create': z.object({ requestId, mission: z.object({ id, shortId: z.string().min(1).max(16), title: z.string().min(1).max(200), description: z.string().max(50_000), agentId: id, priority: z.enum(['low', 'normal', 'high', 'urgent']) }), origin: z.enum(['user', 'automation']) }),
  'mission.followUp': z.object({ requestId, id, prompt: z.string().min(1).max(50_000) }),
  'mission.cancel': z.object({ requestId, id }),
  'approval.resolve': z.object({ requestId, id, approve: z.boolean(), scope: z.enum(['once', 'mission', 'always']), operationHash: z.string().max(80).nullable() }),
  'constellation.launch': z.object({ requestId, runId: id, constellationId: id, goal: z.string().min(1).max(20_000), origin: z.enum(['user', 'automation']) }),
  'constellation.cancel': z.object({ requestId, runId: id }),
  'automation.put': z.object({ requestId, automation: automationSyncSchema }),
  'automation.get': z.object({ id }),
  'automation.release': z.object({ requestId, id }),
  'automation.setStatus': z.object({ requestId, id, status: z.enum(['active', 'paused']) }),
  'automation.runNow': z.object({ requestId, id }),
  'automation.confirmRun': z.object({ requestId, runId: id, approve: z.boolean() }),
  'artifact.list': z.object({ missionId: id.optional() }),
  'artifact.get': z.object({ id, offset: z.number().int().min(0).optional() }),
} as const

export type Method = keyof typeof methods
/** Token-authenticated only (the runtime's OS user, e.g. the local CLI). Nothing here exposes a secret or changes state, except pairing. */
export const OPEN_METHODS: Method[] = ['hello', 'client.pair', 'session.open', 'health.liveness', 'health', 'metrics']

export interface HelloResult {
  protocol: number
  runtimeVersion: string
  schemaVersion: string
  runtimeId: string
  /** Ed25519 public key (SPKI DER, base64) and its fingerprint. */
  runtimeKey: string
  runtimeKeyFingerprint: string
  /** Signature of helloProofMessage(runtimeId, nonce). */
  proof: string
  /** One-time challenge for session.open. */
  challenge: string
  paired: boolean
  machine: { hostname: string; platform: string; arch: string; node: string; cpus: number; memoryGb: number }
  lastSeq: number
  firstSeq: number
}





export interface RpcRequest {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: unknown
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

export const RPC_ERRORS = { unauthenticated: 401, forbidden: 403, notFound: 404, conflict: 409, sessionExpired: 440, invalid: 422, internal: 500 } as const
