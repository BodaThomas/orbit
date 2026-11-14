import { z } from 'zod'
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
} from './types'

// Input schemas

const id = z.string().min(1).max(64)
const paletteId = z.enum(['lavender', 'azure', 'teal', 'amber', 'rose', 'mint', 'coral', 'slate'])
const providerId = z.enum(['anthropic', 'openai', 'claude-agent', 'codex', 'gemini', 'grok', 'openrouter', 'ollama', 'demo'])

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
  autonomy: z.enum(['manual', 'supervised', 'automated']),
  permissions: permissionsSchema,
  workingDirectory: z.string().max(1024).nullable(),
  dailyBudgetUsd: z.number().min(0).max(10_000).nullable(),
})
export type AgentInput = z.infer<typeof agentInputSchema>

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
  'approvals.resolve': z.object({ id, approve: z.boolean() }),

  'activity.list': z.object({
    limit: z.number().int().min(1).max(500).optional(),
    agentId: id.optional(),
    query: z.string().max(200).optional(),
    level: z.enum(['info', 'success', 'warning', 'error']).optional(),
  }),
  'usage.summary': z.void(),
  'notifications.list': z.void(),
  'notifications.markRead': z.object({ id: id.optional() }),

  'memory.list': z.object({ agentId: id }),
  'memory.create': z.object({ agentId: id, kind: memoryKind, content: z.string().trim().min(1).max(20_000), includeInContext: z.boolean() }),
  'memory.update': z.object({ id, content: z.string().trim().min(1).max(20_000).optional(), includeInContext: z.boolean().optional() }),
  'memory.delete': z.object({ id }),

  'machines.list': z.void(),
  'workflows.list': z.void(),
  'audit.list': z.object({ limit: z.number().int().min(1).max(500).optional() }),
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

  'activity.list': ActivityEvent[]
  'usage.summary': UsageSummary
  'notifications.list': OrbitNotification[]
  'notifications.markRead': void

  'memory.list': AgentMemory[]
  'memory.create': AgentMemory
  'memory.update': AgentMemory
  'memory.delete': void

  'machines.list': Machine[]
  'workflows.list': Workflow[]
  'audit.list': AuditEntry[]
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
  | 'all'

export const IPC_INVOKE_CHANNEL = 'orbit:invoke'
export const IPC_EVENT_CHANNEL = 'orbit:event'
