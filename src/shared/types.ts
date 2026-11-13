/**
 * Orbit domain types - shared by main, preload and renderer.
 * Pure types only: no runtime code here.
 */

// Appearance

export type Species = 'round' | 'oval' | 'antenna' | 'eared' | 'cloud' | 'drop'
export type PaletteId = 'lavender' | 'azure' | 'teal' | 'amber' | 'rose' | 'mint' | 'coral' | 'slate'
export type Expression = 'welcoming' | 'focused' | 'curious' | 'calm' | 'joyful' | 'sleepy'
export type PlanetTexture = 'smooth' | 'bands' | 'craters' | 'facets' | 'organic'

export interface PlanetSpec {
  palette: PaletteId
  texture: PlanetTexture
  /** 0 → no atmosphere, 1 → thick glow */
  atmosphere: number
  ring: boolean
  satellite: boolean
  /** Visual size multiplier, 0.8 → 1.2 */
  scale: number
}

export interface Appearance {
  species: Species
  palette: PaletteId
  expression: Expression
  planet: PlanetSpec
}

// Agents

export type AgentStatus =
  | 'available'
  | 'working'
  | 'awaiting_approval'
  | 'done'
  | 'error'
  | 'offline'
  | 'disabled'

export type AutonomyLevel = 'manual' | 'supervised' | 'automated'

export interface AgentPermissions {
  readFiles: boolean
  writeFiles: boolean
  runCommands: boolean
  network: boolean
  manageProjects: boolean
  externalActions: boolean
}

export interface Agent {
  id: string
  name: string
  role: string
  description: string
  appearance: Appearance
  providerId: ProviderId
  model: string
  instructions: string
  autonomy: AutonomyLevel
  permissions: AgentPermissions
  workingDirectory: string | null
  runtime: 'local'
  dailyBudgetUsd: number | null
  enabled: boolean
  status: AgentStatus
  statusText: string | null
  createdAt: string
  updatedAt: string
}

// Providers

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'claude-agent'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'openrouter'
  | 'ollama'
  | 'demo'

export interface ProviderCapabilities {
  streaming: boolean
  cancel: boolean
  tools: boolean
  sessions: boolean
  usage: 'official' | 'estimated' | 'none'
  apiKeyAuth: boolean
}

export interface ModelInfo {
  id: string
  label: string
  /** Short hint shown in pickers */
  hint?: string
}

export interface ProviderInfo {
  id: ProviderId
  name: string
  /** `available` = adapter implemented; `planned` = shown as « Bientôt » */
  availability: 'available' | 'planned'
  capabilities: ProviderCapabilities
  models: ModelInfo[]
  connected: boolean
  hasSecret: boolean
  /** Masked tail of the key, e.g. "…a1B2" */
  secretHint: string | null
  lastValidatedAt: string | null
  statusPage: string | null
  services: string[]
  notes: string
}

export type HealthLevel = 'operational' | 'degraded' | 'outage' | 'unknown'

export interface HealthIncident {
  id: string
  name: string
  status: string
  impact: string
  startedAt: string
  updatedAt: string
  url: string | null
  updates: { status: string; body: string; at: string }[]
}

export interface ProviderHealth {
  providerId: ProviderId
  level: HealthLevel
  description: string
  components: { name: string; level: HealthLevel }[]
  /** 30 entries, oldest first, UTC dates */
  days: { date: string; level: HealthLevel; incidents: number }[]
  uptimePct: number | null
  activeIncidents: HealthIncident[]
  checkedAt: string
  source: string
  error: string | null
}

// Conversations

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled'

export interface Conversation {
  id: string
  agentId: string
  title: string
  providerSessionId: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  status: MessageStatus
  error: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  costKind: CostKind | null
  createdAt: string
}

// Missions

export type MissionStatus =
  | 'todo'
  | 'scheduled'
  | 'running'
  | 'waiting'
  | 'approval_required'
  | 'done'
  | 'failed'
  | 'cancelled'

export type MissionPriority = 'low' | 'normal' | 'high' | 'urgent'

export interface Mission {
  id: string
  shortId: string
  title: string
  description: string
  agentId: string
  priority: MissionPriority
  status: MissionStatus
  result: string | null
  error: string | null
  costUsd: number | null
  costKind: CostKind | null
  workflowId: string | null
  parentMissionId: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface ExecutionEvent {
  id: string
  missionId: string
  executionId: string
  type: 'started' | 'thinking' | 'output' | 'tool' | 'approval' | 'usage' | 'completed' | 'failed' | 'cancelled'
  message: string
  data: Record<string, unknown> | null
  createdAt: string
}

export interface ApprovalRequest {
  id: string
  agentId: string
  missionId: string | null
  kind: 'mission_start' | 'tool_use' | 'budget_override'
  summary: string
  detail: string | null
  status: 'pending' | 'approved' | 'denied' | 'expired'
  createdAt: string
  resolvedAt: string | null
}

// Activity

export type ActivityType =
  | 'agent.created'
  | 'agent.updated'
  | 'agent.deleted'
  | 'conversation.created'
  | 'message.received'
  | 'mission.created'
  | 'mission.started'
  | 'mission.completed'
  | 'mission.failed'
  | 'mission.cancelled'
  | 'approval.requested'
  | 'approval.resolved'
  | 'tool.called'
  | 'file.written'
  | 'provider.connected'
  | 'provider.error'
  | 'budget.reached'

export type ActivityLevel = 'info' | 'success' | 'warning' | 'error'

export interface ActivityEvent {
  id: string
  type: ActivityType
  level: ActivityLevel
  agentId: string | null
  missionId: string | null
  conversationId: string | null
  title: string
  detail: string | null
  createdAt: string
}

// Usage

/** Never mix these categories in totals without labelling them. */
export type CostKind = 'official' | 'estimated' | 'unknown' | 'subscription'

export interface UsageRecord {
  id: string
  agentId: string | null
  providerId: ProviderId
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  costKind: CostKind
  pricingVersion: string | null
  source: 'conversation' | 'mission'
  createdAt: string
}

export interface CostBreakdown {
  official: number
  estimated: number
  unknownCount: number
  subscriptionCount: number
}

export interface UsageSummary {
  today: CostBreakdown
  yesterday: CostBreakdown
  month: CostBreakdown
  byProviderToday: { providerId: ProviderId; cost: CostBreakdown }[]
  byAgentMonth: { agentId: string; cost: CostBreakdown; requests: number }[]
  daily: { date: string; official: number; estimated: number; requests: number }[]
  requestsToday: number
  requestsMonth: number
  tokensMonth: { input: number; output: number }
  missionsDone: number
  missionsFailed: number
  avgMissionSeconds: number | null
  dailyLimitUsd: number | null
  monthlyBudgetUsd: number | null
}

// Constellations

export interface Workflow {
  id: string
  name: string
  coordinatorAgentId: string
  memberAgentIds: string[]
  missionId: string | null
  status: 'active' | 'done' | 'failed'
  createdAt: string
}

// Memory

export type MemoryKind = 'instruction' | 'personal' | 'fact' | 'summary' | 'document' | 'mission'

export interface AgentMemory {
  id: string
  agentId: string
  kind: MemoryKind
  content: string
  /** Only memories marked shareable are ever sent to the provider */
  includeInContext: boolean
  createdAt: string
  updatedAt: string
}

// Notifications & machines

export interface OrbitNotification {
  id: string
  kind: 'mission_done' | 'mission_failed' | 'approval' | 'budget' | 'provider' | 'agent'
  title: string
  body: string
  route: string | null
  read: boolean
  createdAt: string
}

export interface Machine {
  id: string
  name: string
  kind: 'local' | 'linux' | 'vps' | 'mac-remote'
  platform: string
  status: 'online' | 'offline' | 'planned'
  lastHeartbeatAt: string | null
  details: Record<string, string>
}

export interface AuditEntry {
  id: string
  actor: 'user' | 'agent' | 'system'
  agentId: string | null
  action: string
  target: string | null
  allowed: boolean
  reason: string | null
  createdAt: string
}

// Settings

export interface OrbitSettings {
  mode: 'real' | 'demo'
  onboarded: boolean
  userName: string
  dailyLimitUsd: number | null
  monthlyBudgetUsd: number | null
  nativeNotifications: boolean
  reduceMotion: 'system' | 'always' | 'never'
  locale: 'fr'
}

export interface Bootstrap {
  settings: OrbitSettings
  appVersion: string
  platform: string
  dataPath: string
  secureStorage: boolean
}
