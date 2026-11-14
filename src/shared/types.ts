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

/** `standard`: levels 1–2 (Orbit policy + engine sandbox). `strict`: + Orbit Seatbelt read confinement (level 3, host). */
export type IsolationMode = 'standard' | 'strict'

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
  isolation: IsolationMode
  /** Reasoning effort for engines that support it; null → engine default. */
  effort: string | null
  runtime: 'local' | 'remote'
  /** Remote machine id when `runtime === 'remote'`. */
  machineId: string | null
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
  | 'claude-code'
  | 'claude-agent'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'openrouter'
  | 'ollama'
  | 'demo'

export interface ProviderCapabilities {
  /** `chat`: one request → one streamed answer. `agent`: an engine that runs tools in a workspace. */
  kind: 'chat' | 'agent'
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
  /** Engines only: human-readable readiness (auth, binary), refreshed by « Vérifier ». */
  statusDetail: string | null
  /** Engines only: non-secret facts (version, auth method, default model, last activity). */
  engineFacts: Record<string, string> | null
  /** Engines only: how usage is billed, as detected (never guessed). */
  engineAuth: 'api_key' | 'subscription' | 'none' | 'unknown' | null
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
  /** Agent engines only: engine that owns the session, its session id and the folder it may touch. */
  engine: ProviderId | null
  sessionId: string | null
  workspace: string | null
  /** Constellation run this mission belongs to (coordinator or delegated sub-mission). */
  constellationRunId: string | null
  depth: number
  subtask: SubtaskSpec | null
  permissionsOverride: AgentPermissions | null
  resultData: StructuredResult | null
  /** Owned by this runtime machine; the row is a synced copy (actions become commands). */
  remoteMachineId: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type ExecutionEventType =
  | 'started'
  | 'user'
  | 'session'
  | 'thinking'
  | 'output'
  | 'message'
  | 'tool'
  | 'file'
  | 'approval'
  | 'warning'
  | 'usage'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ExecutionEvent {
  id: string
  missionId: string
  executionId: string
  type: ExecutionEventType
  message: string
  data: Record<string, unknown> | null
  createdAt: string
}

export interface MissionExecution {
  id: string
  missionId: string
  /** What the user asked for this run (first brief or a follow-up). */
  prompt: string | null
  status: 'running' | 'done' | 'failed' | 'cancelled'
  error: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  costKind: CostKind | null
  startedAt: string
  finishedAt: string | null
}

/** Normalised tool families shared by every engine. */
export type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'web' | 'mcp' | 'plan' | 'other'
export type ToolCallStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'denied' | 'cancelled'

export interface ToolCall {
  id: string
  missionId: string
  executionId: string
  agentId: string
  /** Engine-side identifier (tool_use id, Codex item id). */
  externalId: string
  /** Raw engine tool name (Read, Bash, commandExecution…). */
  name: string
  kind: ToolKind
  /** Short human label: « Lit src/app.ts », « npm test ». */
  title: string
  input: unknown
  output: string | null
  files: string[]
  exitCode: number | null
  status: ToolCallStatus
  startedAt: string
  finishedAt: string | null
}

export interface FileChange {
  id: string
  missionId: string
  executionId: string
  path: string
  kind: 'add' | 'update' | 'delete'
  diff: string | null
  agentId: string | null
  /** engine: reported by the engine · git/scan: found by Orbit's snapshot (shell edits included). */
  source: 'engine' | 'git' | 'scan'
  createdAt: string
}

export interface RecentFileChange extends FileChange {
  missionTitle: string
  missionShortId: string
}

/** How long a « yes » lasts. `once`: this action only. */
export type GrantScope = 'once' | 'mission' | 'always'

/** What an approval is about, shown to the user before they decide. */
export interface ApprovalPayload {
  tool: string
  kind: ToolKind
  command?: string
  cwd?: string
  paths?: string[]
  diff?: string
  reason?: string
  engine?: ProviderId
  /** Policy family (verify, install, deploy, edit…) and rule id. */
  category?: string
  rule?: string
  /** Exact operation a persistent authorisation would cover, and the widest scope offered. */
  grant?: { key: string; label: string; max: GrantScope; /** Companion folder the grant would be bound to (set by Orbit). */ workspace?: string }
}

/** A persistent « yes » given by the user, limited to one exact operation of one companion in one folder. */
export interface PermissionGrant {
  id: string
  agentId: string
  workspace: string
  scope: Exclude<GrantScope, 'once'>
  missionId: string | null
  kind: ToolKind
  operationKey: string
  label: string
  category: string | null
  uses: number
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** One action that ran without a confirmation (routine rule, persistent grant or engine classifier). */
export interface AutoActionEntry {
  id: string
  agentId: string | null
  missionId: string | null
  via: 'policy' | 'grant' | 'engine'
  category: string | null
  title: string
  reason: string | null
  createdAt: string
}

export interface ApprovalRequest {
  id: string
  agentId: string
  missionId: string | null
  executionId: string | null
  toolCallId: string | null
  kind: 'mission_start' | 'tool_use' | 'budget_override'
  summary: string
  detail: string | null
  payload: ApprovalPayload | null
  status: 'pending' | 'approved' | 'denied' | 'expired'
  createdAt: string
  resolvedAt: string | null
  /** Held by this runtime machine (the answer is sent there, bound to operationHash). */
  machineId: string | null
  operationHash: string | null
  expiresAt: string | null
  resolvedBy: string | null
}

/** What a companion is doing right now. Ephemeral, never invented: derived from engine events. */
export interface LiveActivity {
  missionId: string
  phase: 'starting' | 'thinking' | 'tool' | 'writing' | 'approval' | 'finishing'
  label: string
  toolCallId: string | null
  since: string
}

export interface MissionDetail {
  mission: Mission
  events: ExecutionEvent[]
  executions: MissionExecution[]
  toolCalls: ToolCall[]
  fileChanges: FileChange[]
  inventories: FileInventory[]
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
  | 'tool.denied'
  | 'file.written'
  | 'provider.connected'
  | 'provider.error'
  | 'budget.reached'
  | 'constellation.created'
  | 'constellation.started'
  | 'constellation.delegated'
  | 'constellation.completed'
  | 'constellation.failed'
  | 'constellation.cancelled'
  | 'automation.started'
  | 'automation.completed'
  | 'automation.failed'
  | 'automation.skipped'
  | 'runtime.connected'
  | 'runtime.disconnected'
  | 'automation.paused'
  | 'automation.transferred'
  | 'runtime.paired'
  | 'runtime.error'

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
  /** Subscription usage only: theoretical cost at API list price. Never added to spend. */
  equivalentUsd: number | null
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
  byAgentMonth: { agentId: string; cost: CostBreakdown; requests: number; tokens: number }[]
  /** Subscription usage this month: tokens and a theoretical API-price equivalent (never spend). */
  subscriptionMonth: { requests: number; tokens: number; equivalentUsd: number | null }
  missionsCancelled: number
  missionCounts: MissionCounts
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
  kind: 'mission_done' | 'mission_failed' | 'approval' | 'budget' | 'provider' | 'agent' | 'machine'
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

// Usage and rate limits

/** Official subscription rate-limit window, as reported by the engine itself (never reconstructed). */
export interface RateLimitWindow {
  kind: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'other'
  /** 0–1 when the engine reports it, null otherwise. */
  utilization: number | null
  resetsAt: string | null
  status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown'
}

export interface RateLimitSnapshot {
  providerId: ProviderId
  windows: RateLimitWindow[]
  /** When the engine emitted it (it only does so during a run). */
  observedAt: string
  source: string
}

/** Business definition of what a companion is doing. One function computes it: shared/stats.ts. */
export type CompanionState = 'available' | 'in_mission' | 'awaiting_approval' | 'error' | 'offline'

export interface TeamCounts {
  total: number
  available: number
  inMission: number
  awaitingApproval: number
  /** inMission + awaitingApproval: cannot take new work right now. */
  busy: number
  error: number
  offline: number
}

export interface MissionCounts {
  total: number
  active: number
  todo: number
  done: number
  failed: number
  cancelled: number
  /** done / (done + failed). Cancelled missions are excluded: the user stopped them. null when nothing finished. */
  successRate: number | null
}

/** How Orbit learnt which files an execution touched. */
export interface FileInventory {
  id: string
  missionId: string
  executionId: string
  agentId: string
  method: 'engine' | 'git' | 'scan'
  /** false when Orbit knows the list may miss files (ignored files, size cap, concurrent writers…). */
  complete: boolean
  note: string | null
  createdAt: string
}

export type EffectiveLevel = 'allowed' | 'ask' | 'denied' | 'partial'

export interface EffectivePermissionRow {
  key: 'read' | 'write' | 'commands' | 'network' | 'external' | 'sensitive' | 'outside' | 'secrets'
  label: string
  /** What the companion settings say. */
  companion: boolean
  /** What actually happens at run time, all layers combined. */
  effective: EffectiveLevel
  /** Which layer enforces it. */
  enforcedBy: ('policy' | 'engine' | 'sandbox' | 'isolation' | 'approval')[]
  detail: string
}

export interface SecurityStatus {
  /** Level 3 on this Mac: proof from the empirical self-test. */
  isolation: { available: boolean; ok: boolean; checkedAt: string | null; checks: { label: string; ok: boolean }[]; error: string | null }
  events: { id: string; agentId: string | null; missionId: string | null; layer: string; action: string; target: string | null; decision: string; reason: string | null; createdAt: string }[]
}

/** Read-only totals from Claude Code's local session logs (opt-in). Tokens only, never a quota. */
export interface ClaudeLocalUsage {
  scannedAt: string
  days: number
  sessions: number
  messages: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  byModel: { model: string; messages: number; tokens: number }[]
  daily: { date: string; tokens: number }[]
  lastActivity: string | null
  filesSkipped: number
}

// Constellations

export interface ConstellationLimits {
  /** Coordinator delegation rounds (plan → results → maybe plan again). */
  maxDepth: number
  maxSubtasks: number
  maxParallel: number
  maxDurationMin: number
  /** Total tokens across every mission of the run; null = no limit. */
  maxTokens: number | null
  /** Measured or estimated dollars only; subscription usage cannot be capped in dollars. */
  maxBudgetUsd: number | null
}

export interface ConstellationMember {
  agentId: string
  role: string
  responsibilities: string
  canDelegate: boolean
}

export interface ConstellationDefinition {
  id: string
  name: string
  description: string
  objective: string
  coordinatorAgentId: string
  members: ConstellationMember[]
  /** Project folder every member works in (explicitly chosen by the user). */
  workspace: string | null
  workspaceMode: 'shared' | 'worktrees'
  /** Ceiling: a delegated mission never gets more than this, nor more than its companion. */
  permissions: AgentPermissions
  limits: ConstellationLimits
  isTemplate: boolean
  createdAt: string
  updatedAt: string
}

export type ConstellationRunStatus = 'planning' | 'running' | 'synthesizing' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface SubtaskSpec {
  key: string
  objective: string
  expected: string
  context: string
  dependsOn: string[]
  readOnly: boolean
  round: number
}

export interface StructuredResult {
  status: 'done' | 'partial' | 'blocked'
  summary: string
  files: string[]
}

export interface ConstellationTask {
  missionId: string
  shortId: string
  agentId: string
  title: string
  status: MissionStatus
  spec: SubtaskSpec
  dependsOnMissionIds: string[]
  permissions: AgentPermissions
  workspace: string | null
  result: string | null
  structured: StructuredResult | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

export interface ConstellationRun {
  id: string
  constellationId: string
  constellationName: string
  goal: string
  status: ConstellationRunStatus
  coordinatorAgentId: string
  coordinatorMissionId: string | null
  round: number
  workspace: string | null
  limits: ConstellationLimits
  synthesis: string | null
  error: string | null
  tokens: number
  costUsd: number | null
  origin: 'user' | 'automation'
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Coordinated by this runtime machine (synced copy). */
  machineId: string | null
}

export interface ExecutionHandoff {
  id: string
  runId: string
  kind: 'delegation' | 'result' | 'synthesis'
  fromAgentId: string
  toAgentId: string
  missionId: string | null
  summary: string
  payload: string
  redactions: number
  createdAt: string
}

export interface AgentWorkspace {
  id: string
  runId: string
  agentId: string
  path: string
  kind: 'shared' | 'worktree'
  branch: string | null
  baseRef: string | null
  status: 'active' | 'ready' | 'merged' | 'discarded' | 'conflict'
  diffStat: string | null
  conflictWith: string[]
  createdAt: string
}

export interface ConstellationRunDetail {
  run: ConstellationRun
  definition: ConstellationDefinition | null
  tasks: ConstellationTask[]
  handoffs: ExecutionHandoff[]
  workspaces: AgentWorkspace[]
}

/** Pushed when something real travels along a link (drives the light pulse in the UI). */
export interface ConstellationSignal {
  runId: string
  kind: 'delegation' | 'result' | 'synthesis' | 'error' | 'status'
  fromAgentId: string | null
  toAgentId: string | null
  missionId: string | null
  at: string
}

// Automations

export type MissedPolicy = 'skip' | 'run_once' | 'ask'

export interface AutomationTrigger {
  id: string
  kind: 'mission.completed' | 'mission.failed' | 'automation.completed'
  sourceAgentId: string | null
  sourceAutomationId: string | null
  cooldownSec: number
}

export interface Automation {
  id: string
  name: string
  description: string
  targetKind: 'agent' | 'constellation'
  targetId: string
  title: string
  prompt: string
  recurrence: import('./schedule').Recurrence | null
  timezone: string
  status: 'active' | 'paused' | 'completed'
  missedPolicy: MissedPolicy
  maxRunsPerDay: number | null
  nextRunAt: string | null
  lastRunAt: string | null
  triggers: AutomationTrigger[]
  /** Target can write files, run commands or act externally: never relaunched blindly. */
  sensitive: boolean
  lastRun: AutomationRun | null
  createdAt: string
  updatedAt: string
  /** The one scheduler allowed to fire it ('local' or a machine id). */
  schedulerOwner: string
  ownerState: 'active' | 'transferring'
  pendingOwner: string | null
  configVersion: number
  maxDurationMin: number | null
  budgetUsd: number | null
  failurePolicy: 'notify' | 'pause'
}

export interface AutomationRun {
  id: string
  automationId: string
  scheduledFor: string
  trigger: 'schedule' | 'missed' | 'manual' | 'event'
  status: 'pending_confirmation' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'uncertain'
  missionId: string | null
  constellationRunId: string | null
  note: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  /** Fired by this runtime machine. */
  machineId: string | null
}

// Remote runtime

export interface RemoteEngineStatus {
  id: string
  name?: string
  available: boolean
  detail: string
  installed?: boolean
  version?: string | null
  authenticated?: boolean | 'unknown'
  capabilities?: string[]
  restrictions?: string[]
}

export interface RemoteMachine {
  id: string
  name: string
  transport: 'ssh' | 'local'
  host: string | null
  user: string | null
  port: number
  runtimeHome: string
  hostKeyFingerprint: string | null
  status: 'new' | 'pending_host_key' | 'ready' | 'online' | 'offline' | 'error' | 'revoked'
  lastError: string | null
  lastHeartbeatAt: string | null
  runtimeVersion: string | null
  protocol: number | null
  info: Record<string, string> | null
  engines: RemoteEngineStatus[]
  runningMissions: number
  createdAt: string
  // Runtime identity and pairing
  /** Runtime identity pinned by the user (null until confirmed). */
  runtimeId: string | null
  runtimeKeyFingerprint: string | null
  /** Identity presented by the runtime and not yet confirmed (first connection or changed key). */
  pendingRuntimeKey: { runtimeId: string; fingerprint: string; changed: boolean } | null
  paired: boolean
  schemaVersion: string | null
  health: import('./remote').HealthReport | null
  metrics: import('./remote').MetricsReport | null
  limits: import('./remote').MachineLimits | null
  lastSyncedAt: string | null
  syncError: string | null
  pendingApprovals: number
  activeAutomations: number
  remoteCompanions: number
  sshIdentityFile: string | null
}
