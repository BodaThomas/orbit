import { z } from 'zod'
import type { ArtifactMeta, EngineStatus } from './remote'
import type {
  ActivityEvent,
  Agent,
  AgentMemory,
  ApprovalRequest,
  AuditEntry,
  Bootstrap,
  Conversation,
  ExecutionEvent,
  LiveActivity,
  Machine,
  Message,
  Mission,
  MissionDetail,
  OrbitNotification,
  OrbitSettings,
  ToolCall,
  ProviderHealth,
  ProviderInfo,
  UsageSummary,
  Workflow,
  SecurityStatus,
  RateLimitSnapshot,
  ClaudeLocalUsage,
  ConstellationSignal,
  ConstellationDefinition,
  ConstellationRun,
  ConstellationRunDetail,
  ConstellationPlan,
  AgentWorkspace,
  Automation,
  RemoteMachine,
  AutomationRun,
  RecentFileChange,
  PermissionGrant,
  AutoActionEntry,
} from './types'

// Input schemas

const id = z.string().min(1).max(64)
const paletteId = z.enum(['lavender', 'azure', 'teal', 'amber', 'rose', 'mint', 'coral', 'slate'])
const providerId = z.enum(['anthropic', 'openai', 'claude-code', 'claude-agent', 'codex', 'gemini', 'grok', 'openrouter', 'ollama', 'demo'])

export const appearanceSchema = z.object({
  species: z.enum(['round', 'oval', 'antenna', 'eared', 'cloud', 'drop']),
  palette: paletteId,
  expression: z.enum(['welcoming', 'focused', 'curious', 'calm', 'joyful', 'sleepy']),
  planet: z.object({
    palette: paletteId,
    texture: z.enum(['smooth', 'bands', 'craters', 'facets', 'organic']),
    atmosphere: z.number().min(0).max(1),
    ring: z.boolean(),
    satellite: z.boolean(),
    scale: z.number().min(0.8).max(1.2),
  }),
})

export const permissionsSchema = z.object({
  readFiles: z.boolean(),
  writeFiles: z.boolean(),
  runCommands: z.boolean(),
  network: z.boolean(),
  manageProjects: z.boolean(),
  externalActions: z.boolean(),
})

export const agentInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().max(60),
  description: z.string().max(400),
  appearance: appearanceSchema,
  providerId,
  model: z.string().min(1).max(120),
  instructions: z.string().max(20_000),
  autonomy: z.enum(['manual', 'supervised', 'automated', 'autonomous']),
  permissions: permissionsSchema,
  workingDirectory: z.string().max(1024).nullable(),
  dailyBudgetUsd: z.number().min(0).max(10_000).nullable(),
  isolation: z.enum(['standard', 'strict']).default('standard'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  runtime: z.enum(['local', 'remote']).default('local'),
  machineId: z.string().max(64).nullable().default(null),
})
export type AgentInput = z.infer<typeof agentInputSchema>
export type AgentInputRaw = z.input<typeof agentInputSchema>

const settingsPatch = z
  .object({
    onboarded: z.boolean(),
    userName: z.string().max(40),
    dailyLimitUsd: z.number().min(0).max(100_000).nullable(),
    monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable(),
    nativeNotifications: z.boolean(),
    reduceMotion: z.enum(['system', 'always', 'never']),
  })
  .partial()

const limitsSchema = z.object({
  maxDepth: z.number().int().min(1).max(5),
  maxSubtasks: z.number().int().min(1).max(50),
  maxParallel: z.number().int().min(1).max(8),
  maxDurationMin: z.number().int().min(1).max(1440),
  maxTokens: z.number().int().min(1000).max(100_000_000).nullable(),
  maxBudgetUsd: z.number().min(0).max(10_000).nullable(),
})

export const constellationInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000),
  objective: z.string().max(4000),
  coordinatorAgentId: id,
  members: z
    .array(z.object({ agentId: id, role: z.string().max(80), responsibilities: z.string().max(1000), canDelegate: z.boolean() }))
    .min(2)
    .max(12),
  workspace: z.string().max(1024).nullable(),
  workspaceMode: z.enum(['shared', 'worktrees']),
  permissions: permissionsSchema,
  limits: limitsSchema,
  isTemplate: z.boolean(),
  planApproval: z.enum(['auto', 'writes', 'always']).optional(),
})

export const planTaskInputSchema = z.object({
  id: z.string().trim().min(1).max(40),
  assignee: z.string().trim().min(1).max(80),
  objective: z.string().trim().min(1).max(4000),
  expected: z.string().max(2000).optional(),
  context: z.string().max(8000).optional(),
  dependsOn: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  readOnly: z.boolean().optional(),
  writes: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
})

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.string().max(20) }),
  z.object({ kind: z.literal('daily'), time: z.string().max(5) }),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number().int().min(1).max(7)).min(1).max(7), time: z.string().max(5) }),
  z.object({ kind: z.literal('monthly'), day: z.number().int().min(1).max(31), time: z.string().max(5) }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(44_640), anchor: z.string().max(40) }),
  z.object({ kind: z.literal('cron'), expr: z.string().max(120) }),
])

export const automationInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000),
  targetKind: z.enum(['agent', 'constellation']),
  targetId: id,
  title: z.string().trim().min(1).max(160),
  prompt: z.string().max(20_000),
  recurrence: recurrenceSchema.nullable(),
  timezone: z.string().min(1).max(64),
  missedPolicy: z.enum(['skip', 'run_once', 'ask']),
  maxRunsPerDay: z.number().int().min(1).max(500).nullable(),
  triggers: z.array(z.object({ kind: z.enum(['mission.completed', 'mission.failed', 'automation.completed']), sourceAgentId: id.nullable(), sourceAutomationId: id.nullable(), cooldownSec: z.number().int().min(60).max(86_400) })).max(5),
  maxDurationMin: z.number().int().min(1).max(1440).nullable().optional(),
  budgetUsd: z.number().min(0).max(10_000).nullable().optional(),
  failurePolicy: z.enum(['notify', 'pause']).optional(),
})

const memoryKind = z.enum(['instruction', 'personal', 'fact', 'summary', 'document', 'mission'])

export const ipcSchemas = {
  'app.bootstrap': z.void(),
  'app.setMode': z.object({ mode: z.enum(['real', 'demo']) }),
  'app.openStatusPage': z.object({ providerId }),
  'app.chooseDirectory': z.void(),
  'settings.update': settingsPatch,

  'agents.list': z.void(),
  'agents.create': agentInputSchema,
  'agents.update': z.object({ id, patch: agentInputSchema.partial() }),
  'agents.delete': z.object({ id }),
  'agents.duplicate': z.object({ id }),
  'agents.setEnabled': z.object({ id, enabled: z.boolean() }),

  'providers.list': z.void(),
  'providers.setKey': z.object({ providerId, apiKey: z.string().trim().min(8).max(512) }),
  'providers.removeKey': z.object({ providerId }),
  'providers.validate': z.object({ providerId }),
  'providers.testEngine': z.object({ providerId }),
  'providers.health': z.void(),
  'providers.refreshHealth': z.void(),

  'conversations.list': z.object({ agentId: id }),
  'conversations.create': z.object({ agentId: id, title: z.string().max(120).optional() }),
  'conversations.rename': z.object({ id, title: z.string().trim().min(1).max(120) }),
  'conversations.delete': z.object({ id }),
  'conversations.messages': z.object({ conversationId: id }),
  'conversations.send': z.object({ conversationId: id, content: z.string().trim().min(1).max(100_000) }),
  'conversations.cancel': z.object({ conversationId: id }),
  'conversations.search': z.object({ query: z.string().trim().min(1).max(200) }),

  'missions.list': z.object({ agentId: id.optional() }),
  'missions.get': z.object({ id }),
  'missions.create': z.object({
    title: z.string().trim().min(1).max(160),
    description: z.string().max(20_000),
    agentId: id,
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    startNow: z.boolean(),
  }),
  'missions.start': z.object({ id }),
  'missions.followUp': z.object({ id, prompt: z.string().trim().min(1).max(20_000) }),
  'missions.cancel': z.object({ id }),
  'missions.retry': z.object({ id }),
  'missions.duplicate': z.object({ id }),
  'missions.delete': z.object({ id }),

  'approvals.list': z.object({ status: z.enum(['pending', 'approved', 'denied', 'expired']).optional() }),
  'approvals.resolve': z.object({ id, approve: z.boolean(), scope: z.enum(['once', 'mission', 'always']).default('once') }),
  'permissions.grants': z.object({ agentId: id.optional(), includeRevoked: z.boolean().optional() }),
  'permissions.revoke': z.object({ id }),
  'permissions.autoLog': z.object({ agentId: id.optional(), limit: z.number().int().min(1).max(500).optional() }),

  'activity.list': z.object({
    limit: z.number().int().min(1).max(500).optional(),
    agentId: id.optional(),
    query: z.string().max(200).optional(),
    level: z.enum(['info', 'success', 'warning', 'error']).optional(),
  }),
  'usage.summary': z.void(),
  'usage.quotas': z.void(),
  'usage.localClaude': z.void(),
  'usage.setLocalClaude': z.object({ enabled: z.boolean() }),
  'notifications.list': z.void(),
  'notifications.markRead': z.object({ id: id.optional() }),

  'memory.list': z.object({ agentId: id }),
  'memory.create': z.object({ agentId: id, kind: memoryKind, content: z.string().trim().min(1).max(20_000), includeInContext: z.boolean() }),
  'memory.update': z.object({ id, content: z.string().trim().min(1).max(20_000).optional(), includeInContext: z.boolean().optional() }),
  'memory.delete': z.object({ id }),

  'machines.list': z.void(),
  'workflows.list': z.void(),
  'audit.list': z.object({ limit: z.number().int().min(1).max(500).optional() }),

  'constellations.list': z.void(),
  'constellations.create': constellationInputSchema,
  'constellations.update': z.object({ id, input: constellationInputSchema }),
  'constellations.delete': z.object({ id }),
  'constellations.duplicate': z.object({ id, asTemplate: z.boolean().optional() }),
  'constellations.launch': z.object({ id, goal: z.string().trim().min(1).max(20_000) }),
  'constellations.runs': z.object({ constellationId: id.optional() }),
  'constellations.run': z.object({ id }),
  'constellations.cancel': z.object({ id }),
  'constellations.resume': z.object({ id, skipFailed: z.boolean().optional() }),
  'constellations.pause': z.object({ id }),
  'constellations.approvePlan': z.object({ id, planId: id, hash: z.string().max(64).optional() }),
  'constellations.rejectPlan': z.object({ id, planId: id, feedback: z.string().max(8000) }),
  'constellations.answer': z.object({ id, text: z.string().trim().min(1).max(8000) }),
  'constellations.retry': z.object({ id, missionIds: z.array(id).min(1).max(50) }),
  'constellations.editPlan': z.object({ id, tasks: z.array(planTaskInputSchema).min(1).max(50) }),
  'constellations.updateLimits': z.object({ id, limits: limitsSchema.partial() }),
  'constellations.unfinished': z.void(),
  'constellations.workspaceDiff': z.object({ id }),
  'constellations.mergeWorkspace': z.object({ id }),
  'constellations.discardWorkspace': z.object({ id }),

  'automations.list': z.void(),
  'automations.runs': z.object({ automationId: id.optional() }),
  'automations.create': automationInputSchema,
  'automations.update': z.object({ id, input: automationInputSchema }),
  'automations.delete': z.object({ id }),
  'automations.setStatus': z.object({ id, status: z.enum(['active', 'paused']) }),
  'automations.runNow': z.object({ id }),
  'automations.confirmRun': z.object({ id, approve: z.boolean() }),
  'automations.preview': z.object({ recurrence: recurrenceSchema, timezone: z.string().max(64), count: z.number().int().min(1).max(10).optional() }),
  'app.launchAtLogin': z.object({ enabled: z.boolean().optional() }),

  'runtime.list': z.void(),
  'runtime.register': z.object({ name: z.string().trim().min(1).max(60), transport: z.enum(['ssh', 'local']), host: z.string().max(253).nullable(), user: z.string().max(32).nullable(), port: z.number().int().min(1).max(65535), runtimeHome: z.string().min(1).max(512), identityFile: z.string().max(1024).nullable().optional() }),
  'runtime.scanHostKey': z.object({ id }),
  'runtime.confirmHostKey': z.object({ id, fingerprint: z.string().max(200) }),
  'runtime.deployPlan': z.object({ id }),
  'runtime.deploy': z.object({ id }),
  'runtime.connect': z.object({ id }),
  'runtime.disconnect': z.object({ id }),
  'runtime.revoke': z.object({ id }),
  'runtime.confirmIdentity': z.object({ id, fingerprint: z.string().max(200) }),
  'runtime.engines': z.object({ id, refresh: z.boolean().optional() }),
  'runtime.setLimits': z.object({ id, limits: z.object({ maxConcurrentMissions: z.number().int().min(1).max(16), maxMissionDurationMin: z.number().int().min(1).max(1440), dailyBudgetUsd: z.number().min(0).max(10_000).nullable(), monthlyBudgetUsd: z.number().min(0).max(100_000).nullable() }) }),
  'runtime.clients': z.object({ id }),
  'runtime.events': z.object({ id }),
  'automations.transfer': z.object({ id, to: z.string().min(1).max(64) }),
  'automations.cancelTransfer': z.object({ id }),
  'artifacts.list': z.object({ missionId: id }),
  'artifacts.fetch': z.object({ id }),
  'artifacts.reveal': z.object({ id }),

  'security.status': z.void(),
  'security.selfTest': z.void(),
  'files.recent': z.object({ agentId: id.optional(), limit: z.number().int().min(1).max(500).optional() }),
} as const

export type IpcChannel = keyof typeof ipcSchemas
export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcSchemas)[C]>

// Outputs

export interface IpcOutputs {
  'app.bootstrap': Bootstrap
  'app.setMode': Bootstrap
  'app.openStatusPage': void
  'app.chooseDirectory': string | null
  'settings.update': OrbitSettings

  'agents.list': Agent[]
  'agents.create': Agent
  'agents.update': Agent
  'agents.delete': void
  'agents.duplicate': Agent
  'agents.setEnabled': Agent

  'providers.list': ProviderInfo[]
  'providers.setKey': ProviderInfo
  'providers.removeKey': ProviderInfo
  'providers.validate': { ok: boolean; error: string | null }
  'providers.testEngine': { ok: boolean; text: string; model: string | null; durationMs: number; error: string | null; deniedTools: number }
  'providers.health': ProviderHealth[]
  'providers.refreshHealth': ProviderHealth[]

  'conversations.list': Conversation[]
  'conversations.create': Conversation
  'conversations.rename': Conversation
  'conversations.delete': void
  'conversations.messages': Message[]
  'conversations.send': { userMessage: Message; assistantMessage: Message }
  'conversations.cancel': void
  'conversations.search': { conversation: Conversation; snippet: string }[]

  'missions.list': Mission[]
  'missions.get': MissionDetail
  'missions.create': Mission
  'missions.start': Mission
  'missions.followUp': Mission
  'missions.cancel': Mission
  'missions.retry': Mission
  'missions.duplicate': Mission
  'missions.delete': void

  'approvals.list': ApprovalRequest[]
  'approvals.resolve': ApprovalRequest
  'permissions.grants': PermissionGrant[]
  'permissions.revoke': PermissionGrant
  'permissions.autoLog': AutoActionEntry[]

  'activity.list': ActivityEvent[]
  'usage.summary': UsageSummary
  'usage.quotas': RateLimitSnapshot[]
  'usage.localClaude': { enabled: boolean; usage: ClaudeLocalUsage | null; error: string | null }
  'usage.setLocalClaude': { enabled: boolean; usage: ClaudeLocalUsage | null; error: string | null }
  'notifications.list': OrbitNotification[]
  'notifications.markRead': void

  'memory.list': AgentMemory[]
  'memory.create': AgentMemory
  'memory.update': AgentMemory
  'memory.delete': void

  'machines.list': Machine[]
  'workflows.list': Workflow[]
  'audit.list': AuditEntry[]

  'constellations.list': ConstellationDefinition[]
  'constellations.create': ConstellationDefinition
  'constellations.update': ConstellationDefinition
  'constellations.delete': void
  'constellations.duplicate': ConstellationDefinition
  'constellations.launch': ConstellationRun
  'constellations.runs': ConstellationRun[]
  'constellations.run': ConstellationRunDetail
  'constellations.cancel': ConstellationRun
  'constellations.resume': ConstellationRun
  'constellations.pause': ConstellationRun
  'constellations.approvePlan': ConstellationRun
  'constellations.rejectPlan': ConstellationRun
  'constellations.answer': ConstellationRun
  'constellations.retry': ConstellationRun
  'constellations.editPlan': ConstellationPlan
  'constellations.updateLimits': ConstellationRun
  'constellations.unfinished': ConstellationRun[]
  'constellations.workspaceDiff': string
  'constellations.mergeWorkspace': AgentWorkspace
  'constellations.discardWorkspace': AgentWorkspace

  'automations.list': Automation[]
  'automations.runs': AutomationRun[]
  'automations.create': Automation
  'automations.update': Automation
  'automations.delete': void
  'automations.setStatus': Automation
  'automations.runNow': AutomationRun | null
  'automations.confirmRun': AutomationRun
  'automations.preview': { next: string[]; error: string | null; description: string | null }
  'app.launchAtLogin': { enabled: boolean; supported: boolean }

  'runtime.list': RemoteMachine[]
  'runtime.register': RemoteMachine
  'runtime.scanHostKey': { fingerprint: string; algorithm: string }
  'runtime.confirmHostKey': RemoteMachine
  'runtime.deployPlan': string[]
  'runtime.deploy': RemoteMachine
  'runtime.connect': RemoteMachine
  'runtime.disconnect': void
  'runtime.revoke': void
  'runtime.confirmIdentity': RemoteMachine
  'runtime.engines': EngineStatus[]
  'runtime.setLimits': RemoteMachine
  'runtime.clients': { id: string; name: string; fingerprint: string; created_at: string; last_seen_at: string | null; revoked_at: string | null; self: boolean }[]
  'runtime.events': { seq: number; kind: string; at: string; data: Record<string, unknown> | null }[]
  'automations.transfer': Automation
  'automations.cancelTransfer': Automation
  'artifacts.list': RemoteArtifact[]
  'artifacts.fetch': { path: string; preview: string | null }
  'artifacts.reveal': void

  'security.status': SecurityStatus
  'security.selfTest': SecurityStatus
  'files.recent': RecentFileChange[]
}

/** Error shape returned across the bridge (never a raw Error with stack). */
export interface IpcError {
  code: 'validation' | 'not_found' | 'forbidden' | 'provider' | 'budget' | 'conflict' | 'internal'
  message: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

// Push events (main → renderer)

export type OrbitEvent =
  | { type: 'message.delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'message.updated'; message: Message }
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'mission.event'; event: ExecutionEvent }
  | { type: 'mission.delta'; missionId: string; executionId: string; delta: string }
  | { type: 'mission.activity'; missionId: string; activity: LiveActivity | null }
  | { type: 'mission.tool'; toolCall: ToolCall }
  | { type: 'invalidate'; scopes: InvalidateScope[] }
  | { type: 'navigate'; route: string }
  | { type: 'constellation.signal'; signal: ConstellationSignal }
  /** An action ran without confirmation (routine rule, persistent grant, engine classifier). */
  | { type: 'permission.auto'; agentId: string; agentName: string; missionId: string; title: string; via: 'policy' | 'grant' | 'engine'; category: string }

/** A runtime artifact as Orbit Desktop knows it (metadata synced, content fetched on demand). */
export type RemoteArtifact = ArtifactMeta & { machineId: string; localPath: string | null }

export type InvalidateScope =
  | 'agents'
  | 'providers'
  | 'health'
  | 'conversations'
  | 'missions'
  | 'approvals'
  | 'activity'
  | 'usage'
  | 'notifications'
  | 'memory'
  | 'settings'
  | 'workflows'
  | 'constellations'
  | 'automations'
  | 'machines'
  | 'security'
  | 'all'

export const IPC_INVOKE_CHANNEL = 'orbit:invoke'
export const IPC_EVENT_CHANNEL = 'orbit:event'
